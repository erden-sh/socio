import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { DataApiTokenRepository, DataApiTokenRow } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { dataApiTokens } from './schema.js';

const t = dataApiTokens;

/** Admins' data API tokens: by hash only; a revoke keeps the row. */
export class SqliteDataApiTokens extends SqliteRepository implements DataApiTokenRepository {
    insertNow(row: DataApiTokenRow) {
        this.db.insert(t).values(row).run();
    }

    byHash(hash: string): DataApiTokenRow | undefined {
        return this.db.select().from(t).where(eq(t.hash, hash)).get();
    }

    byId(id: string): DataApiTokenRow | undefined {
        return this.db.select().from(t).where(eq(t.id, id)).get();
    }

    all(): DataApiTokenRow[] {
        return this.db.select().from(t).orderBy(desc(t.createdAt), t.id).all();
    }

    revokeNow(id: string, at: number, by: string) {
        return (
            Number(
                this.db
                    .update(t)
                    .set({ revokedAt: at, revokedBy: by })
                    .where(and(eq(t.id, id), isNull(t.revokedAt)))
                    .run().changes,
            ) > 0
        );
    }

    revokeMadeByNow(createdBy: string, at: number, by: string) {
        const live = this.db
            .select()
            .from(t)
            .where(and(eq(t.createdBy, createdBy), isNull(t.revokedAt)))
            .all();
        return live.filter((row) => this.revokeNow(row.id, at, by));
    }

    recordUse(id: string, at: number, requests: number) {
        this.soon('data api token use', () => {
            this.db
                .update(t)
                .set({ lastUsedAt: at, uses: sql`${t.uses} + ${requests}` })
                .where(eq(t.id, id))
                .run();
        });
    }
}
