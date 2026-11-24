/**
 * Sign-in at the HTTP edge: the provider's account hooks, its sign-in routes,
 * the session check every later /api route relies on, its protected routes, and
 * the access policy's routes.
 */
import { Context } from 'effect';
import type { Hono } from 'hono';

import { transaction } from '@socio/data/open';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import { brandingInForce } from '@socio/foundation/settings/branding';
import {
    appPolicyFromEnv,
    appPolicyInForce,
    DEVICE_PROTOCOL,
    WORKSPACE_MANIFEST_PATH,
    workspaceManifestSchema,
} from '@socio/shared/device-sign-in';
import { isAdmin } from '@socio/shared/roles';

import { appOwnership } from '../../apps/infra/sqlite/ownership.js';
import { contextThreadOwnership } from '../../ask/infra/sqlite/ownership.js';
import { accessPolicyRoutes } from '../../auth/access-policy-routes.js';
import { policyAuditBy } from '../../auth/access-policy-store.js';
import { AccessPolicyService } from '../../auth/access-policy.js';
import { accountLifecycle, assetTransfers, peopleFacts } from '../../auth/accounts.js';
import { DEVICE_REFUSAL_WORDS, type AuthSetup } from '../../auth/contract.js';
import { sessionRoutes } from '../../auth/mock.js';
import { ownerNotice } from '../../auth/owner-notice.js';
import { requestUserResolver } from '../../auth/request-user.js';
import { backupDirFromEnv } from '../../backup/backup-service.js';
import { telegramThreadOwnership } from '../../integrations/infra/sqlite/ownership.js';
import { evidenceOwnership } from '../../learning/infra/sqlite/ownership.js';
import type { AppEdge } from '../../main.js';
import { mediaOwnership } from '../../media/infra/sqlite/ownership.js';
import { memoryOwnership } from '../../memory/infra/sqlite/ownership.js';
import { pageThreadOwnership } from '../../pages/infra/sqlite/ownership.js';
import { personPurge } from '../../purge/person.js';
import { purgeSupervisor } from '../../purge/supervisor.js';
import { scheduleOwnership } from '../../schedules/infra/sqlite/ownership.js';
import { spaceMembershipOwnership } from '../../spaces/infra/sqlite/ownership.js';
import { releaseData } from '../../updates/releases.js';
import type { TrailCursor } from '../../workspace/contract.js';
import { conversationOwnership, socioOwnership } from '../../workspace/infra/ownership.js';
import { LegacyActors } from '../actors.js';
import { LegacyAgentGrants } from '../agents.js';
import { LegacyApps } from '../apps.js';
import { LegacyConfig, LegacyModuleContext, LegacyStore, LegacyWorkspace } from '../base.js';
import type { CoreStore } from '../core-store.js';
import { LegacyData } from '../dataspace.js';
import { deviceEndHooks } from '../device-ends.js';
import { LegacyInference } from '../inference.js';
import { LegacyMcpConnections } from '../mcp.js';
import { LegacyNotifications } from '../notifications.js';
import { LegacyPlugins } from '../plugins.js';
import { LegacyRooms } from '../rooms.js';
import { LegacyJobs } from '../schedules.js';
import { LegacyServiceAccounts } from '../service-accounts.js';
import type { AppWorkspace } from '../workspace-parts.js';

/**
 * A deactivated person's keys, mini app sessions, plugin sessions,
 * schedules and job runs end too; the workspace knows who is deactivated,
 * so issues and jobs give them nothing new.
 * Demotion off admin ends plugin sessions and launch codes.
 */
export function wireAccounts(auth: AuthSetup, edge: AppEdge) {
    const { services } = edge;
    const plugins = Context.get(services, LegacyPlugins);
    const workspace = Context.get(services, LegacyWorkspace);
    plugins.useActiveUsers(() => auth.provider.users());
    // What a deactivation reaches, as one slice made here, once.
    auth.provider.onAccountChange?.(
        accountLifecycle({
            workspace,
            serviceAccounts: Context.get(services, LegacyServiceAccounts),
            agentGrants: Context.get(services, LegacyAgentGrants),
            actors: Context.get(services, LegacyActors),
            apps: Context.get(services, LegacyApps),
            plugins,
            store: Context.get(services, LegacyStore).scheduled,
            jobs: Context.get(services, LegacyJobs),
            inference: Context.get(services, LegacyInference),
            mcpConnections: Context.get(services, LegacyMcpConnections),
            rooms: Context.get(services, LegacyRooms),
            data: Context.get(services, LegacyData),
        }),
    );
    // Data API tokens check their maker against the people who may sign in
    // now, with their effective role, not the workspace's last record of it.
    Context.get(services, LegacyData).useActiveUsers(() => auth.provider.users());
    // And at boot: an admin list changed while the server was down ends them too.
    Context.get(services, LegacyData).revokeApiTokensOfFormerAdmins();
    // What admins' roster and the deactivation preview read (CB-360): the
    // same features, through the methods that count without ending.
    auth.provider.usePeopleFacts?.(
        peopleFacts({
            serviceAccounts: Context.get(services, LegacyServiceAccounts),
            agentGrants: Context.get(services, LegacyAgentGrants),
            actors: Context.get(services, LegacyActors),
            apps: Context.get(services, LegacyApps),
            plugins,
            store: Context.get(services, LegacyStore).scheduled,
            jobs: Context.get(services, LegacyJobs),
            inference: Context.get(services, LegacyInference),
            mcpConnections: Context.get(services, LegacyMcpConnections),
            rooms: Context.get(services, LegacyRooms),
            spacesFor: (userId) => workspace.spaceAccess.spacesFor(userId),
            telegramLink: (userId) => workspace.telegram.linkFor(userId),
            mayRunCode: async (userId) => (await auth.provider.mayRunCode?.(userId)) ?? false,
            ...personPageSources(workspace),
        }),
    );
    // What each person owns, and handing it to another (CB-360): each
    // feature's ownership slice, on the app's one connection.
    const db = workspace.db;
    const data = Context.get(services, LegacyData);
    const spaceMemberships = spaceMembershipOwnership(db);
    const assets = assetTransfers({
        apps: appOwnership(db),
        schedules: scheduleOwnership(db),
        socios: socioOwnership(db),
        spaces: spaceMemberships,
        data,
        media: mediaOwnership(db),
        conversations: conversationOwnership(db),
        memories: memoryOwnership(db),
        threadFollowers: [
            contextThreadOwnership(db),
            pageThreadOwnership(db),
            evidenceOwnership(db),
            telegramThreadOwnership(db),
        ],
        workspace,
        appsHandedOver: (appIds) => Context.get(services, LegacyApps).handedOver(appIds),
        transaction: (work) => transaction(db, 'account transfer', work),
    });
    auth.provider.usePeopleAssets?.(assets);
    // Operators' permanent removal (CB-360): the purge CLI's planner,
    // backup and checks, with the settings it would read here
    // (DATABASE_PATH, USER_DATA_DIR, BACKUP_DIR, S3_*), as the data space
    // and the backups already have them. BACKUP_DIR is read as the backups
    // and the bundle import read it, so a purge's copy lands beside theirs.
    const database = db.location();
    if (database) {
        const config = Context.get(services, LegacyConfig);
        auth.provider.usePersonPurge?.(
            personPurge({
                database,
                userDataDir: data.dir,
                tenantId: data.tenantId,
                backupDir: backupDirFromEnv(process.env),
                store: data.objects.driver === 's3' ? data.objects : undefined,
                supervisor: () =>
                    purgeSupervisor({
                        COMPUTER_SUPERVISOR_URL: config.computerSupervisorUrl,
                        COMPUTER_SUPERVISOR_TOKEN: config.computerSupervisorToken,
                    }),
                owned: (userId) => ({
                    ...Object.fromEntries(
                        assets
                            .assets(userId)
                            .filter((kind) => kind.kind !== 'spaces')
                            .map((kind) => [kind.kind, kind.count]),
                    ),
                    spaces: spaceMemberships.soleEditorOf(userId),
                }),
            }),
        );
    }
    auth.provider.onAdminRevoked?.(async (userId) => {
        await plugins.endAccessOf(userId);
        // The data API tokens they made end for good, so a later promotion doesn't bring them back.
        Context.get(services, LegacyData).revokeApiTokensMadeBy(userId, 'system', 'its maker is no longer an admin');
    });
    // A device signed in through the app (CB-352): the workspace audit, and
    // a notice to the person, so a sign-in they didn't make doesn't go unseen.
    const notifications = Context.get(services, LegacyNotifications);
    auth.provider.onDeviceSignIn?.(async ({ userId, deviceId, label, method }) => {
        workspace.audit({
            actor: userId,
            action: 'create',
            targetKind: 'device',
            targetId: deviceId,
            detail: `${label}; ${method}`,
        });
        await notifications.notifyFromApp({
            userId,
            trigger: 'device_sign_in',
            title: 'New device signed in',
            message: `The Socio app on ${label} signed in to your account. If this wasn't you, sign that device out in Settings.`,
            path: '/settings',
        });
    });
    // CB-390: the workspace owner changed (already audited): every active
    // admin is told, so a hand-over never goes unseen.
    auth.provider.onOwnerChanged?.(async (change) => {
        const deactivated = new Set(auth.provider.deactivatedUsers?.() ?? []);
        const notice = ownerNotice(change);
        for (const user of auth.provider.users()) {
            if (isAdmin(user) && !deactivated.has(user.id)) {
                await notifications
                    .notifyFromApp({ userId: user.id, ...notice })
                    .catch((error: unknown) => reportFailure('A workspace owner notice failed', [safeFailure(error)]));
            }
        }
    });
    // CB-352: a device signed out, by whom and how, in the audit before
    // it ends; its push subscription goes after, if it's still that person's.
    auth.provider.useDeviceEnds?.(
        deviceEndHooks((entries) => workspace.auditNow(entries), {
            byEndpoint: (endpoint) => notifications.push.byEndpoint(endpoint),
            remove: (userId, id) => notifications.push.unsubscribe(userId, id),
        }),
    );
    const deactivated = auth.provider.deactivatedUsers?.bind(auth.provider);
    if (deactivated) {
        workspace.useDeactivated(deactivated);
    }
}

/**
 * What the person page (CB-360) reads beyond the roster's counts: the
 * workspace audit, Space rows, the access policy's audit, and names.
 */
function personPageSources(workspace: AppWorkspace) {
    const nameOf = (actorId: string) => {
        if (actorId === 'system') {
            return 'Socio';
        }
        // The auth CLI (`auth/cli.ts`, CLI_ACTOR).
        if (actorId === 'cli') {
            return 'Command line';
        }
        if (actorId.startsWith('dot:')) {
            return workspace.dot(actorId.slice(4))?.name ?? 'A socio';
        }
        return workspace.users().find((user) => user.id === actorId)?.name ?? 'Former member';
    };
    return {
        workspace: workspace.slices.audit,
        spaceRole: (spaceId: string, userId: string) => workspace.spaceAccess.memberRole(spaceId, userId),
        policyAudit: (actor: string, before: TrailCursor | undefined, limit: number) =>
            policyAuditBy(workspace.db, actor, before, limit),
        nameOf,
        socioName: (socioId: string) => workspace.dot(socioId)?.name,
        spaceName: (spaceId: string) => workspace.spaces().find((space) => space.id === spaceId)?.name,
    };
}

/** The GET paths an identity provider may navigate to from its own site, and `extra` (MCP's callback). */
export function signInPaths(auth: AuthSetup, extra: readonly string[]) {
    const navigationPaths = new Set(auth.provider.navigationPaths ?? []);
    for (const path of extra) {
        navigationPaths.add(path);
    }
    const tokenPaths = new Set(auth.provider.tokenPaths ?? []);
    return { navigationPaths, tokenPaths };
}

/**
 * Sign-in endpoints run before the user check; everything after needs a
 * user. The session routes come first: Better Auth serves all of /api/auth.
 */
export function mountSignIn(app: Hono<AppEnv>, auth: AuthSetup, store: CoreStore) {
    sessionRoutes(app, auth.provider, auth.secureCookies, () =>
        brandingInForce(store.slices.settings.settings().branding),
    );
    auth.provider.useWorkspaceName?.(() => brandingInForce(store.slices.settings.settings().branding).name);
    auth.provider.useSavedInviteLinks?.(() => store.slices.settings.settings().appInviteLinks);
    // The app's lease and notification policy (4.1, 9.1; CB-379): an admin's
    // choices in Settings, each over its AUTH_APP_* variable, else the
    // app's own defaults (30 days to the lock, 30 more to the erase, no app
    // lock, message text in notifications).
    const serverPolicy = appPolicyFromEnv(process.env);
    // CB-352: what the Socio app reads before sign-in. Public, and no
    // cookie is read: the same answer for everyone, cached a minute.
    app.get(WORKSPACE_MANIFEST_PATH, function workspaceManifest(c) {
        const signIn = auth.provider.workspaceManifest?.();
        if (!signIn) {
            return c.json({ error: 'Not found.' }, 404);
        }
        const settings = store.slices.settings.settings();
        const branding = brandingInForce(settings.branding);
        c.header('cache-control', 'max-age=60');
        return c.json(
            workspaceManifestSchema.parse({
                ...signIn,
                name: branding.name,
                branding: { name: branding.name, logo: branding.logo },
                serverVersion: releaseData().version,
                protocol: DEVICE_PROTOCOL,
                policy: appPolicyInForce(settings.appPolicy, serverPolicy),
            }),
        );
    });
    auth.provider.routes(app);
}

/** The person behind an /api request, or 401; data tokens, service keys and plugin services are known already. */
export function mountSession(app: Hono<AppEnv>, auth: AuthSetup, edge: AppEdge | undefined) {
    // Its own resolver, with its own record of whom it wrote (the pages' is another).
    const resolveUser = requestUserResolver(auth, edge && { workspace: Context.get(edge.services, LegacyWorkspace) });
    app.use('/api/*', async function sessionUser(c, next) {
        if (c.get('dataToken') || c.get('serviceKey') || c.get('pluginService')) {
            return next();
        }
        const user = await resolveUser(c.req.raw, (name, value) => c.header(name, value, { append: true }));
        if (!user) {
            // The app's requests (with an install id) learn why (CB-352);
            // the web's answer is unchanged.
            const refusal = auth.provider.deviceRefusal?.(c.req.raw) ?? null;
            return refusal
                ? c.json({ error: DEVICE_REFUSAL_WORDS[refusal], code: refusal }, 401)
                : c.json({ error: 'Sign in to continue.', code: 'sign_in' }, 401);
        }
        c.set('user', user);
        await next();
    });
}

/** The provider's own routes that need a signed-in person. */
export function mountProtectedRoutes(app: Hono<AppEnv>, auth: AuthSetup) {
    auth.provider.protectedRoutes?.(app);
}

/** Code access and the sign-in policy (CB-124): operators, in person. */
export function mountAccessPolicy(app: Hono<AppEnv>, auth: AuthSetup, edge: AppEdge) {
    const { services } = edge;
    const workspace = Context.get(services, LegacyWorkspace);
    const notifications = Context.get(services, LegacyNotifications);
    const context = Context.get(services, LegacyModuleContext);
    app.route(
        '/api',
        accessPolicyRoutes(
            new AccessPolicyService({
                db: workspace.db,
                provider: auth.provider,
                users: () => workspace.users(),
                // Every active admin and operator the provider knows now (its
                // roles are the ones in force), signed in since boot or not.
                notifyAdmins: async (notice) => {
                    for (const user of auth.provider.users()) {
                        if (isAdmin(user) && !workspace.isDeactivated(user.id)) {
                            await notifications.notifyFromApp({ userId: user.id, ...notice }).catch(() => undefined);
                        }
                    }
                },
                log: (line) => context.log(line),
                // An admin entitlement the policy took away ends that person's data API tokens for good.
                afterSave: () => void Context.get(services, LegacyData).revokeApiTokensOfFormerAdmins(),
            }),
        ),
    );
}

/** Sign-in's steps, as index.ts orders them: the accounts' wiring, the paths the browser checks let through, sign-in, the session, the protected routes and the access policy. */
export const authRoutes = {
    wireAccounts,
    signInPaths,
    signIn: mountSignIn,
    session: mountSession,
    protectedRoutes: mountProtectedRoutes,
    accessPolicy: mountAccessPolicy,
};
