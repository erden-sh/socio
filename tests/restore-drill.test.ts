import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { BackupService, backupFailure, backupSettingsFromEnv } from '../src/server/backup/backup-service.js';
import {
    DRILL_WINDOW_MS,
    RestoreDrill,
    compareCounts,
    drillPoint,
    restorableSpan,
    restoreArgs,
    runRestoreDrill,
} from '../src/server/backup/restore-drill.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';

import { startFakeS3 } from './fixtures/fake-s3.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// The restore drill (CB-111): a fake `litestream` that "restores" by
// copying a database, a replica of framed LTX files and a loopback fake
// S3. The real Litestream is never run here.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const scratch = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), name));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const hex = (n: number) => n.toString(16).padStart(16, '0');
/** An LTX file as Litestream 0.5 frames one, dated `at`. */
function ltx(min: number, max: number, at: number) {
    const body = Buffer.alloc(100 + 64 + 16);
    body.write('LTX1', 0, 'ascii');
    body.writeBigUInt64BE(BigInt(min), 16);
    body.writeBigUInt64BE(BigInt(max), 24);
    body.writeBigInt64BE(BigInt(at), 32);
    return body;
}
function writeLtx(replica: string, level: number, min: number, max: number, at: number) {
    const dir = join(replica, 'ltx', String(level));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${hex(min)}-${hex(max)}.ltx`), ltx(min, max, at));
}

/** A database with `tables` rows each; WAL, as the live one. */
function database(path: string, tables: Record<string, number>) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('BEGIN');
    for (const [table, rows] of Object.entries(tables)) {
        db.exec(`CREATE TABLE IF NOT EXISTS "${table}"(id INTEGER PRIMARY KEY)`);
        db.exec(`DELETE FROM "${table}"`);
        const insert = db.prepare(`INSERT INTO "${table}" DEFAULT VALUES`);
        for (let i = 0; i < rows; i++) {
            insert.run();
        }
    }
    db.exec('COMMIT');
    db.close();
}

/**
 * A stand-in `litestream`: logs its arguments, then copies `source` (or,
 * for a replica under `offsite`, `offsiteSource`) to `-o`, or fails as
 * told. It gets nothing of the environment but PATH, as the real one.
 */
function fakeLitestream(
    dir: string,
    options: {
        source: string;
        offsiteSource?: string;
        failPoint?: boolean;
    },
) {
    const bin = join(dir, 'litestream');
    const log = join(dir, 'litestream.log');
    writeFileSync(
        bin,
        `#!/bin/sh
echo "$@" >> '${log}'
env | grep -v '^PATH=' | grep -v '^PWD=' | grep -v '^SHLVL=' | grep -v '^_=' >> '${log}.env'
out=""; prev=""; url=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; url="$a"; done
case "$*" in *-timestamp*) ${options.failPoint ? `echo 'time=x level=INFO msg="restoring"' >&2; echo "Error: timestamp does not exist" >&2; exit 1` : ':'} ;; esac
case "$url" in *offsite*) cp '${options.offsiteSource ?? options.source}' "$out" ;; *) cp '${options.source}' "$out" ;; esac
`,
    );
    chmodSync(bin, 0o755);
    return {
        bin,
        calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
        env: () => (existsSync(`${log}.env`) ? readFileSync(`${log}.env`, 'utf8').trim() : ''),
    };
}

/** A live database, a replica of LTX files and a restored copy to hand out. */
function setup(live: Record<string, number> = { notes: 5, users: 2 }) {
    const dir = scratch('cb-drill-');
    const databasePath = join(dir, 'live.sqlite');
    database(databasePath, live);
    const replica = join(dir, 'backups', 'litestream', 'company-brain');
    // Snapshots every few days, the oldest 20 days back; changes since.
    writeLtx(replica, 9, 1, 10, NOW - 20 * DAY);
    writeLtx(replica, 9, 1, 50, NOW - 3 * DAY);
    writeLtx(replica, 1, 51, 60, NOW - 2 * DAY);
    writeLtx(replica, 0, 61, 61, NOW - 60_000);
    const restored = join(dir, 'restored.sqlite');
    database(restored, live);
    return {
        dir,
        databasePath,
        replica,
        restored,
        directory: join(dir, 'backups'),
    };
}

it('only ever runs `litestream restore`, at a point to the millisecond, from a file replica', () => {
    expect(restoreArgs('/backups/litestream/company-brain', '/s/out.sqlite')).toEqual([
        'restore',
        '-o',
        '/s/out.sqlite',
        'file:///backups/litestream/company-brain',
    ]);
    expect(restoreArgs('/r', '/s/out.sqlite', Date.UTC(2026, 9, 14, 3, 4, 5, 678))).toEqual([
        'restore',
        '-timestamp',
        '2026-10-14T03:04:05.678Z',
        '-o',
        '/s/out.sqlite',
        'file:///r',
    ]);
});

it('picks a point of the last 14 days the replica covers, never before its oldest snapshot', () => {
    const { replica } = setup();
    expect(restorableSpan(replica)).toEqual({
        from: NOW - 20 * DAY,
        to: NOW - 60_000,
    });
    const span = restorableSpan(replica)!;
    // Never older than 14 days, never past the newest file: Litestream
    // refuses a moment after it (as a real drill found).
    expect(drillPoint(span, NOW, () => 0)).toBe(NOW - DRILL_WINDOW_MS);
    expect(drillPoint(span, NOW, () => 1)).toBe(NOW - 60_000);
    for (let i = 0; i < 50; i++) {
        const point = drillPoint(span, NOW);
        expect(point).toBeGreaterThanOrEqual(NOW - DRILL_WINDOW_MS);
        expect(point).toBeLessThanOrEqual(NOW - 60_000);
    }
    // A young replica: from its first snapshot on.
    expect(drillPoint({ from: NOW - 1500, to: NOW }, NOW, () => 0)).toBe(NOW - 1500);
    // A copy that stopped weeks ago: a point within it all the same.
    const stale = { from: NOW - 30 * DAY, to: NOW - 20 * DAY };
    expect(drillPoint(stale, NOW, () => 0)).toBe(NOW - 20 * DAY);
    expect(drillPoint(stale, NOW, () => 1)).toBe(NOW - 20 * DAY);
    // No snapshot (or no replica): nothing to restore a point from.
    const empty = scratch('cb-drill-empty-');
    writeLtx(empty, 0, 1, 1, NOW);
    expect(restorableSpan(empty)).toBeUndefined();
    expect(restorableSpan(join(empty, 'missing'))).toBeUndefined();
});

it('compares the latest restore with live, allowing for writes during the drill', () => {
    const before = { notes: 100, users: 5, events: 2000, gone: 3 };
    const after = { notes: 104, users: 5, events: 2010, fresh: 1 };
    // Anything between the two live counts matches; a table new since the
    // drill began isn't missing; one dropped meanwhile isn't counted.
    expect(compareCounts({ notes: 102, users: 5, events: 2000 }, before, after)).toEqual({
        missing: [],
        differences: [],
        gross: [],
    });
    // Off by a few rows: reported, not a failure.
    expect(compareCounts({ notes: 99, users: 4, events: 2010 }, before, after)).toEqual({
        missing: [],
        differences: [
            { table: 'notes', live: 100, restored: 99 },
            { table: 'users', live: 5, restored: 4 },
        ],
        gross: [],
    });
    // A missing table, and gross mismatches: over 100 rows and 10% of live.
    expect(compareCounts({ notes: 0, events: 1500 }, before, after)).toEqual({
        missing: ['users'],
        differences: [
            { table: 'events', live: 2000, restored: 1500 },
            { table: 'notes', live: 100, restored: 0 },
        ],
        gross: ['events'],
    });
    expect(compareCounts({ notes: 100, users: 5, events: 1800 }, before, after).gross).toEqual([]);
    expect(compareCounts({ notes: 100, users: 5, events: 1790 }, before, after).gross).toEqual(['events']);
});

it('restores the latest point, a point in time and off-site, checks each and leaves no scratch file', async () => {
    const w = setup();
    const fake = fakeLitestream(w.dir, { source: w.restored });
    const scratchDir = join(w.directory, '.restore-drill');
    // A drill cut off earlier left this.
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(join(scratchDir, 'old.sqlite'), 'leftover');
    const offsite = vi.fn(async (directory: string) => {
        mkdirSync(directory, { recursive: true });
        return { files: 3 };
    });
    let now = NOW;
    const result = await runRestoreDrill({
        replica: w.replica,
        databasePath: w.databasePath,
        scratch: scratchDir,
        litestream: fake.bin,
        offsite,
        reason: backupFailure,
        now: () => (now += 1000),
        random: () => 0.5,
    });
    expect(result).toMatchObject({
        ok: true,
        startedAt: NOW + 1000,
        tables: 2,
        differences: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThan(0);
    const point = drillPoint({ from: NOW - 20 * DAY, to: NOW - 60_000 }, NOW + 1000, () => 0.5);
    expect(point).toBe(NOW - 7 * DAY - 29_500);
    expect(result.restores).toEqual([
        { source: 'local', ok: true, durationMs: expect.any(Number) },
        {
            source: 'local',
            pointAt: point,
            ok: true,
            durationMs: expect.any(Number),
        },
        { source: 'offsite', ok: true, durationMs: expect.any(Number) },
    ]);
    expect(offsite).toHaveBeenCalledWith(join(scratchDir, 'offsite'));
    const calls = fake.calls();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
        expect(call.split(' ')[0]).toBe('restore');
    }
    expect(calls.join('\n')).not.toContain('replicate');
    expect(calls[0]).toBe(`restore -o ${join(scratchDir, 'the-latest-restore.sqlite')} file://${w.replica}`);
    expect(calls[1]).toContain(`-timestamp ${new Date(point).toISOString()}`);
    expect(calls[2]).toContain(`file://${join(scratchDir, 'offsite')}`);
    // Nothing of the app's environment reaches it.
    expect(fake.env()).toBe('');
    expect(existsSync(scratchDir)).toBe(false);
});

it('fails on a broken restore, a damaged copy or a missing table, says which, and still cleans up', async () => {
    const w = setup({ notes: 5, users: 2, issues: 1 });
    const scratchDir = join(w.directory, '.restore-drill');
    const run = (
        fake: ReturnType<typeof fakeLitestream>,
        offsite?: (directory: string) => Promise<{ files: number }>,
    ) =>
        runRestoreDrill({
            replica: w.replica,
            databasePath: w.databasePath,
            scratch: scratchDir,
            litestream: fake.bin,
            ...(offsite ? { offsite } : {}),
            reason: backupFailure,
            now: () => NOW,
        });
    // The point in time can't be restored; the latest still is, and checked.
    const failing = await run(
        fakeLitestream(scratch('cb-drill-fake-'), {
            source: w.restored,
            failPoint: true,
        }),
    );
    expect(failing.ok).toBe(false);
    expect(failing.error).toBe('The point-in-time restore: litestream restore failed: timestamp does not exist.');
    expect(failing.restores.map((restore) => restore.ok)).toEqual([true, false]);
    expect(existsSync(scratchDir)).toBe(false);

    // A damaged file off-site, and a restore that lacks a table.
    const damaged = join(w.dir, 'damaged.sqlite');
    writeFileSync(damaged, randomBytes(8192));
    const lacking = join(w.dir, 'lacking.sqlite');
    database(lacking, { notes: 5, users: 2 });
    const broken = await run(
        fakeLitestream(scratch('cb-drill-fake-'), {
            source: lacking,
            offsiteSource: damaged,
        }),
        async (directory) => {
            mkdirSync(directory, { recursive: true });
            return { files: 2 };
        },
    );
    expect(broken.ok).toBe(false);
    expect(broken.error).toMatch(
        /^The latest restore lacks table\(s\) issues; the off-site restore: The database couldn’t be read: .+\.$/,
    );
    expect(broken.restores.map((restore) => [restore.source, restore.ok])).toEqual([
        ['local', true],
        ['local', true],
        ['offsite', false],
    ]);
    expect(existsSync(scratchDir)).toBe(false);

    // Nothing off-site yet, and no litestream at all.
    const missing = await run({ bin: join(w.dir, 'no-such-litestream'), calls: () => [], env: () => '' }, async () => ({
        files: 0,
    }));
    expect(missing.error).toBe(
        'The latest restore: The litestream binary isn’t installed (LITESTREAM_BIN); the point-in-time restore: The litestream binary isn’t installed (LITESTREAM_BIN); the off-site restore: The off-site copy has no continuous copy files.',
    );
    expect(existsSync(scratchDir)).toBe(false);
});

it('fails on rows grossly off live, reporting smaller differences without failing', async () => {
    const w = setup({ notes: 500, users: 3 });
    const fewer = join(w.dir, 'fewer.sqlite');
    database(fewer, { notes: 300, users: 2 });
    const result = await runRestoreDrill({
        replica: w.replica,
        databasePath: w.databasePath,
        scratch: join(w.directory, '.restore-drill'),
        litestream: fakeLitestream(w.dir, { source: fewer }).bin,
        reason: backupFailure,
    });
    expect(result).toMatchObject({
        ok: false,
        error: "The latest restore's rows are far from live in notes.",
        differences: [
            { table: 'notes', live: 500, restored: 300 },
            { table: 'users', live: 3, restored: 2 },
        ],
    });
});

it('drills on schedule from the last one, again a day after a failure, one at a time', async () => {
    const w = setup();
    const fake = fakeLitestream(w.dir, { source: w.restored });
    let now = NOW;
    let days = 30;
    let ready = false;
    const lines: string[] = [];
    const failures: unknown[] = [];
    const drill = new RestoreDrill({
        directory: w.directory,
        replica: w.replica,
        databasePath: w.databasePath,
        litestream: fake.bin,
        reason: backupFailure,
        // Its recovery key check isn't run here.
        sealed: [],
        intervalDays: () => days,
        ready: () => ready,
        log: (line) => lines.push(line),
        onFailure: (result) => failures.push(result),
        now: () => now,
        firstCheckMs: 1,
        checkMs: 5,
    });
    // Not before the replica has a copy.
    expect(drill.due()).toBe(false);
    ready = true;
    expect(drill.due()).toBe(true);
    expect(drill.status()).toEqual({ intervalDays: 30, running: false });
    // Asked twice, it runs once.
    const first = drill.run();
    expect(drill.run()).toBe(first);
    expect(drill.status().running).toBe(true);
    const result = await first;
    expect(fake.calls()).toHaveLength(2);
    expect(drill.status()).toEqual({
        intervalDays: 30,
        running: false,
        last: result,
    });
    expect(lines).toEqual([
        'Restore drill: 2 restore(s) passed in 0 s; 0 table(s) differ from live within writes since.',
    ]);
    expect(lines[0]).not.toContain(w.dir);
    // Monthly: not again for 30 days, then due; 0 days: only by hand.
    now += 29 * DAY;
    expect(drill.due()).toBe(false);
    now += DAY;
    expect(drill.due()).toBe(true);
    days = 0;
    expect(drill.due()).toBe(false);
    days = 30;

    // A failed drill: logged, admins told, tried again after a day.
    rmSync(w.restored);
    const failed = await drill.run();
    expect(failed.ok).toBe(false);
    expect(failures).toEqual([failed]);
    expect(lines.at(-1)).toMatch(/^Restore drill failed in 0 s: The latest restore: /);
    expect(lines.at(-1)).not.toContain(w.dir);
    expect(drill.due()).toBe(false);
    now += DAY;
    expect(drill.due()).toBe(true);

    // Scheduled: start() runs a due drill, and removes a cut-off one's files.
    database(w.restored, { notes: 5, users: 2 });
    const scratchDir = join(w.directory, '.restore-drill');
    mkdirSync(scratchDir, { recursive: true });
    drill.start();
    cleanup.push(() => drill.stop());
    expect(existsSync(scratchDir)).toBe(false);
    await vi.waitFor(() => expect(drill.last()?.ok).toBe(true), {
        timeout: 20_000,
    });
    await vi.waitFor(() => expect(drill.status().running).toBe(false), {
        timeout: 20_000,
    });
    expect(drill.due()).toBe(false);
});

it('reads RESTORE_DRILL_INTERVAL_DAYS, and lets an admin’s schedule take its place', () => {
    expect(backupSettingsFromEnv({}, { dataKey: false }).drillIntervalDays).toBe(30);
    for (const days of ['0', '7', '365']) {
        expect(backupSettingsFromEnv({ RESTORE_DRILL_INTERVAL_DAYS: days }, { dataKey: false }).drillIntervalDays).toBe(
            Number(days),
        );
    }
    for (const value of ['-1', '1.5', '366', 'monthly']) {
        expect(() => backupSettingsFromEnv({ RESTORE_DRILL_INTERVAL_DAYS: value }, { dataKey: false })).toThrow(
            /^RESTORE_DRILL_INTERVAL_DAYS must be 0 \(only by hand\)/,
        );
    }
    expect(backupSettingsFromEnv({ LITESTREAM_BIN: '/opt/litestream' }, { dataKey: false }).litestream).toBe(
        '/opt/litestream',
    );

    const w = setup();
    const own: { schedule?: { drillIntervalDays: number } } = {};
    const service = new BackupService({
        databasePath: w.databasePath,
        userDataDir: join(w.dir, 'userdata'),
        settings: {
            directory: w.directory,
            keep: 3,
            intervalHours: 24,
            continuous: w.replica,
            drillIntervalDays: 14,
        },
        schedule: () => own.schedule,
        log: () => {},
    });
    expect(service.status().restoreDrill).toEqual({
        intervalDays: 14,
        running: false,
    });
    own.schedule = { drillIntervalDays: 0 };
    expect(service.schedule().drillIntervalDays).toBe(0);
    expect(service.status().restoreDrill?.intervalDays).toBe(0);
    // Without the continuous copy there is no drill.
    expect(
        new BackupService({
            databasePath: w.databasePath,
            userDataDir: join(w.dir, 'userdata'),
            settings: { directory: w.directory, keep: 3, intervalHours: 24 },
            log: () => {},
        }).drill,
    ).toBeUndefined();
});

it('restores the newest lineage off-site, fetched and opened with the data key', async () => {
    const w = setup();
    const fake = await startFakeS3();
    cleanup.push(() => fake.close());
    const target = new S3ObjectStore(fake.settings({ bucket: 'offsite' }), {
        backoffMs: 1,
        retries: 0,
    });
    const restorer = fakeLitestream(w.dir, { source: w.restored });
    // The fake also records how many files the off-site replica held.
    writeFileSync(
        restorer.bin,
        readFileSync(restorer.bin, 'utf8').replace(
            'case "$url" in',
            `case "$url" in *offsite*) find "\${url#file://}" -name '*.ltx' | wc -l | tr -d ' ' > '${w.dir}/offsite-files' ;; esac\ncase "$url" in`,
        ),
    );
    const service = new BackupService({
        databasePath: w.databasePath,
        userDataDir: join(w.dir, 'userdata'),
        settings: {
            directory: w.directory,
            keep: 3,
            intervalHours: 24,
            continuous: w.replica,
            litestream: restorer.bin,
            offsite: {
                ...fake.settings({ bucket: 'offsite' }),
                prefix: 'company-brain/',
            },
        },
        offsiteStore: target,
        keys: {
            current: randomBytes(32),
            legacy: 'drill-test-secret-0123456789abcdef',
        },
        log: () => {},
    });
    expect(await service.shipContinuous()).toBe(true);
    const result = await service.drill!.run();
    expect(result.ok).toBe(true);
    expect(result.restores.map((restore) => restore.source)).toEqual(['local', 'local', 'offsite']);
    expect(readFileSync(join(w.dir, 'offsite-files'), 'utf8').trim()).toBe('4');
    expect(existsSync(join(w.directory, '.restore-drill'))).toBe(false);
});

it('lets admins run the drill now, in the background; members can’t', async () => {
    const w = setup();
    const {
        app: server,
        platform,
        dispose,
    } = await makeTestRuntime({
        config: { baseUrl: 'https://model.invalid/v1', apiKey: 'unused', model: 'qwen-test' },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'drill-secret-0123456789abcdef0'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const as = async (userId: string) => {
        const login = await server.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        // As the client's api() sends a write: JSON, here without a body.
        return (path: string, method = 'GET') =>
            server.request(path, {
                method,
                headers: method === 'GET' ? { cookie } : { cookie, 'Content-Type': 'application/json' },
            });
    };
    const alice = await as('alice');
    const bob = await as('bob');
    // No continuous copy here: nothing to drill.
    expect((await alice('/api/backups/restore-drill', 'POST')).status).toBe(404);
    const service = new BackupService({
        databasePath: w.databasePath,
        userDataDir: join(w.dir, 'userdata'),
        settings: {
            directory: w.directory,
            keep: 3,
            intervalHours: 24,
            continuous: w.replica,
            litestream: fakeLitestream(w.dir, { source: w.restored }).bin,
        },
        log: () => {},
    });
    platform.useBackups(service);
    expect((await bob('/api/backups/restore-drill', 'POST')).status).toBe(403);
    const response = await alice('/api/backups/restore-drill', 'POST');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ intervalDays: 30, running: true });
    await vi.waitFor(() => expect(service.drill!.last()?.ok).toBe(true), {
        timeout: 20_000,
    });
    // Admins see it on Service setup; members don't get the backups' status.
    const setupOf = async (fetch: typeof alice) =>
        (
            (await (await fetch('/api/workspace')).json()) as {
                setup: { backup?: { restoreDrill?: unknown } };
            }
        ).setup.backup?.restoreDrill;
    expect(await setupOf(alice)).toMatchObject({
        intervalDays: 30,
        running: false,
        last: { ok: true },
    });
    expect(await setupOf(bob)).toBeUndefined();
});

it('notifies every active admin of a failed drill, members and deactivated people not', async () => {
    const { workspace, platform, dispose } = await makeTestRuntime({
        config: { baseUrl: 'https://model.invalid/v1', apiKey: 'unused', model: 'qwen-test' },
    });
    cleanup.push(dispose);
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'olga', name: 'Olga', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    workspace.recordUser({ id: 'dana', name: 'Dana', role: 'admin' });
    workspace.useDeactivated(() => ['dana']);
    // Alice is in the app: a toast. Olga is away, with no channel on.
    platform.notifications.presence.tab('alice', 'tab-aaaaaaaa', '/');
    await platform.notifyAdmins({
        trigger: 'restore_drill',
        title: 'Restore drill failed',
        message: 'The latest restore: litestream restore failed. See Service setup.',
        path: '/settings/workspace',
    });
    const sent = workspace.db
        .prepare(
            "SELECT userId, dotId, presence, title, link FROM notifications WHERE trigger='restore_drill' ORDER BY userId",
        )
        .all();
    expect(sent).toEqual([
        {
            userId: 'alice',
            dotId: null,
            presence: 'in_app',
            title: 'Restore drill failed',
            link: '/settings/workspace',
        },
        {
            userId: 'olga',
            dotId: null,
            presence: 'away',
            title: 'Restore drill failed',
            link: '/settings/workspace',
        },
    ]);
    expect(await platform.notifications.inApp('alice')).toMatchObject([
        { title: 'Restore drill failed', link: '/settings/workspace' },
    ]);
    // Dots' daily limits don't count it.
    expect((await platform.notifications.usage('any-dot', 'alice')).byUser).toBe(0);
});

it('ships Litestream in the app image, and the app never replicates', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    const imageTag = dockerfile.match(/^FROM (litestream\/litestream:\S+) AS litestream$/m)?.[1];
    expect(imageTag).toBe('litestream/litestream:0.5.17');
    const app = dockerfile.slice(dockerfile.indexOf('AS app\n'));
    expect(app.slice(0, app.indexOf('\nFROM '))).toContain(
        'COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream',
    );
    expect(readFileSync(new URL('../src/server/backup/restore-drill.ts', import.meta.url), 'utf8')).not.toMatch(
        /'replicate'/,
    );
});
