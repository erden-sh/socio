#!/usr/bin/env node
// The server's features talk through contracts. A feature is a top-level
// folder of src/server; a root-level file that isn't an entry file is a
// feature of its own. Entry files start a process or compose the server, and
// may import anything: ENTRY_FILES, and every file under
// src/server/composition/ (ENTRY_PREFIXES), the composition root split into a
// file per feature. The rules:
//
//   1. Contract only: a non-entry file in feature A imports from feature B
//      (B != A) only B/contract.ts.
//   2. Entry files aren't a back door: only entry files import entry files.
//   3. Layers are private: only entry files (and tests, which live outside
//      src/server) import a layer.ts.
//   4. Contracts are leaves: a contract.ts imports only effect, @socio/* and
//      other contract.ts files, plus, with `import type` only, the modules in
//      CONTRACT_TYPE_IMPORTS (node:*, hono, @copilotkit/runtime/v2, @ag-ui/*,
//      @tanstack/ai, drizzle-orm, @modelcontextprotocol/sdk/*); contracts
//      import each other in no cycle.
//   5. Numbers only fall: the largest file SCC, the largest SCC that spans
//      features, and the largest feature SCC (edges from entry files left out)
//      never rise above the baseline.
//
// The imports that break rule 1 today, and the three numbers, are recorded in
// scripts/feature-boundary-baseline.json. An import missing from it fails, and
// so does an entry whose import is gone. The baseline is also held against the
// one on main (referenceBaseline below), so a change can't add an exception by
// editing the file: its numbers may not rise, its rule 1 total may not rise,
// and no feature may start importing a file of another feature that main's
// baseline doesn't have it importing (historyProblems). The file lists exact
// file pairs, for review; history holds them as (source feature, target file),
// so a refactor that splits or moves code between files inside one feature
// passes, even when two of the new files import the same target.
// tests/feature-boundaries.test.ts runs all of it.
//
// Reported, not enforced yet: scripts/feature-ranks.json declares a folder
// order, and the guard counts the
// imports that point up it, over the edges rule 5's feature SCC counts. Cutting
// all of them is what takes that SCC to 0. The count is printed, and listed
// with --ranks, but it isn't in the baseline and fails nothing. A rank file
// the guard can't read fails, as the baseline does.
//
// The runtime checks (runtimeReport, enforced since Platform was deleted):
// no platform-needs.ts; no `Effect.run*` outside the composition root
// (composition/, main.ts, index.ts) and the process entries in
// RUN_ENTRY_FILES; and no `ManagedRuntime.make` outside main.ts and the same
// process entries, so each process has one runtime.
// Each hit fails the guard with its file and line (runtimeProblems).
//
// The import graph is read with TypeScript's own parser and module resolver
// (the `typescript/sync` API of TypeScript 7, already a dependency), not with
// patterns. Every way a file can name another module is either read or fails
// the guard with its file and line (referencesOf lists them): anything the
// scanner can't classify fails, nothing is skipped. Packages are left out of
// the graph: they can't import the server (scripts/check-package-boundary.mjs),
// so they can't close a cycle in it.
//
// What it defends against: The guard catches accidental boundary breaks and
// keeps the numbers honest. It doesn't stop a branch that sets out to hide an
// import; review covers that, along with edits to the guard itself, to the rank
// file, and to what goes under composition/: a file there may import anything,
// and only rule 2 (nothing but an entry file imports it) keeps it from being a
// way around rule 1. The history rule holds rule 1 entries by source feature
// and target file, not by file pair: inside feature A, any number of files may
// import a file of B that some file of A imported on main. A split can widen
// that (two files where there was one, as live/views/issues.ts and
// live/views/state.ts both importing issues/auto-triage.ts), but A depends on
// nothing it didn't, rule 5 still caps the file SCC, the total can't rise (so
// the extra entry is paid for by a cut elsewhere), and the baseline diff shows
// every pair. A file of B that A didn't import before, a new feature pair, or
// an entry moved to another source feature fails. The history rule's limit: a
// target file moved or split inside B (x/a.ts into x/a.ts and x/b.ts) looks
// like a new target and fails, since the history check has only main's
// baseline, not git's rename list, and can't tell a move from a new dependency.
// To land one, leave the old path re-exporting what moved, so A keeps importing
// it, or point A's imports at B's contract.ts. Rule 4's type-only allowance
// trusts TypeScript to erase `import type`; `import { type X }` keeps the
// declaration, so it counts as a value import.
// Known limits:
// - a path built as a string at run time and handed to fs, fork or a Worker
//   (`join(import.meta.dirname, ...)`) names no module the parser can see;
// - JSDoc types (`@import`, `{import('...')}`), which TypeScript ignores in .ts;
// - the one allowed exception, web/prod.ts loading the React Router page build
//   from outside src/server (ALLOWED_UNREAD);
// - a file that declares its own `require` or `module` (a loop variable named
//   `module`) isn't checked for Node's loader of that name.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeFlags, SyntaxKind } from 'typescript/ast';
import { API, ModuleKind, ModuleResolutionKind } from 'typescript/sync';

export const SERVER = 'src/server';
export const BASELINE = 'scripts/feature-boundary-baseline.json';
/** The declared folder order, top first: reported, not enforced yet. */
export const RANKS = 'scripts/feature-ranks.json';
/** Where CI's trusted step puts main's baseline in the copy it tests (.github/ci/reference-baseline.sh). */
export const REFERENCE_DIR = '.ci-reference';

/**
 * Files that start a process or compose the server, relative to src/server:
 * the server's entry files, and the three other files that start a process
 * (classify/eval-main.ts runs classify/eval-cli.ts; the Dockerfile starts
 * analytics-main.ts and planner/main.ts).
 */
export const ENTRY_FILES = new Set([
    'index.ts',
    'app.ts',
    'healthcheck.ts',
    'main.ts',
    'modules/index.ts',
    'modules/boot.ts',
    'modules/mount.ts',
    'modules/migrate-cli.ts',
    'auth/cli.ts',
    'auth/auth-cli.ts',
    'backup/backup-cli.ts',
    'bundle/bundle-cli.ts',
    'classify/eval-cli.ts',
    'keys/key-id-cli.ts',
    'purge/purge-cli.ts',
    'classify/eval-main.ts',
    'operations/analytics/analytics-main.ts',
    'dataspace/analytics/worker.ts',
    'plugins/planner/main.ts',
]);

/**
 * Folders whose every file is an entry file, relative to src/server: the
 * composition root, split into a file per feature. Only a top-level folder:
 * `x/composition/` is x's own code, and a root-level `composition.ts` is a
 * feature. Rule 2 keeps it a dead end, so feature code can't reach another
 * feature through it.
 */
export const ENTRY_PREFIXES = ['composition/'];

/** The feature a server file belongs to: its top-level folder, or the file itself at the root. */
export const featureOf = (file) => (file.includes('/') ? file.slice(0, file.indexOf('/')) : file);
export const isEntry = (file) => ENTRY_FILES.has(file) || ENTRY_PREFIXES.some((prefix) => file.startsWith(prefix));
/** A feature's contract: `<feature>/contract.ts`, at the top of its folder. */
export const isContract = (file) => /^[^/]+\/contract\.ts$/.test(file);
/** A layer.ts, or the same module under another TypeScript extension, so the rule can't be stepped around. */
export const isLayer = (file) => /^layer\.(?:[cm]?ts|tsx|d\.[cm]?ts)$/.test(basename(file));

/**
 * Every TypeScript module and declaration file the server's tsconfig can
 * compile or read: .ts, .tsx, .mts, .cts, and .d.ts, .d.mts, .d.cts.
 */
export const TYPESCRIPT_MODULE = /\.(?:[cm]?ts|tsx)$/;

const serverFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : serverFiles(path);
        }
        return TYPESCRIPT_MODULE.test(entry.name) ? [path] : [];
    });

const isFile = (path) => existsSync(path) && statSync(path).isFile();

/**
 * How tsconfig.server.json resolves modules (tests/feature-boundaries.test.ts
 * holds the two together). TypeScript's own resolver does the work, so `.js`
 * and `.jsx` find `.ts`, `.tsx` or `.d.ts`, `.mjs` finds `.mts` or `.d.mts`,
 * and `.cjs` finds `.cts` or `.d.cts`, in its order.
 */
export const RESOLUTION = {
    module: ModuleKind.NodeNext,
    moduleResolution: ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    resolveJsonModule: true,
    noEmit: true,
};
/** TypeScript's resolution modes: an `import` and a `require`. */
const ESM = 99;
const CJS = 1;

/**
 * The references the guard can't read that are allowed anyway, each by file
 * and by the exact code of the reference (whitespace aside), never by line.
 * An entry that matches nothing fails, so it goes when its code does.
 */
export const ALLOWED_UNREAD = [
    {
        file: 'web/prod.ts',
        code: 'import(pathToFileURL(file).href)',
        why: 'loads the React Router page build from outside src/server',
    },
];

/** `import.meta` properties that name no other module. */
const IMPORT_META_PLAIN = new Set(['url', 'dirname', 'filename', 'main']);

const isString = (node) =>
    node?.kind === SyntaxKind.StringLiteral || node?.kind === SyntaxKind.NoSubstitutionTemplateLiteral;

const WRAPPERS = new Set([
    SyntaxKind.ParenthesizedExpression,
    SyntaxKind.AsExpression,
    SyntaxKind.SatisfiesExpression,
    SyntaxKind.NonNullExpression,
    SyntaxKind.TypeAssertionExpression,
]);

/** An expression without `( )`, `as`, `satisfies`, `!`, `<T>` and the left side of a comma: `(0, f)` is `f`. */
function unwrap(node) {
    let inner = node;
    for (;;) {
        if (inner && WRAPPERS.has(inner.kind)) {
            inner = inner.expression;
        } else if (inner?.kind === SyntaxKind.BinaryExpression && inner.operatorToken.kind === SyntaxKind.CommaToken) {
            inner = inner.right;
        } else {
            return inner;
        }
    }
}

/** A string literal, unwrapped, or undefined. */
function literalOf(node) {
    const inner = unwrap(node);
    return isString(inner) ? inner.text : undefined;
}

/** `{ object, name }` for `a.b`, and for `a['b']` (a string-literal key); undefined otherwise. */
function memberOf(node) {
    const inner = unwrap(node);
    if (inner?.kind === SyntaxKind.PropertyAccessExpression) {
        return { object: unwrap(inner.expression), name: inner.name.text };
    }
    if (inner?.kind === SyntaxKind.ElementAccessExpression && literalOf(inner.argumentExpression) !== undefined) {
        return { object: unwrap(inner.expression), name: literalOf(inner.argumentExpression) };
    }
    return undefined;
}

const isImportMeta = (node) =>
    node?.kind === SyntaxKind.MetaProperty &&
    node.keywordToken === SyntaxKind.ImportKeyword &&
    node.name.text === 'meta';
const isNamed = (node, name) => node?.kind === SyntaxKind.Identifier && node.text === name;

/** Names that load or resolve a module at run time: CommonJS's `require` and `module`, and `createRequire`. */
const LOADERS = new Set(['require', 'module', 'createRequire']);

const same = (a, b) => a && b && a.kind === b.kind && a.pos === b.pos && a.end === b.end;

/** Declarations whose `name` names a member, not a binding: `issues.require(n)`, `require(n) { ... }`. */
const MEMBER_NAMES = new Set([
    SyntaxKind.PropertyAccessExpression,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.MethodSignature,
    SyntaxKind.PropertyDeclaration,
    SyntaxKind.PropertySignature,
    SyntaxKind.PropertyAssignment,
    SyntaxKind.GetAccessor,
    SyntaxKind.SetAccessor,
    SyntaxKind.EnumMember,
]);

/** An identifier that only names a member; `createRequire` never counts as one. */
const namesAMember = (node) =>
    node.text !== 'createRequire' && MEMBER_NAMES.has(node.parent?.kind) && same(node.parent.name, node);

/** Declarations whose `name` binds a local name. */
const BINDINGS = new Set([
    SyntaxKind.VariableDeclaration,
    SyntaxKind.Parameter,
    SyntaxKind.BindingElement,
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.ClassDeclaration,
    SyntaxKind.ImportClause,
    SyntaxKind.ImportSpecifier,
    SyntaxKind.NamespaceImport,
]);

/**
 * `require` and `module` the file declares itself, as a loop variable or a
 * parameter (`for (const module of modules)`): those are its own values, not
 * Node's loaders. `createRequire` is never local: binding it is what fails.
 */
function declaredNames(sourceFile) {
    const names = new Set();
    const visit = (node) => {
        if (
            node.kind === SyntaxKind.Identifier &&
            (node.text === 'require' || node.text === 'module') &&
            BINDINGS.has(node.parent?.kind) &&
            same(node.parent.name, node)
        ) {
            names.add(node.text);
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
    return names;
}

/**
 * Every way a parsed file names another module, each as
 * `{ specifier, mode, line, typeOnly }`, and `{ line, why }` for each one the guard can't
 * classify: a reference whose target isn't a string literal, or a form it
 * doesn't follow. Anything that could name a module and isn't read here fails;
 * nothing is skipped. The forms:
 *
 * - `import` and `export ... from` (type-only too), `import x = require()`;
 * - `import()`, `require()`, `require.resolve()` and `import.meta.resolve()`
 *   calls, their argument a string literal under `( )`, `as`, `satisfies`, `!`;
 * - `import('...')` types, `typeof import('...')` among them;
 * - `declare module '...'`, which augments the module it names;
 * - `/// <reference path>` and `/// <reference types>`;
 * - `new URL('...', import.meta.url)`, how a worker or child process is found.
 *
 * Callees, URL bases and arguments are read through `( )`, `as`,
 * `satisfies`, `!` and commas, and `a['b']` with a literal key as `a.b`.
 * `typeOnly` marks a reference TypeScript always erases: `import type`,
 * `export type ... from`, `import type x = require()` and an `import('...')`
 * type. `import { type X }` isn't one: the declaration stays (with
 * verbatimModuleSyntax, as `import {}`), so the module still loads.
 *
 * These fail outright: `require`, `module` and `createRequire` used any other
 * way (aliased, passed, destructured, or `createRequire` from a namespace),
 * unless the file declares `require` or `module` itself; and any `import.meta`
 * but `.url`, `.dirname`, `.filename`, `.main` or a call of `.resolve`.
 */
function referencesOf(sourceFile, fileMode) {
    const found = [];
    const failed = [];
    const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const take = (node, argument, mode, form, { spawn = false, typeOnly = false } = {}) => {
        const specifier = literalOf(argument);
        if (specifier === undefined) {
            failed.push({
                line: lineOf(node),
                why: `${form} with an argument that isn't a string literal`,
                code: node.getText().replace(/\s+/g, ''),
            });
        } else {
            found.push({ specifier, mode, line: lineOf(node), spawn, typeOnly });
        }
    };
    const fail = (node, why) => failed.push({ line: lineOf(node), why });
    // Names that hold a module loader. A use the guard doesn't read as a call fails.
    const local = declaredNames(sourceFile);
    const visit = (node) => {
        switch (node.kind) {
            case SyntaxKind.ImportDeclaration:
                if (node.moduleSpecifier) {
                    take(node, node.moduleSpecifier, fileMode, 'an import or export', {
                        typeOnly: node.importClause?.isTypeOnly === true,
                    });
                }
                break;
            case SyntaxKind.ExportDeclaration:
                if (node.moduleSpecifier) {
                    take(node, node.moduleSpecifier, fileMode, 'an import or export', {
                        typeOnly: node.isTypeOnly === true,
                    });
                }
                break;
            case SyntaxKind.ExternalModuleReference:
                take(node, node.expression, CJS, 'import x = require()', {
                    typeOnly:
                        node.parent?.kind === SyntaxKind.ImportEqualsDeclaration && node.parent.isTypeOnly === true,
                });
                break;
            case SyntaxKind.ImportType:
                take(node, node.argument?.literal, fileMode, "an import('...') type", { typeOnly: true });
                break;
            case SyntaxKind.ModuleDeclaration:
                if (isString(node.name)) {
                    take(node, node.name, fileMode, 'declare module');
                }
                break;
            case SyntaxKind.CallExpression: {
                const callee = unwrap(node.expression);
                const member = memberOf(callee);
                const form =
                    callee?.kind === SyntaxKind.ImportKeyword
                        ? ['import()', fileMode]
                        : isNamed(callee, 'require') && !local.has('require')
                          ? ['require()', CJS]
                          : member?.name === 'resolve' && isNamed(member.object, 'require') && !local.has('require')
                            ? ['require.resolve()', CJS]
                            : member?.name === 'resolve' && isImportMeta(member.object)
                              ? ['import.meta.resolve()', ESM]
                              : undefined;
                if (form) {
                    take(node, node.arguments[0], form[1], form[0]);
                    // The callee is read; the arguments may hold more references.
                    node.arguments.forEach(visit);
                    return;
                }
                break;
            }
            case SyntaxKind.NewExpression: {
                const base = memberOf(node.arguments?.[1]);
                if (isNamed(unwrap(node.expression), 'URL') && base?.name === 'url' && isImportMeta(base.object)) {
                    take(node, node.arguments[0], ESM, 'new URL(..., import.meta.url)', { spawn: true });
                    node.arguments.forEach(visit);
                    return;
                }
                break;
            }
            case SyntaxKind.MetaProperty:
                if (isImportMeta(node)) {
                    // Only `import.meta.url` and the like as a value; `resolve` only as the call read above.
                    let outer = node.parent;
                    while (outer && WRAPPERS.has(outer.kind)) {
                        outer = outer.parent;
                    }
                    const member = memberOf(outer);
                    if (!member || !isImportMeta(member.object) || !IMPORT_META_PLAIN.has(member.name)) {
                        fail(
                            node,
                            `import.meta${member && isImportMeta(member.object) ? `.${member.name}` : ''}: the guard reads only url, dirname, filename, main and a call of resolve`,
                        );
                    }
                }
                break;
            case SyntaxKind.Identifier:
                if (LOADERS.has(node.text) && !local.has(node.text) && !namesAMember(node)) {
                    fail(
                        node,
                        node.text === 'createRequire'
                            ? "createRequire: the guard can't follow a require it makes"
                            : `${node.text}: used other than as a call the guard reads, so it can't follow it`,
                    );
                }
                break;
            case SyntaxKind.StringLiteral:
                // `x['createRequire']` is `x.createRequire`.
                if (node.text === 'createRequire' && node.parent?.kind === SyntaxKind.ElementAccessExpression) {
                    fail(node, "createRequire: the guard can't follow a require it makes");
                }
                break;
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
    for (const reference of sourceFile.referencedFiles ?? []) {
        found.push({
            specifier: reference.fileName,
            mode: fileMode,
            line: sourceFile.getLineAndCharacterOfPosition(reference.pos).line + 1,
            path: true,
        });
    }
    for (const reference of sourceFile.typeReferenceDirectives ?? []) {
        found.push({
            specifier: reference.fileName,
            mode: fileMode,
            line: sourceFile.getLineAndCharacterOfPosition(reference.pos).line + 1,
        });
    }
    // What TypeScript itself collected while parsing must all be here: a form
    // added to the language later fails rather than slip past.
    const seen = new Set(found.map(({ specifier }) => specifier));
    for (const name of [...(sourceFile.imports ?? []), ...(sourceFile.moduleAugmentations ?? [])]) {
        if (isString(name) && !seen.has(name.text)) {
            failed.push({
                line: lineOf(name),
                why: `'${name.text}': TypeScript sees a reference the guard didn't read`,
            });
        }
    }
    return { found, failed };
}

/** `Effect`'s functions that run an effect, which only the composition root and the process entries call. */
export const EFFECT_RUNS = ['runPromise', 'runSync', 'runFork', 'runPromiseExit', 'runSyncExit', 'runCallback'];

const FUNCTION_LIKE = new Set([
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
    SyntaxKind.Constructor,
    SyntaxKind.GetAccessor,
    SyntaxKind.SetAccessor,
]);

/** The names a binding name (`x`, `{ a: x, ...y }`, `[x, , z]`) declares, added to `into`. */
function bindingNames(name, into) {
    if (name?.kind === SyntaxKind.Identifier) {
        into.add(name.text);
    } else if (name?.kind === SyntaxKind.ObjectBindingPattern || name?.kind === SyntaxKind.ArrayBindingPattern) {
        for (const element of name.elements) {
            if (element.kind === SyntaxKind.BindingElement) {
                bindingNames(element.name, into);
            }
        }
    }
}

/** The names a list of statements declares at its own level: let, const, var, function, class, enum, namespace. */
function statementNames(statements, into) {
    for (const statement of statements ?? []) {
        if (statement.kind === SyntaxKind.VariableStatement) {
            for (const declaration of statement.declarationList.declarations) {
                bindingNames(declaration.name, into);
            }
        } else if (
            (statement.kind === SyntaxKind.FunctionDeclaration ||
                statement.kind === SyntaxKind.ClassDeclaration ||
                statement.kind === SyntaxKind.EnumDeclaration ||
                statement.kind === SyntaxKind.ModuleDeclaration) &&
            statement.name?.kind === SyntaxKind.Identifier
        ) {
            into.add(statement.name.text);
        }
    }
}

/** The `var` names a function body declares in nested blocks (they hoist to the function), not crossing a function or class. */
function hoistedVars(node, into) {
    node.forEachChild((child) => {
        if (
            FUNCTION_LIKE.has(child.kind) ||
            child.kind === SyntaxKind.ClassDeclaration ||
            child.kind === SyntaxKind.ClassExpression
        ) {
            return;
        }
        if (child.kind === SyntaxKind.VariableDeclarationList && (child.flags & NodeFlags.BlockScoped) === 0) {
            for (const declaration of child.declarations) {
                bindingNames(declaration.name, into);
            }
        }
        hoistedVars(child, into);
    });
}

/**
 * The local names a node declares as a scope, other than the file's imports:
 * a block's (or the file's) own declarations; a function's parameters, its
 * own name if it is an expression, and its `var`s; a `for` loop's variables;
 * a `catch` variable; a class expression's name.
 */
function scopeNames(node) {
    const names = new Set();
    switch (node.kind) {
        case SyntaxKind.SourceFile:
        case SyntaxKind.Block:
        case SyntaxKind.ModuleBlock:
            statementNames(node.statements, names);
            break;
        case SyntaxKind.CaseBlock:
            for (const clause of node.clauses) {
                statementNames(clause.statements, names);
            }
            break;
        case SyntaxKind.ForStatement:
        case SyntaxKind.ForInStatement:
        case SyntaxKind.ForOfStatement:
            if (node.initializer?.kind === SyntaxKind.VariableDeclarationList) {
                for (const declaration of node.initializer.declarations) {
                    bindingNames(declaration.name, names);
                }
            }
            break;
        case SyntaxKind.CatchClause:
            bindingNames(node.variableDeclaration?.name, names);
            break;
        case SyntaxKind.ClassExpression:
            bindingNames(node.name, names);
            break;
    }
    if (FUNCTION_LIKE.has(node.kind)) {
        for (const parameter of node.parameters) {
            bindingNames(parameter.name, names);
        }
        if (node.kind === SyntaxKind.FunctionExpression) {
            bindingNames(node.name, names);
        }
        if (node.body) {
            hoistedVars(node.body, names);
        }
    }
    return names;
}

/**
 * Where a file uses `Effect.run*` or `ManagedRuntime.make` from the effect
 * package, each as `{ line, use }` (`use` is `Effect.runPromise`,
 * `ManagedRuntime.make`, ...). The bindings that hold the module's `Effect`:
 * `import { Effect } from 'effect'` (under any local name), `import * as X
 * from 'effect/Effect'`, and `X.Effect` for `import * as X from 'effect'`;
 * the same for `ManagedRuntime` and 'effect/ManagedRuntime'; and each run
 * function imported by name from 'effect/Effect' or 'effect/ManagedRuntime'
 * (`import { runPromise }`, `import { make as m }`).
 *
 * A use is a reference to one of those bindings, resolved by scope: an
 * identifier counts only where no enclosing scope declares the same name
 * (a parameter, a local function, a `const`, a `catch` variable, ...). It is
 * a member read (`Effect.runPromise(...)`, `Effect['runFork']`, passing
 * `Effect.runPromise` as a value), a reference to a run function imported by
 * name (a call, passing it, `{ runPromise }` shorthand in an object), one
 * destructured from the module (`const { runPromise: run } = Effect`), or a
 * re-export of one (`export { runPromise }`, `export { make } from
 * 'effect/ManagedRuntime'`): the guard doesn't follow imports of the
 * re-exporting file, so the re-export is where it reports the run.
 *
 * Not uses: `import type`, `import { type X }`, `typeof` in a type, property
 * names (`x.runPromise`, `{ runPromise: 1 }`, the key in `const { runPromise:
 * r } = other`), and a shadowing local of the same name. Known limits: an
 * alias the file makes itself (`const E = Effect`) and `export * from
 * 'effect/Effect'` aren't followed; review covers them.
 */
function runtimeUsesOf(sourceFile) {
    const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    /** Local name -> the module it holds: 'effect', 'Effect' or 'ManagedRuntime'. */
    const modules = new Map();
    /** Local name -> the use it is, for functions imported by name. */
    const functions = new Map();
    const usesOf = { Effect: EFFECT_RUNS, ManagedRuntime: ['make'] };
    const moduleNamed = (specifier) =>
        specifier === 'effect'
            ? 'effect'
            : specifier === 'effect/Effect'
              ? 'Effect'
              : specifier === 'effect/ManagedRuntime'
                ? 'ManagedRuntime'
                : undefined;
    const found = [];
    for (const statement of sourceFile.statements) {
        const from = isString(statement.moduleSpecifier) ? moduleNamed(statement.moduleSpecifier.text) : undefined;
        // `export { runPromise } from 'effect/Effect'`: a re-export with no local binding.
        if (statement.kind === SyntaxKind.ExportDeclaration && !statement.isTypeOnly && from && from !== 'effect') {
            for (const element of statement.exportClause?.elements ?? []) {
                const exported = (element.propertyName ?? element.name).text;
                if (!element.isTypeOnly && usesOf[from].includes(exported)) {
                    found.push({ line: lineOf(element), use: `${from}.${exported}` });
                }
            }
        }
        const clause = statement.importClause;
        if (statement.kind !== SyntaxKind.ImportDeclaration || !clause || clause.isTypeOnly || !from) {
            continue;
        }
        if (clause.name && from !== 'effect') {
            modules.set(clause.name.text, from);
        }
        const bindings = clause.namedBindings;
        if (bindings?.kind === SyntaxKind.NamespaceImport) {
            modules.set(bindings.name.text, from);
        } else if (bindings?.kind === SyntaxKind.NamedImports) {
            for (const element of bindings.elements) {
                if (element.isTypeOnly) {
                    continue;
                }
                const imported = (element.propertyName ?? element.name).text;
                if (from === 'effect' && (imported === 'Effect' || imported === 'ManagedRuntime')) {
                    modules.set(element.name.text, imported);
                } else if (from !== 'effect' && usesOf[from].includes(imported)) {
                    functions.set(element.name.text, `${from}.${imported}`);
                }
            }
        }
    }
    if (!modules.size && !functions.size) {
        return found;
    }
    const scopes = new Map();
    /** Whether an identifier names the file's import: no scope between it and the file declares its name. */
    const isImportBinding = (identifier) => {
        for (let scope = identifier.parent; scope; scope = scope.parent) {
            const key = `${scope.kind}:${scope.pos}:${scope.end}`;
            const names = scopes.get(key) ?? scopes.set(key, scopeNames(scope)).get(key);
            if (names.has(identifier.text)) {
                return false;
            }
        }
        return true;
    };
    /** The module an expression names: a local name above, or `X.Effect` for the effect package's namespace. */
    const moduleOf = (node) => {
        const inner = unwrap(node);
        if (inner?.kind === SyntaxKind.Identifier) {
            return isImportBinding(inner) ? modules.get(inner.text) : undefined;
        }
        const member = memberOf(inner);
        return member &&
            member.object?.kind === SyntaxKind.Identifier &&
            modules.get(member.object.text) === 'effect' &&
            isImportBinding(member.object)
            ? usesOf[member.name] && member.name
            : undefined;
    };
    /** Whether an identifier is a reference, not a name being declared or a property name. */
    const isReference = (node) => {
        const parent = node.parent;
        if (namesAMember(node) || (BINDINGS.has(parent?.kind) && same(parent.name, node))) {
            return false;
        }
        if (parent?.kind === SyntaxKind.BindingElement && same(parent.propertyName, node)) {
            return false;
        }
        // `export { runPromise as run }`: the local name is the reference, the exported name isn't.
        return !(
            parent?.kind === SyntaxKind.ExportSpecifier &&
            parent.propertyName &&
            !same(parent.propertyName, node)
        );
    };
    const visit = (node) => {
        // A type runs nothing: `typeof runPromise` and `typeof Effect.runPromise` name a function's type.
        // A value import can be named in no other type position.
        if (node.kind === SyntaxKind.TypeQuery || node.kind === SyntaxKind.ImportDeclaration) {
            return;
        }
        if (node.kind === SyntaxKind.ExportDeclaration && (node.isTypeOnly || node.moduleSpecifier)) {
            return;
        }
        switch (node.kind) {
            case SyntaxKind.PropertyAccessExpression:
            case SyntaxKind.ElementAccessExpression: {
                const member = memberOf(node);
                const module = member && moduleOf(member.object);
                if (module && usesOf[module]?.includes(member.name)) {
                    found.push({ line: lineOf(node), use: `${module}.${member.name}` });
                }
                break;
            }
            case SyntaxKind.VariableDeclaration: {
                const module = node.initializer && moduleOf(node.initializer);
                if (module && usesOf[module] && node.name.kind === SyntaxKind.ObjectBindingPattern) {
                    for (const element of node.name.elements) {
                        const key = element.propertyName ?? element.name;
                        if (key.kind === SyntaxKind.Identifier && usesOf[module].includes(key.text)) {
                            found.push({ line: lineOf(element), use: `${module}.${key.text}` });
                        }
                    }
                }
                break;
            }
            case SyntaxKind.Identifier:
                if (
                    functions.has(node.text) &&
                    !(node.parent?.kind === SyntaxKind.ExportSpecifier && node.parent.isTypeOnly) &&
                    isReference(node) &&
                    isImportBinding(node)
                ) {
                    found.push({ line: lineOf(node), use: functions.get(node.text) });
                }
                break;
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
    return found.sort((a, b) => a.line - b.line);
}

/**
 * The server's import graph, under `root` (a repository, real or a fixture).
 * `files` and the ends of `edges` are relative to src/server. `packages` holds
 * each file's references that aren't relative (and relative ones that leave
 * src/server, as `../../packages/...`), each as `{ specifier, line, typeOnly }`.
 * Failures, each as `file:line: ...`:
 * `unresolved` the relative ones that name no file; `unsupported` the ones
 * that name a file in src/server that isn't a TypeScript module (JSON,
 * JavaScript, ...); `unclassified` the references the guard can't read,
 * less those `allowed` lists (ALLOWED_UNREAD on the real tree), and each
 * `allowed` entry that matched nothing.
 */
export function serverGraph(root, allowed = ALLOWED_UNREAD) {
    const server = resolve(root, SERVER);
    const shown = (path) => relative(server, path).replaceAll(sep, '/');
    const paths = serverFiles(server).sort();
    const known = new Set(paths);
    const edges = new Map();
    const packages = new Map();
    const unresolved = [];
    const unsupported = [];
    const unclassified = [];
    const runtimeUses = [];
    const used = new Set();
    const api = new API({ cwd: resolve(root) });
    try {
        const resolver = api.createModuleResolver(RESOLUTION);
        for (const path of paths) {
            const from = shown(path);
            const lease = api.createSourceFile(path, readFileSync(path, 'utf8'));
            let references;
            try {
                references = referencesOf(lease.sourceFile, /\.c(?:ts|js)$|\.d\.cts$/.test(path) ? CJS : ESM);
                for (const use of runtimeUsesOf(lease.sourceFile)) {
                    runtimeUses.push({ file: from, ...use });
                }
            } finally {
                lease.dispose();
            }
            for (const { line, why, code } of references.failed) {
                const entry = allowed.find((one) => one.file === from && one.code.replace(/\s+/g, '') === code);
                if (entry) {
                    used.add(entry);
                } else {
                    unclassified.push(`${from}:${line}: ${why}`);
                }
            }
            for (const { specifier, mode, line, path: byPath, spawn, typeOnly } of references.found) {
                const at = `${from}:${line}: ${specifier}`;
                const outside = () =>
                    (packages.get(from) ?? packages.set(from, []).get(from)).push({
                        specifier,
                        line,
                        typeOnly: typeOnly === true,
                    });
                // `new URL(spec, import.meta.url)` follows URL rules, not module rules: a bare
                // 'worker.js' is relative to the file too. Only file: URLs name a file.
                let relativeSpecifier = specifier;
                let named;
                if (spawn) {
                    const url = new URL(specifier, pathToFileURL(path));
                    if (url.protocol !== 'file:') {
                        unclassified.push(`${at}: a ${url.protocol} URL the guard doesn't follow`);
                        continue;
                    }
                    named = fileURLToPath(url);
                    const fromHere = relative(dirname(path), named).replaceAll(sep, '/');
                    relativeSpecifier = fromHere.startsWith('../') ? fromHere : `./${fromHere}`;
                } else {
                    if (/^(?:\/|[a-z][a-z0-9+.-]*:(?!\/\/)?)/i.test(specifier) && !specifier.startsWith('node:')) {
                        unclassified.push(`${at}: an absolute path or URL the guard doesn't follow`);
                        continue;
                    }
                    if (!byPath && !specifier.startsWith('.')) {
                        outside();
                        continue;
                    }
                    named = resolve(dirname(path), specifier);
                }
                if (!`${named}${sep}`.startsWith(`${server}${sep}`)) {
                    // Outside src/server (a package's source, docs, the build): not in the graph.
                    outside();
                    continue;
                }
                const target = byPath
                    ? [named, `${named}.ts`, `${named}.d.ts`].find(isFile)
                    : resolver.resolveModuleName(relativeSpecifier, dirname(path), mode).resolvedModule
                          ?.resolvedFileName;
                if (!target) {
                    unresolved.push(at);
                } else if (known.has(target)) {
                    const key = `${from}>${shown(target)}`;
                    // A file started by URL (a worker, a child process) only: `spawn`, so rule 2 lets it be an entry file.
                    edges.set(key, { from, to: shown(target), spawn: spawn && (edges.get(key)?.spawn ?? true) });
                } else if (!`${target}${sep}`.startsWith(`${server}${sep}`)) {
                    outside();
                } else {
                    // Inside src/server but not a module the graph has (JSON, JavaScript, ...):
                    // dropping it would hide its edges, so the guard fails it.
                    unsupported.push(`${at} -> ${shown(target)}`);
                }
            }
        }
        resolver.dispose();
    } finally {
        api.close();
    }
    for (const entry of allowed.filter((one) => !used.has(one))) {
        unclassified.push(
            `${entry.file}: ${entry.code}: allowed (${entry.why}), but nothing matches it: remove the entry`,
        );
    }
    return {
        files: paths.map(shown),
        edges: [...edges.values()],
        packages,
        unresolved,
        unsupported,
        unclassified,
        runtimeUses,
    };
}

/** Strongly connected components with more than one node, largest first (Tarjan, iterative). */
export function components(nodes, edges) {
    const next = new Map(nodes.map((node) => [node, []]));
    for (const { from, to } of edges) {
        next.get(from)?.push(to);
    }
    const index = new Map();
    const low = new Map();
    const stack = [];
    const onStack = new Set();
    const found = [];
    let counter = 0;
    for (const start of nodes) {
        if (index.has(start)) {
            continue;
        }
        const work = [[start, 0]];
        index.set(start, counter);
        low.set(start, counter++);
        stack.push(start);
        onStack.add(start);
        while (work.length) {
            const frame = work.at(-1);
            const [node, position] = frame;
            const targets = next.get(node) ?? [];
            if (position < targets.length) {
                frame[1] += 1;
                const target = targets[position];
                if (!index.has(target)) {
                    index.set(target, counter);
                    low.set(target, counter++);
                    stack.push(target);
                    onStack.add(target);
                    work.push([target, 0]);
                } else if (onStack.has(target)) {
                    low.set(node, Math.min(low.get(node), index.get(target)));
                }
                continue;
            }
            work.pop();
            if (work.length) {
                const parent = work.at(-1)[0];
                low.set(parent, Math.min(low.get(parent), low.get(node)));
            }
            if (low.get(node) === index.get(node)) {
                const component = [];
                let member;
                do {
                    member = stack.pop();
                    onStack.delete(member);
                    component.push(member);
                } while (member !== node);
                if (component.length > 1) {
                    found.push(component.sort());
                }
            }
        }
    }
    return found.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** The three numbers of rule 5. */
export function sccNumbers(graph) {
    const files = components(graph.files, graph.edges);
    const crossing = files.filter((component) => new Set(component.map(featureOf)).size > 1);
    const featureEdges = new Map();
    for (const { from, to } of graph.edges) {
        if (!isEntry(from) && featureOf(from) !== featureOf(to)) {
            featureEdges.set(`${featureOf(from)}>${featureOf(to)}`, { from: featureOf(from), to: featureOf(to) });
        }
    }
    const features = components([...new Set(graph.files.map(featureOf))].sort(), [...featureEdges.values()]);
    return {
        largestFileScc: files[0]?.length ?? 0,
        largestCrossFeatureScc: crossing[0]?.length ?? 0,
        largestFeatureScc: features[0]?.length ?? 0,
    };
}

/** Each import that breaks rule 1, as `from -> to` (paths relative to src/server), sorted. */
export function contractOnlyImports(graph) {
    return graph.edges
        .filter(
            ({ from, to }) =>
                !isEntry(from) && featureOf(from) !== featureOf(to) && to !== `${featureOf(to)}/contract.ts`,
        )
        .map(({ from, to }) => `${from} -> ${to}`)
        .sort();
}

const ALLOWED_IN_CONTRACT = /^(?:effect(?:\/|$)|@socio\/)/;

/**
 * Modules a contract may name in a type-only reference: their
 * types are part of the vocabulary contracts share (`Hono`, `DatabaseSync`,
 * `ToolDefinition`, `Message`, the MCP SDK's `McpServer`). Each is matched whole; a trailing `*` takes
 * the rest of the specifier, so `hono/jsx` or `@tanstack/ai-react` isn't in.
 * A value import from any of them still fails.
 */
export const CONTRACT_TYPE_IMPORTS = [
    'node:*',
    'hono',
    '@copilotkit/runtime/v2',
    '@ag-ui/*',
    '@tanstack/ai',
    'drizzle-orm',
    '@modelcontextprotocol/sdk/*',
];
const typeImportAllowed = (specifier) =>
    CONTRACT_TYPE_IMPORTS.some((allowed) =>
        allowed.endsWith('*') ? specifier.startsWith(allowed.slice(0, -1)) : specifier === allowed,
    );

/** Problems with rules 2, 3 and 4, and imports that name no file; none of them has a baseline. */
export function ruleProblems(graph) {
    const problems = [
        ...graph.unresolved.map((line) => `${line} (names no file)`),
        ...graph.unsupported.map(
            (line) => `${line} (not a TypeScript module the guard reads: .ts, .tsx, .mts, .cts or a .d.ts)`,
        ),
        ...graph.unclassified.map((line) => `${line} (the guard can't classify it, so it fails)`),
    ];
    for (const { from, to, spawn } of graph.edges) {
        if (!isEntry(from) && isEntry(to) && !spawn) {
            problems.push(`${from} -> ${to} (rule 2: only entry files import an entry file)`);
        }
        if (!isEntry(from) && isLayer(to)) {
            problems.push(`${from} -> ${to} (rule 3: only entry files and tests import a layer.ts)`);
        }
        if (isContract(from) && !isContract(to)) {
            problems.push(`${from} -> ${to} (rule 4: a contract imports only other contracts)`);
        }
    }
    for (const [from, references] of graph.packages) {
        for (const { specifier, line, typeOnly } of isContract(from) ? references : []) {
            if (ALLOWED_IN_CONTRACT.test(specifier)) {
                continue;
            }
            if (!typeImportAllowed(specifier)) {
                problems.push(
                    `${from}:${line}: ${specifier} (rule 4: a contract imports only effect, @socio/* and, with import type, ${CONTRACT_TYPE_IMPORTS.join(', ')})`,
                );
            } else if (!typeOnly) {
                problems.push(
                    `${from}:${line}: ${specifier} (rule 4: a contract imports ${specifier} only with import type)`,
                );
            }
        }
    }
    const contracts = graph.files.filter(isContract);
    const contractEdges = graph.edges.filter(({ from, to }) => isContract(from) && isContract(to));
    for (const cycle of components(contracts, contractEdges)) {
        problems.push(`${cycle.join(', ')} (rule 4: these contracts import each other in a cycle)`);
    }
    return problems;
}

const NUMBERS = ['largestFileScc', 'largestCrossFeatureScc', 'largestFeatureScc'];

/** What the guard measures now: the rule 1 imports and the rule 5 numbers. */
export function measure(graph) {
    return { numbers: sccNumbers(graph), contractOnly: contractOnlyImports(graph) };
}

/** A baseline as a file holds it, read and checked for shape. */
export function parseBaseline(text, where) {
    const baseline = JSON.parse(text);
    const shaped =
        baseline &&
        typeof baseline === 'object' &&
        NUMBERS.every((name) => Number.isInteger(baseline.numbers?.[name])) &&
        Array.isArray(baseline.contractOnly) &&
        baseline.contractOnly.every((entry) => typeof entry === 'string');
    if (!shaped) {
        throw new Error(`${where}: not a feature boundary baseline (numbers.{${NUMBERS.join(',')}}, contractOnly[])`);
    }
    return {
        numbers: Object.fromEntries(NUMBERS.map((name) => [name, baseline.numbers[name]])),
        contractOnly: baseline.contractOnly,
    };
}

/** The baseline file as it is written: sorted, so a diff shows exactly what moved. */
export function formatBaseline({ numbers, contractOnly }) {
    const body = {
        $comment: 'Written by `node scripts/check-feature-boundaries.mjs --write`. Entries only go.',
        numbers: Object.fromEntries(NUMBERS.map((name) => [name, numbers[name]])),
        contractOnly: [...contractOnly].sort(),
    };
    return `${JSON.stringify(body, null, 4)}\n`;
}

/** The current graph against the baseline in the change itself (rules 1 and 5, both ways for rule 1). */
export function baselineProblems(current, baseline) {
    const listed = new Set(baseline.contractOnly);
    const now = new Set(current.contractOnly);
    const problems = [];
    for (const entry of current.contractOnly.filter((line) => !listed.has(line))) {
        problems.push(`${entry} (rule 1: imports another feature's code, not its contract.ts)`);
    }
    for (const entry of baseline.contractOnly.filter((line) => !now.has(line))) {
        problems.push(`${entry} (stale baseline entry: the import is gone, so remove the entry)`);
    }
    const duplicates = baseline.contractOnly.filter((line, at) => baseline.contractOnly.indexOf(line) !== at);
    for (const entry of new Set(duplicates)) {
        problems.push(`${entry} (listed twice in the baseline)`);
    }
    for (const name of NUMBERS) {
        if (current.numbers[name] > baseline.numbers[name]) {
            problems.push(
                `${name} is ${current.numbers[name]}, above the baseline's ${baseline.numbers[name]} (rule 5)`,
            );
        }
    }
    return problems;
}

/**
 * The key the history rule holds a rule 1 entry under: the feature it starts
 * in and the file it imports, `A -> B/file.ts`. Which file of A imports it
 * doesn't count. An entry that isn't a `from -> to` pair is its own key, so it
 * can't hide under another's.
 */
export function historyKey(entry) {
    const pair = /^(\S+) -> (\S+)$/.exec(entry);
    return pair ? `${featureOf(pair[1])} -> ${pair[2]}` : entry;
}

/**
 * The change's baseline against the reference one (main's): nothing new,
 * nothing higher. Rule 1 entries are held by historyKey: for each pair of
 * features A -> B, the B files the change's baseline has A importing must all
 * be ones main's has A importing. So a refactor may split or move code between
 * files inside A, and two of them may import the same file of B, but A can't
 * start importing a file of B (or a feature) it didn't before. The rule 1
 * total may not rise either. The baseline file itself keeps the exact file
 * pairs, for review.
 */
export function historyProblems(baseline, reference) {
    const before = new Set(reference.contractOnly.map(historyKey));
    const added = new Map();
    for (const entry of baseline.contractOnly) {
        const key = historyKey(entry);
        if (!before.has(key)) {
            added.set(key, [...(added.get(key) ?? []), entry]);
        }
    }
    const problems = [...added]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(
            ([key, entries]) =>
                `${key} (rule 1: main's baseline has no file of ${key.split(' -> ')[0]} importing it; added: ${entries.join(', ')})`,
        );
    if (baseline.contractOnly.length > reference.contractOnly.length) {
        problems.push(
            `rule 1 has ${baseline.contractOnly.length} entries in the baseline, above main's ${reference.contractOnly.length}`,
        );
    }
    for (const name of NUMBERS) {
        if (baseline.numbers[name] > reference.numbers[name]) {
            problems.push(
                `${name} is ${baseline.numbers[name]} in the baseline, above main's ${reference.numbers[name]} (rule 5)`,
            );
        }
    }
    return problems;
}

const git = (root, args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * main's baseline, which the change's may only shrink from:
 *
 * - In CI the copy under test has no .git. A trusted step on the runner
 *   (.github/ci/reference-baseline.sh) reads the baseline at the checked-out
 *   commit's first parent and puts it in .ci-reference/: on a pull request that
 *   commit is GitHub's merge of the branch into main, so its first parent is
 *   main; on a push to main it is the previous main. If that commit has no
 *   baseline, the step writes `feature-boundary-baseline.absent` instead.
 * - Locally (.git present), the baseline at `git merge-base HEAD origin/main`.
 *
 * Returns `{ baseline, from }`, or `{ skip }` with the reason when main has no
 * baseline yet (or, locally only, there is no origin/main to read). Throws when
 * neither source is there, so CI can't pass for want of a reference.
 */
export function referenceBaseline(root) {
    const placed = join(root, REFERENCE_DIR, 'feature-boundary-baseline.json');
    const absent = join(root, REFERENCE_DIR, 'feature-boundary-baseline.absent');
    if (!existsSync(join(root, '.git'))) {
        if (isFile(placed)) {
            return { baseline: parseBaseline(readFileSync(placed, 'utf8'), placed), from: `${REFERENCE_DIR}/` };
        }
        if (isFile(absent)) {
            return { skip: `the reference commit ${readFileSync(absent, 'utf8').trim()} has no ${BASELINE}` };
        }
        throw new Error(
            `No .git and no ${REFERENCE_DIR}/feature-boundary-baseline.json: CI's reference step didn't run, so there is nothing to hold the baseline against`,
        );
    }
    let base;
    try {
        base = git(root, ['merge-base', 'HEAD', 'origin/main']).trim();
    } catch {
        return { skip: 'no origin/main here to find the merge base with (git fetch origin main)' };
    }
    try {
        git(root, ['cat-file', '-e', `${base}:${BASELINE}`]);
    } catch {
        return { skip: `the merge base ${base.slice(0, 12)} has no ${BASELINE}` };
    }
    const text = git(root, ['cat-file', 'blob', `${base}:${BASELINE}`]);
    return { baseline: parseBaseline(text, `${base}:${BASELINE}`), from: `merge base ${base.slice(0, 12)}` };
}

/** The baseline file in a checkout. */
export const readBaseline = (root) => parseBaseline(readFileSync(join(root, BASELINE), 'utf8'), BASELINE);

/**
 * The folder order as a file holds it, read and checked for shape: `order`,
 * top first, each a feature's name (a top-level folder, or a root-level file
 * that is a feature) once. A file that isn't one fails the guard: what it
 * can't read, it doesn't report on.
 */
export function parseRanks(text, where) {
    const ranks = JSON.parse(text);
    const order = ranks?.order;
    const shaped =
        ranks &&
        typeof ranks === 'object' &&
        Array.isArray(order) &&
        order.every((name) => typeof name === 'string' && /^[^/\\]+$/.test(name) && name !== '.' && name !== '..') &&
        new Set(order).size === order.length;
    if (!shaped) {
        throw new Error(`${where}: not a feature rank file (order[]: feature names, top first, each once)`);
    }
    return { order: [...order] };
}

/** The rank file in a checkout. */
export const readRanks = (root) => parseRanks(readFileSync(join(root, RANKS), 'utf8'), RANKS);

/**
 * Imports against the folder order (`order`, top first): a feature may import
 * only features below it. Counted over the edges rule 5's feature SCC counts
 * (between features, from a non-entry file), so with every feature ranked,
 * cutting every `up` import leaves the feature graph acyclic. Reported, not
 * enforced: nothing here fails the guard.
 *
 * Returns `up` (each `from -> to`, sorted), `upFeatures` (the distinct
 * `A -> B` feature edges among them), `down` (how many point down), and,
 * so no import drops out unseen, `unrankedImports` (how many have an end in
 * a feature the order doesn't name), `unranked` (those features: each with a
 * non-entry file and no rank) and `stale` (names in the order that aren't a
 * feature of the tree).
 */
export function rankReport(graph, order) {
    const rank = new Map(order.map((name, at) => [name, at]));
    const up = [];
    let down = 0;
    let unrankedImports = 0;
    for (const { from, to } of graph.edges) {
        if (isEntry(from) || featureOf(from) === featureOf(to)) {
            continue;
        }
        const above = rank.get(featureOf(from));
        const below = rank.get(featureOf(to));
        if (above === undefined || below === undefined) {
            unrankedImports += 1;
        } else if (below < above) {
            up.push(`${from} -> ${to}`);
        } else {
            down += 1;
        }
    }
    const features = new Set(graph.files.map(featureOf));
    const ranked = new Set(graph.files.filter((file) => !isEntry(file)).map(featureOf));
    return {
        up: up.sort(),
        upFeatures: [
            ...new Set(
                up.map((line) => {
                    const [from, to] = line.split(' -> ');
                    return `${featureOf(from)} -> ${featureOf(to)}`;
                }),
            ),
        ].sort(),
        down,
        unrankedImports,
        unranked: [...ranked].filter((name) => !rank.has(name)).sort(),
        stale: order.filter((name) => !features.has(name)),
    };
}

/**
 * The other process entries, relative to src/server, which build and run their
 * own Effect runtime: coding/host/session-host.ts (the coding container starts
 * it as `node session-host.js`) and the ENTRY_FILES that start a
 * process. A list of its own, so a file here doesn't become boundary-exempt.
 */
export const RUN_ENTRY_FILES = new Set([
    'coding/host/session-host.ts',
    'classify/eval-main.ts',
    'operations/analytics/analytics-main.ts',
    'plugins/planner/main.ts',
    'modules/migrate-cli.ts',
    'auth/auth-cli.ts',
    'backup/backup-cli.ts',
    'bundle/bundle-cli.ts',
    'classify/eval-cli.ts',
    'keys/key-id-cli.ts',
]);

/** A platform-needs.ts, under any TypeScript extension: Platform's needs moved into tags, so none comes back. */
export const isPlatformNeeds = (file) => /^platform-needs\.(?:[cm]?ts|tsx|d\.[cm]?ts)$/.test(basename(file));

/** Where `Effect.run*` may be called: the composition root (composition/, main.ts, index.ts) and the process entries. */
export const mayRunEffects = (file) =>
    file === 'main.ts' || file === 'index.ts' || file.startsWith('composition/') || RUN_ENTRY_FILES.has(file);

/** Where `ManagedRuntime.make` may be called: main.ts (one runtime per process) and the process entries. */
export const mayMakeRuntimes = (file) => file === 'main.ts' || RUN_ENTRY_FILES.has(file);

/**
 * The runtime checks: `platformNeeds`, each platform-needs.ts; `effectRuns`,
 * each `Effect.run*` outside mayRunEffects; `managedRuntimes`, each
 * `ManagedRuntime.make` outside mayMakeRuntimes. Each hit as
 * `file:line: use`, sorted. runtimeProblems turns each into a failure.
 */
export function runtimeReport(graph) {
    const shown = ({ file, line, use }) => `${file}:${line}: ${use}`;
    const sorted = (uses) =>
        uses
            .toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.use.localeCompare(b.use))
            .map(shown);
    return {
        platformNeeds: graph.files.filter(isPlatformNeeds).sort(),
        effectRuns: sorted(
            graph.runtimeUses.filter(({ file, use }) => use.startsWith('Effect.') && !mayRunEffects(file)),
        ),
        managedRuntimes: sorted(
            graph.runtimeUses.filter(({ file, use }) => use === 'ManagedRuntime.make' && !mayMakeRuntimes(file)),
        ),
    };
}

/** Each runtime hit as a failure: its file, line and what to do instead. */
export function runtimeProblems(graph) {
    const report = runtimeReport(graph);
    return [
        ...report.platformNeeds.map(
            (file) => `${file}: a platform-needs.ts (Platform is gone: read the app's services from their tags)`,
        ),
        ...report.effectRuns.map(
            (hit) =>
                `${hit} outside composition/, main.ts, index.ts and the process entries (yield it, or run it through the app's runtime)`,
        ),
        ...report.managedRuntimes.map(
            (hit) => `${hit} outside main.ts and the process entries (each process has one runtime)`,
        ),
    ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const root = resolve(import.meta.dirname, '..');
    const graph = serverGraph(root);
    const current = measure(graph);
    if (process.argv.includes('--write')) {
        writeFileSync(join(root, BASELINE), formatBaseline(current));
    }
    console.log(
        `${graph.files.length} files, ${graph.edges.length} imports between them; rule 1: ${current.contractOnly.length}; ${NUMBERS.map((name) => `${name} ${current.numbers[name]}`).join(', ')}`,
    );
    const ranks = rankReport(graph, readRanks(root).order);
    console.log(
        `folder order (${RANKS}, reported, not enforced): ${ranks.up.length} imports point up it (${ranks.upFeatures.length} feature edges), ${ranks.down} down, ${ranks.unrankedImports} with an unranked end${ranks.unranked.length ? ` (unranked: ${ranks.unranked.join(', ')})` : ''}${ranks.stale.length ? `; not a feature: ${ranks.stale.join(', ')}` : ''}${process.argv.includes('--ranks') ? '' : '; --ranks lists them'}`,
    );
    if (process.argv.includes('--ranks')) {
        console.log(ranks.up.map((line) => `  up: ${line}`).join('\n'));
    }
    const runtime = runtimeReport(graph);
    console.log(
        `runtime: platform-needs.ts ${runtime.platformNeeds.length}; Effect.run* outside composition/, main.ts, index.ts and the process entries ${runtime.effectRuns.length}; ManagedRuntime.make outside main.ts and the process entries ${runtime.managedRuntimes.length}`,
    );
    const problems = [
        ...ruleProblems(graph),
        ...runtimeProblems(graph),
        ...baselineProblems(current, readBaseline(root)),
    ];
    const reference = referenceBaseline(root);
    if (reference.baseline) {
        problems.push(...historyProblems(readBaseline(root), reference.baseline));
    } else {
        console.log(`not held against main: ${reference.skip}`);
    }
    if (problems.length) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
    console.log('feature boundaries passed');
}
