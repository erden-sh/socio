import { useCallback, useEffect, useRef, useState } from 'react';

import { OPPOSITE, type MessageReactions, type ReactionKind, type ReactionsView } from '@socio/shared/chat/reactions';

import { ApiError, PollTags, UNCHANGED, api, apiIfChanged } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';

/** How often a visible chat asks for other people's and devices' reactions. */
export const REACTIONS_POLL_MS = 5000;
/** How long "Could not save" stays under a message. */
export const FAILED_MS = 4000;

const NONE: MessageReactions = { counts: {}, mine: [] };

export interface ReactionsApi {
    /** More than one person can see this chat: counts show from one. */
    shared: boolean;
    of(messageId: string): MessageReactions;
    /** Adds the reaction, or takes it back when it is the reader's own. */
    toggle(messageId: string, kind: ReactionKind): void;
    /** The message whose last change did not save. */
    failed?: string;
}

/** `view` with the reader's `kind` on the message added or taken back. */
export function withReaction(view: ReactionsView, messageId: string, kind: ReactionKind, add: boolean): ReactionsView {
    const current = view.messages[messageId] ?? NONE;
    const counts = { ...current.counts };
    let mine = current.mine;
    const drop = (gone: ReactionKind) => {
        if (!mine.includes(gone)) {
            return;
        }
        mine = mine.filter((item) => item !== gone);
        counts[gone] = (counts[gone] ?? 1) - 1;
        if (!counts[gone]) {
            delete counts[gone];
        }
    };
    if (add) {
        const opposite = OPPOSITE[kind];
        if (opposite) {
            drop(opposite);
        }
        if (!mine.includes(kind)) {
            mine = [...mine, kind];
            counts[kind] = (counts[kind] ?? 0) + 1;
        }
    } else {
        drop(kind);
    }
    const messages = { ...view.messages };
    if (mine.length || Object.keys(counts).length) {
        messages[messageId] = { counts, mine };
    } else {
        delete messages[messageId];
    }
    return { ...view, messages };
}

/**
 * A conversation's reactions (CB-133): fetched alongside its history,
 * polled while the chat is in view (a 304 when nothing changed), and
 * refetched at once on another tab's note. A change shows at once and is
 * put back if the server refuses it.
 */
export function useReactions(threadId: string, enabled: boolean): ReactionsApi | undefined {
    const [view, setView] = useState<ReactionsView>();
    const [failed, setFailed] = useState<string>();
    const tags = useRef(new PollTags());
    // Writes in flight: a poll that answers meanwhile would undo the change.
    const writing = useRef(0);
    const path = `/conversations/${threadId}/reactions`;
    const current = useRef(view);
    current.current = view;
    const load = useCallback(
        async (isActive: () => boolean = () => true) => {
            try {
                const fresh = await apiIfChanged<ReactionsView>(path, tags.current.get(path));
                if (fresh === UNCHANGED || !isActive() || writing.current) {
                    return;
                }
                tags.current.set(path, fresh.tag);
                setView(fresh.data);
            } catch {
                // The next poll tries again; the chat reads fine without them.
            }
        },
        [path],
    );
    // At once on another tab's note; a tick waits while the shell re-reads
    // (a conversation this user left is never asked for).
    const canPoll = useLiveTopic(enabled ? `conversation:${threadId}` : undefined, () => load(canPoll));
    useEffect(() => {
        setView(undefined);
        tags.current.forget();
        if (!enabled) {
            return;
        }
        let active = true;
        const isActive = () => active;
        void load(isActive);
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible' && canPoll()) {
                void load(isActive);
            }
        }, REACTIONS_POLL_MS);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [enabled, load, canPoll]);
    const failure = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(failure.current), []);
    const toggle = useCallback(
        (messageId: string, kind: ReactionKind) => {
            const before = current.current;
            if (!before) {
                return;
            }
            const add = !(before.messages[messageId]?.mine ?? []).includes(kind);
            clearTimeout(failure.current);
            setFailed(undefined);
            setView(withReaction(before, messageId, kind, add));
            writing.current += 1;
            void api<ReactionsView>(
                `/conversations/${threadId}/messages/${encodeURIComponent(messageId)}/reactions/${kind}`,
                add ? 'PUT' : 'DELETE',
            )
                .then((saved) => {
                    tags.current.set(path, null);
                    setView(saved);
                })
                .catch((error: unknown) => {
                    setView(before);
                    setFailed(messageId);
                    failure.current = setTimeout(() => setFailed(undefined), FAILED_MS);
                    // A conversation or message that is gone says nothing more.
                    if (!(error instanceof ApiError)) {
                        tags.current.set(path, null);
                    }
                })
                .finally(() => {
                    writing.current -= 1;
                });
        },
        [threadId, path],
    );
    if (!enabled || !view) {
        return undefined;
    }
    return {
        shared: view.shared,
        of: (messageId) => view.messages[messageId] ?? NONE,
        toggle,
        failed,
    };
}
