import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { AppHealth } from '@socio/shared/apps/app-types';

import { SqliteAppHealth, type AppHealthChange, type AppHealthRow as Row } from './infra/health-store.js';

/**
 * Repairs tried before automatic repair gives up and admins are told
 * (CB-291). The first waits a minute, then twice as long each time, at
 * most 30 minutes: 1, 2, 4, 8 and 16 minutes between the six.
 */
export const RECOVERY_ATTEMPTS = 6;
export const RECOVERY_FIRST_WAIT_MS = 60_000;
export const RECOVERY_MAX_WAIT_MS = 30 * 60_000;
/**
 * How long a claimed repair may run before another runtime may claim the
 * next (a runtime that died mid-repair), longer than any repair takes.
 */
export const REPAIR_LEASE_MS = 10 * 60_000;
/** How often a running repair renews its lease. */
const LEASE_RENEW_MS = 60_000;
/** A repaired app that stays up this long is healthy again; its count starts over. */
export const RECOVERY_STABLE_MS = 10 * 60_000;
/** Data token hashes kept per app, so a refused one still names its app. */
const TOKENS_KEPT = 4;

/** How long after repair `attempt` the next may run. */
export const recoveryWait = (attempt: number) =>
    Math.min(RECOVERY_MAX_WAIT_MS, RECOVERY_FIRST_WAIT_MS * 2 ** Math.max(0, attempt - 1));

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** One repair's claim, from `begin`: its outcome, checks and release name it. */
export interface RepairClaim {
    readonly appId: string;
    readonly id: string;
    /** Its number in the episode (1 to `RECOVERY_ATTEMPTS`). */
    readonly attempt: number;
}

export interface AppNotice {
    trigger: string;
    title: string;
    message: string;
    path: string;
}

/**
 * Mini apps' self-healing state (CB-291), in `app_health` (apps 8): whether
 * each app is healthy, recovering, degraded or failed, its repairs since it
 * was last healthy (bounded, with backoff between them), the last repair
 * that held, the hashes of its last data tokens and an unresolved token
 * repair. Repairs belong to an episode (the port of a development app, the
 * live version of a promoted one); a registration, Start or new version
 * resets the record when it is saved. A repair is claimed with a lease that
 * its runtime renews while it runs; only that claim may end it. When the
 * count runs out, admins are told once.
 *
 * Every change is one atomic read-modify-write (`SqliteAppHealth.change`),
 * so runtimes sharing the database never lose each other's changes; reads
 * are plain reads. Changes resolve when written.
 */
export class AppHealthBook {
    private store: SqliteAppHealth;
    /** Repairs this runtime claimed and runs now: their claim and lease renewal. */
    /** Lease renewals of the repairs this runtime claimed and runs now, by claim. */
    private renewals = new Map<string, ReturnType<typeof setInterval>>();
    constructor(
        db: DatabaseSync,
        private hooks: {
            /** The admins' notices, bound once the platform has them. */
            notifyAdmins?: () => ((notice: AppNotice) => Promise<unknown>) | undefined;
            name: (appId: string) => string | undefined;
            log?: (line: string) => void;
        },
    ) {
        this.store = new SqliteAppHealth(db);
    }

    private change(appId: string, decide: (row: Row | undefined) => AppHealthChange | null, now = Date.now()) {
        return this.store.change(appId, decide, now);
    }
    private view(row: Row | undefined): AppHealth {
        return {
            state: row?.state ?? 'healthy',
            reason: row?.reason ?? null,
            attempts: row?.attempts ?? 0,
            maxAttempts: RECOVERY_ATTEMPTS,
            nextAttemptAt: row?.state === 'degraded' ? (row.nextAttemptAt ?? null) : null,
            lastRecoveryAt: row?.lastRecoveryAt ?? null,
            lastRecoveryReason: row?.lastRecoveryReason ?? null,
            lastError: row?.state === 'healthy' ? null : (row?.lastError ?? null),
            escalatedAt: row?.escalatedAt ?? null,
            updatedAt: row?.updatedAt ?? null,
        };
    }

    /** An app's state; healthy when nothing was ever recorded. */
    get(appId: string): AppHealth {
        return this.view(this.store.get(appId));
    }
    /** Every app with a record. */
    list(): Array<AppHealth & { appId: string }> {
        return this.store.all().map((row) => ({ appId: row.appId, ...this.view(row) }));
    }

    // ---- data tokens --------------------------------------------------------
    /** A data token issued to the app (only its hash is kept, and only the last few). */
    async rememberToken(appId: string, token: string) {
        const hash = digest(token);
        await this.change(appId, (row) => {
            const hashes = JSON.parse(row?.tokenHashes ?? '[]') as string[];
            return hashes.includes(hash)
                ? null
                : { tokenHashes: JSON.stringify([...hashes, hash].slice(-TOKENS_KEPT)) };
        });
    }
    /**
     * Its process was replaced with one holding `token`: the older tokens no
     * longer name it, so a copy of one can't set off another repair.
     */
    async forgetTokensExcept(appId: string, token: string) {
        await this.change(appId, () => ({ tokenHashes: JSON.stringify([digest(token)]) }));
    }
    /** The app a (refused) data token was issued to, if it was one of its last few. */
    appOfToken(token: string) {
        return this.store.byTokenHash(digest(token));
    }
    /** Retired (its address may go to another app): it starts with a clean record. */
    async clear(appId: string) {
        await this.change(appId, (row) =>
            row
                ? {
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
                  }
                : null,
        );
    }

    // ---- token repairs (shared, so any runtime resumes them) ---------------
    /** A token repair is under way until `tokenRepairDone`. */
    async tokenRepairStarted(appId: string, reason: string) {
        await this.change(appId, (row) => (row?.tokenRepair === reason ? null : { tokenRepair: reason }));
    }
    async tokenRepairDone(appId: string) {
        await this.change(appId, (row) => (row?.tokenRepair ? { tokenRepair: null } : null));
    }
    tokenRepairPending(appId: string) {
        return !!this.store.get(appId)?.tokenRepair;
    }
    /** Unresolved token repairs, by app, with their reason. */
    tokenRepairs() {
        return this.store
            .all()
            .filter((row) => row.tokenRepair)
            .map((row) => ({ appId: row.appId, reason: row.tokenRepair! }));
    }

    // ---- repairs -------------------------------------------------------------
    /** Whether `row` lets a repair of `episode` run now (another episode starts the count over). */
    private mayRepair(row: Row | undefined, episode: string, now: number) {
        if (row && (row.leaseUntil ?? 0) > now) {
            // Another repair is running (here or on another runtime).
            return false;
        }
        if (!row || row.episode !== episode) {
            return true;
        }
        return row.state !== 'failed' && row.attempts < RECOVERY_ATTEMPTS && (row.nextAttemptAt ?? 0) <= now;
    }
    /**
     * Claims a repair and returns its number, or 0 when it isn't due: not
     * before the backoff's wait, not while another runs, not after the count
     * ran out (then it gives up, once). Another `episode` starts the count
     * over. The next waits `recoveryWait` from now, whatever happens.
     */
    async begin(appId: string, episode: string, reason: string, now = Date.now()): Promise<RepairClaim | null> {
        const claim = randomUUID();
        let gaveUp = false;
        const saved = await this.change(
            appId,
            (row) => {
                if (
                    row?.episode === episode &&
                    row.state !== 'failed' &&
                    row.attempts >= RECOVERY_ATTEMPTS &&
                    (row.leaseUntil ?? 0) <= now
                ) {
                    // The count ran out: failed, in this same transaction.
                    gaveUp = !row.escalatedAt;
                    return this.giveUp(row, row.lastError ?? row.reason ?? 'it kept failing', now);
                }
                if (!this.mayRepair(row, episode, now)) {
                    return null;
                }
                const same = row?.episode === episode;
                const attempts = (same ? (row?.attempts ?? 0) : 0) + 1;
                return {
                    state: 'recovering',
                    reason,
                    episode,
                    attempts,
                    nextAttemptAt: now + recoveryWait(attempts),
                    leaseUntil: now + REPAIR_LEASE_MS,
                    leaseClaim: claim,
                    ...(same ? {} : { escalatedAt: null, lastError: null }),
                };
            },
            now,
        );
        if (!saved || saved.leaseClaim !== claim) {
            if (saved && gaveUp) {
                this.notify(saved);
            }
            return null;
        }
        // Renewed while it runs, however long a deploy takes; a runtime that
        // dies stops renewing, and the lease lapses.
        const timer = setInterval(() => {
            void this.change(appId, (row) =>
                row?.leaseClaim === claim ? { leaseUntil: Date.now() + REPAIR_LEASE_MS } : null,
            )
                .then((held) => {
                    // Lost (reset, or taken over after a pause): stop renewing.
                    // Its outcome still names this claim, so it writes nothing.
                    if (!held) {
                        this.release(claim);
                    }
                })
                .catch(() => undefined);
        }, LEASE_RENEW_MS);
        timer.unref?.();
        this.renewals.set(claim, timer);
        this.hooks.log?.(`Apps: repairing ${appId} (attempt ${saved.attempts} of ${RECOVERY_ATTEMPTS}): ${reason}`);
        return { appId, id: claim, attempt: saved.attempts };
    }
    /** Stops renewing one claim's lease. */
    private release(claim: string) {
        clearInterval(this.renewals.get(claim));
        this.renewals.delete(claim);
    }
    /** Whether `claim` still holds its app's row: the repair may go on. */
    stillClaimed(claim: RepairClaim) {
        return this.store.get(claim.appId)?.leaseClaim === claim.id;
    }
    /** Whether `claim` holds `row`: only that repair has an outcome. */
    private holds(row: Row | undefined, claim: string) {
        return row?.leaseClaim === claim;
    }
    /**
     * The repair did its part (`what`). It is healthy once it stays up
     * (`settle`). A repair another runtime took over writes nothing.
     */
    async succeeded(repair: RepairClaim, what: string, now = Date.now()) {
        const { appId, id: claim } = repair;
        this.release(claim);
        const saved = await this.change(
            appId,
            (row) =>
                this.holds(row, claim)
                    ? {
                          leaseUntil: null,
                          leaseClaim: null,
                          state: 'recovering',
                          reason: `${what}; waiting to see it hold`,
                          lastRecoveryAt: now,
                          lastRecoveryReason: what,
                          lastError: null,
                      }
                    : null,
            now,
        );
        if (saved) {
            this.hooks.log?.(`Apps: ${appId} recovered: ${what}.`);
        }
    }
    /**
     * Up without a break since `upSince` (the current process's start, as
     * last seen), and since its last repair or failure, for
     * `RECOVERY_STABLE_MS`: healthy, the count starts over. That holds for
     * an app whose repair timed out (degraded) or ran out (failed) but came
     * up anyway. A process that crashed and came back starts the wait again.
     * Never while a token repair is unresolved or a repair runs.
     */
    async settle(appId: string, upSince: number | null, now = Date.now()) {
        return !!(await this.change(
            appId,
            (row) => {
                if (!row || row.state === 'healthy' || upSince === null || row.tokenRepair) {
                    return null;
                }
                if ((row.leaseUntil ?? 0) > now) {
                    return null;
                }
                const since = Math.max(
                    upSince,
                    row.state === 'recovering' ? (row.lastRecoveryAt ?? row.updatedAt) : row.updatedAt,
                );
                if (now - since < RECOVERY_STABLE_MS) {
                    return null;
                }
                return {
                    state: 'healthy',
                    reason: null,
                    attempts: 0,
                    nextAttemptAt: null,
                    lastError: null,
                    escalatedAt: null,
                };
            },
            now,
        ));
    }
    /**
     * The repair failed: degraded until the next, or failed when the count
     * ran out, decided and written in one transaction, only while its own
     * claim holds the row.
     */
    async failed(repair: RepairClaim, error: string, now = Date.now()) {
        const { appId, id: claim } = repair;
        this.release(claim);
        let gaveUp = false;
        const saved = await this.change(
            appId,
            (row) => {
                if (!row || !this.holds(row, claim)) {
                    // Reset, or another runtime took the repair over: its outcome counts.
                    return null;
                }
                if (row.attempts >= RECOVERY_ATTEMPTS) {
                    gaveUp = !row.escalatedAt;
                    return this.giveUp(row, error, now);
                }
                return { state: 'degraded', lastError: error, leaseUntil: null, leaseClaim: null };
            },
            now,
        );
        if (saved && gaveUp) {
            this.notify(saved);
        } else if (saved && saved.state === 'degraded') {
            this.hooks.log?.(
                `Apps: repairing ${appId} failed (attempt ${saved.attempts} of ${RECOVERY_ATTEMPTS}): ${error}`,
            );
        }
        return this.get(appId);
    }
    /**
     * The repair stopped because what it was for changed (a new
     * registration, version or status): no outcome, and its lease goes so
     * the next repair isn't held up.
     */
    async abandon(repair: RepairClaim, now = Date.now()) {
        this.release(repair.id);
        await this.change(
            repair.appId,
            (row) => (this.holds(row, repair.id) ? { leaseUntil: null, leaseClaim: null } : null),
            now,
        );
    }
    /**
     * A token renewed in place held: healthy, unless a repair started since
     * (its count and any escalation stay until it is stable).
     */
    async renewalHeld(appId: string, what: string, now = Date.now()) {
        return !!(await this.change(
            appId,
            (row) =>
                row?.state === 'recovering' && !row.attempts && !row.leaseClaim
                    ? {
                          state: 'healthy',
                          reason: null,
                          lastRecoveryAt: now,
                          lastRecoveryReason: what,
                          lastError: null,
                      }
                    : null,
            now,
        ));
    }
    /** Recovering without a repair counted (a data token renewed in place). */
    async recovering(appId: string, reason: string, now = Date.now()) {
        await this.change(appId, (row) => (row?.state === 'failed' ? null : { state: 'recovering', reason }), now);
    }
    /**
     * Something is wrong that isn't a repair's (the runtime is away):
     * degraded, no count. An app in the middle of repairs keeps their state.
     */
    async degraded(appId: string, reason: string, now = Date.now()) {
        await this.change(
            appId,
            (row) => (row && row.state !== 'healthy' ? null : { state: 'degraded', reason, nextAttemptAt: null }),
            now,
        );
    }
    /** What `degraded` reported is over. */
    async clearDegraded(appId: string, reason: string, now = Date.now()) {
        await this.change(
            appId,
            (row) =>
                row?.state === 'degraded' && row.reason === reason && !row.attempts
                    ? { state: 'healthy', reason: null }
                    : null,
            now,
        );
    }
    /**
     * A registration, Start or new version was saved: healthy, the count
     * starts over, and a repair still running ends without effect (its
     * claim no longer holds the row).
     */
    async reset(appId: string, now = Date.now()) {
        await this.change(
            appId,
            (row) =>
                row && (row.state !== 'healthy' || row.attempts || row.tokenRepair || row.leaseClaim)
                    ? {
                          tokenRepair: null,
                          leaseUntil: null,
                          leaseClaim: null,
                          state: 'healthy',
                          reason: null,
                          attempts: 0,
                          nextAttemptAt: null,
                          lastError: null,
                          escalatedAt: null,
                      }
                    : null,
            now,
        );
    }
    /** Automatic repair gave up: the change that marks it failed (inside the caller's transaction). */
    private giveUp(row: Row, error: string, now: number): AppHealthChange {
        return {
            state: 'failed',
            lastError: error,
            nextAttemptAt: null,
            leaseUntil: null,
            leaseClaim: null,
            escalatedAt: row.escalatedAt ?? now,
        };
    }
    /** Tells admins, once: called only by the transaction that set `escalatedAt`. */
    private notify(row: Row) {
        const name = this.hooks.name(row.appId) ?? row.appId;
        const error = row.lastError ?? 'it kept failing';
        this.hooks.log?.(
            `Apps: automatic repair of ${row.appId} gave up after ${row.attempts} attempts (${error}); admins are told.`,
        );
        const notify = this.hooks.notifyAdmins?.();
        void notify?.({
            trigger: 'app_recovery_failed',
            title: `The mini app “${name}” needs attention`,
            message: `Socio tried to repair it ${row.attempts} times and gave up: ${error}. Its data is kept. Its owner can press Start on the Apps page, or its socio can fix and update it.`,
            path: '/apps',
        }).catch(() => undefined);
    }
}
