import { useCallback, useEffect, useRef, useState } from 'react';

import type { OthersQueuedMessage, SteeringView } from '@socio/shared/chat/steering';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';

import { ROOM_POLL_MS } from './feed';

/**
 * Everyone else's queued messages in a room, for its admins (CB-215): the
 * queue's `others`, read when the room opens, every few seconds while the
 * tab is in view, and at once on another tab's note about it. Nothing for
 * anyone else (the server sends members only their own). `cancel` cancels
 * one (never edits it) and reads again; its refusal is thrown, for the
 * row to say.
 */
export function useOthersQueued(threadId: string, admin: boolean) {
    const [others, setOthers] = useState<OthersQueuedMessage[]>([]);
    const reads = useRef(0);
    const base = `/conversations/${encodeURIComponent(threadId)}/steering`;
    const load = useCallback(async () => {
        const read = (reads.current += 1);
        if (!admin) {
            setOthers([]);
            return;
        }
        try {
            const view = await api<SteeringView>(base);
            if (read === reads.current) {
                setOthers(view.others ?? []);
            }
        } catch {
            // The room's feed says what failed; this keeps what it had.
        }
    }, [base, admin]);
    const canPoll = useLiveTopic(admin ? `conversation:${threadId}` : undefined, () => void load());
    useEffect(() => {
        void load();
        if (!admin) {
            return;
        }
        const timer = setInterval(() => {
            if (document.hidden) {
                return;
            }
            if (canPoll()) {
                void load();
            }
        }, ROOM_POLL_MS.idle);
        return () => clearInterval(timer);
    }, [load, canPoll, admin]);
    return {
        others,
        refresh: () => void load(),
        cancel: async (id: string) => {
            await api(`${base}/${encodeURIComponent(id)}`, 'DELETE');
            await load();
        },
    };
}
