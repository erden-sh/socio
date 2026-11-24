import { useCallback, useEffect, useRef, useState } from 'react';

import type { QueuedMessage, SteeringView } from '@socio/shared/chat/steering';
import type { AttachmentRef } from '@socio/shared/media-types';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';

/** The queue as shown: before the first read, its limit is not known. */
type Shown = Omit<SteeringView, 'limit'> & { limit?: number };
const empty: Shown = { messages: [] };
/** The view's own fields: a change's answer carries its message too. */
const shownOf = ({ messages, limit, turn, running }: SteeringView): Shown => ({
    messages,
    limit,
    turn,
    running,
});

export interface SteeringApi {
    /** The person's messages waiting for the turn, oldest first. */
    queued: QueuedMessage[];
    /** The most that may wait (CB-170); undefined until read. */
    limit?: number;
    /** The turn the server started with them, while it runs (CB-170). */
    turn?: string;
    /** A turn ran in the conversation when the server last said (CB-223). */
    running: boolean;
    /**
     * Queues `text` for the running turn, with the uploaded `attachments`
     * (CB-223); the server's queue after it.
     */
    add(text: string, attachments?: readonly AttachmentRef[]): Promise<void>;
    /**
     * Saves new text, and (given) the attachments it keeps (CB-223); throws
     * (and reads the queue again) once delivered.
     */
    edit(id: string, text: string, attachments?: readonly AttachmentRef[]): Promise<void>;
    /** Takes it back; throws (and reads the queue again) once delivered. */
    cancel(id: string): Promise<void>;
}

/**
 * A chat's steering queue (CB-151): what the person sent while the Dot's
 * turn ran, kept on the server until a turn takes it, so a reload or a
 * reconnect shows it still waiting. Read when the chat opens, when a turn
 * starts or ends, and on another tab's note; every change answers with the
 * queue as it is now, its limit, and the turn the server started with it.
 */
export function useSteering(threadId: string, running: boolean): SteeringApi {
    const [view, setView] = useState<Shown>(empty);
    const path = `/conversations/${threadId}/steering`;
    // The latest read wins: an older answer never undoes a newer one.
    const reads = useRef(0);
    const show = useCallback((next: Shown) => {
        reads.current += 1;
        setView(next);
    }, []);
    const load = useCallback(async () => {
        const read = (reads.current += 1);
        try {
            const next = shownOf(await api<SteeringView>(path));
            if (read === reads.current) {
                setView(next);
            }
        } catch {
            // The next turn's start or end reads it again.
        }
    }, [path]);
    useEffect(() => setView(empty), [path]);
    useEffect(() => {
        void load();
    }, [load, running]);
    useLiveTopic(`conversation:${threadId}`, () => void load());
    const changed = async <T extends SteeringView>(request: Promise<T>) => {
        try {
            show(shownOf(await request));
        } catch (error) {
            void load();
            throw error;
        }
    };
    return {
        queued: view.messages,
        limit: view.limit,
        turn: view.turn,
        running: !!view.running,
        add: (text, attachments = []) =>
            changed(
                api<SteeringView>(path, 'POST', {
                    text,
                    ...(attachments.length && {
                        attachments: attachments.map(({ id }) => ({ id })),
                    }),
                }),
            ),
        edit: (id, text, attachments) =>
            changed(
                api<SteeringView>(`${path}/${encodeURIComponent(id)}`, 'PATCH', {
                    text,
                    ...(attachments && {
                        attachments: attachments.map(({ id }) => ({ id })),
                    }),
                }),
            ),
        cancel: (id) => changed(api<SteeringView>(`${path}/${encodeURIComponent(id)}`, 'DELETE')),
    };
}
