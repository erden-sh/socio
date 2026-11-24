import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { BackupService, backupSettingsFromEnv } from '../src/server/backup/backup-service.js';
import { COPY_BEHIND_MS, continuousCopyStatus, newestCopyAt } from '../src/server/backup/litestream-status.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-litestream-'));
    dirs.push(dir);
    return dir;
}
/** A file at `path` last changed at `at` (ms). */
function touch(path: string, at: number) {
    writeFileSync(path, '');
    utimesSync(path, at / 1000, at / 1000);
}
const NOW = Date.UTC(2026, 9, 19, 12);

function replica(dir: string, files: Record<string, number>) {
    for (const [name, at] of Object.entries(files)) {
        const [level, file] = name.split('/');
        mkdirSync(join(dir, 'ltx', level!), { recursive: true });
        touch(join(dir, 'ltx', level!, file!), at);
    }
}

it("reads each level's newest file by name, across levels", () => {
    const dir = scratch();
    replica(dir, {
        '0/0000000000000009-0000000000000009.ltx': NOW - 2_000,
        // An older name: not looked at, whatever its time.
        '0/0000000000000001-0000000000000001.ltx': NOW,
        '1/0000000000000001-0000000000000008.ltx': NOW - 60_000,
        '9/0000000000000001-0000000000000002.ltx': NOW - 3_600_000,
    });
    expect(newestCopyAt(dir)).toBe(NOW - 2_000);
    expect(newestCopyAt(join(dir, 'missing'))).toBeUndefined();
});

it('is up to date when the newest copy follows the last write', () => {
    const dir = scratch();
    const db = join(scratch(), 'company-brain.sqlite');
    touch(db, NOW - 60_000);
    touch(`${db}-wal`, NOW - 3_000);
    replica(dir, { '0/0000000000000002-0000000000000002.ltx': NOW - 2_000 });
    expect(continuousCopyStatus(dir, db, NOW)).toEqual({
        lastCopiedAt: NOW - 2_000,
        lastWriteAt: NOW - 3_000,
        behind: false,
    });
});

it('is behind when a write is over 5 minutes newer than the newest copy', () => {
    const dir = scratch();
    const db = join(scratch(), 'company-brain.sqlite');
    touch(db, NOW);
    replica(dir, {
        '0/0000000000000002-0000000000000002.ltx': NOW - 10 * 60_000,
    });
    touch(`${db}-wal`, NOW - 10 * 60_000 + COPY_BEHIND_MS - 1_000);
    expect(continuousCopyStatus(dir, db, NOW).behind).toBe(false);
    touch(`${db}-wal`, NOW - 10 * 60_000 + COPY_BEHIND_MS + 1_000);
    expect(continuousCopyStatus(dir, db, NOW)).toEqual({
        lastCopiedAt: NOW - 10 * 60_000,
        lastWriteAt: NOW - 10 * 60_000 + COPY_BEHIND_MS + 1_000,
        behind: true,
    });
});

it('waits for the first copy, then is behind once there is none for 5 minutes', () => {
    const dir = join(scratch(), 'not-yet');
    const db = join(scratch(), 'company-brain.sqlite');
    touch(db, NOW - 60_000);
    touch(`${db}-wal`, NOW - 60_000);
    expect(continuousCopyStatus(dir, db, NOW)).toEqual({
        lastWriteAt: NOW - 60_000,
        behind: false,
    });
    expect(continuousCopyStatus(dir, db, NOW + COPY_BEHIND_MS).behind).toBe(true);
});

it('falls back to the database file without a WAL, and has nothing without either', () => {
    const dir = scratch();
    const db = join(scratch(), 'company-brain.sqlite');
    expect(continuousCopyStatus(dir, db, NOW)).toEqual({ behind: false });
    touch(db, NOW - 1_000);
    expect(continuousCopyStatus(dir, db, NOW).lastWriteAt).toBe(NOW - 1_000);
});

it('takes the replica directory from LITESTREAM_REPLICA_DIR', () => {
    expect(
        backupSettingsFromEnv({ LITESTREAM_REPLICA_DIR: ' /backups/litestream/company-brain ' }, { dataKey: false })
            .continuous,
    ).toBe('/backups/litestream/company-brain');
    expect(backupSettingsFromEnv({}, { dataKey: false }).continuous).toBeUndefined();
});

it('shows admins the continuous copy, and nobody else; null when off', async () => {
    const users: User[] = [
        { id: 'olga', name: 'Olga', role: 'admin' },
        { id: 'bob', name: 'Bob', role: 'member' },
    ];
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            sessionSecret: 'litestream-status-secret-0123456789',
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(users, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    for (const user of users) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return (path: string) => app.request(`/api${path}`, { headers: { cookie } });
    };
    try {
        const olga = await as('olga');
        const read = async () =>
            (await (await olga('/operator/replication')).json()) as {
                continuous: unknown;
            };
        expect(await read()).toEqual({ continuous: null });
        const dir = scratch();
        const db = join(scratch(), 'company-brain.sqlite');
        const now = Date.now();
        touch(`${db}-wal`, now - 3_000);
        replica(dir, { '0/0000000000000002-0000000000000002.ltx': now - 2_000 });
        platform.useBackups(
            new BackupService({
                databasePath: db,
                userDataDir: scratch(),
                settings: {
                    directory: scratch(),
                    keep: 1,
                    intervalHours: 0,
                    continuous: dir,
                },
                log: () => {},
            }),
        );
        expect(await read()).toEqual({
            continuous: {
                lastCopiedAt: now - 2_000,
                lastWriteAt: now - 3_000,
                behind: false,
            },
        });
        expect((await platform.adminSetup()).backup?.continuous?.behind).toBe(false);
        expect((await (await as('bob'))('/operator/replication')).status).toBe(403);
    } finally {
        await dispose();
    }
});
