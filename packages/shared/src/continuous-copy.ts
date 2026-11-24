/**
 * The continuous copy's alert thresholds (CB-315): how far behind the copy
 * may fall, and how large the database's write-ahead log may grow, before
 * admins hear of it. With Litestream on, the app leaves checkpoints to it
 * (`sqlite-pragmas.ts`), so while it is down the WAL only grows and no
 * write is copied. An admin's values in Settings (`LIMIT_SPECS`) go over
 * the `LITESTREAM_*` variables', and those over these.
 */
export const DEFAULT_COPY_ALERTS = {
    copyLagWarnMinutes: 5,
    copyLagCriticalMinutes: 30,
    walWarnMb: 256,
    walCriticalMb: 1024,
} as const;

/** The thresholds in force, in the units of `LIMIT_SPECS`. */
export interface CopyAlertThresholds {
    copyLagWarnMinutes: number;
    copyLagCriticalMinutes: number;
    walWarnMb: number;
    walCriticalMb: number;
}

/** How the continuous copy is doing against the thresholds. */
export type CopyAlertLevel = 'ok' | 'warning' | 'critical';

const MB = 1024 * 1024;

/**
 * The level of a copy `lagMs` behind with a WAL of `walBytes`: the worse of
 * the two. A critical threshold set below its warning one still counts as
 * critical from there.
 */
export function copyAlertLevel(
    { lagMs, walBytes }: { lagMs: number; walBytes?: number },
    thresholds: CopyAlertThresholds,
): CopyAlertLevel {
    const wal = walBytes ?? 0;
    if (lagMs >= thresholds.copyLagCriticalMinutes * 60_000 || wal >= thresholds.walCriticalMb * MB) {
        return 'critical';
    }
    if (lagMs >= thresholds.copyLagWarnMinutes * 60_000 || wal >= thresholds.walWarnMb * MB) {
        return 'warning';
    }
    return 'ok';
}
