import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import type { PluginBinding, PluginBindingRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { dataPluginBindings } from './schema.js';

const b = dataPluginBindings;

/** Plugin needs' bindings to workspace datasets (CB-451); ended, never deleted. */
export class SqlitePluginBindings extends SqliteRepository implements PluginBindingRepository {
    bindNow(binding: Omit<PluginBinding, 'unboundAt'>) {
        this.db
            .insert(b)
            .values({ ...binding, unboundAt: null })
            .run();
    }

    unbindNow(id: string, at: number) {
        const { changes } = this.db
            .update(b)
            .set({ unboundAt: at })
            .where(and(eq(b.id, id), isNull(b.unboundAt)))
            .run();
        return Number(changes) > 0;
    }

    liveForPlugin(pluginId: string): PluginBinding[] {
        return this.db
            .select()
            .from(b)
            .where(and(eq(b.pluginId, pluginId), isNull(b.unboundAt)))
            .orderBy(asc(b.boundAt), asc(b.id))
            .all();
    }

    liveForDataset(datasetId: string): PluginBinding[] {
        return this.db
            .select()
            .from(b)
            .where(and(eq(b.datasetId, datasetId), isNull(b.unboundAt)))
            .orderBy(asc(b.boundAt), asc(b.id))
            .all();
    }

    live(): PluginBinding[] {
        return this.db.select().from(b).where(isNull(b.unboundAt)).orderBy(asc(b.boundAt), asc(b.id)).all();
    }

    everBound(datasetId: string) {
        return !!this.db.select({ id: b.id }).from(b).where(eq(b.datasetId, datasetId)).limit(1).get();
    }

    endedForPlugin(pluginId: string): PluginBinding[] {
        return this.db
            .select()
            .from(b)
            .where(and(eq(b.pluginId, pluginId), isNotNull(b.unboundAt)))
            .orderBy(desc(b.unboundAt), desc(b.boundAt))
            .all();
    }

    lastWriters(ids: readonly string[]) {
        const out = new Map<string, PluginBinding>();
        if (!ids.length) {
            return out;
        }
        const rows = this.db
            .select()
            .from(b)
            .where(and(inArray(b.datasetId, [...ids]), eq(b.access, 'write')))
            .orderBy(desc(b.boundAt))
            .all();
        const live = new Set(rows.filter((row) => row.unboundAt === null).map((row) => row.datasetId));
        for (const row of rows) {
            if (row.unboundAt !== null && !live.has(row.datasetId) && !out.has(row.datasetId)) {
                out.set(row.datasetId, row);
            }
        }
        return out;
    }
}
