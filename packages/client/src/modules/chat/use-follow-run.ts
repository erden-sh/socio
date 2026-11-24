import type { Message } from '@ag-ui/core';
import { useCallback, useEffect, useRef, useState } from 'react';

interface FollowAgent {
    messages: Message[];
    setMessages(messages: Message[]): void;
}
interface FollowCopilot<A> {
    connectAgent(options: { agent: A }): Promise<unknown>;
}

/**
 * Whether the server's transcript (`/conversations/:id/transcript`, its
 * messages' ids) has a message this tab doesn't show. Messages are only
 * ever added to a conversation, so a new id is a change.
 */
export function hasUnseenMessages(shown: readonly Message[], stored: readonly { id: string }[]) {
    const ids = new Set(shown.map((message) => message.id));
    return stored.some((message) => !ids.has(message.id));
}

/**
 * Follows a turn the server runs in this conversation: the Dot carrying on
 * after an approval (CB-58), whose approval card reports it with the
 * continuation's id. The server owns the turn; the chat only reconnects,
 * which replays the conversation and then streams the run in progress, so
 * it shows live like a reply. Each continuation is followed once, after
 * the chat's own turn if one is running. While the replay catches up,
 * `held` is the transcript as it was, so it doesn't flash empty; if the
 * connection fails, that transcript is put back.
 *
 * `catchUp` is for another tab's turn in the same chat (a
 * `conversation:<id>` note, CB-74): when `stored` (the server's message
 * ids) has one this tab hasn't, it reconnects the same way, quietly. It
 * never calls `onDone`, which tells the other tabs, so a catch-up never
 * makes a note of its own: no ping-pong between tabs.
 */
export function useFollowRun<A extends FollowAgent>({
    agent,
    copilotkit,
    running,
    setRunning,
    onDone,
    onError,
    stored,
}: {
    agent: A;
    copilotkit: FollowCopilot<A>;
    running: boolean;
    setRunning: (running: boolean) => void;
    onDone: () => void;
    onError: (error: unknown) => void;
    /** The ids of the messages the server has for this conversation. */
    stored?: () => Promise<readonly { id: string }[]>;
}) {
    const [held, setHeld] = useState<Message[] | null>(null);
    // A catch-up in progress: the composer waits, the Dot isn't working.
    const [syncing, setSyncing] = useState(false);
    const followed = useRef(new Set<string>());
    const queued = useRef(false);
    const catchUpQueued = useRef(false);
    const busy = useRef(running || syncing);
    busy.current = running || syncing;
    const latest = useRef({
        agent,
        copilotkit,
        setRunning,
        onDone,
        onError,
        stored,
    });
    latest.current = { agent, copilotkit, setRunning, onDone, onError, stored };
    const connect = useCallback(async (quiet: boolean) => {
        const { agent, copilotkit, setRunning, onDone, onError } = latest.current;
        busy.current = true;
        if (quiet) {
            setSyncing(true);
        } else {
            setRunning(true);
        }
        const before = agent.messages;
        setHeld(before);
        try {
            // The connection replays the whole conversation: start from none.
            agent.setMessages([]);
            await copilotkit.connectAgent({ agent });
            if (!quiet) {
                onDone();
            }
        } catch (error) {
            // A replay cut short leaves a partial transcript: keep the one shown.
            if (agent.messages.length < before.length) {
                agent.setMessages(before);
            }
            onError(error);
        } finally {
            setHeld(null);
            busy.current = false;
            if (quiet) {
                setSyncing(false);
            } else {
                setRunning(false);
            }
        }
    }, []);
    const onContinuation = useCallback(
        (id: string) => {
            if (followed.current.has(id)) {
                return;
            }
            followed.current.add(id);
            if (busy.current) {
                queued.current = true;
            } else {
                void connect(false);
            }
        },
        [connect],
    );
    const catchUp = useCallback(async () => {
        const { stored } = latest.current;
        if (!stored) {
            return;
        }
        // This tab's own turn (or a follow) first: its end checks again.
        if (busy.current) {
            catchUpQueued.current = true;
            return;
        }
        let ids: readonly { id: string }[];
        try {
            ids = await stored();
        } catch {
            // The next note, or the tab coming back, asks again.
            return;
        }
        if (!hasUnseenMessages(latest.current.agent.messages, ids)) {
            return;
        }
        if (busy.current) {
            catchUpQueued.current = true;
        } else {
            await connect(true);
        }
    }, [connect]);
    useEffect(() => {
        if (running || syncing) {
            return;
        }
        if (queued.current) {
            queued.current = false;
            catchUpQueued.current = false;
            void connect(false);
        } else if (catchUpQueued.current) {
            catchUpQueued.current = false;
            void catchUp();
        }
    }, [running, syncing, connect, catchUp]);
    return {
        onContinuation,
        catchUp,
        /** A catch-up is replaying the conversation: hold the composer. */
        syncing,
        /** The messages to show: the held transcript until the replay has it. */
        messages: held && agent.messages.length < held.length ? held : agent.messages,
    };
}
