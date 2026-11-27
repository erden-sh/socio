#!/usr/bin/env node
// A workspace package stands on its own: its source imports Node built-ins,
// itself (relatively, staying inside src), and the packages its package.json
// declares, among them only packages in a lower layer (LAYERS). Its third-party
// dependencies stay in the root manifest at the same range, because images
// install only that. And what coding-git and coding-egress reach needs no
// third-party module, because those images ship none.
// tests/integration/shared-package.test.ts and tests/integration/package-boundaries.test.ts run this on
// the real packages and on violations.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SyntaxKind } from 'typescript/ast';
import { createScanner } from 'typescript/ast/scanner';

import { builtPackages, workspaceDependencies } from './workspace-packages.mjs';

// Every way source names a module, type positions included. Comments are
// blanked first, so prose about an import isn't one; strings are kept, because
// the specifiers are strings.
const SPECIFIER = [
    /(?:^|;)\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm,
    /(?:^|;)\s*import\s*['"]([^'"\n]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g,
];

// After one of these a slash divides; after anything else it opens a regex. A
// `</` is a JSX closing tag: the scanner here doesn't read JSX.
const ENDS_A_VALUE = /(?:[\w$'"`)\]}]|\+\+|--|<)$/;
const BEFORE_A_REGEX = new Set(
    'await case delete do else in instanceof new of return throw typeof void yield default'.split(' '),
);

/**
 * Blanks comments and regex literals, leaving strings and templates as they
 * are, and every offset and line where it was. A regex after `)` or `}`, as in
 * `if (x) /a/.test(y)`, reads as a division: telling those apart takes a parser.
 */
export function withoutComments(source) {
    const scanner = createScanner(false, undefined, source);
    // The brace depth at each open `\${`, so its `}` resumes the template.
    const templates = [];
    let depth = 0;
    let previous = '';
    let kept = 0;
    let result = '';
    const blank = (end) => {
        const start = scanner.getTokenStart();
        result += source.slice(kept, start) + source.slice(start, end).replace(/[^\r\n]/g, ' ');
        kept = end;
    };
    for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
        if (kind === SyntaxKind.WhitespaceTrivia || kind === SyntaxKind.NewLineTrivia) {
            continue;
        }
        // It doesn't read JSX text, and stays put on a `#` before `{` there.
        if (scanner.getTokenEnd() === scanner.getTokenStart()) {
            scanner.resetTokenState(scanner.getTokenStart() + 1);
            continue;
        }
        if (kind === SyntaxKind.SingleLineCommentTrivia || kind === SyntaxKind.MultiLineCommentTrivia) {
            blank(scanner.getTokenEnd());
            continue;
        }
        if (
            (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
            (BEFORE_A_REGEX.has(previous) || !ENDS_A_VALUE.test(previous))
        ) {
            const start = scanner.getTokenStart();
            scanner.reScanSlashToken();
            if (scanner.isUnterminated()) {
                scanner.resetTokenState(start + 1);
            } else {
                blank(scanner.getTokenEnd());
            }
        } else if (kind === SyntaxKind.TemplateHead) {
            templates.push(depth);
        } else if (kind === SyntaxKind.OpenBraceToken) {
            depth += 1;
        } else if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === depth) {
            if (scanner.reScanTemplateToken(false) === SyntaxKind.TemplateTail) {
                templates.pop();
            }
        } else if (kind === SyntaxKind.CloseBraceToken) {
            depth -= 1;
        }
        previous = scanner.getTokenText();
    }
    return result + source.slice(kept);
}

export const importsOf = (source) => {
    const code = withoutComments(source);
    return SPECIFIER.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]));
};

/** `zod` and `zod/v4` are zod; `@ag-ui/core/x` is @ag-ui/core. */
const packageOf = (specifier) =>
    specifier
        .split('/')
        .slice(0, specifier.startsWith('@') ? 2 : 1)
        .join('/');

/** A type-only package's declarations come from @types (`hast` from @types/hast). */
const typesPackage = (name) => `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;

const sourceFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
    });

/** Each violation as `file: specifier (why)`; empty when the package stands alone. */
export function packageBoundaryProblems(pkg) {
    const manifest = JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8'));
    const declared = new Set(
        [manifest.dependencies, manifest.devDependencies].flatMap((deps) => Object.keys(deps ?? {})),
    );
    const src = resolve(pkg, 'src');
    const tests = resolve(pkg, 'tests');
    const problems = [];
    // A package's own tests import its source; the source imports only itself.
    for (const file of [...sourceFiles(src), ...(existsSync(tests) ? sourceFiles(tests) : [])]) {
        const shown = relative(pkg, file).replaceAll(sep, '/');
        const home = file.startsWith(`${src}${sep}`) ? src : resolve(pkg);
        for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
            if (specifier.startsWith('.')) {
                if (!`${resolve(dirname(file), specifier)}${sep}`.startsWith(`${home}${sep}`)) {
                    problems.push(`${shown}: ${specifier} (leaves the package)`);
                }
            } else if (specifier.startsWith('/') || /^[a-z]+:/.test(specifier)) {
                if (!specifier.startsWith('node:')) {
                    problems.push(`${shown}: ${specifier} (not a package)`);
                }
            } else if (!declared.has(packageOf(specifier)) && !declared.has(typesPackage(packageOf(specifier)))) {
                problems.push(`${shown}: ${specifier} (not declared in package.json)`);
            }
        }
    }
    return problems;
}

/** A statement that loads a module: `import type` and `export type` vanish in the build. */
const VALUE_IMPORT = [
    /(?:^|;)\s*import\s+(?!type\b)[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm,
    /(?:^|;)\s*export\s+(?!type\b)[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm,
    /(?:^|;)\s*import\s*['"]([^'"\n]+)['"]/gm,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g,
];

// `import('x')`, with a `typeof` before it and what may follow its closing
// parenthesis: `.name`, or `[` and a string key if there is one.
const DYNAMIC_IMPORT =
    /(?<![\w$.])(typeof\s+)?import\s*\(\s*['"`]([^'"`\n$]+)['"`]\s*(?:,[^()]*)?\)\s*(?:(\.\s*[\w$]+)|(\[)\s*(?:(['"`])([\w$]*)\5)?)?/g;

/** What ends just before a type: an annotation, a type argument, a union or intersection, `extends`, `keyof`, `type X =`. */
const TYPE_POSITION = /(?:[:<|&]|\bextends|\bkeyof|\btype\s+[\w$]+(?:\s*<[^>]*>)?\s*=)\s*$/;

const PROMISE_MEMBER = /^(?:then|catch|finally)$/;

/**
 * What `import('x')` loads, in comment-free code. A promise has no other member
 * than `then`, `catch` and `finally`, so `import('x').Foo` and `import('x')['Foo']`
 * are types, but `.then` or `['then']` loads, and so does a key that isn't a
 * string literal. `typeof import('x')` is a type only in a type position (after
 * `:`, `<`, `|`, `&`, `extends`, `keyof` or `type X =`); elsewhere, as in
 * `const k = typeof import('x')`, the operand still runs. A bare
 * `type M = import('x')` counts: it isn't told apart from a call, and failing on
 * it is the safe side.
 */
export const dynamicImportsOf = (code) =>
    [...code.matchAll(DYNAMIC_IMPORT)]
        .filter((match) => {
            const [, typeofKeyword, , member, bracket, quote, key] = match;
            if (typeofKeyword && TYPE_POSITION.test(code.slice(0, match.index))) {
                return false;
            }
            if (member) {
                return PROMISE_MEMBER.test(member.replace(/^\.\s*/, ''));
            }
            if (bracket) {
                return !quote || PROMISE_MEMBER.test(key);
            }
            return true;
        })
        .map((match) => match[2]);

/** What loads at run time; an import of only `{ type X }` names vanishes too. */
export function valueImportsOf(source) {
    const code = withoutComments(source).replace(
        /(?:^|;)\s*(?:import|export)\s*\{(?:\s*type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?)*\s*\}\s*from\s*['"][^'"\n]+['"]/gm,
        ' ',
    );
    return [
        ...VALUE_IMPORT.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1])),
        ...dynamicImportsOf(code),
    ];
}

const isBuiltin = (specifier) => specifier.startsWith('node:');

/**
 * Images install the root manifest only, and `dist/server/node_modules/@socio/*`
 * resolves upward to it. So what a package loads at run time is in its own
 * `dependencies` and the root's, at the same range; a dev dependency matches
 * the root's range wherever it is listed there.
 */
export function packageDependencyProblems(pkg, rootManifest) {
    const manifest = JSON.parse(readFileSync(resolve(pkg, 'package.json'), 'utf8'));
    const problems = [];
    const inRoot = { ...rootManifest.devDependencies, ...rootManifest.dependencies };
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        if (rootManifest.dependencies?.[name] === undefined) {
            problems.push(`${manifest.name}: ${name} (not in the root dependencies, so no image has it)`);
        } else if (range !== rootManifest.dependencies[name] && !range.startsWith('workspace:')) {
            problems.push(`${manifest.name}: ${name} ${range} (the root has ${rootManifest.dependencies[name]})`);
        }
    }
    for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
        if (inRoot[name] === undefined) {
            problems.push(`${manifest.name}: ${name} (dev, not in the root manifest)`);
        } else if (range !== inRoot[name] && !range.startsWith('workspace:')) {
            problems.push(`${manifest.name}: ${name} ${range} (the root has ${inRoot[name]})`);
        }
    }
    const src = resolve(pkg, 'src');
    for (const file of sourceFiles(src)) {
        const shown = relative(pkg, file).replaceAll(sep, '/');
        for (const specifier of valueImportsOf(readFileSync(file, 'utf8'))) {
            if (specifier.startsWith('.') || isBuiltin(specifier)) {
                continue;
            }
            if (manifest.dependencies?.[packageOf(specifier)] === undefined) {
                problems.push(`${shown}: ${specifier} (loads at run time, so it belongs in dependencies)`);
            }
        }
    }
    return problems;
}

/** The packages built to dist, lowest first. One may depend only on those before it. */
export const LAYERS = ['@socio/shared', '@socio/i18n', '@socio/foundation', '@socio/data'];

/** A dependency between workspace packages that runs both ways, to the app, or not down the layers. */
export function packageGraphProblems(root) {
    try {
        return builtPackages(root).flatMap(({ manifest }) => {
            const layer = LAYERS.indexOf(manifest.name);
            return [
                ...(layer === -1 ? [`${manifest.name}: not in LAYERS, so nothing says what it may depend on`] : []),
                ...workspaceDependencies(manifest).flatMap((name) => {
                    if (name === '@socio/client' || name === '@socio/app') {
                        return [`${manifest.name}: ${name} (the app sits above every package)`];
                    }
                    const below = LAYERS.indexOf(name);
                    return below === -1 || (layer !== -1 && below >= layer)
                        ? [`${manifest.name}: ${name} (not in a lower layer: ${LAYERS.join(' < ')})`]
                        : [];
                }),
            ];
        });
    } catch (error) {
        return [error.message];
    }
}

const fileFor = (base) =>
    [`${base}.ts`, `${base}.tsx`, base.replace(/\.[cm]?js$/, '.ts'), base.replace(/\.[cm]?js$/, '.tsx'), base].find(
        (path) => existsSync(path) && !path.endsWith('/'),
    );

/** Every third-party module that a file's run-time imports reach, `file: specifier` each. */
export function thirdPartyReach(root, entries) {
    const packages = new Map(builtPackages(root).map(({ name, dir }) => [name, join(root, dir, 'src')]));
    const seen = new Set();
    const reached = [];
    const pending = entries.map((entry) => resolve(root, entry));
    while (pending.length) {
        const file = pending.pop();
        if (seen.has(file)) {
            continue;
        }
        seen.add(file);
        for (const specifier of valueImportsOf(readFileSync(file, 'utf8'))) {
            const name = packageOf(specifier);
            let target;
            if (specifier.startsWith('.')) {
                target = fileFor(resolve(dirname(file), specifier));
            } else if (packages.has(name)) {
                target = fileFor(join(packages.get(name), specifier.slice(name.length + 1)));
            } else if (!isBuiltin(specifier)) {
                reached.push(`${relative(root, file).replaceAll(sep, '/')}: ${specifier}`);
                continue;
            } else {
                continue;
            }
            if (!target) {
                reached.push(`${relative(root, file).replaceAll(sep, '/')}: ${specifier} (not found)`);
            } else {
                pending.push(target);
            }
        }
    }
    return reached;
}

/** coding-git and coding-egress images ship no node_modules (Dockerfile). */
export const NO_DEPENDENCY_SERVICES = ['src/coding-git', 'src/coding-egress'];

/** Every problem in the workspace; empty when it holds. */
export function workspaceProblems(root) {
    const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    // A cycle has no build order, so nothing below it can be walked.
    const graph = packageGraphProblems(root);
    if (graph.length) {
        return graph;
    }
    return [
        ...builtPackages(root).flatMap(({ dir }) => [
            ...packageBoundaryProblems(join(root, dir)),
            ...packageDependencyProblems(join(root, dir), rootManifest),
        ]),
        ...thirdPartyReach(
            root,
            NO_DEPENDENCY_SERVICES.flatMap((service) => sourceFiles(join(root, service))),
        ),
    ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const problems = workspaceProblems(resolve(process.argv[2] ?? '.'));
    if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
    console.log('workspace package boundaries passed');
}
