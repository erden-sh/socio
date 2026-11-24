import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    type Migration,
    openRegistry,
    NO_PUSH,
    REGISTRY_MIGRATIONS,
    RegistryError,
    StoreOpenError,
    workspaceId,
} from '../../src/data';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { sha256 } from '../helpers/store';

// The app-level registry:
// SQLCipher with its own key, secure_delete on, under socio/, opened by the
// fail-closed open and migrated as user.db is.

const KEY = '5d'.repeat(32);
const OTHER_KEY = '6e'.repeat(32);
const ORIGIN = 'https://acme.example.test';

const T0 = Date.UTC(2026, 10, 7, 9);
let clock = T0;
const now = () => clock;

let root: string;
beforeEach(() => {
    clock = T0;
    root = mkdtempSync(join(tmpdir(), 'socio-registry-'));
    mkdirSync(join(root, 'socio'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** `text` is in registry.db or its write-ahead log. */
function onDisk(text: string): boolean {
    return ['registry.db', 'registry.db-wal'].some((name) => {
        const path = join(root, 'socio', name);
        return existsSync(path) && readFileSync(path).includes(text);
    });
}

async function opened(keys = new Map<string, string>()) {
    const driver = createNodeSqliteDriver({ keys });
    return { driver, registry: await openRegistry(driver, root, KEY, now) };
}

const newWorkspace = async (appUserId: string, origin = ORIGIN) => ({
    id: await workspaceId(sha256, origin, appUserId),
    origin,
    appUserId,
    name: 'Acme',
    personName: 'Ada',
    personEmail: 'ada@example.test',
});

describe('openRegistry', () => {
    it('opens socio/registry.db fail-closed, then turns secure_delete and foreign keys on', async () => {
        const { driver, registry } = await opened();
        expect(driver.log.slice(0, 2)).toEqual([
            `registry.db: PRAGMA key = "x'${KEY}'"`,
            'registry.db: PRAGMA busy_timeout = 5000',
        ]);
        expect(driver.log).toContain('registry.db: PRAGMA cipher_status');
        expect(driver.log).toContain('registry.db: PRAGMA journal_mode = WAL');
        expect(driver.log).toContain('registry.db: PRAGMA secure_delete = ON');
        expect(driver.log).toContain('registry.db: PRAGMA foreign_keys = ON');
        expect(driver.openPaths()).toEqual([join(root, 'socio', 'registry.db')]);
        expect(registry.version).toBe(10);
        await registry.close();

        // On the file (real SQLite): WAL, incremental auto-vacuum, version 9.
        const raw = new DatabaseSync(join(root, 'socio', 'registry.db'));
        expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
        expect(raw.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
        expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
        raw.close();
    });

    it('has room for the session, lease and lock state, and the server versions', async () => {
        const raw = await opened();
        await raw.registry.close();
        const db = new DatabaseSync(join(root, 'socio', 'registry.db'));
        const columns = (db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name);
        db.close();
        expect(columns).toEqual([
            'id',
            'origin',
            'appUserId',
            'state',
            'wipeReason',
            'name',
            'logo',
            'personName',
            'personEmail',
            'createdAt',
            'lastUsed',
            'sessionExpiresAt',
            'lastContact',
            'endedAt',
            'leaseLockedAt',
            // Migration 2: the server versions.
            'serverVersion',
            'lowerVersion',
            'lowerSince',
            'lastVersion',
            'versionGate',
            'versionGateVote',
            // Migration 3.
            'unread',
            // Migration 4.
            'waiting',
            'pushRegistrationId',
            'pushKey',
            'pushToken',
            'pushSubscriptionId',
            // Migration 10: the workspace keys.
            'serverWorkspaceId',
            'leaseDays',
            'wipeDays',
            'installSetAt',
        ]);
    });

    it('brings a version-1 file to the last version, keeping its rows, with no server versions, unread or waiting yet', async () => {
        const keys = new Map<string, string>();
        const first = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 1),
        );
        expect(first.version).toBe(1);
        const ada = await newWorkspace('u-1');
        await first.add(ada);
        await first.close();

        const { registry } = await opened(keys);
        expect(registry.version).toBe(10);
        expect(await registry.settings()).toEqual({ advanced: false, haptics: true, appearance: 'system' });
        expect(await registry.get(ada.id)).toMatchObject({
            origin: ORIGIN,
            personEmail: 'ada@example.test',
            unread: null,
            waiting: null,
        });
        expect(await registry.serverVersions(ada.id)).toEqual({
            serverVersion: null,
            lowerVersion: null,
            lowerSince: null,
            lastVersion: null,
            versionGate: null,
            versionGateVote: null,
        });
        await registry.close();
    });

    it('reports a key that doesn’t read it, and leaves the file', async () => {
        const keys = new Map<string, string>();
        const { registry } = await opened(keys);
        await registry.add(await newWorkspace('u-1'));
        await registry.close();
        const error = await openRegistry(createNodeSqliteDriver({ keys }), root, OTHER_KEY).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(StoreOpenError);
        expect(error).toMatchObject({ failure: 'wrong-key' });
        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY);
        expect(await again.list()).toHaveLength(1);
        await again.close();
    });

    it('runs later migrations, which only add', async () => {
        const keys = new Map<string, string>();
        const { registry } = await opened(keys);
        await registry.add(await newWorkspace('u-1'));
        await registry.close();
        const next: Migration[] = [
            ...REGISTRY_MIGRATIONS,
            { version: 11, statements: ['ALTER TABLE workspaces ADD COLUMN later INTEGER'] },
        ];
        const migrated = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now, next);
        expect(migrated.version).toBe(11);
        expect(await migrated.list()).toHaveLength(1);
        await migrated.close();
    });

    it('stays writable when a newer build wrote it: its migrations only add', async () => {
        const keys = new Map<string, string>();
        const next: Migration[] = [
            ...REGISTRY_MIGRATIONS,
            { version: 11, statements: ['ALTER TABLE workspaces ADD COLUMN later INTEGER'] },
        ];
        const newer = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now, next);
        await newer.close();
        const { registry } = await opened(keys);
        expect(registry.version).toBe(11);
        await registry.add(await newWorkspace('u-1'));
        expect(await registry.list()).toHaveLength(1);
        await registry.close();
    });

    it('reports a failed migration, and leaves the file at its version', async () => {
        const keys = new Map<string, string>();
        const { registry, driver } = await opened(keys);
        await registry.close();
        const broken: Migration[] = [...REGISTRY_MIGRATIONS, { version: 11, statements: ['ALTER TABLE nope ADD x'] }];
        const second = createNodeSqliteDriver({ keys });
        await expect(openRegistry(second, root, KEY, now, broken)).rejects.toThrow(RegistryError);
        expect(second.openPaths()).toEqual([]);
        expect(driver.openPaths()).toEqual([]);
        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY);
        expect(again.version).toBe(10);
        await again.close();
    });

    it('keeps the phone’s settings in migration 5: Advanced mode off and haptics on until changed', async () => {
        const keys = new Map<string, string>();
        const { registry } = await opened(keys);
        expect(await registry.settings()).toEqual({ advanced: false, haptics: true, appearance: 'system' });
        expect(await registry.setSettings({ advanced: true })).toEqual({
            advanced: true,
            haptics: true,
            appearance: 'system',
        });
        expect(await registry.setSettings({ haptics: false })).toEqual({
            advanced: true,
            haptics: false,
            appearance: 'system',
        });
        expect(await registry.setSettings({})).toEqual({ advanced: true, haptics: false, appearance: 'system' });
        await registry.close();

        const db = new DatabaseSync(join(root, 'socio', 'registry.db'));
        expect(db.prepare('SELECT slot, advanced, haptics FROM settings').all()).toEqual([
            { slot: 1, advanced: 1, haptics: 0 },
        ]);
        db.close();
        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect(await again.settings()).toEqual({ advanced: true, haptics: false, appearance: 'system' });
        await again.close();
    });

    it('brings a version-4 file to version 5 with the default settings, and a version-4 build still uses a version-5 file', async () => {
        const keys = new Map<string, string>();
        const older = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 4),
        );
        expect(older.version).toBe(4);
        const ada = await newWorkspace('u-1');
        await older.add(ada);
        await older.close();

        const { registry } = await opened(keys);
        expect(registry.version).toBe(10);
        expect(await registry.list()).toHaveLength(1);
        expect(await registry.settings()).toEqual({ advanced: false, haptics: true, appearance: 'system' });
        await registry.setSettings({ advanced: true });
        await registry.close();

        // A build that knows only migrations 1 to 4 opens it writable: the settings table is just there.
        const back = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 4),
        );
        expect(back.version).toBe(10);
        await back.markReady(ada.id);
        expect(await back.get(ada.id)).toMatchObject({ state: 'ready' });
        await back.close();
        const latest = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect(await latest.settings()).toEqual({ advanced: true, haptics: true, appearance: 'system' });
        await latest.close();
    });

    it('keeps the build the app last ran in migration 6, beside the settings', async () => {
        const keys = new Map<string, string>();
        const older = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 5),
        );
        await older.setSettings({ advanced: true });
        await older.close();

        const { registry } = await opened(keys);
        expect(registry.version).toBe(10);
        expect(await registry.lastBuild()).toBeNull();
        await registry.setLastBuild(2828);
        expect(await registry.lastBuild()).toBe(2828);
        await registry.setLastBuild(2829);
        expect(await registry.settings()).toEqual({ advanced: true, haptics: true, appearance: 'system' });
        await expect(registry.setLastBuild(0)).rejects.toThrow(TypeError);
        await expect(registry.setLastBuild(1.5)).rejects.toThrow(TypeError);
        await registry.close();

        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect(await again.lastBuild()).toBe(2829);
        await again.close();
    });

    it('keeps each workspace’s push subscription and the device’s push settings in migration 7', async () => {
        const keys = new Map<string, string>();
        const older = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 6),
        );
        const ada = await newWorkspace('u-1');
        await older.add(ada);
        await older.setLastBuild(7);
        await older.close();

        const { registry } = await opened(keys);
        expect(registry.version).toBe(10);
        expect(await registry.push(ada.id)).toEqual(NO_PUSH);
        expect(await registry.push('f'.repeat(64))).toBeNull();
        expect(await registry.pushDevice()).toEqual({
            showText: true,
            refreshedAt: null,
            askDeclinedAt: null,
            askPromptedAt: null,
        });
        await registry.setPush(ada.id, { registrationId: 'r'.repeat(22), pushKey: 'BKey', nativeToken: 'aa' });
        await registry.setPush(ada.id, { subscriptionId: 's-1' });
        expect(await registry.push(ada.id)).toEqual({
            registrationId: 'r'.repeat(22),
            pushKey: 'BKey',
            nativeToken: 'aa',
            subscriptionId: 's-1',
        });
        await registry.setPush(ada.id, {});
        await registry.setPushDevice({ showText: false });
        await registry.setPushDevice({ refreshedAt: T0 });
        expect(await registry.pushDevice()).toEqual({
            showText: false,
            refreshedAt: T0,
            askDeclinedAt: null,
            askPromptedAt: null,
        });
        // The other settings stay as they were.
        expect(await registry.lastBuild()).toBe(7);
        expect(await registry.settings()).toEqual({ advanced: false, haptics: true, appearance: 'system' });
        await registry.close();

        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect((await again.push(ada.id))?.subscriptionId).toBe('s-1');
        await again.setPush(ada.id, NO_PUSH);
        expect(await again.push(ada.id)).toEqual(NO_PUSH);
        expect(await again.pushDevice()).toEqual({
            showText: false,
            refreshedAt: T0,
            askDeclinedAt: null,
            askPromptedAt: null,
        });
        await again.close();
    });

    it('keeps the notification ask’s Not now and its last system prompt in migration 8', async () => {
        const keys = new Map<string, string>();
        const older = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 7),
        );
        await older.setPushDevice({ showText: false, refreshedAt: T0 });
        await older.close();

        const { registry } = await opened(keys);
        expect(registry.version).toBe(10);
        expect(await registry.pushDevice()).toEqual({
            showText: false,
            refreshedAt: T0,
            askDeclinedAt: null,
            askPromptedAt: null,
        });
        await registry.setPushDevice({ askDeclinedAt: T0 + 5 });
        await registry.setPushDevice({ askPromptedAt: T0 + 9 });
        await registry.close();

        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect(await again.pushDevice()).toEqual({
            showText: false,
            refreshedAt: T0,
            askDeclinedAt: T0 + 5,
            askPromptedAt: T0 + 9,
        });
        await again.close();
    });

    it('keeps Appearance in migration 9: System until the person picks Light or Dark', async () => {
        const keys = new Map<string, string>();
        const older = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 8),
        );
        await older.setSettings({ advanced: true, haptics: false });
        await older.close();

        const { registry } = await opened(keys);
        expect(registry.version).toBe(10);
        expect(await registry.settings()).toEqual({ advanced: true, haptics: false, appearance: 'system' });
        expect(await registry.setSettings({ appearance: 'dark' })).toEqual({
            advanced: true,
            haptics: false,
            appearance: 'dark',
        });
        // Another setting leaves it as it is.
        expect(await registry.setSettings({ haptics: true })).toEqual({
            advanced: true,
            haptics: true,
            appearance: 'dark',
        });
        await expect(registry.setSettings({ appearance: 'sepia' as never })).rejects.toThrow(TypeError);
        await registry.close();

        // A build before migration 9 still writes the row; a value this build doesn't know reads as System.
        const back = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 8),
        );
        await back.setSettings({ advanced: false });
        await back.close();
        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect(await again.settings()).toEqual({ advanced: false, haptics: true, appearance: 'dark' });
        await again.close();
        const db = new DatabaseSync(join(root, 'socio', 'registry.db'));
        db.exec("UPDATE settings SET appearance = 'sepia'");
        db.close();
        const unknown = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect((await unknown.settings()).appearance).toBe('system');
        await unknown.close();
    });

    it('keeps the manifest’s workspace id and lease days in migration 10, which only adds and an older build still uses', async () => {
        const keys = new Map<string, string>();
        // A build before the workspace keys (migrations 1 to 9) adds Ada and reads her row without the new columns.
        const older = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 9),
        );
        expect(older.version).toBe(9);
        const ada = await newWorkspace('u-1');
        await older.add(ada);
        await older.markReady(ada.id);
        expect(await older.get(ada.id)).toMatchObject({ serverWorkspaceId: null, leaseDays: null, wipeDays: null });
        await older.close();

        // This build migrates it: Ada's row is kept, with no manifest (the app's 30 and 30 days).
        const { registry } = await opened(keys);
        expect(registry.version).toBe(10);
        expect(await registry.get(ada.id)).toMatchObject({
            state: 'ready',
            serverWorkspaceId: null,
            leaseDays: null,
            wipeDays: null,
        });
        await registry.setManifest(ada.id, { serverWorkspaceId: 'ws-acme', leaseDays: 14, wipeDays: 7 });
        const bob = await newWorkspace('u-2');
        await registry.add({ ...bob, manifest: { serverWorkspaceId: 'ws-acme', leaseDays: 45, wipeDays: 10 } });
        expect(await registry.get(bob.id)).toMatchObject({ serverWorkspaceId: 'ws-acme', leaseDays: 45, wipeDays: 10 });
        await registry.close();

        // The older build opens the file writable, keeps the columns it doesn't know, and adds a row without them.
        const back = await openRegistry(
            createNodeSqliteDriver({ keys }),
            root,
            KEY,
            now,
            REGISTRY_MIGRATIONS.slice(0, 9),
        );
        expect(back.version).toBe(10);
        const cy = await newWorkspace('u-3');
        await back.add(cy);
        await back.markReady(cy.id);
        await back.setSummary(ada.id, { unread: 3 });
        await back.close();
        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect(await again.get(ada.id)).toMatchObject({
            unread: 3,
            serverWorkspaceId: 'ws-acme',
            leaseDays: 14,
            wipeDays: 7,
        });
        expect(await again.get(cy.id)).toMatchObject({ serverWorkspaceId: null, leaseDays: null, wipeDays: null });
        await again.close();
    });

    it('reads the defaults when the settings row is missing, and writes it back', async () => {
        const keys = new Map<string, string>();
        const { registry } = await opened(keys);
        await registry.close();
        const db = new DatabaseSync(join(root, 'socio', 'registry.db'));
        db.exec('DELETE FROM settings');
        db.close();
        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect(await again.settings()).toEqual({ advanced: false, haptics: true, appearance: 'system' });
        expect(await again.setSettings({ haptics: false })).toEqual({
            advanced: false,
            haptics: false,
            appearance: 'system',
        });
        await again.close();
    });

    it('refuses to open when secure_delete doesn’t take', async () => {
        const driver = createNodeSqliteDriver({
            intercept: (sql) => (/^PRAGMA secure_delete$/i.test(sql.trim()) ? [{ secure_delete: 0 }] : undefined),
        });
        await expect(openRegistry(driver, root, KEY)).rejects.toThrow(/secure_delete did not turn on/);
        expect(driver.openPaths()).toEqual([]);
    });
});

describe('the registry', () => {
    it('adds a workspace as pending, and makes it ready', async () => {
        const { registry } = await opened();
        const ada = await newWorkspace('u-1');
        await registry.add(ada);
        expect(await registry.get(ada.id)).toEqual({
            ...ada,
            state: 'pending',
            wipeReason: null,
            logo: null,
            createdAt: T0,
            lastUsed: T0,
            sessionExpiresAt: null,
            lastContact: null,
            endedAt: null,
            leaseLockedAt: null,
            unread: null,
            waiting: null,
            serverWorkspaceId: null,
            leaseDays: null,
            wipeDays: null,
            installSetAt: null,
        });
        await registry.markReady(ada.id);
        expect(await registry.get(ada.id)).toMatchObject({ state: 'ready' });
        await expect(registry.markReady(ada.id)).rejects.toThrow(RegistryError);
        await registry.close();
    });

    it('holds one row per origin and person, and finds them by origin', async () => {
        const { registry } = await opened();
        const ada = await newWorkspace('u-1');
        const bob = await newWorkspace('u-2');
        const other = await newWorkspace('u-1', 'http://localhost:4352');
        for (const workspace of [ada, bob, other]) {
            await registry.add(workspace);
        }
        await expect(registry.add(ada)).rejects.toThrow();
        await expect(registry.add({ ...ada, id: 'acme.example.test' })).rejects.toThrow(TypeError);
        expect((await registry.byOrigin(ORIGIN)).map((row) => row.appUserId)).toEqual(['u-1', 'u-2']);
        expect(await registry.list()).toHaveLength(3);
        await registry.close();
    });

    it('keeps the active workspace, records when it was used, and takes only a ready one', async () => {
        const { registry } = await opened();
        const ada = await newWorkspace('u-1');
        await registry.add(ada);
        await expect(registry.setActive(ada.id)).rejects.toThrow(RegistryError);
        await registry.markReady(ada.id);
        clock = T0 + 60_000;
        await registry.setActive(ada.id);
        expect(await registry.active()).toBe(ada.id);
        expect(await registry.get(ada.id)).toMatchObject({ lastUsed: T0 + 60_000 });
        await registry.setActive(null);
        expect(await registry.active()).toBeNull();
        await registry.close();
    });

    it('puts the active workspace and lastUsed back for a rolled-back sign-in, without counting a use', async () => {
        const { registry } = await opened();
        const ada = await newWorkspace('u-1');
        const bob = await newWorkspace('u-2');
        for (const workspace of [ada, bob]) {
            await registry.add(workspace);
            await registry.markReady(workspace.id);
        }
        clock = T0 + 60_000;
        await registry.setActive(ada.id);
        clock = T0 + 120_000;
        await registry.setActive(bob.id);

        clock = T0 + 180_000;
        await registry.restoreActive(ada.id, new Map([[bob.id, T0]]));
        expect(await registry.active()).toBe(ada.id);
        expect(await registry.get(ada.id)).toMatchObject({ lastUsed: T0 + 60_000 });
        expect(await registry.get(bob.id)).toMatchObject({ lastUsed: T0 });

        // A row that is gone is skipped; none active is allowed; only a ready workspace can be made active again.
        await registry.restoreActive(null, new Map([['f'.repeat(64), T0]]));
        expect(await registry.active()).toBeNull();
        await registry.markWiping(bob.id, 'sign-out');
        await expect(registry.restoreActive(bob.id)).rejects.toThrow(RegistryError);
        expect(await registry.active()).toBeNull();
        await registry.close();
    });

    it('marks a wipe with its first reason and stops the workspace being active', async () => {
        const { registry } = await opened();
        const ada = await newWorkspace('u-1');
        await registry.add(ada);
        await registry.markReady(ada.id);
        await registry.setActive(ada.id);
        await registry.markWiping(ada.id, 'sign-out');
        await registry.markWiping(ada.id, 'lease');
        expect(await registry.get(ada.id)).toMatchObject({ state: 'wiping', wipeReason: 'sign-out' });
        expect(await registry.active()).toBeNull();
        await expect(registry.setActive(ada.id)).rejects.toThrow(RegistryError);
        await registry.close();
    });

    it('removes a row, and the active mark with it', async () => {
        const { registry } = await opened();
        const ada = await newWorkspace('u-1');
        await registry.add(ada);
        await registry.markReady(ada.id);
        await registry.setActive(ada.id);
        await registry.remove(ada.id);
        expect(await registry.get(ada.id)).toBeNull();
        expect(await registry.active()).toBeNull();
        await registry.close();
    });

    it('removes a row with no copy left in the file or its write-ahead log (secure_delete in WAL mode)', async () => {
        // The test driver writes plain SQLite, so the bytes are there to read; SQLCipher's are under the same key.
        const { registry } = await opened();
        const ada = await newWorkspace('u-1', 'https://acme-secret.example.test');
        await registry.add(ada);
        await registry.markReady(ada.id);
        await registry.setActive(ada.id);
        await registry.markWiping(ada.id, 'sign-out');
        expect(onDisk('acme-secret.example.test')).toBe(true);

        await registry.remove(ada.id);

        // Still open, as the app keeps it.
        for (const marker of ['acme-secret.example.test', 'ada@example.test', ada.id]) {
            expect(onDisk(marker)).toBe(false);
        }
        await registry.close();
    });

    it('a kill between a row’s deletion and the log’s truncation is finished by the next open', async () => {
        const keys = new Map<string, string>();
        let deleted = false;
        const driver = createNodeSqliteDriver({
            keys,
            intercept: (sql) => {
                if (sql.trim().startsWith('DELETE FROM workspaces')) {
                    deleted = true;
                } else if (deleted && /wal_checkpoint/.test(sql)) {
                    throw new Error('killed');
                }
                return undefined;
            },
        });
        const registry = await openRegistry(driver, root, KEY, now);
        const ada = await newWorkspace('u-1', 'https://acme-secret.example.test');
        await registry.add(ada);
        await expect(registry.remove(ada.id)).rejects.toThrow('killed');
        expect(onDisk('acme-secret.example.test')).toBe(true);

        // The killed app's connection never closed; the relaunch opens its own.
        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY, now);
        expect(onDisk('acme-secret.example.test')).toBe(false);
        await again.close();
        await registry.close();
    });

    it('keeps a workspace’s server versions and gate, across a relaunch, and drops them with the row', async () => {
        const keys = new Map<string, string>();
        const { registry } = await opened(keys);
        const ada = await newWorkspace('u-1');
        const bob = await newWorkspace('u-2');
        await registry.add(ada);
        await registry.add(bob);
        const versions = {
            serverVersion: '0.33.0',
            lowerVersion: '0.32.0',
            lowerSince: T0 + 60_000,
            lastVersion: '0.32.0',
            versionGate: 'open',
            versionGateVote: 'closed',
        };
        await registry.setServerVersions(ada.id, versions);
        expect(await registry.serverVersions(ada.id)).toEqual(versions);
        // One workspace's don't touch another's.
        expect(await registry.serverVersions(bob.id)).toMatchObject({ serverVersion: null, versionGate: null });
        await registry.close();

        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY);
        expect(await again.serverVersions(ada.id)).toEqual(versions);
        await again.remove(ada.id);
        expect(await again.serverVersions(ada.id)).toBeNull();
        await expect(again.setServerVersions(ada.id, versions)).rejects.toThrow(RegistryError);
        await again.close();
    });

    it('keeps a workspace’s last contact, across a relaunch, and drops it with the row', async () => {
        const keys = new Map<string, string>();
        const { registry } = await opened(keys);
        const ada = await newWorkspace('u-1');
        const bob = await newWorkspace('u-2');
        await registry.add(ada);
        await registry.add(bob);
        expect((await registry.get(ada.id))?.lastContact).toBeNull();
        await registry.setLastContact(ada.id, T0 + 90_000);
        expect((await registry.get(ada.id))?.lastContact).toBe(T0 + 90_000);
        expect((await registry.get(bob.id))?.lastContact).toBeNull();
        await registry.close();

        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY);
        expect((await again.get(ada.id))?.lastContact).toBe(T0 + 90_000);
        await again.remove(ada.id);
        await expect(again.setLastContact(ada.id, T0)).rejects.toThrow(RegistryError);
        await again.close();
    });

    it('keeps each workspace’s name, unread and waiting writes for the switcher, field by field, and ignores a row that is gone', async () => {
        const keys = new Map<string, string>();
        const { registry } = await opened(keys);
        const ada = await newWorkspace('u-1');
        const bob = await newWorkspace('u-2');
        await registry.add(ada);
        await registry.add(bob);
        await registry.setSummary(ada.id, { unread: 4, name: 'Alpha Works' });
        expect((await registry.get(ada.id))?.unread).toBe(4);
        expect((await registry.get(ada.id))?.name).toBe('Alpha Works');
        expect((await registry.get(bob.id))?.unread).toBeNull();
        expect((await registry.get(bob.id))?.name).toBe('Acme');
        await registry.setSummary(ada.id, { unread: 0 });
        expect((await registry.get(ada.id))?.unread).toBe(0);
        await registry.setSummary(ada.id, { unread: 2 });
        await registry.setSummary(ada.id, { waiting: 3 });
        expect(await registry.get(ada.id)).toMatchObject({ unread: 2, waiting: 3 });
        expect((await registry.get(bob.id))?.waiting).toBeNull();
        await registry.close();

        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY);
        expect(await again.get(ada.id)).toMatchObject({ unread: 2, waiting: 3, name: 'Alpha Works' });
        await again.remove(ada.id);
        await again.setSummary(ada.id, { unread: 1 });
        expect(await again.get(ada.id)).toBeNull();
        await again.close();
    });

    it('keeps its rows across a relaunch', async () => {
        const keys = new Map<string, string>();
        const { registry } = await opened(keys);
        const ada = await newWorkspace('u-1');
        await registry.add(ada);
        await registry.markReady(ada.id);
        await registry.setActive(ada.id);
        await registry.close();
        const again = await openRegistry(createNodeSqliteDriver({ keys }), root, KEY);
        expect(await again.active()).toBe(ada.id);
        expect((await again.list()).map((row) => row.personEmail)).toEqual(['ada@example.test']);
        await again.close();
    });
});
