// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pageImageMarkdown } from '@socio/shared/page-image';

import { bridgeExtensions } from '../../editor/bridges';
import { editorExtensions, editorProps } from '../../editor/extensions';
import { attachPageSession, receiveForEditor } from '../../editor/page-bridge';
import { PageImages, pictureUnavailable } from '../../editor/page-images';
import { parseToNative, parseToWeb, type ToNativeMessage, type ToWebMessage } from '../../src/editor/bridge';
import { EDITOR_CSP } from '../../src/editor/generated/editor-html';
import type { EditorPicture } from '../../src/editor/pictures';
import { createEditorSession } from '../../src/editor/session';
import type { EditorDraft, EditorText, PageEditorDraft } from '../../src/sync/page-drafts';

// A page's own pictures in the editor, end to end under jsdom: the native
// session (src/editor/session.ts) and the WebView's (editor/page-bridge.ts) on
// a real TipTap editor, every message through JSON and the other side's check.
// The WebView asks for the ids it lacks after the load, native answers from a
// fake image cache one picture at a time, and the blocks draw them; none of it
// is a change, a draft write or an undo step.

const A = 'cbemb_aaaaaaaaaaaaaaaa';
const B = 'cbemb_bbbbbbbbbbbbbbbb';
const C = 'cbemb_cccccccccccccccc';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';

const editors: Editor[] = [];
afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy());
    vi.useRealTimers();
});

function fakeDraft(start: EditorDraft) {
    let latest = start;
    const changes: EditorText[] = [];
    const listeners = new Set<(text: EditorText) => void>();
    let flushes = 0;
    const draft: PageEditorDraft = {
        read: () => latest,
        error: () => undefined,
        change(text) {
            latest = { ...latest, ...text };
            changes.push(text);
        },
        flush: async () => {
            flushes += 1;
        },
        close: async () => {},
        onReplace(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const land = (text: EditorText) => {
        latest = { ...latest, ...text, revision: latest.revision + 1 };
        listeners.forEach((listener) => listener(text));
    };
    return { draft, changes, land, flushes: () => flushes };
}

function setup(content: string, cache: Map<string, string>) {
    const fake = fakeDraft({ spaceId: 's1', revision: 3, title: 'Plans', content });
    const asked: string[] = [];
    const source = vi.fn(async (id: string): Promise<EditorPicture> => {
        asked.push(id);
        const dataUri = cache.get(id);
        return dataUri === undefined ? { kind: 'unavailable' } : { kind: 'ready', dataUri };
    });
    const toWebLog: ToWebMessage[] = [];
    const toNativeLog: ToNativeMessage[] = [];

    const images = new PageImages();
    const editor = new Editor({
        extensions: [...bridgeExtensions(), ...editorExtensions(images)],
        editorProps: editorProps(() => {}),
        injectCSS: false,
    });
    editors.push(editor);

    const native = createEditorSession({
        draft: fake.draft,
        appearance: { fontScale: 1, tokens: { foreground: '#000000' } },
        pictures: source,
        onError: (error) => {
            throw error;
        },
    });
    attachPageSession(
        editor,
        (message) => {
            const wire = JSON.parse(JSON.stringify(message)) as unknown;
            const parsed = parseToNative(wire);
            if (parsed.kind !== 'ok') {
                throw new Error(`native refused ${JSON.stringify(message)}`);
            }
            toNativeLog.push(parsed.message);
            native.receive(wire);
        },
        images,
    );
    native.connect((message) => {
        const wire = JSON.parse(JSON.stringify(message)) as unknown;
        const parsed = parseToWeb(wire);
        if (parsed.kind !== 'ok') {
            throw new Error(`the WebView refused ${JSON.stringify(message)}`);
        }
        toWebLog.push(parsed.message);
        receiveForEditor(editor, wire);
    });
    const blocks = () => [...editor.view.dom.querySelectorAll<HTMLElement>('[data-page-image]')];
    const of = <T extends ToNativeMessage['type']>(type: T) =>
        toNativeLog.filter((message): message is Extract<ToNativeMessage, { type: T }> => message.type === type);
    const sentToWeb = <T extends ToWebMessage['type']>(type: T) =>
        toWebLog.filter((message): message is Extract<ToWebMessage, { type: T }> => message.type === type);
    return { fake, native, editor, images, source, asked, blocks, of, sentToWeb, toNativeLog };
}

const page = `Plans\n\n${pageImageMarkdown({ id: A, alt: 'A diagram', width: 1600, height: 1200 })}\n\nMiddle\n\n${pageImageMarkdown({ id: B })}`;

describe("a page's own pictures in the editor", () => {
    it('loads the page, asks for its pictures, gets each from the cache and draws them', async () => {
        const { native, editor, blocks, of, sentToWeb, asked, fake, toNativeLog } = setup(
            page,
            new Map([
                [A, PNG],
                [B, JPEG],
            ]),
        );
        native.ready();
        // Loaded first, then asked: native ignores what comes before `loaded`.
        const types = toNativeLog.map((message) => message.type);
        expect(types.indexOf('socio-loaded')).toBeGreaterThanOrEqual(0);
        expect(types.indexOf('socio-loaded')).toBeLessThan(types.indexOf('socio-images-wanted'));
        expect(of('socio-images-wanted')).toEqual([{ type: 'socio-images-wanted', payload: { ids: [A, B] } }]);
        expect(blocks().map((block) => block.textContent)).toEqual(['A diagram', 'Image']);
        await vi.waitFor(() => expect(blocks().every((block) => block.querySelector('img') !== null)).toBe(true));
        expect(blocks().map((block) => block.querySelector('img')!.getAttribute('src'))).toEqual([PNG, JPEG]);
        // One picture a message, in order.
        expect(sentToWeb('socio-images').map((message) => Object.keys(message.payload))).toEqual([[A], [B]]);
        expect(asked).toEqual([A, B]);
        // Drawing is no edit: no change, no draft write, nothing to undo, the same Markdown.
        expect(of('socio-change')).toEqual([]);
        expect(fake.changes).toEqual([]);
        expect(fake.flushes()).toBe(0);
        expect(native.view().editing).toBe(false);
        expect(of('socio-state').at(-1)?.payload).toMatchObject({ unsent: false, canUndo: false });
        expect(editor.can().undo()).toBe(false);
        expect(editor.getMarkdown()).toBe(of('socio-loaded')[0]?.payload.markdown);
    });

    it('keeps a clear placeholder offline with none kept, and draws it once back online', async () => {
        const cache = new Map<string, string>();
        const { native, blocks, sentToWeb, of, fake } = setup(page, cache);
        native.ready();
        await vi.waitFor(() => expect(sentToWeb('socio-images-unavailable')).toHaveLength(2));
        expect(blocks().map((block) => block.textContent)).toEqual([
            pictureUnavailable('A diagram'),
            pictureUnavailable(''),
        ]);
        expect(blocks().every((block) => block.hasAttribute('data-unavailable'))).toBe(true);
        expect(blocks().some((block) => block.querySelector('img') !== null)).toBe(false);
        cache.set(A, PNG);
        native.retryPictures();
        await vi.waitFor(() => expect(blocks()[0]!.querySelector('img')?.getAttribute('src')).toBe(PNG));
        expect(blocks()[0]!.hasAttribute('data-unavailable')).toBe(false);
        expect(blocks()[1]!.textContent).toBe(pictureUnavailable(''));
        expect(of('socio-change')).toEqual([]);
        expect(fake.changes).toEqual([]);
    });

    it('asks only for an id that appears, as a merge brings it', async () => {
        const { native, fake, of, asked, blocks } = setup(
            page,
            new Map([
                [A, PNG],
                [B, JPEG],
                [C, PNG],
            ]),
        );
        native.ready();
        await vi.waitFor(() => expect(asked).toEqual([A, B]));
        // A change made elsewhere lands with a third picture.
        fake.land({ title: 'Plans', content: `${page}\n\n${pageImageMarkdown({ id: C, alt: 'New' })}` });
        expect(of('socio-replaced').at(-1)?.payload.applied).toBe(true);
        expect(of('socio-images-wanted').map((message) => message.payload.ids)).toEqual([[A, B], [C]]);
        await vi.waitFor(() => expect(blocks()[2]?.querySelector('img')?.getAttribute('src')).toBe(PNG));
        expect(asked).toEqual([A, B, C]);
        expect(of('socio-change')).toEqual([]);
    });

    it('asks a new WebView again, and gets nothing from the network inside it', async () => {
        const { native, asked, source } = setup(page, new Map([[A, PNG]]));
        native.ready();
        await vi.waitFor(() => expect(asked).toEqual([A, B]));
        // The WebView again (tentap's ready after a reload): its load asks for every picture it doesn't
        // hold (here the same document still holds A), and native, started afresh, gets B again.
        native.lost();
        native.ready();
        await vi.waitFor(() => expect(asked).toEqual([A, B, B]));
        expect(source).toHaveBeenCalledTimes(3);
        // The WebView's policy still lets no request leave.
        expect(EDITOR_CSP).toContain("default-src 'none'");
        expect(EDITOR_CSP).toContain('img-src data:');
        expect(EDITOR_CSP).not.toMatch(/connect-src|img-src[^;]*(https?:|\*)/);
    });
});
