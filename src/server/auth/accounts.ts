import {
    ASSET_KINDS,
    type AssetKind,
    type AssetTransfer,
    type OwnedKind,
    type OwnedList,
    type ThreadFollower,
    type TransferTally,
} from '@socio/shared/auth';
import type { PersonTrailLine, PersonTrailSource } from '@socio/shared/people';
import type { Space } from '@socio/shared/types';

import type { ActorsShape } from '../actors/contract.js';
import type { GrantAdminShape, GrantsShape } from '../agents/contract.js';
import type { AppOwnershipShape, AppsShape } from '../apps/contract.js';
import type { DataSpaceShape } from '../dataspace/contract.js';
import type { InferenceShape } from '../inference/contract.js';
import type { McpConnectionsShape } from '../mcp/contract.js';
import type { MediaOwnershipShape } from '../media/contract.js';
import type { MemoryOwnershipShape } from '../memory/contract.js';
import type { PluginsShape } from '../plugins/contract.js';
import type { RoomsShape } from '../rooms/contract.js';
import {
    DEACTIVATED_JOB_RUN,
    type JobsShape,
    type ScheduleOwnershipShape,
    type TasksShape,
} from '../schedules/contract.js';
import type { ServiceAccountsShape } from '../service-accounts/contract.js';
import type { SpaceMembershipOwnershipShape } from '../spaces/contract.js';
import type {
    AuditShape,
    AuditTrailShape,
    ConversationOwnershipShape,
    SocioOwnershipShape,
    TrailCursor,
} from '../workspace/contract.js';

import type { AuditRow as PolicyAuditRow } from './access-policy-store.js';
import type { AccountEvent, AuthProvider, PeopleAssets, PeopleFacts, TrailBefore } from './contract.js';

/** Why a deactivated person's schedules are paused (the Schedules page). */
export const DEACTIVATED_SCHEDULE =
    'Paused: its owner was deactivated. It is kept; they can resume it if an admin reactivates them.';

/**
 * Whether someone is a user who may act now: an account the provider lists
 * (Better Auth leaves deactivated people out). Telegram uses it for linked
 * accounts and their turns, the scheduler for owners of scheduled work.
 */
export function activeUser(provider: AuthProvider) {
    return (userId: string) => provider.users().some((user) => user.id === userId);
}

/**
 * What a deactivation reaches, as slices of the other features' tags: their
 * services in the server (`accountEvents`, auth/layer.ts), the database
 * alone in the auth CLI (auth/cli.ts), where nothing runs.
 */
export interface AccountServices {
    /** The workspace audit (`Audit`). */
    workspace: Pick<AuditShape, 'audit'>;
    serviceAccounts: Pick<ServiceAccountsShape, 'revokeKeysMadeBy'>;
    agentGrants: Pick<GrantsShape, 'revokeAllOf'>;
    /** Socios' delegated access for the person (CB-232). */
    actors: Pick<ActorsShape, 'revokePerson'>;
    apps: Pick<AppsShape, 'endSessionsOf'>;
    plugins: Pick<PluginsShape, 'endAccessOf'>;
    /** The task method a deactivation calls (`Tasks`: the core store's `TaskService`). */
    store: Pick<TasksShape, 'pauseOwnedBy'>;
    jobs: Pick<JobsShape, 'stopOwnedBy'>;
    inference: Pick<InferenceShape, 'forgetUser'>;
    mcpConnections?: Pick<McpConnectionsShape, 'forgetUser'>;
    /** Rooms keep an admin (CB-208); the auth CLI's rooms wait for the tick. */
    rooms?: Pick<RoomsShape, 'handOver'>;
    /**
     * Data API tokens the person made. The auth CLI has no data space: a
     * token checks the workspace audit's deactivation line on its next use.
     */
    data?: Pick<DataSpaceShape, 'revokeApiTokensMadeBy'>;
}

/**
 * What a deactivation ends besides sign-in and sessions: the service account
 * keys the person made, their connected agents (CB-90), their socios' delegated
 * access (CB-232), their sessions on mini apps' origins, their plugin sessions
 * and unused launch codes, their scheduled tasks and job schedules (paused,
 * kept), their job runs in progress (stopped), their subscription connections
 * (personal secrets, revoked as before) and their place as a room's last admin
 * (handed to the earliest member, CB-208). Their content is not touched, and
 * stays named after them. Both changes are audited in `workspace_audit`. A
 * reactivation restores sign-in and ends plugin sessions and unused launch
 * codes again, so a cookie from before the deactivation stays dead.
 */
export function accountLifecycle(platform: AccountServices) {
    return async (event: AccountEvent) => {
        const { workspace } = platform;
        const audit = (detail: string) =>
            workspace.audit({
                actor: event.by,
                action: event.action,
                targetKind: 'user',
                targetId: event.userId,
                detail,
            });
        if (event.action === 'reactivate') {
            const pluginAccess = await platform.plugins.endAccessOf(event.userId);
            audit(
                [event.name, pluginAccess && `ended ${pluginAccess} plugin session(s) and launch code(s)`]
                    .filter(Boolean)
                    .join('; '),
            );
            return;
        }
        const keys = platform.serviceAccounts.revokeKeysMadeBy(event.userId);
        const dataTokens = platform.data?.revokeApiTokensMadeBy(event.userId, event.by) ?? [];
        const agents = platform.agentGrants.revokeAllOf(event.userId, event.by);
        const socioAccess = await platform.actors.revokePerson(event.userId, event.by);
        const appSessions = await platform.apps.endSessionsOf(event.userId);
        const pluginAccess = await platform.plugins.endAccessOf(event.userId);
        const paused = await platform.store.pauseOwnedBy(event.userId, DEACTIVATED_SCHEDULE);
        const stopped = platform.jobs.stopOwnedBy(event.userId, DEACTIVATED_JOB_RUN);
        audit(
            [
                event.name,
                event.left && 'left the workspace on their own',
                keys.length &&
                    `revoked keys they made: ${keys.map((key) => `${key.account} / ${key.name}`).join(', ')}`,
                dataTokens.length && `revoked data API tokens they made: ${dataTokens.join(', ')}`,
                agents && `disconnected ${agents} agent(s)`,
                socioAccess && `ended ${socioAccess} socio access grant(s)`,
                appSessions && `ended ${appSessions} mini app session(s)`,
                pluginAccess && `ended ${pluginAccess} plugin session(s) and launch code(s)`,
                paused && `paused ${paused} scheduled task(s)`,
                stopped && `stopped ${stopped} job run(s)`,
            ]
                .filter(Boolean)
                .join('; '),
        );
        await platform.mcpConnections?.forgetUser(event.userId);
        await platform.inference.forgetUser(event.userId);
        // A room whose last active admin they were gets its earliest member as
        // admin, or, with nobody left, stays archived (CB-208).
        await platform.rooms?.handOver(event.userId);
    };
}

/**
 * What `peopleFacts` reads, as slices of the other features' tags: for
 * each thing a deactivation ends (`AccountServices`), the method that
 * counts it without ending it, and what a person can reach.
 */
export interface PeopleFactServices {
    serviceAccounts: Pick<ServiceAccountsShape, 'keysMadeBy' | 'keysCreatedBy'>;
    agentGrants: Pick<GrantsShape, 'countOf'> & Pick<GrantAdminShape, 'list'>;
    actors: Pick<ActorsShape, 'personGrantCount' | 'personTrail'> & {
        grants: Pick<ActorsShape['grants'], 'unrevoked'>;
    };
    apps: Pick<AppsShape, 'sessionCountOf' | 'all'>;
    plugins: Pick<PluginsShape, 'accessCountOf'>;
    store: Pick<TasksShape, 'pausableCountOf'>;
    jobs: Pick<JobsShape, 'runningCountOf'>;
    inference: Pick<InferenceShape, 'connectionCountOf'>;
    mcpConnections?: Pick<McpConnectionsShape, 'connectionCountOf'>;
    rooms?: Pick<RoomsShape, 'handOverPreview' | 'personEvents'>;
    /** The workspace audit: the person's lines, and an admin's action on them. */
    workspace: Pick<AuditShape, 'audit'> & AuditTrailShape;
    /** The Spaces a person can read (the one Space access rule, CB-181), with their level and privacy. */
    spacesFor(userId: string): readonly Space[];
    /** Their row in a Space, if any (`member` or `editor`). */
    spaceRole(spaceId: string, userId: string): string | undefined;
    /** Their linked Telegram, if any. */
    telegramLink(userId: string): Promise<{ username: string | null; linkedAt: number } | undefined>;
    /** Whether this app user may run code now (the `code:run` permission, CB-376). */
    mayRunCode(userId: string): Promise<boolean>;
    /** Their access policy changes, newest first (`access_policy_audit`). */
    policyAudit(actor: string, before: TrailCursor | undefined, limit: number): PolicyAuditRow[];
    /** A user id's, socio's (`dot:<id>`), `system`'s or `cli`'s name. */
    nameOf(actorId: string): string;
    /** A socio's name, if it is there. */
    socioName(socioId: string): string | undefined;
    /** A Space's name, if it is there. */
    spaceName(spaceId: string): string | undefined;
}

/** The trail's sources, in the order lines of the same millisecond are listed (`trailPage`). */
const TRAIL_RANK: Record<PersonTrailSource, number> = { workspace: 3, access_policy: 2, socio_access: 1, room: 0 };
const TRAIL_SOURCES = Object.keys(TRAIL_RANK) as PersonTrailSource[];

/** A trail cursor (`<at>.<source>.<id>`, a `next`) or epoch milliseconds; undefined when neither. */
export function parseTrailBefore(value: string): TrailBefore | undefined {
    if (/^\d{1,15}$/.test(value)) {
        return { at: Number(value) };
    }
    const match = /^(\d{1,15})\.([a-z_]+)\.(\d{1,15})$/.exec(value);
    if (!match || !(TRAIL_SOURCES as string[]).includes(match[2]!)) {
        return undefined;
    }
    return { at: Number(match[1]), source: match[2] as PersonTrailSource, id: Number(match[3]) };
}

/**
 * Where one source's page starts, for a cursor over all of them: lines go
 * newest first, then by source (`TRAIL_RANK`, higher first), then by id.
 */
function sourceCursor(before: TrailBefore | undefined, source: PersonTrailSource): TrailCursor | undefined {
    if (!before) {
        return undefined;
    }
    if (!('source' in before)) {
        return { at: before.at, id: 0 };
    }
    const rank = TRAIL_RANK[source];
    const from = TRAIL_RANK[before.source];
    if (rank === from) {
        return { at: before.at, id: before.id };
    }
    // A later source at the same millisecond is still to come; an earlier one is done.
    return { at: before.at, id: rank < from ? Number.MAX_SAFE_INTEGER : 0 };
}

const VERBS: Record<string, string> = {
    create: 'Added',
    update: 'Changed',
    delete: 'Deleted',
    move: 'Moved',
    unlink: 'Unlinked',
    remove: 'Removed',
    deactivate: 'Deactivated',
    reactivate: 'Reactivated',
    revoke: 'Revoked',
    propose: 'Proposed',
    approve: 'Approved',
    reject: 'Rejected',
    withdraw: 'Withdrew',
    retire: 'Retired',
    restore: 'Restored',
    reseal: 'Re-sealed',
    verify: 'Checked',
    grant: 'Granted',
    read: 'Read',
    deny: 'Refused',
};

const KINDS: Record<string, string> = {
    operations_settings: 'operations settings',
    operations_pricing: 'model prices',
    space_memory: 'Space memory',
    telegram_link: 'Telegram link',
    inference_backend: 'model connection',
    agent_grant: 'connected agent',
    platform_updates: 'update settings',
    feature_flag: 'feature flag',
    flag_tier: 'plan',
    data_key: 'data key',
    workspace_secret: 'secret',
    service_key: 'service key',
};

const words = (code: string) => code.replaceAll('_', ' ');

/**
 * The trail's lines in words, from each source's own columns: ids, names,
 * codes and counts, as the sources store them (never content or secrets).
 */
function trailLines(platform: PeopleFactServices) {
    const { nameOf } = platform;
    return {
        workspace(row: ReturnType<AuditTrailShape['personTrail']>[number]): PersonTrailLine {
            const verb = VERBS[row.action] ?? words(row.action);
            let detail: string;
            if (row.targetKind === 'user') {
                detail = `${verb} ${row.detail || nameOf(row.targetId)}`;
            } else if (row.targetKind === 'space_member') {
                const at = row.targetId.lastIndexOf(':');
                const spaceId = at < 0 ? row.targetId : row.targetId.slice(0, at);
                const space = platform.spaceName(spaceId) ?? spaceId;
                const person = at < 0 ? '' : nameOf(row.targetId.slice(at + 1));
                detail =
                    at < 0
                        ? `Changed the access of Space ${space}: ${row.detail}`
                        : row.action === 'remove'
                          ? `Removed ${person} from Space ${space}`
                          : `${row.action === 'create' ? 'Added' : 'Changed'} ${person} in Space ${space}: ${row.detail}`;
            } else {
                const kind = KINDS[row.targetKind] ?? words(row.targetKind);
                detail = `${verb} ${kind}${row.detail ? `: ${row.detail}` : ` ${row.targetId}`}`;
            }
            return {
                id: `workspace:${row.id}`,
                at: row.createdAt,
                source: 'workspace',
                actorId: row.actor,
                actorName: nameOf(row.actor),
                action: row.action,
                detail,
            };
        },
        policy(row: PolicyAuditRow): PersonTrailLine {
            const ended = [
                row.sessionsEnded && `ended ${row.sessionsEnded} session(s)`,
                row.codeRunsStopped && `stopped ${row.codeRunsStopped} code run(s)`,
            ].filter(Boolean);
            const what =
                row.action === 'change'
                    ? 'Changed the access policy'
                    : row.action === 'reset'
                      ? 'Reset the access policy'
                      : row.action === 'step_up_failed'
                        ? 'Failed a re-authentication for the access policy'
                        : 'Was locked out of re-authenticating for the access policy';
            return {
                id: `access_policy:${row.id}`,
                at: row.at,
                source: 'access_policy',
                actorId: row.actor,
                actorName: nameOf(row.actor),
                action: row.action,
                detail: [what + (row.detail ? `: ${row.detail}` : ''), ...ended].join('; '),
            };
        },
        socio(row: ReturnType<ActorsShape['personTrail']>[number]): PersonTrailLine {
            const actor = row.actorBy ?? 'system';
            const socio = row.socioId ? (platform.socioName(row.socioId) ?? row.socioId) : undefined;
            const parts = [
                row.decision && (row.decision === 'allow' ? 'allowed' : 'refused'),
                socio && `socio ${socio}`,
                row.action && `action ${row.action}`,
                row.audience && `for ${row.audience}`,
                row.status && `status ${row.status}`,
            ].filter(Boolean);
            const detail = `Socio access ${words(row.phase)}${parts.length ? `: ${parts.join(', ')}` : ''}${row.reason ? ` (${words(row.reason)})` : ''}`;
            return {
                id: `socio_access:${row.id}`,
                at: row.at,
                source: 'socio_access',
                actorId: actor,
                actorName: nameOf(actor),
                action: row.decision ? `${row.phase}:${row.decision}` : row.phase,
                detail,
            };
        },
        room(row: Awaited<ReturnType<RoomsShape['personEvents']>>[number]): PersonTrailLine {
            const target =
                row.targetKind === 'person' && row.targetId
                    ? ` ${nameOf(row.targetId)}`
                    : row.targetKind === 'socio' && row.targetId
                      ? ` socio ${platform.socioName(row.targetId) ?? row.targetId}`
                      : '';
            const room = row.roomTitle ? `room “${row.roomTitle}”` : `room ${row.roomId}`;
            return {
                id: `room:${row.id}`,
                at: row.at,
                source: 'room',
                actorId: row.actor,
                actorName: nameOf(row.actor),
                action: row.action,
                detail: `${words(row.action)}${target} in ${room}${row.outcome === 'denied' ? ' (refused)' : ''}${row.detail ? `: ${row.detail}` : ''}`.replace(
                    /^./,
                    (first) => first.toUpperCase(),
                ),
            };
        },
    };
}

/**
 * What admins see of a person beyond their sign-in account (CB-360): what
 * they can reach, and what deactivating them would end, revoke or hand
 * over. Each count comes from the method beside the one
 * `accountLifecycle` calls, so the preview says what a deactivation does.
 * Reads only.
 */
export function peopleFacts(platform: PeopleFactServices): PeopleFacts {
    const appsOwned = (userId: string) => platform.apps.all().filter((app) => app.ownerUserId === userId).length;
    return {
        async reach(userId) {
            return {
                spaces: platform.spacesFor(userId).length,
                socioGrants: platform.actors.personGrantCount(userId),
                connectedAgents: platform.agentGrants.countOf(userId),
                appsOwned: appsOwned(userId),
                keysMade: platform.serviceAccounts.keysMadeBy(userId).length,
                codeAccess: await platform.mayRunCode(userId),
                telegram: !!(await platform.telegramLink(userId)),
            };
        },
        async access(userId) {
            const now = Date.now();
            const link = await platform.telegramLink(userId);
            return {
                spaces: platform.spacesFor(userId).map((space) => {
                    const role = platform.spaceRole(space.id, userId);
                    return {
                        id: space.id,
                        name: space.name,
                        level: space.access === 'editor' ? 'editor' : role ? 'member' : 'everyone',
                        membersOnly: !!space.private,
                    };
                }),
                socioGrants: platform.actors.grants.unrevoked({ personId: userId }).map((grant) => ({
                    id: grant.id,
                    socioId: grant.socioId,
                    socioName: platform.socioName(grant.socioId) ?? null,
                    audiences: [...grant.audiences],
                    scopes: [...grant.scopes],
                    createdAt: grant.createdAt,
                    expiresAt: grant.expiresAt,
                    lastUsedAt: grant.lastUsedAt,
                })),
                connectedAgents: platform.agentGrants.list(userId, now).map((grant) => ({
                    grantId: grant.grantId,
                    clientName: grant.clientName,
                    clientDomain: grant.clientDomain,
                    label: grant.label,
                    scopes: grant.scopes,
                    createdAt: grant.createdAt,
                    lastUsedAt: grant.lastUsedAt,
                    expiresAt: grant.expiresAt,
                })),
                appsOwned: platform.apps
                    .all()
                    .filter((app) => app.ownerUserId === userId)
                    .map((app) => ({ id: app.id, name: app.name })),
                keysMade: platform.serviceAccounts.keysCreatedBy(userId),
                codeAccess: await platform.mayRunCode(userId),
                telegram: link ? { username: link.username ?? null, linkedAt: link.linkedAt } : null,
            };
        },
        async trail(userId, before, limit) {
            // One more than a page from each source tells whether there is a next page.
            const take = limit + 1;
            const lines = trailLines(platform);
            const all = [
                ...platform.workspace.personTrail(userId, sourceCursor(before, 'workspace'), take).map(lines.workspace),
                ...platform.policyAudit(userId, sourceCursor(before, 'access_policy'), take).map(lines.policy),
                ...platform.actors.personTrail(userId, sourceCursor(before, 'socio_access'), take).map(lines.socio),
                ...((await platform.rooms?.personEvents(userId, sourceCursor(before, 'room'), take)) ?? []).map(
                    lines.room,
                ),
            ].sort(
                (a, b) =>
                    b.at - a.at ||
                    TRAIL_RANK[b.source] - TRAIL_RANK[a.source] ||
                    Number(b.id.split(':')[1]) - Number(a.id.split(':')[1]),
            );
            const page = all.slice(0, limit);
            const last = page.at(-1);
            return {
                lines: page,
                next: all.length > limit && last ? `${last.at}.${last.source}.${last.id.split(':')[1]}` : null,
            };
        },
        audit(entry) {
            platform.workspace.audit({
                actor: entry.actor,
                action: entry.action,
                targetKind: 'user',
                targetId: entry.userId,
                detail: entry.detail,
            });
        },
        async deactivationImpact(userId) {
            return {
                keys: platform.serviceAccounts.keysMadeBy(userId),
                connectedAgents: platform.agentGrants.countOf(userId),
                socioGrants: platform.actors.personGrantCount(userId),
                appSessions: await platform.apps.sessionCountOf(userId),
                pluginAccess: platform.plugins.accessCountOf(userId),
                scheduledTasks: await platform.store.pausableCountOf(userId),
                jobRuns: platform.jobs.runningCountOf(userId),
                subscriptionConnections: await platform.inference.connectionCountOf(userId),
                mcpConnections: platform.mcpConnections?.connectionCountOf(userId) ?? 0,
                rooms: (await platform.rooms?.handOverPreview(userId)) ?? { handedOver: 0, archived: 0 },
                appsOwned: appsOwned(userId),
            };
        },
    };
}

/**
 * What `assetTransfers` reads and moves, as each feature's ownership slice
 * (CB-360): the composition builds them on the app's one connection, so
 * every row moves in one transaction.
 */
export interface AssetServices {
    apps: AppOwnershipShape;
    schedules: ScheduleOwnershipShape;
    socios: SocioOwnershipShape;
    spaces: SpaceMembershipOwnershipShape;
    data: Pick<DataSpaceShape, 'ownedData' | 'prepareTransfer'>;
    media: MediaOwnershipShape;
    conversations: ConversationOwnershipShape;
    memories: MemoryOwnershipShape;
    /** What follows a moved conversation besides episodes: its context and page links, learning evidence and Telegram chat. */
    threadFollowers: readonly ThreadFollower[];
    workspace: Pick<AuditShape, 'audit'>;
    /** After the commit: moved apps restart with the new owner's data token (`AppsShape.handedOver`). */
    appsHandedOver?: (appIds: readonly string[]) => Promise<string[]>;
    /** One transaction on the app's connection (`transaction`, CB-110). */
    transaction<T>(work: () => T): Promise<T>;
}

/** The reason a deactivation pauses schedules with, and what a moved one says instead. */
const movedSchedule = (fromName: string) =>
    `Paused: it moved from ${fromName}, whose account is deactivated. Resume it to run it.`;

const merge = (tallies: TransferTally[]): TransferTally => {
    const moved: Record<string, number> = {};
    for (const tally of tallies) {
        for (const [key, value] of Object.entries(tally.moved)) {
            moved[key] = (moved[key] ?? 0) + value;
        }
    }
    return { moved, notes: tallies.flatMap((tally) => tally.notes) };
};

const summary = (kinds: AssetTransfer['kinds']) =>
    kinds
        .map(
            ({ kind, moved }) =>
                `${kind}: ${
                    Object.entries(moved)
                        .map(([what, n]) => `${what} ${n}`)
                        .join(', ') || 'none'
                }`,
        )
        .join('; ');

/**
 * What a person owns, and moving all of it or chosen kinds to another
 * person (CB-360). The company owns its people's work: apps, schedules,
 * personal socios, Space places, the data space, conversations and
 * memories move; what is the person's own (sign-in, secrets, choices,
 * notices) stays (purge/ownership.ts has the decision for each column).
 *
 * The data space's files are copied to the new owner's keys first, under
 * both people's file locks; then every row of every chosen kind moves in
 * one transaction, with an audit line for each person; then the old copies
 * go. Any failure before the commit leaves everything as it was.
 */
export function assetTransfers(platform: AssetServices): PeopleAssets {
    const owned = (userId: string): Record<AssetKind, OwnedList> => ({
        apps: platform.apps.owned(userId),
        schedules: platform.schedules.owned(userId),
        socios: platform.socios.owned(userId),
        spaces: platform.spaces.owned(userId),
        data: platform.data.ownedData(userId),
        conversations: platform.conversations.owned(userId),
        memories: platform.memories.owned(userId),
    });
    return {
        assets(userId) {
            const all = owned(userId);
            return ASSET_KINDS.map((kind): OwnedKind => ({ kind, ...all[kind] }));
        },
        async transfer(parties, chosen, by) {
            const kinds = new Set<AssetKind>(chosen.length ? chosen : ASSET_KINDS);
            // An app's bundles and datasets are its owner's data space: they go together.
            if (kinds.has('apps')) {
                kinds.add('data');
            }
            // The conversations schedules run in go with them, whether or not all do.
            const scheduleThreads =
                kinds.has('schedules') && !kinds.has('conversations')
                    ? platform.schedules.threadsOf(parties.from)
                    : undefined;
            const data = kinds.has('data') ? await platform.data.prepareTransfer(parties) : undefined;
            let result: AssetTransfer['kinds'];
            let appIds: string[] = [];
            try {
                result = await platform.transaction(() => {
                    const tallies = new Map<AssetKind, TransferTally[]>();
                    const add = (kind: AssetKind, tally: TransferTally) =>
                        tallies.set(kind, [...(tallies.get(kind) ?? []), tally]);
                    if (kinds.has('apps')) {
                        const { appIds: moved, ...tally } = platform.apps.transfer(parties);
                        appIds = moved;
                        add('apps', tally);
                    }
                    if (kinds.has('schedules')) {
                        add(
                            'schedules',
                            platform.schedules.transfer(parties, {
                                reason: DEACTIVATED_SCHEDULE,
                                becomes: movedSchedule(parties.fromName),
                            }),
                        );
                    }
                    if (kinds.has('socios')) {
                        add('socios', platform.socios.transfer(parties));
                    }
                    if (kinds.has('spaces')) {
                        add('spaces', platform.spaces.transfer(parties));
                    }
                    if (data) {
                        add('data', data.commit());
                        add('data', platform.media.transfer(parties));
                    }
                    const threadKind: AssetKind | undefined = kinds.has('conversations')
                        ? 'conversations'
                        : scheduleThreads?.length
                          ? 'schedules'
                          : undefined;
                    if (threadKind) {
                        const { threadIds, ...tally } = platform.conversations.transfer(parties, scheduleThreads);
                        add(threadKind, tally);
                        for (const follower of [...platform.threadFollowers, platform.memories]) {
                            add(threadKind, follower.followThreads(parties, threadIds));
                        }
                    }
                    if (kinds.has('memories')) {
                        add('memories', platform.memories.transfer(parties));
                    }
                    const outcome = ASSET_KINDS.filter((kind) => kinds.has(kind)).map((kind) => ({
                        kind,
                        ...merge(tallies.get(kind) ?? []),
                    }));
                    const line = summary(outcome);
                    platform.workspace.audit({
                        actor: by,
                        action: 'transfer',
                        targetKind: 'user',
                        targetId: parties.from,
                        detail: `${parties.fromName}: gave to ${parties.toName} (${parties.to}): ${line}`,
                    });
                    platform.workspace.audit({
                        actor: by,
                        action: 'transfer',
                        targetKind: 'user',
                        targetId: parties.to,
                        detail: `${parties.toName}: received from ${parties.fromName} (${parties.from}): ${line}`,
                    });
                    return outcome;
                });
            } catch (error) {
                await data?.abort();
                throw error;
            }
            const left = (await data?.finish()) ?? [];
            if (left.length) {
                result
                    .find((entry) => entry.kind === 'data')
                    ?.notes.push(
                        `${left.length} old copy(ies) of moved files couldn’t be removed; nothing names them, and a purge of ${parties.fromName} removes them.`,
                    );
            }
            // Running apps still hold a data token of the old owner's: after
            // the commit, and after the bundles' old copies are gone.
            if (appIds.length && platform.appsHandedOver) {
                const notes = await platform
                    .appsHandedOver(appIds)
                    .catch((error: unknown) => [
                        `Moved apps couldn’t be restarted (${error instanceof Error ? error.message : String(error)}); each restarts with the new owner’s data token when its old one is refused.`,
                    ]);
                result.find((entry) => entry.kind === 'apps')?.notes.push(...notes);
            }
            return result;
        },
    };
}
