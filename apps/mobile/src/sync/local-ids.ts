import type { Outbox } from './outbox';

// A new chat's local id: the
// server picks a chat's id, so a chat made offline is known by a local one
// until its create resolves, and the `ids` map then gives its server id
// (`conversation`). A local id carries its own mark (`local-`), so any code
// can tell it from a server id without the map: a scope keyed by one never
// reads the network (history.ts, steering.ts, follow.ts take `isLocalChat`).
//
// Payloads keep the local id; each send resolves it. A chat's messages keep
// the lane they were written in (`chat:<local id>`) after the create resolves,
// and a message written later, under the server id, joins that lane while it
// still holds a row (`chatWriteRoute`), so the chat's messages stay in order.
//
// No React Native: tests/sync runs it under Node.

/** The `ids` map's kind for a new chat's server id. */
export const CONVERSATION_IDS = 'conversation';

const LOCAL_PREFIX = 'local-';

/** A new local chat id from a fresh UUID (expo-crypto). */
export const newLocalChatId = (newId: () => string) => `${LOCAL_PREFIX}${newId()}`;

/** Whether `id` is a chat's local id, never a server's. */
export const isLocalChat = (id: string) => id.startsWith(LOCAL_PREFIX) && id.length > LOCAL_PREFIX.length;

/** Chat `id` as the server knows it: a local id's server id, null while its create hasn't resolved; any other id as it is. */
export function serverChatId(resolve: (kind: string, localId: string) => string | null, id: string): string | null {
    return isLocalChat(id) ? resolve(CONVERSATION_IDS, id) : id;
}

/** Chat `id` for a screen or a link: a resolved local id's server id, else `id`. */
export const shownChatId = (resolve: (kind: string, localId: string) => string | null, id: string) =>
    serverChatId(resolve, id) ?? id;

const CHAT_LANE = 'chat:';

/** The lanes of chat `threadId`'s writes: its own, and those of local ids that resolved to it and still hold a write. */
export function chatLanes(outbox: Pick<Outbox, 'rows' | 'unsent' | 'resolve'>, threadId: string): string[] {
    const lanes = new Set([`${CHAT_LANE}${threadId}`]);
    for (const { lane } of [...outbox.rows(), ...outbox.unsent()]) {
        const id = lane.startsWith(CHAT_LANE) ? lane.slice(CHAT_LANE.length) : '';
        if (isLocalChat(id) && outbox.resolve(CONVERSATION_IDS, id) === threadId) {
            lanes.add(lane);
        }
    }
    return [...lanes];
}

/**
 * Where a new message to chat `threadId` goes: the lane its earlier messages
 * still wait in (a local id's, before or after its create resolved), else its
 * own; and, for a chat not created yet, the create it waits for.
 */
export function chatWriteRoute(
    outbox: Pick<Outbox, 'rows' | 'unsent' | 'resolve'>,
    threadId: string,
): { lane: string; dependsOn: string | null } {
    if (isLocalChat(threadId)) {
        return {
            lane: `${CHAT_LANE}${threadId}`,
            dependsOn: outbox.resolve(CONVERSATION_IDS, threadId) === null ? threadId : null,
        };
    }
    const lanes = chatLanes(outbox, threadId);
    // A local lane still holding writes comes first: the chat's order is its.
    return { lane: lanes.at(-1) as string, dependsOn: null };
}

/**
 * An issue filed on the phone is known by a local key (`pending-issue-<uuid>`)
 * until its create resolves: never `local-`, which `isLocalChat` would
 * take for a chat. Its detail never reads the network (issue-details.ts).
 */
const LOCAL_ISSUE_PREFIX = 'pending-issue-';

/** Whether `key` is an issue's local key, never a server number. */
export const isLocalIssue = (key: string) =>
    key.startsWith(LOCAL_ISSUE_PREFIX) && key.length > LOCAL_ISSUE_PREFIX.length;

/** The `ids` map's kind for a filed issue's number, as a string: the cache's and the details' key. */
export const ISSUE_IDS = 'issue';

/** A new local issue key from a fresh UUID (expo-crypto). */
export const newLocalIssueId = (newId: () => string) => `${LOCAL_ISSUE_PREFIX}${newId()}`;

/** Issue `key` as the server knows it: a local key's number, null while its create hasn't resolved; a number as it is. */
export function serverIssueKey(resolve: (kind: string, localId: string) => string | null, key: string): string | null {
    return isLocalIssue(key) ? resolve(ISSUE_IDS, key) : key;
}

/** Issue `key` for a screen or a link: a resolved local key's number, else `key`. */
export const shownIssueKey = (resolve: (kind: string, localId: string) => string | null, key: string) =>
    serverIssueKey(resolve, key) ?? key;
