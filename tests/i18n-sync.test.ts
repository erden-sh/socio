import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    aliasForBody,
    applyLocale,
    checkCandidate,
    importPayload,
    keyPath,
    pullRequestStates,
    sparseParent,
    type ExportBody,
    type ExportCandidate,
} from '../scripts/i18n-sync.mjs';

// scripts/i18n-sync.mjs: the import's body and the export's files, for the i18n-import and
// i18n-export workflows (docs/I18N.md). Files only; the workflows make the requests.
const root = join(import.meta.dirname, '..');
const scratch: string[] = [];
afterEach(() => {
    for (const dir of scratch.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function setup(files: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'socio-i18n-sync-'));
    scratch.push(dir);
    for (const [path, json] of Object.entries(files)) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), `${JSON.stringify(json, null, 4)}\n`);
    }
    return dir;
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

let next = 0;
const id = () => `k_${String(next++).padStart(26, '0')}`;
const candidate = (fields: Partial<ExportCandidate> & Pick<ExportCandidate, 'ns' | 'key'>): ExportCandidate => ({
    id: id(),
    values: null,
    author: 'Ana',
    origin: 'contributor',
    selfApproved: false,
    inherit: false,
    ...fields,
});
const exportOf = (locale: string, candidates: ExportCandidate[]): ExportBody => ({
    commit: 'abcdef1234567',
    generatedAt: Date.UTC(2026, 10, 26, 12),
    locales: { [locale]: { parent: null, candidates, contributors: [] } },
});

describe('the import', () => {
    it('sends en-US, the translations, the context notes and the glossary, and hashes all but the commit', () => {
        const dir = setup({
            'locales/en-US/common.json': { a: 'Hello' },
            'locales/es-419/common.json': { a: 'Hola' },
            'context/common.json': { a: 'A greeting on the home page' },
            'glossary/es-419.json': [{ term: 'workspace', translation: 'espacio de trabajo' }],
            'glossary/xx-YY.json': [{ term: 'not a locale' }],
        });
        mkdirSync(join(dir, 'locales/en-XA'));
        const pullRequests = [{ number: 7, state: 'closed' as const }];
        const first = importPayload({
            commit: 'abcdef1',
            localesDir: join(dir, 'locales'),
            i18nDir: dir,
            pullRequests,
        });
        expect(first.body).toEqual({
            commit: 'abcdef1',
            locales: { 'en-US': { common: { a: 'Hello' } }, 'es-419': { common: { a: 'Hola' } } },
            context: { common: { a: 'A greeting on the home page' } },
            glossary: { 'es-419': [{ term: 'workspace', translation: 'espacio de trabajo' }] },
            pullRequests,
        });
        const again = importPayload({
            commit: '1234567',
            localesDir: join(dir, 'locales'),
            i18nDir: dir,
            pullRequests,
        });
        expect(again.hash).toBe(first.hash);
        const merged = importPayload({
            commit: '1234567',
            localesDir: join(dir, 'locales'),
            i18nDir: dir,
            pullRequests: [{ number: 7, state: 'merged' }],
        });
        expect(merged.hash).not.toBe(first.hash);
        expect(() => importPayload({ commit: 'main', localesDir: join(dir, 'locales'), i18nDir: dir })).toThrow(
            /commit/,
        );
    });

    it("keeps only the i18n/ pull requests' states", () => {
        expect(
            pullRequestStates([
                { number: 12, state: 'MERGED', headRefName: 'i18n/es-419-2026-11-25' },
                { number: 9, state: 'CLOSED', headRefName: 'i18n/pt-BR-2026-11-20' },
                { number: 10, state: 'OPEN', headRefName: 'feat/other' },
                { number: 'x', state: 'OPEN', headRefName: 'i18n/x' },
            ]),
        ).toEqual([
            { number: 9, state: 'closed' },
            { number: 12, state: 'merged' },
        ]);
    });

    it('writes the body and prints the hash from the command line', () => {
        const dir = setup({ 'locales/en-US/common.json': { a: 'Hello' }, 'prs.json': [] });
        const out = join(dir, 'payload.json');
        const result = spawnSync(
            process.execPath,
            [
                'scripts/i18n-sync.mjs',
                'payload',
                '--commit',
                'abcdef1',
                '--locales',
                join(dir, 'locales'),
                '--pull-requests',
                join(dir, 'prs.json'),
                '--out',
                out,
            ],
            { cwd: root, encoding: 'utf8' },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
        expect(readJson(out).locales).toEqual({ 'en-US': { common: { a: 'Hello' } } });
    });
});

describe('the export', () => {
    it('lays keys out as en-US does', () => {
        const english = {
            title: 'T',
            errors: { offline: 'O', 'very.dotted': 'D' },
            'flat.key': 'F',
            files_one: '1',
            files_other: 'n',
            list: { rank_ordinal_other: 'x' },
        };
        expect(keyPath(english, 'title')).toEqual(['title']);
        expect(keyPath(english, 'errors.offline')).toEqual(['errors', 'offline']);
        expect(keyPath(english, 'errors.very.dotted')).toEqual(['errors', 'very.dotted']);
        expect(keyPath(english, 'flat.key')).toEqual(['flat.key']);
        expect(keyPath(english, 'files_many')).toEqual(['files_many']);
        expect(keyPath(english, 'list.rank_ordinal_few')).toEqual(['list', 'rank_ordinal_few']);
        expect(keyPath(english, 'unknown.key')).toEqual(['unknown.key']);
    });

    it("writes a locale's candidates, plural forms as a whole, in en-US's order", () => {
        const dir = setup({
            'en-US/common.json': {
                title: 'Title',
                errors: { offline: 'Offline', retry: 'Retry' },
                files_one: 'One file',
                files_other: '{{count}} files',
            },
            'es-419/common.json': { files_one: 'old', files_few: 'stale', title: 'Viejo' },
        });
        const self = candidate({
            ns: 'common',
            key: 'errors.offline',
            values: { 'errors.offline': 'Sin conexión' },
            selfApproved: true,
            author: 'Bo',
        });
        const result = applyLocale({
            exported: exportOf('es-419', [
                self,
                candidate({
                    ns: 'common',
                    key: 'files',
                    values: {
                        files_one: 'Un archivo',
                        files_many: '{{count}} de archivos',
                        files_other: '{{count}} archivos',
                    },
                }),
                candidate({ ns: 'common', key: 'title', values: { title: 'Título' } }),
                candidate({ ns: 'common', key: 'machine', values: { machine: 'x' }, origin: 'machine' }),
            ]),
            locale: 'es-419',
            localesDir: dir,
        });
        const text = readFileSync(join(dir, 'es-419/common.json'), 'utf8');
        expect(JSON.parse(text)).toEqual({
            title: 'Título',
            errors: { offline: 'Sin conexión' },
            files_one: 'Un archivo',
            files_many: '{{count}} de archivos',
            files_other: '{{count}} archivos',
            machine: 'x',
        });
        expect(Object.keys(JSON.parse(text))).toEqual([
            'title',
            'errors',
            'files_one',
            'files_many',
            'files_other',
            'machine',
        ]);
        expect(text.endsWith('}\n')).toBe(true);
        expect(text).toContain('\n    "title": "Título",\n');
        expect(result.ids).toHaveLength(4);
        expect(result.body).toContain('Translations by: `Bo`, `Ana`');
        expect(result.body).toContain('Machine drafts, reviewed in the app: 1');
        expect(result.body).toContain('- `common:errors.offline` (self-approved)');
        expect(result.body).toContain('`abcdef123456`');
    });

    it('keeps a locale sparse over the translated locale it falls back to', () => {
        expect(sparseParent('es-US')).toBe('es-419');
        expect(sparseParent('es-419')).toBeNull();
        const dir = setup({
            'en-US/common.json': { car: 'Car', truck: 'Truck', bus: 'Bus' },
            'es-419/common.json': { car: 'Auto', truck: 'Camión', bus: 'Autobús' },
            'es-US/common.json': { car: 'Carro', bus: 'Bus' },
        });
        const result = applyLocale({
            exported: exportOf('es-US', [
                candidate({ ns: 'common', key: 'truck', values: { truck: 'Troca' } }),
                // The same as es-419's: left out, so it inherits.
                candidate({ ns: 'common', key: 'car', values: { car: 'Auto' } }),
                // "Same as es-419": the override goes.
                candidate({ ns: 'common', key: 'bus', inherit: true }),
            ]),
            locale: 'es-US',
            localesDir: dir,
        });
        expect(readJson(join(dir, 'es-US/common.json'))).toEqual({ truck: 'Troca' });
        expect(result.ids).toHaveLength(3);
        expect(result.body).toContain('`common:bus` (back to the fallback)');
    });

    it('removes a file left empty, and writes nothing when nothing changes', () => {
        const dir = setup({ 'en-US/common.json': { a: 'A' }, 'es-US/common.json': { a: 'x' } });
        applyLocale({
            exported: exportOf('es-US', [candidate({ ns: 'common', key: 'a', inherit: true })]),
            locale: 'es-US',
            localesDir: dir,
        });
        expect(existsSync(join(dir, 'es-US/common.json'))).toBe(false);
        const again = applyLocale({
            exported: exportOf('es-US', [candidate({ ns: 'common', key: 'a', inherit: true })]),
            locale: 'es-US',
            localesDir: dir,
        });
        expect(again.changed).toEqual([]);
    });

    it("skips what it can't write, and leaves those candidates out of the ack", () => {
        const dir = setup({ 'en-US/common.json': { a: 'A' } });
        const result = applyLocale({
            exported: exportOf('pt-BR', [
                candidate({ ns: 'missing', key: 'a', values: { a: 'x' } }),
                candidate({ ns: 'common', key: 'a', values: { b: 'not this key' } }),
                candidate({ ns: '../etc', key: 'a', values: { a: 'x' } }),
                { ...candidate({ ns: 'common', key: 'a', values: { a: 'x' } }), id: 'not-an-id' },
                candidate({ ns: 'common', key: 'a', values: { a: 'Á' } }),
            ]),
            locale: 'pt-BR',
            localesDir: dir,
        });
        expect(result.ids).toHaveLength(1);
        expect(result.skipped.map((item) => item.why)).toEqual([
            'en-US has no namespace missing',
            'bad value for b',
            'not a namespace and key',
            'not a candidate',
        ]);
        expect(readJson(join(dir, 'pt-BR/common.json'))).toEqual({ a: 'Á' });
        expect(() => applyLocale({ exported: exportOf('en-US', []), locale: 'en-US', localesDir: dir })).toThrow(
            /not a locale/,
        );
        expect(() => applyLocale({ exported: exportOf('en-XA', []), locale: 'en-XA', localesDir: dir })).toThrow(
            /not a locale/,
        );
        expect(() => applyLocale({ exported: exportOf('../x', []), locale: '../x', localesDir: dir })).toThrow(
            /not a locale/,
        );
    });

    it('checks values and credits by alias only, with nothing that mentions or links', () => {
        expect(checkCandidate(candidate({ ns: 'common', key: 'a', values: { a: '   ' } }))).toBe('bad value for a');
        expect(checkCandidate(candidate({ ns: 'common', key: 'a', values: {} }))).toBe('no values');
        expect(aliasForBody('@octocat')).toBe('`@octocat`');
        expect(aliasForBody('a`b' + String.fromCharCode(0x202e) + '[x](https://example.org)')).toBe(
            '`ab[x](https://example.org)`',
        );
        expect(aliasForBody('')).toBe('`former contributor`');
        expect(aliasForBody('x'.repeat(100))).toBe(`\`${'x'.repeat(40)}\``);
    });

    it('lists the locales with candidates, and applies one, from the command line', () => {
        const dir = setup({
            'locales/en-US/common.json': { a: 'A' },
            'export.json': {
                commit: 'abcdef1',
                generatedAt: 0,
                locales: {
                    'es-419': {
                        parent: null,
                        candidates: [candidate({ ns: 'common', key: 'a', values: { a: 'Á' } })],
                        contributors: ['Ana'],
                    },
                    'pt-BR': { parent: null, candidates: [], contributors: [] },
                    'zz-ZZ': {
                        parent: null,
                        candidates: [candidate({ ns: 'common', key: 'a', values: { a: 'x' } })],
                        contributors: [],
                    },
                },
            },
        });
        const run = (...args: string[]) =>
            spawnSync(process.execPath, ['scripts/i18n-sync.mjs', ...args, '--locales', join(dir, 'locales')], {
                cwd: root,
                encoding: 'utf8',
            });
        const listed = run('locales', '--export', join(dir, 'export.json'));
        expect(listed.status, listed.stderr).toBe(0);
        expect(listed.stdout).toBe('es-419\n');
        expect(listed.stderr).toContain('skipping "zz-ZZ"');
        const applied = run(
            'apply',
            '--export',
            join(dir, 'export.json'),
            '--locale',
            'es-419',
            '--body',
            join(dir, 'body.md'),
            '--ids',
            join(dir, 'ids.json'),
        );
        expect(applied.status, applied.stderr).toBe(0);
        expect(readJson(join(dir, 'ids.json'))).toHaveLength(1);
        expect(readFileSync(join(dir, 'body.md'), 'utf8')).toContain('Translations by: `Ana`');
        expect(readJson(join(dir, 'locales/es-419/common.json'))).toEqual({ a: 'Á' });
    });
});
