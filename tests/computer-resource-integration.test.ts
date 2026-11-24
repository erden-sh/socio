import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { sqliteData } from '@socio/data/open';
import { COMPUTER_RESOURCE_METRICS, type ComputerResourceMetric } from '@socio/shared/computers/computer-resources';

import { SqliteResourceSamples } from '../src/server/operations/infra/sqlite/samples.js';
import { ResourceSampler } from '../src/server/operations/sampler.js';

import { staticAuth } from './fixtures/static-auth.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});
const NOW = Date.UTC(2026, 9, 26),
    DAY = 86400000;
async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb197-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { store, workspace, platform, makeApp, dispose } = await makeTestRuntime({
        config: { data: { userDataDir: dir } },
    });
    cleanup.push(dispose);
    const id = workspace.dots()[0].id;
    // An app per role, bound to the one runtime.
    const app = (role: 'admin' | 'member') => makeApp({ auth: staticAuth({ id: role, name: role, role }) });
    const computer = new SqliteResourceSamples<ComputerResourceMetric>(
        sqliteData(workspace.db),
        id,
        COMPUTER_RESOURCE_METRICS,
    );
    return { store, workspace, platform, id, app, computer };
}
it('persists only current running computer samples and leaves server history separate', async () => {
    const { platform, id, computer, workspace } = await fixture();
    let current = true;
    const stats = {
        botId: id,
        container: 'company-brain-computer-' + id,
        instance: 'fixture-instance',
        running: true,
        values: {
            cpuPercent: 12,
            memoryBytes: 400,
            memoryLimitBytes: 1000,
            volumeBytes: 500,
            containerBytes: 60,
        },
    };
    const reads = vi
        .spyOn(platform.computers, 'resourceReadings')
        .mockImplementation(async () => (current ? [{ dotId: id, stats, current: () => current }] : []));
    const sampler = new ResourceSampler(platform.context);
    await sampler.collect(NOW);
    expect((await computer.latest())?.values).toEqual(stats.values);
    expect((await new SqliteResourceSamples(sqliteData(workspace.db)).latest())?.values.rssBytes).toBeGreaterThan(0);
    current = false;
    await sampler.collect(NOW + 300000);
    expect((await computer.latest())?.at).toBe(NOW);
    expect(reads).toHaveBeenCalledTimes(2);
    await sampler.stop();
});
it('aborts supervisor polling and settles collection before stores close', async () => {
    const { platform, workspace, store } = await fixture();
    let signal: AbortSignal | undefined;
    const polling = vi.spyOn(platform.computers, 'resourceReadings').mockImplementation(async (incoming) => {
        signal = incoming;
        return new Promise((resolve) => incoming!.addEventListener('abort', () => resolve([]), { once: true }));
    });
    const sampler = new ResourceSampler(platform.context);
    const collecting = sampler.collect(NOW);
    await vi.waitFor(() => expect(polling).toHaveBeenCalledTimes(1));
    await sampler.stop();
    await collecting;
    expect(signal?.aborted).toBe(true);
    const previous = workspace.db.prepare('SELECT count(*) n FROM ops_samples').get()?.n;
    await sampler.collect(NOW + 300000);
    expect(workspace.db.prepare('SELECT count(*) n FROM ops_samples').get()?.n).toBe(previous);
    expect(store.settings()).toBeDefined();
});
it('attributes retained OOM attempts per socio and period, with admin-only resource answers', async () => {
    const { workspace, platform, id, app, computer } = await fixture();
    const other = workspace.createDot(workspace.spaces()[0].id, 'Other', 'Other fixture socio.', false, false).id;
    const now = Date.now();
    const addApp = workspace.db.prepare(
        "INSERT INTO apps(id,slug,name,dotId,ownerUserId,port,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,'promoted',?,?)",
    );
    addApp.run('own', 'own', 'Own', id, 'admin', 3001, now, now);
    addApp.run('other', 'other', 'Other', other, 'admin', 3002, now, now);
    const addAttempt = workspace.db.prepare(
        "INSERT INTO app_attempts(appId,attempt,runtimeId,version,kind,state,reason,startedAt,endedAt,updatedAt,log) VALUES (?,?,?,1,'start','failed',?,?,?,?,?)",
    );
    addAttempt.run('own', 1, 'own-1', 'oom', now - 1000, now - 500, now, 'PRIVATE LOG MUST NOT APPEAR');
    addAttempt.run('own', 2, 'own-2', 'exit', now - 1000, now - 500, now, '');
    addAttempt.run('own', 3, 'own-3', 'oom', now - 10 * DAY, now - 10 * DAY, now, '');
    addAttempt.run('other', 1, 'other-1', 'oom', now - 1000, now - 400, now, '');
    expect(await platform.apps.promotions.attempts.oomsByDot(now - DAY, now)).toEqual(
        expect.arrayContaining([
            { dotId: id, count: 1, lastAt: now - 500 },
            { dotId: other, count: 1, lastAt: now - 400 },
        ]),
    );
    await computer.record(
        {
            at: now,
            values: {
                cpuPercent: 0,
                memoryBytes: 10,
                memoryLimitBytes: 0,
                volumeBytes: 20,
                containerBytes: null,
            },
        },
        0,
    );
    vi.spyOn(platform.computers, 'resourceState').mockReturnValue(false);
    expect((await app('member').request('/api/operations/resources/computers')).status).toBe(403);
    const response = await app('admin').request('/api/operations/resources/computers?range=7d&socio=' + id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
        dotId: id,
        running: false,
        appOoms: 1,
        lastAppOomAt: now - 500,
    });
    // No disk usage proxy is configured here (CB-197).
    expect(body.disk).toEqual({
        state: 'off',
        measuredAt: null,
        everyMinutes: 15,
    });
    expect(JSON.stringify(body)).not.toContain('PRIVATE LOG');
    expect((await app('admin').request('/api/operations/resources/computers?range=invalid')).status).toBe(400);
});
