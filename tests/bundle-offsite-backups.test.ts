import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { backupDirFromEnv, backupSettingsFromEnv } from '../src/server/backup/backup-service.js';
import { exportBundle } from '../src/server/bundle/export.js';

import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// v0.41.1 crashed at startup on every site with off-site backups: the bundle
// routes (CB-380) read BACKUP_DIR through the full backup settings, which
// refuse BACKUP_S3_ENDPOINT without the data key. This boots the whole app
// with a site's off-site backup settings and no DATA_ENCRYPTION_KEY, and
// checks that an import's apply reads the backup status where the backup
// writes it.

const ORIGIN = 'https://socio.example';
const USERS: User[] = [{ id: 'olga', name: 'Olga', role: 'admin' }];
const cleanup: (() => Promise<void> | void)[] = [];
let dir: string;
let backupDir: string;
const savedKey = process.env.DATA_ENCRYPTION_KEY;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-bundle-offsite-'));
    backupDir = join(dir, 'backups');
    mkdirSync(join(backupDir, 'bundles'), { recursive: true });
    delete process.env.DATA_ENCRYPTION_KEY;
    // What the site files set (sites/*.json in the provisioning repo).
    vi.stubEnv('BACKUP_DIR', backupDir);
    vi.stubEnv('BACKUP_S3_ENDPOINT', 'https://s3.example.invalid');
    vi.stubEnv('BACKUP_S3_CREDENTIALS', JSON.stringify({ accessKeyId: 'fake-id', secretAccessKey: 'fake-secret' }));
    vi.stubEnv('BACKUP_S3_BUCKET', 'socio-backups');
    vi.stubEnv('BACKUP_S3_PREFIX', 'socio/');
    vi.stubEnv('BACKUP_INTERVAL_HOURS', '6');
});
afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) {
        await step();
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (savedKey !== undefined) {
        process.env.DATA_ENCRYPTION_KEY = savedKey;
    }
    rmSync(dir, { recursive: true, force: true });
});

async function boot() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, dispose } = await makeTestRuntime({
        database: join(dir, 'app.sqlite'),
        config: { baseUrl: 'https://model.invalid/v1' },
        app: {
            config: { mode: 'live', baseUrl: '' },
            origin: ORIGIN,
            auth: { provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    const login = await app.request(`${ORIGIN}/api/auth/mock/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ userId: 'olga' }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const call = (method: string, path: string, body?: unknown) =>
        app.request(`${ORIGIN}${path}`, {
            method,
            headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    return { call };
}

async function writeBundle() {
    const source = testDatabase();
    source
        .prepare(
            "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('i1', 7, 'Seven', 'Body', 'open', 'low', 'bug', 'import', 'web', 1, 1)",
        )
        .run();
    await exportBundle({
        db: source,
        out: join(backupDir, 'bundles', 'first'),
        selection: { issues: [7], spaces: [], pages: [] },
        deny: new Set(['denied']),
        source: { origin: 'https://source.example.test', label: 'SRC', issuePrefix: 'CB' },
        appVersion: '0.41.1',
        readFile: async () => undefined,
    });
    source.close();
}

/** The status file the backup writes after a full run (`backup-status.json`). */
const backedUpAt = (time: number) =>
    writeFileSync(join(backupDir, 'backup-status.json'), JSON.stringify({ lastSuccessAt: time }));

async function apply(call: Awaited<ReturnType<typeof boot>>['call']) {
    const started = await call('POST', '/api/operator/bundles/import', { bundle: 'first', apply: true });
    expect(started.status).toBe(202);
    for (let i = 0; i < 200; i++) {
        const { run } = (await (await call('GET', '/api/operator/bundles/import')).json()) as {
            run: { state: string; error?: string; report?: { backupPath?: string } };
        };
        if (run.state !== 'running') {
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The import did not end.');
}

it('reads the bundle backup directory where the backup writes, with off-site backups on', () => {
    // backup-service and backup-cli write the status and local copies in
    // settings.directory, off-site or not.
    expect(backupSettingsFromEnv(process.env, { dataKey: true }).directory).toBe(backupDir);
    expect(backupDirFromEnv(process.env)).toBe(backupDir);
    expect(backupDirFromEnv({})).toBe(backupSettingsFromEnv({}, { dataKey: false }).directory);
    expect(backupDirFromEnv({ BACKUP_DIR: '  /b  ' })).toBe('/b');
});

it('boots with off-site backups and no data key in the environment, and lists bundles', async () => {
    await writeBundle();
    const { call } = await boot();
    const listed = await call('GET', '/api/operator/bundles');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ bundles: [expect.objectContaining({ name: 'first' })] });
});

it('applies an import after a fresh backup, with off-site backups on', async () => {
    await writeBundle();
    backedUpAt(Date.now() - 60_000);
    const { call } = await boot();
    const run = await apply(call);
    expect(run.error).toBeUndefined();
    expect(run.state).toBe('done');
    expect(run.report?.backupPath?.startsWith(join(backupDir, 'import-'))).toBe(true);
});

it('refuses to apply without a backup, or after a stale one, with off-site backups on', async () => {
    await writeBundle();
    const { call } = await boot();
    const missing = await apply(call);
    expect(missing.state).toBe('failed');
    expect(missing.error).toMatch(/no full backup in the last 15 minutes/);

    backedUpAt(Date.now() - 20 * 60_000);
    const stale = await apply(call);
    expect(stale.state).toBe('failed');
    expect(stale.error).toMatch(/no full backup in the last 15 minutes/);
});
