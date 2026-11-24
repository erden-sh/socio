import { expect, it, vi } from 'vitest';

import { planComputers, purgeSupervisor } from '../src/server/purge/supervisor.js';

const env = { COMPUTER_SUPERVISOR_URL: 'http://supervisor:4300/', COMPUTER_SUPERVISOR_TOKEN: 'secret-token' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

it('is off where the deployment has no supervisor', () => {
    expect(purgeSupervisor({})).toBeUndefined();
    // Computers run, but without the token they couldn't be removed: a stop, not a skip.
    expect(() => purgeSupervisor({ COMPUTER_SUPERVISOR_URL: 'http://x' })).toThrow(/COMPUTER_SUPERVISOR_TOKEN is not/);
    expect(() => purgeSupervisor({ COMPUTER_SUPERVISOR_URL: 'http://x', COMPUTER_SUPERVISOR_TOKEN: ' ' })).toThrow();
});

it('lists, probes and destroys through the supervisor with its token', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
        if (url.endsWith('/computers')) {
            return json(200, { computers: [{ botId: 'a', container: 'ns-computer-a', status: 'exited' }] });
        }
        if (url.endsWith('/computers/-/destroy')) {
            return json(400, { error: 'Invalid id' });
        }
        return json(200, { botId: 'a', container: true, volumes: ['ns-profile-a', 'ns-workspace-a', 'ns-private-a'] });
    });
    const supervisor = purgeSupervisor(env, fetchImpl)!;
    expect(await supervisor.list()).toEqual([{ botId: 'a', container: 'ns-computer-a', status: 'exited' }]);
    expect(await supervisor.canDestroy()).toBe(true);
    expect(await supervisor.destroy('a')).toEqual({
        container: true,
        volumes: ['ns-profile-a', 'ns-workspace-a', 'ns-private-a'],
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
        'http://supervisor:4300/computers/a/destroy',
        expect.objectContaining({ method: 'POST' }),
    );
});

it('tells an older supervisor without the route, and stops on its errors', async () => {
    const old = purgeSupervisor(env, async () => new Response('404 Not Found', { status: 404 }))!;
    expect(await old.canDestroy()).toBe(false);
    await expect(old.destroy('a')).rejects.toThrow(/update it to this release, then purge --resume/);
    const failing = purgeSupervisor(env, async () => json(503, { error: 'down' }))!;
    await expect(failing.destroy('a')).rejects.toThrow(/answered 503/);
    await expect(failing.list()).rejects.toThrow(/answered 503/);
});

it('refuses before any delete when the supervisor has no destroy route, even with no container listed', async () => {
    const old = purgeSupervisor(env, async (url: string) =>
        url.endsWith('/computers') ? json(200, { computers: [] }) : new Response('404 Not Found', { status: 404 }),
    )!;
    const planned = await planComputers(old, ['a']);
    expect(planned).toMatchObject({ destroy: false, found: [] });
    expect(planned.refusal).toMatch(/can't remove computers.*--keep-computers/);
    expect(await planComputers(old, ['a'], true)).toEqual({ destroy: false, found: [] });
    expect(await planComputers(old, [])).toEqual({ destroy: false, found: [] });
    expect(await planComputers(undefined, ['a'])).toEqual({ destroy: false, found: [] });
});

it('destroys every purged socio’s computer where the route exists, listing those it sees', async () => {
    const current = purgeSupervisor(env, async (url: string) =>
        url.endsWith('/computers')
            ? json(200, {
                  computers: [
                      { botId: 'a', container: 'ns-computer-a', status: 'exited' },
                      { botId: 'z', container: 'ns-computer-z', status: 'running' },
                  ],
              })
            : json(400, { error: 'Invalid id' }),
    )!;
    expect(await planComputers(current, ['a', 'b'])).toEqual({
        destroy: true,
        found: [{ botId: 'a', container: 'ns-computer-a', status: 'exited' }],
    });
});
