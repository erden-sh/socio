import type { Message } from '@ag-ui/client';

import type { ReplayStats, StoredRunRow } from './contract.js';

/** What the main thread asks the replay worker (CB-318). */
export type ReplayRequest =
    | { kind: 'messages'; id: number; key: string; threadId: string; rows: StoredRunRow[] }
    | { kind: 'forget'; key: string }
    | { kind: 'forgetPrefix'; prefix: string };

/** The replay worker's answer to a `messages` request. */
export type ReplayResponse =
    | { id: number; ok: true; messages: Message[]; stats: ReplayStats }
    | { id: number; ok: false; error: string };
