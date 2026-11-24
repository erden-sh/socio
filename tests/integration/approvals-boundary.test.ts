import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { approvalTables } from '../../src/server/approvals/infra/sqlite/schema.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * Approvals own their tables (CB-110): only their repositories in
 * src/server/approvals/infra read or write them. Their migrations create
 * them; other contexts ask through the service's port (`dotActivity`).
 */

const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/approvals/infra/';
const ALLOWED = new Set([
    'src/server/approvals/migrations.ts',
    // The Operations ETL's read-only copy (CB-164, CB-190), like a backup.
    'src/server/operations/infra/sqlite/activity-source.ts',
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

const names = approvalTables.map((table) => getTableName(table));
/** SQL naming an approval table: `FROM approval_requests`, … */
const statement = new RegExp(
    String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`,
);

it('spots SQL on an approval table', () => {
    for (const sql of [
        'SELECT * FROM approval_requests WHERE id = ?',
        'SELECT n FROM x JOIN "approval_auto_decisions" a ON a.requestId = x.id',
        'INSERT INTO approval_audit VALUES (?)',
        'UPDATE approval_policies SET policy = ?',
        'DELETE FROM approval_guidance WHERE userId = ?',
        'CREATE INDEX approval_notes_thread ON approval_notes(threadId)',
    ]) {
        expect(sql).toMatch(statement);
    }
    for (const prose of [
        'SELECT * FROM approval_requests_v2',
        'Waits for approval_requests to settle',
        'SELECT * FROM approvals',
    ]) {
        expect(prose).not.toMatch(statement);
    }
});

it('keeps SQL on the approval tables inside the approvals’ infra', () => {
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
        if (/from '[./]*(?:approvals\/)?infra\/sqlite\/schema\.js'/.test(text)) {
            offenders.push(`${file}: imports the approval tables' schema`);
        }
    }
    expect(offenders).toEqual([]);
});
