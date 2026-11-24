import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';

import { SqliteSkillSessions, SqliteSkillsRepository } from './infra/sqlite/index.js';

/**
 * Workspace chat skills (CB-143) and the skills on in each chat: their
 * repositories on a connection (CB-110). The domain types are in
 * `contract.ts`, the domain helpers in `domain/repositories.ts`, the SQLite
 * implementations in `infra/sqlite`.
 */
export { chatSkillsSchema } from './migrations.js';
export { SqliteSkillSessions, SqliteSkillsRepository };

const byDb = new WeakMap<DatabaseSync, SqliteSkillsRepository>();
/** One repository per database, its tables migrated. */
export function skillsRepository(db: DatabaseSync) {
    let repository = byDb.get(db);
    if (!repository) {
        byDb.set(db, (repository = new SqliteSkillsRepository(sqliteData(db))));
    }
    return repository;
}

const sessionsByDb = new WeakMap<DatabaseSync, SqliteSkillSessions>();
/** One sessions repository per database, its tables migrated. */
export function skillSessions(db: DatabaseSync) {
    let sessions = sessionsByDb.get(db);
    if (!sessions) {
        sessionsByDb.set(db, (sessions = new SqliteSkillSessions(sqliteData(db))));
    }
    return sessions;
}
