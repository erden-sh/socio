// The server's features import each other's contracts only
// (scripts/check-feature-boundaries.mjs).
// The first tests run the guard on the real tree and its baseline, and hold the
// baseline against main's; the rest plant one violation each in a small tree.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    ALLOWED_UNREAD,
    BASELINE,
    baselineProblems,
    CONTRACT_TYPE_IMPORTS,
    ENTRY_FILES,
    ENTRY_PREFIXES,
    formatBaseline,
    historyKey,
    historyProblems,
    isEntry,
    measure,
    parseRanks,
    rankReport,
    RANKS,
    RUN_ENTRY_FILES,
    runtimeProblems,
    runtimeReport,
    readBaseline,
    readRanks,
    referenceBaseline,
    RESOLUTION,
    ruleProblems,
    serverGraph,
    type Baseline,
    type ServerGraph,
} from '../scripts/check-feature-boundaries.mjs';

const root = join(import.meta.dirname, '..');

describe('the server', () => {
    const graph = serverGraph(root);
    const current = measure(graph);

    it('breaks none of rules 2, 3 and 4, and every import resolves', () => {
        expect(ruleProblems(graph)).toEqual([]);
    });

    it('matches its baseline: no new rule 1 import, no stale entry, no number above it', () => {
        expect(baselineProblems(current, readBaseline(root))).toEqual([]);
    });

    it('keeps the baseline file as the guard writes it', () => {
        const baseline = readBaseline(root);
        expect(formatBaseline(baseline)).toBe(formatBaseline({ ...baseline, contractOnly: current.contractOnly }));
    });

    it("adds nothing to main's baseline and raises none of its numbers", (context) => {
        const reference = referenceBaseline(root);
        if (!reference.baseline) {
            context.skip(`not held against main: ${reference.skip}`);
            return;
        }
        expect(historyProblems(readBaseline(root), reference.baseline)).toEqual([]);
    });

    it('has a rank file the guard reads, and a report that accounts for every import between features', () => {
        const { order } = readRanks(root);
        const report = rankReport(graph, order);
        const between = graph.edges.filter(
            ({ from, to }) => !isEntry(from) && from.split('/')[0] !== to.split('/')[0],
        ).length;
        expect(report.up.length + report.down + report.unrankedImports).toBe(between);
    });
});

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const step of cleanup.splice(0)) {
        step();
    }
});

const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'feature-boundaries-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

/** Writes files under `dir`, relative to it. */
const write = (dir: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
    }
};

/**
 * Two features and a composition root, within the rules: pages reads issues'
 * contract, the root wires issues' layer.
 */
const CLEAN = {
    'src/server/index.ts': "import { IssuesLive } from './issues/layer.js';\nimport './modules/boot.js';\n",
    'src/server/modules/boot.ts': "import { IssuesLive } from '../issues/layer.js';\n",
    'src/server/issues/contract.ts':
        "import { Context } from 'effect';\nimport type { Id } from '@socio/shared/ids';\nexport interface Issue { id: string }\n",
    'src/server/issues/layer.ts': "import type { Issue } from './contract.js';\nimport { board } from './board.js';\n",
    'src/server/issues/board.ts': "import type { Issue } from './contract.js';\nexport const board = 1;\n",
    'src/server/pages/contract.ts': 'export interface Page { id: string }\n',
    'src/server/pages/moves.ts': "import type { Issue } from '../issues/contract.js';\nexport const moves = 1;\n",
};

const NO_BASELINE: Baseline = {
    numbers: { largestFileScc: 0, largestCrossFeatureScc: 0, largestFeatureScc: 0 },
    contractOnly: [],
};

/** A tree with the clean files plus `extra`, and its graph. */
function plant(extra: Record<string, string> = {}): { dir: string; graph: ServerGraph } {
    const dir = temp();
    write(dir, { ...CLEAN, ...extra });
    return { dir, graph: serverGraph(dir, []) };
}

/** Everything the guard says about a tree, against a baseline. */
const problems = (graph: ServerGraph, baseline: Baseline = NO_BASELINE) => [
    ...ruleProblems(graph),
    ...baselineProblems(measure(graph), baseline),
];

describe('the guard', () => {
    it('passes the clean tree', () => {
        const { graph } = plant();
        expect(problems(graph)).toEqual([]);
        expect(graph.files).toHaveLength(Object.keys(CLEAN).length);
    });

    // Every way a server file can name another module, one per line: each one
    // must reach the graph (here, as a rule 1 import of issues/<name>.ts).
    const FORMS: [string, string][] = [
        ['side-effect import', "import '../issues/{}.js';"],
        ['import from', "import { x } from '../issues/{}.js';"],
        ['import type', "import type { T } from '../issues/{}.js';"],
        ['export from', "export { x } from '../issues/{}.js';"],
        ['export * from', "export * from '../issues/{}.js';"],
        ['export type from', "export type { T } from '../issues/{}.js';"],
        ['import x = require()', "import e = require('../issues/{}.js');"],
        ['require()', "const r = require('../issues/{}.js');"],
        ['require.resolve()', "const r = require.resolve('../issues/{}.js');"],
        ['import()', "const g = await import('../issues/{}.js');"],
        ['import() of a template literal', 'const g = await import(`../issues/{}.js`);'],
        [
            'import() under as, satisfies, ! and ( )',
            "const g = await import((('../issues/{}.js' as string)! satisfies string));",
        ],
        ["an import('...') type", "type F = import('../issues/{}.js').F;"],
        ["typeof import('...')", "type F = typeof import('../issues/{}.js');"],
        ['import.meta.resolve()', "const u = import.meta.resolve('../issues/{}.js');"],
        ['new URL(..., import.meta.url)', "const w = new URL('../issues/{}.js', import.meta.url);"],
        ['declare module', "declare module '../issues/{}.js' { interface Extra { y: number } }"],
        ['/// <reference path>', '/// <reference path="../issues/{}.ts" />'],
    ];

    it.each(FORMS.map(([form, line], at) => [form, line, `f${at}`]))('reads %s', (_form, line, name) => {
        const { graph } = plant({
            'src/server/pages/all.ts': `${line.replace('{}', name)}\nexport {};\n`,
            [`src/server/issues/${name}.ts`]: 'export const x = 1;\nexport type T = 1;\nexport type F = 1;\n',
        });
        expect(ruleProblems(graph)).toEqual([]);
        expect(measure(graph).contractOnly).toEqual([`pages/all.ts -> issues/${name}.ts`]);
    });

    it('reads /// <reference types> as a package, which a contract may not use', () => {
        const { graph } = plant({ 'src/server/issues/contract.ts': '/// <reference types="node" />\nexport {};\n' });
        expect(ruleProblems(graph)).toEqual([
            'issues/contract.ts:1: node (rule 4: a contract imports only effect, @socio/* and, with import type, node:*, hono, @copilotkit/runtime/v2, @ag-ui/*, @tanstack/ai, drizzle-orm, @modelcontextprotocol/sdk/*)',
        ]);
    });

    it('reads nothing in a comment or a string', () => {
        const { graph } = plant({
            'src/server/pages/all.ts': [
                "// import '../issues/board.js';",
                "/* await import('../issues/board.js') */",
                'const text = "import \'../issues/board.js\'";',
                "const call = `require('../issues/board.js')`;",
            ].join('\n'),
        });
        expect(problems(graph)).toEqual([]);
        expect(measure(graph).contractOnly).toEqual([]);
    });

    it('fails every reference whose target it cannot read, with the file and line', () => {
        const { graph } = plant({
            'src/server/issues/contract.ts': "export const fs = await import('node:fs' as string);\n",
            'src/server/pages/all.ts': [
                "const p = '../issues/board.js';",
                'await import(p);',
                "await import('../issues/' + 'board.js');",
                'await import(`../issues/${p}`);',
                'require(p);',
                'require.resolve(p);',
                'import.meta.resolve(p);',
                "new URL('./' + p, import.meta.url);",
                "import { createRequire } from 'node:module';",
                'const glob = import.meta.glob;',
                "await import('/abs/board.js');",
                "await import('file:///abs/board.js');",
            ].join('\n'),
        });
        const why = "(the guard can't classify it, so it fails)";
        expect(ruleProblems(graph)).toEqual([
            `pages/all.ts:2: import() with an argument that isn't a string literal ${why}`,
            `pages/all.ts:3: import() with an argument that isn't a string literal ${why}`,
            `pages/all.ts:4: import() with an argument that isn't a string literal ${why}`,
            `pages/all.ts:5: require() with an argument that isn't a string literal ${why}`,
            `pages/all.ts:6: require.resolve() with an argument that isn't a string literal ${why}`,
            `pages/all.ts:7: import.meta.resolve() with an argument that isn't a string literal ${why}`,
            `pages/all.ts:8: new URL(..., import.meta.url) with an argument that isn't a string literal ${why}`,
            `pages/all.ts:9: createRequire: the guard can't follow a require it makes ${why}`,
            `pages/all.ts:10: import.meta.glob: the guard reads only url, dirname, filename, main and a call of resolve ${why}`,
            `pages/all.ts:11: /abs/board.js: an absolute path or URL the guard doesn't follow ${why}`,
            `pages/all.ts:12: file:///abs/board.js: an absolute path or URL the guard doesn't follow ${why}`,
            'issues/contract.ts:1: node:fs (rule 4: a contract imports node:fs only with import type)',
        ]);
    });

    // Disguised references (fourth review): each is read through its wrapping, or fails.
    it("reads (require)(...), import.meta['resolve'](...) and new URL(..., (import.meta.url))", () => {
        const { graph } = plant({
            'src/server/pages/all.ts': [
                "const a = (require)('../issues/a.js');",
                "const b = (0, require)('../issues/b.js');",
                "const c = import.meta['resolve']('../issues/c.js');",
                "const d = new URL('../issues/d.js', (import.meta.url));",
                "const e = new URL('../issues/e.js', import.meta['url'] as string);",
                "const f = await (import('../issues/f.js'));",
            ].join('\n'),
            ...Object.fromEntries(
                ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [`src/server/issues/${name}.ts`, 'export const x = 1;\n']),
            ),
        });
        expect(ruleProblems(graph)).toEqual([]);
        expect(measure(graph).contractOnly).toEqual(
            ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `pages/all.ts -> issues/${name}.ts`),
        );
    });

    it('fails require, module, createRequire and import.meta used any way it does not read', () => {
        const { graph } = plant({
            'src/server/pages/all.ts': [
                "import * as nodeModule from 'node:module';",
                'const { createRequire } = nodeModule;',
                "const load = nodeModule['createRequire'](import.meta.url);",
                'const r = require;',
                'const m = module;',
                'const meta = import.meta;',
                'const resolveIt = import.meta.resolve;',
                "const c = (import.meta)['resolve'];",
            ].join('\n'),
        });
        const why = "(the guard can't classify it, so it fails)";
        const loader = (name: string) => `${name}: used other than as a call the guard reads, so it can't follow it`;
        const meta = 'the guard reads only url, dirname, filename, main and a call of resolve';
        expect(ruleProblems(graph)).toEqual([
            `pages/all.ts:2: createRequire: the guard can't follow a require it makes ${why}`,
            `pages/all.ts:3: createRequire: the guard can't follow a require it makes ${why}`,
            `pages/all.ts:4: ${loader('require')} ${why}`,
            `pages/all.ts:5: ${loader('module')} ${why}`,
            `pages/all.ts:6: import.meta: ${meta} ${why}`,
            `pages/all.ts:7: import.meta.resolve: ${meta} ${why}`,
            `pages/all.ts:8: import.meta.resolve: ${meta} ${why}`,
        ]);
    });

    it('lets a file use its own require and module, and members of that name', () => {
        const { graph } = plant({
            'src/server/pages/all.ts': [
                'export class Board { require(n: number) { return n; } }',
                'export const board = new Board();',
                'board.require(1);',
                'for (const module of [board]) { module.require(2); }',
                'const issues = { require: (n: number) => n };',
                'issues.require(3);',
            ].join('\n'),
        });
        expect(ruleProblems(graph)).toEqual([]);
    });

    // new URL(spec, import.meta.url) follows URL rules (fifth review): a bare name is relative to the file.
    describe('new URL(..., import.meta.url)', () => {
        const started = (spec: string, extra: Record<string, string> = {}) =>
            plant({
                'src/server/pages/start.ts': `export const at = new URL('${spec}', import.meta.url);\n`,
                ...extra,
            });
        const why = "(the guard can't classify it, so it fails)";

        it('reads a bare name as the file beside it: a worker', () => {
            const { graph } = started('worker.js', { 'src/server/pages/worker.ts': 'export {};\n' });
            expect(ruleProblems(graph)).toEqual([]);
            expect(graph.edges).toContainEqual({ from: 'pages/start.ts', to: 'pages/worker.ts', spawn: true });
        });

        it('reads a bare name as the file beside it: a layer, which rule 3 fails', () => {
            const { graph } = started('layer.js', { 'src/server/pages/layer.ts': 'export {};\n' });
            expect(ruleProblems(graph)).toEqual([
                'pages/start.ts -> pages/layer.ts (rule 3: only entry files and tests import a layer.ts)',
            ]);
        });

        it('fails a bare name that names no file', () => {
            expect(ruleProblems(started('gone.js').graph)).toEqual(['pages/start.ts:1: gone.js (names no file)']);
        });

        it('reads ../ into another feature, and leaves what is outside src/server out of the graph', () => {
            const { graph } = started('../issues/board.js');
            expect(measure(graph).contractOnly).toEqual(['pages/start.ts -> issues/board.ts']);
            const outside = started('../../../docs/NOTES.md');
            expect(ruleProblems(outside.graph)).toEqual([]);
            expect(outside.graph.edges.filter(({ from }) => from === 'pages/start.ts')).toEqual([]);
        });

        it('reads an absolute path as a file: URL, inside src/server or out', () => {
            const outside = started('/nowhere/worker.js');
            expect(ruleProblems(outside.graph)).toEqual([]);
            const dir = temp();
            write(dir, {
                ...CLEAN,
                'src/server/pages/start.ts': `export const at = new URL('${join(dir, 'src/server/issues/board.js')}', import.meta.url);\n`,
            });
            expect(measure(serverGraph(dir, [])).contractOnly).toEqual(['pages/start.ts -> issues/board.ts']);
        });

        it('fails a URL with another scheme', () => {
            expect(ruleProblems(started('https://example.invalid/worker.js').graph)).toEqual([
                `pages/start.ts:1: https://example.invalid/worker.js: a https: URL the guard doesn't follow ${why}`,
            ]);
            expect(ruleProblems(started('data:text/javascript,export{}').graph)).toEqual([
                `pages/start.ts:1: data:text/javascript,export{}: a data: URL the guard doesn't follow ${why}`,
            ]);
        });

        it('leaves import() and require() on module rules: a bare name there is a package', () => {
            const { graph } = plant({
                'src/server/pages/start.ts': "await import('worker.js');\nrequire('layer.js');\n",
                'src/server/pages/worker.ts': 'export {};\n',
                'src/server/pages/layer.ts': 'export {};\n',
            });
            expect(ruleProblems(graph)).toEqual([]);
            expect(graph.packages.get('pages/start.ts')).toEqual([
                { specifier: 'worker.js', line: 1, typeOnly: false },
                { specifier: 'layer.js', line: 2, typeOnly: false },
            ]);
        });
    });

    it('allows an unread reference only by file and exact code, and fails an entry that matches nothing', () => {
        const allowed = [{ file: 'web/prod.ts', code: 'import(pathToFileURL(file).href)', why: 'the page build' }];
        const prod = [
            "import { pathToFileURL } from 'node:url';",
            "const file = '/x';",
            '',
            'const build = await import( pathToFileURL(file).href );',
        ].join('\n');
        const why = "(the guard can't classify it, so it fails)";
        // Matched wherever it sits, whitespace aside.
        expect(ruleProblems(serverGraph(plant({ 'src/server/web/prod.ts': prod }).dir, allowed))).toEqual([]);
        // Another unread reference in the same file, or the same code in another file, still fails.
        const more = plant({
            'src/server/web/prod.ts': `${prod}\nconst other = await import(file);\n`,
            'src/server/web/dev.ts':
                "import { pathToFileURL } from 'node:url';\nconst file = '/x';\nawait import(pathToFileURL(file).href);\n",
        });
        expect(ruleProblems(serverGraph(more.dir, allowed))).toEqual([
            `web/dev.ts:3: import() with an argument that isn't a string literal ${why}`,
            `web/prod.ts:5: import() with an argument that isn't a string literal ${why}`,
        ]);
        // Gone from the code: the entry fails, so it can't go stale.
        expect(ruleProblems(serverGraph(plant().dir, allowed))).toEqual([
            `web/prod.ts: import(pathToFileURL(file).href): allowed (the page build), but nothing matches it: remove the entry ${why}`,
        ]);
        // The real list holds exactly the one entry.
        expect(ALLOWED_UNREAD).toEqual([
            {
                file: 'web/prod.ts',
                code: 'import(pathToFileURL(file).href)',
                why: 'loads the React Router page build from outside src/server',
            },
        ]);
    });

    it('resolves .jsx, .js, .mjs and .cjs the way TypeScript does: sources before declarations', () => {
        const resolved = (files: Record<string, string>, specifier: string) =>
            serverGraph(plant({ ...files, 'src/server/pages/all.ts': `import '../issues/${specifier}';\n` }).dir, [])
                .edges.filter(({ from }) => from === 'pages/all.ts')
                .map(({ to }) => to);
        const x = 'export const x = 1;\n';
        expect(resolved({ 'src/server/issues/m.ts': x }, 'm.jsx')).toEqual(['issues/m.ts']);
        expect(resolved({ 'src/server/issues/m.tsx': x }, 'm.jsx')).toEqual(['issues/m.tsx']);
        expect(resolved({ 'src/server/issues/m.d.ts': x }, 'm.jsx')).toEqual(['issues/m.d.ts']);
        expect(resolved({ 'src/server/issues/m.ts': x, 'src/server/issues/m.d.ts': x }, 'm.js')).toEqual([
            'issues/m.ts',
        ]);
        expect(resolved({ 'src/server/issues/m.tsx': x, 'src/server/issues/m.d.ts': x }, 'm.jsx')).toEqual([
            'issues/m.tsx',
        ]);
        expect(resolved({ 'src/server/issues/m.mts': x, 'src/server/issues/m.d.mts': x }, 'm.mjs')).toEqual([
            'issues/m.mts',
        ]);
        expect(resolved({ 'src/server/issues/m.d.mts': x }, 'm.mjs')).toEqual(['issues/m.d.mts']);
        expect(resolved({ 'src/server/issues/m.d.cts': x }, 'm.cjs')).toEqual(['issues/m.d.cts']);
    });

    it("resolves with tsconfig.server.json's module settings", () => {
        const config = JSON.parse(readFileSync(join(root, 'tsconfig.server.json'), 'utf8')) as {
            compilerOptions: Record<string, unknown>;
        };
        expect(config.compilerOptions.module).toBe('NodeNext');
        expect(config.compilerOptions.moduleResolution).toBe('NodeNext');
        expect(config.compilerOptions.rewriteRelativeImportExtensions).toBe(true);
        expect(config.compilerOptions.paths).toEqual({});
        expect(RESOLUTION).toMatchObject({ rewriteRelativeImportExtensions: true, allowImportingTsExtensions: true });
        // A .ts file is an ES module: the root package is.
        expect((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { type: string }).type).toBe('module');
    });

    it('lets a worker or child process started by URL be an entry file, but not an import of one', () => {
        const started = plant({ 'src/server/modules/fork.ts': "const w = new URL('./boot.js', import.meta.url);\n" });
        expect(ruleProblems(started.graph)).toEqual([]);
        const both = plant({
            'src/server/modules/fork.ts': "const w = new URL('./boot.js', import.meta.url);\nimport './boot.js';\n",
        });
        expect(ruleProblems(both.graph)).toEqual([
            'modules/fork.ts -> modules/boot.ts (rule 2: only entry files import an entry file)',
        ]);
    });

    it('fails an import that names no file', () => {
        const { graph } = plant({ 'src/server/pages/lost.ts': "import { x } from './nowhere.js';\n" });
        expect(problems(graph)).toEqual(['pages/lost.ts:1: ./nowhere.js (names no file)']);
    });

    it('reads .mts and .cts modules, by their emitted or their own extension, and what they import', () => {
        const { graph } = plant({
            'src/server/pages/moves.ts': [
                "import { a } from '../issues/internal.mjs';",
                "import { b } from '../issues/other.mts';",
                "import { c } from '../issues/old.cjs';",
            ].join('\n'),
            'src/server/issues/internal.mts': "import { IssuesLive } from './layer.js';\nexport const a = 1;\n",
            'src/server/issues/other.mts': 'export const b = 1;\n',
            'src/server/issues/old.cts': 'export const c = 1;\n',
        });
        expect(graph.files).toEqual(
            expect.arrayContaining(['issues/internal.mts', 'issues/other.mts', 'issues/old.cts']),
        );
        expect(problems(graph).sort()).toEqual(
            [
                'issues/internal.mts -> issues/layer.ts (rule 3: only entry files and tests import a layer.ts)',
                "pages/moves.ts -> issues/internal.mts (rule 1: imports another feature's code, not its contract.ts)",
                "pages/moves.ts -> issues/old.cts (rule 1: imports another feature's code, not its contract.ts)",
                "pages/moves.ts -> issues/other.mts (rule 1: imports another feature's code, not its contract.ts)",
            ].sort(),
        );
    });

    it("fails a contract that imports another feature's declaration file", () => {
        const { graph } = plant({
            'src/server/issues/contract.ts': [
                "import type { Page } from '../pages/types.js';",
                "import type { Move } from '../pages/moves-types.mjs';",
            ].join('\n'),
            'src/server/pages/types.d.ts': 'export interface Page { id: string }\n',
            'src/server/pages/moves-types.d.mts': 'export interface Move { id: string }\n',
        });
        expect(problems(graph).sort()).toEqual(
            [
                'issues/contract.ts -> pages/moves-types.d.mts (rule 4: a contract imports only other contracts)',
                'issues/contract.ts -> pages/types.d.ts (rule 4: a contract imports only other contracts)',
                "issues/contract.ts -> pages/moves-types.d.mts (rule 1: imports another feature's code, not its contract.ts)",
                "issues/contract.ts -> pages/types.d.ts (rule 1: imports another feature's code, not its contract.ts)",
                // pages already reads issues' contract, so issues and pages now form a feature cycle.
                "largestFeatureScc is 2, above the baseline's 0 (rule 5)",
            ].sort(),
        );
    });

    it('fails an import of a file in the server that is not a TypeScript module, rather than drop it', () => {
        const { graph } = plant({
            'src/server/pages/moves.ts': [
                "import data from './data.json' with { type: 'json' };",
                "import { legacy } from '../issues/legacy.js';",
            ].join('\n'),
            'src/server/pages/data.json': '{}\n',
            'src/server/issues/legacy.js': 'export const legacy = 1;\n',
        });
        const why = '(not a TypeScript module the guard reads: .ts, .tsx, .mts, .cts or a .d.ts)';
        expect(ruleProblems(graph)).toEqual([
            `pages/moves.ts:1: ./data.json -> pages/data.json ${why}`,
            `pages/moves.ts:2: ../issues/legacy.js -> issues/legacy.js ${why}`,
        ]);
    });

    it("rule 1: fails a non-contract import of another feature's code", () => {
        const { graph } = plant({ 'src/server/pages/moves.ts': "import { board } from '../issues/board.js';\n" });
        expect(problems(graph)).toEqual([
            "pages/moves.ts -> issues/board.ts (rule 1: imports another feature's code, not its contract.ts)",
        ]);
        // Nested contracts aren't the feature's contract; the feature's own code is free.
        const nested = plant({
            'src/server/issues/domain/contract.ts': 'export const y = 1;\n',
            'src/server/issues/board.ts': "import { y } from './domain/contract.js';\n",
            'src/server/pages/moves.ts': "import { y } from '../issues/domain/contract.js';\n",
        });
        expect(problems(nested.graph)).toEqual([
            "pages/moves.ts -> issues/domain/contract.ts (rule 1: imports another feature's code, not its contract.ts)",
        ]);
    });

    it('rule 1: passes an import the baseline lists, and fails the entry once the import is gone', () => {
        const { graph } = plant({ 'src/server/pages/moves.ts': "import { board } from '../issues/board.js';\n" });
        const listed = { ...NO_BASELINE, contractOnly: ['pages/moves.ts -> issues/board.ts'] };
        expect(problems(graph, listed)).toEqual([]);
        expect(problems(plant().graph, listed)).toEqual([
            'pages/moves.ts -> issues/board.ts (stale baseline entry: the import is gone, so remove the entry)',
        ]);
    });

    it('rule 2: fails a non-entry file importing an entry file, in its own feature too', () => {
        const { graph } = plant({
            'src/server/modules/registry.ts': "import { x } from './boot.js';\n",
        });
        expect(ruleProblems(graph)).toEqual([
            'modules/registry.ts -> modules/boot.ts (rule 2: only entry files import an entry file)',
        ]);
        // Entry files import each other freely.
        expect(ruleProblems(plant().graph)).toEqual([]);
    });

    it("rule 3: fails a feature importing another's layer.ts, or its own", () => {
        const { graph } = plant({
            'src/server/pages/moves.ts': "import { IssuesLive } from '../issues/layer.js';\n",
            'src/server/issues/board.ts': "import { IssuesLive } from './layer.js';\n",
        });
        expect(ruleProblems(graph)).toEqual([
            'issues/board.ts -> issues/layer.ts (rule 3: only entry files and tests import a layer.ts)',
            'pages/moves.ts -> issues/layer.ts (rule 3: only entry files and tests import a layer.ts)',
        ]);
    });

    it('rule 4: fails a contract importing feature code or another package', () => {
        const { graph } = plant({
            'src/server/issues/contract.ts': [
                "import { Context } from 'effect';",
                "import { Schema } from 'effect/Schema';",
                "import type { Id } from '@socio/shared/ids';",
                "import type { Page } from '../pages/contract.js';",
                "import { board } from './board.js';",
                "import type { Moves } from '../pages/moves.js';",
                "import { z } from 'zod';",
                "import { readFileSync } from 'node:fs';",
            ].join('\n'),
        });
        expect(ruleProblems(graph).sort()).toEqual(
            [
                'issues/contract.ts -> issues/board.ts (rule 4: a contract imports only other contracts)',
                'issues/contract.ts -> pages/moves.ts (rule 4: a contract imports only other contracts)',
                'issues/contract.ts:7: zod (rule 4: a contract imports only effect, @socio/* and, with import type, node:*, hono, @copilotkit/runtime/v2, @ag-ui/*, @tanstack/ai, drizzle-orm, @modelcontextprotocol/sdk/*)',
                'issues/contract.ts:8: node:fs (rule 4: a contract imports node:fs only with import type)',
            ].sort(),
        );
    });

    it('rule 4: fails contracts that import each other in a cycle', () => {
        const { graph } = plant({
            'src/server/issues/contract.ts': "import type { Page } from '../pages/contract.js';\n",
            'src/server/pages/contract.ts': "import type { Issue } from '../issues/contract.js';\n",
        });
        expect(ruleProblems(graph)).toEqual([
            'issues/contract.ts, pages/contract.ts (rule 4: these contracts import each other in a cycle)',
        ]);
    });

    describe('rule 4: import type from the allowlist', () => {
        const contract = (lines: string[]) =>
            ruleProblems(plant({ 'src/server/issues/contract.ts': `${lines.join('\n')}\nexport {};\n` }).graph);
        const valueOnly = (specifier: string) => `(rule 4: a contract imports ${specifier} only with import type)`;

        it('holds the six shared-vocabulary modules and the MCP SDK', () => {
            expect(CONTRACT_TYPE_IMPORTS).toEqual([
                'node:*',
                'hono',
                '@copilotkit/runtime/v2',
                '@ag-ui/*',
                '@tanstack/ai',
                'drizzle-orm',
                '@modelcontextprotocol/sdk/*',
            ]);
        });

        it('passes every type-only form, for each module on it', () => {
            expect(
                contract([
                    "import type { DatabaseSync } from 'node:sqlite';",
                    "import type { IncomingMessage } from 'node:http';",
                    "import type { Hono } from 'hono';",
                    "export type { ToolDefinition } from '@copilotkit/runtime/v2';",
                    "import type * as Client from '@ag-ui/client';",
                    "export type * from '@ag-ui/core';",
                    "type Message = import('@tanstack/ai').ModelMessage;",
                    "type Orm = typeof import('drizzle-orm');",
                    "import type Default from 'drizzle-orm';",
                    "import type Legacy = require('hono');",
                    "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
                ]),
            ).toEqual([]);
        });

        it('fails a value import from a module on it, however it is written', () => {
            expect(
                contract([
                    "import { Hono } from 'hono';",
                    "import { type Hono as H } from 'hono';",
                    "import 'node:sqlite';",
                    "export { EventType } from '@ag-ui/core';",
                    "export * from '@tanstack/ai';",
                    "export { type ToolDefinition } from '@copilotkit/runtime/v2';",
                    "const orm = await import('drizzle-orm');",
                    "import Legacy = require('hono');",
                    "declare module 'hono' { interface Extra { y: number } }",
                ]),
            ).toEqual([
                `issues/contract.ts:1: hono ${valueOnly('hono')}`,
                `issues/contract.ts:2: hono ${valueOnly('hono')}`,
                `issues/contract.ts:3: node:sqlite ${valueOnly('node:sqlite')}`,
                `issues/contract.ts:4: @ag-ui/core ${valueOnly('@ag-ui/core')}`,
                `issues/contract.ts:5: @tanstack/ai ${valueOnly('@tanstack/ai')}`,
                `issues/contract.ts:6: @copilotkit/runtime/v2 ${valueOnly('@copilotkit/runtime/v2')}`,
                `issues/contract.ts:7: drizzle-orm ${valueOnly('drizzle-orm')}`,
                `issues/contract.ts:8: hono ${valueOnly('hono')}`,
                `issues/contract.ts:9: hono ${valueOnly('hono')}`,
            ]);
        });

        it('matches each module whole: a subpath, a neighbor or a bare builtin is not on it', () => {
            const lines = [
                'hono/jsx',
                'honox',
                '@copilotkit/runtime',
                '@copilotkit/runtime/v2/extra',
                '@ag-ui',
                '@ag-uix/core',
                '@tanstack/ai-react',
                '@tanstack/ai/adapters',
                'drizzle-orm/sqlite-core',
                '@modelcontextprotocol/sdk',
                '@modelcontextprotocol/sdkx/server',
                'fs',
                'zod',
            ];
            expect(contract(lines.map((specifier) => `import type { T } from '${specifier}';`))).toEqual(
                lines.map(
                    (specifier, at) =>
                        `issues/contract.ts:${at + 1}: ${specifier} (rule 4: a contract imports only effect, @socio/* and, with import type, node:*, hono, @copilotkit/runtime/v2, @ag-ui/*, @tanstack/ai, drizzle-orm, @modelcontextprotocol/sdk/*)`,
                ),
            );
        });

        it('reads /// <reference types> as no type-only import', () => {
            expect(contract(['/// <reference types="hono" />'])).toEqual([
                `issues/contract.ts:1: hono ${valueOnly('hono')}`,
            ]);
        });

        it('leaves files that are not contracts alone', () => {
            const { graph } = plant({
                'src/server/issues/board.ts':
                    "import { Hono } from 'hono';\nimport { z } from 'zod';\nexport const board = 1;\n",
            });
            expect(ruleProblems(graph)).toEqual([]);
        });
    });

    describe('the composition folder', () => {
        it('is entry code: every file under src/server/composition/, at any depth', () => {
            expect(ENTRY_PREFIXES).toEqual(['composition/']);
            for (const file of ['composition/index.ts', 'composition/issues.ts', 'composition/http/issues.ts']) {
                expect(isEntry(file)).toBe(true);
            }
            // Only the top-level folder: not a feature's own composition/, not a root-level file.
            for (const file of [
                'issues/composition/board.ts',
                'composition.ts',
                'compositions/x.ts',
                'Composition/x.ts',
            ]) {
                expect(isEntry(file)).toBe(false);
            }
        });

        it("imports any feature's code and layer, and adds no rule 1 import or feature edge", () => {
            const { graph } = plant({
                'src/server/composition/issues.ts':
                    "import { IssuesLive } from '../issues/layer.js';\nimport { board } from '../issues/board.js';\nimport { moves } from '../pages/moves.js';\n",
                'src/server/composition/http/pages.ts':
                    "import { moves } from '../../pages/moves.js';\nimport '../issues.js';\nimport '../../index.js';\n",
            });
            expect(problems(graph)).toEqual([]);
            expect(measure(graph).contractOnly).toEqual([]);
        });

        it('is no back door: a feature importing a composition file fails rule 2', () => {
            const { graph } = plant({
                'src/server/composition/issues.ts':
                    "import { board } from '../issues/board.js';\nexport const wired = 1;\n",
                'src/server/pages/moves.ts':
                    "import { wired } from '../composition/issues.js';\nexport const moves = 1;\n",
            });
            expect(ruleProblems(graph)).toEqual([
                'pages/moves.ts -> composition/issues.ts (rule 2: only entry files import an entry file)',
            ]);
        });

        it("doesn't stretch to a feature's own composition folder or a root-level composition.ts", () => {
            const { graph } = plant({
                'src/server/pages/composition/wire.ts': "import { board } from '../../issues/board.js';\n",
                'src/server/composition.ts': "import { IssuesLive } from './issues/layer.js';\n",
            });
            expect(problems(graph).sort()).toEqual(
                [
                    'composition.ts -> issues/layer.ts (rule 3: only entry files and tests import a layer.ts)',
                    "composition.ts -> issues/layer.ts (rule 1: imports another feature's code, not its contract.ts)",
                    "pages/composition/wire.ts -> issues/board.ts (rule 1: imports another feature's code, not its contract.ts)",
                ].sort(),
            );
        });
    });

    it('rule 5: fails each number that rises above the baseline', () => {
        // A two-file cycle inside issues: only the file SCC rises.
        const inside = plant({
            'src/server/issues/a.ts': "import { b } from './b.js';\nexport const a = 1;\n",
            'src/server/issues/b.ts': "import { a } from './a.js';\nexport const b = 1;\n",
        });
        expect(measure(inside.graph).numbers).toEqual({
            largestFileScc: 2,
            largestCrossFeatureScc: 0,
            largestFeatureScc: 0,
        });
        expect(baselineProblems(measure(inside.graph), NO_BASELINE)).toEqual([
            "largestFileScc is 2, above the baseline's 0 (rule 5)",
        ]);
        // A cycle across issues and pages, through code (listed, so rule 1 is quiet): all three rise.
        const across = plant({
            'src/server/issues/board.ts': "import { moves } from '../pages/moves.js';\nexport const board = 1;\n",
            'src/server/pages/moves.ts': "import { board } from '../issues/board.js';\nexport const moves = 1;\n",
        });
        const listed = {
            ...NO_BASELINE,
            contractOnly: ['issues/board.ts -> pages/moves.ts', 'pages/moves.ts -> issues/board.ts'],
        };
        expect(baselineProblems(measure(across.graph), listed)).toEqual([
            "largestFileScc is 2, above the baseline's 0 (rule 5)",
            "largestCrossFeatureScc is 2, above the baseline's 0 (rule 5)",
            "largestFeatureScc is 2, above the baseline's 0 (rule 5)",
        ]);
        // At the recorded numbers it passes; an entry file's edges don't make a feature cycle.
        expect(
            baselineProblems(measure(across.graph), {
                ...listed,
                numbers: { largestFileScc: 2, largestCrossFeatureScc: 2, largestFeatureScc: 2 },
            }),
        ).toEqual([]);
        const entry = plant({ 'src/server/issues/board.ts': "import { x } from '../index.js';\n" });
        expect(measure(entry.graph).numbers.largestFeatureScc).toBe(0);
    });
});

describe("the baseline against main's", () => {
    const GIT_ENV = {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (dir: string, ...args: string[]) =>
        execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
            env: GIT_ENV,
            encoding: 'utf8',
        }).trim();
    const commit = (dir: string, message: string) => {
        git(dir, 'add', '-A');
        git(dir, 'commit', '--quiet', '-m', message);
        return git(dir, 'rev-parse', 'HEAD');
    };
    const MAIN_BASELINE: Baseline = {
        numbers: { largestFileScc: 2, largestCrossFeatureScc: 2, largestFeatureScc: 2 },
        contractOnly: ['pages/moves.ts -> issues/board.ts'],
    };

    /** A repository whose origin/main holds MAIN_BASELINE, on a branch off it. */
    const repository = () => {
        const dir = temp();
        git(dir, 'init', '--quiet');
        write(dir, { ...CLEAN, [BASELINE]: formatBaseline(MAIN_BASELINE) });
        git(dir, 'update-ref', 'refs/remotes/origin/main', commit(dir, 'main'));
        return dir;
    };

    it('fails an entry added in the same change, though the import and baseline agree', () => {
        const dir = repository();
        const added = {
            ...MAIN_BASELINE,
            contractOnly: [...MAIN_BASELINE.contractOnly, 'pages/new.ts -> issues/board.ts'],
        };
        write(dir, {
            'src/server/pages/new.ts': "import { board } from '../issues/board.js';\n",
            [BASELINE]: formatBaseline(added),
        });
        commit(dir, 'a new exception');
        const reference = referenceBaseline(dir);
        expect(reference.from).toMatch(/^merge base [0-9a-f]{12}$/);
        expect(historyProblems(readBaseline(dir), reference.baseline!)).toEqual([
            "rule 1 has 2 entries in the baseline, above main's 1",
        ]);
    });

    describe('holds rule 1 entries by source feature and target file, not file pair', () => {
        const MAIN: Baseline = {
            numbers: MAIN_BASELINE.numbers,
            contractOnly: ['pages/moves.ts -> issues/board.ts', 'rooms/notices.ts -> apps/service.ts'],
        };
        const branch = (...contractOnly: string[]) => historyProblems({ ...MAIN, contractOnly }, MAIN);
        const added = (key: string, entry: string) =>
            `${key} (rule 1: main's baseline has no file of ${key.split(' -> ')[0]} importing it; added: ${entry})`;

        it('keys an entry by its source feature, a root-level file being its own, and its target file', () => {
            expect(historyKey('pages/moves/split.ts -> issues/board/columns.ts')).toBe(
                'pages -> issues/board/columns.ts',
            );
            expect(historyKey('access.ts -> issues/board.ts')).toBe('access.ts -> issues/board.ts');
            expect(historyKey('not a pair')).toBe('not a pair');
        });

        it('passes an entry moved to another file in its source feature', () => {
            expect(branch('pages/moves/split.ts -> issues/board.ts', 'rooms/notices.ts -> apps/service.ts')).toEqual(
                [],
            );
        });

        it('passes a split where two files of the source feature import the same target', () => {
            expect(branch('pages/moves/a.ts -> issues/board.ts', 'pages/moves/b.ts -> issues/board.ts')).toEqual([]);
        });

        it('fails a target moved inside its feature: a known limit, it looks like a new target', () => {
            expect(branch('pages/moves.ts -> issues/columns.ts', 'rooms/notices.ts -> apps/service.ts')).toEqual([
                added('pages -> issues/columns.ts', 'pages/moves.ts -> issues/columns.ts'),
            ]);
        });

        it('fails a feature importing a feature it had no entry into', () => {
            expect(branch('pages/moves.ts -> issues/board.ts', 'pages/moves.ts -> apps/service.ts')).toEqual([
                added('pages -> apps/service.ts', 'pages/moves.ts -> apps/service.ts'),
            ]);
        });

        it('fails a new target file in a feature the source feature already imports', () => {
            expect(branch('pages/moves.ts -> issues/board.ts', 'pages/moves.ts -> issues/store.ts')).toEqual([
                added('pages -> issues/store.ts', 'pages/moves.ts -> issues/store.ts'),
            ]);
        });

        it('fails an entry moved to another source feature', () => {
            expect(branch('rooms/moves.ts -> issues/board.ts', 'rooms/notices.ts -> apps/service.ts')).toEqual([
                added('rooms -> issues/board.ts', 'rooms/moves.ts -> issues/board.ts'),
            ]);
        });

        it('fails a total that rises, though every key is on main', () => {
            expect(branch(...MAIN.contractOnly, 'pages/moves/split.ts -> issues/board.ts')).toEqual([
                "rule 1 has 3 entries in the baseline, above main's 2",
            ]);
        });
    });

    it('fails a number raised in the same change, and passes a baseline that only shrinks', () => {
        const dir = repository();
        const raised = { ...MAIN_BASELINE, numbers: { ...MAIN_BASELINE.numbers, largestFeatureScc: 3 } };
        write(dir, { [BASELINE]: formatBaseline(raised) });
        commit(dir, 'a higher number');
        expect(historyProblems(readBaseline(dir), referenceBaseline(dir).baseline!)).toEqual([
            "largestFeatureScc is 3 in the baseline, above main's 2 (rule 5)",
        ]);
        const shrunk = { numbers: { ...MAIN_BASELINE.numbers, largestFileScc: 1 }, contractOnly: [] };
        write(dir, { [BASELINE]: formatBaseline(shrunk) });
        commit(dir, 'fewer exceptions');
        expect(historyProblems(readBaseline(dir), referenceBaseline(dir).baseline!)).toEqual([]);
    });

    it('compares with the merge base, not with a main that moved on', () => {
        const dir = repository();
        const base = git(dir, 'rev-parse', 'HEAD');
        // main drops its exception after the branch left it.
        write(dir, { [BASELINE]: formatBaseline({ ...MAIN_BASELINE, contractOnly: [] }) });
        git(dir, 'update-ref', 'refs/remotes/origin/main', commit(dir, 'main moves on'));
        git(dir, 'checkout', '--quiet', '-b', 'branch', base);
        expect(referenceBaseline(dir).baseline).toEqual(MAIN_BASELINE);
    });

    it('skips, with the reason, when main has no baseline yet or there is no origin/main', () => {
        const dir = temp();
        git(dir, 'init', '--quiet');
        write(dir, CLEAN);
        const sha = commit(dir, 'before the guard');
        expect(referenceBaseline(dir).skip).toMatch(/^no origin\/main here/);
        git(dir, 'update-ref', 'refs/remotes/origin/main', sha);
        expect(referenceBaseline(dir).skip).toBe(`the merge base ${sha.slice(0, 12)} has no ${BASELINE}`);
    });

    it("in CI's copy (no .git): reads what the trusted step placed, and fails when it placed nothing", () => {
        const dir = temp();
        write(dir, CLEAN);
        expect(() => referenceBaseline(dir)).toThrow(/CI's reference step didn't run/);
        write(dir, { '.ci-reference/feature-boundary-baseline.absent': 'abc123\n' });
        expect(referenceBaseline(dir).skip).toBe(`the reference commit abc123 has no ${BASELINE}`);
        write(dir, { '.ci-reference/feature-boundary-baseline.json': formatBaseline(MAIN_BASELINE) });
        expect(referenceBaseline(dir)).toEqual({ baseline: MAIN_BASELINE, from: '.ci-reference/' });
        write(dir, { '.ci-reference/feature-boundary-baseline.json': '{"contractOnly": "everything"}' });
        expect(() => referenceBaseline(dir)).toThrow(/not a feature boundary baseline/);
    });
});

describe('the folder order (reported, not enforced)', () => {
    // CLEAN has pages/moves.ts -> issues/contract.ts; this adds issues -> pages.
    const both = () =>
        plant({
            'src/server/issues/board.ts':
                "import type { Page } from '../pages/contract.js';\nexport const board = 1;\n",
        });

    it('reports each import that points up the order, by file and by feature', () => {
        const { graph } = both();
        expect(rankReport(graph, ['pages', 'issues'])).toEqual({
            up: ['issues/board.ts -> pages/contract.ts'],
            upFeatures: ['issues -> pages'],
            down: 1,
            unrankedImports: 0,
            unranked: [],
            stale: [],
        });
        // The other way round, the other import is the one that points up.
        expect(rankReport(graph, ['issues', 'pages']).up).toEqual(['pages/moves.ts -> issues/contract.ts']);
    });

    it('fails nothing: an up-pointing import changes no rule and no baseline', () => {
        const { graph } = both();
        expect(rankReport(graph, ['pages', 'issues']).up).toHaveLength(1);
        // The two features import each other, which rule 5 already counts; at that number the guard passes.
        const atTwo = { ...NO_BASELINE, numbers: { ...NO_BASELINE.numbers, largestFeatureScc: 2 } };
        expect(problems(graph, atTwo)).toEqual([]);
        expect(formatBaseline(measure(graph))).not.toMatch(/rank|up/i);
    });

    it("leaves out entry files' imports and a feature's own, as the feature SCC does", () => {
        const { graph } = plant({
            'src/server/composition/pages.ts': "import { moves } from '../pages/moves.js';\n",
            'src/server/issues/more.ts': "import { board } from './board.js';\n",
        });
        // index.ts, modules/boot.ts and composition/ hold only entry files: no rank needed.
        expect(rankReport(graph, ['pages', 'issues'])).toMatchObject({ up: [], down: 1, unranked: [] });
    });

    it('counts what it cannot rank, and names unranked features and stale names', () => {
        const { graph } = both();
        expect(rankReport(graph, ['issues', 'gone'])).toEqual({
            up: [],
            upFeatures: [],
            down: 0,
            unrankedImports: 2,
            unranked: ['pages'],
            stale: ['gone'],
        });
    });

    it('reads a rank file, and fails one it cannot read', () => {
        expect(parseRanks('{"$comment": "x", "order": ["pages", "platform-config.ts"]}', RANKS)).toEqual({
            order: ['pages', 'platform-config.ts'],
        });
        for (const text of [
            '[]',
            'null',
            '{}',
            '{"order": "pages"}',
            '{"order": ["pages", "pages"]}',
            '{"order": ["pages/moves.ts"]}',
            '{"order": ["..", "pages"]}',
            '{"order": [""]}',
            '{"order": [1]}',
        ]) {
            expect(() => parseRanks(text, RANKS), text).toThrow(/not a feature rank file/);
        }
        expect(() => parseRanks('{', RANKS)).toThrow();
    });

    describe('in the summary', () => {
        /** A copy of the guard and a small tree, run as CI's copy runs it (no .git, main's baseline absent). */
        const run = (ranks: string | undefined, ...args: string[]) => {
            const { dir } = both();
            mkdirSync(join(dir, 'scripts'), { recursive: true });
            copyFileSync(
                join(root, 'scripts/check-feature-boundaries.mjs'),
                join(dir, 'scripts/check-feature-boundaries.mjs'),
            );
            symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
            const baseline = { ...NO_BASELINE, numbers: { ...NO_BASELINE.numbers, largestFeatureScc: 2 } };
            write(dir, {
                [BASELINE]: formatBaseline(baseline),
                ...(ranks === undefined ? {} : { [RANKS]: ranks }),
                '.ci-reference/feature-boundary-baseline.absent': 'abc123\n',
                // The real guard's one allowed unread reference must match something.
                'src/server/web/prod.ts':
                    "import { pathToFileURL } from 'node:url';\nconst file = '/x';\nawait import(pathToFileURL(file).href);\n",
            });
            return spawnSync(process.execPath, ['scripts/check-feature-boundaries.mjs', ...args], {
                cwd: dir,
                encoding: 'utf8',
            });
        };

        it('prints the count, lists it with --ranks, and still passes', { timeout: 30_000 }, () => {
            const result = run('{"order": ["pages", "issues"]}\n', '--ranks');
            expect(result.stderr).toBe('');
            expect(result.status).toBe(0);
            expect(result.stdout).toContain(
                `folder order (${RANKS}, reported, not enforced): 1 imports point up it (1 feature edges), 1 down, 0 with an unranked end`,
            );
            expect(result.stdout).toContain('  up: issues/board.ts -> pages/contract.ts');
            expect(result.stdout).toContain('feature boundaries passed');
        });

        it('fails when the rank file is missing or unreadable', { timeout: 30_000 }, () => {
            const result = run('{"order": ["pages", "pages"]}\n');
            expect(result.status).not.toBe(0);
            expect(result.stderr).toMatch(/not a feature rank file/);
            const missing = run(undefined);
            expect(missing.status).not.toBe(0);
            expect(missing.stderr).toMatch(/ENOENT.*feature-ranks\.json/);
        });
    });
});

describe('the runtime checks (reported, not enforced)', () => {
    /** Runs a file through the guard as `src/server/<path>`, and returns what it found there. */
    const usesIn = (path: string, text: string) =>
        plant({ [`src/server/${path}`]: text }).graph.runtimeUses.filter(({ file }) => file === path);

    it("finds Effect.run* on the effect package's Effect, however it is imported", () => {
        const uses = usesIn(
            'pages/run.ts',
            [
                "import { Effect, Layer } from 'effect';",
                "import { Effect as E } from 'effect';",
                "import * as Fx from 'effect/Effect';",
                "import * as All from 'effect';",
                "import { runSync, runCallback as cb } from 'effect/Effect';",
                'Effect.runPromise(Effect.void);',
                "E['runFork'](E.void);",
                'Fx.runPromiseExit(Fx.void);',
                'All.Effect.runSyncExit(All.Effect.void);',
                'const later = Promise.resolve(Effect.void).then(Effect.runPromise);',
                'runSync(Fx.void);',
                'cb(Fx.void);',
                'const { runFork: fork } = Effect;',
                '',
            ].join('\n'),
        );
        expect(uses.map(({ line, use }) => `${line}: ${use}`)).toEqual([
            '6: Effect.runPromise',
            '7: Effect.runFork',
            '8: Effect.runPromiseExit',
            '9: Effect.runSyncExit',
            '10: Effect.runPromise',
            '11: Effect.runSync',
            '12: Effect.runCallback',
            '13: Effect.runFork',
        ]);
    });

    it('finds ManagedRuntime.make, however it is imported', () => {
        const uses = usesIn(
            'pages/make.ts',
            [
                "import { Layer, ManagedRuntime } from 'effect';",
                "import * as Runtimes from 'effect/ManagedRuntime';",
                "import { make as makeRuntime } from 'effect/ManagedRuntime';",
                "import * as All from 'effect';",
                'const a = ManagedRuntime.make(Layer.empty);',
                'const b = Runtimes.make(Layer.empty);',
                'const c = makeRuntime(Layer.empty);',
                'const d = All.ManagedRuntime.make(All.Layer.empty);',
                '',
            ].join('\n'),
        );
        expect(uses.map(({ line, use }) => `${line}: ${use}`)).toEqual([
            '5: ManagedRuntime.make',
            '6: ManagedRuntime.make',
            '7: ManagedRuntime.make',
            '8: ManagedRuntime.make',
        ]);
    });

    it('counts no type, no runtime instance, no other module and no other member', () => {
        expect(
            usesIn(
                'pages/fine.ts',
                [
                    "import type { Effect as T } from 'effect';",
                    "import { type ManagedRuntime as M, Effect } from 'effect';",
                    "import { runPromise } from './local.js';",
                    "import type { AppRuntime } from '../issues/contract.js';",
                    'type Run = typeof Effect.runPromise;',
                    'type R = T.Effect<number>;',
                    'declare const runtime: { runPromise: (x: unknown) => void; runFork: (x: unknown) => void };',
                    'runtime.runPromise(Effect.gen(function* () {}));',
                    'runtime["runFork"](Effect.void);',
                    'runPromise();',
                    '// Effect.runPromise(Effect.void); ManagedRuntime.make(x)',
                    "const text = 'Effect.runSync';",
                    'const record = { runPromise: 1 };',
                    '',
                ].join('\n'),
            ),
        ).toEqual([]);
        // An `Effect` that isn't the effect package's.
        expect(
            usesIn(
                'pages/own.ts',
                "import { Effect } from './effect.js';\nEffect.runPromise(1);\nconst ManagedRuntime = { make: () => 1 };\nManagedRuntime.make();\n",
            ),
        ).toEqual([]);
    });

    it('counts no type query, of a named import or a namespace import, but the same names as values', () => {
        const uses = usesIn(
            'pages/types.ts',
            [
                "import { runPromise, runFork as fork } from 'effect/Effect';",
                "import { make } from 'effect/ManagedRuntime';",
                "import * as Fx from 'effect/Effect';",
                "import * as Runtimes from 'effect/ManagedRuntime';",
                "import * as All from 'effect';",
                "import { type runSync } from 'effect/Effect';",
                'type A = typeof runPromise;',
                'type B = typeof fork;',
                'type C = typeof make;',
                'type D = typeof Fx.runPromise;',
                'type E = typeof Runtimes.make;',
                'type F = typeof All.Effect.runSync;',
                'type G = ReturnType<typeof make>;',
                'declare const h: typeof runPromise;',
                'function f(x: typeof Fx.runFork): typeof make { return make as never; }',
                'runPromise(Fx.void);',
                'fork(Fx.void);',
                'Fx.runSync(Fx.void);',
                'Runtimes.make(All.Layer.empty);',
                'make(All.Layer.empty);',
                'All.Effect.runPromise(All.Effect.void);',
                'type S = typeof runSync;',
                '',
            ].join('\n'),
        );
        expect(uses.map(({ line, use }) => `${line}: ${use}`)).toEqual([
            '15: ManagedRuntime.make',
            '16: Effect.runPromise',
            '17: Effect.runFork',
            '18: Effect.runSync',
            '19: ManagedRuntime.make',
            '20: ManagedRuntime.make',
            '21: Effect.runPromise',
        ]);
    });

    it('resolves each name by scope: no property name, no shadowing local, only the import', () => {
        const uses = usesIn(
            'pages/scope.ts',
            [
                "import { runPromise, runFork as fork } from 'effect/Effect';",
                "import { make } from 'effect/ManagedRuntime';",
                "import { Effect, Layer } from 'effect';",
                'declare const localRunner: { runPromise: (x: unknown) => void; make: () => void };',
                // Destructuring with a rename: the key is a property name.
                'const { runPromise: runLocal, make: makeLocal } = localRunner;',
                // Shadowed parameters, and a call of each.
                'export const a = (make: () => void) => make();',
                'export function b(runPromise: (x: unknown) => void, { fork }: { fork: () => void }) { runPromise(1); fork(); }',
                'export const c = [1].map((Effect) => Effect);',
                // A local function, a block const, a catch variable, a hoisted var and a loop variable of the same name.
                'export function d() { function make() {} make(); }',
                'export function e() { { const runPromise = () => 1; runPromise(); } }',
                'export function f() { try {} catch (make) { make; } }',
                'export function g() { if (1) { var fork = () => 1; } fork(); }',
                'export function h() { for (const make of [() => 1]) make(); }',
                'export const i = { runPromise: 1, make() {}, fork: 2 };',
                // Uses of the imports: next to the shadows, after a block that shadows, and as values.
                'export function j() { { const make = 1; } return make(Layer.empty); }',
                'export const k = (x: number) => runPromise(Effect.succeed(x));',
                'export const l = { fork, make };',
                'export const m = (Effect: { runPromise: () => void }) => Effect.runPromise();',
                'export const n = () => Effect.runSync(Effect.void);',
                '',
            ].join('\n'),
        );
        expect(uses.map(({ line, use }) => `${line}: ${use}`)).toEqual([
            '15: ManagedRuntime.make',
            '16: Effect.runPromise',
            '17: Effect.runFork',
            '17: ManagedRuntime.make',
            '19: Effect.runSync',
        ]);
    });

    it('counts a re-export of a run function, which hides it from the guard in the files that import it', () => {
        const uses = usesIn(
            'pages/reexport.ts',
            [
                "import { runPromise, runFork as fork } from 'effect/Effect';",
                "import { Effect } from 'effect';",
                'export { runPromise };',
                'export { fork as forkIt };',
                "export { make, make as makeRuntime } from 'effect/ManagedRuntime';",
                "export { runSync as sync } from 'effect/Effect';",
                "export { void as nothing, succeed } from 'effect/Effect';",
                'export { Effect };',
                "export type { runPromiseExit } from 'effect/Effect';",
                'const runPromiseExit = 1;',
                'export { runPromiseExit as exit };',
                '',
            ].join('\n'),
        );
        expect(uses.map(({ line, use }) => `${line}: ${use}`)).toEqual([
            '3: Effect.runPromise',
            '4: Effect.runFork',
            '5: ManagedRuntime.make',
            '5: ManagedRuntime.make',
            '6: Effect.runSync',
        ]);
    });

    const RUN = "import { Effect } from 'effect';\nEffect.runPromise(Effect.void);\n";
    const MAKE =
        "import { Layer, ManagedRuntime } from 'effect';\nexport const r = ManagedRuntime.make(Layer.empty);\n";

    it('allows Effect.run* in composition/, main.ts, index.ts and the process entries only', () => {
        const { graph } = plant({
            'src/server/composition/pages.ts': RUN,
            'src/server/main.ts': RUN,
            'src/server/index.ts': `${CLEAN['src/server/index.ts']}${RUN}`,
            'src/server/coding/host/session-host.ts': RUN,
            'src/server/classify/eval-main.ts': RUN,
            'src/server/pages/moves.ts': `${CLEAN['src/server/pages/moves.ts']}${RUN}`,
            'src/server/coding/host/other.ts': RUN,
            'src/server/pages/composition/x.ts': RUN,
        });
        expect(runtimeReport(graph).effectRuns).toEqual([
            'coding/host/other.ts:2: Effect.runPromise',
            'pages/composition/x.ts:2: Effect.runPromise',
            'pages/moves.ts:4: Effect.runPromise',
        ]);
    });

    it('allows ManagedRuntime.make in main.ts and the process entries only, not in composition/ or index.ts', () => {
        const { graph } = plant({
            'src/server/main.ts': MAKE,
            'src/server/coding/host/session-host.ts': MAKE,
            'src/server/plugins/planner/main.ts': MAKE,
            'src/server/composition/issues.ts': MAKE,
            'src/server/index.ts': `${CLEAN['src/server/index.ts']}${MAKE}`,
            'src/server/pages/runtime.ts': MAKE,
        });
        expect(runtimeReport(graph).managedRuntimes).toEqual([
            'composition/issues.ts:2: ManagedRuntime.make',
            'index.ts:4: ManagedRuntime.make',
            'pages/runtime.ts:2: ManagedRuntime.make',
        ]);
    });

    it('keeps session-host.ts out of the entry files: its imports still answer to rule 1', () => {
        expect(RUN_ENTRY_FILES.has('coding/host/session-host.ts')).toBe(true);
        expect(isEntry('coding/host/session-host.ts')).toBe(false);
        const { graph } = plant({
            'src/server/coding/host/session-host.ts': `import { board } from '../../issues/board.js';\n${RUN}`,
        });
        expect(runtimeReport(graph).effectRuns).toEqual([]);
        expect(measure(graph).contractOnly).toEqual(['coding/host/session-host.ts -> issues/board.ts']);
    });

    it('reports every platform-needs.ts, under any TypeScript extension', () => {
        const { graph } = plant({
            'src/server/platform-needs.ts': 'export {};\n',
            'src/server/pages/platform-needs.mts': 'export {};\n',
            'src/server/pages/platform-needs-not.ts': 'export {};\n',
        });
        expect(runtimeReport(graph).platformNeeds).toEqual(['pages/platform-needs.mts', 'platform-needs.ts']);
    });

    it('fails on each hit, outside the rules and the baseline', () => {
        const { graph } = plant({
            'src/server/pages/platform-needs.ts': 'export {};\n',
            'src/server/pages/run.ts': RUN,
            'src/server/pages/runtime.ts': MAKE,
        });
        expect(runtimeProblems(graph)).toEqual([
            "pages/platform-needs.ts: a platform-needs.ts (Platform is gone: read the app's services from their tags)",
            "pages/run.ts:2: Effect.runPromise outside composition/, main.ts, index.ts and the process entries (yield it, or run it through the app's runtime)",
            'pages/runtime.ts:2: ManagedRuntime.make outside main.ts and the process entries (each process has one runtime)',
        ]);
        expect(problems(graph)).toEqual([]);
        expect(formatBaseline(measure(graph))).not.toMatch(/runtime|run|platform-needs/i);
        expect(runtimeProblems(plant().graph)).toEqual([]);
    });

    it('keeps platform.ts out of the entry files: Platform is gone', () => {
        expect(ENTRY_FILES.has('platform.ts')).toBe(false);
        expect(isEntry('platform.ts')).toBe(false);
    });

    it('prints the counts and fails with each hit', { timeout: 30_000 }, () => {
        const { dir } = plant({
            'src/server/pages/run.ts': RUN,
            'src/server/pages/runtime.ts': MAKE,
            'src/server/coding/host/session-host.ts': `${RUN}${MAKE}`,
            // The real guard's one allowed unread reference must match something.
            'src/server/web/prod.ts':
                "import { pathToFileURL } from 'node:url';\nconst file = '/x';\nawait import(pathToFileURL(file).href);\n",
        });
        mkdirSync(join(dir, 'scripts'), { recursive: true });
        copyFileSync(
            join(root, 'scripts/check-feature-boundaries.mjs'),
            join(dir, 'scripts/check-feature-boundaries.mjs'),
        );
        symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
        write(dir, {
            [BASELINE]: formatBaseline(NO_BASELINE),
            [RANKS]: '{"order": ["pages", "coding", "issues", "web"]}\n',
            '.ci-reference/feature-boundary-baseline.absent': 'abc123\n',
        });
        const result = spawnSync(process.execPath, ['scripts/check-feature-boundaries.mjs'], {
            cwd: dir,
            encoding: 'utf8',
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
            'runtime: platform-needs.ts 0; Effect.run* outside composition/, main.ts, index.ts and the process entries 1; ManagedRuntime.make outside main.ts and the process entries 1\n',
        );
        expect(result.stderr).toBe(
            [
                "pages/run.ts:2: Effect.runPromise outside composition/, main.ts, index.ts and the process entries (yield it, or run it through the app's runtime)",
                'pages/runtime.ts:2: ManagedRuntime.make outside main.ts and the process entries (each process has one runtime)',
                '',
            ].join('\n'),
        );
        expect(result.stdout).not.toContain('feature boundaries passed');
    });
});
