import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';
import { deletedWith } from '@socio/data/soft-delete';
import type { UnitOfWork } from '@socio/data/uow';
import {
    BundleError,
    decodeBundle,
    DEFAULT_BUNDLE_LIMITS,
    encodeBundle,
    fileChanges,
    globMatch,
    packageable,
    readTarGz,
    type BundleEntry,
    type BundleLimits,
} from '@socio/foundation/apps/bundle';
import { LogRedactor, secretSettings } from '@socio/foundation/apps/log-redact';
import type { AppsSettings } from '@socio/foundation/apps/settings';
import { DataError } from '@socio/foundation/dataspace/data-error';
import type { ActorRevokeReason } from '@socio/shared/actor-scopes';
import { DEFAULT_APP_LOG_RETENTION, type AppLogRetention } from '@socio/shared/apps/app-log-retention';
import { manifestChanges, parseAppManifest, type AppManifest } from '@socio/shared/apps/app-manifest';
import {
    APP_APPROVALS,
    type AppAttemptsState,
    type AppRuntimeState,
    type AppStatus,
    type AppVersionView,
    type DatasetChoice,
    type PromotionChoice,
    type PromotionDataset,
    type PromotionPlan,
    type WorkspaceAppEntry,
} from '@socio/shared/apps/app-types';
import type { RuntimeAttempt } from '@socio/shared/apps/apps-runtime-types';
import { SOCIO_OWNER_PREFIX } from '@socio/shared/data-types';
import { SPACE_PLACE_REFUSED } from '@socio/shared/spaces/space-items';

import type { ApprovalOutcome, ApprovalsShape } from '../approvals/contract.js';
import type { ComputersShape } from '../computers/contract.js';
import type { DataSpaceShape } from '../dataspace/contract.js';

import type { AppActors } from './actor.js';
import type { AppRecord } from './contract.js';
import type { AppAttemptRepository, AppGrant, AppRepositories } from './domain/repositories.js';
import { AppError, appLogFile, RepairSuperseded } from './errors.js';
import type { AppHealthBook } from './health.js';
import { RuntimeRefused, RuntimeUnavailable, type AppsRuntime } from './runtime-client.js';
import type { AppsWorkspace } from './slices.js';

interface VersionRow {
    appId: string;
    version: number;
    manifest: string;
    bundlePath: string;
    sha256: string;
    sizeBytes: number;
    files: number;
    fileList: string;
    createdByDotId: string | null;
    createdAt: number;
}
interface GrantRow {
    appId: string;
    datasetId: string;
    ref: string;
    access: 'read' | 'write';
    createdByPromotion: number;
    createdAt: number;
}

/** What `app_promote` and the wizard ask; the approval runs it from this. */
export interface PromotePayload {
    appId: string;
    version: number;
    datasets: PromotionChoice[];
    env: Record<string, string>;
}
/** What `app_update` asks: a new version, choices for its new datasets. */
export interface UpdatePayload {
    appId: string;
    version: number;
    datasets: PromotionChoice[];
}

export interface PromotionOptions {
    approvals: ApprovalsShape;
    workspace: AppsWorkspace;
    data: DataSpaceShape;
    computers: () => ComputersShape;
    /** Unset: promotion is off (APPS_RUNTIME_URL). */
    runtime?: AppsRuntime;
    bundleLimits?: BundleLimits;
    /** How long attempts and their logs are kept (CB-175); read on each prune. */
    logRetention?: () => AppLogRetention;
    /** Registers the approval handlers (only where apps are served). */
    enabled: boolean;
    /** The data token's life (7 days; refreshed a day before). */
    tokenTtlMs: number;
    log?: (line: string) => void;
}

/**
 * What promotions read and change of the app registry (`AppsService`,
 * which builds them): its records, their status and sessions, and the
 * apps' socio-access keys.
 */
export interface PromotionRegistry {
    readonly settings: AppsSettings | undefined;
    readonly enabled: boolean;
    /** Socio access (CB-232): an app's envelope keys and their rotation. */
    readonly actor: Pick<AppActors, 'keyEnv' | 'rotate'>;
    /** Socio Secrets an app may read, and the required ones it still lacks. */
    readonly workloadSecrets?: { values(appId: string): string[]; needsSetup(appId: string): string[] };
    get(id: string): AppRecord | undefined;
    all(): AppRecord[];
    /** The apps a user may open: their own, and those shared with a Space they read. */
    visibleTo(userId: string): AppRecord[];
    /** One of the user's apps on this Dot, by id, slug or name; throws `AppError` (404) when none. */
    findForDot(userId: string, dotId: string, ref: string): AppRecord;
    url(app: Pick<AppRecord, 'id'>): string;
    sharedSpaceName(app: Pick<AppRecord, 'sharedSpaceId'>, viewer: string): string | null;
    setStatus(id: string, status: AppStatus): Promise<void>;
    endComputerServing(id: string): void;
    endSessions(id: string): Promise<void>;
    endGrants(appId: string, by: string, reason: ActorRevokeReason): Promise<number>;
    /** Self-healing (CB-291): each app's state, repairs and last tokens. */
    readonly health: AppHealthBook;
}

const DAY = 86_400_000;
/** A company socio's shared area's owner id (CB-224). */
const sharedOwnerId = (dotId: string) => `${SOCIO_OWNER_PREFIX}${dotId}`;
/** What a promoted app is degraded by while the runtime can't be reached. */
const RUNTIME_AWAY = 'The workspace app runtime can’t be reached; it is checked again every minute.';
/** Bytes read from the computer per exec (base64 stays under its 64 KB). */
const CHUNK = 45_000;
const DIR = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._ /@+-]{1,200}$/;
// oxlint-disable-next-line no-control-regex -- one line, no control characters
const LINE = /^[^\u0000-\u001f]*$/;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const message = (error: unknown) => (error instanceof Error ? error.message : 'It failed.');
export const bundlePath = (appId: string, version: number) => `apps/${appId}/bundles/v${version}.cbapp`;

/**
 * Promotion and handoff of mini apps, next to `AppsService`:
 * packaged versions, the promotion wizard's plan, the data handoff (move,
 * share or keep per dataset) and the app's grants, the approvals, rollout
 * and rollback in the workspace app runtime, retirement, combining apps,
 * and the tick that keeps promoted apps running with live tokens.
 */
export class AppPromotions {
    /** Each app's live data token, and the owner it was issued for. */
    private tokens = new Map<string, { token: string; expiresAt: number; userId: string }>();
    private statuses = new Map<
        string,
        {
            at: number;
            state: AppRuntimeState;
            version: number | null;
            attempt?: string;
        }
    >();
    private reconciling = new Set<string>();
    /** Apps whose current token the runtime may not have yet (a failed `setToken`). */
    private undelivered = new Set<string>();
    /** The runtime's newest attempt (`id:state`) as last copied, per app. */
    private synced = new Map<string, string>();
    /** Build and start attempts with their logs (CB-146). */
    readonly attempts: AppAttemptRepository;
    /** The once-a-minute check (`reconcile`), as Operations → Health shows it (CB-291). */
    readonly check: {
        lastRunAt: number | null;
        lastOkAt: number | null;
        lastError: string | null;
        failingSince: number | null;
    } = { lastRunAt: null, lastOkAt: null, lastError: null, failingSince: null };
    private uow: UnitOfWork;
    constructor(
        private apps: PromotionRegistry,
        private db: DatabaseSync,
        private repos: AppRepositories,
        private options: PromotionOptions,
    ) {
        this.uow = sqliteData(db).uow;
        this.attempts = repos.attempts;
        if (options.enabled) {
            this.registerApprovals();
        }
    }
    get runtime() {
        return this.options.runtime;
    }
    private get limits() {
        return this.options.bundleLimits ?? DEFAULT_BUNDLE_LIMITS;
    }
    private requireRuntime() {
        if (!this.options.runtime) {
            throw new AppError(
                'The workspace app runtime is not set up here (APPS_RUNTIME_URL); apps can be packaged but not promoted.',
                503,
            );
        }
        return this.options.runtime;
    }
    private owned(id: string, userId: string) {
        const app = this.apps.get(id);
        if (!app || app.ownerUserId !== userId) {
            throw new AppError('App not found.', 404);
        }
        return app;
    }

    // ---- versions -----------------------------------------------------------
    private versionRows(appId: string) {
        return this.db
            .prepare('SELECT * FROM app_versions WHERE appId=? ORDER BY version DESC')
            .all(appId) as unknown as VersionRow[];
    }
    private versionRow(appId: string, version: number) {
        return this.db.prepare('SELECT * FROM app_versions WHERE appId=? AND version=?').get(appId, version) as
            | VersionRow
            | undefined;
    }
    private versionView(row: VersionRow, before?: VersionRow): AppVersionView {
        const manifest = JSON.parse(row.manifest) as AppManifest;
        return {
            version: row.version,
            manifest,
            files: row.files,
            sizeBytes: row.sizeBytes,
            sha256: row.sha256,
            createdAt: row.createdAt,
            createdByDotName: row.createdByDotId
                ? (this.options.workspace.dot(row.createdByDotId)?.name ?? null)
                : null,
            changes: [
                ...manifestChanges(before ? (JSON.parse(before.manifest) as AppManifest) : undefined, manifest),
                ...(before
                    ? fileChanges(
                          JSON.parse(before.fileList) as BundleEntry[],
                          JSON.parse(row.fileList) as BundleEntry[],
                      )
                    : []),
            ],
        };
    }
    versions(appId: string): AppVersionView[] {
        const rows = this.versionRows(appId);
        return rows.map((row, index) => this.versionView(row, rows[index + 1]));
    }
    latest(appId: string) {
        return this.versionRows(appId)[0];
    }
    /**
     * A version's manifest, or the newest version's when `version` is unset
     * (CB-232: a development app's socio-access contract); undefined when
     * there is none.
     */
    manifestOf(appId: string, version?: number | null) {
        const row = version === undefined || version === null ? this.latest(appId) : this.versionRow(appId, version);
        return row ? (JSON.parse(row.manifest) as AppManifest) : undefined;
    }
    /** The bundle's bytes from the owner's data space, checked. */
    private async readBundle(app: AppRecord, row: VersionRow) {
        let bytes: Buffer;
        try {
            bytes = Buffer.from(
                (await this.options.data.getFile({ kind: 'user', userId: app.ownerUserId }, row.bundlePath)).data,
            );
        } catch (error) {
            if (error instanceof DataError && error.status === 503) {
                throw new AppError(error.message, 503);
            }
            throw new AppError(`Version ${row.version}'s bundle is gone from the data space; package it again.`, 409);
        }
        if (sha(bytes) !== row.sha256) {
            throw new AppError(`Version ${row.version}'s bundle doesn't match its checksum; package it again.`, 409);
        }
        return bytes;
    }
    /** Paths and sizes in a version (the wizard's review). */
    files(app: AppRecord, row: VersionRow) {
        return (JSON.parse(row.fileList) as BundleEntry[]).map(({ path, size }) => ({ path, size }));
    }

    // ---- packaging ------------------------------------------------------------
    /**
     * `app_package`: collects the app's source and lockfile from its Dot's
     * computer (`dir`, optionally narrowed by `files` globs), checks the
     * manifest and the caps, and stores a new version, sealed, in the
     * owner's data space under `apps/<id>/bundles/`.
     */
    async package(
        userId: string,
        dotId: string,
        input: { app: string; dir: string; files?: string[]; manifest: unknown },
        signal?: AbortSignal,
    ) {
        const app = this.apps.findForDot(userId, dotId, input.app);
        const parsed = parseAppManifest({
            name: app.name,
            description: app.description,
            ...(input.manifest && typeof input.manifest === 'object' ? input.manifest : {}),
        });
        if (!parsed.ok) {
            throw new AppError(`Manifest: ${parsed.error}`);
        }
        const manifest = parsed.manifest;
        manifest.datasets = manifest.datasets.map((dataset) => ({
            ...dataset,
            id: this.datasetRef(app, userId, dotId, dataset.id),
        }));
        const dir = input.dir.trim().replace(/\/+$/, '') || '.';
        if (!DIR.test(dir)) {
            throw new AppError('dir is a relative directory in your workspace (no .. or leading /).');
        }
        const files = await this.collect(app, userId, dir, input.files, manifest, signal);
        let packed: ReturnType<typeof encodeBundle>;
        try {
            packed = encodeBundle({ manifest, files }, this.limits);
        } catch (error) {
            if (error instanceof BundleError) {
                throw new AppError(error.message);
            }
            throw error;
        }
        const previous = this.latest(app.id);
        const version = (previous?.version ?? 0) + 1;
        const path = bundlePath(app.id, version);
        try {
            await this.options.data.putFile({ kind: 'user', userId }, path, packed.bytes, 'application/gzip');
        } catch (error) {
            throw new AppError(message(error), error instanceof DataError && error.status === 503 ? 503 : 413);
        }
        await this.write('package app', async () => {
            await this.repos.versions.add({
                appId: app.id,
                version,
                manifest,
                bundlePath: path,
                sha256: packed.sha256,
                sizeBytes: packed.sizeBytes,
                files: packed.entries.length,
                fileList: packed.entries,
                createdByDotId: dotId,
                createdAt: Date.now(),
            });
            if (app.status === 'ephemeral') {
                await this.apps.setStatus(app.id, 'packaged');
            }
        });
        this.options.data.audit({ kind: 'dot', userId, dotId }, 'app_package', 'ok', {
            target: path,
            detail: `${app.name} v${version}: ${packed.entries.length} file(s), ${packed.sizeBytes} bytes`,
        });
        const view = this.versionView(this.versionRow(app.id, version)!, previous);
        return { app: app.id, ...view };
    }
    /** A manifest's dataset as the app may name it: `scratch` or an id. */
    private datasetRef(app: AppRecord, userId: string, dotId: string, ref: string) {
        const wanted = ref.trim();
        if (wanted.toLowerCase() === 'scratch') {
            return 'scratch';
        }
        const granted = this.grantRows(app.id).find(
            (grant) => grant.ref.toLowerCase() === wanted.toLowerCase() || grant.datasetId === wanted,
        );
        if (granted) {
            return granted.ref;
        }
        const visible = this.options.data.visible({ kind: 'dot', userId, dotId }, false);
        const match =
            visible.find((item) => item.row.id === wanted) ??
            visible.find((item) => item.row.name.toLowerCase() === wanted.toLowerCase());
        if (!match) {
            throw new AppError(`No dataset "${ref}" is available to this socio (data_list shows yours).`, 404);
        }
        return match.scratch ? 'scratch' : match.row.id;
    }
    /** Lists, packs and reads the files out of the computer (exec only). */
    private async collect(
        app: AppRecord,
        userId: string,
        dir: string,
        globs: string[] | undefined,
        manifest: AppManifest,
        signal?: AbortSignal,
    ) {
        const computers = this.options.computers();
        const exec = async (command: string, timeoutMs = 60_000) => {
            const result = (await computers.action(
                app.dotId,
                'exec',
                { command, timeoutMs },
                'agent',
                signal,
                userId,
            )) as {
                exitCode?: number;
                stdout?: string;
                stderr?: string;
                truncated?: boolean;
            };
            if (result?.exitCode !== 0) {
                throw new AppError(
                    `Packaging failed in the computer: ${(result?.stderr ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200) || `exit ${result?.exitCode}`}`,
                );
            }
            return result;
        };
        const listed = await exec(
            `cd -- ${quote(dir)} && find . \\( -name node_modules -o -name .git -o -name .socio \\) -prune -o -type f -printf '%s\\t%P\\n' | head -n ${this.limits.maxFiles * 4 + 1}`,
        );
        if (listed.truncated) {
            throw new AppError('Too many files there; package a smaller directory.');
        }
        const all = (listed.stdout ?? '')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const tab = line.indexOf('\t');
                return { size: Number(line.slice(0, tab)), path: line.slice(tab + 1) };
            })
            .filter((entry) => Number.isFinite(entry.size) && packageable(entry.path));
        const always = new Set([manifest.entry, 'package.json', 'bun.lock', 'bun.lockb', 'tsconfig.json']);
        const selected = globs?.length
            ? all.filter((entry) => always.has(entry.path) || globs.some((glob) => globMatch(glob, entry.path)))
            : all;
        if (!selected.some((entry) => entry.path === manifest.entry)) {
            throw new AppError(`The entry ${manifest.entry} isn't in ${dir} (or is excluded).`);
        }
        if (selected.length > this.limits.maxFiles) {
            throw new AppError(
                `${selected.length} files: at most ${this.limits.maxFiles} in a bundle. Narrow it with files (e.g. ["src/**", "server.ts"]).`,
            );
        }
        const big = selected.find((entry) => entry.size > this.limits.maxFileBytes);
        if (big) {
            throw new AppError(`${big.path} is ${big.size} bytes; files are at most ${this.limits.maxFileBytes}.`);
        }
        const total = selected.reduce((sum, entry) => sum + entry.size, 0);
        if (total > this.limits.maxBytes) {
            throw new AppError(`The files come to ${total} bytes; a bundle is at most ${this.limits.maxBytes}.`);
        }
        const base = `.socio/apps/${app.slug}.pkg`;
        await computers.writeFile(app.dotId, `${base}-files`, `${selected.map((entry) => entry.path).join('\n')}\n`, {
            kind: 'person',
            id: userId,
        });
        try {
            const packed = await exec(
                `W="$PWD"; cd -- ${quote(dir)} && tar --format=ustar --no-recursion --verbatim-files-from -czf "$W/${base}.tgz" -T "$W/${base}-files" && wc -c < "$W/${base}.tgz" && sha256sum "$W/${base}.tgz" | cut -d' ' -f1`,
            );
            const [sizeLine, digest] = (packed.stdout ?? '').trim().split(/\s+/);
            const size = Number(sizeLine);
            if (!Number.isInteger(size) || !/^[0-9a-f]{64}$/.test(digest ?? '')) {
                throw new AppError('Packaging failed: the archive could not be read.');
            }
            if (size > this.limits.maxBytes) {
                throw new AppError('The packed files are larger than a bundle may be.');
            }
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < size; offset += CHUNK) {
                const part = await exec(
                    `tail -c +${offset + 1} ${quote(`${base}.tgz`)} | head -c ${CHUNK} | base64 -w0`,
                );
                const data = Buffer.from((part.stdout ?? '').trim(), 'base64');
                if (part.truncated || data.length !== Math.min(CHUNK, size - offset)) {
                    throw new AppError('Packaging failed: the archive came back cut.');
                }
                chunks.push(data);
            }
            const archive = Buffer.concat(chunks);
            if (sha(archive) !== digest) {
                throw new AppError('Packaging failed: the archive came back changed.');
            }
            const files = readTarGz(archive, this.limits);
            const wanted = new Set(selected.map((entry) => entry.path));
            if (files.length !== wanted.size || files.some((file) => !wanted.has(file.path))) {
                throw new AppError('Packaging failed: the files changed while they were packed; try again.');
            }
            return files;
        } catch (error) {
            if (error instanceof BundleError) {
                throw new AppError(error.message);
            }
            throw error;
        } finally {
            await exec(`rm -f ${quote(`${base}.tgz`)} ${quote(`${base}-files`)}`).catch(() => undefined);
        }
    }

    // ---- grants ---------------------------------------------------------------
    private grantRows(appId: string) {
        return this.db
            .prepare('SELECT * FROM app_grants WHERE appId=? ORDER BY createdAt, ref')
            .all(appId) as unknown as GrantRow[];
    }
    /** The data space's view of a promoted app's grants (its token). */
    grantsFor(appId: string) {
        const app = this.apps.get(appId);
        if (!app || app.status !== 'promoted') {
            return [];
        }
        return this.grantRows(appId).map(({ datasetId, access, ref }) => ({
            datasetId,
            access,
            ref,
        }));
    }
    /** What the owner sees: each grant with its dataset's name. */
    grantViews(app: AppRecord) {
        // Theirs, or a workspace dataset in the socio's area (CB-354).
        const own = this.options.data
            .datasetsFor(app.ownerUserId)
            .filter(
                (dataset) =>
                    dataset.ownerUserId === app.ownerUserId || dataset.ownerUserId === sharedOwnerId(app.dotId),
            );
        const shared = this.sharedScratch(app);
        return this.grantRows(app.id).map((grant) => ({
            ref: grant.ref,
            datasetId: grant.datasetId,
            access: grant.access,
            createdByPromotion: !!grant.createdByPromotion,
            name:
                own.find((dataset) => dataset.id === grant.datasetId)?.name ??
                (shared?.id === grant.datasetId ? shared.name : 'Deleted'),
        }));
    }
    /** Whether the app's socio is a company socio: its scratch is shared (CB-337). */
    private companySocio(app: AppRecord) {
        return this.options.workspace.dot(app.dotId)?.ownerId === null;
    }
    /**
     * The scratch a company socio's app used before promotion: the socio's
     * shared dataset (its token's `reach`, CB-224), not its owner's own
     * scratch (CB-354). Only while its owner may see the shared area.
     */
    private sharedScratch(app: AppRecord) {
        return this.companySocio(app) ? this.options.data.sharedDatasetFor(app.ownerUserId, app.dotId) : undefined;
    }

    // ---- the wizard's plan ------------------------------------------------------
    private resolveDataset(
        app: AppRecord,
        ref: string,
    ): Omit<PromotionDataset, 'ref' | 'access' | 'tables' | 'choices'> {
        const data = this.options.data;
        const owner = app.ownerUserId;
        const granted = this.grantRows(app.id).find((grant) => grant.ref === ref);
        const company = this.companySocio(app);
        if (company && ref === 'scratch' && !granted) {
            // A company socio's scratch is its shared dataset (CB-354).
            const shared = this.sharedScratch(app);
            const visible = data.canSeeShared(owner, app.dotId);
            return {
                datasetId: shared?.id ?? null,
                name: shared?.name ?? (visible ? 'Shared scratch (empty)' : 'Shared scratch (not visible to you)'),
                kind: 'scratch',
                sizeBytes: shared?.sizeBytes ?? 0,
                tableNames: shared ? data.detailFor(owner, shared.id).tables.map((t) => t.name) : [],
                sharedSpaceId: null,
                sharedArea: true,
            };
        }
        const id = granted?.datasetId ?? (ref === 'scratch' ? data.scratch(owner, app.dotId, false)?.id : ref);
        // Theirs, or a workspace dataset in the socio's area (CB-354) they
        // may see, which another of its apps' data moved into.
        const dataset = id
            ? data
                  .datasetsFor(owner)
                  .find(
                      (item) =>
                          item.id === id &&
                          (item.ownerUserId === owner ||
                              (item.ownerUserId === sharedOwnerId(app.dotId) && !item.scratchForDotId)),
                  )
            : undefined;
        if (!dataset) {
            return {
                datasetId: null,
                name: ref === 'scratch' ? 'Scratch (empty)' : 'Missing dataset',
                kind: ref === 'scratch' && !granted ? 'scratch' : 'missing',
                sizeBytes: 0,
                tableNames: [],
                sharedSpaceId: null,
            };
        }
        return {
            datasetId: dataset.id,
            name: dataset.name,
            // A workspace dataset stays where it is: it is no one person's to share.
            kind: dataset.ownerUserId === owner ? dataset.kind : 'workspace',
            sizeBytes: dataset.sizeBytes,
            tableNames: data.detailFor(owner, dataset.id).tables.map((t) => t.name),
            sharedSpaceId: dataset.sharedSpaceId,
        };
    }
    private planDatasets(app: AppRecord, manifest: AppManifest, only?: Set<string>) {
        return manifest.datasets
            .filter((dataset) => !only || only.has(dataset.id))
            .map((dataset): PromotionDataset => {
                const resolved = this.resolveDataset(app, dataset.id);
                const choices: DatasetChoice[] =
                    resolved.kind === 'scratch'
                        ? ['move', 'share', 'keep']
                        : resolved.kind === 'dataset'
                          ? ['share', 'keep']
                          : resolved.kind === 'workspace'
                            ? ['keep']
                            : [];
                return {
                    ref: dataset.id,
                    access: dataset.access,
                    ...(dataset.tables ? { tables: dataset.tables } : {}),
                    ...resolved,
                    choices,
                };
            });
    }
    /** `GET /api/apps/:id/promotion`: the manifest, files and datasets. */
    plan(id: string, userId: string, version?: number): PromotionPlan {
        const app = this.owned(id, userId);
        const row = version ? this.versionRow(id, version) : this.latest(id);
        if (!row) {
            throw new AppError('Nothing is packaged yet: ask the socio to package the app (app_package).', 409);
        }
        const rows = this.versionRows(id);
        const before = rows.find((item) => item.version < row.version);
        const manifest = JSON.parse(row.manifest) as AppManifest;
        const promoted = app.status === 'promoted' || app.status === 'unpublished';
        const known = new Set(this.grantRows(id).map((grant) => grant.ref));
        return {
            appId: id,
            name: app.name,
            dotName: this.options.workspace.dot(app.dotId)?.name ?? 'A deleted socio',
            version: this.versionView(row, before),
            files: this.files(app, row),
            // An update asks only about datasets the app doesn't have yet.
            datasets: this.planDatasets(
                app,
                manifest,
                promoted ? new Set(manifest.datasets.map((d) => d.id).filter((ref) => !known.has(ref))) : undefined,
            ),
            runtime: !!this.options.runtime,
            promoted,
        };
    }

    // ---- the handoff --------------------------------------------------------------
    /** Checks every choice against the plan; nothing moves without one. */
    private checkChoices(app: AppRecord, plan: PromotionDataset[], choices: PromotionChoice[]) {
        // Only a Space the app's owner may read (CB-181).
        const spaces = this.options.workspace.spaceAccess.readable({
            userId: app.ownerUserId,
        });
        return plan.map((dataset) => {
            const choice = choices.find((item) => item.ref.toLowerCase() === dataset.ref.toLowerCase());
            if (dataset.kind === 'missing') {
                throw new AppError(
                    `The dataset “${dataset.ref}” the manifest names no longer exists; package a version without it.`,
                    409,
                );
            }
            // A company socio's shared data, only for someone who may see it
            // (CB-229): never a way into it, whatever the choice (CB-354).
            if (dataset.sharedArea && !this.options.data.canSeeShared(app.ownerUserId, app.dotId)) {
                throw new AppError(
                    `You can’t see ${this.options.workspace.dot(app.dotId)?.name ?? 'the socio'}’s shared data, so this app can’t be promoted with it. Package a version that doesn’t use “scratch”, or ask an admin to promote it.`,
                    403,
                );
            }
            if (!choice) {
                throw new AppError(`Choose what happens to “${dataset.name}”: ${dataset.choices.join(', ')}.`);
            }
            if (!dataset.choices.includes(choice.choice)) {
                throw new AppError(`“${dataset.name}” can be ${dataset.choices.join(' or ')}, not ${choice.choice}.`);
            }
            if (choice.choice === 'share' && !spaces.some((s) => s.id === choice.spaceId)) {
                throw new AppError(`Choose the Space to share “${dataset.name}” with.`);
            }
            // Only a Space's editors place a dataset in it (CB-451), checked
            // before anything moves: a moved table can't be moved back.
            this.requirePlacing(app, choice);
            const name = (choice.name ?? '').trim();
            if (name && (name.length > 80 || !LINE.test(name))) {
                throw new AppError('A dataset name is one line of up to 80 characters.');
            }
            return { dataset, choice: { ...choice, name } };
        });
    }
    /** A share needs the Space's editor role (CB-451). */
    private requirePlacing(app: AppRecord, choice: PromotionChoice) {
        if (
            choice.choice === 'share' &&
            choice.spaceId &&
            !this.options.workspace.spaceAccess.canEdit(choice.spaceId, app.ownerUserId)
        ) {
            throw new AppError(SPACE_PLACE_REFUSED, 403);
        }
    }
    private checkEnv(manifest: AppManifest, env: Record<string, string>) {
        const names = Object.keys(manifest.env ?? {});
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(env ?? {})) {
            if (!names.includes(name)) {
                throw new AppError(`The manifest has no setting ${name}.`);
            }
            if (typeof value !== 'string' || value.length > 300 || !LINE.test(value)) {
                throw new AppError(`${name} is one line of up to 300 characters.`);
            }
            out[name] = value;
        }
        return out;
    }
    /**
     * Moves, shares or keeps each dataset; returns the app's grants, and the
     * workspace datasets its socio asks to write to once the unit of work
     * is saved (CB-354).
     */
    private handoff(app: AppRecord, checked: ReturnType<AppPromotions['checkChoices']>) {
        const data = this.options.data;
        const owner = app.ownerUserId;
        const dot = this.options.workspace.dot(app.dotId);
        const grants: Array<Omit<AppGrant, 'appId' | 'createdAt'>> = [];
        const lines: string[] = [];
        const workspace: Array<{ id: string; name: string }> = [];
        // Rights may have changed since the choices were checked: again,
        // before the first table moves.
        for (const { choice } of checked) {
            this.requirePlacing(app, choice);
        }
        for (const { dataset, choice } of checked) {
            try {
                let datasetId = dataset.datasetId;
                let created = false;
                if (dataset.kind === 'scratch' && choice.choice !== 'keep') {
                    // Move (and maybe share) out of the Dot's scratch dataset:
                    // a company socio's is its shared one (CB-354).
                    const input = {
                        name: choice.name || `${app.name} data`,
                        description: `Moved from ${dot?.name ?? 'a socio'}’s ${dataset.sharedArea ? 'shared' : 'scratch'} dataset when “${app.name}” was promoted.`,
                        createdByDotId: app.dotId,
                        tables: dataset.tables,
                    };
                    let moved;
                    if (dataset.sharedArea) {
                        // Into a workspace dataset, no person's (CB-354), shared
                        // with the Space at once when asked. Nothing shared yet:
                        // an empty one, so the app starts on its own.
                        data.scratch(sharedOwnerId(app.dotId), app.dotId, true);
                        moved = data.moveSharedToWorkspaceDataset(owner, app.dotId, {
                            ...input,
                            sharedSpaceId: choice.choice === 'share' ? choice.spaceId : null,
                        });
                        // Its socio writes there only once a person approves.
                        if (dot && choice.dotReads !== false) {
                            workspace.push({ id: moved.id, name: moved.name });
                        }
                    } else {
                        moved = data.moveToNewDataset(
                            owner,
                            datasetId ?? data.scratch(owner, app.dotId, true)!.id,
                            input,
                        );
                        if (dot && choice.dotReads !== false) {
                            data.setGrant(
                                owner,
                                { dotId: app.dotId, datasetId: moved.id, access: 'read' },
                                'promotion',
                            );
                        }
                    }
                    datasetId = moved.id;
                    created = true;
                    lines.push(
                        dataset.sharedArea
                            ? `“${dataset.name}” moved into the workspace dataset “${moved.name}”`
                            : `“${dataset.name}” moved into “${moved.name}”`,
                    );
                }
                if (!datasetId) {
                    // Kept: a company socio's app stays on its shared dataset.
                    datasetId = data.scratch(
                        dataset.sharedArea ? sharedOwnerId(app.dotId) : owner,
                        app.dotId,
                        true,
                    )!.id;
                }
                if (choice.choice === 'share' && dataset.sharedArea) {
                    lines.push(
                        `“${dataset.name}” shared with ${this.options.workspace.spaces().find((s) => s.id === choice.spaceId)?.name ?? 'a Space'}`,
                    );
                } else if (choice.choice === 'share') {
                    const shared = data.updateDataset(owner, datasetId, {
                        sharedSpaceId: choice.spaceId!,
                    });
                    lines.push(
                        `“${shared.name}” shared with ${this.options.workspace.spaces().find((s) => s.id === choice.spaceId)?.name ?? 'a Space'}`,
                    );
                } else if (choice.choice === 'keep') {
                    lines.push(`“${dataset.name}” stays where it is`);
                }
                grants.push({
                    datasetId,
                    ref: dataset.ref,
                    access: dataset.access,
                    createdByPromotion: created,
                });
            } catch (error) {
                if (error instanceof DataError) {
                    throw new AppError(error.message, 409);
                }
                throw error;
            }
        }
        return { grants, lines, workspace };
    }
    /**
     * Its socio's request to keep writing to each workspace dataset the
     * app's data moved into (CB-354): a `grant.change` approval the app's
     * owner decides. Once the move is saved, so a refusal never undoes it.
     */
    private async askWorkspaceAccess(app: AppRecord, datasets: Array<{ id: string; name: string }>) {
        const dot = this.options.workspace.dot(app.dotId);
        const lines: string[] = [];
        for (const dataset of datasets) {
            try {
                const outcome = await this.options.data.requestWorkspaceAccess(
                    app.ownerUserId,
                    app.dotId,
                    dataset.id,
                    `So it can keep shipping “${app.name}”, which it built, now that its data is in “${dataset.name}”.`,
                );
                lines.push(
                    outcome.status === 'approved'
                        ? `${dot?.name ?? 'The socio'} can write to “${dataset.name}”`
                        : `${dot?.name ?? 'The socio'} can write to “${dataset.name}” once you approve its request`,
                );
            } catch (error) {
                this.options.log?.(
                    `Apps: asking for ${app.dotId}’s access to a workspace dataset failed: ${message(error)}`,
                );
                lines.push(
                    `${dot?.name ?? 'The socio'} couldn’t ask for access to “${dataset.name}” (${message(error)})`,
                );
            }
        }
        return lines;
    }
    private writeGrants(appId: string, grants: Array<Omit<AppGrant, 'appId' | 'createdAt'>>) {
        return this.repos.grants.replace(appId, grants, Date.now());
    }

    // ---- the runtime ----------------------------------------------------------------
    /**
     * The app's data token, for its owner as the database has it now: a
     * caller may hold a record read before a transfer (CB-360), and a token
     * of the old owner's is never issued or reused after it.
     */
    private token(app: AppRecord, fresh = false) {
        const owner = this.apps.get(app.id)?.ownerUserId ?? app.ownerUserId;
        const current = this.tokens.get(app.id);
        if (
            !fresh &&
            current &&
            current.userId === owner &&
            current.expiresAt - Date.now() > DAY &&
            this.options.data.tokens.resolve(current.token)
        ) {
            return { token: current.token, renewed: false };
        }
        const ttl = this.options.tokenTtlMs;
        const token = this.options.data.tokens.issue(
            {
                userId: owner,
                dotId: app.dotId,
                purpose: 'app',
                session: `app:${app.id}`,
                appId: app.id,
            },
            ttl,
        );
        this.tokens.set(app.id, { token, expiresAt: Date.now() + ttl, userId: owner });
        void this.apps.health.rememberToken(app.id, token).catch(() => undefined);
        return { token, renewed: true };
    }
    /** Ends the app's data tokens (its owner changed, or it stopped being served). */
    dropToken(appId: string) {
        this.options.data.tokens.revokeSession(`app:${appId}`);
        this.tokens.delete(appId);
    }
    private startRequest(app: AppRecord, version: number, token: string) {
        const runtime = this.requireRuntime();
        const api = runtime.settings.dataApiUrl;
        return {
            version,
            token: api ? token : null,
            dataUrl: api ? `${api}/api/data` : null,
            appUrl: this.apps.url(app),
            env: {
                ...(JSON.parse(app.config || '{}') as Record<string, string>),
                // CB-232: its envelope keys, in `env` so an older runtime
                // ignores them (RUNTIME_ACTOR_ENV).
                ...this.apps.actor.keyEnv(app),
            },
        };
    }
    /**
     * `run` for a new live version or its owner's change (promote, update,
     * rollback, publish): earlier repairs no longer apply, whether or not it
     * starts now (CB-291).
     */
    private async runAndReset(app: AppRecord, version: number) {
        await this.apps.health.reset(app.id);
        return this.run(app, version);
    }
    /** Deploys (if the runtime lacks it) and starts one version. */
    /**
     * `guard` (a repair's): called right before deploying and right before
     * starting; it throws `RepairSuperseded` when what the repair was for
     * changed, so a stale version is never started.
     */
    private async run(app: AppRecord, version: number, guard?: () => void) {
        const runtime = this.requireRuntime();
        const row = this.versionRow(app.id, version);
        if (!row) {
            throw new AppError(`Version ${version} doesn't exist.`, 404);
        }
        this.statuses.delete(app.id);
        try {
            return await this.runIn(runtime, app, row, version, guard);
        } finally {
            // Its own log and exit reason, before anything else starts (CB-146).
            await this.syncAttempts(app.id);
        }
    }
    private async runIn(runtime: AppsRuntime, app: AppRecord, row: VersionRow, version: number, guard?: () => void) {
        try {
            const status = await runtime.status(app.id);
            if (!status?.versions.includes(version)) {
                const bundle = await this.readBundle(app, row);
                guard?.();
                await runtime.deploy(app.id, version, bundle, row.sha256);
            }
            guard?.();
            const { token } = this.token(app);
            const started = await runtime.start(app.id, this.startRequest(app, version, token));
            this.statuses.set(app.id, {
                at: Date.now(),
                state: started.state,
                version: started.version,
            });
            return started;
        } catch (error) {
            if (error instanceof RuntimeRefused || error instanceof RuntimeUnavailable) {
                throw new AppError(error.message, error instanceof RuntimeRefused ? 409 : 503);
            }
            throw error;
        }
    }
    private async deployOnly(app: AppRecord, row: VersionRow) {
        const runtime = this.requireRuntime();
        try {
            await runtime.deploy(app.id, row.version, await this.readBundle(app, row), row.sha256);
            await this.syncAttempts(app.id);
        } catch (error) {
            await this.syncAttempts(app.id);
            if (error instanceof RuntimeRefused || error instanceof RuntimeUnavailable) {
                throw new AppError(
                    `The runtime refused version ${row.version}: ${error.message}`,
                    error instanceof RuntimeRefused ? 409 : 503,
                );
            }
            throw error;
        }
    }
    /** The runtime's state for an app (cached for 3 s unless `fresh`). */
    async state(app: AppRecord, fresh = false): Promise<AppRuntimeState> {
        const runtime = this.options.runtime;
        if (!runtime) {
            return 'not_configured';
        }
        const cached = this.statuses.get(app.id);
        if (!fresh && cached && Date.now() - cached.at < 3000) {
            return cached.state;
        }
        let state: AppRuntimeState;
        let version: number | null = null;
        let attempt: string | undefined;
        try {
            const status = await runtime.status(app.id);
            state = status?.state ?? 'not_deployed';
            version = status?.version ?? null;
            if (status?.attempt) {
                attempt = `${status.attempt.id}:${status.attempt.state}`;
            }
        } catch {
            state = 'unavailable';
        }
        this.statuses.set(app.id, { at: Date.now(), state, version, attempt });
        return state;
    }
    forgetState(appId: string) {
        this.statuses.delete(appId);
    }

    // ---- attempts and their logs (CB-146) ----------------------------------------------
    /**
     * Values the app gave the runtime that its output must not show: its
     * data token, the owner's secret settings (`secretSettings`, by the
     * live or newest version's manifest) and its Socio Secrets.
     */
    private secretsOf(app: AppRecord) {
        let config: Record<string, unknown> = {};
        try {
            config = JSON.parse(app.config || '{}') as Record<string, unknown>;
        } catch {
            // Nothing to hide then.
        }
        const row = (app.liveVersion && this.versionRow(app.id, app.liveVersion)) || this.latest(app.id);
        const manifest = row ? (JSON.parse(row.manifest) as AppManifest) : null;
        return [
            ...secretSettings(config, manifest?.env ?? {}),
            this.tokens.get(app.id)?.token,
            // Socio Secrets it may read or read.
            ...(this.apps.workloadSecrets?.values(app.id) ?? []),
        ];
    }
    /**
     * Copies the runtime's attempts of an app into `attempts`, redacted with
     * what the app gave it (the owner's settings, its data token). The
     * runtime keeps them in memory only, so this runs after every deploy and
     * start, when its newest attempt changes, and before they are read. An
     * unreachable runtime leaves what is stored.
     */
    async syncAttempts(appId: string): Promise<'synced' | 'missing' | 'unsupported' | 'failed'> {
        const runtime = this.options.runtime;
        const app = this.apps.get(appId);
        if (!runtime || !app) {
            return 'missing';
        }
        let answer: Awaited<ReturnType<AppsRuntime['attempts']>>;
        try {
            answer = await runtime.attempts(appId);
        } catch (error) {
            this.options.log?.(`Apps: couldn't read the attempts of ${appId} from the runtime: ${message(error)}`);
            return 'failed';
        }
        // Not there (yet), or a runtime that keeps no attempts: what is stored
        // stays as it is, running attempts included.
        if (typeof answer === 'string') {
            return answer;
        }
        const reported: RuntimeAttempt[] = answer.attempts;
        const redactor = new LogRedactor(this.secretsOf(app));
        try {
            await this.attempts.sync(
                appId,
                answer.boot,
                reported.map((attempt) => ({
                    ...attempt,
                    lines: attempt.lines.map((line) => redactor.redact(line)),
                    exit: attempt.exit && {
                        ...attempt.exit,
                        message: redactor.redact(attempt.exit.message),
                    },
                })),
            );
        } catch (error) {
            // Never in the way of a start: the next sync tries again.
            this.options.log?.(`Apps: couldn't store the attempts of ${appId}: ${message(error)}`);
            return 'failed';
        }
        const newest = reported[reported.length - 1];
        if (newest) {
            this.synced.set(appId, `${newest.id}:${newest.state}`);
        } else {
            this.synced.delete(appId);
        }
        return 'synced';
    }
    /** Syncs when the runtime's newest attempt differs from what is stored. */
    private async syncIfChanged(appId: string, attempt: string | undefined) {
        if (attempt && this.synced.get(appId) !== attempt) {
            await this.syncAttempts(appId);
        }
    }
    /**
     * Drops attempts past the retention setting (CB-175), the running one
     * never. The module's tick calls it about hourly.
     */
    async pruneAttempts() {
        const retention = this.options.logRetention?.() ?? DEFAULT_APP_LOG_RETENTION;
        const dropped = await this.attempts.prune(retention);
        if (dropped) {
            this.options.log?.(`Apps: dropped ${dropped} old build and start logs.`);
        }
    }
    /** The app's newest attempt, for its card (after `state`). */
    async lastAttempt(app: AppRecord) {
        await this.syncIfChanged(app.id, this.statuses.get(app.id)?.attempt);
        return (await this.attempts.list(app.id, 1))[0] ?? null;
    }
    /**
     * An app's build and start attempts for whoever manages it (the caller
     * checks): fresh from the runtime, then as stored, newest first, with the
     * one asked for (`attempt`, else the newest of `version`, else the
     * newest) and its last `tail` lines, redacted again with today's values.
     * When there is none, `note` says why.
     */
    async diagnostics(
        app: AppRecord,
        query: { version?: number; attempt?: number; tail?: number } = {},
    ): Promise<AppAttemptsState> {
        const synced = await this.syncAttempts(app.id);
        const attempts = await this.attempts.list(app.id);
        const found = await this.attempts.find(app.id, query);
        const tail = Math.max(1, Math.min(query.tail ?? 400, 400));
        const redactor = new LogRedactor(this.secretsOf(app));
        if (!found && synced === 'unsupported' && this.options.runtime) {
            // A runtime from before attempts: its one log, every version mixed.
            const lines = await this.options.runtime.logs(app.id, tail).catch(() => [] as string[]);
            return {
                attempts,
                attempt: null,
                note: 'This workspace app runtime is older: it keeps one log for every version and start, and no exit reasons. Its last lines are below; the newest are at the end.',
                runtimeLog: lines.map((line) => redactor.redact(line)),
            };
        }
        if (!found) {
            const note =
                query.attempt !== undefined
                    ? `There is no attempt ${query.attempt} of this app${attempts.length ? `; the attempts kept are ${attempts.map((item) => item.attempt).join(', ')}` : ''}.`
                    : query.version !== undefined
                      ? this.versionRow(app.id, query.version)
                          ? `Version ${query.version} has no build or start log yet: the workspace app runtime hasn’t built or started it.`
                          : `Version ${query.version} doesn't exist.`
                      : `No build or start log yet: the app hasn’t been built or started in the workspace app runtime. While it runs in its socio’s computer, its output is in ${appLogFile(app.slug)} there.`;
            return { attempts, attempt: null, note };
        }
        return {
            attempts,
            attempt: {
                ...found,
                message: found.message && redactor.redact(found.message),
                lines: found.lines.slice(-tail).map((line) => redactor.redact(line)),
                dropped: found.dropped + Math.max(0, found.lines.length - tail),
            },
        };
    }

    // ---- promote ----------------------------------------------------------------------
    private checkPromote(userId: string, input: PromotePayload) {
        const app = this.owned(input.appId, userId);
        if (app.status === 'promoted' || app.status === 'unpublished') {
            throw new AppError('This app is promoted already; propose a new version with app_update.', 409);
        }
        this.requireRuntime();
        const row = this.versionRow(app.id, input.version);
        if (!row) {
            throw new AppError(`Version ${input.version} doesn't exist.`, 404);
        }
        const manifest = JSON.parse(row.manifest) as AppManifest;
        const checked = this.checkChoices(app, this.planDatasets(app, manifest), input.datasets ?? []);
        const env = this.checkEnv(manifest, input.env ?? {});
        return { app, row, manifest, checked, env };
    }
    /** Runs a promotion the user chose (the wizard) or approved. */
    async promote(userId: string, input: PromotePayload) {
        const { app, row, manifest, checked, env } = this.checkPromote(userId, input);
        // The bundle first: nothing moves for a version the runtime refuses.
        await this.deployOnly(app, row);
        // One unit of work, queued behind one open on the shared connection
        // (CB-110).
        const { lines, workspace } = await this.write('promote app', async () => {
            const { grants, lines, workspace } = this.handoff(app, checked);
            await this.writeGrants(app.id, grants);
            // The computer's copy loses its data token and its connections.
            this.apps.endComputerServing(app.id);
            await this.repos.apps.promote(app.id, { version: row.version, config: env }, Date.now());
            return { lines, workspace };
        });
        lines.push(...(await this.askWorkspaceAccess(app, workspace)));
        const promoted = this.apps.get(app.id)!;
        this.options.data.audit({ kind: 'user', userId }, 'app_promote', 'ok', {
            target: app.name,
            detail: `v${row.version}; ${lines.join('; ') || 'no datasets'}`.slice(0, 300),
        });
        this.options.log?.(`Apps: promoted ${app.id} v${row.version}.`);
        let started: string;
        try {
            await this.runAndReset(promoted, row.version);
            started = 'It runs in the workspace app runtime now.';
        } catch (error) {
            started = `It didn’t start yet (${message(error)}); see why with app_logs, or Logs on the Apps page.`;
        }
        return `Promoted “${manifest.name}” (version ${row.version}) at ${this.apps.url(app)}. ${lines.length ? `${lines.join('; ')}. ` : ''}${started}`;
    }
    /** `app_promote`: the Dot proposes; the user approves (or bypass). */
    async requestPromote(
        userId: string,
        dotId: string,
        input: Omit<PromotePayload, 'appId'> & { app: string },
        threadId?: string,
    ): Promise<ApprovalOutcome> {
        const found = this.apps.findForDot(userId, dotId, input.app);
        const payload: PromotePayload = {
            appId: found.id,
            version: input.version || this.latest(found.id)?.version || 0,
            datasets: input.datasets,
            env: input.env ?? {},
        };
        const { app, row, manifest, checked } = this.checkPromote(userId, payload);
        const settings = this.apps.settings;
        return this.options.approvals.request({
            userId,
            dotId,
            capability: APP_APPROVALS.promote,
            summary: `Promote the mini app “${manifest.name}” (version ${row.version}) into the workspace`,
            details: [
                `Runs ${manifest.entry} (${row.files} files) in the workspace app runtime at ${this.apps.url(app)}`,
                ...checked.map(
                    ({ dataset, choice }) =>
                        `${dataset.name} (${dataset.access}): ${choice.choice === 'move' ? `move into a new ${dataset.sharedArea ? 'workspace ' : ''}dataset${choice.name ? ` “${choice.name}”` : ''}` : choice.choice === 'share' ? `share with ${this.options.workspace.spaces().find((s) => s.id === choice.spaceId)?.name ?? 'a Space'}` : 'keep where it is'}${dataset.sharedArea && choice.choice !== 'keep' ? ' (its tables leave the socio’s shared dataset for a workspace dataset, which is no one person’s; the socio asks to write to it, which you approve)' : ''}`,
                ),
                `Egress: ${manifest.egress.length ? manifest.egress.join(', ') : 'none'}`,
                ...(settings
                    ? [`Or choose yourself: ${settings.mainOrigin}/apps?promote=${encodeURIComponent(app.id)}`]
                    : []),
            ],
            payload,
            threadId,
        });
    }

    // ---- update and rollback ------------------------------------------------------------
    private checkUpdate(userId: string, input: UpdatePayload) {
        const app = this.owned(input.appId, userId);
        if (app.status !== 'promoted' && app.status !== 'unpublished') {
            throw new AppError('Only a promoted app gets updates; promote it first.', 409);
        }
        this.requireRuntime();
        const row = this.versionRow(app.id, input.version);
        if (!row) {
            throw new AppError(`Version ${input.version} doesn't exist.`, 404);
        }
        if (row.version === app.liveVersion) {
            throw new AppError(`Version ${row.version} is live already.`, 409);
        }
        const manifest = JSON.parse(row.manifest) as AppManifest;
        const known = new Set(this.grantRows(app.id).map((grant) => grant.ref));
        const fresh = new Set(manifest.datasets.map((d) => d.id).filter((ref) => !known.has(ref)));
        const checked = this.checkChoices(app, this.planDatasets(app, manifest, fresh), input.datasets ?? []);
        return { app, row, manifest, checked };
    }
    /** Rolls a new version out; the previous one stays for a rollback. */
    async update(userId: string, input: UpdatePayload) {
        const { app, row, manifest, checked } = this.checkUpdate(userId, input);
        await this.deployOnly(app, row);
        const previous = app.liveVersion;
        // One unit of work, queued behind one open on the shared connection
        // (CB-110).
        const { lines, before, workspace } = await this.write('update app', async () => {
            const { grants: added, lines, workspace } = this.handoff(app, checked);
            // Grants follow the new manifest: new access, new datasets, none for
            // datasets it no longer names (their data stays).
            const current = await this.repos.grants.forApp(app.id);
            const grants = [
                ...manifest.datasets.flatMap((dataset) => {
                    const grant = current.find((item) => item.ref === dataset.id);
                    return grant ? [{ ...grant, access: dataset.access }] : [];
                }),
                ...added,
            ];
            await this.writeGrants(app.id, grants);
            if (app.status === 'unpublished') {
                await this.repos.apps.setVersions(app.id, row.version, previous, Date.now());
            }
            return { lines, before: current, workspace };
        });
        lines.push(...(await this.askWorkspaceAccess(app, workspace)));
        if (app.status === 'unpublished') {
            return `Version ${row.version} of “${manifest.name}” is ready; it starts when the app is published again.`;
        }
        try {
            await this.runAndReset(this.apps.get(app.id)!, row.version);
        } catch (error) {
            // Back to what ran, grants included.
            await this.write('restore app grants', () => this.writeGrants(app.id, before));
            const failed = `Version ${row.version} didn’t start (${message(error)})`;
            const why = `See why with app_logs for version ${row.version}, or Logs on the Apps page.`;
            if (!previous) {
                return `${failed}; the app isn’t running. ${why}`;
            }
            try {
                await this.runAndReset(this.apps.get(app.id)!, previous);
            } catch (again) {
                return `${failed}, and version ${previous} didn’t start again either (${message(again)}): the app isn’t running. ${why}`;
            }
            return `${failed}; version ${previous} is still live. ${why}`;
        }
        await this.write('make app version live', () =>
            this.repos.apps.setVersions(app.id, row.version, previous, Date.now()),
        );
        this.options.data.audit({ kind: 'user', userId }, 'app_update', 'ok', {
            target: app.name,
            detail: `v${previous} → v${row.version}${lines.length ? `; ${lines.join('; ')}` : ''}`.slice(0, 300),
        });
        return `Version ${row.version} of “${manifest.name}” is live (version ${previous} kept for a rollback).${lines.length ? ` ${lines.join('; ')}.` : ''}`;
    }
    /** `app_update`: the Dot proposes a packaged version as an update. */
    async requestUpdate(
        userId: string,
        dotId: string,
        input: { app: string; version?: number; datasets: PromotionChoice[] },
        threadId?: string,
    ): Promise<ApprovalOutcome> {
        const found = this.apps.findForDot(userId, dotId, input.app);
        const payload: UpdatePayload = {
            appId: found.id,
            version: input.version || this.latest(found.id)?.version || 0,
            datasets: input.datasets,
        };
        const { app, row, manifest, checked } = this.checkUpdate(userId, payload);
        const live = app.liveVersion ? this.versionRow(app.id, app.liveVersion) : undefined;
        const view = this.versionView(row, live);
        return this.options.approvals.request({
            userId,
            dotId,
            capability: APP_APPROVALS.update,
            summary: `Update the mini app “${manifest.name}” to version ${row.version}`,
            details: [
                `From version ${app.liveVersion ?? '–'}; that version is kept for a rollback.`,
                ...view.changes.slice(0, 7),
                ...checked.map(
                    ({ dataset, choice }) => `New data: ${dataset.name} (${dataset.access}): ${choice.choice}`,
                ),
            ],
            payload,
            threadId,
        });
    }
    /** The owner's rollback: the previous version runs again. */
    async rollback(id: string, userId: string) {
        const app = this.owned(id, userId);
        if (app.status !== 'promoted' || !app.previousVersion || !app.liveVersion) {
            throw new AppError('There is no previous version to roll back to.', 409);
        }
        await this.runAndReset(app, app.previousVersion);
        await this.repos.apps.setVersions(id, app.previousVersion, app.liveVersion, Date.now());
        this.options.data.audit({ kind: 'user', userId }, 'app_rollback', 'ok', {
            target: app.name,
            detail: `v${app.liveVersion} → v${app.previousVersion}`,
        });
        return this.apps.get(id)!;
    }

    // ---- retirement ------------------------------------------------------------------------
    /** Stops a promoted app; its data and versions stay. */
    async unpublish(id: string, userId: string) {
        const app = this.owned(id, userId);
        if (app.status !== 'promoted') {
            throw new AppError('Only a promoted app can be unpublished.', 409);
        }
        await this.repos.apps.setStatus(id, 'unpublished', Date.now());
        this.dropToken(id);
        await this.apps.endSessions(id);
        await this.apps.endGrants(id, userId, 'audience_unavailable');
        this.statuses.delete(id);
        try {
            await this.requireRuntime().stop(id);
        } catch {
            // The runtime is away: it has nothing running after its restart, and
            // the tick never starts an unpublished app.
        }
        this.options.data.audit({ kind: 'user', userId }, 'app_unpublish', 'ok', {
            target: app.name,
        });
        return this.apps.get(id)!;
    }
    /** Publishes an unpublished app again. */
    async publish(id: string, userId: string) {
        const app = this.owned(id, userId);
        if (app.status !== 'unpublished' || !app.liveVersion) {
            throw new AppError('Only an unpublished app can be published again.', 409);
        }
        await this.repos.apps.setStatus(id, 'promoted', Date.now());
        // A new envelope key: nothing signed before the unpublish verifies.
        await this.apps.actor.rotate(app);
        try {
            await this.runAndReset(this.apps.get(id)!, app.liveVersion);
        } catch (error) {
            return { app: this.apps.get(id)!, warning: message(error) };
        }
        return { app: this.apps.get(id)! };
    }
    /**
     * Deletes a promoted (or unpublished) app: the runtime forgets it and
     * its token ends; the record, versions, bundles and grants are hidden
     * and kept by `AppsService.dropRecord` (CB-64). With `deleteData`, the
     * datasets its promotion created (moved data) are deleted (hidden and
     * kept, `deletedWith app:<retired>`, the id the app is kept under);
     * datasets it only used stay.
     */
    async remove(id: string, userId: string, deleteData: boolean, retired?: string) {
        const app = this.owned(id, userId);
        const deleted: string[] = [];
        const kept: string[] = [];
        if (deleteData) {
            for (const grant of await this.repos.grants.forApp(id)) {
                if (grant.createdByPromotion && this.options.data.isWorkspaceDataset(app.dotId, grant.datasetId)) {
                    // A workspace dataset its data moved into (CB-354): only
                    // by someone who may see the socio's area.
                    try {
                        deleted.push(
                            this.options.data.deleteWorkspaceDataset(
                                userId,
                                app.dotId,
                                grant.datasetId,
                                retired ? { with: deletedWith('app', retired) } : {},
                            ),
                        );
                    } catch (error) {
                        // Deleted already, or not theirs to delete: kept.
                        if (!(error instanceof DataError && error.message === 'Dataset not found.')) {
                            kept.push(grant.datasetId);
                        }
                    }
                } else if (grant.createdByPromotion) {
                    try {
                        const name =
                            this.options.data.datasetsFor(userId).find((dataset) => dataset.id === grant.datasetId)
                                ?.name ?? grant.datasetId;
                        this.options.data.deleteDataset(
                            userId,
                            grant.datasetId,
                            { kind: 'user', userId },
                            retired ? { with: deletedWith('app', retired) } : {},
                        );
                        deleted.push(name);
                    } catch {
                        // Deleted already.
                    }
                }
            }
        }
        try {
            await this.options.runtime?.remove(id);
        } catch {
            // Gone with the runtime's restart, or unreachable: nothing runs it.
        }
        this.dropToken(id);
        this.statuses.delete(id);
        // A new app at its address syncs its own attempts from scratch.
        this.synced.delete(id);
        this.options.data.audit({ kind: 'user', userId }, 'app_delete', 'ok', {
            target: app.name,
            detail: deleteData
                ? `with its data${deleted.length ? `: ${deleted.join(', ')}` : ' (none of its own)'}${kept.length ? `; workspace data it can’t delete kept: ${kept.join(', ')}` : ''}`
                : 'data kept',
        });
        return { deletedDatasets: deleted };
    }
    /** The runtime's raw log of an app whose logs the caller may read (`AppsService.logsOf`). */
    async logs(app: AppRecord) {
        const id = app.id;
        if (app.status !== 'promoted' && app.status !== 'unpublished') {
            throw new AppError('Logs are for promoted apps; an ephemeral app logs in its computer.', 409);
        }
        try {
            return await this.requireRuntime().logs(id, 300);
        } catch (error) {
            if (error instanceof RuntimeRefused && error.status === 404) {
                return [];
            }
            if (error instanceof AppError) {
                throw error;
            }
            throw new AppError(message(error), 503);
        }
    }

    // ---- combine ------------------------------------------------------------------------------
    /**
     * `app_combine`: copies the bundles of several of the user's apps into
     * the Dot's computer as a starting point for a new one (each under its
     * own folder, with a COMBINE.md of their manifests). The new app goes
     * through register, package and promote like any other.
     */
    async combine(
        userId: string,
        dotId: string,
        input: { apps: string[]; name: string; dir?: string },
        signal?: AbortSignal,
    ) {
        const name = input.name.trim();
        if (!name || name.length > 60 || !LINE.test(name)) {
            throw new AppError('Name the new app (1 to 60 characters).');
        }
        const slug =
            name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 30) || 'combined';
        const dir = (input.dir?.trim() || `combined/${slug}`).replace(/\/+$/, '');
        if (!DIR.test(dir)) {
            throw new AppError('dir is a relative directory in your workspace.');
        }
        const wanted = [...new Set(input.apps.map((ref) => ref.trim().toLowerCase()))];
        if (wanted.length < 2 || wanted.length > 6) {
            throw new AppError('Combine 2 to 6 apps.');
        }
        const mine = this.apps.all().filter((app) => app.ownerUserId === userId);
        const sources = [];
        for (const ref of wanted) {
            const app =
                mine.find((item) => item.id === ref) ??
                mine.find((item) => item.slug === ref) ??
                mine.find((item) => item.name.toLowerCase() === ref);
            if (!app) {
                throw new AppError(`No app "${ref}" of yours.`, 404);
            }
            const row = (app.liveVersion ? this.versionRow(app.id, app.liveVersion) : undefined) ?? this.latest(app.id);
            if (!row) {
                throw new AppError(`“${app.name}” has no packaged version to start from.`, 409);
            }
            sources.push({
                app,
                row,
                bundle: decodeBundle(await this.readBundle(app, row), this.limits),
            });
        }
        const computers = this.options.computers();
        if (!(await this.options.workspace.computers.permissions(dotId)).enabled) {
            throw new AppError('This socio’s computer is turned off.', 403);
        }
        const binaries: string[] = [];
        let written = 0;
        for (const { app, bundle } of sources) {
            for (const file of bundle.files) {
                const path = `${dir}/${app.slug}/${file.path}`;
                const text = file.data.toString('utf8');
                signal?.throwIfAborted();
                if (Buffer.from(text, 'utf8').equals(file.data) && !text.includes('\0')) {
                    await computers.writeFile(dotId, path, text, {
                        kind: 'person',
                        id: userId,
                    });
                } else {
                    await computers.writeFile(dotId, `${path}.b64`, file.data.toString('base64'), {
                        kind: 'person',
                        id: userId,
                    });
                    binaries.push(path);
                }
                written++;
            }
        }
        const summary = [
            `# ${name}`,
            '',
            'A new mini app combined from these apps. Each folder holds one app’s packaged source as it was; write the new server from them, then app_register, app_package and app_promote it.',
            '',
            ...sources.flatMap(({ app, row, bundle }) => [
                `## ${app.name} (${app.slug}/, version ${row.version})`,
                '',
                `- Entry: ${bundle.manifest.entry}`,
                `- Datasets: ${bundle.manifest.datasets.map((d) => `${d.id} (${d.access})`).join(', ') || 'none'}`,
                `- Egress: ${bundle.manifest.egress.join(', ') || 'none'}`,
                ...(bundle.manifest.description ? [`- ${bundle.manifest.description}`] : []),
                '',
            ]),
        ].join('\n');
        await computers.writeFile(dotId, `${dir}/COMBINE.md`, summary, {
            kind: 'person',
            id: userId,
        });
        if (binaries.length) {
            await computers.action(
                dotId,
                'exec',
                {
                    command: binaries
                        .map(
                            (path) =>
                                `base64 -d ${quote(`${path}.b64`)} > ${quote(path)} && rm -f ${quote(`${path}.b64`)}`,
                        )
                        .join(' && '),
                    timeoutMs: 60_000,
                },
                'agent',
                signal,
                userId,
            );
        }
        return {
            dir,
            files: written + 1,
            from: sources.map(({ app, row }) => ({
                app: app.name,
                version: row.version,
            })),
            next: `Build the new app in ${dir} (see COMBINE.md), run it, then app_register it, app_package it and propose promoting it with app_promote, which shows the user an approval card.`,
        };
    }

    // ---- launcher and tick ------------------------------------------------------------------------
    /** Promoted apps a user may open: launcher and sidebar entries. */
    launcherFor(userId: string): WorkspaceAppEntry[] {
        if (!this.apps.enabled) {
            return [];
        }
        return this.apps
            .visibleTo(userId)
            .filter((app) => app.status === 'promoted')
            .map((app) => ({
                id: app.id,
                name: app.name,
                description: app.description,
                url: this.apps.url(app),
                dotName: this.options.workspace.dot(app.dotId)?.name ?? 'A deleted socio',
                sharedSpaceName: this.apps.sharedSpaceName(app, userId),
                owner: app.ownerUserId === userId,
            }));
    }
    /**
     * Keeps every promoted app running with a live data token: after either
     * side restarts (tokens die with the app, the runtime keeps nothing) it
     * deploys and starts the live version again; a token near its expiry is
     * replaced in place. A version that stopped, crashed until the runtime
     * gave up (`failed`), or never started is repaired with the health
     * book's bounded backoff (CB-291); when that runs out, admins are told
     * and it waits for its owner or a new version. An app that stays up
     * after a repair is healthy again. The check's own failures show in
     * Operations → Health (`check`) and the log, once each.
     */
    async reconcile() {
        if (!this.options.runtime) {
            return 0;
        }
        const health = this.apps.health;
        const now = Date.now();
        this.check.lastRunAt = now;
        let acted = 0;
        let away: string | null = null;
        for (const app of this.apps.all()) {
            if (app.status !== 'promoted' || !app.liveVersion) {
                continue;
            }
            if (this.reconciling.has(app.id)) {
                continue;
            }
            this.reconciling.add(app.id);
            try {
                let status: Awaited<ReturnType<AppsRuntime['status']>>;
                try {
                    status = await this.options.runtime.status(app.id);
                } catch (error) {
                    away = message(error);
                    await health.degraded(app.id, RUNTIME_AWAY);
                    continue;
                }
                await health.clearDegraded(app.id, RUNTIME_AWAY);
                // Crashes and restarts happen between starts: keep their logs.
                if (status?.attempt) {
                    await this.syncIfChanged(app.id, `${status.attempt.id}:${status.attempt.state}`);
                }
                if (
                    !status ||
                    status.state === 'not_deployed' ||
                    status.state === 'stopped' ||
                    status.state === 'failed' ||
                    status.version !== app.liveVersion
                ) {
                    // Not `updatedAt` (sharing changes it): a new version or its
                    // owner's action resets health explicitly (`runAndReset`).
                    const episode = `v${app.liveVersion}`;
                    const reason =
                        status?.state === 'failed'
                            ? `version ${app.liveVersion} kept crashing${status.error ? ` (${status.error})` : ''}`
                            : !status || status.state === 'not_deployed'
                              ? `version ${app.liveVersion} isn’t in the runtime (it restarted)`
                              : status.state === 'stopped'
                                ? `version ${app.liveVersion} stopped`
                                : `the runtime runs version ${status.version}, not ${app.liveVersion}`;
                    const claim = await health.begin(app.id, episode, reason);
                    if (!claim) {
                        // Another runtime claimed this repair.
                        continue;
                    }
                    const version = app.liveVersion;
                    // Right before deploying and starting: still promoted, still
                    // this version, still this repair's claim.
                    const guard = () => {
                        const now = this.apps.get(app.id);
                        // (A transfer meanwhile, CB-360: `token` issues the new owner's.)
                        if (now?.status !== 'promoted' || now.liveVersion !== version || !health.stillClaimed(claim)) {
                            throw new RepairSuperseded();
                        }
                    };
                    try {
                        await this.run(app, version, guard);
                    } catch (error) {
                        if (error instanceof RepairSuperseded) {
                            await health.abandon(claim);
                        } else {
                            await health.failed(claim, message(error));
                        }
                        continue;
                    }
                    await health.succeeded(claim, `started version ${app.liveVersion} again: ${reason}`);
                    acted++;
                    continue;
                }
                if (status.state === 'running') {
                    await health.settle(app.id, status.startedAt);
                }
                const { token, renewed } = this.token(app);
                if (renewed || this.undelivered.has(app.id)) {
                    await this.options.runtime.setToken(app.id, token);
                    this.undelivered.delete(app.id);
                    acted++;
                }
            } catch (error) {
                away = message(error);
            } finally {
                this.reconciling.delete(app.id);
            }
        }
        if (away) {
            if (!this.check.failingSince) {
                this.check.failingSince = now;
                this.options.log?.(`Apps: the check of promoted apps fails: ${away}`);
            }
            this.check.lastError = away;
        } else {
            if (this.check.failingSince) {
                this.options.log?.('Apps: the check of promoted apps works again.');
            }
            this.check.failingSince = null;
            this.check.lastError = null;
            this.check.lastOkAt = now;
        }
        return acted;
    }
    /** The check itself failed (the module's tick): it shows, once in the log. */
    checkFailed(error: unknown) {
        const now = Date.now();
        this.check.lastRunAt = now;
        this.check.lastError = message(error);
        if (!this.check.failingSince) {
            this.check.failingSince = now;
            this.options.log?.(`Apps: the check of promoted apps fails: ${message(error)}`);
        }
    }
    /**
     * A promoted app's data token was refused (CB-291): a new one goes to
     * the runtime, which writes its token file (`CB_DATA_TOKEN_FILE`), so an
     * app that reads it again on a 401 carries on without a restart.
     */
    async renewToken(app: AppRecord) {
        const runtime = this.requireRuntime();
        const { token } = this.token(app);
        // Until the runtime has it, the tick keeps delivering it.
        this.undelivered.add(app.id);
        await runtime.setToken(app.id, token);
        this.undelivered.delete(app.id);
    }
    /**
     * Replaces a promoted app's process with one holding a live token: the
     * runtime stops the old one by its process group, then starts the
     * live version again (CB-291).
     */
    async replaceProcess(app: AppRecord, guard?: () => void) {
        if (app.status !== 'promoted' || !app.liveVersion) {
            throw new AppError('This app is unpublished.', 409);
        }
        const { token } = this.token(app, true);
        await this.run(app, app.liveVersion, guard);
        await this.apps.health.forgetTokensExcept(app.id, token);
    }
    /** The owner's Start on the app's stopped page. */
    async ensureRunning(app: AppRecord) {
        if (app.status !== 'promoted' || !app.liveVersion) {
            throw new AppError('This app is unpublished.', 409);
        }
        // The owner acts: the tick tries again from the start if this fails.
        await this.apps.health.reset(app.id);
        await this.run(app, app.liveVersion);
    }

    /**
     * One unit of work: queued behind one open on the shared connection, a
     * savepoint of this context's own (CB-110).
     */
    private write<T>(label: string, work: () => Promise<T>) {
        return this.uow.run(work, { label, savepoint: true });
    }

    // ---- approvals ------------------------------------------------------------------------------
    private registerApprovals() {
        this.options.approvals.register<PromotePayload>({
            capability: APP_APPROVALS.promote,
            label: 'Promote mini apps',
            description:
                'A socio asks to move one of its mini apps into the workspace: its packaged version runs in the workspace app runtime, and each dataset it uses is moved, shared or kept as listed.',
            execute: ({ userId, payload }) => this.promote(userId, payload),
        });
        this.options.approvals.register<UpdatePayload>({
            capability: APP_APPROVALS.update,
            label: 'Update promoted apps',
            description:
                'A new version of a promoted mini app, with what changed in its code, manifest and data. The previous version is kept for a rollback.',
            execute: ({ userId, payload }) => this.update(userId, payload),
        });
    }
}
