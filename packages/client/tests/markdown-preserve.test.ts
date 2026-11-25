// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it } from 'vitest';

import {
    documentExtensions,
    inspectMarkdown,
    markdownManager,
    preservedMarkdown,
} from '../src/modules/pages/editor/markdown';

// What an edit writes back (`preservedMarkdown`, RichEditor's and the app's
// save): the source's own bytes for every top-level block the person didn't
// change, the serializer's text only for the blocks they did.

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

/** The web's editor on `source`, mounted as RichEditor's is (its plugins append their transactions). */
function open(source: string) {
    const editor = new Editor({
        element: document.createElement('div'),
        extensions: [...documentExtensions(), Markdown],
        content: source,
        contentType: 'markdown',
    });
    editors.push(editor);
    // The first transaction, as a click makes: the trailing paragraph goes in.
    editor.view.dispatch(editor.state.tr);
    return editor;
}

/** Replaces the first `find` in the document's text, as typing over it would. */
function replaceText(editor: Editor, find: string, replacement: string) {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
        if (at >= 0) {
            return false;
        }
        const index = node.isText ? node.text!.indexOf(find) : -1;
        if (index >= 0) {
            at = pos + index;
        }
        return true;
    });
    expect(at, find).toBeGreaterThanOrEqual(0);
    editor.view.dispatch(editor.state.tr.insertText(replacement, at, at + find.length));
}

/** The top-level block holding `find`: its start and end in the document. */
function blockRange(editor: Editor, find: string) {
    let range: { from: number; to: number } | null = null;
    editor.state.doc.forEach((node, offset) => {
        if (!range && node.textContent.includes(find)) {
            range = { from: offset, to: offset + node.nodeSize };
        }
    });
    expect(range, find).not.toBeNull();
    return range!;
}

const PAGE = [
    'Title',
    '=====',
    '',
    'Intro with __bold__, <https://example.com>, a \\<tag\\> and AT&amp;T.',
    '',
    'A line with a break\\',
    'here and another  ',
    'there.',
    '',
    '***',
    '',
    '| a | b |',
    '|-|-|',
    '| 1 | 2 |',
    '',
    '* star item',
    '* another',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '> text',
    '',
    '~~~',
    'const tilde = "<kept>";',
    '~~~',
    '',
    '- [ ] task',
    '- [x] done',
    '',
    'Subtitle',
    '--------',
    '',
    'Last paragraph.',
    '',
].join('\n');

describe('preservedMarkdown', () => {
    it('opens the corpus page in the rich editor and writes it back unchanged when nothing is edited', () => {
        expect(inspectMarkdown(PAGE)).toEqual({ supported: true });
        const editor = open(PAGE);
        // The editor's trailing paragraph is in the document, and writes nothing.
        expect(editor.state.doc.lastChild!.type.name).toBe('paragraph');
        expect(preservedMarkdown(editor, PAGE)).toBe(PAGE);
        // What the serializer alone would write: everything restyled.
        expect(editor.getMarkdown()).not.toBe(PAGE);
    });

    it('changes only the edited paragraph’s bytes', () => {
        const editor = open(PAGE);
        replaceText(editor, 'there.', 'there!');
        expect(preservedMarkdown(editor, PAGE)).toBe(
            PAGE.replace(
                'A line with a break\\\nhere and another  \nthere.',
                'A line with a break\\\nhere and another\\\nthere!',
            ),
        );
    });

    it('writes an edited block the serializer’s way, and only that block', () => {
        const editor = open(PAGE);
        replaceText(editor, 'Intro', 'Opening');
        expect(preservedMarkdown(editor, PAGE)).toBe(
            PAGE.replace(
                'Intro with __bold__, <https://example.com>, a \\<tag\\> and AT&amp;T.',
                'Opening with **bold**, [https://example.com](https://example.com), a \\<tag> and AT&T.',
            ),
        );
    });

    it.each([
        ['a setext heading', 'Title', 'Heading', 'Title\n=====', '# Heading'],
        ['a table', '2', '3', '| a | b |\n|-|-|\n| 1 | 2 |', '| a   | b   |\n| --- | --- |\n| 1   | 3   |'],
        ['a list', 'star', 'starred', '* star item\n* another', '- starred item\n- another'],
        ['an ordered list', 'second', 'two', '1. first\n2. second', '1. first\n2. two'],
        ['a task list', 'task', 'chore', '- [ ] task\n- [x] done', '- [ ] chore\n- [x] done'],
        ['a quote', 'quoted', 'said', '> quoted\n> text', '> said\n> text'],
        ['a code block', 'tilde', 'fence', '~~~\nconst tilde = "<kept>";\n~~~', '```\nconst fence = "<kept>";\n```'],
        ['the last paragraph', 'Last', 'Final', 'Last paragraph.', 'Final paragraph.'],
    ])('an edit in %s leaves every other byte as it was', (_name, find, replacement, before, after) => {
        const editor = open(PAGE);
        replaceText(editor, find, replacement);
        expect(PAGE).toContain(before);
        expect(preservedMarkdown(editor, PAGE)).toBe(PAGE.replace(before, after));
    });

    it('keeps the source’s rules, autolinks and escapes outside the edit', () => {
        const source = '***\n\nSee <https://example.com> \\<b\\>\n\n___\n\nEdit me\n';
        const editor = open(source);
        replaceText(editor, 'Edit me', 'Edited');
        expect(preservedMarkdown(editor, source)).toBe('***\n\nSee <https://example.com> \\<b\\>\n\n___\n\nEdited\n');
    });

    it('keeps CRLF line endings and writes new text with them', () => {
        const source = PAGE.replace(/\n/g, '\r\n');
        const editor = open(source);
        replaceText(editor, 'there.', 'there!');
        expect(preservedMarkdown(editor, source)).toBe(
            PAGE.replace(
                'A line with a break\\\nhere and another  \nthere.',
                'A line with a break\\\nhere and another\\\nthere!',
            ).replace(/\n/g, '\r\n'),
        );
        const { to } = blockRange(editor, 'Last paragraph.');
        editor.view.dispatch(
            editor.state.tr.insert(to, editor.schema.nodes.paragraph!.create(null, editor.schema.text('New'))),
        );
        expect(preservedMarkdown(editor, source)).toMatch(/Last paragraph\.\r\n\r\nNew\r\n$/);
    });

    it('keeps the trailing newline, or its absence', () => {
        for (const source of ['One\n\nTwo\n', 'One\n\nTwo', 'One\n\nTwo\n\n\n']) {
            const editor = open(source);
            replaceText(editor, 'One', 'First');
            expect(preservedMarkdown(editor, source)).toBe(source.replace('One', 'First'));
        }
    });

    it('edits at the start and the end of the document', () => {
        const editor = open(PAGE);
        replaceText(editor, 'Title', 'Top');
        replaceText(editor, 'Last', 'End');
        expect(preservedMarkdown(editor, PAGE)).toBe(
            PAGE.replace('Title\n=====', '# Top').replace('Last paragraph.', 'End paragraph.'),
        );
    });

    it('types into the editor’s trailing paragraph: the new block goes after the last one', () => {
        const source = '# Notes\n\n***\n';
        const editor = open(source);
        editor.chain().focus('end').insertContent('After').run();
        expect(preservedMarkdown(editor, source)).toBe('# Notes\n\n***\n\nAfter\n');
    });

    it('inserts a block between untouched ones', () => {
        const editor = open(PAGE);
        const { to } = blockRange(editor, 'there.');
        editor.view.dispatch(
            editor.state.tr.insert(to, editor.schema.nodes.paragraph!.create(null, editor.schema.text('Inserted'))),
        );
        expect(preservedMarkdown(editor, PAGE)).toBe(PAGE.replace('there.\n\n***', 'there.\n\nInserted\n\n***'));
    });

    it('inserts a block at the start', () => {
        const editor = open(PAGE);
        editor.view.dispatch(
            editor.state.tr.insert(0, editor.schema.nodes.paragraph!.create(null, editor.schema.text('First'))),
        );
        expect(preservedMarkdown(editor, PAGE)).toBe(`First\n\n${PAGE}`);
    });

    it.each([
        ['in the middle', '***', PAGE.replace('***\n\n', '')],
        ['at the start', 'Title', PAGE.replace('Title\n=====\n\n', '')],
        ['at the end', 'Last paragraph.', PAGE.replace('\n\nLast paragraph.', '')],
    ])('deletes a block %s and keeps the rest', (_name, find, expected) => {
        const editor = open(PAGE);
        let range = { from: 0, to: 0 };
        if (find === '***') {
            editor.state.doc.forEach((node, offset) => {
                if (node.type.name === 'horizontalRule') {
                    range = { from: offset, to: offset + node.nodeSize };
                }
            });
        } else {
            range = blockRange(editor, find);
        }
        editor.view.dispatch(editor.state.tr.delete(range.from, range.to));
        expect(preservedMarkdown(editor, PAGE)).toBe(expected);
    });

    it('moves a block: only the moved block is written again', () => {
        const source = 'One\n\nTwo\n\nThree\n';
        const editor = open(source);
        const { from, to } = blockRange(editor, 'One');
        const node = editor.state.doc.nodeAt(from)!;
        const end = blockRange(editor, 'Three').to;
        editor.view.dispatch(editor.state.tr.insert(end, node).delete(from, to));
        expect(preservedMarkdown(editor, source)).toBe('Two\n\nThree\n\nOne\n');
    });

    it('gives the source back exactly after an edit is undone', () => {
        const editor = open(PAGE);
        replaceText(editor, 'quoted', 'said');
        expect(preservedMarkdown(editor, PAGE)).not.toBe(PAGE);
        editor.commands.undo();
        expect(preservedMarkdown(editor, PAGE)).toBe(PAGE);
    });

    it('keeps the source’s blank lines, and the empty paragraphs they read as', () => {
        const source = 'One\n\n\n\nTwo\n\nThree';
        const editor = open(source);
        expect(editor.state.doc.childCount).toBe(4);
        replaceText(editor, 'Three', '3');
        expect(preservedMarkdown(editor, source)).toBe('One\n\n\n\nTwo\n\n3');
        // Typing in the empty paragraph.
        const { to } = blockRange(editor, 'One');
        editor.view.dispatch(editor.state.tr.insertText('Between', to + 1));
        expect(preservedMarkdown(editor, source)).toBe('One\n\nBetween\n\nTwo\n\n3');
    });

    it('whatever the edit, the text reads back as the document, and untouched blocks keep their bytes', () => {
        const blocks = markdownManager.instance.lexer(PAGE).filter((token) => token.type !== 'space');
        for (const block of blocks) {
            const editor = open(PAGE);
            const text = block.raw.match(/[A-Za-z]{3,}/)?.[0];
            if (!text) {
                continue;
            }
            replaceText(editor, text, `${text}x`);
            const saved = preservedMarkdown(editor, PAGE);
            expect(
                editor.schema.nodeFromJSON(markdownManager.parse(saved)).eq(editor.state.doc),
                `${text}: ${saved}`,
            ).toBe(true);
            // Only the edited block's bytes differ: the same prefix and suffix around it.
            const at = PAGE.indexOf(block.raw.trimEnd());
            expect(saved.startsWith(PAGE.slice(0, at)), text).toBe(true);
            expect(saved.endsWith(PAGE.slice(at + block.raw.trimEnd().length)), text).toBe(true);
        }
    });

    it('falls back to the serializer when the source can’t be read block by block', () => {
        const editor = open('One\n\nTwo');
        replaceText(editor, 'One', 'First');
        // A source that isn't this document: nothing of it is kept.
        expect(preservedMarkdown(editor, 'Unrelated <div>\n\n![x](y)')).toBe('First\n\nTwo');
    });
});

describe('the serializer’s writing of edited blocks', () => {
    const write = (source: string) => markdownManager.serialize(markdownManager.parse(source));

    it('writes a hard break as a backslash and a newline', () => {
        expect(write('a  \nb')).toBe('a\\\nb');
        expect(write('a\\\n\\\nb')).toBe('a\\\n\\\nb');
        // A list item's next line is a lazy continuation, as the library writes it.
        expect(write('- item\\\n  more')).toBe('- item\\\nmore');
        expect(write('> quote\\\n> more')).toBe('> quote\\\n> more');
        // A table cell's renderer turns its newlines into <br>: no backslash there.
        const cell = (type: string, content: object[]) => ({ type, content: [{ type: 'paragraph', content }] });
        const table = {
            type: 'doc',
            content: [
                {
                    type: 'table',
                    content: [
                        { type: 'tableRow', content: [cell('tableHeader', [{ type: 'text', text: 'a' }])] },
                        {
                            type: 'tableRow',
                            content: [
                                cell('tableCell', [
                                    { type: 'text', text: 'b' },
                                    { type: 'hardBreak' },
                                    { type: 'text', text: 'c' },
                                ]),
                            ],
                        },
                    ],
                },
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'x' }, { type: 'hardBreak' }, { type: 'text', text: 'y' }],
                },
            ],
        };
        const written = markdownManager.serialize(table);
        expect(written).toContain('| b<br>c |');
        expect(written).toContain('x\\\ny');
    });

    it('escapes < and > with a backslash, and & only where it would start an entity', () => {
        expect(write('a \\<b\\> c')).toBe('a \\<b> c');
        expect(write('a &lt;b&gt; c')).toBe('a \\<b> c');
        expect(write('\\> not a quote')).toBe('\\> not a quote');
        // Right after a bare URL (GFM reads it as a link), a backslash would join the link: entities there.
        const text = (value: string) => ({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
        });
        expect(markdownManager.serialize(text('See https://example.com> or me@example.com<'))).toBe(
            'See https://example.com&gt; or me@example.com&lt;',
        );
        expect(write('AT&T & co')).toBe('AT&T & co');
        expect(write('&amp;lt; is written &amp;amp;lt;')).toBe('&amp;lt; is written &amp;amp;lt;');
        expect(write('`<code> & &lt;`')).toBe('`<code> & &lt;`');
    });

    it.each([
        'a <b> c',
        'line one\n> two\n  > three',
        '<b>not bold</b> <br> <!-- not a comment -->',
        '> not a quote',
        'x &lt; y &gt; z &amp; w &#38; &#x26; &copy; &nbsp; & ;',
        'tags: <div>, </p>, <!-- -->',
        'back\\slash \\< \\\\< *star* _under_ [bracket] ~tilde~',
        '5 > 3 and 2 < 4',
        '<',
        '>',
        '&',
    ])('round-trips text exactly: %s', (text) => {
        const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
        const written = markdownManager.serialize(doc);
        expect(markdownManager.parse(written)).toEqual(doc);
    });

    it('round-trips hard breaks in paragraphs, lists and quotes', () => {
        for (const source of ['a\\\nb', 'a\\\n\\\nb', '- a\\\n  b', '> a\\\n> b']) {
            const doc = markdownManager.parse(source);
            expect(JSON.stringify(doc)).toContain('hardBreak');
            expect(markdownManager.parse(markdownManager.serialize(doc)), source).toEqual(doc);
            expect(inspectMarkdown(source), source).toEqual({ supported: true });
        }
    });
});
