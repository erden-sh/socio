import { Editor } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';

import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import {
    documentExtensions,
    inspectMarkdown,
    preservedMarkdown,
} from '../../../../packages/client/src/modules/pages/editor/markdown';
import { CORPUS_EDIT_TEXT } from '../../src/editor/corpus';

// The web's page editor, as RichEditor.tsx runs it: the web's document
// extensions with
// `@tiptap/markdown` and its placeholder, the stored page read as Markdown
// through `simpleHtmlToMarkdown`, and `preservedMarkdown` back (RichEditor's
// `onUpdate`: the source's own text for every block not edited). Left out: the
// atoms' React views and the slash menu, which draw and suggest but never
// change what is written. Used under jsdom by tests/editor/roundtrip.test.ts
// and, built by Vite, in Playwright's browsers by scripts/roundtrip-browsers.mts.
//
// A page `inspectMarkdown` refuses opens in Markdown source on the web
// (PageDocument's `sourceMode`): RichEditor never mounts, and the source keeps
// the stored text byte for byte. So does this path: the rich editor never runs
// on it, and the answer is the stored text with the verdict. Running it anyway
// would test what no one sees, and some such pages make it throw (a paragraph
// holding only `![…](…)` leaves a bare text node under the doc).

export interface WebAnswer {
    /**
     * The stored text, unchanged, for a page `inspectMarkdown` refuses (source mode). Otherwise
     * `preservedMarkdown` once the editor that opened on the page (RichEditor's `content`) has had its
     * first transaction, a click's: plugins append theirs only then (StarterKit's trailing
     * paragraph after a last block that isn't one, which writes `\n\n`).
     */
    readonly markdown: string;
    /** `preservedMarkdown` after the web's later load (RichEditor's `setContent(…, { contentType: 'markdown' })`). */
    readonly reloaded: string;
    readonly supported: boolean;
    readonly reason: string | null;
    /** After CORPUS_EDIT_TEXT is typed at the end (CoreBridge's Focus 'end', then InsertContent). */
    readonly edited: string;
    /** After that edit's undo. */
    readonly undone: string;
    /** Updates the editor sent while opening, before any transaction: always 0 on the web. */
    readonly openUpdates: number;
}

/**
 * Opens a stored page as the web does: in source mode when `inspectMarkdown` refuses it,
 * else in the rich editor, read back, edited and undone.
 */
export function webRoundTrip(stored: string, element?: HTMLElement): WebAnswer {
    const verdict = inspectMarkdown(stored);
    if (!verdict.supported) {
        // Source mode: the textarea holds the stored text; nothing opens, reads back or edits it.
        return {
            markdown: stored,
            reloaded: stored,
            supported: false,
            reason: verdict.reason ?? null,
            edited: stored,
            undone: stored,
            openUpdates: 0,
        };
    }
    return richRoundTrip(stored, element);
}

/**
 * RichEditor's path on a stored page, whatever `inspectMarkdown` says: what `webRoundTrip`
 * runs on a page the web opens rich. Exported so tests can show why a refused page must not
 * get here (it throws, or drops what the rich editor has no node for).
 */
export function richRoundTrip(stored: string, element?: HTMLElement): WebAnswer {
    let updates = 0;
    const source = simpleHtmlToMarkdown(stored);
    const editor = new Editor({
        // A mounted editor, as the web's: an unmounted one skips the plugins' appended transactions.
        element: element ?? document.createElement('div'),
        extensions: [
            ...documentExtensions(),
            Markdown,
            Placeholder.configure({ placeholder: 'Start writing, or type / for blocks…' }),
        ],
        content: source,
        contentType: 'markdown',
        onUpdate: () => {
            updates += 1;
        },
    });
    try {
        // Nothing sent while the page opens; the first transaction may (the web saves its trailing paragraph).
        const openUpdates = updates;
        editor.view.dispatch(editor.state.tr);
        const markdown = preservedMarkdown(editor, source);
        editor.commands.setContent(source, { contentType: 'markdown', emitUpdate: false });
        const reloaded = preservedMarkdown(editor, source);
        editor.commands.focus('end');
        editor.chain().focus().insertContent(CORPUS_EDIT_TEXT, { parseOptions: editor.options.parseOptions }).run();
        const edited = preservedMarkdown(editor, source);
        editor.commands.undo();
        const undone = preservedMarkdown(editor, source);
        return {
            markdown,
            reloaded,
            supported: true,
            reason: null,
            edited,
            undone,
            openUpdates,
        };
    } finally {
        editor.destroy();
    }
}

/**
 * Errors the web path is known to throw, matched whole, each with a kind of our
 * own: ProseMirror's when a parse leaves a node whose content its schema refuses
 * and a later step (the trailing-node plugin's insert) meets it. The live run
 * first met it on image-only paragraphs, which now open in source mode (above);
 * the catch stays for anything else.
 */
const KNOWN_WEB_FAILURES: readonly (readonly [RegExp, string])[] = [
    [/^Called contentMatchAt on a node with invalid content$/, 'invalid-content'],
];

/**
 * Why the rich editor threw on a page, in words that can't hold its text: a
 * known message's kind, else a plain error name, else "unknown". Never the
 * message itself, which may quote the page. The round-trip test (Node) and the
 * browsers' run (web-path-browser.ts) both record a throw this way and go on.
 */
export function webFailureKind(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    const known = KNOWN_WEB_FAILURES.find(([pattern]) => pattern.test(message));
    if (known) {
        return known[1];
    }
    return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
}
