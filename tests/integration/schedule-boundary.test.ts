import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { scheduleTables } from '../../src/server/schedules/infra/sqlite/schema.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * The Scheduling and jobs context owns its tables (CB-110): only its
 * repositories in src/server/schedules/infra read or write them. Its
 * migrations create them, after the core's and the workspace's frozen
 * history, and the change counters (CB-62) watch `tasks` with triggers.
 * Other contexts reach them through its services.
 */

const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/schedules/infra/';
const ALLOWED = new Set([
    'src/server/schedules/migrations.ts',
    'src/server/live/change-counters.ts',
    // The Operations ETL's read-only copy into the analytics store (CB-192),
    // the documented exception to one owner per table (CB-164), held to
    // its columns by the source map's drift test.
    'src/server/operations/infra/sqlite/health-source-reader.ts',
]);
/** Files whose frozen migrations name these tables, and nothing else may. */
const HISTORY: Record<string, string> = {
    'src/server/settings/store.ts': 'export const coreSchema',
    'src/server/workspace/workspace.ts': 'export const workspaceSchema',
};

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

/** A file's source with its frozen migrations (`marker`) blanked out. */
function withoutHistory(text: string, marker: string) {
    const start = text.indexOf(marker);
    const end = text.indexOf('\n};\n', start);
    if (start < 0 || end < 0) {
        throw new Error(`${marker} not found`);
    }
    // Keep the line breaks, so offenders keep their line numbers.
    return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

const names = scheduleTables.map((table) => getTableName(table));
/** SQL naming a Scheduling table: `FROM tasks`, `INTO "job_runs"`, … */
const statement = new RegExp(
    String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`,
);

it('spots SQL on a Scheduling table', () => {
    for (const sql of [
        'SELECT * FROM tasks WHERE id = ?',
        'SELECT t.taskId FROM task_threads t JOIN thread_bindings b ON b.id = t.threadId',
        'INSERT INTO "job_runs" (id) VALUES (?)',
        'UPDATE goals SET status = ?',
        'DELETE FROM job_items WHERE longRunId = ?',
        'SELECT status, n FROM job_run_counts',
        'CREATE INDEX events_task ON events(taskId, id)',
        'SELECT MAX(queuedAt) FROM job_runs WHERE dotId=?',
    ]) {
        expect(sql).toMatch(statement);
    }
    for (const prose of [
        'SELECT * FROM agent_runs',
        'SELECT * FROM dispatch_run_events',
        'SELECT * FROM jobs_v2',
        'Socios run jobs from schedules',
    ]) {
        expect(prose).not.toMatch(statement);
    }
    // The frozen history is left out, keeping the lines after it.
    const blanked = withoutHistory(
        'a\nexport const coreSchema = {\n  up: `UPDATE tasks SET x=1`,\n};\nUPDATE tasks',
        'export const coreSchema',
    );
    expect(blanked.split('\n')).toHaveLength(5);
    expect(blanked.match(new RegExp(statement, 'g'))).toEqual(['UPDATE tasks']);
});

it('keeps SQL on the Scheduling tables inside the Scheduling context’s infra', () => {
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
        const text = HISTORY[file] ? withoutHistory(source, HISTORY[file]) : source;
        // Over the whole file, so a statement split across lines counts too.
        for (const match of text.matchAll(new RegExp(statement, 'g'))) {
            offenders.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
        }
        if (/from '[./]*(?:schedules\/)?infra\/sqlite\/schema\.js'/.test(text)) {
            offenders.push(`${file}: imports the Scheduling context's table schema`);
        }
    }
    expect(offenders).toEqual([]);
});

it('runs no raw SQL in the Scheduling context outside its infra', () => {
    const offenders: string[] = [];
    for (const path of sources(join(root, 'src/server/schedules'))) {
        const file = relative(root, path).replaceAll('\\', '/');
        if (file.startsWith(INFRA)) {
            continue;
        }
        const text = readFileSync(path, 'utf8');
        // Raw statements; Drizzle's own `.prepare()` takes no SQL.
        if (/\.(?:prepare|exec)\(\s*['"\x60]/.test(text)) {
            offenders.push(`${file}: runs raw SQL`);
        }
        if (/from 'drizzle-orm/.test(text)) {
            offenders.push(`${file}: queries with Drizzle outside its infra`);
        }
    }
    expect(offenders).toEqual([]);
});
