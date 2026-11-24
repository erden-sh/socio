import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { HistoryRun } from '@socio/shared/chat/chat-history';

import { chatHistory, type ChatHistory, type HistoryState } from './chat-history';

const OFF: HistoryState = {
    ready: false,
    settled: true,
    failed: true,
    earlier: false,
    loadingEarlier: false,
};
const NONE: readonly HistoryRun[] = [];
const quiet = () => () => {};

/**
 * A conversation's synced history for the signed-in person (CB-136): its
 * runs, oldest first, as the client store's collection holds them, and
 * how it stands. Without a person (signed out) there is none: `failed`,
 * and the chat replays its conversation as before. The server render has
 * none either: the chat renders in the browser only.
 */
export function useChatHistory(
    threadId: string,
    userId: string | undefined,
): HistoryState & { history?: ChatHistory; runs: readonly HistoryRun[] } {
    const history = useMemo(() => (userId ? chatHistory(userId, threadId) : undefined), [userId, threadId]);
    useEffect(() => {
        if (!history) {
            return;
        }
        history.users += 1;
        return () => {
            history.users -= 1;
        };
    }, [history]);
    const subscribe = history?.subscribe ?? quiet;
    const state = useSyncExternalStore(
        subscribe,
        () => history?.state ?? OFF,
        () => OFF,
    );
    const runs = useSyncExternalStore(
        subscribe,
        () => history?.runs ?? NONE,
        () => NONE,
    );
    return { ...state, history, runs };
}
