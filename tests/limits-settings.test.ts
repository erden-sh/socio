import { afterEach, expect, it, vi } from 'vitest';

import { LIMIT_GROUPS, LIMIT_KEYS, validLimit, type LimitValues } from '@socio/shared/limits';
import { limitsInForce } from '@socio/shared/settings/limits';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { limitDefaults, turnTimeLimitMs } from '../src/server/settings/limits.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// Settings → General → the tunable limits (CB-108): an admin's over the
// environment's, applied where they are enforced, with no restart.

const MB = 1024 * 1024;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    const { app, store, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: config.baseUrl,
            apiKey: 'unused',
            model: 'qwen-test',
            voiceName: 'marin',
            runtimeUrl: '',
            // What the environment would set.
            schedules: { minIntervalMs: 30 * 60_000, maxActivePerUser: 7 },
            jobs: {
                maxTimeoutSeconds: 600,
                concurrency: 3,
                maxJobsPerUser: 9,
                itemAttempts: 4,
            },
            data: {
                limits: {
                    fileMaxBytes: 1 * MB,
                    datasetMaxBytes: 50 * MB,
                    userMaxBytes: 500 * MB,
                    maxDatasets: 11,
                },
            },
            roomCycleSpendUsd: 250,
            dotModelRounds: 40,
            turnTimeLimitSeconds: 120,
            turnRecallTokens: 1500,
            steeringMaxQueued: 3,
        },
        app: {
            config,
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'limits-secret-0123456789abcdef'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return Object.assign(
            (path: string, method = 'GET', body?: unknown) =>
                app.request(path, {
                    method,
                    headers: {
                        cookie,
                        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }),
            {
                upload: (bytes: Uint8Array, name: string) =>
                    app.request('/api/media/uploads?purpose=attachment', {
                        method: 'POST',
                        headers: {
                            cookie,
                            'Content-Type': 'application/octet-stream',
                            'X-CB-Upload': '1',
                            'X-File-Name': encodeURIComponent(name),
                        },
                        body: new Uint8Array(bytes),
                    }),
            },
        );
    };
    return {
        store,
        platform,
        alice: await as('alice'),
        bob: await as('bob'),
    };
}

type View = {
    settings: { limits: LimitValues; limitDefaults: LimitValues };
};
const stateOf = async (response: Response) => ((await response.json()) as View).settings;

it('has a range and a card for every limit', () => {
    expect(LIMIT_GROUPS.flatMap((group) => group.keys).sort()).toEqual([...LIMIT_KEYS].sort());
    expect(validLimit('jobConcurrency', 4)).toBe(true);
    expect(validLimit('jobConcurrency', 0)).toBe(false);
    expect(validLimit('jobConcurrency', 2.5)).toBe(false);
    expect(validLimit('roomCycleSpendUsd', 0)).toBe(true);
    expect(validLimit('roomCycleSpendUsd', 12.34)).toBe(true);
    expect(validLimit('roomCycleSpendUsd', 12.345)).toBe(false);
    expect(validLimit('roomCycleSpendUsd', '5')).toBe(false);
});

it("shows the environment's limits until an admin saves their own", async () => {
    const { alice, bob, platform } = await fixture();
    const expected: LimitValues = {
        scheduleMinIntervalMinutes: 30,
        schedulesPerUser: 7,
        jobMaxTimeoutSeconds: 600,
        jobConcurrency: 3,
        jobsPerUser: 9,
        // CB-122: jobs that run until done; the batch limits are the defaults.
        jobItemAttempts: 4,
        jobBatchRetries: 5,
        jobMaxBatches: 200,
        dataFileMaxMb: 1,
        dataDatasetMaxMb: 50,
        dataUserMaxMb: 500,
        dataMaxDatasets: 11,
        dataSharedRetentionDays: 0,
        dataStampTombstoneDays: 30,
        // Plugin datasets: today's dataset and query defaults.
        dataPluginDatasetMaxMb: 100,
        dataPluginQueryMaxRows: 500,
        dataPluginStatementsPerMinute: 600,
        // Analytical tables (CB-369): the defaults.
        dataAnalyticalMaxMb: 1024,
        dataAnalyticsQueryTimeoutSeconds: 30,
        dataAnalyticsQueryMaxRows: 10_000,
        dataAppendMaxRows: 200_000,
        dataAnalyticsQueryMemoryMb: 512,
        dataAnalyticsQueryConcurrency: 2,
        dataAnalyticsRetainDays: 0,
        dotModelRounds: 40,
        turnTimeLimitSeconds: 120,
        turnRecallTokens: 1500,
        // CB-180: episodes kept 180 days unless set.
        episodeRetentionDays: 180,
        // CB-181: Space memory out of use kept 365 days unless set.
        spaceMemoryRetentionDays: 365,
        steeringMaxQueued: 3,
        // CB-211: the work cycle limits' built-in defaults.
        roomCycleTokens: 2_000_000,
        roomMessagesPerMinute: 20,
        roomHandoffsPerCycle: 4,
        roomCycleSpendUsd: 250,
        // CB-315: the continuous copy's alerts' built-in defaults.
        copyLagWarnMinutes: 5,
        copyLagCriticalMinutes: 30,
        walWarnMb: 256,
        walCriticalMb: 1024,
        // CB-458: the per-plugin snapshot cap's built-in default.
        pluginBackupMaxGb: 20,
    };
    expect(limitDefaults(platform.config)).toEqual(expected);
    const member = await stateOf(await bob('/api/state'));
    expect(member.limits).toEqual(expected);
    expect(member.limitDefaults).toEqual(expected);

    const saved = await alice('/api/settings', 'PATCH', {
        limits: { jobConcurrency: 5, roomCycleSpendUsd: 99.5 },
    });
    expect(saved.status).toBe(200);
    const after = await stateOf(await bob('/api/state'));
    expect(after.limits).toEqual({
        ...expected,
        jobConcurrency: 5,
        roomCycleSpendUsd: 99.5,
    });
    // The server's own values stay as they were.
    expect(after.limitDefaults).toEqual(expected);

    // Another change leaves the first alone; null goes back to the server's.
    await alice('/api/settings', 'PATCH', { limits: { schedulesPerUser: 40 } });
    await alice('/api/settings', 'PATCH', { limits: { jobConcurrency: null } });
    await alice('/api/settings', 'PATCH', { researchAllowed: false });
    const kept = (await stateOf(await alice('/api/state'))).limits;
    expect(kept).toEqual({
        ...expected,
        schedulesPerUser: 40,
        roomCycleSpendUsd: 99.5,
    });
});

it('lets only admins save, and checks every value on the server', async () => {
    const { alice, bob, store } = await fixture();
    expect(
        (
            await bob('/api/settings', 'PATCH', {
                limits: { dataFileMaxMb: 500 },
            })
        ).status,
    ).toBe(403);
    // Nor the rounds a Dot reply may use (CB-127).
    expect(
        (
            await bob('/api/settings', 'PATCH', {
                limits: { dotModelRounds: 200 },
            })
        ).status,
    ).toBe(403);
    expect(store.settings().limits).toBeUndefined();

    for (const bad of [
        { jobConcurrency: 0 },
        { jobConcurrency: 33 },
        { jobConcurrency: 1.5 },
        { jobConcurrency: '4' },
        { scheduleMinIntervalMinutes: -1 },
        { dataFileMaxMb: 251 },
        { roomCycleSpendUsd: 1.005 },
        { roomCycleSpendUsd: -1 },
        { dotModelRounds: 1 },
        { dotModelRounds: 201 },
        // The turn time limit: 30 to 300 s, whole seconds (CB-123).
        { turnTimeLimitSeconds: 29 },
        { turnTimeLimitSeconds: 301 },
        { turnTimeLimitSeconds: 90.5 },
        { turnTimeLimitSeconds: '90' },
        // The recall budget: 250 to 8,000 tokens, whole ones (CB-173).
        { turnRecallTokens: 249 },
        { turnRecallTokens: 8001 },
        { turnRecallTokens: 1000.5 },
        // Queued messages per chat: 1 to 20 (CB-170).
        { steeringMaxQueued: 0 },
        { steeringMaxQueued: 21 },
        { steeringMaxQueued: 2.5 },
        { unknownLimit: 3 },
    ]) {
        expect((await alice('/api/settings', 'PATCH', { limits: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    // One bad value saves nothing, the good ones with it included.
    expect(
        (
            await alice('/api/settings', 'PATCH', {
                limits: { jobsPerUser: 12, jobConcurrency: 0 },
            })
        ).status,
    ).toBe(400);
    expect(store.settings().limits).toBeUndefined();
    expect(
        (
            await alice('/api/settings', 'PATCH', {
                limits: { roomCycleSpendUsd: 0 },
            })
        ).status,
    ).toBe(200);
    expect(store.settings().limits).toEqual({ roomCycleSpendUsd: 0 });
    expect(
        (
            await alice('/api/settings', 'PATCH', {
                limits: { dotModelRounds: 50 },
            })
        ).status,
    ).toBe(200);
    expect(store.settings().limits).toEqual({
        roomCycleSpendUsd: 0,
        dotModelRounds: 50,
    });
    for (const ok of [30, 300]) {
        expect(
            (
                await alice('/api/settings', 'PATCH', {
                    limits: { turnTimeLimitSeconds: ok },
                })
            ).status,
        ).toBe(200);
    }
    expect(store.settings().limits?.turnTimeLimitSeconds).toBe(300);
});

it('lets only admins change the turn time limit, and the stored value wins over the environment (CB-123)', async () => {
    const { alice, bob, store, platform } = await fixture();
    expect(turnTimeLimitMs(store.settings(), platform.config)).toBe(120_000);
    expect(
        (
            await bob('/api/settings', 'PATCH', {
                limits: { turnTimeLimitSeconds: 60 },
            })
        ).status,
    ).toBe(403);
    expect(turnTimeLimitMs(store.settings(), platform.config)).toBe(120_000);

    await alice('/api/settings', 'PATCH', {
        limits: { turnTimeLimitSeconds: 45 },
    });
    expect(turnTimeLimitMs(store.settings(), platform.config)).toBe(45_000);
    const view = await stateOf(await bob('/api/state'));
    expect(view.limits.turnTimeLimitSeconds).toBe(45);
    expect(view.limitDefaults.turnTimeLimitSeconds).toBe(120);

    // null goes back to the environment's.
    await alice('/api/settings', 'PATCH', {
        limits: { turnTimeLimitSeconds: null },
    });
    expect(turnTimeLimitMs(store.settings(), platform.config)).toBe(120_000);
});

it('puts saved schedule, job and data limits to work at once', async () => {
    const { alice, store, platform } = await fixture();
    expect(platform.schedules.settings.minIntervalMs).toBe(30 * 60_000);
    expect(platform.jobs.settings.concurrency).toBe(3);
    expect(platform.data.limits.fileMaxBytes).toBe(1 * MB);

    const pump = vi.spyOn(platform.jobs, 'pump');
    await alice('/api/settings', 'PATCH', {
        limits: {
            scheduleMinIntervalMinutes: 5,
            schedulesPerUser: 2,
            jobMaxTimeoutSeconds: 1200,
            jobConcurrency: 6,
            jobsPerUser: 3,
            dataFileMaxMb: 8,
            dataDatasetMaxMb: 20,
            dataUserMaxMb: 64,
            dataMaxDatasets: 4,
        },
    });
    // No restart and nothing rebuilt: the same services answer differently.
    expect(platform.schedules.settings).toMatchObject({
        minIntervalMs: 5 * 60_000,
        maxActivePerUser: 2,
    });
    expect(store.scheduleMinGapMs()).toBe(5 * 60_000);
    expect(platform.jobs.settings).toMatchObject({
        maxTimeoutSeconds: 1200,
        concurrency: 6,
        maxJobsPerUser: 3,
        // What isn't a setting keeps its default.
        maxFiles: 20,
    });
    expect(platform.data.limits).toMatchObject({
        fileMaxBytes: 8 * MB,
        datasetMaxBytes: 20 * MB,
        userMaxBytes: 64 * MB,
        maxDatasets: 4,
        // And the ones that aren't settings keep the defaults.
        statementsPerMinute: 120,
    });
    // The views the pages poll show the new values at once, with no reload.
    const data = (await (await alice('/api/data')).json()) as {
        usage: { limits: { fileMaxBytes: number; maxDatasets: number } };
    };
    expect(data.usage.limits).toMatchObject({
        fileMaxBytes: 8 * MB,
        maxDatasets: 4,
    });
    const schedules = (await (await alice('/api/schedules')).json()) as {
        limits: { minIntervalMinutes: number; jobConcurrency: number };
    };
    expect(schedules.limits).toMatchObject({
        minIntervalMinutes: 5,
        jobConcurrency: 6,
    });
    // Jobs waiting for a slot are started when the limit grows.
    expect(pump).toHaveBeenCalled();
    expect(limitsInForce(store.settings(), limitDefaults(platform.config))).toMatchObject({
        jobConcurrency: 6,
    });

    // Back to the server's: the environment's values apply again.
    await alice('/api/settings', 'PATCH', {
        limits: Object.fromEntries(LIMIT_KEYS.map((key) => [key, null])),
    });
    expect(store.settings().limits).toEqual({});
    expect(platform.schedules.settings.minIntervalMs).toBe(30 * 60_000);
    expect(store.scheduleMinGapMs()).toBe(30 * 60_000);
    expect(platform.jobs.settings.concurrency).toBe(3);
    expect(platform.data.limits.fileMaxBytes).toBe(1 * MB);
});

it('lets an upload through once the file limit is raised', async () => {
    const { alice, bob } = await fixture();
    const file = Buffer.alloc(1_500_000, 97);
    const refused = await bob.upload(file, 'big.txt');
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toContain('at most 1 MB');
    await alice('/api/settings', 'PATCH', { limits: { dataFileMaxMb: 2 } });
    expect((await bob.upload(file, 'big.txt')).status).toBeLessThan(300);
    // And lowering it refuses them again.
    await alice('/api/settings', 'PATCH', { limits: { dataFileMaxMb: null } });
    expect((await bob.upload(file, 'big2.txt')).status).toBe(413);
});
