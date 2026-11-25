// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATASET_VIEW_LANG, viewSpecBody } from '@socio/shared/dataset-view';
import { embedCardMarkdown } from '@socio/shared/embed-card';
import { pageImageMarkdown } from '@socio/shared/page-image';

import { bridgeExtensions } from '../../editor/bridges';
import {
    EDITOR_ATTRIBUTES,
    editorExtensions,
    editorProps,
    loadMarkdown,
    pageEditorOptions,
    REFUSED_PASTE_NOTICE,
} from '../../editor/extensions';
import { PageImages } from '../../editor/page-images';

// The page editor's TipTap inside the WebView, under jsdom: the web's
// path in (simpleHtmlToMarkdown, setContent as Markdown) and out
// (getMarkdown()), an edit and its undo, the atoms' fences, the ARIA and the
// paste rule. The round trip compares whole corpora with the web.

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function makeEditor() {
    const refused = vi.fn<(notice: string) => void>();
    const onUpdate = vi.fn();
    const editor = new Editor({
        extensions: [...bridgeExtensions(), ...editorExtensions()],
        editorProps: editorProps(refused),
        injectCSS: false,
        onUpdate,
    });
    editors.push(editor);
    return { editor, refused, onUpdate };
}

const load = loadMarkdown;

const card = {
    url: 'https://example.com/post/1',
    kind: 'post',
    provider: 'Example',
    author: 'Some One',
    handle: '@someone',
    text: 'Text with ``` fences` and "quotes"',
    media: [{ id: 'cbemb_0123456789abcdef', kind: 'image', alt: 'A chart' }],
    fetchedAt: '2026-10-27T12:00:00.000Z',
};

describe("the page editor's TipTap", () => {
    it('loads Markdown the web’s way, reads it back, and sends no update', () => {
        const { editor, onUpdate } = makeEditor();
        const markdown = '# Notes\n\nA **bold**, *italic* and `code` line.\n\n- [ ] Open\n- [x] Done';
        // The page's own text: opening rewrites nothing, not even the editor's trailing paragraph.
        expect(load(editor, markdown)).toBe(markdown);
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('reads simple HTML as its Markdown, as the web does, and keeps it as written until it is edited', () => {
        const { editor } = makeEditor();
        const html = '<p>Hello <strong>there</strong></p>';
        expect(load(editor, html)).toBe(html);
        expect(editor.getMarkdown()).toBe('Hello **there**');
    });

    it('writes back each atom’s exact fence', () => {
        const { editor } = makeEditor();
        const fences = [
            '## Blocks',
            embedCardMarkdown(card as never),
            `\`\`\`${DATASET_VIEW_LANG}\n${viewSpecBody({ datasetId: 'ds_1', query: 'select 1', display: 'table' })}\n\`\`\``,
            pageImageMarkdown({ id: 'cbemb_fedcba9876543210', alt: 'A diagram', width: 640, height: 480 }),
            'After the blocks.',
        ].join('\n\n');
        expect(load(editor, fences)).toBe(fences);
        const types = editor.getJSON().content?.map((node) => node.type);
        expect(types).toEqual(['heading', 'embedCard', 'datasetView', 'pageImage', 'paragraph']);
    });

    it('takes an edit, reads it back, and undoes it', () => {
        const { editor, onUpdate } = makeEditor();
        const loaded = load(editor, 'First line.');
        editor.commands.insertContentAt(editor.state.doc.content.size, {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Typed on the phone.' }],
        });
        expect(editor.getMarkdown()).toBe('First line.\n\nTyped on the phone.');
        expect(onUpdate).toHaveBeenCalledTimes(1);
        editor.commands.undo();
        expect(editor.getMarkdown()).toBe(loaded);
        // Opening isn't an edit: Undo stops at the page as it opened.
        editor.commands.undo();
        expect(editor.getMarkdown()).toBe(loaded);
    });

    it('starts each loaded page with an empty undo and redo history', () => {
        const { editor } = makeEditor();
        load(editor, 'Page A.');
        // Edits on A, and one of them undone, so both stacks hold something.
        editor.commands.selectAll();
        editor.commands.deleteSelection();
        editor.view.dispatch(closeHistory(editor.state.tr));
        editor.commands.insertContent('Typed on A.');
        editor.commands.undo();
        expect(editor.can().undo()).toBe(true);
        expect(editor.can().redo()).toBe(true);

        const loaded = load(editor, 'Page B.');
        expect(loaded).toBe('Page B.');
        expect(editor.can().undo()).toBe(false);
        expect(editor.can().redo()).toBe(false);
        expect(editor.commands.undo()).toBe(false);
        expect(editor.getMarkdown()).toBe(loaded);
        expect(editor.commands.redo()).toBe(false);
        expect(editor.getMarkdown()).toBe(loaded);

        // B's own edits still undo, back to B as it opened.
        editor.commands.insertContentAt(editor.state.doc.content.size, {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Typed on B.' }],
        });
        editor.commands.undo();
        expect(editor.getMarkdown()).toBe(loaded);
    });

    it("carries the web's ARIA", () => {
        const { editor } = makeEditor();
        for (const [name, value] of Object.entries(EDITOR_ATTRIBUTES)) {
            expect(editor.view.dom.getAttribute(name)).toBe(value);
        }
    });

    it('refuses pasted HTML with a picture, a frame or a script, and takes the rest', () => {
        const { editor, refused } = makeEditor();
        load(editor, 'Before.');
        const paste = (html: string) => {
            const event = {
                clipboardData: { getData: (type: string) => (type === 'text/html' ? html : '') },
                preventDefault: vi.fn(),
            };
            const handled = editor.view.someProp('handlePaste', (handle) =>
                handle(editor.view, event as unknown as ClipboardEvent, editor.state.doc.slice(0)),
            );
            return { handled: handled === true, prevented: event.preventDefault.mock.calls.length > 0 };
        };
        for (const html of ['<p>a<img src="x.png"></p>', '<IFRAME src="x">', '<div><script>1</script></div>']) {
            expect(paste(html), html).toEqual({ handled: true, prevented: true });
        }
        expect(refused).toHaveBeenCalledTimes(3);
        expect(refused).toHaveBeenCalledWith(REFUSED_PASTE_NOTICE);
        expect(paste('<p><strong>Bold</strong> and <a href="https://example.com">a link</a></p>')).toEqual({
            handled: false,
            prevented: false,
        });
        expect(paste('')).toEqual({ handled: false, prevented: false });
        expect(refused).toHaveBeenCalledTimes(3);
    });

    it("adds nothing of tentap's to the schema", () => {
        expect(bridgeExtensions()).toEqual([]);
    });

    it("never reads tentap's initialContent: the page comes only through socio-load", () => {
        // As tentap's useTenTap builds it: the boot config's content first, then the bundle's options over it.
        const options = pageEditorOptions({
            images: new PageImages(),
            onNotice: () => {},
            onPasteImage: () => {},
            onCreate: () => {},
        });
        const boot = {
            content: '<p>Injected <a href="https://example.com">link</a></p><img src="https://example.com/x.png">',
            editable: true,
        };
        const editor = new Editor({
            ...boot,
            ...options,
            extensions: [...bridgeExtensions(), ...options.extensions],
        });
        editors.push(editor);
        expect(editor.getMarkdown()).toBe('');
        expect(editor.getHTML()).not.toContain('Injected');
        expect(options.injectCSS).toBe(false);
    });
});
