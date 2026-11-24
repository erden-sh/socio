import type { SourceRun } from '@socio/foundation/operations/source-run';

import type { RunSourceShape } from '../contract.js';

/**
 * How the Operations ETL reads the system of record (CB-164): one port,
 * so the SQLite adapter (`infra/sqlite/source-reader.ts`) can give way to
 * a Postgres one later without the DuckDB side changing. Every method is
 * one short read: a batch of at most `ETL_BATCH` rows, or a small table
 * whole. Nothing here writes.
 */

/** The most rows one read returns. */
export const ETL_BATCH = 500;
/**
 * The most stored text (events and trace) one read of turns brings into
 * memory, about 8 MB: a turn's events can be large (a web read's page),
 * and the analytics child shares the app task's memory. A turn larger
 * than this is read alone.
 */
export const ETL_BATCH_BYTES = 8 * 1024 * 1024;

/** A turn as stored: `@socio/foundation/operations/source-run`. */

export interface SourcePerson {
    id: string;
    name: string;
    role: string;
    createdAt: number;
}
export interface SourceSocio {
    id: string;
    name: string;
    spaceId: string;
    ownerId: string | null;
    createdAt: number;
    archivedAt: number | null;
    deletedAt: number | null;
}
export interface SourceSpace {
    id: string;
    name: string;
    createdAt: number;
    deletedAt: number | null;
}
export interface SourceChat {
    id: string;
    socioId: string;
    ownerId: string;
    /** `private` or `room` (CB-207). */
    kind: string;
    /** A room's name (CB-218); never a private chat's title, which is its content's. */
    title: string | null;
    createdAt: number;
    archivedAt: number | null;
    deletedAt: number | null;
}

/** An item on the Improvements board (`issues`), without its text. */
export interface SourceIssue {
    id: string;
    number: number;
    kind: string;
    priority: string;
    status: string;
    reporterId: string;
    createdAt: number;
    closedAt: number | null;
    deletedAt: number | null;
}

/**
 * A failure label in force (CB-198, `classify_labels`): an admin's, or
 * the model's once applied. `idx` is the tool call's place in the trace,
 * -1 for the turn. Never its input text.
 */
export interface SourceLabel {
    seq: number;
    runId: string;
    idx: number;
    label: string;
    source: 'admin' | 'model';
    provider: string | null;
}

/**
 * A session's intent or themes in force (CB-199, `classify_labels`
 * `use` intent or themes): the label of the turn that opened it, an
 * admin's or the model's once applied. Themes' label is JSON
 * (`{ topics, outcome }`). Never its input text.
 */
export interface SourceSessionLabel {
    seq: number;
    use: 'intent' | 'themes';
    runId: string;
    label: string;
    source: 'admin' | 'model';
    provider: string | null;
}

/**
 * A work cycle as stored (`work_cycles`, CB-211): one person's message
 * and every step it led to, with who started it, whose access it used,
 * who paid and what it used. Ids, kinds, counts and times only: never the
 * message, the tools still running when it stopped or its dispatch key.
 */
export interface SourceCycle {
    id: string;
    conversationId: string;
    kind: string;
    initiatorKind: string;
    initiatorId: string | null;
    actingUserId: string;
    /** The socio of its current or last step. */
    dotId: string;
    billingKind: string | null;
    billingUserId: string | null;
    status: string;
    startedAt: number;
    endedAt: number | null;
    /** Time its steps ran, waits between them left out. */
    elapsedMs: number;
    steps: number;
    handoffs: number;
    tokensUsed: number;
    /** Null once any model request did not report its cost. */
    costUsd: number | null;
    costKnown: number | boolean;
    /** The limits it started with (`RoomLimits`), JSON. */
    limits: string;
    endReason: string | null;
}

/**
 * Every read the ETL makes. The turns' reads (`ready`, `runsAfter`,
 * `runsBySeq`) are also what `classify/` asks for, as the `RunSource` tag
 * (`operations/contract.ts`).
 */
export interface SourceReader extends RunSourceShape {
    /** Whether the app has made its tables yet (a new database hasn't). */
    ready(): boolean;
    /**
     * Turns after `seq`, oldest first: at most `limit`, and no more than
     * `maxBytes` of stored text unless the first alone is larger.
     */
    runsAfter(seq: number, limit: number, maxBytes?: number): SourceRun[];
    /** These turns again (the ones still running last time). */
    runsBySeq(seqs: readonly number[]): SourceRun[];
    /** The newest turn's `seq`, for "Rebuilding n%". */
    lastRunSeq(): number;
    people(): SourcePerson[];
    socios(): SourceSocio[];
    spaces(): SourceSpace[];
    chats(): SourceChat[];
    /** Board items after `number`, by number, at most `limit` (CB-189). */
    issuesAfter(number: number, limit: number): SourceIssue[];
    /** Applied failure labels after `seq`, by seq, at most `limit` (CB-198). */
    labelsAfter(seq: number, limit: number): SourceLabel[];
    /** Applied intent and themes labels after `seq`, by seq, at most `limit` (CB-199). */
    sessionLabelsAfter(seq: number, limit: number): SourceSessionLabel[];
    /** The cycles module has made its table (CB-211). */
    hasCycles(): boolean;
    /** Work cycles after `(at, id)` by `(startedAt, id)`, at most `limit` (CB-218). */
    cyclesAfter(mark: { at: number; id: string }, limit: number): SourceCycle[];
    /** These cycles again (the ones not ended last time). */
    cyclesById(ids: readonly string[]): SourceCycle[];
}
