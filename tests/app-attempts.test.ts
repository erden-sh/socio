import { expect, it } from 'vitest';

import { sqliteData } from '@socio/data/open';
import { APP_LOG_ATTEMPTS_RANGE } from '@socio/shared/apps/app-log-retention';
import type { RuntimeAttempt } from '@socio/shared/apps/apps-runtime-types';

import { ATTEMPTS_KEPT } from '../src/apps-runtime/supervisor.js';
import { ATTEMPT_LOG_BYTES, ATTEMPT_LOG_LINES, ATTEMPTS_PER_APP } from '../src/server/apps/domain/attempts.js';
import { sqliteAppRepositories } from '../src/server/apps/infra/sqlite/index.js';
import { AppsRuntimeClient } from '../src/server/apps/runtime-client.js';

import { testDatabase } from './helpers/test-database.js';

// CB-146: promoted apps' build and start attempts, as the app keeps them.

const repo = () => {
    const db = testDatabase();
    return { db, attempts: sqliteAppRepositories(sqliteData(db)).attempts };
};
const reported = (n: number, extra: Partial<RuntimeAttempt> = {}): RuntimeAttempt => ({
    id: `rt-${n}`,
    version: 1,
    kind: 'start',
    state: 'failed',
    startedAt: n,
    upAt: null,
    endedAt: n,
    exit: {
        reason: 'exit',
        code: 1,
        signal: null,
        message: `Attempt ${n} failed.`,
    },
    lines: [`line of ${n}`],
    dropped: 0,
    ...extra,
});

it('numbers attempts per app, updates known ones and marks lost ones', async () => {
    const { attempts } = repo();
    await attempts.sync('app', 'boot-1', [
        reported(1, { kind: 'build', state: 'succeeded', exit: null }),
        reported(2, { state: 'running', exit: null, endedAt: null }),
    ]);
    expect((await attempts.list('app')).map((item) => `${item.attempt} ${item.state}`)).toEqual([
        '2 running',
        '1 succeeded',
    ]);
    // Output that came after the first copy is taken.
    await attempts.sync('app', 'boot-1', [
        reported(2, {
            state: 'running',
            exit: null,
            endedAt: null,
            lines: ['line of 2', 'later'],
        }),
    ]);
    expect((await attempts.find('app'))!.lines).toEqual(['line of 2', 'later']);
    // The runtime restarted: it no longer knows the running one.
    await attempts.sync('app', 'boot-1', [reported(3, { version: 2 })]);
    expect(await attempts.find('app', { attempt: 2 })).toMatchObject({
        state: 'stopped',
        reason: 'lost',
        message: expect.stringMatching(/runtime restarted/),
    });
    expect(await attempts.find('app')).toMatchObject({
        attempt: 3,
        version: 2,
        reason: 'exit',
        exitCode: 1,
    });
    expect(await attempts.find('app', { version: 1 })).toMatchObject({
        attempt: 2,
    });
    expect(await attempts.find('app', { version: 7 })).toBeUndefined();
    expect(await attempts.find('other')).toBeUndefined();
});

it('tells an attempt the runtime dropped as old from one a restart lost', async () => {
    const { attempts } = repo();
    await attempts.sync('app', 'boot-1', [reported(1, { id: 'boot-1:a', state: 'running', exit: null })]);
    // Same run, not listed any more: it aged out.
    await attempts.sync('app', 'boot-1', [reported(2, { id: 'boot-1:b' })]);
    expect((await attempts.find('app', { attempt: 1 }))!.message).toMatch(/no longer keeps this attempt/);
    await attempts.sync('app', 'boot-1', [reported(3, { id: 'boot-1:c', state: 'running', exit: null })]);
    // Another run: the runtime restarted.
    await attempts.sync('app', 'boot-2', []);
    expect((await attempts.find('app', { attempt: 3 }))!.message).toMatch(/runtime restarted/);
});

it('keeps logs and attempts bounded', async () => {
    const { attempts } = repo();
    const long = Array.from({ length: 1000 }, (_, n) => `line ${n} ${'x'.repeat(100)}`);
    await attempts.sync('app', 'boot-1', [reported(1, { lines: long, dropped: 5 })]);
    const one = (await attempts.find('app'))!;
    expect(one.lines.length).toBeLessThanOrEqual(ATTEMPT_LOG_LINES);
    expect(Buffer.byteLength(one.lines.join('\n'))).toBeLessThanOrEqual(ATTEMPT_LOG_BYTES);
    expect(one.lines.at(-1)).toBe(long.at(-1));
    expect(one.dropped).toBe(5 + long.length - one.lines.length);
    // Never more than the ceiling, the newest staying.
    for (let n = 2; n <= ATTEMPTS_PER_APP + 5; n++) {
        await attempts.sync('app', 'boot-1', [reported(n)]);
    }
    const all = await attempts.list('app', 1000);
    expect(all).toHaveLength(ATTEMPTS_PER_APP);
    expect(all[0].attempt).toBe(ATTEMPTS_PER_APP + 5);
});

// CB-175: an attempt stays for the days kept or while it is among the app's
// last attempts, whichever keeps more; the running one always stays.
it('prunes by days or count, whichever keeps more, and never the running attempt', async () => {
    const { attempts } = repo();
    const DAY = 86_400_000;
    const now = 100 * DAY;
    // Ten attempts, one a day: attempt n started and ended n days in.
    for (let n = 1; n <= 10; n++) {
        await attempts.sync('app', 'boot-1', [reported(n, { startedAt: n * DAY, endedAt: n * DAY })]);
    }
    await attempts.sync('other', 'boot-1', [reported(1, { startedAt: DAY, endedAt: DAY })]);
    const kept = async (appId = 'app') => (await attempts.list(appId)).map((item) => item.attempt);
    // All are over 85 days old: the last 3 stay by count.
    expect(await attempts.prune({ days: 14, attempts: 3 }, now)).toBe(7);
    expect(await kept()).toEqual([10, 9, 8]);
    expect(await kept('other')).toEqual([1]);
    // Recent ones stay by age even past the count: days keep more.
    expect(await attempts.prune({ days: 95, attempts: 1 }, now)).toBe(0);
    expect(await kept()).toEqual([10, 9, 8]);
    expect(await attempts.prune({ days: 91, attempts: 1 }, now)).toBe(1);
    expect(await kept()).toEqual([10, 9]);
    // The running attempt is never pruned, however old and beyond the count.
    await attempts.sync('old', 'boot-1', [
        reported(1, {
            id: 'run',
            state: 'running',
            exit: null,
            endedAt: null,
            startedAt: 1,
        }),
        reported(2, { startedAt: DAY, endedAt: DAY }),
        reported(3, { startedAt: 2 * DAY, endedAt: 2 * DAY }),
    ]);
    await attempts.prune({ days: 1, attempts: 1 }, now);
    expect(await kept('old')).toEqual([3, 1]);
    expect((await attempts.find('old', { attempt: 1 }))!.state).toBe('running');
});

// A pruned attempt the runtime still lists must not come back as a newer one.
it('does not copy a pruned attempt again when the runtime still lists it', async () => {
    const { attempts } = repo();
    const DAY = 86_400_000;
    const list = [
        ...Array.from({ length: 9 }, (_, i) => reported(i + 1, { startedAt: (i + 1) * DAY, endedAt: (i + 1) * DAY })),
        reported(10, {
            state: 'running',
            exit: null,
            endedAt: null,
            startedAt: 10 * DAY,
        }),
    ];
    await attempts.sync('app', 'boot-1', list);
    expect(await attempts.prune({ days: 1, attempts: 3 }, 100 * DAY)).toBe(7);
    await attempts.sync('app', 'boot-1', list);
    expect((await attempts.list('app')).map((item) => item.attempt)).toEqual([10, 9, 8]);
    expect((await attempts.find('app'))!.state).toBe('running');
    // A newer attempt is still taken.
    await attempts.sync('app', 'boot-1', [...list, reported(11, { startedAt: 11 * DAY })]);
    expect((await attempts.find('app'))!.attempt).toBe(11);
});

it('keeps the least retention at what the runtime keeps in memory', () => {
    expect(APP_LOG_ATTEMPTS_RANGE.min).toBe(ATTEMPTS_KEPT);
});

it('moves a deleted app’s attempts with it, so a new app at its address starts clean', async () => {
    const { attempts } = repo();
    await attempts.sync('tracker--dot-d1', 'boot-1', [reported(1)]);
    await attempts.rekey('tracker--dot-d1', 'deleted-1');
    expect(await attempts.list('tracker--dot-d1')).toEqual([]);
    expect(await attempts.list('deleted-1')).toHaveLength(1);
    await attempts.sync('tracker--dot-d1', 'boot-1', [reported(2)]);
    expect((await attempts.find('tracker--dot-d1'))!.attempt).toBe(1);
});

it('tells a runtime without the app from one too old to keep attempts', async () => {
    const client = (response: () => Response) =>
        new AppsRuntimeClient(
            {
                url: 'http://runtime.test',
                token: 'runtime-token-0123456789abcdef',
                ingress: { host: 'runtime.test', port: 4331 },
            },
            async () => response(),
        );
    // The runtime's own answer: it doesn't have the app (yet).
    expect(await client(() => Response.json({ error: 'App not found here.' }, { status: 404 })).attempts('a')).toBe(
        'missing',
    );
    // No such route: a runtime from before attempts.
    expect(await client(() => new Response('404 Not Found', { status: 404 })).attempts('a')).toBe('unsupported');
    expect(await client(() => Response.json({ boot: 'b', attempts: [] })).attempts('a')).toEqual({
        boot: 'b',
        attempts: [],
    });
});
