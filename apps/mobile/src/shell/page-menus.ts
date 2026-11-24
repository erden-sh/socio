import type { PageCover, PageSummary } from '@socio/shared/pages/page-library';
import { isAdmin } from '@socio/shared/roles';
import type { Space, User } from '@socio/shared/types';

import { DELETE, effectiveOverlays, type MenuAction, type NotSaved } from '../chat/long-press';
import type { UnsentWrite } from '../sync/outbox';
import type { OverlayItem } from '../sync/outbox-overlay';
import {
    PAGE_COVER_KIND,
    PAGE_DELETE_KIND,
    PAGE_MANAGE_REFUSALS,
    PAGE_MOVE_KIND,
    UNTITLED_PAGE,
} from '../sync/page-manage';
import { isLocalPage, PAGE_CREATE_KIND } from '../sync/page-save';
import { PAGES } from '../sync/pages';

import { pageTree, type TreeRow } from './space-library';
import { unsentWhy } from './unsent';

// A Space's New page and page menus: each page row's long-press menu, also its
// accessibility actions (Move, Set or Change cover, Remove cover, Delete), the
// web's rule for who may delete (`DeletePageDialog.tsx`'s `canDeletePage`, and
// the server's: only an admin deletes a subtree with others' pages) and its
// confirm's words, the move's Space and parent picker, the library's pages
// with this phone's pending writes laid over (the page writes' overlays), and
// the ones the server refused, said with Retry, Copy and Discard. No React
// Native, so tests/shell runs it under Node.

export const MOVE: MenuAction = { name: 'move', label: 'Move' };
export const SET_COVER: MenuAction = { name: 'set-cover', label: 'Set cover' };
/** The web's words for a page that has one (`PageCover.tsx`). */
export const CHANGE_COVER: MenuAction = { name: 'set-cover', label: 'Change cover' };
export const REMOVE_COVER: MenuAction = { name: 'remove-cover', label: 'Remove cover' };

export const NEW_PAGE = 'New page';
export const NEW_PAGE_LABEL = 'Title';
export const COVER_REMOVED = 'Cover removed';

/**
 * Runs one write at a time: a call while the last one is still in flight is
 * dropped (returns undefined). New page's prompt sends on Save and on the
 * keyboard's Return, and each create gets its own id and idempotency key, so
 * a double tap would otherwise make the page twice.
 */
export function oneAtATime() {
    let busy = false;
    return <T>(run: () => Promise<T>): Promise<T> | undefined => {
        if (busy) {
            return undefined;
        }
        busy = true;
        try {
            return run().finally(() => {
                busy = false;
            });
        } catch (error) {
            busy = false;
            throw error;
        }
    };
}

const titleOf = (page: Pick<PageSummary, 'title'>) => page.title.trim() || UNTITLED_PAGE;

/** A page with this phone's writes laid over: whether one waits, and a cover being uploaded. */
export interface ShownPage extends PageSummary {
    /** A write of this phone waits for the server (a create, move, cover or title). */
    readonly waiting: boolean;
    /** The upload's local id while a new cover goes up, else null. */
    readonly coverUpload: string | null;
}

interface PagePatch {
    spaceId?: string;
    parentId?: string | null;
    title?: string;
    cover?: PageCover | null;
    coverUpload?: string;
    pendingDelete?: boolean;
}

/**
 * The pages with this phone's writes laid over (the page save's and page
 * writes' overlays, oldest first): a page made here is added, a move changes
 * its Space and parent, a delete takes it out, a cover change shows at once. A
 * refused write, and what waits behind it, lays nothing (`effectiveOverlays`):
 * the row shows what the server has, and `pagesNotSaved` says so.
 */
export function withPageWrites(pages: readonly PageSummary[], overlays: readonly OverlayItem[]): ShownPage[] {
    const shown = new Map<string, ShownPage>(
        pages.map((page) => [page.id, { ...page, waiting: false, coverUpload: null }]),
    );
    for (const item of overlays) {
        if (item.collection === PAGES && item.mode === 'insert' && item.state !== 'unsent' && !shown.has(item.key)) {
            shown.set(item.key, { ...(item.value as PageSummary), waiting: item.state !== 'sent', coverUpload: null });
        }
    }
    const deleted = new Set<string>();
    /** Pages a pending move takes to another Space: their subpages go with them. */
    const moved = new Map<string, string>();
    for (const item of effectiveOverlays(overlays, PAGES)) {
        const page = shown.get(item.key);
        if (page === undefined) {
            continue;
        }
        const patch = item.value as PagePatch;
        if (patch.pendingDelete === true) {
            deleted.add(item.key);
            continue;
        }
        if (patch.spaceId !== undefined && patch.spaceId !== page.spaceId) {
            moved.set(item.key, patch.spaceId);
        }
        const { pendingDelete: _, coverUpload, ...fields } = patch;
        shown.set(item.key, {
            ...page,
            ...fields,
            // A cover set from the server's image ends an upload's; a new upload replaces it.
            coverUpload: coverUpload ?? ('cover' in fields ? null : page.coverUpload),
            waiting: page.waiting || item.state !== 'sent',
        });
    }
    // The server moves or deletes a page's subpages with it: shown so at once, not as top-level rows
    // of the old Space until the answer (indefinitely offline).
    const all = [...shown.values()];
    for (const [id, spaceId] of moved) {
        for (const sub of subpagesOf(shown.get(id)!, all)) {
            shown.set(sub.id, { ...shown.get(sub.id)!, spaceId });
        }
    }
    for (const id of [...deleted]) {
        const page = shown.get(id);
        if (page !== undefined) {
            subpagesOf(page, all).forEach((sub) => deleted.add(sub.id));
        }
    }
    return [...shown.values()].filter((page) => !deleted.has(page.id));
}

/**
 * New page's `known` (the page create's check): every page of the Space the
 * server holds, as synced, a page with a pending move, cover or title
 * included. A page made on this phone is never one (its id is local).
 */
export function knownPages(synced: readonly Pick<PageSummary, 'id' | 'spaceId'>[], spaceId: string): string[] {
    return synced.filter((page) => page.spaceId === spaceId && !isLocalPage(page.id)).map((page) => page.id);
}

/** A page's subpages at any depth, in tree order (the web's `subpagesOf`), each once. */
export function subpagesOf<P extends Pick<PageSummary, 'id' | 'parentId'>>(page: P, pages: readonly P[]): P[] {
    const tree: P[] = [page];
    const seen = new Set([page.id]);
    for (let i = 0; i < tree.length; i++) {
        for (const item of pages) {
            if (item.parentId === tree[i]!.id && !seen.has(item.id)) {
                seen.add(item.id);
                tree.push(item);
            }
        }
    }
    return tree.slice(1);
}

/** Who may delete a page, and the subpages that go with it. */
export type DeleteRule =
    | { readonly allowed: true; readonly subpages: readonly ShownPage[] }
    | { readonly allowed: false; readonly subpages: readonly ShownPage[] };

/**
 * The web's rule (`canDeletePage`): an admin (or operator) any page, a member the
 * pages they created; and the server's for a subtree: only an admin deletes
 * one holding others' pages, so a member is offered Delete only when every
 * subpage is theirs too.
 */
export function deleteRule(
    /** The person: their app user id, and their role once the shell has it (else a member's rule). */
    user: { readonly id: string; readonly role?: User['role'] } | null,
    page: ShownPage,
    pages: readonly ShownPage[],
): DeleteRule {
    const own = pages.filter((item) => item.spaceId === page.spaceId);
    const subpages = subpagesOf(page, own);
    if (user === null) {
        return { allowed: false, subpages };
    }
    if (user.role !== undefined && isAdmin({ role: user.role })) {
        return { allowed: true, subpages };
    }
    const mine = (item: ShownPage) => item.createdBy === user.id;
    return { allowed: mine(page) && subpages.every(mine), subpages };
}

/** A page row's menu: Move, the cover's, and Delete where the rule allows. */
export function pageMenu(page: Pick<ShownPage, 'cover' | 'coverUpload'>, deletable: boolean): MenuAction[] {
    const covered = page.cover !== null || page.coverUpload !== null;
    return [
        MOVE,
        covered ? CHANGE_COVER : SET_COVER,
        ...(covered ? [REMOVE_COVER] : []),
        ...(deletable ? [DELETE] : []),
    ];
}

// ---- Delete's confirm (the web's DeletePageDialog) -------------------------------

export const deleteTitle = (page: Pick<PageSummary, 'title'>) => `Delete “${titleOf(page)}”?`;

/** The web's description, then each subpage that goes with it. */
export function deleteMessage(subpages: readonly Pick<PageSummary, 'title'>[]): string {
    const n = subpages.length;
    const lead = n === 0 ? '' : `Its ${n === 1 ? 'subpage' : `${n} subpages`} will be deleted with it. `;
    const sentence = `${lead}It’s removed for everyone in this Space, and links to it say it was deleted. Conversations about it stay in your chats.`;
    return n === 0 ? sentence : `${sentence}\n\n${subpages.map((item) => `• ${titleOf(item)}`).join('\n')}`;
}

export const deleteButton = (subpages: number) => (subpages > 0 ? 'Delete pages' : 'Delete page');

// ---- Move's picker (the web's MovePageDialog, with a parent) ----------------------

export const moveTitle = (page: Pick<PageSummary, 'title'>) => `Move “${titleOf(page)}”`;
export const MOVE_TO = 'Move to';
export const MOVE_UNDER = 'Put it';
export const AT_TOP = 'At the top';
export const NO_OTHER_SPACE = 'There is no other Space to move it to.';

/** The web's line, with the parent the picker adds. */
export function moveLine(subpages: number): string {
    const along = subpages === 0 ? '' : `, with its ${subpages === 1 ? 'subpage' : `${subpages} subpages`}`;
    return `It goes to the Space you pick, at the top or under one of its pages${along}. Its history goes with it, and links to it keep working.`;
}

export const moveButton = (subpages: number) => (subpages > 0 ? 'Move pages' : 'Move page');

/** The Spaces a page may go to: every other one the workspace lists, as it lists them. */
export const moveTargets = (spaces: readonly Space[], spaceId: string): Space[] =>
    spaces.filter((space) => space.id !== spaceId);

/** Where in the chosen Space: the top, then each of its pages as the tree shows them all. */
export function parentChoices(pages: readonly PageSummary[], spaceId: string): TreeRow[] {
    const all = new Set(pages.filter((page) => page.spaceId === spaceId).map((page) => page.id));
    return pageTree(pages, spaceId, all);
}

// ---- What the server refused ------------------------------------------------------

const MANAGE_KINDS: ReadonlySet<string> = new Set([
    PAGE_CREATE_KIND,
    PAGE_MOVE_KIND,
    PAGE_DELETE_KIND,
    PAGE_COVER_KIND,
]);

/** A refused page write: what it says, what Copy takes, and what Retry does. */
export interface PageNotSaved extends NotSaved {
    /** What the person wrote (a new page's title and text), or null: then there is no Copy. */
    readonly copy: string | null;
    /**
     * `confirm-delete` for a delete that met subpages its confirm didn't name:
     * Retry asks again, naming them. Else `retry` sends it as it was.
     */
    readonly again: 'retry' | 'confirm-delete';
    /** The page it was about (resolved where the create has). */
    readonly pageId: string;
    readonly spaceId: string;
}

const VERBS: Readonly<Record<string, string>> = {
    [PAGE_CREATE_KIND]: 'Couldn’t create',
    [PAGE_MOVE_KIND]: 'Couldn’t move',
    [PAGE_DELETE_KIND]: 'Couldn’t delete',
    [PAGE_COVER_KIND]: 'Couldn’t change the cover of',
};

const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The page writes of Space `spaceId` the server refused (their four kinds),
 * oldest first: "Couldn’t delete “Roadmap”." and why in the outbox's words. A
 * page edit's refusal is the editor's (the conflict banner), not the library's.
 */
export function pagesNotSaved(
    unsent: readonly UnsentWrite[],
    pages: readonly PageSummary[],
    spaceId: string,
    resolve: (localId: string) => string | null,
): PageNotSaved[] {
    return [...unsent]
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .flatMap((write) => {
            if (!MANAGE_KINDS.has(write.kind)) {
                return [];
            }
            let payload: Record<string, unknown>;
            try {
                payload = JSON.parse(write.payload) as Record<string, unknown>;
            } catch {
                return [];
            }
            if (payload.spaceId !== spaceId) {
                return [];
            }
            const named = stringOf(payload.pageId) ?? write.id;
            const pageId = resolve(named) ?? named;
            const page = pages.find((item) => item.id === pageId);
            const written = stringOf(payload.title);
            const title =
                page !== undefined ? titleOf(page) : written !== null ? titleOf({ title: written }) : UNTITLED_PAGE;
            const content = stringOf(payload.content)?.trim() ?? '';
            const copy =
                write.kind === PAGE_CREATE_KIND && written !== null
                    ? content === ''
                        ? written
                        : `${written}\n\n${content}`
                    : null;
            return [
                {
                    id: write.id,
                    text: `${VERBS[write.kind]} “${title}”. ${unsentWhy(write.reason)}.`,
                    copy,
                    again:
                        write.kind === PAGE_DELETE_KIND && write.reason === PAGE_MANAGE_REFUSALS.newSubpages
                            ? ('confirm-delete' as const)
                            : ('retry' as const),
                    pageId,
                    spaceId,
                },
            ];
        });
}
