import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { pageImageMarkdown } from '@socio/shared/page-image';

import RichEditor from '../src/modules/pages/editor/RichEditor';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    // ProseMirror measures; jsdom has no layout.
    Range.prototype.getClientRects = () =>
        ({
            length: 0,
            item: () => null,
            [Symbol.iterator]: [][Symbol.iterator],
        }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    document.elementFromPoint = () => null;
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.restoreAllMocks();
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const editor = async (value: string, onNotice: (message: string) => void = () => {}) => {
    const onChange = vi.fn();
    root = createRoot(host);
    await act(async () => root!.render(<RichEditor value={value} onChange={onChange} onNotice={onNotice} />));
    await flush();
    await flush();
    return onChange;
};

it('shows a picture from this app by its embed id, and a note when it can’t load (CB-358)', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const onChange = await editor(
        `Before.\n\n${pageImageMarkdown({ id: 'cbemb_0123456789abcdef', alt: 'The whiteboard', width: 1600, height: 1200 })}\n\nAfter.`,
    );
    const figure = host.querySelector('figure.page-image')!;
    expect(figure).not.toBeNull();
    expect(figure.getAttribute('contenteditable')).toBe('false');
    const image = figure.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/api/media/embeds/cbemb_0123456789abcdef/content');
    expect([image.getAttribute('alt'), image.getAttribute('width'), image.getAttribute('height')]).toEqual([
        'The whiteboard',
        '1600',
        '1200',
    ]);
    // The block's text is no code: no fence JSON shows.
    expect(host.querySelector('pre code')).toBeNull();
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(host.querySelector('.page-image img')).toBeNull();
    expect(host.querySelector('.page-image')!.textContent).toBe('Image not available here: The whiteboard');
    expect(fetch).not.toHaveBeenCalled();
    // Opening it changes nothing in the page.
    expect(onChange).not.toHaveBeenCalled();
});

it('shows a fence that isn’t a picture as code, unchanged (CB-358)', async () => {
    const onChange = await editor('```image\n{ "id": "https://evil.example/x.png" }\n```');
    expect(host.querySelector('.page-image, img')).toBeNull();
    expect(host.querySelector('pre code')?.textContent).toBe('{ "id": "https://evil.example/x.png" }');
    expect(onChange).not.toHaveBeenCalled();
});

const paste = (view: Editor['view'], html: string, text: string) => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const data = { 'text/html': html, 'text/plain': text } as Record<string, string>;
    Object.defineProperty(event, 'clipboardData', {
        value: { getData: (type: string) => data[type] ?? '', types: Object.keys(data), files: [], items: [] },
    });
    view.dom.dispatchEvent(event);
};
const pictures = (view: Editor['view']) => {
    const found: Record<string, unknown>[] = [];
    view.state.doc.descendants((node) => {
        if (node.type.name === 'pageImage') {
            found.push(node.attrs);
        }
    });
    return found;
};

it.each([
    { id: 'cbemb_0123456789abcdef', alt: 'A `quoted` board', width: 1600, height: 1200 },
    // Alts and ids that look like numbers, booleans or null stay strings.
    { id: 'cbemb_0123456789abcdef', alt: '2026', width: null, height: null },
    { id: 'cbemb_0123456789abcdef', alt: 'true', width: 10, height: null },
    { id: 'cbemb_0123456789abcdef', alt: 'false', width: null, height: null },
    { id: 'cbemb_0123456789abcdef', alt: 'null', width: null, height: null },
    { id: '1234567890123456', alt: '42', width: null, height: 7 },
])('cuts a picture and pastes it back whole, without the images notice (CB-358): $alt', async (attrs) => {
    const notices: string[] = [];
    const picture = Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== null)) as {
        id: string;
    };
    const onChange = await editor(`Before.\n\n${pageImageMarkdown(picture)}\n\nAfter.`, (m) => notices.push(m));
    const view = (host.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor.view;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'pageImage') {
            at = pos;
        }
    });
    await act(async () => view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at))));
    const { dom, text } = view.serializeForClipboard(view.state.selection.content());
    expect(dom.innerHTML).not.toMatch(/<img\b/i);
    // The cut.
    await act(async () => view.dispatch(view.state.tr.deleteSelection()));
    expect(pictures(view)).toEqual([]);
    await act(async () => paste(view, dom.innerHTML, text));
    expect(notices).toEqual([]);
    expect(pictures(view)).toEqual([attrs]);
    expect(onChange.mock.calls.at(-1)?.[0]).toContain(pageImageMarkdown(picture));
});

it('still refuses an outside <img> paste (CB-358)', async () => {
    const notices: string[] = [];
    await editor('Text.', (m) => notices.push(m));
    const view = (host.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor.view;
    await act(async () =>
        paste(view, '<img data-page-image="cbemb_0123456789abcdef" src="https://x.example/a.png">', ''),
    );
    expect(notices).toHaveLength(1);
    expect(pictures(view)).toEqual([]);
});
