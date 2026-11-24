import type { State, WorkspaceState } from '@socio/shared/types';

import { SnapshotShapeError } from './errors';
import type { SnapshotItem } from './merge';
import type { SnapshotDefinition } from './snapshot-cache';
import { list, object, singleton } from './snapshot-shape';

// The shell's two snapshots, as the
// server gives them: `GET /api/state` (src/server/composition/http/live.ts,
// live/views/state.ts) and `GET /api/workspace`
// (src/server/workspace/workspace-routes.ts, workspace/views.ts), each through
// conditionalJsonAsync (packages/foundation/src/http/conditional.ts), the shapes
// packages/shared/src/types.ts's State and WorkspaceState.
// - /api/state fills the shell's `state` row (State without its notices) and
//   `notices`: the person's unseen in-app notices of the last 24 h, at most 5,
//   which the device keeps after the server stops listing them, for the
//   Inbox, until the server keeps a notification history. At most NOTICES_KEPT stay, the
//   newest.
// - /api/workspace fills the shell's `workspace` row (WorkspaceState without
//   its lists), `conversations` (the chat list and the archived chats, which
//   carry `archivedAt`), `spaces` and `dots` (the socios, for their names and
//   characters), all under its one ETag and in one transaction.
// None of these records carries a version (no updatedAt, revision or seq), so
// only the pulls' order and the device's confirmations order them (merge.ts).
// The `state` row's `version` is the server's release, which keys every
// scope's rows and the minimum-version gate read (versions.ts).

export const SHELL = 'shell';
export const NOTICES = 'notices';
export const CONVERSATIONS = 'conversations';
export const SPACES = 'spaces';
export const DOTS = 'dots';
/** The shell's two rows. */
export const STATE_KEY = 'state';
export const WORKSPACE_KEY = 'workspace';

/** The notices kept on the device, the newest by createdAt. */
export const NOTICES_KEPT = 200;

/** The shell's `state` row. */
export type ShellState = Omit<State, 'notices'>;
/** The shell's `workspace` row. */
export type ShellWorkspace = Omit<WorkspaceState, 'spaces' | 'dots' | 'conversations' | 'archived'>;

/** Records keyed by their `id`, which every one must have. */
function records(path: string, values: readonly unknown[], what: string): SnapshotItem[] {
    return values.map((value) => {
        const id = object(path, value, `an item of ${what}`).id;
        if (typeof id !== 'string' || id === '') {
            throw new SnapshotShapeError(path, `an item of ${what} has no id.`);
        }
        return { key: id, json: JSON.stringify(value), version: null, value };
    });
}

const STATE_PATH = '/api/state';
const WORKSPACE_PATH = '/api/workspace';

/** State.version, the server's release (versions.ts), or null when the row names none. */
const stateVersion = (state: unknown): string | null => {
    const version = (state as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : null;
};

/** `GET /api/state`: the shell's `state` row and the notices, and the server's version. */
export const STATE_SNAPSHOT: SnapshotDefinition = {
    id: 'state',
    path: STATE_PATH,
    format: 1,
    version: { feed: 0, key: STATE_KEY, read: stateVersion },
    feeds: [
        { collection: SHELL, key: STATE_KEY },
        {
            collection: NOTICES,
            retain: {
                keep: NOTICES_KEPT,
                order: (notice) => {
                    const createdAt = (notice as { createdAt?: unknown }).createdAt;
                    return typeof createdAt === 'number' ? createdAt : 0;
                },
            },
        },
    ],
    split(body) {
        const { notices, ...state } = object(STATE_PATH, body, 'the body');
        object(STATE_PATH, state.settings, 'settings');
        list(STATE_PATH, state.tasks, 'tasks');
        list(STATE_PATH, state.memories, 'memories');
        return [
            [singleton(STATE_KEY, state)],
            records(STATE_PATH, notices === undefined ? [] : list(STATE_PATH, notices, 'notices'), 'notices'),
        ];
    },
};

/** `GET /api/workspace`: the shell's `workspace` row, conversations, spaces and socios, under one ETag. */
export const WORKSPACE_SNAPSHOT: SnapshotDefinition = {
    id: 'workspace',
    path: WORKSPACE_PATH,
    format: 1,
    feeds: [
        { collection: SHELL, key: WORKSPACE_KEY },
        { collection: CONVERSATIONS },
        { collection: SPACES },
        { collection: DOTS },
    ],
    split(body) {
        const { spaces, dots, conversations, archived, ...workspace } = object(WORKSPACE_PATH, body, 'the body');
        object(WORKSPACE_PATH, workspace.user, 'user');
        const chats = [
            ...list(WORKSPACE_PATH, conversations, 'conversations'),
            ...(archived === undefined ? [] : list(WORKSPACE_PATH, archived, 'archived')),
        ];
        return [
            [singleton(WORKSPACE_KEY, workspace)],
            records(WORKSPACE_PATH, chats, 'conversations'),
            records(WORKSPACE_PATH, list(WORKSPACE_PATH, spaces, 'spaces'), 'spaces'),
            records(WORKSPACE_PATH, list(WORKSPACE_PATH, dots, 'dots'), 'dots'),
        ];
    },
};

/** The shell's snapshots, in the order a pull asks them. */
export const SHELL_SNAPSHOTS: readonly SnapshotDefinition[] = [STATE_SNAPSHOT, WORKSPACE_SNAPSHOT];
