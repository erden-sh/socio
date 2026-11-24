import { resolveThreadFeedLiveFollow } from '../../vendor/t3code/thread-feed-live-follow';

// Following the end of a chat's transcript (T3 Code's feed,
// vendor/t3code/thread-feed-live-follow.ts): a small state machine, not a
// distance check. Only the person's own scroll session (a drag, through its
// momentum) turns following off; it closes 160 ms after the finger lifts
// unless momentum starts, and following comes back only when the list is
// exactly at its end. Layout changes and the list's own scrolls never turn it
// off. While it follows, the list keeps its end in view as rows grow (the
// screen's `maintainScrollAtEnd`); while it doesn't, it keeps the reader's
// rows in place. `reset` (a send, Jump to latest) follows again. A row the
// person opens or closes (a turn's steps, CB-437) stops following unless a
// reply is streaming, so the row stays where it is and opens below, as in
// Settings or Files; once it settles, the list follows again only if it is
// still at its end. Timers are injected, so tests/chat drives it with fake ones.

/** How long after the finger lifts a scroll session stays open for momentum to start (T3 Code's). */
export const SCROLL_SESSION_GRACE_MS = 160;

/**
 * When a row opened or closed is read for the list's end (CB-437): this long
 * after the last row resized (the list has its new size by then), or after
 * `DISCLOSURE_SETTLE_MS` if no row reports one.
 */
export const DISCLOSURE_RESIZED_MS = 100;
export const DISCLOSURE_SETTLE_MS = 1000;

/** Slack for "exactly at the end", in points: a rounding error, not LegendList's wider threshold. */
export const AT_END_SLACK = 1;

export interface ScrollMetrics {
    readonly contentOffset: { readonly y: number };
    readonly contentSize: { readonly height: number };
    readonly layoutMeasurement: { readonly height: number };
}

/** Whether a vertical list is scrolled to its very end. */
export const isAtEnd = ({ contentOffset, contentSize, layoutMeasurement }: ScrollMetrics) =>
    contentOffset.y + layoutMeasurement.height >= contentSize.height - AT_END_SLACK;

export interface FollowSession {
    /** The list follows its end. */
    readonly following: boolean;
    /** Calls `listener` each time `following` changes. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    dragBegin(): void;
    dragEnd(atEnd: boolean): void;
    momentumBegin(): void;
    momentumEnd(atEnd: boolean): void;
    scroll(atEnd: boolean): void;
    /**
     * The person opened or closed a row (a turn's steps, CB-437): following
     * stops, so the list keeps the row in place instead of its end, unless a
     * reply is streaming. Once the row has settled (`resized`, or
     * `DISCLOSURE_SETTLE_MS`), `atEnd` says whether the list is still at its
     * end (a short chat, a row closed at the end): it follows again if so
     * (T3's `disclosure-settled`).
     */
    disclosure(streaming: boolean, atEnd: () => boolean): void;
    /** A row changed size: a row opened or closed has settled `DISCLOSURE_RESIZED_MS` after the last. */
    resized(): void;
    /** A row opened or closed hasn't settled yet: the screen keeps that row where it was (`sizeChangeAnchor`). */
    readonly holding: boolean;
    /** Follow again: a send, or Jump to latest. */
    reset(): void;
    dispose(): void;
}

export interface FollowSessionTimers {
    readonly setTimeout: (run: () => void, ms: number) => unknown;
    readonly clearTimeout: (timer: unknown) => void;
}

const SYSTEM_TIMERS: FollowSessionTimers = {
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createFollowSession(timers: FollowSessionTimers = SYSTEM_TIMERS): FollowSession {
    let following = true;
    let session = false;
    let lastAtEnd = true;
    let closing: unknown = null;
    const listeners = new Set<() => void>();

    const set = (next: boolean) => {
        if (next !== following) {
            following = next;
            for (const listener of [...listeners]) {
                listener();
            }
        }
    };
    let settling: unknown = null;
    let readAtEnd: (() => boolean) | null = null;
    const cancelSettle = () => {
        readAtEnd = null;
        if (settling !== null) {
            timers.clearTimeout(settling);
            settling = null;
        }
    };
    const settleIn = (ms: number) => {
        if (settling !== null) {
            timers.clearTimeout(settling);
        }
        settling = timers.setTimeout(() => {
            const atEnd = readAtEnd;
            settling = null;
            readAtEnd = null;
            if (atEnd !== null) {
                set(
                    resolveThreadFeedLiveFollow(following, {
                        type: 'disclosure-settled',
                        isAtEnd: atEnd(),
                        userScrollSessionActive: session,
                    }),
                );
            }
        }, ms);
    };
    const cancelClose = () => {
        if (closing !== null) {
            timers.clearTimeout(closing);
            closing = null;
        }
    };
    const close = (atEnd: boolean) => {
        cancelClose();
        if (!session) {
            return;
        }
        set(
            resolveThreadFeedLiveFollow(following, {
                type: 'user-scroll-end',
                isAtEnd: atEnd,
                userScrollSessionActive: true,
            }),
        );
        session = false;
    };

    return {
        get following() {
            return following;
        },
        get holding() {
            return readAtEnd !== null;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        dragBegin() {
            cancelClose();
            cancelSettle();
            session = true;
            set(resolveThreadFeedLiveFollow(following, { type: 'user-scroll-begin' }));
        },
        dragEnd(atEnd) {
            lastAtEnd = atEnd;
            cancelClose();
            closing = timers.setTimeout(() => {
                closing = null;
                close(lastAtEnd);
            }, SCROLL_SESSION_GRACE_MS);
        },
        momentumBegin() {
            cancelClose();
        },
        momentumEnd(atEnd) {
            lastAtEnd = atEnd;
            close(atEnd);
        },
        scroll(atEnd) {
            lastAtEnd = atEnd;
            set(
                resolveThreadFeedLiveFollow(following, {
                    type: 'scroll',
                    isAtEnd: atEnd,
                    userScrollSessionActive: session,
                }),
            );
        },
        disclosure(streaming, atEnd) {
            if (streaming) {
                return;
            }
            set(false);
            readAtEnd = atEnd;
            settleIn(DISCLOSURE_SETTLE_MS);
        },
        resized() {
            if (readAtEnd !== null) {
                settleIn(DISCLOSURE_RESIZED_MS);
            }
        },
        reset() {
            cancelClose();
            cancelSettle();
            session = false;
            set(resolveThreadFeedLiveFollow(following, { type: 'reset' }));
        },
        dispose() {
            cancelClose();
            cancelSettle();
            listeners.clear();
        },
    };
}

/** How long after a turn ends the list goes back to its end: the stored run and the footer settle first. */
export const TURN_END_SETTLE_MS = 250;

/**
 * Whether the list should go back to its end now: a turn just ended
 * (Stop, or its last event) while the list follows. The stored run then
 * replaces the live turn and the pill goes, and the list's own
 * maintain-at-end can leave it part-way, the keyboard hidden.
 */
export function returnsToEndAfterTurn(wasRunning: boolean, running: boolean, following: boolean): boolean {
    return wasRunning && !running && following;
}
