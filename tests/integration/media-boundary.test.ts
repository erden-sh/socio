import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { mediaTables } from '../../src/server/media/infra/sqlite/schema.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * Media owns its tables (CB-110): only its repositories in
 * src/server/media/infra read or write them. Its migrations create them.
 * Other contexts ask Media (attachments, the conversation reads check),
 * and Media asks the data space for files, never joining its tables.
 */

const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/media/infra/';
const ALLOWED = new Set([
    'src/server/media/migrations.ts',
    // CB-380: workspace bundles, an operator's copy between two Socio
    // servers. The export reads a snapshot of these tables (replication,
    // like a backup); the import writes them in its own chunked
    // transactions, keeping ids and times, which the repositories can't.
    // Both are held to the migrations by the bundle's schema check and tests.
    'src/server/bundle/export.ts',
    'src/server/bundle/import.ts',
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

const names = mediaTables.map((table) => getTableName(table));
/** SQL naming a Media table: `FROM media_attachments`, `INTO "media_folders"`, … */
const statement = new RegExp(
    String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`,
);

it('spots SQL on a Media table', () => {
    for (const sql of [
        'SELECT * FROM media_attachments WHERE id=?',
        'SELECT 1 FROM data_files f JOIN "media_attachments" a ON a.fileId = f.id',
        'INSERT INTO media_folders (ownerUserId, path, createdAt) VALUES (?, ?, ?)',
        'INSERT OR IGNORE INTO media_folders VALUES (?, ?, ?)',
        'UPDATE media_attachments SET deletedAt=?',
        'DELETE FROM media_folders WHERE ownerUserId=?',
        'CREATE INDEX media_attachments_file ON media_attachments(fileId)',
    ]) {
        expect(sql).toMatch(statement);
    }
    for (const prose of [
        'SELECT * FROM media_attachments_v4',
        'Files the user attached in this conversation',
        'from media folders on the Media page',
        'SELECT * FROM data_files',
    ]) {
        expect(prose).not.toMatch(statement);
    }
});

it('keeps SQL on the Media tables inside its infra', () => {
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
        if (/from '[./]*(?:media\/)?infra\/sqlite\/schema\.js'/.test(text)) {
            offenders.push(`${file}: imports the Media table schema`);
        }
    }
    expect(offenders).toEqual([]);
});

it('keeps the media service off the data space’s tables', () => {
    const text = readFileSync(join(root, 'src/server/media/service.ts'), 'utf8');
    expect(text).not.toMatch(/\bdata_files\b|\.prepare\(/);
});
