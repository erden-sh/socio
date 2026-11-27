import { describe, expect, it } from 'vitest';

import { buildCatalog, CatalogError, type Sources } from '../src/catalog.js';
import { sourceHash } from '../src/keys.js';
import {
    acceptsServerNamespace,
    availableLocales,
    languageSettingVisible,
    narrowManifest,
    offeredLocales,
    type I18nManifest,
} from '../src/manifest.js';
import { pseudoText } from '../src/pseudo.js';

const EN = {
    common: {
        product: 'Socio',
        greeting: 'Hello, {{name}}',
        files_one: '{{count}} file',
        files_other: '{{count}} files',
        nested: { title: 'Title', body: 'Body' },
    },
    'settings.language': { title: 'Language' },
};

const problems = (sources: Sources) => {
    try {
        buildCatalog(sources, '1.0.0');
        return [];
    } catch (error) {
        expect(error).toBeInstanceOf(CatalogError);
        return [...(error as CatalogError).problems];
    }
};

describe('the build’s checks', () => {
    it('passes the source and a complete translation', () => {
        expect(
            problems({
                'en-US': EN,
                'es-419': {
                    common: {
                        product: 'Socio',
                        greeting: 'Hola, {{name}}',
                        files_one: '{{count}} archivo',
                        files_many: '{{count}} de archivos',
                        files_other: '{{count}} archivos',
                        nested: { title: 'Título' },
                    },
                },
            }),
        ).toEqual([]);
    });

    it('fails a key en-US lacks, a changed variable, an incomplete plural, an empty string', () => {
        expect(
            problems({
                'en-US': EN,
                'es-419': {
                    common: {
                        greting: 'Hola',
                        greeting: 'Hola, {{nombre}}',
                        files_one: '{{count}} archivo',
                        files_other: '{{count}} archivos',
                        product: ' ',
                    },
                },
                'pt-BR': { common: { files_one: '{{count}} arquivo', files_other: '{{count}} {{size}}' } },
            }),
        ).toEqual([
            'es-419/common: greting isn’t in en-US'.replace('’', "'"),
            'es-419/common: greeting interpolates {nombre}, en-US {name}',
            'es-419/common: product is empty (leave a key out to fall back)',
            'es-419/common: files lacks the es-419 plural form(s) many',
            'pt-BR/common: files_other uses size, which en-US’s files doesn’t pass'.replaceAll('’', "'"),
            'pt-BR/common: files lacks the pt-BR plural form(s) many',
        ]);
    });

    it('fails an unregistered locale, a namespace en-US lacks, a bad name, en-XA files, an incomplete en-US plural', () => {
        expect(
            problems({
                'en-US': { ...EN, Bad_Name: { a: 'A' }, plural: { things_one: 'one thing' } },
                'fr-FR': { common: {} },
                'es-419': { chat: { a: 'b' } },
                'en-XA': { common: {} },
            }),
        ).toEqual([
            'en-US/Bad_Name: not a namespace name (lower case, dotted: settings.language)',
            'fr-FR: not a registered locale (packages/i18n/src/registry.ts)',
            'es-419/chat: en-US has no such namespace',
            'en-XA: generated from en-US, so it has no files',
            'en-US/plural: things lacks the en-US plural form(s) other',
        ]);
    });

    it('fails what isn’t a string', () => {
        expect(problems({ 'en-US': { common: { list: ['a'] } as never } })).toEqual([
            'en-US/common: list must be a string or an object of strings.',
        ]);
    });
});

describe('coverage, through the fallback chain', () => {
    it('counts a sparse es-US over es-419, and keeps its file sparse', () => {
        const { manifest, files } = buildCatalog(
            {
                'en-US': EN,
                'es-419': {
                    common: {
                        product: 'Socio',
                        greeting: 'Hola, {{name}}',
                        nested: { title: 'Título', body: 'Cuerpo' },
                    },
                },
                // Only what differs in the US.
                'es-US': {
                    common: {
                        files_one: '{{count}} archivo',
                        files_many: '{{count}} de archivos',
                        files_other: '{{count}} archivos',
                    },
                },
            },
            '1.0.0',
        );
        // en-US has 6 units: product, greeting, files (one plural), nested.title, nested.body, title.
        expect(manifest.locales['es-419']!.coverage).toBe(Math.round((4 / 6) * 10000) / 10000);
        expect(manifest.locales['es-US']!.coverage).toBe(Math.round((5 / 6) * 10000) / 10000);
        expect(manifest.locales['pt-BR']).toEqual({ coverage: 0, ns: {} });
        expect(manifest.locales['en-US']!.coverage).toBe(1);
        expect(manifest.locales['en-XA']!.coverage).toBe(1);
        const esUs = files.find((file) => file.locale === 'es-US')!;
        expect(Object.keys(JSON.parse(esUs.text))).toEqual(['files_one', 'files_many', 'files_other']);
        expect(Object.keys(manifest.locales['es-US']!.ns)).toEqual(['common']);
    });

    it('names files by content and keeps the source hash per namespace', () => {
        const a = buildCatalog({ 'en-US': EN }, '1.0.0');
        const b = buildCatalog({ 'en-US': { ...EN, common: { ...EN.common, product: 'Socio!' } } }, '1.0.0');
        const entry = (catalog: typeof a) => catalog.manifest.locales['en-US']!.ns.common!;
        expect(entry(a).hash).toMatch(/^[0-9a-f]{12}$/);
        expect(entry(a).hash).not.toBe(entry(b).hash);
        // The wording changed, not the keys or variables.
        expect(entry(a).sourceHash).toBe(entry(b).sourceHash);
        expect(a.manifest.locales['en-XA']!.ns.common!.sourceHash).toBe(entry(a).sourceHash);
    });
});

describe('sourceHash', () => {
    it('changes with a key, a suffix or a variable, not with wording or order', () => {
        const base = sourceHash({ a: 'A {{x}}', b_one: 'one', b_other: 'many' });
        expect(sourceHash({ b_other: 'lots', a: 'Other {{x}}', b_one: 'uno' })).toBe(base);
        expect(sourceHash({ a: 'A {{y}}', b_one: 'one', b_other: 'many' })).not.toBe(base);
        expect(sourceHash({ a: 'A {{x}}', b_one: 'one', b_many: 'm', b_other: 'many' })).not.toBe(base);
        expect(sourceHash({ a: 'A {{x}}', a_socio: 'S', b_one: 'one', b_other: 'many' })).not.toBe(base);
        expect(base).toMatch(/^[0-9a-f]{12}$/);
    });

    it('decides whether a client takes the server’s copy', () => {
        expect(acceptsServerNamespace({ hash: 'aaa', sourceHash: 'sss' }, 'sss')).toBe(true);
        expect(acceptsServerNamespace({ hash: 'aaa', sourceHash: 'ttt' }, 'sss')).toBe(false);
        expect(acceptsServerNamespace(undefined, 'sss')).toBe(false);
    });
});

describe('the manifest’s gate', () => {
    const fixture = (coverage: Record<string, number>): I18nManifest => ({
        release: '1.0.0',
        locales: Object.fromEntries(
            Object.entries(coverage).map(([locale, share]) => [locale, { coverage: share, ns: {} }]),
        ),
    });

    it('hides Settings › Language with en-US alone (pseudo and thin locales don’t count)', () => {
        const today = fixture({ 'en-US': 1, 'es-419': 0, 'es-US': 0, 'pt-BR': 0, 'en-XA': 1 });
        expect(offeredLocales(today)).toEqual(['en-US']);
        expect(languageSettingVisible(today)).toBe(false);
        expect(languageSettingVisible(fixture({ 'en-US': 1, 'es-419': 0.9 }))).toBe(false);
        expect(languageSettingVisible(undefined)).toBe(false);
    });

    it('shows it once a second locale passes the gate', () => {
        const later = fixture({ 'en-US': 1, 'es-419': 0.97, 'es-US': 0.97, 'pt-BR': 0.2, 'en-XA': 1 });
        expect(offeredLocales(later)).toEqual(['en-US', 'es-419', 'es-US']);
        expect(languageSettingVisible(later)).toBe(true);
        // What a request may resolve to: any locale with strings.
        expect(availableLocales(later)).toEqual(['en-US', 'es-419', 'es-US', 'pt-BR', 'en-XA']);
    });

    it('narrows to a locale and its chain', () => {
        const all = fixture({ 'en-US': 1, 'es-419': 1, 'es-US': 1, 'pt-BR': 1 });
        expect(Object.keys(narrowManifest(all, ['es-US']).locales)).toEqual(['en-US', 'es-419', 'es-US']);
        expect(narrowManifest(all, undefined)).toBe(all);
    });
});

describe('en-XA', () => {
    it('accents and lengthens text, keeping variables, nesting and tags', () => {
        expect(pseudoText('Hello {{name}}, see <0>$t(common:product)</0>')).toBe(
            '[Ĥéļļö {{name}}, šéé <0>$t(common:product)</0> ~~~]',
        );
    });
});
