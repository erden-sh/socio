import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';

/**
 * One person's device endings and push endpoint changes, one at a time
 * (CB-352), across processes too (CB-379). In one process a promise
 * chain per account orders them; a lease row in the auth database
 * (`auth_device_turn`, auth migration 15) orders them between processes, as
 * during a start-first rollout, when two serve one database for a while.
 *
 * The lease names its holder and runs out unless renewed, so a process
 * that dies holding one stalls that person's turn for `leaseMs` at most.
 * A turn that can't get the lease within `waitMs` goes ahead without it,
 * reported: ordering is a safeguard, never a reason to keep a sign-out
 * from finishing. A turn asked for while this connection is inside a
 * transaction doesn't wait: the other process could not write meanwhile.
 *
 * The previous release takes no lease, so the guarantee holds from the
 * first rollout where both processes run this one.
 */
export interface AccountTurnTiming {
    /** How long a lease lasts unless renewed; renewed every third of it. */
    leaseMs: number;
    /** The longest wait for another process's lease before going ahead without it. */
    waitMs: number;
    /** The first pause between tries; it doubles up to 200 ms. */
    pollMs: number;
}

export const ACCOUNT_TURN_TIMING: AccountTurnTiming = { leaseMs: 15_000, waitMs: 60_000, pollMs: 10 };

export class AccountTurns {
    /** This process's turns: the last one asked for, per account. */
    private readonly chains = new Map<string, Promise<unknown>>();
    /** This process, as a lease holder. */
    private readonly holder = `p_${randomBytes(8).toString('hex')}`;
    private taken = 0;

    constructor(
        private readonly db: () => DatabaseSync,
        private readonly timing: AccountTurnTiming = ACCOUNT_TURN_TIMING,
    ) {}

    /** Runs `work` in the account's turn: after every turn asked for before it, here or in another process. */
    run<T>(accountId: string, work: () => Promise<T>): Promise<T> {
        const before = this.chains.get(accountId) ?? Promise.resolve();
        const mine = before.catch(() => undefined).then(() => this.leased(accountId, work));
        const settled = mine.catch(() => undefined);
        this.chains.set(accountId, settled);
        void settled.then(() => {
            if (this.chains.get(accountId) === settled) {
                this.chains.delete(accountId);
            }
        });
        return mine;
    }

    private async leased<T>(accountId: string, work: () => Promise<T>): Promise<T> {
        const holder = `${this.holder}.${++this.taken}`;
        const held = await this.acquire(accountId, holder);
        const renewal = held
            ? setInterval(() => this.renew(accountId, holder), Math.max(1, Math.floor(this.timing.leaseMs / 3)))
            : undefined;
        renewal?.unref();
        try {
            return await work();
        } finally {
            if (renewal) {
                clearInterval(renewal);
            }
            if (held) {
                this.release(accountId, holder);
            }
        }
    }

    /** Takes the account's lease, waiting while another live holder has it. False: going ahead without it. */
    private async acquire(accountId: string, holder: string): Promise<boolean> {
        const deadline = Date.now() + this.timing.waitMs;
        let pause = this.timing.pollMs;
        for (;;) {
            try {
                if (this.tryTake(accountId, holder)) {
                    return true;
                }
            } catch (error) {
                reportFailure('Device turn lease failed', [safeFailure(error)]);
                return false;
            }
            if (this.db().isTransaction || Date.now() >= deadline) {
                if (!this.db().isTransaction) {
                    reportFailure('Device turn lease wait ran out', [
                        `another process held it over ${this.timing.waitMs} ms`,
                    ]);
                }
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, pause));
            pause = Math.min(pause * 2, 200);
        }
    }

    /** One try: the lease is free, ran out, or is ours already. */
    private tryTake(accountId: string, holder: string): boolean {
        const now = Date.now();
        const result = this.db()
            .prepare(
                `INSERT INTO auth_device_turn(accountId, holder, expiresAt) VALUES (?, ?, ?)
                 ON CONFLICT(accountId) DO UPDATE SET holder = excluded.holder, expiresAt = excluded.expiresAt
                 WHERE auth_device_turn.expiresAt <= ? OR auth_device_turn.holder = excluded.holder`,
            )
            .run(accountId, holder, now + this.timing.leaseMs, now);
        return Number(result.changes) === 1;
    }

    private renew(accountId: string, holder: string) {
        try {
            this.db()
                .prepare('UPDATE auth_device_turn SET expiresAt = ? WHERE accountId = ? AND holder = ?')
                .run(Date.now() + this.timing.leaseMs, accountId, holder);
        } catch {
            // The next renewal tries again; past the lease, another turn may start.
        }
    }

    private release(accountId: string, holder: string) {
        try {
            this.db().prepare('DELETE FROM auth_device_turn WHERE accountId = ? AND holder = ?').run(accountId, holder);
        } catch (error) {
            // It runs out on its own.
            reportFailure('Device turn lease release failed', [safeFailure(error)]);
        }
    }
}
