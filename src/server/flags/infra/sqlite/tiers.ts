import { eq } from 'drizzle-orm';

import type { FlagTierRepository, StoredFlagTier } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { flagTenantTiers, flagTiers } from './schema.js';

/** Hard deletes name the table (tests/hard-deletes.test.ts). */
const t = flagTiers;
const w = flagTenantTiers;

/** Plans and the plan each workspace is on (CB-182). */
export class SqliteFlagTiers extends SqliteRepository implements FlagTierRepository {
    save(tier: StoredFlagTier, by: string, at: number) {
        return this.write('save flag tier', async () => {
            const fields = {
                name: tier.name,
                description: tier.description,
                flags: tier.flags,
                updatedBy: by,
                updatedAt: at,
            };
            await this.db
                .insert(t)
                .values({ id: tier.id, ...fields, createdAt: at })
                .onConflictDoUpdate({ target: t.id, set: fields });
        });
    }

    async exists(id: string) {
        return !!(await this.db.select({ id: t.id }).from(t).where(eq(t.id, id)).get());
    }

    async inUse(id: string) {
        return !!(await this.db.select({ tenantId: w.tenantId }).from(w).where(eq(w.tierId, id)).limit(1).get());
    }

    remove(id: string) {
        return this.write('delete flag tier', async () => {
            await this.db.delete(flagTiers).where(eq(t.id, id));
        });
    }

    assign(tenantId: string, tierId: string, by: string, at: number) {
        return this.write('set workspace tier', async () => {
            const fields = { tierId, updatedBy: by, updatedAt: at };
            await this.db
                .insert(w)
                .values({ tenantId, ...fields })
                .onConflictDoUpdate({ target: w.tenantId, set: fields });
        });
    }

    unassign(tenantId: string) {
        return this.write('clear workspace tier', async () => {
            await this.db.delete(flagTenantTiers).where(eq(w.tenantId, tenantId));
        });
    }
}
