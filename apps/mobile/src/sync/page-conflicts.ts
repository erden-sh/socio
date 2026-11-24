import { lineChanges, type LineChange } from '@socio/shared/pages/merge-lines';
import { pageTitle } from '@socio/shared/pages/page-draft';

import type { Outbox, UnsentWrite } from './outbox';
import type { EditorText, PageLanded } from './page-drafts';
import { createPage, type CreatePageOptions } from './page-manage';
import {
    decodeSave,
    isLocalPage,
    isPageConflict,
    mergePageText,
    PAGE_IDS,
    PAGE_SAVE_KIND,
    PAGE_SAVE_REFUSALS,
    type PageLanding,
    pageLane,
    type PageSavePayload,
    type PageText,
    type PageTheirs,
} from './page-save';
import { pageOfLane } from './pages';

// A page's conflicts (v1's simple version): a
// save the server answered 409 for, whose edits didn't merge clean with
// someone else's (page-save.ts), waits in `unsent` in lane
// `page-conflict:<pageId>` with both texts, while the phone shows theirs and
// new saves go on from it. The banner offers:
//
// - **Use mine** (after "Replace the changes made elsewhere?"): ours, re-based
//   on the page the phone holds now (else theirs as the conflict kept it), with
//   any edits made on theirs since merged on top, goes back to `page:<pageId>` in its place and is sent again (`editUnsent`, then
//   `retryUnsent`); an editor on that revision moves onto it (page-drafts.ts's `landed`).
//   When those edits don't merge clean, ours stays on theirs as Compare
//   showed it, so the server refuses it and the banner comes back with the
//   page as it is now: nothing the person hasn't seen is replaced.
// - **Keep theirs** (after a confirm): ours is discarded.
// - **Save mine as a new page**: ours as a new page (page-manage.ts's `createPage`, in
//   the page's own Space unless the person picks another), then discarded;
//   once per conflict, however often it is tapped.
// - **Compare**: theirs against ours, line by line (shared's `lineChanges`).
//
// Nothing is discarded without the person's word. Who changed it isn't said:
// the screens say "someone else".
//
// No React Native: tests/sync runs it under Node.

/** A conflict on a page, as the banner shows it. */
export interface PageConflict {
    /** The refused write's id: the actions take it. */
    readonly id: string;
    /** The page, by the id its lane names (the server's once its create resolved). */
    readonly pageId: string;
    readonly spaceId: string;
    readonly mine: PageText;
    /** The server's page as the conflict found it; null for a conflict an older build refused (no texts kept). */
    readonly theirs: PageTheirs | null;
    readonly payload: PageSavePayload;
    readonly createdAt: number;
}

type ConflictOutbox = Pick<Outbox, 'unsent' | 'resolve'>;

const serverId = (outbox: Pick<Outbox, 'resolve'>, pageId: string) =>
    isLocalPage(pageId) ? (outbox.resolve(PAGE_IDS, pageId) ?? pageId) : pageId;

function conflictOf(outbox: ConflictOutbox, write: UnsentWrite): PageConflict | null {
    if (write.kind !== PAGE_SAVE_KIND || write.reason !== PAGE_SAVE_REFUSALS.conflict) {
        return null;
    }
    const lanePage = pageOfLane(write.lane);
    let payload: PageSavePayload;
    try {
        payload = decodeSave(write.payload);
    } catch {
        return null;
    }
    return {
        id: write.id,
        pageId: serverId(outbox, lanePage ?? payload.pageId),
        spaceId: payload.spaceId,
        mine: payload.draft,
        theirs: isPageConflict(payload) ? payload.theirs : null,
        payload,
        createdAt: write.createdAt,
    };
}

/** Every page conflict waiting for the person, oldest first. */
export function allPageConflicts(outbox: ConflictOutbox): PageConflict[] {
    return outbox.unsent().flatMap((write) => conflictOf(outbox, write) ?? []);
}

/** Page `pageId`'s conflicts (by its local or server id), oldest first: the banner shows the oldest. */
export function pageConflicts(outbox: ConflictOutbox, pageId: string): PageConflict[] {
    const id = serverId(outbox, pageId);
    return allPageConflicts(outbox).filter((conflict) => conflict.pageId === id);
}

type ResolveOutbox = Pick<Outbox, 'unsent' | 'resolve' | 'editUnsent' | 'retryUnsent' | 'discardUnsent'>;

export interface TakeMineOptions {
    readonly outbox: ResolveOutbox;
    /** A fresh UUID (expo-crypto): the send's idempotency key. */
    readonly newId: () => string;
    /** The page as the phone holds it now (its body), or null: ours re-bases on it, else on theirs as kept. */
    readonly current: (PageTheirs & { readonly id: string }) | null;
    /** page-drafts.ts's `landed`: an editor on the page moves onto ours. */
    readonly landed?: (pageId: string, from: readonly number[], sent: EditorText, to: PageLanded) => void;
}

/**
 * Use mine: ours, re-based on the page the phone holds, goes back to the
 * page's lane in its place and is sent (the server's revision check still
 * guards it: changed again meanwhile, it merges or comes back here). False
 * when it is gone, or there is nothing to re-base on.
 */
export async function takeMine(conflict: PageConflict, options: TakeMineOptions): Promise<boolean> {
    const { outbox, newId, landed } = options;
    const on = options.current !== null && options.current.id === conflict.pageId ? options.current : conflict.theirs;
    if (on === null) {
        return false;
    }
    const { theirs: _theirs, ...rest } = conflict.payload as PageSavePayload & { theirs?: unknown };
    // Edits made on theirs since (the person's own, typed under the banner, or someone's the poll
    // brought) stay on top of mine when they merge clean.
    const merged =
        conflict.theirs !== null && on !== conflict.theirs
            ? mergePageText(conflict.theirs, conflict.mine, on)
            : conflict.mine;
    // Not clean: mine stays on theirs as Compare showed it, so the server's revision check refuses
    // it and the banner comes back with what is on the page now. Never mine over edits unseen.
    const onto = merged === null && conflict.theirs !== null ? conflict.theirs : on;
    const draft = merged ?? conflict.mine;
    const next: PageSavePayload = {
        ...rest,
        draft,
        spaceId: onto.spaceId,
        base: { title: onto.title, content: onto.content, revision: onto.revision },
        bases: [...new Set([...(rest.bases ?? []), rest.base.revision, onto.revision])].slice(-20),
    };
    const edited = await outbox.editUnsent(conflict.id, {
        payload: JSON.stringify(next),
        payloadVersion: 1,
        lane: pageLane(conflict.pageId),
    });
    if (!edited || !(await outbox.retryUnsent(conflict.id, newId()))) {
        return false;
    }
    if (merged !== null) {
        // The editor shows theirs under the banner: it moves onto ours, its edits since on top.
        landed?.(conflict.pageId, [on.revision], on, { ...draft, spaceId: on.spaceId, revision: on.revision });
    }
    return true;
}

/** Keep theirs: ours is discarded (after the banner's confirm). */
export async function keepTheirs(outbox: Pick<Outbox, 'discardUnsent'>, conflict: PageConflict): Promise<boolean> {
    return (await outbox.discardUnsent(conflict.id)) !== null;
}

/** Saves as a new page under way, by conflict: a second tap gets the first's. */
const savingAsNew = new Map<string, Promise<string | null>>();

/**
 * Save mine as a new page: ours as a new page in `spaceId` (the page's own by
 * default), queued before ours is discarded, so a kill between them leaves
 * both, never neither. The new page's local id; null when the conflict is
 * gone already (saved, kept or used). One at a time per conflict, so a
 * second tap makes no second page. The Unsent list's Save as a new page
 * takes it too, for a save whose page is gone: any refused write
 * with what the person wrote.
 */
export function saveMineAsNewPage(
    conflict: Pick<PageConflict, 'id' | 'mine'>,
    options: Omit<CreatePageOptions, 'title' | 'content' | 'parentId' | 'outbox'> & {
        readonly outbox: CreatePageOptions['outbox'] & Pick<Outbox, 'discardUnsent'>;
    },
): Promise<string | null> {
    const running = savingAsNew.get(conflict.id);
    if (running !== undefined) {
        return running;
    }
    const task = (async () => {
        if (!options.outbox.unsent().some((write) => write.id === conflict.id)) {
            return null;
        }
        const { localId } = await createPage({
            ...options,
            title: pageTitle(conflict.mine.title),
            content: conflict.mine.content,
            parentId: null,
        });
        await options.outbox.discardUnsent(conflict.id);
        return localId;
    })();
    savingAsNew.set(conflict.id, task);
    const forget = () => {
        savingAsNew.delete(conflict.id);
    };
    task.then(forget, forget);
    return task;
}

/** Compare: how ours differs from theirs, line by line (fenced blocks whole); empty with no theirs. */
export function compareConflict(conflict: PageConflict): {
    readonly title: { readonly theirs: string; readonly mine: string } | null;
    readonly lines: LineChange[];
} {
    if (conflict.theirs === null) {
        return { title: null, lines: [] };
    }
    const theirsTitle = pageTitle(conflict.theirs.title);
    const mineTitle = pageTitle(conflict.mine.title);
    return {
        title: theirsTitle === mineTitle ? null : { theirs: theirsTitle, mine: mineTitle },
        lines: lineChanges(conflict.theirs.content, conflict.mine.content),
    };
}

/**
 * What a clean merge changed under the person: the
 * text their save sent, and the merge it now stands on. The difference is the
 * change made elsewhere, which the toast's "See what changed" shows.
 */
export interface PageMergeChange {
    readonly before: PageText;
    readonly after: PageText;
}

type LandingListener = (pageId: string, how: PageLanding, change: PageMergeChange) => void;

/** Each 409 that moved a page under its editor: the screens' "Merged with changes made elsewhere". */
export interface PageLandings {
    /** The save kind's `onLanded` calls this, after page-drafts.ts's `landed`: what the save sent, and where it landed. */
    note(pageId: string, how: PageLanding, sent: PageText, to: PageText): void;
    /** Each landing, until the unsubscribe. */
    subscribe(listener: LandingListener): () => void;
}

export function createPageLandings(onError: (error: unknown) => void = () => {}): PageLandings {
    const listeners = new Set<LandingListener>();
    return {
        note(pageId, how, sent, to) {
            const change: PageMergeChange = {
                before: { title: sent.title, content: sent.content },
                after: { title: to.title, content: to.content },
            };
            for (const listener of [...listeners]) {
                try {
                    listener(pageId, how, change);
                } catch (error) {
                    onError(error);
                }
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
