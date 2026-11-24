import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';

import { afterAll, describe, expect, it, onTestFinished } from 'vitest';

import { moduleNames } from '../vendor/t3code/dependency-graph';

// No Effect in the app, vendored code included (apps/mobile/AGENTS.md). The
// root's lint bans the imports in the app's own files, but it ignores
// apps/*/vendor, so this reads every file, and the lockfile: nothing the app
// installs may bring Effect in either.

const app = join(import.meta.dirname, '..');
const root = join(app, '../..');
// The root's YAML parser (its devDependency): the app declares nothing for this.
const { parse } = createRequire(join(root, 'package.json'))('yaml') as { parse: (text: string) => unknown };

/** `effect`, `effect/Option`, `@effect/vitest` and the like. */
const isEffect = (name: string) => /^effect($|\/)/.test(name) || name.startsWith('@effect/');

/** What git ignores in the app, and what builds leave there. */
const SKIP = new Set(['node_modules', 'android', 'ios', '.expo', 'dist', '.turbo']);
const CODE = /\.[cm]?[jt]sx?$/;

/**
 * Every Effect import in the code under `dir`, as `path: specifier`: any module a
 * file names, type-only ones included, read from Babel's AST of it as Metro parses
 * it (moduleNames in vendor/t3code/dependency-graph.ts), so comments and strings
 * name nothing. A file Metro can't parse fails the test, naming the file.
 *
 * Expo's preset reads only `.ts` and `.tsx` as TypeScript and everything else as
 * Flow, so a `.mts` or `.cts` script (Node's, which Metro never bundles) is parsed
 * under its `.ts` name. Babel's errors name the file it was given, so the error
 * gets the real name back.
 */
function effectImports(dir: string): string[] {
    const found: string[] = [];
    const walk = (at: string) => {
        for (const entry of readdirSync(at, { withFileTypes: true })) {
            const path = join(at, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP.has(entry.name)) {
                    walk(path);
                }
            } else if (CODE.test(entry.name)) {
                const alias = path.replace(/\.[cm]ts$/, '.ts');
                let specifiers: string[];
                try {
                    specifiers = moduleNames(readFileSync(path, 'utf8'), alias);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(`${relative(dir, path)}: ${message.replaceAll(alias, path)}`, { cause: error });
                }
                for (const specifier of specifiers) {
                    if (isEffect(specifier)) {
                        found.push(`${relative(dir, path)}: ${specifier}`);
                    }
                }
            }
        }
    };
    walk(dir);
    return [...new Set(found)].sort();
}

type Dependencies = Record<string, { version: string }>;

interface Lockfile {
    importers: Record<string, Partial<Record<string, Dependencies>>>;
    snapshots: Record<string, Partial<Record<string, Record<string, string>>> | null>;
}

/** A snapshot key's package name: `@scope/name@1.0.0(peer@2.0.0)` gives `@scope/name`. */
const nameOf = (key: string) => key.slice(0, key.indexOf('@', 1));

/** The peers resolved in a key's suffix: `a@1(b@2(c@3))(d@4)` gives `b@2(c@3)` and `d@4`. */
function resolvedPeers(key: string): string[] {
    const peers: string[] = [];
    let depth = 0;
    let start = -1;
    for (let index = key.indexOf('('); index !== -1 && index < key.length; index++) {
        if (key[index] === '(') {
            if (depth++ === 0) {
                start = index + 1;
            }
        } else if (key[index] === ')' && --depth === 0) {
            peers.push(key.slice(start, index));
        }
    }
    return peers;
}

/**
 * Every package an importer installs: its dependencies of each kind, the
 * workspace packages it links and theirs, then each snapshot's dependencies,
 * optional ones and resolved peers, transitively. Snapshot keys.
 */
function closure(lock: Lockfile, importer: string): Set<string> {
    const seen = new Set<string>();
    const importers = new Set<string>();
    const queue: string[] = [];
    const fromImporter = (id: string) => {
        if (importers.has(id)) {
            return;
        }
        importers.add(id);
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            for (const [name, { version }] of Object.entries(lock.importers[id]?.[section] ?? {})) {
                if (version.startsWith('link:')) {
                    fromImporter(posix.normalize(posix.join(id, version.slice('link:'.length))));
                } else if (!/^(file|workspace):/.test(version)) {
                    const bare = version.split('(')[0];
                    queue.push(/^(@[^/]+\/)?[^@/]+@/.test(bare) ? version : `${name}@${version}`);
                }
            }
        }
    };
    fromImporter(importer);
    for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const snapshot = lock.snapshots[key] ?? {};
        for (const section of ['dependencies', 'optionalDependencies']) {
            for (const [name, version] of Object.entries(snapshot[section] ?? {})) {
                if (!/^(link|file|workspace):/.test(version)) {
                    const bare = version.split('(')[0];
                    queue.push(/^(@[^/]+\/)?[^@/]+@/.test(bare) ? version : `${name}@${version}`);
                }
            }
        }
        queue.push(...resolvedPeers(key));
    }
    return seen;
}

/** The Effect packages an importer installs, as `name@version`. */
const effectPackages = (lock: Lockfile, importer: string) =>
    [
        ...new Set([...closure(lock, importer)].filter((key) => isEffect(nameOf(key))).map((key) => key.split('(')[0])),
    ].sort();

describe('no Effect in the app', () => {
    // It reads every file of the app, vendor/ included: about 6 s alone, past 20 s beside the whole suite.
    it('is imported nowhere in apps/mobile, vendored code included', { timeout: 60_000 }, () => {
        expect(effectImports(app)).toEqual([]);
    });

    it('is installed by nothing the app depends on', () => {
        const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')) as Lockfile;
        const installed = [...closure(lock, 'apps/mobile')].map(nameOf);
        // The walk reaches the app's tree, and Effect is there to find: the server uses it.
        expect(installed).toEqual(expect.arrayContaining(['react-native', 'expo', 'zod']));
        // Any version: a server bump mustn't touch this test.
        expect(effectPackages(lock, '.')).toContainEqual(expect.stringMatching(/^effect@\d/));
        expect(effectPackages(lock, 'apps/mobile')).toEqual([]);
    });
});

describe('the checks themselves', () => {
    // Built from parts, so this file holds no Effect import for the first check to find.
    const E = 'effect';
    const dir = mkdtempSync(join(tmpdir(), 'socio-no-effect-'));
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('finds an Effect import under vendor/, and every other way to load it', () => {
        const files: Record<string, string> = {
            'vendor/t3code/utils.ts': `import * as Option from "${E}/Option";\nexport const none = Option.none;\n`,
            'vendor/t3code/harness.ts': `import { it } from '@${E}/vitest';\nexport { it };\n`,
            // A quote or a semicolon in a comment inside the clause.
            'vendor/t3code/apostrophe.ts': `import {\n    Effect, // Effect's runtime\n} from '${E}';\nexport { Effect };\n`,
            'vendor/t3code/semicolon.ts': `import { Layer /* a; b */ } from '${E}';\nexport { Layer };\n`,
            'vendor/t3code/type-expression.ts': `export type Run = typeof import('${E}/Effect').runPromise;\n`,
            'vendor/t3code/import-equals.ts': `import Stream = require('${E}/Stream');\nexport { Stream };\n`,
            'src/lazy.ts': `export const load = () => import('${E}');\n`,
            'scripts/old.cjs': `const { Effect } = require('${E}');\nmodule.exports = Effect;\n`,
            'src/types.ts': `export type { Layer } from '${E}';\n`,
            'src/fine.tsx': [
                "import { useEffect } from 'react';",
                "import { sideEffect } from './effect';",
                `import ts from '${E}-ts';`,
                `// ${E} is mentioned here, and in a string: '${E}'`,
                'export { useEffect, sideEffect, ts };',
                '',
            ].join('\n'),
            [`node_modules/${E}/index.js`]: `require('${E}/Function');\n`,
        };
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), text);
        }
        expect(effectImports(dir)).toEqual([
            `scripts/old.cjs: ${E}`,
            `src/lazy.ts: ${E}`,
            `src/types.ts: ${E}`,
            `vendor/t3code/apostrophe.ts: ${E}`,
            `vendor/t3code/harness.ts: @${E}/vitest`,
            `vendor/t3code/import-equals.ts: ${E}/Stream`,
            `vendor/t3code/semicolon.ts: ${E}`,
            `vendor/t3code/type-expression.ts: ${E}/Effect`,
            `vendor/t3code/utils.ts: ${E}/Option`,
        ]);
    });

    it("parses Node's .mts and .cts scripts as TypeScript, and finds Effect in them", () => {
        // Expo's preset would read these as Flow, where `as const` is a syntax error.
        // Its own folder: the test above walks all of `dir`.
        const scripts = mkdtempSync(join(tmpdir(), 'socio-no-effect-'));
        onTestFinished(() => {
            rmSync(scripts, { recursive: true, force: true });
        });
        const files: Record<string, string> = {
            'theme.mts': `import { pipe } from '${E}/Function';\nexport const steps = ['a', 'b'] as const;\n`,
            'legacy.cts': `const tones = ['mint'] as const;\nconst { Layer } = require('@${E}/platform');\nmodule.exports = { tones, Layer };\n`,
            'fine.mts': [
                "import { readFileSync } from 'node:fs';",
                "export const tones = ['mint', 'sky'] as const;",
                'export type Tone = (typeof tones)[number];',
                "export const read = (path: string): string => readFileSync(path, 'utf8');",
                '',
            ].join('\n'),
        };
        for (const [path, text] of Object.entries(files)) {
            writeFileSync(join(scripts, path), text);
        }
        expect(effectImports(scripts)).toEqual([`legacy.cts: @${E}/platform`, `theme.mts: ${E}/Function`]);
    });

    it.each(['mts', 'cts', 'ts'])('names the .%s file it can’t parse, and no other', (extension) => {
        const scripts = mkdtempSync(join(tmpdir(), 'socio-no-effect-'));
        onTestFinished(() => {
            rmSync(scripts, { recursive: true, force: true });
        });
        mkdirSync(join(scripts, 'theme'));
        writeFileSync(join(scripts, `theme/bad.${extension}`), 'export const x = ;\n');
        let message = '';
        try {
            effectImports(scripts);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(new RegExp(`^theme/bad\\.${extension}: `));
        expect(message).toContain(`${join(scripts, `theme/bad.${extension}`)}: Unexpected token (1:17)`);
        // Not the `.ts` alias a `.mts` or `.cts` file is parsed under.
        expect(message.includes('bad.ts')).toBe(extension === 'ts');
    });

    it('finds Effect installed through a dependency, an optional one, a peer or a linked workspace package', () => {
        const lock: Lockfile = {
            importers: {
                'apps/x': {
                    dependencies: { a: { version: '1.0.0' }, '@socio/y': { version: 'link:../../packages/y' } },
                },
                'packages/y': { dependencies: { c: { version: `1.0.0(${E}@4.0.5)` } } },
                'packages/z': { dependencies: { [`@${E}/sql`]: { version: '1.0.0' } } },
            },
            snapshots: {
                'a@1.0.0': { dependencies: { b: '2.0.0' } },
                'b@2.0.0': { optionalDependencies: { [`@${E}/platform`]: '1.0.0' } },
                [`c@1.0.0(${E}@4.0.5)`]: {},
                [`${E}@4.0.5`]: null,
                [`@${E}/platform@1.0.0`]: {},
                [`@${E}/sql@1.0.0`]: {},
            },
        };
        expect(effectPackages(lock, 'apps/x')).toEqual([`@${E}/platform@1.0.0`, `${E}@4.0.5`]);
    });
});
