import type { WorkCycle } from '../contract.js';

/**
 * Work cycles' repositories (CB-110 layout, CB-211): plain domain types in
 * and out. Only `cycles/infra` implements them; nothing else reads or
 * writes the cycle tables.
 *
 * Synchronous, unlike most CB-110 repositories, on purpose: the runner
 * asks the cycles at every turn's start and end, and the ledger after
 * every model request, while the turn's own legacy writes run on the same
 * connection. So the service runs each of its reads and writes as one
 * synchronous transaction (`transact`), queued behind any unit of work and
 * never holding the connection across an await. When the turn's writes
 * move to units of work (Postgres, CB-109), these become async.
 */

export type WorkCyclePatch = Partial<Omit<WorkCycle, 'id' | 'conversationId' | 'startedAt'>>;

export interface WorkCycleRepository {
    byId(id: string): WorkCycle | undefined;
    byDispatch(conversationId: string, dispatchKey: string): WorkCycle | undefined;
    /** The conversation's running cycle: its lease. */
    running(conversationId: string): WorkCycle | undefined;
    /** The conversation's cycles waiting for their next step (an approval). */
    waiting(conversationId: string): WorkCycle[];
    /**
     * The conversation's cycles started from `since`, newest first, at
     * most `limit` (a room's use, CB-218).
     */
    recent(conversationId: string, since: number, limit: number): WorkCycle[];
    /** Every cycle with a step running, for the start's reconciliation. */
    allRunning(): WorkCycle[];
    insert(cycle: WorkCycle): void;
    /** Writes `patch`; false when the row is not there. */
    update(id: string, patch: WorkCyclePatch): boolean;
    /**
     * Writes `patch` with nothing waiting on it (a running step's use so
     * far): at once when the connection is free, else queued behind the
     * work ahead (`writeSoon`), so it never holds the connection in the
     * middle of a turn's other writes.
     */
    stamp(id: string, patch: WorkCyclePatch): void;
    /** Ends cycles waiting since before `before`; how many. */
    expireWaiting(before: number, now: number): number;
}

export interface SubmissionRepository {
    /** When the conversation's messages came since `after`, oldest first. */
    since(conversationId: string, after: number): number[];
    add(conversationId: string, actorId: string | null, at: number): void;
    /** Forgets those before `before`; how many. */
    prune(before: number): number;
}

export interface CycleRepositories {
    cycles: WorkCycleRepository;
    submissions: SubmissionRepository;
}
