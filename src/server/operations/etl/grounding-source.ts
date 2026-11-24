/**
 * What the grounding ETL reads from the system of record (CB-194): the
 * references turns recorded (`run_refs`, the Runs module's) and the turns
 * items were filed from (`issue_runs`, the Board's). Ids, kinds and times
 * only; nothing here writes.
 */

/** One thing a turn read (`run_refs`). */
export interface SourceRunRef {
    id: number;
    runId: string;
    threadId: string;
    kind: string;
    spaceId: string | null;
    refId: string;
    at: number;
}

/** An item's link to the turn it was filed from (`issue_runs`). */
export interface SourceIssueRun {
    issueId: string;
    runId: string;
    threadId: string;
    via: string;
    createdAt: number;
}

export interface GroundingSourceReader {
    /** Whether the app has made this table yet. */
    has(table: string): boolean;
    /** References after `id`, oldest first. */
    runRefsAfter(id: number, limit: number): SourceRunRef[];
    lastRunRefId(): number;
    /** Every link, in a stable order (a small table, read whole). */
    issueRuns(): SourceIssueRun[];
}
