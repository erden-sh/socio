// The backups' service is made by its layer from the tags it reads (`Data`,
// `ObjectStores`, `StorageConfig`, `WorkspaceSettings`, `BackupConfig`,
// `BackupHost`) and offered as `Backups`; the boot step makes the same service
// with the same `makeBackupService`, with `BackupConfig` from the supplied
// startup config, and the restore drill gets the sealed values from the
// composition root.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { ObjectStore } from '@socio/data/object-store';

import { BackupService } from '../src/server/backup/backup-service.js';
import { BackupConfig, Backups, type BackupConfigShape } from '../src/server/backup/contract.js';
import { BackupHost, BackupsLive, makeBackupService } from '../src/server/backup/layer.js';
import { backupConfig, backupSealedValues } from '../src/server/composition/backup.js';
import { Data, type DataSpaceShape } from '../src/server/dataspace/contract.js';
import { GITHUB_SEALED_SQL } from '../src/server/github/infra/sealed.js';
import { INFERENCE_SEALED_SQL } from '../src/server/inference/infra/sqlite/sealed.js';
import { MCP_SEALED_SQL } from '../src/server/mcp/infra/sqlite/sealed.js';
import { NOTIFICATIONS_SEALED_SQL } from '../src/server/notifications/infra/sqlite/sealed.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';
import { ObjectStores, StorageConfig, type ObjectStoresShape } from '../src/server/storage/contract.js';
import { WORKSPACE_SECRETS_SEALED_SQL } from '../src/server/workspace-secrets/infra/sqlite/sealed.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-layer-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const OFFSITE = {
    endpoint: 'https://s3.invalid',
    region: 'auto',
    bucket: 'offsite',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    prefix: 'company-brain/',
};

/** A store whose every call fails with `message`. */
const failing = (driver: 's3' | 'local', message: string): ObjectStore => {
    const fail = () => Promise.reject(new Error(message));
    return { driver, put: fail, get: fail, head: fail, delete: fail, list: fail, ensureReady: fail };
};

function tags(
    { storage = {}, objects = failing('local', 'local store') } = {} as {
        storage?: { s3?: unknown; tenantId?: string };
        objects?: ObjectStore;
    },
) {
    const userData = scratch();
    const config: BackupConfigShape = {
        databasePath: join(scratch(), 'brain.sqlite'),
        settings: { directory: scratch(), keep: 2, intervalHours: 6, continuous: scratch(), offsite: OFFSITE },
        keys: { current: Buffer.alloc(32, 1), legacy: 'legacy-secret' },
        sealed: backupSealedValues,
    };
    let backupSchedule:
        | { intervalHours: number; ltxIntervalSeconds: number; drillIntervalDays: number; purgeBackupDays: number }
        | undefined;
    const settings = { settings: () => ({ backupSchedule }) } as unknown as WorkspaceSettingsShape;
    const s3 = vi.fn<ObjectStoresShape['s3']>(
        () => failing('s3', 'off-site store') as ReturnType<ObjectStoresShape['s3']>,
    );
    const notices: unknown[] = [];
    const lines: string[] = [];
    const layer = Layer.mergeAll(
        Layer.succeed(BackupConfig, config),
        Layer.succeed(Data, { dir: userData, objects } as unknown as DataSpaceShape),
        Layer.succeed(ObjectStores, { local: vi.fn(), s3 } as unknown as ObjectStoresShape),
        Layer.succeed(StorageConfig, { settings: storage as never }),
        Layer.succeed(WorkspaceSettings, settings),
        Layer.succeed(BackupHost, {
            notifyAdmins: async (notice) => void notices.push(notice),
            log: (line) => void lines.push(line),
        }),
    );
    return {
        layer,
        config,
        userData,
        s3,
        notices,
        lines,
        schedule: (next: typeof backupSchedule) => (backupSchedule = next),
    };
}

async function built(layer: ReturnType<typeof tags>['layer']) {
    const runtime = ManagedRuntime.make(BackupsLive.pipe(Layer.provide(layer)));
    cleanup.push(() => runtime.dispose());
    return Context.get(await runtime.context(), Backups) as BackupService;
}

/** The options the service was made with (private to it). */
const optionsOf = (service: BackupService) => (service as unknown as { options: Record<string, unknown> }).options;

it('makes one service from the tags it reads, and offers it as Backups', async () => {
    const t = tags();
    const service = await built(t.layer);
    expect(service).toBeInstanceOf(BackupService);
    const options = optionsOf(service);
    expect(options).toMatchObject({
        databasePath: t.config.databasePath,
        userDataDir: t.userData,
        settings: t.config.settings,
        keys: t.config.keys,
        sealed: backupSealedValues,
    });
    // Local file storage: no object mirror.
    expect(options.objects).toBeUndefined();
    expect(service.drill).toBeDefined();
});

it('reads an admin’s schedule at each use, over BACKUP_*', async () => {
    const t = tags();
    const service = await built(t.layer);
    expect(service.schedule()).toEqual({
        intervalHours: 6,
        ltxIntervalSeconds: 60,
        drillIntervalDays: 30,
        purgeBackupDays: 30,
    });
    t.schedule({ intervalHours: 12, ltxIntervalSeconds: 30, drillIntervalDays: 7, purgeBackupDays: 60 });
    expect(service.schedule()).toEqual({
        intervalHours: 12,
        ltxIntervalSeconds: 30,
        drillIntervalDays: 7,
        purgeBackupDays: 60,
    });
});

it('mirrors the data space’s objects only when they are in S3', async () => {
    const objects = failing('s3', 'data store');
    const t = tags({ storage: { s3: {}, tenantId: 'acme' }, objects });
    const options = optionsOf(await built(t.layer));
    expect(options.objects).toEqual({ store: objects, tenantId: 'acme' });

    // S3 configured, but the data space still on the local disk: no mirror.
    const local = tags({ storage: { s3: {}, tenantId: 'acme' } });
    expect(optionsOf(await built(local.layer)).objects).toBeUndefined();
});

it('opens the off-site copy through storage’s ObjectStores, once', async () => {
    const t = tags();
    const service = await built(t.layer);
    await expect(service.sampleOffsite(1)).rejects.toThrow('off-site store');
    await expect(service.sampleOffsite(1)).rejects.toThrow('off-site store');
    expect(t.s3).toHaveBeenCalledTimes(1);
    expect(t.s3).toHaveBeenCalledWith(OFFSITE);
});

it('tells admins of a failed drill through BackupHost, and logs there', async () => {
    const t = tags();
    const service = await built(t.layer);
    const onDrillFailure = optionsOf(service).onDrillFailure as (result: { error?: string }) => Promise<void>;
    await onDrillFailure({ error: 'The restored database failed its integrity check.' });
    await onDrillFailure({});
    expect(t.notices).toEqual([
        {
            trigger: 'restore_drill',
            title: 'Restore drill failed',
            message: 'The restored database failed its integrity check. See Service setup.',
            path: '/settings/workspace',
        },
        {
            trigger: 'restore_drill',
            title: 'Restore drill failed',
            message: 'A restore from the continuous copy failed. See Service setup.',
            path: '/settings/workspace',
        },
    ]);
    (optionsOf(service).log as (line: string) => void)('a line');
    expect(t.lines).toEqual(['a line']);
});

it('builds BackupConfig from the supplied config, never from process.env', () => {
    vi.stubEnv('SESSION_SECRET', 'from-env');
    vi.stubEnv('LITESTREAM_WAL_WARN_MB', '999');
    const settings = { directory: '/backups', keep: 3, intervalHours: 24 };
    const current = Buffer.alloc(32, 2);
    expect(
        backupConfig({
            database: '/data/brain.sqlite',
            backupSettings: settings,
            dataKeys: { current },
            config: { sessionSecret: 'supplied', walCriticalMb: 2048 },
        }),
    ).toEqual({
        databasePath: '/data/brain.sqlite',
        settings,
        keys: { current, legacy: 'supplied' },
        sealed: backupSealedValues,
        // CB-315: the supplied thresholds over the built-in ones.
        copyAlerts: { copyLagWarnMinutes: 5, copyLagCriticalMinutes: 30, walWarnMb: 256, walCriticalMb: 2048 },
        // CB-458: the per-plugin snapshot cap, PLUGIN_BACKUP_MAX_GB or built in.
        pluginBackupMaxGb: 20,
    });
    // Without a session secret, a placeholder: backups never seal under it.
    expect(backupConfig({ database: 'db', backupSettings: settings, dataKeys: {}, config: {} }).keys).toEqual({
        legacy: 'unused-for-backups',
    });
    vi.unstubAllEnvs();
});

it('gathers every feature’s sealed values, in the drill’s order', () => {
    expect(backupSealedValues).toEqual([
        ...INFERENCE_SEALED_SQL.map((sql) => ['inference-credentials', sql]),
        ...NOTIFICATIONS_SEALED_SQL.map((sql) => ['push-keys', sql]),
        ...GITHUB_SEALED_SQL.map((sql) => ['dispatch-credentials', sql]),
        ['settings-secrets', 'SELECT value AS v FROM secret_settings'],
        ...MCP_SEALED_SQL.map((sql) => ['mcp-credentials', sql]),
        ...WORKSPACE_SECRETS_SEALED_SQL.map((sql) => ['workspace-secrets', sql]),
    ]);
});

it('the boot step’s maker and the layer make the same service from the same parts', () => {
    const t = tags();
    const service = makeBackupService({
        config: t.config,
        data: { dir: t.userData, objects: failing('local', 'local') },
        stores: { s3: t.s3 },
        storage: {},
        schedule: () => ({}),
        host: { notifyAdmins: async () => {}, log: () => {} },
    });
    expect(optionsOf(service)).toMatchObject({ databasePath: t.config.databasePath, sealed: backupSealedValues });
    expect(BackupConfig.key).toBe('socio/backup/BackupConfig');
    expect(BackupHost.key).toBe('socio/backup/BackupHost');
});
