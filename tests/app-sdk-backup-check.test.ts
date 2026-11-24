import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    assertBackup,
    checkBackup,
    isSnapshotId,
    newSnapshotId,
    type BackupCheckOptions,
} from '../packages/app-sdk/src/backup-check.js';
import type { BackupHandler } from '../packages/app-sdk/src/backup.js';
import { socioApp, type BackupServeOptions } from '../packages/app-sdk/src/index.js';

// CB-458 step 4: the backup conformance kit, run against the SDK's default
// handler (in process and over loopback, as a plugin's CI would), and against
// plugins that break the protocol, so a pass means something.

const KEY = randomBytes(32).toString('base64url');
const PLUGIN = 'acme-notes';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const volume = () => {
    const dir = mkdtempSync(join(tmpdir(), 'acme-kit-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

/** A volume like a real plugin's: a WAL database in use, uploads, and a secret the default handler skips. */
const acmeVolume = () => {
    const data = volume();
    const db = new DatabaseSync(join(data, 'app.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)');
    db.prepare('INSERT INTO notes(body) VALUES (?)').run('Ada’s first note');
    cleanup.push(() => db.close());
    mkdirSync(join(data, 'uploads'));
    writeFileSync(join(data, 'uploads/logo.png'), randomBytes(2048));
    writeFileSync(join(data, 'empty.txt'), '');
    writeFileSync(join(data, 'server.key'), 'secret');
    return data;
};

const plugin = (data: string, env: Record<string, string> = {}, over: Partial<BackupServeOptions> = {}) => {
    const exit = vi.fn();
    const socio = socioApp({ appId: `plugin:${PLUGIN}`, key: KEY, env });
    const served = socio.backup.serve({ volumes: { data }, schemaVersion: 2, exit, ...over });
    cleanup.push(() => served.close());
    const app = socio.fetchHandler(() => new Response('acme app'));
    return { socio, served, exit, app };
};

const base = (app: BackupCheckOptions['app']): BackupCheckOptions => ({
    pluginId: PLUGIN,
    key: KEY,
    app,
    volumes: ['data'],
    schema: 2,
    write: { method: 'POST', path: '/notes', body: '{"body":"Acme"}' },
    timeoutMs: 10_000,
});

const failures = (results: Awaited<ReturnType<typeof checkBackup>>) =>
    results.filter((result) => !result.ok).map((result) => result.name);

describe('newSnapshotId', () => {
    it('makes ULIDs, distinct each time', () => {
        const a = newSnapshotId();
        expect(isSnapshotId(a)).toBe(true);
        expect(a).not.toBe(newSnapshotId());
        expect(isSnapshotId('acme-1')).toBe(false);
    });
});

describe('the kit against plugins that break the protocol', () => {
    it('fails a plugin that answers every backup call without checking who calls', async () => {
        const open = async (request: Request) =>
            new URL(request.url).pathname === '/__cb/backup'
                ? Response.json({ snapshotId: 'x' }, { status: 202 })
                : new Response('ok');
        const results = await checkBackup({ ...base(open), write: undefined });
        expect(failures(results)).toEqual(
            expect.arrayContaining([
                'no envelope on /__cb/backup: 401',
                "a person's envelope on /__cb/backup: 401",
                "another plugin's host envelope: 401",
                'a host envelope under another key: 401',
                'a replayed host envelope: 401',
                'begin with a snapshot id that is not a ULID: 400',
                'a quiesced begin without a hold: 409',
            ]),
        );
        await expect(assertBackup({ ...base(open), write: undefined })).rejects.toThrow(
            /does not keep the backup protocol:\n- no envelope on \/__cb\/backup: 401: got 202/,
        );
    });

    it('fails a plugin whose items are not the bytes its manifest names', async () => {
        const handler: BackupHandler = {
            begin: () => ({ items: [{ volume: 'data', path: 'export.bin', kind: 'file' }] }),
            // Hashed once as listed, then different bytes when fetched.
            openItem: (() => {
                let reads = 0;
                return () => [Buffer.from(reads++ === 0 ? 'acme export' : 'acme EXPORT')];
            })(),
            end: () => undefined,
        };
        const { app } = plugin(volume(), {}, { handler });
        expect(failures(await checkBackup(base(app)))).toContain('every item and chunk is the bytes its hashes name');
    });

    it('fails a plugin that keeps writing while held', async () => {
        const { app } = plugin(acmeVolume(), {}, { writing: () => false });
        expect(failures(await checkBackup(base(app)))).toEqual(
            expect.arrayContaining([
                'a write while held: 503 with Retry-After',
                "writes stay held after the snapshot's DELETE",
            ]),
        );
    });

    it('fails a plugin whose manifest the workspace would refuse', async () => {
        const handler: BackupHandler = {
            begin: () => ({ items: [{ volume: 'data', path: 'export.bin', kind: 'file' }], schemaVersion: 9 }),
            openItem: () => [Buffer.from('acme')],
            end: () => undefined,
        };
        // The SDK refuses to answer such a manifest at all: the snapshot fails.
        const { app } = plugin(volume(), {}, { handler });
        expect(failures(await checkBackup(base(app)))).toContain('a snapshot: becomes ready');
    });
});

describe('the kit against the SDK’s default handler', () => {
    it('signs each envelope from one clock reading, so a clock that moves between reads never fails it (CB-458)', async () => {
        const { app } = plugin(acmeVolume());
        // Each read a millisecond later, as a loaded machine can give it.
        let at = Date.now();
        const results = await checkBackup({ ...base(app), now: () => at++ });
        const failed = failures(results);
        expect(failed).not.toContain('every item is taken');
        expect(failed.filter((name) => name.startsWith('a snapshot'))).toEqual([]);
    });

    it('passes in process, restore included', async () => {
        const data = acmeVolume();
        const { app } = plugin(data);
        const restores: string[] = [];
        const results = await assertBackup({
            ...base(app),
            restore: (snapshotId) => {
                const target = volume();
                restores.push(target);
                const restoring = plugin(target, { CB_RESTORE_SNAPSHOT: snapshotId, CB_RESTORE_HOLD: snapshotId });
                expect(restoring.served.restoreMode).toBe(true);
                return {
                    app: restoring.app,
                    committed: () => restoring.exit.mock.calls.length > 0,
                };
            },
        });
        expect(results.length).toBeGreaterThan(25);
        expect(results.map((result) => result.name)).toContain('the restore ends (the task exits 0)');
        expect(existsSync(join(restores[0], 'uploads/logo.png'))).toBe(true);
        expect(existsSync(join(restores[0], 'server.key'))).toBe(false);
    });

    it('passes over loopback, as a plugin in any language would be checked', async () => {
        const listen = async (server: Server) => {
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
            return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        };
        const { socio } = plugin(acmeVolume());
        const url = await listen(
            createServer(
                socio.node((_request, response) => {
                    response.writeHead(200);
                    response.end('acme app');
                }),
            ),
        );
        await assertBackup({
            ...base(url),
            restore: async (snapshotId) => {
                const restoring = plugin(volume(), { CB_RESTORE_SNAPSHOT: snapshotId });
                const server = await restoring.served.listenForRestore({ port: 0, host: '127.0.0.1' });
                return {
                    app: `http://127.0.0.1:${server.port}`,
                    committed: () => restoring.exit.mock.calls.length > 0,
                    stop: () => server.close(),
                };
            },
        });
    });
});
