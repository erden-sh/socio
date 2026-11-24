import { type Collection, createCollection, type SyncConfig } from '@tanstack/db';

import type { HistoryPage, HistoryRun } from '@socio/shared/chat/chat-history';
import { historyScope, waitsOnTool } from '@socio/shared/chat/history-chain';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { HttpError, httpError, SnapshotShapeError } from './errors';
import {
    deleteHistory,
    dropOtherFormats,
    HISTORY_BOUNDS,
    type HistoryBounds,
    readHistory,
    touchHistory,
    writeHistory,
} from './history-disk';

// Chat histories, ported
// from the web's CB-136 store (packages/client/src/modules/chat/sync/
// chat-history.ts): per conversation, a TanStack DB collection of its
// finished runs keyed by seq, filled from cache.db (history-disk.ts), then
// from `GET /api/conversations/:id/history?after|before` (the cursor source):
// - rows enter only when they chain (`prev`); an `after` page that doesn't
//   follow on, or says `more`, re-pulls the newest page, which replaces them;
// - `before` pages the older runs in as the reader scrolls up;
// - a 404 or 410 drops the scope, in memory and on disk, and tells `onGone`,
//   whose queued writes the Unsent list takes;
// - long tool results come as previews (`light`); `fullResult` fetches one
//   whole, at most once, keeping the 20 latest per chat;
// - a scope keyed by a local id (a chat not created yet) never reads
//   the network, so it can't 404 and drop itself.
//
// Memory keeps at most 8 chats, dropping the least recently used first, but
// never one a screen shows (`use`). The disk bounds are history-disk.ts's;
// they skip the chats a screen shows and those `pinned` names (queued
// writes). A chat is never written while one of its runs streams (`streaming`):
// what pulls bring then waits for RUN_FINISHED or RUN_ERROR.
//
// `preload` reads a chat from disk without the network, for a row press, a
// link or a cold start onto a chat. The chat it hands out
// stays in memory until its first `use()` (or `HANDOFF_MS`), so nothing evicts
// it between the read and the screen. `history()` hands one out for a `use()`
// in the same turn. A chat that left memory takes nothing more: no pull, no
// apply and no write lands after it, so a later copy of the chat is never
// overwritten by an older one.
//
// Older pages (`loadEarlier`) wait for a pull in flight, and a page that comes
// after the runs were replaced or the chat dropped is ignored: memory never
// has a gap, and a gone chat is never written back.

/** Chats whose history stays in memory, for going back and forth (the web's OPEN_HISTORIES). */
export const OPEN_HISTORIES = 8;
/** Whole tool results kept in memory per chat once fetched. */
export const FULL_RESULTS = 20;
/** How long a chat `preload` handed out stays in memory waiting for its first `use()`. */
export const HANDOFF_MS = 10_000;

export interface HistoryState {
    /** It has something to show: from disk, or the server's answer. */
    readonly ready: boolean;
    /** Its first pull is over: it holds what the server had then. */
    readonly settled: boolean;
    /** Neither disk nor the server could give it (offline, or the server failed). */
    readonly failed: boolean;
    /** The server said it's gone (404 or 410): dropped. */
    readonly gone: boolean;
    /** Older runs are on the server. */
    readonly earlier: boolean;
    readonly loadingEarlier: boolean;
}

const INITIAL: HistoryState = {
    ready: false,
    settled: false,
    failed: false,
    gone: false,
    earlier: false,
    loadingEarlier: false,
};

type SyncParams = Parameters<SyncConfig<HistoryRun, number>['sync']>[0];

export interface ChatHistory {
    readonly threadId: string;
    /** Its runs, oldest first, keyed by seq. */
    readonly collection: Collection<HistoryRun, number>;
    readonly state: HistoryState;
    /** Calls `listener` after each change of `state` or the runs held. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** The runs held, oldest first. */
    list(): HistoryRun[];
    /** Resolves once what disk keeps is in memory (no network). */
    readonly loaded: Promise<void>;
    /** A screen shows it: never evicted, pulled now. Returns the release. */
    use(): () => void;
    /**
     * Asks for what came after the newest run held (or the newest page).
     * Calls while one runs make one more after it. Resolves true once what's
     * held reaches what the server had (no `more`), false if it couldn't ask
     * (offline, a failure, gone, or the chat left memory). A local id is current.
     */
    pull(): Promise<boolean>;
    /** Asks for the page before the oldest run held. */
    loadEarlier(): Promise<void>;
    /** The whole result a preview (`light`) stands for, fetched once. */
    fullResult(toolCallId: string): Promise<string>;
    /**
     * Where the chat's connection starts (the runner's `connect`, `x-cb-history-after`):
     * after the newest run, or the one before it when that waits on a tool. Undefined until ready.
     */
    connectAfter(): number | undefined;
    /** Whether a run held has the message. */
    has(messageId: string): boolean;
    /** Whether the run with this id is held (stored on the server). */
    hasRun(runId: string): boolean;
    /** A run of the chat started streaming: writes wait until the returned end (RUN_FINISHED or RUN_ERROR). */
    streaming(): () => void;
}

export interface HistoryStoreOptions {
    /** The workspace scope's id: collection ids carry it (`<scope id>/history/<thread>`). */
    readonly scopeId: string;
    /** The workspace's cache.db. */
    readonly db: SqlConnection;
    /** The workspace's authedFetch. */
    readonly fetch: AuthedFetch;
    /** The scope's signal: a body read after it aborts rejects. */
    readonly signal?: AbortSignal;
    /** Whether a thread id is a local one, not created on the server yet: no network reads. */
    readonly isLocal?: (threadId: string) => boolean;
    /** The thread ids queued writes pin: never evicted from disk. */
    readonly pinned?: () => Iterable<string>;
    /** A chat the server says is gone or no longer the person's (404, 410): its writes go to Unsent. */
    readonly onGone?: (threadId: string) => void;
    /**
     * Runs entered a chat (from disk or the server), with a lookup of the
     * message ids it now holds: the outbox's sent rows wait for it (`caughtUp`).
     */
    readonly onRuns?: (threadId: string, has: (messageId: string) => boolean) => void;
    /** A disk failure: memory goes on, the next open asks the server again. */
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
    /** The disk bounds (history-disk.ts's by default), smaller in tests. */
    readonly bounds?: HistoryBounds;
    /** How long a preloaded chat waits for its `use()`, HANDOFF_MS by default. */
    readonly handoffMs?: number;
}

export interface HistoryStore {
    /**
     * The history of `threadId`, most recently used now. Hold it with `use()`
     * in the same turn: a chat nothing uses may leave memory at the next call.
     */
    history(threadId: string): ChatHistory;
    /**
     * Reads `threadId`'s history from disk into memory, with no network: a row
     * press, a link, a cold start. The chat stays in memory until its first
     * `use()`, or HANDOFF_MS.
     */
    preload(threadId: string): Promise<ChatHistory>;
    /** The chats held in memory, least recently used first. */
    held(): string[];
    /** Resolves once every write asked so far has been tried. */
    flush(): Promise<void>;
    /** Writes what waits (streaming or not), ends every collection, and takes no more. */
    close(): Promise<void>;
}

/** A pull that found the chat gone (404 or 410). */
const goneStatus = (error: unknown) => error instanceof HttpError && (error.status === 404 || error.status === 410);

function checkPage(path: string, body: unknown): HistoryPage {
    const page = body as Partial<HistoryPage> | null;
    if (!page || typeof page !== 'object' || !Array.isArray(page.runs)) {
        throw new SnapshotShapeError(path, 'no runs.');
    }
    for (const run of page.runs as unknown[]) {
        const r = run as Partial<HistoryRun> | null;
        if (
            !r ||
            typeof r.seq !== 'number' ||
            !Array.isArray(r.messages) ||
            (r.prev !== null && typeof r.prev !== 'number')
        ) {
            throw new SnapshotShapeError(path, 'a run without its seq, prev or messages.');
        }
    }
    return { runs: page.runs, more: page.more === true };
}

export function createHistoryStore(options: HistoryStoreOptions): HistoryStore {
    const {
        scopeId,
        db,
        fetch,
        signal,
        isLocal = () => false,
        pinned = () => [],
        onGone,
        onRuns,
        onError = () => {},
    } = options;
    const now = options.now ?? Date.now;
    const bounds = options.bounds ?? HISTORY_BOUNDS;
    const handoffMs = options.handoffMs ?? HANDOFF_MS;
    const open = new Map<string, Chat>();
    let closed = false;
    /** Every disk step, one after another, the format check first. */
    let disk: Promise<void> = Promise.resolve();
    const onDisk = <T>(step: () => Promise<T>): Promise<T> => {
        const next = disk.then(step);
        disk = next.then(
            () => {},
            () => {},
        );
        return next;
    };
    onDisk(() => dropOtherFormats(db)).catch(onError);

    /** Scopes that must stay on disk: those shown, and those queued writes pin. */
    const protectedScopes = () => {
        const scopes = new Set<string>();
        for (const chat of open.values()) {
            if (chat.kept) {
                scopes.add(historyScope(chat.threadId));
            }
        }
        for (const threadId of pinned()) {
            scopes.add(historyScope(threadId));
        }
        return scopes;
    };

    async function request(path: string): Promise<unknown> {
        const response = await fetch(path);
        if (!response.ok) {
            throw await httpError(response, signal);
        }
        return readJson(response, signal);
    }

    class Chat implements ChatHistory {
        readonly collection: Collection<HistoryRun, number>;
        readonly loaded: Promise<void>;
        users = 0;
        /** Holds from `preload` waiting for the first `use()`: each its timer. */
        private handoffs = new Set<ReturnType<typeof setTimeout>>();
        private held = new Map<number, HistoryRun>();
        private current: HistoryState = INITIAL;
        private listeners = new Set<() => void>();
        private sink: SyncParams | undefined;
        private pulling: Promise<boolean> | undefined;
        private again = false;
        private results = new Map<string, Promise<string>>();
        private disposed = false;
        /** Bumped each time the held runs are replaced or dropped: an answer asked before is stale. */
        private generation = 0;
        private streams = 0;
        /** What waits to be written: replace all, then these runs. */
        private unwritten: { replace: boolean; runs: Map<number, HistoryRun> } | null = null;

        constructor(readonly threadId: string) {
            this.collection = createCollection<HistoryRun, number>({
                id: `${scopeId}/history/${threadId}`,
                getKey: (run) => run.seq,
                compare: (a, b) => a.seq - b.seq,
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
                        for (const run of this.held.values()) {
                            write({ type: 'insert', value: run });
                        }
                        commit();
                        if (this.current.ready || this.current.failed || this.current.gone) {
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
            this.loaded = this.load();
        }

        /** A screen shows it, or `preload` handed it out: it stays in memory and on disk. */
        get kept() {
            return this.users > 0 || this.handoffs.size > 0;
        }

        /** Keeps it in memory until the first `use()` or `ms`. */
        handOff(ms: number) {
            if (this.disposed) {
                return;
            }
            const timer = setTimeout(() => {
                this.handoffs.delete(timer);
                trim();
            }, ms);
            this.handoffs.add(timer);
        }

        private endHandoffs() {
            for (const timer of this.handoffs) {
                clearTimeout(timer);
            }
            this.handoffs.clear();
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

        private set(patch: Partial<HistoryState>) {
            this.current = { ...this.current, ...patch };
            this.tell();
        }

        private tell() {
            for (const listener of [...this.listeners]) {
                listener();
            }
        }

        private markReady() {
            this.sink?.markReady();
        }

        list() {
            return [...this.held.values()].sort((a, b) => a.seq - b.seq);
        }

        private async load() {
            try {
                const kept = await onDisk(() => readHistory(db, this.scope));
                if (!this.disposed && kept.length && !this.held.size) {
                    this.apply(kept, true);
                    this.set({ ready: true, earlier: kept[0]!.prev !== null });
                }
            } catch (error) {
                // An unreadable copy is an empty one: the server has it all.
                onError(error);
            }
            if (!this.disposed && isLocal(this.threadId) && !this.current.ready) {
                // Nothing to ask for: it is empty until its create resolves.
                this.set({ ready: true, settled: true });
            }
            this.markReady();
        }

        use() {
            if (this.disposed) {
                // It left memory (the store closed): nothing to hold.
                return () => {};
            }
            this.users += 1;
            this.endHandoffs();
            onDisk(() => touchHistory(db, this.scope, now())).catch(onError);
            void this.pull();
            let released = false;
            return () => {
                if (!released) {
                    released = true;
                    this.users -= 1;
                    trim();
                }
            };
        }

        connectAfter(): number | undefined {
            if (!this.current.ready) {
                return undefined;
            }
            const newest = this.list().at(-1);
            if (!newest) {
                return 0;
            }
            return waitsOnTool(newest) ? (newest.prev ?? 0) : newest.seq;
        }

        has(messageId: string) {
            for (const run of this.held.values()) {
                if (run.messages.some((message) => message.id === messageId)) {
                    return true;
                }
            }
            return false;
        }

        hasRun(runId: string) {
            for (const run of this.held.values()) {
                if (run.runId === runId) {
                    return true;
                }
            }
            return false;
        }

        streaming() {
            this.streams += 1;
            let ended = false;
            return () => {
                if (ended) {
                    return;
                }
                ended = true;
                this.streams -= 1;
                if (this.streams === 0) {
                    void this.write();
                }
            };
        }

        pull(): Promise<boolean> {
            if (this.disposed) {
                return Promise.resolve(false);
            }
            if (isLocal(this.threadId)) {
                return Promise.resolve(true);
            }
            if (this.pulling) {
                this.again = true;
                return this.pulling;
            }
            const pulling = (async () => {
                let current = false;
                try {
                    await this.loaded;
                    do {
                        this.again = false;
                        current = await this.pullOnce();
                    } while (this.again && !this.disposed);
                    return current && !this.disposed;
                } finally {
                    this.pulling = undefined;
                    if (!this.disposed) {
                        this.set({ settled: true });
                        this.markReady();
                    }
                }
            })();
            this.pulling = pulling;
            return pulling;
        }

        private path(query: string) {
            return `/api/conversations/${encodeURIComponent(this.threadId)}/history${query ? `?${query}` : ''}`;
        }

        private async page(query: string): Promise<HistoryPage> {
            const path = this.path(query);
            return checkPage(path, await request(path));
        }

        /** One pull: true once what's held reaches what the server had. */
        private async pullOnce(): Promise<boolean> {
            const newest = this.list().at(-1);
            const generation = this.generation;
            // An older page (or its 404) that changed what's held meanwhile makes this answer stale.
            const stale = () => this.disposed || this.generation !== generation;
            try {
                if (newest) {
                    const page = await this.page(`after=${newest.seq}`);
                    if (stale()) {
                        return false;
                    }
                    if (!page.more && (!page.runs.length || page.runs[0]!.prev === newest.seq)) {
                        if (page.runs.length) {
                            this.apply(page.runs);
                            this.persist(page.runs, false);
                        }
                        this.set({ failed: false });
                        return true;
                    }
                }
                // Nothing held, or what's held doesn't lead to what came since.
                const page = await this.page('');
                if (stale()) {
                    return false;
                }
                this.apply(page.runs, true);
                this.set({ ready: true, failed: false, earlier: (page.runs[0]?.prev ?? null) !== null });
                this.persist(page.runs, true);
                return true;
            } catch (error) {
                if (stale()) {
                    return false;
                }
                if (goneStatus(error)) {
                    this.drop();
                    return false;
                }
                if (!this.current.ready || this.held.size === 0) {
                    this.set({ failed: true });
                }
                return false;
            }
        }

        /** Gone, or never this person's: forget it, here and on disk. */
        private drop() {
            this.unwritten = null;
            this.apply([], true);
            this.set({ ready: false, failed: false, gone: true, earlier: false });
            onDisk(() => deleteHistory(db, this.scope)).catch(onError);
            onGone?.(this.threadId);
        }

        async loadEarlier() {
            if (this.disposed || this.current.loadingEarlier || isLocal(this.threadId)) {
                return;
            }
            this.set({ loadingEarlier: true });
            try {
                // A pull in flight may replace what's held: the page goes before what it leaves.
                while (this.pulling && !this.disposed) {
                    await this.pulling;
                }
                const oldest = this.list()[0];
                if (this.disposed || !oldest || oldest.prev === null) {
                    return;
                }
                const generation = this.generation;
                // Replaced (a gap, `more`) or dropped (404) meanwhile, or the oldest moved: not this page's place.
                const stale = () =>
                    this.disposed || this.generation !== generation || this.list()[0]?.seq !== oldest.seq;
                try {
                    const page = await this.page(`before=${oldest.seq}`);
                    if (stale()) {
                        return;
                    }
                    // It must end where the held runs begin; otherwise it is ignored.
                    if (page.runs.at(-1)?.seq === oldest.prev) {
                        this.apply(page.runs);
                        this.set({ earlier: page.runs[0]!.prev !== null });
                        this.persist(page.runs, false);
                    } else if (!page.runs.length) {
                        this.set({ earlier: false });
                    }
                } catch (error) {
                    if (!stale() && goneStatus(error)) {
                        this.drop();
                    }
                    // Otherwise scrolling up again asks again.
                }
            } finally {
                if (!this.disposed) {
                    this.set({ loadingEarlier: false });
                }
            }
        }

        fullResult(toolCallId: string): Promise<string> {
            if (isLocal(this.threadId)) {
                return Promise.reject(new Error('A chat not created yet has no stored results.'));
            }
            let found = this.results.get(toolCallId);
            if (!found) {
                const path = `/api/conversations/${encodeURIComponent(this.threadId)}/tool-results/${encodeURIComponent(toolCallId)}`;
                found = request(path).then((body) => {
                    const content = (body as { content?: unknown } | null)?.content;
                    if (typeof content !== 'string') {
                        throw new SnapshotShapeError(path, 'no content.');
                    }
                    return content;
                });
                found.catch(() => this.results.delete(toolCallId));
                this.results.set(toolCallId, found);
                if (this.results.size > FULL_RESULTS) {
                    this.results.delete(this.results.keys().next().value!);
                }
            }
            return found;
        }

        private apply(runs: readonly HistoryRun[], replace = false) {
            if (replace) {
                this.generation += 1;
                this.held.clear();
            }
            const sink = this.sink;
            if (sink) {
                sink.begin(replace ? { snapshot: true } : undefined);
            }
            for (const run of runs) {
                sink?.write({ type: !replace && this.held.has(run.seq) ? 'update' : 'insert', value: run });
                this.held.set(run.seq, run);
            }
            sink?.commit();
            if (runs.length > 0 && onRuns !== undefined) {
                try {
                    onRuns(this.threadId, (messageId) => this.has(messageId));
                } catch (error) {
                    onError(error);
                }
            }
            this.tell();
        }

        private persist(runs: readonly HistoryRun[], replace: boolean) {
            if (this.disposed) {
                return;
            }
            if (replace || this.unwritten === null) {
                this.unwritten = { replace, runs: new Map() };
            }
            for (const run of runs) {
                this.unwritten.runs.set(run.seq, run);
            }
            if (this.streams === 0) {
                void this.write();
            }
        }

        /** Writes what waits, now. Nothing once it left memory: `retire` wrote the last. */
        write(): Promise<void> {
            const pending = this.unwritten;
            if (pending === null || this.disposed) {
                return Promise.resolve();
            }
            this.unwritten = null;
            return onDisk(async () => {
                const evicted = await writeHistory(
                    db,
                    { scope: this.scope, replace: pending.replace, runs: [...pending.runs.values()] },
                    now(),
                    protectedScopes(),
                    bounds,
                );
                forgetEvicted(evicted);
            }).catch(onError);
        }

        /**
         * Leaves memory: writes what waits (`write` true), then takes nothing
         * more at once, so no pull, apply or write lands after, and ends its
         * collection.
         */
        retire(write: boolean): Promise<void> {
            const written = write ? this.write() : Promise.resolve();
            this.disposed = true;
            this.unwritten = null;
            this.endHandoffs();
            this.listeners.clear();
            return written.then(() => this.collection.cleanup({ dependents: true }));
        }
    }

    /** Past OPEN_HISTORIES, the least recently used chats nothing keeps leave memory. */
    function trim(except?: Chat) {
        for (const [threadId, held] of open) {
            if (open.size <= OPEN_HISTORIES) {
                break;
            }
            if (held.kept || held === except) {
                continue;
            }
            open.delete(threadId);
            void held.retire(true);
        }
    }

    /** Chats evicted from disk leave memory too, unless a screen shows one, so a later write is whole. */
    function forgetEvicted(scopes: readonly string[]) {
        const gone = new Set(scopes);
        for (const [threadId, chat] of open) {
            if (!chat.kept && gone.has(historyScope(threadId))) {
                open.delete(threadId);
                void chat.retire(false);
            }
        }
    }

    function history(threadId: string): ChatHistory {
        if (closed) {
            throw new Error('The history store is closed.');
        }
        let chat = open.get(threadId);
        if (chat) {
            // The most recently used goes last.
            open.delete(threadId);
            open.set(threadId, chat);
            return chat;
        }
        chat = new Chat(threadId);
        open.set(threadId, chat);
        // The chat handed out never leaves in its own call.
        trim(chat);
        return chat;
    }

    return {
        history,
        async preload(threadId) {
            const chat = history(threadId) as Chat;
            // Kept from now: nothing evicts it while disk reads, nor before its screen's `use()`.
            chat.handOff(handoffMs);
            await chat.loaded;
            return chat;
        },
        held: () => [...open.keys()],
        flush: () => disk,
        async close() {
            if (closed) {
                return disk;
            }
            closed = true;
            const chats = [...open.values()];
            open.clear();
            const retired = chats.map((chat) => chat.retire(true));
            await disk;
            await Promise.allSettled(retired);
        },
    };
}
