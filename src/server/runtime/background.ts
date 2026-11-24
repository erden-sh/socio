import { transaction } from '@socio/data/open';
import type { RuntimeOwnership, WorkLease } from '@socio/data/runtime-ownership';

/** What the leader's work checks before each claim or effect. */
export interface LeaderAuthority {
    /** Aborted when this runtime stops leading. */
    readonly signal: AbortSignal;
    /** Rechecks the lease in the database (after waiting for a writer, too). */
    current(): boolean;
}

export type LeaderState =
    /** Not leading yet: another runtime leads, or none has asked. */
    | 'follower'
    | 'leader'
    /** Its lease lapsed (a stall past the lease); it is trying to renew. */
    | 'lapsed'
    /** Another runtime led meanwhile: this one stopped leading for good. */
    | 'superseded'
    | 'stopped';

export interface LeaderHooks {
    /** Starts the singleton work. Called at most once per process. */
    start(authority: LeaderAuthority): void | Promise<void>;
    /**
     * Called once, when no other runtime is alive any more (at once on an
     * ordinary restart; after the previous task exits in a start-first
     * deploy): recovery that treats what is left running as a dead
     * process's. Never while the runtime that ran it may still finish it.
     */
    succeed?(authority: LeaderAuthority): void | Promise<void>;
    /** Stops the singleton work for good: drain, or superseded. */
    stop(): void | Promise<void>;
    /** Another runtime led meanwhile; this process should restart. */
    superseded?(): void;
    error?(error: unknown): void;
    log?(line: string): void;
}

/**
 * One leader among the app's runtimes (CB-108): the one process that runs
 * the scheduler, Telegram polling, the modules' ticks, backups and the
 * other work that must run once. Every runtime campaigns; the lease is a
 * fenced singleton in SQLite (`claimSingleton`), so its epoch only grows
 * and a stale leader's database writes fail through `current()`.
 *
 * Handover is graceful: a draining leader stops its work, then releases,
 * and a follower takes over at its next check (under a second). A leader
 * that stalled past its lease renews only if no one led in between (the
 * next epoch is its own); otherwise it stops its work and reports
 * `superseded`, so external effects (polling, network calls) of two
 * leaders overlap at most for that one stall.
 *
 * Per-run leases (turns, job runs) are separate: a draining leader's runs
 * finish under their own leases after it hands over.
 */
export class LeaderLease {
    private timer?: ReturnType<typeof setInterval>;
    private lease?: WorkLease;
    private controller = new AbortController();
    private operation?: Promise<void>;
    private stopping?: Promise<void>;
    private started = false;
    private succeeded = false;
    state: LeaderState = 'follower';

    constructor(
        private ownership: RuntimeOwnership,
        private name: string,
        private hooks: LeaderHooks,
        private options: { checkMs?: number } = {},
    ) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
            throw new Error('Invalid leader lease name.');
        }
    }

    /** The lease, as the database has it now; false once it lapsed. */
    current = (): boolean =>
        this.state === 'leader' && !!this.lease && this.ownership.db.isOpen && this.ownership.owns(this.lease);

    /** The epoch held, for status and tests. */
    get epoch() {
        return this.lease?.epoch;
    }

    /** Campaigns from now on: leads at once if no live runtime does. */
    start() {
        if (this.timer || this.state !== 'follower') {
            return this.operation;
        }
        this.timer = setInterval(
            () => void this.check(),
            this.options.checkMs ?? Math.min(1000, Math.floor(this.ownership.session.leaseMs / 3)),
        );
        this.timer.unref();
        return this.check();
    }

    /**
     * Drain: no longer campaigns, stops the leader's work, then releases the
     * lease, so a successor never overlaps it. Idempotent.
     */
    stop(): Promise<void> {
        if (this.stopping) {
            return this.stopping;
        }
        clearInterval(this.timer);
        this.timer = undefined;
        const previous = this.state;
        if (previous !== 'superseded') {
            this.state = 'stopped';
        }
        this.stopping = (async () => {
            await this.operation?.catch(() => {});
            this.controller.abort(new Error('Leadership ended.'));
            if (previous === 'superseded') {
                return;
            }
            await this.finish();
        })();
        return this.stopping;
    }

    /** One step; public for deterministic tests and diagnostics. */
    check(): Promise<void> {
        if (this.operation) {
            return this.operation;
        }
        const operation = this.advance()
            .catch((error: unknown) => this.hooks.error?.(error))
            .finally(() => {
                if (this.operation === operation) {
                    this.operation = undefined;
                }
            });
        this.operation = operation;
        return operation;
    }

    private claim() {
        // Queued behind any open unit of work on the shared connection.
        return transaction(this.ownership.db, 'claim leader lease', () => this.ownership.claimSingleton(this.name));
    }

    private authority(): LeaderAuthority {
        return { signal: this.controller.signal, current: this.current };
    }

    private async advance() {
        if (!this.ownership.db.isOpen) {
            return;
        }
        if (this.state === 'follower') {
            const lease = await this.claim();
            if (!lease || this.state !== 'follower') {
                if (lease) {
                    await this.releaseLease(lease);
                }
                return;
            }
            this.lease = lease;
            this.state = 'leader';
            this.hooks.log?.(`Leader: this runtime leads (epoch ${lease.epoch}).`);
            this.started = true;
            await this.hooks.start(this.authority());
        }
        if (this.state === 'leader' && !this.current()) {
            this.state = 'lapsed';
            this.hooks.log?.('Leader: the lease lapsed; renewing.');
        }
        if (this.state === 'lapsed') {
            const previous = this.lease!;
            const next = await this.claim();
            if (next && next.epoch === previous.epoch + 1) {
                // No one led in between: the same leadership, uninterrupted.
                this.lease = next;
                this.state = 'leader';
                this.hooks.log?.(`Leader: renewed after a lapse (epoch ${next.epoch}).`);
            } else {
                this.state = 'superseded';
                this.controller.abort(new Error('Another runtime leads.'));
                this.hooks.log?.('Leader: another runtime led while this one stalled; stopping its work.');
                await this.hooks.stop();
                if (next) {
                    await this.releaseLease(next);
                }
                this.lease = undefined;
                this.hooks.superseded?.();
                return;
            }
        }
        if (this.state === 'leader' && !this.succeeded) {
            // Recovery waits until every other runtime is gone: a draining
            // predecessor still finishes (and records) its own work.
            if (this.ownership.othersAlive()) {
                return;
            }
            this.succeeded = true;
            await this.hooks.succeed?.(this.authority());
        }
    }

    private async finish() {
        if (this.started) {
            // A failed stop keeps the lease held: no successor overlaps it.
            await this.hooks.stop();
            this.started = false;
        }
        if (this.lease) {
            await this.releaseLease(this.lease);
        }
        this.lease = undefined;
    }

    private async releaseLease(lease: WorkLease) {
        if (!this.ownership.db.isOpen) {
            return;
        }
        await transaction(this.ownership.db, 'release leader lease', () => this.ownership.release(lease));
    }
}
