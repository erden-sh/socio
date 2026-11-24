import type { DatabaseSync } from 'node:sqlite';

import type { ModelRecord } from '../../../coding/contract.js';

/**
 * The model gateway's SQL (CB-239), on the shared connection. Every
 * write here runs inside the caller's `transaction()` or `writeSoon`
 * (docs/DATA-LAYER.md); nothing here opens one itself.
 */

type ModelRow = Omit<ModelRecord, 'acceptsImages' | 'outsideProvider' | 'enabled'> & {
    acceptsImages: number;
    outsideProvider: number | null;
    enabled: number;
    /**
     * The mark for dispatch, unused since dispatch was removed (CB-325):
     * the column stays until a later migration drops it, and is never read.
     */
    dispatch?: number;
};

const modelOf = ({ dispatch: _dispatch, ...row }: ModelRow): ModelRecord => ({
    ...row,
    acceptsImages: !!row.acceptsImages,
    outsideProvider: row.outsideProvider === null ? null : row.outsideProvider === 1,
    enabled: !!row.enabled,
});

export class ModelRows {
    constructor(private db: DatabaseSync) {}
    all(): ModelRecord[] {
        return (this.db.prepare('SELECT * FROM gateway_models ORDER BY id').all() as unknown as ModelRow[]).map(
            modelOf,
        );
    }
    get(id: string): ModelRecord | undefined {
        const row = this.db.prepare('SELECT * FROM gateway_models WHERE id=?').get(id) as ModelRow | undefined;
        return row && modelOf(row);
    }
    upsert(model: ModelRecord) {
        this.db
            .prepare(
                `INSERT INTO gateway_models(id, label, backendId, upstreamModel, maxOutputTokens, contextWindow, acceptsImages, outsideProvider, enabled, createdAt, updatedAt, updatedBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, backendId=excluded.backendId,
           upstreamModel=excluded.upstreamModel, maxOutputTokens=excluded.maxOutputTokens,
           contextWindow=excluded.contextWindow, acceptsImages=excluded.acceptsImages,
           outsideProvider=excluded.outsideProvider, enabled=excluded.enabled,
           updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`,
            )
            .run(
                model.id,
                model.label,
                model.backendId,
                model.upstreamModel,
                model.maxOutputTokens,
                model.contextWindow,
                model.acceptsImages ? 1 : 0,
                model.outsideProvider === null ? null : model.outsideProvider ? 1 : 0,
                model.enabled ? 1 : 0,
                model.createdAt,
                model.updatedAt,
                model.updatedBy,
            );
    }
    delete(id: string) {
        this.db.prepare('DELETE FROM gateway_model_repositories WHERE modelId=?').run(id);
        return Number(this.db.prepare('DELETE FROM gateway_models WHERE id=?').run(id).changes);
    }
    repositories(modelId: string): string[] {
        return (
            this.db
                .prepare('SELECT repository FROM gateway_model_repositories WHERE modelId=? ORDER BY repository')
                .all(modelId) as { repository: string }[]
        ).map((row) => row.repository);
    }
    allowedFor(modelId: string, repository: string) {
        return !!this.db
            .prepare('SELECT 1 FROM gateway_model_repositories WHERE modelId=? AND repository=?')
            .get(modelId, repository);
    }
    setRepositories(modelId: string, repositories: readonly string[], by: string, at: number) {
        this.db.prepare('DELETE FROM gateway_model_repositories WHERE modelId=?').run(modelId);
        const insert = this.db.prepare(
            'INSERT INTO gateway_model_repositories(modelId, repository, allowedBy, allowedAt) VALUES (?, ?, ?, ?)',
        );
        for (const repository of repositories) {
            insert.run(modelId, repository, by, at);
        }
    }
}

export class LimitRows {
    constructor(private db: DatabaseSync) {}
    all(): Record<string, number> {
        return Object.fromEntries(
            (
                this.db.prepare('SELECT key, value FROM gateway_limits').all() as {
                    key: string;
                    value: number;
                }[]
            ).map((row) => [row.key, row.value]),
        );
    }
    set(key: string, value: number | null, by: string, at: number) {
        if (value === null) {
            this.db.prepare('DELETE FROM gateway_limits WHERE key=?').run(key);
        } else {
            this.db
                .prepare(
                    `INSERT INTO gateway_limits(key, value, updatedAt, updatedBy) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`,
                )
                .run(key, value, at, by);
        }
    }
}

export interface ReservationRecord {
    id: string;
    sessionId: string;
    personId: string;
    socioId: string;
    grantId: string;
    modelId: string;
    backendId: string;
    runtimeId: string;
    promptTokens: number;
    completionTokens: number;
    createdAt: number;
}

export interface UsageEntry {
    at: number;
    sessionId: string;
    personId: string;
    socioId: string;
    grantId: string;
    modelId: string;
    backendId: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    estimated: boolean;
    latencyMs: number;
    status: string;
}

/** Who a count or a sum is over: a session, a person or socio's window, all. */
export type LedgerScope =
    | { sessionId: string }
    | { personId: string; since: number }
    | { socioId: string; since: number };

const scopeSql = (scope: LedgerScope) =>
    'sessionId' in scope
        ? { usage: 'sessionId=?', open: 'sessionId=?', values: [scope.sessionId] }
        : 'personId' in scope
          ? {
                usage: 'personId=? AND at>?',
                open: 'personId=?',
                values: [scope.personId],
                since: scope.since,
            }
          : {
                usage: 'socioId=? AND at>?',
                open: 'socioId=?',
                values: [scope.socioId],
                since: scope.since,
            };

export class LedgerRows {
    constructor(private db: DatabaseSync) {}
    insertReservation(record: ReservationRecord) {
        this.db
            .prepare(
                `INSERT INTO gateway_reservations(id, sessionId, personId, socioId, grantId, modelId, backendId, runtimeId, promptTokens, completionTokens, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                record.id,
                record.sessionId,
                record.personId,
                record.socioId,
                record.grantId,
                record.modelId,
                record.backendId,
                record.runtimeId,
                record.promptTokens,
                record.completionTokens,
                record.createdAt,
            );
    }
    reservation(id: string): ReservationRecord | undefined {
        return this.db.prepare('SELECT * FROM gateway_reservations WHERE id=?').get(id) as
            | ReservationRecord
            | undefined;
    }
    /** Settles a reservation: true when this call removed it. */
    deleteReservation(id: string) {
        return Number(this.db.prepare('DELETE FROM gateway_reservations WHERE id=?').run(id).changes) > 0;
    }
    reservationsByRuntime(): Map<string, ReservationRecord[]> {
        const out = new Map<string, ReservationRecord[]>();
        for (const row of this.db
            .prepare('SELECT * FROM gateway_reservations ORDER BY createdAt')
            .all() as unknown as ReservationRecord[]) {
            out.set(row.runtimeId, [...(out.get(row.runtimeId) ?? []), row]);
        }
        return out;
    }
    insertUsage(entry: UsageEntry) {
        this.db
            .prepare(
                `INSERT INTO gateway_usage(at, sessionId, personId, socioId, grantId, modelId, backendId, promptTokens, completionTokens, cachedTokens, estimated, latencyMs, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                entry.at,
                entry.sessionId,
                entry.personId,
                entry.socioId,
                entry.grantId,
                entry.modelId,
                entry.backendId,
                entry.promptTokens,
                entry.completionTokens,
                entry.cachedTokens,
                entry.estimated ? 1 : 0,
                entry.latencyMs,
                entry.status,
            );
    }
    /** Requests in flight: open reservations of a session, person, or all. */
    inFlight(scope?: { sessionId: string } | { personId: string }): number {
        const row = !scope
            ? this.db.prepare('SELECT COUNT(*) AS n FROM gateway_reservations').get()
            : 'sessionId' in scope
              ? this.db.prepare('SELECT COUNT(*) AS n FROM gateway_reservations WHERE sessionId=?').get(scope.sessionId)
              : this.db.prepare('SELECT COUNT(*) AS n FROM gateway_reservations WHERE personId=?').get(scope.personId);
        return Number(row?.n ?? 0);
    }
    /** Tokens settled in `scope` plus what its open reservations hold. */
    tokens(scope: LedgerScope): { settled: number; reserved: number } {
        const sql = scopeSql(scope);
        const settled = this.db
            .prepare(
                `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS n FROM gateway_usage WHERE ${sql.usage}`,
            )
            .get(...sql.values, ...(sql.since === undefined ? [] : [sql.since]));
        const reserved = this.db
            .prepare(
                `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS n FROM gateway_reservations WHERE ${sql.open}`,
            )
            .get(...sql.values);
        return {
            settled: Number(settled?.n ?? 0),
            reserved: Number(reserved?.n ?? 0),
        };
    }
    /** Last-24-hours totals by one column, for Settings → Coding. */
    summary(column: 'personId' | 'socioId' | 'modelId', since: number) {
        return (
            this.db
                .prepare(
                    `SELECT ${column} AS id, COUNT(*) AS requests, SUM(promptTokens) AS promptTokens, SUM(completionTokens) AS completionTokens
           FROM gateway_usage WHERE at>? GROUP BY ${column} ORDER BY SUM(promptTokens + completionTokens) DESC LIMIT 50`,
                )
                .all(since) as {
                id: string;
                requests: number;
                promptTokens: number;
                completionTokens: number;
            }[]
        ).map((row) => ({
            id: row.id,
            requests: Number(row.requests),
            promptTokens: Number(row.promptTokens),
            completionTokens: Number(row.completionTokens),
        }));
    }
    noteDropped(sessionId: string, fields: readonly string[], at: number) {
        const statement = this.db.prepare(
            `INSERT INTO gateway_dropped_fields(sessionId, field, count, lastAt) VALUES (?, ?, 1, ?)
       ON CONFLICT(sessionId, field) DO UPDATE SET count=count+1, lastAt=excluded.lastAt`,
        );
        for (const field of fields) {
            statement.run(sessionId, field, at);
        }
    }
    droppedFields(sessionId: string) {
        return (
            this.db
                .prepare(
                    'SELECT field, count FROM gateway_dropped_fields WHERE sessionId=? ORDER BY count DESC, field LIMIT 50',
                )
                .all(sessionId) as { field: string; count: number }[]
        ).map((row) => ({ field: row.field, count: Number(row.count) }));
    }
    distinctDropped(sessionId: string) {
        return Number(
            this.db.prepare('SELECT COUNT(*) AS n FROM gateway_dropped_fields WHERE sessionId=?').get(sessionId)?.n ??
                0,
        );
    }
}
