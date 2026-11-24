import { eq } from 'drizzle-orm';

import type { PluginBudget, PluginBudgetRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { dataPluginBudgets } from './schema.js';

const b = dataPluginBudgets;

/** Admins' data operation budgets for plugins' tokens (CB-473). */
export class SqlitePluginBudgets extends SqliteRepository implements PluginBudgetRepository {
    get(pluginId: string): PluginBudget | undefined {
        return this.db.select().from(b).where(eq(b.pluginId, pluginId)).get();
    }

    set(budget: PluginBudget) {
        this.db
            .insert(b)
            .values(budget)
            .onConflictDoUpdate({
                target: b.pluginId,
                set: { statementsPerMinute: budget.statementsPerMinute, setBy: budget.setBy, setAt: budget.setAt },
            })
            .run();
    }

    clear(pluginId: string) {
        return Number(this.db.delete(b).where(eq(b.pluginId, pluginId)).run().changes) > 0;
    }
}
