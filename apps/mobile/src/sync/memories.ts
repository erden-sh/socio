import type { MemoryItem, UserProfile } from '@socio/shared/memory';

import { SnapshotShapeError } from './errors';
import type { SnapshotDefinition } from './snapshot-cache';
import { keyed, list, object, singleton } from './snapshot-shape';

// The memories kind: the
// person's Memories page as the server gives it, `GET /api/memories`
// (src/server/memory/routes.ts, through conditionalJson, so a poll with no
// change is a 304), the shape packages/shared's MemoriesState.
// - `memories` holds the active memories and the proposals waiting, by id: one
//   table on the server, told apart by `status`, so approving a proposal
//   changes its row and never moves it. Each is versioned by its `updatedAt`;
// - `memory-profile` holds the profile and the moved time zone (CB-176) as
//   one row, `profile`, under the same ETag. The body has no limits: the
//   page's (MEMORY_TEXT_MAX, PROPOSALS_WAITING_MAX) are packages/shared's.
// Memories polls it every 15 s while in view, as the web's MemoriesPage does.

export const MEMORIES = 'memories';
export const MEMORY_PROFILE = 'memory-profile';
/** The `memory-profile` collection's one row. */
export const PROFILE_KEY = 'profile';

/** How often Memories, in view, asks again (the web's MemoriesPage). */
export const MEMORIES_POLL_MS = 15_000;

/** The `memory-profile` row: the profile (null before one is written) and the moved time zone, if any. */
export interface MemoryProfileRow {
    readonly id: typeof PROFILE_KEY;
    readonly profile: UserProfile | null;
    readonly timeZoneMoved: string | null;
}

const MEMORIES_PATH = '/api/memories';
const BY_ID = { key: 'id', version: 'updatedAt' };

/** `GET /api/memories`: the memories and proposals by id, and the profile as one row. */
export const MEMORIES_SNAPSHOT: SnapshotDefinition = {
    id: 'memories',
    path: MEMORIES_PATH,
    format: 1,
    feeds: [{ collection: MEMORIES }, { collection: MEMORY_PROFILE }],
    split(body) {
        const fields = object(MEMORIES_PATH, body, 'the body');
        const { profile, timeZoneMoved } = fields;
        if (profile !== null) {
            object(MEMORIES_PATH, profile, 'the profile');
        }
        if (timeZoneMoved !== undefined && typeof timeZoneMoved !== 'string') {
            throw new SnapshotShapeError(MEMORIES_PATH, 'timeZoneMoved is not text.');
        }
        const row: Omit<MemoryProfileRow, 'id'> = {
            profile: profile as UserProfile | null,
            timeZoneMoved: timeZoneMoved ?? null,
        };
        return [
            [
                ...keyed(MEMORIES_PATH, list(MEMORIES_PATH, fields.memories, 'memories'), 'memories', BY_ID),
                ...keyed(MEMORIES_PATH, list(MEMORIES_PATH, fields.proposals, 'proposals'), 'proposals', BY_ID),
            ],
            [singleton(PROFILE_KEY, row)],
        ];
    },
};

/** A memory's row as its collection holds it: the item the server sent. */
export const memoryRow = (_key: string, value: unknown): MemoryItem => value as MemoryItem;
/** The `memory-profile` row from its stored value. */
export const memoryProfileRow = (key: string, value: unknown): MemoryProfileRow =>
    ({ id: key, ...(value as object) }) as MemoryProfileRow;
