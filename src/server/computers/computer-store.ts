import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';
import type { ComputerAudit, ComputerPermissions } from '@socio/shared/computers/computer-types';

import type { ComputerAuditRepository, ComputerPermissionRepository } from '../integrations/contract.js';

import type { ComputerRecordsShape } from './contract.js';

const OFF: ComputerPermissions = {
    enabled: false,
    browser: false,
    files: false,
    shell: false,
};

/**
 * What the store works over: the connection's unit of work and the
 * Integrations repositories of its tables, which the composition builds
 * (`composition/integration-stores.ts`, `computerStoreOn`).
 */
export interface ComputerStoreDeps {
    readonly uow: UnitOfWork;
    readonly permissions: ComputerPermissionRepository;
    readonly audits: ComputerAuditRepository;
}

/** Per-socio computer permissions and the audit trail, over their repositories (CB-110). */
export class ComputerStore implements ComputerRecordsShape {
    private uow: UnitOfWork;
    private permissionsOf: ComputerPermissionRepository;
    private audits: ComputerAuditRepository;
    constructor(deps: ComputerStoreDeps) {
        this.uow = deps.uow;
        this.permissionsOf = deps.permissions;
        this.audits = deps.audits;
    }
    usedBy(userId: string, dotId: string) {
        return this.audits.usedBy(userId, dotId);
    }
    async permissions(id: string): Promise<ComputerPermissions> {
        return (await this.permissionsOf.get(id)) ?? { ...OFF };
    }
    patch(id: string, patch: Partial<ComputerPermissions>) {
        return this.uow.run(
            async () => {
                const value = { ...(await this.permissions(id)), ...patch };
                await this.permissionsOf.save(id, value);
                return value;
            },
            { label: 'save computer permissions' },
        );
    }
    begin(dotId: string, action: string, actor: 'owner' | 'agent' | 'platform', userId?: string) {
        const id = randomUUID();
        // Audit rows: behind any open unit of work, in order (CB-110).
        this.audits.begin({
            id,
            dotId,
            action,
            actor,
            userId: userId ?? null,
            createdAt: Date.now(),
        });
        return id;
    }
    finish(id: string, outcome: 'succeeded' | 'failed') {
        this.audits.finish(id, outcome);
    }
    /** The Dot's latest entries. Every entry is kept. */
    audit(id: string): Promise<ComputerAudit[]> {
        return this.audits.latest(id, 50);
    }
    /** The socio's entries at or before `before`, newest first (its activity). */
    activity(dotId: string, before: number, limit: number) {
        return this.audits.activity(dotId, before, limit);
    }
}
