import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, it } from 'vitest';

// A cache of Intl formatters must never hand one request's locale to the
// next (the server renders pages in many locales, docs/I18N.md). Formatters
// from @socio/shared/locale follow the active locale at each call; a Map of
// `new Intl.*` instances must key on the locale, or be fixed to en-US on
// purpose (parsing dates into parts, never display text). Each such cache is
// listed here with why it is safe: a new one fails until it is.
const root = join(import.meta.dirname, '../..');
const DIRS = [
    'packages/client/src',
    'packages/shared/src',
    'packages/plugin-ui/src',
    'packages/i18n/src',
    'src/server',
];

const SAFE: Record<string, string> = {
    'packages/client/src/modules/operations/format.ts': 'keyed by activeLocale(), zone and shape',
    'packages/shared/src/dataset-views/format.ts': 'keyed by the locale it is given',
    'packages/shared/src/calendar.ts': 'en-US, to read a zoned date into parts',
    'packages/shared/src/operations/operations.ts': 'en-US, to read a zoned date into parts',
    'src/server/schedules/cadence.ts': 'en-US, to read a zoned date into parts',
    'packages/shared/src/locale.ts': 'one instance per locale (perLocale)',
};

const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });

it('lists every cache of Intl formatters, each keyed by locale or fixed to en-US', () => {
    const found = DIRS.flatMap((dir) => files(join(root, dir)))
        .filter((file) => /new (?:Weak)?Map<[^>]*Intl\.|perLocale\(/.test(readFileSync(file, 'utf8')))
        .map((file) => relative(root, file).replaceAll('\\', '/'))
        .sort();
    expect(found).toEqual(Object.keys(SAFE).sort());
});

it('keys the display cache by locale', () => {
    const text = readFileSync(join(root, 'packages/client/src/modules/operations/format.ts'), 'utf8');
    expect(text).toMatch(/const key = `\$\{locale\} /);
});
