import { pageDraftError, pageTitle } from '@socio/shared/pages/page-draft';
import { coverUrl, type Page, type PageCover, pageExcerpt, pageSummary } from '@socio/shared/pages/page-library';

import { NetworkError } from '../net/errors';
import { keptPage, LAST_SCREEN_KEY, pageScreen } from '../shell/last-screen';

import type { Drafts } from './chat-drafts';
import { answeredWithError } from './issue-create';
import type { CheckOutcome, NewOutboxWrite, Outbox, OutboxContext, OutboxKind, OutboxRow, SendOutcome } from './outbox';
import { UNSENT_GONE } from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer, type WriteMethod } from './outbox-answers';
import type { Overlay } from './outbox-overlay';
import { pageDraft } from './page-drafts';
import {
    coverLane,
    isLocalPage,
    movedSave,
    newLocalPageId,
    PAGE_CREATE_KIND,
    PAGE_IDS,
    PAGE_SAVE_REFUSALS,
    pageLane,
    pageRoute,
    sameText,
} from './page-save';
import type { PageMove } from './page-store';
import { pageBodyKey, pageLocationPath, PAGES } from './pages';
import { serverSince } from './server-clock';
import type { SnapshotCache } from './snapshot-cache';
import type { FileUploads } from './upload-file';
import type { ViewState } from './view-state';

// Creating, moving and deleting pages, and their covers. Four kinds beside
// page-save.ts's `page-save`:
//
// - **`page-create`** (`POST /api/spaces/:id/pages`): a page made on the phone
//   has a local id (`local-page-<uuid>`, the row's id) until the create
//   resolves (`ids`, `page`). Its row is in lane `page:<local>`, where the page's
//   saves fold into it while it is queued, and a child waits for its parent's
//   create (`dependsOn`); the parent's local id is resolved as it is sent. Not
//   safe to repeat: its check (the server takes no client ids) pulls the Space's
//   list fresh and takes a page with the same trimmed title and parent, made
//   by the person, created at or after `serverSince(serverAt)`, absent from
//   the ids the phone held as it was made (`known`) and no other write's,
//   then reads each candidate's body for the same content. One is sent; two
//   are "Couldn't confirm this was sent" with their ids for View; none goes
//   again after a request with no answer and waits for the person after an
//   error answer. With no bound at all (no `serverAt`, no `known`), even one
//   waits for the person: it may be an older page just like it.
// - **`page-move`** (`POST …/pages/:id/move`), lane `page:<id>`, behind the
//   page's saves: safe to repeat. A 409 is the server's "changed during the
//   move" and goes again; a 404 or 400 reads where the page is
//   (`/api/pages/:id/location`): already in the target is done (a lost
//   success), elsewhere is a `rewrite` from there, gone is `UNSENT_GONE`. Its
//   answer moves the page's summary and body to the new Space, re-keys the last
//   screen (`onMoved`), moves an editor on the revision before it (page-drafts.ts's rebase)
//   only when the body held before it has the answer's text (the move rewrites
//   image fences to copies; else the editor's next save meets a 409), and `amend`s the lane's queued saves (`movedSave`: the new Space, and the
//   move's revision as base and own when their base is the text it moved).
//   Under a parent made on the phone, it waits (`waiting-parent`) while the
//   parent's create row is in the outbox (`holdsRow`), and is `noParent` only
//   once that row is gone or refused.
// - **`page-delete`** (`DELETE …/pages/:id`), lane `page:<id>`: it pulls the
//   Space's list first, and a subpage the confirm didn't name sends it to
//   `unsent` ("This page has new subpages"); `?subpages=true` only when the
//   confirm named some. 404 (nowhere the person reads) and 410 are done; 403
//   and 409 are `unsent`. Deletes are soft on the server. A page made on the
//   phone whose create hasn't gone is dropped with its writes instead, and
//   nothing is sent.
// - **`page-cover`** in lane `cover:<id>` (a cover carries no revision, so it
//   never waits on a save): set from an upload to the person's Files (upload-file.ts's
//   `prepare`, then `PUT …/cover { fileId }`), removed (`DELETE …/cover`), or
//   put back by the removal's Undo (`PUT …/cover { embedId: previous }`). A
//   newer change replaces a queued one in place (a replaced upload is
//   forgotten), and an Undo of a removal still queued just takes it out.
//
// Routes follow `pageRoute`: a page made on the phone keeps its local lane while
// that holds writes. Re-keying (`createLocalPages`, a new chat's rules): once a create
// resolves, the page's editor draft and the last screen move to the server
// id, and `subscribe` tells the screen to swap its route param.
//
// No React Native: tests/sync runs it under Node.

export const PAGE_MOVE_KIND = 'page-move';
export const PAGE_DELETE_KIND = 'page-delete';
export const PAGE_COVER_KIND = 'page-cover';
const VERSION = 1;
/** A move's retry reason while its new parent, made on the phone, waits for its create. */
export const PAGE_MOVE_WAITING_PARENT = 'waiting-parent';

/** The web's title for a page made without one (NewPageDialog). */
export const UNTITLED_PAGE = 'Untitled page';

/** Refusals' codes beside page-save.ts's (`PAGE_SAVE_REFUSALS`), which the Unsent list words. */
export const PAGE_MANAGE_REFUSALS = {
    /** A subpage whose parent was made on the phone and never created. */
    noParent: 'no-parent-page',
    /** 410 on a create or a move: the parent page was deleted. */
    parentDeleted: 'page-parent-deleted',
    /** A move whose target Space or parent page the person can't reach. */
    moveTarget: 'page-move-target',
    /** The Space's list has a subpage the delete's confirm didn't name. */
    newSubpages: 'page-new-subpages',
    /** 409 on a delete: it has subpages. */
    hasSubpages: 'page-has-subpages',
    /** 403 on a delete: only an admin or its creator may delete it (and only an admin others' subpages). */
    deleteRefused: 'page-delete-refused',
    /** 413 and 415 on a cover. */
    coverTooLarge: 'cover-too-large',
    coverType: 'cover-type',
    /** The image a cover names is no longer there (the file, or the Space's image for an Undo). */
    coverGone: 'cover-gone',
} as const;

// ---- Payloads -------------------------------------------------------------------

export interface PageCreatePayload {
    readonly spaceId: string;
    /** The local id: the row's id too. */
    readonly pageId: string;
    /** As typed: the server trims the title, and the check compares it trimmed. */
    readonly title: string;
    readonly content: string;
    /** The parent's id, a local one while its create hasn't resolved; null at the top. */
    readonly parentId: string | null;
    /** The person (the scope's app user id): the check's `createdBy`. */
    readonly createdBy: string;
    /** The scope's newest Date header as the page was made, or null. */
    readonly serverAt: number | null;
    /** The Space's page ids the phone held as the page was made: never this create's. */
    readonly known: readonly string[];
}

export interface PageMovePayload {
    /** The Space it is moved from (a relocation rewrites it). */
    readonly spaceId: string;
    readonly pageId: string;
    readonly to: string;
    /** The new parent in `to`, a local id while its create hasn't resolved; null at the top. */
    readonly parentId: string | null;
}

export interface PageDeletePayload {
    readonly spaceId: string;
    readonly pageId: string;
    /** The subpages the confirm named ("This page has 2 subpages"), ids local or not; empty for none. */
    readonly subpages: readonly string[];
}

export type PageCoverChange =
    | { readonly kind: 'set'; readonly uploadId: string }
    | { readonly kind: 'remove' }
    | { readonly kind: 'restore'; readonly embedId: string };

export interface PageCoverPayload {
    readonly spaceId: string;
    readonly pageId: string;
    readonly change: PageCoverChange;
    /** The cover before the first change in the row: a removal's Undo puts it back. */
    readonly previous: PageCover | null;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isId = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function object(text: string): Record<string, unknown> {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Not a page write.');
    }
    return value as Record<string, unknown>;
}

function decodeCreate(text: string): PageCreatePayload {
    const value = object(text);
    if (
        !isId(value.spaceId) ||
        !isId(value.pageId) ||
        !isString(value.title) ||
        !isString(value.content) ||
        !(value.parentId === null || isId(value.parentId)) ||
        !isString(value.createdBy) ||
        !(value.serverAt === null || typeof value.serverAt === 'number') ||
        !isStrings(value.known)
    ) {
        throw new TypeError('Not a page create.');
    }
    return value as unknown as PageCreatePayload;
}

function decodeMove(text: string): PageMovePayload {
    const value = object(text);
    if (
        !isId(value.spaceId) ||
        !isId(value.pageId) ||
        !isId(value.to) ||
        !(value.parentId === null || isId(value.parentId))
    ) {
        throw new TypeError('Not a page move.');
    }
    return value as unknown as PageMovePayload;
}

function decodeDelete(text: string): PageDeletePayload {
    const value = object(text);
    if (!isId(value.spaceId) || !isId(value.pageId) || !isStrings(value.subpages)) {
        throw new TypeError('Not a page delete.');
    }
    return value as unknown as PageDeletePayload;
}

function decodeCover(text: string): PageCoverPayload {
    const value = object(text);
    const change = value.change as Partial<Record<string, unknown>> | null | undefined;
    const previous = value.previous as Partial<PageCover> | null | undefined;
    const changeOk =
        typeof change === 'object' &&
        change !== null &&
        ((change.kind === 'set' && isId(change.uploadId)) ||
            change.kind === 'remove' ||
            (change.kind === 'restore' && isId(change.embedId)));
    if (
        !isId(value.spaceId) ||
        !isId(value.pageId) ||
        !changeOk ||
        !(previous === null || (typeof previous === 'object' && isId(previous.id) && isString(previous.url)))
    ) {
        throw new TypeError('Not a page cover.');
    }
    return value as unknown as PageCoverPayload;
}

const encode = (payload: object) => ({ payload: JSON.stringify(payload), payloadVersion: VERSION });

/** Why a page write wasn't queued: the web's words, the draft kept. */
export class PageWriteError extends Error {
    override readonly name = 'PageWriteError';
}

// ---- Writing --------------------------------------------------------------------

type WriteOutbox = Pick<Outbox, 'rows' | 'unsent' | 'resolve' | 'enqueue' | 'update' | 'remove' | 'revisionOf'>;

interface WriteOptions {
    readonly outbox: WriteOutbox;
    /** A fresh UUID (expo-crypto): local ids, row ids and keys. */
    readonly newId: () => string;
}

export interface CreatePageOptions extends WriteOptions {
    readonly spaceId: string;
    /** Its parent page, a local id or a server one; null or absent at the top. */
    readonly parentId?: string | null;
    /** The web's "Untitled page" when absent or blank. */
    readonly title?: string;
    readonly content?: string;
    /** The scope's app user id. */
    readonly createdBy: string;
    /** The scope's `serverClock.lastDate()`. */
    readonly serverAt: number | null;
    /** The ids of the Space's pages the phone holds now (its summaries). */
    readonly known: Iterable<string>;
}

/**
 * Queues a new page: its local id, which the screen opens at once (an
 * editor on it starts at revision 1, the create's). Throws PageWriteError for
 * a title or text the server would refuse.
 */
export async function createPage(options: CreatePageOptions): Promise<{ localId: string; row: OutboxRow }> {
    const { localId, write } = pageCreateWrite(options);
    const row = await options.outbox.enqueue(write);
    return { localId, row };
}

/**
 * A new page's outbox write and local id, not queued: `createPage` queues it,
 * and a page review's "Save as a new page" queues it from the review's edits
 * (`enqueueFromDraft`, so the edits leave `drafts` in the insert's
 * transaction). Throws PageWriteError for a title or text the server would refuse.
 */
export function pageCreateWrite(
    options: Omit<CreatePageOptions, 'outbox'> & { readonly outbox: Pick<Outbox, 'rows' | 'unsent' | 'resolve'> },
): {
    localId: string;
    write: NewOutboxWrite;
} {
    const { outbox, newId, spaceId, createdBy, serverAt } = options;
    const parentId = options.parentId ?? null;
    const title = options.title !== undefined && pageTitle(options.title) !== '' ? options.title : UNTITLED_PAGE;
    const content = options.content ?? '';
    const invalid = pageDraftError({ title, content, parentId });
    if (invalid !== undefined) {
        throw new PageWriteError(invalid);
    }
    const localId = newLocalPageId(newId);
    // A subpage of a page made on the phone waits for its parent's create.
    const parent = parentId === null ? null : pageRoute(outbox, parentId);
    const payload: PageCreatePayload = {
        spaceId,
        pageId: localId,
        title,
        content,
        parentId: parent?.pageId ?? null,
        createdBy,
        serverAt,
        known: [...new Set(options.known)],
    };
    return {
        localId,
        write: {
            id: localId,
            lane: pageLane(localId),
            kind: PAGE_CREATE_KIND,
            ...encode(payload),
            idempotencyKey: newId(),
            dependsOn: parent?.dependsOn ?? null,
        },
    };
}

export interface MovePageOptions extends WriteOptions {
    /** Where the page is now. */
    readonly spaceId: string;
    readonly pageId: string;
    readonly to: string;
    readonly parentId?: string | null;
}

/** Queues moving a page (with its subpages) to another Space, behind its saves. */
export async function movePage(options: MovePageOptions): Promise<OutboxRow> {
    const { outbox, newId, spaceId, to } = options;
    if (to === spaceId) {
        throw new PageWriteError('This page is already in that Space.');
    }
    const route = pageRoute(outbox, options.pageId);
    const parentId = options.parentId ?? null;
    const parent = parentId === null ? null : pageRoute(outbox, parentId);
    const payload: PageMovePayload = { spaceId, pageId: route.pageId, to, parentId: parent?.pageId ?? null };
    return outbox.enqueue({
        id: newId(),
        lane: route.lane,
        kind: PAGE_MOVE_KIND,
        ...encode(payload),
        idempotencyKey: newId(),
        dependsOn: route.dependsOn ?? parent?.dependsOn ?? null,
    });
}

export interface DeletePageOptions extends WriteOptions {
    readonly spaceId: string;
    readonly pageId: string;
    /** The subpages the confirm named (from the cached tree), or none. */
    readonly subpages?: readonly string[];
    /** upload-file.ts's uploads: a cover change dropped with a page never created forgets its upload. */
    readonly uploads: Pick<FileUploads, 'forget'>;
    /** The drafts: a page never created takes its editor draft (`page:<local>`) with it. */
    readonly drafts: Pick<Drafts, 'read' | 'write'>;
}

/** A dropped page's editor draft goes too: nothing would ever save it. A newer build's (locked) stays. */
function dropEditorDraft(drafts: Pick<Drafts, 'read' | 'write'>, localId: string) {
    const scope = pageDraft(localId);
    const record = drafts.read(scope);
    if (record.text && !record.locked) {
        drafts.write(scope, '');
    }
}

/**
 * A page made on the phone whose create hasn't gone yet (queued, never sent)
 * is dropped here instead of created then deleted: its create and the writes
 * of its own lanes (saves, moves, covers) go, newest first so none starts
 * once the create is out. False, with nothing dropped but those already
 * taken out, when the create went (or goes now), or another page's write
 * waits on it (a subpage made under it): the delete is queued then.
 */
async function dropNeverCreated(
    outbox: WriteOutbox,
    localId: string,
    uploads: Pick<FileUploads, 'forget'>,
): Promise<boolean> {
    const rows = outbox.rows();
    const create = rows.find((row) => row.id === localId && row.kind === PAGE_CREATE_KIND);
    if (create?.state !== 'queued') {
        return false;
    }
    const lanes = new Set([pageLane(localId), coverLane(localId)]);
    const others = rows.filter((row) => row.id !== localId && (lanes.has(row.lane) || row.dependsOn === localId));
    if (others.some((row) => !lanes.has(row.lane) || row.state !== 'queued')) {
        return false;
    }
    for (const row of others.reverse()) {
        const removed = await outbox.remove(row.id, outbox.revisionOf(row.id));
        if (removed === null) {
            return false;
        }
        if (removed.kind === PAGE_COVER_KIND) {
            const change = decodeCover(removed.payload).change;
            if (change.kind === 'set') {
                await uploads.forget(change.uploadId);
            }
        }
    }
    return (await outbox.remove(localId, outbox.revisionOf(localId))) !== null;
}

/**
 * Queues deleting a page, behind its saves; with the subpages its confirm
 * named. A page made on the phone whose create hasn't gone is dropped
 * instead, with nothing sent and its editor draft cleared: null then.
 */
export async function deletePage(options: DeletePageOptions): Promise<OutboxRow | null> {
    const { outbox, newId, spaceId } = options;
    const route = pageRoute(outbox, options.pageId);
    if (route.dependsOn !== null && (await dropNeverCreated(outbox, route.dependsOn, options.uploads))) {
        dropEditorDraft(options.drafts, route.dependsOn);
        return null;
    }
    const payload: PageDeletePayload = { spaceId, pageId: route.pageId, subpages: [...(options.subpages ?? [])] };
    return outbox.enqueue({
        id: newId(),
        lane: route.lane,
        kind: PAGE_DELETE_KIND,
        ...encode(payload),
        idempotencyKey: newId(),
        dependsOn: route.dependsOn,
    });
}

export interface PageCoverOptions extends WriteOptions {
    readonly spaceId: string;
    readonly pageId: string;
    /** The cover the screen shows now: a removal's Undo puts it back. */
    readonly current: PageCover | null;
    /** upload-file.ts's uploads: a queued cover's upload that a newer change replaces is forgotten (its copy goes). */
    readonly uploads: Pick<FileUploads, 'forget'>;
}

/** What a cover change did: queued a row, changed the queued one, or took it out (an Undo before it went). */
export type PageCoverResult = 'queued' | 'folded' | 'removed';

const sameChange = (a: PageCoverChange, b: PageCoverChange) =>
    a.kind === b.kind &&
    (a.kind !== 'set' || b.kind !== 'set' || a.uploadId === b.uploadId) &&
    (a.kind !== 'restore' || b.kind !== 'restore' || a.embedId === b.embedId);

/** Queues a cover change in lane `cover:<id>`: a queued one takes the newest change in place. */
async function changeCover(options: PageCoverOptions, change: PageCoverChange): Promise<PageCoverResult> {
    const { outbox, newId, spaceId, current } = options;
    for (;;) {
        const route = pageRoute(outbox, options.pageId, coverLane);
        const queued = outbox
            .rows()
            .filter((row) => row.lane === route.lane)
            .at(-1);
        if (queued?.kind === PAGE_COVER_KIND && queued.state === 'queued') {
            let held: PageCoverPayload | null = null;
            try {
                held = decodeCover(queued.payload);
            } catch {
                held = null;
            }
            if (held !== null) {
                const revision = outbox.revisionOf(queued.id);
                const back =
                    change.kind === 'restore' && held.change.kind === 'remove' && held.previous?.id === change.embedId;
                if (back) {
                    // The removal's Undo before it went: nothing to send.
                    if ((await outbox.remove(queued.id, revision)) !== null) {
                        return 'removed';
                    }
                    continue;
                }
                if (sameChange(held.change, change)) {
                    return 'folded';
                }
                const next = encode({ ...held, change });
                if (await outbox.update(queued.id, next, revision)) {
                    if (held.change.kind === 'set') {
                        // Its image will never be the cover: the phone's copy goes (upload-file.ts's `forget`).
                        await options.uploads.forget(held.change.uploadId);
                    }
                    return 'folded';
                }
                continue;
            }
        }
        const payload: PageCoverPayload = { spaceId, pageId: route.pageId, change, previous: current };
        await outbox.enqueue({
            id: newId(),
            lane: route.lane,
            kind: PAGE_COVER_KIND,
            ...encode(payload),
            idempotencyKey: newId(),
            dependsOn: route.dependsOn,
        });
        return 'queued';
    }
}

/** Sets a page's cover from an upload to the person's Files (upload-file.ts's `add`, its local id). */
export const setPageCover = (options: PageCoverOptions & { readonly uploadId: string }) =>
    changeCover(options, { kind: 'set', uploadId: options.uploadId });

/** Removes a page's cover; the toast's Undo is `restorePageCover` with `current`'s id. */
export const removePageCover = (options: PageCoverOptions) => changeCover(options, { kind: 'remove' });

/** Puts a removed cover back (`{ embedId: previous }`), or takes the removal out while it waits. */
export const restorePageCover = (options: PageCoverOptions & { readonly embedId: string }) =>
    changeCover(options, { kind: 'restore', embedId: options.embedId });

// ---- The kinds ------------------------------------------------------------------

export interface PageManageKindOptions {
    /**
     * The pages' bodies: an answer's page is handed off there. `read` gives the copy
     * held, with no network: a move rebases an editor only when the text before it was the same.
     */
    readonly bodies?: { put(key: string, page: Page): Promise<void>; read?(key: string): Promise<Page | null> };
    /** cache.db's rows: the Space's list takes the answer's summary. */
    readonly cache?: Pick<SnapshotCache, 'confirm' | 'rows'>;
    /** Uploads to the person's Files (upload-file.ts): a cover's image goes up first. */
    readonly uploads?: Pick<FileUploads, 'prepare' | 'resolve' | 'forget'>;
    /** An editor on one of the revisions `from` moves to `page` (page-drafts.ts's rebase, as page-save.ts's `onSaved`). */
    readonly onSaved?: (pageId: string, from: readonly number[], page: Page) => void;
    /** This phone's move landed: the last screen and the screens follow the page (the pages store's `noteMoved`). */
    readonly onMoved?: (move: PageMove) => void;
    /** Pulls a Space's list (its moved subpages, a delete's subtree). */
    readonly pull?: (spaceId: string) => void;
    /**
     * Whether the outbox still holds row `id` (queued, in flight or held; not
     * refused): a move under a parent made on the phone waits while that
     * parent's create row is there. Without it, an unresolved parent is `noParent`.
     */
    readonly holdsRow?: (id: string) => boolean;
    /** A fresh UUID: a rewrite's idempotency key. */
    readonly newId?: () => string;
}

const spacePages = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/pages`;
const pagePath = (spaceId: string, pageId: string) => `${spacePages(spaceId)}/${encodeURIComponent(pageId)}`;

/** The page an answer carries, or null for a body that isn't one. */
function pageOf(body: unknown): Page | null {
    const page = body as Partial<Page> | null;
    return page &&
        typeof page === 'object' &&
        isId(page.id) &&
        isId(page.spaceId) &&
        isString(page.title) &&
        isString(page.content) &&
        typeof page.revision === 'number'
        ? (page as Page)
        : null;
}

interface ListedPage {
    readonly id: string;
    readonly parentId: string | null;
    readonly title: string;
    readonly createdBy: string | null;
    readonly createdAt: number;
}

/** A Space's live pages, fresh (no ETag): 404 when the person can't read it. A failure throws, to go again. */
async function listSpace(context: OutboxContext, spaceId: string): Promise<ListedPage[] | 404> {
    const path = spacePages(spaceId);
    const answer = await readAnswer(await context.fetch(path), context.signal);
    if (answer.status === 404) {
        return 404;
    }
    if (answer.status !== 200 || !Array.isArray(answer.body)) {
        throw new NetworkError(path);
    }
    return (answer.body as Partial<ListedPage>[]).filter(
        (page): page is ListedPage =>
            typeof page === 'object' &&
            page !== null &&
            isId(page.id) &&
            (page.parentId === null || isId(page.parentId)) &&
            isString(page.title) &&
            typeof page.createdAt === 'number',
    );
}

/** Where page `pageId` is now: its Space, `gone` (nowhere the person reads), or a throw to go again. */
async function locate(context: OutboxContext, pageId: string): Promise<string | 'gone'> {
    const path = pageLocationPath(pageId);
    const answer = await readAnswer(await context.fetch(path), context.signal);
    if (answer.status === 404 || answer.status === 410) {
        return 'gone';
    }
    const spaceId = (answer.body as { spaceId?: unknown } | null)?.spaceId;
    if (answer.status !== 200 || !isId(spaceId)) {
        throw new NetworkError(path);
    }
    return spaceId;
}

/** A request's own answers, then the outbox's defaults, as an outcome; `delivered` and the kind's own go to `on`. */
function outcome(
    action: ClassifierAction,
    status: number,
    on: Partial<Record<'delivered' | 'merge' | 'relocate', () => Promise<SendOutcome> | SendOutcome>>,
): Promise<SendOutcome> | SendOutcome {
    switch (action.action) {
        case 'delivered':
        case 'merge':
        case 'relocate':
            return on[action.action]?.() ?? { action: 'unsent', reason: `http-${status}` };
        case 'back-off':
            return action.delayMs === null
                ? { action: 'retry', reason: action.reason }
                : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
        case 'retry':
        case 'unknown':
        case 'unsent':
            return action;
        default:
            return { action: 'unsent', reason: `http-${status}` };
    }
}

async function request(
    context: OutboxContext,
    path: string,
    method: WriteMethod,
    ambiguous: boolean,
    special: (answer: Answer) => ClassifierAction | undefined,
    json?: unknown,
): Promise<{ answer: Answer; action: ClassifierAction }> {
    const response = await context.fetch(path, { method, ...(json === undefined ? {} : { json }) });
    const answer = await readAnswer(response, context.signal);
    return { answer, action: classify(answer, { method, ambiguous, special }) };
}

/** A local id resolved through `ids`: null while (or because) its create never resolved. */
const serverPage = (context: Pick<OutboxContext, 'resolve'>, id: string) =>
    isLocalPage(id) ? context.resolve(PAGE_IDS, id) : id;

/** The four kinds, given to the scope beside page-save.ts's `pageSaveKind`. */
export function pageManageKinds(options: PageManageKindOptions = {}): OutboxKind<unknown>[] {
    const { bodies, cache, uploads, onSaved, onMoved, pull, holdsRow } = options;
    let fallbackKeys = 0;
    const newId = options.newId ?? (() => `page-manage-key-${Date.now()}-${(fallbackKeys += 1)}`);

    /** The page the server answered, into the body and the Space's list. */
    const keep = async (page: Page) => {
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
    };
    const drop = async (spaceId: string, ids: readonly string[]) => {
        await Promise.all(ids.map((key) => cache?.confirm({ collection: PAGES, scope: spaceId, key, deleted: true })));
    };
    const rewrite = (payload: object, reason: string): SendOutcome => ({
        action: 'rewrite',
        ...encode(payload),
        idempotencyKey: newId(),
        reason,
    });

    // ---- page-create

    /** A create's answers before the outbox's defaults (issue-create's rules for a proxy's page). */
    const createAnswer = ({ status, code, unreadable }: Answer): ClassifierAction | undefined => {
        switch (status) {
            case 400:
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.invalid };
            case 403:
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.refused };
            case 404:
                // The Space, or the parent, is nowhere the person reads.
                return { action: 'unsent', reason: UNSENT_GONE };
            case 410:
                return { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.parentDeleted };
            default:
                break;
        }
        if (status === 503 && !unreadable && code !== 'draining') {
            return { action: 'retry', reason: 'unavailable' };
        }
        if ((status === 502 || status === 503 || status === 504) && code !== 'draining') {
            // A proxy's page may come after the server made the page: only the check can tell.
            return { action: 'unknown', reason: 'away' };
        }
        return undefined;
    };
    const created = (page: Page): Omit<Extract<SendOutcome, { action: 'done' }>, 'action'> => ({
        serverId: page.id,
        handOff: () => keep(page),
    });

    const create: OutboxKind<PageCreatePayload> = {
        kind: PAGE_CREATE_KIND,
        payloadVersion: VERSION,
        repeatable: false,
        creates: PAGE_IDS,
        decode: decodeCreate,
        async send({ payload }, context) {
            const parentId = payload.parentId === null ? null : serverPage(context, payload.parentId);
            if (payload.parentId !== null && parentId === null) {
                return { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.noParent };
            }
            const { answer, action } = await request(
                context,
                spacePages(payload.spaceId),
                'POST',
                false,
                createAnswer,
                { title: pageTitle(payload.title), content: payload.content, parentId },
            );
            return outcome(action, answer.status, {
                delivered: () => {
                    const page = pageOf(answer.body);
                    // A 2xx without the page: the check finds it.
                    return page === null
                        ? { action: 'unknown', reason: `http-${answer.status}` }
                        : { action: 'done', ...created(page) };
                },
            });
        },
        async check({ row, payload }, context): Promise<CheckOutcome> {
            const parentId = payload.parentId === null ? null : serverPage(context, payload.parentId);
            const listed = await listSpace(context, payload.spaceId);
            if (listed === 404) {
                // Nowhere the person reads: the send's 404 says so.
                return { action: 'not-sent' };
            }
            const since = serverSince(payload.serverAt);
            const known = new Set(payload.known);
            const title = pageTitle(payload.title);
            const candidates = listed.filter(
                (page) =>
                    !known.has(page.id) &&
                    page.parentId === parentId &&
                    page.createdBy === payload.createdBy &&
                    pageTitle(page.title) === title &&
                    (since === null || page.createdAt >= since) &&
                    !context.claimed(PAGE_IDS, page.id),
            );
            // Told apart by content (two "Untitled page" made offline): each candidate's body.
            const found: Page[] = [];
            for (const candidate of candidates) {
                const answer = await readAnswer(
                    await context.fetch(pagePath(payload.spaceId, candidate.id)),
                    context.signal,
                );
                if (answer.status === 404 || answer.status === 410) {
                    continue;
                }
                const page = answer.status === 200 ? pageOf(answer.body) : null;
                if (page === null) {
                    throw new NetworkError(pagePath(payload.spaceId, candidate.id));
                }
                if (page.content === payload.content) {
                    found.push(page);
                }
            }
            const bounded = since !== null || known.size > 0;
            if (found.length === 1 && bounded) {
                return { action: 'sent', ...created(found[0]!) };
            }
            if (found.length > 0) {
                return { action: 'unconfirmed', candidates: found.map((page) => page.id) };
            }
            // None, on a fresh list: it never landed, unless an error answer says it may yet.
            return answeredWithError(row.lastError)
                ? { action: 'unconfirmed', candidates: [] }
                : { action: 'not-sent' };
        },
        overlay({ id, row, payload }, scope): Overlay {
            const key = scope.resolve(PAGE_IDS, id) ?? id;
            const parentId =
                payload.parentId === null ? null : (scope.resolve(PAGE_IDS, payload.parentId) ?? payload.parentId);
            const title = pageTitle(payload.title);
            const at = row?.createdAt ?? 0;
            return {
                collection: PAGES,
                key,
                mode: 'insert',
                value: {
                    id: key,
                    spaceId: payload.spaceId,
                    parentId,
                    title,
                    excerpt: pageExcerpt(payload.content, title),
                    revision: 0,
                    createdAt: at,
                    updatedAt: at,
                    sourceThreadId: null,
                    createdBy: payload.createdBy,
                    cover: null,
                },
            };
        },
    };

    // ---- page-move

    const moveAnswer = ({ status }: Answer): ClassifierAction | undefined => {
        switch (status) {
            case 409:
                // Its pages changed while it moved (the server's `PageChangedDuringMove`): again.
                return { action: 'retry', reason: 'changed-during-move' };
            case 400:
            case 404:
                return { action: 'relocate' };
            case 403:
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.refused };
            case 410:
                return { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.parentDeleted };
            default:
                return undefined;
        }
    };

    const move: OutboxKind<PageMovePayload> = {
        kind: PAGE_MOVE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decodeMove,
        async send(write, context) {
            const { payload } = write;
            const pageId = serverPage(context, payload.pageId);
            if (pageId === null) {
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.noPage };
            }
            const parentId = payload.parentId === null ? null : serverPage(context, payload.parentId);
            if (payload.parentId !== null && parentId === null) {
                // The parent's create (its row's id is the local id) may still be on its way:
                // the move waits for it. Refused or gone, the parent will never be there.
                return holdsRow?.(payload.parentId)
                    ? { action: 'retry', reason: PAGE_MOVE_WAITING_PARENT }
                    : { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.noParent };
            }
            if (payload.spaceId === payload.to) {
                return { action: 'done' };
            }
            // The text before the move: the server's move rewrites image fences to copies in the
            // new Space, in the move's own revision, so an editor rebases only when nothing changed.
            const before = (await bodies?.read?.(pageBodyKey(payload.spaceId, pageId))) ?? null;
            const { answer, action } = await request(
                context,
                `${pagePath(payload.spaceId, pageId)}/move`,
                'POST',
                write.ambiguous === true,
                moveAnswer,
                { spaceId: payload.to, parentId },
            );
            return outcome(action, answer.status, {
                delivered: () => {
                    const body = answer.body as { page?: unknown; moved?: unknown } | null;
                    const page = pageOf(body?.page);
                    if (page === null) {
                        pull?.(payload.to);
                        return { action: 'done' };
                    }
                    const moved = isStrings(body?.moved) ? body.moved : [page.id];
                    return {
                        action: 'done',
                        handOff: async () => {
                            await drop(payload.spaceId, moved);
                            await keep(page);
                            onMoved?.({ pageId: page.id, from: payload.spaceId, to: page.spaceId });
                            // An editor on the revision before moves to it only when the move changed
                            // no words (its fences weren't rewritten): else its next save's 409 goes
                            // to the page save's conflict path, so it never puts the old Space's images back.
                            // An editor may be open under the local id or the server's.
                            if (before !== null && before.revision === page.revision - 1 && sameText(page, before)) {
                                for (const id of new Set([payload.pageId, page.id])) {
                                    onSaved?.(id, [page.revision - 1], page);
                                }
                            }
                            if (moved.length > 1) {
                                pull?.(page.spaceId);
                            }
                        },
                        amend: (other) => movedSave(other, page),
                    };
                },
                relocate: async () => {
                    const where = await locate(context, pageId);
                    if (where === 'gone') {
                        return { action: 'unsent', reason: UNSENT_GONE };
                    }
                    if (where === payload.to) {
                        // There already: a move whose answer was lost, or someone else's.
                        pull?.(payload.to);
                        return { action: 'done' };
                    }
                    if (where !== payload.spaceId) {
                        return rewrite({ ...payload, spaceId: where }, 'relocated');
                    }
                    // Where it was: the target Space or parent is out of reach, or the move can't be made.
                    return {
                        action: 'unsent',
                        reason: answer.status === 404 ? PAGE_MANAGE_REFUSALS.moveTarget : PAGE_SAVE_REFUSALS.invalid,
                    };
                },
            });
        },
        overlay({ payload }, scope): Overlay {
            const key = scope.resolve(PAGE_IDS, payload.pageId) ?? payload.pageId;
            const parentId =
                payload.parentId === null ? null : (scope.resolve(PAGE_IDS, payload.parentId) ?? payload.parentId);
            return { collection: PAGES, key, mode: 'patch', value: { spaceId: payload.to, parentId } };
        },
    };

    // ---- page-delete

    const deleteAnswer = ({ status }: Answer): ClassifierAction | undefined => {
        switch (status) {
            case 404:
                return { action: 'relocate' };
            case 410:
                return { action: 'delivered' };
            case 403:
                return { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.deleteRefused };
            case 409:
                return { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.hasSubpages };
            default:
                return undefined;
        }
    };

    const remove: OutboxKind<PageDeletePayload> = {
        kind: PAGE_DELETE_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decodeDelete,
        async send(write, context) {
            const { payload } = write;
            const pageId = serverPage(context, payload.pageId);
            if (pageId === null) {
                // Its create never went: there is nothing to delete.
                return { action: 'done' };
            }
            /** Moved since: deleted where it is now; nowhere the person reads is done. */
            const relocate = async (): Promise<SendOutcome> => {
                const where = await locate(context, pageId);
                if (where === 'gone') {
                    return { action: 'done' };
                }
                if (where !== payload.spaceId) {
                    return rewrite({ ...payload, spaceId: where }, 'relocated');
                }
                return { action: 'retry', reason: 'relocate' };
            };
            // The Space's list first: a subpage the confirm didn't name stops it.
            const listed = await listSpace(context, payload.spaceId);
            if (listed === 404) {
                return relocate();
            }
            const named = new Set(payload.subpages.map((id) => serverPage(context, id) ?? id));
            const tree = [pageId];
            for (let at = 0; at < tree.length; at++) {
                tree.push(...listed.filter((page) => page.parentId === tree[at]).map((page) => page.id));
            }
            if (tree.slice(1).some((id) => !named.has(id))) {
                return { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.newSubpages };
            }
            const path = `${pagePath(payload.spaceId, pageId)}${payload.subpages.length > 0 ? '?subpages=true' : ''}`;
            const { answer, action } = await request(context, path, 'DELETE', write.ambiguous === true, deleteAnswer);
            return outcome(action, answer.status, {
                delivered: () => {
                    const deleted = (answer.body as { deleted?: unknown } | null)?.deleted;
                    const ids = isStrings(deleted) && deleted.length > 0 ? deleted : tree;
                    return { action: 'done', handOff: () => drop(payload.spaceId, ids) };
                },
                relocate,
            });
        },
        overlay({ payload }, scope): Overlay {
            const key = scope.resolve(PAGE_IDS, payload.pageId) ?? payload.pageId;
            return { collection: PAGES, key, mode: 'patch', value: { pendingDelete: true } };
        },
    };

    // ---- page-cover

    const coverAnswer = ({ status }: Answer): ClassifierAction | undefined => {
        switch (status) {
            case 404:
                return { action: 'relocate' };
            case 410:
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.deleted };
            case 403:
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.refused };
            case 400:
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.invalid };
            case 413:
                return { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.coverTooLarge };
            case 415:
                return { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.coverType };
            default:
                return undefined;
        }
    };

    const cover: OutboxKind<PageCoverPayload> = {
        kind: PAGE_COVER_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decodeCover,
        async send(write, context) {
            const { payload } = write;
            const { change } = payload;
            const pageId = serverPage(context, payload.pageId);
            if (pageId === null) {
                return { action: 'unsent', reason: PAGE_SAVE_REFUSALS.noPage };
            }
            let json: unknown;
            if (change.kind === 'set') {
                if (!uploads) {
                    return { action: 'unsent', reason: 'upload-missing' };
                }
                // The image goes up to the person's Files first (upload-file.ts).
                const waiting = await uploads.prepare(change.uploadId);
                if (waiting !== null) {
                    return waiting;
                }
                const fileId = uploads.resolve(change.uploadId);
                if (fileId === null) {
                    return { action: 'retry', reason: 'uploading' };
                }
                json = { fileId };
            } else if (change.kind === 'restore') {
                json = { embedId: change.embedId };
            }
            const path = `${pagePath(payload.spaceId, pageId)}/cover`;
            const method = change.kind === 'remove' ? 'DELETE' : 'PUT';
            const { answer, action } = await request(
                context,
                path,
                method,
                write.ambiguous === true,
                coverAnswer,
                json,
            );
            return outcome(action, answer.status, {
                delivered: () => {
                    const page = pageOf(answer.body);
                    return {
                        action: 'done',
                        handOff: async () => {
                            if (page !== null) {
                                await keep(page);
                            } else if (change.kind === 'remove' && cache) {
                                // The answer is `{ previous }`: the list's row loses its cover.
                                const row = cache.rows(PAGES, payload.spaceId).get(pageId);
                                if (row !== undefined) {
                                    const summary = JSON.parse(row.json) as Record<string, unknown>;
                                    await cache.confirm({
                                        collection: PAGES,
                                        scope: payload.spaceId,
                                        key: pageId,
                                        value: { ...summary, cover: null },
                                        ...(typeof row.version === 'number' ? { version: row.version } : {}),
                                    });
                                }
                            }
                            if (change.kind === 'set') {
                                // The file stays in the person's Files; the phone's copy goes.
                                await uploads?.forget(change.uploadId);
                            }
                        },
                    };
                },
                relocate: async () => {
                    const where = await locate(context, pageId);
                    if (where === 'gone') {
                        return { action: 'unsent', reason: UNSENT_GONE };
                    }
                    if (where !== payload.spaceId) {
                        return rewrite({ ...payload, spaceId: where }, 'relocated');
                    }
                    // The page is there: the image is what's missing (a file, or the Space's image for an Undo).
                    return change.kind === 'remove'
                        ? { action: 'done' }
                        : { action: 'unsent', reason: PAGE_MANAGE_REFUSALS.coverGone };
                },
            });
        },
        overlay({ payload }, scope): Overlay {
            const key = scope.resolve(PAGE_IDS, payload.pageId) ?? payload.pageId;
            const { change } = payload;
            const value =
                change.kind === 'set'
                    ? { coverUpload: change.uploadId }
                    : change.kind === 'remove'
                      ? { cover: null }
                      : { cover: { id: change.embedId, url: coverUrl(change.embedId) } };
            return { collection: PAGES, key, mode: 'patch', value };
        },
    };

    return [create, move, remove, cover] as OutboxKind<unknown>[];
}

/** How page writes look on screen (`overlaysOf`), without anything that sends. */
export const PAGE_MANAGE_VIEWS = pageManageKinds();

// ---- Re-keying ------------------------------------------------------------------

/** A page's local id resolved: the server id a screen showing `localId` moves to. */
export type PageResolved = (localId: string, pageId: string) => void;

export interface LocalPages {
    /** Page `id` as a screen or a link opens it: a resolved local id's server id, else `id`. */
    resolve(id: string): string;
    /** Each page whose create resolved (the screen swaps its route param). Returns the unsubscribe. */
    subscribe(listener: PageResolved): () => void;
    dispose(): void;
}

export interface LocalPagesOptions {
    readonly outbox: Pick<Outbox, 'resolve' | 'subscribe'>;
    readonly drafts: Pick<Drafts, 'scopes' | 'rekey' | 'read'>;
    readonly viewState: Pick<ViewState, 'get' | 'set'>;
    readonly onError?: (error: unknown) => void;
}

/**
 * Re-keys what a page's local id named once its create resolves (a new
 * chat's rules): the editor's draft (`page:<local>`) and the last screen
 * (`Page/<spaceId>/<local>`), then tells the screens. Links resolve through
 * `ids` (`resolve`). As it starts it repeats the moves for every local id
 * that resolved before a kill.
 */
export function createLocalPages(options: LocalPagesOptions): LocalPages {
    const { outbox, drafts, viewState, onError = () => {} } = options;
    const listeners = new Set<PageResolved>();
    const serverOf = (localId: string) => outbox.resolve(PAGE_IDS, localId);

    const move = (localId: string, pageId: string) => {
        // A draft already under the server id is newer: the local one stays for its own save (`pageRoute`).
        if (drafts.read(pageDraft(pageId)).text === '') {
            drafts.rekey(pageDraft(localId), pageDraft(pageId));
        }
        const kept = keptPage(viewState.get(LAST_SCREEN_KEY));
        if (kept?.pageId === localId) {
            viewState.set(LAST_SCREEN_KEY, pageScreen(kept.spaceId, pageId));
        }
    };

    const named = new Set<string>();
    const prefix = pageDraft('');
    for (const scope of drafts.scopes()) {
        if (scope.startsWith(prefix)) {
            named.add(scope.slice(prefix.length));
        }
    }
    const kept = keptPage(viewState.get(LAST_SCREEN_KEY));
    if (kept !== null) {
        named.add(kept.pageId);
    }
    for (const id of named) {
        const pageId = isLocalPage(id) ? serverOf(id) : null;
        if (pageId !== null) {
            move(id, pageId);
        }
    }

    const unsubscribe = outbox.subscribe((change) => {
        if (change.type !== 'remove' || !isLocalPage(change.id)) {
            return;
        }
        const pageId = serverOf(change.id);
        if (pageId === null) {
            return;
        }
        move(change.id, pageId);
        for (const listener of [...listeners]) {
            try {
                listener(change.id, pageId);
            } catch (error) {
                onError(error);
            }
        }
    });

    return {
        resolve: (id) => (isLocalPage(id) ? (serverOf(id) ?? id) : id),
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        dispose() {
            unsubscribe();
            listeners.clear();
        },
    };
}
