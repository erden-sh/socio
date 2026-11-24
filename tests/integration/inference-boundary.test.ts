import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { inferenceTables } from '../../src/server/inference/infra/sqlite/schema.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * Inference owns its tables (CB-110): only its repositories in
 * src/server/inference/infra read or write them; its migrations create
 * them, and the change counters' triggers name them (an infra adapter,
 * Q9). Inference itself runs no raw SQL and reaches no other context's
 * infra.
 */

const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/inference/infra/';
const ALLOWED = new Set(['src/server/inference/migrations.ts']);

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

const names = inferenceTables.map((table) => getTableName(table));
/** SQL naming an inference table: `FROM inference_backends`, `INTO "inference_timings"`, … */
const statement = new RegExp(
    String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`,
);

it('spots SQL on an inference table', () => {
    for (const sql of [
        'SELECT * FROM inference_backends WHERE id=?',
        'INSERT INTO "inference_timings" (key) VALUES (?)',
        'UPDATE inference_settings SET value=? WHERE key=?',
        'DELETE FROM user_inference_connections WHERE userId=?',
        'SELECT u.name FROM users u JOIN user_inference_connections c ON c.userId = u.id',
        'CREATE INDEX inference_timings_key ON inference_timings(key, at)',
    ]) {
        expect(sql).toMatch(statement);
    }
    for (const prose of [
        'SELECT * FROM inference_backends_v2',
        'Inference backends are managed on the Operator page',
        "targetKind: 'inference_backend'",
        'SELECT * FROM users',
    ]) {
        expect(prose).not.toMatch(statement);
    }
});

it('keeps SQL on the inference tables inside inference’s infra', () => {
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
        if (/from '[./]*(?:inference\/)?infra\/sqlite\/schema\.js'/.test(text)) {
            offenders.push(`${file}: imports inference's table schema`);
        }
    }
    expect(offenders).toEqual([]);
});

it('runs no raw SQL in inference, and reaches no other context’s infra', () => {
    const offenders: string[] = [];
    for (const path of sources(join(root, 'src/server/inference'))) {
        const file = relative(root, path).replaceAll('\\', '/');
        const text = readFileSync(path, 'utf8');
        for (const [, target] of text.matchAll(/from '([^']*\/infra\/[^']*)'/g)) {
            if (!file.startsWith(INFRA) && !target.startsWith('./infra/')) {
                offenders.push(`${file}: imports ${target}`);
            }
        }
        // Raw statements; Drizzle's own `.prepare()` takes no SQL.
        if (/\.(?:prepare|exec)\(\s*['"\x60]/.test(text)) {
            offenders.push(`${file}: runs raw SQL`);
        }
    }
    expect(offenders).toEqual([]);
});
