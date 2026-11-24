import type { ScopeOpenTimings } from '../sync/scope';

// The cold-start marks: from the
// process's start to the first frame of the chat list (or Home) with data,
// filled from the cache before any request. Pure, so it runs under Node:
// src/platform/cold-start.ts feeds it the marks and writes the record, to a
// file and one log line; apps/mobile/perf/ reads them back and aggregates
// (perf/cold-start-stats.mjs).

/** What starts the one log line, `[cold-start] {json}`, which perf/ finds in logcat. */
export const COLD_START_PREFIX = '[cold-start] ';
export const COLD_START_VERSION = 1;

/** The marks one launch collects, as they come. Times `At` are on the wall clock (ms since the epoch), the rest durations. */
export interface ColdStartMarks {
    /** When the process started (socio-device's processStartTime). */
    readonly processStartAt: number;
    /** iOS: the process was prewarmed, so its start is earlier than the launch. */
    readonly prewarmed: boolean;
    /** When the app's JavaScript began to run (this module's binding loading). */
    readonly jsAt: number;
    /** Opening the store: the registry and the launch's reconcile (launch.ts's openMs). */
    storeMs?: number;
    /** Opening the active workspace's scope, step by step. */
    scope?: ScopeOpenTimings;
    /** The first frame with data drawn: when, and on which screen. */
    firstFrame?: { readonly at: number; readonly screen: string };
}

export interface ColdStartRecord {
    readonly v: typeof COLD_START_VERSION;
    readonly platform: string;
    /** The OS's version: Android's release ("13"), iOS's ("26.0"). */
    readonly os: string;
    readonly variant: string;
    readonly screen: string;
    readonly prewarmed: boolean;
    /** The process's start, on the wall clock. */
    readonly at: number;
    readonly ms: {
        /** From the process's start to the JavaScript running. */
        readonly js: number;
        readonly store: number;
        readonly keys: number;
        readonly cacheDb: number;
        readonly userDb: number;
        readonly rows: number;
        /** From the process's start to the first frame with data: the number held against the budget. */
        readonly firstFrame: number;
    };
    readonly rows: Readonly<Record<string, number>>;
    /** The workspace's files, in bytes (each with its -wal), and the registry's. */
    readonly bytes: Readonly<Record<string, number>>;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** The launch's record once every mark is in, or null while one is missing. */
export function coldStartRecord(
    marks: ColdStartMarks,
    env: { readonly platform: string; readonly os: string; readonly variant: string },
    bytes: Readonly<Record<string, number>> = {},
): ColdStartRecord | null {
    const { scope, firstFrame, storeMs } = marks;
    if (scope === undefined || firstFrame === undefined || storeMs === undefined) {
        return null;
    }
    return {
        v: COLD_START_VERSION,
        ...env,
        screen: firstFrame.screen,
        prewarmed: marks.prewarmed,
        at: marks.processStartAt,
        ms: {
            js: round(marks.jsAt - marks.processStartAt),
            store: round(storeMs),
            keys: round(scope.keysMs),
            cacheDb: round(scope.cacheDbMs),
            userDb: round(scope.userDbMs),
            rows: round(scope.rowsMs),
            firstFrame: round(firstFrame.at - marks.processStartAt),
        },
        rows: scope.rows,
        bytes,
    };
}

/** The one log line. */
export function coldStartLine(record: ColdStartRecord): string {
    return COLD_START_PREFIX + JSON.stringify(record);
}
