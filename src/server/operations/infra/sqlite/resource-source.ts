import type { DatabaseSync } from 'node:sqlite';

/** Read-only resource measurements; never reads page or conversation contents. */
export class SqliteResourceSource {
    constructor(private db: DatabaseSync) {}
    database() {
        const pragma = (name: string) => Number(Object.values(this.db.prepare(`PRAGMA ${name}`).get() ?? {})[0]);
        const files = this.db.prepare('PRAGMA database_list').all();
        return {
            pages: pragma('page_count'),
            freePages: pragma('freelist_count'),
            path: String(files.find((row) => row.name === 'main')?.file ?? ''),
        };
    }
    daily() {
        const total = (table: string, column: string) => {
            if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
                return null;
            }
            return Number(
                this.db.prepare(`SELECT COALESCE(SUM(${column}),0) AS n FROM ${table} WHERE deletedAt IS NULL`).get()
                    ?.n,
            );
        };
        return {
            datasetBytes: total('data_datasets', 'sizeBytes'),
            fileBytes: total('data_files', 'storedSize'),
            mediaBytes: total('media_attachments', 'size'),
        };
    }
}
