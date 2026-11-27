#!/usr/bin/env node
// The translations' content guard (docs/I18N.md, "Translations from contributors"). A
// translation may add nothing its en-US source string doesn't have of:
//
//   - URLs (any scheme, `www.` hosts, and obfuscated ones: `hxxp://`, `evil[.]com`, `(dot)`);
//   - domains, IDN ones included (a look-alike `exаmple.com` with a Cyrillic а is not
//     `example.com`), and IPv4 addresses;
//   - email addresses (`ada@example.com`, `ada (at) example (dot) com`);
//   - phone numbers: seven digits or more, unless the same digits are a number in the source
//     (`1,000,000` may become `1 000 000`), or it is written with `,`, `.` or `'` as thousands
//     separators, or it is a decimal or a date;
//   - markup: only the source's `<Trans>` tags (`<0>`, `<1/>`, `<bold>`), no other tag, HTML
//     entity or invisible format character (bidi overrides, zero-width spaces).
//
// Text is NFKC-normalized first, so full-width characters (`ｅｖｉｌ．ｃｏｍ`, `＠`) count as
// their ASCII forms; zero-width characters inside a word are dropped; `{{variables}}` and
// `$t(nesting)` are taken out. A domain's last label must be a top-level domain in IANA's list
// (scripts/lib/iana-tlds.txt), so abbreviations like `EE.UU.` or `p.ej.` pass.
//
// It needs nothing installed, so the i18n-guard workflow runs it on the runner's own Node:
//
//   node scripts/i18n-content-guard.mjs [--locales <dir>]     # part of pnpm i18n:check
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_LOCALE = 'en-US';
// fileURLToPath, not import.meta.dirname: the runner's Node may be older than the repository's.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TLDS = new Set(
    readFileSync(join(root, 'scripts/lib/iana-tlds.txt'), 'utf8')
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line && !line.startsWith('#')),
);

// Invisible format characters: soft hyphen, zero-width, bidi marks, overrides and isolates, the
// word joiner and invisible operators, and the byte-order mark.
// Written as escapes in a string: the formatter would turn regex escapes into the invisible characters.
const INVISIBLE = new RegExp(
    '[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]',
    'gu',
);
// Controls but newline and tab.
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** `{{name}}`, `{{- html}}`, `{{when, datetime}}` and `$t(ns:key)`: i18next's, not text. */
const TOKENS = /\{\{[^{}]*\}\}|\$t\([^()]*\)/gu;

/** The text as the guard reads it: tokens out, NFKC, invisible characters dropped, obfuscations undone. */
export function normalizeText(text) {
    return (
        text
            .replace(TOKENS, ' ')
            .normalize('NFKC')
            .replace(INVISIBLE, '')
            // Ideographic and half-width full stops: URL parsers read them as dots in a host.
            .replace(new RegExp('[\\u3002\\uff61]', 'gu'), '.')
            // Defanged forms: hxxp://, evil[.]com, evil(dot)com, ada[at]example.com, example[:]8080.
            .replace(/\bh(?:xx|\*\*|XX)p(s?)(?=\[?:)/giu, 'http$1')
            .replace(/\s*[[({<]\s*(?:\.|dot)\s*[\])}>]\s*/giu, '.')
            .replace(/\s*[[({<]\s*(?:@|at)\s*[\])}>]\s*/giu, '@')
            .replace(/\s*[[({<]\s*:\s*[\])}>]\s*/gu, ':')
            .replace(/\[\s*\/\s*\]/gu, '/')
    );
}

const URL_PATTERN =
    /\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|tel|sms|callto|javascript|data|file|ftp|news|irc|xmpp|sip|magnet):)[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/giu;
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,63}/giu;
const HOST_PATTERN =
    /(?<![\p{L}\p{N}@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}-]{1,63}(?![\p{L}\p{N}-])/giu;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const NUMBER_PATTERN = /(?<![\d.,])\+?\(?\d[\d\s().\-–—/]{5,}\d/gu;

/** A host's ASCII (punycode) form; null when it isn't a valid host name. */
function asciiHost(host) {
    const ascii = domainToASCII(host.replace(/\.$/u, ''));
    return ascii ? ascii.toLowerCase() : null;
}

/** Whether `candidate` is a domain name or an IPv4 address, not an abbreviation or a version. */
function isHost(candidate) {
    if (IPV4.test(candidate)) {
        return true;
    }
    const ascii = asciiHost(candidate);
    if (!ascii) {
        return false;
    }
    const labels = ascii.split('.');
    return labels.length >= 2 && !/^\d+$/u.test(labels.at(-1)) && TLDS.has(labels.at(-1));
}

/** Lowercased, trailing punctuation cut: `Socio.sh.` and `socio.sh` are one item. */
function normalizeItem(kind, text) {
    const trimmed = text.replace(/[.,;:!?)\]}'"»”’]+$/u, '');
    if (kind === 'domain') {
        return asciiHost(trimmed) ?? trimmed.toLowerCase();
    }
    if (kind === 'email') {
        const at = trimmed.lastIndexOf('@');
        return `${trimmed.slice(0, at).toLowerCase()}@${asciiHost(trimmed.slice(at + 1)) ?? trimmed.slice(at + 1).toLowerCase()}`;
    }
    if (kind === 'url') {
        return trimmed.toLowerCase();
    }
    return trimmed;
}

/** Digits only, for comparing numbers across locales' separators. */
const digitsOf = (text) => text.replace(/\D/gu, '');

/** Written with thousands separators (1,000,000; 1.000.000; 1'000'000). Spaces don't count: NFKC makes no-break
 * spaces plain ones, and 912 345 678 is a phone number. */
const GROUPED = /^\d{1,3}(?:([.,'])\d{3})(?:\1\d{3})*(?:[.,]\d+)?$/u;
/** A decimal: one separator, no grouping (3.14159265). */
const DECIMAL = /^\d+[.,]\d+$/u;
/** A date or time, which isn't a phone number: 2026-11-26, 26/11/2026, 26.11.2026. */
const DATE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})$/u;

/**
 * The URLs, emails, domains and phone-like numbers in a text, each normalized, in the order found.
 * Each is cut out of the text once taken, so a URL's host isn't also a domain.
 */
export function contentItems(raw) {
    let text = normalizeText(raw);
    const found = [];
    const take = (kind, pattern, keep = () => true) => {
        text = text.replace(pattern, (match) => {
            if (!keep(match)) {
                return match;
            }
            found.push({ kind, text: normalizeItem(kind, match) });
            return ' ';
        });
    };
    take('url', URL_PATTERN);
    take('email', EMAIL_PATTERN);
    take('domain', HOST_PATTERN, (match) => isHost(match.replace(/\.$/u, '')));
    take('phone', NUMBER_PATTERN, (match) => {
        const trimmed = match.trim();
        return digitsOf(trimmed).length >= 7 && !GROUPED.test(trimmed) && !DECIMAL.test(trimmed) && !DATE.test(trimmed);
    });
    return found;
}

/** Every number in a text with seven digits or more, as digits: what a phone item may match. */
function sourceNumbers(text) {
    const numbers = new Set();
    for (const match of normalizeText(text).matchAll(/\+?\(?\d[\d\s().,\-–—/'  ]*\d/gu)) {
        numbers.add(digitsOf(match[0]));
    }
    return numbers;
}

/** The items in `translation` that `source` doesn't have. A domain in a source URL or email counts as present. */
export function newContent(source, translation) {
    const present = new Set();
    for (const item of contentItems(source)) {
        present.add(`${item.kind}:${item.text}`);
        if (item.kind === 'url') {
            const host = /^[a-z][a-z0-9+.-]*:(?:\/\/)?(?:[^@/?#]*@)?([^/?#:]+)/u.exec(item.text)?.[1];
            if (host) {
                present.add(`domain:${asciiHost(host) ?? host}`);
            }
        }
        if (item.kind === 'email') {
            present.add(`domain:${item.text.slice(item.text.lastIndexOf('@') + 1)}`);
        }
    }
    const numbers = sourceNumbers(source);
    return contentItems(translation).filter((item) =>
        item.kind === 'phone' ? !numbers.has(digitsOf(item.text)) : !present.has(`${item.kind}:${item.text}`),
    );
}

/** `<0>`, `</0>`, `<1/>`, `<bold>`: the tags `<Trans>` maps to components. */
const TAG = /<(\/?)([A-Za-z0-9_-]+)\s*(\/?)>/gu;
const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/giu;

const tagsOf = (text) =>
    [...text.normalize('NFKC').matchAll(TAG)].map((match) => `<${match[1]}${match[2]}${match[3]}>`);

/** What a text adds of markup over its source: foreign or extra tags, other `<…>` markup, entities, invisible characters. */
export function newMarkup(source, translation) {
    const problems = [];
    const allowed = new Map();
    for (const tag of tagsOf(source)) {
        allowed.set(tag, (allowed.get(tag) ?? 0) + 1);
    }
    for (const tag of tagsOf(translation)) {
        const left = allowed.get(tag) ?? 0;
        if (left === 0) {
            problems.push(`tag ${tag}`);
        } else {
            allowed.set(tag, left - 1);
        }
    }
    const rest = translation.normalize('NFKC').replace(TAG, ' ');
    const sourceRest = source.normalize('NFKC').replace(TAG, ' ');
    // Anything else that a browser or `<Trans>` could read as markup: <a href>, <!-- -->, <?…>, </ x>.
    for (const match of rest.matchAll(/<\s*[A-Za-z!/?][^>]*>?/gu)) {
        if (!sourceRest.includes(match[0])) {
            problems.push(`markup ${JSON.stringify(match[0].slice(0, 40))}`);
        }
    }
    for (const match of rest.matchAll(ENTITY)) {
        if (!sourceRest.includes(match[0])) {
            problems.push(`entity ${match[0]}`);
        }
    }
    for (const pattern of [INVISIBLE, CONTROL]) {
        for (const match of translation.matchAll(pattern)) {
            if (!source.includes(match[0])) {
                problems.push(
                    `invisible character U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
                );
            }
        }
    }
    return [...new Set(problems)];
}

/** A translation's problems against its source text: content and markup, as readable lines. */
export function translationProblems(source, translation) {
    return [
        ...newContent(source, translation).map(
            (item) => `${item.kind} ${JSON.stringify(item.text)} is not in the en-US source`,
        ),
        ...newMarkup(source, translation).map((problem) => `${problem} is not in the en-US source`),
    ];
}

/** Nested objects to dotted keys, as i18next reads them. */
function flatten(tree, prefix = '', out = new Map()) {
    if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
        return out;
    }
    for (const [key, value] of Object.entries(tree)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
            out.set(path, value);
        } else {
            flatten(value, path, out);
        }
    }
    return out;
}

const PLURAL = /^(.+?)(_ordinal)?_(zero|one|two|few|many|other)$/u;

/**
 * The source text a translated key answers to. A plural form answers to all of the source's forms
 * of that key (a locale may have forms en-US doesn't, like `_many`); null for an unknown key, which
 * the build reports.
 */
function sourceFor(source, key) {
    const plural = PLURAL.exec(key);
    if (plural) {
        const [, base, ordinal = ''] = plural;
        const forms = [...source].filter(([sourceKey]) => {
            const match = PLURAL.exec(sourceKey);
            return match && match[1] === base && (match[2] ?? '') === ordinal;
        });
        if (forms.length) {
            return forms.map(([, text]) => text).join('\n');
        }
    }
    return source.has(key) ? source.get(key) : null;
}

/** Every translation file's problems against en-US, as `<locale>/<ns>.json: <key>: <problem>`. */
export function checkLocales(dir) {
    const problems = [];
    const read = (locale, file) => {
        try {
            return JSON.parse(readFileSync(join(dir, locale, file), 'utf8'));
        } catch {
            return null;
        }
    };
    const locales = readdirSync(dir)
        .filter((name) => statSync(join(dir, name)).isDirectory())
        .sort();
    for (const locale of locales.filter((name) => name !== SOURCE_LOCALE)) {
        for (const file of readdirSync(join(dir, locale))
            .filter((name) => name.endsWith('.json'))
            .sort()) {
            const translation = read(locale, file);
            if (translation === null) {
                // Not JSON: the build's check reports it.
                continue;
            }
            const source = flatten(read(SOURCE_LOCALE, file) ?? {});
            for (const [key, text] of flatten(translation)) {
                const sourceText = sourceFor(source, key);
                if (sourceText === null) {
                    continue;
                }
                for (const problem of translationProblems(sourceText, text)) {
                    problems.push(`${locale}/${file}: ${key}: ${problem}`);
                }
            }
        }
    }
    return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const at = args.indexOf('--locales');
    const dir = at === -1 ? join(root, 'packages/i18n/locales') : resolve(args[at + 1]);
    const problems = checkLocales(dir);
    if (problems.length) {
        console.error(
            `i18n content guard: ${problems.length} problem${problems.length === 1 ? '' : 's'} (docs/I18N.md):\n${problems.map((line) => `  ${line}`).join('\n')}`,
        );
        process.exit(1);
    }
    console.log('i18n content guard: no URL, domain, email, phone number or markup beyond the en-US source.');
}
