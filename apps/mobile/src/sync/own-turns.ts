import { type LiveTurn, NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';

// The turns of runs this device started ("one source per run"): while its
// own POST streams, the follow stream drops that run's events (follow.ts's
// `ownRun`), so the run client's turn is the one the chat draws.
// chat-send.ts hands each event's turn to `set` (`onTurn`); the chat screen
// reads `turn` and lays it over the follow stream's (`chatLiveTurn`,
// src/chat/composer.ts).
// In memory only: once the run is stored the history draws it, and a restart
// reads it from there. No React Native: tests/sync runs it under Node.

export interface OwnTurns {
    /** The newest turn of a run this device started in `threadId`, or `NO_LIVE_TURN`. */
    turn(threadId: string): LiveTurn;
    /** The run client's turn after an event (chat-send.ts's `onTurn`). */
    set(threadId: string, turn: LiveTurn): void;
    /** Calls `listener` after each change of `threadId`'s turn. Returns the unsubscribe. */
    subscribe(threadId: string, listener: () => void): () => void;
    /** Forgets every turn and listener (the scope closed). */
    clear(): void;
}

export function createOwnTurns(): OwnTurns {
    const turns = new Map<string, LiveTurn>();
    const listeners = new Map<string, Set<() => void>>();
    return {
        turn: (threadId) => turns.get(threadId) ?? NO_LIVE_TURN,
        set(threadId, turn) {
            if (turns.get(threadId) === turn) {
                return;
            }
            turns.set(threadId, turn);
            for (const listener of [...(listeners.get(threadId) ?? [])]) {
                listener();
            }
        },
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
            turns.clear();
            listeners.clear();
        },
    };
}
