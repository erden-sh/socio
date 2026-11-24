import { and, desc, eq, lte } from 'drizzle-orm';

import type { WebAudit, WebIdentity } from '@socio/shared/web/web-types';

import type { WebAuditRepository, WebIdentityRepository } from '../../contract.js';

import { SqliteRepository, insertionOrder } from './base.js';
import { webAudit, webIdentity } from './schema.js';

/** Each socio's own web identity, when it has one. */
export class SqliteWebIdentities extends SqliteRepository implements WebIdentityRepository {
    async get(dotId: string) {
        return (
            await this.db
                .select({ identity: webIdentity.identity })
                .from(webIdentity)
                .where(eq(webIdentity.dotId, dotId))
                .get()
        )?.identity;
    }

    set(dotId: string, identity: WebIdentity | null, now: number) {
        return this.write('set web identity', async () => {
            if (!identity) {
                await this.db.delete(webIdentity).where(eq(webIdentity.dotId, dotId));
                return;
            }
            await this.db
                .insert(webIdentity)
                .values({ dotId, identity, updatedAt: now })
                .onConflictDoUpdate({
                    target: webIdentity.dotId,
                    set: { identity, updatedAt: now },
                });
        });
    }
}

/** The web-read audit: append-only. */
export class SqliteWebAudit extends SqliteRepository implements WebAuditRepository {
    append(entry: WebAudit & { dotId: string }) {
        this.soon('web audit', () => {
            this.db
                .insert(webAudit)
                .values({
                    id: entry.id,
                    dotId: entry.dotId,
                    userId: entry.userId ?? null,
                    method: entry.method,
                    host: entry.host,
                    path: entry.path,
                    status: entry.status ?? null,
                    bytes: entry.bytes,
                    outcome: entry.outcome,
                    createdAt: entry.createdAt,
                })
                .run();
        });
    }

    async latest(dotId: string, limit: number): Promise<WebAudit[]> {
        // `web_audit_dot` serves this without a sort.
        return this.db
            .select({
                id: webAudit.id,
                userId: webAudit.userId,
                method: webAudit.method,
                host: webAudit.host,
                path: webAudit.path,
                status: webAudit.status,
                bytes: webAudit.bytes,
                outcome: webAudit.outcome,
                createdAt: webAudit.createdAt,
            })
            .from(webAudit)
            .where(eq(webAudit.dotId, dotId))
            .orderBy(desc(webAudit.createdAt), desc(insertionOrder(webAudit)))
            .limit(limit)
            .all();
    }

    async activity(dotId: string, before: number, limit: number) {
        return this.db
            .select({
                userId: webAudit.userId,
                method: webAudit.method,
                host: webAudit.host,
                path: webAudit.path,
                status: webAudit.status,
                outcome: webAudit.outcome,
                createdAt: webAudit.createdAt,
            })
            .from(webAudit)
            .where(and(eq(webAudit.dotId, dotId), lte(webAudit.createdAt, before)))
            .orderBy(desc(webAudit.createdAt))
            .limit(limit)
            .all();
    }
}
