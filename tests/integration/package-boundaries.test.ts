import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    importsOf,
    LAYERS,
    NO_DEPENDENCY_SERVICES,
    packageBoundaryProblems,
    packageDependencyProblems,
    packageGraphProblems,
    thirdPartyReach,
    valueImportsOf,
    withoutComments,
    workspaceProblems,
} from '../../scripts/check-package-boundary.mjs';
import { builtPackages, workspaceDependencies } from '../../scripts/workspace-packages.mjs';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

const root = join(import.meta.dirname, '../..');
const text = (path: string) => readFileSync(join(root, path), 'utf8');
const json = (path: string) => JSON.parse(text(path));
const NEW = ['foundation', 'data'];

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A root with these files, each path relative to it; objects are written as JSON. */
const workspace = (files: Record<string, string | object>) => {
    const dir = mkdtempSync(join(tmpdir(), 'package-boundary-'));
    made.push(dir);
    for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return dir;
};
const EXPORTS = { './*': { types: './dist/*.d.ts', default: './dist/*.js' } };
const manifest = (name: string, extra: object = {}) => ({ name, exports: EXPORTS, ...extra });

describe('the workspace packages', () => {
    it('hold every boundary on the real tree', () => {
        expect(workspaceProblems(root)).toEqual([]);
    });

    it('build lowest first', () => {
        const names = builtPackages(root).map(({ name }) => name);
        expect(names.indexOf('@socio/shared')).toBeLessThan(names.indexOf('@socio/foundation'));
        expect(names).toEqual(expect.arrayContaining(['@socio/shared', '@socio/foundation', '@socio/data']));
    });

    it('are all in the guards’ walk, so moved code stays scanned', () => {
        expect(PACKAGE_SOURCES).toEqual(
            expect.arrayContaining(['packages/shared/src', 'packages/foundation/src', 'packages/data/src']),
        );
        // Each walker takes the list; a new one that walks `src` alone would miss a package.
        for (const test of [
            'approvals-boundary',
            'board-boundary',
            'hard-deletes',
            'inference-boundary',
            'integration-boundary',
            'media-boundary',
            'memory-boundary',
            'migration-boundary',
            'notification-boundary',
            'page-repositories',
            'plain-writes',
            'schedule-boundary',
            'socio-copy',
            'telemetry',
        ]) {
            const path = [`tests/${test}.test.ts`, `tests/integration/${test}.test.ts`].find((file) =>
                existsSync(join(root, file)),
            );
            expect(path && text(path), test).toContain('PACKAGE_SOURCES');
        }
    });

    it('are not reached around: nothing outside imports a package’s files by path', () => {
        const walk = (dir: string): string[] =>
            readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
                const path = `${dir}/${entry.name}`;
                if (entry.name === 'node_modules' || entry.name === 'dist') {
                    return [];
                }
                return entry.isDirectory() ? walk(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
            });
        const reaching = ['src', 'tests', 'packages/client/src', 'packages/client/tests', ...PACKAGE_SOURCES]
            .flatMap(walk)
            .filter((path) => path !== 'tests/integration/package-boundaries.test.ts')
            .filter((path) =>
                /(?:from\s*|import\s*\(?\s*)['"][^'"]*\/packages\/(?:foundation|data)\/src\//.test(text(path)),
            );
        expect(reaching).toEqual([]);
    });
});

describe('the wiring of @socio/foundation and @socio/data', () => {
    it.each(NEW)('holds %s to Node semantics, at the root’s target', (name) => {
        const { compilerOptions } = json(`packages/${name}/tsconfig.json`);
        expect(compilerOptions.module).toBe('NodeNext');
        expect(compilerOptions.moduleResolution).toBe('NodeNext');
        expect(compilerOptions.target).toBe(json('tsconfig.json').compilerOptions.target);
        expect(compilerOptions.allowImportingTsExtensions).toBeUndefined();
        const build = json(`packages/${name}/tsconfig.build.json`);
        expect(build.extends).toBe('./tsconfig.json');
        expect(build.compilerOptions.paths).toEqual({});
        expect(build.compilerOptions.outDir).toBe('dist');
    });

    it.each(NEW)('makes %s private, ESM and importable by subpath from dist', (name) => {
        const pkg = json(`packages/${name}/package.json`);
        expect(pkg.name).toBe(`@socio/${name}`);
        expect(pkg.private).toBe(true);
        expect(pkg.type).toBe('module');
        expect(pkg.author).toBeUndefined();
        expect(pkg.exports).toEqual(EXPORTS);
        expect(json('package.json').dependencies[`@socio/${name}`]).toBe('workspace:*');
    });

    it.each(NEW)('resolves %s to source in dev and tests, and to the build for tsc', (name) => {
        const specifier = `@socio/${name}`;
        expect(json('tsconfig.json').compilerOptions.paths[`${specifier}/*`]).toEqual([`./packages/${name}/src/*.ts`]);
        expect(json('tsconfig.json').include).toContain(`packages/${name}/src`);
        expect(json('tsconfig.server.json').compilerOptions.paths).toEqual({});
        expect(text('vite.config.ts')).toContain(`'${specifier}': fileURLToPath(new URL('./packages/${name}/src'`);
        expect(text('vitest.shared.ts')).toContain(`'${specifier}': at('./packages/${name}/src')`);
        expect(json('package.json').scripts.dev).toContain(`--watch-path=packages/${name}/src`);
    });

    it.each(NEW)('typechecks %s on its own, beside the root', (name) => {
        expect(text('scripts/typecheck.mjs')).toContain(`['-p', 'packages/${name}/tsconfig.json', '--noEmit'`);
        expect(json('package.json').scripts.typecheck).toBe('node scripts/typecheck.mjs');
    });

    it('keeps the data package’s code out of .gitignore’s `data/`, and its build out of images’ context', () => {
        expect(text('.gitignore')).toContain('!packages/data/');
        expect(text('.dockerignore')).toContain('packages/*/dist');
    });

    it('builds every package for the coding image, whose context lists them by hand', () => {
        // Every package the build compiles (scripts/workspace-packages.mjs), not a list kept here:
        // a new package missing from this Dockerfile otherwise first fails at release (v0.57.0).
        const dockerfile = text('deployment/coding/coding.Dockerfile');
        const built = builtPackages(root);
        for (const { dir, build } of built) {
            expect(dockerfile).toContain(`COPY ${dir} ./${dir}`);
            expect(dockerfile).toContain(`pnpm exec tsc -p ${build}`);
        }
        // Each package compiles after the workspace packages it depends on, and before the server.
        const at = (build: string) => dockerfile.indexOf(`pnpm exec tsc -p ${build}`);
        for (const { manifest, build } of built) {
            for (const dependency of built.filter(({ name }) => workspaceDependencies(manifest).includes(name))) {
                expect(at(dependency.build), `${dependency.build} before ${build}`).toBeLessThan(at(build));
            }
            expect(at(build)).toBeLessThan(at('tsconfig.server.json'));
        }
    });

    it('allows Drizzle in @socio/data only, as it did in src/server/data', () => {
        const { overrides } = json('.oxlintrc.json');
        const off = overrides.find(
            (entry: { rules: Record<string, unknown> }) => entry.rules['no-restricted-imports'] === 'off',
        );
        expect(off.files).toContain('packages/data/**');
        expect(
            overrides.some(
                (entry: { files: string[]; rules: Record<string, unknown> }) =>
                    entry.files.includes('packages/foundation/**/*.ts') && entry.rules['no-restricted-imports'],
            ),
        ).toBe(true);
    });

    it('keeps the opt-out importable with no dependency, first in each entry', () => {
        expect(valueImportsOf(text('packages/foundation/src/no-vendor-telemetry.ts'))).toEqual([]);
    });

    it('does not ignore the data package in git', () => {
        const ignored = () =>
            execFileSync('git', ['-C', root, 'check-ignore', 'packages/data/src/open.ts'], { encoding: 'utf8' });
        let result = '';
        try {
            result = ignored();
        } catch {
            // Exit 1: not ignored. Exit 128: no repository here (the no-network box's copy has one).
        }
        expect(result).toBe('');
    });
});

describe('a planted violation', () => {
    const base = {
        'package.json': { dependencies: { zod: '^4', '@socio/low': 'workspace:*' }, devDependencies: { tsx: '^1' } },
        'packages/low/package.json': manifest('@socio/low'),
        'packages/low/src/index.ts': 'export {};\n',
    };

    it.each([
        ['a higher package', "import x from '@socio/high/x';", 'not declared'],
        ['the server', "import x from '../../../src/server/platform.js';", 'leaves the package'],
        ['an undeclared package', "import x from 'lodash';", 'not declared'],
        ['a sibling package by path', "import x from '../../high/src/x.js';", 'leaves the package'],
        [
            'a type-only import of the server',
            "import type { X } from '../../../src/server/x.js';",
            'leaves the package',
        ],
    ])('fails on %s', (_name, line, why) => {
        const dir = workspace({ ...base, 'packages/low/src/bad.ts': `${line}\n` });
        const problems = packageBoundaryProblems(join(dir, 'packages/low'));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(why);
    });

    it('fails on a package’s test that imports past it, and allows its own source', () => {
        const dir = workspace({
            ...base,
            'packages/low/tests/a.test.ts':
                "import { x } from '../src/index.js';\nimport y from '../../../src/y.js';\n",
        });
        const problems = packageBoundaryProblems(join(dir, 'packages/low'));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('../../../src/y.js');
    });

    it('fails on a dependency that runs both ways', () => {
        const dir = workspace({
            'packages/a/package.json': manifest('@socio/a', { dependencies: { '@socio/b': 'workspace:*' } }),
            'packages/b/package.json': manifest('@socio/b', { dependencies: { '@socio/a': 'workspace:*' } }),
        });
        expect(packageGraphProblems(dir).join()).toContain('cycle');
    });

    describe('in the layers', () => {
        /** The three real names, with `@socio/foundation` declaring these. */
        const graph = (dependencies: Record<string, string>) =>
            workspace({
                'package.json': {},
                'packages/shared/package.json': manifest('@socio/shared'),
                'packages/foundation/package.json': manifest('@socio/foundation', { dependencies }),
                'packages/data/package.json': manifest('@socio/data'),
                'packages/foundation/src/a.ts': "import x from '@socio/data/open';\n",
            });

        it('fails on a package that declares and imports one above it', () => {
            const dir = graph({ '@socio/data': 'workspace:*' });
            // It declares it, so this check has nothing to say; the layers do.
            expect(packageBoundaryProblems(join(dir, 'packages/foundation'))).toEqual([]);
            expect(packageGraphProblems(dir)).toEqual([
                '@socio/foundation: @socio/data (not in a lower layer: @socio/shared < @socio/i18n < @socio/foundation < @socio/data)',
            ]);
            expect(workspaceProblems(dir)).toEqual(packageGraphProblems(dir));
        });

        it('allows one below, and nothing else', () => {
            expect(packageGraphProblems(graph({ '@socio/shared': 'workspace:*' }))).toEqual([]);
            expect(packageGraphProblems(graph({ '@socio/plugin-ui': 'workspace:*' })).join()).toContain(
                'not in a lower layer',
            );
            expect(packageGraphProblems(graph({ '@socio/client': 'workspace:*' })).join()).toContain(
                'the app sits above',
            );
        });

        it('fails on a built package nobody placed', () => {
            const dir = workspace({ 'packages/new/package.json': manifest('@socio/new') });
            expect(packageGraphProblems(dir).join()).toContain('@socio/new: not in LAYERS');
        });

        it('name every built package, in an order that builds', () => {
            const names = builtPackages(root).map(({ name }) => name);
            expect([...LAYERS].sort()).toEqual([...names].sort());
        });
    });

    it('fails on a run-time dependency the root doesn’t install, or at another range', () => {
        const roots = { dependencies: { zod: '^4' }, devDependencies: { tsx: '^1' } };
        const problems = (dependencies: object, devDependencies: object = {}) => {
            const dir = workspace({
                'p/package.json': manifest('@socio/p', { dependencies, devDependencies }),
                'p/src/a.ts': 'export {};\n',
            });
            return packageDependencyProblems(join(dir, 'p'), roots);
        };
        expect(problems({ zod: '^4' }, { tsx: '^1' })).toEqual([]);
        expect(problems({ zod: '^3' }).join()).toContain('the root has ^4');
        expect(problems({ tsx: '^1' }).join()).toContain('not in the root dependencies');
        expect(problems({ lodash: '^1' }).join()).toContain('not in the root dependencies');
        expect(problems({}, { tsx: '^2' }).join()).toContain('the root has ^1');
        expect(problems({}, { lodash: '^1' }).join()).toContain('not in the root manifest');
    });

    it('fails on a run-time import of a dev dependency, and allows a type-only one', () => {
        const roots = { dependencies: { zod: '^4' }, devDependencies: {} };
        const problems = (line: string) => {
            const dir = workspace({
                'p/package.json': manifest('@socio/p', { devDependencies: { zod: '^4' } }),
                'p/src/a.ts': `${line}\n`,
            });
            return packageDependencyProblems(join(dir, 'p'), roots);
        };
        expect(problems("import { z } from 'zod';").join()).toContain('belongs in dependencies');
        expect(problems("import 'zod';").join()).toContain('belongs in dependencies');
        expect(problems("export { z } from 'zod';").join()).toContain('belongs in dependencies');
        expect(problems("const z = await import('zod');").join()).toContain('belongs in dependencies');
        expect(problems("export const z = () => import('zod');").join()).toContain('belongs in dependencies');
        expect(problems("import type { z } from 'zod';")).toEqual([]);
        expect(problems("import { type z } from 'zod';")).toEqual([]);
        expect(problems("export type { z } from 'zod';")).toEqual([]);
    });

    it.each([
        ['after await', "const z = await import('zod');"],
        ['in an arrow', "export const load = () => import('zod');"],
        ['with then', "import('zod').then((z) => z);"],
        ['with catch, over lines', "import('zod')\n    .catch(() => undefined);"],
        ['with finally', "import('zod').finally(done);"],
        ['in a list', "await Promise.all([import('zod')]);"],
        ['as an argument', "lazy(import('zod'));"],
        ['with options', "const z = import('zod', { with: { type: 'json' } });"],
        ['after a comment', "import(/* @vite-ignore */ 'zod').then(use);"],
        ['in a template', 'import(`zod`).then(use);'],
        ['with a computed then', "import('zod')['then'](use);"],
        ['with a computed catch', 'import("zod")["catch"](() => undefined);'],
        ['with a key that is not a string', "import('zod')[key](use);"],
        ['under a value typeof', "const kind = typeof import('zod');"],
        ['under typeof in a call', "log(typeof import('zod'));"],
    ])('counts a dynamic import %s as loading at run time', (_name, line) => {
        expect(valueImportsOf(line)).toEqual(['zod']);
    });

    it.each([
        ['typeof', "type Z = typeof import('zod');"],
        ['typeof a member', "let z: typeof import('zod').z;"],
        ['a member type', "let z: import('zod').ZodType;"],
        ['a generic member type', "function f(z: import('zod').ZodType<string>): void {}"],
        ['an indexed type', "type Z = import('zod')['ZodType'];"],
        ['typeof as a type argument', "const z = await load<typeof import('zod')>();"],
        ['typeof in a union', "type Z = string | typeof import('zod');"],
        ['typeof in a generic type alias', "type Z<T> = typeof import('zod');"],
        ['typeof in a parameter type', "const f = ({ z }: typeof import('zod')) => z;"],
        ['a return type', "const f = (): import('zod').ZodType => g();"],
        ['a method of another object', "loader.import('zod');"],
        ['a comment', "// const z = () => import('zod');"],
    ])('does not count %s as loading at run time', (_name, line) => {
        expect(valueImportsOf(line)).toEqual([]);
    });

    it('tells a type from a call in the same line', () => {
        expect(valueImportsOf("const f = (t: typeof import('t')) => import('v').then(use);")).toEqual(['v']);
    });

    it('fails when a no-dependency service reaches a third-party module lazily', () => {
        const dir = workspace({
            'src/service/lazy.ts': "export const load = () => import('zod');\n",
            'src/service/hop.ts': "export const load = () => import('./then.js');\n",
            'src/service/then.ts': "import('lodash').then(console.log);\n",
            'src/service/typed.ts': "export type Z = typeof import('zod');\nexport let z: import('zod').Z;\n",
            'packages/low/package.json': manifest('@socio/low'),
        });
        expect(thirdPartyReach(dir, ['src/service/lazy.ts'])).toEqual(['src/service/lazy.ts: zod']);
        expect(thirdPartyReach(dir, ['src/service/hop.ts'])).toEqual(['src/service/then.ts: lodash']);
        expect(thirdPartyReach(dir, ['src/service/typed.ts'])).toEqual([]);
    });

    it.each([
        ['a character class', "const r = /[/*]/;\nimport x from 'zod';\nconst s = 1; // */\n"],
        ['after a keyword', "function f() {\n    return /\\/*/;\n}\nimport x from 'zod';\n/* */\n"],
        ['with flags', "const r = /a\\/*b/gi;\nimport x from 'zod';\n/* */\n"],
        ['as an argument', "s.replace(/[/*]/g, '');\nimport x from 'zod';\n/* */\n"],
        ['holding a quote', "const r = /'/;\nimport x from 'zod';\nconst q = /'/;\n"],
    ])('sees an import after a regex literal, %s, that looks like a comment or string', (_name, source) => {
        expect(importsOf(source)).toEqual(['zod']);
        expect(valueImportsOf(source)).toEqual(['zod']);
    });

    it('blanks comments and regex literals, and only those', () => {
        // Every offset stays, so a line number read from the result is the file's.
        const kept = (source: string) => {
            const result = withoutComments(source);
            expect(result.length).toBe(source.length);
            expect(result.split('\n').length).toBe(source.split('\n').length);
            return result.replace(/\s+/g, ' ').trim();
        };
        expect(kept('a; /* one\ntwo */ b; // three\nc;')).toBe('a; b; c;');
        expect(kept("const r = /x'y/g; z;")).toBe('const r = ; z;');
        // A slash that divides isn't a regex, so a comment after two of them is still one.
        expect(kept('const r = a / b / c; // d')).toBe('const r = a / b / c;');
        expect(kept('const r = (a) / (b); // d')).toBe('const r = (a) / (b);');
        expect(kept('r /= 2; n++ / 2; // d')).toBe('r /= 2; n++ / 2;');
        // What looks like one in a string or a template stays.
        expect(kept("const u = 'https://x.test/*';")).toBe("const u = 'https://x.test/*';");
        expect(kept('const u = `https://${host}/*`; v; /* w */')).toBe('const u = `https://${host}/*`; v;');
        // A template's code is code, at any depth, and its braces don't end it.
        expect(kept('`a${ /* b */ c }d/*e*/`')).toBe('`a${ c }d/*e*/`');
        expect(kept('`a${{ b: `c${d}/*` }.b}/*`; /* e */')).toBe('`a${{ b: `c${d}/*` }.b}/*`;');
        // JSX: a closing tag isn't a regex, nor a self-closing one.
        expect(kept("<a href='x'>b</a>; <c d='e' />; /* f */")).toBe("<a href='x'>b</a>; <c d='e' />;");
        // Text the scanner can't read, which must not stop it.
        expect(kept('<a>Draft #{n}</a>; /* b */')).toBe('<a>Draft #{n}</a>;');
    });

    it('fails when a no-dependency service reaches a third-party module through a package', () => {
        const dir = workspace({
            'packages/low/package.json': manifest('@socio/low'),
            'packages/low/src/clean.ts': "import { hash } from 'node:crypto';\nexport { hash };\n",
            'packages/low/src/hop.ts': "export { z } from './dirty.js';\n",
            'packages/low/src/dirty.ts': "import { z } from 'zod';\nexport { z };\n",
            'src/service/clean.ts':
                "import { hash } from '@socio/low/clean';\nimport type { Z } from 'zod';\nexport { hash };\n",
            'src/service/dirty.ts': "import { z } from '@socio/low/hop';\nexport { z };\n",
        });
        expect(thirdPartyReach(dir, ['src/service/clean.ts'])).toEqual([]);
        expect(thirdPartyReach(dir, ['src/service/dirty.ts'])).toEqual(['packages/low/src/dirty.ts: zod']);
    });

    it('names the services whose images ship no dependencies', () => {
        for (const service of NO_DEPENDENCY_SERVICES) {
            expect(text('Dockerfile')).toContain(`dist/server/${relative('src', service)}/`);
        }
    });
});
