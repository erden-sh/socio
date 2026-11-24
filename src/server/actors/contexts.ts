import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';

import type { RuntimeOwnershipShape } from '../runtime/contract.js';

import type { ActorAudit } from './audit.js';
import {
    ActorAccessError,
    BROWSER_CONTEXT_LIMITS,
    type ActorContextsShape,
    type ContextRecord,
    type OpenContext,
} from './contract.js';
import { ContextRows, CredentialRows } from './infra/sqlite/rows.js';

/** `runtime_work` kind of a context's lease (CB-108). */
export const CONTEXT_WORK = 'actor-context';

/**
 * Execution contexts a credential is bound to (CB-232): an app
 * browser context or a coding sandbox (CB-239). Each is a row in
 * `actor_contexts` and a `runtime_work` lease held by the runtime that
 * renews its credential. A draining runtime releases its leases; another
 * takes them over (`adoptOrphans`) and renews, so nothing a later request
 * needs lives in one process. Caps are counted in the
 * transaction that opens a context, so two runtimes can't both take the
 * last slot.
 */
export class ActorContexts implements ActorContextsShape {
    private rows: ContextRows;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: {
            ownership: RuntimeOwnershipShape;
            audit: ActorAudit;
            now?: () => number;
        },
    ) {
        this.rows = new ContextRows(db);
        this.now = options.now ?? Date.now;
    }

    /** Opens a context for a live grant, leased here; refuses past a cap. */
    async open(input: OpenContext): Promise<ContextRecord> {
        const { grant, kind } = input;
        if (!grant.audiences.includes(input.audience)) {
            throw new ActorAccessError('audience_mismatch', 'That grant is not for this audience.');
        }
        const limits = input.limits ?? (kind === 'browser' ? BROWSER_CONTEXT_LIMITS : undefined);
        const now = this.now();
        const record: ContextRecord = {
            id: randomUUID(),
            grantId: grant.id,
            personId: grant.personId,
            socioId: grant.socioId,
            kind,
            audience: input.audience,
            worker: input.worker ?? null,
            openedAt: now,
            closedAt: null,
            closeReason: null,
        };
        const { ownership } = this.options;
        await transaction(this.db, 'open actor context', () => {
            if (limits) {
                const open = this.rows.openCounts(kind, grant.personId, grant.socioId);
                if (
                    open.person >= limits.perPerson ||
                    open.socio >= limits.perSocio ||
                    open.total >= limits.perInstance
                ) {
                    throw new ActorAccessError(
                        'limit_reached',
                        kind === 'browser' ? 'The app browser is busy.' : 'Too many sessions are open.',
                    );
                }
            }
            this.rows.insert(record);
            ownership.claimWithin(CONTEXT_WORK, record.id, `${CONTEXT_WORK}:${record.id}`);
            this.options.audit.recordIn({
                at: now,
                correlationId: input.correlationId,
                phase: 'context',
                decision: 'allow',
                status: 'open',
                personId: grant.personId,
                socioId: grant.socioId,
                grantId: grant.id,
                actorBy: 'system',
                audience: input.audience,
                resourceKind: kind,
                resourceId: record.id,
            });
        });
        ownership.session.keepAlive();
        return record;
    }

    get(id: string) {
        return this.rows.get(id);
    }
    /** Every open context (diagnostics, the broker's reconciliation). */
    openContexts(): ContextRecord[] {
        return this.rows.open();
    }

    /** Closes contexts: their credentials end, their leases are released. */
    async close(ids: readonly string[], reason: string, correlationId: string) {
        const { ownership } = this.options;
        const now = this.now();
        const closed = await transaction(this.db, 'close actor contexts', () => {
            const done = this.rows.close(ids, now, reason);
            const credentials = new CredentialRows(this.db);
            for (const id of done) {
                credentials.deleteHolder('context', id);
                const lease = ownership.workLease(CONTEXT_WORK, id);
                if (lease) {
                    ownership.releaseWithin(lease);
                }
                const context = this.rows.get(id)!;
                this.options.audit.recordIn({
                    at: now,
                    correlationId,
                    phase: 'context',
                    status: 'closed',
                    reason: /^[a-z0-9_]{1,64}$/.test(reason) ? reason : undefined,
                    personId: context.personId,
                    socioId: context.socioId,
                    grantId: context.grantId,
                    actorBy: 'system',
                    audience: context.audience,
                    resourceKind: context.kind,
                    resourceId: id,
                });
            }
            return done;
        });
        return closed;
    }

    /** Open contexts this runtime holds the lease of. */
    owned(): ContextRecord[] {
        const { ownership } = this.options;
        return this.rows.open().filter((context) => {
            const lease = ownership.workLease(CONTEXT_WORK, context.id);
            return !!lease && ownership.owns(lease);
        });
    }

    /**
     * Takes over open contexts whose runtime drained or died: their
     * leases move here; the caller renews their credentials.
     */
    adoptOrphans(): ContextRecord[] {
        const { ownership } = this.options;
        return this.rows
            .open()
            .filter(
                (context) =>
                    !ownership.workAlive(CONTEXT_WORK, context.id) && !!ownership.takeOver(CONTEXT_WORK, context.id),
            );
    }

    /** A drain: this runtime's context leases go, for the other to adopt. */
    releaseOwned() {
        const { ownership } = this.options;
        let released = 0;
        for (const context of this.owned()) {
            const lease = ownership.workLease(CONTEXT_WORK, context.id);
            try {
                if (lease && ownership.release(lease)) {
                    released++;
                }
            } catch {
                // A unit of work is open: the lease lapses instead (DEFAULT_LEASE_MS).
            }
        }
        return released;
    }
}
