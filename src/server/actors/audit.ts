import type { DatabaseSync } from 'node:sqlite';

import { writeSoon } from '@socio/data/open';
import { redactSocioTokens } from '@socio/foundation/actors/redact';

import type { ActorAuditShape, AuditEntry, AuditInput } from './contract.js';
import { AuditRows, type AuditRow } from './infra/sqlite/rows.js';

/** Allowed decisions are kept one per key and minute. */
const SAMPLE_MS = 60_000;

/**
 * `actor_audit` (CB-232). Rows that record a change of security state
 * are written inside the caller's transaction (`recordIn`), so a crash
 * can't leave a grant or revocation without its record. Denies, sampled
 * allows and outcomes go through `writeSoon`. The table refuses UPDATE and
 * DELETE by trigger.
 *
 * Never stored: tokens, cookies, envelopes, bodies, query text, params,
 * page content. Codes are a closed list (`ACTOR_DENY_REASONS`,
 * `ACTOR_REVOKE_REASONS`); free text (`detail`, ids) passes the token
 * redactor as a second guard.
 */
export class ActorAudit implements ActorAuditShape {
    private rows: AuditRows;
    /** Per runtime: a deploy's overlap may record a sample twice, never none. */
    private sampled = new Map<string, number>();
    constructor(
        private db: DatabaseSync,
        private now: () => number = Date.now,
    ) {
        this.rows = new AuditRows(db);
    }

    private clean(input: AuditInput): AuditEntry {
        const text = (value: string | undefined, max: number) =>
            value === undefined ? undefined : redactSocioTokens(value, { envelopes: true }).slice(0, max);
        return {
            ...input,
            at: input.at ?? this.now(),
            correlationId: text(input.correlationId, 64)!,
            action: text(input.action, 100),
            resourceId: text(input.resourceId, 200),
            status: text(input.status, 32),
            detail: text(input.detail, 2000),
        };
    }

    /**
     * Inside the caller's open transaction: a state change's own row.
     * Throws outside one, so a row can't land apart from its change.
     */
    recordIn(input: AuditInput) {
        if (!this.db.isTransaction) {
            throw new Error('An actor audit row is recorded inside a transaction.');
        }
        this.rows.insert(this.clean(input));
    }

    /** Nothing reads it back at once: a deny, an outcome, a context event. */
    recordSoon(input: AuditInput) {
        if (!this.db.isOpen) {
            return;
        }
        const entry = this.clean(input);
        writeSoon(this.db, 'actor audit', () => this.rows.insert(entry));
    }

    /**
     * An access decision: every deny, and one allow per `sampleKey` (a
     * credential or grant, and the action) per minute. `sampleDeny` samples
     * a deny the same way: one tied to no grant, which anyone can cause.
     */
    decision(
        input: AuditInput & { decision: 'allow' | 'deny' },
        sampleKey: string,
        { sampleDeny = false }: { sampleDeny?: boolean } = {},
    ) {
        if (input.decision === 'allow' || sampleDeny) {
            const at = input.at ?? this.now();
            const last = this.sampled.get(sampleKey);
            if (last !== undefined && at - last < SAMPLE_MS) {
                return false;
            }
            this.sampled.set(sampleKey, at);
            if (this.sampled.size > 10_000) {
                for (const [key, when] of this.sampled) {
                    if (at - when >= SAMPLE_MS) {
                        this.sampled.delete(key);
                    }
                }
            }
        }
        this.recordSoon({ ...input, phase: input.phase ?? 'decision' });
        return true;
    }

    /** A person's rows, newest first, older than `before` (by time, then id). */
    personPage(personId: string, before: { at: number; id: number } | undefined, limit: number): AuditRow[] {
        return this.rows.personPage(personId, before, limit);
    }

    /** Newest first: a person's own history, a grant's, or one correlation. */
    list(filter: { personId?: string; grantId?: string; correlationId?: string }, limit?: number): AuditRow[] {
        return this.rows.list(filter, limit);
    }
}
