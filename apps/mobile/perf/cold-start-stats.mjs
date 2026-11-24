// The cold-start aggregation, shared by cold-start-android.mjs
// and cold-start-ios.mjs and run under Node by tests/perf/cold-start.test.ts.
// It reads the records the app writes (src/perf/cold-start.ts: one log line,
// `[cold-start] {json}`, and one line of JSON per launch in the marks file),
// drops the discarded launch, and gives the median and p90 of each mark.

/** What starts the app's log line (COLD_START_PREFIX in src/perf/cold-start.ts). */
export const COLD_START_PREFIX = '[cold-start] ';

/** Expo CLI's switches for any build these scripts start (release builds run `expo export:embed`). */
export const EXPO_ENV = { EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', DO_NOT_TRACK: '1' };

/** The budgets, from the process's start to the first frame with data. */
export const BUDGET_MS = { android: 700, ios: 450 };

/** The marks reported, in the order of the record's `ms`. */
export const MARKS = ['js', 'store', 'keys', 'cacheDb', 'userDb', 'rows', 'firstFrame'];

/**
 * The records in `text`: log lines with the prefix anywhere in them (logcat
 * puts its own fields first), or lines that are the record's JSON alone (the
 * marks file). Other lines, and JSON that isn't a version 1 record, are skipped.
 * @param {string} text
 */
export function parseRecords(text) {
    const records = [];
    for (const line of text.split('\n')) {
        const at = line.indexOf(COLD_START_PREFIX);
        const json = at >= 0 ? line.slice(at + COLD_START_PREFIX.length) : line.trim();
        if (!json.startsWith('{')) {
            continue;
        }
        try {
            const record = JSON.parse(json);
            if (record?.v === 1 && typeof record.ms?.firstFrame === 'number') {
                records.push(record);
            }
        } catch {
            // A line cut short: not a record.
        }
    }
    return records;
}

/**
 * The nearest-rank percentile `p` (0 to 100) of `values`; NaN for none.
 * @param {number[]} values
 * @param {number} p
 */
export function percentile(values, p) {
    if (values.length === 0) {
        return Number.NaN;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[rank - 1];
}

/**
 * The median: the middle value, or the mean of the two middle ones.
 * @param {number[]} values
 */
export function median(values) {
    if (values.length === 0) {
        return Number.NaN;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The timed launches' summary: records from `since` on (the process's start, on
 * the wall clock), in order, the first `discard` dropped. Each mark's median,
 * p90, min and max; the budget's verdict on the first frame's median and p90;
 * the last record's rows and bytes (the cache doesn't change offline).
 * @param {any[]} records
 * @param {{ since?: number, discard?: number, platform?: 'android' | 'ios', budgetMs?: number }} [options]
 */
export function summarize(records, options = {}) {
    const { since = 0, discard = 1 } = options;
    const runs = records
        .filter((record) => record.at >= since)
        .sort((a, b) => a.at - b.at)
        .slice(discard);
    const platform = options.platform ?? runs[0]?.platform;
    const budgetMs = options.budgetMs ?? BUDGET_MS[platform] ?? Number.NaN;
    /** @type {Record<string, { median: number, p90: number, min: number, max: number }>} */
    const marks = {};
    for (const mark of MARKS) {
        const values = runs.map((run) => run.ms[mark]).filter((value) => typeof value === 'number');
        marks[mark] = {
            median: median(values),
            p90: percentile(values, 90),
            min: values.length ? Math.min(...values) : Number.NaN,
            max: values.length ? Math.max(...values) : Number.NaN,
        };
    }
    const last = runs.at(-1);
    return {
        runs: runs.length,
        platform,
        os: last?.os ?? null,
        variant: last?.variant ?? null,
        screens: [...new Set(runs.map((run) => run.screen))],
        prewarmed: runs.filter((run) => run.prewarmed).length,
        budgetMs,
        withinBudget: { median: marks.firstFrame.median <= budgetMs, p90: marks.firstFrame.p90 <= budgetMs },
        marks,
        firstFrames: runs.map((run) => run.ms.firstFrame),
        rows: last?.rows ?? {},
        bytes: last?.bytes ?? {},
    };
}

/**
 * The summary as a few lines of text for the PR.
 * @param {ReturnType<typeof summarize>} summary
 */
export function formatSummary(summary) {
    const ms = (value) => (Number.isNaN(value) ? '-' : `${Math.round(value)} ms`);
    const lines = [
        `${summary.platform} ${summary.os} (${summary.variant}), ${summary.runs} timed launches, screen ${summary.screens.join('/')}`,
        `first frame with data: median ${ms(summary.marks.firstFrame.median)}, p90 ${ms(summary.marks.firstFrame.p90)} (budget ${ms(summary.budgetMs)}: median ${summary.withinBudget.median ? 'within' : 'over'}, p90 ${summary.withinBudget.p90 ? 'within' : 'over'})`,
        ...MARKS.filter((mark) => mark !== 'firstFrame').map(
            (mark) =>
                `  ${mark}: median ${ms(summary.marks[mark].median)}, p90 ${ms(summary.marks[mark].p90)} (${ms(summary.marks[mark].min)} to ${ms(summary.marks[mark].max)})`,
        ),
        `rows: ${Object.entries(summary.rows)
            .map(([name, count]) => `${name} ${count}`)
            .join(', ')}`,
        `bytes: ${Object.entries(summary.bytes)
            .map(([name, size]) => `${name} ${size}`)
            .join(', ')}`,
    ];
    if (summary.prewarmed > 0) {
        lines.push(`${summary.prewarmed} launch(es) were prewarmed: their process start is earlier than the launch.`);
    }
    return lines.join('\n');
}
