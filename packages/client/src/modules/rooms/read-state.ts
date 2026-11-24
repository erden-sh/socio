import { useEffect, useRef } from 'react';

import type { RoomReadState } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import { api } from '../../lib/api';

/** `POST /api/rooms/:id/read` (CB-215): the reader saw the room. */
export const markRoomRead = (roomId: string) =>
    api<RoomReadState>(`/rooms/${encodeURIComponent(roomId)}/read`, 'POST', {});

/**
 * Clears the room's unread count while the person looks at it (CB-215):
 * whenever the shell says something is new there (`thread.unread`, read
 * on every poll) and the tab is in view, the server moves their read
 * cursor to the room's last finished turn, on every device; a tab out of
 * view leaves it for when it comes back. A failed mark is tried again at
 * the next change. `onRead` refreshes the shell, so the sidebar follows.
 */
export function useMarkRoomRead(thread: Pick<Conversation, 'id' | 'kind' | 'unread'>, onRead?: () => unknown) {
    const unread = thread.kind === 'room' ? (thread.unread ?? 0) : 0;
    const marking = useRef(false);
    const latest = useRef(onRead);
    useEffect(() => {
        latest.current = onRead;
    });
    useEffect(() => {
        if (!unread) {
            return;
        }
        const mark = () => {
            if (marking.current || document.hidden) {
                return;
            }
            marking.current = true;
            markRoomRead(thread.id)
                .then(() => latest.current?.())
                .catch(() => undefined)
                .finally(() => {
                    marking.current = false;
                });
        };
        mark();
        const back = () => {
            if (!document.hidden) {
                mark();
            }
        };
        document.addEventListener('visibilitychange', back);
        return () => document.removeEventListener('visibilitychange', back);
    }, [thread.id, unread]);
}
