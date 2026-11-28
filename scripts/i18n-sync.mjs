#!/usr/bin/env node
// The repository's side of the translation app's sync (docs/I18N.md, "Translations from
// contributors"), for .github/workflows/i18n-import.yml and i18n-export.yml. It reads and writes
// only files; the workflows make the requests.
//
//   node scripts/i18n-sync.mjs payload --commit <sha> --out <file> [--pull-requests <file>]
//       Writes the import's body (en-US, the translations, the glossary, the context notes, each
//       namespace's label and where it appears, and the state of the i18n/ pull requests) and prints its content hash, which leaves the
//       commit out: an import whose hash is unchanged has nothing new to send.
//   node scripts/i18n-sync.mjs locales --export <file>
//       Prints the locales the export has candidates for, one per line, and how many candidates
//       the app withheld (its `withheld` ids: candidates that failed its own re-validation).
//   node scripts/i18n-sync.mjs apply --export <file> --locale <locale> --body <file> --ids <file>
//       Writes the locale's approved candidates into packages/i18n/locales/<locale>/, the pull
//       request body's section for them (contributors by alias only) and the ids written, for
//       /export/ack. A locale that falls back to another translated one (es-US over es-419)
//       stays sparse: a string equal to that locale's is left out.
//
// --locales <dir> reads and writes another locales folder (tests). It needs nothing installed:
// Node 26 reads packages/i18n/src/registry.ts, which has no imports, by stripping its types.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LOCALES, SOURCE_LOCALE, resolutionChain } from '../packages/i18n/src/registry.ts';

import { namespaceEntryProblems } from './lib/i18n-namespaces.mjs';

const root = resolve(import.meta.dirname, '..');

export const CANDIDATE_ID = /^k_[0-9A-HJKMNP-TV-Z]{26}$/u;
const NAMESPACE = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31})?$/u;
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/u;
const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL = /^(.+?)_(ordinal_)?(zero|one|two|few|many|other)$/u;
const MAX_TEXT = 4000;
const MAX_BODY = 60_000;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const jsonFiles = (dir) =>
    existsSync(dir)
        ? readdirSync(dir)
              .filter((name) => name.endsWith('.json'))
              .sort()
        : [];

/** A locale the repository translates into: registered, not en-US, not generated. */
export function isTranslatedLocale(locale) {
    return (
        typeof locale === 'string' &&
        Object.hasOwn(LOCALES, locale) &&
        locale !== SOURCE_LOCALE &&
        !LOCALES[locale].pseudo
    );
}

/** The translated locale a sparse locale's missing keys come from (es-US: es-419); null when it's en-US. */
export function sparseParent(locale) {
    const next = resolutionChain(locale)[1];
    return next && next !== SOURCE_LOCALE ? next : null;
}

// ── Import ────────────────────────────────────────────────────────────────

/** The state of the i18n/ pull requests, from `gh pr list --json number,state,headRefName`. */
export function pullRequestStates(list) {
    return (Array.isArray(list) ? list : [])
        .filter(
            (pr) =>
                typeof pr?.headRefName === 'string' &&
                pr.headRefName.startsWith('i18n/') &&
                Number.isSafeInteger(pr.number),
        )
        .map((pr) => ({ number: pr.number, state: String(pr.state).toLowerCase() }))
        .filter((pr) => ['open', 'closed', 'merged'].includes(pr.state))
        .sort((a, b) => a.number - b.number);
}

/**
 * The import's body: every locale folder's dictionaries (en-US and the translations, not the
 * pseudo-locale), the context notes `packages/i18n/notes/<ns>.json` ({ key: note }, the folder
 * i18n-build checks), each namespace's label and where it appears (`packages/i18n/namespaces.json`,
 * { ns: { label, where } }, every entry, checked with i18n-build's rules; no field without the
 * file) and
 * `packages/i18n/glossary/<locale>.json` ([{ term, translation, note, doNotTranslate }]).
 */
export function importPayload({ commit, localesDir, i18nDir, pullRequests = [] }) {
    if (!/^[0-9a-f]{7,40}$/u.test(commit ?? '')) {
        throw new Error('--commit must be a commit SHA');
    }
    const locales = {};
    for (const locale of readdirSync(localesDir).sort()) {
        if (
            !statSync(join(localesDir, locale)).isDirectory() ||
            (locale !== SOURCE_LOCALE && !isTranslatedLocale(locale))
        ) {
            continue;
        }
        locales[locale] = Object.fromEntries(
            jsonFiles(join(localesDir, locale)).map((name) => [
                name.slice(0, -5),
                readJson(join(localesDir, locale, name)),
            ]),
        );
    }
    const context = Object.fromEntries(
        jsonFiles(join(i18nDir, 'notes')).map((name) => [name.slice(0, -5), readJson(join(i18nDir, 'notes', name))]),
    );
    const glossary = Object.fromEntries(
        jsonFiles(join(i18nDir, 'glossary'))
            .map((name) => [name.slice(0, -5), readJson(join(i18nDir, 'glossary', name))])
            .filter(([locale]) => isTranslatedLocale(locale)),
    );
    // The app takes the namespaces as the complete set (one left out loses its label) and
    // refuses the whole import if one entry breaks its rules, so every entry goes, checked.
    const namespacesFile = join(i18nDir, 'namespaces.json');
    const namespaces = existsSync(namespacesFile) ? readJson(namespacesFile) : undefined;
    if (namespaces !== undefined) {
        const problems = namespaceEntryProblems(namespaces);
        if (problems.length) {
            throw new Error(`namespaces.json would fail the import:\n${problems.join('\n')}`);
        }
    }
    const content = { locales, context, ...(namespaces && { namespaces }), glossary, pullRequests };
    return { body: { commit, ...content }, hash: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}

// ── Export ────────────────────────────────────────────────────────────────

/** Nested objects to dotted keys. */
function flatten(tree, prefix = '', out = new Map()) {
    for (const [key, value] of Object.entries(tree ?? {})) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
            out.set(path, value);
        } else if (isObject(value)) {
            flatten(value, path, out);
        }
    }
    return out;
}

/** The segments a dotted key has in en-US's file, which may nest (`errors: { offline }`) or not (`"errors.offline"`). */
function pathIn(node, key) {
    if (!isObject(node)) {
        return null;
    }
    if (Object.hasOwn(node, key)) {
        return [key];
    }
    for (let at = key.indexOf('.'); at !== -1; at = key.indexOf('.', at + 1)) {
        const head = key.slice(0, at);
        const rest = isObject(node[head]) ? pathIn(node[head], key.slice(at + 1)) : null;
        if (rest) {
            return [head, ...rest];
        }
    }
    return null;
}

/** Where a flat key goes, laid out as en-US lays it; a plural form en-US lacks (`_many`) goes beside its `_other`. */
export function keyPath(english, key) {
    const direct = pathIn(english, key);
    if (direct) {
        return direct;
    }
    const plural = PLURAL.exec(key);
    if (plural) {
        const [, base, ordinal = '', form] = plural;
        const other = pathIn(english, `${base}_${ordinal}other`);
        if (other) {
            const last = other.at(-1);
            return [...other.slice(0, -1), `${last.slice(0, -`_${ordinal}other`.length)}_${ordinal}${form}`];
        }
    }
    return [key];
}

function setAt(tree, path, value) {
    let node = tree;
    for (const part of path.slice(0, -1)) {
        if (!Object.hasOwn(node, part)) {
            node[part] = {};
        }
        if (!isObject(node[part])) {
            throw new Error(`${path.join('.')}: ${part} is a string, not an object`);
        }
        node = node[part];
    }
    node[path.at(-1)] = value;
}

function deleteAt(tree, path) {
    const parents = [tree];
    for (const part of path.slice(0, -1)) {
        const next = parents.at(-1)[part];
        if (!isObject(next)) {
            return;
        }
        parents.push(next);
    }
    delete parents.at(-1)[path.at(-1)];
    // Drop the objects left empty.
    for (let at = parents.length - 1; at > 0; at--) {
        if (Object.keys(parents[at]).length === 0) {
            delete parents[at - 1][path[at - 1]];
        }
    }
}

/** A key's own entry and every plural form of it. */
const formsOf = (key) => [
    key,
    ...FORMS.map((form) => `${key}_${form}`),
    ...FORMS.map((form) => `${key}_ordinal_${form}`),
];

/** The segments of every string in a tree, with its dotted key. */
function stringPaths(tree, prefix = [], out = []) {
    for (const [key, value] of Object.entries(tree ?? {})) {
        if (typeof value === 'string') {
            out.push({ key: [...prefix, key].join('.'), path: [...prefix, key] });
        } else if (isObject(value)) {
            stringPaths(value, [...prefix, key], out);
        }
    }
    return out;
}

/** Removes a key and its plural forms in every layout a file may hold them: nested, flat or both. */
export function removeKey(tree, key) {
    const keys = new Set(formsOf(key));
    for (const { key: dotted, path } of stringPaths(tree)) {
        if (keys.has(dotted)) {
            deleteAt(tree, path);
        }
    }
}

/** Keys in en-US's order, a plural form en-US lacks beside its `_other`, anything else last. */
function ordered(tree, english) {
    if (!isObject(tree)) {
        return tree;
    }
    const keys = isObject(english) ? Object.keys(english) : [];
    const rank = (key) => {
        const plural = PLURAL.exec(key);
        const form = plural ? FORMS.indexOf(plural[3]) : 0;
        const own = keys.indexOf(key);
        if (own !== -1) {
            return [own, form];
        }
        const other = plural ? keys.indexOf(`${plural[1]}_${plural[2] ?? ''}other`) : -1;
        return [other === -1 ? Number.MAX_SAFE_INTEGER : other, form];
    };
    const entries = Object.entries(tree).sort(([a], [b]) => {
        const [ra, fa] = rank(a);
        const [rb, fb] = rank(b);
        return ra - rb || fa - fb || (a < b ? -1 : a > b ? 1 : 0);
    });
    return Object.fromEntries(
        entries.map(([key, value]) => [key, ordered(value, isObject(english) ? english[key] : undefined)]),
    );
}

/** A candidate as the app sends it, checked; the reason when it can't be written. */
export function checkCandidate(candidate) {
    if (!isObject(candidate) || typeof candidate.id !== 'string' || !CANDIDATE_ID.test(candidate.id)) {
        return 'not a candidate';
    }
    if (
        typeof candidate.ns !== 'string' ||
        !NAMESPACE.test(candidate.ns) ||
        typeof candidate.key !== 'string' ||
        !KEY.test(candidate.key)
    ) {
        return 'not a namespace and key';
    }
    if (candidate.inherit === true) {
        return null;
    }
    if (!isObject(candidate.values) || Object.keys(candidate.values).length === 0) {
        return 'no values';
    }
    for (const [key, text] of Object.entries(candidate.values)) {
        const plural = PLURAL.exec(key);
        if (
            (key !== candidate.key && plural?.[1] !== candidate.key) ||
            typeof text !== 'string' ||
            text.trim() === '' ||
            text.length > MAX_TEXT
        ) {
            return `bad value for ${key}`;
        }
    }
    return null;
}

/**
 * The ids the app withheld from the export (approved candidates that failed its re-validation,
 * left out of `locales[*].candidates`). Only an array of candidate ids counts; anything else is
 * ignored, as an empty list.
 */
export function withheldIds(exported) {
    const withheld = exported?.withheld;
    if (!Array.isArray(withheld) || !withheld.every((id) => typeof id === 'string' && CANDIDATE_ID.test(id))) {
        return [];
    }
    return [...new Set(withheld)];
}

const withheldLine = (count) =>
    `${count} candidate${count === 1 ? '' : 's'} withheld by the app's validation (they stay in the app, and aren't acknowledged).`;

/** An alias for the pull request body: one line, no backticks, in a code span so it can't mention or link. */
export function aliasForBody(alias) {
    const text = String(alias ?? '')
        .normalize('NFKC')
        .replace(/[\p{C}`\\]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 40);
    return `\`${text || 'former contributor'}\``;
}

/**
 * Writes one locale's candidates. Returns the ids written (for /export/ack), the body section,
 * the candidates skipped with why, and the files changed.
 */
export function applyLocale({ exported, locale, localesDir }) {
    if (!isTranslatedLocale(locale)) {
        throw new Error(`${locale} is not a locale this repository translates into`);
    }
    const entry = exported?.locales?.[locale];
    const candidates = Array.isArray(entry?.candidates) ? entry.candidates : [];
    const parent = sparseParent(locale);
    const files = new Map();
    const fileFor = (ns) => {
        if (!files.has(ns)) {
            const path = join(localesDir, locale, `${ns}.json`);
            files.set(ns, {
                path,
                tree: existsSync(path) ? readJson(path) : {},
                english: readJson(join(localesDir, SOURCE_LOCALE, `${ns}.json`)),
                parent:
                    parent && existsSync(join(localesDir, parent, `${ns}.json`))
                        ? flatten(readJson(join(localesDir, parent, `${ns}.json`)))
                        : null,
            });
        }
        return files.get(ns);
    };
    const withheld = new Set(withheldIds(exported));
    const written = [];
    const skipped = [];
    for (const candidate of candidates) {
        const problem = withheld.has(candidate?.id) ? "withheld by the app's validation" : checkCandidate(candidate);
        if (problem) {
            skipped.push({ id: typeof candidate?.id === 'string' ? candidate.id.slice(0, 40) : '?', why: problem });
            continue;
        }
        if (!existsSync(join(localesDir, SOURCE_LOCALE, `${candidate.ns}.json`))) {
            skipped.push({ id: candidate.id, why: `en-US has no namespace ${candidate.ns}` });
            continue;
        }
        const file = fileFor(candidate.ns);
        // The key's old entry and forms go first, wherever the file has them (nested or flat, which
        // may differ from en-US's layout): a plural's forms are replaced as a whole. A context form
        // (`edited_socio`) is a key of its own in the app, with its own candidates.
        removeKey(file.tree, candidate.key);
        // Sparse over the parent as a whole: a plural's forms are all kept when any differs (the build
        // wants every form of a plural a file has), and left out only when all match.
        const values = candidate.inherit === true ? [] : Object.entries(candidate.values);
        if (values.some(([key, text]) => file.parent?.get(key) !== text)) {
            for (const [key, text] of values) {
                setAt(file.tree, keyPath(file.english, key), text);
            }
        }
        written.push(candidate);
    }
    const changed = [];
    for (const { path, tree, english } of files.values()) {
        const next = ordered(tree, english);
        const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (Object.keys(next).length === 0) {
            if (before !== null) {
                rmSync(path);
                changed.push(path);
            }
            continue;
        }
        const text = `${JSON.stringify(next, null, 4)}\n`;
        if (text !== before) {
            mkdirSync(join(localesDir, locale), { recursive: true });
            writeFileSync(path, text);
            changed.push(path);
        }
    }
    return {
        ids: written.map((candidate) => candidate.id),
        body: bodySection(exported, locale, written, skipped),
        skipped,
        changed,
    };
}

/** The pull request body's section for one export: contributors by alias, self-approved strings marked. */
export function bodySection(exported, locale, written, skipped = []) {
    const at = Number.isFinite(exported?.generatedAt) ? new Date(exported.generatedAt).toISOString() : 'unknown time';
    const commit =
        typeof exported?.commit === 'string' && /^[0-9a-f]{7,40}$/u.test(exported.commit)
            ? `\`${exported.commit.slice(0, 12)}\``
            : 'unknown';
    const people = [
        ...new Set(
            written
                .filter((candidate) => candidate.origin !== 'machine')
                .map((candidate) => aliasForBody(candidate.author)),
        ),
    ];
    const machine = written.filter((candidate) => candidate.origin === 'machine').length;
    const self = written.filter((candidate) => candidate.selfApproved === true);
    const label = (candidate) =>
        `\`${candidate.ns}:${candidate.key}\`${candidate.inherit === true ? ' (back to the fallback)' : ''}`;
    const lines = [
        `### Export ${at}`,
        '',
        `${written.length} string${written.length === 1 ? '' : 's'} for ${locale}, translated against en-US at ${commit}.`,
        '',
    ];
    lines.push(`Translations by: ${people.length ? people.join(', ') : 'none (machine drafts only)'}`);
    if (machine) {
        lines.push(`Machine drafts, reviewed in the app: ${machine}`);
    }
    if (self.length) {
        lines.push(
            '',
            '**Self-approved** (an admin approved their own translation; review these closely):',
            ...self.map((candidate) => `- ${label(candidate)} (self-approved)`),
        );
    }
    const withheld = withheldIds(exported).length;
    if (withheld) {
        lines.push('', withheldLine(withheld));
    }
    if (skipped.length) {
        lines.push(
            '',
            `Not written (left approved in the app): ${skipped.length}`,
            ...skipped.slice(0, 20).map((item) => `- \`${item.id}\`: ${item.why}`),
        );
    }
    lines.push(
        '',
        '<details><summary>Strings</summary>',
        '',
        ...written.map((candidate) => `- ${label(candidate)}`),
        '',
        '</details>',
    );
    let body = lines.join('\n');
    if (body.length > MAX_BODY) {
        body = `${body.slice(0, MAX_BODY)}\n\n(cut: the list is longer than a pull request body holds)\n\n</details>`;
    }
    return `${body}\n`;
}

// ── Command line ──────────────────────────────────────────────────────────

function main(argv) {
    const [command, ...args] = argv;
    const option = (name) => {
        const at = args.indexOf(name);
        return at === -1 ? undefined : args[at + 1];
    };
    const localesDir = resolve(option('--locales') ?? join(root, 'packages/i18n/locales'));
    if (command === 'payload') {
        const prs = option('--pull-requests');
        const { body, hash } = importPayload({
            commit: option('--commit'),
            localesDir,
            i18nDir: resolve(localesDir, '..'),
            pullRequests: prs ? pullRequestStates(readJson(prs)) : [],
        });
        writeFileSync(option('--out'), JSON.stringify(body));
        console.log(hash);
        return;
    }
    if (command === 'locales') {
        const exported = readJson(option('--export'));
        for (const [locale, entry] of Object.entries(isObject(exported?.locales) ? exported.locales : {}).sort(
            ([a], [b]) => (a < b ? -1 : 1),
        )) {
            if (!isTranslatedLocale(locale)) {
                console.error(
                    `skipping ${JSON.stringify(locale.slice(0, 20))}: not a locale this repository translates into`,
                );
            } else if (Array.isArray(entry?.candidates) && entry.candidates.length) {
                console.log(locale);
            }
        }
        // stderr: the job's log, not the list of locales.
        console.error(withheldLine(withheldIds(exported).length));
        return;
    }
    if (command === 'apply') {
        const result = applyLocale({ exported: readJson(option('--export')), locale: option('--locale'), localesDir });
        writeFileSync(option('--body'), result.body);
        writeFileSync(option('--ids'), JSON.stringify(result.ids));
        for (const item of result.skipped) {
            console.error(`${option('--locale')}: skipped ${item.id}: ${item.why}`);
        }
        console.log(
            `${option('--locale')}: ${result.ids.length} written, ${result.skipped.length} skipped, ${result.changed.length} files changed.`,
        );
        return;
    }
    console.error('usage: i18n-sync.mjs payload | locales | apply (see the header)');
    process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2));
}
