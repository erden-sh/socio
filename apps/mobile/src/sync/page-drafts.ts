import { AUTOSAVE_DEBOUNCE_MS, pageDraftError } from '@socio/shared/pages/page-draft';

import { type Drafts, DraftError } from './chat-drafts';
import { mergePageText, sameText } from './page-merge';

// The page editor's draft: what the person typed in a page, kept so a kill,
// a dead WebView, the background or a workspace switch loses at most about
// 2 s of it. Durability is apart from sending:
//
// - The editor hands every `change` here (the editor bridge throttles them to
//   one every 400 ms). The latest is kept in memory and written at most every
//   `PAGE_DRAFT_WRITE_MS` (1.5 s), the first at once.
// - A write goes to user.db's `drafts`, scope `page:<pageId>` (`pageDraft`),
//   the draft as JSON (`EditorDraft`). Offline, a valid draft goes into the
//   page's queued row in place instead (the sink's `updateQueued`, page-save.ts), and
//   the editor draft is cleared; with no row that can change (or when that
//   rejects), it is written here. A write that failed (not a DraftError) is
//   tried again by the next change, flush or close (counted by write, so a
//   rebase meanwhile doesn't hide it); when it was a save's, that flush or
//   close also saves (`saveOwed`). `page:` and `review:` drafts are exempt from `DRAFTS_KEPT`.
// - `AUTOSAVE_DEBOUNCE_MS` (800 ms) after the last change, a valid draft is
//   written, then, when it went to `drafts` (not into the queued row), the
//   sink's `save` turns it into a row (page-save.ts's `savePage`, through
//   `enqueueFromDraft`, which clears it in the insert's transaction). Closing
//   an editor (or the scope) with that debounce still pending saves the same
//   way, so leaving right after typing never strands a `page:` draft.
// - **An invalid draft never queues** (the page limits): it stays
//   here, and `error()` gives the web's inline words.
// - `flush()` writes the latest at once (Android Back, leaving the editor, the
//   app going to the background); `close()` also saves a pending debounce; the scope's `dispose()` flushes every open
//   editor before the drafts close, so before the outbox does.
//
// The scope's sink is page-save.ts's. After a save, `rebase` moves an
// open editor's base revision, and the draft on disk's, to the one the server
// answered, so the next save goes against it. Without a sink nothing queues.
//
// After a 409 (page-conflicts.ts), `landed` moves them onto the text the page now stands
// on, the merge or theirs under the conflict banner: a draft still holding
// what the save sent takes it whole, one edited since takes it merged again
// (its edits on top), and one whose edits don't merge clean stays as it is, on
// its old revision, so its own save meets a 409 and the banner. An editor whose
// text changed this way tells its `onReplace` listeners: the editor's session
// wires the editor bridge's `replace` there (a minimal ProseMirror
// transaction that keeps the cursor, undo and IME input).
//
// No React Native: tests/sync runs it under Node.

/** At most one write of the editor's text this often (a kill loses at most about 2 s). */
export const PAGE_DRAFT_WRITE_MS = 1_500;
/** The format of an editor draft's JSON. */
export const PAGE_DRAFT_VERSION = 1;

/** A page editor's draft scope in `drafts`. */
export const pageDraft = (pageId: string) => `page:${pageId}`;

/** What the editor holds for a page, and the base it started from. */
export interface EditorDraft {
    /** The page's Space when the editor opened it (a move keeps the page id; the save relocates). */
    readonly spaceId: string;
    /** The page's revision the editor opened on: the save's base. */
    readonly revision: number;
    readonly title: string;
    readonly content: string;
}

/** Where and at which revision the server holds a page. */
export type PageAt = Pick<EditorDraft, 'spaceId' | 'revision'>;

/** What the editor changes. */
export type EditorText = Pick<EditorDraft, 'title' | 'content'>;

/** The page save's half (page-save.ts): the page's queued row and the save. */
export interface PageDraftSink {
    /** Offline: puts `draft` in the page's queued row in place. False when none can change (none queued, or in flight). */
    updateQueued(pageId: string, draft: EditorDraft): Promise<boolean>;
    /** The debounce ended on a valid draft, written to `drafts`: queue it (`enqueueFromDraft` on `pageDraft(pageId)`). */
    save(pageId: string): Promise<void>;
}

export interface PageDraftsOptions {
    readonly drafts: Drafts;
    /** False only when NetInfo says there is no network. */
    readonly connected: () => boolean;
    /** page-save.ts's; without one nothing queues. */
    readonly sink?: PageDraftSink;
    readonly onError?: (error: unknown) => void;
    /** The timers' clock (fake timers in tests). */
    readonly now?: () => number;
    /**
     * The `drafts` scope of a key: `pageDraft` by default. A page review's
     * edits pass the review's own scope (`reviewDraft`), with no sink.
     */
    readonly scopeOf?: (key: string) => string;
    /** The web's words for a draft that can't be saved; the page limits by default. */
    readonly check?: (draft: EditorDraft) => string | undefined;
}

/** One open editor's draft. */
export interface PageEditorDraft {
    /** The latest text, written or not. */
    read(): EditorDraft;
    /** The web's words when the draft can't be saved (the page limits), else undefined. */
    error(): string | undefined;
    /** The editor's text changed. */
    change(text: EditorText): void;
    /** Writes the latest at once; resolves once it is on disk (or in the queued row). */
    flush(): Promise<void>;
    /** `flush`, then no more changes; a debounce still pending saves as it would have. */
    close(): Promise<void>;
    /**
     * The text the editor must now show, after a merge or a conflict moved it
     * (`landed`): the editor's session hands it to the editor bridge's `replace`. `read()` already
     * gives it. Returns the unsubscribe.
     */
    onReplace(listener: (text: EditorText) => void): () => void;
}

/** Where a 409 left a page: its Space, revision and text, the merge or theirs. */
export type PageLanded = PageAt & EditorText;

export interface PageDrafts {
    /** The editor draft on disk for `pageId` (a kill, a dead WebView), or undefined (none, or unreadable). */
    stored(pageId: string): EditorDraft | undefined;
    /** Opens the editor's draft, starting from `start` (already written: nothing goes until it changes). */
    open(pageId: string, start: EditorDraft): PageEditorDraft;
    /**
     * Page `pageId` was saved by a row whose base was on the revisions `from`
     * (its first, then each rebase on a 409 or after an earlier save), and the
     * server has it at `to`: an editor still on one of them, and the
     * draft on disk, move to `to`'s revision and Space, so the next save goes
     * against the page the server now holds, where it now is.
     */
    rebase(pageId: string, from: readonly number[], to: PageAt): void;
    /**
     * A save of page `pageId` from one of the revisions `from` sent `sent`
     * and met a 409: an editor on one of them, and the draft on disk,
     * move to `to` (the merge, or theirs under the banner) when they hold
     * `sent`, or `to` with their own edits since merged in when that is clean;
     * otherwise they stay as they are. An editor whose text changed tells its
     * `onReplace` listeners.
     */
    landed(pageId: string, from: readonly number[], sent: EditorText, to: PageLanded): void;
    /** Flushes every open editor. */
    flush(): Promise<void>;
    /** Flushes every open editor, then refuses more. Before the drafts close. Never rejects. */
    close(): Promise<void>;
}

/** `text` as an editor draft, or undefined when it isn't one this build reads. */
export function parseEditorDraft(text: string): EditorDraft | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    const draft = value as Partial<EditorDraft & { v: number }> | null;
    return draft?.v === PAGE_DRAFT_VERSION &&
        typeof draft.spaceId === 'string' &&
        typeof draft.revision === 'number' &&
        typeof draft.title === 'string' &&
        typeof draft.content === 'string'
        ? { spaceId: draft.spaceId, revision: draft.revision, title: draft.title, content: draft.content }
        : undefined;
}

const encode = (draft: EditorDraft) =>
    JSON.stringify({
        v: PAGE_DRAFT_VERSION,
        spaceId: draft.spaceId,
        revision: draft.revision,
        title: draft.title,
        content: draft.content,
    });

/** What a draft on one of a save's revisions becomes after its 409 (`landed`), or null to leave it. */
function landedText(current: EditorText, sent: EditorText, to: PageLanded): EditorText | null {
    if (sameText(current, sent)) {
        return { title: to.title, content: to.content };
    }
    return mergePageText(sent, current, to);
}

/** The page limits, as the web words them. */
const pageError = (draft: EditorDraft) =>
    pageDraftError({ title: draft.title, content: draft.content, parentId: null });

export function createPageDrafts(options: PageDraftsOptions): PageDrafts {
    const { drafts, connected, sink, onError = () => {}, now = Date.now } = options;
    const scopeOf = options.scopeOf ?? pageDraft;
    const errorOf = options.check ?? pageError;
    /** The open editors, each with its page and its own rebase. */
    const open = new Map<
        PageEditorDraft,
        {
            pageId: string;
            rebase: (from: readonly number[], to: PageAt) => void;
            land: (from: readonly number[], sent: EditorText, to: PageLanded) => void;
        }
    >();
    let closed = false;

    const openDraft = (
        pageId: string,
        start: EditorDraft,
    ): {
        handle: PageEditorDraft;
        rebase: (from: readonly number[], to: PageAt) => void;
        land: (from: readonly number[], sent: EditorText, to: PageLanded) => void;
    } => {
        const scope = scopeOf(pageId);
        let latest = start;
        const replaceListeners = new Set<(text: EditorText) => void>();
        /** The last draft handed to `persist`; undefined after one failed, so the next write retries. */
        let written: EditorDraft | undefined = start;
        let lastWriteAt = Number.NEGATIVE_INFINITY;
        let writeTimer: ReturnType<typeof setTimeout> | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        /** Where the last write went; undefined while one runs or after one failed. */
        let wentTo: 'drafts' | 'queued' | undefined;
        /** Writes in order: an offline `updateQueued` settles before the next write. */
        let chain: Promise<void> = Promise.resolve();
        /** Each write's number: a failure clears `written` only when no later write began (a rebase swaps the object). */
        let writes = 0;
        /**
         * The debounce ended (or the editor closed within it) on a valid draft
         * whose write failed: the sink's `save` is still owed. The next flush or
         * close saves rather than only writing, so an online edit isn't left in
         * `drafts` unsent.
         */
        let saveOwed = false;

        /** The sink's `updateQueued`; a rejection falls back to `drafts` (false), so the text is still written. */
        const intoQueued = async (into: PageDraftSink, draft: EditorDraft): Promise<boolean> => {
            try {
                return await into.updateQueued(pageId, draft);
            } catch (error) {
                onError(error);
                return false;
            }
        };
        const persist = async (draft: EditorDraft) => {
            wentTo = undefined;
            let to: 'drafts' | 'queued';
            if (errorOf(draft) === undefined && !connected() && sink && (await intoQueued(sink, draft))) {
                // The queued row holds it now: an editor draft beside it would be older.
                if (drafts.read(scope).text) {
                    drafts.write(scope, '');
                }
                to = 'queued';
            } else {
                drafts.write(scope, encode(draft));
                to = 'drafts';
            }
            await drafts.flush();
            wentTo = to;
        };
        const write = (): Promise<void> => {
            clearTimeout(writeTimer);
            writeTimer = undefined;
            lastWriteAt = now();
            const draft = latest;
            if (draft !== written) {
                written = draft;
                writes += 1;
                const sequence = writes;
                chain = chain
                    .then(() => persist(draft))
                    .catch((error: unknown) => {
                        // A newer build's draft (locked) or closed drafts: the text stays in memory.
                        if (!(error instanceof DraftError)) {
                            // Anything else (a disk error) isn't written: the next write tries again,
                            // unless a later one already took over (a rebase in between doesn't count).
                            if (sequence === writes) {
                                written = undefined;
                            }
                            onError(error);
                        }
                    });
            }
            return chain;
        };
        /**
         * Writes the latest, then hands it to the sink's `save` when it is valid
         * and went to `drafts`: in the queued row it is already queued, and
         * `drafts` holds nothing to save.
         */
        const save = async (): Promise<void> => {
            const valid = errorOf(latest) === undefined;
            if (valid && sink) {
                saveOwed = true;
            }
            // Written first, so the save sends what the editor holds.
            await write();
            if (!valid || !sink || wentTo === undefined) {
                // Invalid, no sink, or the write failed: owed until a flush or close writes it.
                return;
            }
            saveOwed = false;
            if (wentTo === 'drafts') {
                await sink.save(pageId).catch(onError);
            }
        };
        const idle = () => {
            idleTimer = undefined;
            if (errorOf(latest) === undefined && sink !== undefined) {
                void save();
            }
        };

        const handle: PageEditorDraft = {
            read: () => latest,
            error: () => errorOf(latest),
            change(text) {
                if (done || (text.title === latest.title && text.content === latest.content)) {
                    return;
                }
                latest = { ...latest, title: text.title, content: text.content };
                clearTimeout(idleTimer);
                idleTimer = setTimeout(idle, AUTOSAVE_DEBOUNCE_MS);
                if (writeTimer === undefined) {
                    const wait = lastWriteAt + PAGE_DRAFT_WRITE_MS - now();
                    if (wait > 0) {
                        writeTimer = setTimeout(write, wait);
                    } else {
                        void write();
                    }
                }
            },
            flush: () => (saveOwed ? save() : write()),
            onReplace(listener) {
                replaceListeners.add(listener);
                return () => replaceListeners.delete(listener);
            },
            async close() {
                if (!done) {
                    done = true;
                    const pending = idleTimer !== undefined;
                    clearTimeout(idleTimer);
                    idleTimer = undefined;
                    open.delete(handle);
                    if (pending || saveOwed) {
                        // Left within the debounce, or after a save whose write failed: save now.
                        await save();
                        return;
                    }
                }
                await (saveOwed ? save() : write());
            },
        };
        const rebase = (from: readonly number[], to: PageAt) => {
            if (from.includes(latest.revision)) {
                const wasWritten = latest === written;
                latest = { ...latest, spaceId: to.spaceId, revision: to.revision };
                if (wasWritten) {
                    written = latest;
                }
            }
        };
        const land = (from: readonly number[], sent: EditorText, to: PageLanded) => {
            if (done || !from.includes(latest.revision)) {
                return;
            }
            const next = landedText(latest, sent, to);
            if (next === null) {
                // Its edits don't merge: left on its revision, so its save meets the 409 and the banner.
                return;
            }
            const changed = next.title !== latest.title || next.content !== latest.content;
            const wasWritten = latest === written;
            latest = { spaceId: to.spaceId, revision: to.revision, title: next.title, content: next.content };
            if (!changed) {
                if (wasWritten) {
                    written = latest;
                }
                return;
            }
            // Written with the next write, as any change; the editor shows it through the bridge's `replace`.
            for (const listener of [...replaceListeners]) {
                try {
                    listener({ title: next.title, content: next.content });
                } catch (error) {
                    onError(error);
                }
            }
        };
        return { handle, rebase, land };
    };

    const flushAll = async () => {
        await Promise.all([...open.keys()].map((handle) => handle.flush()));
    };

    return {
        stored(pageId) {
            const { text } = drafts.read(scopeOf(pageId));
            return text ? parseEditorDraft(text) : undefined;
        },
        open(pageId, start) {
            if (closed) {
                throw new DraftError('The drafts are closed.');
            }
            const { handle, rebase, land } = openDraft(pageId, start);
            open.set(handle, { pageId, rebase, land });
            return handle;
        },
        rebase(pageId, from, to) {
            for (const entry of open.values()) {
                if (entry.pageId === pageId) {
                    entry.rebase(from, to);
                }
            }
            // The draft on disk (an editor's, or one a kill left), when it is on one of `from` too.
            const scope = scopeOf(pageId);
            const record = drafts.read(scope);
            const stored = record.text && !record.locked ? parseEditorDraft(record.text) : undefined;
            if (stored !== undefined && from.includes(stored.revision) && !closed) {
                try {
                    drafts.write(scope, encode({ ...stored, spaceId: to.spaceId, revision: to.revision }));
                } catch (error) {
                    if (!(error instanceof DraftError)) {
                        onError(error);
                    }
                }
            }
        },
        landed(pageId, from, sent, to) {
            for (const entry of [...open.values()]) {
                if (entry.pageId === pageId) {
                    entry.land(from, sent, to);
                }
            }
            const scope = scopeOf(pageId);
            const record = drafts.read(scope);
            const stored = record.text && !record.locked ? parseEditorDraft(record.text) : undefined;
            if (stored === undefined || !from.includes(stored.revision) || closed) {
                return;
            }
            const next = landedText(stored, sent, to);
            if (next === null) {
                return;
            }
            try {
                drafts.write(scope, encode({ spaceId: to.spaceId, revision: to.revision, ...next }));
            } catch (error) {
                if (!(error instanceof DraftError)) {
                    onError(error);
                }
            }
        },
        flush: flushAll,
        async close() {
            closed = true;
            await Promise.all([...open.keys()].map((handle) => handle.close())).catch(onError);
        },
    };
}
