// The WebView's half of the page editor's bridge. The messages and
// their checks are src/editor/bridge.ts's, shared with the native side.
//
// - `socio-load` opens a page the web's way (extensions.ts's `loadMarkdown`): no
//   `change`, nothing to undo. `socio-loaded` says whether the rich editor
//   can keep it (the web's `inspectMarkdown`), else native edits the source.
// - Own edits go out as `socio-change`, at most every CHANGE_THROTTLE_MS: the
//   first at once, the rest at the end of the window with the latest text.
// - `socio-replace` puts a merge in place as one minimal transaction (the
//   changed range from `findDiffStart`/`findDiffEnd`), so the selection maps
//   through it and the person's undo history stays theirs (the merge isn't in
//   it). It waits while an input method composes, and applies only while the
//   document is still at `ifVersion`. `socio-flush` answers one still waiting
//   at once (not applied, with the text now): leaving can't wait for it.
// - Toolbar commands, links, the appearance and the page's pictures: after each
//   load, and whenever an `image` block's id appears, the ids whose pictures it
//   doesn't hold go to native (`socio-images-wanted`), which answers from its
//   image cache. Drawing a picture is never a transaction: no change, no undo.
// - A pasted picture goes to native as `socio-paste-image`; once native
//   has uploaded it, `socio-insert-image` puts its `image` block at the
//   selection as the person's own edit.
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

import type { PageImage } from '@socio/shared/page-image';
import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import {
    changedRuns,
    inspectMarkdown,
    preservedMarkdown,
} from '../../../packages/client/src/modules/pages/editor/markdown';
import {
    ACTIVE_NAMES,
    CHANGE_THROTTLE_MS,
    type EditorAppearance,
    IMAGES_WANTED_MAX,
    type EditorCommand,
    type EditorState,
    PASTE_IMAGE_MAX_BYTES,
    parseToWeb,
    type ToNativeMessage,
    type ToWebMessage,
} from '../src/editor/bridge';

import { BRIDGE_META, loadMarkdown } from './extensions';
import { PageImages } from './page-images';

/** What the page shows when a pasted picture is over PASTE_IMAGE_MAX_BYTES. */
export const PASTE_TOO_LARGE_NOTICE = 'This image is too large to paste.';

/** The reason when the web's check gives none. */
const SOURCE_MODE_REASON = 'This document needs source mode.';

/** After `compositionend`, ProseMirror finishes the composition's own transaction; wait for it. */
const AFTER_COMPOSITION_MS = 50;

/** The document's title field (page-title.ts): set from native, and the bar's inset over the document. */
export interface TitleField {
    set(title: string): void;
    setInsetTop(top: number): void;
}

export interface PageSessionOptions {
    /** The title at the top of the document (CB-417); none in the tests that drive only the text. */
    title?: TitleField;
    /** Defaults to the editor's own (`view.composing`). */
    isComposing?: () => boolean;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
}

type Post = (message: ToNativeMessage) => void;

const COMMANDS: Record<EditorCommand, (editor: Editor) => boolean> = {
    bold: (editor) => editor.chain().focus().toggleBold().run(),
    italic: (editor) => editor.chain().focus().toggleItalic().run(),
    strike: (editor) => editor.chain().focus().toggleStrike().run(),
    code: (editor) => editor.chain().focus().toggleCode().run(),
    paragraph: (editor) => editor.chain().focus().setParagraph().run(),
    heading1: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    heading2: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    heading3: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    bulletList: (editor) => editor.chain().focus().toggleBulletList().run(),
    orderedList: (editor) => editor.chain().focus().toggleOrderedList().run(),
    taskList: (editor) => editor.chain().focus().toggleTaskList().run(),
    blockquote: (editor) => editor.chain().focus().toggleBlockquote().run(),
    codeBlock: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    undo: (editor) => editor.chain().focus().undo().run(),
    redo: (editor) => editor.chain().focus().redo().run(),
};

// The block diff is the web's (markdown.ts), shared with `preservedMarkdown`.
export { changedRuns };

/** Where each top-level child starts, and the end. */
const childStarts = (node: ProseMirrorNode) => {
    const starts = [0];
    node.forEach((child) => starts.push(starts.at(-1)! + child.nodeSize));
    return starts;
};

/**
 * Applies `next` over the editor's document as the smallest replaces that
 * make them equal: one per run of changed top-level blocks, each narrowed by
 * `findDiffStart`/`findDiffEnd`. ProseMirror maps the selection through them,
 * so a cursor in a block the merge didn't touch stays where it was; with
 * `addToHistory` false, the history rebases the person's own steps over them
 * instead of recording them. Falls back to replacing the whole content when
 * a step can't fit the structure (the result is checked either way). Null
 * when the documents are equal.
 */
export function minimalReplace(editor: Editor, next: ProseMirrorNode): Transaction | null {
    const { doc, tr } = editor.state;
    const runs = changedRuns(doc, next);
    if (runs.length === 0) {
        return null;
    }
    const startsA = childStarts(doc);
    const startsB = childStarts(next);
    // From the last run back, so the earlier runs' positions hold.
    for (const run of [...runs].reverse()) {
        const fromA = startsA[run.aFrom]!;
        const fromB = startsB[run.bFrom]!;
        const oldPart = doc.content.cut(fromA, startsA[run.aTo]!);
        const newPart = next.content.cut(fromB, startsB[run.bTo]!);
        const start = oldPart.findDiffStart(newPart) ?? 0;
        let { a: endA, b: endB } = oldPart.findDiffEnd(newPart) ?? { a: oldPart.size, b: newPart.size };
        // When the change repeats what's around it, the two ends can cross.
        const overlap = start - Math.min(endA, endB);
        if (overlap > 0) {
            endA += overlap;
            endB += overlap;
        }
        tr.replace(fromA + start, fromA + endA, next.slice(fromB + start, fromB + endB));
    }
    if (!tr.doc.eq(next)) {
        const whole = editor.state.tr;
        whole.replaceWith(0, doc.content.size, next.content);
        return whole;
    }
    return tr;
}

/**
 * The editor's state for the toolbar, and whether an own edit isn't sent yet
 * (`unsent`, so leaving waits for it). No version: it would make every
 * keystroke a new state; this one changes only with what the toolbar shows.
 */
export function toolbarState(editor: Editor, unsent: boolean): EditorState {
    const heading = ([1, 2, 3] as const).find((level) => editor.isActive('heading', { level })) ?? 0;
    const link = editor.getAttributes('link').href;
    return {
        unsent,
        canUndo: editor.can().undo(),
        canRedo: editor.can().redo(),
        heading,
        active: ACTIVE_NAMES.filter((name) => editor.isActive(name)),
        link: editor.isActive('link') && typeof link === 'string' ? link : null,
    };
}

/** Puts the type size and colors on the page as CSS variables (the CSSOM: no stylesheet the CSP would refuse). */
export function applyAppearance(root: HTMLElement, appearance: EditorAppearance) {
    root.style.setProperty('--socio-font-scale', String(appearance.fontScale));
    if (appearance.insets) {
        root.style.setProperty('--socio-inset-top', `${appearance.insets.top}px`);
        root.style.setProperty('--socio-inset-bottom', `${appearance.insets.bottom}px`);
    }
    for (const [name, color] of Object.entries(appearance.tokens)) {
        root.style.setProperty(`--color-${name}`, color);
    }
}

/** The ids of the document's `image` blocks, in order, once each. */
export function pageImageIds(doc: ProseMirrorNode): string[] {
    const ids = new Set<string>();
    doc.descendants((node) => {
        if (node.type.name === 'pageImage') {
            if (typeof node.attrs.id === 'string') {
                ids.add(node.attrs.id);
            }
            return false;
        }
        // A block of text holds no picture.
        return !node.isTextblock;
    });
    return [...ids];
}

/** One editor's end of the bridge. */
export class PageSession {
    /** The document's version: each own edit, load and applied replace moves it on. */
    private version = 0;
    /** The version native last got the text of. */
    private sentVersion = 0;
    private lastSentAt = Number.NEGATIVE_INFINITY;
    private changeTimer: unknown = null;
    private pendingReplace: Extract<ToWebMessage, { type: 'socio-replace' }>['payload'] | null = null;
    private lastState = '';
    /** The pictures asked for since this WebView started: an edit asks only for new ones. */
    private readonly asked = new Set<string>();
    /** The wait after `compositionend` before a held replace goes in; cleared on dispose. */
    private compositionTimer: unknown = null;
    private disposed = false;
    private readonly isComposing: () => boolean;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (timer: unknown) => void;
    private readonly cleanup: (() => void)[] = [];
    private readonly title: TitleField | null;
    /** The Markdown last loaded or merged in: what an edit keeps of it, untouched blocks byte for byte. */
    private source = '';

    constructor(
        private readonly editor: Editor,
        private readonly post: Post,
        readonly images: PageImages = new PageImages(),
        options: PageSessionOptions = {},
    ) {
        this.title = options.title ?? null;
        this.isComposing = options.isComposing ?? (() => editor.view.composing);
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
        this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
        const onTransaction = ({ transaction }: { transaction: Transaction }) => {
            if (transaction.docChanged && !transaction.getMeta(BRIDGE_META)) {
                this.version += 1;
                this.scheduleChange();
            }
            // A load asks for all of its pictures once it has said `loaded` (native ignores what comes before).
            if (transaction.docChanged && transaction.getMeta(BRIDGE_META) !== 'load') {
                this.askForImages(false);
            }
            this.publishState();
        };
        editor.on('transaction', onTransaction);
        this.cleanup.push(() => editor.off('transaction', onTransaction));
        const onCompositionEnd = () => {
            this.clearCompositionTimer();
            this.compositionTimer = this.setTimer(() => {
                this.compositionTimer = null;
                this.applyPendingReplace();
            }, AFTER_COMPOSITION_MS);
        };
        editor.view.dom.addEventListener('compositionend', onCompositionEnd);
        this.cleanup.push(() => editor.view.dom.removeEventListener('compositionend', onCompositionEnd));
    }

    /** Handles a message from native; false for one that isn't ours (tentap's). */
    receive(value: unknown): boolean {
        const parsed = parseToWeb(value);
        if (parsed.kind === 'other') {
            return false;
        }
        if (parsed.kind === 'refused') {
            this.post({ type: 'socio-refused', payload: { type: parsed.type } });
            return true;
        }
        const message = parsed.message;
        switch (message.type) {
            case 'socio-load':
                this.load(message.payload.markdown);
                break;
            case 'socio-replace':
                if (this.pendingReplace) {
                    // A newer merge supersedes one still waiting for the input method.
                    this.answerReplace(this.pendingReplace.ifVersion, false);
                }
                this.pendingReplace = message.payload;
                this.applyPendingReplace();
                break;
            case 'socio-command':
                COMMANDS[message.payload.name](this.editor);
                break;
            case 'socio-link':
                this.link(message.payload.href);
                break;
            case 'socio-appearance':
                applyAppearance(this.editor.view.dom.ownerDocument.documentElement, message.payload);
                if (message.payload.insets) {
                    this.applyInsets(message.payload.insets);
                }
                break;
            case 'socio-title':
                this.title?.set(message.payload.title);
                break;
            case 'socio-images':
                this.images.set(message.payload);
                break;
            case 'socio-images-unavailable':
                this.images.markUnavailable(message.payload.ids);
                break;
            case 'socio-insert-image':
                this.insertImage(message.payload);
                break;
            case 'socio-flush':
                if (this.pendingReplace) {
                    // Leaving can't wait for the input method: the answer carries the text now.
                    const held = this.pendingReplace;
                    this.pendingReplace = null;
                    this.answerReplace(held.ifVersion, false);
                } else {
                    this.sendChange();
                }
                break;
        }
        return true;
    }

    /**
     * The native bar's room over the document (CB-417): the caret is kept
     * clear of it as ProseMirror scrolls it into view, and the title counts
     * as gone once it is under it.
     */
    private applyInsets(insets: { top: number; bottom: number }) {
        const margin = 16;
        this.editor.setOptions({
            editorProps: {
                ...this.editor.options.editorProps,
                scrollMargin: { top: insets.top + margin, bottom: insets.bottom + margin, left: 0, right: 0 },
                scrollThreshold: { top: insets.top + margin, bottom: insets.bottom + margin, left: 0, right: 0 },
            },
        });
        this.title?.setInsetTop(insets.top);
    }

    /** A picture from the DOM's paste event, read as a data URI and handed to native. */
    pasteImage(file: File) {
        if (file.size > PASTE_IMAGE_MAX_BYTES) {
            this.post({ type: 'socio-notice', payload: { text: PASTE_TOO_LARGE_NOTICE } });
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                this.post({ type: 'socio-paste-image', payload: { mimeType: file.type, dataUri: reader.result } });
            }
        };
        reader.readAsDataURL(file);
    }

    /** Words for the person, such as a refused paste. */
    notice(text: string) {
        this.post({ type: 'socio-notice', payload: { text } });
    }

    dispose() {
        this.disposed = true;
        this.cancelChange();
        this.clearCompositionTimer();
        // A replace held for the input method dies with the editor: the next WebView loads the draft.
        this.pendingReplace = null;
        this.cleanup.splice(0).forEach((stop) => stop());
    }

    private clearCompositionTimer() {
        if (this.compositionTimer !== null) {
            this.clearTimer(this.compositionTimer);
            this.compositionTimer = null;
        }
    }

    private load(markdown: string) {
        this.cancelChange();
        this.pendingReplace = null;
        const safety = inspectMarkdown(markdown);
        this.source = simpleHtmlToMarkdown(markdown);
        const readBack = loadMarkdown(this.editor, markdown);
        this.version += 1;
        this.sentVersion = this.version;
        this.post({
            type: 'socio-loaded',
            payload: {
                markdown: readBack,
                version: this.version,
                supported: safety.supported,
                reason: safety.supported ? null : (safety.reason ?? SOURCE_MODE_REASON),
            },
        });
        this.publishState();
        this.askForImages(true);
    }

    /**
     * Asks native for the pictures of the document's `image` blocks it doesn't
     * hold: every one (`all`, after a load: a new page, or the WebView again),
     * else only ids not asked for yet. Never a transaction.
     */
    private askForImages(all: boolean) {
        if (this.disposed || this.editor.isDestroyed) {
            return;
        }
        const ids = pageImageIds(this.editor.state.doc).filter(
            (id) => !this.images.has(id) && (all || !this.asked.has(id)),
        );
        ids.forEach((id) => this.asked.add(id));
        for (let at = 0; at < ids.length; at += IMAGES_WANTED_MAX) {
            this.post({ type: 'socio-images-wanted', payload: { ids: ids.slice(at, at + IMAGES_WANTED_MAX) } });
        }
    }

    private applyPendingReplace() {
        const replace = this.pendingReplace;
        if (!replace || this.disposed || this.editor.isDestroyed || this.isComposing()) {
            return;
        }
        this.pendingReplace = null;
        if (replace.ifVersion !== this.version) {
            this.answerReplace(replace.ifVersion, false);
            return;
        }
        this.source = simpleHtmlToMarkdown(replace.markdown);
        const json = this.editor.markdown!.parse(this.source);
        const next = this.editor.schema.nodeFromJSON(json);
        const tr = minimalReplace(this.editor, next);
        if (tr) {
            this.editor.view.dispatch(tr.setMeta(BRIDGE_META, 'replace').setMeta('addToHistory', false));
            this.version += 1;
        }
        this.answerReplace(replace.ifVersion, true);
    }

    /** The document as Markdown, the source's own text kept where the person didn't change it (the web's way). */
    private markdown() {
        return preservedMarkdown(this.editor, this.source);
    }

    /** Answers a replace with what the editor holds now; native then has this version's text. */
    private answerReplace(ifVersion: number, applied: boolean) {
        this.cancelChange();
        this.sentVersion = this.version;
        this.post({
            type: 'socio-replaced',
            payload: { ifVersion, applied, markdown: this.markdown(), version: this.version },
        });
        this.publishState();
    }

    /** The web's picture node (`pageImage`) at the selection: an own edit, so a `change` follows and Undo takes it back. */
    private insertImage(image: PageImage) {
        this.editor
            .chain()
            .focus()
            .insertContent({
                type: 'pageImage',
                attrs: {
                    id: image.id,
                    alt: image.alt ?? null,
                    width: image.width ?? null,
                    height: image.height ?? null,
                },
            })
            .run();
    }

    private link(href: string | null) {
        const chain = this.editor.chain().focus().extendMarkRange('link');
        (href === null ? chain.unsetLink() : chain.setLink({ href })).run();
    }

    private scheduleChange() {
        if (this.changeTimer !== null) {
            return;
        }
        const wait = this.lastSentAt + CHANGE_THROTTLE_MS - this.now();
        if (wait <= 0) {
            this.sendChange();
            return;
        }
        this.changeTimer = this.setTimer(() => {
            this.changeTimer = null;
            this.sendChange();
        }, wait);
    }

    private cancelChange() {
        if (this.changeTimer !== null) {
            this.clearTimer(this.changeTimer);
            this.changeTimer = null;
        }
    }

    private sendChange() {
        this.cancelChange();
        if (this.version === this.sentVersion || this.editor.isDestroyed) {
            return;
        }
        this.sentVersion = this.version;
        this.lastSentAt = this.now();
        this.post({ type: 'socio-change', payload: { markdown: this.markdown(), version: this.version } });
        this.publishState();
    }

    private publishState() {
        if (this.editor.isDestroyed) {
            return;
        }
        const state = toolbarState(this.editor, this.version !== this.sentVersion);
        const key = JSON.stringify(state);
        if (key !== this.lastState) {
            this.lastState = key;
            this.post({ type: 'socio-state', payload: state });
        }
    }
}

const sessions = new WeakMap<Editor, PageSession>();

/** The editor's session, made once (the bundle's `onCreate`). */
export function attachPageSession(editor: Editor, post: Post, images: PageImages, options?: PageSessionOptions) {
    let session = sessions.get(editor);
    if (!session) {
        session = new PageSession(editor, post, images, options);
        sessions.set(editor, session);
        editor.on('destroy', () => {
            session!.dispose();
            sessions.delete(editor);
        });
    }
    return session;
}

/** Hands a native message to the editor's session (tentap's `onBridgeMessage`). */
export const receiveForEditor = (editor: Editor, message: unknown) => sessions.get(editor)?.receive(message) ?? false;
