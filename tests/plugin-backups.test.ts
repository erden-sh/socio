// Plugin backups, step 1 (CB-458): `service.backup` and `ephemeral` in the
// manifest, the catalog's storage warnings, every installed plugin with
// state reported `not_backed_up`, and admins told once when one is flagged
// without a declared backup, then weekly.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import {
    PLUGIN_NOT_BACKED_UP_WARNING,
    PLUGIN_PRIVATE_STORAGE_WARNING,
    pluginBackupMissing,
    pluginBackupStatuses,
    pluginStorageWarnings,
    type PluginBackupInstall,
    type PluginBackupStatus,
} from '@socio/shared/plugins/plugin-backup';
import {
    PluginSpecError,
    checkServiceSpec,
    statefulVolumes,
    type PluginServiceSpec,
} from '@socio/shared/plugins/plugin-service';

import { BackupService } from '../src/server/backup/backup-service.js';
import { makeBackupService } from '../src/server/backup/layer.js';
import {
    PLUGIN_GAP_REMINDER_MS,
    delivered,
    observePluginGaps,
    readPluginGaps,
} from '../src/server/backup/plugin-gaps.js';
import { adminNotices } from '../src/server/composition/app/notices.js';
import { parseManifest } from '../src/server/plugins/catalog.js';
import { pluginRoutes } from '../src/server/plugins/routes.js';
import type { PluginService } from '../src/server/plugins/service.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-backups-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const pinned = `example/plugin@sha256:${'ab'.repeat(32)}`;
const DAY = 24 * 3_600_000;

function manifest(service: Record<string, unknown> = {}, patch: Record<string, unknown> = {}) {
    return {
        id: 'notes',
        name: 'Notes',
        version: '1.0.0',
        author: 'Elsewhere',
        description: 'Keeps notes.',
        display: 'tab',
        permissions: [],
        service: { image: pinned, port: 8080, ...service },
        ...patch,
    };
}

const spec = (patch: Partial<PluginServiceSpec> = {}): PluginServiceSpec => ({ image: pinned, port: 8080, ...patch });

// ── The manifest ─────────────────────────────────────────────────────────

it('accepts service.backup and ephemeral volumes, and refuses a bad protocol, schema or flag', () => {
    expect(() =>
        checkServiceSpec(
            spec({
                volumes: [
                    { name: 'data', mount: '/data' },
                    { name: 'cache', mount: '/cache', ephemeral: true },
                ],
                backup: { protocol: 1, schema: 4 },
            }),
        ),
    ).not.toThrow();
    expect(() => checkServiceSpec(spec({ backup: { protocol: 1, schema: 0 } }))).not.toThrow();
    for (const [backup, why] of [
        [{ protocol: 2, schema: 1 }, /protocol must be 1/],
        [{ schema: 1 }, /protocol must be 1/],
        [{ protocol: '1', schema: 1 }, /protocol must be 1/],
        [{ protocol: 1 }, /schema must be a whole number/],
        [{ protocol: 1, schema: -1 }, /schema must be a whole number/],
        [{ protocol: 1, schema: 1.5 }, /schema must be a whole number/],
        [{ protocol: 1, schema: '4' }, /schema must be a whole number/],
        [{ protocol: 1, schema: 1_000_001 }, /schema must be a whole number/],
        [null, /backup is \{ protocol, schema \}/],
        [[1, 4], /backup is \{ protocol, schema \}/],
    ] as const) {
        expect(() => checkServiceSpec(spec({ backup: backup as never })), JSON.stringify(backup)).toThrow(why);
        expect(() => checkServiceSpec(spec({ backup: backup as never }))).toThrow(PluginSpecError);
    }
    expect(() =>
        checkServiceSpec(spec({ volumes: [{ name: 'cache', mount: '/cache', ephemeral: 'yes' as never }] })),
    ).toThrow(/ephemeral must be true or false/);
});

it('counts every volume not marked ephemeral as state', () => {
    expect(statefulVolumes(undefined)).toEqual([]);
    expect(
        statefulVolumes(
            spec({
                volumes: [
                    { name: 'data', mount: '/data' },
                    { name: 'cache', mount: '/cache', ephemeral: true },
                    { name: 'files', mount: '/files', ephemeral: false },
                ],
            }),
        ).map((volume) => volume.name),
    ).toEqual(['data', 'files']);
});

it('parses service.backup and ephemeral in a catalog manifest, and refuses unknown fields in them', () => {
    const warn = () => undefined;
    const parsed = parseManifest(
        manifest({
            volumes: [
                { name: 'data', mount: '/data' },
                { name: 'cache', mount: '/cache', ephemeral: true },
            ],
            backup: { protocol: 1, schema: 4 },
        }),
        'catalog.json',
        warn,
    );
    expect(parsed.service?.backup).toEqual({ protocol: 1, schema: 4 });
    expect(parsed.service?.volumes?.[1]).toEqual({ name: 'cache', mount: '/cache', ephemeral: true });
    expect(() =>
        parseManifest(manifest({ backup: { protocol: 1, schema: 4, mode: 'cold' } }), 'catalog.json', warn),
    ).toThrow(/service\.backup field mode is not allowed/);
    expect(() => parseManifest(manifest({ backup: 'sdk' }), 'catalog.json', warn)).toThrow(
        /service\.backup must be \{ protocol, schema \}/,
    );
    expect(() => parseManifest(manifest({ backup: { protocol: 1, schema: -2 } }), 'catalog.json', warn)).toThrow(
        /schema must be a whole number/,
    );
    expect(() =>
        parseManifest(manifest({ volumes: [{ name: 'cache', mount: '/cache', ephemeral: 1 }] }), 'catalog.json', warn),
    ).toThrow(/ephemeral must be true or false/);
});

it('warns at catalog load about a volume without service.backup, and about private storage with or without it', () => {
    const load = (service: Record<string, unknown>) => {
        const lines: string[] = [];
        parseManifest(manifest(service), 'catalog.json', (line) => lines.push(line));
        return lines;
    };
    // State and no backup: both warnings, naming the plugin and its volumes.
    const missing = load({
        volumes: [
            { name: 'data', mount: '/data' },
            { name: 'cache', mount: '/cache', ephemeral: true },
        ],
    });
    expect(missing).toHaveLength(2);
    expect(missing[0]).toContain('plugin notes keeps data on volume(s) data without service.backup');
    expect(missing[0]).toContain(PLUGIN_NOT_BACKED_UP_WARNING);
    expect(missing[1]).toContain(PLUGIN_PRIVATE_STORAGE_WARNING);
    // With backup: only private storage, for as long as the entry declares the volume.
    const declared = load({ volumes: [{ name: 'data', mount: '/data' }], backup: { protocol: 1, schema: 1 } });
    expect(declared).toEqual([
        `catalog.json: plugin notes keeps data on volume(s) data. ${PLUGIN_PRIVATE_STORAGE_WARNING}.`,
    ]);
    // Only caches, or no volumes: nothing.
    expect(load({ volumes: [{ name: 'cache', mount: '/cache', ephemeral: true }] })).toEqual([]);
    expect(load({})).toEqual([]);
});

it('lists the catalog’s storage warnings in order, and says when a backup is missing', () => {
    const data = [{ name: 'data', mount: '/data' }];
    expect(pluginStorageWarnings(spec({ volumes: data })).map((w) => w.kind)).toEqual([
        'not_backed_up',
        'private_storage',
    ]);
    expect(pluginStorageWarnings(spec({ volumes: data, backup: { protocol: 1, schema: 1 } }))).toEqual([
        { kind: 'private_storage', message: PLUGIN_PRIVATE_STORAGE_WARNING },
    ]);
    expect(pluginStorageWarnings(spec())).toEqual([]);
    expect(pluginStorageWarnings(undefined)).toEqual([]);
    expect(pluginBackupMissing(spec({ volumes: data }))).toBe(true);
    expect(pluginBackupMissing(spec({ volumes: data, backup: { protocol: 1, schema: 1 } }))).toBe(false);
    expect(pluginBackupMissing(spec({ volumes: [{ name: 'c', mount: '/c', ephemeral: true }] }))).toBe(false);
});

// ── Status ───────────────────────────────────────────────────────────────

const install = (
    id: string,
    service: PluginBackupInstall['manifest']['service'],
    mode: PluginBackupInstall['mode'] = 'service',
): PluginBackupInstall => ({ id, mode, manifest: { name: id.toUpperCase(), service } });

it('reports every installed service plugin with state as not backed up, and no other', () => {
    const statuses = pluginBackupStatuses([
        install('zeta', { volumes: [{ name: 'data', mount: '/data' }] }),
        install('alpha', {
            volumes: [
                { name: 'db', mount: '/db' },
                { name: 'tmp', mount: '/tmp2', ephemeral: true },
            ],
            backup: { protocol: 1, schema: 2 },
        }),
        install('cache-only', { volumes: [{ name: 'cache', mount: '/cache', ephemeral: true }] }),
        install('stateless', {}),
        install('bundled', { volumes: [{ name: 'data', mount: '/data' }] }, 'bundled'),
    ]);
    expect(statuses).toEqual([
        { id: 'alpha', name: 'ALPHA', state: 'not_backed_up', declared: true, volumes: ['db'] },
        { id: 'zeta', name: 'ZETA', state: 'not_backed_up', declared: false, volumes: ['data'] },
    ]);
});

// ── Notices ──────────────────────────────────────────────────────────────

const flagged = (id: string, declared = false): PluginBackupStatus => ({
    id,
    name: id,
    state: 'not_backed_up',
    declared,
    volumes: ['data'],
});

it('notices a plugin once when flagged, again weekly, and forgets it once it declares a backup', () => {
    const t0 = Date.UTC(2026, 10, 21);
    const first = observePluginGaps([flagged('notes'), flagged('declared', true)], {}, t0);
    expect(first.notices.map((n) => [n.id, n.reminder])).toEqual([['notes', false]]);
    expect(first.notices[0]).toMatchObject({ title: 'Not backed up: notes', path: '/settings/plugins/notes' });
    // It names the installed version and the Update that adopts a fixed catalog entry.
    expect(first.notices[0]!.message).toContain('the installed version doesn’t declare backups');
    expect(first.notices[0]!.message).toContain('add service.backup, then apply the plugin’s Update');
    // Flagged, but not noticed until the notice is delivered.
    expect(first.file).toEqual({ notes: { flaggedAt: t0 } });
    const sent = delivered(first.file, first.notices[0]!, t0);
    expect(sent).toEqual({ notes: { flaggedAt: t0, notifiedAt: t0 } });

    // Within the week: nothing.
    const later = observePluginGaps([flagged('notes')], sent, t0 + PLUGIN_GAP_REMINDER_MS - 1);
    expect(later.notices).toEqual([]);
    expect(later.file).toEqual(sent);

    // A week on: a reminder, flagged since the first time.
    const week = observePluginGaps([flagged('notes')], later.file, t0 + PLUGIN_GAP_REMINDER_MS);
    expect(week.notices.map((n) => [n.id, n.reminder, n.title])).toEqual([
        ['notes', true, 'Still not backed up: notes'],
    ]);
    expect(week.file).toEqual(sent);
    expect(delivered(week.file, week.notices[0]!, t0 + PLUGIN_GAP_REMINDER_MS)).toEqual({
        notes: { flaggedAt: t0, notifiedAt: t0 + PLUGIN_GAP_REMINDER_MS },
    });

    // A first notice that never went out is owed again, still as the first.
    const undelivered = observePluginGaps([flagged('notes')], first.file, t0 + DAY);
    expect(undelivered.notices.map((n) => n.reminder)).toEqual([false]);
    expect(undelivered.file).toEqual(first.file);

    // Its entry declares backup (or it was uninstalled): dropped, so a later flag notifies afresh.
    const fixed = observePluginGaps([flagged('notes', true)], week.file, t0 + 8 * DAY);
    expect(fixed).toEqual({ file: {}, notices: [] });
    const again = observePluginGaps([flagged('notes')], fixed.file, t0 + 9 * DAY);
    expect(again.notices.map((n) => n.reminder)).toEqual([false]);
});

it('tells admins through the backups’ check, keeps the record across a restart, and shows since when in status', async () => {
    const directory = scratch();
    let now = Date.UTC(2026, 10, 21, 9);
    let installed: PluginBackupStatus[] = [flagged('notes'), flagged('declared', true)];
    const notices: { trigger: string; title: string; message: string; path: string }[] = [];
    const lines: string[] = [];
    const make = () =>
        makeBackupService({
            config: {
                databasePath: join(directory, 'brain.sqlite'),
                settings: { directory, keep: 2, intervalHours: 0 },
                keys: { legacy: 'unused' },
                sealed: [],
            },
            data: { dir: scratch(), objects: { driver: 'local' } } as never,
            stores: { s3: () => undefined as never },
            storage: { settings: undefined },
            schedule: () => ({}),
            host: {
                notifyAdmins: async (notice) => void notices.push(notice),
                log: (line) => void lines.push(line),
                pluginBackups: () => installed,
            },
        });
    const service = make();
    (service as unknown as { options: { now: () => number } }).options.now = () => now;
    // Before the first check: listed, not yet flagged.
    expect(service.status().plugins).toEqual(installed);

    await service.checkPlugins();
    expect(notices).toEqual([
        expect.objectContaining({
            trigger: 'plugin_backup',
            title: 'Not backed up: notes',
            path: '/settings/plugins/notes',
        }),
    ]);
    expect(lines).toEqual(['Plugin backups: notes keeps data on its own volumes without service.backup.']);
    expect(service.status().plugins).toEqual([{ ...flagged('notes'), since: now }, flagged('declared', true)]);

    // A restart within the week notifies nothing.
    const flaggedAt = now;
    now += DAY;
    const restarted = make();
    (restarted as unknown as { options: { now: () => number } }).options.now = () => now;
    await restarted.checkPlugins();
    expect(notices).toHaveLength(1);

    // A week after the first notice: a reminder.
    now = flaggedAt + PLUGIN_GAP_REMINDER_MS;
    await restarted.checkPlugins();
    expect(notices.map((n) => n.title)).toEqual(['Not backed up: notes', 'Still not backed up: notes']);
    expect(readPluginGaps(directory)).toEqual({ notes: { flaggedAt, notifiedAt: now } });

    // Uninstalled: dropped from status and from the record.
    installed = [];
    await restarted.checkPlugins();
    expect(restarted.status().plugins).toBeUndefined();
    expect(readPluginGaps(directory)).toEqual({});
});

it('sends a notice that failed again with the next check, and records only a delivered one', async () => {
    const directory = scratch();
    const now = Date.UTC(2026, 10, 21, 9);
    let failing = true;
    const attempts: string[] = [];
    const lines: string[] = [];
    const service = new BackupService({
        databasePath: join(directory, 'brain.sqlite'),
        userDataDir: scratch(),
        settings: { directory, keep: 2, intervalHours: 0 },
        plugins: () => [flagged('notes')],
        onPluginGap: async (notice) => {
            attempts.push(notice.title);
            if (failing) {
                throw new Error('notifications are down');
            }
        },
        log: (line) => void lines.push(line),
        now: () => now,
    });
    await service.checkPlugins();
    expect(attempts).toEqual(['Not backed up: notes']);
    expect(readPluginGaps(directory)).toEqual({ notes: { flaggedAt: now } });
    expect(lines.at(-1)).toBe('Plugin backups: the notice about notes failed; it is sent again with the next check.');
    // Flagged in status all the same.
    expect(service.status().plugins).toEqual([{ ...flagged('notes'), since: now }]);

    // The next check (a restart reads the same file) sends it again, as the first notice.
    await service.checkPlugins();
    expect(attempts).toEqual(['Not backed up: notes', 'Not backed up: notes']);
    failing = false;
    await service.checkPlugins();
    expect(attempts).toHaveLength(3);
    expect(readPluginGaps(directory)).toEqual({ notes: { flaggedAt: now, notifiedAt: now } });
    await service.checkPlugins();
    expect(attempts).toHaveLength(3);
});

it('sends a plugin notice again when the admins’ notices adapter reached none of them, as production wires it', async () => {
    const directory = scratch();
    const now = Date.UTC(2026, 10, 21, 9);
    let down = true;
    const attempts: string[] = [];
    const notices = adminNotices({
        workspace: {
            users: () => [
                { id: 'u-admin', name: 'Admin', role: 'admin' },
                { id: 'u-member', name: 'Member', role: 'member' },
                { id: 'u-gone', name: 'Gone', role: 'admin' },
            ],
            deactivatedUsers: () => new Set(['u-gone']),
        } as never,
        notifications: {
            notifyFromApp: async (notice: { userId: string }) => {
                attempts.push(notice.userId);
                if (down) {
                    throw new Error('notifications store is down');
                }
            },
        } as never,
    });
    const service = makeBackupService({
        config: {
            databasePath: join(directory, 'brain.sqlite'),
            settings: { directory, keep: 2, intervalHours: 0 },
            keys: { legacy: 'unused' },
            sealed: [],
        },
        data: { dir: scratch(), objects: { driver: 'local' } } as never,
        stores: { s3: () => undefined as never },
        storage: { settings: undefined },
        schedule: () => ({}),
        host: {
            notifyAdmins: (notice) => notices.notifyAdmins(notice),
            deliverToAdmins: (notice) => notices.deliverToAdmins!(notice),
            log: () => undefined,
            pluginBackups: () => [flagged('notes')],
        },
    });
    (service as unknown as { options: { now: () => number } }).options.now = () => now;
    // notifyAdmins swallows each person's failure; deliverToAdmins counts it.
    await expect(notices.deliverToAdmins!({ trigger: 't', title: 't', message: 'm', path: '/' })).resolves.toEqual({
        sent: 0,
        failed: 1,
    });
    attempts.length = 0;

    await service.checkPlugins();
    await service.checkPlugins();
    expect(attempts).toEqual(['u-admin', 'u-admin']);
    expect(readPluginGaps(directory)).toEqual({ notes: { flaggedAt: now } });

    down = false;
    await service.checkPlugins();
    expect(readPluginGaps(directory)).toEqual({ notes: { flaggedAt: now, notifiedAt: now } });
    await service.checkPlugins();
    expect(attempts).toEqual(['u-admin', 'u-admin', 'u-admin']);
});

it('leaves status and the backup directory alone without plugins (pnpm run backup)', async () => {
    const directory = scratch();
    const service = new BackupService({
        databasePath: join(directory, 'brain.sqlite'),
        userDataDir: scratch(),
        settings: { directory, keep: 2, intervalHours: 0 },
        log: () => undefined,
    });
    await service.checkPlugins();
    expect(service.status().plugins).toBeUndefined();
    expect(existsSync(join(directory, 'plugin-backups.json'))).toBe(false);
});

it('keeps the backups’ status when reading the plugins fails', () => {
    const directory = scratch();
    const service = new BackupService({
        databasePath: join(directory, 'brain.sqlite'),
        userDataDir: scratch(),
        settings: { directory, keep: 2, intervalHours: 6 },
        plugins: () => {
            throw new Error('database is closed');
        },
        log: () => undefined,
    });
    expect(service.status()).toMatchObject({ intervalHours: 6, running: false });
    expect(service.status().plugins).toBeUndefined();
});

// ── The Plugins page's data ──────────────────────────────────────────────

it('gives the Plugins page each catalog entry’s storage warnings and each installed plugin’s backup state', async () => {
    const withState = parseManifest(manifest({ volumes: [{ name: 'data', mount: '/data' }] }), 'c.json', () => {});
    const declared = parseManifest(
        manifest({ volumes: [{ name: 'data', mount: '/data' }], backup: { protocol: 1, schema: 1 } }, { id: 'kept' }),
        'c.json',
        () => {},
    );
    const stateless = parseManifest(manifest({}, { id: 'plain' }), 'c.json', () => {});
    const row = (m: typeof withState) => ({
        id: m.id,
        version: m.version,
        enabled: true,
        display: m.display,
        config: {},
        permissions: [],
        manifest: m,
        replicas: 1,
        audience: 'admins',
        mode: 'service',
        revision: 'a'.repeat(64),
    });
    const plugins = {
        list: () => [row(withState), row(stateless)],
        catalogEntries: () => [withState, declared, stateless],
        status: async () => ({ running: 1, state: 'running' }),
        origin: () => '',
        egress: () => ({ hosts: [], settings: [] }),
        catalogUpdate: () => undefined,
        updateReview: () => undefined,
    } as unknown as PluginService;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', { id: 'u-admin', name: 'Admin', role: 'admin' });
        await next();
    });
    app.route('/api', pluginRoutes(plugins, {} as never));
    const body = (await (await app.request('/api/plugins')).json()) as {
        catalog: { id: string; storageWarnings?: { kind: string }[] }[];
        installed: { id: string; backup?: unknown }[];
    };
    expect(body.catalog.map((entry) => [entry.id, entry.storageWarnings?.map((w) => w.kind)])).toEqual([
        ['notes', ['not_backed_up', 'private_storage']],
        ['kept', ['private_storage']],
        ['plain', undefined],
    ]);
    expect(body.installed).toEqual([
        expect.objectContaining({
            id: 'notes',
            backup: { state: 'not_backed_up', declared: false, volumes: ['data'] },
        }),
        expect.not.objectContaining({ backup: expect.anything() }),
    ]);
});
