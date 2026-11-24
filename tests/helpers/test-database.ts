import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';

/**
 * Where the migrated template lives: `tests/setup/test-template.ts` writes
 * it once per run; a script outside Vitest calls `prepareTestTemplate`
 * (`./test-template-build.ts`) first. Migrating once and copying is what
 * lets a test start from the schema boot makes without paying for it:
 * copying takes a few milliseconds, migrating most of a second.
 */
export const TEMPLATE_ENV = 'SOCIO_TEST_TEMPLATE';

let template: Uint8Array | undefined;
function templateBytes() {
    if (!template) {
        const path = process.env[TEMPLATE_ENV];
        if (!path) {
            throw new Error(
                `${TEMPLATE_ENV} is not set: Vitest's global setup writes the template; a script calls prepareTestTemplate() first.`,
            );
        }
        template = readFileSync(path);
    }
    return template;
}

/**
 * A private in-memory database with every schema boot migrates, as an
 * already-booted server would open it. The caller closes it, or lets it go.
 */
export function testDatabase() {
    const db = new DatabaseSync(':memory:');
    db.deserialize(templateBytes());
    applyConnectionPragmas(db, {});
    return db;
}

/**
 * The same as a file, for tests that reopen the path or hold several
 * connections to it: returns `path`, written unless something is there yet.
 */
export function testDatabaseFile(path: string) {
    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, templateBytes());
    }
    return path;
}
