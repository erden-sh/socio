import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';
import { personSeedOf } from '@socio/data/person-seed';
import { SYSTEM, deletedWith, unstamped } from '@socio/data/soft-delete';
import type { UnitOfWork } from '@socio/data/uow';
import type { BundleLimits } from '@socio/foundation/apps/bundle';
import { appInRuntime } from '@socio/foundation/apps/runtime-status';
import { appLabel, appOrigin, appSlug, type AppsSettings } from '@socio/foundation/apps/settings';
import type { ActorRevokeReason } from '@socio/shared/actor-scopes';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import type { AppLogRetention } from '@socio/shared/apps/app-log-retention';
import type { AppsHealthSummary } from '@socio/shared/apps/app-types';
import {
    APP_PORT_RANGE,
    type AppComputerState,
    type AppStatus,
    type AppDirectoryEntry,
    type AppView,
    type DotAppEntry,
} from '@socio/shared/apps/app-types';
import { compareText } from '@socio/shared/locale';
import { isAdmin } from '@socio/shared/roles';

import type { AppActorAccess } from '../actors/contract.js';
import type { ApprovalOutcome, ApprovalsShape } from '../approvals/contract.js';
import type { AppTarget, ComputersShape, ScreenshotsShape } from '../computers/contract.js';
import type { DataSpaceShape } from '../dataspace/contract.js';

import { AppActors } from './actor.js';
import type { AppRecord, AppsShape } from './contract.js';
import type { AppRepositories } from './domain/repositories.js';
import { AppError, appEnvFile, appLogFile, appPidFile, RepairSuperseded } from './errors.js';
import { AppHealthBook, type AppNotice } from './health.js';
import { SqliteLaunchCodes } from './infra/launch-codes.js';
import { sqliteAppRepositories } from './infra/sqlite/index.js';
import { AppPromotions, bundlePath } from './promotion.js';
import type { AppsRuntime } from './runtime-client.js';
import type { AppsPlugins, AppsWorkspace } from './slices.js';

export { AppError, appEnvFile, appLogFile };

/** Where a request for an app goes: the computer, or the runtime's ingress. */
export type ProxyTarget = AppTarget & {
    headers?: Record<string, string>;
    /**
     * Signs the identity headers the proxy adds (`x-cb-runtime-sig`,
     * CB-232), for the runtime's ingress; unset for a computer's port.
     */
    sign?: (method: string, target: string, headers: Record<string, string>) => Record<string, string>;
};

/** An `apps` row: the record with its datasets as JSON, and the `public` column the record drops. */
interface AppRow extends Omit<AppRecord, 'datasets'> {
    datasets: string;
    public: number;
}

/** What `app_register` asks to do; the approval runs it from this. */
export interface RegisterPayload {
    name: string;
    description: string;
    port: number;
    datasets: string[];
    startCommand: string | null;
}

export interface AppSession {
    app: AppRecord;
    userId: string;
    access: 'owner' | 'space';
    /** The session row's key (SHA-256 of the cookie): a person's `cbob_` names it. */
    sessionHash: string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000;
const NAME = /^[^\n\r]{1,60}$/;
const COMMAND = /^[^\n\r\0]{1,500}$/;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const message = (error: unknown) => (error instanceof Error ? error.message : 'It failed.');
const sha = (token: string) => createHash('sha256').update(token).digest('hex');

export interface AppsServiceOptions {
    /** Unset: mini apps are off (no APPS_HOST and no APP_ORIGIN). */
    settings?: AppsSettings;
    /** Derives the opaque per-person ids apps see. */
    secret: string;
    approvals: ApprovalsShape;
    workspace: AppsWorkspace;
    data: DataSpaceShape;
    /** The computers (built after this service). */
    computers: () => ComputersShape;
    /** DATA_API_URL: where an app in a computer reaches the data API. */
    dataApiUrl?: string;
    /** Replaces the computer lookup (tests: a local fake upstream). */
    resolveTarget?: (dotId: string, port: number) => Promise<AppTarget>;
    /** The workspace app runtime; unset: apps can't be promoted. */
    runtime?: AppsRuntime & {
        ingressHeaders(id: string): Record<string, string>;
    };
    bundleLimits?: BundleLimits;
    /** How long attempts and their logs are kept (CB-175); read on each prune. */
    logRetention?: () => AppLogRetention;
    /**
     * Socio-actor access (CB-232, `platform.actors`): this service registers
     * the `app` audience policy with it and revokes grants for an app
     * through it on unpublish, unregister and unshare. Unset in tests that
     * don't need it.
     */
    actors?: AppActorAccess;
    /** A screenshot's result as history keeps it (computers' `Screenshots`), for the app browser's `app_screenshot`. */
    screenshots: ScreenshotsShape;
    log?: (line: string) => void;
}

/**
 * Mini apps (`LegacyApps`): the apps Dots register, launch codes and
 * sessions on the apps' own origins, the data token each app's server gets
 * through a file in its computer, and where to reach each app. The proxy
 * (`proxy.ts`) serves them; routes and tools call in here.
 */
export class AppsService implements AppsShape {
    /** One-time launch codes, shared by the runtimes on the database (CB-108). */
    private codes: SqliteLaunchCodes;
    private uow: UnitOfWork;
    private repos: AppRepositories;
    /** Each development app's live data token, and the owner it was issued for. */
    private tokens = new Map<string, { token: string; expiresAt: number; userId: string }>();
    private targets = new Map<string, { at: number; target: AppTarget }>();
    private provisioned = new Map<string, number>();
    private provisioning = new Set<string>();
    private sockets = new Map<string, Set<{ destroy: () => void }>>();
    /** Promotion, versions, the runtime and retirement. */
    readonly promotions: AppPromotions;
    /** Socio access (CB-232): the audience policy, keys and envelopes. */
    readonly actor: AppActors;
    /** Self-healing (CB-291): each app's state, repairs and last data tokens. */
    readonly health: AppHealthBook;
    /**
     * Self-healing's waits (CB-291; tests shorten them): how long an app
     * may keep using a refused token after it was renewed before its
     * process is replaced, how long a started app may take before an
     * unanswered port counts, and how long a replaced one has to answer.
     */
    readonly timing = { renewGraceMs: 30_000, startGraceMs: 60_000, upWaitMs: 30_000 };
    /** Tokens renewed in place after a refusal, per app: when, and the refused ones' hashes. */
    private renewals = new Map<string, { at: number; hashes: Set<string>; settled: boolean }>();
    /** Apps being repaired now. */
    private repairing = new Set<string>();
    /** When the platform last started a development app's process. */
    private started = new Map<string, number>();
    /** Since when each development app has answered every check, without a miss. */
    private answering = new Map<string, number>();
    private notifyAdmins?: (notice: AppNotice) => Promise<unknown>;
    constructor(
        private db: DatabaseSync,
        private options: AppsServiceOptions,
    ) {
        this.codes = new SqliteLaunchCodes(db);
        const data = sqliteData(db);
        this.uow = data.uow;
        this.repos = sqliteAppRepositories(data);
        this.health = new AppHealthBook(db, {
            notifyAdmins: () => this.notifyAdmins,
            name: (id) => this.get(id)?.name,
            log: options.log,
        });
        // A refused data token names its app: it recovers by itself (CB-291).
        // (A data space without tokens, in some tests, has nothing to refuse.)
        options.data.tokens?.onRefused?.((token) => this.refusedToken(token));
        // Listed in the policies only where apps can be published.
        if (options.settings) {
            this.registerApproval();
        }
        this.promotions = new AppPromotions(this, db, this.repos, {
            approvals: options.approvals,
            workspace: options.workspace,
            data: options.data,
            computers: options.computers,
            runtime: options.runtime,
            bundleLimits: options.bundleLimits,
            logRetention: options.logRetention,
            enabled: !!options.settings,
            tokenTtlMs: options.settings?.tokenTtlMs ?? 7 * DAY,
            log: options.log,
        });
        options.data.useAppGrants((appId) => this.promotions.grantsFor(appId));
        this.actor = new AppActors({
            db,
            secret: options.secret,
            workspace: options.workspace,
            app: (id) => this.get(id),
            access: (personId, app) => this.access(personId, app as AppRecord),
            manifest: (appId, version) => this.promotions.manifestOf(appId, version),
        });
        // The `app` audience (CB-232), where apps are served at all.
        if (options.settings && options.actors) {
            options.actors.audiences.register('app', this.actor.policy());
        }
        // The data API's side of socio access: an app's contract terms, a
        // person's access, and a person's app session by the hash their
        // `cbob_` names. Unregistered, every `x-cb-obo` is refused.
        options.data.useAppDelegation({
            terms: (appId) => {
                const app = this.get(appId);
                // Only an app that receives envelopes takes part: promoted, or a
                // development app on a person-owned socio.
                if (!app || !this.actor.receivesEnvelopes(app)) {
                    return undefined;
                }
                const delegation = this.actor.delegation(app);
                if (!delegation) {
                    return undefined;
                }
                return {
                    background: delegation.background?.datasets ?? [],
                    backgroundRead: delegation.background?.read ?? true,
                    ...(delegation.spaceAccess ? { spaceAccess: delegation.spaceAccess } : {}),
                };
            },
            personAccess: (appId, userId) => {
                const app = this.get(appId);
                return app ? this.access(userId, app) : undefined;
            },
            session: async (appId, sessionHash) => {
                const session = await this.sessionByHash(appId, sessionHash);
                return session ? { userId: session.userId } : undefined;
            },
        });
    }
    /** Socio-actor access, when the platform has it (CB-232). */
    get actors() {
        return this.options.actors;
    }
    /** A screenshot's result as history keeps it (CB-157): the app browser's `app_screenshot`. */
    get screenshots() {
        return this.options.screenshots;
    }
    /**
     * Ends every socio grant for an app (CB-232: unpublished, unregistered,
     * deleted, unshared). A failure is logged, never thrown:
     * the grants also fail their next check, whose policy no longer
     * delegates the app (or no longer lets the person open it).
     */
    async endGrants(appId: string, by: string, reason: ActorRevokeReason) {
        try {
            return (await this.options.actors?.appEnded(appId, by, reason)) ?? 0;
        } catch {
            this.options.log?.(`Apps: ending socio access to ${appId} failed.`);
            return 0;
        }
    }
    /**
     * Installed plugins, which share the apps host (CB-232): the
     * internal apps listener serves a socio's session on a service plugin
     * too. Set by the plugins module.
     */
    plugins?: AppsPlugins;
    usePlugins(plugins: AppsPlugins) {
        this.plugins = plugins;
    }
    /**
     * Socio Secrets, set by the platform: values an app may read or did
     * read, which its logs and its socio's computer output redact, and the
     * required secrets it still lacks.
     */
    workloadSecrets?: { values(appId: string): string[]; needsSetup(appId: string): string[] };
    useWorkloadSecrets(secrets: NonNullable<AppsService['workloadSecrets']>) {
        this.workloadSecrets = secrets;
    }
    /** Replaces the runtime (tests: one on loopback). */
    useRuntime(runtime: AppsRuntime) {
        this.options.runtime = runtime;
        (this.promotions as unknown as { options: { runtime: unknown } }).options.runtime = runtime;
    }
    /** Replaces where apps are reached (tests: a local fake upstream). */
    useTargets(resolve: (dotId: string, port: number) => Promise<AppTarget>) {
        this.options.resolveTarget = resolve;
        this.targets.clear();
    }
    /** The admins' notices, for when automatic repair gives up (CB-291). */
    useAdminNotices(notify: (notice: AppNotice) => Promise<unknown>) {
        this.notifyAdmins = notify;
    }
    get settings() {
        return this.options.settings;
    }
    get enabled() {
        return !!this.options.settings;
    }
    private requireEnabled() {
        if (!this.options.settings) {
            throw new AppError('Mini apps are not set up here (APPS_HOST and APP_ORIGIN).', 503);
        }
        return this.options.settings;
    }

    // ---- records ------------------------------------------------------------
    private record(row: AppRow | undefined): AppRecord | undefined {
        if (!row) {
            return undefined;
        }
        const record = unstamped(row) as Partial<AppRow> & {
            deletedLabel?: unknown;
        };
        delete record.public;
        delete record.deletedLabel;
        return {
            ...(record as Omit<AppRow, 'public'>),
            datasets: JSON.parse(row.datasets) as string[],
        };
    }
    /** A live app; a deleted one is missing (CB-64). */
    get(id: string) {
        return this.record(
            this.db.prepare('SELECT * FROM apps WHERE id=? AND deletedAt IS NULL').get(id) as AppRow | undefined,
        );
    }
    /** Every live app. */
    all() {
        return (
            this.db
                .prepare('SELECT * FROM apps WHERE deletedAt IS NULL ORDER BY createdAt')
                .all() as unknown as AppRow[]
        ).map((row) => this.record(row)!);
    }
    /** Apps, deleted or not, with their stamps, by the label they had (admin, tests). */
    withDeleted(label: string) {
        return this.db
            .prepare('SELECT * FROM apps WHERE id=? OR deletedLabel=? ORDER BY createdAt')
            .all(label, label) as unknown as Array<
            AppRow & {
                deletedAt: number | null;
                deletedBy: string | null;
                deletedWith: string | null;
                deletedLabel: string | null;
            }
        >;
    }
    forDot(userId: string, dotId: string) {
        return this.all().filter((app) => app.dotId === dotId && app.ownerUserId === userId);
    }
    /** The workspace's Spaces (tools resolve share choices by name). */
    /** The Spaces `userId` may read (CB-181): the ones an app may be shared with. */
    spaces(userId: string) {
        return this.options.workspace.spaceAccess.readable({ userId });
    }
    /**
     * What a socio, acting for `userId` in a conversation, may do in an app
     * (CB-181): the person's own app; or one shared with a Space the socio
     * reads there, granted to it and readable by everyone reading the chat
     * (a room's people; for a conversation that is no chat, such as a
     * schedule's, the person). Asked at a grant's request and on every
     * socio session request through the proxy.
     */
    socioAccess(app: AppRecord, userId: string, conversationId: string, dotId: string): 'owner' | 'space' | undefined {
        const access = this.access(userId, app);
        if (access !== 'space') {
            return access;
        }
        const { workspace } = this.options;
        const reader = workspace.thread(conversationId)
            ? workspace.socioReader(conversationId, dotId)
            : { dotId, people: [userId] };
        return workspace.spaceAccess.reads(app.sharedSpaceId!, reader) ? 'space' : undefined;
    }
    /** Whether `socioAccess` lets the socio reach the app at all. */
    socioMayReach(app: AppRecord, userId: string, conversationId: string, dotId: string) {
        return !!this.socioAccess(app, userId, conversationId, dotId);
    }
    /** The Spaces a socio may name in its chat (CB-181), for share choices. */
    socioSpaces(threadId: string, dotId: string) {
        const { workspace } = this.options;
        return workspace.spaceAccess.readable(workspace.socioReader(threadId, dotId));
    }
    /** One of the user's apps on this Dot, by id, slug or name (tools). */
    findForDot(userId: string, dotId: string, ref: string) {
        const wanted = ref.trim().toLowerCase();
        const mine = this.forDot(userId, dotId);
        const app =
            mine.find((item) => item.id === wanted) ??
            mine.find((item) => item.slug === wanted) ??
            mine.find((item) => item.name.toLowerCase() === wanted);
        if (!app) {
            throw new AppError(`No app "${ref}" of yours on this socio; app_list shows them.`, 404);
        }
        return app;
    }
    setStatus(id: string, status: AppStatus) {
        return this.repos.apps.setStatus(id, status, Date.now());
    }
    /** Served from the computer no more: its token and connections end. */
    endComputerServing(id: string) {
        this.revokeToken(id);
        this.closeSockets(id);
        const app = this.get(id);
        if (app) {
            this.targets.delete(`${app.dotId}:${app.port}`);
        }
    }
    /** Development apps stop with their computer; promoted apps keep their runtime leases. */
    computerStopped(dotId: string) {
        for (const app of this.all()) {
            if (app.dotId === dotId && !AppsService.inRuntime(app)) {
                this.endComputerServing(app.id);
            }
        }
    }
    /** Everyone's sessions on the app's origin end (unpublished). */
    async endSessions(id: string) {
        await this.repos.sessions.removeForApp(id);
        this.closeSockets(id);
        this.codes.forgetApp(id);
    }
    /** Served by the workspace app runtime, not the Dot's computer. */
    static inRuntime(app: Pick<AppRecord, 'status'>) {
        return appInRuntime(app);
    }
    url(app: Pick<AppRecord, 'id'>) {
        return appOrigin(this.requireEnabled(), app.id);
    }
    /**
     * Owner, or someone who may read the Space it is shared with (the one
     * Space access rule, CB-181: everyone for a Space open to the workspace,
     * its people for a private one); nobody else. Asked on every request.
     */
    access(userId: string, app: AppRecord): 'owner' | 'space' | undefined {
        if (app.ownerUserId === userId) {
            return 'owner';
        }
        if (!app.sharedSpaceId) {
            return undefined;
        }
        return this.options.workspace.spaceAccess.canRead(app.sharedSpaceId, userId) ? 'space' : undefined;
    }
    /** The name of the Space an app is shared with, for a viewer who may read it. */
    sharedSpaceName(app: Pick<AppRecord, 'sharedSpaceId'>, viewer: string) {
        if (!app.sharedSpaceId || !this.options.workspace.spaceAccess.canRead(app.sharedSpaceId, viewer)) {
            return null;
        }
        return this.options.workspace.spaces().find((space) => space.id === app.sharedSpaceId)?.name ?? null;
    }
    private datasetNames(app: Pick<AppRecord, 'ownerUserId' | 'dotId' | 'datasets'>) {
        const visible = this.options.data.visible({ kind: 'dot', userId: app.ownerUserId, dotId: app.dotId }, false);
        return app.datasets.map((id) =>
            id === 'scratch' ? 'Scratch' : (visible.find((item) => item.row.id === id)?.row.name ?? 'Unavailable'),
        );
    }
    view(app: AppRecord, viewer: string): AppView {
        const owner = app.ownerUserId === viewer;
        return {
            id: app.id,
            name: app.name,
            description: app.description,
            dotId: app.dotId,
            dotName: this.options.workspace.dot(app.dotId)?.name ?? 'A deleted socio',
            owner,
            ...(owner
                ? {}
                : {
                      ownerName:
                          this.options.workspace.users().find((user) => user.id === app.ownerUserId)?.name ??
                          'Another user',
                  }),
            port: app.port,
            datasets: app.datasets,
            datasetNames: owner ? this.datasetNames(app) : [],
            // A Space the viewer may not read is never named (CB-181).
            sharedSpaceId: this.sharedSpaceName(app, viewer) ? app.sharedSpaceId : null,
            sharedSpaceName: this.sharedSpaceName(app, viewer),
            startCommand: owner ? app.startCommand : null,
            status: app.status,
            url: this.url(app),
            createdAt: app.createdAt,
            updatedAt: app.updatedAt,
            liveVersion: app.liveVersion,
            previousVersion: app.previousVersion,
            promotedAt: app.promotedAt,
            canReadLogs: this.mayReadLogs(viewer, app),
            ...(this.mayReadLogs(viewer, app) ? { health: this.health.get(app.id) } : {}),
            ...this.setupNeeds(app, viewer),
            ...(owner ? { versions: this.promotions.versions(app.id) } : {}),
        };
    }
    /** Required Socio Secrets it lacks, for its owner and admins (names only). */
    private setupNeeds(app: AppRecord, viewer: string): Pick<AppView, 'needsSetup'> {
        if (!AppsService.inRuntime(app) || !this.mayReadLogs(viewer, app)) {
            return {};
        }
        const missing = this.workloadSecrets?.needsSetup(app.id) ?? [];
        return missing.length ? { needsSetup: missing } : {};
    }
    /**
     * The app whose build and start logs a user may read (CB-175): its owner
     * and workspace admins, nobody else. A member who is not the owner gets a
     * 403, even for an app shared with them; an unknown app is a 404.
     */
    logsOf(id: string, userId: string): AppRecord {
        const app = this.get(id);
        if (!app) {
            throw new AppError('App not found.', 404);
        }
        if (!this.mayReadLogs(userId, app)) {
            throw new AppError('Only the app’s owner and workspace admins can read its logs.', 403);
        }
        return app;
    }
    mayReadLogs(userId: string, app: AppRecord) {
        if (app.ownerUserId === userId) {
            return true;
        }
        return isAdmin(this.options.workspace.users().find((user) => user.id === userId));
    }
    /**
     * For an admin, the live apps they can't open, by name and owner only
     * (CB-442); for anyone else, none. Seeing a name opens
     * nothing: `access` is unchanged.
     */
    othersFor(userId: string): AppDirectoryEntry[] | undefined {
        const users = this.options.workspace.users();
        if (!this.enabled || !isAdmin(users.find((user) => user.id === userId))) {
            return undefined;
        }
        return this.all()
            .filter((app) => !this.access(userId, app))
            .map((app) => ({
                id: app.id,
                name: app.name,
                ownerName: users.find((user) => user.id === app.ownerUserId)?.name ?? 'Another user',
            }))
            .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
    }
    /** The apps a user may open: their own and those shared with their Spaces. */
    visibleTo(userId: string) {
        return this.all().filter((app) => this.access(userId, app));
    }
    /**
     * A socio's home page (CB-260): its apps `userId` may open (`visibleTo`,
     * nothing more), newest change first, from the registry alone. Unlike
     * `listFor` it never asks a computer or the runtime, so the page can read
     * it often and a stopped app stays stopped. Another person's personal
     * socio is missing, as on the page's other panels.
     */
    homeFor(userId: string, dotId: string): DotAppEntry[] {
        const dot = this.options.workspace.dot(dotId);
        if (!dot || (dot.ownerId && dot.ownerId !== userId)) {
            throw new AppError('Socio not found.', 404);
        }
        if (!this.enabled) {
            return [];
        }
        const users = this.options.workspace.users();
        return this.visibleTo(userId)
            .filter((app) => app.dotId === dotId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((app) => {
                const owner = app.ownerUserId === userId;
                return {
                    id: app.id,
                    name: app.name,
                    description: app.description,
                    status: app.status,
                    owner,
                    ...(owner
                        ? {}
                        : {
                              ownerName: users.find((user) => user.id === app.ownerUserId)?.name ?? 'Another user',
                          }),
                    sharedSpaceName: this.sharedSpaceName(app, userId),
                    liveVersion: app.liveVersion,
                    updatedAt: app.updatedAt,
                };
            });
    }
    /** Views with the computer's state and whether the port answers. */
    async listFor(userId: string): Promise<AppView[]> {
        if (!this.enabled) {
            return [];
        }
        return Promise.all(
            this.visibleTo(userId).map(async (app) => {
                if (AppsService.inRuntime(app)) {
                    const runtime = await this.promotions.state(app, true);
                    return {
                        ...this.view(app, userId),
                        ...(app.ownerUserId === userId
                            ? {
                                  datasetNames: this.promotions
                                      .grantViews(app)
                                      .map((grant) => `${grant.name} (${grant.access})`),
                              }
                            : {}),
                        ...(this.mayReadLogs(userId, app)
                            ? { lastAttempt: await this.promotions.lastAttempt(app) }
                            : {}),
                        runtime,
                        answering: runtime === 'running',
                    };
                }
                const target = await this.target(app, true);
                return {
                    ...this.view(app, userId),
                    // A packaged app whose promotion failed to build (CB-146).
                    ...(this.mayReadLogs(userId, app) && app.status === 'packaged'
                        ? { lastAttempt: await this.promotions.lastAttempt(app) }
                        : {}),
                    computer: target.state,
                    answering: target.state === 'running' ? await this.probe(target) : null,
                };
            }),
        );
    }

    // ---- registration -------------------------------------------------------
    /** Checks a registration; throws an AppError the Dot can act on. */
    private async validate(userId: string, dotId: string, input: RegisterPayload) {
        this.requireEnabled();
        const dot = this.options.workspace.dot(dotId);
        if (!dot) {
            throw new AppError('Socio not found.', 404);
        }
        if (!NAME.test(input.name.trim())) {
            throw new AppError('Name the app (1 to 60 characters, one line).');
        }
        const slug = appSlug(input.name);
        if (!slug) {
            throw new AppError('The name needs letters or digits (it becomes part of the address).');
        }
        let id: string;
        try {
            id = appLabel(slug, dot, this.requireEnabled().labelPrefix);
        } catch (error) {
            throw new AppError(error instanceof Error ? error.message : 'Invalid app name.');
        }
        if (!Number.isInteger(input.port) || input.port < APP_PORT_RANGE.min || input.port > APP_PORT_RANGE.max) {
            throw new AppError(`Use a port from ${APP_PORT_RANGE.min} to ${APP_PORT_RANGE.max}.`);
        }
        if (input.startCommand !== null && !COMMAND.test(input.startCommand)) {
            throw new AppError('The start command is one line of 500 characters at most.');
        }
        if (!(await this.options.workspace.computers.permissions(dotId)).enabled) {
            throw new AppError(
                'This socio’s computer is turned off; an admin enables it in the socio’s settings.',
                403,
            );
        }
        const visible = this.options.data.visible({ kind: 'dot', userId, dotId }, false);
        const datasets = [...new Set(input.datasets.map((ref) => ref.trim()))].filter(Boolean).map((ref) => {
            if (ref.toLowerCase() === 'scratch') {
                return 'scratch';
            }
            const match =
                visible.find((item) => item.row.id === ref) ??
                visible.find((item) => item.row.name.toLowerCase() === ref.toLowerCase());
            if (!match) {
                throw new AppError(`No dataset "${ref}" is available to this socio (data_list shows yours).`, 404);
            }
            return match.scratch ? 'scratch' : match.row.id;
        });
        if (datasets.length > 20) {
            throw new AppError('At most 20 datasets.');
        }
        const existing = this.get(id);
        if (existing && existing.ownerUserId !== userId) {
            throw new AppError('Another person’s app on this socio has that name; choose another.', 409);
        }
        if (existing && AppsService.inRuntime(existing)) {
            throw new AppError(
                'This app is promoted: propose a new version with app_package and app_update instead.',
                409,
            );
        }
        if (await this.repos.apps.portHolder(dotId, input.port, id)) {
            throw new AppError(
                `Another app on this computer is registered on port ${input.port}; choose another port.`,
                409,
            );
        }
        return {
            id,
            slug,
            dot,
            datasets: [...new Set([...datasets, 'scratch'])],
            existing,
        };
    }
    /** `app_register`: asks the user (or runs at once under bypass). */
    async requestRegister(
        userId: string,
        dotId: string,
        input: RegisterPayload & { public?: boolean },
        threadId?: string,
    ): Promise<ApprovalOutcome> {
        if (input.public) {
            throw new AppError(
                'Public mini apps are not available yet: every app needs sign-in. Register it without public.',
                403,
            );
        }
        const payload: RegisterPayload = {
            name: input.name.trim(),
            description: input.description.trim().slice(0, 500),
            port: input.port,
            datasets: input.datasets,
            startCommand: input.startCommand?.trim() || null,
        };
        const checked = await this.validate(userId, dotId, payload);
        const names = this.datasetNames({
            ownerUserId: userId,
            dotId,
            datasets: checked.datasets,
        });
        return this.options.approvals.request({
            userId,
            dotId,
            capability: APPROVAL_CAPABILITIES.appRegister,
            summary: `${checked.existing ? 'Update' : 'Publish'} the mini app “${payload.name}” from ${checked.dot.name}’s computer`,
            details: [
                `Address: ${this.url({ id: checked.id })}`,
                `Port ${payload.port} in the socio’s computer`,
                `Data it may use: ${names.join(', ')}`,
                ...(payload.startCommand ? [`Start command: ${payload.startCommand.slice(0, 200)}`] : []),
                'Only you can open it until you share it with a Space.',
                'Ephemeral: it runs only while the socio’s computer runs it.',
            ],
            payload: { ...payload, datasets: checked.datasets },
            threadId,
        });
    }
    /** Runs an approved registration; returns its outcome in a line. */
    async register(userId: string, dotId: string, payload: RegisterPayload) {
        const checked = await this.validate(userId, dotId, payload);
        const now = Date.now();
        // One unit of work, queued behind one open on the shared connection
        // (CB-110): the approved action runs after a queued write.
        const app = await this.write('register app', async () => {
            await this.repos.apps.register({
                id: checked.id,
                slug: checked.slug,
                name: payload.name,
                description: payload.description,
                dotId,
                ownerUserId: userId,
                port: payload.port,
                datasets: checked.datasets,
                startCommand: payload.startCommand,
                createdAt: checked.existing?.createdAt ?? now,
                updatedAt: now,
            });
            const app = this.get(checked.id)!;
            // New datasets or a new port: a new token.
            this.revokeToken(app.id);
            return app;
        });
        this.targets.delete(`${dotId}:${payload.port}`);
        // A new registration, committed: earlier repairs no longer apply,
        // whether or not it starts now (CB-291).
        await this.health.reset(app.id);
        const lines = [`Registered “${app.name}” at ${this.url(app)} (port ${app.port}).`];
        try {
            await this.provision(app, true);
            lines.push('Credentials are private to this app identity.');
            if (app.startCommand) {
                await this.run(app, userId, 'agent');
                lines.push('Started with its start command; use app_logs for its output.');
            }
        } catch (error) {
            lines.push(
                `The token file will be written when the computer runs (${error instanceof Error ? error.message : 'computer unavailable'}).`,
            );
        }
        this.options.log?.(`Apps: registered ${app.id} for Dot ${dotId}.`);
        return lines.join(' ');
    }
    private registerApproval() {
        this.options.approvals.register<RegisterPayload>({
            capability: APPROVAL_CAPABILITIES.appRegister,
            label: 'Publish mini apps',
            description:
                'A web app the socio runs in its computer, served on its own address behind your sign-in, with a data token for the datasets it names and its scratch dataset.',
            execute: ({ userId, dotId, payload }) => this.register(userId, dotId, payload),
            auto: {
                maxRiskForAuto: 'low',
                riskNotes:
                    'A web app served behind your sign-in (and to anyone you later share it with), with a data token for the datasets it names.',
                rules: [
                    {
                        description: 'Apps that use datasets beyond the socio’s scratch dataset go to you.',
                        check: ({ payload }) =>
                            payload.datasets.some((id) => id !== 'scratch') &&
                            'It uses datasets beyond the socio’s scratch dataset.',
                    },
                ],
            },
        });
    }
    /**
     * Hides a deleted app and keeps it (CB-64), re-keyed to
     * `deleted-<uuid>` so a new app can take its address: its versions and
     * grants move with it, and its bundles move to the new id's folder in the
     * owner's data space (a bundle that can't move keeps its path), where
     * they are deleted with it (`deletedWith app:<new id>`), so kept. One
     * transaction for the rows; returns the new id. Sessions and tokens are
     * the caller's to end.
     */
    private async retire(
        app: AppRecord,
        by: string,
        parent: string | null = null,
        id = AppsService.retiredId(),
    ): Promise<string> {
        // Its address may go to another app: that one starts healthy (CB-291).
        await this.health.clear(app.id);
        this.renewals.delete(app.id);
        const versions = await this.repos.versions.forApp(app.id);
        const moved = new Map<number, string>();
        for (const row of versions) {
            const to = bundlePath(id, row.version);
            try {
                await this.options.data.moveFile(app.ownerUserId, row.bundlePath, to);
                moved.set(row.version, to);
            } catch {
                // Deleted from the Data page already, or storage is down.
            }
        }
        const now = Date.now();
        await this.write('retire app', async () => {
            await this.repos.apps.retire(app.id, id, { at: now, by, with: parent });
            await this.repos.versions.rekey(
                app.id,
                id,
                versions.map((row) => ({
                    version: row.version,
                    bundlePath: moved.get(row.version) ?? row.bundlePath,
                })),
            );
            await this.repos.grants.rekey(app.id, id);
        });
        // Its build and start logs too: a new app at the address starts clean.
        await this.promotions.attempts.rekey(app.id, id);
        // A new epoch for the address: whatever takes it next never shares
        // this app's envelope key (CB-232).
        await this.actor.rotate(app);
        for (const row of versions) {
            try {
                await this.options.data.deleteFile(app.ownerUserId, moved.get(row.version) ?? row.bundlePath, {
                    by,
                    with: deletedWith('app', id),
                });
            } catch {
                // Deleted from the Data page already.
            }
        }
        this.options.workspace.audit({
            actor: by,
            action: 'delete',
            targetKind: 'app',
            targetId: id,
            detail: `${app.name} (${app.id})`,
        });
        return id;
    }
    /** The id a deleted app is kept under; its address is free again. */
    static retiredId() {
        return `deleted-${randomUUID()}`;
    }
    /**
     * Ends an app: its sessions, token and open connections; the record is
     * hidden and kept (CB-64). `by` is the user, or `dot:<id>` for the
     * Dot's tool.
     */
    async unregister(id: string, userId: string, by: string = userId) {
        const app = this.get(id);
        if (!app || app.ownerUserId !== userId) {
            throw new AppError('App not found.', 404);
        }
        if (AppsService.inRuntime(app)) {
            throw new AppError('This app is promoted: unpublish or delete it on the Apps page.', 409);
        }
        await this.repos.sessions.removeForApp(id);
        await this.retire(app, by);
        this.revokeToken(id);
        this.closeSockets(id);
        this.codes.forgetApp(id);
        await this.endGrants(id, by, 'audience_unavailable');
        this.options.log?.(`Apps: unregistered ${id}.`);
        // The token is already dead; the file is cleared when the computer runs.
        try {
            if ((await this.target(app, true)).state === 'running') {
                await this.options
                    .computers()
                    .writeFile(app.dotId, appEnvFile(app.slug), '# This mini app was unregistered.\n', {
                        kind: 'app',
                        id: app.id,
                    });
            }
        } catch {
            // Nothing to clear, or the computer is gone.
        }
        return { ok: true };
    }
    /**
     * The record's last step when a promoted app is deleted, kept under `as`
     * (`retiredId`), which its deleted datasets already name.
     */
    async dropRecord(id: string, by: string, as = AppsService.retiredId()) {
        const app = this.get(id);
        if (!app) {
            return;
        }
        await this.endSessions(id);
        await this.retire(app, by, null, as);
        this.revokeToken(id);
        await this.endGrants(id, by, 'audience_unavailable');
        this.options.log?.(`Apps: deleted ${id}.`);
    }
    /** Shares an app with a Space (or stops sharing); others' sessions end. */
    async share(id: string, userId: string, spaceId: string | null) {
        const app = this.get(id);
        if (!app || app.ownerUserId !== userId) {
            throw new AppError('App not found.', 404);
        }
        // Only with a Space its owner may read (CB-181).
        if (spaceId && !this.options.workspace.spaceAccess.canRead(spaceId, userId)) {
            throw new AppError('Space not found.', 404);
        }
        const unshared = !!app.sharedSpaceId && app.sharedSpaceId !== spaceId;
        await this.write('share app', async () => {
            await this.repos.apps.share(id, spaceId, Date.now());
            if (unshared) {
                await this.repos.sessions.removeForAppExcept(id, userId);
            }
        });
        if (unshared) {
            this.closeSockets(id);
            await this.endGrants(id, userId, 'access_changed');
        }
        return this.view(this.get(id)!, userId);
    }
    /** Apps whose Dot is gone go with it (CB-64: hidden, `deletedWith` dot:<id>). */
    async forgetDeletedDots() {
        const known = new Set(this.options.workspace.dots().map((dot) => dot.id));
        let removed = 0;
        for (const app of this.all())
        // Promoted apps belong to the workspace now; they outlive their Dot.
        {
            if (!known.has(app.dotId) && !AppsService.inRuntime(app)) {
                await this.repos.sessions.removeForApp(app.id);
                await this.retire(app, SYSTEM, deletedWith('dot', app.dotId));
                this.revokeToken(app.id);
                this.closeSockets(app.id);
                await this.endGrants(app.id, SYSTEM, 'audience_unavailable');
                removed++;
            }
        }
        return removed;
    }

    /**
     * One unit of work: queued behind one open on the shared connection, a
     * savepoint of this context's own (CB-110).
     */
    private write<T>(label: string, work: () => Promise<T>) {
        return this.uow.run(work, { label, savepoint: true });
    }

    // ---- data tokens --------------------------------------------------------
    revokeToken(id: string) {
        this.options.data.tokens.revokeSession(`app:${id}`);
        this.tokens.delete(id);
        this.provisioned.delete(id);
    }
    /**
     * The app's data token: one per app, valid for `tokenTtlMs` (7 days),
     * replaced once less than a day is left (or after a restart, which ends
     * every token). The old one stays valid until its own expiry.
     */
    private token(app: AppRecord) {
        const current = this.tokens.get(app.id);
        if (
            current &&
            // Never the old owner's after a transfer (CB-360).
            current.userId === app.ownerUserId &&
            current.expiresAt - Date.now() > DAY &&
            this.options.data.tokens.resolve(current.token)
        ) {
            return { token: current.token, fresh: false };
        }
        const ttl = this.requireEnabled().tokenTtlMs;
        const token = this.options.data.tokens.issue(
            {
                userId: app.ownerUserId,
                dotId: app.dotId,
                purpose: 'app',
                // A development app shares the company's computer (CB-226).
                // Its token must never inherit the registering person's private data.
                ...(this.options.workspace.dot(app.dotId)?.ownerId === null ? { reach: 'socio' as const } : {}),
                session: `app:${app.id}`,
                datasetIds: app.datasets,
            },
            ttl,
        );
        this.tokens.set(app.id, { token, expiresAt: Date.now() + ttl, userId: app.ownerUserId });
        void this.health.rememberToken(app.id, token).catch(() => undefined);
        return { token, fresh: true };
    }
    /**
     * Tokens (and envelope keys, CB-232) apps of this Dot hold: redacted
     * from its computer's responses.
     */
    secretsFor(dotId: string) {
        const apps = this.all().filter((app) => app.dotId === dotId);
        return [
            ...apps
                .filter((app) => !AppsService.inRuntime(app))
                .flatMap((app) => [this.tokens.get(app.id)?.token, ...Object.values(this.actorKeyEnv(app))])
                .filter((token): token is string => !!token && token.length >= 16),
            // Socio Secrets its workspace apps may read: never in its socio's view.
            ...apps.flatMap((app) => this.workloadSecrets?.values(app.id) ?? []),
        ];
    }
    /**
     * A development app's envelope keys (CB-232), only when it is
     * eligible at all: on a person-owned socio, declaring the contract.
     * Never on a company socio's computer.
     */
    private actorKeyEnv(app: AppRecord): Record<string, string> {
        if (!this.options.actors || !this.actor.receivesEnvelopes(app)) {
            return {};
        }
        return this.actor.keyEnv(app);
    }
    envFile(app: AppRecord, token: string) {
        const api = this.options.dataApiUrl?.replace(/\/$/, '').replace(/'/g, '');
        const keys = this.actorKeyEnv(app);
        return [
            '# Written by Socio for this mini app. Source it before starting',
            '# the server; read it again on a 401 (the token is renewed here; its',
            '# path is in CB_APP_ENV_FILE). Otherwise Socio restarts the app.',
            `PORT='${app.port}'`,
            `CB_APP_ID='${app.id}'`,
            `CB_APP_URL='${this.url(app)}'`,
            ...(api
                ? [`CB_DATA_URL='${api}/api/data'`, `CB_DATA_TOKEN='${token}'`]
                : ['# No data API here (DATA_API_URL is not set).']),
            ...Object.entries(keys).map(([name, value]) => `${name}='${value}'`),
            '',
        ].join('\n');
    }
    /**
     * Writes the token file into the computer when the token is new (or
     * `force`); the computer must be running. Returns whether it wrote.
     */
    async provision(app: AppRecord, force = false) {
        const current = this.get(app.id);
        if (!current || AppsService.inRuntime(current)) {
            return false;
        }
        app = current;
        const { token, fresh } = this.token(app);
        if (!fresh && !force && this.provisioned.has(app.id)) {
            return false;
        }
        // Until this write lands, the next refresh (or request) writes it again.
        this.provisioned.delete(app.id);
        await this.options
            .computers()
            .writeFile(app.dotId, appEnvFile(app.slug), this.envFile(app, token), { kind: 'app', id: app.id }, [
                token,
                ...Object.values(this.actorKeyEnv(app)),
            ]);
        this.provisioned.set(app.id, Date.now());
        return true;
    }
    /** Keeps every running app's token file current (the module's tick). */
    async refreshTokens() {
        let written = 0;
        for (const app of this.all().filter((item) => !AppsService.inRuntime(item))) {
            try {
                if ((await this.target(app, true)).state !== 'running') {
                    continue;
                }
                if (await this.provision(app)) {
                    written++;
                }
            } catch {
                // The computer went away meanwhile; the next tick tries again.
            }
        }
        return written;
    }
    /** From the proxy: a request reached a running app; refresh lazily. */
    touch(app: AppRecord) {
        if (AppsService.inRuntime(app)) {
            return;
        }
        const current = this.tokens.get(app.id);
        if (
            current &&
            this.provisioned.has(app.id) &&
            current.expiresAt - Date.now() > DAY &&
            this.options.data.tokens.resolve(current.token)
        ) {
            return;
        }
        if (this.provisioning.has(app.id)) {
            return;
        }
        this.provisioning.add(app.id);
        void this.provision(app)
            .catch(() => undefined)
            .finally(() => this.provisioning.delete(app.id));
    }

    // ---- running ------------------------------------------------------------
    /**
     * Where the app listens now; cached for 3 s unless `fresh`. A promoted
     * app is reached through the runtime's ingress, with its headers.
     */
    async target(app: AppRecord, fresh = false): Promise<ProxyTarget> {
        if (AppsService.inRuntime(app)) {
            const runtime = this.options.runtime;
            if (!runtime) {
                return { state: 'not_configured' };
            }
            if (app.status === 'unpublished') {
                return { state: 'stopped' };
            }
            const state = await this.promotions.state(app, fresh);
            if (state === 'running') {
                return {
                    state: 'running',
                    host: runtime.settings.ingress.host,
                    port: runtime.settings.ingress.port,
                    headers: runtime.ingressHeaders(app.id),
                    ...(runtime.signIdentity
                        ? {
                              sign: (method: string, target: string, headers: Record<string, string>) =>
                                  runtime.signIdentity!(app.id, method, target, headers),
                          }
                        : {}),
                };
            }
            return {
                state: state === 'unavailable' || state === 'starting' ? 'unavailable' : 'stopped',
            };
        }
        const key = `${app.dotId}:${app.port}`;
        const cached = this.targets.get(key);
        if (!fresh && cached && Date.now() - cached.at < 3000) {
            return cached.target;
        }
        let target: AppTarget;
        try {
            target = this.options.resolveTarget
                ? await this.options.resolveTarget(app.dotId, app.port)
                : await this.options.computers().appTarget(app.dotId, app.port);
        } catch {
            target = { state: 'unavailable' };
        }
        this.targets.set(key, { at: Date.now(), target });
        return target;
    }
    /** Drops the cached target (the app stopped answering). */
    forget(app: AppRecord) {
        this.targets.delete(`${app.dotId}:${app.port}`);
        this.promotions.forgetState(app.id);
    }
    /** Whether something accepts connections on the app's port (1.5 s). */
    probe(target: { host: string; port: number }) {
        return new Promise<boolean>((resolve) => {
            const socket: Socket = connect({ host: target.host, port: target.port });
            const done = (ok: boolean) => {
                socket.destroy();
                resolve(ok);
            };
            socket.setTimeout(1500, () => done(false));
            socket.once('connect', () => done(true));
            socket.once('error', () => done(false));
        });
    }
    /**
     * Runs the app's start command in its computer, in the background, after
     * sourcing its token file, as the app's own identity. Whatever it ran
     * before goes first (CB-291): its tracked process group (the pid file),
     * then anything of its identity still listening on its port (a process
     * from before it was tracked); the start waits for the port to be free,
     * so a replacement never fails with EADDRINUSE. A port another identity
     * holds is refused (exit 75). `owner`: the owner pressed Start; `agent`:
     * on registration or a repair, as the Dot.
     */
    private async run(app: AppRecord, userId: string, actor: 'owner' | 'agent') {
        if (!app.startCommand) {
            return;
        }
        const result = (await this.options
            .computers()
            .action(app.dotId, 'exec', { command: this.runCommand(app), timeoutMs: 30_000 }, actor, undefined, userId, {
                env: null,
                principal: { kind: 'app', id: app.id },
            })) as { exitCode?: number; stderr?: string } | undefined;
        if (typeof result?.exitCode === 'number' && result.exitCode !== 0) {
            const why = (result.stderr ?? '').trim().split('\n').pop();
            throw new AppError(why || `The start command couldn’t run (exit ${result.exitCode}).`, 409);
        }
        this.started.set(app.id, Date.now());
        // A new process: its uninterrupted uptime starts now.
        this.answering.delete(app.id);
    }
    /** The stop-then-start script `run` sends (POSIX sh, as the app's identity). */
    private runCommand(app: AppRecord) {
        const env = appEnvFile(app.slug);
        const hex = app.port.toString(16).toUpperCase().padStart(4, '0');
        return [
            'mkdir -p .socio/apps',
            `pidf=${appPidFile(app.slug)}`,
            // Its tracked process group: TERM, 5 s, then KILL.
            'pg=$(cat "$pidf" 2>/dev/null); case "$pg" in ""|*[!0-9]*) pg="";; esac',
            // (`kill -SIG -PGID`: dash, ash and bash all read it as a group.)
            'if [ -n "$pg" ] && kill -0 "-$pg" 2>/dev/null; then kill -TERM "-$pg" 2>/dev/null; i=0; while kill -0 "-$pg" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL "-$pg" 2>/dev/null; fi',
            // Sockets listening on its port, and its own processes holding them.
            // (/proc files are read through cat: sh reads byte by byte.)
            `held() { cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | while read -r _ l _ st _ _ _ _ _ ino _; do case "$l" in *:${hex}) [ "$st" = 0A ] && echo "$ino";; esac; done; }`,
            'holders() { ino=$(held); [ -z "$ino" ] && return; ls -l /proc/[0-9]*/fd 2>/dev/null | while read -r line; do case "$line" in /proc/*/fd:) p=${line#/proc/}; p=${p%/fd:};; *socket:*) for i in $ino; do case "$line" in *"socket:[$i]"*) echo "$p";; esac; done;; esac; done; }',
            'for sig in TERM KILL; do ps=$(holders); [ -z "$ps" ] && break; kill -s $sig $ps 2>/dev/null; i=0; while [ -n "$(held)" ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; done',
            `i=0; while [ -n "$(held)" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done`,
            `if [ -n "$(held)" ]; then echo ${quote(`Port ${app.port} is still in use by a process this app can't stop.`)} >&2; exit 75; fi`,
            `set -a && . ./${env} && set +a || exit 1`,
            `export CB_APP_ENV_FILE="$PWD/${env}"`,
            `setsid nohup sh -c ${quote(`cd -- "$HOME/shared" && ${app.startCommand}`)} > ${appLogFile(app.slug)} 2>&1 < /dev/null &`,
            'echo $! > "$pidf"',
        ].join('\n');
    }
    /** Authorized owners/admins read app output through its identity, never its credentials. */
    async computerLog(id: string, userId: string, lines = 100) {
        const app = this.logsOf(id, userId);
        const result = (await this.options
            .computers()
            .action(app.dotId, 'files_read', { path: appLogFile(app.slug) }, 'owner', undefined, userId, {
                principal: { kind: 'app', id: app.id },
            })) as { text?: string };
        return (result.text ?? '').split('\n').slice(-Math.max(1, Math.min(lines, 400)));
    }
    /** The owner's Start: the computer, the token file, then the app. */
    async start(id: string, userId: string) {
        const app = this.get(id);
        if (!app || app.ownerUserId !== userId) {
            throw new AppError('Only the app’s owner can start it.', 403);
        }
        if (AppsService.inRuntime(app)) {
            await this.promotions.ensureRunning(app);
            return;
        }
        await this.health.reset(app.id);
        await this.options.computers().start(app.dotId, userId);
        this.targets.delete(`${app.dotId}:${app.port}`);
        await this.provision(app, true);
        await this.run(app, userId, 'owner');
    }

    // ---- self-healing (CB-291) ----------------------------------------------
    /** What a run of repairs belongs to: a new registration or version starts the count over. */
    private episode(app: AppRecord) {
        // Not `updatedAt`: sharing changes it. A registration, Start or new
        // version resets health explicitly.
        return AppsService.inRuntime(app) ? `v${app.liveVersion}` : `dev:${app.port}`;
    }
    /**
     * The data API refused a token one of the apps was given (expired,
     * revoked, or its issuer restarted). First a live one is renewed in
     * place: the token file (a development app's env file, a promoted
     * app's `CB_DATA_TOKEN_FILE`), which an app that reads it again on a
     * 401 picks up without a restart. If the same refused token comes back
     * after `renewGraceMs`, the app doesn't read it again: its process is
     * replaced with one that holds the live token (bounded, with backoff).
     */
    private refusedToken(token: string) {
        const appId = this.health.appOfToken(token);
        const app = appId ? this.get(appId) : undefined;
        if (!app || app.status === 'unpublished' || (!AppsService.inRuntime(app) && !app.startCommand)) {
            return;
        }
        if (this.repairing.has(app.id)) {
            return;
        }
        this.repairing.add(app.id);
        void this.recoverToken(app, sha(token))
            .catch((error) =>
                this.options.log?.(`Apps: recovering ${app.id} from a refused token failed: ${message(error)}`),
            )
            .finally(() => this.repairing.delete(app.id));
    }
    private async recoverToken(app: AppRecord, hash: string) {
        const now = Date.now();
        const renewal = this.renewals.get(app.id);
        if (renewal?.hashes.has(hash)) {
            if (now - renewal.at < this.timing.renewGraceMs) {
                // It may be reading the new one now.
                return;
            }
            this.renewals.delete(app.id);
            await this.tokenRepair(app, 'it kept using a refused data token after a new one was issued');
            return;
        }
        const state = this.health.get(app.id).state;
        if (state === 'degraded' || state === 'failed') {
            // Under repair already: only the repairs' bounded backoff acts.
            await this.tokenRepair(app, 'its data token was refused');
            return;
        }
        await this.health.recovering(app.id, 'Its data token was refused (expired or revoked); a new one was issued.');
        try {
            if (AppsService.inRuntime(app)) {
                await this.promotions.renewToken(app);
            } else {
                await this.provision(app, true);
            }
        } catch (error) {
            // Delivering it failed: a counted repair, with backoff and escalation.
            await this.tokenRepair(app, `its data token couldn’t be renewed (${message(error)})`);
            return;
        }
        this.renewals.set(app.id, { at: now, hashes: new Set([...(renewal?.hashes ?? []), hash]), settled: false });
    }
    /** A repair for a refused token: kept until one holds, so the tick retries it. */
    private async tokenRepair(app: AppRecord, reason: string) {
        // Kept in the shared table: any runtime resumes it, and none calls
        // the app healthy until it holds.
        await this.health.tokenRepairStarted(app.id, reason);
        if ((await this.repair(app, reason)) === 'ok') {
            await this.health.tokenRepairDone(app.id);
        }
    }
    /**
     * One bounded repair (`AppHealthBook`): the app's process is replaced
     * (promoted: by the runtime; in a computer: `run`, which stops the old
     * one first) with a live token, and must answer. Returns whether it ran.
     */
    private async repair(app: AppRecord, reason: string): Promise<'skipped' | 'failed' | 'ok'> {
        const episode = this.episode(app);
        // Claimed atomically: another runtime on the database may be at it too.
        const claim = await this.health.begin(app.id, episode, reason);
        if (!claim) {
            return 'skipped';
        }
        try {
            // Before each step that acts on the process: what it runs (status,
            // start command, port, live version) is still what this repair was
            // for, and its claim holds. Not `updatedAt`: sharing changes it.
            const current = () => {
                const now = this.get(app.id);
                if (
                    !now ||
                    now.status !== app.status ||
                    now.startCommand !== app.startCommand ||
                    now.port !== app.port ||
                    now.liveVersion !== app.liveVersion ||
                    // A transfer (CB-360): its token would name the old owner.
                    now.ownerUserId !== app.ownerUserId ||
                    !this.health.stillClaimed(claim)
                ) {
                    throw new RepairSuperseded();
                }
            };
            if (AppsService.inRuntime(app)) {
                current();
                // Checked again inside, right before deploying and starting.
                await this.promotions.replaceProcess(app, current);
            } else {
                current();
                await this.provision(app, true);
                current();
                await this.run(app, app.ownerUserId, 'agent');
                await this.waitUp(app);
                const live = this.tokens.get(app.id)?.token;
                if (live) {
                    await this.health.forgetTokensExcept(app.id, live);
                }
            }
        } catch (error) {
            if (error instanceof RepairSuperseded) {
                // No outcome, and its lease goes so the next repair isn't held up.
                await this.health.abandon(claim);
                return 'skipped';
            }
            await this.health.failed(claim, message(error));
            return 'failed';
        }
        await this.health.succeeded(claim, `replaced its process: ${reason}`);
        return 'ok';
    }
    /** A replaced development app must answer on its port within `upWaitMs`. */
    private async waitUp(app: AppRecord) {
        const deadline = Date.now() + this.timing.upWaitMs;
        while (Date.now() < deadline) {
            const target = await this.target(app, true);
            if (target.state === 'running' && (await this.probe(target))) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new AppError(
            `It didn’t answer on port ${app.port} within ${Math.round(this.timing.upWaitMs / 1000)} s; its output is in ${appLogFile(app.slug)}.`,
            503,
        );
    }
    /**
     * The once-a-minute check of apps in computers (the module's tick): an
     * app the platform starts (it has a start command) whose computer runs
     * but whose port doesn't answer is replaced, with the bounded backoff;
     * one that stays up after a repair is healthy again. A token renewed in
     * place that nobody used refused since counts as recovered.
     */
    async checkHealth() {
        const now = Date.now();
        for (const [appId, renewal] of this.renewals) {
            if (!renewal.settled && now - renewal.at >= 2 * this.timing.renewGraceMs) {
                renewal.settled = true;
                await this.health.renewalHeld(appId, 'renewed its data token without a restart');
            }
        }
        // Token repairs that failed: again on the backoff, answering port or not.
        for (const { appId, reason } of this.health.tokenRepairs()) {
            const app = this.get(appId);
            if (!app || app.status === 'unpublished') {
                await this.health.tokenRepairDone(appId);
                continue;
            }
            if (this.repairing.has(appId)) {
                continue;
            }
            this.repairing.add(appId);
            try {
                await this.tokenRepair(app, reason);
            } catch (error) {
                this.options.log?.(`Apps: repairing ${appId} failed: ${message(error)}`);
            } finally {
                this.repairing.delete(appId);
            }
        }
        for (const app of this.all()) {
            if (AppsService.inRuntime(app) || !app.startCommand || this.repairing.has(app.id)) {
                continue;
            }
            this.repairing.add(app.id);
            try {
                const target = await this.target(app, true);
                if (target.state !== 'running') {
                    continue;
                }
                if (await this.probe(target)) {
                    if (!this.answering.has(app.id)) {
                        this.answering.set(app.id, Date.now());
                    }
                    await this.health.settle(app.id, this.answering.get(app.id)!);
                    continue;
                }
                this.answering.delete(app.id);
                const started = this.started.get(app.id);
                if (started && Date.now() - started < this.timing.startGraceMs) {
                    continue;
                }
                await this.repair(app, `it didn’t answer on port ${app.port}`);
            } catch (error) {
                this.options.log?.(`Apps: checking ${app.id} failed: ${message(error)}`);
            } finally {
                this.repairing.delete(app.id);
            }
        }
    }
    /**
     * After a transfer of ownership committed (CB-360): each app's data
     * token names its old owner, so it is revoked. A promoted app the
     * runtime runs is restarted right away, as a self-healing repair
     * replaces it (CB-291), with a token of the new owner's; a stopped one
     * gets one when it next starts. A development app gets one on the next
     * token refresh, and reads it again on its first refused call. One that
     * can't restart now recovers the same way: its old token is refused.
     * When the runtime can't be reached, the restart is skipped with a note.
     */
    async handedOver(appIds: readonly string[]) {
        const notes: string[] = [];
        for (const id of appIds) {
            const app = this.get(id);
            if (!app) {
                continue;
            }
            if (!AppsService.inRuntime(app)) {
                this.revokeToken(app.id);
                continue;
            }
            const state = await this.promotions.state(app, true);
            this.promotions.dropToken(app.id);
            // Read again: its owner may have acted while the runtime answered.
            const now = this.get(id);
            // The runtime couldn't be reached: nothing to restart now, but
            // say so rather than skip it silently (CB-360).
            if (now?.status === 'promoted' && now.liveVersion && state === 'unavailable') {
                notes.push(
                    `App “${now.name}”: restart skipped, the apps runtime couldn’t be reached; the app picks up the new owner’s token on its next start.`,
                );
                continue;
            }
            if (
                !now ||
                now.status !== 'promoted' ||
                !now.liveVersion ||
                (state !== 'running' && state !== 'starting')
            ) {
                continue;
            }
            // Right before deploying and starting: still promoted, the same
            // version and owner (an unpublish or another transfer meanwhile
            // wins; it acts for itself).
            const guard = () => {
                const latest = this.get(id);
                if (
                    latest?.status !== 'promoted' ||
                    latest.liveVersion !== now.liveVersion ||
                    latest.ownerUserId !== now.ownerUserId
                ) {
                    throw new RepairSuperseded();
                }
            };
            // Its old process's refused calls are this restart's, not a repair's.
            const mine = !this.repairing.has(app.id);
            this.repairing.add(app.id);
            try {
                await this.promotions.replaceProcess(now, guard);
                notes.push(`App “${now.name}” restarted: it acts for its new owner now.`);
            } catch (error) {
                if (error instanceof RepairSuperseded) {
                    continue;
                }
                notes.push(
                    `App “${app.name}” couldn’t restart now (${message(error)}): its old data token no longer works, and it gets the new owner’s on its next call with the old one.`,
                );
            } finally {
                if (mine) {
                    this.repairing.delete(app.id);
                }
            }
        }
        return notes;
    }
    /** Self-healing as Operations → Health shows it (CB-291). */
    healthSummary(): AppsHealthSummary {
        const now = Date.now();
        const apps = new Map(this.all().map((app) => [app.id, app]));
        const rows = this.health.list().filter((row) => apps.has(row.appId));
        const rank = { failed: 0, degraded: 1, recovering: 2, healthy: 3 };
        return {
            watched: [...apps.values()].filter((app) =>
                AppsService.inRuntime(app) ? app.status === 'promoted' : !!app.startCommand,
            ).length,
            unhealthy: rows
                .filter((row) => row.state !== 'healthy')
                .sort((a, b) => rank[a.state] - rank[b.state] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                .map((row) => ({ ...row, name: apps.get(row.appId)!.name, status: apps.get(row.appId)!.status })),
            recoveredLastDay: rows.filter((row) => row.lastRecoveryAt && row.lastRecoveryAt > now - DAY).length,
            check: { ...this.promotions.check },
        };
    }

    // ---- launch codes and sessions -----------------------------------------
    /**
     * A one-time code for the app's origin (60 s, single use, bound to this
     * app and user); returns the URL that redeems it.
     */
    launch(id: string, userId: string, next = '/') {
        const settings = this.requireEnabled();
        const app = this.get(id);
        if (!app || !this.access(userId, app)) {
            throw new AppError('App not found.', 404);
        }
        if (app.status === 'unpublished') {
            throw new AppError('This app is unpublished; its owner can publish it again on the Apps page.', 409);
        }
        const now = Date.now();
        const code = randomBytes(24).toString('base64url');
        this.codes.add(
            hash(code),
            {
                appId: id,
                userId,
                next: safeNext(next),
                expiresAt: now + Math.min(settings.codeTtlMs, 60_000),
            },
            now,
        );
        return `${this.url(app)}/__cb/auth?code=${encodeURIComponent(code)}`;
    }
    /** Redeems a code on the app's origin: a new session's cookie value. */
    async redeem(appId: string, code: string | undefined) {
        const settings = this.requireEnabled();
        if (!code) {
            return undefined;
        }
        // Single use, on every runtime: gone whatever happens next.
        const entry = this.codes.take(hash(code));
        if (!entry || entry.expiresAt <= Date.now() || entry.appId !== appId) {
            return undefined;
        }
        const app = this.get(appId);
        if (!app || !this.access(entry.userId, app)) {
            return undefined;
        }
        const value = randomBytes(32).toString('base64url');
        const now = Date.now();
        await this.repos.sessions.add(
            {
                hash: hash(value),
                appId,
                userId: entry.userId,
                createdAt: now,
                expiresAt: now + settings.sessionTtlMs,
            },
            now,
        );
        return {
            value,
            next: entry.next,
            maxAgeSeconds: settings.sessionTtlMs / 1000,
        };
    }
    /**
     * The session a cookie value holds on this app's origin, if it is live,
     * belongs to this very app and its user may still open it.
     */
    async session(appId: string, value: string | undefined): Promise<AppSession | undefined> {
        if (!value) {
            return undefined;
        }
        return this.sessionByHash(appId, hash(value));
    }
    /**
     * A live session by its row's hash (a person's `cbob_` names it,
     * CB-232): the same checks as `session`.
     */
    async sessionByHash(appId: string, sessionHash: string): Promise<AppSession | undefined> {
        const row = await this.repos.sessions.byHash(sessionHash);
        if (!row || row.appId !== appId || row.expiresAt <= Date.now()) {
            return undefined;
        }
        const app = this.get(appId);
        if (!app) {
            return undefined;
        }
        const access = this.access(row.userId, app);
        if (!access) {
            return undefined;
        }
        return { app, userId: row.userId, access, sessionHash: row.hash };
    }
    /**
     * Ends a person's sessions on every app's origin and their unused
     * sign-in codes (they were deactivated, accounts.ts), and those apps'
     * open connections, which others reopen with their own sessions.
     * Returns how many sessions ended.
     */
    async endSessionsOf(userId: string) {
        const { apps, ended } = await this.repos.sessions.removeOf(userId);
        for (const appId of apps) {
            this.closeSockets(appId);
        }
        // A sign-in code not yet redeemed would make a new one.
        this.codes.forgetUser(userId);
        return ended;
    }
    /** How many sessions `endSessionsOf` would end now (a deactivation preview). */
    sessionCountOf(userId: string) {
        return this.repos.sessions.countOf(userId);
    }
    async endSession(value: string | undefined) {
        if (value) {
            await this.repos.sessions.remove(hash(value));
        }
    }
    /** Live sessions of an app (tests, the owner's view). */
    sessionCount(appId: string) {
        return this.repos.sessions.countLive(appId, Date.now());
    }
    /** An opaque id for a person in one app: stable, not their user id. */
    personId(appId: string, userId: string) {
        return createHmac('sha256', this.options.secret)
            .update(`company-brain-app-user\u0000${appId}\u0000${personSeedOf(this.db, userId)}`)
            .digest('base64url')
            .slice(0, 22);
    }
    /** Open proxied connections (WebSockets), closed when access ends. */
    track(appId: string, socket: { destroy: () => void }) {
        const set = this.sockets.get(appId) ?? new Set();
        set.add(socket);
        this.sockets.set(appId, set);
        return () => {
            set.delete(socket);
            if (!set.size) {
                this.sockets.delete(appId);
            }
        };
    }
    /**
     * A Space's people or access changed (CB-181): the open connections of
     * apps shared with it close, and each person reconnects only if they
     * still may (`access`, at every request).
     */
    closeSpaceSockets(spaceId: string) {
        for (const app of this.all()) {
            if (app.sharedSpaceId === spaceId) {
                this.closeSockets(app.id);
            }
        }
    }
    closeSockets(appId: string) {
        for (const socket of this.sockets.get(appId) ?? []) {
            socket.destroy();
        }
        this.sockets.delete(appId);
    }
    /** The state names people see on the stopped page. */
    static stateLine(state: AppComputerState) {
        return {
            running: 'running',
            stopped: 'This app’s computer is stopped.',
            disabled: 'This socio’s computer is turned off in its settings.',
            not_configured: 'Computers are not set up on this server.',
            unreachable: 'This computer runs on the server’s own machine, where app ports are not reachable.',
            unavailable: 'The computer service is unavailable right now.',
        }[state];
    }
}

/** A path on the app's origin to return to; anything else is `/`. */
export function safeNext(next: string | undefined) {
    if (!next || !next.startsWith('/') || next.startsWith('//')) {
        return '/';
    }
    if (/[\\\r\n\0]/.test(next) || next.startsWith('/__cb/')) {
        return '/';
    }
    return next.slice(0, 1000);
}

/**
 * Deletes a person's sessions on every app's origin; returns the apps they
 * had sessions on and how many ended. The database part of
 * `AppsService.endSessionsOf`, which the auth CLI uses alone.
 */
export function deleteAppSessionsOf(db: DatabaseSync, userId: string) {
    return sqliteAppRepositories(sqliteData(db)).sessions.removeOf(userId);
}
