import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { createRoomCreate, roomCreateBody, type RoomCreateOptions } from '../../src/sync/room-create';

import { fakeNetwork, OFFLINE } from './fakes';

// New room (CB-470): the web's `GET /api/rooms/people` and `POST /api/rooms`,
// online only, one create at a time, resolving once the chat list holds the room.

interface Call {
    readonly url: string;
    readonly init: AuthedRequestInit | undefined;
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(answer: (url: string) => Response | Promise<Response>, options: Partial<RoomCreateOptions> = {}) {
    const calls: Call[] = [];
    const fetch: AuthedFetch = async (url, init) => {
        calls.push({ url, init });
        return answer(url);
    };
    const network = fakeNetwork();
    const listed = vi.fn(async (_id: string) => {});
    const refresh = vi.fn();
    const create = createRoomCreate({
        fetch,
        network,
        away: () => false,
        hold: () => null,
        listed,
        refresh,
        ...options,
    });
    return { create, calls, network, listed, refresh };
}

const ROOM = { id: 'room-9', title: 'Launch', kind: 'room', dotId: 'd-sebas', createdAt: 1 };
const INPUT = { title: '  Launch ', socioIds: ['d-sebas', 'd-manny'], userIds: ['u-ben', 'u-opal'] };

const repo = (file: string) => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');

describe('creating a room, online only', () => {
    it('posts the web dialog’s body: the lead, the further socios and the people', () => {
        expect(roomCreateBody(INPUT)).toEqual({
            dotId: 'd-sebas',
            title: 'Launch',
            dotIds: ['d-manny'],
            userIds: ['u-ben', 'u-opal'],
        });
        // One socio and nobody else: the optional lists stay out, as the web leaves them.
        expect(roomCreateBody({ title: 'Solo', socioIds: ['d-sebas', 'd-sebas'], userIds: [] })).toEqual({
            dotId: 'd-sebas',
            title: 'Solo',
        });
        // The server's schema and the web's call, so the body stays theirs.
        const routes = repo('src/server/rooms/routes.ts');
        expect(routes).toContain("app.post('/rooms', async (c) => {");
        for (const field of [
            'dotId: z.string().min(1),',
            'dotIds: z.array(z.string().min(1)).optional(),',
            'userIds: z.array(z.string().min(1)).optional(),',
        ]) {
            expect(routes).toContain(field);
        }
        expect(routes).toContain(
            "app.get('/rooms/people', async (c) => c.json(await rooms.inviteCandidates(user(c))));",
        );
        const web = repo('packages/client/src/modules/rooms/api.ts');
        expect(web).toContain("api<Conversation>('/rooms', 'POST', {");
        expect(web).toContain('...(options.dotIds?.length ? { dotIds: [...options.dotIds] } : {}),');
    });

    it('waits for the chat list, then answers the room', async () => {
        const s = setup(() => json(201, ROOM));
        const outcome = await s.create.create(INPUT);
        expect(outcome).toEqual({ kind: 'done', room: { id: 'room-9', title: 'Launch' } });
        expect(s.calls).toEqual([{ url: '/api/rooms', init: { method: 'POST', json: roomCreateBody(INPUT) } }]);
        expect(s.listed).toHaveBeenCalledWith('room-9');
        expect(s.create.busy()).toBe(false);
    });

    it('sends nothing offline, away or while writes wait', async () => {
        const s = setup(() => json(201, ROOM));
        await Promise.resolve();
        s.network.set(OFFLINE);
        expect(s.create.blocked()).toBe('offline');
        expect(await s.create.create(INPUT)).toEqual({ kind: 'blocked', reason: 'offline' });
        expect(await s.create.people()).toEqual({ kind: 'blocked', reason: 'offline' });
        const away = setup(() => json(201, ROOM), { away: () => true });
        expect(await away.create.create(INPUT)).toEqual({ kind: 'blocked', reason: 'away' });
        const held = setup(() => json(201, ROOM), { hold: () => 'update' });
        expect(await held.create.create(INPUT)).toEqual({ kind: 'blocked', reason: 'update' });
        expect([...s.calls, ...away.calls, ...held.calls]).toEqual([]);
    });

    it('makes one room for two taps: the second is busy until the list holds the first', async () => {
        let release: (() => void) | null = null;
        const s = setup(() => json(201, ROOM), {
            listed: () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        });
        const first = s.create.create(INPUT);
        await vi.waitFor(() => expect(release).not.toBeNull());
        expect(s.create.busy()).toBe(true);
        expect(await s.create.create(INPUT)).toEqual({ kind: 'busy' });
        release!();
        expect((await first).kind).toBe('done');
        expect(s.calls).toHaveLength(1);
    });

    it('tells refusals by code, else status, and pulls the shell when the room may be there all the same', async () => {
        expect(await setup(() => json(409, { error: 'server words', code: 'rooms_off' })).create.create(INPUT)).toEqual(
            { kind: 'refused', reason: 'rooms_off' },
        );
        expect(await setup(() => json(403, {})).create.create(INPUT)).toEqual({ kind: 'refused', reason: 'http-403' });
        const broke = setup(() => Promise.reject(new Error('broke off')));
        expect(await broke.create.create(INPUT)).toEqual({ kind: 'no-answer' });
        expect(broke.refresh).toHaveBeenCalledTimes(1);
        const failed = setup(() => json(500, {}));
        expect(await failed.create.create(INPUT)).toEqual({ kind: 'no-answer' });
        expect(failed.refresh).toHaveBeenCalledTimes(1);
        expect(failed.listed).not.toHaveBeenCalled();
    });
});

describe('the people one may invite', () => {
    it('reads them before any room exists, keeping only well-formed rows', async () => {
        const s = setup(() =>
            json(200, [{ userId: 'u-ben', name: 'Ben' }, { userId: 7 }, { userId: 'u-opal', name: 'Opal' }]),
        );
        expect(await s.create.people()).toEqual({
            kind: 'done',
            people: [
                { userId: 'u-ben', name: 'Ben' },
                { userId: 'u-opal', name: 'Opal' },
            ],
        });
        expect(s.calls).toEqual([{ url: '/api/rooms/people', init: { method: 'GET' } }]);
    });

    it('still reads while writes wait, and words what it couldn’t read', async () => {
        const held = setup(() => json(200, []), { hold: () => 'sign-in' });
        expect(await held.create.people()).toEqual({ kind: 'done', people: [] });
        expect(await setup(() => json(409, { code: 'rooms_off' })).create.people()).toEqual({
            kind: 'refused',
            reason: 'rooms_off',
        });
        expect(await setup(() => json(200, { people: [] })).create.people()).toEqual({
            kind: 'refused',
            reason: 'unreadable',
        });
        expect(await setup(() => json(503, {})).create.people()).toEqual({ kind: 'no-answer' });
    });
});

describe('the scope', () => {
    it('holds roomCreate beside spaceCreate, waiting on the chat list, and disposes it', () => {
        const scope = readFileSync(new URL('../../src/sync/scope.ts', import.meta.url), 'utf8');
        expect(scope).toContain('listed: (roomId) => whenListed(CONVERSATIONS, roomId),');
        expect(scope).toContain('roomCreate.dispose();');
        expect(scope).toMatch(/spaceCreate,\s+roomCreate,/);
    });
});
