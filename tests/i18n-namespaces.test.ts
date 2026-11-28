import { describe, expect, it } from 'vitest';

import { namespaceEntryProblems, namespaceTextProblem } from '../scripts/lib/i18n-namespaces.mjs';

// scripts/lib/i18n-namespaces.mjs: the rules the translation app's import holds a namespace's
// label and where to. One entry that breaks them gets the whole import refused, so i18n-build
// and the import builder both use these (docs/I18N.md).
describe("namespaces.json's rules", () => {
    it('takes plain prose, a lone & or <, and counts code points, not UTF-16 units', () => {
        for (const text of [
            'Chat · Message box',
            'Search & filters',
            'Shown when fewer than 5 < 6 items remain',
            'Tom & Jerry; then more',
            'A heart: ❤ and an arrow ->',
        ]) {
            expect(namespaceTextProblem('label', text), text).toBeNull();
        }
        // 80 emoji are 160 UTF-16 units but 80 code points.
        expect(namespaceTextProblem('label', '😀'.repeat(80))).toBeNull();
        expect(namespaceTextProblem('label', '😀'.repeat(81))).toBe('is 81 characters, over the 80 limit');
        expect(namespaceTextProblem('where', 'é'.repeat(300))).toBeNull();
        expect(namespaceTextProblem('where', 'é'.repeat(301))).toBe('is 301 characters, over the 300 limit');
    });

    it('refuses control characters, line breaks and bidi overrides and isolates', () => {
        for (const text of ['Two\nlines', 'A\rB', 'A\tB', 'A\u0000B', 'A\u007fB', 'A\u0085B', 'A\u2028B', 'A\u2029B']) {
            expect(namespaceTextProblem('where', text), JSON.stringify(text)).toMatch(/single line/);
        }
        for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
            expect(namespaceTextProblem('label', `Chat ${String.fromCodePoint(code)}box`), code.toString(16)).toBe(
                'has a bidi override or isolate character',
            );
        }
    });

    it('refuses HTML-like tags and entities', () => {
        for (const text of ['The <b>header</b>', 'A </a> end', 'A <br/> break', 'A <!-- note -->', 'A < img src=x>']) {
            expect(namespaceTextProblem('where', text), text).toBe("has an HTML-like tag; it's plain text");
        }
        for (const text of ['Search &amp; filters', 'A &#38; B', 'A &#x26; B', 'A &nbsp;B']) {
            expect(namespaceTextProblem('where', text), text).toMatch(/has an HTML entity/);
        }
    });

    it('refuses empty text, placeholders and edge spaces, and an absent field only when required', () => {
        expect(namespaceTextProblem('label', '')).toBe('needs text (a non-empty string)');
        expect(namespaceTextProblem('label', '  ')).toBe('needs text (a non-empty string)');
        expect(namespaceTextProblem('label', 42)).toBe('needs text (a non-empty string)');
        expect(namespaceTextProblem('label', undefined)).toBe('needs text (a non-empty string)');
        expect(namespaceTextProblem('label', undefined, { required: false })).toBeNull();
        expect(namespaceTextProblem('label', 'Hi {{name}}')).toMatch(/placeholder/);
        expect(namespaceTextProblem('label', ' Chat')).toBe('starts or ends with spaces');
    });

    it('checks every entry, its shape and its fields', () => {
        expect(namespaceEntryProblems({ chat: { label: 'Chat · Box', where: 'At the bottom.' } })).toEqual([]);
        expect(namespaceEntryProblems([])).toEqual(['must be an object of namespace → { label, where }']);
        expect(
            namespaceEntryProblems({
                chat: 'Chat',
                shell: { label: 'Shell', where: 'The <i>top</i>.', screenshot: 'x' },
            }),
        ).toEqual([
            'chat must be an object with a label and a where',
            'shell has an unknown field screenshot (only label and where)',
            "shell.where has an HTML-like tag; it's plain text",
        ]);
    });
});
