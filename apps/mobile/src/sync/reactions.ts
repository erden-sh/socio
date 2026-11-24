import { isReactionKind, type ReactionsView } from '@socio/shared/chat/reactions';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { httpError, SnapshotShapeError } from './errors';

// A chat's reactions (CB-133): per conversation, in memory, the view
// of `GET /api/conversations/:id/reactions` (the messages that have any, and
// whether others see the chat). Asked when a chat opens (`use`) and as its
// stored runs change (the screen calls `refresh`), and taken from each
// reaction write's answer (chat-manage.ts's `onReactions`). An answer's view
// is newer than any GET in flight, so a GET sent before it was taken is
// dropped and asked again: a poll never undoes a write's view. What this
// device hasn't sent is laid over by the screen (`reactionsShown`, from the
// outbox's reaction rows). A failed GET keeps what is held; a local id (a
// chat not created yet) never reads the network. At most `OPEN_REACTIONS`
// chats stay in memory, never one a screen uses.

export const OPEN_REACTIONS = 8;

export interface ReactionsState {
    /** A view came: from the server, or a write's answer. */
    readonly ready: boolean;
    /** The last GET failed; what's held stays. */
    readonly failed: boolean;
    readonly view: ReactionsView;
}

const EMPTY: ReactionsView = { shared: false, messages: {} };
const INITIAL: ReactionsState = { ready: false, failed: false, view: EMPTY };

export interface ChatReactions {
    readonly threadId: string;
    readonly state: ReactionsState;
    /** Calls `listener` after each change of `state`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** A screen shows it: never evicted, asked now. Returns the release. */
    use(): () => void;
    /** Asks the server. A call while one runs makes one more after it. */
    refresh(): Promise<void>;
}

export interface ReactionsStore {
    /** The reactions of `threadId`, most recently used now. */
    reactions(threadId: string): ChatReactions;
    /** A reaction write's answer: the chat's whole view (ignored when it isn't one). */
    take(threadId: string, view: unknown): void;
    /** Takes no more and forgets everything. */
    close(): void;
}

export interface ReactionsStoreOptions {
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly isLocal?: (threadId: string) => boolean;
}

/** A reactions view, checked whole; throws SnapshotShapeError when it isn't one. */
export function checkReactionsView(path: string, body: unknown): ReactionsView {
    const view = body as Partial<ReactionsView> | null;
    if (!view || typeof view !== 'object' || !view.messages || typeof view.messages !== 'object') {
        throw new SnapshotShapeError(path, 'no messages.');
    }
    for (const entry of Object.values(view.messages as Record<string, unknown>)) {
        const e = entry as { counts?: unknown; mine?: unknown } | null;
        if (
            !e ||
            typeof e !== 'object' ||
            !e.counts ||
            typeof e.counts !== 'object' ||
            !Array.isArray(e.mine) ||
            !e.mine.every(isReactionKind)
        ) {
            throw new SnapshotShapeError(path, 'a message without its counts or mine.');
        }
    }
    return { shared: view.shared === true, messages: view.messages as ReactionsView['messages'] };
}

export const reactionsPath = (threadId: string) => `/api/conversations/${encodeURIComponent(threadId)}/reactions`;

export function createReactionsStore(options: ReactionsStoreOptions): ReactionsStore {
    const { fetch, signal, isLocal = () => false } = options;
    const open = new Map<string, Chat>();
    let closed = false;

    class Chat implements ChatReactions {
        state: ReactionsState = INITIAL;
        users = 0;
        private listeners = new Set<() => void>();
        private running: Promise<void> | undefined;
        private again = false;
        /** Bumped by each view taken: a GET that saw it move is stale. */
        private taken = 0;

        constructor(readonly threadId: string) {}

        subscribe(listener: () => void) {
            this.listeners.add(listener);
            return () => {
                this.listeners.delete(listener);
            };
        }

        set(next: ReactionsState) {
            this.state = next;
            for (const listener of [...this.listeners]) {
                listener();
            }
        }

        take(view: ReactionsView) {
            this.taken += 1;
            this.set({ ready: true, failed: false, view });
        }

        use() {
            this.users += 1;
            void this.refresh();
            let released = false;
            return () => {
                if (!released) {
                    released = true;
                    this.users -= 1;
                    evict();
                }
            };
        }

        refresh(): Promise<void> {
            if (closed || isLocal(this.threadId)) {
                return Promise.resolve();
            }
            if (this.running !== undefined) {
                this.again = true;
                return this.running;
            }
            this.running = this.get().finally(() => {
                this.running = undefined;
                if (this.again) {
                    this.again = false;
                    void this.refresh();
                }
            });
            return this.running;
        }

        private async get() {
            const path = reactionsPath(this.threadId);
            const before = this.taken;
            try {
                const response = await fetch(path, { signal });
                if (!response.ok) {
                    throw await httpError(response, signal);
                }
                const view = checkReactionsView(path, await readJson(response, signal));
                if (closed) {
                    return;
                }
                if (this.taken !== before) {
                    // A write's view came meanwhile: this answer may be older.
                    this.again = true;
                    return;
                }
                this.take(view);
            } catch {
                if (!closed) {
                    this.set({ ...this.state, failed: true });
                }
            }
        }
    }

    function evict() {
        for (const [id, chat] of open) {
            if (open.size <= OPEN_REACTIONS) {
                return;
            }
            if (chat.users === 0) {
                open.delete(id);
            }
        }
    }

    function reactions(threadId: string): Chat {
        let chat = open.get(threadId);
        if (chat === undefined) {
            chat = new Chat(threadId);
        } else {
            open.delete(threadId);
        }
        open.set(threadId, chat);
        evict();
        return chat;
    }

    return {
        reactions,
        take(threadId, body) {
            if (closed) {
                return;
            }
            try {
                reactions(threadId).take(checkReactionsView(reactionsPath(threadId), body));
            } catch {
                // Not a view: ask for it.
                void reactions(threadId).refresh();
            }
        },
        close() {
            closed = true;
            open.clear();
        },
    };
}
