#!/usr/bin/env node
// @socio/client stands alone: its source and tests can't reach server code or
// the service directories. They import Node built-ins, themselves (relatively,
// or through `@/`, which is the package's src) and the packages its
// package.json declares. tests/integration/client-package.test.ts runs this on the real
// package and on violations.
//
// It also holds the package's manifest to the root's. Images install from the
// root manifest alone and the pages' server build loads packages at run time
// from /app/node_modules, so a package only the client declares would work in
// development and fail in an image (packages/client/README.md).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { importsOf, withoutComments } from './check-package-boundary.mjs';

// What the shared check doesn't read, because only this package has it: mocks
// by path, globs and files named by location. A glob or a mock that names code
// outside the package reaches it as surely as an import.
const LOCATED = [
    /\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^>]*>\s*)?\(\s*['"`]([^'"`\n]+)['"`]/g,
    /\bimport\.meta\.glob\s*(?:<[^>]*>\s*)?\(\s*['"`]([^'"`\n]+)['"`]/g,
    /\bnew URL\(\s*['"`]([^'"`\n]+)['"`]\s*,\s*import\.meta\.url/g,
];
const SERVER_DIR =
    '(?:src/(?:server|net|app-browser|apps-runtime|coding-egress|coding-git|egress|updater)|packages/(?:foundation|data))';
// A path in any string (`readFileSync('src/server/x.ts')`), where no import form applies.
const NAMES_SERVER = new RegExp(`(?:^|[^\\w-])${SERVER_DIR}(?:/|$)`);
const STRING = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\[\s\S])*)`/g;
// Relative references in stylesheets and pages.
const ASSET = [
    /@(?:import|source|config|plugin)\s+(?:url\()?['"]([^'"\n]+)['"]/g,
    /\b(?:src|href)=["']([^"'\n]+)["']/g,
];
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const ASSET_FILE = /\.(?:css|html)$/;

/** `zod` and `zod/v4` are zod; `@ag-ui/core/x` is @ag-ui/core. */
const packageOf = (specifier) =>
    specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/');

/** A type-only package's declarations come from @types (`hast` from @types/hast). */
const typesPackage = (name) => `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;

const filesUnder = (dir) =>
    existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
              const path = resolve(dir, entry.name);
              return entry.isDirectory()
                  ? filesUnder(path)
                  : CODE_FILE.test(entry.name) || ASSET_FILE.test(entry.name)
                    ? [path]
                    : [];
          })
        : [];

const inside = (path, dir) => `${path}${sep}`.startsWith(`${dir}${sep}`);

/** Everything a code file's text names by location. */
export const locatedOf = (source) => {
    const code = withoutComments(source);
    return LOCATED.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]));
};

/** The strings in a code file that name a server or service directory. */
export const serverPathsIn = (source) =>
    [...withoutComments(source).matchAll(STRING)]
        .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
        .filter((text) => NAMES_SERVER.test(text));

/** Each violation as `file: specifier (why)`; empty when the package stands alone. */
export function clientBoundaryProblems(pkg) {
    const manifest = JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8'));
    const declared = new Set(
        [manifest.dependencies, manifest.devDependencies].flatMap((deps) => Object.keys(deps ?? {})),
    );
    const src = resolve(pkg, 'src');
    // A public file the page loads (theme-init.js) is the app's, not code to import.
    const publicDir = resolve(pkg, '../../public');
    const siblings = resolve(pkg, '..');
    const problems = [];
    for (const file of [...filesUnder(src), ...filesUnder(resolve(pkg, 'tests'))]) {
        const shown = relative(pkg, file).replaceAll(sep, '/');
        const text = readFileSync(file, 'utf8');
        const report = (specifier, why) => problems.push(`${shown}: ${specifier} (${why})`);
        if (ASSET_FILE.test(file)) {
            for (const pattern of ASSET) {
                for (const [, reference] of text.matchAll(pattern)) {
                    if (!reference.startsWith('.')) {
                        continue;
                    }
                    const target = resolve(dirname(file), reference);
                    // The two UI packages supply Tailwind classes to globals.css.
                    const uiSource =
                        pattern === ASSET[0] &&
                        [
                            ['@socio/plugin-ui', 'plugin-ui'],
                            ['@socio/ui', 'ui'],
                        ].some(
                            ([name, directory]) => declared.has(name) && inside(target, resolve(siblings, directory)),
                        );
                    if (!inside(target, resolve(pkg)) && !uiSource) {
                        report(reference, 'leaves the package');
                    }
                }
            }
            continue;
        }
        for (const specifier of [...importsOf(text), ...locatedOf(text)]) {
            if (specifier.startsWith('.')) {
                const target = resolve(dirname(file), specifier);
                const located = locatedOf(text).includes(specifier) && !importsOf(text).includes(specifier);
                if (!inside(target, resolve(pkg)) && !(located && inside(target, publicDir))) {
                    report(specifier, 'leaves the package');
                }
            } else if (specifier.startsWith('@/')) {
                if (!inside(resolve(src, specifier.slice(2)), src)) {
                    report(specifier, 'leaves the package');
                }
            } else if (specifier.startsWith('/') || /^[a-z]+:/.test(specifier)) {
                if (!specifier.startsWith('node:')) {
                    report(specifier, 'not a package');
                }
            } else if (!declared.has(packageOf(specifier)) && !declared.has(typesPackage(packageOf(specifier)))) {
                report(specifier, 'not declared in package.json');
            }
        }
        for (const path of serverPathsIn(text)) {
            report(path, 'names server code');
        }
    }
    return problems;
}

/**
 * Each way the client's manifest can drift from the root's. `dependencies`
 * must be root `dependencies` (images install those alone); `devDependencies`
 * must be in the root's manifest at all (the image's build stage installs only
 * that one). Ranges must match, so both resolve to one version in the lockfile.
 */
export function clientManifestProblems(pkg, root) {
    const manifest = JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8'));
    const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const problems = [];
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        if (rootManifest.dependencies?.[name] === undefined) {
            problems.push(`${name}: not in the root's dependencies, so production images don't install it`);
        } else if (rootManifest.dependencies[name] !== range) {
            problems.push(`${name}: ${range} here, ${rootManifest.dependencies[name]} at the root`);
        }
    }
    for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
        const atRoot = rootManifest.dependencies?.[name] ?? rootManifest.devDependencies?.[name];
        if (atRoot === undefined) {
            problems.push(`${name}: not in the root's manifest, so the image's build stage doesn't install it`);
        } else if (atRoot !== range) {
            problems.push(`${name}: ${range} here, ${atRoot} at the root`);
        }
    }
    return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const pkg = resolve(process.argv[2] ?? 'packages/client');
    const problems = [...clientBoundaryProblems(pkg), ...clientManifestProblems(pkg, resolve(pkg, '../..'))];
    if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
    console.log('@socio/client boundary passed');
}
