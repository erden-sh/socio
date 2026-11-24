import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, it } from 'vitest';

import { dynamicImportsOf, withoutComments } from '../scripts/check-package-boundary.mjs';

import { PACKAGE_SOURCES } from './support/package-sources.js';

/*
 * One boot step migrates the app's database (`modules/boot.ts`), so a
 * constructor takes a database that is already migrated. A new `migrate(`
 * in a store would work in every test and hide that a process skipped boot:
 * only the code listed here may run migrations, and only the way it says.
 * Tests and test helpers aren't scanned; they run real migrations on purpose.
 */

const root = join(import.meta.dirname, '..');
const SCANNED = ['src', 'scripts', ...PACKAGE_SOURCES];
/** The ways to run migrations. */
const RUNNERS = ['migrate', 'migrateDatabase', 'migrateBundledPlugin'];
/** Who may use which of them. */
const ALLOWED = new Map([
    ['packages/data/src/migrate.ts', { runs: ['migrate'], why: 'the runner itself, and `migrateDatabase` calls it' }],
    ['src/server/modules/boot.ts', { runs: ['migrateDatabase'], why: 'the boot step' }],
    [
        'src/server/plugins/plugin-schemas.ts',
        { runs: ['migrate'], why: 'an install at runtime makes that plugin’s tables; boot runs the rest' },
    ],
    ['src/server/plugins/service.ts', { runs: ['migrateBundledPlugin'], why: 'that install, in `install()`' }],
    [
        'scripts/experiments/cb137-summariser.mjs',
        { runs: ['migrate'], why: 'an experiment that makes its own scratch notes database' },
    ],
]);

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : sources(path);
        }
        return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) ? [path] : [];
    });
}

/**
 * Code as it runs: no comments, and the text of every string blanked, each thing
 * where it was. Template literals too, keeping the code in their `${...}`
 * (which may hold strings and templates of its own), so prose like
 * `run bootDatabase(path) first` in a template is no boot.
 */
function codeOf(source: string): string {
    const code = withoutComments(source);
    let out = '';
    // What encloses the current point: a template's text, or a `${` holding code (with its brace depth).
    const stack: ({ kind: 'template' } | { kind: 'code'; depth: number })[] = [];
    let i = 0;
    const blank = (text: string) => text.replace(/[^\n]/g, ' ');
    while (i < code.length) {
        const top = stack.at(-1);
        const ch = code[i];
        if (top?.kind === 'template') {
            if (ch === '\\') {
                out += blank(code.slice(i, i + 2));
                i += 2;
            } else if (ch === '`') {
                stack.pop();
                out += ' ';
                i += 1;
            } else if (ch === '$' && code[i + 1] === '{') {
                stack.push({ kind: 'code', depth: 0 });
                out += '${';
                i += 2;
            } else {
                out += blank(ch);
                i += 1;
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            const end = ch === "'" ? /'(?:[^'\\\n]|\\.)*'/y : /"(?:[^"\\\n]|\\.)*"/y;
            end.lastIndex = i;
            const quoted = end.exec(code);
            const length = quoted ? quoted[0].length : 1;
            out += ' '.repeat(length);
            i += length;
        } else if (ch === '`') {
            stack.push({ kind: 'template' });
            out += ' ';
            i += 1;
        } else {
            if (top?.kind === 'code') {
                if (ch === '{') {
                    top.depth += 1;
                } else if (ch === '}') {
                    if (top.depth === 0) {
                        stack.pop();
                        out += '}';
                        i += 1;
                        continue;
                    }
                    top.depth -= 1;
                }
            }
            out += ch;
            i += 1;
        }
    }
    return out;
}

/** The module of the runner, or of the plugin pass, wherever a path puts it. */
const RUNNER_MODULE = /(?:^|\/)(?:migrate|plugin-schemas)(?:\.[cm]?[jt]s)?$/;
/** A call of a runner: not `foo.migrate(`, `migrateThings(` or a definition. */
const CALL = /(?<![\w.$])(?<!\bfunction\s+)(migrate|migrateDatabase|migrateBundledPlugin)\s*(?:<[^>]*>)?\(/g;
const STATEMENT = /(?:^|;)\s*(?:import|export)\s+(?!type\b)([^'"`;]*?)\s*\bfrom\s*['"]([^'"\n]+)['"]/gm;

/** Each runner name this source reaches, with where. `any` is a whole-module reach, which names can't narrow. */
function runs(source: string): { runner: string; where: string }[] {
    const comments = withoutComments(source);
    const lines = source.split('\n');
    const lineAt = (index: number) => comments.slice(0, index).split('\n').length;
    const found = [...codeOf(source).matchAll(CALL)].map((match) => {
        const line = lineAt(match.index);
        return { runner: match[1], where: `line ${line}: ${lines[line - 1].trim()}` };
    });
    for (const [statement, clause, module] of comments.matchAll(STATEMENT)) {
        if (!RUNNER_MODULE.test(module)) {
            continue;
        }
        if (clause.includes('*')) {
            found.push({ runner: 'any', where: `reaches every runner: ${statement.trim()}` });
        }
        const named = /\{([^}]*)\}/.exec(clause)?.[1].split(',') ?? [];
        for (const runner of RUNNERS) {
            if (named.some((name) => name.trim().split(/\s+/)[0] === runner)) {
                found.push({ runner, where: `imports it: ${statement.trim()}` });
            }
        }
    }
    const loaded = [...dynamicImportsOf(comments), ...[...comments.matchAll(REQUIRE)].map((match) => match[1])];
    for (const module of loaded.filter((specifier) => RUNNER_MODULE.test(specifier))) {
        found.push({ runner: 'any', where: `loads it at run time: ${module}` });
    }
    return found;
}
const REQUIRE = /(?<![\w.$])require\s*\(\s*['"`]([^'"`\n]+)['"`]/g;

/** Where this source runs migrations beyond what it may; empty when it doesn't. */
const violations = (source: string, may: readonly string[] = []) =>
    runs(source)
        .filter(({ runner }) => !may.includes(runner))
        .map(({ runner, where }) => `${runner}: ${where}`);

it('spots a migration run in a store, and leaves look-alikes alone', () => {
    for (const planted of [
        'constructor(db) {\n    migrate(db, [schema]);\n}',
        'export const repo = (db) => migrate(db, sets);',
        'const steps = await migrate (db, sets);',
        "import { migrate } from '@socio/data/migrate';",
        "import { migrate } from './migrate.js';",
        "import {\n    planMigrations,\n    migrate,\n} from '@socio/data/migrate';",
        // A comment or a URL earlier in the line doesn't hide it.
        "const url = 'https://x.test'; migrate(db, sets);",
        '/* first */ migrate(db, sets);',
    ]) {
        expect(violations(planted), planted).not.toEqual([]);
    }
    for (const fine of [
        '// Boot calls migrate(db, sets) first.',
        '/**\n * migrate(db, sets) is what boot runs\n */',
        '/* migrateDatabase(path, sets) runs in boot */',
        "log('call migrate(db, sets) from boot');",
        'export function migrate(db, sets) {',
        'export function migrateBundledPlugin(db, id) {',
        'export function migrateDatabase(path, sets, options) {',
        'platform.plugins.migrateIdentities();',
        'await this.migrate(job);',
        'const migrated = migrateLocalFiles(store);',
        "import type { SchemaSet } from '@socio/data/migrate';",
        "import type * as runner from '@socio/data/migrate';",
        "import { planMigrations, type SchemaSet } from '@socio/data/migrate';",
        "import { installedPluginSchemas } from './plugin-schemas.js';",
        "import { migrate } from './migrate-things.js';",
        "export type Runner = typeof import('@socio/data/migrate');",
        "let step: import('@socio/data/migrate').MigrationStep;",
    ]) {
        expect(violations(fine), fine).toEqual([]);
    }
});

it.each([
    // Through a whole module, wherever its path puts it.
    ['a namespace', "import * as runner from '@socio/data/migrate';\nrunner.migrate(db, [schema]);"],
    ['a namespace by path', "import * as runner from '../modules/migrate.js';\nrunner.migrate(db, [schema]);"],
    ['a namespace of the plugin pass', "import * as s from './plugin-schemas.js';\ns.migrateBundledPlugin(db, 'x');"],
    ['a re-export', "export * from '@socio/data/migrate';"],
    ['a dynamic import', "const { migrate: go } = await import('@socio/data/migrate');\ngo(db, []);"],
    ['a lazy import', "const load = () => import('../modules/migrate.js');"],
    ['a computed then', "import('@socio/data/migrate')['then'](({ migrate: go }) => go(db, []));"],
    ['a value typeof', "const kind = typeof import('@socio/data/migrate');"],
    ['a require', "const runner = require('@socio/data/migrate');"],
    // Under another name.
    ['an alias', "import { migrate as go } from '@socio/data/migrate';\ngo(db, []);"],
    ['an alias by path', "import { migrate as go } from '../modules/migrate.js';\ngo(db, []);"],
    ['a named re-export', "export { migrate } from '@socio/data/migrate';"],
    // The boot step's own call, outside it.
    ['migrateDatabase', "migrateDatabase(path, schemas, { backupDirectory: 'b' });"],
    ['its import', "import { migrateDatabase } from '@socio/data/migrate';"],
    ['its import by path', "import { migrateDatabase } from './migrate.js';"],
    // The plugin pass, outside the install.
    [
        'migrateBundledPlugin',
        'class S {\n    constructor(db) {\n        migrateBundledPlugin(db, "calendar");\n    }\n}',
    ],
    ['its import', "import { migrateBundledPlugin } from './plugin-schemas.js';"],
])('fails on %s', (_name, planted) => {
    expect(violations(planted)).not.toEqual([]);
});

it('allows each listed file only what it lists', () => {
    const boot = "import { migrateDatabase } from '@socio/data/migrate';\nmigrateDatabase(path, schemas, options);";
    expect(violations(boot, ['migrateDatabase'])).toEqual([]);
    expect(violations(`${boot}\nmigrate(db, []);`, ['migrateDatabase'])).toEqual(['migrate: line 3: migrate(db, []);']);
    expect(violations("import * as runner from '@socio/data/migrate';", ['migrateDatabase'])).not.toEqual([]);
});

it('runs migrations nowhere but the boot step and what it lists', () => {
    const offenders = SCANNED.flatMap((dir) => sources(join(root, dir)))
        .map((path) => [relative(root, path).replaceAll('\\', '/'), path] as const)
        .flatMap(([name, path]) =>
            violations(readFileSync(path, 'utf8'), ALLOWED.get(name)?.runs).map((line) => `${name}: ${line}`),
        );
    expect(offenders).toEqual([]);
});

/*
 * The stores assume boot ran, so whatever makes one in a process must run it.
 * Tests have the template instead. A connection that can write counts whatever
 * it's handed to, so a store nobody lists here still can't get one unbooted.
 */
const STORE = /new (?:Store|WorkspaceStore|LocalAgentRunner|SqliteStateStore)\(|\bopenDatabase\(/;
const CONNECTION = /\bnew DatabaseSync\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g;
const BOOTS = /(?<![\w.$])(?<!\bfunction\s+)bootDatabase\s*\(/;
/** A read-only connection can't write, and `:memory:` starts empty on purpose. */
const opensForWriting = (source: string) =>
    STORE.test(codeOf(source)) ||
    [...withoutComments(source).matchAll(CONNECTION)].some(
        ([, args]) => !/\breadOnly\s*:\s*true\b/.test(args) && !/^\s*['"]:memory:['"]\s*$/.test(args),
    );
const opensUnbooted = (source: string) => opensForWriting(source) && !BOOTS.test(codeOf(source));

/** Who opens a database without the boot step, and why that isn't this mistake. */
const OPENS_WITHOUT_BOOT = new Map([
    ['packages/data/src/open.ts', 'the opener itself'],
    ['packages/data/src/migrate.ts', 'the connection the boot step migrates with'],
    ['packages/data/src/backup.ts', 'its own connections to the backup copies it makes and checks'],
    ['src/server/workspace/workspace.ts', 'a store’s own path form: its callers are held to this'],
    ['src/server/telegram/channel-state.ts', 'a store’s own path form: its callers are held to this'],
    ['src/server/turns/local-runner.ts', 'a store’s own path form: its callers are held to this'],
    ['src/server/auth/better-auth.ts', 'Better Auth’s own connection, opened on first use after the process booted'],
    ['src/server/dataspace/engine.ts', 'a dataset is a database of its own, which the app’s migrations don’t touch'],
    [
        'src/server/backup/rename-user.ts',
        'never migrates: offline, it refuses a database that `planMigrations` finds behind (backup-cli.ts checks)',
    ],
    [
        'src/server/purge/purge-cli.ts',
        'never migrates: it runs beside the server that did, and plans only with the columns that exist; also its own backup copy',
    ],
    ['src/server/purge/run.ts', 'never migrates: the purge’s own backup copy, which it plans on to check it'],
    [
        'src/server/bundle/bundle-cli.ts',
        'never migrates: an export reads a snapshot read-only; an import refuses a database without the bundle tables, and one a server holds',
    ],
    [
        'src/server/purge/person.ts',
        'never migrates: an operator’s removal (CB-360) beside the server that did, as the purge CLI does',
    ],
    ['src/server/dataspace/transfer.ts', 'a dataset is a database of its own, which the app’s migrations don’t touch'],
    [
        'src/server/dataspace/query-runner.ts',
        'a batch’s own process writes a dataset, a database of its own, which the app’s migrations don’t touch',
    ],
    ['src/server/classify/eval-cli.ts', 'never migrates: it refuses a database that `planMigrations` finds behind'],
    [
        'src/server/backup/copy-alerts.ts',
        'never migrates: the safety valve’s PASSIVE checkpoint (CB-315), on the leader after the server booted',
    ],
]);

it('tells a boot from a mention of one', () => {
    for (const unbooted of [
        'const store = new Store(connection);',
        // Mentions.
        '// bootDatabase(path) ran already.\nconst store = new Store(connection);',
        '/* bootDatabase(path) */ const store = new Store(connection);',
        "const store = new Store(connection);\nlog('run bootDatabase(path) first');",
        'const db = new Store(connection);\nlog(`run bootDatabase(path) first`);',
        'const db = new Store(connection);\nlog(`${name}: bootDatabase(path) is missing`);',
        'export function bootDatabase(path) {}\nconst store = new Store(connection);',
        'const store = new Store(connection);\nthis.bootDatabase(path);',
    ]) {
        expect(opensUnbooted(unbooted), unbooted).toBe(true);
    }
    expect(opensUnbooted('bootDatabase(database, { backupDirectory });\nconst store = new Store(c);')).toBe(false);
    // A boot inside a template's code is still a boot.
    expect(opensUnbooted('log(`${bootDatabase(database, {})}`);\nconst store = new Store(c);')).toBe(false);
    // Nor does a mention of a store open one.
    expect(opensUnbooted('// new Store(connection) opens it')).toBe(false);
    expect(opensUnbooted("log('openDatabase(path) failed');")).toBe(false);
});

it('finds any writable connection, whichever store it goes to', () => {
    for (const opened of [
        'new FlagService(new DatabaseSync(path), clock);',
        'const db = new DatabaseSync(path);',
        'const db = new DatabaseSync(join(dir, name(id)), { allowExtension: false });',
        'const db = new DatabaseSync(path, { readOnly: false });',
        'const flags = new FlagService(openDatabase(path));',
    ]) {
        expect(opensUnbooted(opened), opened).toBe(true);
    }
    for (const fine of [
        "new DatabaseSync(path, { readOnly: true }).prepare('SELECT 1');",
        'new DatabaseSync(path, {\n    readOnly: true,\n    allowExtension: false,\n});',
        "new DatabaseSync(':memory:');",
        '// new FlagService(new DatabaseSync(path), clock)',
        'bootDatabase(path, options);\nnew FlagService(new DatabaseSync(path), clock);',
    ]) {
        expect(opensUnbooted(fine), fine).toBe(false);
    }
});

it('opens the app’s stores only in a file that runs the boot step', () => {
    const unbooted = ['src', ...PACKAGE_SOURCES]
        .flatMap((dir) => sources(join(root, dir)))
        .map((path) => [relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')] as const)
        .filter(([name, source]) => !OPENS_WITHOUT_BOOT.has(name) && opensUnbooted(source))
        .map(([name]) => name);
    expect(unbooted).toEqual([]);
});

it('lists only files that still run migrations, each for a reason', () => {
    for (const [name, { runs: allowed, why }] of ALLOWED) {
        expect(why).not.toBe('');
        const used = runs(readFileSync(join(root, name), 'utf8')).map(({ runner }) => runner);
        for (const runner of allowed) {
            expect(used, `${name}: ${runner}`).toContain(runner);
        }
    }
});

it('lists only files that still open a database without booting, each for a reason', () => {
    for (const [name, why] of OPENS_WITHOUT_BOOT) {
        expect(why).not.toBe('');
        expect(opensUnbooted(readFileSync(join(root, name), 'utf8')), name).toBe(true);
    }
});
