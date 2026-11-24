import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { backupDirFromEnv } from '../src/server/backup/backup-service.js';
import { exportBundle } from '../src/server/bundle/export.js';
import {
    liveImport,
    liveImportFromCli,
    liveSocketPath,
    adminHere,
    startLiveChannel,
} from '../src/server/bundle/live.js';
import { bundleImports } from '../src/server/bundle/routes.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function setup(limits: { maxRequestBytes?: number; requestTimeoutMs?: number } = {}) {
    // Short: a Unix socket's path has a small limit.
    const dir = mkdtempSync(join(tmpdir(), 'cbl-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const source = testDatabase();
    source
        .prepare(
            "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('i1', 7, 'Seven', 'Body', 'open', 'low', 'bug', 'import', 'web', 1, 1)",
        )
        .run();
    mkdirSync(join(dir, 'backups', 'bundles'), { recursive: true });
    await exportBundle({
        db: source,
        out: join(dir, 'backups', 'bundles', 'first'),
        selection: { issues: [7], spaces: [], pages: [] },
        deny: new Set(['denied']),
        source: { origin: 'https://source.example.test', label: 'SRC', issuePrefix: 'CB' },
        appVersion: '0.40.0',
        readFile: async () => undefined,
    });
    const db = testDatabase();
    const user = db.prepare('INSERT INTO users(id, name, role, createdAt, lastSeenAt) VALUES (?, ?, ?, 1, 1)');
    user.run('op', 'Operator', 'admin');
    user.run('gone', 'Former operator', 'admin');
    user.run('adm', 'Admin', 'admin');
    user.run('mem', 'Member', 'member');
    db.prepare(
        "INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt, appUserId, banned) VALUES ('a-gone', 'Former', 'gone@example.test', 1, 1, 1, 'gone', 1)",
    ).run();
    const snapshot = vi.fn(async () => join(dir, 'copy.sqlite'));
    const log = vi.fn();
    const imports = bundleImports({
        db,
        backupDir: join(dir, 'backups'),
        files: { put: vi.fn() },
        safety: { lastBackupAt: () => Date.now(), snapshot },
        log,
    });
    const base = join(dir, 'run');
    const databasePath = join(dir, 'target.sqlite');
    const channel = await startLiveChannel({
        databasePath,
        imports,
        isAdmin: (id) => adminHere(db, id),
        log,
        base,
        ...limits,
    });
    cleanup.push(() => channel.close());
    const ask = (as: string, input: Record<string, unknown>) =>
        liveImport(databasePath, { as, input: { bundle: 'first', ...input } }, { base });
    return { dir, db, imports, channel, ask, snapshot, log, base, databasePath };
}

it('listens only on a Unix socket, private to the server’s user', async () => {
    const { channel, base, databasePath } = await setup();
    const where = liveSocketPath(databasePath, base);
    // A path in the private directory, never a host and port.
    const address = channel.server.address();
    expect(typeof address).toBe('string');
    expect(String(address).startsWith(`${where.dir}/`)).toBe(true);
    expect(channel.path).toBe(where.path);
    const dir = statSync(where.dir);
    expect(dir.mode & 0o777).toBe(0o700);
    expect(dir.uid).toBe(process.getuid!());
    const socket = statSync(channel.path);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
});

it('refuses anyone but an active admin, and starts nothing', async () => {
    const { ask, imports, snapshot } = await setup();
    for (const as of ['mem', 'gone', 'nobody']) {
        expect(await ask(as, { apply: true }), as).toEqual({ error: '--as must name an admin’s user id.' });
    }
    expect(imports.current()).toBeUndefined();
    expect(snapshot).not.toHaveBeenCalled();
});

it('runs the web import’s code for an admin: a dry run, then an apply recorded as the CLI’s', async () => {
    const { ask, db, snapshot, log } = await setup();
    const dry = await ask('op', {});
    expect(dry.run).toMatchObject({ state: 'done', apply: false, by: 'op', via: 'cli' });
    expect(dry.run?.report?.counts.issue).toEqual({ create: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM issues').get()).toEqual({ n: 0 });

    const applied = await ask('op', { apply: true });
    expect(applied.run).toMatchObject({ state: 'done', apply: true, by: 'op', via: 'cli' });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT number, source FROM issues').get()).toEqual({ number: 7, source: 'import' });
    expect(db.prepare('SELECT startedBy, via FROM import_runs').get()).toEqual({ startedBy: 'op', via: 'cli' });
    expect(log).toHaveBeenCalledWith('Bundle import started: first, by the CLI, for op.');
});

it('keeps the backup check: no recent backup, no apply', async () => {
    const { dir, db, base, databasePath, channel } = await setup();
    await channel.close();
    const imports = bundleImports({
        db,
        backupDir: join(dir, 'backups'),
        files: { put: vi.fn() },
        safety: { lastBackupAt: () => undefined, snapshot: vi.fn() },
        log: () => undefined,
    });
    const again = await startLiveChannel({
        databasePath,
        imports,
        isAdmin: (id) => adminHere(db, id),
        log: () => undefined,
        base,
    });
    cleanup.push(() => again.close());
    const answer = await liveImport(databasePath, { as: 'op', input: { bundle: 'first', apply: true } }, { base });
    expect(answer.run).toMatchObject({ state: 'failed' });
    expect(answer.run?.error).toContain('no full backup in the last 15 minutes');
});

it('runs one import at a time, with the web’s', async () => {
    const { ask, imports } = await setup();
    const web = imports.start({ bundle: 'first' }, 'op', 'web');
    expect(web).toBeDefined();
    const answer = await ask('op', {});
    expect(answer.error).toBe('An import is running. Wait for it to end.');
    await web!.done;
});

it('refuses a request that isn’t one, and a bundle named by path', async () => {
    const { channel, ask } = await setup();
    expect(await ask('op', { bundle: '../outside' })).toEqual({
        error: 'Name a bundle under BACKUP_DIR/bundles/ (letters, digits, . _ -).',
    });
    const raw = await new Promise<string>((resolve) => {
        const socket = createConnection(channel.path);
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (text += chunk));
        socket.on('end', () => resolve(text));
        socket.write('not json\n');
    });
    expect(JSON.parse(raw)).toEqual({ error: 'Name a bundle under BACKUP_DIR/bundles/ (letters, digits, . _ -).' });
});

it('talks only to a private socket of its own user, and says when no server answers', async () => {
    const { base, databasePath, channel, ask } = await setup();
    const { dir } = liveSocketPath(databasePath, base);
    chmodSync(dir, 0o755);
    await expect(ask('op', {})).rejects.toThrow('is open to other users');
    chmodSync(dir, 0o700);
    await channel.close();
    await expect(ask('op', {})).rejects.toThrow('No server answers on this database');
});

it('hands the socket to the newest server, and the older one never removes it', async () => {
    const { db, imports, base, databasePath, channel, ask } = await setup();
    const newer = await startLiveChannel({
        databasePath,
        imports,
        isAdmin: (id) => adminHere(db, id),
        log: () => undefined,
        base,
    });
    cleanup.push(() => newer.close());
    await channel.close();
    expect(statSync(newer.path).isSocket()).toBe(true);
    expect((await ask('op', {})).run).toMatchObject({ state: 'done' });
});

/** Sends raw bytes (in parts, `gapMs` apart) and resolves the answer. */
function send(path: string, parts: Array<string | Buffer>, gapMs = 0) {
    return new Promise<string>((resolve) => {
        const socket = createConnection(path);
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (text += chunk));
        socket.on('end', () => resolve(text));
        socket.on('error', () => resolve(text));
        socket.on('connect', async () => {
            for (const part of parts) {
                if (socket.destroyed) {
                    return;
                }
                socket.write(part);
                if (gapMs) {
                    await new Promise((r) => setTimeout(r, gapMs));
                }
            }
        });
    });
}

it('counts a request’s bytes, newline included, multibyte text too', async () => {
    const { channel, imports } = await setup({ maxRequestBytes: 1000 });
    // 400 characters, 1200 bytes: under the limit in characters, over it in bytes.
    const line = `${JSON.stringify({ as: 'op', input: { bundle: 'first', terms: ['€'.repeat(400)] } })}\n`;
    expect(line.length).toBeLessThan(1000);
    expect(JSON.parse(await send(channel.path, [line]))).toEqual({ error: 'The request is too long.' });
    // All in one chunk with its newline: still counted before it is read.
    const big = `${JSON.stringify({ as: 'op', input: { bundle: 'first', terms: ['x'.repeat(2000)] } })}\n`;
    expect(JSON.parse(await send(channel.path, [big]))).toEqual({ error: 'The request is too long.' });
    expect(imports.current()).toBeUndefined();
});

it('gives the whole request a fixed time, however it trickles in', async () => {
    const { channel, imports } = await setup({ requestTimeoutMs: 300 });
    const answer = await send(channel.path, [' ', ' ', ' ', ' ', ' ', ' ', '{}\n'], 100);
    expect(JSON.parse(answer)).toEqual({ error: 'No request came in time.' });
    expect(imports.current()).toBeUndefined();
});

it('the CLI finds the bundle where the server does, with BACKUP_DIR unset', async () => {
    const { db } = await setup();
    // A server started in `work` with DATABASE_PATH=data/target.sqlite and no BACKUP_DIR reads data/backups/bundles/.
    const work = mkdtempSync(join(tmpdir(), 'cblw-'));
    cleanup.push(() => rmSync(work, { recursive: true, force: true }));
    const source = testDatabase();
    source
        .prepare(
            "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('i1', 7, 'Seven', 'Body', 'open', 'low', 'bug', 'import', 'web', 1, 1)",
        )
        .run();
    mkdirSync(join(work, 'data', 'backups', 'bundles'), { recursive: true });
    await exportBundle({
        db: source,
        out: join(work, 'data', 'backups', 'bundles', 'first'),
        selection: { issues: [7], spaces: [], pages: [] },
        deny: new Set(['denied']),
        source: { origin: 'https://source.example.test', label: 'SRC', issuePrefix: 'CB' },
        appVersion: '0.40.0',
        readFile: async () => undefined,
    });
    const imports = bundleImports({
        db,
        backupDir: join(work, 'data', 'backups'),
        files: { put: vi.fn() },
        safety: { lastBackupAt: () => Date.now(), snapshot: vi.fn() },
        log: () => undefined,
    });
    const channel = await startLiveChannel({
        databasePath: join(work, 'data', 'target.sqlite'),
        imports,
        isAdmin: (id) => adminHere(db, id),
        log: () => undefined,
    });
    cleanup.push(() => channel.close());
    // The CLI's side, as it runs in `work` with no BACKUP_DIR.
    const env = { database: 'data/target.sqlite', backupDir: backupDirFromEnv({}) };
    const answer = await liveImportFromCli('data/backups/bundles/first', env, { as: 'op' }, { cwd: work });
    expect(answer.run).toMatchObject({ state: 'done', apply: false, via: 'cli' });
    // A directory elsewhere (the old guess, next to the database, is the same here: name another) is refused.
    await expect(liveImportFromCli('elsewhere/first', env, { as: 'op' }, { cwd: work })).rejects.toThrow(
        `directly under ${join(work, 'data', 'backups', 'bundles')}`,
    );
    await expect(
        liveImportFromCli(
            'data/backups/bundles/first',
            { ...env, backupDir: backupDirFromEnv({ BACKUP_DIR: '/nowhere' }) },
            { as: 'op' },
            { cwd: work },
        ),
    ).rejects.toThrow('directly under /nowhere/bundles');
});
