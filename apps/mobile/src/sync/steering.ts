import { type Collection, createCollection, type SyncConfig } from '@tanstack/db';

import type { OthersQueuedMessage, QueuedMessage, SteeringView } from '@socio/shared/chat/steering';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { HttpError, httpError, SnapshotShapeError } from './errors';

// Steering snapshots:
// per conversation, a TanStack DB collection of the person's queued messages
// (CB-151), keyed by their server id, filled from
// `GET /api/conversations/:id/steering`:
// - when a chat opens (`use`), on the follow stream's frames (follow.ts
//   calls `refresh`), and after each steering write, from the view its answer
//   carries (`writing()` as it is sent, then its answer);
// - a GET that started before a write's answer came is dropped and asked
//   again, so an older answer never undoes a write's; and a write's answer
//   that comes after a GET sent later was taken is not taken (it may be the
//   older): the snapshot is asked again instead, so a late answer never
//   brings back a delivered message or a finished turn;
// - the view's `limit` is `maxQueued`, which the outbox's lane keeps to;
// - a 404 or 410 empties it (the history store tells the Unsent list);
// - a local id (a chat not created yet) never reads the network.
// It lives in memory only: the outbox holds what this device hasn't handed
// over, and the server what it has.
//
// `queuedBubbles` is the overlay rule across the hand-off: an outbox row's
// bubble hides once the snapshot lists its server id, and a queued message's
// once the history holds it (delivered), so a message shows once throughout.

/** Chats whose steering snapshot stays in memory, as for histories. */
export const OPEN_STEERING = 8;

export interface SteeringState {
    /** A snapshot came: from the server, or a write's answer. */
    readonly ready: boolean;
    /** The last GET failed (offline, or the server did); what's held stays. */
    readonly failed: boolean;
    /** The server said the chat is gone (404 or 410): emptied. */
    readonly gone: boolean;
    /** The most messages that may wait (the view's `limit`); null until a snapshot says. */
    readonly maxQueued: number | null;
    /** A turn runs in the chat now, whoever started it. */
    readonly running: boolean;
    /** The run id of the turn the server started with queued messages, while it runs. */
    readonly turn: string | null;
    /** In a room, for its admins: everyone else's waiting messages. */
    readonly others: readonly OthersQueuedMessage[];
}

const INITIAL: SteeringState = {
    ready: false,
    failed: false,
    gone: false,
    maxQueued: null,
    running: false,
    turn: null,
    others: [],
};

type SyncParams = Parameters<SyncConfig<QueuedMessage, string>['sync']>[0];

export interface ChatSteering {
    readonly threadId: string;
    /** The person's queued messages, oldest first, keyed by server id. */
    readonly collection: Collection<QueuedMessage, string>;
    readonly state: SteeringState;
    /** Calls `listener` after each change of `state` or the messages. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** The queued messages, oldest first (the order they are delivered in). */
    list(): QueuedMessage[];
    /** Whether the snapshot lists the message with this server id. */
    lists(serverId: string): boolean;
    /** A screen shows it: never evicted, refreshed now. Returns the release. */
    use(): () => void;
    /** Asks the server for the snapshot. Calls while one runs make one more after it. */
    refresh(): Promise<void>;
    /**
     * Call as a steering write (POST, PATCH, DELETE) is sent; hand its answer's
     * view to the returned function. The view is taken, newer than any GET in
     * flight, unless a GET sent after the write was taken first: then the
     * snapshot is asked again. It throws on a body that isn't a view.
     */
    writing(): (view: unknown) => void;
}

export interface SteeringStoreOptions {
    /** The workspace scope's id: collection ids carry it (`<scope id>/steering/<thread>`). */
    readonly scopeId: string;
    /** The workspace's authedFetch. */
    readonly fetch: AuthedFetch;
    /** The scope's signal: a body read after it aborts rejects. */
    readonly signal?: AbortSignal;
    /** Whether a thread id is a local one, not created on the server yet: no network reads. */
    readonly isLocal?: (threadId: string) => boolean;
}

export interface SteeringStore {
    /** The steering snapshot of `threadId`, most recently used now. */
    steering(threadId: string): ChatSteering;
    /** The chats held in memory, least recently used first. */
    held(): string[];
    /** Ends every collection and takes no more. */
    close(): Promise<void>;
}

const goneStatus = (error: unknown) => error instanceof HttpError && (error.status === 404 || error.status === 410);

/** A steering view, checked whole: `GET …/steering`, or the view a write's answer spreads in. */
export function checkSteeringView(path: string, body: unknown): SteeringView {
    const view = body as Partial<SteeringView> | null;
    if (!view || typeof view !== 'object' || !Array.isArray(view.messages) || typeof view.limit !== 'number') {
        throw new SnapshotShapeError(path, 'no messages or limit.');
    }
    for (const message of view.messages as unknown[]) {
        const m = message as Partial<QueuedMessage> | null;
        if (!m || typeof m.id !== 'string' || typeof m.text !== 'string') {
            throw new SnapshotShapeError(path, 'a queued message without its id or text.');
        }
    }
    if (view.others !== undefined && !Array.isArray(view.others)) {
        throw new SnapshotShapeError(path, 'others that are not a list.');
    }
    return view as SteeringView;
}

/** An outbox row as the overlay rule needs it: the server id it got, once handed over. */
export interface OutboxBubble {
    readonly serverId?: string | null;
}

/**
 * The queued bubbles a chat shows across the hand-off: the outbox's rows not
 * yet in the snapshot or the history, then the snapshot's messages not yet in
 * the history. `delivered` says whether the history holds a message id.
 */
export function queuedBubbles<T extends OutboxBubble>(
    outbox: readonly T[],
    queued: readonly QueuedMessage[],
    delivered: (messageId: string) => boolean,
): { outbox: T[]; queued: QueuedMessage[] } {
    const listed = new Set(queued.map((message) => message.id));
    return {
        outbox: outbox.filter((row) => !row.serverId || (!listed.has(row.serverId) && !delivered(row.serverId))),
        queued: queued.filter((message) => !delivered(message.id)),
    };
}

const same = (a: QueuedMessage, b: QueuedMessage) =>
    a.text === b.text &&
    a.updatedAt === b.updatedAt &&
    a.createdAt === b.createdAt &&
    JSON.stringify(a.attachments ?? []) === JSON.stringify(b.attachments ?? []);

export function createSteeringStore(options: SteeringStoreOptions): SteeringStore {
    const { scopeId, fetch, signal, isLocal = () => false } = options;
    const open = new Map<string, Chat>();
    let closed = false;

    class Chat implements ChatSteering {
        readonly collection: Collection<QueuedMessage, string>;
        users = 0;
        private held = new Map<string, QueuedMessage>();
        private current: SteeringState = INITIAL;
        private listeners = new Set<() => void>();
        private sink: SyncParams | undefined;
        private refreshing: Promise<void> | undefined;
        private again = false;
        /** Bumped by each snapshot taken: a GET that saw it move is stale. */
        private applied = 0;
        /** GETs sent so far, and which of them gave the snapshot held (0: none did). */
        private sent = 0;
        private takenGet = 0;
        private disposed = false;

        constructor(readonly threadId: string) {
            this.collection = createCollection<QueuedMessage, string>({
                id: `${scopeId}/steering/${threadId}`,
                getKey: (message) => message.id,
                // Oldest first, as the server lists them: the order they are delivered in.
                compare: (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
                gcTime: 0,
                startSync: true,
                sync: {
                    rowUpdateMode: 'full',
                    sync: (params) => {
                        const { begin, write, commit, markReady } = params;
                        if (this.disposed) {
                            // Ended for good: ready, with no rows (collections.ts's rule).
                            begin({ snapshot: true });
                            commit();
                            markReady();
                            return;
                        }
                        this.sink = params;
                        begin({ snapshot: true });
                        for (const message of this.held.values()) {
                            write({ type: 'insert', value: message });
                        }
                        commit();
                        if (this.current.ready || this.current.failed || this.current.gone || isLocal(threadId)) {
                            markReady();
                        }
                        return () => {
                            if (this.sink === params) {
                                this.sink = undefined;
                            }
                        };
                    },
                },
            });
            if (isLocal(threadId)) {
                // Nothing can wait on the server for a chat it doesn't have yet.
                this.current = { ...INITIAL, ready: true };
            }
        }

        get state() {
            return this.current;
        }

        subscribe = (listener: () => void) => {
            this.listeners.add(listener);
            return () => void this.listeners.delete(listener);
        };

        private set(patch: Partial<SteeringState>) {
            this.current = { ...this.current, ...patch };
            this.tell();
        }

        private tell() {
            for (const listener of [...this.listeners]) {
                listener();
            }
        }

        list() {
            return [...this.held.values()];
        }

        lists(serverId: string) {
            return this.held.has(serverId);
        }

        use() {
            this.users += 1;
            void this.refresh();
            let released = false;
            return () => {
                if (!released) {
                    released = true;
                    this.users -= 1;
                }
            };
        }

        refresh(): Promise<void> {
            if (this.disposed || isLocal(this.threadId)) {
                return Promise.resolve();
            }
            if (this.refreshing) {
                this.again = true;
                return this.refreshing;
            }
            const refreshing = (async () => {
                try {
                    do {
                        this.again = false;
                        await this.refreshOnce();
                    } while (this.again && !this.disposed);
                } finally {
                    this.refreshing = undefined;
                }
            })();
            this.refreshing = refreshing;
            return refreshing;
        }

        private async refreshOnce() {
            const path = `/api/conversations/${encodeURIComponent(this.threadId)}/steering`;
            const seen = this.applied;
            const get = ++this.sent;
            try {
                const response = await fetch(path);
                if (!response.ok) {
                    throw await httpError(response, signal);
                }
                const view = checkSteeringView(path, await readJson(response, signal));
                if (this.disposed) {
                    return;
                }
                if (this.applied !== seen) {
                    // A write's answer came meanwhile: this one may be older.
                    this.again = true;
                    return;
                }
                this.take(view);
                this.takenGet = get;
            } catch (error) {
                if (this.disposed) {
                    return;
                }
                if (goneStatus(error)) {
                    this.replace([]);
                    this.set({ ...INITIAL, gone: true });
                    return;
                }
                this.set({ failed: true });
                this.sink?.markReady();
            }
        }

        writing() {
            const sentBefore = this.sent;
            return (view: unknown) => {
                const checked = checkSteeringView(
                    `/api/conversations/${encodeURIComponent(this.threadId)}/steering`,
                    view,
                );
                if (this.disposed) {
                    return;
                }
                if (this.takenGet > sentBefore) {
                    // A GET sent after this write is held: it may be newer than this answer.
                    this.applied += 1;
                    void this.refresh();
                    return;
                }
                this.take(checked);
            };
        }

        private take(view: SteeringView) {
            this.applied += 1;
            this.replace(view.messages);
            this.set({
                ready: true,
                failed: false,
                gone: false,
                maxQueued: view.limit,
                running: view.running === true,
                turn: view.turn ?? null,
                others: view.others ?? [],
            });
            this.sink?.markReady();
        }

        /** Makes the held messages `messages`, in the server's order (the delivery order), writing only what changed. */
        private replace(messages: readonly QueuedMessage[]) {
            const next = new Map<string, QueuedMessage>();
            const sink = this.sink;
            sink?.begin();
            for (const message of messages) {
                const before = this.held.get(message.id);
                if (!before) {
                    sink?.write({ type: 'insert', value: message });
                    next.set(message.id, message);
                } else if (!same(before, message)) {
                    sink?.write({ type: 'update', value: message });
                    next.set(message.id, message);
                } else {
                    // Unchanged: it keeps its identity.
                    next.set(message.id, before);
                }
            }
            for (const [id, message] of this.held) {
                if (!next.has(id)) {
                    sink?.write({ type: 'delete', value: message });
                }
            }
            sink?.commit();
            this.held = next;
        }

        dispose() {
            this.disposed = true;
            this.listeners.clear();
            return this.collection.cleanup({ dependents: true });
        }
    }

    function steering(threadId: string): ChatSteering {
        if (closed) {
            throw new Error('The steering store is closed.');
        }
        let chat = open.get(threadId);
        if (chat) {
            open.delete(threadId);
            open.set(threadId, chat);
            return chat;
        }
        chat = new Chat(threadId);
        open.set(threadId, chat);
        for (const [other, held] of open) {
            if (open.size <= OPEN_STEERING) {
                break;
            }
            if (held.users > 0 || held === chat) {
                continue;
            }
            open.delete(other);
            void held.dispose();
        }
        return chat;
    }

    return {
        steering,
        held: () => [...open.keys()],
        async close() {
            if (closed) {
                return;
            }
            closed = true;
            const chats = [...open.values()];
            open.clear();
            await Promise.allSettled(chats.map((chat) => chat.dispose()));
        },
    };
}
