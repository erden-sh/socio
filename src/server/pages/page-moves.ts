import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';
import { LIVE, byDot } from '@socio/data/soft-delete';
import { PageError } from '@socio/foundation/pages/page-error';
import { pageText } from '@socio/shared/pages/page-text';

import { SPACE_NOT_FOUND, type SpaceReader } from '../spaces/contract.js';

import type { PageMove, PageMoveInput, PageMovesShape } from './contract.js';
import type { PageRepositories } from './domain/repositories.js';
import { sqlitePageRepositories } from './infra/sqlite/index.js';
import {
    PageChangedDuringMove,
    type PageMoveMedia,
    type PagePicture,
    findPagePictures,
    mayHavePictures,
    pageImageCopier,
    swapPagePictures,
} from './page-images.js';
import { type Pages } from './pages.js';
import type { PagesWorkspace } from './slices.js';

/** `PageMoves` on the workspace database, beside `Pages`. */
export class SqlitePageMoves implements PageMovesShape {
    private stored?: PageRepositories;
    constructor(
        private db: DatabaseSync,
        private pages: Pages,
    ) {}
    /** Made on first move: the connection's data layer is its own (CB-110). */
    private get repos() {
        return (this.stored ??= sqlitePageRepositories(sqliteData(this.db)));
    }
    /**
     * Moves a page and its live subpages, in one transaction. The page goes
     * under `parentId` (or the root); its subpages keep their places under
     * it. Deleted subpages stay where they were deleted. Each moved page
     * gets a new revision number, so open copies reload it; its title, text
     * and kept revisions are unchanged.
     */
    async move({
        spaceId,
        id,
        to,
        parentId = null,
        expectedRevision,
        now = Date.now(),
        copyImage,
        recheck,
    }: PageMoveInput): Promise<PageMove> {
        // The pictures' places in each page's text (CB-358), found before
        // the unit of work opens, so no page is parsed under the writer's
        // lock, with a turn of the event loop between pages.
        const planned = copyImage ? await this.planPictures(spaceId, id) : undefined;
        // One unit of work: at once, or queued behind one open on the
        // connection; inside the caller's own unit, a savepoint of it.
        return sqliteData(this.db).uow.run(
            async () => {
                // Rights taken away while the pictures were planned refuse
                // the move as the first check would have.
                recheck?.();
                const page = this.pages.get(spaceId, id);
                this.pages.requireSpace(to);
                if (to === spaceId) {
                    throw new PageError('This page is already in that Space.');
                }
                if (expectedRevision !== undefined && page.revision !== expectedRevision) {
                    throw new PageError('This page changed. Reload the latest revision before moving it.', 409);
                }
                // The parent must be a live page there: never one of these.
                if (parentId !== null) {
                    this.pages.get(to, parentId);
                }
                const all = this.pages.list(spaceId);
                const tree = [page];
                for (let i = 0; i < tree.length; i++) {
                    tree.push(...all.filter((item) => item.parentId === tree[i].id));
                }
                // A page planned, or one that may hold pictures now, must be
                // as it was planned: edited (pictures added or taken out),
                // or new in the subtree, since then, the move stops whole
                // (409) and can be tried again.
                if (planned) {
                    for (const item of tree) {
                        const plan = planned.get(item.id);
                        if (plan ? plan.revision !== item.revision : mayHavePictures(item.content)) {
                            throw new PageChangedDuringMove();
                        }
                    }
                }
                const { pages, search, reviews } = this.repos;
                // Each picture copied once, however many fences name it.
                const copies = new Map<string, string | undefined>();
                for (const item of tree) {
                    // Its pictures' copies in the new Space (CB-358), in the
                    // same revision as the move.
                    const pictures = planned?.get(item.id)?.pictures ?? [];
                    for (const picture of pictures) {
                        if (!copies.has(picture.id)) {
                            copies.set(picture.id, await copyImage!(picture.id));
                        }
                    }
                    const content = pictures.length ? swapPagePictures(item.content, pictures, copies) : item.content;
                    const rewritten = content === item.content ? undefined : content;
                    await pages.move(item.id, to, item.id === id ? parentId : item.parentId, now, rewritten);
                    await search.moveSpace(item.id, to);
                    if (rewritten !== undefined) {
                        await search.put({
                            pageId: item.id,
                            spaceId: to,
                            title: item.title,
                            body: pageText(rewritten),
                        });
                    }
                    // A review receipt opens its page where it is now.
                    await reviews.moveSpace(item.id, to);
                }
                // Moving a page never changes who reads a dataset (CB-451):
                // the datasets under the subtree stay in this Space, at its root.
                this.pages.pagesGone(
                    spaceId,
                    tree.map((item) => item.id),
                    null,
                );
                return {
                    page: this.pages.get(to, id),
                    from: spaceId,
                    moved: tree.map((item) => item.id),
                };
            },
            { label: 'move page', savepoint: true },
        );
    }
    /**
     * The pictures of the page and its live subpages, by page id, with the
     * revision they were read at; only pages that may hold any. Read
     * outside any unit of work, yielding between pages.
     */
    private async planPictures(spaceId: string, id: string) {
        const page = this.pages.get(spaceId, id);
        const all = this.pages.list(spaceId);
        const tree = [page];
        for (let i = 0; i < tree.length; i++) {
            tree.push(...all.filter((item) => item.parentId === tree[i].id));
        }
        const planned = new Map<string, { revision: number; pictures: PagePicture[] }>();
        for (const item of tree) {
            if (!mayHavePictures(item.content)) {
                continue;
            }
            await new Promise(setImmediate);
            planned.set(item.id, { revision: item.revision, pictures: findPagePictures(item.content) });
        }
        return planned;
    }
    async locate(id: string) {
        const row = this.db.prepare(`SELECT spaceId FROM pages WHERE id=? AND ${LIVE}`).get(id);
        const spaceId = row ? String(row.spaceId) : undefined;
        return spaceId && this.pages.spaceLive(spaceId) ? spaceId : undefined;
    }
}

/**
 * Who moves a page: a person, or a Dot acting for one, with the Dot as a
 * Space reader in its chat (`WorkspaceStore.socioReader`).
 */
export type PageMover = {
    userId: string;
    dotId?: string;
    reader?: SpaceReader;
};

/**
 * A page move with its checks and its media, the same for the page's
 * "Move to…" and a Dot's `move_space_page`: the person must be able to
 * edit pages in both Spaces, and a Dot must also have been granted both.
 * The pages' pictures and link cards' media (CB-358, CB-362) get copies
 * in the new Space, written into the moved text in the move's own
 * revision, and their covers (CB-308) after it, so its readers see them;
 * a cover whose image is gone is cleared. The move is audited (the Dot's
 * own, `dot:<id>`, when a Dot moved it). `moves` is the root's
 * `PageMoves`.
 */
export async function movePage(
    workspace: PagesWorkspace,
    moves: PageMovesShape,
    media: PageMoveMedia,
    by: PageMover,
    input: Omit<PageMoveInput, 'copyImage' | 'recheck'>,
): Promise<PageMove> {
    const check = () => checkMover(workspace, by, input);
    check();
    // Checked again inside the move, before it writes (CB-358).
    const result = await moves.move({
        ...input,
        copyImage: pageImageCopier(media, by.userId, input.spaceId, input.to),
        recheck: check,
    });
    const subpages = result.moved.length - 1;
    workspace.audit({
        actor: by.dotId ? byDot(by.dotId) : by.userId,
        action: 'move',
        targetKind: 'page',
        targetId: input.id,
        detail: `from ${input.spaceId} to ${input.to}${by.dotId ? ` for ${by.userId}` : ''}${subpages ? ` with ${subpages} ${subpages === 1 ? 'subpage' : 'subpages'}` : ''}`,
    });
    // A cover belongs to its Space (CB-308): moved pages get theirs in the
    // new one; a cover whose image is gone is cleared.
    let { page } = result;
    for (const id of result.moved) {
        const cover = workspace.pages.get(input.to, id).cover;
        if (!cover) {
            continue;
        }
        const copy = await media.copyEmbedToSpace(cover.id, input.to);
        if (copy === cover.id) {
            continue;
        }
        const updated = await workspace.pages.setCover(input.to, id, copy ?? null);
        if (id === page.id) {
            page = updated.page;
        }
    }
    return { ...result, page };
}

/**
 * Whether `by` may move pages between the two Spaces (`movePage`'s
 * rules); throws the refusal when not.
 */
function checkMover(workspace: PagesWorkspace, by: PageMover, input: PageMoveInput) {
    const { pages, spaceAccess } = workspace;
    // A Space the person (or the socio's chat) may not read is one that
    // isn't there (CB-181).
    for (const space of [input.spaceId, input.to]) {
        if (!spaceAccess.reads(space, { userId: by.userId })) {
            throw new PageError(SPACE_NOT_FOUND, 404);
        }
    }
    for (const space of [input.spaceId, input.to]) {
        if (!pages.canEdit(by.userId, space)) {
            throw new PageError('You can’t edit pages in that Space.', 403);
        }
        if (by.dotId && !spaceAccess.reads(space, by.reader ?? { dotId: by.dotId, people: [by.userId] })) {
            throw new PageError(
                'This socio may not use that Space. An admin grants Spaces in the socio’s settings.',
                403,
            );
        }
    }
}
