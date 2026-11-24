import type { Collection, InitialQueryBuilder } from '@tanstack/db';

import type { PageSummary } from '@socio/shared/pages/page-library';

import type { ScopeCollections, ShellRow } from '../sync/collections';
import { STATE_KEY, type ShellState, type ShellWorkspace, WORKSPACE_KEY } from '../sync/shell';
import type { HeldItem } from '../sync/space-items';

// The live queries the shell's screens run on the scope's collections
// (`useLiveQuery({ query })`, src/live), each a whole collection: the view
// models here (chat-list.ts, home.ts, spaces.ts, account.ts) order and shape
// the rows. tests/shell runs the same queries on seeded collections.

export const chatsQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ chat: collections.conversations });

export const sociosQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ dot: collections.dots });

export const spacesQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ space: collections.spaces });

/** One Space's page summaries, its collection from `pages.space(id)`, for its library. */
export const pagesQuery = (pages: Collection<PageSummary, string>) => (q: InitialQueryBuilder) =>
    q.from({ page: pages });

/** A list of Space items (a Space's, or the Private group: CB-469). */
export const itemsQuery = (items: Collection<HeldItem, string>) => (q: InitialQueryBuilder) => q.from({ item: items });

/** This device's queued writes (user.db's outbox), for Technical details. */
export const pendingQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ write: collections.pending });

/** The board's issue summaries, in no order (the Board sorts them), and the assignees' names as one row. */
export const issuesQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ issue: collections.issues });
export const issueUsersQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ users: collections.issueUsers });
/** The list's component labels as one row (CB-442): the cards' chips, the Board's facet. */
export const issueComponentsQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ components: collections.issueComponents });

/** Memories' rows (memories and proposals by id, which Memories sorts) and the profile as one row. */
export const memoriesQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ memory: collections.memories });
export const memoryProfileQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ profile: collections.memoryProfile });

/** Schedules' rows (the screen orders them): schedules, goals with their comments, jobs, and the limits as one row. */
export const schedulesQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ schedule: collections.schedules });
export const goalsQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ goal: collections.goals });
export const jobsQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ job: collections.jobs });
export const scheduleLimitsQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ limits: collections.scheduleLimits });

/** Runs' rows (the screen sorts them) and each learning container's published skills. */
export const runsQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ run: collections.runs });
export const skillsQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ skills: collections.skills });

export const shellQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ shell: collections.shell });

/** The shell's two rows, each null until the first answer fills it. */
export function shellRows(rows: readonly ShellRow[]): {
    state: ShellState | null;
    workspace: ShellWorkspace | null;
} {
    let state: ShellState | null = null;
    let workspace: ShellWorkspace | null = null;
    for (const row of rows) {
        if (row.id === STATE_KEY) {
            state = row.value;
        } else if (row.id === WORKSPACE_KEY) {
            workspace = row.value;
        }
    }
    return { state, workspace };
}

export const noticesQuery = (collections: ScopeCollections) => (q: InitialQueryBuilder) =>
    q.from({ notice: collections.notices });
