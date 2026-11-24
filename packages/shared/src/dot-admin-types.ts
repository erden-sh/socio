import type { Dot } from './types.js';

/** One Dot in the admins' list: the company's and everyone's own. */
export interface DotAdminRow {
    dot: Dot;
    /** The person whose own Dot it is; null for a company Dot. */
    ownerName: string | null;
    conversations: number;
    /** People with chats with it: a room's active members each (CB-213). */
    people: number;
    /** Its newest audited activity (a turn, a filing, a setting, …). */
    lastActivityAt: number | null;
}

/** Where an activity line comes from. */
export type DotActivityKind =
    | 'settings'
    | 'turn'
    | 'filing'
    | 'issue'
    | 'comment'
    | 'vote'
    | 'approval'
    | 'computer'
    | 'web'
    | 'data'
    | 'job'
    | 'goal';

/**
 * One line of a Dot's audit, from every log that names it. `actor` is who
 * did it (a user id, `dot:<id>`, `system`); `onBehalfOf` the person the Dot
 * acted for, when there was one. Metadata only: never message text,
 * instructions, page contents or data.
 */
export interface DotActivity {
    at: number;
    kind: DotActivityKind;
    actor: string | null;
    onBehalfOf: string | null;
    summary: string;
}

export interface DotAdminDetail {
    row: DotAdminRow;
    spaces: Array<{ id: string; name: string }>;
    /**
     * Owners and dates only: no titles, which a model writes from the first
     * exchange. Each chat is its owner's to read; a room's owner is its
     * sentinel (`room:<id>`), named "A room" in `users` (CB-213).
     */
    conversations: Array<{ id: string; ownerId: string; createdAt: number }>;
    goals: { active: number; total: number };
    filings: number;
    /** Newest first, a page at a time. */
    activity: DotActivity[];
    /** The next page's cursor (`?before=&skip=`); null at the end. */
    next: { before: number; skip: number } | null;
    /** Display names for the user and Dot ids above. */
    users: Record<string, string>;
}
