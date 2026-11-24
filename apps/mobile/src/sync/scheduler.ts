import { RECONNECT_MAX_MS, reconnectDelay } from '@socio/shared/reconnect';

import { serverAway } from '../net/reconnect';

import type { PullResult } from './snapshot-cache';
import type { SyncSource } from './snapshot-source';
import {
    type AppStateSource,
    type AppStateStatus,
    createNetworkWatch,
    isForeground,
    type NetworkSource,
    type NetworkState,
    returnsFromBackground,
} from './triggers';

// The one scheduler of a workspace's pulls. Each job is a source and the
// scope it pulls ('' for a whole kind, as the shell's two are: /api/state and
// /api/workspace):
// - one pull at a time per job. Pokes within 100 ms of the first are one pull
//   (the window is fixed, so pokes that never stop still pull every 100 ms). A
//   poke while the job's pull is in flight runs it once more after, except a
//   screen's: that answer is as fresh as it asks;
// - triggers, all in the foreground only, where 'inactive' counts:
//   - coming back to the foreground after 10 s or more in the background (a
//     picker or a share sheet is less, triggers.ts), and `start`: every job,
//     as a full poll (a start in the background waits for the foreground,
//     however soon it comes);
//   - a screen coming into view (`view`): the jobs that fill its collections,
//     if their last answer is older than 5 s;
//   - the network coming back or changing type (NetInfo): every job;
//   - every 15 s after a poll job's last pull ends: the shell's sources
//     (/api/state every 5 s, its `pollMs`, for presence);
//   - while a screen is in view (from `view` until the function it returns
//     is called), every `visiblePoll` after its job's last pull ends: a
//     module's kind at the web's interval (15 s for issues). A failure other
//     than the server away (a 403, a 404, a 500) doubles the wait, up to 5
//     minutes, until an answer: an error with back-off, never a wipe, since a
//     failed pull applies nothing;
//   - a higher server version (`stale`, versions.ts): the jobs it left stale,
//     which send their ETag;
//   - one of this device's writes confirmed while a job's pull was in flight
//     (`confirmed`): that job, once more;
// - a full poll sends no If-None-Match (a null cursor): on return to the
//   foreground, and when the job's last 200 is 5 minutes old, as the web's
//   PollTags does (FULL_POLL_MS in packages/client/src/lib/api.ts). Within one
//   server boot a 304 can come from change counters alone, so a counter that
//   missed a change could otherwise keep the copy stale;
// - while the server is away (src/net's `serverAway`: a 503 `draining`, a 502
//   or 504, an unreadable 503, no answer), it waits before asking again, with
//   jitter: reconnectDelay's 1 s, 2 s, 4 s… up to 10 s, and once the server
//   has been away longer than a deploy takes (about 5.5 minutes), rising
//   to 60 s: it isn't restarting then, but down or out of reach. Other pokes
//   wait for that attempt. Coming back to the foreground or the network coming
//   back starts the waits over at 1 s. `status()` says "Reconnecting…" from
//   the first failure to the next answer;
// - any other failure (a 401, a 500, a body that isn't the snapshot) goes to
//   `onError`, and the job keeps its cadence (a visible poll backs off);
// - a `deferred` job (a module's kind) waits while any other job's pull is in
//   flight or about to go: after a start, it is pulled after the shell;
// - an `inView` job (a module's kind no other screen counts) is left
//   out of the triggers that pull every job (a start or return, the network
//   back, `stale`, a poke of all) unless a screen showing it is in view: it is
//   pulled on its screen's view and polled while it stays.
// Jobs may come and go while it runs (`add`): a scoped kind's, one per scope
// (a Space's pages), added as its screen first shows it and removed
// with the scope; a removed job's pull in flight ends without a next one.
// Timers run only in the foreground: going to the background clears them, a
// brief leave resumes them where they were, and a return starts over.
// Everything runs on the timers' clock (Date.now), so fake timers drive it.

/** Pokes this close to the first are one pull. */
export const COALESCE_MS = 100;
/** A screen coming into view pulls its collections when their last answer is older than this. */
export const FRESH_MS = 5_000;
/** How long after a pull of the shell's ends the next one goes, in the foreground (the web polls every 3 s). */
export const SHELL_POLL_MS = 15_000;
/** A job's pull sends no If-None-Match when its last 200 is this old (the web's FULL_POLL_MS). */
export const FULL_POLL_MS = 5 * 60_000;
/** The longest wait of a visible poll that keeps failing. */
export const VISIBLE_POLL_MAX_MS = 5 * 60_000;
/** Away longer than a deploy takes (about 5.5 minutes), the waits rise past 10 s. */
export const RECONNECT_SLOW_AFTER_MS = 6 * 60_000;
/** The longest wait between attempts while the server is away. */
export const RECONNECT_SLOW_MAX_MS = 60_000;

/**
 * The wait before the next attempt while the server is away: reconnectDelay's
 * for attempt `attempt` (1 s, 2 s, 4 s… up to 10 s, give or take a quarter)
 * while `slowAttempt` is null; once the server has been away past
 * RECONNECT_SLOW_AFTER_MS, the `slowAttempt`-th wait since (from 0) doubles
 * from 10 s: 20 s, 40 s, then 60 s, give or take a quarter and never over 60 s.
 */
export function awayDelay(attempt: number, slowAttempt: number | null, random: () => number = Math.random): number {
    if (slowAttempt === null) {
        return reconnectDelay(attempt, random);
    }
    const base = Math.min(RECONNECT_SLOW_MAX_MS, RECONNECT_MAX_MS * 2 ** (slowAttempt + 1));
    return Math.min(RECONNECT_SLOW_MAX_MS, Math.round(base * (0.75 + random() * 0.5)));
}

/** What the scheduler pulls: a source, the scope it pulls, and what it fills. */
export interface SyncJob {
    readonly source: SyncSource;
    /** '' (the default) for a whole kind. */
    readonly scope?: string;
    /** The collections its answers fill: a screen showing one, or a write confirmed in one, pokes it. */
    readonly collections: readonly string[];
    /** Pulled every SHELL_POLL_MS in the foreground: the shell's sources. */
    readonly poll?: boolean;
    /** The poll's own interval, when not SHELL_POLL_MS: /api/state's carries presence (presence.ts). */
    readonly pollMs?: number;
    /** Pulled this long after each pull ends while a screen showing its collections is in view, in the foreground. */
    readonly visiblePoll?: number;
    /** Waits while another job's pull is in flight or about to go: a module's kind, after the shell. */
    readonly deferred?: boolean;
    /** Pulled only while a screen showing its collections is in view: a start, a return, the network back, `stale` or a poke of all skip it otherwise. */
    readonly inView?: boolean;
}

/** The connection as the header shows it. */
export interface SyncStatus {
    /** The server is away: "Reconnecting…", from the first failure to the next answer. */
    readonly reconnecting: boolean;
    /** Failed attempts since the waits last started over. */
    readonly attempts: number;
    /** When the next attempt goes (timers' clock), or null when none is waiting. */
    readonly retryAt: number | null;
}

export const CONNECTED: SyncStatus = { reconnecting: false, attempts: 0, retryAt: null };

export interface SchedulerOptions {
    readonly jobs: readonly SyncJob[];
    readonly appState: AppStateSource;
    readonly network: NetworkSource;
    /** A pull failed other than with the server away (a 401, a 500, a body that isn't the snapshot). */
    readonly onError?: (error: unknown, source: string) => void;
    /** Each pull's result, as it lands. */
    readonly onPull?: (source: string, result: PullResult) => void;
    /** The jitter's randomness, for tests. */
    readonly random?: () => number;
}

export interface SyncScheduler {
    /**
     * Listens to the app's state and the network, and pulls every job (full):
     * at once in the foreground, else on coming to it.
     */
    start(): void;
    /** Pulls these sources (by id), or all (an `inView` job only while in view): once more after a pull in flight. */
    poke(sources?: readonly string[]): void;
    /**
     * Pull to refresh: pulls the jobs that fill `collections` (of `scope`, when given) now, in
     * view or not, and resolves once none of them has a pull waiting or in flight. Offline, or while the
     * server is away, nothing goes and it resolves at once: the wait keeps its own back-off.
     */
    refresh(collections: readonly string[], scope?: string): Promise<void>;
    /**
     * Adds a job (a scoped kind's scope: a Space's pages). Started, it pulls at
     * once unless `inView`. Returns its removal: its timers go, and a pull in
     * flight ends with no next one; calling it again does nothing.
     */
    add(job: SyncJob): () => void;
    /**
     * A screen showing `collections` came into view: their jobs pull if their
     * last answer is older than 5 s, and those with a `visiblePoll` poll while
     * it stays. With `scope`, only the jobs of that scope (a Space's pages).
     * Returns the leave (the screen blurred), which stops that poll once no
     * screen shows them; calling it again does nothing.
     */
    view(collections: readonly string[], scope?: string): () => void;
    /** The highest server version moved: the jobs it left stale pull once (versions.ts). */
    stale(): void;
    /**
     * One of this device's writes was confirmed in `collection` (and `scope`, for
     * a scoped kind): a pull in flight that fills it runs once more.
     */
    confirmed(collection: string, scope?: string): void;
    /** The connection now: the same object until it changes. */
    status(): SyncStatus;
    /** Calls `listener` after each change of `status()`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Resolves once no pull is in flight. */
    idle(): Promise<void>;
    /**
     * Stops for good: every timer cleared, the app's state and the network no
     * longer heard, the status listeners dropped. A pull in flight is the
     * scope's to abort; its answer then starts nothing.
     */
    stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

interface JobState {
    readonly job: SyncJob;
    readonly scope: string;
    /** The pull in flight. */
    pulling: Promise<void> | null;
    /** Pull once more when the one in flight ends. */
    again: boolean;
    /** The next pull is a full one. */
    full: boolean;
    /** A pull is wanted but waits: for the server's next attempt, or the foreground. */
    waiting: boolean;
    /** Its last pull found the server away. */
    away: boolean;
    /** The 100 ms window of pokes. */
    window: Timer | null;
    /** The next poll. */
    poll: Timer | null;
    /** When its last answer came, or null. */
    answeredAt: number | null;
    /** When its last 200 came: the full poll counts from it. */
    fullAt: number;
    /** When its last pull ended, or null. */
    endedAt: number | null;
    /** Screens in view that show its collections. */
    viewers: number;
    /** Failures other than the server away since its last answer: a visible poll's back-off. */
    failures: number;
    /** Removed (`add`'s removal): it pulls no more. */
    removed: boolean;
}

/** The scheduler for one workspace's jobs. Nothing runs until `start`. */
export function createScheduler({
    jobs,
    appState,
    network,
    onError = () => {},
    onPull,
    random = Math.random,
}: SchedulerOptions): SyncScheduler {
    const now = () => Date.now();
    const stateOf = (job: SyncJob): JobState => ({
        job,
        scope: job.scope ?? '',
        pulling: null,
        again: false,
        full: false,
        waiting: false,
        away: false,
        window: null,
        poll: null,
        answeredAt: null,
        fullAt: Number.NEGATIVE_INFINITY,
        endedAt: null,
        viewers: 0,
        failures: 0,
        removed: false,
    });
    const states: JobState[] = jobs.map(stateOf);
    const listeners = new Set<() => void>();
    const unsubscribes: (() => void)[] = [];
    const watch = createNetworkWatch();
    let started = false;
    let stopped = false;
    let foreground = false;
    let backgroundedAt: number | null = null;
    /**
     * The server's absence: whether it is away; the attempt the next wait is
     * for, and the slow one once past RECONNECT_SLOW_AFTER_MS (null before);
     * since when the waits run; and when the next attempt goes.
     */
    const away = {
        failing: false,
        attempt: 0,
        slow: null as number | null,
        since: null as number | null,
        retryAt: null as number | null,
    };
    let retry: Timer | null = null;
    let status: SyncStatus = CONNECTED;

    const setStatus = () => {
        const next: SyncStatus = away.failing
            ? { reconnecting: true, attempts: away.attempt, retryAt: away.retryAt }
            : CONNECTED;
        if (
            next.reconnecting === status.reconnecting &&
            next.attempts === status.attempts &&
            next.retryAt === status.retryAt
        ) {
            return;
        }
        status = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const clear = (timer: Timer | null): null => {
        if (timer !== null) {
            clearTimeout(timer);
        }
        return null;
    };

    /**
     * Asks `state` for a pull. `rerun`: once more after a pull in flight;
     * `full`: with no If-None-Match.
     */
    const want = (state: JobState, { rerun, full = false }: { rerun: boolean; full?: boolean }) => {
        if (!started || stopped || state.removed) {
            return;
        }
        if (full) {
            state.full = true;
        }
        if (state.pulling !== null) {
            state.again ||= rerun;
            return;
        }
        if (!foreground || away.retryAt !== null) {
            state.waiting = true;
            return;
        }
        state.window ??= setTimeout(() => {
            state.window = null;
            run(state);
        }, COALESCE_MS);
    };

    /** How long after a pull ends the next one goes by itself, or null when none does. */
    const pollInterval = (state: JobState): number | null => {
        const { poll, visiblePoll } = state.job;
        if (poll) {
            return state.job.pollMs ?? SHELL_POLL_MS;
        }
        if (visiblePoll === undefined || state.viewers === 0) {
            return null;
        }
        return Math.min(VISIBLE_POLL_MAX_MS, visiblePoll * 2 ** state.failures);
    };

    /** The next poll, `elapsed` after the last pull ended. */
    const schedulePoll = (state: JobState, elapsed = 0) => {
        state.poll = clear(state.poll);
        const interval = pollInterval(state);
        if (interval === null || !foreground || stopped) {
            return;
        }
        state.poll = setTimeout(
            () => {
                state.poll = null;
                run(state);
            },
            Math.max(0, interval - elapsed),
        );
    };

    /** Whether a trigger of every job pulls this one: an `inView` job only while a screen shows it. */
    const everyJob = (state: JobState) => !state.job.inView || state.viewers > 0;

    /** Another job's pull is in flight or about to go: a deferred job waits for it. */
    const othersBusy = (state: JobState) =>
        states.some(
            (other) => !other.job.deferred && other !== state && (other.pulling !== null || other.window !== null),
        );

    /** The server didn't answer: wait before the next attempt, unless a wait already covers this one. */
    const markAway = () => {
        const at = now();
        if (away.retryAt !== null && away.retryAt > at) {
            return;
        }
        away.failing = true;
        away.since ??= at;
        if (at - away.since >= RECONNECT_SLOW_AFTER_MS) {
            away.slow = away.slow === null ? 0 : away.slow + 1;
        }
        const delay = awayDelay(away.attempt, away.slow, random);
        away.attempt += 1;
        away.retryAt = at + delay;
        retry = clear(retry);
        if (foreground) {
            retry = setTimeout(attempt, delay);
        }
        setStatus();
    };

    /** The wait is over: the jobs the server didn't answer, and those that waited, try again now. */
    const attempt = () => {
        retry = null;
        away.retryAt = null;
        setStatus();
        for (const state of states) {
            if (state.pulling === null && (state.away || state.waiting)) {
                run(state);
            }
        }
    };

    /** The waits start over (a return to the foreground, the network back). The status stays until an answer. */
    const restartWaits = () => {
        retry = clear(retry);
        away.attempt = 0;
        away.slow = null;
        away.since = null;
        away.retryAt = null;
        setStatus();
    };

    /** The server answered `state`'s pull, whatever it said: if it was away, whatever waited for it goes now. */
    const serverBack = (state: JobState) => {
        state.away = false;
        if (!away.failing) {
            return;
        }
        away.failing = false;
        restartWaits();
        for (const other of states) {
            if (other !== state && (other.away || other.waiting)) {
                other.waiting = false;
                want(other, { rerun: true });
            }
        }
    };

    const answered = (state: JobState, result: PullResult) => {
        const at = now();
        onPull?.(state.job.source.id, result);
        if (result.outcome === 'superseded') {
            // A later answer overtook it, so it vouches for nothing: ask again.
            state.again = true;
        } else {
            state.answeredAt = at;
            state.failures = 0;
            if (result.outcome !== 'not-modified') {
                state.fullAt = at;
            }
        }
        serverBack(state);
    };

    const failed = (state: JobState, error: unknown, full: boolean) => {
        if (full) {
            // Still owed.
            state.full = true;
        }
        if ((error as { name?: unknown } | null)?.name === 'AbortError') {
            // Only the scope stops its requests, and it stops the scheduler first.
            return;
        }
        if (serverAway(error)) {
            state.away = true;
            markAway();
            return;
        }
        // A 401, a 500, a body that isn't the snapshot: the server is there, and said no.
        state.failures += 1;
        serverBack(state);
        onError(error, state.job.source.id);
    };

    const ended = (state: JobState) => {
        state.pulling = null;
        state.endedAt = now();
        if (stopped || state.removed) {
            return;
        }
        if (state.again) {
            state.again = false;
            want(state, { rerun: false });
        } else if (!state.away) {
            schedulePoll(state);
        }
        // The deferred jobs that waited for the others go once none is busy.
        if (!state.job.deferred && foreground && away.retryAt === null) {
            for (const other of states) {
                if (other.job.deferred && other.waiting && other.pulling === null && !othersBusy(other)) {
                    other.waiting = false;
                    want(other, { rerun: false });
                }
            }
        }
    };

    const run = (state: JobState) => {
        state.window = clear(state.window);
        state.poll = clear(state.poll);
        if (stopped || state.removed || state.pulling !== null) {
            return;
        }
        if (!foreground || away.retryAt !== null || (state.job.deferred && othersBusy(state))) {
            state.waiting = true;
            return;
        }
        const full = state.full || now() - state.fullAt >= FULL_POLL_MS;
        state.full = false;
        state.waiting = false;
        state.again = false;
        const { source } = state.job;
        const pull = async () => source.pull(state.scope, full ? null : source.cursor(state.scope));
        state.pulling = pull()
            .then(
                (result) => {
                    if (!stopped) {
                        answered(state, result);
                    }
                },
                (error: unknown) => {
                    if (!stopped) {
                        failed(state, error, full);
                    }
                },
            )
            .finally(() => {
                ended(state);
            });
    };

    /** Back after the background for long enough, or the start: every job, full, the waits over. */
    const returned = () => {
        restartWaits();
        for (const state of states) {
            state.waiting = false;
            if (everyJob(state)) {
                want(state, { rerun: true, full: true });
            }
        }
    };

    /** Back after a brief leave (a picker): the timers resume where they were. */
    const resumed = () => {
        const at = now();
        if (away.retryAt !== null) {
            retry = clear(retry);
            retry = setTimeout(attempt, Math.max(0, away.retryAt - at));
        }
        for (const state of states) {
            if (state.pulling !== null) {
                continue;
            }
            if (state.waiting) {
                state.waiting = false;
                want(state, { rerun: true });
            } else if (pollInterval(state) !== null) {
                schedulePoll(state, state.endedAt === null ? Number.POSITIVE_INFINITY : at - state.endedAt);
            }
        }
    };

    /** Gone to the background: every timer goes; what was about to pull waits for the foreground. */
    const paused = () => {
        retry = clear(retry);
        for (const state of states) {
            if (state.window !== null) {
                state.waiting = true;
            }
            state.window = clear(state.window);
            state.poll = clear(state.poll);
        }
    };

    const onAppState = (next: AppStateStatus) => {
        if (stopped) {
            return;
        }
        const at = now();
        const nowForeground = isForeground(next);
        if (nowForeground === foreground) {
            return;
        }
        foreground = nowForeground;
        if (!foreground) {
            backgroundedAt = at;
            paused();
            return;
        }
        const long = returnsFromBackground(backgroundedAt, at);
        backgroundedAt = null;
        if (long) {
            returned();
        } else {
            resumed();
        }
    };

    const onNetwork = (state: NetworkState) => {
        if (stopped) {
            return;
        }
        const change = watch.report(state);
        if ((change === 'back' || change === 'changed') && foreground) {
            restartWaits();
            for (const job of states) {
                job.waiting = false;
                if (everyJob(job)) {
                    want(job, { rerun: true });
                }
            }
        }
    };

    return {
        start() {
            if (started || stopped) {
                return;
            }
            started = true;
            foreground = isForeground(appState.current());
            backgroundedAt = foreground ? null : now();
            unsubscribes.push(appState.subscribe(onAppState), network.subscribe(onNetwork));
            network
                .current()
                .then((state) => {
                    if (!stopped) {
                        watch.seed(state);
                    }
                })
                .catch(() => {});
            // A start is a return. In the background its pulls wait, so the foreground pulls every job, even
            // after a brief leave, which only resumes what waits.
            returned();
        },
        poke(sources) {
            for (const state of states) {
                if (sources === undefined ? everyJob(state) : sources.includes(state.job.source.id)) {
                    want(state, { rerun: true });
                }
            }
        },
        async refresh(collections, scope) {
            const shown = states.filter(
                (state) =>
                    (scope === undefined || state.scope === scope) &&
                    state.job.collections.some((collection) => collections.includes(collection)),
            );
            for (const state of shown) {
                want(state, { rerun: true });
            }
            for (;;) {
                const busy = shown.filter(
                    (state) => !state.removed && !stopped && (state.window !== null || state.pulling !== null),
                );
                if (busy.length === 0) {
                    return;
                }
                const pulling = busy.flatMap((state) => (state.pulling === null ? [] : [state.pulling]));
                await (pulling.length > 0
                    ? Promise.all(pulling)
                    : new Promise<void>((resolve) => setTimeout(resolve, COALESCE_MS)));
            }
        },
        add(job) {
            const state = stateOf(job);
            states.push(state);
            if (!job.inView) {
                want(state, { rerun: true, full: true });
            }
            return () => {
                if (state.removed) {
                    return;
                }
                state.removed = true;
                state.window = clear(state.window);
                state.poll = clear(state.poll);
                const index = states.indexOf(state);
                if (index >= 0) {
                    states.splice(index, 1);
                }
            };
        },
        view(collections, scope) {
            const at = now();
            const shown = states.filter(
                (state) =>
                    (scope === undefined || state.scope === scope) &&
                    state.job.collections.some((collection) => collections.includes(collection)),
            );
            for (const state of shown) {
                state.viewers += 1;
                if (state.answeredAt === null || at - state.answeredAt > FRESH_MS) {
                    want(state, { rerun: false });
                } else if (
                    started &&
                    !stopped &&
                    state.pulling === null &&
                    state.window === null &&
                    state.poll === null &&
                    !state.away
                ) {
                    // Fresh: its poll counts from the last pull's end.
                    schedulePoll(state, state.endedAt === null ? 0 : at - state.endedAt);
                }
            }
            let left = false;
            return () => {
                if (left) {
                    return;
                }
                left = true;
                for (const state of shown) {
                    state.viewers -= 1;
                    if (pollInterval(state) === null) {
                        state.poll = clear(state.poll);
                    }
                }
            };
        },
        stale() {
            for (const state of states) {
                if (everyJob(state) && state.job.source.stale(state.scope)) {
                    want(state, { rerun: true });
                }
            }
        },
        confirmed(collection, scope) {
            for (const state of states) {
                if (
                    state.pulling !== null &&
                    (scope === undefined || state.scope === scope) &&
                    state.job.collections.includes(collection)
                ) {
                    state.again = true;
                }
            }
        },
        status: () => status,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async idle() {
            for (;;) {
                const pulling = states.flatMap((state) => (state.pulling === null ? [] : [state.pulling]));
                if (pulling.length === 0) {
                    return;
                }
                await Promise.all(pulling);
            }
        },
        stop() {
            if (stopped) {
                return;
            }
            stopped = true;
            for (const unsubscribe of unsubscribes.splice(0)) {
                unsubscribe();
            }
            retry = clear(retry);
            for (const state of states) {
                state.window = clear(state.window);
                state.poll = clear(state.poll);
            }
            listeners.clear();
        },
    };
}
