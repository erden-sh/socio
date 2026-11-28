#!/usr/bin/env node
// Builds the dictionaries (packages/i18n/locales/<locale>/<ns>.json) for the
// server to serve, after checking them (docs/I18N.md):
//
//   - every file is valid JSON, an object of strings;
//   - every key exists in en-US, with the same interpolation variables;
//   - every plural has the forms its locale's CLDR rules use;
//   - coverage is counted through each locale's fallback chain, so a sparse
//     locale (es-US over es-419) only holds what differs;
//   - every context note (packages/i18n/notes/<ns>.json, beside locales/)
//     names a namespace and a key en-US has, and every en-US key has a note,
//     its own or its plural's or context's base's. Notes are for translators
//     and drafting; they are never built or served;
//   - packages/i18n/namespaces.json, beside locales/, gives every en-US
//     namespace a label ("Chat · Message box") and where it appears in the
//     app, for translators: one entry per namespace and no other, each plain
//     text on one line within the limits, as the translation app's import
//     accepts them (scripts/lib/i18n-namespaces.mjs).
//
// It writes dist/i18n/<locale>/<ns>.<sha256-12>.json, each with a gzip and a
// Brotli copy when that pays (as scripts/precompress.mjs), en-XA generated
// from en-US, and dist/i18n/manifest.json:
// { release, locales: { <locale>: { coverage, ns: { <ns>: { hash, sourceHash } } } } }.
// It prints each namespace's size, and warns when a route's inlined
// dictionaries (packages/i18n/src/route-namespaces.json) are over the
// budget in en-US. Run with tsx, which reads the package's TypeScript:
//
//   node --import tsx scripts/i18n-build.mjs            # check and write
//   node --import tsx scripts/i18n-build.mjs --check    # check only (pnpm check)
//   node --import tsx scripts/i18n-build.mjs --out <dir> --locales <dir>
//   node --import tsx scripts/i18n-build.mjs --write-types   # pnpm run i18n:types
//
// The typed keys (packages/i18n/src/resources.gen.ts) are en-US's strings as
// literal types, so tsc checks each t() call's key and variables. Every run
// checks that file is current; --write-types rewrites it.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

import { buildCatalog, CatalogError } from '../packages/i18n/src/catalog.ts';

import { namespaceEntryProblems } from './lib/i18n-namespaces.mjs';

/** The most a route's inlined en-US dictionaries may weigh, gzipped, before the build warns. */
export const ROUTE_BUDGET_BYTES = 8 * 1024;
const MIN_COMPRESSED = 1024;

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : resolve(args[index + 1]);
};
const check = args.includes('--check');
const localesDir = option('--locales', join(root, 'packages/i18n/locales'));
const outDir = option('--out', join(root, 'dist/i18n'));
const routesFile = option('--routes', join(root, 'packages/i18n/src/route-namespaces.json'));
const typesFile = option('--types', join(root, 'packages/i18n/src/resources.gen.ts'));
const notesDir = option('--notes', join(localesDir, '..', 'notes'));
const namespacesFile = option('--namespaces', join(localesDir, '..', 'namespaces.json'));

/** The files, parsed; a file that isn't JSON is a problem, reported with the rest. */
function readSources(dir) {
    const sources = {};
    const problems = [];
    for (const locale of readdirSync(dir).sort()) {
        const path = join(dir, locale);
        if (!statSync(path).isDirectory()) {
            problems.push(`${locale}: only locale folders belong in ${dir}`);
            continue;
        }
        sources[locale] = {};
        for (const name of readdirSync(path).sort()) {
            if (!name.endsWith('.json')) {
                problems.push(`${locale}/${name}: not a .json file`);
                continue;
            }
            try {
                sources[locale][name.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(path, name), 'utf8'));
            } catch (error) {
                problems.push(`${locale}/${name}: not valid JSON (${error.message})`);
            }
        }
    }
    return { sources, problems };
}

/** A plural form's suffix (`_one`, `_ordinal_few`…), which i18next adds to a base key. */
const PLURAL_SUFFIX = /(?:_ordinal)?_(?:zero|one|two|few|many|other)$/;

/**
 * Whether an en-US key has a context note, as the translation app finds one:
 * its own; or, with a plural suffix stripped, the base's (`files` for
 * `files_one`); or, with one `_<context>` suffix then stripped, that base's
 * (`edited` for `edited_socio` and `edited_socio_one`).
 */
function hasNote(key, notes) {
    const noted = (name) => Object.hasOwn(notes, name);
    if (noted(key)) {
        return true;
    }
    const base = key.replace(PLURAL_SUFFIX, '');
    if (base !== key && noted(base)) {
        return true;
    }
    const cut = base.lastIndexOf('_');
    return cut > 0 && !base.slice(cut).includes('.') && noted(base.slice(0, cut));
}

/**
 * The context notes: `notes/<ns>.json`, an object of en-US key → note. A
 * note may name a plain key, a plural's base (`files` for `files_one`…) or a
 * context's base (`edited` for `edited_socio`), and every en-US key needs one
 * (hasNote): translators see only a key, its English and its note. Problems
 * join the build's.
 */
function checkNotes(dir, english) {
    const problems = [];
    const notesOf = {};
    let names = [];
    try {
        names = readdirSync(dir).sort();
    } catch {}
    for (const name of names) {
        const ns = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null;
        if (!ns || !english?.[ns]) {
            problems.push(`notes/${name}: en-US has no namespace ${ns ?? name}`);
            continue;
        }
        let notes;
        try {
            notes = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        } catch (error) {
            problems.push(`notes/${name}: not valid JSON (${error.message})`);
            notesOf[ns] = null;
            continue;
        }
        if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) {
            problems.push(`notes/${name}: must be an object of en-US key → note`);
            notesOf[ns] = null;
            continue;
        }
        notesOf[ns] = Object.fromEntries(
            Object.entries(notes).filter(([, note]) => typeof note === 'string' && note.trim()),
        );
        const keys = [...flattenKeys(english[ns])];
        for (const [key, note] of Object.entries(notes)) {
            if (typeof note !== 'string' || !note.trim()) {
                problems.push(`notes/${name}: ${key} needs a note (a non-empty string)`);
            } else if (!keys.some((known) => known === key || known.startsWith(`${key}_`))) {
                problems.push(`notes/${name}: ${key} isn't an en-US key of ${ns}`);
            }
        }
    }
    // A file that didn't parse is reported above, not as every key it lacks.
    for (const ns of Object.keys(english ?? {}).sort()) {
        if (notesOf[ns] === null) {
            continue;
        }
        const missing = [...flattenKeys(english[ns])].filter((key) => !hasNote(key, notesOf[ns] ?? {}));
        if (missing.length) {
            problems.push(
                `notes/${ns}.json: ${missing.length} en-US key(s) need a context note for translators, on the key or its plural or context base (docs/I18N.md): ${missing.join(', ')}`,
            );
        }
    }
    return problems;
}

/**
 * namespaces.json: `{ "<ns>": { "label", "where" } }`, one entry for each en-US
 * namespace and none for a namespace en-US doesn't have. Both fields are
 * plain text on one line within their limits (lib/i18n-namespaces.mjs).
 * Problems join the build's.
 */
function checkNamespaces(file, english) {
    const name = 'namespaces.json';
    let entries;
    try {
        entries = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        return [
            error.code === 'ENOENT'
                ? `${name}: missing; it gives each en-US namespace a label and where it appears (docs/I18N.md)`
                : `${name}: not valid JSON (${error.message})`,
        ];
    }
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        return [`${name}: must be an object of namespace → { label, where }`];
    }
    const problems = [];
    const namespaces = Object.keys(english ?? {});
    for (const ns of namespaces) {
        if (!Object.hasOwn(entries, ns)) {
            problems.push(`${name}: en-US namespace ${ns} needs an entry with a label and where it appears`);
        }
    }
    const known = Object.fromEntries(Object.entries(entries).filter(([ns]) => namespaces.includes(ns)));
    for (const ns of Object.keys(entries)) {
        if (!Object.hasOwn(known, ns)) {
            problems.push(`${name}: en-US has no namespace ${ns}`);
        }
    }
    problems.push(...namespaceEntryProblems(known).map((problem) => `${name}: ${problem}`));
    return problems;
}

/** A dictionary's dotted keys. */
function* flattenKeys(dictionary, prefix = '') {
    for (const [key, value] of Object.entries(dictionary ?? {})) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'object' && value !== null) {
            yield* flattenKeys(value, path);
        } else {
            yield path;
        }
    }
}

const gzip = (body) => gzipSync(body, { level: constants.Z_BEST_COMPRESSION });
const brotli = (body) => brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

const release = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const { sources, problems } = readSources(localesDir);
problems.push(...checkNotes(notesDir, sources['en-US']));
problems.push(...checkNamespaces(namespacesFile, sources['en-US']));
let catalog;
try {
    catalog = buildCatalog(sources, release);
} catch (error) {
    if (!(error instanceof CatalogError)) {
        throw error;
    }
    problems.push(...error.problems);
}
if (problems.length) {
    console.error(new CatalogError(problems).message);
    process.exit(1);
}

// Sizes: each en-US namespace, then each route's inlined set against the budget.
const sizes = new Map();
for (const file of catalog.files) {
    sizes.set(`${file.locale}/${file.ns}`, { raw: Buffer.byteLength(file.text), gzip: gzip(file.text).byteLength });
}
const routes = Object.entries(JSON.parse(readFileSync(routesFile, 'utf8'))).filter(([id]) => !id.startsWith('$'));
const rootNamespaces = routes.find(([id]) => id === 'root')?.[1] ?? [];
const warnings = [];
for (const [id, namespaces] of routes) {
    for (const ns of namespaces) {
        if (!sizes.has(`en-US/${ns}`)) {
            console.error(`${routesFile}: route ${id} inlines ${ns}, which en-US doesn't have`);
            process.exit(1);
        }
    }
    const inlined = new Set(id === 'root' ? namespaces : [...rootNamespaces, ...namespaces]);
    const total = [...inlined].reduce((sum, ns) => sum + sizes.get(`en-US/${ns}`).gzip, 0);
    if (total > ROUTE_BUDGET_BYTES) {
        warnings.push(
            `Route ${id} inlines ${kb(total)} of en-US dictionaries gzipped, over the ${kb(ROUTE_BUDGET_BYTES)} budget: split a namespace (docs/I18N.md).`,
        );
    }
}
for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
}

/** A string as oxfmt writes it: single quotes, unless the text holds more of them than double quotes. */
const quoted = (text) => {
    const json = JSON.stringify(text);
    const singles = (text.match(/'/g) ?? []).length;
    const doubles = (text.match(/"/g) ?? []).length;
    return singles > doubles ? json : `'${json.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
};
const keyOf = (key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : quoted(key));

/** en-US's dictionaries as one interface of literal types, formatted as oxfmt would. */
function typesOf(english) {
    const indent = (depth) => '    '.repeat(depth);
    const body = (value, depth) =>
        `{\n${Object.entries(value)
            .map(
                ([key, inner]) =>
                    `${indent(depth)}${keyOf(key)}: ${typeof inner === 'string' ? quoted(inner) : body(inner, depth + 1)};`,
            )
            .join('\n')}\n${indent(depth - 1)}}`;
    return [
        '// Generated by scripts/i18n-build.mjs from packages/i18n/locales/en-US: run',
        '// `pnpm run i18n:types` after changing those files. The typed keys',
        '// (docs/I18N.md) read it.',
        '',
        `export interface EnglishResources ${body(english, 1)}`,
        '',
    ].join('\n');
}
const types = typesOf(Object.fromEntries(Object.entries(sources['en-US'] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))));
let current = '';
try {
    current = readFileSync(typesFile, 'utf8');
} catch {}
if (args.includes('--write-types')) {
    writeFileSync(typesFile, types);
    console.log(`i18n: wrote ${typesFile}.`);
} else if (current !== types) {
    console.error(`${typesFile} is out of date with en-US: run pnpm run i18n:types.`);
    process.exit(1);
}

const summary = Object.entries(catalog.manifest.locales)
    .map(([locale, entry]) => `${locale} ${Math.round(entry.coverage * 100)}%`)
    .join(', ');
if (check) {
    console.log(`i18n: ${catalog.files.length} dictionaries check out (${summary}).`);
    process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
for (const file of catalog.files) {
    const dir = join(outDir, file.locale);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${file.ns}.${file.hash}.json`);
    const body = Buffer.from(file.text);
    writeFileSync(path, body);
    if (body.byteLength >= MIN_COMPRESSED) {
        for (const [suffix, compress] of [
            ['.gz', gzip],
            ['.br', brotli],
        ]) {
            const compressed = compress(body);
            if (compressed.byteLength <= body.byteLength * 0.9) {
                writeFileSync(`${path}${suffix}`, compressed);
            }
        }
    }
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(catalog.manifest, null, 2)}\n`);
const english = [...sizes].filter(([key]) => key.startsWith('en-US/'));
console.log(
    `i18n: wrote ${catalog.files.length} dictionaries to ${outDir} (${summary}); en-US by namespace, gzipped: ${english
        .map(([key, size]) => `${key.slice('en-US/'.length)} ${kb(size.gzip)}`)
        .join(', ')}.`,
);
