import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, type DatabaseSync } from 'node:sqlite';
import { clearImmediate, setImmediate } from 'node:timers';

import { ACQUIRE_TIMEOUT_MS, Mutex } from './mutex.js';

/** Work that runs once the outermost unit of work has committed. */
export type AfterCommit = () => void | Promise<void>;

export interface UnitOfWorkOptions {
    /** Names the unit in the lock's timeout and the event-loop guard's report. */
    label?: string;
    /** Inside an open unit of work: a nested one that can roll back alone. */
    savepoint?: boolean;
}

/**
 * One transaction, the data layer's only writer path (CB-110). Repositories
 * find it through the async context, so services just call them inside
 * `run`. Its body does database work only: no network, model calls, timers
 * or file I/O. Slow work goes before `run`, or in `afterCommit`.
 */
export interface UnitOfWork {
    /** One transaction. Nested calls join it; `savepoint` gives a nested one. */
    run<T>(work: () => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
    /**
     * Runs after the outermost commit (never on rollback), in the order
     * given, before that `run` resolves; errors are logged, not thrown.
     * Outside a unit of work it runs at once.
     */
    afterCommit(effect: AfterCommit): void;
}

/** What `ModuleContext.data` gives modules: the platform's unit of work. */
export interface DataContext {
    uow: UnitOfWork;
}

export class UnitOfWorkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnitOfWorkError';
    }
}

interface Tx {
    label: string;
    /** Set at commit or rollback: using it after that is a leak. */
    closed: boolean;
    /** Set when the event-loop guard found it still open. */
    spanned: boolean;
    effects: AfterCommit[];
    savepoints: number;
    /** A write from outside the unit joined it (production only). */
    foreign: boolean;
}

/** What the connection guard watches: writes and transaction control. */
const GUARDED = new Set<number>([
    constants.SQLITE_INSERT,
    constants.SQLITE_UPDATE,
    constants.SQLITE_DELETE,
    constants.SQLITE_TRANSACTION,
    constants.SQLITE_SAVEPOINT,
]);
const CONTROL = new Set<number>([constants.SQLITE_TRANSACTION, constants.SQLITE_SAVEPOINT]);

/**
 * The SQLite unit of work on one connection, which the app's own tables
 * share (`Store`, `WorkspaceStore` and the repositories):
 *
 * 1. an in-process FIFO lock (`Mutex`), so one unit runs at a time;
 * 2. `BEGIN IMMEDIATE`, so the write lock is taken up front and other
 *    processes wait (`busy_timeout`) instead of failing on the upgrade;
 * 3. the work, with the transaction in an `AsyncLocalStorage`;
 * 4. `COMMIT`, or `ROLLBACK` on any error; the lock is released;
 * 5. the `afterCommit` effects.
 *
 * Drizzle's own `transaction()` is not used: its callback must be sync.
 *
 * A unit's body awaits, so while it is open, other async work that is
 * ready in the same turn of the event loop runs too, on the same
 * connection: parallel tool calls in one model step, a `Promise.all`, work
 * started with `void`. (A `setImmediate` check catches only a unit that
 * outlives its turn: that fails tests, `strict`, and is logged once per
 * label in production.) Such work must not write inside the unit, where
 * it would commit or roll back with it. So:
 *
 * - legacy synchronous transactions go through `transact`, which runs
 *   them at once when no unit is open or waiting, and otherwise queues
 *   them on the lock behind it (first come, first served);
 *   `transactSync`, for callers that can't wait, fails loudly instead of
 *   joining another context's unit; records nothing reads back at once
 *   (audit rows, usage stamps) use `writeSoon` (packages/data/src/open.ts), which
 *   queues them the same way without making their callers wait;
 * - a connection guard (SQLite's authorizer) fails any `BEGIN`, `COMMIT`
 *   or savepoint from outside the open unit, and any write from outside it
 *   in tests; in production such a write joins the unit, and is reported
 *   if the unit then rolls it back. Statements are checked when prepared,
 *   so one prepared before the unit opened and run during it is not seen.
 *
 * The rule for new code: on this connection, every write from an async
 * path (a route, a tool, a listener, a timer) goes through `transaction()`
 * or `writeSoon` (packages/data/src/open.ts), or a repository inside `run`; never a
 * bare `.prepare('INSERT …').run()`. Work a listener or `afterCommit`
 * starts that opens its own unit waits for `nextTurn()` (packages/data/src/events.ts)
 * first. New socio tools that write get registered in the interleaving
 * sweep (tests/tool-interleaving-sweep.test.ts); tests/integration/plain-writes.test.ts
 * counts prepared writes outside infra/. See docs/DATA-LAYER.md.
 *
 * `Handle` is what repositories query with (`executor()`): the same for
 * every unit today, since there is one connection; a pooled database
 * would hand out each transaction's own.
 */
export class SqliteUnitOfWork<Handle> implements UnitOfWork {
    private storage = new AsyncLocalStorage<Tx>();
    private lock: Mutex;
    private reported = new Set<string>();
    /** The unit holding the connection's transaction, if any. */
    private current: Tx | undefined;

    constructor(
        private db: DatabaseSync,
        private handle: Handle,
        private options: {
            /** Fail on a spanned or leaked unit; on by default under vitest. */
            strict?: boolean;
            acquireTimeoutMs?: number;
            log?: (line: string) => void;
            /** Lost writes (always reported, never deduplicated): console.error. */
            error?: (line: string) => void;
        } = {},
    ) {
        this.lock = new Mutex(options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
        db.setAuthorizer((action) => this.authorize(action));
    }

    /** The connection guard: see the class notes. */
    private authorize(action: number) {
        const open = this.current;
        if (!open || !GUARDED.has(action) || this.storage.getStore() === open) {
            return constants.SQLITE_OK;
        }
        if (CONTROL.has(action) || this.strict) {
            throw new UnitOfWorkError(
                `A ${CONTROL.has(action) ? 'transaction' : 'write'} from outside the unit of work "${open.label}" ran while it was open: run it through the unit of work, which queues it (CB-110).`,
            );
        }
        open.foreign = true;
        return constants.SQLITE_OK;
    }

    /**
     * Whether a write may run on the connection now, without waiting: in
     * this context's own unit, or with no unit open or queued (CB-110). A
     * write that can't goes through `transact`, behind the units ahead.
     */
    get writable() {
        const tx = this.storage.getStore();
        if (tx && !tx.closed) {
            return true;
        }
        return !this.current && this.lock.heldBy === undefined;
    }

    /** Units and queued writes waiting for the lock (diagnostics, tests). */
    get waiting() {
        return this.lock.waiting;
    }

    /** The label of a unit open on the connection outside this context. */
    get foreignUnit(): string | undefined {
        const open = this.current;
        return open && this.storage.getStore() !== open ? open.label : undefined;
    }

    private get strict() {
        return this.options.strict ?? process.env.VITEST === 'true';
    }

    private log(line: string) {
        (this.options.log ?? ((text) => console.error(text)))(line);
    }

    /** In production, each kind of report once per label. */
    private report(kind: string, label: string, message: string) {
        if (this.strict) {
            throw new UnitOfWorkError(message);
        }
        const key = `${kind}:${label}`;
        if (this.reported.has(key)) {
            return;
        }
        this.reported.add(key);
        this.log(message);
    }

    /** Whether a unit of work is open in this async context. */
    get active() {
        const tx = this.storage.getStore();
        return !!tx && !tx.closed;
    }

    /**
     * What a repository queries with: the open unit's handle, else the base
     * one (a read outside a unit is one autocommit statement). Work that
     * outlived its unit (fire-and-forget) fails in tests.
     */
    executor(): Handle {
        const tx = this.storage.getStore();
        if (tx?.closed) {
            this.report('leak', tx.label, `A unit of work was used after it ended: ${tx.label}`);
        }
        return this.handle;
    }

    async run<T>(
        work: () => Promise<T>,
        { label = 'unit of work', savepoint = false }: UnitOfWorkOptions = {},
    ): Promise<T> {
        const open = this.storage.getStore();
        if (open && !open.closed) {
            return savepoint ? this.nested(open, work) : work();
        }
        // A finished unit's context (a timer it started) begins a new one.
        const release = await this.lock.acquire(label);
        const tx: Tx = {
            label,
            closed: false,
            spanned: false,
            effects: [],
            savepoints: 0,
            foreign: false,
        };
        let result: T;
        try {
            if (this.db.isTransaction) {
                throw new UnitOfWorkError(`A transaction was already open on the connection: ${label}`);
            }
            this.db.exec('BEGIN IMMEDIATE');
            this.current = tx;
            const guard = setImmediate(() => {
                if (!tx.closed) {
                    tx.spanned = true;
                }
            });
            try {
                result = await this.storage.run(tx, work);
                if (tx.spanned) {
                    this.report('spanned', label, `A unit of work spanned the event loop: ${label}`);
                }
                this.current = undefined;
                this.db.exec('COMMIT');
            } finally {
                clearImmediate(guard);
                tx.closed = true;
                this.current = undefined;
                if (this.db.isTransaction) {
                    this.db.exec('ROLLBACK');
                    if (tx.foreign) {
                        (this.options.error ?? ((line) => console.error(line)))(
                            `Data loss: writes from outside the unit of work were rolled back with it: ${label}`,
                        );
                    }
                }
            }
        } finally {
            release();
        }
        for (const effect of tx.effects) {
            try {
                await effect();
            } catch (error) {
                this.log(`After-commit effect failed (${label}): ${error instanceof Error ? error.name : 'unknown'}`);
            }
        }
        return result;
    }

    /**
     * A legacy synchronous transaction (raw SQL on this connection): at once
     * when no other context's unit is open, else queued on the lock behind
     * it; inside this context's unit, a savepoint of it. Callers await it.
     */
    transact<T>(work: () => T, { label = 'transaction' }: { label?: string } = {}): Promise<T> {
        // Behind a unit that is open or waiting for the lock: first come,
        // first served, so writes that depend on each other keep their order.
        if (!this.writable) {
            return this.run(async () => work(), { label, savepoint: true });
        }
        try {
            return Promise.resolve(this.transactSync(work, { label }));
        } catch (error) {
            return Promise.reject(error as Error);
        }
    }

    /**
     * `transact` for a caller that can't wait: it fails while another
     * context's unit is open instead of joining it. A transaction the caller
     * opened itself (a migration, a fixture) is joined.
     */
    transactSync<T>(work: () => T, { label = 'transaction' }: { label?: string } = {}): T {
        const open = this.storage.getStore();
        if (open && !open.closed) {
            const name = `uow_${++open.savepoints}`;
            this.db.exec(`SAVEPOINT ${name}`);
            try {
                const result = work();
                this.db.exec(`RELEASE ${name}`);
                return result;
            } catch (error) {
                this.db.exec(`ROLLBACK TO ${name}`);
                this.db.exec(`RELEASE ${name}`);
                throw error;
            }
        }
        const foreign = this.foreignUnit;
        if (foreign) {
            throw new UnitOfWorkError(
                `"${label}" can't start while the unit of work "${foreign}" is open on the connection: it has to wait for it (transact).`,
            );
        }
        if (this.db.isTransaction) {
            return work();
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            if (this.db.isTransaction) {
                this.db.exec('ROLLBACK');
            }
            throw error;
        }
    }

    /** A savepoint inside the open unit; its effects go if it rolls back. */
    private async nested<T>(tx: Tx, work: () => Promise<T>) {
        const name = `uow_${++tx.savepoints}`;
        const effects = tx.effects.length;
        this.db.exec(`SAVEPOINT ${name}`);
        try {
            const result = await work();
            this.db.exec(`RELEASE ${name}`);
            return result;
        } catch (error) {
            this.db.exec(`ROLLBACK TO ${name}`);
            this.db.exec(`RELEASE ${name}`);
            tx.effects.length = effects;
            throw error;
        }
    }

    afterCommit(effect: AfterCommit) {
        const tx = this.storage.getStore();
        if (tx && !tx.closed) {
            tx.effects.push(effect);
            return;
        }
        void (async () => {
            try {
                await effect();
            } catch (error) {
                this.log(`After-commit effect failed: ${error instanceof Error ? error.name : 'unknown'}`);
            }
        })();
    }
}
