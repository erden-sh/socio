import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { boardTables } from '../../src/server/issues/infra/sqlite/schema.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * The Board owns its tables (CB-110): only its repositories in
 * src/server/issues/infra read or write them. Its migrations create them,
 * and the change counters (CB-62) watch them with triggers.
 */

const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/issues/infra/';
const ALLOWED = new Set([
    'src/server/issues/migrations.ts',
    'src/server/live/change-counters.ts',
    // The Operations ETL's read-only copy of the board's items (CB-189):
    // the documented exception for analytics (CB-164), on its own
    // read-only connection, its columns checked by the ETL's drift test.
    'src/server/operations/infra/sqlite/source-reader.ts',
    // The analytics ETL's read-only copy of capability requests and their
    // items' titles and statuses (CB-191): replication, like a backup, held
    // to the migrations by its drift test (CB-164).
    'src/server/operations/infra/sqlite/knowledge-source.ts',
    // The analytics ETL's read-only copy of items' links to the turns they
    // were filed from (CB-194), held to the migrations by its drift test.
    'src/server/operations/infra/sqlite/grounding-source.ts',
    // CB-380: workspace bundles, an operator's copy between two Socio
    // servers. The export reads a snapshot of these tables (replication,
    // like a backup); the import writes them in its own chunked
    // transactions, keeping ids and times, which the repositories can't.
    // Both are held to the migrations by the bundle's schema check and tests.
    'src/server/bundle/export.ts',
    'src/server/bundle/import.ts',
    // The import's removal of a deleted issue (filed here) whose number a
    // bundle's issue takes, in the transaction that writes that issue.
    'src/server/bundle/replace.ts',
]);

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

const names = boardTables.map((table) => getTableName(table));
/** SQL naming a Board table: `FROM issues`, `JOIN "issue_votes"`, … */
const statement = new RegExp(
    String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`,
);

it('spots SQL on a Board table', () => {
    for (const sql of [
        'SELECT * FROM issues WHERE id = ?',
        'SELECT n FROM x JOIN "issue_votes" v ON v.issueId = x.id',
        'INSERT INTO dot_request_notices(id) VALUES (?)',
        'UPDATE issue_triage SET state = ?',
        'DELETE FROM issue_events',
    ]) {
        expect(sql).toMatch(statement);
    }
    for (const prose of ['SELECT * FROM issues_v3', 'Waits for issues to close', 'SELECT * FROM dispatch_runs']) {
        expect(prose).not.toMatch(statement);
    }
});

it('keeps SQL on the Board tables inside the Board’s infra', () => {
    const offenders: string[] = [];
    for (const path of [
        ...sources(join(root, 'src')),
        ...sources(join(root, 'packages/client/src')),
        ...PACKAGE_SOURCES.flatMap((dir) => sources(join(root, dir))),
    ]) {
        const file = relative(root, path).replaceAll('\\', '/');
        if (file.startsWith(INFRA) || ALLOWED.has(file)) {
            continue;
        }
        const text = readFileSync(path, 'utf8');
        // Over the whole file, so a statement split across lines counts too.
        for (const match of text.matchAll(new RegExp(statement, 'g'))) {
            offenders.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
        }
        if (/from '[./]*(?:issues\/)?infra\/sqlite\/schema\.js'/.test(text)) {
            offenders.push(`${file}: imports the Board's table schema`);
        }
    }
    expect(offenders).toEqual([]);
});
