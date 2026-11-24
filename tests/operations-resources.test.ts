import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import {
    RESOURCE_METRICS,
    RESOURCE_DEFAULTS,
    type ResourceSample,
    type ResourcePolicy,
    type ResourceValues,
} from '@socio/shared/operations/operations-resources';

import { sqliteNotificationRepositories } from '../src/server/notifications/infra/sqlite/index.js';
import { SqliteResourceSamples } from '../src/server/operations/infra/sqlite/samples.js';
import { operationsSchema } from '../src/server/operations/migrations.js';
import { resourceDefaultsFromEnv, resourcePolicyView } from '../src/server/operations/retention.js';
import { directoryBytes, ResourceSampler } from '../src/server/operations/sampler.js';

import { staticAuth } from './fixtures/static-auth.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const HOUR = 3_600_000,
    DAY = 24 * HOUR,
    NOW = Date.UTC(2026, 9, 25, 12);
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});
const sample = (at: number, values: Partial<ResourceValues> = {}): ResourceSample => ({
    at,
    values: {
        ...Object.fromEntries(Object.keys(RESOURCE_METRICS).map((key) => [key, null])),
        ...values,
    } as ResourceValues,
});
function historyFixture() {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [operationsSchema]);
    return { db, samples: new SqliteResourceSamples(sqliteData(db)) };
}
async function platformFixture(resources: Partial<ResourcePolicy> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb193-resources-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { runtime, store, workspace, platform, makeApp, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            runtimeUrl: '',
            voiceName: 'marin',
            data: { userDataDir: dir },
            operations: { resources: { sampleDays: 9, ...resources } },
        },
    });
    cleanup.push(dispose);
    return {
        dir,
        runtime,
        store,
        workspace,
        platform,
        makeApp,
        samples: new SqliteResourceSamples(sqliteData(workspace.db)),
    };
}

it('rolls up hours idempotently without treating unavailable metrics as zero', async () => {
    const { samples } = historyFixture();
    await samples.record(sample(NOW, { rssBytes: 100, datasetBytes: 999 }), 0);
    await samples.record(sample(NOW + 5 * 60_000, { rssBytes: 300, cpuPercent: 20 }), 0);
    await samples.record(sample(NOW + HOUR, { rssBytes: 500 }), 0);
    await samples.record(sample(NOW, { rssBytes: 100, datasetBytes: 999 }), 0);
    const history = await samples.history(NOW + HOUR, 300);
    expect(history.hourly).toMatchObject([
        {
            at: NOW,
            samples: 2,
            values: {
                rssBytes: 200,
                cpuPercent: 20,
                datasetBytes: 999,
                walBytes: null,
            },
        },
        { at: NOW + HOUR, samples: 1, values: { rssBytes: 500 } },
    ]);
    expect(history.latest?.at).toBe(NOW + HOUR);
    expect(history.gaps).toContainEqual({
        metric: 'walBytes',
        label: RESOURCE_METRICS.walBytes,
        lastAt: null,
        state: 'missing',
    });
    expect(history.gaps.map((gap) => gap.metric)).not.toContain('datasetBytes');
    const stale = await samples.history(NOW + 3 * DAY, 300);
    expect(stale.gaps).toContainEqual(expect.objectContaining({ metric: 'rssBytes', state: 'stale' }));
});

it('retains all history at zero and prunes only resource history at a positive cutoff', async () => {
    const { db, samples } = historyFixture();
    db.exec(
        "CREATE TABLE agent_runs(id TEXT PRIMARY KEY, startedAt INTEGER); INSERT INTO agent_runs VALUES ('original',1)",
    );
    await samples.record(sample(NOW - 500 * DAY, { rssBytes: 1 }), 0);
    await samples.record(sample(NOW - DAY, { rssBytes: 2 }), 0);
    await samples.record(sample(NOW, { rssBytes: 3 }), 0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ops_samples').get()?.n).toBe(3);
    await samples.record(sample(NOW + HOUR, { rssBytes: 4 }), 1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ops_samples').get()?.n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ops_samples_hourly').get()?.n).toBe(2);
    expect(db.prepare('SELECT id FROM agent_runs').all()).toEqual([{ id: 'original' }]);
});

it('uses actual observation times across hourly boundaries and distinguishes old history from no history', async () => {
    const { samples } = historyFixture();
    await samples.record(sample(NOW + 59 * 60_000, { rssBytes: 1 }), 0);
    await samples.record(sample(NOW + HOUR + 60_000), 0);
    const recent = await samples.history(NOW + HOUR + 2 * 60_000, 300);
    expect(recent.gaps.some((gap) => gap.metric === 'rssBytes')).toBe(false);
    // Beyond the bounded hourly display window, the retained observation is stale,
    // rather than being reported as having never existed.
    for (let i = 1; i <= 750; i++) {
        await samples.record(sample(NOW + (i + 1) * HOUR), 0);
    }
    const old = await samples.history(NOW + 752 * HOUR, 300);
    expect(old.gaps).toContainEqual({
        metric: 'rssBytes',
        label: RESOURCE_METRICS.rssBytes,
        lastAt: NOW + 59 * 60_000,
        state: 'stale',
    });
});

it('joins the writer queue and rolls back samples and rollups together', async () => {
    const { db, samples } = historyFixture();
    const { uow } = sqliteData(db);
    await expect(
        uow.run(async () => {
            await samples.record(sample(NOW), 0);
            throw Error('rollback');
        }),
    ).rejects.toThrow('rollback');
    expect(await samples.latest()).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ops_samples_hourly').get()?.n).toBe(0);
});

it('applies validated environment defaults, saved zero values and existing analytics overrides', () => {
    const defaults = resourceDefaultsFromEnv({
        OPS_PAGE_USE_DAYS: '500',
        OPS_SAMPLE_EVERY_SECONDS: '600',
        OPS_FACT_DAYS: '20',
    });
    expect(resourcePolicyView(undefined, defaults).policy).toMatchObject({
        pageUseDays: 500,
        sampleEverySeconds: 600,
        factDays: 20,
        deliveryDays: 400,
        pageSearchDays: 0,
        hourlyDays: 0,
    });
    expect(
        resourcePolicyView(
            {
                resources: { pageUseDays: 0 },
                analytics: { factDays: 0, hourlyDays: 0 },
            },
            defaults,
        ).policy,
    ).toMatchObject({ pageUseDays: 0, factDays: 0, hourlyDays: 0 });
    for (const env of [
        { OPS_SAMPLE_DAYS: '-1' },
        { OPS_PAGE_SEARCH_DAYS: '1.5' },
        { OPS_SAMPLE_EVERY_SECONDS: '0' },
        { OPS_SAMPLE_DAYS: 'NaN' },
    ]) {
        expect(() => resourceDefaultsFromEnv(env)).toThrow();
    }
    expect(resourcePolicyView().policy).toEqual(RESOURCE_DEFAULTS);
});

it('bounds daily filesystem scans and skips symlinks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb193-scan-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'one'), 'abc');
    writeFileSync(join(dir, 'two'), '12345');
    symlinkSync('/etc', join(dir, 'external'));
    expect(await directoryBytes(dir)).toBe(8);
    expect(await directoryBytes(dir, 1)).toBeNull();
    expect(await directoryBytes(join(dir, 'missing'))).toBeNull();
    expect(await directoryBytes(join(dir, 'external'))).toBeNull();
    expect(await directoryBytes(join(dir, 'external') + '/')).toBeNull();
});

it('collects process/system/storage measurements, respects interval, and scans totals once daily', async () => {
    const { dir, platform, samples } = await platformFixture();
    writeFileSync(join(dir, 'proof'), '12345');
    const sampler = new ResourceSampler(platform.context);
    await sampler.collect(NOW);
    const first = await samples.latest();
    expect(first?.values).toMatchObject({
        userdataBytes: 5,
        datasetBytes: 0,
        fileBytes: 0,
        mediaBytes: 0,
        cpuPercent: null,
    });
    expect(first!.values.rssBytes).toBeGreaterThan(0);
    expect(first!.values.databasePages).toBeGreaterThan(0);
    await sampler.collect(NOW + 1000);
    expect((await samples.latest())?.at).toBe(NOW);
    await sampler.collect(NOW + 300_000);
    expect((await samples.latest())?.values).toMatchObject({
        userdataBytes: null,
        datasetBytes: null,
    });
    expect((await samples.latest())!.values.cpuPercent).toBeGreaterThanOrEqual(0);
});

it('guards resource routes and audits admin retention changes without modifying source runs', async () => {
    const { store, workspace, makeApp } = await platformFixture();
    const app = (role: 'admin' | 'member') => makeApp({ auth: staticAuth({ id: role, name: role, role }) });
    const admin = app('admin'),
        member = app('member');
    for (const path of ['/api/operations/resources', '/api/operations/retention']) {
        expect((await member.request(path)).status).toBe(403);
    }
    const put = (body: unknown) => ({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect((await member.request('/api/operations/retention', put({ sampleDays: 0 }))).status).toBe(403);
    expect((await admin.request('/api/operations/retention', put({ sampleDays: -1 }))).status).toBe(400);
    expect((await admin.request('/api/operations/retention', put({ agentRunDays: 1 }))).status).toBe(400);
    const response = await admin.request(
        '/api/operations/retention',
        put({ sampleDays: 0, pageUseDays: 500, factDays: 0, hourlyDays: 0 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        policy: { sampleDays: 0, pageUseDays: 500, factDays: 0, hourlyDays: 0 },
        defaults: { sampleDays: 9 },
    });
    expect(store.settings().operations?.analytics).toMatchObject({
        factDays: 0,
        hourlyDays: 0,
    });
    expect(workspace.auditOf('operations_settings', 'retention')).toMatchObject([
        {
            actor: 'admin',
            action: 'update',
            detail: expect.stringContaining('sampleDays'),
        },
    ]);
    expect((await admin.request('/api/operations/retention', put({ sampleDays: null }))).status).toBe(200);
    expect((await (await admin.request('/api/operations/retention')).json()).policy.sampleDays).toBe(9);
    const history = await (await admin.request('/api/operations/resources')).json();
    expect(history.latest).toBeNull();
    expect(history.gaps).toHaveLength(Object.keys(RESOURCE_METRICS).length);
});

it('prunes delivery history separately while zero retains notifications and in-app notices', async () => {
    const { store, workspace, platform } = await platformFixture();
    const repos = sqliteNotificationRepositories(sqliteData(workspace.db));
    const old = NOW - 500 * DAY;
    await repos.notifications.insert(
        'old',
        {
            userId: 'alice',
            dotId: null,
            threadId: null,
            trigger: 'chat',
            causeId: null,
            title: 'Kept',
            message: 'History',
            link: '/',
            imageToken: null,
            presence: 'away',
        },
        old,
    );
    await repos.notifications.addDelivery({
        notificationId: 'old',
        channel: 'push',
        target: 'fixture',
        outcome: 'sent',
        error: null,
        at: old,
    });
    await repos.inApp.insert({
        id: 'notice',
        userId: 'alice',
        notificationId: 'old',
        title: 'Kept',
        body: 'History',
        link: '/',
        createdAt: old,
    });
    const count = (table: string) => workspace.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;
    await store.updateSettings({
        operations: {
            resources: { deliveryDays: 0, notificationDays: 0, noticeDays: 0 },
        },
    });
    await platform.notifications.prune(NOW);
    expect(count('notification_deliveries')).toBe(1);
    await store.updateSettings({
        operations: {
            resources: { deliveryDays: 400, notificationDays: 0, noticeDays: 0 },
        },
    });
    await platform.notifications.prune(NOW);
    expect(count('notification_deliveries')).toBe(0);
    expect(count('notifications')).toBe(1);
    expect(count('notification_in_app')).toBe(1);
    await store.updateSettings({
        operations: { resources: { notificationDays: 400, noticeDays: 400 } },
    });
    await platform.notifications.prune(NOW);
    expect(count('notifications')).toBe(0);
    expect(count('notification_in_app')).toBe(0);
});

it('keeps delivery audit at zero when notification records expire under a separate policy', async () => {
    const { store, workspace, platform } = await platformFixture();
    const repos = sqliteNotificationRepositories(sqliteData(workspace.db));
    await repos.notifications.insert(
        'expired',
        {
            userId: 'alice',
            dotId: null,
            threadId: null,
            trigger: 'chat',
            causeId: null,
            title: 'Expire',
            message: 'Record',
            link: '/',
            imageToken: null,
            presence: 'away',
        },
        NOW - 500 * DAY,
    );
    await repos.notifications.addDelivery({
        notificationId: 'expired',
        channel: 'push',
        target: 'fixture',
        outcome: 'sent',
        error: null,
        at: NOW - 500 * DAY,
    });
    await store.updateSettings({
        operations: { resources: { notificationDays: 400, deliveryDays: 0 } },
    });
    await platform.notifications.prune(NOW);
    expect(workspace.db.prepare('SELECT COUNT(*) n FROM notifications').get()?.n).toBe(0);
    expect(workspace.db.prepare('SELECT COUNT(*) n FROM notification_deliveries').get()?.n).toBe(1);
});

it('audits explicit zero and inheritance separately while identical saves and inherited resets are no-ops', async () => {
    const { store, workspace, makeApp } = await platformFixture({
        pageSearchDays: 0,
        factDays: 0,
        hourlyDays: 0,
    });
    const app = makeApp({ auth: staticAuth({ id: 'admin', name: 'Admin', role: 'admin' }) });
    const writes = vi.spyOn(store.slices.settings, 'updateSettings');
    const change = async (key: string, value: number | null) => {
        const response = await app.request('/api/operations/retention', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value }),
        });
        expect(response.status).toBe(200);
        expect((await response.json()).policy[key]).toBe(0);
    };
    const audit = () => workspace.auditOf('operations_settings', 'retention');
    let expectedChanges = 0;
    for (const key of ['pageSearchDays', 'factDays', 'hourlyDays']) {
        // Resetting an inherited default must not create empty override maps or
        // an audit event; an explicit override with that same value must.
        await change(key, null);
        expect(audit()).toHaveLength(expectedChanges);
        expect(writes).toHaveBeenCalledTimes(expectedChanges);
        await change(key, 0);
        expectedChanges++;
        expect(audit()).toHaveLength(expectedChanges);
        const section = key === 'pageSearchDays' ? 'resources' : 'analytics';
        expect(store.settings().operations?.[section]).toHaveProperty(key, 0);
        await change(key, 0);
        expect(audit()).toHaveLength(expectedChanges);
        expect(writes).toHaveBeenCalledTimes(expectedChanges);
        await change(key, null);
        expectedChanges++;
        expect(audit()).toHaveLength(expectedChanges);
        expect(store.settings().operations?.[section] ?? {}).not.toHaveProperty(key);
        await change(key, null);
        expect(audit()).toHaveLength(expectedChanges);
        expect(writes).toHaveBeenCalledTimes(expectedChanges);
    }
    for (const entry of audit()) {
        expect(entry.actor).toBe('admin');
        const detail = JSON.parse(entry.detail);
        expect(detail.before).toEqual(detail.after);
        expect(Object.keys(detail.change)).toHaveLength(1);
    }
    expect(store.settings().operations).toEqual({});
});

it('queues retention changes on the shared connection and rolls settings back when auditing fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb193-policy-atomic-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { db, store, workspace, makeApp, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            runtimeUrl: '',
            voiceName: 'marin',
            data: { userDataDir: dir },
        },
    });
    cleanup.push(dispose);
    const app = makeApp({ auth: staticAuth({ id: 'admin', name: 'Admin', role: 'admin' }) });
    const put = (body: unknown) =>
        app.request('/api/operations/retention', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    let opened!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        opened = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const held = sqliteData(db).uow.run(async () => {
        opened();
        await gate;
        throw Error('Other write rolled back');
    });
    const rejected = expect(held).rejects.toThrow('Other write rolled back');
    await entered;
    const pending = put({ pageSearchDays: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.settings().operations?.resources?.pageSearchDays).toBeUndefined();
    expect(workspace.auditOf('operations_settings', 'retention')).toHaveLength(0);
    release();
    await rejected;
    expect((await pending).status).toBe(200);
    expect(store.settings().operations?.resources?.pageSearchDays).toBe(0);
    expect(workspace.auditOf('operations_settings', 'retention')).toHaveLength(1);

    const before = store.settings();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(workspace.slices.audit, 'audit').mockImplementationOnce(() => {
        throw Error('Audit unavailable');
    });
    expect((await put({ factDays: 0 })).status).toBe(500);
    expect(store.settings()).toEqual(before);
    expect(workspace.auditOf('operations_settings', 'retention')).toHaveLength(1);
});
