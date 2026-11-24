import type { PageImage } from '@socio/shared/page-image';
import { AUTOSAVE_DEBOUNCE_MS } from '@socio/shared/pages/page-draft';

import type { EditorText, PageEditorDraft } from '../sync/page-drafts';
import { mergePageText } from '../sync/page-merge';

import {
    type EditorAppearance,
    type EditorCommand,
    type EditorState,
    parseToNative,
    type ToNativeMessage,
    toWeb,
    type ToWebMessage,
} from './bridge';
import { createEditorPictures, type EditorPictureSource } from './pictures';

// The page editor's native session: what sits between the editor's WebView
// (bridge.ts) and the page's draft (`PageEditorDraft`, which feeds the page's
// saves). No React
// Native: the screen (screens/page-editor-webview.tsx) binds it to tentap,
// and tests/editor/session.test.ts runs it under Node.
//
// - **Opening:** each time tentap says the WebView is ready (the first time,
//   and again after a dead content process brought a new one), the session
//   sends the appearance and `socio-load` with the draft's text, and ignores
//   anything else the WebView says until its `socio-loaded`: after a crash, a
//   page that came back empty must never reach the draft.
// - **Typing:** each `socio-change` (the bridge throttles them to one every
//   400 ms) goes to the draft with the title the draft holds; the draft writes
//   it at most every 1.5 s and saves it 800 ms after the last one.
// - **The title** (CB-417) is at the top of the WebView's document, so it
//   scrolls with the text: sent (`socio-title`) once the page is read back
//   and whenever the draft's title differs from what the WebView last held (a
//   merge, source mode's native field); each `socio-title-change` goes to the
//   draft. `socio-title-shown` tells the screen when it has scrolled under the
//   bar (`titleShown`), which then shows it on one line.
// - **Merges** (the draft's `landed`, through its `onReplace`): the merged
//   text goes to the WebView as `socio-replace` at the version native last
//   saw. If the person typed since, the WebView answers with what it holds,
//   and the session merges that onto the merge again (shared's line merge,
//   from what it last saw) and sends it again. One replace is out at a time:
//   a merge landing meanwhile waits for the answer, which then sends the
//   draft's newest text. While a replace is out, changes only update what the
//   WebView holds: the draft already holds the merge, and the person's newer
//   words come back with the answer. When they don't merge clean, the merge
//   wins on screen (a load) and the person is told: a change made elsewhere is
//   never replaced unseen.
// - **Source mode:** the web's `inspectMarkdown` runs in the WebView on each
//   load. A page the rich editor can't keep opens as Markdown source, with the
//   web's reason; Visual editor checks the text again each time it is asked
//   (the person may have fixed it). Text typed in source while a check is out
//   is checked again, from the draft, before the rich editor shows anything.
//   On request any page can switch to source, and back once the check passes.
// - **Leaving and Android Back:** `flush()` asks the WebView for an edit not
//   yet sent (`socio-flush`) and waits for it (at most `FLUSH_WAIT_MS`), then
//   writes the draft; `close()` does the same and closes the draft, which
//   saves a debounce still pending. A replace still out is waited for too
//   (the WebView answers one held for an input method at once); when the wait
//   ends first, or the WebView dies, the person's words are merged into the
//   draft here (`fold`), so nothing typed meanwhile is lost.
// - **Pictures:** the WebView's `socio-images-wanted` goes to `pictures.ts`,
//   which answers from the image cache one picture at a time. The draft never
//   hears of it: a picture drawn is no edit. A new WebView starts it afresh.

/** After the draft's debounce, how long the save line waits for the outbox to show the row. */
const EDITING_SLACK_MS = 200;

/** How long leaving waits for the WebView's last edit. */
export const FLUSH_WAIT_MS = 400;

/** The words when a merge and the person's last words couldn't both stay. */
export const MERGE_CLASHED =
    'A change made elsewhere touched the lines you were typing in, so your last few words were replaced. The page shows both changes up to then.';
/** A pasted picture where the editor takes none (a page review's draft: no Space to make it an image of). */
export const PASTE_IMAGE_LATER = 'Pasting images into a page isn’t available on the phone yet.';

export type EditorMode =
    /** The WebView hasn't read the page back yet. */
    | 'loading'
    /** The rich editor. */
    | 'rich'
    /** Markdown source in a plain text field. */
    | 'source';

export interface EditorView {
    readonly mode: EditorMode;
    /** Why source mode is required for this page (the web's words), or null when it was asked for. */
    readonly sourceReason: string | null;
    /** Words for the person (a refused paste, a clashing merge), until dismissed. */
    readonly notice: string | null;
    /** The toolbar's state, or null before the first. */
    readonly state: EditorState | null;
    /** The page's text as the draft holds it: the title field's, and source mode's. */
    readonly text: EditorText;
    /** Changed within the draft's debounce: not in the outbox yet, so the save line says "Saving…". */
    readonly editing: boolean;
    /** The rich editor holds the page and takes the toolbar's commands; else they are dropped, so the toolbar is off. */
    readonly editable: boolean;
    /** The document's title is in view below the bar; false once it scrolled under it (CB-417). */
    readonly titleShown: boolean;
}

export interface EditorSessionOptions {
    readonly draft: PageEditorDraft;
    /** Sends to the WebView (tentap's bridge); else `connect` gives it once the WebView mounts. */
    readonly send?: (message: ToWebMessage) => void;
    readonly appearance: EditorAppearance;
    readonly onError?: (error: unknown) => void;
    /**
     * A picture pasted into the WebView (its DOM paste): the screen
     * uploads it and calls `insertImage`. Without it, the editor says
     * PASTE_IMAGE_LATER.
     */
    readonly onPasteImage?: (image: { readonly mimeType: string; readonly dataUri: string }) => void;
    /**
     * The pictures of the page's `image` blocks, from the app's image cache
     * (src/platform/editor-pictures.ts). Without it, the blocks show their
     * alt text.
     */
    readonly pictures?: EditorPictureSource;
    /** Timers (fake ones in tests). */
    readonly setTimer?: (callback: () => void, ms: number) => unknown;
    readonly clearTimer?: (timer: unknown) => void;
}

export interface EditorSession {
    /** The view's state, the same object between changes (useSyncExternalStore). */
    view(): EditorView;
    subscribe(listener: () => void): () => void;
    /** The WebView's sender as it mounts (tentap's bridge), null as it unmounts. */
    connect(send: ((message: unknown) => void) | null): void;
    /** tentap says the WebView is ready: load the draft into it. */
    ready(): void;
    /** The WebView went away (a dead content process, a reload): wait for the next ready. */
    lost(): void;
    /** A message from the WebView; false when it isn't ours (tentap's). */
    receive(value: unknown): boolean;
    setTitle(title: string): void;
    /** Source mode's text field changed. */
    setSource(content: string): void;
    /** Markdown source, on request. */
    showSource(): void;
    /** Back to the rich editor, if the web's check lets the text in. */
    showRich(): void;
    setAppearance(appearance: EditorAppearance): void;
    /** A toolbar button: the command on the WebView's selection; false when the editor can't take it now. */
    command(name: EditorCommand): boolean;
    /** The toolbar's link prompt: links the selection to `href`, or unlinks it with null. */
    link(href: string | null): boolean;
    dismissNotice(): void;
    /** Words for the person from the screen (a paste's progress or refusal), until dismissed. */
    showNotice(text: string): void;
    /**
     * A pasted picture, uploaded: its picture (`dataUri`) to the
     * WebView's images, then its block at the cursor, as the person's own
     * edit. False when the rich editor can't take it now.
     */
    insertImage(image: PageImage, dataUri?: string): boolean;
    /** Back online: the pictures the cache couldn't give are asked for again. */
    retryPictures(): void;
    /** Takes the WebView's last edit, then writes the draft (Android Back, the background). */
    flush(): Promise<void>;
    /** `flush`, then closes the draft (leaving the editor). */
    close(): Promise<void>;
}

interface PendingReplace {
    readonly ifVersion: number;
    /** What the WebView held at `ifVersion`, as native last saw it. */
    readonly base: string;
    /** The text it should now show. */
    readonly target: string;
}

export function createEditorSession(options: EditorSessionOptions): EditorSession {
    const { draft, onError = (error: unknown) => console.warn('[editor]', error) } = options;
    const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    const listeners = new Set<() => void>();
    let appearance = options.appearance;
    let sendTo: ((message: ToWebMessage) => void) | null = options.send ?? null;

    let isReady = false;
    /** A load is out: everything else the WebView says is about a page that is gone. */
    let awaitingLoad = true;
    /** The text the WebView last told (a load, a change, a replace's answer) and its version. */
    let held = draft.read().content;
    let heldVersion = 0;
    /** The WebView's `state` says an own edit isn't sent yet (the throttle holds it): leaving waits for it. */
    let webUnsent = false;
    let pending: PendingReplace | null = null;
    /** The draft holds `held` (or a merge of it): false while a replace is out and the person typed. */
    let draftHasHeld = true;
    /** Leaving waits for these: resolved when the WebView's text catches up. */
    let waiters: (() => void)[] = [];
    let closed = false;
    /** The load out is a switch from source back to the rich editor. */
    let checkingRich = false;
    /** The text the last `socio-load` sent: source mode's field may change the draft while a check is out. */
    let loadedText: string | null = null;
    /** The title the WebView holds, as far as native knows; null until it is sent after a load. */
    let webTitle: string | null = null;

    const pictures =
        options.pictures === undefined
            ? null
            : createEditorPictures({ source: options.pictures, send: (message) => send(message), onError });

    let view: EditorView = {
        mode: 'loading',
        sourceReason: null,
        notice: null,
        state: null,
        text: textOf(),
        editing: false,
        editable: false,
        titleShown: true,
    };
    let editingTimer: unknown = null;

    function textOf(): EditorText {
        const { title, content } = draft.read();
        return { title, content };
    }
    const update = (patch: Partial<EditorView>) => {
        const next = { ...view, ...patch };
        view = { ...next, text: textOf(), editable: canSend(next.mode) };
        for (const listener of [...listeners]) {
            listener();
        }
    };
    /** The person changed the text: "Saving…" until the draft's debounce has handed it to the outbox. */
    const edited = () => {
        clearTimer(editingTimer);
        editingTimer = setTimer(() => {
            editingTimer = null;
            update({ editing: false });
        }, AUTOSAVE_DEBOUNCE_MS + EDITING_SLACK_MS);
        update({ editing: true });
    };
    const send = (message: ToWebMessage) => {
        if (sendTo === null) {
            return;
        }
        try {
            sendTo(toWeb(message));
        } catch (error) {
            onError(error);
        }
    };
    /** The draft holds everything the WebView has: leaving needn't wait. */
    const settled = () => !isReady || awaitingLoad || view.mode !== 'rich' || (!webUnsent && draftHasHeld);
    const settleWaiters = () => {
        if (settled()) {
            const done = waiters;
            waiters = [];
            done.forEach((resolve) => resolve());
        }
    };
    /** The rich editor shows the page: a toolbar command reaches it (else it is dropped: no queue across a load). */
    const canSend = (mode: EditorMode) => !closed && sendTo !== null && isReady && !awaitingLoad && mode === 'rich';
    const editable = () => canSend(view.mode);
    /** Tells the toolbar when whether it can send changed with no other update. */
    const syncEditable = () => {
        if (view.editable !== editable()) {
            update({});
        }
    };
    const load = () => {
        awaitingLoad = true;
        pending = null;
        draftHasHeld = true;
        loadedText = draft.read().content;
        send({ type: 'socio-load', payload: { markdown: loadedText } });
        syncEditable();
    };
    /** The draft's title to the WebView, when it differs from what the WebView holds. */
    const syncTitle = () => {
        if (!isReady || awaitingLoad || webTitle === null) {
            return;
        }
        const { title } = draft.read();
        if (title !== webTitle) {
            webTitle = title;
            send({ type: 'socio-title', payload: { title } });
        }
    };
    /** The person's text from the WebView, into the draft (rich mode only). */
    const typed = (markdown: string) => {
        if (view.mode === 'rich') {
            draft.change({ title: draft.read().title, content: markdown });
            edited();
        }
    };

    /** Sends `target` to the WebView, from what it last told. */
    const replace = (target: string) => {
        pending = { ifVersion: heldVersion, base: held, target };
        send({ type: 'socio-replace', payload: { markdown: target, ifVersion: heldVersion } });
    };

    const onReplace = draft.onReplace(() => {
        // The draft holds the merge now (its `landed`); the title field reads it.
        update({});
        syncTitle();
        if (!isReady || awaitingLoad || view.mode !== 'rich') {
            // The next load, or source mode's field, shows it.
            return;
        }
        if (pending !== null) {
            // One at a time: two answers at the same version can't be told apart. The answer sends this one.
            return;
        }
        const target = draft.read().content;
        if (target === held) {
            return;
        }
        replace(target);
    });

    /**
     * The person's words typed while a replace is out, merged into the draft
     * now: leaving, the background or a dead WebView can't wait for its answer.
     * When they clash, the draft keeps the change made elsewhere and the person
     * is told, as when the answer clashes.
     */
    const fold = () => {
        if (pending === null || draftHasHeld) {
            return;
        }
        draftHasHeld = true;
        const { title, content } = draft.read();
        const merged = mergePageText({ title, content: pending.base }, { title, content: held }, { title, content });
        if (merged === null) {
            update({ notice: MERGE_CLASHED });
            return;
        }
        // The answer, if it still comes, merges from here.
        pending = { ...pending, base: held };
        if (merged.content !== content) {
            draft.change({ title, content: merged.content });
            edited();
        }
    };

    const handle = (message: ToNativeMessage) => {
        switch (message.type) {
            case 'socio-loaded': {
                const { markdown, version, supported, reason } = message.payload;
                awaitingLoad = false;
                held = markdown;
                heldVersion = version;
                webUnsent = false;
                draftHasHeld = true;
                const wasChecking = checkingRich;
                if (wasChecking && draft.read().content !== loadedText) {
                    // The person typed in source mode while the check was out: the WebView holds
                    // older text. Check the newest instead, still in source mode, so nothing is lost.
                    load();
                    settleWaiters();
                    return;
                }
                checkingRich = false;
                if (webTitle === null) {
                    // The page is in: its title goes above it.
                    webTitle = draft.read().title;
                    send({ type: 'socio-title', payload: { title: webTitle } });
                } else {
                    syncTitle();
                }
                if (!supported) {
                    // Opened as source, or Visual editor refused for this text: the web's reason.
                    update({
                        mode: 'source',
                        sourceReason: reason,
                        notice: wasChecking ? reason : view.notice,
                    });
                } else if (view.mode === 'loading' || wasChecking) {
                    update({ mode: 'rich', sourceReason: null });
                }
                syncEditable();
                settleWaiters();
                return;
            }
            case 'socio-change': {
                const { markdown, version } = message.payload;
                if (awaitingLoad || version <= heldVersion) {
                    return;
                }
                held = markdown;
                heldVersion = version;
                webUnsent = false;
                if (pending === null) {
                    typed(markdown);
                    draftHasHeld = true;
                } else {
                    draftHasHeld = false;
                }
                settleWaiters();
                return;
            }
            case 'socio-replaced': {
                if (awaitingLoad) {
                    return;
                }
                const { ifVersion, applied, markdown, version } = message.payload;
                held = markdown;
                heldVersion = Math.max(heldVersion, version);
                webUnsent = false;
                const asked = pending;
                if (asked === null || asked.ifVersion !== ifVersion) {
                    settleWaiters();
                    return;
                }
                pending = null;
                draftHasHeld = true;
                if (view.mode !== 'rich') {
                    // Source mode's field edits the draft now; the next load shows it.
                    settleWaiters();
                    return;
                }
                // The newest merge: what was asked, or one that landed while it was out.
                const { title, content: target } = draft.read();
                if (applied) {
                    if (target !== asked.target) {
                        replace(target);
                    }
                } else {
                    // The person typed since: their words on top of the merge, merged again.
                    const merged = mergePageText(
                        { title, content: asked.base },
                        { title, content: markdown },
                        { title, content: target },
                    );
                    if (merged === null) {
                        // They clash: the merge stays (it holds someone else's change), shown as it is.
                        load();
                        update({ notice: MERGE_CLASHED });
                        settleWaiters();
                        return;
                    }
                    draft.change({ title, content: merged.content });
                    update({});
                    if (merged.content !== markdown) {
                        replace(merged.content);
                    }
                }
                settleWaiters();
                return;
            }
            case 'socio-title-change': {
                if (awaitingLoad || webTitle === null) {
                    return;
                }
                webTitle = message.payload.title;
                if (message.payload.title !== draft.read().title) {
                    draft.change({ title: message.payload.title, content: draft.read().content });
                    edited();
                }
                return;
            }
            case 'socio-title-shown':
                if (view.titleShown !== message.payload.shown) {
                    update({ titleShown: message.payload.shown });
                }
                return;
            case 'socio-state':
                webUnsent = message.payload.unsent;
                update({ state: message.payload });
                return;
            case 'socio-notice':
                update({ notice: message.payload.text });
                return;
            case 'socio-paste-image':
                if (options.onPasteImage && view.mode === 'rich') {
                    options.onPasteImage(message.payload);
                } else {
                    update({ notice: PASTE_IMAGE_LATER });
                }
                return;
            case 'socio-images-wanted':
                if (!awaitingLoad) {
                    pictures?.want(message.payload.ids);
                }
                return;
            case 'socio-refused':
                onError(new Error(`The editor refused a ${message.payload.type} message.`));
                return;
        }
    };

    const lost = () => {
        // The reload comes from the draft: the words held for a replace go into it first.
        fold();
        isReady = false;
        awaitingLoad = true;
        pending = null;
        webTitle = null;
        if (!view.titleShown) {
            update({ titleShown: true });
        }
        syncEditable();
        settleWaiters();
    };

    /** Waits until the WebView's last edit is here (or `FLUSH_WAIT_MS`). */
    const caughtUp = () =>
        new Promise<void>((resolve) => {
            if (settled()) {
                resolve();
                return;
            }
            let timer: unknown;
            const done = () => {
                clearTimer(timer);
                resolve();
            };
            waiters.push(done);
            timer = setTimer(() => {
                waiters = waiters.filter((each) => each !== done);
                fold();
                resolve();
            }, FLUSH_WAIT_MS);
            send({ type: 'socio-flush' });
        });

    return {
        view: () => view,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        connect(next) {
            sendTo = next;
            if (next === null) {
                lost();
            }
            syncEditable();
        },
        ready() {
            if (closed || sendTo === null) {
                return;
            }
            isReady = true;
            heldVersion = 0;
            // A new WebView holds no picture: its load asks again.
            pictures?.reset();
            webUnsent = false;
            send({ type: 'socio-appearance', payload: appearance });
            load();
        },
        lost,
        receive(value) {
            const parsed = parseToNative(value);
            if (parsed.kind === 'other') {
                return false;
            }
            if (parsed.kind === 'refused') {
                onError(new Error(`A ${parsed.type} message from the editor was refused.`));
            } else if (!closed) {
                handle(parsed.message);
            }
            return true;
        },
        setTitle(title) {
            draft.change({ title, content: draft.read().content });
            edited();
            syncTitle();
        },
        setSource(content) {
            if (view.mode === 'source') {
                draft.change({ title: draft.read().title, content });
                edited();
            }
        },
        showSource() {
            if (view.mode !== 'rich') {
                return;
            }
            void caughtUp().then(() => {
                if (view.mode === 'rich' && !closed) {
                    update({ mode: 'source', sourceReason: null });
                }
            });
        },
        showRich() {
            if (view.mode !== 'source') {
                return;
            }
            // Checked again each time, a page that opened in required source mode too: the
            // person may have fixed what the rich editor couldn't keep. Refused, it stays here
            // with the web's reason.
            checkingRich = true;
            if (isReady) {
                load();
            }
        },
        setAppearance(next) {
            appearance = next;
            if (isReady) {
                send({ type: 'socio-appearance', payload: next });
            }
        },
        command(name) {
            if (!editable()) {
                return false;
            }
            send({ type: 'socio-command', payload: { name } });
            return true;
        },
        link(href) {
            if (!editable()) {
                return false;
            }
            send({ type: 'socio-link', payload: { href } });
            return true;
        },
        dismissNotice() {
            if (view.notice !== null) {
                update({ notice: null });
            }
        },
        showNotice(text) {
            if (view.notice !== text) {
                update({ notice: text });
            }
        },
        insertImage(image, dataUri) {
            if (!editable()) {
                return false;
            }
            if (dataUri !== undefined) {
                send({ type: 'socio-images', payload: { [image.id]: dataUri } });
            }
            send({ type: 'socio-insert-image', payload: image });
            return true;
        },
        retryPictures() {
            pictures?.retry();
        },
        async flush() {
            await caughtUp();
            await draft.flush();
        },
        async close() {
            if (closed) {
                return;
            }
            await caughtUp();
            closed = true;
            pictures?.stop();
            syncEditable();
            clearTimer(editingTimer);
            onReplace();
            await draft.close();
        },
    };
}
