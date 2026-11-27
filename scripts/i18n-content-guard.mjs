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
//   - markup: exactly the source's `<Trans>` tags, the same names nested the same way (siblings
//     may move), each holding only its name (`<0>`, `</0>`, `<1/>`, `<bold>`): no attribute, no
//     spaced pseudo-tag (`< 0 href="/x"/>`) or other `<` or `>`, no look-alike bracket, HTML
//     entity or invisible format character (bidi overrides, zero-width spaces). A plural form is
//     held to its own source form.
//
// For content, text is NFKC-normalized first, so full-width characters (`ｅｖｉｌ．ｃｏｍ`, `＠`) count as
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
        // Scheme and host are case-insensitive; a path or query may not be (`/Team?token=AbC`).
        const parts = /^([a-z][a-z0-9+.-]*:(?:\/\/)?)?([^@/?#]*@)?([^/?#]*)(.*)$/isu.exec(trimmed);
        return parts
            ? `${(parts[1] ?? '').toLowerCase()}${parts[2] ?? ''}${parts[3].toLowerCase()}${parts[4]}`
            : trimmed;
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

/**
 * A `<Trans>` tag, strictly: `<0>`, `</0>`, `<0/>`, `<strong>`. Nothing but the name may stand
 * between the brackets: no attribute (`<0 href="/logout">` renders as a link), no space.
 */
const TAG = /<(\/?)([A-Za-z0-9_-]+)(\/?)>/uy;
const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/giu;
/**
 * Full-width and small brackets: not markup to `<Trans>`, but they read as markup, so they're held
 * to the source. Exactly the characters NFKC maps to `<` or `>` (U+FF1C, U+FF1E, U+FE64, U+FE65);
 * the tests scan U+0000 to U+FFFF to keep it so.
 */
export const LOOKALIKE_BRACKETS = new RegExp('[\\uff1c\\uff1e\\ufe64\\ufe65]', 'gu');

/**
 * A text's tags as a tree, and every `<` or `>` that isn't part of a tag. Only ASCII brackets
 * are markup to `<Trans>`, so the text is read as written, not NFKC-normalized.
 *
 * The tree's canonical form is what translations must match: each tag's name, whether it closes
 * itself, and what it nests. Siblings are compared in any order, since a sentence's parts move
 * between languages ("Read <0>the guide</0> and <1/>" may become "<1/> y lee <0>la guía</0>").
 */
export function tagStructure(text) {
    const stray = [];
    const sequence = [];
    const root = { children: [] };
    const stack = [root];
    let wellFormed = true;
    for (let at = 0; at < text.length; at++) {
        const char = text[at];
        if (char === '>') {
            stray.push('>');
            continue;
        }
        if (char !== '<') {
            continue;
        }
        TAG.lastIndex = at;
        const match = TAG.exec(text);
        if (!match || (match[1] && match[3])) {
            // A `<`, any whitespace (newlines too), then a tag-name character, `/`, `!` or `?`, with
            // a `>` before the next `<`, is markup however it's spaced (`< 0 href="/x"/>`, `<\n0>`):
            // it's quoted whole, so only the same snippet in the source lets it through. A `<` with
            // no `>` after it before the next `<` ("x < 5", "a < b") is text.
            const close = text.indexOf('>', at + 1);
            const open = text.indexOf('<', at + 1);
            const closed = close !== -1 && (open === -1 || close < open);
            if (closed && /^<\s*[A-Za-z0-9_/!?-]/u.test(text.slice(at, close + 1))) {
                stray.push(text.slice(at, close + 1));
                // Its own `>` is part of it, not another stray.
                at = close;
            } else if (/^<[A-Za-z0-9_/!?-]/u.test(text.slice(at, at + 2))) {
                // An unclosed tag-like start (`<0 href`): quoted up to the next `<`.
                stray.push(text.slice(at, Math.min(open === -1 ? text.length : open, at + 40)));
            } else {
                stray.push('<');
            }
            continue;
        }
        const [token, closing, name, selfClosing] = match;
        sequence.push(token);
        at += token.length - 1;
        if (selfClosing) {
            stack.at(-1).children.push({ name, self: true, children: [] });
        } else if (!closing) {
            const node = { name, self: false, children: [] };
            stack.at(-1).children.push(node);
            stack.push(node);
        } else if (stack.length > 1 && stack.at(-1).name === name) {
            stack.pop();
        } else {
            wellFormed = false;
        }
    }
    if (stack.length > 1) {
        wellFormed = false;
    }
    const canon = (node) => `${node.name}${node.self ? '/' : `(${node.children.map(canon).sort().join(',')})`}`;
    return {
        // A malformed source has no tree; a translation then has to repeat its tags exactly.
        canonical: wellFormed ? root.children.map(canon).sort().join(',') : `malformed:${sequence.join('')}`,
        sequence: sequence.join(''),
        stray,
    };
}

/**
 * What a text adds of markup over its source form, as readable lines: tags that differ from the
 * source's (extra, missing, renamed, renested, or self-closing where the source pairs them, and
 * any attribute), other `<` or `>`, look-alike brackets, entities and invisible characters.
 */
export function newMarkup(source, translation) {
    const problems = [];
    const want = tagStructure(source);
    const have = tagStructure(translation);
    const strays = [...want.stray];
    for (const item of have.stray) {
        const at = strays.indexOf(item);
        if (at === -1) {
            problems.push(
                `markup ${JSON.stringify(item)} is not allowed: a tag holds only its name, as in <0> or <0/>`,
            );
        } else {
            strays.splice(at, 1);
        }
    }
    if (have.canonical !== want.canonical) {
        problems.push(
            `tags ${JSON.stringify(have.sequence)} don't match the en-US source's ${JSON.stringify(want.sequence)}`,
        );
    }
    const counts = (text, pattern) => {
        const found = new Map();
        for (const match of text.matchAll(pattern)) {
            found.set(match[0], (found.get(match[0]) ?? 0) + 1);
        }
        return found;
    };
    const extra = (pattern, label, sourceText = source, translationText = translation) => {
        const allowed = counts(sourceText, pattern);
        for (const [item, count] of counts(translationText, pattern)) {
            if (count > (allowed.get(item) ?? 0)) {
                problems.push(`${label(item)} is not in the en-US source`);
            }
        }
    };
    extra(LOOKALIKE_BRACKETS, (item) => `look-alike bracket ${JSON.stringify(item)}`);
    extra(ENTITY, (item) => `entity ${item}`, source.normalize('NFKC'), translation.normalize('NFKC'));
    for (const pattern of [INVISIBLE, CONTROL]) {
        extra(
            pattern,
            (item) => `invisible character U+${item.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        );
    }
    return problems;
}

/**
 * A translation's problems against its source: content against all of the key's source text (a
 * plural's forms together), markup against the source form it answers to.
 */
export function translationProblems(source, translation, markupSource = source) {
    return [
        ...newContent(source, translation).map(
            (item) => `${item.kind} ${JSON.stringify(item.text)} is not in the en-US source`,
        ),
        ...newMarkup(markupSource, translation),
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
 * The source text a translated key answers to: `all` holds every form of a plural (a locale may
 * have forms en-US doesn't, like `_many`), for the content check; `form` is the source form its
 * tags must match: the same form, or `_other` for one en-US lacks. Null for an unknown key, which
 * the build reports. A context form (`edited_socio`) is a key of its own in en-US.
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
            const form = source.get(key) ?? source.get(`${base}${ordinal}_other`) ?? forms[0][1];
            return { all: forms.map(([, text]) => text).join('\n'), form };
        }
    }
    return source.has(key) ? { all: source.get(key), form: source.get(key) } : null;
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
                for (const problem of translationProblems(sourceText.all, text, sourceText.form)) {
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
