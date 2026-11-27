import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { flatten, pluralForm } from '@socio/i18n/keys';
import { useTranslation } from '@socio/i18n/react';
import ROUTES from '@socio/i18n/route-namespaces.json';

// Every `t('ns:key')` the client writes names an en-US key, and the typed
// keys (src/i18n/i18next.d.ts, over packages/i18n/src/resources.gen.ts) cover
// every en-US namespace, so tsc checks
// each call's key and variables (docs/I18N.md).
const client = join(import.meta.dirname, '..');
const locales = join(client, '../i18n/locales/en-US');

const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
    });

const english = new Map(
    readdirSync(locales).map((file) => [
        file.slice(0, -'.json'.length),
        flatten(JSON.parse(readFileSync(join(locales, file), 'utf8'))),
    ]),
);

/** A key i18next resolves: as written, a plural's base, or a context's (`title` for `title_admin`). */
const known = (ns: string, key: string) => {
    const keys = english.get(ns);
    return (
        !!keys &&
        (keys.has(key) || [...keys.keys()].some((name) => pluralForm(name)?.base === key || name.startsWith(`${key}_`)))
    );
};

it('names only en-US keys in t() calls', () => {
    const calls: string[] = [];
    const unknown: string[] = [];
    for (const file of sources(join(client, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/\bt\(\s*['"`]([a-z][a-z0-9.-]*):([^'"`$]+)['"`]/g)) {
            calls.push(`${match[1]}:${match[2]}`);
            if (!known(match[1]!, match[2]!)) {
                unknown.push(`${file.slice(client.length + 1)}: ${match[1]}:${match[2]}`);
            }
        }
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(unknown).toEqual([]);
});

it('types every en-US namespace', () => {
    const generated = readFileSync(join(client, '../i18n/src/resources.gen.ts'), 'utf8');
    for (const ns of english.keys()) {
        expect(generated, ns).toMatch(new RegExp(`^    '?${ns.replace('.', '\\.')}'?: \\{$`, 'm'));
    }
    expect(readFileSync(join(client, 'src/i18n/i18next.d.ts'), 'utf8')).toContain('resources: EnglishResources;');
});

it('inlines only namespaces en-US has', () => {
    for (const [route, namespaces] of Object.entries(ROUTES)) {
        if (route.startsWith('$')) {
            continue;
        }
        for (const ns of namespaces as string[]) {
            expect(english.has(ns), `${route}: ${ns}`).toBe(true);
        }
    }
});

/** Never called: tsc checks these lines (pnpm run check). */
export function useTypedKeys() {
    const { t } = useTranslation(['settings.language']);
    // @ts-expect-error: not a key of settings.language.
    t('settings.language:nope');
    // @ts-expect-error: `language` is required by the string.
    t('settings.language:saved');
    // @ts-expect-error: another variable than the string's.
    t('settings.language:saved', { lang: 'es' });
    return t('settings.language:saved', { language: 'español' });
}
