import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

// scripts/i18n-build.mjs, on dictionaries written to a scratch folder: what it
// refuses, and what it writes (dist/i18n's shape, docs/I18N.md).
const root = join(import.meta.dirname, '..');
const scratch: string[] = [];
afterEach(() => {
    for (const dir of scratch.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A label and where-it-appears for each en-US namespace, as namespaces.json needs.
const entriesFor = (files: Record<string, string>) =>
    Object.fromEntries(
        Object.keys(files)
            .filter((path) => path.startsWith('en-US/'))
            .map((path) => [
                path.slice('en-US/'.length, -'.json'.length),
                { label: 'Chat · Message box', where: 'The box at the bottom of a conversation.' },
            ]),
    );

function setup(
    files: Record<string, string>,
    routes: Record<string, string[]> = { root: ['common'] },
    namespaces: unknown = entriesFor(files),
) {
    const dir = mkdtempSync(join(tmpdir(), 'socio-i18n-'));
    scratch.push(dir);
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(dir, 'locales', path, '..'), { recursive: true });
        writeFileSync(join(dir, 'locales', path), text);
    }
    writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes));
    writeFileSync(join(dir, 'namespaces.json'), JSON.stringify(namespaces));
    return dir;
}

const build = (dir: string, ...flags: string[]) =>
    spawnSync(
        process.execPath,
        [
            '--import',
            'tsx',
            'scripts/i18n-build.mjs',
            '--locales',
            join(dir, 'locales'),
            '--out',
            join(dir, 'out'),
            '--routes',
            join(dir, 'routes.json'),
            // Typed keys of the scratch locales, not the repository's.
            '--types',
            join(dir, 'resources.gen.ts'),
            '--write-types',
            ...flags,
        ],
        { cwd: root, encoding: 'utf8' },
    );

const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) =>
        statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)],
    );

const EN = JSON.stringify({ hello: 'Hello, {{name}}', files_one: '{{count}} file', files_other: '{{count}} files' });

describe('scripts/i18n-build.mjs', () => {
    it('refuses broken JSON, unknown keys, other variables and missing plural forms, and writes nothing', () => {
        const dir = setup({
            'en-US/common.json': EN,
            'es-419/common.json': JSON.stringify({ hola: 'Hola', hello: 'Hola, {{nombre}}', files_one: 'un archivo' }),
            'pt-BR/common.json': '{ "hello": ',
        });
        const run = build(dir);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("es-419/common: hola isn't in en-US");
        expect(run.stderr).toContain('es-419/common: hello interpolates {nombre}, en-US {name}');
        expect(run.stderr).toContain('es-419/common: files lacks the es-419 plural form(s) many, other');
        expect(run.stderr).toMatch(/pt-BR\/common\.json: not valid JSON/);
        expect(() => readdirSync(join(dir, 'out'))).toThrow();
    });

    it('checks without writing', () => {
        const dir = setup({ 'en-US/common.json': EN });
        const run = build(dir, '--check');
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toContain('check out');
        expect(() => readdirSync(join(dir, 'out'))).toThrow();
    });

    it('writes hashed files, en-XA and the manifest, and only what the locales hold', () => {
        const big = Object.fromEntries(
            Array.from({ length: 80 }, (_, i) => [`line${i}`, `Line number ${i} of the text`]),
        );
        const dir = setup({
            'en-US/common.json': EN,
            'en-US/settings.language.json': JSON.stringify(big),
            'es-419/common.json': JSON.stringify({
                hello: 'Hola, {{name}}',
                files_one: '{{count}} archivo',
                files_many: '{{count}} de archivos',
                files_other: '{{count}} archivos',
            }),
        });
        const run = build(dir);
        expect(run.status, run.stderr).toBe(0);
        const manifest = JSON.parse(readFileSync(join(dir, 'out/manifest.json'), 'utf8'));
        expect(manifest.release).toBe(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
        expect(Object.keys(manifest.locales)).toEqual(['en-US', 'es-419', 'es-US', 'pt-BR', 'en-XA']);
        // es-US has no file, so falls through to es-419: 2 of en-US's 82 strings.
        expect(manifest.locales['es-US']).toEqual({ coverage: 0.0244, ns: {} });
        // Every file is a namespace the manifest names, or its compressed copy.
        const expected = new Set(['manifest.json']);
        for (const [locale, entry] of Object.entries<{ ns: Record<string, { hash: string }> }>(manifest.locales)) {
            for (const [ns, { hash }] of Object.entries(entry.ns)) {
                const file = `${locale}/${ns}.${hash}.json`;
                expected.add(file);
                const body = readFileSync(join(dir, 'out', file), 'utf8');
                expect(JSON.parse(body)).toBeTypeOf('object');
                if (body.length >= 1024) {
                    expected.add(`${file}.gz`).add(`${file}.br`);
                    expect(gunzipSync(readFileSync(join(dir, 'out', `${file}.gz`))).toString()).toBe(body);
                }
            }
        }
        expect(new Set(walk(join(dir, 'out')).map((file) => relative(join(dir, 'out'), file)))).toEqual(expected);
        // en-XA is generated, with en-US's keys.
        const xa = JSON.parse(
            readFileSync(join(dir, 'out/en-XA', `common.${manifest.locales['en-XA'].ns.common.hash}.json`), 'utf8'),
        );
        expect(xa.hello).toMatch(/^\[Ĥéļļö, \{\{name\}\} ~+\]$/);
        expect(run.stdout).toMatch(/en-US by namespace, gzipped: common [\d.]+ kB, settings\.language [\d.]+ kB/);
    });

    it('warns when a route’s inlined dictionaries are over the budget, and fails on an unknown namespace', () => {
        // Random words compress badly: about 20 kB gzipped.
        let seed = 7;
        const word = () =>
            Array.from({ length: 8 }, () => {
                seed = (seed * 1103515245 + 12345) % 2147483648;
                return String.fromCharCode(97 + (seed % 26));
            }).join('');
        const big = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, `${word()} ${word()}`]));
        const dir = setup(
            { 'en-US/common.json': EN, 'en-US/chat.json': JSON.stringify(big) },
            { root: ['common'], chat: ['chat'] },
        );
        const run = build(dir, '--check');
        expect(run.status, run.stderr).toBe(0);
        expect(run.stderr).toMatch(
            /warning: Route chat inlines [\d.]+ kB of en-US dictionaries gzipped, over the 8\.0 kB budget/,
        );
        expect(run.stderr).not.toContain('Route root');

        writeFileSync(join(dir, 'routes.json'), JSON.stringify({ root: ['common', 'missing'] }));
        const unknown = build(dir, '--check');
        expect(unknown.status).toBe(1);
        expect(unknown.stderr).toContain("route root inlines missing, which en-US doesn't have");
    });

    it('needs a label and where it appears for every namespace, and nothing else, in plain text on one line', () => {
        const where = 'The box at the bottom of a conversation.';
        const dir = setup(
            { 'en-US/common.json': EN, 'en-US/chat.json': EN, 'en-US/shell.json': EN, 'en-US/pages.json': EN },
            undefined,
            {
                common: { label: 'Common words', where },
                chat: { label: 'L'.repeat(81), where: 'W'.repeat(301) },
                shell: { label: 'Shell · {{name}}', where: 'The <b>header</b>.' },
                pages: { label: ' ', where: 'Two\nlines.', screenshot: 'x' },
                gone: { label: 'Gone', where },
            },
        );
        const run = build(dir, '--check');
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('namespaces.json: chat.label is 81 characters, over the 80 limit');
        expect(run.stderr).toContain('namespaces.json: chat.where is 301 characters, over the 300 limit');
        expect(run.stderr).toContain('namespaces.json: shell.label has a {{ placeholder');
        expect(run.stderr).toContain("namespaces.json: shell.where has < or >; it's plain text, with no HTML");
        expect(run.stderr).toContain('namespaces.json: pages.label needs text (a non-empty string)');
        expect(run.stderr).toContain('namespaces.json: pages.where must be a single line');
        expect(run.stderr).toContain('namespaces.json: pages has an unknown field screenshot');
        expect(run.stderr).toContain('namespaces.json: en-US has no namespace gone');
        expect(run.stderr).not.toContain('common');

        writeFileSync(join(dir, 'namespaces.json'), JSON.stringify({ common: { label: 'Common words', where } }));
        const missing = build(dir, '--check');
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain(
            'namespaces.json: en-US namespace chat needs an entry with a label and where it appears',
        );
        expect(missing.stderr).toContain('namespaces.json: en-US namespace pages needs an entry');

        rmSync(join(dir, 'namespaces.json'));
        const none = build(dir, '--check');
        expect(none.status).toBe(1);
        expect(none.stderr).toContain('namespaces.json: missing');

        writeFileSync(join(dir, 'namespaces.json'), '{ "common": ');
        expect(build(dir, '--check').stderr).toMatch(/namespaces\.json: not valid JSON/);
    });

    it('checks the repository’s own dictionaries', () => {
        const run = spawnSync(
            process.execPath,
            ['--import', 'tsx', 'scripts/i18n-build.mjs', '--check', '--routes', join(setup({}), 'routes.json')],
            { cwd: root, encoding: 'utf8' },
        );
        expect(run.status, run.stderr).toBe(0);
    });
});
