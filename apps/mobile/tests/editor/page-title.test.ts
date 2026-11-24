// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAGE_TITLE_MAX } from '@socio/shared/pages/page-draft';

import { bridgeExtensions } from '../../editor/bridges';
import { editorExtensions, editorProps } from '../../editor/extensions';
import { attachPageSession, receiveForEditor } from '../../editor/page-bridge';
import { PageImages } from '../../editor/page-images';
import { oneLine, PageTitle, SCROLL_CLASS, TITLE_ATTRIBUTES, TITLE_CLASS } from '../../editor/page-title';
import { PAGE_CSS } from '../../editor/styles';
import { parseToNative, type ToNativeMessage, TITLE_LABEL, TITLE_PLACEHOLDER } from '../../src/editor/bridge';

// The page's title in the editor's document (CB-417): one scroll holds the
// title and the text, as Apple Notes has it, so a long title scrolls away and
// the native bar shows it. The title travels on its own messages, never in
// the Markdown the editor writes.

const editors: Editor[] = [];
afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy());
    document.body.innerHTML = '';
});

/** The bundle's layout (editor/index.ts): the scroll, the title's textarea, then the editor. */
function setup() {
    const received: ToNativeMessage[] = [];
    const post = (message: ToNativeMessage) => {
        const parsed = parseToNative(JSON.parse(JSON.stringify(message)));
        if (parsed.kind !== 'ok') {
            throw new Error(`native refused ${JSON.stringify(message)}`);
        }
        received.push(parsed.message);
    };
    const scroller = document.createElement('div');
    scroller.className = SCROLL_CLASS;
    const field = document.createElement('textarea');
    field.className = TITLE_CLASS;
    field.setAttribute('aria-label', TITLE_ATTRIBUTES['aria-label']);
    const host = document.createElement('div');
    scroller.append(field, host);
    document.body.append(scroller);
    let editor: Editor | null = null;
    const title = new PageTitle(post, () => editor?.commands.focus('start'));
    const images = new PageImages();
    editor = new Editor({
        element: host,
        extensions: [...bridgeExtensions(), ...editorExtensions(images)],
        editorProps: editorProps(vi.fn()),
        injectCSS: false,
    });
    editors.push(editor);
    attachPageSession(editor, post, images, { title });
    title.attach(field);
    const send = (message: unknown) => receiveForEditor(editor!, JSON.parse(JSON.stringify(message)));
    const of = <T extends ToNativeMessage['type']>(type: T) =>
        received.filter((message): message is Extract<ToNativeMessage, { type: T }> => message.type === type);
    const type = (text: string) => {
        field.value = text;
        field.dispatchEvent(new Event('input'));
    };
    return { editor, field, scroller, title, send, of, type, received };
}

describe("the page editor's title in the document", () => {
    it('is a labelled one-line field with the web’s limit, above the text in the same scroll', () => {
        expect(TITLE_ATTRIBUTES).toMatchObject({
            'aria-label': TITLE_LABEL,
            placeholder: TITLE_PLACEHOLDER,
            maxLength: PAGE_TITLE_MAX,
        });
        // One scroll for both: the title scrolls away with the text, under the bar's inset.
        expect(PAGE_CSS).toMatch(/\.socio-scroll\{position:absolute;[^}]*overflow-y:auto;[^}]*flex-direction:column/);
        expect(PAGE_CSS).toContain('padding:var(--socio-inset-top,0px) 0 var(--socio-inset-bottom,0px)');
        expect(PAGE_CSS).toMatch(/\.socio-title\{[^}]*resize:none;overflow:hidden/);
        // The editor no longer scrolls by itself.
        expect(PAGE_CSS).not.toContain('.tentap-root,#root>div:nth-of-type(1){position:absolute');
    });

    it('shows the title native sends, and never sends a set back', () => {
        const { send, field, of } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Body' } });
        send({ type: 'socio-title', payload: { title: 'Borderless Context Engine' } });
        expect(field.value).toBe('Borderless Context Engine');
        expect(of('socio-title-change')).toEqual([]);
        // Not the editor's text: the Markdown stays the body's alone.
        expect(of('socio-loaded')[0]?.payload.markdown).toBe('Body');
    });

    it('sends each edit as a title change, line breaks folded to one space, never a text change', () => {
        const { send, type, of, field } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Body' } });
        send({ type: 'socio-title', payload: { title: 'Plan' } });
        type('Plans');
        type('Plans\nfor Q3');
        expect(field.value).toBe('Plans for Q3');
        expect(of('socio-title-change').map((message) => message.payload.title)).toEqual(['Plans', 'Plans for Q3']);
        expect(of('socio-change')).toEqual([]);
        expect(oneLine('a \r\n  b\n\nc')).toBe('a b c');
    });

    it('moves on to the text on Return instead of breaking the title', () => {
        const { send, field, editor } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Body' } });
        const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
        field.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(true);
        expect(editor.isFocused || editor.state.selection.from === 1).toBe(true);
    });

    it('takes the bar’s inset: CSS variables, the caret kept clear of the bar, and the title gone once under it', () => {
        const { send, field, scroller, editor, of } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Body' } });
        // jsdom lays nothing out: place the title by hand, below the bar, then scroll it under.
        vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
        const at = vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({ bottom: 200 } as DOMRect);
        send({
            type: 'socio-appearance',
            payload: { fontScale: 1, tokens: {}, insets: { top: 98, bottom: 34 } },
        });
        const root = document.documentElement.style;
        expect(root.getPropertyValue('--socio-inset-top')).toBe('98px');
        expect(root.getPropertyValue('--socio-inset-bottom')).toBe('34px');
        expect(editor.options.editorProps.scrollMargin).toEqual({ top: 114, bottom: 50, left: 0, right: 0 });
        scroller.dispatchEvent(new Event('scroll'));
        expect(of('socio-title-shown')).toEqual([]);
        at.mockReturnValue({ bottom: 90 } as DOMRect);
        scroller.dispatchEvent(new Event('scroll'));
        scroller.dispatchEvent(new Event('scroll'));
        expect(of('socio-title-shown').map((message) => message.payload.shown)).toEqual([false]);
        at.mockReturnValue({ bottom: 140 } as DOMRect);
        scroller.dispatchEvent(new Event('scroll'));
        expect(of('socio-title-shown').map((message) => message.payload.shown)).toEqual([false, true]);
    });

    it('refuses a title over the web’s limit', () => {
        const { send, received, field } = setup();
        send({ type: 'socio-title', payload: { title: 'x'.repeat(PAGE_TITLE_MAX + 1) } });
        expect(field.value).toBe('');
        expect(received.at(-1)).toEqual({ type: 'socio-refused', payload: { type: 'socio-title' } });
    });
});
