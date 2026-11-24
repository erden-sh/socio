import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_SOURCES } from '../support/package-sources.js';

/**
 * The product is Socio and its agents are socios (CB-163). Nothing a
 * person or a model reads may call them "Dot" or "Dots" again: not in
 * the client, the server or the shared code. The scan reads each source
 * file without its comments and finds
 * - the words "Dot" and "Dots" anywhere except where they are a type
 *   (`dot: Dot`, `Dot[]`, `Pick<Dot, 'id'>`, an import), and
 * - "dot" or "dots" in lower case inside a sentence in a string or in
 *   JSX text.
 * Identifiers like `computerDot` or `DotHome` never match: only whole
 * words do. Lines that log (`log(`, `console.`) are left alone.
 */
const src = join(__dirname, '../../src');
const roots = [
    join(src, 'server'),
    join(__dirname, '../../packages/client/src'),
    ...PACKAGE_SOURCES.map((dir) => join(__dirname, '../..', dir)),
];

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(path) ? [path] : [];
    });
}

interface Line {
    /** The line with strings and comments blanked: what is code. */
    code: string;
    /** The text inside the line's string literals. */
    strings: string[];
    /** The line as written, without a trailing comment. */
    text: string;
}

/**
 * Splits source into lines without comments (block comments, `//` and
 * trailing comments after code), and with each line's strings apart.
 * Template literals that span lines carry on; `${}` is not parsed.
 */
export function stripComments(source: string): Line[] {
    const out: Line[] = [];
    let block = false;
    let quote = '';
    // Open `${` expressions inside template literals: brace depth of each.
    const exprs: number[] = [];
    for (const raw of source.split('\n')) {
        let code = '';
        let text = '';
        let current = '';
        const strings: string[] = [];
        let i = 0;
        if (quote === '`') {
            current = '';
        }
        while (i < raw.length) {
            const ch = raw[i]!;
            const next = raw[i + 1];
            if (block) {
                if (ch === '*' && next === '/') {
                    block = false;
                    i += 2;
                } else {
                    i++;
                }
                continue;
            }
            if (quote) {
                if (ch === '\\') {
                    current += raw.slice(i, i + 2);
                    text += raw.slice(i, i + 2);
                    i += 2;
                    continue;
                }
                text += ch;
                if (quote === '`' && ch === '$' && next === '{') {
                    text += next;
                    current += '${';
                    exprs.push(1);
                    quote = '';
                    i += 2;
                    continue;
                }
                if (ch === quote) {
                    strings.push(current);
                    current = '';
                    quote = '';
                    code += ch;
                } else {
                    current += ch;
                }
                i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                block = true;
                i += 2;
                continue;
            }
            if (ch === '/' && next === '/' && /^[\s;{}),]?$/.test(raw[i - 1] ?? '')) {
                break;
            }
            if (
                ch === '"' ||
                (ch === '`' && next !== ']') ||
                (ch === "'" && /[\s([{,:=?!&|>+]/.test(raw[i - 1] ?? ' '))
            ) {
                quote = ch;
                current = '';
                code += ch;
                text += ch;
                i++;
                continue;
            }
            if (exprs.length && ch === '{') {
                exprs[exprs.length - 1]!++;
            }
            if (exprs.length && ch === '}' && --exprs[exprs.length - 1]! === 0) {
                exprs.pop();
                quote = '`';
                current += '}';
                text += ch;
                i++;
                continue;
            }
            code += ch;
            text += ch;
            i++;
        }
        if (quote === '`') {
            strings.push(current);
        } else if (quote) {
            quote = '';
        }
        out.push({ code, strings, text });
    }
    return out;
}

/** A type position: the word names the `Dot` type, not a person's word. */
const typeUse = /(?:[:|]|\bas|\breadonly|\binterface|<)\s*Dot(?=[\s;,)>|=[\]]|$)/;

/** Strings that are not sentences: SQL, paths, keys and metadata. */
const notProse = /^(?:\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WITH)\b)/;

/** Places where "dot" or "dots" means something else, or the old text is kept on purpose. */
const wordsOfDots = [
    'dot segments',
    'separated by dots',
    'digits, dots and dashes',
    'has dots, which',
    'dot=',
    'dots/',
    'Three dots worth',
];
const legacy = (text: string) => /\bLEGACY_DOT_FILING_FOOTER\b|^\s*'_Filed by a Dot /.test(text);

/** A line of JSX text: words and punctuation, no code. */
const isProse = (line: string) =>
    /^[A-Za-z0-9 ,.’'!?&;\-–—…“”]+$/.test(line) && !/\w\.\w/.test(line) && line.split(' ').length > 2;

export function copyHits(source: string, file = ''): string[] {
    const hits: string[] = [];
    let importing = false;
    const jsx = file.endsWith('.tsx');
    stripComments(source).forEach((line, i) => {
        const where = `${file}:${i + 1}: ${line.text.trim()}`;
        const trimmed = line.code.trim();
        if (/^import\b/.test(trimmed)) {
            importing = !/\bfrom\s*['"`]/.test(trimmed) && !/^import\s+['"]/.test(trimmed);
        } else if (importing) {
            if (/\bfrom\s*['"`]/.test(line.code)) {
                importing = false;
            }
            return;
        }
        if (/^import\b/.test(trimmed)) {
            return;
        }
        if (legacy(line.text)) {
            return;
        }
        if (/\blog\??\.?\(|console\./.test(line.code)) {
            return;
        }
        if (/^Dot,?$/.test(trimmed)) {
            return;
        }
        if (/^name: '[^']*',?$/.test(trimmed)) {
            return;
        }
        // Capitalized: anywhere in code (JSX text) or in a string.
        const codeWord = /\bDots?\b/.exec(line.code);
        const words = line.strings.map((s) => s.replace(/\$\{[^}]*\}/g, ''));
        if (codeWord && !typeUse.test(line.code)) {
            hits.push(where);
        } else if (words.some((s) => /\bDots?\b/.test(s))) {
            hits.push(where);
        }
        // Lower case: a word of a sentence in a string or in JSX text.
        else if (
            words.some(
                (s) =>
                    /\s/.test(s.trim()) &&
                    !notProse.test(s) &&
                    !wordsOfDots.some((ok) => s.includes(ok)) &&
                    /\bdots?\b/i.test(s),
            )
        ) {
            hits.push(where);
        } else if (jsx && isProse(trimmed) && /\bdots?\b/i.test(trimmed)) {
            hits.push(where);
        }
    });
    return hits;
}

describe('user-visible copy', () => {
    it('never calls a socio a Dot', () => {
        const hits = roots
            .flatMap(sources)
            .flatMap((file) => copyHits(readFileSync(file, 'utf8'), relative(src, file)));
        expect(hits).toEqual([]);
    });

    it('spots the old wording, but not identifiers or types', () => {
        const hit = (code: string, file = 'a.tsx') => copyHits(code, file).length;
        expect(hit('<p>Create a Dot to give it a computer.</p>')).toBe(1);
        expect(hit('<TableHead>Dots</TableHead>')).toBe(1);
        expect(hit("const text = 'Could not load the Dots.';")).toBe(1);
        expect(hit("return c.json({ error: 'Dot not found.' }, 404);", 'a.ts')).toBe(1);
        expect(hit('const x = `A ${n} Dot`;', 'a.ts')).toBe(1);
        expect(hit("const text = 'Ask a dot to do it.';", 'a.ts')).toBe(1);
        expect(hit('<p>\n  Each dot has a scratch dataset.\n</p>')).toBe(1);
        expect(hit('const computerDot = dots.find(Boolean);')).toBe(0);
        expect(hit('<DotHome dot={dot} />')).toBe(0);
        expect(hit("const dot = 'dot';", 'a.ts')).toBe(0);
        expect(hit('const dotPath = `/dots/${id}`;', 'a.ts')).toBe(0);
        expect(hit('  dot: Dot;', 'a.ts')).toBe(0);
        expect(hit('function f(dots: readonly Dot[]) {}', 'a.ts')).toBe(0);
        expect(hit("type P = Pick<Dot, 'id'>;", 'a.ts')).toBe(0);
        expect(hit("import type { Conversation, Dot } from './types';")).toBe(0);
        expect(hit('import {\n  Dot,\n  Space,\n} from "../types";', 'a.ts')).toBe(0);
        expect(hit("const s = 'x: Dot';", 'a.ts')).toBe(1);
        expect(hit("log('Dots: archived');", 'a.ts')).toBe(0);
    });

    it('ignores comments, also after code', () => {
        const hit = (code: string) => copyHits(code, 'a.ts').length;
        expect(hit('// A Dot\nconst a = 1;')).toBe(0);
        expect(hit('/** A Dot\n * and its Dots */\nconst a = 1;')).toBe(0);
        expect(hit('const a = 1; // the Dot')).toBe(0);
        expect(hit('const a = 1; /* the Dot */')).toBe(0);
        expect(hit("const a = 'http://x'; // the Dot")).toBe(0);
        expect(hit("const a = 'the Dot'; // fine")).toBe(1);
    });
});
