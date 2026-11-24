import { and, asc, desc, eq, ne } from 'drizzle-orm';

import type { DomainOp, DomainStep } from '@socio/shared/domains';

import type { DomainHost, DomainHostRepository, DomainOpRepository } from '../../contract.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { domainHosts, domainOps } from './schema.js';

/** The hostnames the domains module manages. */
export class SqliteDomainHosts extends SqliteRepository implements DomainHostRepository {
    async all(kind?: DomainHost['kind']) {
        return this.db
            .select()
            .from(domainHosts)
            .where(kind ? eq(domainHosts.kind, kind) : undefined)
            .orderBy(asc(domainHosts.hostname))
            .all();
    }

    async byName(hostname: string) {
        return this.db.select().from(domainHosts).where(eq(domainHosts.hostname, hostname)).get();
    }

    save(host: DomainHost) {
        return this.write('save domain host', async () => {
            await this.db
                .insert(domainHosts)
                .values(host)
                .onConflictDoUpdate({ target: domainHosts.hostname, set: host });
        });
    }

    remove(hostname: string) {
        return this.write('remove domain host', async () => {
            await this.db.delete(domainHosts).where(eq(domainHosts.hostname, hostname));
        });
    }
}

type OpRow = typeof domainOps.$inferSelect;

const opOf = (row: OpRow): DomainOp => ({
    id: row.id,
    kind: row.kind,
    hostname: row.hostname,
    actor: row.actor,
    status: row.status,
    steps: row.steps,
    ...(row.error ? { error: row.error } : {}),
    startedAt: row.startedAt,
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
});

const NEWEST = [desc(domainOps.startedAt), desc(insertionOrder(domainOps))];

/** Every domain operation, its steps and outcome. */
export class SqliteDomainOps extends SqliteRepository implements DomainOpRepository {
    start(op: DomainOp) {
        return this.write('start domain operation', async () => {
            await this.db.insert(domainOps).values({
                id: op.id,
                kind: op.kind,
                hostname: op.hostname,
                actor: op.actor,
                status: 'running',
                steps: [],
                startedAt: op.startedAt,
            });
        });
    }

    saveSteps(id: string, steps: DomainStep[]) {
        return this.write('save domain steps', async () => {
            await this.db.update(domainOps).set({ steps }).where(eq(domainOps.id, id));
        });
    }

    finish(id: string, steps: DomainStep[], error: string | undefined, now: number) {
        return this.write('finish domain operation', async () => {
            await this.db
                .update(domainOps)
                .set({
                    status: error ? 'failed' : 'ok',
                    steps,
                    error: error ?? null,
                    finishedAt: now,
                })
                .where(eq(domainOps.id, id));
            return this.byId(id);
        });
    }

    async byId(id: string) {
        const row = await this.db.select().from(domainOps).where(eq(domainOps.id, id)).get();
        return row ? opOf(row) : undefined;
    }

    async latest(limit: number) {
        return (
            await this.db
                .select()
                .from(domainOps)
                .orderBy(...NEWEST)
                .limit(limit)
                .all()
        ).map(opOf);
    }

    async lastFinished(hostname: string) {
        const row = await this.db
            .select()
            .from(domainOps)
            .where(and(eq(domainOps.hostname, hostname), ne(domainOps.status, 'running')))
            .orderBy(...NEWEST)
            .limit(1)
            .get();
        return row ? opOf(row) : undefined;
    }

    interruptRunning(now: number) {
        return this.write('interrupt domain operations', async () => {
            const interrupted = await this.db
                .update(domainOps)
                .set({
                    status: 'failed',
                    error: 'Interrupted by a restart.',
                    finishedAt: now,
                })
                .where(eq(domainOps.status, 'running'))
                .returning({ id: domainOps.id });
            return interrupted.length;
        });
    }
}
