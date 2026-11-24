import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
    buildPlatformGraph,
    findCycles,
    parseImports,
    type Platform,
    PLATFORM_EXTENSION_ORDER,
    PLATFORMS,
    resolveRelative,
} from '../vendor/t3code/dependency-graph';

// The app's import graph, through T3 Code's graph (vendor/t3code/dependency-graph.ts),
// for each platform's extension order:
// - no import cycle anywhere in src/ (a cycle can leave a module half
//   initialized at launch under Metro; a dynamic import can't, so it doesn't count,
//   and a type-only import loads nothing);
// - src/data, src/sync, src/net and src/push load no React Native or Expo package, by any
// route through src/. Their tests run under Node, so the platform hands them what they need: a
// SQLite driver, the app's fetch;
// - src/ holds no script but .ts and .tsx files, the only ones the graph reads (and
//   the React Compiler test compiles): Metro would bundle a .js, .jsx, .mjs or .cjs
//   file, and the checks above would never see it or its imports.

const src = join(import.meta.dirname, '../src');
const NODE_ONLY = ['data', 'sync', 'net', 'push'];

/** Files src/sync may never reach, by any route: the push relay's fetch. */
const OUT_OF_SYNC = ['net/relay-fetch.ts', 'push/relay-client.ts'];

/**
 * Packages that need React Native to load: the app-only packages of
 * tests/integration/apps-isolation.test.ts, their subpaths (`expo/fetch`), and
 * the libraries built on React Native (lucide-react-native, uniwind).
 */
const NATIVE = [
    /^react-native($|\/)/,
    /^react-native-/,
    /^@react-native\//,
    /^@react-native-community\//,
    /^expo($|\/)/,
    /^expo-/,
    /^@expo\//,
    /^metro($|-|\/)/,
    /^hermes-/,
    /^@react-navigation\//,
    /-react-native($|\/)/,
    /^uniwind($|\/)/,
];

/** Scripts the graph doesn't read: JavaScript of any kind, `.mts` and `.cts` (`.d.ts` loads nothing). */
const OTHER_SCRIPT = /\.(?:[cm]?jsx?|[cm]ts)$/;

/** The files under `root` that OTHER_SCRIPT matches, as relative paths with `/`. */
function otherScripts(root: string): string[] {
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((file) => OTHER_SCRIPT.test(file))
        .map((file) => file.split(sep).join('/'))
        .sort();
}

/**
 * The native packages the files in `folders` load, directly or through other
 * files under `sourceRoot` (dynamic imports included: they load too), each as
 * `a.ts -> b.ts: package`, by the shortest route from one of those files.
 * Type-only syntax loads nothing, and parseImports, which reads Babel's AST
 * as Metro parses the file, leaves it out.
 */
function nativeImports(sourceRoot: string, folders: readonly string[], platform: Platform): string[] {
    const order = PLATFORM_EXTENSION_ORDER[platform];
    const inFolders = (file: string) => folders.some((folder) => file.startsWith(join(sourceRoot, folder) + sep));
    const routes = new Map<string, string[]>();
    const queue: string[] = [];
    for (const file of buildPlatformGraph(sourceRoot, platform).files.filter(inFolders)) {
        routes.set(file, [file]);
        queue.push(file);
    }
    const found = new Set<string>();
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        const route = routes.get(file) ?? [file];
        for (const { specifier } of parseImports(readFileSync(file, 'utf8'), file)) {
            if (NATIVE.some((pattern) => pattern.test(specifier))) {
                found.add(`${route.map((step) => relative(sourceRoot, step)).join(' -> ')}: ${specifier}`);
                continue;
            }
            const next = resolveRelative(sourceRoot, file, specifier, order);
            if (next !== null && !routes.has(next)) {
                routes.set(next, [...route, next]);
                queue.push(next);
            }
        }
    }
    return [...found].sort();
}

/** Every file under `sourceRoot` the files in `folder` load, by any route (relative paths with `/`). */
function reachable(sourceRoot: string, folder: string, platform: Platform): string[] {
    const order = PLATFORM_EXTENSION_ORDER[platform];
    const seen = new Set<string>();
    const queue = buildPlatformGraph(sourceRoot, platform).files.filter((file) =>
        file.startsWith(join(sourceRoot, folder) + sep),
    );
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        if (seen.has(file)) {
            continue;
        }
        seen.add(file);
        for (const { specifier } of parseImports(readFileSync(file, 'utf8'), file)) {
            const next = resolveRelative(sourceRoot, file, specifier, order);
            if (next !== null && !seen.has(next)) {
                queue.push(next);
            }
        }
    }
    return [...seen].map((file) => relative(sourceRoot, file).split(sep).join('/'));
}

describe('the app’s dependency graph', () => {
    it.each(PLATFORMS)('has no circular imports under %s resolution', (platform) => {
        const graph = buildPlatformGraph(src, platform);
        expect(graph.files.map((file) => relative(src, file))).toEqual(
            expect.arrayContaining(NODE_ONLY.map((folder) => `${folder}/index.ts`)),
        );
        expect(findCycles(graph)).toEqual([]);
    });

    it.each(PLATFORMS)(
        'keeps src/data, src/sync, src/net and src/push off React Native and Expo under %s resolution',
        (platform) => {
            expect(nativeImports(src, NODE_ONLY, platform)).toEqual([]);
        },
    );

    it.each(PLATFORMS)('keeps the relay fetch out of src/sync under %s resolution', (platform) => {
        expect(reachable(src, 'sync', platform).filter((file) => OUT_OF_SYNC.includes(file))).toEqual([]);
    });

    it('holds no script in src/ but .ts and .tsx files', () => {
        expect(otherScripts(src)).toEqual([]);
    });
});

describe('the checks themselves', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'socio-graph-'));
    afterAll(() => {
        rmSync(fixture, { recursive: true, force: true });
    });
    const files: Record<string, string> = {
        'data/index.ts': "export * from './store';\n",
        'data/store.ts': "import { openDatabaseAsync } from 'expo-sqlite';\nexport const open = openDatabaseAsync;\n",
        'data/types.ts': [
            "import type { SQLiteDatabase } from 'expo-sqlite';",
            "import type {\n    SQLiteBindValue,\n    SQLiteRunResult,\n} from 'expo-sqlite';",
            "import type Sqlite from 'expo-sqlite';",
            "import type * as Next from 'expo-sqlite/next';",
            "export type { SQLiteStatement } from 'expo-sqlite';",
            "export type * from 'expo-sqlite/kv-store';",
            "import { type SQLiteOptions, type SQLiteDatabase as Database } from 'expo-sqlite';",
            'export type Db = SQLiteDatabase | typeof Sqlite | Next.SQLiteDatabase | Database;',
            'export type Row = [SQLiteBindValue, SQLiteRunResult, SQLiteOptions];',
            '',
        ].join('\n'),
        // Type expressions load nothing: `import('…').T` and `typeof import('…')`, in an
        // alias, an annotation, a cast or an ambient declaration.
        'data/driver.ts': "export type Driver = import('expo-sqlite').SQLiteDatabase;\n",
        'data/module.ts': [
            "export type SqliteModule = typeof import('expo-sqlite');",
            "export const name = (db: import('expo-sqlite').SQLiteDatabase): string => db.databasePath;",
            "export const cast = (value: unknown) => value as typeof import('expo-sqlite');",
            "declare const sqlite: typeof import('expo-sqlite');",
            'export type Sqlite = typeof sqlite;',
            '',
        ].join('\n'),
        // Comments and strings hold no imports.
        'data/comment.ts': [
            "export const before = 1; // import x from 'expo-sqlite'",
            "// import x from 'expo-sqlite'",
            '/*',
            "import 'expo-sqlite';",
            '*/',
            'export const after = 2;',
            '',
        ].join('\n'),
        'data/text.ts': [
            'export const example = "import { openDatabaseAsync } from \'expo-sqlite\';";',
            "export const lazy = `await import('expo-sqlite')`;",
            '',
        ].join('\n'),
        // A real dynamic import loads the package when it runs.
        'data/lazy.ts': "export const open = async () => (await import('expo-sqlite')).openDatabaseAsync('a');\n",
        // So does one whose name Metro computes before bundling: a const, a sum of strings.
        'data/constant.ts': [
            "const SQLITE = 'expo-sqlite';",
            "export const open = async () => (await import(SQLITE)).openDatabaseAsync('a');",
            '',
        ].join('\n'),
        'data/sum.ts': "export const load = () => import('expo-' + 'sqlite');\n",
        // A clause with one value in it loads the package, type names or not.
        'data/mixed.ts':
            "import { type SQLiteDatabase, openDatabaseSync } from 'expo-sqlite';\nexport const db: SQLiteDatabase = openDatabaseSync('a');\n",
        // A file named in full, and a NodeNext `.js` name for a `.ts` file.
        'net/upload.ts': "import { CameraView } from '../platform/camera.tsx';\nexport const camera = CameraView;\n",
        'data/keys.ts': "import { getItem } from '../platform/secure-store.js';\nexport const read = getItem;\n",
        'net/request.ts': "import { Platform } from 'react-native';\nexport const os = Platform.OS;\n",
        'net/barrel.ts': "export type Origin = string;\nexport { openDb } from '../platform/sqlite';\n",
        // Metro takes storage.ts over storage.native.tsx: .ts comes first, whatever the platform.
        'net/cache.ts': "import { cacheDir } from '../platform/storage';\nexport const dir = cacheDir;\n",
        // A JavaScript file the graph can't see (no edge to it): only otherScripts catches it.
        'net/session.ts': "import { getItem } from '../platform/legacy';\nexport const read = getItem;\n",
        'sync/engine.ts': "import { appFetch } from '../platform/fetch';\nexport const go = appFetch;\n",
        'sync/later.ts': "export const load = () => import('react-native');\n",
        'sync/a.ts': "import { b } from './b';\nexport const a = () => b;\n",
        'sync/b.ts': "import { a } from './a';\nexport const b = () => a;\n",
        'sync/c.ts': "export const loadD = () => import('./d');\n",
        'sync/d.ts': "import { loadD } from './c';\nexport const d = loadD;\n",
        // Cycles through names in full, and through NodeNext `.js` names (h.tsx from './h.js').
        'sync/e.ts': "import { f } from './f.tsx';\nexport const e = () => f;\n",
        'sync/f.tsx': "import { e } from './e.ts';\nexport const f = () => e;\n",
        'sync/g.ts': "import { h } from './h.js';\nexport const g = () => h;\n",
        'sync/h.tsx': "import { g } from './g.js';\nexport const h = () => g;\n",
        // Files that import and re-export only each other's types: no cycle.
        'sync/ta.ts':
            "import type { TB } from './tb';\nexport type { TC } from './tc';\nexport type TA = { b?: TB };\n",
        'sync/tb.ts':
            "import {\n    type TA, // the row\n    type TC as C,\n} from './ta';\nexport type TB = { a?: TA; c?: C };\n",
        'sync/tc.ts': "export { type TA } from './ta';\nexport type * from './tb';\nexport type TC = string;\n",
        // Clauses that mix type names with a value still load: a cycle.
        'sync/ma.ts': "import { type B, b } from './mb';\nexport type A = B;\nexport const a = () => b;\n",
        'sync/mb.ts': "export { type A, a as b } from './ma';\nexport type B = string;\n",
        // A cycle through q.ts, which Metro takes over q.native.tsx (no import back).
        'sync/p.ts': "import { q } from './q';\nexport const p = () => q;\n",
        'sync/q.ts': "import { p } from './p';\nexport const q = () => p;\n",
        'sync/q.native.tsx': 'export const q = () => null;\n',
        // Metro's order: each extension in turn, the platform's file first inside it.
        'sync/mix.ts': 'export const mix = 1;\n',
        'sync/mix.native.tsx': 'export const mix = 2;\n',
        'sync/os.ts': 'export const os = 1;\n',
        'sync/os.android.tsx': 'export const os = 2;\n',
        'sync/os.ios.tsx': 'export const os = 3;\n',
        'sync/nat.ts': 'export const nat = 1;\n',
        'sync/nat.native.ts': 'export const nat = 2;\n',
        'sync/plat.native.ts': 'export const plat = 1;\n',
        'sync/plat.android.ts': 'export const plat = 2;\n',
        'sync/plat.ios.ts': 'export const plat = 3;\n',
        // A file comes before a folder's index, as in Metro.
        'sync/order.ts': 'export const order = 1;\n',
        'sync/order/index.native.ts': 'export const order = 2;\n',
        'platform/fetch.ts': "import { fetch } from 'expo/fetch';\nexport const appFetch = fetch;\n",
        'platform/sqlite.ts':
            "import { openDatabaseAsync } from 'expo-sqlite';\nexport const openDb = openDatabaseAsync;\n",
        'platform/camera.tsx': "import { CameraView } from 'expo-camera';\nexport { CameraView };\n",
        'platform/secure-store.ts': "import { getItem } from 'expo-secure-store';\nexport { getItem };\n",
        'platform/storage.ts': "import { Paths } from 'expo-file-system';\nexport const cacheDir = Paths.cache;\n",
        'platform/storage.native.tsx': "export const cacheDir = '';\n",
        'platform/legacy.js': "import { getItem } from 'expo-secure-store';\nexport { getItem };\n",
        'platform/types.d.ts': 'export type Legacy = string;\n',
        'sync/worker.mjs': 'export const work = 1;\n',
        'screens/card.jsx': 'export const Card = () => null;\n',
        'screens/old.cjs': 'module.exports = {};\n',
        'screens/tool.mts': 'export const tool = 1;\n',
        'screens/style.css': '.card {}\n',
        'screens/home.tsx': "import { View } from 'react-native';\nexport const Home = View;\n",
    };
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(fixture, path)), { recursive: true });
        writeFileSync(join(fixture, path), text);
    }

    it.each(PLATFORMS)(
        'finds native imports in the Node-only folders, by any route, under %s resolution',
        (platform) => {
            expect(nativeImports(fixture, NODE_ONLY, platform)).toEqual([
                'data/constant.ts: expo-sqlite',
                'data/keys.ts -> platform/secure-store.ts: expo-secure-store',
                'data/lazy.ts: expo-sqlite',
                'data/mixed.ts: expo-sqlite',
                'data/store.ts: expo-sqlite',
                'data/sum.ts: expo-sqlite',
                'net/barrel.ts -> platform/sqlite.ts: expo-sqlite',
                'net/cache.ts -> platform/storage.ts: expo-file-system',
                'net/request.ts: react-native',
                'net/upload.ts -> platform/camera.tsx: expo-camera',
                'sync/engine.ts -> platform/fetch.ts: expo/fetch',
                'sync/later.ts: react-native',
            ]);
        },
    );

    it.each(PLATFORMS)(
        'finds static import cycles, not one closed by a dynamic import or by types, under %s resolution',
        (platform) => {
            expect(findCycles(buildPlatformGraph(fixture, platform))).toEqual([
                ['sync/a.ts', 'sync/b.ts'],
                ['sync/e.ts', 'sync/f.tsx'],
                ['sync/g.ts', 'sync/h.tsx'],
                ['sync/ma.ts', 'sync/mb.ts'],
                ['sync/p.ts', 'sync/q.ts'],
            ]);
        },
    );

    it.each(PLATFORMS)('resolves relative names in Metro’s order under %s resolution', (platform) => {
        const from = join(fixture, 'sync/a.ts');
        const resolve = (specifier: string) => {
            const file = resolveRelative(fixture, from, specifier, PLATFORM_EXTENSION_ORDER[platform]);
            return file === null ? null : relative(fixture, file);
        };
        expect(resolve('./b')).toBe('sync/b.ts');
        expect(resolve('./f.tsx')).toBe('sync/f.tsx');
        expect(resolve('./g.js')).toBe('sync/g.ts');
        expect(resolve('./h.js')).toBe('sync/h.tsx');
        expect(resolve('./order')).toBe('sync/order.ts');
        expect(resolve('./mix')).toBe('sync/mix.ts');
        expect(resolve('./os')).toBe('sync/os.ts');
        expect(resolve('./nat')).toBe('sync/nat.native.ts');
        expect(resolve('./plat')).toBe(`sync/plat.${platform}.ts`);
        expect(resolve('../data')).toBe('data/index.ts');
        expect(resolve('./b.tsx')).toBeNull();
        expect(resolve('react-native')).toBeNull();
    });

    it('lists the scripts the graph doesn’t read', () => {
        expect(otherScripts(fixture)).toEqual([
            'platform/legacy.js',
            'screens/card.jsx',
            'screens/old.cjs',
            'screens/tool.mts',
            'sync/worker.mjs',
        ]);
    });

    it('leaves type-only clauses out of the imports, and keeps any clause that names a value', () => {
        const source = [
            "import type { A } from './type-named';",
            "import type B from './type-default';",
            "import type * as C from './type-namespace';",
            "export type { D } from './type-reexport';",
            "export type * from './type-star';",
            "export type * as E from './type-star-as';",
            "import { type F, type G as H } from './inline-types';",
            "export { type I } from './inline-type-reexport';",
            "import {\n    type J, // a comment\n    type K,\n} from './inline-types-multiline';",
            'export type Id = string;',
            "import { type L, m } from './mixed';",
            "export { type N, o } from './mixed-reexport';",
            "import { type } from './value-named-type';",
            "import { type as p } from './value-type-renamed';",
            "import {} from './empty';",
            "import './side-effect';",
            "export const load = () => import('./dynamic');",
        ].join('\n');
        expect(parseImports(source, 'clauses.ts')).toEqual([
            { specifier: './mixed', isDynamic: false },
            { specifier: './mixed-reexport', isDynamic: false },
            { specifier: './value-named-type', isDynamic: false },
            { specifier: './value-type-renamed', isDynamic: false },
            { specifier: './empty', isDynamic: false },
            { specifier: './side-effect', isDynamic: false },
            { specifier: './dynamic', isDynamic: true },
        ]);
        // A default import named `type`, alone: a second `type` binding would be a duplicate declaration.
        expect(parseImports("import type from './default-named-type';", 'default-type.ts')).toEqual([
            { specifier: './default-named-type', isDynamic: false },
        ]);
    });

    it('reads imports from the syntax tree: not from types, comments or strings', () => {
        const source = [
            "export type Driver = import('./type-expression').Driver;",
            "type Module = typeof import('./type-query');",
            "export const name = (db: import('./annotation').Db) => db.name;",
            "export const cast = (value: unknown) => value as typeof import('./as-cast');",
            "export const checked = {} satisfies Partial<typeof import('./satisfies')>;",
            "export function first<T extends import('./constraint').Row>(rows: T[]): T | undefined { return rows[0]; }",
            "export interface Store { db: import('./interface').Db; open(): typeof import('./method'); }",
            "declare const ambient: typeof import('./declared');",
            "declare module './ambient' { import x from './ambient-import'; export = x; }",
            "import type Legacy = require('./type-require');",
            'export type Both = Module | Legacy | typeof ambient;',
            "// import x from './line-comment'",
            "/* import './block-comment'; */",
            "export const text = \"import x from './string'; import('./string-dynamic')\";",
            "export const template = `export * from './template-text'`;",
            "export * from './star';",
            "export * as namespace from './star-as';",
            "import Default, { type Typed } from './default-and-type';",
            "import * as All from './namespace';",
            "import Old = require('./require-equals');",
            "const required = require('./required');",
            'export const later = () => import(`./template-dynamic`);',
            'export const used = [Default, All, Old, required];',
            'export type Kept = Typed;',
        ].join('\n');
        expect(parseImports(source, 'syntax.ts')).toEqual([
            { specifier: './star', isDynamic: false },
            { specifier: './star-as', isDynamic: false },
            { specifier: './default-and-type', isDynamic: false },
            { specifier: './namespace', isDynamic: false },
            { specifier: './require-equals', isDynamic: false },
            { specifier: './required', isDynamic: false },
            { specifier: './template-dynamic', isDynamic: true },
        ]);
    });

    it('reads an import() or require() name as Metro does, and throws on one it can’t compute', () => {
        const source = [
            "const LAZY = './constant';",
            'export const a = () => import(LAZY);',
            "export const b = () => import('./su' + 'm');",
            "export const c = () => import(`./templ${'ate'}`);",
            "const name = './required-constant';",
            'export const d = require(name);',
        ].join('\n');
        expect(parseImports(source, 'computed.ts')).toEqual([
            { specifier: './constant', isDynamic: true },
            { specifier: './sum', isDynamic: true },
            { specifier: './template', isDynamic: true },
            { specifier: './required-constant', isDynamic: false },
        ]);
        // Metro rejects a name it can't compute in the app's code; this throws on more (a cast).
        for (const unknown of [
            'export const load = (name: string) => import(name);',
            'export const load = (name: string) => require(name);',
            "const NAME = './x' as const;\nexport const load = () => import(NAME);",
        ]) {
            expect(() => parseImports(unknown, 'unknown.ts'), unknown).toThrow(
                /^unknown\.ts:\d: an import\(\) or require\(\) of a name the graph can't compute$/,
            );
        }
        // A call to a `require` the file declares loads nothing, as in Metro.
        expect(
            parseImports(
                'const require = (name: string) => name;\nexport const id = (name: string) => require(name);',
                'local.ts',
            ),
        ).toEqual([]);
    });

    it('parses each file as Metro does: JSX in .tsx files only', () => {
        expect(parseImports("export const Row = () => <View onPress={() => import('./tap')} />;", 'row.tsx')).toEqual([
            { specifier: './tap', isDynamic: true },
        ]);
        // In a .ts file, `<T>value` is a type assertion, and JSX doesn't parse.
        expect(parseImports("export const n = <number>(require('./cast') as unknown);", 'cast.ts')).toEqual([
            { specifier: './cast', isDynamic: false },
        ]);
        expect(() => parseImports('export const Row = () => <View />;', 'row.ts')).toThrow(SyntaxError);
    });
});
