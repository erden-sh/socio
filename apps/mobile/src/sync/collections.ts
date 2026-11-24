import {
    type Collection,
    createCollection,
    localOnlyCollectionOptions,
    type LocalOnlyCollectionUtils,
    type SyncConfig,
} from '@tanstack/db';

import type { ApprovalView } from '@socio/shared/approvals';
import type { IssueSummary } from '@socio/shared/issues/issue-types';
import type { MemoryItem } from '@socio/shared/memory';
import type { InAppNotice } from '@socio/shared/notifications';
import type { RoomInvite } from '@socio/shared/rooms/rooms';
import type { GoalView, JobView, ScheduleView } from '@socio/shared/schedule-types';
import type { AgentRunSummary, Conversation, Dot, Space } from '@socio/shared/types';

import { approvalRow, APPROVALS } from './approvals';
import {
    ISSUE_COMPONENTS,
    ISSUE_USERS,
    type IssueComponentsRow,
    issueKey,
    issueRow,
    ISSUES,
    type IssueUsersRow,
} from './issues';
import { MEMORIES, MEMORY_PROFILE, type MemoryProfileRow, memoryProfileRow, memoryRow } from './memories';
import type { PendingWrite } from './pending';
import { ROOM_INVITES, roomInviteRow } from './room-invites';
import { runRow, RUNS } from './runs';
import {
    goalRow,
    GOALS,
    jobRow,
    JOBS,
    SCHEDULE_LIMITS,
    type ScheduleLimitsRow,
    scheduleLimitsRow,
    scheduleRow,
    SCHEDULES,
} from './schedules';
import {
    CONVERSATIONS,
    DOTS,
    NOTICES,
    SHELL,
    type ShellState,
    type ShellWorkspace,
    SPACES,
    type STATE_KEY,
    type WORKSPACE_KEY,
} from './shell';
import { type ContainerSkills, SKILLS, skillsRow } from './skills';
import type { CacheChange, SnapshotCache } from './snapshot-cache';

// A workspace scope's TanStack DB collections, which screens read through live
// queries (@tanstack/react-db, the hooks in src/live). Each synced collection
// mirrors one of the snapshot cache's (snapshot-cache.ts): its custom `sync`
// writes the rows memory holds as it starts, before `createCollection` returns,
// so they are there for the first frame, then every change the cache tells as
// it applies. Nothing else writes to them; unchanged rows are never written, so
// they keep their object identity and a list re-renders only the rows that
// changed. Besides the first four (shell, conversations, spaces,
// notices), `dots` holds the socios, which /api/workspace sends as their own
// list (shell.ts) and the chat list needs for names and characters. The
// modules' kinds (kinds.ts) add theirs: `issues`, `issueUsers` and
// `issueComponents` (issues.ts); `memories` and `memoryProfile` (memories.ts);
// `approvals` (approvals.ts); `roomInvites` (room-invites.ts);
// `schedules`, `goals`, `jobs` and `scheduleLimits` (schedules.ts); `runs`
// (runs.ts); `skills` (skills.ts). Each fills as its kind loads.
//
// `pending` is local-only: user.db's outbox (pending.ts), laid over the synced
// rows by screen queries. The scope fills it from the outbox (outbox.ts) as it
// opens, then follows each row the outbox publishes.
//
// Every collection's id carries the scope's (`<scope id>/<name>`), and each
// scope makes its own: TanStack DB keys a live query's identity by its
// collections' ids (`useLiveQuery({ query })`), so two scopes, even of one
// workspace, can never share a query or a row. None is collected while nothing
// reads it (`gcTime: 0`): the scope owns them, and `cleanupScopeCollections`
// ends them, with the live queries that read them, when it closes.
//
// That end is final. TanStack DB starts a cleaned-up collection again when
// anything subscribes to it (a live query a screen still under the old
// provider mounts, a hook that subscribes again), and a direct subscription
// outlives cleanup. So every sync run, the local-only one too, first checks
// whether its scope has closed: if so it is ready with no rows and hears
// nothing, and a signed-out person's rows can never come back.

/** The shell's two rows: State without its notices, and WorkspaceState without its lists. */
export type ShellRow =
    | { readonly id: typeof STATE_KEY; readonly value: ShellState }
    | { readonly id: typeof WORKSPACE_KEY; readonly value: ShellWorkspace };

export interface ScopeCollections {
    readonly shell: Collection<ShellRow, string>;
    /** The chat list and the archived chats (`archivedAt`), in no order: the server's is `createdAt` DESC. */
    readonly conversations: Collection<Conversation, string>;
    readonly spaces: Collection<Space, string>;
    /** The socios. */
    readonly dots: Collection<Dot, string>;
    /** The in-app notices, kept past the server's 24 h (at most 200), for the Inbox. */
    readonly notices: Collection<InAppNotice, string>;
    /** The board's issue summaries, by number as text, in no order: the board sorts them. */
    readonly issues: Collection<IssueSummary, string>;
    /** The board list's names for the assignees, as one row (`users`). */
    readonly issueUsers: Collection<IssueUsersRow, string>;
    /** The board list's component labels (CB-442), as one row (`components`); null from a server before them. */
    readonly issueComponents: Collection<IssueComponentsRow, string>;
    /** The person's approval requests, waiting and recently decided, by id, in no order. */
    readonly approvals: Collection<ApprovalView, string>;
    /** The room invites waiting for the person, by room id, in no order. */
    readonly roomInvites: Collection<RoomInvite, string>;
    /** The person's memories and the proposals waiting, by id, told apart by `status`. */
    readonly memories: Collection<MemoryItem, string>;
    /** The profile and the moved time zone, as one row (`profile`). */
    readonly memoryProfile: Collection<MemoryProfileRow, string>;
    /** The person's schedules, by id. */
    readonly schedules: Collection<ScheduleView, string>;
    /** The person's goals, by id, each with its comments. */
    readonly goals: Collection<GoalView, string>;
    /** The person's jobs, by id. */
    readonly jobs: Collection<JobView, string>;
    /** The schedules' limits, usage and an operator's counts, as one row (`limits`). */
    readonly scheduleLimits: Collection<ScheduleLimitsRow, string>;
    /** The latest runs, by run id, in no order: Runs sorts them. */
    readonly runs: Collection<AgentRunSummary, string>;
    /** Each learning container's published skills, by container id. */
    readonly skills: Collection<ContainerSkills, string>;
    /** This device's queued writes (user.db's outbox), local-only. */
    readonly pending: Collection<PendingWrite, string, LocalOnlyCollectionUtils>;
}

/** The synced collections, by name, which is the cache collection each mirrors. */
export const SYNCED_COLLECTIONS = [
    SHELL,
    CONVERSATIONS,
    SPACES,
    DOTS,
    NOTICES,
    ISSUES,
    ISSUE_USERS,
    ISSUE_COMPONENTS,
    APPROVALS,
    ROOM_INVITES,
    MEMORIES,
    MEMORY_PROFILE,
    SCHEDULES,
    GOALS,
    JOBS,
    SCHEDULE_LIMITS,
    RUNS,
    SKILLS,
] as const;
export const PENDING = 'pending';

/** Whether a scope's collections have been cleaned up, which they never come back from. */
interface Gate {
    closed: boolean;
}
const gates = new WeakMap<ScopeCollections, Gate>();

type SyncParams<T extends object> = Parameters<SyncConfig<T, string>['sync']>[0];

/** A sync run of a closed scope's collection: ready, with no rows, and hearing nothing. */
function closedRun<T extends object>({ begin, commit, markReady }: SyncParams<T>): void {
    begin({ snapshot: true });
    commit();
    markReady();
}

/** One collection's changes in a cache change, in one scope ('' for a whole kind). */
function changesFor(name: string, scope: string, change: CacheChange) {
    return {
        upserts: change.upserts.filter((upsert) => upsert.collection === name && upsert.scope === scope),
        removes: change.removes.filter((remove) => remove.collection === name && remove.scope === scope),
    };
}

/** What a collection that mirrors one of the cache's needs. */
export interface MirrorOptions<T extends object> {
    /** The TanStack DB id: `<scope id>/<name>`, and the cache scope after it for a scoped kind. */
    readonly id: string;
    /** The cache collection it mirrors. */
    readonly name: string;
    /** The cache scope ('' for a whole kind; a Space's id for its pages). */
    readonly scope?: string;
    readonly cache: SnapshotCache;
    readonly toItem: (key: string, value: unknown) => T;
    readonly getKey: (item: T) => string;
    /** Whether its owner has closed it, for good: a run then is ready with no rows. */
    readonly closed: () => boolean;
}

/**
 * A collection that mirrors the cache's collection `name` in one scope, filled
 * as it is created, then by every change the cache tells. The scope's own
 * collections are made with it, and so are a scoped kind's (a Space's pages).
 */
export function mirrorCollection<T extends object>(options: MirrorOptions<T>): Collection<T, string> {
    const { id, name, scope = '', cache, toItem, getKey, closed } = options;
    return createCollection<T, string>({
        id,
        getKey,
        gcTime: 0,
        startSync: true,
        sync: {
            rowUpdateMode: 'full',
            sync: (params) => {
                if (closed()) {
                    closedRun(params);
                    return;
                }
                const { begin, write, commit, markReady, collection } = params;
                // Memory's rows now, replacing whatever an earlier run left.
                begin({ snapshot: true });
                for (const row of cache.rows(name, scope).values()) {
                    write({ type: 'insert', value: toItem(row.key, JSON.parse(row.json) as unknown) });
                }
                commit();
                markReady();
                return cache.subscribe((change) => {
                    const { upserts, removes } = changesFor(name, scope, change);
                    if (upserts.length === 0 && removes.length === 0) {
                        return;
                    }
                    begin();
                    for (const upsert of upserts) {
                        const value = toItem(upsert.key, upsert.value);
                        write({ type: collection.has(upsert.key) ? 'update' : 'insert', value });
                    }
                    for (const { key } of removes) {
                        if (collection.has(key)) {
                            write({ type: 'delete', key });
                        }
                    }
                    commit();
                });
            },
        },
    });
}

/** A collection of the scope's that mirrors the cache's whole collection `name`. */
const mirror = <T extends object>(
    gate: Gate,
    id: string,
    name: string,
    cache: SnapshotCache,
    toItem: (key: string, value: unknown) => T,
    getKey: (item: T) => string,
): Collection<T, string> => mirrorCollection({ id, name, cache, toItem, getKey, closed: () => gate.closed });

/**
 * A record as its collection holds it: the value itself, keyed by its id, which
 * is the row's key (shell.ts keys records by id). A value that names another id,
 * or none, gets the key's, so one odd row can't stop the scope from opening.
 */
const record = <T>(key: string, value: unknown): T =>
    (value as { id?: unknown } | null)?.id === key ? (value as T) : ({ ...(value as object), id: key } as T);
const byId = (item: { id: string }) => item.id;

/**
 * The scope's collections, filled from `cache` (opened, with the shell's rows
 * loaded) and `pending` (user.db's outbox) before this returns. `scopeId` is
 * the scope's, unique to it.
 */
export function createScopeCollections(
    scopeId: string,
    cache: SnapshotCache,
    pending: readonly PendingWrite[],
): ScopeCollections {
    const id = (name: string) => `${scopeId}/${name}`;
    const gate: Gate = { closed: false };
    const local = localOnlyCollectionOptions<PendingWrite, string>({
        id: id(PENDING),
        getKey: (write) => write.id,
        initialData: [...pending],
    });
    const collections: ScopeCollections = {
        shell: mirror<ShellRow>(
            gate,
            id(SHELL),
            SHELL,
            cache,
            (key, value) => ({ id: key, value }) as ShellRow,
            (row) => row.id,
        ),
        conversations: mirror<Conversation>(gate, id(CONVERSATIONS), CONVERSATIONS, cache, record, byId),
        spaces: mirror<Space>(gate, id(SPACES), SPACES, cache, record, byId),
        dots: mirror<Dot>(gate, id(DOTS), DOTS, cache, record, byId),
        notices: mirror<InAppNotice>(gate, id(NOTICES), NOTICES, cache, record, byId),
        // Empty until the issues kind loads, unless the kept screen is the Board (kinds.ts).
        issues: mirror<IssueSummary>(gate, id(ISSUES), ISSUES, cache, issueRow, (issue) => issueKey(issue.number)),
        issueUsers: mirror<IssueUsersRow>(
            gate,
            id(ISSUE_USERS),
            ISSUE_USERS,
            cache,
            (key, value) => ({ id: key, value }) as IssueUsersRow,
            (row) => row.id,
        ),
        issueComponents: mirror<IssueComponentsRow>(
            gate,
            id(ISSUE_COMPONENTS),
            ISSUE_COMPONENTS,
            cache,
            (key, value) => ({ id: key, value }) as IssueComponentsRow,
            (row) => row.id,
        ),
        // Empty until their kind loads: the scope's start, or the first pull (kinds.ts).
        approvals: mirror<ApprovalView>(gate, id(APPROVALS), APPROVALS, cache, approvalRow, (item) => item.id),
        roomInvites: mirror<RoomInvite>(
            gate,
            id(ROOM_INVITES),
            ROOM_INVITES,
            cache,
            roomInviteRow,
            (invite) => invite.roomId,
        ),
        memories: mirror<MemoryItem>(gate, id(MEMORIES), MEMORIES, cache, memoryRow, (item) => item.id),
        memoryProfile: mirror<MemoryProfileRow>(
            gate,
            id(MEMORY_PROFILE),
            MEMORY_PROFILE,
            cache,
            memoryProfileRow,
            (row) => row.id,
        ),
        schedules: mirror<ScheduleView>(gate, id(SCHEDULES), SCHEDULES, cache, scheduleRow, (row) => row.id),
        goals: mirror<GoalView>(gate, id(GOALS), GOALS, cache, goalRow, (row) => row.id),
        jobs: mirror<JobView>(gate, id(JOBS), JOBS, cache, jobRow, (row) => row.id),
        scheduleLimits: mirror<ScheduleLimitsRow>(
            gate,
            id(SCHEDULE_LIMITS),
            SCHEDULE_LIMITS,
            cache,
            scheduleLimitsRow,
            (row) => row.id,
        ),
        runs: mirror<AgentRunSummary>(gate, id(RUNS), RUNS, cache, runRow, (run) => run.runId),
        skills: mirror<ContainerSkills>(gate, id(SKILLS), SKILLS, cache, skillsRow, (row) => row.containerId),
        // Local-only, but its run checks the gate too: a local-only collection loads its initial data
        // again each time it starts.
        pending: createCollection({
            ...local,
            sync: {
                ...local.sync,
                sync: (params) => (gate.closed ? closedRun(params) : local.sync.sync(params)),
            },
        }),
    };
    gates.set(collections, gate);
    return collections;
}

/**
 * Ends every collection of a scope, with the live queries that read them, and
 * stops their sync: their rows leave memory, for good (a collection started
 * again stays empty). Tries every one, then throws the first failure.
 */
export async function cleanupScopeCollections(collections: ScopeCollections): Promise<void> {
    const gate = gates.get(collections);
    if (gate !== undefined) {
        gate.closed = true;
    }
    const results = await Promise.allSettled(
        Object.values(collections).map((collection: Collection<object, string>) =>
            collection.cleanup({ dependents: true }),
        ),
    );
    for (const result of results) {
        if (result.status === 'rejected') {
            throw result.reason;
        }
    }
}
