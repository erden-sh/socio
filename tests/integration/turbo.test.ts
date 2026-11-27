// The cached task graph (turbo.json, scripts/turbo.mjs). Two things here can do
// real harm: a false hit, which turns a broken branch green, and a vendor's
// telemetry. The first half pins the opt-outs; the second changes one file of
// each kind of input in a copy of the repository and checks exactly which tasks'
// hashes move. Turbo's dry run only hashes: nothing runs, and no network.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultCacheDir, GROUPS, turboArgs, turboEnv } from '../../scripts/turbo.mjs';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const json = (path: string) => JSON.parse(read(path));
const PACKAGES = readdirSync(join(root, 'packages'));
/** The apps that are workspace members, with package tasks of their own (apps-isolation.test.ts). */
const APPS = ['apps/mobile', 'apps/push-relay', 'apps/link', 'apps/site'];

describe('the opt-outs', () => {
    const config = json('turbo.json');

    it('pins turbo to one exact version, in the lockfile too', () => {
        const version = json('package.json').devDependencies.turbo;
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(read('pnpm-lock.yaml')).toContain(`turbo@${version}:`);
    });

    it('filters the environment, and turns off the remote cache and the update check', () => {
        expect(config.envMode).toBe('strict');
        expect(config.remoteCache).toEqual({ enabled: false });
        expect(config.noUpdateNotifier).toBe(true);
        expect(config.globalPassThroughEnv.filter((name: string) => /TOKEN|KEY|SECRET|\*/.test(name))).toEqual([]);
        expect(config.globalEnv.filter((name: string) => /TOKEN|KEY|SECRET/.test(name))).toEqual([]);
        for (const dir of [...PACKAGES.map((name) => `packages/${name}`), ...APPS]) {
            const local = json(`${dir}/turbo.json`);
            expect(local.extends, dir).toEqual(['//']);
            expect(Object.keys(local), dir).toEqual(['$schema', 'extends', 'tasks']);
        }
    });

    it('names no daemon option: 2.x never starts one for `turbo run`, and warns about the setting', () => {
        // docs/reference/run.mdx at the pinned version: the flags are ignored
        // and go away in 3.0. Only `turbo watch` and the LSP use a daemon.
        expect(config).not.toHaveProperty('daemon');
        const everything = `${read('scripts/turbo.mjs')}\n${JSON.stringify(json('package.json').scripts)}`;
        expect(everything).not.toMatch(/turbo watch|turbo daemon/);
    });

    it('always runs turbo with telemetry off and nothing inherited that could turn things on', () => {
        const env = turboEnv(
            {
                PATH: '/bin',
                TURBO_TELEMETRY_DISABLED: '0',
                DO_NOT_TRACK: '0',
                TURBO_API: 'https://cache.example.invalid',
                TURBO_TOKEN: 'token',
                TURBO_TEAM: 'team',
                TURBO_REMOTE_ONLY: '1',
                TURBO_EXPERIMENTAL_OTEL_ENABLED: '1',
                VERCEL_ARTIFACTS_TOKEN: 'token',
            },
            () => 'tools',
        );
        expect(env).toMatchObject({
            PATH: '/bin',
            TURBO_TELEMETRY_DISABLED: '1',
            DO_NOT_TRACK: '1',
            TURBO_NO_UPDATE_NOTIFIER: '1',
            NO_UPDATE_NOTIFIER: '1',
            SOCIO_TOOLCHAIN: 'tools',
        });
        for (const name of [
            'TURBO_API',
            'TURBO_TOKEN',
            'TURBO_TEAM',
            'TURBO_REMOTE_ONLY',
            'TURBO_EXPERIMENTAL_OTEL_ENABLED',
            'VERCEL_ARTIFACTS_TOKEN',
        ]) {
            expect(env, name).not.toHaveProperty(name);
        }
    });

    it('uses the local cache alone, whatever the caller asks for', () => {
        expect(turboArgs(['check'])).toContain('--cache=local:rw');
        expect(turboArgs(['check', '--force'])).toContain('--cache=local:w');
        expect(turboArgs(['check', '--force'])).not.toContain('--force');
        expect(turboArgs(['test', '--cache=local:r', '--', '--shard=1/4'])).toEqual([
            'run',
            ...GROUPS.test,
            '--cache=local:r',
            '--concurrency=1',
            '--log-order=grouped',
            '--output-logs=new-only',
            '--continue',
            '--',
            '--shard=1/4',
        ]);
    });

    it('goes through the wrapper everywhere, so nothing runs a bare turbo', () => {
        const scripts = [
            json('package.json'),
            ...PACKAGES.map((name) => json(`packages/${name}/package.json`)),
            ...APPS.map((dir) => json(`${dir}/package.json`)),
        ].flatMap((manifest) => Object.values<string>(manifest.scripts ?? {}));
        expect(scripts.filter((script) => /\bturbo\b/.test(script)).sort()).toEqual([
            'node scripts/turbo.mjs build',
            'node scripts/turbo.mjs check',
            'node scripts/turbo.mjs test',
        ]);
        for (const path of [
            '.github/workflows/ci.yml',
            '.github/ci/turbo.sh',
            '.github/ci/smoke.sh',
            '.github/ci/box.sh',
        ]) {
            const uses = read(path)
                .split('\n')
                .filter((line) => !line.trimStart().startsWith('#') && /\bturbo\b/.test(line));
            expect(
                uses.filter((line) => /(^|[\s'"])(pnpm (exec )?)?turbo\s/.test(line)),
                path,
            ).toEqual([]);
        }
    });

    it('shares results between worktrees by default, somewhere each person can move', () => {
        expect(defaultCacheDir({}, '/home/a')).toBe('/home/a/.cache/socio/turbo');
        expect(defaultCacheDir({ XDG_CACHE_HOME: '/x' }, '/home/a')).toBe('/x/socio/turbo');
        expect(defaultCacheDir({ SOCIO_TURBO_CACHE_DIR: '/y', XDG_CACHE_HOME: '/x' }, '/home/a')).toBe('/y');
        expect(read('scripts/turbo.mjs')).not.toMatch(/\/home\/|\/Users\//);
        expect(json('turbo.json')).not.toHaveProperty('cacheDir');
    });

    it('never ignores the bits turbo leaves in the tree', () => {
        for (const entry of ['.turbo/', '.turbo-ci/']) {
            expect(read('.gitignore').split('\n')).toContain(entry);
        }
    });
});

describe('the graph keeps what the root scripts do', () => {
    const scripts = json('package.json').scripts as Record<string, string>;

    it('builds the same steps, split by what each one reads', () => {
        const steps = (script: string) => script.split(' && ').sort();
        const builds = PACKAGES.filter((name) => json(`packages/${name}/package.json`).scripts?.build);
        expect(builds).toEqual(['client', 'ui']);
        expect(json('packages/client/package.json').scripts.build).toBe('pnpm -w run build:pages');
        expect(scripts['build:packages']).toBe('node scripts/build-packages.mjs');
        expect(steps(scripts.build)).toEqual(
            [
                ...steps(scripts['build:pages']),
                scripts['build:packages'],
                scripts['build:server'],
                scripts['build:release-data'],
                scripts['build:released-migrations'],
            ].sort(),
        );
    });

    it('lints what `pnpm run lint` lints', () => {
        const named = (script: string) => script.replace(/^(pnpm -w exec )?oxlint /, '').split(' ');
        const dirs = [...PACKAGES.map((name) => `packages/${name}`), ...APPS];
        const local = dirs.map((dir) => json(`${dir}/package.json`).scripts.lint);
        expect(named(scripts.lint).filter((path) => path !== 'packages' && !APPS.includes(path))).toEqual(
            named(scripts['lint:root']),
        );
        expect(named(scripts.lint)).toEqual(expect.arrayContaining(['packages', ...APPS]));
        expect(local.flatMap(named).sort()).toEqual(dirs.sort());
    });

    it('never caches the release data: it holds the commit', () => {
        expect(json('turbo.json').tasks['//#build:release-data'].cache).toBe(false);
    });
});

// Each kind of input, and exactly what must rerun. Everything else must hit.
const CLIENT_LINT = '@socio/client#lint';
const CLIENT_TYPECHECK = '@socio/client#typecheck';
const CLIENT_TEST = '@socio/client#test';
const CLIENT_BUILD = '@socio/client#build';
const PLUGIN_TYPECHECK = '@socio/plugin-ui#typecheck';
const PLUGIN_LINT = '@socio/plugin-ui#lint';
const PACKAGE_CHECKS = ['shared', 'i18n', 'foundation', 'data', 'ui'].flatMap((name) => [
    `@socio/${name}#lint`,
    `@socio/${name}#typecheck`,
]);
const BUILD_PACKAGES = '//#build:packages';
const FORMAT = '//#check-format';
const LINT_ROOT = '//#lint:root';
const TYPECHECK_ROOT = '//#typecheck:root';
const TYPECHECK_MIXED = '//#typecheck:mixed';
const SERVER = '//#test:server';
const MIXED = '//#test:mixed';
const BUILD_SERVER = '//#build:server';
/** Reads the server build: it moves with build:server and build:packages, and on its own inputs. */
const BUILD_MIGRATIONS = '//#build:released-migrations';
const MOBILE = ['typecheck', 'lint', 'test', 'build'].map((task) => `@socio/mobile#${task}`);
/** The push relay has no build until its wrangler.toml. */
const RELAY = ['typecheck', 'lint', 'test'].map((task) => `@socio/push-relay#${task}`);
/** The link domain's Worker: no build either. */
const LINK = ['typecheck', 'lint', 'test'].map((task) => `@socio/link#${task}`);
/** The public site: a build too (its static assets). */
const SITE = ['typecheck', 'lint', 'test', 'build'].map((task) => `@socio/site#${task}`);
const ROOT_CODE = [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER];

/** Every task: nothing but what turbo says differs may differ. */
const EVERYTHING = 'everything';
const CASES: [string, string, string[] | typeof EVERYTHING][] = [
    [
        'client source',
        'packages/client/src/lib/utils.ts',
        [
            FORMAT,
            LINT_ROOT,
            CLIENT_LINT,
            CLIENT_TYPECHECK,
            CLIENT_TEST,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
            PLUGIN_LINT,
            TYPECHECK_MIXED,
            MIXED,
        ],
    ],
    // In the CI copy without .git, Turbo includes @socio/ui in the root
    // internal-dependency hash. Source and token edits invalidate that hash.
    ['reusable UI source', 'packages/ui/src/components/button.tsx', EVERYTHING],
    ['shared UI tokens', 'packages/ui/src/styles/tokens.css', EVERYTHING],
    [
        'a client test',
        'packages/client/tests/access-policy-ui.test.tsx',
        [FORMAT, LINT_ROOT, CLIENT_LINT, CLIENT_TYPECHECK, CLIENT_TEST, TYPECHECK_MIXED, MIXED],
    ],
    // What the native app takes from the web client (its theme and its modules)
    // reruns the app's tests too (apps/mobile/turbo.json); the rest of the client doesn't.
    // The public site copies the theme too (apps/site/turbo.json), so its tests rerun as well.
    ...['packages/client/src/shell/tones.ts'].map((path): [string, string, string[]] => [
        'client theme the app and the site read',
        path,
        [
            FORMAT,
            LINT_ROOT,
            CLIENT_LINT,
            CLIENT_TYPECHECK,
            CLIENT_TEST,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
            PLUGIN_LINT,
            TYPECHECK_MIXED,
            MIXED,
            '@socio/mobile#test',
            '@socio/site#test',
        ],
    ]),
    [
        // The site builds its character art from the client's (cream tiles stripped) and tests it.
        'the character art the site serves',
        'packages/client/src/locals/art/sebas.svg',
        [
            FORMAT,
            LINT_ROOT,
            CLIENT_LINT,
            CLIENT_TYPECHECK,
            CLIENT_TEST,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
            PLUGIN_LINT,
            TYPECHECK_MIXED,
            MIXED,
            '@socio/site#test',
            '@socio/site#build',
        ],
    ],
    ...[
        'packages/client/src/modules/types.ts',
        'packages/client/src/modules/issues/module.ts',
        'packages/client/src/modules/chat/module.tsx',
    ].map((path): [string, string, string[]] => [
        'client source the app reads',
        path,
        [
            FORMAT,
            LINT_ROOT,
            CLIENT_LINT,
            CLIENT_TYPECHECK,
            CLIENT_TEST,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
            PLUGIN_LINT,
            TYPECHECK_MIXED,
            MIXED,
            '@socio/mobile#test',
        ],
    ]),
    [
        // The page editor's WebView bundle is built from the web's page editor.
        'the web page editor the app bundles',
        'packages/client/src/modules/pages/editor/markdown.ts',
        [
            FORMAT,
            LINT_ROOT,
            CLIENT_LINT,
            CLIENT_TYPECHECK,
            CLIENT_TEST,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
            PLUGIN_LINT,
            TYPECHECK_MIXED,
            MIXED,
            '@socio/mobile#typecheck',
            '@socio/mobile#test',
        ],
    ],
    [
        'client source beside it that the app doesn’t read',
        'packages/client/src/modules/registry.ts',
        [
            FORMAT,
            LINT_ROOT,
            CLIENT_LINT,
            CLIENT_TYPECHECK,
            CLIENT_TEST,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
            PLUGIN_LINT,
            TYPECHECK_MIXED,
            MIXED,
        ],
    ],
    // The root's manifest depends on these packages, and turbo's global hash takes in
    // the files of the root's workspace dependencies, so every task reruns. More
    // than each needs, but on the safe side, and turbo has no setting for it. The
    // app's typecheck, test and build also name shared's source as an input.
    ['shared source', 'packages/shared/src/locale.ts', EVERYTHING],
    ['foundation source', 'packages/foundation/src/http/allowed-host.ts', EVERYTHING],
    ['data source', 'packages/data/src/uow.ts', EVERYTHING],
    // Their tests run in the server bucket; the global hash is what reruns it.
    ['a foundation test', 'packages/foundation/tests/app-bundle.test.ts', EVERYTHING],
    ['a data test', 'packages/data/tests/migration-ledger.test.ts', EVERYTHING],
    [
        'the packages’ build',
        'scripts/build-packages.mjs',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER, CLIENT_BUILD, BUILD_PACKAGES],
    ],
    [
        'plugin UI source',
        'packages/plugin-ui/src/index.ts',
        [
            FORMAT,
            LINT_ROOT,
            CLIENT_TYPECHECK,
            CLIENT_TEST,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
            PLUGIN_LINT,
            TYPECHECK_MIXED,
            MIXED,
        ],
    ],
    ['server source', 'src/server/platform.ts', ROOT_CODE],
    // The relay's config test holds wrangler.toml's hosts against its DEFAULT_PUSH_HOSTS.
    ['the notifications contract', 'src/server/notifications/contract.ts', [...ROOT_CODE, '@socio/push-relay#test']],
    ['the file every client test loads', 'packages/foundation/src/no-vendor-telemetry.ts', EVERYTHING],
    ['a service', 'src/coding-git/main.ts', ROOT_CODE],
    ['a test helper', 'tests/support/format.ts', [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED]],
    ['a server test', 'tests/ci-workflow.test.ts', [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED]],
    ['a mixed test', 'tests/integration/routes.test.tsx', [FORMAT, LINT_ROOT, TYPECHECK_MIXED, MIXED]],
    ['test setup', 'tests/setup/egress-guard.ts', EVERYTHING],
    ['the lockfile', 'pnpm-lock.yaml', EVERYTHING],
    ['the root manifest', 'package.json', EVERYTHING],
    ['a package manifest', 'packages/app-sdk/package.json', EVERYTHING],
    ['tsconfig', 'tsconfig.json', EVERYTHING],
    ['the server tsconfig', 'tsconfig.server.json', EVERYTHING],
    ['Vitest', 'vitest.shared.ts', EVERYTHING],
    ['the client’s Vitest config, which the root’s loads', 'packages/client/vitest.config.ts', EVERYTHING],
    ['Vite', 'vite.config.ts', EVERYTHING],
    ['oxlint', '.oxlintrc.json', EVERYTHING],
    ['oxfmt', '.oxfmtrc.json', EVERYTHING],
    ['turbo.json', 'turbo.json', EVERYTHING],
    ['a package’s turbo.json', 'packages/client/turbo.json', EVERYTHING],
    // apps-isolation.test.ts reads these two, and no root task's inputs hold an app file.
    ['the app’s manifest', 'apps/mobile/package.json', EVERYTHING],
    ['the app’s turbo.json', 'apps/mobile/turbo.json', EVERYTHING],
    ['the Node version', '.nvmrc', EVERYTHING],
    ['the wrapper', 'scripts/turbo.mjs', EVERYTHING],
    ['the CI image', '.github/ci/Dockerfile', EVERYTHING],
    [
        'a script a test reads',
        'scripts/release.mjs',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER, CLIENT_BUILD],
    ],
    [
        'a script only the build reads',
        'scripts/precompress.mjs',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER, CLIENT_BUILD],
    ],
    [
        'the released migrations',
        'src/server/modules/released-migrations.json',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER],
    ],
    [
        'their check',
        'scripts/released-migrations.mjs',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER, CLIENT_BUILD],
    ],
    ['content', 'content/docs/user/index.md', [FORMAT, SERVER, MIXED, CLIENT_BUILD]],
    ['the release notes', 'docs/RELEASE-NOTES.md', [FORMAT, SERVER, MIXED]],
    [
        'a deployment file',
        'deployment/app-browser/seccomp.json',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER],
    ],
    [
        'compose',
        '.docker/compose.yml',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER],
    ],
    ['the Dockerfile', 'Dockerfile', [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER]],
    [
        'the workflow',
        '.github/workflows/ci.yml',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER],
    ],
    [
        'public files',
        'public/sw.js',
        [FORMAT, LINT_ROOT, TYPECHECK_ROOT, TYPECHECK_MIXED, SERVER, MIXED, BUILD_SERVER, CLIENT_TEST, CLIENT_BUILD],
    ],
    [
        'a vendored package',
        'vendor/noop-segment/package.json',
        [
            FORMAT,
            LINT_ROOT,
            TYPECHECK_ROOT,
            TYPECHECK_MIXED,
            SERVER,
            MIXED,
            BUILD_SERVER,
            CLIENT_TEST,
            CLIENT_TYPECHECK,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
        ],
    ],
    ['docs no test reads', 'docs/SETUP.md', [FORMAT]],
    ['another doc no test reads', 'docs/MEMORY.md', [FORMAT]],
    ['the marketing site', 'marketing/locals.html', [FORMAT]],
    ['this repository’s README', 'README.md', [FORMAT]],
    // The app is a workspace member with its own tasks, and every root task but the format
    // check excludes it by name (turbo would hash it into them), so it reruns those two kinds.
    ['the mobile app', 'apps/mobile/src/app.tsx', [FORMAT, ...MOBILE]],
    ['an app test', 'apps/mobile/tests/variant.test.ts', [FORMAT, ...MOBILE]],
    ['the app’s Metro config', 'apps/mobile/metro.config.js', [FORMAT, ...MOBILE]],
    ['the app’s tsconfig', 'apps/mobile/tsconfig.json', [FORMAT, ...MOBILE]],
    // What prebuild and expo export leave there: git ignores it, and the app's tasks exclude it.
    ['the app’s generated Android project', 'apps/mobile/android/app/build.gradle', []],
    ['the app’s bundles', 'apps/mobile/dist/metadata.json', []],
    // A workspace member too, with its own tasks and none of the app's.
    ['the push relay', 'apps/push-relay/src/index.ts', [FORMAT, ...RELAY]],
    // The site's legal pages state facts these files decide (apps/site/tests/facts.test.ts).
    ['the relay’s registration expiry', 'apps/push-relay/src/registrations.ts', [FORMAT, ...RELAY, '@socio/site#test']],
    ['the phone’s lease', 'apps/mobile/src/data/lease.ts', [FORMAT, ...MOBILE, '@socio/site#test']],
    ['the session cookie', 'src/server/auth/better-auth.ts', [...ROOT_CODE, '@socio/site#test']],
    // The site's delete-account and support pages name these menus' labels (apps/site/tests/facts.test.ts).
    ['the app’s account screen', 'apps/mobile/src/screens/account.tsx', [FORMAT, ...MOBILE, '@socio/site#test']],
    [
        'the web’s user menu',
        'packages/client/src/components/nav-user.tsx',
        [
            FORMAT,
            LINT_ROOT,
            CLIENT_LINT,
            CLIENT_TYPECHECK,
            CLIENT_TEST,
            CLIENT_BUILD,
            PLUGIN_TYPECHECK,
            PLUGIN_LINT,
            TYPECHECK_MIXED,
            MIXED,
            '@socio/site#test',
        ],
    ],
    ['the link domain', 'apps/link/src/index.ts', [FORMAT, ...LINK]],
    ['the public site', 'apps/site/src/worker/index.ts', [FORMAT, ...SITE]],
    // The root's format check never reads it (--disable-nested-config), but hashes it like any file, as the app's tasks do.
    ['an app’s own formatter config', 'apps/mobile/.oxfmtrc.json', [FORMAT, ...MOBILE]],
];

describe('which tasks rerun', () => {
    let copy: string;
    let all: Set<string>;
    let base: Map<string, string>;

    const TASKS = [...GROUPS.check, ...GROUPS.test, ...GROUPS.build];
    const hashes = (extraEnv: Record<string, string> = {}, forwarded: string[] = []) => {
        const env = {
            ...turboEnv(
                { PATH: process.env.PATH, HOME: copy, CI: 'true', ...extraEnv },
                () => extraEnv.TOOLS ?? 'tools',
            ),
            TURBO_CACHE_DIR: join(copy, '.turbo-ci'),
        };
        const result = spawnSync(join(root, 'node_modules/.bin/turbo'), ['run', ...TASKS, '--dry=json', ...forwarded], {
            cwd: copy,
            env,
            maxBuffer: 1e9,
        });
        expect(result.status, result.stderr.toString()).toBe(0);
        const run = JSON.parse(result.stdout.toString()) as { tasks: { taskId: string; hash: string }[] };
        return new Map(run.tasks.map((task) => [task.taskId, task.hash]));
    };
    const moved = (now: Map<string, string>) => [...all].filter((id) => now.get(id) !== base.get(id)).sort();
    /** Runs `change`, and gives the tasks that miss. */
    const changing = (path: string, edit: (text: string) => string) => {
        const file = join(copy, path);
        // A file deleted one day must not fail this test: it may not be an input.
        const original = existsSync(file) ? readFileSync(file) : undefined;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, edit(original?.toString() ?? ''));
        try {
            return moved(hashes());
        } finally {
            if (original) {
                writeFileSync(file, original);
            } else {
                rmSync(file);
            }
        }
    };

    // Everything but what git ignores, as CI's copy has it: no .git, so turbo
    // hashes by walking, and tests read and hash the same files either way.
    beforeAll(() => {
        copy = mkdtempSync(join(tmpdir(), 'turbo-inputs-'));
        // .erden is Erden's installed layers, read-only by design, so the copy
        // couldn't be removed afterwards.
        const skip = new Set(['node_modules', '.git', 'dist', '.turbo', '.turbo-ci', '.react-router', '.erden']);
        // The native app's generated projects and build caches, which git ignores
        // and a worktree that has built the app holds by the gigabyte.
        const appSkip = new Set(['ios', 'android', '.expo', '.android-cache', '.cxx', '.gradle']);
        cpSync(root, copy, {
            recursive: true,
            verbatimSymlinks: true,
            // data/ at the top is the app's databases; packages/data is a package.
            filter: (source) => {
                const parts = relative(root, source).split('/');
                return (
                    !parts.some((part, index) => skip.has(part) || (index === 0 && part === 'data')) &&
                    !(parts[0] === 'apps' && parts.some((part) => appSkip.has(part))) &&
                    !(parts[0] === 'ontology' && parts[1] === 'audit') &&
                    !source.endsWith('src/server/plugins/planner/ui')
                );
            },
        });
        base = hashes();
        all = new Set(base.keys());
    }, 120_000);
    afterAll(() => {
        rmSync(copy, { recursive: true, force: true });
    });

    it('knows every task', () => {
        expect([...all].sort()).toEqual(
            [
                FORMAT,
                LINT_ROOT,
                TYPECHECK_ROOT,
                TYPECHECK_MIXED,
                SERVER,
                MIXED,
                BUILD_SERVER,
                BUILD_MIGRATIONS,
                '//#build:release-data',
                CLIENT_LINT,
                CLIENT_TYPECHECK,
                CLIENT_TEST,
                CLIENT_BUILD,
                PLUGIN_TYPECHECK,
                PLUGIN_LINT,
                '@socio/app-sdk#lint',
                '@socio/app-sdk#typecheck',
                ...MOBILE,
                ...RELAY,
                ...LINK,
                ...SITE,
                ...PACKAGE_CHECKS,
                '@socio/ui#build',
                BUILD_PACKAGES,
            ].sort(),
        );
    });

    it('moves nothing when nothing changed', { timeout: 60_000 }, () => {
        expect(moved(hashes())).toEqual([]);
    });

    it.each(CASES)('after a change to %s (%s)', { timeout: 60_000 }, (_kind, path, expected) => {
        // A blank line is a change to the bytes, and parses in every kind of file.
        const after = changing(path, (text) => `${text}\n`);
        // The release data never hits, whatever changes: it isn't cached, but it hashes all.
        const without = after.filter((id) => id !== '//#build:release-data');
        const want =
            expected === EVERYTHING
                ? [...all].filter((id) => id !== '//#build:release-data')
                : expected.some((id) => id === BUILD_SERVER || id === BUILD_PACKAGES)
                  ? [...expected, BUILD_MIGRATIONS]
                  : expected;
        expect(without.sort()).toEqual([...new Set(want)].sort());
    });

    it('moves on a new file a test could glob, and on a deleted one', { timeout: 60_000 }, () => {
        const file = join(copy, 'tests/support/new-helper.ts');
        writeFileSync(file, 'export const x = 1;\n');
        const added = moved(hashes());
        rmSync(file);
        expect(added).toContain(SERVER);
        expect(added).toContain(TYPECHECK_ROOT);
        expect(added).not.toContain(CLIENT_TEST);
    });

    // CI puts main's feature boundary baseline here (.github/ci/reference-baseline.sh);
    // tests/feature-boundaries.test.ts reads it, so a pass can't replay against another main.
    // CI's copy always has the directory (the baseline or the absent marker), and
    // the hashes above include it: only a directory this test made goes again.
    it("moves the server tests on main's baseline in .ci-reference", { timeout: 60_000 }, () => {
        const dir = join(copy, '.ci-reference');
        const existed = existsSync(dir);
        try {
            expect(changing('.ci-reference/feature-boundary-baseline.json', (text) => `${text}\n`)).toContain(SERVER);
        } finally {
            if (!existed) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it('moves everything on a different toolchain, or environment that decides what runs', { timeout: 60_000 }, () => {
        const tasks = [...all].filter((id) => id !== '//#build:release-data').sort();
        const environments: Record<string, string>[] = [
            { TOOLS: 'node 27' },
            { TZ: 'Asia/Tokyo' },
            { NODE_ENV: 'production' },
            { COMPUTER_ISOLATION_TEST_IMAGE: 'x' },
        ];
        for (const env of environments) {
            expect(
                moved(hashes(env))
                    .filter((id) => id !== '//#build:release-data')
                    .sort(),
                JSON.stringify(env),
            ).toEqual(tasks);
        }
    });

    // With a `!` in its inputs, turbo stops honouring .gitignore when it hashes
    // without git, which is how CI runs: turbo.json has to name all of this.
    it('hashes nothing git ignores: logs, caches, dependencies, databases and builds', { timeout: 60_000 }, () => {
        const junk = [
            '.turbo/turbo-x.log',
            'packages/client/.turbo/turbo-x.log',
            '.turbo-ci/abcdef0123456789.tar.zst',
            'node_modules/x/index.js',
            'packages/client/node_modules/x/index.js',
            'apps/mobile/node_modules/x/index.js',
            'apps/mobile/.turbo/turbo-x.log',
            'dist/server/x.js',
            'packages/shared/dist/x.js',
            'packages/foundation/dist/x.js',
            'data/backups/x.sqlite',
            'src/server/x.sqlite-wal',
            '.react-router/types/x.ts',
            '.env',
            'artifacts/x.png',
            'test-results/x.json',
        ];
        for (const path of junk) {
            mkdirSync(dirname(join(copy, path)), { recursive: true });
            writeFileSync(join(copy, path), 'junk');
        }
        try {
            expect(moved(hashes())).toEqual([]);
        } finally {
            for (const dir of [
                '.turbo',
                'packages/client/.turbo',
                '.turbo-ci',
                'node_modules',
                'packages/client/node_modules',
                'apps/mobile/node_modules',
                'apps/mobile/.turbo',
                'dist',
                'packages/shared/dist',
                'packages/foundation/dist',
                'data',
                '.react-router',
                'artifacts',
                'test-results',
                '.env',
                'src/server/x.sqlite-wal',
            ]) {
                rmSync(join(copy, dir), { recursive: true, force: true });
            }
        }
    });

    it('moves only the mixed bucket when a build leaves what its tests read', { timeout: 60_000 }, () => {
        for (const path of ['dist/web/server/index.js', 'src/server/plugins/planner/ui/planner.js']) {
            mkdirSync(dirname(join(copy, path)), { recursive: true });
            writeFileSync(join(copy, path), 'built');
            try {
                expect(moved(hashes()), path).toEqual([MIXED]);
            } finally {
                rmSync(join(copy, path.startsWith('dist/') ? 'dist' : dirname(path)), { recursive: true });
            }
        }
    });

    // The app's test task gets the flag too: apps/mobile/tests/shards.test.ts runs its four shards.
    it('caches each shard on its own, under every bucket', { timeout: 60_000 }, () => {
        const first = hashes({}, ['--', '--shard=1/4']);
        const second = hashes({}, ['--', '--shard=2/4']);
        for (const id of [SERVER, MIXED, CLIENT_TEST, '@socio/mobile#test']) {
            expect(first.get(id), id).not.toBe(base.get(id));
            expect(first.get(id), id).not.toBe(second.get(id));
        }
    });

    it('ignores a variable no task may see', { timeout: 60_000 }, () => {
        expect(moved(hashes({ OPENAI_API_KEY: 'real-looking', SOME_SHELL_THING: '1' }))).toEqual([]);
    });
});
