import { bucketStart, bucketStarts } from '@socio/shared/operations/operations';
import { percentile, type OpsIssueVelocity } from '@socio/shared/operations/operations-reliability';

import type { OpsScope } from './scope.js';

/** An item on the board, as `f_issue` keeps it (CB-189). */
export interface IssueFact {
    /** Its id, which `f_issue_run` links turns to (CB-194). */
    id?: string;
    kind: string;
    reporterId: string;
    createdAt: number;
    closedAt: number | null;
    deletedAt?: number | null;
}

/**
 * A failed turn a person filed an item about from Runs (CB-194,
 * `f_issue_run` with `via` report): when it failed, when the item was
 * filed, and by whom.
 */
export interface ReportFact {
    reporterId: string;
    failedAt: number;
    reportedAt: number;
}

const within = (at: number | null, from: number | null, to: number) =>
    at !== null && (from === null || at >= from) && at < to;

/**
 * The board's reporting and resolution in a window (CB-189), from its
 * items: the board is small, so both readers count it the same way, in
 * code, over the live items the person filter (their reporter) leaves.
 * The board has no socio, Space or source, so those filters don't apply.
 * `reports` are the failed turns people filed items about from Runs: how
 * long each took to be reported (CB-194), by when its item was filed.
 */
export function issueVelocity(
    all: readonly IssueFact[],
    { window, filters }: OpsScope,
    reports: readonly ReportFact[] = [],
): OpsIssueVelocity {
    const issues = all.filter(
        (issue) => issue.deletedAt == null && (!filters.person || issue.reporterId === filters.person),
    );
    const { from, to, previous, bucket, timeZone } = window;
    const reported = issues.filter((issue) => within(issue.createdAt, from, to));
    const resolved = issues.filter((issue) => within(issue.closedAt, from, to));
    const times = resolved.map((issue) => Math.max(0, issue.closedAt! - issue.createdAt)).sort((a, b) => a - b);
    const start = from ?? (issues.length ? Math.min(...issues.map((issue) => issue.createdAt)) : null);
    const points =
        start === null
            ? []
            : bucketStarts(start, to, bucket, timeZone).map((at) => ({
                  at,
                  reported: 0,
                  resolved: 0,
              }));
    const byStart = new Map(points.map((point) => [point.at, point]));
    for (const issue of reported) {
        const point = byStart.get(bucketStart(issue.createdAt, bucket, timeZone));
        if (point) {
            point.reported++;
        }
    }
    for (const issue of resolved) {
        const point = byStart.get(bucketStart(issue.closedAt!, bucket, timeZone));
        if (point) {
            point.resolved++;
        }
    }
    // Failure to report (CB-194): the failed turns filed about in the window.
    const lags = reports
        .filter(
            (report) =>
                (!filters.person || report.reporterId === filters.person) && within(report.reportedAt, from, to),
        )
        .map((report) => Math.max(0, report.reportedAt - report.failedAt))
        .sort((a, b) => a - b);
    return {
        reported: reported.length,
        resolved: resolved.length,
        previousReported: previous
            ? issues.filter((issue) => within(issue.createdAt, previous.from, previous.to)).length
            : null,
        previousResolved: previous
            ? issues.filter((issue) => within(issue.closedAt, previous.from, previous.to)).length
            : null,
        bugsReported: reported.filter((issue) => issue.kind === 'bug').length,
        open: issues.filter((issue) => issue.createdAt < to && (issue.closedAt === null || issue.closedAt >= to))
            .length,
        medianResolveMs: percentile(times, 0.5),
        p90ResolveMs: percentile(times, 0.9),
        failuresReported: lags.length,
        medianReportMs: percentile(lags, 0.5),
        p90ReportMs: percentile(lags, 0.9),
        points,
    };
}
