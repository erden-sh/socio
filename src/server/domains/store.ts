import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@socio/data/uow';
import type { DomainOp, DomainOpKind, DomainStep } from '@socio/shared/domains';

import type { DomainHost, DomainHostRepository, DomainOpRepository } from '../integrations/contract.js';

/** A row of `domain_hosts` (the Integrations context's `DomainHost`). */
export type DomainHostRow = DomainHost;

/**
 * What the store works on: the Integrations context's hosts and operations
 * (`DomainHostsRepo`, `DomainOpsRepo`) and the unit of work on their
 * connection. The composition builds them (`composition/domains.ts`).
 */
export interface DomainsRepositories {
    readonly hosts: DomainHostRepository;
    readonly ops: DomainOpRepository;
    readonly uow: UnitOfWork;
}

/**
 * The domains module's hostnames and operations, over their repositories
 * (CB-110). Every write is its own unit of work, awaited; a host's
 * read-then-write (`saveHost`) is one.
 */
export class DomainsStore {
    private uow: UnitOfWork;
    private hostsOf: DomainHostRepository;
    private opsOf: DomainOpRepository;
    constructor(
        repositories: DomainsRepositories,
        private now: () => number = Date.now,
    ) {
        this.uow = repositories.uow;
        this.hostsOf = repositories.hosts;
        this.opsOf = repositories.ops;
    }

    hosts(kind?: 'base' | 'custom') {
        return this.hostsOf.all(kind);
    }
    host(hostname: string) {
        return this.hostsOf.byName(hostname);
    }
    /** Inserts or updates the given fields; the rest stay. */
    saveHost(
        hostname: string,
        kind: 'base' | 'custom',
        by: string,
        patch: Partial<
            Pick<
                DomainHostRow,
                | 'dnsRecordId'
                | 'dnsContent'
                | 'dnsCreated'
                | 'certificateId'
                | 'certificateCreated'
                | 'proxyHostId'
                | 'proxyHostCreated'
            >
        >,
    ) {
        return this.uow.run(
            async () => {
                const now = this.now();
                const current = await this.host(hostname);
                const row: DomainHostRow = {
                    hostname,
                    kind,
                    dnsRecordId: null,
                    dnsContent: null,
                    dnsCreated: 0,
                    certificateId: null,
                    certificateCreated: 0,
                    proxyHostId: null,
                    proxyHostCreated: 0,
                    createdBy: by,
                    createdAt: now,
                    ...current,
                    ...patch,
                    updatedAt: now,
                };
                await this.hostsOf.save(row);
                return row;
            },
            { label: 'save domain host' },
        );
    }
    deleteHost(hostname: string) {
        return this.hostsOf.remove(hostname);
    }

    /** The op as it starts: running, no steps; saved before it is returned. */
    async startOp(kind: DomainOpKind, hostname: string, actor: string, id: string = randomUUID()): Promise<DomainOp> {
        const op: DomainOp = {
            id,
            kind,
            hostname,
            actor,
            status: 'running',
            steps: [],
            startedAt: this.now(),
        };
        await this.opsOf.start(op);
        return op;
    }
    saveSteps(id: string, steps: DomainStep[]) {
        return this.opsOf.saveSteps(id, steps);
    }
    async finishOp(id: string, steps: DomainStep[], error?: string) {
        return (await this.opsOf.finish(id, steps, error, this.now()))!;
    }
    op(id: string) {
        return this.opsOf.byId(id);
    }
    ops(limit = 20) {
        return this.opsOf.latest(limit);
    }
    /** The last finished op for a hostname (status lines). */
    lastOp(hostname: string) {
        return this.opsOf.lastFinished(hostname);
    }
    /** After a restart nothing is running: mark what was as interrupted. */
    interruptRunning() {
        return this.opsOf.interruptRunning(this.now());
    }
}
