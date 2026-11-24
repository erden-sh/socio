import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { type LiveTurn, NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';

import type { ChatFollow, FollowState } from '../sync/follow';
import type { ChatHistory, HistoryState } from '../sync/history';

// One chat's history and follow stream as one external store, for React's
// useSyncExternalStore (the chat screen). The snapshot is rebuilt only
// when something in it changed: the history's state, its runs (compared by
// identity, since the store never rewrites an unchanged run) or the follow's
// state. `get` checks each time it is asked, so a change between a render and
// the subscription is never missed. A run this device started streams through
// its own POST, which the follow stream drops: `own` is the scope's
// `turns` for the chat, and `turn` the one the screen draws (`chatLiveTurn`).
// No React here: tests/chat runs it under Node.

export interface ChatSnapshot {
    readonly history: HistoryState;
    /** The stored runs, oldest first. */
    readonly runs: readonly HistoryRun[];
    readonly follow: FollowState;
    /** The turn of a run this device started, while its POST streams (or NO_LIVE_TURN). */
    readonly own: LiveTurn;
}

/** One chat's own turns: the scope's `turns` for it. */
export interface OwnTurn {
    turn(): LiveTurn;
    subscribe(listener: () => void): () => void;
}

const NO_OWN_TURN: OwnTurn = { turn: () => NO_LIVE_TURN, subscribe: () => () => {} };

export interface ChatSource {
    readonly history: ChatHistory;
    readonly follow: ChatFollow;
    subscribe(listener: () => void): () => void;
    get(): ChatSnapshot;
}

const sameRuns = (a: readonly HistoryRun[], b: readonly HistoryRun[]) =>
    a.length === b.length && a.every((run, index) => run === b[index]);

export function chatSource(history: ChatHistory, follow: ChatFollow, own: OwnTurn = NO_OWN_TURN): ChatSource {
    let snapshot: ChatSnapshot | null = null;
    return {
        history,
        follow,
        subscribe(listener) {
            const stopHistory = history.subscribe(listener);
            const stopFollow = follow.subscribe(listener);
            const stopOwn = own.subscribe(listener);
            return () => {
                stopHistory();
                stopFollow();
                stopOwn();
            };
        },
        get() {
            const runs = history.list();
            const ownTurn = own.turn();
            if (
                snapshot === null ||
                snapshot.history !== history.state ||
                snapshot.follow !== follow.state ||
                snapshot.own !== ownTurn ||
                !sameRuns(snapshot.runs, runs)
            ) {
                snapshot = { history: history.state, runs, follow: follow.state, own: ownTurn };
            }
            return snapshot;
        },
    };
}

/**
 * Holds a chat for a screen: its history and follow stream in use (the
 * history pulled and kept in memory, the stream open once caught up) until the
 * returned release.
 */
export function holdChat(source: Pick<ChatSource, 'history' | 'follow'>): () => void {
    const releaseHistory = source.history.use();
    const releaseFollow = source.follow.use();
    return () => {
        releaseFollow();
        releaseHistory();
    };
}
