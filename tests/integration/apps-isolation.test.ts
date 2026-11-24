// apps/mobile, Socio's native app, is a member of the root pnpm workspace: it
// shares pnpm-lock.yaml and has its own package tasks (apps/mobile/turbo.json),
// which the full typecheck and lint name the way they name packages. The root's
// own tasks still leave it out, by name: turbo hashes a member's files into a
// root task's $TURBO_DEFAULT$ like any other file, so every root task but the
// format check excludes apps/mobile, apps/push-relay (its push relay) and
// apps/link (its link domain) and apps/site (its public site), members too. A change to an app's source reruns the format check and
// that app's own tasks (turbo.test.ts moves each kind of file and checks). An
// app nobody listed is hashed, which costs a rerun, never a stale green. No
// image holds the apps. The lockfile guards below walk pnpm-lock.yaml: the
// server's install may reach nothing of the app's tree through an optional
// peer, no React Native or Expo package at all, and no peer off the root's
// version. The app's manifest and turbo.json, which this file reads, are
// global dependencies in turbo.json.
// This file is here because it reads the root's Vitest config, which names the
// client.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import config from '../../vitest.config.ts';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const json = (path: string) => JSON.parse(read(path));
const APPS = ['apps/mobile', 'apps/push-relay', 'apps/link', 'apps/site'];
/** The apps that are workspace members, with package tasks of their own. */
const MEMBERS = ['apps/mobile', 'apps/push-relay', 'apps/link', 'apps/site'];
/** Each member's package tasks. The Workers have no build: the deploy pipeline bundles each when it deploys. The site builds its static assets (vite build), which wrangler serves. */
const APP_TASKS: Record<string, string[]> = {
    'apps/mobile': ['typecheck', 'lint', 'test', 'build'],
    'apps/push-relay': ['typecheck', 'lint', 'test'],
    'apps/link': ['typecheck', 'lint', 'test'],
    'apps/site': ['typecheck', 'lint', 'test', 'build'],
};
const underApps = (path: string) => path === 'apps' || path.startsWith('apps/');

type Task = { inputs?: string[] };
type Project = string | { test?: { name?: string; include?: string[]; exclude?: string[] } };

describe('the apps stay out of the root', () => {
    it('leave every root task but the format check', () => {
        const { tasks } = json('turbo.json') as { tasks: Record<string, Task> };
        const walking = Object.entries(tasks).filter(([, task]) => task.inputs?.includes('$TURBO_DEFAULT$'));
        expect(walking.map(([id]) => id)).toContain('//#check-format');
        for (const [id, task] of walking) {
            const excluded = APPS.filter((app) => task.inputs?.includes(`!${app}/**`));
            expect(excluded, id).toEqual(id === '//#check-format' ? [] : APPS);
        }
    });

    it('have no tests the root suite runs', () => {
        const projects = (config.test?.projects ?? []) as Project[];
        const named = (name: string) =>
            projects.find((project) => typeof project !== 'string' && project.test?.name === name);
        const server = named('server');
        const mixed = named('mixed');
        expect(typeof server === 'object' && server.test?.exclude).toContain('apps/**');
        // The mixed project names what it runs, so it can't reach them.
        expect(typeof mixed === 'object' && mixed.test?.include).toEqual([
            'tests/integration/**/*.test.?(c|m)[jt]s?(x)',
        ]);
        expect(projects.filter((project) => typeof project === 'string')).toEqual(['packages/client']);
    });

    it("are left out of the root's own typecheck and lint, and named in the full ones like packages", () => {
        // What tsc loads, imports included, not what the configs say.
        for (const project of ['tsconfig.json', 'tsconfig.server.json', 'tests/integration/tsconfig.json']) {
            const listed = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', project, '--listFilesOnly'], {
                cwd: root,
                encoding: 'utf8',
                maxBuffer: 1e8,
            });
            expect(listed.status, listed.stderr).toBe(0);
            const files = listed.stdout.split('\n').filter(Boolean);
            expect(files.length, project).toBeGreaterThan(100);
            expect(files.map((file) => relative(root, file)).filter(underApps), project).toEqual([]);
        }
        const { scripts } = json('package.json') as { scripts: Record<string, string> };
        expect(scripts['lint:root'].split(' ').filter(underApps)).toEqual([]);
        expect(scripts.lint.split(' ').filter(underApps)).toEqual(MEMBERS);
        expect(scripts['typecheck:root']).toBe('node scripts/typecheck.mjs root');
        // Three full tsc file listings: seconds on a workstation, more on a shared CI runner.
    }, 120_000);

    it('have their own typecheck, lint, test and build tasks, and a typecheck part', () => {
        const typecheck = read('scripts/typecheck.mjs');
        const { globalDependencies } = json('turbo.json') as { globalDependencies: string[] };
        for (const app of MEMBERS) {
            // This test reads them, and the root's tasks exclude the apps: only the global hash can rerun it.
            expect(globalDependencies, app).toEqual(
                expect.arrayContaining([`${app}/package.json`, `${app}/turbo.json`]),
            );
            const { tasks } = json(`${app}/turbo.json`) as { tasks: Record<string, Task> };
            const { scripts } = json(`${app}/package.json`) as { scripts: Record<string, string> };
            // Turbo skips a task with no script, silently.
            expect(Object.keys(tasks).sort(), app).toEqual([...(APP_TASKS[app] ?? [])].sort());
            expect(Object.keys(scripts), app).toEqual(expect.arrayContaining(APP_TASKS[app] ?? []));
            expect(typecheck).toContain(`'-p', '${app}/tsconfig.json'`);
        }
        // app.config.ts picks the variant from APP_VARIANT. The root runs turbo in strict
        // env mode, so unlisted, the build would never see it: every variant would build
        // as development and share one cache entry.
        const { tasks } = json('apps/mobile/turbo.json') as { tasks: Record<string, Task & { env?: string[] }> };
        expect(tasks.build?.env).toContain('APP_VARIANT');
    });

    // Expo CLI sends telemetry unless EXPO_NO_TELEMETRY or EXPO_OFFLINE is set
    // (it never reads DO_NOT_TRACK), and without EXPO_OFFLINE a running Metro
    // reports each dev session to Expo (hostname, app name, device ids).
    it("run every expo command with Expo's telemetry and dev-session reports off", () => {
        for (const app of ['apps/mobile']) {
            const { scripts } = json(`${app}/package.json`) as { scripts: Record<string, string> };
            const expo = Object.entries(scripts).filter(([, script]) => /(^|\s)expo\s/.test(script));
            expect(expo.length, app).toBeGreaterThan(0);
            for (const [name, script] of expo) {
                const before = script.slice(0, script.search(/(^|\s)expo\s/)).split(/\s+/);
                expect(before, `${app} ${name}`).toEqual(
                    expect.arrayContaining(['cross-env', 'EXPO_NO_TELEMETRY=1', 'EXPO_OFFLINE=1', 'DO_NOT_TRACK=1']),
                );
            }
        }
    });

    // Wrangler sends usage metrics unless WRANGLER_SEND_METRICS=false (or its
    // config's send_metrics) says otherwise; DO_NOT_TRACK covers the rest.
    it('run every wrangler command with its metrics off', () => {
        for (const app of MEMBERS) {
            const { scripts } = json(`${app}/package.json`) as { scripts: Record<string, string> };
            for (const [name, script] of Object.entries(scripts).filter(([, s]) => /(^|\s)wrangler\s/.test(s))) {
                const before = script.slice(0, script.search(/(^|\s)wrangler\s/)).split(/\s+/);
                expect(before, `${app} ${name}`).toEqual(
                    expect.arrayContaining(['cross-env', 'WRANGLER_SEND_METRICS=false', 'DO_NOT_TRACK=1']),
                );
            }
        }
        for (const app of ['apps/push-relay', 'apps/link', 'apps/site']) {
            const { scripts } = json(`${app}/package.json`) as { scripts: Record<string, string> };
            expect(
                Object.values(scripts).some((script) => /(^|\s)wrangler\s/.test(script)),
                app,
            ).toBe(true);
        }
    });

    it('go into no image', () => {
        expect(read('.dockerignore').split('\n')).toContain('apps');
    });

    it('are formatted like the rest, except what is vendored or generated', () => {
        const { ignorePatterns } = json('.oxfmtrc.json') as { ignorePatterns: string[] };
        expect(ignorePatterns.filter((pattern) => ['apps', 'apps/**', ...APPS].includes(pattern))).toEqual([]);
        expect(ignorePatterns).toEqual(
            expect.arrayContaining([
                'apps/*/vendor',
                'apps/mobile/ios',
                'apps/mobile/android',
                'apps/mobile/.expo',
                'apps/mobile/deps',
                'apps/push-relay/worker-configuration.d.ts',
                'apps/link/.wrangler',
                'apps/link/worker-configuration.d.ts',
                'apps/site/.wrangler',
                'apps/site/dist',
                'apps/site/worker-configuration.d.ts',
            ]),
        );
    });

    // oxfmt would read an app's own config instead of the root's, and drop the
    // root's ignores there. The root's format check never looks for one, so
    // the rule holds in the one task that hashes the apps' files, and this
    // test reads nothing under apps/.
    it("never reads an app's own formatter config", () => {
        const { scripts } = json('package.json') as { scripts: Record<string, string> };
        expect(scripts['check-format']).toBe('oxfmt --check --disable-nested-config');
        expect(scripts.format).toBe('oxfmt --disable-nested-config');
        const dir = mkdtempSync(join(tmpdir(), 'apps-format-'));
        try {
            const files = {
                '.oxfmtrc.json': JSON.stringify({ ignorePatterns: ['apps/*/vendor', '**/.oxfmtrc.json'] }),
                'apps/x/.oxfmtrc.json': JSON.stringify({}),
                'apps/x/vendor/generated.ts': 'export   const x=1\n',
                'apps/x/src/app.ts': 'export const y = 2;\n',
            };
            for (const [path, text] of Object.entries(files)) {
                mkdirSync(dirname(join(dir, path)), { recursive: true });
                writeFileSync(join(dir, path), text);
            }
            const check = (...flags: string[]) =>
                spawnSync(join(root, 'node_modules/.bin/oxfmt'), ['--check', ...flags], { cwd: dir, encoding: 'utf8' })
                    .status;
            expect(check()).toBe(1);
            expect(check('--disable-nested-config')).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// The lockfile. pnpm links an optional peer whenever any project in the
// workspace has it: when a spike of the app had expo-sqlite, the server's
// drizzle-orm (and better-auth through it) got it as a peer, and with it expo
// and react-native, in the images' install too. Metro's terser and Expo's
// Babel preset's React Compiler plugin would reach vite and
// @vitejs/plugin-react the same way. Root overrides drop such peers from server
// packages (pnpm-workspace.yaml, overrides: "drizzle-orm>expo-sqlite": "-" and
// the like). The leak check below finds any package the server reaches only
// through an optional peer that the app's own tree holds, whatever its name;
// a second check names the React Native and Expo packages, for a server
// dependency that pulls them in some other way. Neither sees a peer that
// resolves to another version of a package the server already has, such as
// packages/foundation's zod (docs/TOOLING.md): the peer check does.

interface PackageMeta {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface Lockfile {
    importers: Record<string, Partial<Record<string, Record<string, { version: string }>>>>;
    packages: Record<string, PackageMeta | undefined>;
    snapshots: Record<string, Partial<Record<string, Record<string, string>>>>;
}

/** Packages only the app needs: React Native, Expo, Metro, Hermes, React Navigation and the page editor's tentap. */
const APP_ONLY = [
    /^react-native$/,
    /^react-native-/,
    /^@react-native\//,
    /^@react-native-community\//,
    /^expo$/,
    /^expo-/,
    /^@expo\//,
    /^metro$/,
    /^metro-/,
    /^hermes-/,
    /^@react-navigation\//,
    /^@10play\//,
];

/** A snapshot key's package name: `@scope/name@1.0.0(peer@2.0.0)` gives `@scope/name`. */
const nameOf = (key: string) => key.slice(0, key.indexOf('@', 1));

/** A snapshot key without the peers it resolved: `a@1(b@2)` gives `a@1`, the package's key. */
const baseOf = (key: string) => key.split('(')[0];

/** A dependency's snapshot key, from its name and the version the lockfile gives (an alias is a key already). */
const keyOf = (name: string, version: string) => {
    if (/^(link|file|workspace):/.test(version)) {
        return undefined;
    }
    const bare = version.split('(')[0];
    return /^(@[^/]+\/)?[^@/]+@/.test(bare) ? version : `${name}@${version}`;
};

/** The peers resolved in a snapshot key's suffix, each a snapshot key itself: `a@1(b@2(c@3))(d@4)` gives `b@2(c@3)` and `d@4`. */
const resolvedPeers = (key: string) => {
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
};

const SERVER = (id: string) => !underApps(id);

/**
 * The packages (name@version) some importers reach: their dependencies,
 * devDependencies and optionalDependencies, then each snapshot's own and the
 * peers resolved in its key, transitively.
 *
 * With `optionalPeers: false`, the walk takes no edge to an optional peer of
 * the package it leaves, wherever pnpm wrote it: in the key's suffix, or in
 * the snapshot's dependencies or optionalDependencies, where a resolved
 * optional peer shows up too (vite's terser). A key's suffix also names peers
 * of the package's dependencies; those are left to the dependency's own
 * snapshot, which names them again.
 */
function closure(lock: Lockfile, from: (importer: string) => boolean, { optionalPeers }: { optionalPeers: boolean }) {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const [id, importer] of Object.entries(lock.importers)) {
        if (!from(id)) {
            continue;
        }
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            for (const [name, { version }] of Object.entries(importer[section] ?? {})) {
                const key = keyOf(name, version);
                if (key) {
                    queue.push(key);
                }
            }
        }
    }
    for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const meta = lock.packages[baseOf(key)] ?? {};
        const peers = meta.peerDependencies ?? {};
        const optional = (name: string) =>
            Object.hasOwn(peers, name) && meta.peerDependenciesMeta?.[name]?.optional === true;
        const snapshot = lock.snapshots[key] ?? {};
        for (const section of ['dependencies', 'optionalDependencies']) {
            for (const [name, version] of Object.entries(snapshot[section] ?? {})) {
                const next = keyOf(name, version);
                if (next && (optionalPeers || !optional(name))) {
                    queue.push(next);
                }
            }
        }
        for (const peer of resolvedPeers(key)) {
            const name = nameOf(peer);
            if (optionalPeers || (Object.hasOwn(peers, name) && !optional(name))) {
                queue.push(peer);
            }
        }
    }
    return new Set([...seen].map(baseOf));
}

/**
 * The packages the server's install holds only because an optional peer of a
 * server package resolved to something the app's own tree holds: what the
 * importers outside apps/ reach with every edge, that the app reaches without
 * optional peers, and that they don't reach without them. Empty when nothing leaks.
 */
function leaked(lock: Lockfile) {
    const server = closure(lock, SERVER, { optionalPeers: true });
    const serverPlain = closure(lock, SERVER, { optionalPeers: false });
    const app = closure(lock, underApps, { optionalPeers: false });
    return [...server].filter((key) => app.has(key) && !serverPlain.has(key)).sort();
}

/** The app-only packages the server's closure reaches, by name: empty when it reaches none. */
const appOnlyReached = (lock: Lockfile) =>
    [...new Set([...closure(lock, SERVER, { optionalPeers: true })].map(nameOf))]
        .filter((name) => APP_ONLY.some((rule) => rule.test(name)))
        .sort();

/** Every peer resolved in a version or key, nested ones too: `a@1(b@2(c@3))` gives `b@2(c@3)` and `c@3`. */
const allPeers = (key: string): string[] => resolvedPeers(key).flatMap((peer) => [peer, ...allPeers(peer)]);

/**
 * The peers resolved in the importers outside apps/ that differ from the
 * version the root importer declares for that package, as
 * `importer dependency: peer@version (root: version)`. Empty when every one matches.
 */
function peerDrift(lock: Lockfile) {
    const sections = ['dependencies', 'devDependencies', 'optionalDependencies'];
    const rootVersions = new Map(
        sections.flatMap((section) =>
            Object.entries(lock.importers['.']?.[section] ?? {}).map(([name, { version }]) => [name, baseOf(version)]),
        ),
    );
    const drift: string[] = [];
    for (const [id, importer] of Object.entries(lock.importers)) {
        if (!SERVER(id)) {
            continue;
        }
        for (const section of sections) {
            for (const [name, { version }] of Object.entries(importer[section] ?? {})) {
                for (const peer of allPeers(version)) {
                    const peerName = nameOf(peer);
                    const peerVersion = baseOf(peer).slice(peerName.length + 1);
                    const root = rootVersions.get(peerName);
                    if (root !== undefined && root !== peerVersion) {
                        drift.push(`${id} ${name}: ${peerName}@${peerVersion} (root: ${root})`);
                    }
                }
            }
        }
    }
    return [...new Set(drift)].sort();
}

// The negative proof runs this file against a lockfile made without an
// override: APPS_ISOLATION_LOCKFILE=<path> pnpm exec vitest run --project mixed
// tests/integration/apps-isolation.test.ts. Turbo passes no such variable.
const lockfilePath = process.env.APPS_ISOLATION_LOCKFILE ?? join(root, 'pnpm-lock.yaml');
const lockfile = () => parse(readFileSync(lockfilePath, 'utf8')) as Lockfile;

describe("the server's install holds none of the app's packages", () => {
    it('reaches nothing of the app through an optional peer, and no app-only package at all', () => {
        const lock = lockfile();
        const server = closure(lock, SERVER, { optionalPeers: true });
        // A walk that found nothing would pass too: it must reach the server's own tree, and the app's.
        expect(server.size).toBeGreaterThan(1000);
        expect([...server].some((key) => key.startsWith('drizzle-orm@'))).toBe(true);
        expect([...closure(lock, underApps, { optionalPeers: false })].some((key) => key.startsWith('metro@'))).toBe(
            true,
        );
        expect(leaked(lock)).toEqual([]);
        expect(appOnlyReached(lock)).toEqual([]);
    });

    it('keeps every importer outside apps/ on the root’s version of each peer it resolves', () => {
        expect(peerDrift(lockfile())).toEqual([]);
        const drifted: Lockfile = {
            importers: {
                '.': { dependencies: { zod: { version: '4.6.5' }, '@tanstack/ai': { version: '0.63.0(zod@4.6.5)' } } },
                'packages/foundation': {
                    devDependencies: { '@copilotkit/runtime': { version: '1.75.0(openai@6.49.0(zod@3.25.76))' } },
                },
                'apps/mobile': { dependencies: { x: { version: '1.0.0(zod@3.25.76)' } } },
            },
            packages: {},
            snapshots: {},
        };
        expect(peerDrift(drifted)).toEqual(['packages/foundation @copilotkit/runtime: zod@3.25.76 (root: 4.6.5)']);
    });

    it('follows the peers in a snapshot key, which is how the leak came in', () => {
        const rn = 'react-native@0.88.1(react@19.3.0)';
        const expo = `expo@58.0.23(react-native@0.88.1(react@19.3.0))(react@19.3.0)`;
        const sqlite = `expo-sqlite@58.0.15(${expo})(react-native@0.88.1(react@19.3.0))(react@19.3.0)`;
        const drizzle = `drizzle-orm@1.0.0-rc.4(${sqlite})(zod@4.6.5)`;
        const leaky: Lockfile = {
            importers: {
                '.': {
                    dependencies: {
                        'better-auth': { version: `1.7.10(${drizzle})` },
                        'drizzle-orm': { version: drizzle.slice('drizzle-orm@'.length) },
                    },
                },
                'apps/mobile': {
                    dependencies: {
                        'expo-sqlite': { version: sqlite.slice('expo-sqlite@'.length) },
                        metro: { version: '0.84.4' },
                    },
                },
            },
            packages: {
                'better-auth@1.7.10': {
                    peerDependencies: { 'drizzle-orm': '*' },
                    peerDependenciesMeta: { 'drizzle-orm': { optional: true } },
                },
                'drizzle-orm@1.0.0-rc.4': {
                    peerDependencies: { 'expo-sqlite': '*', zod: '*' },
                    peerDependenciesMeta: { 'expo-sqlite': { optional: true }, zod: { optional: true } },
                },
                'expo-sqlite@58.0.15': { peerDependencies: { expo: '*', 'react-native': '*', react: '*' } },
                'expo@58.0.23': { peerDependencies: { 'react-native': '*', react: '*' } },
                'react-native@0.88.1': { peerDependencies: { react: '*' } },
            },
            snapshots: {
                // better-auth lists drizzle-orm only as a peer in its key, and
                // the drizzle-orm snapshot names no dependency at all.
                [`better-auth@1.7.10(${drizzle})`]: { dependencies: { zod: '4.6.5' } },
                [drizzle]: {},
                [sqlite]: {},
                [expo]: {},
                'zod@4.6.5': {},
                'react@19.3.0': {},
                [rn]: {},
                'metro@0.84.4': {},
            },
        };
        expect(resolvedPeers(drizzle)).toEqual([sqlite, 'zod@4.6.5']);
        expect(appOnlyReached(leaky)).toEqual(['expo', 'expo-sqlite', 'react-native']);
        expect(leaked(leaky)).toEqual(['expo-sqlite@58.0.15', 'expo@58.0.23', 'react-native@0.88.1', 'react@19.3.0']);
        delete leaky.importers['.'];
        expect(appOnlyReached(leaky)).toEqual([]);
        expect(leaked(leaky)).toEqual([]);
    });

    it('catches an optional peer pnpm wrote in a snapshot’s optionalDependencies, whatever its name', () => {
        const vite = 'vite@8.3.1(terser@5.51.2)';
        const leaky: Lockfile = {
            importers: {
                '.': { devDependencies: { vite: { version: '8.3.1(terser@5.51.2)' } } },
                'apps/mobile': { dependencies: { metro: { version: '0.84.4' } } },
            },
            packages: {
                'vite@8.3.1': {
                    peerDependencies: { terser: '^5' },
                    peerDependenciesMeta: { terser: { optional: true } },
                },
            },
            snapshots: {
                // As pnpm writes it: the resolved optional peer is in the key and in optionalDependencies.
                [vite]: { dependencies: { esbuild: '0.28.2' }, optionalDependencies: { terser: '5.51.2' } },
                'esbuild@0.28.2': {},
                'metro@0.84.4': { dependencies: { 'metro-minify-terser': '0.84.4' } },
                'metro-minify-terser@0.84.4': { dependencies: { terser: '5.51.2' } },
                'terser@5.51.2': { dependencies: { acorn: '8.19.0' } },
                'acorn@8.19.0': {},
            },
        };
        // The names alone pass it: terser and acorn are no React Native or Expo package.
        expect(appOnlyReached(leaky)).toEqual([]);
        expect(leaked(leaky)).toEqual(['acorn@8.19.0', 'terser@5.51.2']);
        // With the override, vite resolves no terser, and nothing leaks.
        leaky.importers['.'] = { devDependencies: { vite: { version: '8.3.1' } } };
        leaky.snapshots['vite@8.3.1'] = { dependencies: { esbuild: '0.28.2' } };
        expect(leaked(leaky)).toEqual([]);
    });
});

describe('one copy of React', () => {
    it('gives react, react-dom and @types/react one version each, the one react-native resolves', () => {
        const lock = lockfile();
        const versions = (name: string) =>
            Object.keys(lock.packages)
                .filter((key) => nameOf(key) === name)
                .map((key) => key.slice(name.length + 1));
        const app = lock.importers['apps/mobile'];
        const native = app?.dependencies?.['react-native']?.version ?? '';
        const peers = resolvedPeers(`react-native@${native}`);
        expect(native).toMatch(/^\d/);
        for (const name of ['react', '@types/react']) {
            expect(versions(name), name).toHaveLength(1);
            expect(peers, name).toContain(`${name}@${versions(name)[0]}`);
        }
        expect(versions('react-dom')).toEqual(versions('react'));
    });
});
