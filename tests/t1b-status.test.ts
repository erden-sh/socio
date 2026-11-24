// The status `Platform` reports, pinned for the PRs that move it:
// `/healthz`'s body (`health()`), `setup()` for the server
// and for a person, what admins see on top (`adminSetup()`), the data key's
// state (`dataKeyStatus()`) and when `statusEpoch()` moves, for a fixed
// config with and without a data key, and with a fake backups service.
import { rmSync } from 'node:fs';

import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { BackupService } from '../src/server/backup/backup-service.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { DataSpaceInstance } from '../src/server/dataspace/layer.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

/** A fixed config: no model, no keys, no runtime; a data key when asked. */
function configWith(dataKey: boolean): Partial<PlatformConfig> {
    return {
        baseUrl: '',
        voiceName: 'marin',
        runtimeUrl: '',
        ...(dataKey ? { dataKeys: { current: Buffer.alloc(32, 7) } } : {}),
    };
}

/** A backups service's status: a fake whose answers the test changes. */
function fakeBackups() {
    const state = {
        status: {
            directory: '/backups',
            keep: 14,
            intervalHours: 24,
            running: false,
            lastAt: '2026-11-07T00:00:00.000Z',
        } as Record<string, unknown>,
    };
    const backups = {
        start: () => undefined,
        stop: () => undefined,
        status: () => state.status,
        sealStates: () => ({ current: 2, previous: 0, legacy: 0, unknown: 0 }),
    } as unknown as BackupService;
    return { backups, state };
}

async function runtimeWith(dataKey: boolean) {
    const built = await makeTestRuntime({ config: configWith(dataKey) });
    cleanup.push(built.dispose);
    built.workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    return built;
}
async function platformWith(dataKey: boolean) {
    return (await runtimeWith(dataKey)).platform;
}

/** Each status as JSON, as the routes send it: the fields' order is pinned too. */
async function statuses(platform: Awaited<ReturnType<typeof platformWith>>) {
    const json = (value: unknown) => JSON.stringify(value, null, 2);
    return {
        health: json(await platform.health()),
        setup: json(await platform.setup()),
        setupForAlice: json(await platform.setup('alice')),
        adminSetup: json(await platform.adminSetup()),
        dataKeyStatus: json(await platform.dataKeyStatus()),
    };
}

it('reports this status without a data key or backups', async () => {
    const platform = await platformWith(false);
    expect(await statuses(platform)).toMatchSnapshot();
});

it('reports this status with a data key and backups', async () => {
    const platform = await platformWith(true);
    platform.useBackups(fakeBackups().backups);
    expect(await statuses(platform)).toMatchSnapshot();
});

it('reports draining in the health check', async () => {
    const platform = await platformWith(false);
    platform.drain();
    expect(await platform.health()).toMatchObject({ ok: true, draining: true });
});

it('moves the status epoch only when what it fingerprints changes', async () => {
    const platform = await platformWith(true);
    const epochs = [platform.statusEpoch()];
    // The same status: the same epoch.
    epochs.push(platform.statusEpoch());
    // Backups set up.
    const { backups, state } = fakeBackups();
    platform.useBackups(backups);
    epochs.push(platform.statusEpoch());
    // A run in progress.
    state.status = { ...state.status, running: true };
    epochs.push(platform.statusEpoch());
    // The continuous copy's times move with every write: not news.
    state.status = { ...state.status, continuous: { behind: false, lastAt: 1 } };
    epochs.push(platform.statusEpoch());
    state.status = { ...state.status, continuous: { behind: false, lastAt: 2 } };
    epochs.push(platform.statusEpoch());
    // Whether it is behind is.
    state.status = { ...state.status, continuous: { behind: true, lastAt: 2 } };
    epochs.push(platform.statusEpoch());
    // An admin's re-seal running, then done.
    const reseal = platform.resealNow('alice');
    epochs.push(platform.statusEpoch());
    await reseal;
    epochs.push(platform.statusEpoch());
    expect(epochs).toEqual([1, 1, 2, 3, 4, 4, 5, 6, 7]);
});

it('counts missing dataset files in the health check and names them only to admins (CB-340)', async () => {
    const built = await runtimeWith(false);
    const space = Context.get(built.edge.services, DataSpaceInstance);
    const lost = space.createDataset('alice', { name: 'Lost' });
    rmSync(space.datasetPath({ id: lost.id, ownerUserId: 'alice' }));
    const health = await built.platform.health();
    expect(health.datasetFiles).toEqual({ missing: 1, warning: expect.stringMatching(/1 registered dataset file/) });
    // `/healthz` is unauthenticated: no dataset ids in it.
    expect(JSON.stringify(health)).not.toContain(lost.id);
    expect((await built.platform.adminSetup()).datasetFiles).toMatchObject({ missing: 1, ids: [lost.id] });
});

it("gives the continuous copy's level only in the health check (CB-315)", async () => {
    const platform = await platformWith(true);
    // No backups set up: nothing to say.
    expect(await platform.health()).not.toHaveProperty('litestream');
    const { backups, state } = fakeBackups();
    platform.useBackups(backups);
    expect((await platform.health()).litestream).toBe('off');
    state.status = {
        ...state.status,
        continuous: { behind: true, lagMs: 1_860_000, walBytes: 2 ** 30, level: 'critical', lastCopiedAt: 1 },
    };
    const health = await platform.health();
    expect(health.litestream).toBe('critical');
    // `/healthz` is unauthenticated: no sizes or times in it.
    expect(JSON.stringify(health)).not.toContain('1860000');
    expect(JSON.stringify(health)).not.toContain(String(2 ** 30));
});
