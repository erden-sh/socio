import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';
import type { WebAudit, WebIdentity } from '@socio/shared/web/web-types';

import type { WebAuditRepository, WebIdentityRepository } from '../integrations/contract.js';

/**
 * What the store works over: the connection's unit of work and the
 * Integrations repositories of its tables, which the composition builds
 * (`composition/integration-stores.ts`, `webStoreOn`).
 */
export interface WebStoreDeps {
    readonly uow: UnitOfWork;
    readonly identities: WebIdentityRepository;
    readonly audits: WebAuditRepository;
}

/** Per-socio web identity and the web-read audit, over their repositories (CB-110). */
export class WebStore {
    private uow: UnitOfWork;
    private identities: WebIdentityRepository;
    private audits: WebAuditRepository;
    constructor(deps: WebStoreDeps) {
        this.uow = deps.uow;
        this.identities = deps.identities;
        this.audits = deps.audits;
    }
    /** The Dot's own identity, if one was set; otherwise the default applies. */
    identity(dotId: string): Promise<WebIdentity | undefined> {
        return this.identities.get(dotId);
    }
    /** Sets (or, with null, clears) the Dot's identity, and audits who did. */
    setIdentity(dotId: string, identity: WebIdentity | null, userId: string) {
        return this.uow.run(
            async () => {
                await this.identities.set(dotId, identity, Date.now());
                this.record({
                    dotId,
                    userId,
                    method: 'SET',
                    host: '',
                    path: '',
                    bytes: 0,
                    outcome: `identity:${identity ?? 'default'}`,
                });
            },
            { label: 'set web identity' },
        );
    }
    /** An audit line: behind any open unit of work, in order (CB-110). */
    record(entry: Omit<WebAudit, 'id' | 'createdAt'> & { dotId: string }) {
        this.audits.append({ ...entry, id: randomUUID(), createdAt: Date.now() });
    }
    /**
     * The Dot's latest lines, newest first. Every line is kept;
     * `web_audit_dot` serves this without a sort.
     */
    audit(dotId: string, limit = 50): Promise<WebAudit[]> {
        return this.audits.latest(dotId, limit);
    }
    /** The socio's lines at or before `before`, newest first (its activity). */
    activity(dotId: string, before: number, limit: number) {
        return this.audits.activity(dotId, before, limit);
    }
}
