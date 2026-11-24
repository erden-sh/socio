import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction, writeSoon } from '@socio/data/open';
import {
    GRANT_MINUTES,
    closeScopes,
    isAudience,
    scopeFitsAudience,
    type ActorScope,
    type Audience,
} from '@socio/shared/actor-scopes';

import type { ActorAudit } from './audit.js';
import {
    ActorAccessError,
    STANDING_EXTRACTION_MAX_MINUTES,
    type GrantRecord,
    type NewSocioGrant,
    type SocioGrantsShape,
} from './contract.js';
import { GrantRows } from './infra/sqlite/rows.js';
import { revokeWithin } from './revocations.js';

/** A grant is reused only with at least this much time left. */
export const REUSE_MIN_REMAINING_MS = 5 * 60_000;
/** How often a grant's last use is written. */
const TOUCH_MS = 60_000;
const standingExtraction = (audiences: readonly string[], scopes: readonly string[]) =>
    audiences.length === 1 && audiences[0] === 'gateway:git' && scopes.length === 1 && scopes[0] === 'git:extract';

export interface SocioGrantsOptions {
    audit: ActorAudit;
    /** Whether every live runtime enforces this contract. */
    issuable: () => boolean;
    /** Local effects of a revocation this one made (`replaces`). */
    afterRevoke?: (grantIds: string[], reason: 'replaced') => void;
    now?: () => number;
}

/**
 * Delegation grants (CB-232): a person's consent that one socio may use
 * one audience for them, from one conversation, for a bounded time. Rows
 * in `socio_grants`; revocation is a row change every runtime sees. A
 * grant is never widened in place: a wider one replaces it.
 */
export class SocioGrants implements SocioGrantsShape {
    private rows: GrantRows;
    private touched = new Map<string, number>();
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: SocioGrantsOptions,
    ) {
        this.rows = new GrantRows(db);
        this.now = options.now ?? Date.now;
    }

    /** Records an approved grant and its `grant` audit row in one transaction. */
    async create(input: NewSocioGrant): Promise<GrantRecord> {
        if (!this.options.issuable()) {
            throw new ActorAccessError('contract_outdated', 'Socio access waits until every server runs this version.');
        }
        const audiences = [...new Set(input.audiences)];
        if (!audiences.length || !audiences.every(isAudience)) {
            throw new Error('A grant names at least one valid audience.');
        }
        const scopes = closeScopes(input.scopes);
        if (
            !scopes.length ||
            !scopes.every((scope) => audiences.some((audience) => scopeFitsAudience(scope, audience)))
        ) {
            throw new Error('A grant’s scopes must fit its audiences.');
        }
        const minutes = Math.round(input.minutes ?? GRANT_MINUTES.default);
        const most = standingExtraction(audiences, scopes) ? STANDING_EXTRACTION_MAX_MINUTES : GRANT_MINUTES.max;
        if (minutes < GRANT_MINUTES.min || minutes > most) {
            throw new Error(`A grant lasts ${GRANT_MINUTES.min} to ${most} minutes.`);
        }
        // Idle never outlasts the grant itself.
        const idleMinutes = Math.min(Math.round(input.idleMinutes ?? GRANT_MINUTES.idle), minutes);
        if (idleMinutes < 1) {
            throw new Error('A grant’s idle limit is at least a minute.');
        }
        const now = this.now();
        const grant: GrantRecord = {
            id: randomUUID(),
            personId: input.personId,
            socioId: input.socioId,
            audiences,
            scopes,
            resources: input.resources ?? null,
            conversationId: input.conversationId,
            conversationKind: input.conversationKind,
            task: input.task.trim().slice(0, 500),
            policyVersion: input.policyVersion ?? '',
            approvalId: input.approvalId ?? null,
            createdAt: now,
            expiresAt: now + minutes * 60_000,
            idleMs: idleMinutes * 60_000,
            lastUsedAt: now,
            revokedAt: null,
            revokedBy: null,
            revokeReason: null,
            replacedBy: null,
        };
        const replaced = await transaction(this.db, 'create socio grant', () => {
            this.rows.insert(grant);
            this.options.audit.recordIn({
                at: now,
                correlationId: input.correlationId,
                phase: 'grant',
                decision: 'allow',
                personId: grant.personId,
                socioId: grant.socioId,
                grantId: grant.id,
                actorBy: input.approvedBy,
                audience: audiences.join(' '),
                action: scopes.join(' '),
                resourceKind: 'conversation',
                resourceId: grant.conversationId,
                ...(grant.approvalId ? { status: 'approved' } : {}),
            });
            if (!input.replaces) {
                return [];
            }
            const old = this.rows.get(input.replaces);
            if (!old || old.personId !== grant.personId || old.socioId !== grant.socioId) {
                throw new Error('A grant replaces only its own person’s and socio’s.');
            }
            return revokeWithin(this.db, this.options.audit, {
                ids: [old.id],
                at: now,
                by: input.approvedBy,
                reason: 'replaced',
                correlationId: input.correlationId,
                replacedBy: grant.id,
            });
        });
        if (replaced.length) {
            this.options.afterRevoke?.(replaced, 'replaced');
        }
        return grant;
    }

    get(id: string) {
        return this.rows.get(id);
    }

    /**
     * A live grant to reuse: same person, socio and conversation, for this
     * audience, whose scopes cover the request, with at least 5 minutes
     * left and not idle. A wider request is a new one.
     */
    reusable(request: {
        personId: string;
        socioId: string;
        audience: Audience;
        conversationId: string;
        scopes: readonly ActorScope[];
    }): GrantRecord | undefined {
        const now = this.now();
        const wanted = closeScopes(request.scopes);
        return this.rows
            .unrevoked({
                personId: request.personId,
                socioId: request.socioId,
                conversationId: request.conversationId,
                audience: request.audience,
            })
            .filter(
                (grant) =>
                    grant.expiresAt - now >= REUSE_MIN_REMAINING_MS &&
                    now - grant.lastUsedAt < grant.idleMs &&
                    wanted.every((scope) => grant.scopes.includes(scope)),
            )
            .at(-1);
    }

    /** A person's grants, newest first, with their ends (Account → Socio access). */
    ofPerson(personId: string) {
        return this.rows.ofPerson(personId);
    }
    /** Everyone's live grants (Operations → Access). */
    live() {
        return this.rows.live(this.now());
    }
    unrevoked(filter: Parameters<GrantRows['unrevoked']>[0]) {
        return this.rows.unrevoked(filter);
    }

    /**
     * Records a use, at most once a minute per grant and runtime, without
     * making the caller wait: idle expiry reads it.
     */
    touch(grantId: string) {
        const now = this.now();
        if ((this.touched.get(grantId) ?? 0) + TOUCH_MS > now) {
            return;
        }
        this.touched.set(grantId, now);
        if (this.touched.size > 10_000) {
            for (const [id, at] of this.touched) {
                if (at + TOUCH_MS <= now) {
                    this.touched.delete(id);
                }
            }
        }
        if (!this.db.isOpen) {
            return;
        }
        writeSoon(this.db, 'touch socio grant', () => this.rows.touch(grantId, now));
    }
}
