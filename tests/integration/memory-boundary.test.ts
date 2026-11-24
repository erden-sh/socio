import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { memoryTables } from '../../src/server/memory/infra/sqlite/schema.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * The Memory context owns its tables (CB-110): only its repositories in
 * src/server/memory/infra read or write them. Its migrations create them,
 * after the core's frozen history (Q7), and the change counters (CB-62)
 * watch them with triggers.
 */

const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/memory/infra/';
const ALLOWED = new Set([
    'src/server/memory/migrations.ts',
    'src/server/live/change-counters.ts',
    // The Operations ETL's read-only copy (CB-164, CB-190), like a backup.
    'src/server/operations/infra/sqlite/activity-source.ts',
]);
/** The core store's file: only its frozen migrations name these tables. */
const CORE = 'src/server/settings/store.ts';

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

/** The core store's source with its migrations (`coreSchema`) blanked out. */
function withoutCoreHistory(text: string) {
    const start = text.indexOf('export const coreSchema');
    const end = text.indexOf('\n};\n', start);
    if (start < 0 || end < 0) {
        throw new Error('coreSchema not found');
    }
    // Keep the line breaks, so offenders keep their line numbers.
    return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

const names = memoryTables.map((table) => getTableName(table));
/** SQL naming a Memory table: `FROM memories`, `INTO "user_profiles"`, … */
const statement = new RegExp(
    String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`,
);

it('spots SQL on a Memory table', () => {
    for (const sql of [
        'SELECT * FROM memories WHERE id = ?',
        'SELECT n FROM x JOIN "user_profiles" p ON p.userId = x.id',
        'INSERT INTO time_zone_notes(userId) VALUES (?)',
        'UPDATE memories SET status = ?',
        'DELETE FROM user_profiles',
        'CREATE INDEX memories_user ON memories(userId)',
    ]) {
        expect(sql).toMatch(statement);
    }
    for (const prose of [
        'SELECT * FROM memories_v2',
        'Socios propose memories to the person',
        'SELECT * FROM user_preferences',
    ]) {
        expect(prose).not.toMatch(statement);
    }
    // The core's frozen history is left out, keeping the lines after it.
    const blanked = withoutCoreHistory(
        'a\nexport const coreSchema = {\n  up: `UPDATE memories SET x=1`,\n};\nUPDATE memories',
    );
    expect(blanked.split('\n')).toHaveLength(5);
    expect(blanked.match(new RegExp(statement, 'g'))).toEqual(['UPDATE memories']);
});

it('keeps SQL on the Memory tables inside the Memory context’s infra', () => {
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
        const source = readFileSync(path, 'utf8');
        const text = file === CORE ? withoutCoreHistory(source) : source;
        // Over the whole file, so a statement split across lines counts too.
        for (const match of text.matchAll(new RegExp(statement, 'g'))) {
            offenders.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
        }
        if (/from '[./]*(?:memory\/)?infra\/sqlite\/schema\.js'/.test(text)) {
            offenders.push(`${file}: imports the Memory context's table schema`);
        }
    }
    expect(offenders).toEqual([]);
});
