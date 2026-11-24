import type { BaseEvent } from '@ag-ui/core';

import { type LiveTurn, NO_LIVE_TURN, stillLive } from '@socio/shared/rooms/live-turn';
import { AG_UI_EVENT } from '@socio/shared/runs/event-types';

import { applyRunEvent, keepLiveSteps } from '../chat/live-steps';
import { createRunLifecycle, type RunLifecycle } from '../chat/run-lifecycle';
import type { AuthedFetch } from '../net/authed-fetch';
import { AbortedError } from '../net/errors';
import { readSse, type SseFrame } from '../net/read-sse';
import { serverAway } from '../net/reconnect';

import { HttpError, httpError } from './errors';
import type { ChatHistory, HistoryStore } from './history';
import { awayDelay, RECONNECT_SLOW_AFTER_MS } from './scheduler';
import type { SteeringStore } from './steering';

// The follow stream: while a screen shows a chat,
// `GET /api/conversations/:id/ stream?after=` tells its turns as they
// happen, AG-UI frames reduced by shared's `applyRoomEvent` into the
// running turn (`turn`), its steps kept beside it (chat/live-steps.ts,
// CB-434):
// - it opens only once the history's pull reaches what the server has (no
//   `more`), after the newest run held, so weeks away never replay a backlog
//   through the stream; each reconnect catches up the same way and sends the
//   last cursor as `Last-Event-ID` too;
// - a `cursor` frame (a finished run delivered) pulls the history, and the
//   live turn goes the moment the history holds its run: never shown twice;
// - one source per run, decided at its RUN_STARTED: a run that starts while
//   this device's own POST lives (`ownRun`; the run client shows that one)
//   is dropped whole, as is a run whose `runId` the history already holds (a
//   replay); a run already streaming when a POST opens is kept whole;
// - steering is asked again as runs start and end, on cursors, on `closed`,
//   and on a user TEXT_MESSAGE_START (a queued message delivered mid-run);
// - `closed` with a reason (removed, left, archived, Rooms off, access) ends
//   it: the history and steering are asked again (a 404 drops the chat). An
//   end with no reason (the server stopping, or a private chat `converted`
//   to a room) and a dropped or silent stream (read-sse's 20 s watchdog)
//   reconnect with `serverAway`'s back-off (the scheduler's `awayDelay`);
//   any other failure (a 401, a 500) stops until `check()`;
// - coming back to the foreground (`check`), the stream isn't trusted: it is
//   opened again after a catch-up, and `live` is false until it answers; a
//   broken own POST (`ownRun`'s end, `broken`) does the same, so the server
//   replays the running turn whole and this stream takes it over;
// - while one of its runs streams, the history writes nothing (`streaming`)
//   until RUN_FINISHED or RUN_ERROR, or the stream drops;
// - it refreshes the steering snapshot (steering.ts) as a run starts or ends, on each
//   cursor and on `closed`: when the queue can change, not on every delta;
// - every event, a dropped run's too, goes by the store's `lifecycle`
//   (chat/run-lifecycle.ts, CB-434), which maps none yet.

export interface FollowState {
    /** The stream is open and answered since it was last opened: what it tells is current. */
    readonly live: boolean;
    /** It waits to try again: the server is away, or the stream dropped ("Reconnecting…"). */
    readonly reconnecting: boolean;
    /** The server ended it, and why (or 'gone', a 404): it doesn't reconnect until used again. */
    readonly ended: string | null;
    /** It stopped on a failure other than the server away (a 401, a 500): `check()` tries again. */
    readonly failed: boolean;
    /** The running turn as the stream tells it, without what the history holds. */
    readonly turn: LiveTurn;
}

const IDLE: FollowState = { live: false, reconnecting: false, ended: null, failed: false, turn: NO_LIVE_TURN };

export interface ChatFollow {
    readonly threadId: string;
    readonly state: FollowState;
    /** Calls `listener` after each change of `state`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** A screen shows the chat: the stream is open while any `use` holds. Returns the release. */
    use(): () => void;
    /**
     * This device's POST of a run starts: stream events are dropped until the
     * returned end. End it with `broken` when the POST broke before the run
     * ended: the stream opens again and takes the turn over.
     */
    ownRun(): (end?: { readonly broken?: boolean }) => void;
    /** Don't trust the open stream (back in the foreground, the network back): catch up and open again. */
    check(): void;
}

export interface FollowStoreOptions {
    /** The workspace's authedFetch. */
    readonly fetch: AuthedFetch;
    /** The scope's chat histories: the stream's catch-up and its cursor pulls. */
    readonly histories: HistoryStore;
    /** The scope's steering snapshots, refreshed on frames. */
    readonly steering?: SteeringStore;
    /** Whether a thread id is a local one, not created on the server yet: no stream. */
    readonly isLocal?: (threadId: string) => boolean;
    /** The person's user id, for `applyRoomEvent`'s authors. */
    readonly me?: () => string | undefined;
    /**
     * A RUN_ERROR the stream told, with its run (a dropped run's too): its `code`
     * outlives the run in a `/history` that drops it (a server before CB-406; run-failures.ts).
     */
    readonly onRunError?: (threadId: string, runId: string, code: unknown) => void;
    /** Silence before a stream counts as dead (read-sse's 20 s), smaller in tests. */
    readonly silenceMs?: number;
    /** The wait before attempt `attempt` (from 0), `awayDelay`'s by default; `slowAttempt` as there. */
    readonly delay?: (attempt: number, slowAttempt: number | null) => number;
    /** The back-off's jitter. */
    readonly random?: () => number;
    readonly now?: () => number;
    /** A failure nothing waits for. */
    readonly onError?: (error: unknown) => void;
}

export interface FollowStore {
    /** The follow stream of `threadId` (one per chat while the store lives). */
    follow(threadId: string): ChatFollow;
    /** Back in the foreground: every open stream is checked (`check`). */
    foreground(): void;
    /** The network came back or changed: a stream waiting to reconnect tries now. */
    wake(): void;
    /** Stops every stream and takes no more. */
    close(): Promise<void>;
    /** What the chats' runs did beyond their streams (CB-434): every event goes by it. */
    readonly lifecycle: RunLifecycle;
}

const goneStatus = (error: unknown) => error instanceof HttpError && (error.status === 404 || error.status === 410);

const isEvent = (value: unknown): value is BaseEvent =>
    !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';

export function createFollowStore(options: FollowStoreOptions): FollowStore {
    const {
        fetch,
        histories,
        steering,
        isLocal = () => false,
        me = () => undefined,
        onRunError,
        silenceMs,
        onError = () => {},
    } = options;
    const now = options.now ?? Date.now;
    const lifecycle = createRunLifecycle();
    const random = options.random ?? Math.random;
    const delay = options.delay ?? ((attempt, slow) => awayDelay(attempt, slow, random));
    const follows = new Map<string, Follow>();
    let closed = false;

    class Follow implements ChatFollow {
        private current: FollowState = IDLE;
        private listeners = new Set<() => void>();
        private users = 0;
        /** Bumped by each start and stop: a loop of an older one ends. */
        private run = 0;
        private history: ChatHistory | undefined;
        private releaseHistory: (() => void) | undefined;
        private unsubscribeHistory: (() => void) | undefined;
        /** The open connection's, aborted to reopen (`check`) or stop. */
        private connection: AbortController | undefined;
        /** Wakes a back-off wait early. */
        private wakeWait: (() => void) | undefined;
        /** The newest cursor the stream gave: `Last-Event-ID` on reconnect. */
        private cursor: number | null = null;
        /** POSTs of this device's that live. */
        private own = 0;
        /** The run the stream is in: its id, and whether its events are dropped. */
        private streamRun: { id: string | undefined; dropped: boolean } | null = null;
        /** The run the live turn shows, and the history's write hold while it runs. */
        private liveRun: string | undefined;
        private endStreaming: (() => void) | undefined;
        /** The reason of a `closed` frame on the open connection. */
        private closedReason: string | null = null;

        constructor(readonly threadId: string) {}

        get state() {
            return this.current;
        }

        subscribe = (listener: () => void) => {
            this.listeners.add(listener);
            return () => void this.listeners.delete(listener);
        };

        private set(patch: Partial<FollowState>) {
            const next = { ...this.current, ...patch };
            if (
                next.live === this.current.live &&
                next.reconnecting === this.current.reconnecting &&
                next.ended === this.current.ended &&
                next.failed === this.current.failed &&
                next.turn === this.current.turn
            ) {
                return;
            }
            this.current = next;
            for (const listener of [...this.listeners]) {
                listener();
            }
        }

        use() {
            if (closed || isLocal(this.threadId)) {
                return () => {};
            }
            this.users += 1;
            if (this.users === 1) {
                this.start();
            }
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                this.users -= 1;
                if (this.users === 0) {
                    this.stop();
                }
            };
        }

        ownRun() {
            this.own += 1;
            let ended = false;
            return (end?: { readonly broken?: boolean }) => {
                if (ended) {
                    return;
                }
                ended = true;
                this.own -= 1;
                if (end?.broken && this.own === 0) {
                    // The turn goes on without this device's POST: the server replays it whole.
                    this.check();
                }
            };
        }

        check() {
            if (this.users === 0 || closed) {
                return;
            }
            if (this.current.failed || this.current.ended !== null) {
                // Stopped: start over.
                this.stop();
                this.start();
                return;
            }
            this.set({ live: false });
            this.connection?.abort();
            this.wakeWait?.();
        }

        wake() {
            this.wakeWait?.();
        }

        private start() {
            const history = histories.history(this.threadId);
            this.history = history;
            this.releaseHistory = history.use();
            // The live turn goes the moment the history holds its run.
            this.unsubscribeHistory = history.subscribe(() => this.settle());
            this.cursor = null;
            this.set({ ...IDLE, turn: this.current.turn });
            const run = ++this.run;
            void this.loop(run).catch(onError);
        }

        stop() {
            this.run += 1;
            this.connection?.abort();
            this.connection = undefined;
            this.wakeWait?.();
            this.endRun();
            this.streamRun = null;
            this.unsubscribeHistory?.();
            this.unsubscribeHistory = undefined;
            this.releaseHistory?.();
            this.releaseHistory = undefined;
            this.history = undefined;
            this.set({ live: false, reconnecting: false });
        }

        private async loop(run: number) {
            const stale = () => run !== this.run || closed;
            let attempt = 0;
            let awaySince: number | null = null;
            let slow: number | null = null;
            const away = async () => {
                const at = now();
                awaySince ??= at;
                if (at - awaySince >= RECONNECT_SLOW_AFTER_MS) {
                    slow = slow === null ? 0 : slow + 1;
                }
                const wait = delay(attempt, slow);
                attempt += 1;
                this.set({ live: false, reconnecting: true });
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(done, wait);
                    function done() {
                        clearTimeout(timer);
                        resolve();
                    }
                    this.wakeWait = done;
                });
                this.wakeWait = undefined;
            };
            const history = this.history!;
            // The chat's first stream needs no steering ask (the screen's `use` makes one); a reconnect does.
            let opened = false;
            while (!stale()) {
                // Caught up first: the stream then tells only what's new.
                const current = await history.pull();
                if (stale()) {
                    return;
                }
                if (history.state.gone) {
                    this.end('gone');
                    return;
                }
                if (!current) {
                    await away();
                    continue;
                }
                const controller = new AbortController();
                this.connection = controller;
                this.closedReason = null;
                const after = Math.max(this.cursor ?? 0, history.list().at(-1)?.seq ?? 0);
                const path = `/api/conversations/${encodeURIComponent(this.threadId)}/stream?after=${after}`;
                const headers: Record<string, string> = { Accept: 'text/event-stream' };
                if (this.cursor !== null) {
                    headers['Last-Event-ID'] = String(this.cursor);
                }
                try {
                    const response = await fetch(path, { headers, signal: controller.signal });
                    if (!response.ok) {
                        throw await httpError(response, controller.signal);
                    }
                    if (stale()) {
                        controller.abort();
                        return;
                    }
                    // It answered: what it tells from here is current.
                    attempt = 0;
                    awaySince = null;
                    slow = null;
                    this.set({ live: true, reconnecting: false, failed: false });
                    if (opened) {
                        // What steering last said may be from before the break: a turn the server ended
                        // while the stream was down (a restart) sends no frame to say so.
                        this.refreshSteering();
                    }
                    opened = true;
                    await readSse(response, (frame) => this.frame(frame), {
                        signal: controller.signal,
                        ...(silenceMs === undefined ? {} : { silenceMs }),
                    });
                    if (stale()) {
                        return;
                    }
                    this.dropped();
                    if (this.closedReason !== null) {
                        this.end(this.closedReason);
                        void history.pull();
                        return;
                    }
                    // Ended with no reason: the server stopping, or a chat converted to a room.
                    await away();
                } catch (error) {
                    if (stale()) {
                        return;
                    }
                    this.dropped();
                    if (error instanceof AbortedError && controller.signal.aborted) {
                        // `check`: open again at once, after a catch-up.
                        continue;
                    }
                    if (goneStatus(error)) {
                        await history.pull();
                        this.end(history.state.gone ? 'gone' : 'access');
                        return;
                    }
                    if (serverAway(error)) {
                        await away();
                        continue;
                    }
                    onError(error);
                    this.set({ live: false, reconnecting: false, failed: true });
                    return;
                } finally {
                    if (this.connection === controller) {
                        this.connection = undefined;
                    }
                }
            }
        }

        /** The connection is gone: the run it was in is no longer told. */
        private dropped() {
            this.endRun();
            this.streamRun = null;
            this.set({ live: false });
        }

        private end(reason: string) {
            this.refreshSteering();
            this.set({ live: false, reconnecting: false, ended: reason, turn: NO_LIVE_TURN });
            this.liveRun = undefined;
        }

        private endRun() {
            const end = this.endStreaming;
            this.endStreaming = undefined;
            end?.();
        }

        private refreshSteering() {
            if (steering && !closed) {
                void steering.steering(this.threadId).refresh();
            }
        }

        private frame(frame: SseFrame) {
            if (frame.kind === 'cursor') {
                this.cursor = Math.max(this.cursor ?? 0, frame.seq);
                this.refreshSteering();
                void this.history?.pull();
                return;
            }
            if (frame.kind === 'closed') {
                this.closedReason = frame.reason;
                return;
            }
            const event = frame.event;
            if (!isEvent(event)) {
                return;
            }
            // Whichever source shows the run, its move to the background and its report are the chat's.
            lifecycle.observe(this.threadId, event);
            const history = this.history;
            if (event.type === AG_UI_EVENT.RUN_STARTED) {
                const id = (event as { runId?: unknown }).runId;
                const runId = typeof id === 'string' ? id : undefined;
                // One source per run: this device's POST tells its own; a stored run is a replay.
                const dropped = this.own > 0 || (runId !== undefined && !!history?.hasRun(runId));
                this.streamRun = { id: runId, dropped };
                this.refreshSteering();
                if (dropped) {
                    return;
                }
                if (runId !== this.liveRun) {
                    // A run before it that isn't stored yet stays shown until `settle` finds it stored.
                    this.endRun();
                    this.liveRun = runId;
                }
                this.endStreaming ??= history?.streaming();
                this.reduce(event);
                return;
            }
            if (event.type === AG_UI_EVENT.TEXT_MESSAGE_START && (event as { role?: unknown }).role === 'user') {
                // A queued message delivered mid-run (or a hand-off): it left the queue.
                this.refreshSteering();
            }
            const ends = event.type === AG_UI_EVENT.RUN_FINISHED || event.type === AG_UI_EVENT.RUN_ERROR;
            // Decided once per run, at RUN_STARTED: a POST that starts mid-run drops only its own run.
            const dropped = this.streamRun === null ? this.own > 0 : this.streamRun.dropped;
            if (event.type === AG_UI_EVENT.RUN_ERROR) {
                const runId = this.streamRun?.id ?? this.liveRun;
                if (runId !== undefined) {
                    onRunError?.(this.threadId, runId, (event as { code?: unknown }).code);
                }
            }
            if (ends) {
                this.streamRun = null;
                this.refreshSteering();
            }
            if (dropped) {
                return;
            }
            this.reduce(event);
            if (ends) {
                this.endRun();
                this.settle();
            }
        }

        private reduce(event: BaseEvent) {
            this.set({ turn: applyRunEvent(this.current.turn, event, me()) });
        }

        /** Takes out of the live turn what the history now holds: all of it once its run is stored. */
        private settle() {
            const history = this.history;
            const turn = this.current.turn;
            if (!history || (turn.messages.length === 0 && !turn.running)) {
                return;
            }
            if (this.liveRun !== undefined && history.hasRun(this.liveRun)) {
                this.liveRun = undefined;
                this.endRun();
                this.set({ turn: NO_LIVE_TURN });
                return;
            }
            this.set({
                turn: keepLiveSteps(
                    turn,
                    stillLive(
                        turn,
                        history.list().flatMap((run) => run.messages),
                    ),
                ),
            });
        }
    }

    return {
        lifecycle,
        follow(threadId) {
            if (closed) {
                throw new Error('The follow store is closed.');
            }
            let follow = follows.get(threadId);
            if (!follow) {
                follow = new Follow(threadId);
                follows.set(threadId, follow);
            }
            return follow;
        },
        foreground() {
            for (const follow of follows.values()) {
                follow.check();
            }
        },
        wake() {
            for (const follow of follows.values()) {
                follow.wake();
            }
        },
        async close() {
            if (closed) {
                return;
            }
            closed = true;
            for (const follow of follows.values()) {
                follow.stop();
            }
            follows.clear();
            lifecycle.clear();
        },
    };
}
