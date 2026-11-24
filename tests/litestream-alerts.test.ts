// CB-315: the continuous copy's lag and write-ahead log, their alert level,
// admins' notices on each change, and the safety valve's checkpoint.
import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { copyAlertLevel, DEFAULT_COPY_ALERTS, type CopyAlertThresholds } from '@socio/shared/continuous-copy';

import { BackupService } from '../src/server/backup/backup-service.js';
import {
    COPY_ALERT_PATH,
    COPY_REMINDER_MS,
    CopyAlerts,
    passiveCheckpoint,
    valveDue,
} from '../src/server/backup/copy-alerts.js';
import { copyAlertsInForce } from '../src/server/backup/layer.js';
import { continuousCopyStatus } from '../src/server/backup/litestream-status.js';
import { copyAlertLimitsFromEnv } from '../src/server/composition/config.js';

const MB = 1024 * 1024;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 8, 12);
const T: CopyAlertThresholds = { ...DEFAULT_COPY_ALERTS };

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-315-'));
    dirs.push(dir);
    return dir;
}
function touch(path: string, at: number, bytes = 0) {
    writeFileSync(path, '');
    if (bytes) {
        truncateSync(path, bytes);
    }
    utimesSync(path, at / 1000, at / 1000);
}
/** A replica whose newest copy is from `at`, and a database last written at `writeAt` with a WAL of `walBytes`. */
function setup(at: number | undefined, writeAt: number, walBytes = 4096) {
    const replica = scratch();
    if (at !== undefined) {
        mkdirSync(join(replica, 'ltx', '0'), { recursive: true });
        touch(join(replica, 'ltx', '0', '0000000000000002-0000000000000002.ltx'), at);
    }
    const db = join(scratch(), 'company-brain.sqlite');
    touch(db, writeAt - 60 * MIN);
    touch(`${db}-wal`, writeAt, walBytes);
    return { replica, db };
}

it('levels the lag and the log against the thresholds, the worse of the two', () => {
    expect(copyAlertLevel({ lagMs: 0, walBytes: 0 }, T)).toBe('ok');
    expect(copyAlertLevel({ lagMs: 5 * MIN }, T)).toBe('warning');
    expect(copyAlertLevel({ lagMs: 30 * MIN }, T)).toBe('critical');
    expect(copyAlertLevel({ lagMs: 0, walBytes: 256 * MB }, T)).toBe('warning');
    expect(copyAlertLevel({ lagMs: 6 * MIN, walBytes: 1024 * MB }, T)).toBe('critical');
});

it('measures the writes not copied yet, not the age of an idle copy', () => {
    // Idle for an hour, copied right after the last write: nothing at risk.
    const idle = setup(NOW - 60 * MIN + 1_000, NOW - 60 * MIN);
    expect(continuousCopyStatus(idle.replica, idle.db, NOW, T)).toMatchObject({
        lagMs: 0,
        walBytes: 4096,
        level: 'ok',
    });
    // Written after the newest copy: waiting since that copy.
    const behind = setup(NOW - 15 * MIN, NOW - 3 * MIN, 300 * MB);
    expect(continuousCopyStatus(behind.replica, behind.db, NOW, T)).toMatchObject({
        lagMs: 15 * MIN,
        walBytes: 300 * MB,
        level: 'warning',
        behind: true,
    });
    // Litestream stopped a second before the last write, then traffic stopped:
    // the write still waits, and the lag keeps growing.
    const stopped = setup(NOW - 24 * 60 * MIN, NOW - 24 * 60 * MIN + 1_000);
    expect(continuousCopyStatus(stopped.replica, stopped.db, NOW, T)).toMatchObject({
        lagMs: 24 * 60 * MIN,
        level: 'critical',
    });
    // No copy at all: behind since the server started.
    const none = setup(undefined, NOW - 1_000);
    expect(continuousCopyStatus(none.replica, none.db, NOW, T, NOW - 40 * MIN)).toMatchObject({
        lagMs: 40 * MIN,
        level: 'critical',
    });
    // Without thresholds, the status stays as it was (CB-109).
    expect(continuousCopyStatus(behind.replica, behind.db, NOW)).not.toHaveProperty('level');
});

it('alerts once per change, reminds hourly while critical, and says when it recovers', () => {
    const alerts = new CopyAlerts();
    const at = (level: 'ok' | 'warning' | 'critical', lagMs = 0) => ({ behind: false, level, lagMs, walBytes: 8 * MB });
    expect(alerts.observe(at('ok'), NOW)).toBeUndefined();
    expect(alerts.observe(at('warning', 6 * MIN), NOW)).toMatchObject({
        level: 'warning',
        previous: 'ok',
        title: 'Continuous copy falling behind',
    });
    expect(alerts.observe(at('warning', 7 * MIN), NOW + MIN)).toBeUndefined();
    const critical = alerts.observe(at('critical', 31 * MIN), NOW + 2 * MIN);
    expect(critical).toMatchObject({ level: 'critical', reminder: false, title: 'Continuous copy critical' });
    expect(critical?.message).toContain('31 minutes behind');
    expect(critical?.message).toContain('8 MB');
    expect(alerts.observe(at('critical', 40 * MIN), NOW + 30 * MIN)).toBeUndefined();
    expect(alerts.observe(at('critical', 90 * MIN), NOW + 2 * MIN + COPY_REMINDER_MS)).toMatchObject({
        reminder: true,
        title: 'Continuous copy still critical',
    });
    expect(alerts.observe(at('ok'), NOW + 3 * COPY_REMINDER_MS)).toMatchObject({
        level: 'ok',
        previous: 'critical',
        title: 'Continuous copy recovered',
    });
    expect(alerts.observe(at('ok'), NOW + 4 * COPY_REMINDER_MS)).toBeUndefined();
});

it("takes an admin's thresholds over the environment's, and the environment's over the defaults", () => {
    expect(copyAlertLimitsFromEnv({ LITESTREAM_WAL_CRITICAL_MB: '2048', LITESTREAM_LAG_WARN_MINUTES: ' ' })).toEqual({
        walCriticalMb: 2048,
    });
    expect(() => copyAlertLimitsFromEnv({ LITESTREAM_LAG_CRITICAL_MINUTES: '0' })).toThrow(
        /LITESTREAM_LAG_CRITICAL_MINUTES must be a whole number/,
    );
    expect(copyAlertsInForce(T, { walWarnMb: 64 })).toEqual({ ...T, walWarnMb: 64 });
});

it('only opens the valve with the log past critical while the copy is critically behind', () => {
    expect(valveDue({ behind: true, lagMs: 31 * MIN, walBytes: 1024 * MB }, T)).toBe(true);
    expect(valveDue({ behind: true, lagMs: 31 * MIN, walBytes: 512 * MB }, T)).toBe(false);
    // A big log with Litestream keeping up is Litestream's to checkpoint.
    expect(valveDue({ behind: false, lagMs: 0, walBytes: 2048 * MB }, T)).toBe(false);
});

it('tells admins on each change and checkpoints only when the valve is due, at most every 10 minutes', async () => {
    let now = NOW;
    const { replica, db } = setup(NOW - 45 * MIN, NOW - MIN, 1100 * MB);
    const notices: { title: string; path: string }[] = [];
    const lines: string[] = [];
    const checkpoint = vi.fn(async () => ({ busy: 0, log: 10, checkpointed: 10 }));
    let thresholds: CopyAlertThresholds = { ...T };
    const service = new BackupService({
        databasePath: db,
        userDataDir: scratch(),
        settings: { directory: scratch(), keep: 1, intervalHours: 0, continuous: replica },
        copyAlerts: () => thresholds,
        onCopyAlert: (notice) => void notices.push(notice),
        checkpoint,
        log: (line) => void lines.push(line),
        now: () => now,
    });
    await service.checkCopy();
    expect(notices.map((notice) => notice.title)).toEqual(['Continuous copy critical', 'Write-ahead log checkpointed']);
    expect(notices.every((notice) => notice.path === COPY_ALERT_PATH)).toBe(true);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain('checkpointed 10 of 10 page(s) (PASSIVE)');
    // Admins see it in their setup; the notices name no path.
    expect(service.status().continuous).toMatchObject({ level: 'critical', walBytes: 1100 * MB, lagMs: 45 * MIN });
    expect(JSON.stringify(notices)).not.toContain(replica);
    // Within 10 minutes: no second checkpoint, and no second valve notice after.
    now += 5 * MIN;
    await service.checkCopy();
    expect(checkpoint).toHaveBeenCalledTimes(1);
    now += 6 * MIN;
    await service.checkCopy();
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(notices).toHaveLength(2);
    // An admin raises the thresholds: it recovers.
    thresholds = { ...T, copyLagWarnMinutes: 100, copyLagCriticalMinutes: 200, walWarnMb: 4096, walCriticalMb: 8192 };
    await service.checkCopy();
    expect(notices.at(-1)?.title).toBe('Continuous copy recovered');
    expect(checkpoint).toHaveBeenCalledTimes(2);
});

it('says when a reader holds the checkpoint short of the log’s end', async () => {
    let now = NOW;
    const { replica, db } = setup(NOW - 45 * MIN, NOW - MIN, 1100 * MB);
    const titles: string[] = [];
    const results = [
        { busy: 1, log: 10, checkpointed: 4 },
        { busy: 1, log: 12, checkpointed: 4 },
        { busy: 0, log: 12, checkpointed: 12 },
    ];
    const service = new BackupService({
        databasePath: db,
        userDataDir: scratch(),
        settings: { directory: scratch(), keep: 1, intervalHours: 0, continuous: replica },
        copyAlerts: () => T,
        onCopyAlert: (notice) => void titles.push(notice.title),
        checkpoint: async () => results.shift()!,
        log: () => {},
        now: () => now,
    });
    await service.checkCopy();
    now += 11 * MIN;
    await service.checkCopy();
    now += 11 * MIN;
    await service.checkCopy();
    // Incomplete twice is told once; the complete one after it is told too.
    expect(titles).toEqual([
        'Continuous copy critical',
        'Write-ahead log checkpoint incomplete',
        'Write-ahead log checkpointed',
    ]);
});

it('runs no alert checks without thresholds or a continuous copy', async () => {
    const { replica, db } = setup(NOW - 45 * MIN, NOW - MIN, 1100 * MB);
    const onCopyAlert = vi.fn();
    const base = { databasePath: db, userDataDir: scratch(), log: () => {}, onCopyAlert, now: () => NOW };
    await new BackupService({
        ...base,
        settings: { directory: scratch(), keep: 1, intervalHours: 0, continuous: replica },
    }).checkCopy();
    await new BackupService({
        ...base,
        settings: { directory: scratch(), keep: 1, intervalHours: 0 },
        copyAlerts: () => T,
    }).checkCopy();
    expect(onCopyAlert).not.toHaveBeenCalled();
});

it("checkpoints a WAL the app doesn't checkpoint itself, without truncating it", async () => {
    const path = join(scratch(), 'company-brain.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT)');
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 200; i++) {
        insert.run('x'.repeat(1000));
    }
    const result = await passiveCheckpoint(path);
    expect(result.busy).toBe(0);
    expect(result.log).toBeGreaterThan(0);
    expect(result.checkpointed).toBe(result.log);
    expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(200);
    db.close();
});
