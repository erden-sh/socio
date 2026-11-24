import { pageDraftError, pageTitle } from '@socio/shared/pages/page-draft';
import { type Page, pageSummary } from '@socio/shared/pages/page-library';

import { NetworkError } from '../net/errors';

import type { Drafts } from './chat-drafts';
import type { Outbox, OutboxContext, OutboxKind, OutboxRow, OutboxWrite, SendOutcome, UnsentAs } from './outbox';
import { OUTBOX_REWRITE_MAX, UNSENT_GONE } from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer } from './outbox-answers';
import type { Overlay, OverlayKind } from './outbox-overlay';
import { type EditorDraft, pageDraft, type PageDraftSink, parseEditorDraft } from './page-drafts';
import { mergePageText, type PageText, sameText } from './page-merge';
import { pageBodyKey, pageLocationPath, PAGES } from './pages';
import type { SnapshotCache } from './snapshot-cache';

// Saving a page: the
// `page-save` kind, safe to repeat (the PATCH is a compare-and-set on the page's
// revision), in lane `page:<pageId>`, one coalesced row per page.
//
// - **The row** carries the Space, the page, its **base** (the title, text and
//   revision the draft started from; the text is null when the phone no
//   longer held that revision), the **draft** and `ownRevisions`, the
//   revisions this phone's own saves made. It never sends `parentId`: a move
//   is page-manage.ts's, and someone's move only bumps the revision (a 409 here).
// - **`savePage`** (the editor draft's sink, page-drafts.ts): the draft
//   replaces the queued row's in place. A row in flight can't change, so the
//   next draft is one queued row behind it, based on that row's draft; the
//   settle of the first rewrites its base and `ownRevisions` in the same
//   transaction (the outbox's `amend`). A draft equal to its base is never
//   queued, and a queued row whose edits go back to the base is removed;
//   titles are trimmed before comparing (the server trims them).
// - **Before a create is confirmed** (page-manage.ts's `page-create`, local id
//   `local-page-<uuid>`): edits fold into the create while it is queued; after
//   that, a save `dependsOn` it, based on its payload at revision 1.
// - **Answers:** 200 hands the page to the Space's list and the body,
//   moves the editor's base (`onSaved`) and the next row's (`amend`). 409 reads
//   the page: our draft already there is done (a lost success); the server
//   still at our base, or at one of our own revisions, sends again on it (a
//   move, an earlier save of ours); anything else is merged on lines
//   (below). 404 reads where the page went and sends
//   again there (a `rewrite`), or is gone. 410 is `page-deleted`, 403
//   `page-refused`, a 400 from a newer rule `page-invalid`. A 401 holds, a 5xx
//   or no answer is unknown and goes again.
// - **Merges** (page-conflicts.ts): shared's `mergeTitledText`
//   of the base, the draft and theirs. Clean, the row is rewritten with the
//   merge on theirs (`merged`) and sent; once the row has had
//   `OUTBOX_REWRITE_MAX` rewrites (`write.rewrites`) it is a conflict instead,
//   decided before the editor or the toast hears of a merge. Not clean (or with no base text to merge from), theirs goes to
//   the body and the list, and ours to `unsent` as `conflict` in lane
//   `page-conflict:<pageId>` with theirs beside it (`PageConflictPayload`),
//   in one transaction, so `page:<pageId>` stays free for the next saves.
//   Either way `onLanded` hands the editor the text it now stands on
//   (page-drafts.ts's `landed`, through the editor bridge's `replace`). A
//   queued save behind a merged one is merged again onto the page the server
//   answered as its base moves (`amend`); when that isn't clean it keeps its
//   old base, so its own 409 brings it to the banner.
// - **On screen** (`overlay`): the Space's list shows the draft's title (a
//   conflict's shows nothing: the screen shows theirs under the banner);
//   `pendingPageText` gives the body screen the newest draft.
//
// No React Native: tests/sync runs it under Node.

export const PAGE_SAVE_KIND = 'page-save';
/** page-manage.ts's create of a page made on the phone: edits fold into it while it is queued. */
export const PAGE_CREATE_KIND = 'page-create';
/** The `ids` map's kind for a page's server id (page-manage.ts's creates). */
export const PAGE_IDS = 'page';
const LOCAL_PAGE_PREFIX = 'local-page-';
const VERSION = 1;
/** Own revisions a row remembers, newest last. */
const OWN_REVISIONS_KEPT = 20;

/** Page `pageId`'s lane: its saves, move and delete (page-manage.ts). */
export const pageLane = (pageId: string) => `page:${pageId}`;
/** Page `pageId`'s conflicts: refused saves only, so they never hold its lane. */
export const pageConflictLane = (pageId: string) => `page-conflict:${pageId}`;
/** Page `pageId`'s cover lane (page-manage.ts): a cover carries no revision, so it never waits on a save. */
export const coverLane = (pageId: string) => `cover:${pageId}`;
/** A page made on the phone, known by its local id until its create resolves. */
export const isLocalPage = (pageId: string) =>
    pageId.startsWith(LOCAL_PAGE_PREFIX) && pageId.length > LOCAL_PAGE_PREFIX.length;
/** A new page's local id from a fresh UUID (expo-crypto). */
export const newLocalPageId = (newId: () => string) => `${LOCAL_PAGE_PREFIX}${newId()}`;

type RouteOutbox = Pick<Outbox, 'rows' | 'unsent' | 'resolve'>;

/** Whether lane `lane` holds a write: a row in the outbox or a refused one. */
const holdsWrite = (outbox: RouteOutbox, lane: string) =>
    outbox.rows().some((row) => row.lane === lane) || outbox.unsent().some((write) => write.lane === lane);

/** Where a write to a page goes, by its lane family (`pageLane` or `coverLane`). */
export interface PageRoute {
    readonly lane: string;
    /** The id its payload names: a local id while its lane still holds the page's writes, else the server's. */
    readonly pageId: string;
    /** The create it waits for while that hasn't resolved. */
    readonly dependsOn: string | null;
}

/**
 * Where page `pageId`'s next write goes, as chats' `chatWriteRoute` does: a
 * page made on the phone keeps its local lane while that holds a write, so
 * writes under the server id join it and stay in order behind the ones
 * written before the create resolved; once it holds none, the server id's
 * lane. A write to a page whose create hasn't resolved waits for it.
 */
export function pageRoute(outbox: RouteOutbox, pageId: string, laneOf: (id: string) => string = pageLane): PageRoute {
    if (isLocalPage(pageId)) {
        const server = outbox.resolve(PAGE_IDS, pageId);
        if (server === null) {
            return { lane: laneOf(pageId), pageId, dependsOn: pageId };
        }
        if (!holdsWrite(outbox, laneOf(pageId))) {
            return pageRoute(outbox, server, laneOf);
        }
        return { lane: laneOf(pageId), pageId, dependsOn: null };
    }
    for (const lane of new Set([...outbox.rows(), ...outbox.unsent()].map((write) => write.lane))) {
        const local = lane.startsWith(laneOf('')) ? lane.slice(laneOf('').length) : '';
        if (isLocalPage(local) && outbox.resolve(PAGE_IDS, local) === pageId) {
            return { lane, pageId: local, dependsOn: null };
        }
    }
    return { lane: laneOf(pageId), pageId, dependsOn: null };
}

/** Every lane of page `pageId`'s writes in a family: its own, and a resolved local id's that still holds some. */
export function pageWriteLanes(outbox: RouteOutbox, pageId: string, laneOf: (id: string) => string = pageLane) {
    const lanes = new Set([laneOf(pageId)]);
    const server = isLocalPage(pageId) ? outbox.resolve(PAGE_IDS, pageId) : pageId;
    if (server !== null) {
        lanes.add(laneOf(server));
        lanes.add(pageRoute(outbox, server, laneOf).lane);
    }
    return lanes;
}

/** Refusals' codes, which the Unsent list words. */
export const PAGE_SAVE_REFUSALS = {
    /** 410: "This page was deleted", with Save as a new page. */
    deleted: 'page-deleted',
    /** 403: the person may no longer edit it. */
    refused: 'page-refused',
    /** A 400 from a rule this build doesn't know. */
    invalid: 'page-invalid',
    /** Changed elsewhere and not merged clean: the conflict banner's. */
    conflict: 'conflict',
    /** Its page was made offline and never created. */
    noPage: 'no-page',
} as const;

export { mergePageText, type PageText, sameText } from './page-merge';

export interface PageSaveBase {
    /** The text the draft started from; null when the phone didn't hold that revision. */
    readonly title: string | null;
    readonly content: string | null;
    readonly revision: number;
}

export interface PageSavePayload {
    readonly spaceId: string;
    /** The page's id, or its local id while its create hasn't resolved. */
    readonly pageId: string;
    readonly base: PageSaveBase;
    readonly draft: PageText;
    /** Revisions this phone's saves made: a 409 that finds one sends again with no merge. */
    readonly ownRevisions: readonly number[];
    /**
     * Every base revision the row has been on, its first (the editor's) first:
     * a rebase on a 409 or an `amend` adds one. The save's answer moves an
     * editor on any of them (`onSaved`), so the next save goes against the page
     * the server holds. Older rows lack it: their base revision stands in.
     */
    readonly bases?: readonly number[];
}

/** The server's page beside a conflict: what Keep theirs keeps and Use mine replaces. */
export interface PageTheirs extends PageText {
    readonly spaceId: string;
    readonly revision: number;
}

/** A save refused as a conflict, in `unsent` in lane `page-conflict:<pageId>`: ours, and theirs. */
export interface PageConflictPayload extends PageSavePayload {
    readonly theirs: PageTheirs;
}

/** How a page's text moved under the editor (`onLanded`): merged clean, or theirs under the banner. */
export type PageLanding = 'merged' | 'conflict';

/** What page-manage.ts's create carries that a save folds into while it is queued. */
export interface PageCreateText extends PageText {
    readonly spaceId: string;
    readonly pageId: string;
}

const bounded = (revisions: readonly number[]) => [...new Set(revisions)].slice(-OWN_REVISIONS_KEPT);

/** The base revisions a row has been on (`bases`), the current one included. */
const basesOf = (payload: PageSavePayload) => bounded([...(payload.bases ?? []), payload.base.revision]);

function parse<P>(text: string): P | null {
    try {
        return JSON.parse(text) as P;
    } catch {
        return null;
    }
}

/** Whether a save's payload is a conflict's: ours with theirs beside it. */
export function isPageConflict(payload: PageSavePayload): payload is PageConflictPayload {
    const theirs = (payload as Partial<PageConflictPayload>).theirs as Partial<PageTheirs> | undefined;
    return (
        theirs !== undefined &&
        theirs !== null &&
        typeof theirs.spaceId === 'string' &&
        typeof theirs.title === 'string' &&
        typeof theirs.content === 'string' &&
        typeof theirs.revision === 'number'
    );
}

/** A save's payload, or a throw for one this build can't read. */
export function decodeSave(text: string): PageSavePayload {
    const value = JSON.parse(text) as Partial<PageSavePayload> | null;
    const base = value?.base as Partial<PageSaveBase> | undefined;
    const draft = value?.draft as Partial<PageText> | undefined;
    const textOrNull = (field: unknown) => field === null || typeof field === 'string';
    if (
        !value ||
        typeof value.spaceId !== 'string' ||
        typeof value.pageId !== 'string' ||
        !base ||
        typeof base.revision !== 'number' ||
        !textOrNull(base.title) ||
        !textOrNull(base.content) ||
        !draft ||
        typeof draft.title !== 'string' ||
        typeof draft.content !== 'string' ||
        !Array.isArray(value.ownRevisions) ||
        !value.ownRevisions.every((revision) => typeof revision === 'number') ||
        (value.bases !== undefined &&
            (!Array.isArray(value.bases) || !value.bases.every((revision) => typeof revision === 'number')))
    ) {
        throw new TypeError('Not a page save.');
    }
    return value as PageSavePayload;
}

const encode = (payload: PageSavePayload) => ({ payload: JSON.stringify(payload), payloadVersion: VERSION });

// ---- Saving --------------------------------------------------------------------

type SaveOutbox = Pick<Outbox, 'rows' | 'unsent' | 'resolve' | 'enqueue' | 'update' | 'remove' | 'revisionOf'>;

export interface PageSavesOptions {
    readonly outbox: SaveOutbox;
    readonly drafts: Pick<Drafts, 'read' | 'write' | 'enqueueFromDraft'>;
    /** The page at `revision` as the phone holds it (the body), or null: a first row's base. */
    readonly baseOf: (spaceId: string, pageId: string, revision: number) => Promise<Page | null>;
    /** A fresh UUID (expo-crypto): a new row's id and key. */
    readonly newId: () => string;
}

/** The editor draft's sink (page-drafts.ts), and `savePage` for a draft given directly. */
export interface PageSaves extends PageDraftSink {
    /** Saves `draft` for page `pageId`: folds it into the queued row, queues one, or nothing when it is the base. */
    savePage(pageId: string, draft: EditorDraft): Promise<PageSaveResult>;
}

/** What a save did. */
export type PageSaveResult = 'queued' | 'folded' | 'removed' | 'none' | 'invalid';

type Plan =
    | { readonly action: 'fold'; readonly row: OutboxRow; readonly payload: PageSavePayload }
    | { readonly action: 'fold-create'; readonly row: OutboxRow; readonly payload: PageCreateText }
    | {
          readonly action: 'new';
          readonly lane: string;
          readonly base: Omit<PageSavePayload, 'draft'>;
          readonly dependsOn: string | null;
      };

export function createPageSaves(options: PageSavesOptions): PageSaves {
    const { outbox, drafts, baseOf, newId } = options;
    /** Each page's saves, one at a time: a plan is never made beside another's write. */
    const chains = new Map<string, Promise<unknown>>();
    const inOrder = <T>(pageId: string, task: () => Promise<T>): Promise<T> => {
        const result = (chains.get(pageId) ?? Promise.resolve()).then(task, task);
        const tail = result.then(
            () => undefined,
            () => undefined,
        );
        chains.set(pageId, tail);
        void tail.then(() => {
            if (chains.get(pageId) === tail) {
                chains.delete(pageId);
            }
        });
        return result;
    };

    /** Where page `pageId`'s next draft goes: its lane's newest row while queued, else a new row behind it. */
    const plan = async (editorPageId: string, draft: EditorDraft): Promise<Plan> => {
        // A page made on the phone: its local lane while that holds writes (page-manage.ts's `pageRoute`).
        const route = pageRoute(outbox, editorPageId);
        const { lane, pageId } = route;
        const writes = outbox
            .rows()
            .filter((row) => row.lane === lane && (row.kind === PAGE_SAVE_KIND || row.kind === PAGE_CREATE_KIND));
        const newest = writes.at(-1);
        if (newest?.kind === PAGE_CREATE_KIND) {
            const create = parse<PageCreateText>(newest.payload);
            if (create !== null && newest.state === 'queued') {
                return { action: 'fold-create', row: newest, payload: create };
            }
            if (create !== null) {
                // Gone to the server: the save waits for it, against the page it creates.
                return {
                    action: 'new',
                    lane,
                    base: {
                        spaceId: create.spaceId,
                        pageId,
                        base: { title: pageTitle(create.title), content: create.content, revision: 1 },
                        ownRevisions: [1],
                        bases: [1],
                    },
                    dependsOn: newest.id,
                };
            }
        }
        const ahead = newest === undefined ? null : parse<PageSavePayload>(newest.payload);
        if (newest !== undefined && ahead !== null) {
            if (newest.state === 'queued') {
                return { action: 'fold', row: newest, payload: ahead };
            }
            // In flight or unknown: the server will have its draft. Its settle moves the revision (`amend`).
            return {
                action: 'new',
                lane,
                base: {
                    spaceId: ahead.spaceId,
                    pageId,
                    base: {
                        title: pageTitle(ahead.draft.title),
                        content: ahead.draft.content,
                        revision: ahead.base.revision,
                    },
                    ownRevisions: ahead.ownRevisions,
                    bases: basesOf(ahead),
                },
                dependsOn: null,
            };
        }
        const page = await baseOf(draft.spaceId, pageId, draft.revision);
        return {
            action: 'new',
            lane,
            base: {
                spaceId: draft.spaceId,
                pageId,
                base:
                    page === null
                        ? { title: null, content: null, revision: draft.revision }
                        : { title: page.title, content: page.content, revision: page.revision },
                ownRevisions: [],
                bases: [draft.revision],
            },
            dependsOn: route.dependsOn,
        };
    };

    /** Writes `draft` into the queued row, if the page has one; null when it has none that can change. */
    const fold = async (pageId: string, draft: EditorDraft): Promise<PageSaveResult | null> => {
        for (;;) {
            const next = await plan(pageId, draft);
            if (next.action === 'new') {
                return null;
            }
            const revision = outbox.revisionOf(next.row.id);
            const text = { title: draft.title, content: draft.content };
            if (next.action === 'fold-create') {
                const payload = JSON.stringify({ ...next.payload, ...text });
                if (await outbox.update(next.row.id, { payload, payloadVersion: next.row.payloadVersion }, revision)) {
                    return 'folded';
                }
                continue;
            }
            if (sameText(text, next.payload.base)) {
                // Back to the base: nothing to send.
                if ((await outbox.remove(next.row.id, revision)) !== null) {
                    return 'removed';
                }
                continue;
            }
            if (await outbox.update(next.row.id, encode({ ...next.payload, draft: text }), revision)) {
                return 'folded';
            }
            // It started going, or another write changed it: plan again.
        }
    };

    const save = async (pageId: string, draft: EditorDraft, fromDrafts: boolean): Promise<PageSaveResult> => {
        if (pageDraftError({ title: draft.title, content: draft.content, parentId: null }) !== undefined) {
            return 'invalid';
        }
        const scope = pageDraft(pageId);
        const clear = (text: string) => {
            // The row holds it now; text typed meanwhile stays for the next save.
            if (fromDrafts && drafts.read(scope).text === text) {
                drafts.write(scope, '');
            }
        };
        const sentText = fromDrafts ? drafts.read(scope).text : '';
        const folded = await fold(pageId, draft);
        if (folded !== null) {
            clear(sentText);
            return folded;
        }
        const next = await plan(pageId, draft);
        if (next.action !== 'new') {
            // A row became queued meanwhile: fold into it.
            return save(pageId, draft, fromDrafts);
        }
        const text = { title: draft.title, content: draft.content };
        if (sameText(text, next.base.base)) {
            clear(sentText);
            return 'none';
        }
        const build = (payloadText: PageText) => {
            const id = newId();
            return {
                id,
                lane: next.lane,
                kind: PAGE_SAVE_KIND,
                ...encode({ ...next.base, draft: payloadText }),
                idempotencyKey: newId(),
                ...(next.dependsOn === null ? {} : { dependsOn: next.dependsOn }),
            };
        };
        if (!fromDrafts) {
            await outbox.enqueue(build(text));
            return 'queued';
        }
        // From the editor draft: it clears in the insert's transaction, sending what it holds then.
        const row = await drafts.enqueueFromDraft(scope, (held) => {
            const latest = parseEditorDraft(held);
            return build(latest === undefined ? text : { title: latest.title, content: latest.content });
        });
        return row === null ? 'none' : 'queued';
    };

    return {
        savePage: (pageId, draft) => inOrder(pageId, () => save(pageId, draft, false)),
        updateQueued: (pageId, draft) =>
            inOrder(pageId, async () => {
                if (pageDraftError({ title: draft.title, content: draft.content, parentId: null }) !== undefined) {
                    return false;
                }
                return (await fold(pageId, draft)) !== null;
            }),
        save: (pageId) =>
            inOrder(pageId, async () => {
                const text = drafts.read(pageDraft(pageId)).text;
                const draft = text ? parseEditorDraft(text) : undefined;
                if (draft !== undefined) {
                    await save(pageId, draft, true);
                }
            }),
    };
}

/**
 * A queued save of a page this phone just moved (page-manage.ts's
 * `page-move`, whose answer is `page`): it goes to the page's new Space, and
 * when its base is the text the server now has (a move changes no words), it
 * takes the move's revision as its base and among its own, so it needs no 409
 * first. Null for another kind's row, or one this build can't read.
 */
export function movedSave(other: Pick<OutboxRow, 'kind' | 'payload'>, page: Page) {
    if (other.kind !== PAGE_SAVE_KIND) {
        return null;
    }
    let next: PageSavePayload;
    try {
        next = decodeSave(other.payload);
    } catch {
        return null;
    }
    if (!sameText(page, next.base)) {
        return encode({ ...next, spaceId: page.spaceId });
    }
    return encode({
        ...next,
        spaceId: page.spaceId,
        base: { title: page.title, content: page.content, revision: page.revision },
        ownRevisions: bounded([...next.ownRevisions, page.revision]),
        bases: bounded([...basesOf(next), page.revision]),
    });
}

// ---- The kind ------------------------------------------------------------------

export interface PageSaveKindOptions {
    /** The pages' bodies: a saved page is handed off there. */
    readonly bodies?: { put(key: string, page: Page): Promise<void> };
    /** cache.db's rows: the Space's list takes the saved page's summary. */
    readonly cache?: Pick<SnapshotCache, 'confirm'>;
    /**
     * Page `pageId` saved by a row whose base was on revisions `from` (`bases`),
     * now `page`: an editor on one of them moves to `page`'s revision and Space
     * (page-drafts.ts's `rebase`).
     */
    readonly onSaved?: (pageId: string, from: readonly number[], page: Page) => void;
    /**
     * A 409 merged: page `pageId`'s editor, on one of the revisions
     * `from` and still holding `sent` (the draft the save sent) or an edit of
     * it, moves onto `to` (the merge, or theirs under the conflict banner) at
     * `to`'s revision (page-drafts.ts's `landed`); `merged` also says "Merged with changes
     * made elsewhere".
     */
    readonly onLanded?: (
        pageId: string,
        from: readonly number[],
        sent: PageText,
        to: PageTheirs,
        how: PageLanding,
    ) => void;
    /** A fresh UUID: a rewrite's idempotency key. */
    readonly newId?: () => string;
}

const pagePath = (spaceId: string, pageId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`;

/** The page an answer carries, or null for a body that isn't one. */
function pageOf(body: unknown): Page | null {
    const page = body as Partial<Page> | null;
    return page &&
        typeof page === 'object' &&
        typeof page.id === 'string' &&
        typeof page.spaceId === 'string' &&
        typeof page.title === 'string' &&
        typeof page.content === 'string' &&
        typeof page.revision === 'number'
        ? (page as Page)
        : null;
}

/** A save's answers before the outbox's defaults (never the server's text). */
function saveAnswer(answer: Answer): ClassifierAction | undefined {
    switch (answer.status) {
        case 409:
            return { action: 'merge' };
        case 404:
            return { action: 'relocate' };
        case 410:
            return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.deleted };
        case 403:
            return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.refused };
        case 400:
            return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.invalid };
        default:
            return undefined;
    }
}

let fallbackKeys = 0;

export function pageSaveKind(options: PageSaveKindOptions = {}): OutboxKind<unknown> {
    const { bodies, cache, onSaved, onLanded } = options;
    const newId = options.newId ?? (() => `page-save-key-${Date.now()}-${(fallbackKeys += 1)}`);

    /** The page the server has, handed to the list and the body; the next row and the editor rebase on it. */
    const saved = (write: OutboxWrite<PageSavePayload>, page: Page): SendOutcome => {
        const { payload } = write;
        const own = bounded([...payload.ownRevisions, page.revision]);
        return {
            action: 'done',
            handOff: async () => {
                try {
                    await Promise.all([
                        bodies?.put(pageBodyKey(page.spaceId, page.id), page),
                        cache?.confirm({
                            collection: PAGES,
                            scope: page.spaceId,
                            key: page.id,
                            value: pageSummary(page),
                            version: page.revision,
                        }),
                    ]);
                } finally {
                    // The server holds the page at its new revision even when a cache write failed:
                    // an editor left on the old base would send its next save as a false conflict.
                    onSaved?.(payload.pageId, basesOf(payload), page);
                }
            },
            amend: (other) => {
                if (other.kind !== PAGE_SAVE_KIND) {
                    return null;
                }
                const next = decodeSave(other.payload);
                let draft: PageText = next.draft;
                if (next.base.title !== null && next.base.content !== null && !sameText(page, next.base)) {
                    // The page isn't the text this row went on from (a merge landed): merged again
                    // onto it, or, not clean, left on its old base for its own 409 and the banner.
                    const remerged = mergePageText(next.base, next.draft, page);
                    if (remerged === null) {
                        return null;
                    }
                    draft = remerged;
                }
                return encode({
                    ...next,
                    spaceId: page.spaceId,
                    base: { title: page.title, content: page.content, revision: page.revision },
                    draft,
                    ownRevisions: bounded([...next.ownRevisions, ...own]),
                    bases: bounded([...basesOf(next), page.revision]),
                });
            },
        };
    };

    /** Theirs as the phone's copy: the body and the Space's list. */
    const showTheirs = (theirs: Page) =>
        Promise.all([
            bodies?.put(pageBodyKey(theirs.spaceId, theirs.id), theirs),
            cache?.confirm({
                collection: PAGES,
                scope: theirs.spaceId,
                key: theirs.id,
                value: pageSummary(theirs),
                version: theirs.revision,
            }),
        ]);

    /** Ours to `unsent` in the page's conflict lane, theirs beside it. */
    const conflictAs = (payload: PageSavePayload, pageId: string, theirs: Page): UnsentAs => {
        const conflict: PageConflictPayload = {
            ...payload,
            theirs: {
                spaceId: theirs.spaceId,
                title: theirs.title,
                content: theirs.content,
                revision: theirs.revision,
            },
        };
        return {
            reason: PAGE_SAVE_REFUSALS.conflict,
            lane: pageConflictLane(pageId),
            payload: JSON.stringify(conflict),
        };
    };

    const landed = (payload: PageSavePayload, pageId: string, to: PageTheirs, how: PageLanding) => {
        try {
            onLanded?.(pageId, basesOf(payload), payload.draft, to, how);
        } catch {
            // The editor's own trouble never changes what the outbox does with the row.
        }
    };

    const rewrite = (payload: PageSavePayload, reason: string): Extract<SendOutcome, { action: 'rewrite' }> => ({
        action: 'rewrite',
        ...encode(payload),
        idempotencyKey: newId(),
        reason,
    });

    /** GETs the page: the page, `gone` (404 or 410, by status), or a throw to try again later. */
    const read = async (context: OutboxContext, spaceId: string, pageId: string): Promise<Page | 404 | 410> => {
        const path = pagePath(spaceId, pageId);
        const answer = await readAnswer(await context.fetch(path), context.signal);
        if (answer.status === 404 || answer.status === 410) {
            return answer.status;
        }
        const page = answer.status === 200 ? pageOf(answer.body) : null;
        if (page === null) {
            // Can't compare now: the outbox tries again after the back-off.
            throw new NetworkError(path);
        }
        return page;
    };

    /** A 409: ours already, a base that only moved, or a merge. */
    const conflict = async (
        write: OutboxWrite<PageSavePayload>,
        context: OutboxContext,
        pageId: string,
    ): Promise<SendOutcome> => {
        const { payload } = write;
        const theirs = await read(context, payload.spaceId, pageId);
        if (theirs === 404) {
            return relocate(write, context, pageId);
        }
        if (theirs === 410) {
            return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.deleted };
        }
        if (sameText(payload.draft, theirs)) {
            // A success whose answer was lost, or the same edit made elsewhere.
            return saved(write, theirs);
        }
        if (payload.ownRevisions.includes(theirs.revision) || sameText(theirs, payload.base)) {
            // Our own earlier save, or a change that left the text alone (a move): send again on it.
            return rewrite(
                {
                    ...payload,
                    spaceId: theirs.spaceId,
                    base: { title: theirs.title, content: theirs.content, revision: theirs.revision },
                    bases: bounded([...basesOf(payload), theirs.revision]),
                },
                'rebased',
            );
        }
        // The last rewrite the outbox allows is spent (it kept changing meanwhile): the banner, not a
        // merge the outbox would refuse after the editor and the toast had taken it.
        const spent = (write.rewrites ?? 0) >= OUTBOX_REWRITE_MAX;
        const merged = spent ? null : mergePageText(payload.base, payload.draft, theirs);
        if (merged === null) {
            // The screen shows theirs under the banner; ours waits beside it.
            await showTheirs(theirs);
            landed(payload, pageId, theirs, 'conflict');
            return { action: 'unsent', ...conflictAs(payload, pageId, theirs) };
        }
        // Theirs is the phone's copy now: the merge shows over it while it goes (`pendingPageText`).
        await showTheirs(theirs);
        landed(payload, pageId, { ...theirs, ...merged }, 'merged');
        if (sameText(merged, theirs)) {
            // Everything of ours was there already: nothing to send.
            return saved(write, theirs);
        }
        return {
            ...rewrite(
                {
                    ...payload,
                    spaceId: theirs.spaceId,
                    base: { title: theirs.title, content: theirs.content, revision: theirs.revision },
                    draft: merged,
                    bases: bounded([...basesOf(payload), theirs.revision]),
                },
                'merged',
            ),
            // Only if the outbox's count ever ran ahead of `write.rewrites`: the banner still.
            exhausted: conflictAs(payload, pageId, theirs),
        } as SendOutcome;
    };

    /** A 404: the page moved to another Space (sent again there), or it is gone for the person. */
    const relocate = async (
        write: OutboxWrite<PageSavePayload>,
        context: OutboxContext,
        pageId: string,
    ): Promise<SendOutcome> => {
        const path = pageLocationPath(pageId);
        const answer = await readAnswer(await context.fetch(path), context.signal);
        if (answer.status === 404 || answer.status === 410) {
            return { action: 'unsent', reason: UNSENT_GONE };
        }
        const spaceId = (answer.body as { spaceId?: unknown } | null)?.spaceId;
        if (answer.status !== 200 || typeof spaceId !== 'string' || spaceId === '') {
            throw new NetworkError(path);
        }
        if (spaceId === write.payload.spaceId) {
            // Listed where it was: the 404 was a moment's. The back-off, then again.
            return { action: 'retry', reason: 'relocate' };
        }
        return rewrite({ ...write.payload, spaceId }, 'relocated');
    };

    const kind: OutboxKind<PageSavePayload> = {
        kind: PAGE_SAVE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decodeSave,
        async send(write, context) {
            const { payload } = write;
            const pageId = isLocalPage(payload.pageId) ? context.resolve(PAGE_IDS, payload.pageId) : payload.pageId;
            if (pageId === null) {
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.noPage };
            }
            if (sameText(payload.draft, payload.base)) {
                // Nothing to change: a no-op is never sent.
                return { action: 'done' };
            }
            const response = await context.fetch(pagePath(payload.spaceId, pageId), {
                method: 'PATCH',
                json: {
                    title: pageTitle(payload.draft.title),
                    content: payload.draft.content,
                    expectedRevision: payload.base.revision,
                },
            });
            const answer = await readAnswer(response, context.signal);
            const action = classify(answer, {
                method: 'PATCH',
                ambiguous: write.ambiguous === true,
                special: saveAnswer,
            });
            switch (action.action) {
                case 'delivered': {
                    const page = pageOf(answer.body);
                    // A 2xx without the page: the server has it; the next pull brings it.
                    return page === null ? { action: 'done' } : saved(write, page);
                }
                case 'merge':
                    return conflict(write, context, pageId);
                case 'relocate':
                    return relocate(write, context, pageId);
                case 'back-off':
                    return action.delayMs === null
                        ? { action: 'retry', reason: action.reason }
                        : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
                case 'retry':
                case 'unknown':
                case 'unsent':
                    return action;
                default:
                    return { action: 'unsent', reason: `http-${answer.status}` };
            }
        },
        overlay({ payload }, scope): Overlay | null {
            if (isPageConflict(payload)) {
                // Under the banner the screen shows theirs.
                return null;
            }
            const pageId = isLocalPage(payload.pageId)
                ? (scope.resolve(PAGE_IDS, payload.pageId) ?? payload.pageId)
                : payload.pageId;
            return { collection: PAGES, key: pageId, mode: 'patch', value: { title: pageTitle(payload.draft.title) } };
        },
    };
    return kind as OutboxKind<unknown>;
}

/** How page saves look on screen (`overlaysOf`), without anything that sends. */
export const PAGE_SAVE_VIEWS: readonly OverlayKind<unknown>[] = [pageSaveKind()];

/** A page's newest pending text: what its body shows over the server's while a save waits. */
export interface PendingPageText extends PageText {
    /** The write's state: a refused one ("Couldn't save") or one still going. */
    readonly state: 'pending' | 'unsent';
    readonly reason: string | null;
}

/** Page `pageId`'s newest save waiting or refused, or null: the body screen shows its draft. */
export function pendingPageText(outbox: RouteOutbox, pageId: string): PendingPageText | null {
    const lanes = pageWriteLanes(outbox, pageId);
    const inLanes = (write: { readonly lane: string; readonly kind: string }) =>
        lanes.has(write.lane) && write.kind === PAGE_SAVE_KIND;
    const pending = outbox.rows().filter(inLanes).at(-1);
    const payload = pending === undefined ? null : parse<PageSavePayload>(pending.payload);
    if (payload !== null) {
        return { ...payload.draft, state: 'pending', reason: pending?.lastError ?? null };
    }
    const refused = outbox.unsent().filter(inLanes).at(-1);
    const held = refused === undefined ? null : parse<PageSavePayload>(refused.payload);
    return held === null || refused === undefined ? null : { ...held.draft, state: 'unsent', reason: refused.reason };
}
