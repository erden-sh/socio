import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '@socio/data/migrate';

import { schemas } from '../../src/server/modules/index.js';

import { TEMPLATE_ENV } from './test-database.js';

/**
 * Runs the real migrations on an empty database, as boot does, and writes
 * the result where `testDatabase` copies it from. An in-memory source keeps
 * the file out of WAL mode, which an in-memory copy couldn't open. Kept out
 * of `test-database.ts` since importing the registry loads the whole server.
 */
export function buildTestTemplate(path: string) {
    const db = new DatabaseSync(':memory:');
    try {
        migrate(db, schemas, { strict: true });
        writeFileSync(path, db.serialize());
    } finally {
        db.close();
    }
}

/** For a script outside Vitest: a template for this process, once. Returns its folder. */
export function prepareTestTemplate() {
    const directory = mkdtempSync(join(tmpdir(), 'socio-test-template-'));
    const path = join(directory, 'template.sqlite');
    buildTestTemplate(path);
    process.env[TEMPLATE_ENV] = path;
    return directory;
}
