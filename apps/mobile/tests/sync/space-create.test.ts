import { describe, expect, it, vi } from 'vitest';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { createSpaceCreate, type SpaceCreateOptions } from '../../src/sync/space-create';

import { fakeNetwork, OFFLINE } from './fakes';

// New Space (CB-410): the web's `POST /api/spaces`, online only, one at a
// time, resolving once the Spaces list holds the new Space.

interface Call {
    readonly url: string;
    readonly init: AuthedRequestInit | undefined;
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(answer: () => Response | Promise<Response>, options: Partial<SpaceCreateOptions> = {}) {
    const calls: Call[] = [];
    const fetch: AuthedFetch = async (url, init) => {
        calls.push({ url, init });
        return answer();
    };
    const network = fakeNetwork();
    const listed = vi.fn(async (_id: string) => {});
    const refresh = vi.fn();
    const create = createSpaceCreate({
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

const SPACE = { id: 'space-9', name: 'Launch', description: 'Plans', createdAt: 1, private: true };

describe('creating a Space, online only', () => {
    it('posts the web dialog’s body, waits for the Spaces list, and answers the Space', async () => {
        const s = setup(() => json(201, SPACE));
        const outcome = await s.create.create({ name: '  Launch ', description: ' Plans ', private: true });
        expect(outcome).toEqual({ kind: 'done', space: SPACE });
        expect(s.calls).toEqual([
            {
                url: '/api/spaces',
                init: { method: 'POST', json: { name: 'Launch', description: 'Plans', private: true } },
            },
        ]);
        expect(s.listed).toHaveBeenCalledWith('space-9');
        expect(s.create.busy()).toBe(false);
    });

    it('sends nothing offline, away or while writes wait', async () => {
        const s = setup(() => json(201, SPACE));
        await Promise.resolve();
        s.network.set(OFFLINE);
        expect(s.create.blocked()).toBe('offline');
        expect(await s.create.create({ name: 'A', description: '', private: false })).toEqual({
            kind: 'blocked',
            reason: 'offline',
        });
        const away = setup(() => json(201, SPACE), { away: () => true });
        expect(await away.create.create({ name: 'A', description: '' })).toEqual({ kind: 'blocked', reason: 'away' });
        const held = setup(() => json(201, SPACE), { hold: () => 'update' });
        expect(await held.create.create({ name: 'A', description: '' })).toEqual({ kind: 'blocked', reason: 'update' });
        expect([...s.calls, ...away.calls, ...held.calls]).toEqual([]);
    });

    it('makes one Space for two taps: the second is busy until the list holds the first', async () => {
        let release: (() => void) | null = null;
        const s = setup(() => json(201, SPACE), {
            listed: () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        });
        const first = s.create.create({ name: 'Launch', description: '' });
        await vi.waitFor(() => expect(release).not.toBeNull());
        expect(s.create.busy()).toBe(true);
        expect(await s.create.create({ name: 'Launch', description: '' })).toEqual({ kind: 'busy' });
        release!();
        expect((await first).kind).toBe('done');
        expect(s.calls).toHaveLength(1);
    });

    it('tells refusals by status, and pulls the shell when the Space may be there all the same', async () => {
        expect(
            await setup(() => json(403, { error: 'server words' })).create.create({ name: 'A', description: '' }),
        ).toEqual({ kind: 'refused', reason: 'http-403' });
        expect(await setup(() => json(400, {})).create.create({ name: 'A', description: '' })).toEqual({
            kind: 'refused',
            reason: 'http-400',
        });
        const broke = setup(() => Promise.reject(new Error('broke off')));
        expect(await broke.create.create({ name: 'A', description: '' })).toEqual({ kind: 'no-answer' });
        expect(broke.refresh).toHaveBeenCalledTimes(1);
        const failed = setup(() => json(500, {}));
        expect(await failed.create.create({ name: 'A', description: '' })).toEqual({ kind: 'no-answer' });
        expect(failed.refresh).toHaveBeenCalledTimes(1);
        expect(failed.listed).not.toHaveBeenCalled();
    });
});
