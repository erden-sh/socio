import { isReactionKind, type ReactionsView } from '@socio/shared/chat/reactions';
import type { ReportOutcome } from '@socio/shared/chat/reply-reports';

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
//
// AI reply reports (CB-382): a write that carried a report hands what became
// of it with its view (`take`'s `report`), kept as the chat's `report` for
// the screen's quiet line; and the replies whose thumbs-down went plain
// while the app was offline (`offer`), for "Report it now?" once it's back.
// Both live in memory only, with the chat. A report the server holds
// `queued` goes to Ingenio later (the leader sends every minute), and nothing
// tells the phone: while a screen watches the chat (`watchQueued`), the view
// is asked again every `REPORT_POLL_MS` for as long as any of its reports is
// still queued, so "Shared with Ingenio" and the removal's warning follow.

export const OPEN_REACTIONS = 8;
/** How often a watched chat with a queued report asks its view again. */
export const REPORT_POLL_MS = 15_000;

/** Whether any reply's report in the view is still queued on the server. */
export const hasQueuedReport = (view: ReactionsView): boolean =>
    Object.values(view.messages).some((entry) => entry.report === 'queued');

/** What became of a report a reaction write carried (§3): its reply and the server's outcome. */
export interface ReactionReport {
    readonly messageId: string;
    readonly outcome: ReportOutcome;
}

export interface ReactionsState {
    /** A view came: from the server, or a write's answer. */
    readonly ready: boolean;
    /** The last GET failed; what's held stays. */
    readonly failed: boolean;
    readonly view: ReactionsView;
    /** The last report's outcome, numbered so the same one twice is two (`seq`). */
    readonly report?: ReactionReport & { readonly seq: number };
    /** The replies to offer "Report it now?" under: their thumbs-down went plain, offline. */
    readonly offers: readonly string[];
}

const EMPTY: ReactionsView = { shared: false, messages: {} };
const INITIAL: ReactionsState = { ready: false, failed: false, view: EMPTY, offers: [] };

export interface ChatReactions {
    readonly threadId: string;
    readonly state: ReactionsState;
    /** Calls `listener` after each change of `state`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** A screen shows it: never evicted, asked now. Returns the release. */
    use(): () => void;
    /** Asks the server. A call while one runs makes one more after it. */
    refresh(): Promise<void>;
    /** Offers "Report it now?" under `messageId` (`true`), or no longer (`false`). */
    offer(messageId: string, on: boolean): void;
    /**
     * A screen shows it in the foreground, online: while any report is queued, the view is asked
     * again every `REPORT_POLL_MS`, stopping once none is. Returns the release.
     */
    watchQueued(): () => void;
}

export interface ReactionsStore {
    /** The reactions of `threadId`, most recently used now. */
    reactions(threadId: string): ChatReactions;
    /** A reaction write's answer: the chat's whole view (ignored when it isn't one), and a report's outcome. */
    take(threadId: string, view: unknown, report?: ReactionReport): void;
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
        private watchers = 0;
        private poll: ReturnType<typeof setTimeout> | undefined;

        constructor(readonly threadId: string) {}

        subscribe(listener: () => void) {
            this.listeners.add(listener);
            return () => {
                this.listeners.delete(listener);
            };
        }

        set(next: ReactionsState) {
            this.state = next;
            this.schedule();
            for (const listener of [...this.listeners]) {
                listener();
            }
        }

        /** Asks again later while watched and a report is queued; otherwise stops. */
        schedule() {
            if (closed || this.watchers === 0 || !hasQueuedReport(this.state.view)) {
                this.stopPoll();
                return;
            }
            if (this.poll !== undefined) {
                return;
            }
            this.poll = setTimeout(() => {
                this.poll = undefined;
                void this.refresh().then(() => this.schedule());
            }, REPORT_POLL_MS);
        }

        stopPoll() {
            if (this.poll !== undefined) {
                clearTimeout(this.poll);
                this.poll = undefined;
            }
        }

        watchQueued() {
            this.watchers += 1;
            this.schedule();
            let released = false;
            return () => {
                if (!released) {
                    released = true;
                    this.watchers -= 1;
                    this.schedule();
                }
            };
        }

        take(view: ReactionsView, report?: ReactionReport) {
            this.taken += 1;
            this.set({
                ...this.state,
                ready: true,
                failed: false,
                view,
                ...(report === undefined ? {} : { report: { ...report, seq: (this.state.report?.seq ?? 0) + 1 } }),
            });
        }

        offer(messageId: string, on: boolean) {
            const has = this.state.offers.includes(messageId);
            if (has === on) {
                return;
            }
            this.set({
                ...this.state,
                offers: on ? [...this.state.offers, messageId] : this.state.offers.filter((id) => id !== messageId),
            });
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
        take(threadId, body, report) {
            if (closed) {
                return;
            }
            try {
                reactions(threadId).take(checkReactionsView(reactionsPath(threadId), body), report);
            } catch {
                // Not a view: ask for it.
                void reactions(threadId).refresh();
            }
        },
        close() {
            closed = true;
            for (const chat of open.values()) {
                chat.stopPoll();
            }
            open.clear();
        },
    };
}
