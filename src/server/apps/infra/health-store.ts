import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import type { AppHealthState } from '@socio/shared/apps/app-types';

/** One `app_health` row (apps 8, CB-291). */
export interface AppHealthRow {
    appId: string;
    state: AppHealthState;
    reason: string | null;
    attempts: number;
    episode: string | null;
    nextAttemptAt: number | null;
    lastRecoveryAt: number | null;
    lastRecoveryReason: string | null;
    lastError: string | null;
    escalatedAt: number | null;
    /** JSON: the SHA-256 hashes of its last data tokens. */
    tokenHashes: string;
    /** A token repair that hasn't held yet (its reason): every runtime resumes it. */
    tokenRepair: string | null;
    /** A repair is running until then (one runtime's claim), or null. */
    leaseUntil: number | null;
    /** Which claim holds the lease: only it may end the repair. */
    leaseClaim: string | null;
    updatedAt: number;
}

export type AppHealthChange = Partial<Omit<AppHealthRow, 'appId' | 'updatedAt'>>;

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const normal = (row: AppHealthRow): AppHealthRow => ({
    ...row,
    attempts: Number(row.attempts),
    nextAttemptAt: num(row.nextAttemptAt),
    lastRecoveryAt: num(row.lastRecoveryAt),
    escalatedAt: num(row.escalatedAt),
    leaseUntil: num(row.leaseUntil),
    updatedAt: Number(row.updatedAt),
});

const EMPTY: Omit<AppHealthRow, 'appId' | 'updatedAt'> = {
    state: 'healthy',
    reason: null,
    attempts: 0,
    episode: null,
    nextAttemptAt: null,
    lastRecoveryAt: null,
    lastRecoveryReason: null,
    lastError: null,
    escalatedAt: null,
    tokenHashes: '[]',
    tokenRepair: null,
    leaseUntil: null,
    leaseClaim: null,
};

/**
 * Apps' self-healing state in `app_health`, which every runtime on the
 * database shares (a blue/green deploy runs two). Reads are plain reads of
 * the table. Every change is one read-modify-write inside one transaction
 * (`BEGIN IMMEDIATE`, queued behind an open unit of work): the decision is
 * made on the row as it is under the write lock, so no change can lose
 * another's. Rows are only upserted, never deleted.
 */
export class SqliteAppHealth {
    constructor(private db: DatabaseSync) {}

    get(appId: string): AppHealthRow | undefined {
        const row = this.db.prepare('SELECT * FROM app_health WHERE appId=?').get(appId) as AppHealthRow | undefined;
        return row && normal(row);
    }

    all(): AppHealthRow[] {
        return (this.db.prepare('SELECT * FROM app_health').all() as unknown as AppHealthRow[]).map(normal);
    }

    /** The app one of whose last tokens has this hash. */
    byTokenHash(hash: string): string | undefined {
        const row = this.db.prepare('SELECT appId FROM app_health WHERE instr(tokenHashes, ?) > 0').get(`"${hash}"`) as
            | { appId: string }
            | undefined;
        return row?.appId;
    }

    /**
     * Decides a change on the row as it is now (`decide` returns null for
     * none) and writes it, atomically. Resolves to the row written, or
     * undefined when there was nothing to write.
     */
    change(
        appId: string,
        decide: (row: AppHealthRow | undefined) => AppHealthChange | null,
        now: number,
    ): Promise<AppHealthRow | undefined> {
        return transaction(this.db, 'app health', () => {
            const current = this.get(appId);
            const change = decide(current);
            if (!change) {
                return undefined;
            }
            const next: AppHealthRow = { appId, ...EMPTY, ...current, ...change, updatedAt: now };
            this.db
                .prepare(
                    `INSERT INTO app_health(appId, state, reason, attempts, episode, nextAttemptAt, lastRecoveryAt, lastRecoveryReason, lastError, escalatedAt, tokenHashes, tokenRepair, leaseUntil, leaseClaim, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(appId) DO UPDATE SET state=excluded.state, reason=excluded.reason, attempts=excluded.attempts, episode=excluded.episode, nextAttemptAt=excluded.nextAttemptAt, lastRecoveryAt=excluded.lastRecoveryAt, lastRecoveryReason=excluded.lastRecoveryReason, lastError=excluded.lastError, escalatedAt=excluded.escalatedAt, tokenHashes=excluded.tokenHashes, tokenRepair=excluded.tokenRepair, leaseUntil=excluded.leaseUntil, leaseClaim=excluded.leaseClaim, updatedAt=excluded.updatedAt`,
                )
                .run(
                    appId,
                    next.state,
                    next.reason,
                    next.attempts,
                    next.episode,
                    next.nextAttemptAt,
                    next.lastRecoveryAt,
                    next.lastRecoveryReason,
                    next.lastError,
                    next.escalatedAt,
                    next.tokenHashes,
                    next.tokenRepair,
                    next.leaseUntil,
                    next.leaseClaim,
                    now,
                );
            return next;
        });
    }
}
