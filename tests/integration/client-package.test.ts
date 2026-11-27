import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import routerConfig from '../../react-router.config';
import { clientBoundaryProblems, clientManifestProblems } from '../../scripts/check-client-boundary.mjs';
import { ssrDepsProblems } from '../../scripts/check-ssr-deps.mjs';
import viteConfig from '../../vite.config';
import rootConfig from '../../vitest.config';
import sharedConfig from '../../vitest.shared';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const json = (path: string) => JSON.parse(read(path));
const clientPath = (path: string) => join(root, 'packages/client', path);

const made: string[] = [];
const tempDir = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), name));
    made.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const write = (dir: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
};

/** A package at <dir>/packages/client with these files. */
const fixture = (files: Record<string, string>) => {
    const pkg = join(tempDir('client-boundary-'), 'packages/client');
    write(pkg, {
        'package.json': JSON.stringify({ dependencies: { react: '1' }, devDependencies: { vitest: '1' } }),
        ...files,
    });
    return clientBoundaryProblems(pkg);
};

describe('the @socio/client boundary', () => {
    it('holds on the real package, which it really reads', () => {
        expect(clientBoundaryProblems(clientPath('.'))).toEqual([]);
        expect(readdirSync(clientPath('src'), { recursive: true }).length).toBeGreaterThan(500);
    });

    it('allows the package, Node built-ins, what it declares and public files by location', () => {
        expect(
            fixture({
                'package.json': JSON.stringify({
                    dependencies: { react: '1', '@socio/plugin-ui': 'workspace:*', '@socio/ui': 'workspace:*' },
                    devDependencies: { vitest: '1' },
                }),
                'src/a.ts': "import React from 'react';\nimport { b } from './deep/b';\nimport c from '@/deep/b';\n",
                'src/deep/b.ts': "import 'node:fs';\nexport { a } from '../a';\nexport const b = 1;\n",
                'tests/a.test.ts':
                    "import { vi } from 'vitest';\nimport { a } from '../src/a';\nvi.mock('../src/deep/b');\n" +
                    "const glob = import.meta.glob('../src/**/*.ts');\n" +
                    "const page = new URL('../../../public/theme-init.js', import.meta.url);\n",
                'src/globals.css': '@import \'./style.css\';\n@source "../../plugin-ui";\n@source "../../ui/src";\n',
                'src/index.html': '<script src="./main.tsx"></script>',
            }),
        ).toEqual([]);
    });

    it.each([
        ['a static import of the server', "import { x } from '../../../src/server/x.js';", 'leaves the package'],
        ['src/net', "import { x } from '../../../src/net/public-address.js';", 'leaves the package'],
        ['the apps runtime', "import { x } from '../../../src/apps-runtime/x.js';", 'leaves the package'],
        ['coding-git', "import { x } from '../../../src/coding-git/x.js';", 'leaves the package'],
        ['coding-egress', "import { x } from '../../../src/coding-egress/x.js';", 'leaves the package'],
        ['the egress proxy', "import { x } from '../../../src/egress/x.js';", 'leaves the package'],
        ['the app browser', "import { x } from '../../../src/app-browser/x.js';", 'leaves the package'],
        ['the updater', "import { x } from '../../../src/updater/x.js';", 'leaves the package'],
        ['a type-only import', "import type { X } from '../../../src/server/x';", 'leaves the package'],
        ['a type position', "export type X = import('../../../src/server/x.js').X;", 'leaves the package'],
        ['a re-export', "export { x } from '../../../src/server/x.js';", 'leaves the package'],
        ['a star re-export', "export * from '../../../src/server/x.js';", 'leaves the package'],
        ['a side-effect import', "import '../../../src/server/no-vendor-telemetry.js';", 'leaves the package'],
        ['a dynamic import', "await import('../../../src/server/x.js');", 'leaves the package'],
        ['a require', "require('../../../src/server/x.js');", 'leaves the package'],
        ['a multi-line import', "import {\n    x,\n} from '../../../src/server/x.js';", 'leaves the package'],
        ['a mock', "vi.mock('../../../src/server/x.js');", 'leaves the package'],
        ['a real module behind a mock', "await vi.importActual('../../../src/server/x.js');", 'leaves the package'],
        ['a glob', "import.meta.glob('../../../src/server/**/*.ts');", 'leaves the package'],
        ['a file by location', "new URL('../../../src/server/x.ts', import.meta.url);", 'leaves the package'],
        ['the alias climbing out', "import x from '@/../../../src/server/x';", 'leaves the package'],
        ['a path read from the root', "readFileSync('src/server/app.ts', 'utf8');", 'names server code'],
        ['a path built from a template', 'readFileSync(`src/egress/${name}`);', 'names server code'],
        ['@socio/foundation by name', "import { x } from '@socio/foundation/keys/secret-box';", 'not declared'],
        ['@socio/data by name', "import { x } from '@socio/data/open';", 'not declared'],
        ['@socio/data by location', "vi.mock('../../../packages/data/src/open.js');", 'leaves the package'],
        ['a path into @socio/foundation', "readFileSync('packages/foundation/src/x.ts');", 'names server code'],
        ['a path into @socio/data', "readFileSync('packages/data/src/x.ts');", 'names server code'],
        ['an undeclared package', "import x from 'lodash';", 'not declared'],
        ['another workspace package', "import x from '@socio/plugin-ui';", 'not declared'],
        ['an absolute path', "import x from '/app/src/server/x.js';", 'not a package'],
        ['a URL', "import x from 'https://example.test/x.js';", 'not a package'],
    ])('catches %s, in source and in tests', (_name, line, why) => {
        for (const file of ['src/deep/a.ts', 'tests/deep/a.test.ts']) {
            const problems = fixture({ [file]: `${line}\n` });
            expect(problems.length, file).toBeGreaterThanOrEqual(1);
            expect(problems[0]).toContain(file);
            expect(problems.join('\n')).toContain(why);
        }
    });

    it('reads .js, .tsx and .mjs sources too', () => {
        for (const name of ['a.js', 'a.tsx', 'a.mjs']) {
            expect(fixture({ [`src/${name}`]: "import x from 'lodash';\n" })).toHaveLength(1);
        }
    });

    it('catches stylesheets and pages that leave the package', () => {
        expect(fixture({ 'src/a.css': "@import '../../../src/server/a.css';\n" })).toHaveLength(1);
        expect(fixture({ 'src/a.css': '@source "../../../src/server";\n' })).toHaveLength(1);
        expect(fixture({ 'src/a.html': '<script src="../../../src/server/a.ts"></script>' })).toHaveLength(1);
    });

    it('does not take prose in a comment for a violation', () => {
        expect(
            fixture({
                'src/a.ts': "// see src/server/app.ts, from '../../../src/server/x'\nexport const a = 1;\n",
            }),
        ).toEqual([]);
    });

    it('fails when run as a command on a planted violation', async () => {
        const { spawnSync } = await import('node:child_process');
        const pkg = join(tempDir('client-boundary-'), 'packages/client');
        write(pkg, {
            'package.json': '{}',
            'src/a.ts': "import { x } from '../../../src/server/x.js';\n",
        });
        write(join(pkg, '../..'), { 'package.json': '{}' });
        const run = spawnSync(process.execPath, [join(root, 'scripts/check-client-boundary.mjs'), pkg], {
            encoding: 'utf8',
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('src/a.ts: ../../../src/server/x.js (leaves the package)');
    });
});

describe('the client manifest against the root manifest images install from', () => {
    const manifests = (client: object, top: object) => {
        const dir = tempDir('client-manifest-');
        write(dir, {
            'package.json': JSON.stringify(top),
            'packages/client/package.json': JSON.stringify(client),
        });
        return clientManifestProblems(join(dir, 'packages/client'), dir);
    };

    it('holds on the real manifests', () => {
        expect(clientManifestProblems(clientPath('.'), root)).toEqual([]);
    });

    it('catches a runtime dependency images would not install', () => {
        expect(manifests({ dependencies: { a: '1' } }, {})[0]).toContain('production images');
        expect(manifests({ dependencies: { a: '1' } }, { devDependencies: { a: '1' } })[0]).toContain(
            'production images',
        );
    });

    it('catches a development dependency the image build stage would not install', () => {
        expect(manifests({ devDependencies: { a: '1' } }, {})[0]).toContain('build stage');
    });

    it('catches a different range', () => {
        expect(manifests({ dependencies: { a: '1' } }, { dependencies: { a: '2' } })[0]).toContain('at the root');
    });

    it('resolves every package to the version the root has in the lockfile', () => {
        const { importers } = parse(read('pnpm-lock.yaml')) as {
            importers: Record<string, Record<string, Record<string, { version: string }>>>;
        };
        const all = (importer: string) => ({
            ...importers[importer]!.dependencies,
            ...importers[importer]!.devDependencies,
        });
        const top = all('.');
        const entries = Object.entries(all('packages/client')).filter(
            ([, { version }]) => !version.startsWith('link:'),
        );
        expect(entries.length).toBeGreaterThan(30);
        for (const [name, { version }] of entries) {
            expect(version, name).toBe(top[name]?.version);
        }
    });
});

describe('the check on what the server build loads', () => {
    const built = (top: object) => {
        const dir = tempDir('ssr-deps-');
        write(dir, {
            'package.json': JSON.stringify(top),
            'dist/web/server/index.js': "import 'node:fs';\nimport 'a-pkg/sub';\nawait import('./assets/lazy.js');\n",
            'dist/web/server/assets/lazy.js':
                "import '@scope/lazy-pkg';\nexport const sample = \"import x from 'in-a-code-sample';\";\n",
        });
        return dir;
    };

    it('finds packages in lazily loaded chunks, not in strings', async () => {
        const problems = await ssrDepsProblems(built({ dependencies: {} }));
        expect(problems).toHaveLength(2);
        expect(problems.join('\n')).toContain('a-pkg');
        expect(problems.join('\n')).toContain('@scope/lazy-pkg');
        expect(problems.join('\n')).not.toContain('in-a-code-sample');
    });

    it('takes only dependencies, not development ones', async () => {
        const dependencies = { 'a-pkg': '1', '@scope/lazy-pkg': '1' };
        expect(await ssrDepsProblems(built({ dependencies }))).toEqual([]);
        expect(await ssrDepsProblems(built({ devDependencies: dependencies }))).toHaveLength(2);
    });

    it('fails with no build rather than passing on nothing', async () => {
        expect(await ssrDepsProblems(tempDir('ssr-deps-'))).toHaveLength(1);
    });

    it('runs in the build, after the pages are built', () => {
        expect(json('package.json').scripts.build).toMatch(/react-router build && node scripts\/check-ssr-deps\.mjs/);
    });
});

describe('the @socio/client wiring', () => {
    it('is private and ESM, with the bundler resolution of a bundled package', () => {
        const manifest = json('packages/client/package.json');
        expect(manifest.name).toBe('@socio/client');
        expect(manifest.private).toBe(true);
        expect(manifest.type).toBe('module');
        expect(manifest.author).toBeUndefined();
        const { compilerOptions, include } = json('packages/client/tsconfig.json');
        expect(compilerOptions.moduleResolution).toBe('Bundler');
        expect(compilerOptions.paths['@/*']).toEqual(['./src/*']);
        expect(include).toEqual(expect.arrayContaining(['src', 'tests']));
    });

    it('checks the package in its own typecheck, not the root one', () => {
        const { include, compilerOptions } = json('tsconfig.json');
        expect(include.filter((path: string) => path.includes('client'))).toEqual([]);
        expect(compilerOptions.paths['@/*']).toEqual(['./packages/client/src/*']);
        expect(json('package.json').scripts.typecheck).toBe('node scripts/typecheck.mjs');
        expect(read('scripts/typecheck.mjs')).toContain('packages/client/tsconfig.json');
    });

    it('runs each test file in exactly one project', () => {
        const projects = rootConfig.test?.projects as (string | { test: { name: string; exclude: string[] } })[];
        expect(projects).toContain('packages/client');
        const server = projects.find((project) => typeof project === 'object' && project.test.name === 'server');
        expect(typeof server === 'object' && server.test.exclude).toContain('packages/client/**');
        const moved = readdirSync(clientPath('tests')).filter((name) => /\.test\.tsx?$/.test(name));
        expect(moved.length).toBeGreaterThan(100);
        const here = [...readdirSync(join(root, 'tests')), ...readdirSync(join(root, 'tests/integration'))];
        expect(moved.filter((name) => here.includes(name))).toEqual([]);
    });

    it('builds to dist/web from the package source', () => {
        expect(routerConfig.appDirectory).toBe('packages/client/src');
        expect(routerConfig.buildDirectory).toBe('dist/web');
        expect(read('Dockerfile')).toContain('COPY --from=build /app/dist ./dist');
    });

    it('points each alias at something real, in the build and in every test run', () => {
        for (const alias of [viteConfig.resolve?.alias, sharedConfig.resolve?.alias] as Record<string, string>[]) {
            expect(alias['@']).toBe(clientPath('src'));
            expect(alias['@copilotkit/web-inspector']).toBe(clientPath('src/no-web-inspector.ts'));
            expect(alias['@socio/shared']).toBe(resolve(root, 'packages/shared/src'));
            expect(read(alias['@copilotkit/web-inspector']!.slice(root.length + 1))).toContain('not part of Socio');
        }
        expect(read('packages/client/vitest.config.ts')).toContain('vitest.shared.ts');
        expect(read('vitest.config.ts')).toContain('vitest.shared.ts');
        expect(read('scripts/build-planner-ui.mjs')).toContain('../packages/client/src');
        const onboarding = read('scripts/onboarding-browser.mjs');
        expect(onboarding).toContain("resolve(root, 'packages/client/src/no-web-inspector.ts')");
        expect(onboarding).toContain('./packages/client/tests/fixtures/onboarding-app');
    });

    it('keeps the package under the lint rules it had as src/client', () => {
        const { overrides } = json('.oxlintrc.json');
        for (const rule of ['socio/locale', 'no-restricted-imports']) {
            expect(
                overrides.some(
                    (entry: { files: string[]; rules: Record<string, unknown> }) =>
                        rule in entry.rules &&
                        entry.files.includes('packages/client/src/**/*.ts') &&
                        entry.files.includes('packages/client/src/**/*.tsx'),
                ),
                rule,
            ).toBe(true);
        }
    });

    it('leaves the tests out of images', () => {
        expect(read('.dockerignore').split('\n')).toEqual(expect.arrayContaining(['tests', 'packages/client/tests']));
    });

    // Tests that scan source find nothing, and pass, if a directory they walk stops being there.
    it.each([
        'approvals-boundary',
        'board-boundary',
        'inference-boundary',
        'integration-boundary',
        'media-boundary',
        'memory-boundary',
        'notification-boundary',
        'schedule-boundary',
        'page-repositories',
        'plain-writes',
        'plugins',
        'socio-copy',
        'telemetry',
    ])('keeps %s scanning the package', (name) => {
        expect(read(`tests/integration/${name}.test.ts`)).toContain('packages/client/src');
    });

    it('keeps the docs boundary reading the package', () => {
        expect(read('scripts/check-docs-boundary.mjs')).toContain("resolve(root, 'packages/client/src')");
    });
});
