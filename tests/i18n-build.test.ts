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

// A context note on every en-US key, as notes/<ns>.json needs.
const notesFor = (files: Record<string, string>) =>
    Object.fromEntries(
        Object.entries(files)
            .filter(([path]) => path.startsWith('en-US/'))
            .map(([path, text]) => [
                path.slice('en-US/'.length, -'.json'.length),
                Object.fromEntries(Object.keys(JSON.parse(text)).map((key) => [key, 'A note for translators.'])),
            ]),
    );

function setup(
    files: Record<string, string>,
    routes: Record<string, string[]> = { root: ['common'] },
    namespaces: unknown = entriesFor(files),
    notes: Record<string, unknown> = notesFor(files),
) {
    const dir = mkdtempSync(join(tmpdir(), 'socio-i18n-'));
    scratch.push(dir);
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(dir, 'locales', path, '..'), { recursive: true });
        writeFileSync(join(dir, 'locales', path), text);
    }
    mkdirSync(join(dir, 'notes'));
    for (const [ns, entries] of Object.entries(notes)) {
        writeFileSync(join(dir, 'notes', `${ns}.json`), JSON.stringify(entries));
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
            {
                'en-US/common.json': EN,
                'en-US/chat.json': EN,
                'en-US/shell.json': EN,
                'en-US/pages.json': EN,
                'en-US/rooms.json': EN,
                'en-US/spaces.json': EN,
            },
            undefined,
            {
                common: { label: 'Common words', where },
                chat: { label: 'L'.repeat(81), where: 'W'.repeat(301) },
                shell: { label: 'Shell · {{name}}', where: 'The <b>header</b>.' },
                rooms: { label: 'Rooms &amp; chats', where: 'A room\u202e, reversed.' },
                spaces: {
                    label: 'Spaces & pages',
                    where: `Shown when fewer than 5 < 6 items remain ${'é'.repeat(250)}`,
                },
                pages: { label: ' ', where: 'Two\nlines.', screenshot: 'x' },
                gone: { label: 'Gone', where },
            },
        );
        const run = build(dir, '--check');
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('namespaces.json: chat.label is 81 characters, over the 80 limit');
        expect(run.stderr).toContain('namespaces.json: chat.where is 301 characters, over the 300 limit');
        expect(run.stderr).toContain('namespaces.json: shell.label has a {{ placeholder');
        expect(run.stderr).toContain("namespaces.json: shell.where has an HTML-like tag; it's plain text");
        expect(run.stderr).toContain('namespaces.json: rooms.label has an HTML entity');
        expect(run.stderr).toContain('namespaces.json: rooms.where has a bidi override or isolate character');
        // A lone & or < is prose, and the limit counts code points.
        expect(run.stderr).not.toContain('namespaces.json: spaces');
        expect(run.stderr).toContain('namespaces.json: pages.label needs text (a non-empty string)');
        expect(run.stderr).toContain('namespaces.json: pages.where must be a single line');
        expect(run.stderr).toContain('namespaces.json: pages has an unknown field screenshot');
        expect(run.stderr).toContain('namespaces.json: en-US has no namespace gone');
        expect(run.stderr).not.toContain('namespaces.json: common');

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

    it('needs a context note on every en-US key, its own or its plural’s or context’s base’s', () => {
        const english = {
            title: 'Title',
            nested: { label: 'Label', hint: 'Hint' },
            files_one: '{{count}} file',
            files_other: '{{count}} files',
            edited_socio: 'Edited by a socio',
            edited_person: 'Edited by {{name}}',
            replies_socio_one: '{{count}} reply from a socio',
            replies_socio_other: '{{count}} replies from a socio',
            rank_ordinal_one: '{{count}}st',
            rank_ordinal_two: '{{count}}nd',
            rank_ordinal_few: '{{count}}rd',
            rank_ordinal_other: '{{count}}th',
            hint_external: 'External',
            status: { long_wait: 'Waiting a long time' },
        };
        const files = { 'en-US/common.json': JSON.stringify(english), 'en-US/chat.json': EN };
        const covered = {
            title: 'Heading.',
            'nested.label': 'Field label.',
            'nested.hint': 'Hint under the field.',
            files: 'How many files.',
            edited: 'Who last edited it.',
            replies: 'How many replies.',
            rank: 'A place in a list.',
            hint: 'A hint.',
            'status.long': 'A status.',
        };
        const ok = build(
            setup(files, undefined, undefined, { common: covered, chat: notesFor(files).chat }),
            '--check',
        );
        expect(ok.status, ok.stderr).toBe(0);

        // A plural's own base or a context's base covers its forms; nothing covers a key with neither.
        const partial = {
            'nested.label': 'Field label.',
            edited: 'Who last edited it.',
            replies_socio: 'How many replies from a socio.',
            rank: 'A place in a list.',
            hint: 'A hint.',
            'status.long': 'A status.',
        };
        const run = build(setup(files, undefined, undefined, { common: partial }), '--check');
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(
            'notes/common.json: 4 en-US key(s) need a context note for translators, on the key or its plural or context base (docs/I18N.md): title, nested.hint, files_one, files_other',
        );
        // chat.json has no notes file at all, so all its keys are listed.
        expect(run.stderr).toContain('notes/chat.json: 3 en-US key(s) need a context note');
        expect(run.stderr).toContain('hello, files_one, files_other');
    });

    it('reports a notes file that isn’t JSON once, not as every key it lacks', () => {
        const dir = setup({ 'en-US/common.json': EN }, undefined, undefined, {});
        writeFileSync(join(dir, 'notes', 'common.json'), '{ "hello": ');
        const run = build(dir, '--check');
        expect(run.status).toBe(1);
        expect(run.stderr).toMatch(/notes\/common\.json: not valid JSON/);
        expect(run.stderr).not.toContain('need a context note');
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
