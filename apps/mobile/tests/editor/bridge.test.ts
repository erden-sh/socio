// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pageImageMarkdown } from '@socio/shared/page-image';

import { bridgeExtensions } from '../../editor/bridges';
import { editorExtensions, editorProps, REFUSED_PASTE_NOTICE } from '../../editor/extensions';
import { attachPageSession, minimalReplace, PASTE_TOO_LARGE_NOTICE, receiveForEditor } from '../../editor/page-bridge';
import { PageImages } from '../../editor/page-images';
import { editorAppearance, EDITOR_TOKENS } from '../../src/editor/appearance';
import {
    CHANGE_THROTTLE_MS,
    PASTE_IMAGE_MAX_BYTES,
    parseToNative,
    parseToWeb,
    type ToNativeMessage,
    toWeb,
    type ToWebMessage,
} from '../../src/editor/bridge';
import { colorsOf } from '../../src/theme/theme';

// The page editor's bridge under jsdom: the WebView's session on a
// real TipTap editor, driven through tentap's message path with every message
// going through JSON and the native side's checks, as on a phone.

const editors: Editor[] = [];
afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy());
    vi.useRealTimers();
});

/** A fake clock and timers the session reads, so throttling runs without waiting. */
function clock() {
    let now = 1_000;
    let timers: { at: number; run: () => void; id: number }[] = [];
    let ids = 0;
    return {
        now: () => now,
        setTimer: (run: () => void, ms: number) => {
            ids += 1;
            timers.push({ at: now + ms, run, id: ids });
            return ids;
        },
        clearTimer: (id: unknown) => {
            timers = timers.filter((timer) => timer.id !== id);
        },
        advance(ms: number) {
            now += ms;
            const due = timers.filter((timer) => timer.at <= now);
            timers = timers.filter((timer) => timer.at > now);
            due.forEach((timer) => timer.run());
        },
    };
}

function setup({ composing = (): boolean => false } = {}) {
    const images = new PageImages();
    const refused = vi.fn<(notice: string) => void>();
    const editor = new Editor({
        extensions: [...bridgeExtensions(), ...editorExtensions(images)],
        editorProps: editorProps(refused),
        injectCSS: false,
    });
    editors.push(editor);
    const time = clock();
    const received: ToNativeMessage[] = [];
    const session = attachPageSession(
        editor,
        (message) => {
            // Over the wire as JSON, then the native side's check.
            const parsed = parseToNative(JSON.parse(JSON.stringify(message)));
            if (parsed.kind !== 'ok') {
                throw new Error(`native refused ${JSON.stringify(message)}`);
            }
            received.push(parsed.message);
        },
        images,
        { isComposing: composing, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer },
    );
    const send = (message: ToWebMessage | Record<string, unknown>) =>
        receiveForEditor(editor, JSON.parse(JSON.stringify(message)));
    const of = <T extends ToNativeMessage['type']>(type: T) =>
        received.filter((message): message is Extract<ToNativeMessage, { type: T }> => message.type === type);
    const typeAt = (pos: number, text: string) => editor.chain().insertContentAt(pos, text).run();
    return { editor, session, images, received, send, of, time, typeAt, refused };
}

describe("the page editor's bridge", () => {
    it('opens a page with no change, and reads it back', () => {
        const { send, of } = setup();
        send({ type: 'socio-load', payload: { markdown: '# Notes\n\nFirst line.' } });
        expect(of('socio-loaded')).toEqual([
            {
                type: 'socio-loaded',
                payload: { markdown: '# Notes\n\nFirst line.', version: 1, supported: true, reason: null },
            },
        ]);
        expect(of('socio-change')).toEqual([]);
        expect(of('socio-state').at(-1)?.payload).toMatchObject({ unsent: false, canUndo: false, heading: 0 });
    });

    it('sends own edits at most every 400 ms, the latest text at the end of the window', () => {
        const { send, of, time, typeAt, editor } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Hello' } });
        typeAt(6, ' a');
        expect(of('socio-change').map((m) => m.payload)).toEqual([{ markdown: 'Hello a', version: 2 }]);
        typeAt(8, 'b');
        typeAt(9, 'c');
        time.advance(CHANGE_THROTTLE_MS - 1);
        expect(of('socio-change')).toHaveLength(1);
        time.advance(1);
        expect(of('socio-change').map((m) => m.payload)).toEqual([
            { markdown: 'Hello a', version: 2 },
            { markdown: 'Hello abc', version: 4 },
        ]);
        time.advance(CHANGE_THROTTLE_MS * 3);
        expect(of('socio-change')).toHaveLength(2);
        // A selection move is no change.
        editor.commands.setTextSelection(1);
        time.advance(CHANGE_THROTTLE_MS);
        expect(of('socio-change')).toHaveLength(2);
    });

    it('posts the toolbar state only when it changes, not on every keystroke, and says when an edit is unsent', () => {
        const { send, of, time, typeAt } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Hello' } });
        typeAt(6, ' a');
        const states = () => of('socio-state').map((m) => m.payload);
        expect(states().at(-1)).toMatchObject({ unsent: false, canUndo: true });
        const before = states().length;
        // Within the throttle: the first keystroke marks the edit unsent, the rest change nothing the toolbar shows.
        typeAt(8, 'b');
        typeAt(9, 'c');
        typeAt(10, 'd');
        typeAt(11, 'e');
        expect(states().slice(before)).toEqual([expect.objectContaining({ unsent: true })]);
        time.advance(CHANGE_THROTTLE_MS);
        expect(of('socio-change').at(-1)?.payload.markdown).toBe('Hello abcde');
        expect(states().slice(before)).toEqual([
            expect.objectContaining({ unsent: true }),
            expect.objectContaining({ unsent: false }),
        ]);
        expect(states().every((state) => !('version' in state))).toBe(true);
    });

    it('flushes the latest edit at once', () => {
        const { send, of, typeAt } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Hello' } });
        typeAt(6, '!');
        typeAt(7, '?');
        send({ type: 'socio-flush' });
        expect(of('socio-change').map((m) => m.payload.markdown)).toEqual(['Hello!', 'Hello!?']);
        send({ type: 'socio-flush' });
        expect(of('socio-change')).toHaveLength(2);
    });

    it('a load cancels an edit not yet sent', () => {
        const { send, of, typeAt, time } = setup();
        send({ type: 'socio-load', payload: { markdown: 'One' } });
        typeAt(4, ' a');
        typeAt(6, 'b');
        send({ type: 'socio-load', payload: { markdown: 'Two' } });
        time.advance(CHANGE_THROTTLE_MS * 2);
        expect(of('socio-change').map((m) => m.payload.markdown)).toEqual(['One a']);
        expect(of('socio-loaded').at(-1)?.payload).toEqual({
            markdown: 'Two',
            version: 4,
            supported: true,
            reason: null,
        });
    });

    it("says when the rich editor can't keep a page, in the web's words (inspectMarkdown)", () => {
        const { send, of } = setup();
        send({ type: 'socio-load', payload: { markdown: '---\ntitle: x\n---\n\nBody' } });
        expect(of('socio-loaded')[0]?.payload).toMatchObject({
            supported: false,
            reason: 'This document contains extended Markdown. Source mode preserves it exactly.',
        });
        send({ type: 'socio-load', payload: { markdown: '#### Deep heading' } });
        expect(of('socio-loaded')[1]?.payload.supported).toBe(false);
        expect(of('socio-change')).toEqual([]);
    });

    it("a load starts an empty undo and redo history: the last page's edits never come back", () => {
        const { send, of, editor, typeAt, time } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Page A.' } });
        editor.commands.selectAll();
        editor.commands.deleteSelection();
        typeAt(1, 'Gone.');
        send({ type: 'socio-command', payload: { name: 'undo' } });
        expect(of('socio-state').at(-1)?.payload).toMatchObject({ canRedo: true });
        send({ type: 'socio-flush' });
        const changes = of('socio-change').length;

        send({ type: 'socio-load', payload: { markdown: 'Page B.' } });
        expect(of('socio-state').at(-1)?.payload).toMatchObject({ canUndo: false, canRedo: false });
        send({ type: 'socio-command', payload: { name: 'undo' } });
        send({ type: 'socio-command', payload: { name: 'redo' } });
        time.advance(CHANGE_THROTTLE_MS * 2);
        expect(editor.getMarkdown()).toBe('Page B.');
        expect(of('socio-change')).toHaveLength(changes);
    });

    it('puts a merge in place with no change, keeping the selection and the undo history', () => {
        const { send, of, editor, typeAt, time } = setup();
        send({ type: 'socio-load', payload: { markdown: 'First line.\n\nSecond line.' } });
        // The person types at the end of the first paragraph, and the cursor stays there.
        typeAt(12, ' Mine.');
        send({ type: 'socio-flush' });
        const { version } = of('socio-change').at(-1)!.payload;
        expect(editor.state.selection.from).toBe(18);
        // Someone else added a paragraph at the top and changed the last line.
        const merged = 'From elsewhere.\n\nFirst line. Mine.\n\nSecond line, edited.';
        send({ type: 'socio-replace', payload: { markdown: merged, ifVersion: version } });
        expect(of('socio-replaced')).toEqual([
            {
                type: 'socio-replaced',
                payload: { ifVersion: version, applied: true, markdown: merged, version: version + 1 },
            },
        ]);
        time.advance(CHANGE_THROTTLE_MS * 2);
        expect(of('socio-change')).toHaveLength(1);
        // The cursor moved with its text: still after "Mine.".
        const { from } = editor.state.selection;
        expect(editor.state.doc.textBetween(from - 5, from)).toBe('Mine.');
        // Undo takes back the person's own typing, not the merge.
        editor.commands.undo();
        expect(editor.getMarkdown()).toBe('From elsewhere.\n\nFirst line.\n\nSecond line, edited.');
        expect(of('socio-change').at(-1)?.payload.markdown).toBe(
            'From elsewhere.\n\nFirst line.\n\nSecond line, edited.',
        );
    });

    it('changes only the range that differs', () => {
        const { send, editor } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Alpha.\n\nBeta.\n\nGamma.' } });
        const before = editor.state.doc;
        const next = editor.schema.nodeFromJSON(editor.markdown!.parse('Alpha.\n\nBeta, more.\n\nGamma.'));
        const tr = minimalReplace(editor, next)!;
        expect(tr.steps).toHaveLength(1);
        const step = tr.steps[0]!.getMap();
        let range: number[] = [];
        step.forEach((oldStart, oldEnd) => (range = [oldStart, oldEnd]));
        // Inside "Beta.", never the paragraphs around it.
        expect(before.textBetween(range[0]!, range[1]!)).toBe('');
        expect(range[0]).toBeGreaterThan(8);
        expect(range[1]).toBeLessThan(15);
        expect(minimalReplace(editor, before)).toBeNull();
    });

    it('takes each changed run of blocks on its own', () => {
        const { send, editor } = setup();
        send({ type: 'socio-load', payload: { markdown: 'One.\n\nTwo.\n\nThree.\n\nFour.' } });
        const next = editor.schema.nodeFromJSON(
            editor.markdown!.parse('Zero.\n\nOne.\n\nTwo.\n\nThree!\n\nFour.\n\nFive.'),
        );
        const tr = minimalReplace(editor, next)!;
        expect(tr.steps).toHaveLength(3);
        expect(tr.doc.eq(next)).toBe(true);
    });

    it('applies the same document a load would', () => {
        const { send, of } = setup();
        const markdown = '| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] Open';
        send({ type: 'socio-load', payload: { markdown: 'Start.' } });
        send({ type: 'socio-replace', payload: { markdown, ifVersion: 1 } });
        send({ type: 'socio-load', payload: { markdown } });
        expect(of('socio-replaced')[0]?.payload.markdown).toBe(of('socio-loaded')[1]?.payload.markdown);
    });

    it('refuses a merge made from an older version, answering with the text now', () => {
        const { send, of, typeAt } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Hello' } });
        typeAt(6, ' there');
        send({ type: 'socio-replace', payload: { markdown: 'Hello from elsewhere', ifVersion: 1 } });
        expect(of('socio-replaced').map((m) => m.payload)).toEqual([
            { ifVersion: 1, applied: false, markdown: 'Hello there', version: 2 },
        ]);
    });

    it('drops a replace held for compositionend when the editor goes, and clears its timer', () => {
        let composing = true;
        const { send, of, editor, time, session } = setup({ composing: () => composing });
        send({ type: 'socio-load', payload: { markdown: 'One' } });
        send({ type: 'socio-replace', payload: { markdown: 'One theirs', ifVersion: 1 } });
        expect(of('socio-replaced')).toEqual([]);
        composing = false;
        editor.view.dom.dispatchEvent(new Event('compositionend'));
        session.dispose();
        time.advance(1_000);
        expect(of('socio-replaced')).toEqual([]);
        // A flush after it answers nothing held either.
        send({ type: 'socio-flush' });
        expect(of('socio-replaced')).toEqual([]);
        expect(editor.getMarkdown()).toBe('One');
    });

    it('waits while an input method composes, then applies', () => {
        let composing = true;
        const { send, of, editor, time } = setup({ composing: () => composing });
        send({ type: 'socio-load', payload: { markdown: 'Hello' } });
        send({ type: 'socio-replace', payload: { markdown: 'Hello, merged', ifVersion: 1 } });
        expect(of('socio-replaced')).toEqual([]);
        expect(editor.getMarkdown()).toBe('Hello');
        // Still composing at the first compositionend's check: waits on.
        editor.view.dom.dispatchEvent(new Event('compositionend'));
        time.advance(100);
        expect(of('socio-replaced')).toEqual([]);
        composing = false;
        editor.view.dom.dispatchEvent(new Event('compositionend'));
        time.advance(100);
        expect(of('socio-replaced').map((m) => m.payload.applied)).toEqual([true]);
        expect(editor.getMarkdown()).toBe('Hello, merged');
    });

    it('answers a merge waiting for the input method at once on flush, with the text now', () => {
        const { send, of, editor, time } = setup({ composing: () => true });
        send({ type: 'socio-load', payload: { markdown: 'Hello' } });
        send({ type: 'socio-replace', payload: { markdown: 'Hello, merged', ifVersion: 1 } });
        send({ type: 'socio-flush' });
        expect(of('socio-replaced').map((m) => m.payload)).toEqual([
            { ifVersion: 1, applied: false, markdown: 'Hello', version: 1 },
        ]);
        expect(editor.getMarkdown()).toBe('Hello');
        editor.view.dom.dispatchEvent(new Event('compositionend'));
        time.advance(100);
        expect(of('socio-replaced')).toHaveLength(1);
    });

    it('a newer merge supersedes one waiting for the input method', () => {
        let composing = true;
        const { send, of, editor, time } = setup({ composing: () => composing });
        send({ type: 'socio-load', payload: { markdown: 'Hello' } });
        send({ type: 'socio-replace', payload: { markdown: 'Hello, one', ifVersion: 1 } });
        send({ type: 'socio-replace', payload: { markdown: 'Hello, two', ifVersion: 1 } });
        composing = false;
        editor.view.dom.dispatchEvent(new Event('compositionend'));
        time.advance(100);
        expect(of('socio-replaced').map((m) => [m.payload.applied, m.payload.markdown])).toEqual([
            [false, 'Hello'],
            [true, 'Hello, two'],
        ]);
    });

    it('runs toolbar commands and reports the state', () => {
        const { send, of, editor } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Some words' } });
        editor.commands.setTextSelection({ from: 1, to: 5 });
        send({ type: 'socio-command', payload: { name: 'bold' } });
        expect(editor.getMarkdown()).toBe('**Some** words');
        expect(of('socio-state').at(-1)?.payload).toMatchObject({ active: ['bold'], canUndo: true });
        send({ type: 'socio-command', payload: { name: 'heading2' } });
        expect(of('socio-state').at(-1)?.payload.heading).toBe(2);
        send({ type: 'socio-command', payload: { name: 'undo' } });
        send({ type: 'socio-command', payload: { name: 'undo' } });
        expect(editor.getMarkdown()).toBe('Some words');
        expect(of('socio-state').at(-1)?.payload).toMatchObject({ canUndo: false, canRedo: true });
    });

    it('links and unlinks the selection, with the web’s rule', () => {
        const { send, of, editor, received } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Read the plan' } });
        editor.commands.setTextSelection({ from: 10, to: 14 });
        send({ type: 'socio-link', payload: { href: '/#/spaces/s1/pages/p1' } });
        expect(editor.getMarkdown()).toBe('Read the [plan](/#/spaces/s1/pages/p1)');
        expect(of('socio-state').at(-1)?.payload).toMatchObject({ active: ['link'], link: '/#/spaces/s1/pages/p1' });
        send({ type: 'socio-link', payload: { href: null } });
        expect(editor.getMarkdown()).toBe('Read the plan');
        const before = received.length;
        send({ type: 'socio-link', payload: { href: 'javascript:alert(1)' } });
        expect(received.slice(before)).toEqual([{ type: 'socio-refused', payload: { type: 'socio-link' } }]);
        expect(editor.getMarkdown()).toBe('Read the plan');
    });

    it('refuses bad messages and leaves tentap’s alone', () => {
        const { send, of, editor } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Kept' } });
        const bad = [
            { type: 'socio-load', payload: { markdown: 3 } },
            { type: 'socio-load', payload: { markdown: 'x', extra: true } },
            { type: 'socio-replace', payload: { markdown: 'x', ifVersion: -1 } },
            { type: 'socio-command', payload: { name: 'deleteEverything' } },
            { type: 'socio-appearance', payload: { fontScale: 1, tokens: { foreground: 'red;background:url(x)' } } },
            { type: 'socio-images', payload: { cbemb_0123456789abcdef: 'https://example.com/x.png' } },
            { type: 'socio-nothing' },
        ];
        for (const message of bad) {
            expect(send(message), JSON.stringify(message)).toBe(true);
        }
        expect(of('socio-refused').map((m) => m.payload.type)).toEqual(bad.map((message) => message.type));
        expect(editor.getMarkdown()).toBe('Kept');
        expect(send({ type: 'set-content', payload: 'tentap' })).toBe(false);
        expect(of('socio-refused')).toHaveLength(bad.length);
        // The native side's check refuses what the WebView mustn't send, and makes nothing it can't.
        expect(parseToNative({ type: 'socio-change', payload: { markdown: 'x' } }).kind).toBe('refused');
        expect(parseToNative({ type: 'editor-ready' }).kind).toBe('other');
        expect(() => toWeb({ type: 'socio-replace', payload: { markdown: 'x', ifVersion: 1.5 } })).toThrow();
        expect(parseToWeb(toWeb({ type: 'socio-flush' })).kind).toBe('ok');
    });

    it('applies the appearance as CSS variables, background untouched', () => {
        const { send } = setup();
        const appearance = editorAppearance('dark', 1.35);
        send({ type: 'socio-appearance', payload: appearance });
        const root = document.documentElement.style;
        expect(root.getPropertyValue('--socio-font-scale')).toBe('1.35');
        for (const token of EDITOR_TOKENS) {
            expect(root.getPropertyValue(`--color-${token}`)).toBe(colorsOf('dark')[token]);
        }
        expect(root.background).toBe('');
        send({ type: 'socio-appearance', payload: editorAppearance('light', 9) });
        expect(root.getPropertyValue('--socio-font-scale')).toBe('5');
        expect(root.getPropertyValue('--color-foreground')).toBe(colorsOf('light').foreground);
    });

    it("draws an image block's picture once native sends it", () => {
        const { send, editor, of } = setup();
        const id = 'cbemb_fedcba9876543210';
        const fence = pageImageMarkdown({ id, alt: 'A diagram' });
        send({ type: 'socio-load', payload: { markdown: fence } });
        const block = () => editor.view.dom.querySelector('[data-page-image]')!;
        expect(block().querySelector('img')).toBeNull();
        expect(block().textContent).toBe('A diagram');
        const uri = 'data:image/png;base64,iVBORw0KGgo=';
        send({ type: 'socio-images', payload: { [id]: uri } });
        expect(block().querySelector('img')?.getAttribute('src')).toBe(uri);
        expect(block().querySelector('img')?.getAttribute('alt')).toBe('A diagram');
        // The picture is drawing only: the page still writes its fence.
        expect(editor.getMarkdown()).toBe(of('socio-loaded')[0]?.payload.markdown);
        expect(editor.getMarkdown().trim()).toBe(fence);
    });

    it("puts a pasted picture's block at the cursor as an own edit, drawn and undoable", () => {
        const { send, editor, of, images } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Before\n\nAfter' } });
        // The cursor at the end of "Before".
        editor.commands.setTextSelection(7);
        const id = 'cbemb_0123456789abcdef';
        const uri = 'data:image/png;base64,iVBORw0KGgo=';
        send({ type: 'socio-images', payload: { [id]: uri } });
        send({ type: 'socio-insert-image', payload: { id, width: 1600, height: 1200 } });
        const fence = pageImageMarkdown({ id, width: 1600, height: 1200 });
        const change = of('socio-change').at(-1)?.payload;
        expect(change?.markdown).toBe(`Before\n\n${fence}\n\nAfter`);
        expect(change?.version).toBe(2);
        expect(images.get(id)).toBe(uri);
        expect(editor.view.dom.querySelector('[data-page-image] img')?.getAttribute('src')).toBe(uri);
        expect(of('socio-state').at(-1)?.payload.canUndo).toBe(true);
        editor.commands.undo();
        expect(editor.getMarkdown()).toBe('Before\n\nAfter');
        // A block that isn't a picture is refused, and nothing goes in.
        send({ type: 'socio-insert-image', payload: { id: 'not-an-embed' } });
        expect(of('socio-refused').map((m) => m.payload.type)).toEqual(['socio-insert-image']);
    });

    it('hands a pasted picture to native and tells of a refused paste', async () => {
        const { session, received, editor } = setup();
        const sent = vi.fn<(file: File) => void>((file) => session.pasteImage(file));
        const props = editorProps((notice) => session.notice(notice), sent);
        const paste = (files: File[], html = '') =>
            props.handlePaste(editor.view, {
                clipboardData: { files, getData: (type: string) => (type === 'text/html' ? html : '') },
                preventDefault: vi.fn(),
            } as unknown as ClipboardEvent);
        const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
        expect(paste([png], '<img src="x">')).toBe(true);
        await vi.waitFor(() => expect(received.some((m) => m.type === 'socio-paste-image')).toBe(true));
        expect(received.find((m) => m.type === 'socio-paste-image')?.payload).toEqual({
            mimeType: 'image/png',
            dataUri: 'data:image/png;base64,iVBORw==',
        });
        const huge = new File([], 'huge.png', { type: 'image/png' });
        Object.defineProperty(huge, 'size', { value: PASTE_IMAGE_MAX_BYTES + 1 });
        expect(paste([huge])).toBe(true);
        // A paste with no picture file falls to the web's rule.
        expect(paste([], '<p><img src="https://example.com/x.png"></p>')).toBe(true);
        expect(received.filter((m) => m.type === 'socio-notice').map((m) => m.payload.text)).toEqual([
            PASTE_TOO_LARGE_NOTICE,
            REFUSED_PASTE_NOTICE,
        ]);
        expect(paste([new File(['x'], 'a.txt', { type: 'text/plain' })])).toBe(false);
    });

    it('stops with the editor', () => {
        const { send, of, typeAt, time, editor } = setup();
        send({ type: 'socio-load', payload: { markdown: 'Hello' } });
        typeAt(6, '1');
        typeAt(7, '2');
        editor.destroy();
        time.advance(CHANGE_THROTTLE_MS);
        expect(of('socio-change')).toHaveLength(1);
        expect(receiveForEditor(editor, { type: 'socio-flush' })).toBe(false);
    });
});
