import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { RoomPerson, RoomRole } from '@socio/shared/rooms/rooms';

import { useOnDemand } from '../../i18n/on-demand';

import { failure, roomsApi } from './api';
import { PersonAvatar } from './RoomSpeaker';
import { touchTarget } from './touch';

import { cn } from '@/lib/utils';

/**
 * The `/invite` slash command in the room composer (CB-285): a room admin
 * types `/invite` and the start of a name to list the people they may
 * invite (the same `GET /rooms/:id/invitable` the Members panel uses),
 * picks one, and the invite goes with the room's existing authorization
 * (`POST /rooms/:id/invites`, as a member). ↑ ↓ move, Enter or Tab picks,
 * Escape closes; a click picks too. The composer's draft is cleared once
 * the invite is sent. Non-admins get nothing: inviting is a room admin's
 * action, as in Members.
 */

/** `/invite` and the start of a name, or just `/invite `. */
const INVITE_QUERY = /^\/invite[ ]?([^\n]*)$/i;

/** The `@query` being typed after `/invite `, or undefined when it isn't. */
function inviteQuery(draft: string): string | undefined {
    if (!draft.startsWith('/invite')) {
        return undefined;
    }
    const match = INVITE_QUERY.exec(draft);
    return match ? match[1] : undefined;
}

/** The people whose name fits what is typed after `/invite `. */
function matchingInvitees(people: readonly RoomPerson[], query: string, limit = 8): RoomPerson[] {
    const wanted = query.trim().toLocaleLowerCase('en');
    return people
        .filter((person) => {
            const name = person.name.trim().toLocaleLowerCase('en');
            if (!name) {
                return false;
            }
            if (!wanted) {
                return true;
            }
            return name.startsWith(wanted) || name.split(' ').some((word) => word.startsWith(wanted));
        })
        .slice(0, limit);
}

/**
 * The room's `/invite` command. Spread `inputProps` on the text box, ask
 * `onKeyDown` first, render `menu` above the box and `status` (a polite
 * live region) anywhere. `admin` gates it: a member's composer shows
 * nothing. `onInvited` runs once an invite goes (to refresh the room).
 */
export function useRoomInviteCommand({
    draft,
    setDraft,
    roomId,
    admin,
    onInvited,
    tones,
    labels,
}: {
    draft: string;
    setDraft: (value: string) => void;
    box: RefObject<HTMLTextAreaElement | null>;
    roomId: string;
    /** The reader is a room admin: only they may invite. */
    admin: boolean;
    /** After an invite is sent, to refresh the room's members. */
    onInvited: () => void;
    /** Each person's avatar tone, as the people picker shows it. */
    tones?: ReadonlyMap<string, string>;
    /** Two people with one name, in words (`personLabels`). */
    labels?: ReadonlyMap<string, string>;
}) {
    const { t } = useTranslation(['rooms']);
    // Its words are the room's (rooms), which RoomChat waits for.
    const ready = useOnDemand(['rooms']);
    const listId = useId();
    const [people, setPeople] = useState<RoomPerson[]>();
    const [active, setActive] = useState(0);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');
    const query = admin ? inviteQuery(draft) : undefined;
    const members = `${roomId}`;

    // Read the people the admin may invite, again whenever the room's
    // membership changes (someone joined, an invite went), as Members does.
    useEffect(() => {
        if (!admin) {
            return;
        }
        const controller = new AbortController();
        roomsApi
            .invitable(roomId, controller.signal)
            .then((next) => {
                setPeople(next);
                setProblem('');
            })
            .catch((error) => {
                if (!controller.signal.aborted) {
                    setProblem(failure(error, t('rooms:invite-command.list-failed')));
                }
            });
        return () => controller.abort();
    }, [admin, roomId, members, t]);

    // `query === ''` is `/invite` with nothing after it: show everyone invitable.
    const candidates = query !== undefined ? matchingInvitees(people ?? [], query) : [];
    const open = ready && query !== undefined && candidates.length > 0;
    const current = Math.min(active, Math.max(candidates.length - 1, 0));

    const send = async (person: RoomPerson, role: RoomRole = 'member') => {
        setBusy(true);
        setProblem('');
        try {
            await roomsApi.invite(roomId, person.userId, role);
            toast.message(t('rooms:invite-command.invited', { name: person.name }));
            setDraft('');
            onInvited();
        } catch (error) {
            setProblem(failure(error, t('rooms:invite-command.failed')));
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        setActive(0);
    }, [query]);

    /** Handles the list's keys while it is open; true when it took the key. */
    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!open || event.nativeEvent.isComposing || busy) {
            return false;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((current + step + candidates.length) % candidates.length);
            return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            void send(candidates[current]!);
            return true;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            setDraft('');
            return true;
        }
        return false;
    };

    const optionId = (index: number) => `${listId}-option-${index}`;
    const list = open ? (
        <ul
            id={listId}
            role="listbox"
            aria-label={t('rooms:invite-command.list')}
            data-slot="room-invite-menu"
            className="mb-1 max-h-48 overflow-y-auto rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md keyboard-short:max-h-28"
        >
            {candidates.map((person, index) => (
                <li
                    key={person.userId}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === current}
                    data-invite-option={person.userId}
                    className={cn(
                        'flex min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-1',
                        touchTarget,
                        index === current && 'bg-accent text-accent-foreground ring-2 ring-ring ring-inset',
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void send(person)}
                >
                    <PersonAvatar name={person.name} tone={tones?.get(person.userId)} />
                    <span className="min-w-0 truncate">{labels?.get(person.userId) ?? person.name}</span>
                </li>
            ))}
        </ul>
    ) : null;

    const said = open ? t('rooms:invite-command.count', { count: candidates.length }) : '';
    const status = (
        <span role="status" className="sr-only" data-slot="room-invite-status">
            {said}
        </span>
    );

    return {
        onKeyDown,
        menu: (
            <div data-slot="room-invite-anchor" className="relative">
                {list}
                {ready && problem && (
                    <p
                        role="alert"
                        data-slot="room-invite-problem"
                        className="mb-1 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
                    >
                        {problem}
                    </p>
                )}
            </div>
        ),
        status,
        inputProps: {
            'aria-autocomplete': 'list' as const,
            'aria-haspopup': 'listbox' as const,
            'aria-controls': open ? listId : undefined,
            'aria-activedescendant': open ? optionId(current) : undefined,
        },
        /** Whether `/invite` is in the draft and waiting (to suppress a send). */
        active: query !== undefined,
        busy,
    };
}
