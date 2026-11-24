import { and, asc, eq, sql } from 'drizzle-orm';

import type { FieldSettingRepository, FieldSettingRow } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { dataFieldSettings } from './schema.js';

const f = dataFieldSettings;

/** Table and column names compare as SQLite's do: without regard to case (the columns are NOCASE). */
const at = (datasetId: string, table: string) => and(eq(f.datasetId, datasetId), eq(f.tableName, table));

/** Columns' field settings (CB-451), saved by version. */
export class SqliteFieldSettings extends SqliteRepository implements FieldSettingRepository {
    forTable(datasetId: string, table: string): FieldSettingRow[] {
        return this.db
            .select()
            .from(f)
            .where(at(datasetId, table))
            .orderBy(asc(sql`rowid`))
            .all();
    }

    get(datasetId: string, table: string, column: string): FieldSettingRow | undefined {
        return this.db
            .select()
            .from(f)
            .where(and(at(datasetId, table), eq(f.columnName, column)))
            .get();
    }

    saveNow(row: Omit<FieldSettingRow, 'version'>, baseVersion: number) {
        if (baseVersion === 0) {
            const { changes } = this.db
                .insert(f)
                .values({ ...row, version: 1 })
                .onConflictDoNothing()
                .run();
            return Number(changes) > 0;
        }
        const { changes } = this.db
            .update(f)
            .set({
                kind: row.kind,
                label: row.label,
                settings: row.settings,
                declaredBy: row.declaredBy,
                updatedBy: row.updatedBy,
                updatedAt: row.updatedAt,
                version: baseVersion + 1,
            })
            .where(and(at(row.datasetId, row.tableName), eq(f.columnName, row.columnName), eq(f.version, baseVersion)))
            .run();
        return Number(changes) > 0;
    }
}
