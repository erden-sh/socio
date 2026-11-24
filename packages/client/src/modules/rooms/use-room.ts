import { useCallback, useEffect, useRef, useState } from 'react';

import type { RoomInvite, RoomView } from '@socio/shared/rooms/rooms';

import { useLiveTopic } from '../../lib/change-channel';
import { useShell } from '../../shell/shell-context';

import { roomsApi } from './api';

/** How often an open room's people and socios are read again. */
export const ROOM_VIEW_POLL_MS = 10_000;

/**
 * A room as its members see it (`GET /api/rooms/:id`): its people, socios,
 * the reader's role and the switch. Read when it opens, whenever the
 * shell's workspace changes (a change to the reader's own membership
 * bumps their chat list), on another tab's note about it, and every
 * `ROOM_VIEW_POLL_MS` for other people's. `update` shows a change's
 * answer at once.
 */
export function useRoom(roomId: string | undefined) {
    const { workspace } = useShell();
    const [room, setRoom] = useState<RoomView>();
    const [error, setError] = useState('');
    const reads = useRef(0);
    const load = useCallback(async () => {
        if (!roomId) {
            return;
        }
        const read = (reads.current += 1);
        try {
            const next = await roomsApi.view(roomId);
            if (read === reads.current) {
                setRoom(next);
                setError('');
            }
        } catch (cause) {
            if (read === reads.current) {
                setError(cause instanceof Error ? cause.message : 'Could not load the room.');
            }
        }
    }, [roomId]);
    useEffect(() => {
        setRoom(undefined);
        setError('');
    }, [roomId]);
    useEffect(() => {
        void load();
    }, [load, workspace]);
    // Someone else joining or leaving changes their own chat list, not the
    // reader's: a slow poll catches it (CB-212-server's stream will say).
    const canPoll = useLiveTopic(roomId && `conversation:${roomId}`, () => void load());
    useEffect(() => {
        const timer = setInterval(() => {
            if (!document.hidden && canPoll()) {
                void load();
            }
        }, ROOM_VIEW_POLL_MS);
        return () => clearInterval(timer);
    }, [load, canPoll]);
    const update = useCallback((next: RoomView) => {
        reads.current += 1;
        setRoom(next);
    }, []);
    return { room, error, reload: load, update };
}

/**
 * The reader's room invitations (`GET /api/rooms/invites`), while Rooms
 * are on: read again whenever the shell's workspace changes (an invite
 * bumps the invitee's chat list; another tab's note re-reads it).
 */
export function useRoomInvites(
    on: boolean,
    /** The shell's workspace: a new one is a cue to read again. */
    workspace: unknown,
) {
    const [invites, setInvites] = useState<RoomInvite[]>([]);
    const reads = useRef(0);
    const load = useCallback(async () => {
        const read = (reads.current += 1);
        if (!on) {
            setInvites([]);
            return;
        }
        try {
            const next = await roomsApi.invites();
            if (read === reads.current) {
                setInvites(next);
            }
        } catch {
            // The next workspace change reads them again.
        }
    }, [on]);
    useEffect(() => {
        void load();
    }, [load, workspace]);
    return { invites, reload: load };
}
