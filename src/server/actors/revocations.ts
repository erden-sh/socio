import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import type { ActorRevokeReason } from '@socio/shared/actor-scopes';

import { ActorAudit } from './audit.js';
import type { ActorRevocationsShape, GrantFilter, RevocationListener, TrackedHandle } from './contract.js';
import { ContextRows, CredentialRows, GrantRows, RevocationSignals } from './infra/sqlite/rows.js';

/** How often another runtime's revocations are looked for. */
export const SIGNAL_POLL_MS = 1_000;
/** How often every open delegated socket and stream is re-checked. */
export const RECHECK_MS = 5_000;

/**
 * The revocation itself, inside the caller's open transaction: the grants
 * marked revoked, their credential rows deleted, their contexts closed, a
 * signal for the other runtimes, and one `revoke` audit row each. Returns
 * the grants it changed.
 */
export function revokeWithin(
    db: DatabaseSync,
    audit: ActorAudit,
    input: {
        ids: readonly string[];
        at: number;
        by: string;
        reason: ActorRevokeReason;
        correlationId: string;
        replacedBy?: string;
    },
) {
    const grants = new GrantRows(db);
    const changed = grants.revoke(input.ids, input.at, input.by, input.reason, input.replacedBy);
    if (!changed.length) {
        return changed;
    }
    new CredentialRows(db).deleteGrants(changed);
    const contexts = new ContextRows(db);
    contexts.close(contexts.ofGrants(changed), input.at, 'grant_revoked');
    const signals = new RevocationSignals(db);
    for (const id of changed) {
        signals.insert(id, input.reason, input.at);
        const grant = grants.get(id)!;
        audit.recordIn({
            at: input.at,
            correlationId: input.correlationId,
            phase: 'revoke',
            reason: input.reason,
            personId: grant.personId,
            socioId: grant.socioId,
            grantId: id,
            actorBy: input.by,
            audience: grant.audiences.join(' '),
        });
    }
    return changed;
}

export interface ActorRevocationsOptions {
    audit: ActorAudit;
    /**
     * The grant-level check (`ActorAuthorizer.authorizeGrant` with `fresh`)
     * the 5-s re-check runs for each grant something here holds open.
     */
    recheck?: (grantId: string) => Promise<boolean>;
    /** Cached decisions to forget when a grant ends. */
    invalidate?: (grantIds: readonly string[]) => void;
    now?: () => number;
    log?: (line: string) => void;
}

/**
 * Revocation (CB-232). `revoke` is one
 * transaction (rows, credentials, contexts, signal, audit). Then, on this
 * runtime, what it tracks for those grants is closed and listeners run
 * (the broker's contexts, coding sandboxes). Other runtimes learn it from
 * the `runtime_signals` row within a second, and in any case re-check
 * every grant they hold open every 5 s, so a missed signal still takes
 * effect within 5 s. Works on a database alone (the auth CLI), where
 * nothing is open.
 */
export class ActorRevocations implements ActorRevocationsShape {
    private tracked = new Map<string, Set<TrackedHandle>>();
    private listeners = new Set<RevocationListener>();
    private timers: ReturnType<typeof setInterval>[] = [];
    private lastSignal: number;
    private seen = new Map<string, number>();
    private rechecking = false;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: ActorRevocationsOptions,
    ) {
        this.now = options.now ?? Date.now;
        this.lastSignal = this.now();
    }

    /** Revokes the unrevoked grants `filter` matches; returns their ids. */
    async revoke(
        filter: GrantFilter,
        by: string,
        reason: ActorRevokeReason,
        correlationId = `revoke-${this.now()}`,
    ): Promise<string[]> {
        if (!this.db.isOpen) {
            return [];
        }
        const changed = await transaction(this.db, 'revoke socio grants', () =>
            revokeWithin(this.db, this.options.audit, {
                ids: new GrantRows(this.db).unrevoked(filter).map((grant) => grant.id),
                at: this.now(),
                by,
                reason,
                correlationId,
            }),
        );
        if (changed.length) {
            this.afterRevoke(changed, reason, 'local');
        }
        return changed;
    }

    /** Every grant of a person (a deactivation, accounts.ts); how many ended. */
    async revokePerson(personId: string, by: string) {
        return (await this.revoke({ personId }, by, 'person_deactivated')).length;
    }

    /**
     * After a revocation's transaction: cached decisions forgotten, what this
     * runtime holds for those grants closed, listeners told.
     */
    afterRevoke(grantIds: readonly string[], reason: string, origin: 'local' | 'remote') {
        const at = this.now();
        for (const id of grantIds) {
            this.seen.set(id, at);
        }
        this.options.invalidate?.(grantIds);
        for (const id of grantIds) {
            this.close(id, reason);
        }
        for (const listener of this.listeners) {
            try {
                listener({ grantIds, reason, origin });
            } catch {
                this.options.log?.('Socio access: a revocation listener failed.');
            }
        }
    }

    /** Called with every revocation this runtime makes or learns of. */
    onRevoked(listener: RevocationListener) {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    /**
     * Holds something open for a grant (a WebSocket, a streamed response, a
     * gateway stream), per grant, not per app: closed when the grant
     * is revoked here, signaled from elsewhere, or fails its re-check.
     */
    track(grantId: string, handle: TrackedHandle) {
        const set = this.tracked.get(grantId) ?? new Set();
        set.add(handle);
        this.tracked.set(grantId, set);
        return () => {
            set.delete(handle);
            if (!set.size) {
                this.tracked.delete(grantId);
            }
        };
    }
    /** How many handles are open (tests, diagnostics). */
    trackedCount(grantId?: string) {
        if (grantId) {
            return this.tracked.get(grantId)?.size ?? 0;
        }
        let n = 0;
        for (const set of this.tracked.values()) {
            n += set.size;
        }
        return n;
    }

    private close(grantId: string, reason: string) {
        const set = this.tracked.get(grantId);
        if (!set) {
            return;
        }
        this.tracked.delete(grantId);
        for (const handle of set) {
            try {
                handle.close(reason);
            } catch {
                // One handle failing to close must not keep the others open.
            }
        }
    }

    /** The fast path: revocations other runtimes signaled since the last poll. */
    pollSignals() {
        if (!this.db.isOpen) {
            return [];
        }
        const from = this.lastSignal;
        const signals = new RevocationSignals(this.db).since(from);
        const fresh = signals.filter((signal) => (this.seen.get(signal.grantId) ?? -1) < signal.at);
        // Same-millisecond signals are read again next time; `seen` dedupes.
        if (signals.length) {
            this.lastSignal = signals.at(-1)!.at;
        }
        const byReason = new Map<string, string[]>();
        for (const signal of fresh) {
            byReason.set(signal.reason, [...(byReason.get(signal.reason) ?? []), signal.grantId]);
        }
        for (const [reason, ids] of byReason) {
            this.afterRevoke(ids, reason, 'remote');
        }
        if (this.seen.size > 10_000) {
            for (const [id, at] of this.seen) {
                if (this.now() - at > 60 * 60_000) {
                    this.seen.delete(id);
                }
            }
        }
        return fresh.map((signal) => signal.grantId);
    }

    /**
     * The guarantee: every grant this runtime holds something open for is
     * checked afresh; those that fail are closed here. A check that throws
     * closes its grant's handles too (fail closed) and the others are
     * still checked.
     */
    async recheck() {
        if (this.rechecking || !this.options.recheck) {
            return [];
        }
        this.rechecking = true;
        try {
            const failed: string[] = [];
            for (const grantId of [...this.tracked.keys()]) {
                let allowed = false;
                try {
                    allowed = await this.options.recheck(grantId);
                } catch {
                    this.options.log?.('Socio access: re-checking a grant failed; its open access was closed.');
                }
                if (!allowed) {
                    failed.push(grantId);
                }
            }
            for (const id of failed) {
                this.close(id, 'access_changed');
            }
            return failed;
        } finally {
            this.rechecking = false;
        }
    }

    /** Starts the per-runtime poll and re-check (every runtime, not the leader). */
    watch({ pollMs = SIGNAL_POLL_MS, recheckMs = RECHECK_MS } = {}) {
        if (this.timers.length) {
            return;
        }
        const poll = setInterval(() => {
            try {
                this.pollSignals();
            } catch {
                this.options.log?.('Socio access: reading revocation signals failed.');
            }
        }, pollMs);
        const recheck = setInterval(() => {
            void this.recheck().catch(() => this.options.log?.('Socio access: the re-check of open access failed.'));
        }, recheckMs);
        poll.unref();
        recheck.unref();
        this.timers.push(poll, recheck);
    }
    stop() {
        for (const timer of this.timers.splice(0)) {
            clearInterval(timer);
        }
    }
}

/**
 * Revocation on a database alone (the auth CLI, accounts.ts): nothing is
 * open in that process, and running servers learn of it from the signal
 * row and their own checks within seconds.
 */
export function databaseRevocations(db: DatabaseSync) {
    return new ActorRevocations(db, { audit: new ActorAudit(db) });
}
