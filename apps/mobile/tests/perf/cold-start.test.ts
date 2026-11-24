import { describe, expect, it } from 'vitest';

import { fullyDrawnMs, parseAndroidArgs, totalTimeMs } from '../../perf/cold-start-android.mjs';
import { parseIosArgs } from '../../perf/cold-start-ios.mjs';
import {
    COLD_START_PREFIX,
    formatSummary,
    median,
    parseRecords,
    percentile,
    summarize,
} from '../../perf/cold-start-stats.mjs';
import { COLD_START_PREFIX as APP_PREFIX, coldStartLine, coldStartRecord } from '../../src/perf/cold-start';

// The cold-start aggregation: the app's record, its log line and
// file line read back, and the median and p90 the PR reports.

const ENV = { platform: 'android', os: '13', variant: 'preview' };
const SCOPE = {
    keysMs: 12.34,
    cacheDbMs: 40,
    userDbMs: 20,
    rowsMs: 30,
    rows: { shell: 2, conversations: 500, spaces: 12, dots: 40, notices: 0, pending: 0 },
};

function record(at: number, firstFrameMs: number) {
    const built = coldStartRecord(
        {
            processStartAt: at,
            prewarmed: false,
            jsAt: at + 150,
            storeMs: 25,
            scope: SCOPE,
            firstFrame: { at: at + firstFrameMs, screen: 'Chats' },
        },
        ENV,
        { cache: 1000, user: 100, registry: 50 },
    );
    if (built === null) {
        throw new Error('no record');
    }
    return built;
}

describe('the app record', () => {
    it('waits for every mark', () => {
        expect(coldStartRecord({ processStartAt: 0, prewarmed: false, jsAt: 1 }, ENV)).toBeNull();
        expect(
            coldStartRecord({ processStartAt: 0, prewarmed: false, jsAt: 1, storeMs: 1, scope: SCOPE }, ENV),
        ).toBeNull();
    });

    it('measures from the process start and rounds to a tenth', () => {
        const built = record(1_000, 612.36);
        expect(built.ms).toEqual({
            js: 150,
            store: 25,
            keys: 12.3,
            cacheDb: 40,
            userDb: 20,
            rows: 30,
            firstFrame: 612.4,
        });
        expect(built).toMatchObject({ v: 1, screen: 'Chats', at: 1_000, rows: SCOPE.rows, bytes: { cache: 1000 } });
    });

    it('reads back from logcat and from the marks file', () => {
        expect(COLD_START_PREFIX).toBe(APP_PREFIX);
        const line = coldStartLine(record(1_000, 600));
        const logcat = `11-08 01:00:00.000 I/ReactNativeJS( 123): ${line}\nnoise\n{"v":2}\n${COLD_START_PREFIX}{cut`;
        expect(parseRecords(logcat)).toEqual([record(1_000, 600)]);
        const file = `${line.slice(COLD_START_PREFIX.length)}\n${JSON.stringify(record(2_000, 650))}\n`;
        expect(parseRecords(file).map((r) => r.at)).toEqual([1_000, 2_000]);
    });
});

describe('the aggregation', () => {
    it('takes nearest-rank percentiles and the median', () => {
        const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
        expect(percentile(values, 90)).toBe(9);
        expect(percentile(values, 100)).toBe(10);
        expect(median(values)).toBe(5.5);
        expect(median([3, 1, 2])).toBe(2);
        expect(Number.isNaN(median([]))).toBe(true);
    });

    it('drops the discarded launch and launches before the runs, then holds the budget', () => {
        const old = record(0, 5_000);
        const discarded = record(10_000, 2_000);
        const runs = [640, 600, 610, 620, 630, 650, 660, 670, 680, 760].map((ms, i) => record(20_000 + i * 1000, ms));
        const summary = summarize([...runs].reverse().concat(old, discarded), { since: 10_000 });
        expect(summary.runs).toBe(10);
        expect(summary.marks.firstFrame).toEqual({ median: 645, p90: 680, min: 600, max: 760 });
        expect(summary).toMatchObject({
            platform: 'android',
            budgetMs: 700,
            withinBudget: { median: true, p90: true },
        });
        expect(summary.rows).toEqual(SCOPE.rows);
        expect(summarize(runs, { discard: 0, platform: 'ios' }).withinBudget).toEqual({ median: false, p90: false });
        expect(formatSummary(summary)).toContain(
            'median 645 ms, p90 680 ms (budget 700 ms: median within, p90 within)',
        );
    });
});

describe('the scripts', () => {
    it('read their arguments', () => {
        expect(parseAndroidArgs(['--device', 'X'])).toMatchObject({
            appId: 'com.ingenioventures.socio.preview',
            runs: 10,
            fillSeconds: 30,
        });
        expect(
            parseAndroidArgs(['--device', 'X', '--no-fill', '--server-log', 'a', '--server-log', 'b']),
        ).toMatchObject({
            fillSeconds: 0,
            serverLogs: ['a', 'b'],
        });
        expect(() => parseAndroidArgs([])).toThrow(/--device/);
        expect(() => parseAndroidArgs(['--device', 'X', '--runs', '5'])).toThrow(/10 or more/);
        expect(() => parseIosArgs(['--device', 'Y'])).toThrow(/airplane/);
        expect(parseIosArgs(['--device', 'Y', '--airplane-on', '--ssh', 'me@mac'])).toMatchObject({
            bundleId: 'com.ingenioventures.socio.preview',
            ssh: 'me@mac',
            runs: 10,
        });
    });

    it("read the system's lines", () => {
        expect(fullyDrawnMs('I/ActivityTaskManager( 1): Fully drawn com.x/.MainActivity: +1s234ms')).toBe(1234);
        expect(fullyDrawnMs('Fully drawn com.x/.MainActivity: +987ms')).toBe(987);
        expect(fullyDrawnMs('nothing')).toBeNull();
        expect(totalTimeMs('ThisTime: 400\nTotalTime: 412\n')).toBe(412);
    });
});
