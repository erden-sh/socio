import { characterFor, characterOf, type LocalId } from '@socio/shared/mascot';
import { initials, personLabels, personTones, toneIndex } from '@socio/shared/rooms/room-speakers';
import { answeringSocios, presenceLine, roomStatus } from '@socio/shared/rooms/room-view';
import type { RoomMemberView, RoomView } from '@socio/shared/rooms/rooms';
import type { Dot } from '@socio/shared/types';

import type { ToneName } from '../theme/theme';

// Who is in a room, as its screen shows them: the
// people's avatars (initials on a squircle in a tone), the header's lines and
// the read-only Members sheet. The rules are shared's (room-speakers.ts,
// room-view.ts); the tones are the app's own, from theme.json's module tones,
// the same six hues as the web's class table (RoomSpeaker.tsx). Never by color
// alone: a name is always beside an avatar. No React Native here: tests/chat
// runs it under Node.

/** People's avatar tones, indexed by shared's `toneIndex`/`personTones`. */
export const PERSON_TONES: readonly ToneName[] = ['sky', 'amber', 'violet', 'emerald', 'rose', 'slate'];

/** A person's avatar: their initials in their tone. */
export interface PersonMark {
    readonly initials: string;
    readonly tone: ToneName;
}

/** How the room tells its people apart: each one's tone and, for same-named members, a numbered name. */
export interface RoomPeople {
    /** A person's avatar by id, their name's tone when the room doesn't know them. */
    mark(id: string | undefined, name: string): PersonMark;
    /** The name the room shows: "Ana Lima · 2" for same-named members, else their current name, else `stamped`. */
    name(id: string | undefined, stamped: string): string;
}

/** Each person's tone and shown name in a room, from its view and the authors its messages carry. */
export function roomPeople(
    view: Pick<RoomView, 'members'> | null,
    authors: Iterable<{ id?: string; name: string }> = [],
): RoomPeople {
    const members = view?.members ?? [];
    const tones = personTones(
        [...members.map((member) => ({ id: member.userId, name: member.name })), ...authors],
        PERSON_TONES.length,
    );
    const labels = personLabels(members);
    const current = new Map(members.map((member) => [member.userId, member.name]));
    return {
        mark(id, name) {
            const index = (id === undefined ? undefined : tones.get(id)) ?? toneIndex(name, PERSON_TONES.length);
            return { initials: initials(name), tone: PERSON_TONES[index]! };
        },
        name(id, stamped) {
            if (id === undefined) {
                return stamped;
            }
            return labels.get(id) ?? current.get(id) ?? stamped;
        },
    };
}

/** "Ben is here", "Ana and Bo are here", "Ana, Bo and 2 others are here"; empty with nobody. */
export function presenceSaid(names: readonly string[]): string {
    if (names.length === 0) {
        return '';
    }
    return `${presenceLine(names)} ${names.length === 1 ? 'is' : 'are'} here`;
}

/** A socio's mark in the header's stack. */
export interface SocioMark {
    readonly dotId: string;
    readonly name: string;
    readonly character: LocalId;
}

/** The room's header: its title, its status line, its socios' stack and who else is looking. */
export interface RoomHeaderView {
    readonly title: string;
    /** shared's `roomStatus`: "Room · 3 people · Sebas answers · you’re an admin". */
    readonly status: string;
    /** The answering socios, the lead first, at most `SOCIOS_SHOWN`. */
    readonly socios: readonly SocioMark[];
    /** How many more socios answer than the stack shows. */
    readonly moreSocios: number;
    /** The others looking at the room, with their avatars (hidden from screen readers). */
    readonly here: readonly (PersonMark & { readonly userId: string })[];
    /** "Ben is here", or empty. */
    readonly presence: string;
    /** What a screen reader hears for the whole header, once, as it reaches it: never announced. */
    readonly label: string;
}

/** Socios the header's stack shows (the web's SOCIO_STACK_SHOWN). */
export const SOCIOS_SHOWN = 3;

const socioMark = (dotId: string, name: string, dots: readonly Dot[]): SocioMark => {
    const dot = dots.find((known) => known.id === dotId);
    return { dotId, name, character: dot === undefined ? characterFor(dotId) : characterOf(dot) };
};

export interface RoomHeaderInput {
    readonly title: string;
    readonly view: RoomView | null;
    readonly dots: readonly Dot[];
    /** Settings → Socios paused (`settings.paused`). */
    readonly paused: boolean;
    /** Who else is looking (`rooms.presence(id)`), never the reader. */
    readonly present: readonly { readonly userId: string; readonly name: string }[];
    readonly me: string;
}

export function roomHeader(input: RoomHeaderInput): RoomHeaderView {
    const { view, dots } = input;
    const answering = answeringSocios(view?.socios ?? []);
    const people = roomPeople(view);
    const here = input.present.filter((person) => person.userId !== input.me);
    const names = here.map((person) => people.name(person.userId, person.name));
    const status = roomStatus(view ?? undefined, answering, input.paused);
    const presence = presenceSaid(names);
    return {
        title: input.title,
        status,
        socios: answering.slice(0, SOCIOS_SHOWN).map((socio) => socioMark(socio.dotId, socio.name, dots)),
        moreSocios: Math.max(0, answering.length - SOCIOS_SHOWN),
        here: here.map((person, at) => ({ userId: person.userId, ...people.mark(person.userId, names[at]!) })),
        presence,
        label: [input.title, status, presence].filter((part) => part !== '').join('. '),
    };
}

/** One row of the Members sheet. */
export interface MemberRow {
    readonly id: string;
    readonly name: string;
    /** "Admin", "Invited", "Lead", "Asked for", or null. */
    readonly detail: string | null;
    readonly you: boolean;
    readonly person: PersonMark | null;
    readonly socio: SocioMark | null;
}

/** The read-only Members sheet: the room's people, then its socios, and the web link for managing them. */
export interface MembersView {
    readonly people: readonly MemberRow[];
    readonly socios: readonly MemberRow[];
    /** Through `useOpenLink`, with its sign-in line: the room on the web, where it is managed. */
    readonly manage: { readonly label: string; readonly href: string };
}

export const MANAGE_ON_WEB = 'Manage on the web';

const memberDetail = (member: Pick<RoomMemberView, 'role' | 'status'>) =>
    member.status === 'invited' ? 'Invited' : member.role === 'admin' ? 'Admin' : null;

/** The Members sheet's rows: active people first (the reader as "You"), then those invited; the socios, lead first. */
export function membersView(roomId: string, view: RoomView, dots: readonly Dot[], me: string): MembersView {
    const people = roomPeople(view);
    const order = (member: RoomMemberView) => (member.status === 'active' ? 0 : 1);
    const members = [...view.members].sort((a, b) => order(a) - order(b));
    const socios = view.socios
        .filter((socio) => socio.status === 'active' || socio.status === 'requested')
        .sort((a, b) => Number(b.lead) - Number(a.lead));
    return {
        people: members.map((member) => {
            const you = member.userId === me;
            const name = people.name(member.userId, member.name);
            return {
                id: member.userId,
                name: you ? `${name} (you)` : name,
                detail: memberDetail(member),
                you,
                person: people.mark(member.userId, name),
                socio: null,
            };
        }),
        socios: socios.map((socio) => ({
            id: socio.dotId,
            name: socio.name,
            detail: socio.status === 'requested' ? 'Asked for' : socio.lead ? 'Lead' : null,
            you: false,
            person: null,
            socio: socioMark(socio.dotId, socio.name, dots),
        })),
        manage: { label: MANAGE_ON_WEB, href: `/chats/${encodeURIComponent(roomId)}` },
    };
}
