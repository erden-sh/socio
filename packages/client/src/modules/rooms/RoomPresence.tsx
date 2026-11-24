import { useEffect, useRef, useState } from 'react';

import { ROOM_PRESENCE_POLL_MS, type RoomPresenceView } from '@socio/shared/rooms/room-notices';
import { presenceLine } from '@socio/shared/rooms/room-view';

import { api, ApiError } from '../../lib/api';

import { PersonAvatar } from './RoomSpeaker';

/** Shown in the header before "+N". */
const SHOWN = 3;

/**
 * Who else of the room is looking at it now (CB-216,
 * `GET /api/rooms/:id/presence`): read when it opens and every
 * `ROOM_PRESENCE_POLL_MS` while this tab is in view. The heartbeat is the
 * shell's own: each tab's `/api/state` poll says which page it is on while
 * in use (presence.ts), so looking costs no extra request; leaving,
 * hiding the tab or losing the connection drops a person within seconds.
 */
export function useRoomPresence(roomId: string, enabled: boolean) {
    const [people, setPeople] = useState<RoomPresenceView['people']>([]);
    const reads = useRef(0);
    useEffect(() => {
        setPeople([]);
        if (!enabled) {
            return;
        }
        let stopped = false;
        const load = async () => {
            if (document.hidden) {
                return;
            }
            const read = (reads.current += 1);
            try {
                const view = await api<RoomPresenceView>(`/rooms/${encodeURIComponent(roomId)}/presence`);
                if (!stopped && read === reads.current) {
                    setPeople(Array.isArray(view.people) ? view.people : []);
                }
            } catch (error) {
                // Out of the room: nobody to show, and nothing to ask again.
                if (!stopped && error instanceof ApiError && error.status === 404) {
                    stopped = true;
                    setPeople([]);
                }
            }
        };
        void load();
        const timer = setInterval(() => {
            if (!stopped) {
                void load();
            }
        }, ROOM_PRESENCE_POLL_MS);
        const back = () => {
            if (!document.hidden && !stopped) {
                void load();
            }
        };
        document.addEventListener('visibilitychange', back);
        return () => {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', back);
        };
    }, [roomId, enabled]);
    return people;
}

/**
 * In the room's header (CB-216): the avatars of the others looking at it
 * now, with their names said in words ("Ana and Bo are here"). Nothing
 * while nobody else is. Only the room's members are ever listed, and
 * never anyone who hides their presence (Account → Notifications).
 * Read with the header, not announced (CB-219): people come and go as
 * their tabs idle, and a live region would interrupt the reader with
 * each of them.
 */
export function RoomPresence({
    roomId,
    enabled,
    tones,
    labels,
}: {
    roomId: string;
    enabled: boolean;
    /** Each person's avatar tone in the room (`personTones`). */
    tones?: ReadonlyMap<string, string>;
    /** Same-named people's names in words (`personLabels`). */
    labels?: ReadonlyMap<string, string>;
}) {
    const people = useRoomPresence(roomId, enabled);
    if (!people.length) {
        return null;
    }
    const line = `${presenceLine(people.map((person) => labels?.get(person.userId) ?? person.name))} ${people.length === 1 ? 'is' : 'are'} here`;
    return (
        <div data-slot="room-presence" title={line} className="flex shrink-0 items-center">
            <span className="sr-only">{line}</span>
            <span aria-hidden className="flex items-center -space-x-1.5">
                {people.slice(0, SHOWN).map((person) => (
                    <PersonAvatar
                        key={person.userId}
                        name={person.name}
                        tone={tones?.get(person.userId)}
                        className="size-6 ring-2 ring-background"
                    />
                ))}
            </span>
            {people.length > SHOWN && (
                <span aria-hidden className="ml-1 text-[11px] text-muted-foreground tabular-nums">
                    {`+${people.length - SHOWN}`}
                </span>
            )}
        </div>
    );
}
