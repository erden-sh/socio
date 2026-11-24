/**
 * Runtime ownership (CB-108): each process's runtime identity, and its fenced
 * work leases, singletons and cross-runtime signals on one database, by
 * SQLite's writer transaction. Moved from the server's `runtime/ownership.ts`
 * and the shapes from its contract, which re-exports them: the turn runner,
 * which makes the process's identity, sits below the runtime feature, and
 * reaches this from here.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { SchemaSet } from './migrate.js';
import { transaction, transactionSync } from './open.js';

/** A fenced lease on a resource: whose it is, and at which epoch. */
export interface WorkLease {
    resource: string;
    ownerId: string;
    epoch: number;
}

/**
 * A claim found the work owned by a live runtime. Thrown synchronously by
 * `claimWithin` (and `claim`) and caught with `instanceof`; kept a plain
 * `Error` so its name and message stay what they are today.
 */
export class OwnershipError extends Error {
    constructor() {
        super('Work is already owned by a live runtime.');
    }
}

// ── Ownership (one per database) ──────────────────────────────────────────

/**
 * This runtime's ownership on one database (`RuntimeSession.attach`): fenced
 * work leases, singletons, cross-runtime signals. Synchronous, as SQLite is;
 * the `Sync` methods and `claim` open their own writer transaction, the
 * `Within` ones run inside the caller's. `RuntimeOwnership` implements it.
 */
export interface RuntimeOwnershipShape {
    readonly db: DatabaseSync;
    readonly session: RuntimeIdentityShape;
    /** Whether a runtime is registered, unreleased and within its lease. */
    instanceAlive(id: string, now?: number): boolean;
    owns(lease: WorkLease): boolean;
    workAlive(kind: string, id: string): boolean;
    /** A finished batch may still have its live owner's settlement callback pending. */
    workOwnerAlive(kind: string, id: string): boolean;
    /** Claim and the caller's insert share one transaction and roll back together. */
    claim<T>(kind: string, id: string, resource: string, work: (lease: WorkLease) => T): T;
    /** `claim` inside the caller's open writer transaction; throws `OwnershipError`. */
    claimWithin(kind: string, id: string, resource: string): WorkLease;
    /** One live owner per background service; null while another holds it. */
    claimSingleton(name: string): WorkLease | null;
    /** The check and mutation run in the same writer transaction. */
    guarded<T>(lease: WorkLease, work: () => T): { owned: true; value: T } | { owned: false };
    release(lease: WorkLease): boolean;
    /** `release` inside the caller's open writer transaction. */
    releaseWithin(lease: WorkLease): boolean;
    /** The work's current lease row, whoever holds it. */
    workLease(kind: string, id: string): WorkLease | undefined;
    /** Records the version of a cross-runtime contract this runtime enforces (CB-232). */
    recordContract(contract: string, version: number): void;
    /** Whether a live runtime enforces an older `contract` than `version`, or none. */
    contractBehind(contract: string, version: number, now?: number): boolean;
    /** Takes over work whose owner released or lost its lease; null otherwise. */
    takeOver(kind: string, id: string): WorkLease | null;
    /** Whether any runtime but this one is alive. */
    othersAlive(now?: number): boolean;
    /** The live runtime other than this one that owns the work, if any. */
    remoteOwner(kind: string, id: string): string | undefined;
    /** Asks the live runtime that owns the work to act on it; false when none does. */
    signalSync(kind: string, id: string, signal: string, reason?: string): boolean;
    /** `signalSync` for a connection shared with asynchronous units of work. */
    signal(kind: string, id: string, signal: string, reason?: string): Promise<boolean>;
    /** Whether a signal waits for this work; read-only. */
    hasSignal(kind: string, id: string, signal: string): boolean;
    /** Consumes a signal: its reason (or '') once, undefined when there is none. */
    takeSignalSync(kind: string, id: string, signal: string): string | undefined;
    /** `takeSignalSync` for a connection shared with asynchronous units of work. */
    takeSignal(kind: string, id: string, signal: string): Promise<string | undefined>;
    /** Legacy rows have no owner: recovers one once. */
    recoverOrphan<T>(kind: string, id: string, work: () => T): { recovered: true; value: T } | { recovered: false };
    /** Forgets what dead runtimes left behind a day after they ended; how many rows went. */
    prune(): Promise<number>;
}

/**
 * This process's runtime identity (CB-108), shared by its turns, job runs
 * and leader lease: one per process, attached to each database it uses.
 * `RuntimeSession` implements it; today `LocalAgentRunner` makes it.
 */
export interface RuntimeIdentityShape {
    readonly id: string;
    readonly leaseMs: number;
    readonly now: () => number;
    /** This runtime's ownership on `db`, made once per connection. */
    attach(db: DatabaseSync): RuntimeOwnershipShape;
    /** Starts the heartbeat, after a committed claim. */
    keepAlive(): void;
    /** Releases this runtime on `db` (unless another attached connection shares it). */
    detach(db: DatabaseSync): Promise<void>;
    /** `detach` for a connection with no asynchronous units of work. */
    detachSync(db: DatabaseSync): void;
}

// ── The implementation ───────────────────────────────────────────────────

/** Coordination metadata only: no credentials, prompts, event bodies or tokens. */
export const runtimeSchema: SchemaSet = {
    id: 'runtime',
    migrations: [
        {
            version: 1,
            name: 'runtime identities and fenced work ownership',
            up: `CREATE TABLE runtime_instances(id TEXT PRIMARY KEY, startedAt INTEGER NOT NULL, heartbeatAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, releasedAt INTEGER);
      CREATE TABLE runtime_leases(resource TEXT PRIMARY KEY, ownerId TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch > 0), expiresAt INTEGER NOT NULL, releasedAt INTEGER);
      CREATE INDEX runtime_leases_owner ON runtime_leases(ownerId);
      CREATE TABLE runtime_work(kind TEXT NOT NULL, id TEXT NOT NULL, resource TEXT NOT NULL, ownerId TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX runtime_work_owner ON runtime_work(ownerId);
      CREATE TABLE runtime_recoveries(kind TEXT NOT NULL, id TEXT NOT NULL, recoveredAt INTEGER NOT NULL, PRIMARY KEY(kind,id));`,
        },
        {
            version: 2,
            name: 'cross-runtime signals and data tokens',
            phase: 'expand',
            // Stop/cancel requests for work another runtime owns, which it polls
            // (CB-108). Data tokens by SHA-256 hash only, never the token itself:
            // any runtime accepts them while the one that issued them lives.
            up: `CREATE TABLE runtime_signals(kind TEXT NOT NULL, id TEXT NOT NULL, signal TEXT NOT NULL, reason TEXT, requestedAt INTEGER NOT NULL, PRIMARY KEY(kind,id,signal));
      CREATE TABLE runtime_data_tokens(hash TEXT PRIMARY KEY, issuer TEXT NOT NULL, session TEXT NOT NULL, dotId TEXT NOT NULL, purpose TEXT NOT NULL, scope TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE INDEX runtime_data_tokens_session ON runtime_data_tokens(session);
      CREATE INDEX runtime_data_tokens_dot ON runtime_data_tokens(dotId);
      CREATE INDEX runtime_data_tokens_issuer ON runtime_data_tokens(issuer);`,
        },
        {
            version: 3,
            name: 'contract versions each runtime enforces',
            phase: 'expand',
            // Which version of a cross-runtime contract each runtime enforces,
            // e.g. CB-232's actor access: work that relies on
            // every live runtime enforcing it waits while one records an older
            // version, or none. A side table, not a runtime_instances column: a
            // release before this one registers with a positional INSERT.
            up: `CREATE TABLE runtime_contracts(runtimeId TEXT NOT NULL, contract TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), PRIMARY KEY(runtimeId, contract));`,
        },
    ],
};

/** How long a released or expired runtime's bookkeeping is kept for diagnosis. */
export const RUNTIME_HISTORY_MS = 24 * 60 * 60_000;
/** An unanswered signal (its work ended meanwhile) is dropped after this. */
const SIGNAL_TTL_MS = 60 * 60_000;
/**
 * The lease a runtime holds by default. Graceful handover releases it at
 * once; only a crashed or frozen runtime is waited out this long, so it is
 * generous: an event-loop stall shorter than this never costs ownership.
 */
export const DEFAULT_LEASE_MS = 30_000;

interface StoredLease extends WorkLease {
    expiresAt: number;
    releasedAt: number | null;
}
/** One runtime identity, shared by its runner and jobs, even in split-DB tests. */
export class RuntimeSession implements RuntimeIdentityShape {
    readonly id: string;
    private repositories = new Map<DatabaseSync, RuntimeOwnership>();
    private timer?: ReturnType<typeof setInterval>;
    private renewing = false;
    readonly leaseMs: number;
    readonly now: () => number;
    constructor(
        private options: {
            leaseMs?: number;
            heartbeatMs?: number;
            /** Explicitly disabled only by lease-expiry tests. */
            heartbeat?: boolean;
            now?: () => number;
        } = {},
    ) {
        this.id = randomUUID();
        this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
        this.now = options.now ?? Date.now;
        if (!Number.isInteger(this.leaseMs) || this.leaseMs < 100) {
            throw new Error('Runtime lease must be at least 100 ms.');
        }
        const every = options.heartbeatMs ?? Math.floor(this.leaseMs / 3);
        if (!Number.isInteger(every) || every <= 0 || every >= this.leaseMs) {
            throw new Error('Runtime heartbeat must be shorter than its lease.');
        }
    }
    attach(db: DatabaseSync): RuntimeOwnership {
        let repository = this.repositories.get(db);
        if (!repository) {
            repository = new RuntimeOwnership(db, this);
            this.repositories.set(db, repository);
        }
        return repository;
    }
    /** Starts only after a committed claim; idle fixtures don't acquire timers. */
    keepAlive() {
        if (this.timer || this.options.heartbeat === false) {
            return;
        }
        this.timer = setInterval(
            () => {
                if (this.renewing) {
                    return;
                }
                this.renewing = true;
                void Promise.all(
                    [...this.repositories.values()].map((repository) =>
                        repository.heartbeat().catch(() => {
                            // A failed renewal never extends authority; guards fail closed at expiry.
                            console.error('Runtime ownership heartbeat failed; authority will expire.');
                        }),
                    ),
                ).finally(() => {
                    this.renewing = false;
                });
            },
            this.options.heartbeatMs ?? Math.floor(this.leaseMs / 3),
        );
        this.timer.unref();
    }
    private remove(db: DatabaseSync) {
        this.repositories.delete(db);
        if (!this.repositories.size) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    private sharesDatabase(repository: RuntimeOwnership, departing: DatabaseSync) {
        return [...this.repositories].some(
            ([db, other]) => db !== departing && db.isOpen && repository.sameDatabase(other),
        );
    }
    /** The private runner connection has no asynchronous units of work to await. */
    detachSync(db: DatabaseSync) {
        const repository = this.repositories.get(db);
        if (repository && db.isOpen && !this.sharesDatabase(repository, db)) {
            repository.releaseRuntimeSync();
        }
        this.remove(db);
    }
    async detach(db: DatabaseSync) {
        const repository = this.repositories.get(db);
        if (repository && db.isOpen && !this.sharesDatabase(repository, db)) {
            await repository.releaseRuntime();
        }
        this.remove(db);
    }
}

/** SQLite's writer transaction, not an in-process mutex, arbitrates all epochs. */
export class RuntimeOwnership implements RuntimeOwnershipShape {
    constructor(
        readonly db: DatabaseSync,
        readonly session: RuntimeSession,
    ) {
        transactionSync(db, 'register runtime', () => {
            const now = session.now();
            db.prepare('INSERT OR IGNORE INTO runtime_instances VALUES(?,?,?,?,NULL)').run(
                session.id,
                now,
                now,
                now + session.leaseMs,
            );
        });
    }
    sameDatabase(other: RuntimeOwnership) {
        const path = this.db.prepare('PRAGMA database_list').get()?.file;
        return !!path && path === other.db.prepare('PRAGMA database_list').get()?.file;
    }
    private renew(now: number) {
        this.db
            .prepare('UPDATE runtime_instances SET heartbeatAt=?, expiresAt=? WHERE id=? AND releasedAt IS NULL')
            .run(now, now + this.session.leaseMs, this.session.id);
        // An expired lease is never resurrected by a late heartbeat.
        this.db
            .prepare('UPDATE runtime_leases SET expiresAt=? WHERE ownerId=? AND releasedAt IS NULL AND expiresAt>?')
            .run(now + this.session.leaseMs, this.session.id, now);
    }
    heartbeat() {
        if (!this.db.isOpen) {
            return Promise.resolve();
        }
        return transaction(this.db, 'renew runtime ownership', () => this.renew(this.session.now()));
    }
    private releaseRuntimeAt(now: number) {
        this.db
            .prepare('UPDATE runtime_instances SET releasedAt=? WHERE id=? AND releasedAt IS NULL')
            .run(now, this.session.id);
        this.db
            .prepare('UPDATE runtime_leases SET releasedAt=? WHERE ownerId=? AND releasedAt IS NULL')
            .run(now, this.session.id);
    }
    releaseRuntimeSync() {
        return transactionSync(this.db, 'release runtime ownership', () => this.releaseRuntimeAt(this.session.now()));
    }
    releaseRuntime() {
        return transaction(this.db, 'release runtime ownership', () => this.releaseRuntimeAt(this.session.now()));
    }
    /** Whether a runtime is registered, unreleased and within its lease. */
    instanceAlive(id: string, now = this.session.now()) {
        return !!this.db
            .prepare('SELECT 1 FROM runtime_instances WHERE id=? AND releasedAt IS NULL AND expiresAt>?')
            .get(id, now);
    }
    private leaseAlive(lease: WorkLease, now = this.session.now()): boolean {
        if (!this.db.isOpen || !this.instanceAlive(lease.ownerId, now)) {
            return false;
        }
        return !!this.db
            .prepare(
                'SELECT 1 FROM runtime_leases WHERE resource=? AND ownerId=? AND epoch=? AND releasedAt IS NULL AND expiresAt>?',
            )
            .get(lease.resource, lease.ownerId, lease.epoch, now);
    }
    owns(lease: WorkLease): boolean {
        return lease.ownerId === this.session.id && this.leaseAlive(lease);
    }
    workAlive(kind: string, id: string) {
        const row = this.db
            .prepare('SELECT resource, ownerId, epoch FROM runtime_work WHERE kind=? AND id=?')
            .get(kind, id) as unknown as WorkLease | undefined;
        return !!row && this.leaseAlive(row);
    }
    /** A finished batch may still have its live owner's settlement callback pending. */
    workOwnerAlive(kind: string, id: string) {
        const row = this.db.prepare('SELECT ownerId FROM runtime_work WHERE kind=? AND id=?').get(kind, id);
        return (
            !!row &&
            this.instanceAlive(String(row.ownerId), this.session.now()) &&
            !this.db.prepare('SELECT 1 FROM runtime_recoveries WHERE kind=? AND id=?').get(kind, id)
        );
    }
    /** Claim and the caller's insert share one transaction and roll back together. */
    claim<T>(kind: string, id: string, resource: string, work: (lease: WorkLease) => T): T {
        const result = transactionSync(this.db, 'claim runtime work', () => work(this.claimWithin(kind, id, resource)));
        this.session.keepAlive();
        return result;
    }
    /**
     * `claim` inside the caller's open writer transaction (`transaction()`),
     * for work created on an async path. The caller then calls
     * `session.keepAlive()` once it has committed.
     */
    claimWithin(kind: string, id: string, resource: string): WorkLease {
        const lease = this.acquire(resource);
        if (!lease) {
            throw new OwnershipError();
        }
        this.db
            .prepare('INSERT INTO runtime_work VALUES(?,?,?,?,?)')
            .run(kind, id, resource, lease.ownerId, lease.epoch);
        return lease;
    }
    /**
     * One live owner per background service. Contention is normal at startup,
     * so a candidate receives null and must leave the incumbent running.
     * Repeated admission by the live owner keeps its epoch. Released/expired
     * admissions always advance it, including a late return of the old owner.
     * No work-history row is inserted for a long-lived singleton.
     * Callers must fence each database mutation with guarded(); this admission
     * alone cannot fence external effects (polling, network calls or containers).
     */
    claimSingleton(name: string): WorkLease | null {
        if (!name.trim()) {
            throw new Error('A runtime singleton needs a name.');
        }
        const lease = transactionSync(this.db, 'claim runtime singleton', () => {
            const resource = `singleton:${name}`;
            const previous = this.db
                .prepare('SELECT resource, ownerId, epoch FROM runtime_leases WHERE resource=?')
                .get(resource) as unknown as WorkLease | undefined;
            if (previous && this.owns(previous)) {
                return previous;
            }
            return this.acquire(resource);
        });
        if (lease) {
            this.session.keepAlive();
        }
        return lease;
    }

    /** Must run under the connection's writer transaction. */
    private acquire(resource: string): WorkLease | null {
        const now = this.session.now();
        const instance = this.db.prepare('SELECT releasedAt FROM runtime_instances WHERE id=?').get(this.session.id);
        if (!instance || instance.releasedAt !== null) {
            return null;
        }
        const previous = this.db.prepare('SELECT * FROM runtime_leases WHERE resource=?').get(resource) as unknown as
            | StoredLease
            | undefined;
        // Check the incumbent before renewing this runtime: a missed heartbeat
        // must not resurrect its expired authority through a new admission.
        if (previous && this.leaseAlive(previous, now)) {
            return null;
        }
        this.renew(now);
        const lease = {
            resource,
            ownerId: this.session.id,
            epoch: (previous?.epoch ?? 0) + 1,
        };
        this.db
            .prepare(
                'INSERT INTO runtime_leases VALUES(?,?,?,?,NULL) ON CONFLICT(resource) DO UPDATE SET ownerId=excluded.ownerId,epoch=excluded.epoch,expiresAt=excluded.expiresAt,releasedAt=NULL',
            )
            .run(resource, lease.ownerId, lease.epoch, now + this.session.leaseMs);
        return lease;
    }

    /** The check and mutation must remain in this same writer transaction. */
    guarded<T>(lease: WorkLease, work: () => T): { owned: true; value: T } | { owned: false } {
        return transactionSync(this.db, 'fenced runtime write', () =>
            this.owns(lease) ? { owned: true as const, value: work() } : { owned: false as const },
        );
    }
    release(lease: WorkLease) {
        return transactionSync(this.db, 'release work lease', () => this.releaseWithin(lease));
    }
    /** `release` inside the caller's open writer transaction. */
    releaseWithin(lease: WorkLease) {
        if (lease.ownerId !== this.session.id) {
            return false;
        }
        return (
            Number(
                this.db
                    .prepare(
                        'UPDATE runtime_leases SET releasedAt=? WHERE resource=? AND ownerId=? AND epoch=? AND releasedAt IS NULL',
                    )
                    .run(this.session.now(), lease.resource, lease.ownerId, lease.epoch).changes,
            ) > 0
        );
    }
    /** The work's current lease row, whoever holds it. */
    workLease(kind: string, id: string): WorkLease | undefined {
        return this.db
            .prepare('SELECT resource, ownerId, epoch FROM runtime_work WHERE kind=? AND id=?')
            .get(kind, id) as unknown as WorkLease | undefined;
    }

    /**
     * Records the version of a cross-runtime contract this runtime enforces
     * (CB-232): `contractBehind` on any runtime then sees it.
     */
    recordContract(contract: string, version: number) {
        if (!Number.isInteger(version) || version < 1) {
            throw new Error('A contract version is a positive whole number.');
        }
        transactionSync(this.db, 'record runtime contract', () => {
            this.db
                .prepare(
                    'INSERT INTO runtime_contracts VALUES(?,?,?) ON CONFLICT(runtimeId, contract) DO UPDATE SET version=excluded.version',
                )
                .run(this.session.id, contract, version);
        });
    }
    /**
     * Whether a live runtime enforces an older `contract` than `version`, or
     * records none (a release from before it): work that needs every runtime
     * to enforce it waits until that one exits.
     */
    contractBehind(contract: string, version: number, now = this.session.now()) {
        return !!this.db
            .prepare(
                `SELECT 1 FROM runtime_instances i LEFT JOIN runtime_contracts c ON c.runtimeId = i.id AND c.contract = ?
         WHERE i.releasedAt IS NULL AND i.expiresAt > ? AND (c.version IS NULL OR c.version < ?) LIMIT 1`,
            )
            .get(contract, now, version);
    }

    /**
     * Takes over work whose owner released or lost its lease (a drained or
     * dead runtime's broker context or prompt run, CB-232): a new
     * epoch of the work's lease, owned here. Null while a live owner holds
     * it, or for work never claimed.
     */
    takeOver(kind: string, id: string): WorkLease | null {
        const lease = transactionSync(this.db, 'take over runtime work', () => {
            const row = this.db.prepare('SELECT resource FROM runtime_work WHERE kind=? AND id=?').get(kind, id) as
                | { resource: string }
                | undefined;
            if (!row) {
                return null;
            }
            const taken = this.acquire(row.resource);
            if (!taken) {
                return null;
            }
            this.db
                .prepare('UPDATE runtime_work SET ownerId=?, epoch=? WHERE kind=? AND id=?')
                .run(taken.ownerId, taken.epoch, kind, id);
            return taken;
        });
        if (lease) {
            this.session.keepAlive();
        }
        return lease;
    }

    /** Whether any runtime but this one is alive (registered and unexpired). */
    othersAlive(now = this.session.now()) {
        return !!this.db
            .prepare('SELECT 1 FROM runtime_instances WHERE id<>? AND releasedAt IS NULL AND expiresAt>? LIMIT 1')
            .get(this.session.id, now);
    }

    /**
     * The live runtime other than this one that owns the work, if any: where
     * a stop or a stream for it has to go (CB-108).
     */
    remoteOwner(kind: string, id: string): string | undefined {
        const row = this.db
            .prepare('SELECT resource, ownerId, epoch FROM runtime_work WHERE kind=? AND id=?')
            .get(kind, id) as unknown as WorkLease | undefined;
        return row && row.ownerId !== this.session.id && this.leaseAlive(row) ? row.ownerId : undefined;
    }

    private signalAt(kind: string, id: string, signal: string, reason?: string) {
        if (!this.remoteOwner(kind, id)) {
            return false;
        }
        this.db
            .prepare(
                'INSERT INTO runtime_signals VALUES(?,?,?,?,?) ON CONFLICT(kind,id,signal) DO UPDATE SET reason=excluded.reason, requestedAt=excluded.requestedAt',
            )
            .run(kind, id, signal, reason ?? null, this.session.now());
        return true;
    }
    /**
     * Asks the live runtime that owns the work to act on it (`stop`), for a
     * request that reached this one. False when no other live runtime owns
     * it: the caller handles it here, or there is nothing to stop. The owner
     * polls with `takeSignal`.
     */
    signalSync(kind: string, id: string, signal: string, reason?: string) {
        return transactionSync(this.db, 'signal runtime work', () => this.signalAt(kind, id, signal, reason));
    }
    /** `signalSync` for a connection shared with asynchronous units of work. */
    signal(kind: string, id: string, signal: string, reason?: string) {
        return transaction(this.db, 'signal runtime work', () => this.signalAt(kind, id, signal, reason));
    }
    /** Whether a signal waits for this work; read-only, for frequent polls. */
    hasSignal(kind: string, id: string, signal: string) {
        return !!this.db
            .prepare('SELECT 1 FROM runtime_signals WHERE kind=? AND id=? AND signal=?')
            .get(kind, id, signal);
    }
    /**
     * Consumes a signal for work this runtime owns: its reason (or '') once,
     * undefined when there is none. Callers check `hasSignal` first.
     */
    takeSignalSync(kind: string, id: string, signal: string) {
        return transactionSync(this.db, 'take runtime signal', () => {
            const row = this.db
                .prepare('SELECT reason FROM runtime_signals WHERE kind=? AND id=? AND signal=?')
                .get(kind, id, signal) as { reason: string | null } | undefined;
            if (!row) {
                return undefined;
            }
            this.db.prepare('DELETE FROM runtime_signals WHERE kind=? AND id=? AND signal=?').run(kind, id, signal);
            return row.reason ?? '';
        });
    }
    /** `takeSignalSync` for a connection shared with asynchronous units of work. */
    takeSignal(kind: string, id: string, signal: string) {
        return transaction(this.db, 'take runtime signal', () => {
            const row = this.db
                .prepare('SELECT reason FROM runtime_signals WHERE kind=? AND id=? AND signal=?')
                .get(kind, id, signal) as { reason: string | null } | undefined;
            if (!row) {
                return undefined;
            }
            this.db.prepare('DELETE FROM runtime_signals WHERE kind=? AND id=? AND signal=?').run(kind, id, signal);
            return row.reason ?? '';
        });
    }

    /**
     * Forgets what dead runtimes left behind, a day after they ended: their
     * instance rows, work rows, recoveries, unanswered signals and data
     * tokens. Never a live runtime's, and never a lease row (its epoch must
     * only ever grow). Returns how many rows went.
     */
    prune() {
        return transaction(this.db, 'prune runtime history', () => {
            const now = this.session.now();
            const before = now - RUNTIME_HISTORY_MS;
            const dead = `SELECT id FROM runtime_instances WHERE id<>? AND (releasedAt IS NOT NULL OR expiresAt<=?)`;
            let removed = 0;
            removed += Number(
                this.db
                    .prepare(`DELETE FROM runtime_data_tokens WHERE expiresAt<=? OR issuer IN (${dead})`)
                    .run(now, this.session.id, now).changes,
            );
            removed += Number(
                this.db.prepare('DELETE FROM runtime_signals WHERE requestedAt<=?').run(now - SIGNAL_TTL_MS).changes,
            );
            removed += Number(
                this.db
                    .prepare(
                        `DELETE FROM runtime_work WHERE ownerId IN (SELECT id FROM runtime_instances WHERE id<>? AND COALESCE(releasedAt, expiresAt)<=?)`,
                    )
                    .run(this.session.id, before).changes,
            );
            removed += Number(
                this.db.prepare('DELETE FROM runtime_recoveries WHERE recoveredAt<=?').run(before).changes,
            );
            removed += Number(
                this.db
                    .prepare(
                        `DELETE FROM runtime_instances WHERE id<>? AND COALESCE(releasedAt, expiresAt)<=? AND id NOT IN (SELECT ownerId FROM runtime_leases)`,
                    )
                    .run(this.session.id, before).changes,
            );
            removed += Number(
                this.db
                    .prepare('DELETE FROM runtime_contracts WHERE runtimeId NOT IN (SELECT id FROM runtime_instances)')
                    .run().changes,
            );
            return removed;
        });
    }

    /** Legacy rows have no owner: the first upgrade must still be stop-first. */
    recoverOrphan<T>(kind: string, id: string, work: () => T): { recovered: true; value: T } | { recovered: false } {
        return transactionSync(this.db, 'recover orphan runtime work', () => {
            if (
                this.workAlive(kind, id) ||
                this.db.prepare('SELECT 1 FROM runtime_recoveries WHERE kind=? AND id=?').get(kind, id)
            ) {
                return { recovered: false as const };
            }
            const value = work();
            this.db.prepare('INSERT INTO runtime_recoveries VALUES(?,?,?)').run(kind, id, this.session.now());
            return { recovered: true as const, value };
        });
    }
}
