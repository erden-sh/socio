import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Dot } from '@socio/shared/types';

import { ROUTES } from '../../src/navigation/routes';
import { NEW_CHAT } from '../../src/shell/first-run';
import {
    canSubmitRoom,
    composeMenu,
    NEW_CHAT_ITEM,
    NEW_ROOM_INTRO,
    NEW_ROOM_ITEM,
    newRoomAsks,
    peopleNote,
    PEOPLE_HINT,
    pickerRows,
    ROOM_NAME_PLACEHOLDER,
    ROOM_NEEDS_CONNECTION,
    ROOM_NO_ANSWER,
    roomChips,
    roomCreateCopy,
    roomOpenDelay,
    ROOM_OPEN_DELAY_MS,
    roomPeopleChoices,
    roomSocios,
    sociosNote,
    startSocios,
    toggleChoice,
} from '../../src/shell/new-room';
import { NEW_ROOM, NEW_ROOM_HINT } from '../../src/shell/room-invites';

// New room (CB-470): the web's create dialog on a phone, reached from the Chats
// tab's compose menu and Home's Rooms. The screens draw on React Native, so
// they're read as source; the view model runs under Node, and its words are
// held to the web's dialog.

const app = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
const web = (file: string) => readFileSync(new URL(`../../../../packages/client/src/${file}`, import.meta.url), 'utf8');

const dot = (id: string, name: string, extra: Partial<Dot> = {}) =>
    ({ id, name, createdAt: 1, ownerId: null, archivedAt: null, ...extra }) as unknown as Dot;
const DOTS = [
    dot('d-sebas', 'Sebas'),
    dot('d-mine', 'Mine', { ownerId: 'u-ada' }),
    dot('d-old', 'Old', { archivedAt: 5 }),
    dot('d-manny', 'Manny', { createdAt: 2 }),
];
const ON = { settings: { rooms: { enabled: true } } } as never;
const OFF = { settings: { rooms: { enabled: false } } } as never;

describe('where New room is', () => {
    it('puts New chat and New room in the Chats tab’s compose menu, New room only while rooms are on', () => {
        expect(composeMenu({ canChat: true, state: ON })).toEqual([NEW_CHAT_ITEM, NEW_ROOM_ITEM]);
        expect(composeMenu({ canChat: true, state: OFF })).toEqual([NEW_CHAT_ITEM]);
        expect(composeMenu({ canChat: false, state: ON })).toEqual([NEW_ROOM_ITEM]);
        expect(composeMenu({ canChat: false, state: null })).toEqual([]);
        expect(NEW_CHAT_ITEM.label).toBe(NEW_CHAT);
        expect(NEW_ROOM_ITEM.label).toBe(NEW_ROOM);
        const chats = app('screens/chats.tsx');
        // The bar's Compose: a native menu (a UIMenu on iOS, Material's popup on Android) once it holds both.
        expect(chats).toContain(
            '...(composeItems.length > 1 ? { menu: { actions: composeItems, onAction: compose } } : {}),',
        );
        expect(chats).toContain("navigation.navigate('NewRoom');");
    });

    it('opens the app’s own form from Home’s Rooms, no longer the web', () => {
        expect(app('screens/home.tsx')).toContain("onNewRoom={() => navigation.navigate('NewRoom')}");
        expect(NEW_ROOM_HINT).not.toMatch(/browser/i);
        expect(app('shell/room-invites.ts')).not.toContain('NEW_ROOM_HREF');
    });

    it('is a compose page sheet in the root stack, with no path', () => {
        expect(ROUTES.NewRoom).toEqual({ gates: ['shell'], preset: ROUTES.NewSpace.preset });
        expect('linking' in ROUTES.NewRoom).toBe(false);
        expect(app('navigation/root-stack.tsx')).toContain('NewRoom: NewRoomScreen,');
    });
});

describe('the form', () => {
    it('has the web dialog’s words', () => {
        const dialog = web('modules/rooms/RoomDialogs.tsx');
        expect(dialog).toContain(`description="${NEW_ROOM_INTRO}"`);
        expect(dialog).toContain(`placeholder="${ROOM_NAME_PLACEHOLDER}"`);
        expect(dialog).toContain('const socios = shell.workspace.dots.filter((dot) => roomEligibleSocio(dot));');
        expect(dialog).toContain('You are a member and admin already. Invited people get an invite to accept.');
        expect(PEOPLE_HINT).toBe('You are a member and admin already. People you add get an invite to accept.');
    });

    it('offers company socios only, not archived, and opens with the default one', () => {
        expect(roomSocios(DOTS).map((socio) => socio.id)).toEqual(['d-sebas', 'd-manny']);
        expect(roomSocios(DOTS).every((socio) => socio.character !== null && socio.person === null)).toBe(true);
        expect(startSocios(DOTS, { settings: {}, tasks: [] } as never)).toEqual(['d-sebas']);
        expect(startSocios([dot('d-mine', 'Mine', { ownerId: 'u-ada' })], null)).toEqual([]);
        expect(sociosNote(0, 0)).toMatch(/no company socio/);
        expect(sociosNote(2, 0)).toBe('No socio matches.');
        expect(sociosNote(2, 1)).toBeNull();
    });

    it('chooses several of each, the first socio leading, and searches by any part of the name', () => {
        let chosen = toggleChoice([], 'd-manny');
        chosen = toggleChoice(chosen, 'd-sebas');
        expect(chosen).toEqual(['d-manny', 'd-sebas']);
        const socios = roomSocios(DOTS);
        expect(roomChips(socios, chosen, true).map((chip) => [chip.name, chip.lead, chip.removeLabel])).toEqual([
            ['Manny', true, 'Remove Manny'],
            ['Sebas', false, 'Remove Sebas'],
        ]);
        expect(toggleChoice(chosen, 'd-manny')).toEqual(['d-sebas']);
        const people = roomPeopleChoices([
            { userId: 'u-ben', name: 'Ben' },
            { userId: 'u-jose', name: 'José Ruiz' },
        ]);
        expect(people[1]!.person).toMatchObject({ initials: 'JR' });
        expect(pickerRows(people, ['u-jose'], 'jose').map((row) => [row.id, row.checked])).toEqual([['u-jose', true]]);
        expect(pickerRows(people, [], ' BE ').map((row) => row.id)).toEqual(['u-ben']);
        expect(pickerRows(socios, chosen, '', true)[1]).toMatchObject({
            id: 'd-manny',
            lead: true,
            accessibilityLabel: 'Manny, lead',
        });
        // A chosen one that went (a socio archived meanwhile) leaves the chips.
        expect(roomChips(socios, ['d-gone', 'd-sebas'], true).map((chip) => [chip.id, chip.lead])).toEqual([
            ['d-sebas', true],
        ]);
    });

    it('says why the people picker is empty', () => {
        expect(peopleNote(null, 0, '')).toBe('Loading people…');
        expect(peopleNote({ kind: 'blocked', reason: 'offline' }, 0, '')).toBe(ROOM_NEEDS_CONNECTION);
        expect(peopleNote({ kind: 'done', people: [] }, 0, '')).toBe('Nobody else can be invited yet.');
        expect(peopleNote({ kind: 'done', people: [{ userId: 'u', name: 'Ben' }] }, 0, 'zz')).toBe('No one matches.');
        expect(peopleNote({ kind: 'done', people: [{ userId: 'u', name: 'Ben' }] }, 1, '')).toBeNull();
        expect(peopleNote({ kind: 'no-answer' }, 0, '')).toMatch(/Couldn’t load/);
    });

    it('creates only with a name, a socio, nothing in flight and a connection', () => {
        expect(canSubmitRoom('Launch', ['d'], false, null)).toBe(true);
        expect(canSubmitRoom('  ', ['d'], false, null)).toBe(false);
        expect(canSubmitRoom('Launch', [], false, null)).toBe(false);
        expect(canSubmitRoom('Launch', ['d'], true, null)).toBe(false);
        expect(canSubmitRoom('Launch', ['d'], false, 'offline')).toBe(false);
    });

    it('words each outcome by code or status, never the server’s text', () => {
        expect(roomCreateCopy({ kind: 'done', room: { id: 'r', title: 'R' } })).toBeNull();
        expect(roomCreateCopy({ kind: 'busy' })).toBeNull();
        expect(roomCreateCopy({ kind: 'blocked', reason: 'offline' })).toBe(ROOM_NEEDS_CONNECTION);
        expect(roomCreateCopy({ kind: 'blocked', reason: 'update' })).toBe('Update Socio to do this');
        expect(roomCreateCopy({ kind: 'refused', reason: 'rooms_off' })).toBe('Rooms are off in this workspace.');
        expect(roomCreateCopy({ kind: 'refused', reason: 'personal_socio' })).toMatch(/company socios only/);
        expect(roomCreateCopy({ kind: 'refused', reason: 'not_eligible' })).toMatch(/can’t be invited/);
        expect(roomCreateCopy({ kind: 'refused', reason: 'server words' })).toBe(
            'Couldn’t create the room. Try again.',
        );
        expect(roomCreateCopy({ kind: 'no-answer' })).toBe(ROOM_NO_ANSWER);
    });

    it('asks before leaving once something is chosen, and lets its own hand-off pass', () => {
        expect(newRoomAsks('', ['d-sebas'], [], ['d-sebas'])).toBe(false);
        expect(newRoomAsks('Launch', ['d-sebas'], [], ['d-sebas'])).toBe(true);
        expect(newRoomAsks('', ['d-sebas'], ['u-ben'], ['d-sebas'])).toBe(true);
        expect(newRoomAsks('', ['d-sebas', 'd-manny'], [], ['d-sebas'])).toBe(true);
        expect(newRoomAsks('', ['d-manny'], [], ['d-sebas'])).toBe(true);
        const screen = app('screens/new-room.tsx');
        expect(screen).toContain('usePreventRemove(newRoomAsks(title, socioIds, userIds, start)');
        expect(screen).toContain("if (data.action.type === 'REPLACE' || isHandOff(data.action)) {");
    });

    it('picks in native sheets, and opens the new room in the Chats tab in the sheet’s place', () => {
        const screen = app('screens/new-room.tsx');
        expect(screen).toContain('useRouteSheet(');
        expect(screen).not.toMatch(/\bModal\b/);
        expect(screen).toContain('<SearchField');
        expect(screen).toContain(
            "() => navigation.dispatch(inOwnTabAction('Chats', 'Chat', { id: outcome.room.id })),",
        );
        // Android: the sheet goes once the Chats list under it has drawn the new row (Fabric's addViewAt stopped the app).
        expect(screen).toContain('roomOpenDelay(Platform.OS),');
        expect(roomOpenDelay('android')).toBe(ROOM_OPEN_DELAY_MS);
        expect(ROOM_OPEN_DELAY_MS).toBeGreaterThanOrEqual(300);
        expect(roomOpenDelay('ios')).toBe(0);
        // The keyboard goes as a picker opens, so iOS doesn't bring it back over the form as the sheet closes.
        expect(screen).toMatch(/const openPicker = \(kind: 'socios' \| 'people'\) => \{\s+Keyboard\.dismiss\(\);/);
    });
});
