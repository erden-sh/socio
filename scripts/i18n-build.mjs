#!/usr/bin/env node
// Builds the dictionaries (packages/i18n/locales/<locale>/<ns>.json) for the
// server to serve, after checking them (docs/I18N.md):
//
//   - every file is valid JSON, an object of strings;
//   - every key exists in en-US, with the same interpolation variables;
//   - every plural has the forms its locale's CLDR rules use;
//   - coverage is counted through each locale's fallback chain, so a sparse
//     locale (es-US over es-419) only holds what differs.
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

const gzip = (body) => gzipSync(body, { level: constants.Z_BEST_COMPRESSION });
const brotli = (body) => brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

const release = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const { sources, problems } = readSources(localesDir);
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
