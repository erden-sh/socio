import { characterOf, type LocalId } from '@socio/shared/mascot';
import { initials, toneIndex } from '@socio/shared/rooms/room-speakers';
import { roomEligibleSocio, type RoomPerson } from '@socio/shared/rooms/rooms';
import { type Dot, MAX_CHAT_TITLE, type State } from '@socio/shared/types';

import type { MenuAction } from '../chat/long-press';
import { type PersonMark, PERSON_TONES } from '../chat/room-people';
import type { RoomCreateBlock, RoomCreateOutcome, RoomPeopleOutcome } from '../sync/room-create';

import { roomsOn } from './chat-list';
import { defaultSocioId, NEW_CHAT } from './first-run';

// New room (CB-470): the web's create dialog (packages/client's
// CreateRoomDialog) on a phone, the `NewRoom` page sheet from the Chats tab's
// compose menu and Home's Rooms. The owner's feedback reversed the earlier
// plan for making a room: a name, then the socios (company socios only, the first
// one leads) and the people to invite, several of each, each list a native
// sheet with search, the chosen ones as chips on the form; then Create, online
// only (src/sync/room-create.ts). Every other room setting stays the web's. No
// React Native, so tests/shell runs it under Node.

export const NEW_ROOM_TITLE = 'New room';
/** The web dialog's line under its title. */
export const NEW_ROOM_INTRO =
    'A room is one conversation for several people and company socios. Each message runs as the person who sent it; nobody’s private memories or data are shared.';
export const ROOM_NAME_LABEL = 'Name';
export const ROOM_NAME_PLACEHOLDER = 'Launch planning';
export const ROOM_NAME_MAX = MAX_CHAT_TITLE;
export const CREATE_ROOM = 'Create';
export const SOCIOS_LABEL = 'Socios';
export const PEOPLE_LABEL = 'People';
export const ADD_SOCIOS = 'Add socios';
export const ADD_PEOPLE = 'Add people';
export const SEARCH_SOCIOS = 'Search socios';
export const SEARCH_PEOPLE = 'Search people';
export const PICKER_DONE = 'Done';
/** The web's hints, in a phone's words: who leads, and that further socios wait for an admin. */
export const SOCIOS_HINT =
    'Company socios only. The first one leads; each one more starts as a request a workspace admin approves.';
export const NO_COMPANY_SOCIO = 'There is no company socio yet: ask an admin to add one.';
export const PEOPLE_HINT = 'You are a member and admin already. People you add get an invite to accept.';
export const LEAD = 'lead';

/** The Chats tab's compose menu (CB-470): New chat with the default socio, and New room while rooms are on. */
export const NEW_CHAT_ITEM: MenuAction = { name: 'new-chat', label: NEW_CHAT, icon: 'square.and.pencil' };
export const NEW_ROOM_ITEM: MenuAction = { name: 'new-room', label: NEW_ROOM_TITLE, icon: 'person.3' };
export const COMPOSE_LABEL = 'Compose';

export function composeMenu(input: { canChat: boolean; state: Pick<State, 'settings'> | null }): MenuAction[] {
    return [...(input.canChat ? [NEW_CHAT_ITEM] : []), ...(roomsOn(input.state) ? [NEW_ROOM_ITEM] : [])];
}

/** One choice in a picker, or a chip on the form. */
export interface RoomChoice {
    readonly id: string;
    readonly name: string;
    /** A socio's Local, or null for a person. */
    readonly character: LocalId | null;
    /** A person's initials in their tone, or null for a socio. */
    readonly person: PersonMark | null;
}

/** The socios a room may have: the workspace's company socios, not archived (shared's rule), in its order. */
export function roomSocios(dots: readonly Dot[]): RoomChoice[] {
    return dots
        .filter((dot) => roomEligibleSocio(dot))
        .map((dot) => ({ id: dot.id, name: dot.name, character: characterOf(dot), person: null }));
}

/** The people as the picker shows them, by the server's order (by name). */
export function roomPeopleChoices(people: readonly RoomPerson[]): RoomChoice[] {
    return people.map((person) => ({
        id: person.userId,
        name: person.name,
        character: null,
        person: { initials: initials(person.name), tone: PERSON_TONES[toneIndex(person.name, PERSON_TONES.length)]! },
    }));
}

/** The socio the form opens with, as the web's dialog: the default socio when it may lead a room, else the first that may. */
export function startSocios(dots: readonly Dot[], state: Pick<State, 'settings' | 'tasks'> | null): string[] {
    const socios = roomSocios(dots);
    const preferred = defaultSocioId(dots, state);
    const first = socios.find((socio) => socio.id === preferred) ?? socios[0];
    return first === undefined ? [] : [first.id];
}

/** Adds `id` at the end, or takes it out. */
export const toggleChoice = (chosen: readonly string[], id: string): string[] =>
    chosen.includes(id) ? chosen.filter((known) => known !== id) : [...chosen, id];

/** The chosen ones that are still there, in the order chosen. */
export function chosenChoices(choices: readonly RoomChoice[], chosen: readonly string[]): RoomChoice[] {
    const byId = new Map(choices.map((choice) => [choice.id, choice]));
    return chosen.flatMap((id) => {
        const choice = byId.get(id);
        return choice === undefined ? [] : [choice];
    });
}

const fold = (text: string) =>
    text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

/** A picker's row: its choice, whether it is chosen, and what a screen reader says. */
export interface PickerRow extends RoomChoice {
    readonly checked: boolean;
    readonly lead: boolean;
    readonly accessibilityLabel: string;
}

/** The picker's rows matching `query` (any part of the name, ignoring case and accents). */
export function pickerRows(
    choices: readonly RoomChoice[],
    chosen: readonly string[],
    query: string,
    leads = false,
): PickerRow[] {
    const wanted = fold(query);
    return choices
        .filter((choice) => wanted === '' || fold(choice.name).includes(wanted))
        .map((choice) => {
            const lead = leads && chosen[0] === choice.id;
            return {
                ...choice,
                checked: chosen.includes(choice.id),
                lead,
                accessibilityLabel: lead ? `${choice.name}, ${LEAD}` : choice.name,
            };
        });
}

/** A chip on the form: its name, the lead said, and its remove button's label. */
export interface RoomChip extends RoomChoice {
    readonly lead: boolean;
    readonly removeLabel: string;
}

export function roomChips(choices: readonly RoomChoice[], chosen: readonly string[], leads = false): RoomChip[] {
    return chosenChoices(choices, chosen).map((choice, index) => ({
        ...choice,
        lead: leads && index === 0,
        removeLabel: `Remove ${choice.name}`,
    }));
}

/** The people picker's line when it has no rows. */
export function peopleNote(people: RoomPeopleOutcome | null, shown: number, query: string): string | null {
    if (people === null) {
        return 'Loading people…';
    }
    if (people.kind === 'blocked') {
        return ROOM_NEEDS_CONNECTION;
    }
    if (people.kind !== 'done') {
        return 'Couldn’t load the people. Close this and try again.';
    }
    if (shown > 0) {
        return null;
    }
    return people.people.length === 0 || query.trim() === '' ? 'Nobody else can be invited yet.' : 'No one matches.';
}

/** The socios picker's line when it has no rows. */
export const sociosNote = (all: number, shown: number): string | null =>
    all === 0 ? NO_COMPANY_SOCIO : shown === 0 ? 'No socio matches.' : null;

/** Whether Create can go: a name, a socio to lead, nothing in flight, and a connection. */
export const canSubmitRoom = (
    title: string,
    socioIds: readonly string[],
    busy: boolean,
    blocked: RoomCreateBlock | null,
): boolean => title.trim() !== '' && socioIds.length > 0 && !busy && blocked === null;

/** Offline: the workspace makes rooms (its id, who may be in it), so it can't wait in the outbox. */
export const ROOM_NEEDS_CONNECTION = 'Needs a connection: the workspace makes new rooms.';

export const ROOM_BLOCK_COPY: Readonly<Record<RoomCreateBlock, string>> = {
    offline: ROOM_NEEDS_CONNECTION,
    away: ROOM_NEEDS_CONNECTION,
    'sign-in': 'Sign in again to do this',
    update: 'Update Socio to do this',
};

export const ROOM_NO_ANSWER = 'No answer from the workspace. Check your chats before you try again.';
export const ROOM_CREATE_FAILED = 'Couldn’t create the room. Try again.';

/** A refusal's words, by `code` (the server's `RoomRefusal` and storage refusals) or status, never its text. */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
    invalid: `Choose a socio and name the room in 1 to ${MAX_CHAT_TITLE} characters.`,
    invalid_title: `Name the room in 1 to ${MAX_CHAT_TITLE} characters.`,
    rooms_off: 'Rooms are off in this workspace.',
    personal_socio: 'A room takes company socios only. Choose another socio.',
    not_found: 'One of those socios isn’t there any more. Choose again.',
    not_eligible: 'One of those people can’t be invited. Choose again.',
    'http-401': 'Sign in again to do this',
    'http-403': 'You can’t create rooms in this workspace.',
    'http-429': 'Too many tries. Wait a moment.',
};

/** What an outcome says on the form, or null when it worked (or another create is going). */
export function roomCreateCopy(outcome: RoomCreateOutcome): string | null {
    switch (outcome.kind) {
        case 'done':
        case 'busy':
            return null;
        case 'blocked':
            return ROOM_BLOCK_COPY[outcome.reason];
        case 'no-answer':
            return ROOM_NO_ANSWER;
        case 'refused':
            return REFUSAL_COPY[outcome.reason] ?? ROOM_CREATE_FAILED;
    }
}

/**
 * How long Create waits, once the chat list holds the room, before the sheet goes and the room
 * opens. On Android the Chats tab's list under the sheet takes the new row as the list fills, and
 * the sheet's removal in the same moment stopped the app (Fabric's `addViewAt`: a view that still
 * had its parent, CB-470); 300 ms lets the row mount first. iOS goes at once.
 */
export const ROOM_OPEN_DELAY_MS = 300;
export const roomOpenDelay = (os: string): number => (os === 'android' ? ROOM_OPEN_DELAY_MS : 0);

/** Leaving New room with something chosen asks first (CB-421): Discard closes it, Cancel stays. */
export const DISCARD_ROOM_QUESTION = 'Discard this new room?';
export const DISCARD_ROOM = { name: 'discard', label: 'Discard', destructive: true } as const;

/** Whether leaving asks: a name typed, someone added, or the socios changed from the ones it opened with. */
export function newRoomAsks(
    title: string,
    socioIds: readonly string[],
    userIds: readonly string[],
    startIds: readonly string[],
): boolean {
    return (
        title.trim() !== '' ||
        userIds.length > 0 ||
        socioIds.length !== startIds.length ||
        socioIds.some((id, index) => startIds[index] !== id)
    );
}
