import type { DataAuditLog, DataAuditRecord } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { dataAudit } from './schema.js';

/** The data audit: rows written soon, in order (CB-110). */
export class SqliteDataAudit extends SqliteRepository implements DataAuditLog {
    record(entry: DataAuditRecord) {
        this.soon('data audit', () => {
            this.db.insert(dataAudit).values(entry).run();
        });
    }
}
