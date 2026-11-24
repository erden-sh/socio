import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { SourceRun } from '@socio/foundation/operations/source-run';
import { runSources, UNRECORDED_SOURCE } from '@socio/shared/runs/run-sources';

import type {
    SourceChat,
    SourceCycle,
    SourceIssue,
    SourceLabel,
    SourcePerson,
    SourceReader,
    SourceSessionLabel,
    SourceSocio,
    SourceSpace,
} from '../../etl/source-reader.js';

const readers = new WeakMap<DatabaseSync, SqliteSourceReader>();

/**
 * The ETL's reads of the app's database (CB-187), on the analytics
 * process's own read-only `node:sqlite` connection: each method one
 * statement, so one short read transaction that never holds up the app's
 * writer or Litestream's checkpoint (WAL). One per connection.
 */
export function sqliteSourceReader(db: DatabaseSync): SourceReader {
    let reader = readers.get(db);
    if (!reader) {
        readers.set(db, (reader = new SqliteSourceReader(db)));
    }
    return reader;
}

class SqliteSourceReader implements SourceReader {
    private statements = new Map<string, StatementSync>();
    constructor(private db: DatabaseSync) {}

    private has(table: string) {
        return !!this.statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    }
    private statement(sql: string) {
        let statement = this.statements.get(sql);
        if (!statement) {
            this.statements.set(sql, (statement = this.db.prepare(sql)));
        }
        return statement;
    }

    ready() {
        return this.has('agent_runs') && this.has('thread_bindings');
    }

    /**
     * A turn's source: as recorded, else the registered source whose chats
     * hold it (Telegram's), else the web app, as the Runs view reads it.
     * Source keys and table names are checked when they are registered; a
     * source's table counts once the app has made it.
     */
    private runSelect() {
        const byChat = runSources()
            .filter((source) => source.threads && this.has(source.threads.table))
            .map(
                ({ key, threads }) =>
                    `WHEN EXISTS (SELECT 1 FROM "${threads!.table}" WHERE "${threads!.column}" = r.threadId) THEN '${key}'`,
            );
        const fallback = byChat.length
            ? `CASE ${byChat.join(' ')} ELSE '${UNRECORDED_SOURCE}' END`
            : `'${UNRECORDED_SOURCE}'`;
        // A room that was a Telegram topic (CB-214): its source binding.
        const fromTopic = this.has('room_source_bindings')
            ? 'EXISTS (SELECT 1 FROM room_source_bindings s WHERE s.roomId = r.threadId)'
            : '0';
        return `SELECT r.seq, r.runId, r.threadId, r.status, r.startedAt,
        r.finishedAt, COALESCE(r.source, ${fallback}) AS source, r.trace,
        r.events, r.errorDetail IS NOT NULL AS detail, b.dotId AS socioId,
        b.ownerId AS ownerId, b.kind AS chatKind, b.createdBy AS createdBy,
        b.convertedAt AS convertedAt,
        CASE WHEN b.kind = 'room' THEN ${fromTopic} ELSE 0 END AS fromTopic
      FROM agent_runs r LEFT JOIN thread_bindings b ON b.id = r.threadId`;
    }

    runsAfter(seq: number, limit: number, maxBytes = Infinity) {
        // The rows' sizes first (SQLite reads them from the record headers,
        // not the text), then only as many rows as fit.
        const sizes = this.statement(
            `SELECT seq, octet_length(events) + COALESCE(octet_length(trace), 0) AS bytes
        FROM agent_runs WHERE seq > ? ORDER BY seq LIMIT ?`,
        ).all(seq, limit) as { seq: number; bytes: number }[];
        if (!sizes.length) {
            return [];
        }
        let upto = sizes[0]!.seq;
        let total = sizes[0]!.bytes;
        for (const row of sizes.slice(1)) {
            if (total + row.bytes > maxBytes) {
                break;
            }
            total += row.bytes;
            upto = row.seq;
        }
        return this.statement(`${this.runSelect()} WHERE r.seq > ? AND r.seq <= ? ORDER BY r.seq`).all(
            seq,
            upto,
        ) as unknown as SourceRun[];
    }

    runsBySeq(seqs: readonly number[]) {
        if (!seqs.length) {
            return [];
        }
        return this.statement(`${this.runSelect()} WHERE r.seq IN (SELECT value FROM json_each(?)) ORDER BY r.seq`).all(
            JSON.stringify(seqs),
        ) as unknown as SourceRun[];
    }

    lastRunSeq() {
        const row = this.statement('SELECT MAX(seq) AS seq FROM agent_runs').get() as
            | { seq: number | null }
            | undefined;
        return row?.seq ?? 0;
    }

    people() {
        if (!this.has('users')) {
            return [];
        }
        return this.statement(
            'SELECT id, name, role, createdAt FROM users ORDER BY id',
        ).all() as unknown as SourcePerson[];
    }

    socios() {
        if (!this.has('dots')) {
            return [];
        }
        return this.statement(
            'SELECT id, name, spaceId, ownerId, createdAt, archivedAt, deletedAt FROM dots ORDER BY id',
        ).all() as unknown as SourceSocio[];
    }

    spaces() {
        if (!this.has('spaces')) {
            return [];
        }
        return this.statement(
            'SELECT id, name, createdAt, deletedAt FROM spaces ORDER BY id',
        ).all() as unknown as SourceSpace[];
    }

    chats() {
        return this.statement(
            `SELECT id, dotId AS socioId, ownerId, kind,
        CASE WHEN kind = 'room' THEN title END AS title,
        createdAt, archivedAt, deletedAt
      FROM thread_bindings ORDER BY id`,
        ).all() as unknown as SourceChat[];
    }

    issuesAfter(number: number, limit: number) {
        if (!this.has('issues')) {
            return [];
        }
        return this.statement(
            'SELECT id, number, kind, priority, status, reporterId, createdAt, closedAt, deletedAt FROM issues WHERE number > ? ORDER BY number LIMIT ?',
        ).all(number, limit) as unknown as SourceIssue[];
    }

    labelsAfter(seq: number, limit: number) {
        if (!this.has('classify_labels')) {
            return [];
        }
        return this.statement(
            `SELECT seq, runId, idx, label, source, provider FROM classify_labels
        WHERE seq > ? AND use = 'failures' AND applied = 1 ORDER BY seq LIMIT ?`,
        ).all(seq, limit) as unknown as SourceLabel[];
    }

    sessionLabelsAfter(seq: number, limit: number) {
        if (!this.has('classify_labels')) {
            return [];
        }
        return this.statement(
            `SELECT seq, use, runId, label, source, provider FROM classify_labels
        WHERE seq > ? AND use IN ('intent', 'themes') AND idx = -1 AND applied = 1
        ORDER BY seq LIMIT ?`,
        ).all(seq, limit) as unknown as SourceSessionLabel[];
    }

    hasCycles() {
        return this.has('work_cycles');
    }

    cyclesAfter(mark: { at: number; id: string }, limit: number) {
        if (!this.hasCycles()) {
            return [];
        }
        // By the `work_cycles_started` index (cycles 2).
        return this.statement(
            `${CYCLE} WHERE startedAt > ? OR (startedAt = ? AND id > ?) ORDER BY startedAt, id LIMIT ?`,
        ).all(mark.at, mark.at, mark.id, limit) as unknown as SourceCycle[];
    }

    cyclesById(ids: readonly string[]) {
        if (!ids.length || !this.hasCycles()) {
            return [];
        }
        return this.statement(`${CYCLE} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY startedAt, id`).all(
            JSON.stringify(ids),
        ) as unknown as SourceCycle[];
    }
}

/** A work cycle's ids, kinds, counts and times (CB-218): never its message. */
const CYCLE = `SELECT id, conversationId, kind, initiatorKind, initiatorId,
    actingUserId, dotId, billingKind, billingUserId, status, startedAt, endedAt,
    elapsedMs, steps, handoffs, tokensUsed, costUsd, costKnown, limits, endReason
  FROM work_cycles`;
