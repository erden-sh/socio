import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The root lint config's rules for the app (.oxlintrc.json), run by the root's
// oxlint on files placed where the overrides look, in a scratch copy of the
// config and its plugin:
// - socio/hermes, in the app and in packages/shared/src, whose source the app
//   bundles (scripts/lint/socio-rules.mjs; the cases are T3 Code's for its rule),
//   on the global APIs only: an import, parameter or declaration of the same name
//   in scope is another implementation, unless it emits nothing (`declare`,
//   `import type`) or is a copy taken from the global;
// - in apps/mobile/src, no bare fetch and no expo/fetch outside src/platform/fetch.ts,
//   though a type may come from expo/fetch;
// - in apps/mobile, no Effect import, src/platform/fetch.ts included (its override
//   restates the ban, since an override replaces a rule's options), except under
//   vendor/, which oxlint skips and tests/no-effect.test.ts reads instead;
// - in apps/mobile, no getExpoPushTokenAsync, imported by name or called on the
//   module (it sends the token to Expo's push service); getDevicePushTokenAsync
//   is the one the app uses.

const root = join(import.meta.dirname, '../../..');
// Built from parts, so this file holds no Effect import for tests/no-effect.test.ts to find.
const E = 'effect';

/** T3 Code's cases for no-hermes-unsupported-apis (240446e2d9): source, and the message it must give, or none. */
const HERMES: [string, RegExp | null][] = [
    ['const sorted = [...items].sort(compare);', null],
    ['const reversed = [...items].reverse();', null],
    ['const last = items.findLast(Boolean); const tail = items.at(-1);', null],
    ['const hasToSorted = typeof Array.prototype.toSorted === "function";', null],
    ['const sorted = items.toSorted(compare);', /Array#toSorted/],
    ['const open = chains.map((chain) => chain.layers.toReversed().filter(isOpen));', /Array#toReversed/],
    ['const next = items["toSpliced"](0, 1);', /const copy = \[\.\.\.array\]; copy\.splice\(\.\.\.\); use copy/],
    ['const reversed = items[`toReversed`]();', /Array#toReversed/],
    ['const value = items[`to${suffix}`]();', null],
    ['new Intl.NumberFormat();', null],
    ['const supported = typeof Intl.Segmenter === "function";', null],
    ['new custom.Segmenter();', null],
    ['new Intl[Segmenter](); items[toSorted]();', null],
    ...[
        "new Intl.Segmenter(undefined, { granularity: 'grapheme' })",
        "new Intl['Segmenter']()",
        'new Intl[`Segmenter`]()',
        'new globalThis.Intl.Segmenter()',
        "new globalThis['Intl']['Segmenter']()",
        'new global.Intl.Segmenter()',
        'new window.Intl.Segmenter()',
        'Intl.Segmenter()',
        'Intl.Segmenter?.()',
    ].map((expression): [string, RegExp] => [
        `${expression};`,
        /Hermes does not implement Intl\.Segmenter\. .*portable/,
    ]),
    // Socio's additions. Hermes has no crypto global.
    ['const id = crypto.randomUUID();', /Hermes does not implement crypto\.randomUUID\. .*expo-crypto/],
    ['const id = globalThis.crypto.randomUUID();', /Hermes does not implement crypto\.randomUUID/],
    ['const has = typeof crypto.randomUUID === "function";', null],
    ['const bytes = crypto.getRandomValues(new Uint8Array(32));', null],
    // Missing from the Hermes that React Native 0.88 ships (scripts/lint/socio-rules.mjs).
    [
        "const zones = Intl.supportedValuesOf('timeZone');",
        /Hermes does not implement Intl\.supportedValuesOf\. .*typeof/,
    ],
    ['const has = typeof Intl.supportedValuesOf === "function";', null],
    ['const copy = structuredClone(value);', /Hermes does not implement structuredClone\. .*JSON/],
    ['const copy = globalThis.structuredClone(value);', /Hermes does not implement structuredClone/],
    [
        'const all = (source: AsyncIterable<number>) => Array.fromAsync(source);',
        /Hermes does not implement Array\.fromAsync\. .*for await/,
    ],
    ['const all = Array.from(new Set([1]));', null],
];

/**
 * A global API is the global's only when its first name resolves to no binding in
 * scope: what the case is, its source, and the lines socio/hermes must flag.
 */
const BINDINGS: [string, string[], number[]][] = [
    [
        'an imported namespace (expo-crypto)',
        ["import * as crypto from 'expo-crypto';", '', 'export const id = crypto.randomUUID();'],
        [],
    ],
    [
        'a named import',
        ["import { structuredClone } from './clone';", '', 'export const copy = structuredClone({ a: 1 });'],
        [],
    ],
    ['a default import', ["import Intl from './intl';", '', 'export const segmenter = new Intl.Segmenter();'], []],
    [
        'a parameter',
        ['export function segment(Intl: { Segmenter: new () => object }) {', '    return new Intl.Segmenter();', '}'],
        [],
    ],
    [
        'a local variable',
        [
            "import { makeCrypto } from './make';",
            '',
            'const crypto = makeCrypto();',
            'export const id = crypto.randomUUID();',
        ],
        [],
    ],
    [
        'a function declared later in the file (hoisted)',
        [
            'export const copy = structuredClone({ a: 1 });',
            '',
            'function structuredClone<T>(value: T): T {',
            '    return { ...value };',
            '}',
        ],
        [],
    ],
    [
        'a var declared in a block (hoisted to the function)',
        [
            'export function id(seed: number) {',
            '    if (seed > 0) {',
            '        var crypto = { randomUUID: () => String(seed) };',
            '    }',
            '    return crypto.randomUUID();',
            '}',
        ],
        [],
    ],
    ['a catch parameter', ['try {', '    run();', '} catch (crypto) {', '    report(crypto.randomUUID());', '}'], []],
    [
        'a class',
        ['class Intl {', '    static Segmenter = class {};', '}', '', 'export const segmenter = new Intl.Segmenter();'],
        [],
    ],
    [
        'a globalThis parameter',
        [
            'export function copy(globalThis: { structuredClone<T>(value: T): T }) {',
            '    return globalThis.structuredClone({ a: 1 });',
            '}',
        ],
        [],
    ],
    [
        'no binding: still flagged',
        [
            'export const id = crypto.randomUUID();',
            'export const copy = structuredClone({ a: 1 });',
            'export const segmenter = new Intl.Segmenter();',
            "export const zones = Intl.supportedValuesOf('timeZone');",
            'export const all = Array.fromAsync([]);',
        ],
        [1, 2, 3, 4, 5],
    ],
    [
        'a binding in an inner function leaves the outer use flagged',
        [
            'function inner() {',
            "    const crypto = { randomUUID: () => 'id' };",
            '    return crypto.randomUUID();',
            '}',
            '',
            'export const ids = [inner(), crypto.randomUUID()];',
        ],
        [6],
    ],
    [
        'a binding in a block leaves the use after it flagged',
        [
            '{',
            '    const structuredClone = <T>(value: T): T => value;',
            '    structuredClone(1);',
            '}',
            'export const copy = structuredClone({ a: 1 });',
        ],
        [5],
    ],
    [
        'another function’s parameter leaves this one flagged',
        ['export const a = (Intl: object) => Intl;', 'export const b = () => new Intl.Segmenter();'],
        [2],
    ],
    [
        'globalThis and window flagged though the API’s own name is bound',
        [
            'export function copy(structuredClone: unknown, crypto: unknown) {',
            '    return [structuredClone, crypto, globalThis.structuredClone({ a: 1 }), window.crypto.randomUUID()];',
            '}',
        ],
        [2, 2],
    ],
    [
        'a type of the same name binds no value',
        ['type structuredClone = unknown;', 'export const copy = structuredClone({ a: 1 });'],
        [2],
    ],
    [
        'an overloaded function',
        [
            'function structuredClone<T>(value: T): T;',
            'function structuredClone(value: unknown) {',
            '    return value;',
            '}',
            'export const copy = structuredClone({ a: 1 });',
        ],
        [],
    ],
    // A declaration that emits nothing leaves the global in place.
    [
        'an ambient const still reaches the global',
        ['declare const crypto: { randomUUID(): string };', 'export const id = crypto.randomUUID();'],
        [2],
    ],
    [
        'an ambient function still reaches the global',
        ['declare function structuredClone<T>(value: T): T;', 'export const copy = structuredClone({ a: 1 });'],
        [2],
    ],
    [
        'an ambient class still reaches the global',
        [
            'declare class Intl {',
            '    static Segmenter: new () => object;',
            '}',
            'export const s = new Intl.Segmenter();',
        ],
        [4],
    ],
    [
        'a type-only import still reaches the global',
        ["import type { structuredClone } from './clone';", 'export const copy = structuredClone({ a: 1 });'],
        [2],
    ],
    // A local taken from the global is the global.
    [
        'a const destructured from globalThis is the global',
        ['const { structuredClone } = globalThis;', 'export const copy = structuredClone({ a: 1 });'],
        [2],
    ],
    [
        'a const copied from globalThis.crypto is the global',
        ['const crypto = globalThis.crypto;', 'export const id = crypto.randomUUID();'],
        [2],
    ],
    [
        'a copy under another name, through a cast or a nested pattern, is the global',
        [
            'const { crypto: webCrypto } = window;',
            'export const a = webCrypto.randomUUID();',
            'const root = globalThis;',
            'export const b = root.structuredClone({ a: 1 });',
            'const intl = (globalThis as { Intl: typeof Intl }).Intl;',
            'export const c = new intl.Segmenter();',
            'const {',
            '    Intl: { supportedValuesOf },',
            '} = globalThis;',
            "export const d = supportedValuesOf('timeZone');",
        ],
        [2, 4, 6, 10],
    ],
    [
        'a copy with a fallback, or assigned again, is a value of its own',
        [
            "import { clone, polyfill } from './polyfill';",
            '',
            'const { structuredClone = clone } = globalThis;',
            'export const a = structuredClone({ a: 1 });',
            'const crypto = globalThis.crypto ?? polyfill;',
            'export const b = crypto.randomUUID();',
            'let Intl = globalThis.Intl;',
            'Intl = polyfill;',
            'export const c = new Intl.Segmenter();',
        ],
        [],
    ],
];

/** The files to lint, by path from the repository root. */
const FILES: Record<string, string> = {
    ...Object.fromEntries(HERMES.map(([source], index) => [`apps/mobile/src/hermes/case-${index}.ts`, `${source}\n`])),
    ...Object.fromEntries(
        BINDINGS.map(([, lines], index) => [`apps/mobile/src/hermes/binding-${index}.ts`, `${lines.join('\n')}\n`]),
    ),
    'packages/shared/src/sorted.ts': 'export const sorted = (items: number[]) => items.toSorted();\n',
    'apps/mobile/metro.config.js': 'module.exports = [3, 1].toSorted();\n',
    'src/server/sorted.ts': 'export const sorted = (items: number[]) => items.toSorted();\n',
    'packages/client/src/sorted.ts': 'export const sorted = (items: number[]) => items.toSorted();\n',
    'apps/mobile/src/net/bare.ts': "export const get = () => fetch('https://example.invalid');\n",
    'apps/mobile/src/net/global.ts': "export const get = () => globalThis.fetch('https://example.invalid');\n",
    'apps/mobile/src/net/window.ts': "export const get = () => window.fetch('https://example.invalid');\n",
    'apps/mobile/src/net/expo.ts':
        "import { fetch as expoFetch } from 'expo/fetch';\n\nexport const get = expoFetch;\n",
    'apps/mobile/src/net/passed.ts': [
        "import type { fetch as ExpoFetch } from 'expo/fetch';",
        '',
        "export const get = (fetch: typeof ExpoFetch) => fetch('https://example.invalid');",
        '',
    ].join('\n'),
    'apps/mobile/src/net/typed.ts': 'export type Fetch = typeof fetch;\n',
    'apps/mobile/src/platform/fetch.ts': [
        "import { fetch as expoFetch } from 'expo/fetch';",
        `import * as Option from '${E}/Option';`,
        '',
        "export const get = () => expoFetch('https://example.invalid');",
        "export const fallback = () => fetch('https://example.invalid');",
        'export const none = Option;',
        '',
    ].join('\n'),
    'apps/mobile/tests/fetches.test.ts': "export const get = () => fetch('https://example.invalid');\n",
    'apps/mobile/src/effect.ts': `import { Effect } from '${E}';\n\nexport const run = Effect;\n`,
    'apps/mobile/src/platform/effect.ts': `import * as Option from '${E}/Option';\n\nexport const none = Option;\n`,
    'apps/mobile/scripts/effect.mjs': `import { it } from '@${E}/vitest';\n\nexport const t = it;\n`,
    'apps/mobile/vendor/t3code/utils.ts': `import * as Option from '${E}/Option';\n\nexport const none = Option;\n`,
    'apps/mobile/src/push/named.ts':
        "import { getExpoPushTokenAsync } from 'expo-notifications';\n\nexport const token = getExpoPushTokenAsync;\n",
    'apps/mobile/src/push/module.ts':
        "import * as Notifications from 'expo-notifications';\n\nexport const token = () => Notifications.getExpoPushTokenAsync();\n",
    'apps/mobile/src/push/device.ts':
        "import { getDevicePushTokenAsync } from 'expo-notifications';\n\nexport const token = getDevicePushTokenAsync;\n",
    'apps/mobile/src/platform/fetch-push.ts':
        "import * as Notifications from 'expo-notifications';\n\nexport const token = () => Notifications.getExpoPushTokenAsync();\n",
    'apps/mobile/plugins/push-token.ts':
        "import { getExpoPushTokenAsync } from 'expo-notifications';\n\nexport const token = getExpoPushTokenAsync;\n",
};

interface Diagnostic {
    code: string;
    message: string;
    help?: string;
    filename: string;
    labels?: { span: { line: number } }[];
}

/** Each file's findings for the rules this test is about, as `rule: message`, deduplicated. */
let findings: Map<string, string[]>;
/** Each file's socio/hermes findings, as the line of each, sorted. */
let hermesLines: Map<string, number[]>;
const scratch = mkdtempSync(join(tmpdir(), 'socio-lint-'));

beforeAll(() => {
    for (const path of ['.oxlintrc.json', 'scripts/lint/socio-rules.mjs']) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        copyFileSync(join(root, path), join(scratch, path));
    }
    for (const [path, text] of Object.entries(FILES)) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        writeFileSync(join(scratch, path), text);
    }
    const run = spawnSync(
        join(root, 'node_modules/.bin/oxlint'),
        ['-c', '.oxlintrc.json', '-f', 'json', 'apps', 'packages', 'src'],
        { cwd: scratch, encoding: 'utf8', maxBuffer: 1e8 },
    );
    expect(run.stdout, run.stderr).toMatch(/^\s*\{/);
    const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
    findings = new Map();
    hermesLines = new Map();
    for (const { code, message, help, filename, labels } of diagnostics) {
        const rule = /\((.+)\)$/.exec(code)?.[1] ?? code;
        if (rule === 'hermes') {
            const line = labels?.[0]?.span.line ?? 0;
            hermesLines.set(
                filename,
                [...(hermesLines.get(filename) ?? []), line].sort((a, b) => a - b),
            );
        }
        if (rule === 'hermes' || rule.startsWith('no-restricted-')) {
            const entry = `${rule}: ${message}${help ? ` ${help}` : ''}`;
            const list = findings.get(filename) ?? [];
            findings.set(filename, [...new Set([...list, entry])].sort());
        }
    }
}, 60_000);

afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

const of = (path: string) => findings.get(path) ?? [];

describe('socio/hermes', () => {
    it.each(HERMES.map(([source, message], index) => [source, message, index] as const))(
        '%s',
        (_source, message, index) => {
            const found = of(`apps/mobile/src/hermes/case-${index}.ts`);
            if (message === null) {
                expect(found).toEqual([]);
            } else {
                expect(found).toHaveLength(1);
                expect(found[0]).toMatch(/^hermes: /);
                expect(found[0]).toMatch(message);
            }
        },
    );

    it.each(BINDINGS.map(([name, , lines], index) => [name, lines, index] as const))(
        'with %s',
        (_name, lines, index) => {
            const path = `apps/mobile/src/hermes/binding-${index}.ts`;
            expect(hermesLines.get(path) ?? []).toEqual(lines);
            for (const finding of of(path)) {
                expect(finding).toMatch(/^hermes: Hermes does not implement /);
            }
        },
    );

    it('runs on shared’s source and the app’s config files too', () => {
        expect(of('packages/shared/src/sorted.ts')).toEqual([expect.stringMatching(/^hermes: .*Array#toSorted/)]);
        expect(of('apps/mobile/metro.config.js')).toEqual([expect.stringMatching(/^hermes: .*Array#toSorted/)]);
    });

    it('leaves the server and the web client alone', () => {
        expect(of('src/server/sorted.ts')).toEqual([]);
        expect(of('packages/client/src/sorted.ts')).toEqual([]);
    });
});

describe('the app’s fetch', () => {
    it('is never the global, by any name, in src/', () => {
        expect(of('apps/mobile/src/net/bare.ts')).toEqual([expect.stringMatching(/^no-restricted-globals: .*fetch/)]);
        for (const path of ['apps/mobile/src/net/global.ts', 'apps/mobile/src/net/window.ts']) {
            expect(of(path), path).toEqual([expect.stringMatching(/^no-restricted-properties: .*fetch/)]);
        }
    });

    it('never comes from expo/fetch outside src/platform/fetch.ts', () => {
        expect(of('apps/mobile/src/net/expo.ts')).toEqual([
            expect.stringMatching(/^no-restricted-imports: 'expo\/fetch'.*src\/platform\/fetch\.ts/),
        ]);
        // That file's only finding is its Effect import (below).
        expect(of('apps/mobile/src/platform/fetch.ts')).toEqual([
            expect.stringMatching(/^no-restricted-imports: .*No Effect in the native app/),
        ]);
    });

    it('may be passed in, typed from expo/fetch, and tests may use the global', () => {
        expect(of('apps/mobile/src/net/passed.ts')).toEqual([]);
        expect(of('apps/mobile/tests/fetches.test.ts')).toEqual([]);
    });

    it('is not typed as the global, whose signature isn’t expo/fetch’s', () => {
        expect(of('apps/mobile/src/net/typed.ts')).toEqual([expect.stringMatching(/^no-restricted-globals: .*fetch/)]);
    });
});

describe('Effect in the app', () => {
    it('is banned in src/, src/platform/fetch.ts included, and in every other app file', () => {
        for (const path of [
            'apps/mobile/src/effect.ts',
            'apps/mobile/src/platform/effect.ts',
            'apps/mobile/src/platform/fetch.ts',
            'apps/mobile/scripts/effect.mjs',
        ]) {
            expect(of(path), path).toEqual([
                expect.stringMatching(/^no-restricted-imports: .*No Effect in the native app/),
            ]);
        }
    });

    it('is not linted under vendor/, which oxlint ignores', () => {
        expect(of('apps/mobile/vendor/t3code/utils.ts')).toEqual([]);
    });
});

describe('Expo’s push tokens', () => {
    it('are banned by name and on the module, in src/ and in every other app file', () => {
        for (const path of ['apps/mobile/src/push/named.ts', 'apps/mobile/plugins/push-token.ts']) {
            expect(of(path), path).toEqual([
                expect.stringMatching(/^no-restricted-imports: .*getExpoPushTokenAsync.*getDevicePushTokenAsync/),
            ]);
        }
        // A namespace import counts as importing it, so the app imports expo-notifications by name.
        for (const path of ['apps/mobile/src/push/module.ts', 'apps/mobile/src/platform/fetch-push.ts']) {
            expect(of(path), path).toEqual([
                expect.stringMatching(/^no-restricted-imports: \* import is invalid .*getExpoPushTokenAsync/),
                expect.stringMatching(/^no-restricted-properties: .*getExpoPushTokenAsync.*getDevicePushTokenAsync/),
            ]);
        }
    });

    it('leave the device token alone', () => {
        expect(of('apps/mobile/src/push/device.ts')).toEqual([]);
    });
});
