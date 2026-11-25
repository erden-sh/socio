// Three test buckets (vitest.config.ts), and a change on one side of the
// repository doesn't rerun the bucket on the other (turbo.json). That is safe
// only while the server bucket really stays away from the client, so this
// keeps it there. tests/integration/turbo.test.ts covers the task graph.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { testBucketProblems, unlistedInputProblems } from '../../scripts/check-test-buckets.mjs';
import { noClientPlugin } from '../setup/no-client-plugin';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A repository with these files, for the guard to read. */
const repo = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'test-buckets-'));
    made.push(dir);
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    return dir;
};
const CLIENT_FILES = {
    'packages/client/src/x.ts': 'export const x = 1;\n',
    'packages/plugin-ui/src/index.ts': 'export const y = 1;\n',
};

describe('the server bucket', () => {
    // It reads the whole repository: seconds here, more on a loaded CI runner.
    it('reaches no client file on the real repository', () => {
        expect(testBucketProblems(root)).toEqual([]);
    }, 120_000);

    it.each([
        ['an import', "import { x } from '../packages/client/src/x';"],
        ['the alias', "import { x } from '@/x';"],
        ['the plugin UI', "import { y } from '@socio/plugin-ui';"],
        ['a type-only import', "import type { X } from '../packages/client/src/x';"],
        ['a dynamic import', "await import('../packages/client/src/x');"],
        ['a mock', "vi.mock('../packages/client/src/x');"],
        ['a glob', "import.meta.glob('../packages/client/src/*.ts');"],
        ['a file by location', "new URL('../packages/client/src/x.ts', import.meta.url);"],
        ['a path in a string', "readFileSync('packages/client/src/x.ts');"],
        ['a path built from parts', "join(root, 'packages', 'client', 'src');"],
        ['a path to the plugin UI', "readdirSync('packages/plugin-ui/src');"],
    ])('catches %s in a test', (_name, line) => {
        const problems = testBucketProblems(repo({ ...CLIENT_FILES, 'tests/a.test.ts': `${line}\n` }));
        expect(problems.length).toBeGreaterThan(0);
        expect(problems[0]).toContain('tests/a.test.ts');
    });

    it('catches a route through helpers and server code', () => {
        const problems = testBucketProblems(
            repo({
                ...CLIENT_FILES,
                'tests/a.test.ts': "import { b } from './helper.js';\n",
                'tests/helper.ts': "export { b } from '../src/server/b.js';\n",
                'src/server/b.ts': "export { x as b } from '@/x';\n",
            }),
        );
        expect(problems).toEqual([
            'tests/a.test.ts -> tests/helper.ts -> src/server/b.ts -> packages/client/src/x.ts: reaches the client',
        ]);
    });

    it('catches a helper in tests/integration, which is not an input of this bucket', () => {
        const problems = testBucketProblems(
            repo({
                'tests/a.test.ts': "import { b } from './integration/helper.js';\n",
                'tests/integration/helper.ts': 'export const b = 1;\n',
            }),
        );
        expect(problems).toEqual(['tests/a.test.ts -> tests/integration/helper.ts: reaches the client']);
    });

    it('catches a helper that reads the client', () => {
        const problems = testBucketProblems(
            repo({
                ...CLIENT_FILES,
                'tests/a.test.ts': "import './helper.js';\n",
                'tests/helper.ts': "readFileSync('packages/client/package.json');\n",
            }),
        );
        expect(problems).toEqual(["tests/a.test.ts -> tests/helper.ts: names the client's files in a string"]);
    });

    it('leaves alone tests/integration, the server, shared code, prose and fixtures in other words', () => {
        expect(
            testBucketProblems(
                repo({
                    ...CLIENT_FILES,
                    'tests/integration/a.test.ts': "import { x } from '@/x';\n",
                    'tests/b.test.ts':
                        "import { s } from '../src/server/s.js';\nimport { z } from '@socio/shared/z';\n// packages/client/src/x.ts is the client's\nconst word = 'client';\n",
                    'src/server/s.ts': "export const s = 'packages/client is mentioned in a server message';\n",
                    'packages/shared/src/z.ts': 'export const z = 1;\n',
                }),
            ),
        ).toEqual([]);
    });

    it('fails at run time on a module from the client side, for imports no reading shows', () => {
        const plugin = noClientPlugin();
        const load = plugin.load as (id: string) => unknown;
        expect(() => load(join(root, 'packages/client/src/root.tsx'))).toThrow(/move it to tests\/integration/);
        expect(() => load(`${join(root, 'packages/plugin-ui/src/index.ts')}?v=1`)).toThrow(/server bucket/);
        expect(load(join(root, 'packages/shared/src/locale.ts'))).toBeNull();
        expect(load('virtual:packages/client/x')).toBeNull();
    });

    it('fails at run time on a read or a walk of the client side, for paths no reading shows', () => {
        const probe = (body: string) =>
            spawnSync(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    '--input-type=module',
                    '-e',
                    `import ${JSON.stringify(join(root, 'tests/setup/no-client-reads.ts'))};
                     import { readFileSync, readdirSync, promises } from 'node:fs';
                     ${body}`,
                ],
                { cwd: root },
            );
        expect(probe("readFileSync('package.json');").status).toBe(0);
        expect(probe("readdirSync('packages/shared/src');").status).toBe(0);
        for (const body of [
            "readFileSync('packages/client/package.json');",
            "readdirSync('packages/client/src');",
            "readdirSync('packages/plugin-ui/src', { recursive: true });",
            "readFileSync(new URL('packages/client/package.json', 'file://' + process.cwd() + '/'));",
            "await promises.readFile('packages/client/package.json');",
        ]) {
            const result = probe(body);
            expect(result.status, body).not.toBe(0);
            expect(result.stderr.toString(), body).toContain('server bucket');
        }
    });
});

describe('the buckets together', () => {
    const tests = (dir: string): string[] =>
        readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
            .filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file))
            .map((file) => join(dir, file));

    it('put each test file in one project, by directory alone', () => {
        const config = read('vitest.config.ts');
        expect(config).toMatch(/exclude: \[[^\]]*'packages\/client\/\*\*'[^\]]*'tests\/integration\/\*\*'/);
        expect(config).toContain("include: ['tests/integration/**/*.test.?(c|m)[jt]s?(x)']");
        expect(config).toContain("'packages/client',");
        expect(tests('tests/integration').length).toBeGreaterThan(40);
        expect(tests('packages/client/tests').length).toBeGreaterThan(100);
        expect(tests('tests').filter((file) => !file.startsWith('tests/integration/')).length).toBeGreaterThan(300);
        // Nothing outside the three directories would be a test of a bucket's.
        for (const dir of ['src', 'scripts', 'packages/shared/src', 'packages/app-sdk/src', 'packages/plugin-ui/src']) {
            expect(tests(dir), dir).toEqual([]);
        }
    });

    it('leave the release script its check of the notes, which it skips if the test moves', () => {
        expect(read('scripts/release.mjs')).toContain("existsSync(join(root, 'tests/release-notes.test.ts'))");
        expect(existsSync(join(root, 'tests/release-notes.test.ts'))).toBe(true);
    });

    it('leave no client file in the root’s typecheck', () => {
        const files = execFileSync(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--listFilesOnly'], {
            cwd: root,
            maxBuffer: 1e9,
        }).toString();
        expect(files).toContain('src/server/main.ts');
        expect(files).not.toMatch(/\/packages\/(?:client|plugin-ui)\//);
    }, 120_000);

    it('typecheck every project', () => {
        const typecheck = read('scripts/typecheck.mjs');
        const configs = [
            'tests/integration/tsconfig.json',
            ...readdirSync(join(root, 'packages')).map((name) => `packages/${name}/tsconfig.json`),
            'apps/mobile/tsconfig.json',
        ];
        for (const config of configs) {
            expect(existsSync(join(root, config)), config).toBe(true);
            expect(typecheck, config).toContain(config);
        }
    });

    it('name no docs file left out of their inputs', () => {
        // This file's fixtures, the input matrix and the apps' isolation test name them on purpose.
        expect(
            unlistedInputProblems(root).filter(
                (problem) => !/^tests\/integration\/(test-buckets|turbo|apps-isolation)\.test/.test(problem),
            ),
        ).toEqual([]);
    }, 120_000);

    it('notice a test that starts to read one', () => {
        const turbo = JSON.stringify({
            tasks: {
                '//#test:server': {
                    inputs: [
                        '$TURBO_DEFAULT$',
                        '!docs/SETUP.md',
                        '!docs/MEMORY.md',
                        '!docs/RELEASE-*-SCOPE.md',
                        '!apps/mobile/**',
                    ],
                },
            },
        });
        const dir = repo({
            'turbo.json': turbo,
            'packages/client/tests/a.test.ts': "readFileSync('docs/SETUP.md');\n",
            'tests/b.test.ts': "readFileSync('docs/MEMORY.md');\n// docs/SETUP.md in a comment\n",
            'tests/integration/c.test.ts': "join(root, 'docs/RELEASE-1-SCOPE.md');\n",
            'tests/d.test.ts': "readFileSync('docs/RELEASE-NOTES.md');\n",
            'tests/e.test.ts': "join(root, 'apps/mobile/app.json');\n",
            'tests/g.test.ts': "const app = join(root, 'apps/mobile');\n",
            'tests/h.test.ts': "join(root, 'apps', 'mobile', 'app.json');\n",
            'tests/i.test.ts': "join(root, 'apps', 'mobile/app.json');\n",
            // A helper, and the packages' own suites, which the server project runs too.
            'tests/support/app-version.ts': "readFileSync(join(root, 'apps/mobile/app.json'));\n",
            'packages/foundation/tests/j.test.ts': "join(root, 'apps/mobile/app.json');\n",
            'packages/data/tests/k.test.ts': "join(root, 'docs', 'SETUP.md');\n",
            // A workspace app's bundle path is not the native app.
            'tests/f.test.ts': "expect(path).toBe('apps/tracker/bundles/v1.cbapp');\n",
        });
        expect(unlistedInputProblems(dir).sort()).toEqual([
            'packages/client/tests/a.test.ts: names docs/SETUP.md, which is not an input',
            'packages/data/tests/k.test.ts: names docs/SETUP.md, which is not an input',
            'packages/foundation/tests/j.test.ts: names apps/mobile/**, which is not an input',
            'tests/b.test.ts: names docs/MEMORY.md, which is not an input',
            'tests/e.test.ts: names apps/mobile/**, which is not an input',
            'tests/g.test.ts: names apps/mobile/**, which is not an input',
            'tests/h.test.ts: names apps/mobile/**, which is not an input',
            'tests/i.test.ts: names apps/mobile/**, which is not an input',
            'tests/integration/c.test.ts: names docs/RELEASE-*-SCOPE.md, which is not an input',
            'tests/support/app-version.ts: names apps/mobile/**, which is not an input',
        ]);
    });
});
