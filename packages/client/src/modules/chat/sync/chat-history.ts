import { createCollection, type Collection } from '@tanstack/db';

import type { HistoryPage, HistoryRun } from '@socio/shared/chat/chat-history';
import { chained, historyScope, waitsOnTool } from '@socio/shared/chat/history-chain';

import { api, ApiError } from '../../../lib/api';
import { forgetOnSignOut } from '../../../shell/auth-channel';

import { clearSyncStore, openSyncStore, type StoredRow, type SyncBounds, type SyncStore } from './idb';

/**
 * A chat's history on the client store (CB-136): a TanStack DB
 * collection of the conversation's finished runs, synced incrementally
 * from the server by sequence number and kept in IndexedDB per person
 * and conversation.
 *
 * - Opening a chat shows what the store has at once, then asks only for
 *   the runs after the newest (`pull`). A cold open asks for the newest
 *   page; scrolling up asks for the page before the oldest
 *   (`loadEarlier`).
 * - Each run names the one before it (`prev`), so the store only ever
 *   holds the server's history without gaps: a pull that doesn't follow
 *   on (other tabs, a long time away) starts again from the newest page.
 * - Another tab's write, or this tab coming back into view, pokes it
 *   through the change channel (the chat's `conversation:<id>` topic).
 *
 * CopilotKit still runs the live turn: the chat shows these runs, then
 * what its agent streamed since it opened (`mergeHistory`).
 */

/** What the store keeps: chats used most recently, up to about this size. */
export const HISTORY_STORE_BOUNDS: SyncBounds = {
    scopes: 30,
    size: 15_000_000,
};
// In shared now (history-chain); re-exported here until nothing imports them from this path.
export { chained, HISTORY_FORMAT, historyScope, mergeHistory, waitsOnTool } from '@socio/shared/chat/history-chain';

/** Chats whose history stays in memory, for going back and forth. */
export const OPEN_HISTORIES = 8;
/** Whole tool results kept in memory per chat once fetched. */
const FULL_RESULTS = 20;

export interface HistoryState {
    /** It has something to show: from the store, or the server's answer. */
    ready: boolean;
    /** Its first pull is over: it holds what the server had then. */
    settled: boolean;
    /**
     * Neither the store nor the server could give it (offline, or the
     * server doesn't serve it): the chat replays its conversation instead.
     */
    failed: boolean;
    /** Older runs are on the server. */
    earlier: boolean;
    loadingEarlier: boolean;
}

const INITIAL: HistoryState = {
    ready: false,
    settled: false,
    failed: false,
    earlier: false,
    loadingEarlier: false,
};

type Sink = {
    begin: () => void;
    write: (message: { type: 'insert' | 'update'; value: HistoryRun }) => void;
    commit: () => unknown;
    truncate: () => void;
    markReady: () => void;
};

/** One person's history of one conversation (`chatHistory`). */
export class ChatHistory {
    readonly collection: Collection<HistoryRun, number>;
    private held = new Map<number, HistoryRun>();
    private view: readonly HistoryRun[] = [];
    private subscription: { unsubscribe: () => void };
    private current: HistoryState = INITIAL;
    private listeners = new Set<() => void>();
    private sink?: Sink;
    private store?: Promise<SyncStore | undefined>;
    private pulling?: Promise<void>;
    private again = false;
    private results = new Map<string, Promise<string>>();
    private disposed = false;
    /** Mounted chats using it: never evicted while one is. */
    users = 0;

    constructor(
        readonly userId: string,
        readonly threadId: string,
        store: () => Promise<SyncStore | undefined>,
    ) {
        this.collection = createCollection<HistoryRun, number>({
            id: `chat-history:${userId}:${threadId}`,
            getKey: (run) => run.seq,
            compare: (a, b) => a.seq - b.seq,
            // Its life is the open histories' (`chatHistory`), not subscribers'.
            gcTime: 0,
            startSync: true,
            sync: {
                rowUpdateMode: 'full',
                sync: (params) => {
                    const sink = params as unknown as Sink;
                    this.sink = sink;
                    if (this.store) {
                        // Started again (after a pause): what it held, at once.
                        sink.begin();
                        for (const run of this.held.values()) {
                            sink.write({ type: 'insert', value: run });
                        }
                        sink.commit();
                        if (this.current.ready || this.current.failed) {
                            sink.markReady();
                        }
                    } else {
                        this.store = store();
                        void this.start();
                    }
                    return () => {
                        if (this.sink === sink) {
                            this.sink = undefined;
                        }
                    };
                },
            },
        });
        // The chat reads the collection's rows, in order, as they change.
        this.subscription = this.collection.subscribeChanges(() => {
            this.view = this.collection.toArray;
            this.emit();
        });
    }

    private get scope() {
        return historyScope(this.threadId);
    }

    get state() {
        return this.current;
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    };

    /** The collection's runs, oldest first: a new array when they change. */
    get runs(): readonly HistoryRun[] {
        return this.view;
    }

    private emit() {
        for (const listener of this.listeners) {
            listener();
        }
    }

    private set(patch: Partial<HistoryState>) {
        this.current = { ...this.current, ...patch };
        this.emit();
    }

    /** The runs it holds, oldest first. */
    list() {
        return [...this.held.values()].sort((a, b) => a.seq - b.seq);
    }

    /**
     * Where the chat's connection starts (the runner's `connect`): after the
     * newest run, so CopilotKit replays only a run in progress. When the
     * newest ended waiting on the person (a page review: a call without a
     * result), after the one before it, so CopilotKit replays it too and the
     * review opens again. Undefined until the history is ready.
     */
    connectAfter(): number | undefined {
        if (!this.current.ready || this.current.failed) {
            return undefined;
        }
        const newest = this.list().at(-1);
        if (!newest) {
            return 0;
        }
        return waitsOnTool(newest) ? (newest.prev ?? 0) : newest.seq;
    }

    /** Whether a run it holds has the message. */
    has(messageId: string) {
        for (const run of this.held.values()) {
            if (run.messages.some((message) => message.id === messageId)) {
                return true;
            }
        }
        return false;
    }

    /** The ids of the messages of the runs after `seq`. */
    idsAfter(seq: number) {
        return this.list()
            .filter((run) => run.seq > seq)
            .flatMap((run) => run.messages.map((message) => ({ id: message.id })));
    }

    private async start() {
        const store = await this.store;
        if (this.disposed) {
            return;
        }
        try {
            const kept = chained(((await store?.read<HistoryRun>(this.scope)) ?? []).map((row) => row.value));
            if (kept.length && !this.held.size) {
                this.apply(kept, true);
                this.set({ ready: true, earlier: kept[0].prev !== null });
                this.sink?.markReady();
            }
        } catch {
            // An unreadable store is an empty one: the server has it all.
        }
        await this.pull();
        if (!this.disposed) {
            this.set({ settled: true });
        }
        this.sink?.markReady();
    }

    /**
     * Asks the server for what came after the newest run held (or for the
     * newest page, if none or if that doesn't follow on). Calls while one
     * runs make one more after it.
     */
    pull(): Promise<void> {
        if (this.pulling) {
            this.again = true;
            return this.pulling;
        }
        const pulling = (async () => {
            try {
                do {
                    this.again = false;
                    await this.pullOnce();
                } while (this.again && !this.disposed);
            } finally {
                this.pulling = undefined;
            }
        })();
        this.pulling = pulling;
        return pulling;
    }

    private async pullOnce() {
        const newest = this.list().at(-1);
        try {
            if (newest) {
                const page = await this.page(`after=${newest.seq}`);
                if (this.disposed) {
                    return;
                }
                if (!page.more && (!page.runs.length || page.runs[0].prev === newest.seq)) {
                    if (page.runs.length) {
                        this.apply(page.runs);
                        await this.persist(page.runs, []);
                    }
                    return;
                }
            }
            // Nothing held, or what's held doesn't lead to what came since.
            const page = await this.page('');
            if (this.disposed) {
                return;
            }
            this.apply(page.runs, true);
            this.set({
                ready: true,
                failed: false,
                earlier: (page.runs[0]?.prev ?? null) !== null,
            });
            await this.persist(page.runs, 'all');
        } catch (error) {
            if (this.disposed) {
                return;
            }
            if (error instanceof ApiError && error.status === 404) {
                // Gone, or never this person's: forget it.
                this.apply([], true);
                void (await this.store)?.drop(this.scope).catch(() => {});
            }
            if (!this.current.ready || this.held.size === 0) {
                this.set({ failed: true, ready: false });
            }
        }
    }

    /** Asks for the page before the oldest run held; shows it on top. */
    async loadEarlier() {
        const oldest = this.list()[0];
        if (!oldest || oldest.prev === null || this.current.loadingEarlier) {
            return;
        }
        this.set({ loadingEarlier: true });
        try {
            const page = await this.page(`before=${oldest.seq}`);
            if (this.disposed) {
                return;
            }
            // It must end where the held runs begin; otherwise it is ignored.
            if (page.runs.at(-1)?.seq === oldest.prev) {
                this.apply(page.runs);
                this.set({ earlier: page.runs[0].prev !== null });
                await this.persist(page.runs, []);
            } else if (!page.runs.length) {
                this.set({ earlier: false });
            }
        } catch {
            // Scrolling up again asks again.
        } finally {
            if (!this.disposed) {
                this.set({ loadingEarlier: false });
            }
        }
    }

    /** The whole result a preview stands for, fetched once. */
    fullResult(toolCallId: string): Promise<string> {
        let found = this.results.get(toolCallId);
        if (!found) {
            found = api<{ content: string }>(
                `/conversations/${encodeURIComponent(this.threadId)}/tool-results/${encodeURIComponent(toolCallId)}`,
            ).then((result) => result.content);
            found.catch(() => this.results.delete(toolCallId));
            this.results.set(toolCallId, found);
            if (this.results.size > FULL_RESULTS) {
                this.results.delete(this.results.keys().next().value!);
            }
        }
        return found;
    }

    private page(query: string) {
        return api<HistoryPage>(
            `/conversations/${encodeURIComponent(this.threadId)}/history${query ? `?${query}` : ''}`,
        );
    }

    private apply(runs: readonly HistoryRun[], replace = false) {
        const sink = this.sink;
        if (replace) {
            this.held.clear();
        }
        if (!sink) {
            for (const run of runs) {
                this.held.set(run.seq, run);
            }
            return;
        }
        sink.begin();
        if (replace) {
            sink.truncate();
        }
        for (const run of runs) {
            sink.write({
                type: this.held.has(run.seq) ? 'update' : 'insert',
                value: run,
            });
            this.held.set(run.seq, run);
        }
        sink.commit();
    }

    private async persist(runs: readonly HistoryRun[], drop: [] | 'all') {
        if (this.disposed) {
            return;
        }
        try {
            await (
                await this.store
            )?.write<HistoryRun>(
                this.scope,
                runs.map((run): StoredRow<HistoryRun> => ({
                    scope: this.scope,
                    key: run.seq,
                    value: run,
                    size: run.size,
                })),
                drop,
                HISTORY_STORE_BOUNDS,
            );
        } catch {
            // Not kept this time: the next open asks the server again.
        }
    }

    dispose() {
        this.disposed = true;
        this.listeners.clear();
        this.subscription.unsubscribe();
        void this.collection.cleanup();
    }
}

const open = new Map<string, ChatHistory>();
let stores: { owner: string; store: Promise<SyncStore | undefined> } | undefined;

/**
 * The history of `threadId` for `userId`, shared by the chats that show
 * it. Asking for another person's drops every history held for the last.
 */
export function chatHistory(userId: string, threadId: string): ChatHistory {
    if (stores && stores.owner !== userId) {
        forgetHistories();
    }
    stores ??= { owner: userId, store: openSyncStore(userId) };
    const store = stores.store;
    const key = `${userId}\n${threadId}`;
    let history = open.get(key);
    if (history) {
        // The most recently used goes last.
        open.delete(key);
        open.set(key, history);
        return history;
    }
    history = new ChatHistory(userId, threadId, () => store);
    open.set(key, history);
    for (const [other, held] of open) {
        if (open.size <= OPEN_HISTORIES) {
            break;
        }
        if (held.users || held === history) {
            continue;
        }
        held.dispose();
        open.delete(other);
    }
    return history;
}

/** Drops every history held in memory (sign-out, another person). */
export function forgetHistories() {
    for (const history of open.values()) {
        history.dispose();
    }
    open.clear();
    stores = undefined;
}

// Signed out: nothing of the last person's chats stays, here or on disk.
forgetOnSignOut(() => {
    forgetHistories();
    void clearSyncStore();
});
