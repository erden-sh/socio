import type { BaseEvent } from '@ag-ui/core';

// A run's place in the chat beyond its own stream (CB-434): a run still going
// after 2 minutes moves to the background, and reports back in the chat when
// it ends. The server's events for these aren't
// designed yet, so this is the one place they will land: `LIFECYCLE_EVENTS`
// maps an AG-UI event to a signal, and is empty until the names come. The
// follow stream hands every event of a chat to `observe` (follow.ts), and the
// transcript draws what `state` holds (transcript.ts's `run-note` rows): "Moved
// to the background" while a run works there, then its report. Nothing here
// changes how a run streams, or the outbox. In memory only, per workspace
// scope (the follow store's). No React Native here: tests/chat runs it.

/** A run working in the background. */
export interface BackgroundRun {
    readonly runId: string;
    /** When it moved there, when the signal says. */
    readonly at?: number;
}

/** A background run that ended and reported back. */
export interface RunReport {
    readonly runId: string;
    /** What it did, in the server's words (a line or two). */
    readonly summary: string;
    /** Where its result is (a web path, `/chats/…`), or null. */
    readonly link: string | null;
    readonly at?: number;
}

/** What one chat's runs did beyond their streams. */
export interface ThreadLifecycle {
    /** Runs working in the background, oldest first. */
    readonly background: readonly BackgroundRun[];
    /** Reports of background runs that ended, oldest first. */
    readonly reports: readonly RunReport[];
}

/** A lifecycle change, from whatever told it. */
export type LifecycleSignal =
    /** The run went to the background. */
    | ({ readonly kind: 'background' } & BackgroundRun)
    /** The background run finished: its summary and link. */
    | ({ readonly kind: 'finished' } & RunReport);

/**
 * The server's events that tell a lifecycle change, by AG-UI `type` (a CUSTOM
 * event by its `name` as `CUSTOM:<name>`), each read into its signal or null.
 * Empty until the server's names are settled (CB-432): today nothing maps.
 */
export const LIFECYCLE_EVENTS: Readonly<Record<string, (event: BaseEvent) => LifecycleSignal | null>> = {};

/** The signal an event tells, or null (every event, today). */
export function lifecycleSignal(event: BaseEvent): LifecycleSignal | null {
    const name = (event as { name?: unknown }).name;
    const key = event.type === 'CUSTOM' && typeof name === 'string' ? `CUSTOM:${name}` : event.type;
    const read = Object.prototype.hasOwnProperty.call(LIFECYCLE_EVENTS, key) ? LIFECYCLE_EVENTS[key] : undefined;
    return read === undefined ? null : read(event);
}

export const NO_LIFECYCLE: ThreadLifecycle = { background: [], reports: [] };

/** `state` after `signal`: a run moves to the background once, and its report takes it out of there. */
export function applyLifecycle(state: ThreadLifecycle, signal: LifecycleSignal): ThreadLifecycle {
    if (signal.kind === 'background') {
        if (
            state.background.some((run) => run.runId === signal.runId) ||
            state.reports.some((report) => report.runId === signal.runId)
        ) {
            return state;
        }
        const run: BackgroundRun = { runId: signal.runId, ...(signal.at === undefined ? {} : { at: signal.at }) };
        return { ...state, background: [...state.background, run] };
    }
    if (state.reports.some((report) => report.runId === signal.runId)) {
        return state;
    }
    const report: RunReport = {
        runId: signal.runId,
        summary: signal.summary,
        link: signal.link,
        ...(signal.at === undefined ? {} : { at: signal.at }),
    };
    return {
        background: state.background.filter((run) => run.runId !== signal.runId),
        reports: [...state.reports, report],
    };
}

/** The adapter: the follow stream tells it events, the transcript reads it. */
export interface RunLifecycle {
    /** An event of `threadId`'s stream: applied when `LIFECYCLE_EVENTS` maps it. */
    observe(threadId: string, event: BaseEvent): void;
    /** The run went to the background. */
    backgrounded(threadId: string, run: BackgroundRun): void;
    /** The background run finished: its summary and link. */
    finished(threadId: string, report: RunReport): void;
    /** What `threadId`'s runs did beyond their streams; the same object until it changes. */
    state(threadId: string): ThreadLifecycle;
    /** Calls `listener` after each change of `threadId`'s state. Returns the unsubscribe. */
    subscribe(threadId: string, listener: () => void): () => void;
    /** Forgets everything (the scope closed). */
    clear(): void;
}

export function createRunLifecycle(): RunLifecycle {
    const states = new Map<string, ThreadLifecycle>();
    const listeners = new Map<string, Set<() => void>>();
    const apply = (threadId: string, signal: LifecycleSignal) => {
        const before = states.get(threadId) ?? NO_LIFECYCLE;
        const after = applyLifecycle(before, signal);
        if (after === before) {
            return;
        }
        states.set(threadId, after);
        for (const listener of [...(listeners.get(threadId) ?? [])]) {
            listener();
        }
    };
    return {
        observe(threadId, event) {
            const signal = lifecycleSignal(event);
            if (signal !== null) {
                apply(threadId, signal);
            }
        },
        backgrounded: (threadId, run) => apply(threadId, { kind: 'background', ...run }),
        finished: (threadId, report) => apply(threadId, { kind: 'finished', ...report }),
        state: (threadId) => states.get(threadId) ?? NO_LIFECYCLE,
        subscribe(threadId, listener) {
            let set = listeners.get(threadId);
            if (set === undefined) {
                set = new Set();
                listeners.set(threadId, set);
            }
            set.add(listener);
            return () => {
                set.delete(listener);
                if (set.size === 0) {
                    listeners.delete(threadId);
                }
            };
        },
        clear() {
            states.clear();
            listeners.clear();
        },
    };
}
