import type { CopyAlertLevel, CopyAlertThresholds } from '@socio/shared/continuous-copy';
import type { ContinuousCopyStatus } from '@socio/shared/types';

/** While critical, admins are reminded at most this often. */
export const COPY_REMINDER_MS = 60 * 60_000;
/** The safety valve's checkpoint runs at most this often. */
export const COPY_CHECKPOINT_EVERY_MS = 10 * 60_000;

/** Where admins see the copy: Operations → Health. */
export const COPY_ALERT_PATH = '/operations/health';

/** A notice for admins about the continuous copy (CB-315). Sizes and times only. */
export interface CopyAlertNotice {
    level: CopyAlertLevel;
    previous: CopyAlertLevel;
    /** A critical state that lasted another hour, not a change. */
    reminder: boolean;
    title: string;
    message: string;
}

const MB = 1024 * 1024;

/** "12 minutes", "3 hours": how far behind, for a notice. */
function span(ms: number) {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 120) {
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${Math.round(minutes / 60)} hours`;
}

/** What the copy is like now, in a sentence. */
export function copyFacts(status: ContinuousCopyStatus) {
    const lag = status.lagMs ? `is ${span(status.lagMs)} behind the newest write` : 'is up to date';
    const wal =
        status.walBytes !== undefined ? ` and the write-ahead log is ${Math.round(status.walBytes / MB)} MB` : '';
    return `The database’s continuous copy ${lag}${wal}.`;
}

/**
 * The continuous copy's alerts (CB-315): one notice per change of level,
 * a reminder at most hourly while it stays critical, and one when it
 * recovers. It starts at `ok`, so a server that restarts while the copy is
 * behind tells admins again, and one that starts healthy says nothing.
 */
export class CopyAlerts {
    private level: CopyAlertLevel = 'ok';
    private notifiedAt = 0;

    /** The notice the status calls for now, if any. */
    observe(status: ContinuousCopyStatus, now: number): CopyAlertNotice | undefined {
        const next = status.level ?? 'ok';
        const previous = this.level;
        if (next === previous) {
            if (next !== 'critical' || now - this.notifiedAt < COPY_REMINDER_MS) {
                return undefined;
            }
            this.notifiedAt = now;
            return notice(next, previous, true, status);
        }
        this.level = next;
        this.notifiedAt = now;
        return notice(next, previous, false, status);
    }
}

function notice(
    level: CopyAlertLevel,
    previous: CopyAlertLevel,
    reminder: boolean,
    status: ContinuousCopyStatus,
): CopyAlertNotice {
    const facts = copyFacts(status);
    if (level === 'ok') {
        return {
            level,
            previous,
            reminder,
            title: 'Continuous copy recovered',
            message: `${facts} Replication is keeping up again.`,
        };
    }
    const check = 'Check that the litestream service is running; see Operations → Health.';
    return {
        level,
        previous,
        reminder,
        title:
            level === 'critical'
                ? reminder
                    ? 'Continuous copy still critical'
                    : 'Continuous copy critical'
                : previous === 'critical'
                  ? 'Continuous copy improving'
                  : 'Continuous copy falling behind',
        message:
            level === 'critical'
                ? `${facts} New writes are not being copied, and the log keeps growing until Litestream checkpoints it. ${check}`
                : `${facts} ${check}`,
    };
}

/**
 * Whether the safety valve may checkpoint now (CB-315): the log is past its
 * critical size while the copy has been critically behind, i.e. Litestream
 * has been gone a long time and the disk is what's at risk.
 */
export function valveDue(status: ContinuousCopyStatus, thresholds: CopyAlertThresholds) {
    return (
        (status.walBytes ?? 0) >= thresholds.walCriticalMb * MB &&
        (status.lagMs ?? 0) >= thresholds.copyLagCriticalMinutes * 60_000
    );
}

/** What `PRAGMA wal_checkpoint` reports: pages in the log, and how many are now in the database. */
export interface CheckpointResult {
    busy: number;
    log: number;
    checkpointed: number;
}

/**
 * The safety valve's checkpoint (CB-315): PASSIVE, from a connection of its
 * own. Why it is safe with Litestream:
 *
 * - PASSIVE never waits for or interrupts anyone, and never truncates or
 *   resets the log itself: it copies committed pages into the database
 *   file up to the oldest reader's mark. While Litestream runs it holds a
 *   read transaction for exactly this reason, so a checkpoint can't pass
 *   frames it hasn't copied; the valve then changes nothing.
 * - Only with Litestream gone does it reach the end of the log; the next
 *   write then starts the log over instead of growing it. The frames it
 *   reuses were never copied, so when Litestream returns it finds its
 *   position gone and starts from a fresh snapshot of the database. The
 *   data is all in the database file; what's lost is point-in-time restore
 *   inside the outage, which a full disk (no writes at all) costs anyway.
 * - It never shrinks the file (TRUNCATE would, but would wait on readers
 *   and is Litestream's to run); it stops the growth.
 */
export async function passiveCheckpoint(databasePath: string): Promise<CheckpointResult> {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath);
    try {
        db.exec('PRAGMA busy_timeout=5000');
        const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as Partial<CheckpointResult> | undefined;
        return {
            busy: Number(row?.busy ?? 0),
            log: Number(row?.log ?? 0),
            checkpointed: Number(row?.checkpointed ?? 0),
        };
    } finally {
        db.close();
    }
}
