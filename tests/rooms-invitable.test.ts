import { afterEach, expect, it } from 'vitest';

import { ROOM_DISCLOSURE_VERSION, type RoomPerson } from '@socio/shared/rooms/rooms';

import { matrixChats, roomsFixture } from './fixtures/rooms.js';

// CB-212 (client half): what the room screens need of the server beyond
// CB-208's API. A room admin's invite list (people by id and name, not
// those in the room or invited, never to anyone else), and a room's own
// name surviving the first message's generated title.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

it('lists whom a room admin may invite, to room admins only', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId, privateId } = await matrixChats(f);
    const invitable = await f.as('ada')(`/rooms/${roomId}/invitable`);
    expect(invitable.status).toBe(200);
    const people = (await invitable.json()) as RoomPerson[];
    // Ada and Mo are in it, Ivy is invited; Rex was removed and can be
    // invited again. Names and ids only, sorted by name.
    expect(people).toEqual([
        { userId: 'alice', name: 'Alice' },
        { userId: 'nina', name: 'Nina' },
        { userId: 'olive', name: 'Olive' },
        { userId: 'rex', name: 'Rex' },
    ]);
    // A member who isn't an admin, a workspace admin outside the room and a
    // stranger: refused, the outsiders as if there were no room.
    expect((await f.as('mo')(`/rooms/${roomId}/invitable`)).status).toBe(403);
    expect((await f.as('alice')(`/rooms/${roomId}/invitable`)).status).toBe(404);
    expect((await f.as('nina')(`/rooms/${roomId}/invitable`)).status).toBe(404);
    // A private chat is no room.
    expect((await f.as('olive')(`/rooms/${privateId}/invitable`)).status).toBe(404);
    // Once Nina joins she leaves the list; a deactivated person isn't on it.
    await f.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' });
    await f.as('nina')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    f.workspace.useDeactivated(() => ['olive']);
    const after = (await (await f.as('ada')(`/rooms/${roomId}/invitable`)).json()) as RoomPerson[];
    expect(after.map((person) => person.userId)).toEqual(['alice', 'rex']);
});

it('keeps an archived room’s invite list closed', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    await f.as('ada')(`/rooms/${roomId}/archive`, 'POST');
    const archived = await f.as('ada')(`/rooms/${roomId}/invitable`);
    expect(archived.status).toBe(409);
    expect(((await archived.json()) as { code: string }).code).toBe('archived');
});

it('keeps the name a room was made with when its first message would title it', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    // What a turn's generated title does (CB-66): only an untitled,
    // unrenamed chat takes it.
    f.workspace.setAutomaticTitle(roomId, 'Smoke pelican');
    expect(f.workspace.thread(roomId)?.title).toBe('Launch');
    expect(f.workspace.thread(roomId)?.renamed).toBe(true);
});
