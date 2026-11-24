/**
 * The bounds of promoted apps' build and start attempts (CB-146, CB-175),
 * whatever stores them.
 */

/**
 * The most attempts one app keeps whatever the retention setting says
 * (CB-175): the top of `APP_LOG_ATTEMPTS_RANGE`, so a crash loop can't fill
 * the database inside the days kept.
 */
export const ATTEMPTS_PER_APP = 500;
/** Each attempt's log: its last lines, at most this many bytes. */
export const ATTEMPT_LOG_LINES = 400;
export const ATTEMPT_LOG_BYTES = 32 * 1024;

/** The last lines of a log, within the bounds; how many were cut. */
export function boundLog(lines: string[]) {
    const kept = lines.slice(-ATTEMPT_LOG_LINES);
    let bytes = kept.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    while (kept.length > 1 && bytes > ATTEMPT_LOG_BYTES) {
        bytes -= Buffer.byteLength(kept.shift()!) + 1;
    }
    return { log: kept.join('\n'), cut: lines.length - kept.length };
}
