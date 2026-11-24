import { expect, it } from 'vitest';

import { waitIdle } from '../scripts/lib/wait-idle.mjs';

/** A fake API caller: answers from `routes`, records each call. */
function fakeApi(routes) {
    const calls = [];
    const call = async (path, method = 'GET', body) => {
        calls.push(`${method} ${path}`);
        const handler = routes[`${method} ${path}`];
        if (!handler) {
            throw new Error(`${method} ${path}: 404 Not found.`);
        }
        return handler(body);
    };
    return { call, calls };
}

const quiet = { log: () => {}, sleep: async () => {} };

it('--force stops all running work as an admin, then waits until idle', async () => {
    let turns = 2;
    const lines = [];
    const { call, calls } = fakeApi({
        'GET /auth/session': () => ({
            user: { id: 'smoke-admin', role: 'admin' },
        }),
        'POST /operator/force-stop': () => {
            // The stopped turns finish storing a moment later.
            turns = 1;
            return {
                turns: 2,
                turnSources: { web: 2 },
                scheduledTasks: 0,
                computerActions: 1,
                held: true,
            };
        },
        'GET /runs?status=running': () => ({
            runs: Array.from({ length: turns-- > 0 ? 1 : 0 }, () => ({})),
        }),
    });
    expect(await waitIdle(call, { ...quiet, force: true, log: (l) => lines.push(l) })).toBe(true);
    expect(calls.slice(0, 2)).toEqual(['GET /auth/session', 'POST /operator/force-stop']);
    expect(lines[0]).toBe(
        '[wait-idle] force stop: 2 turns, 0 scheduled tasks stopped; 1 computer actions aborted; new work held until the restart',
    );
    expect(lines.at(-1)).toMatch(/^\[wait-idle\] idle after \d+s$/);
});

it('--force refuses accounts that are not admins, and servers outside development', async () => {
    const member = fakeApi({
        'GET /auth/session': () => ({ user: { role: 'member' } }),
    });
    await expect(waitIdle(member.call, { ...quiet, force: true })).rejects.toThrow(
        '--force needs an admin account; this one is member.',
    );
    expect(member.calls).toEqual(['GET /auth/session']);
    const production = fakeApi({
        'GET /auth/session': () => ({ user: { role: 'admin' } }),
    });
    await expect(waitIdle(production.call, { ...quiet, force: true })).rejects.toThrow(
        'This server has no force stop: it runs only with APP_ENV=development.',
    );
});

it('without --force only waits, and gives up at the timeout', async () => {
    let clock = 0;
    const { call, calls } = fakeApi({
        'GET /runs?status=running': () => ({ runs: [{}] }),
    });
    const lines = [];
    expect(
        await waitIdle(call, {
            timeoutMs: 10_000,
            now: () => clock,
            sleep: async (ms) => void (clock += ms),
            log: (line) => lines.push(line),
        }),
    ).toBe(false);
    expect(calls).not.toContain('POST /operator/force-stop');
    expect(lines.at(-1)).toBe('[wait-idle] still busy after 10s (1 turns)');
});
