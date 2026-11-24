#!/usr/bin/env node
// The server test bucket stays away from the client. A change to the client
// doesn't rerun that bucket (turbo.json), so a test there that reached the
// client could stay green on a broken one. This follows each server test's
// imports through tests/, src/, scripts/ and the workspace packages, and fails
// on any route to packages/client, packages/plugin-ui or tests/integration (not
// an input of that bucket either): an import, the `@/` alias, a mock, a glob or
// a path in a string. Run by
// tests/integration/test-buckets.test.ts; tests/setup/no-client-*.ts catch the
// same at run time, for paths built in ways no reading of the source shows.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { importsOf, withoutComments } from './check-package-boundary.mjs';

const LOCATED = [
    /\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^>]*>\s*)?\(\s*['"`]([^'"`\n]+)['"`]/g,
    /\bimport\.meta\.glob\s*(?:<[^>]*>\s*)?\(\s*['"`]([^'"`\n]+)['"`]/g,
    /\bnew URL\(\s*['"`]([^'"`\n]+)['"`]\s*,\s*import\.meta\.url/g,
];
// A path in any string, however it is split: 'packages/client/x', or
// join(root, 'packages', 'client').
const NAMES_CLIENT =
    /['"`][^'"`\n]*packages\/(?:client|plugin-ui)\b|['"`]packages['"`]\s*,\s*['"`](?:client|plugin-ui)\b/;
const EXTENSIONS = [
    '',
    '.ts',
    '.tsx',
    '.mts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.json',
    '/index.ts',
    '/index.tsx',
    '/index.js',
];
const CODE = /\.[cm]?[jt]sx?$/;

const clientSide = (root, path) =>
    ['packages/client', 'packages/plugin-ui', 'tests/integration'].some((dir) =>
        `${path}${sep}`.startsWith(`${join(root, dir)}${sep}`),
    );

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/** The file a specifier names, trying `.js` written for a `.ts` source too. */
const resolveFile = (from, target) => {
    const stem = resolve(from, target);
    const swapped = stem
        .replace(/\.js$/, '.ts')
        .replace(/\.jsx$/, '.tsx')
        .replace(/\.mjs$/, '.mts');
    return [...EXTENSIONS.map((extension) => `${stem}${extension}`), swapped].find(isFile);
};

/** Workspace specifiers as the server's tests resolve them (vitest.shared.ts, tsconfig.json). */
const workspaceTarget = (root, specifier) => {
    if (specifier === '@' || specifier.startsWith('@/')) {
        return join(root, 'packages/client/src', specifier.slice(2));
    }
    if (specifier.startsWith('@socio/plugin-ui') || specifier.startsWith('@socio/client')) {
        return join(root, 'packages/plugin-ui/src/index.ts');
    }
    if (specifier.startsWith('@socio/shared/')) {
        return join(root, 'packages/shared/src', specifier.slice('@socio/shared/'.length));
    }
    if (specifier.startsWith('@socio/app-sdk')) {
        const sub = specifier.slice('@socio/app-sdk'.length).replace(/^\//, '') || 'index';
        return join(root, 'packages/app-sdk/src', sub);
    }
    return undefined;
};

const testsUnder = (dir, skip) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return path === skip ? [] : testsUnder(path, skip);
        }
        return /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
    });

/**
 * Each route from a server test to the client as `test -> ... -> file`, or a
 * string that names it; empty when the bucket keeps away. `root` is a
 * repository, real or a fixture.
 */
export function testBucketProblems(root) {
    const tests = testsUnder(join(root, 'tests'), join(root, 'tests/integration'));
    const shown = (path) => relative(root, path).replaceAll(sep, '/');
    // Paths in strings count only in the tests' side of the repository: the
    // server's own source mentions the client's files in messages and routes.
    const inTests = (path) => shown(path).startsWith('tests/') || shown(path).startsWith('scripts/');
    const problems = [];
    const visited = new Map();
    for (const test of tests) {
        const queue = [[test, [shown(test)]]];
        const seen = new Set([test]);
        while (queue.length) {
            const [file, route] = queue.shift();
            if (visited.has(file)) {
                continue;
            }
            visited.set(file, true);
            const source = readFileSync(file, 'utf8');
            if (inTests(file) && NAMES_CLIENT.test(withoutComments(source))) {
                problems.push(`${route.join(' -> ')}: names the client's files in a string`);
            }
            const located = LOCATED.flatMap((pattern) =>
                [...withoutComments(source).matchAll(pattern)].map((match) => match[1]),
            );
            for (const specifier of [...importsOf(source), ...located]) {
                const target = specifier.startsWith('.')
                    ? resolve(dirname(file), specifier)
                    : workspaceTarget(root, specifier);
                if (!target) {
                    continue;
                }
                const next = resolveFile(dirname(file), target);
                if (clientSide(root, target) || (next && clientSide(root, next))) {
                    problems.push(`${[...route, shown(next ?? target)].join(' -> ')}: reaches the client`);
                } else if (next && CODE.test(next) && !seen.has(next)) {
                    seen.add(next);
                    queue.push([next, [...route, shown(next)]]);
                }
            }
        }
    }
    return problems;
}

/** A path pattern's segment as a regex: `*` stays inside the segment. */
const segmentPattern = (segment) => segment.replace(/[.+^$()|[\]{}\\]/g, '\\$&').replaceAll('*', '[^/\'"`]*');

/**
 * A negated glob from turbo.json as a pattern over a path in a test's strings,
 * however it is split: `'docs/SETUP.md'`, `join(root, 'apps', 'mobile/app.json')`,
 * `join(root, 'apps', 'mobile', 'app.json')`, and a folder glob's folder alone
 * (`'apps/mobile'`).
 */
const excludedPattern = (glob) => {
    const path = glob.slice(1);
    const folder = path.endsWith('/**');
    const segments = (folder ? path.slice(0, -'/**'.length) : path).split('/').map(segmentPattern);
    const boundary = '(?:/|[\'"`]\\s*,\\s*[\'"`])';
    return new RegExp(`['"\`/]${segments.join(boundary)}${folder ? '(?:/|[\'"`])' : ''}`);
};

/** Where the test projects' files live: every one of them, helpers and fixtures included. */
const SUITES = ['tests', 'packages/client/tests', 'packages/foundation/tests', 'packages/data/tests'];

const codeUnder = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : codeUnder(path);
        }
        return CODE.test(entry.name) ? [path] : [];
    });

/**
 * Every file of the test projects that names, in a string, a docs, marketing
 * or apps file the buckets leave out of their inputs: reading it would give a
 * test an input turbo doesn't see, and a stale green. Empty when none does.
 *
 * A best-effort guard, by name: it reads each file under the suites' roots, but
 * doesn't follow imports out of them (a src/ or scripts/ helper that reads one
 * of those files gets through), and can't see a path built at run time. The
 * apps are excluded from the inputs one by one, which bounds what it can miss.
 */
export function unlistedInputProblems(root) {
    const { tasks } = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
    const left = (tasks['//#test:server'].inputs ?? []).filter((glob) => /^!(docs|marketing|apps)\//.test(glob));
    const patterns = left.map((glob) => [glob, excludedPattern(glob)]);
    const files = SUITES.filter((dir) => existsSync(join(root, dir))).flatMap((dir) => codeUnder(join(root, dir)));
    return files.flatMap((test) => {
        const code = withoutComments(readFileSync(test, 'utf8'));
        return patterns
            .filter(([, pattern]) => pattern.test(code))
            .map(
                ([glob]) =>
                    `${relative(root, test).replaceAll(sep, '/')}: names ${glob.slice(1)}, which is not an input`,
            );
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const problems = testBucketProblems(resolve(import.meta.dirname, '..'));
    for (const problem of problems) {
        console.error(problem);
    }
    if (problems.length) {
        console.error('Move these tests to tests/integration: the server bucket does not rerun on client changes.');
        process.exit(1);
    }
}
