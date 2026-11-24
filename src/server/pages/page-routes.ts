import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJson } from '@socio/foundation/http/conditional';
import { PageError } from '@socio/foundation/pages/page-error';
import { pageImageUrl } from '@socio/shared/page-image';
import { COVER_MAX_BYTES, LIBRARY_FIRST_SCREEN } from '@socio/shared/pages/page-library';
import { pageReviewArgsSchema } from '@socio/shared/pages/page-review';
import { PAGE_SEARCH_LIMIT, PAGE_SEARCH_MAX_LIMIT, PAGE_SEARCH_MAX_OFFSET } from '@socio/shared/pages/page-search';
import { isAdmin } from '@socio/shared/roles';

import type { DataSpaceShape } from '../dataspace/contract.js';
import { MediaError, type MediaEmbedsShape } from '../media/contract.js';
import { SpaceAccessError } from '../spaces/contract.js';

import type { PageConversationsShape, PageCountersShape, PageMovesShape } from './contract.js';
import { PageChangedDuringMove } from './page-images.js';
import { movePage } from './page-moves.js';
import { pageInput, pagePatch } from './pages.js';
import type { PagesWorkspace } from './slices.js';
import { pagesViews, spaceItemsView, spaceItemsVersion } from './views.js';

const MB = 1048576;

/** `PUT …/cover` (CB-308): one of the person's files, or an image of the Space. */
const coverInput = z.union([
    z.object({ fileId: z.string().min(1).max(200) }).strict(),
    z.object({ embedId: z.string().min(1).max(200) }).strict(),
]);
/**
 * What the page routes use (it was `PagesPlatform` in
 * `platform-needs.ts`): the HTTP composition builds it where it mounts them.
 */
export interface PageRouteServices {
    /** The workspace's slices, and its change counters for the views' version. */
    readonly workspace: PagesWorkspace & { readonly counters: PageCountersShape };
    readonly media: MediaEmbedsShape;
    /** Page moves, built once by the composition root (`PageMovesLive`). */
    readonly pageMoves: PageMovesShape;
    readonly pages: PageConversationsShape;
    /** The datasets placed in each Space, for its items list (CB-451). */
    readonly data: Pick<DataSpaceShape, 'spaceDatasetItems'>;
}

export function pageRoutes(platform: PageRouteServices) {
    const app = new Hono<AppEnv>();
    const { spaceAccess } = platform.workspace;
    const views = pagesViews({
        spaceAccess,
        pages: platform.workspace.pages,
        counters: platform.workspace.counters,
    });
    /**
     * Every route of one Space asks first (CB-181): a Space the person may
     * not read is a 404, word for word as one that isn't there.
     */
    const readable = (c: Context<AppEnv>) => {
        const spaceId = c.req.param('spaceId')!;
        spaceAccess.require(spaceId, c.get('user').id);
        return spaceId;
    };
    app.get('/conversations/:id/reviewed-page/:toolCallId', (c) => {
        const thread = platform.workspace.requireOwnedThread(c.get('user').id, c.req.param('id'));
        const receipt = platform.workspace.pages.reviewReceipt(thread.id, c.req.param('toolCallId'));
        if (!receipt) {
            return c.json(null);
        }
        if (!platform.workspace.socioReads(thread.id, receipt.spaceId)) {
            return c.json({ error: 'This socio no longer has access to the selected Space.' }, 403);
        }
        return c.json({
            ...platform.workspace.pages.get(receipt.spaceId, receipt.pageId),
            reviewDraft: receipt.draft,
        });
    });
    app.post('/conversations/:id/reviewed-page', async (c) => {
        const data = pageReviewArgsSchema
            .extend({ toolCallId: z.string().min(1).max(200) })
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Enter a valid page draft.' }, 400);
        }
        const thread = platform.workspace.requireOwnedThread(c.get('user').id, c.req.param('id'));
        const { spaceId: requested, toolCallId, ...draft } = data.data;
        // A draft without a Space goes where create_space_page would put it
        // (CB-81); a retry keeps the Space its first save picked.
        const spaceId =
            requested ??
            platform.workspace.pages.reviewReceipt(thread.id, toolCallId)?.spaceId ??
            platform.workspace.pages.forThread(thread.id)?.spaceId ??
            platform.workspace.dot(thread.dotId)!.spaceId;
        if (!platform.workspace.socioReads(thread.id, spaceId)) {
            return c.json({ error: 'This socio no longer has access to the selected Space.' }, 403);
        }
        return c.json(
            await platform.workspace.pages.createReviewed(spaceId, draft, thread.id, toolCallId, thread.ownerId),
            201,
        );
    });
    app.get('/conversations/:id/page-context', (c) => {
        const thread = platform.workspace.requireOwnedThread(c.get('user').id, c.req.param('id'));
        const dot = platform.workspace.dot(thread.dotId)!;
        const page = platform.workspace.pages.forThread(thread.id);
        return c.json(
            page && platform.workspace.socioReads(thread.id, page.spaceId, dot.id)
                ? { id: page.id, spaceId: page.spaceId, title: page.title }
                : null,
        );
    });
    // The ⌘K palette's page search: every readable live page's title.
    app.get('/pages/titles', (c) => c.json(views.pageTitlesView(c.get('user').id)));
    // Page search: titles and text of live pages, every Space or `space`;
    // `exact=true` turns typo correction off. The query text is never logged.
    app.get('/spaces/search', (c) => {
        const limit = Number(c.req.query('limit') ?? PAGE_SEARCH_LIMIT);
        const offset = Number(c.req.query('offset') ?? 0);
        if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SEARCH_MAX_LIMIT) {
            return c.json({ error: `Ask for 1 to ${PAGE_SEARCH_MAX_LIMIT} results.` }, 400);
        }
        if (!Number.isInteger(offset) || offset < 0 || offset > PAGE_SEARCH_MAX_OFFSET) {
            return c.json({ error: `Start at 0 to ${PAGE_SEARCH_MAX_OFFSET}.` }, 400);
        }
        return c.json(
            views.pageSearchView(c.get('user').id, {
                q: c.req.query('q') ?? '',
                space: c.req.query('space') || undefined,
                limit,
                offset,
                exact: c.req.query('exact') === 'true',
            }),
        );
    });
    // A page opened from a search result: one freshness signal per person,
    // page and day. Who used it is never shown.
    app.post('/spaces/:spaceId/pages/:id/used', async (c) => {
        // Unreadable or not, the same answer: nothing counted, nothing said.
        if (spaceAccess.canRead(c.req.param('spaceId'), c.get('user').id)) {
            await platform.workspace.pages.noteUse(c.req.param('spaceId'), c.req.param('id'), c.get('user').id);
        }
        return c.body(null, 204);
    });
    // The sidebar's page tree: one Space's titles and parents, no bodies.
    // Both polled (the sidebar, an open Space): 304 when no page of the
    // Space changed (conditional.ts).
    app.get('/spaces/:spaceId/page-tree', (c) => {
        const spaceId = readable(c);
        return conditionalJson(
            c,
            () => views.pageTreeView(c.get('user').id, spaceId),
            () => views.spacePagesVersion(spaceId),
        );
    });
    // The Space's pages and datasets in one tree (CB-451):
    // what the sidebar and Socio Mobile draw. 304 when nothing listed changed.
    app.get('/spaces/:spaceId/items', (c) => {
        const spaceId = readable(c);
        return conditionalJson(
            c,
            () =>
                spaceItemsView(
                    { spaceAccess, pages: platform.workspace.pages, data: platform.data },
                    c.get('user').id,
                    spaceId,
                ),
            () => spaceItemsVersion({ counters: platform.workspace.counters }, spaceId),
        );
    });
    // The Space's change radar (CB-282): recent changes, open decision/
    // experiment markers, and stale pages, computed from existing data. Opt-in
    // (the client opens `/spaces/:id/radar`); read-gated like every Space
    // route. `?root=<pageId>` narrows to a subtree; `?staleDays=<n>` overrides
    // the default stale threshold.
    app.get('/spaces/:spaceId/radar', (c) => {
        const spaceId = readable(c);
        const rootId = c.req.query('root') || undefined;
        const staleDays = Number(c.req.query('staleDays'));
        return c.json(
            views.spaceRadarView(c.get('user').id, spaceId, {
                rootId,
                staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : undefined,
            }),
        );
    });
    // Every page with an excerpt, no bodies (CB-71): an open Space polls it.
    // `?bodies=false`: the library's first screen (spaceLibraryView), as the
    // Space's page loader has it; `limit` and `include` as there.
    app.get('/spaces/:spaceId/pages', (c) => {
        const spaceId = readable(c);
        const viewer = c.get('user').id;
        const version = () => views.spacePagesVersion(spaceId);
        if (c.req.query('bodies') !== 'false') {
            return conditionalJson(c, () => views.spacePagesView(viewer, spaceId), version);
        }
        const limit = Number(c.req.query('limit') ?? LIBRARY_FIRST_SCREEN);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            return c.json({ error: 'Ask for 1 to 500 pages.' }, 400);
        }
        return conditionalJson(
            c,
            () =>
                views.spaceLibraryView(viewer, spaceId, {
                    limit,
                    include: c.req.query('include'),
                }),
            version,
        );
    });
    app.get('/spaces/:spaceId/pages/:id', (c) => c.json(platform.workspace.pages.get(readable(c), c.req.param('id'))));
    app.post('/spaces/:spaceId/pages', async (c) => {
        const data = pageInput.safeParse(await c.req.json());
        if (!data.success) {
            return c.json(
                {
                    error: 'Enter a title (160 characters max) and Markdown content (100,000 max).',
                },
                400,
            );
        }
        return c.json(await platform.workspace.pages.create(readable(c), data.data, null, c.get('user').id), 201);
    });
    app.patch('/spaces/:spaceId/pages/:id', async (c) => {
        const data = pagePatch.safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'A valid page patch and expectedRevision are required.' }, 400);
        }
        // The editor autosaves; saves within 10 minutes by one person keep one
        // revision.
        return c.json(
            await platform.workspace.pages.update(readable(c), c.req.param('id'), data.data, { by: c.get('user').id }),
        );
    });
    // A page's cover (CB-308): whoever may edit the page sets it, from one of
    // their own image files or an image already in the Space (the picker's
    // "From this Space", and Undo after a removal). It isn't the page's text:
    // no revision.
    app.put('/spaces/:spaceId/pages/:id/cover', async (c) => {
        const spaceId = readable(c);
        const data = coverInput.safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Choose an image for the cover.' }, 400);
        }
        const { pages } = platform.workspace;
        const userId = c.get('user').id;
        // A deleted page is refused before anything is recorded.
        pages.get(spaceId, c.req.param('id'));
        const embedId =
            'fileId' in data.data
                ? await platform.media.coverFromFile(userId, {
                      fileId: data.data.fileId,
                      spaceId,
                  })
                : await platform.media.coverFromEmbed(userId, data.data.embedId, spaceId);
        const { page } = await pages.setCover(spaceId, c.req.param('id'), embedId);
        // Not a revision of the text, so the audit log is its history.
        platform.workspace.audit({
            actor: userId,
            action: 'update',
            targetKind: 'page',
            targetId: c.req.param('id'),
            detail: `cover ${embedId}`,
        });
        return c.json(page);
    });
    // Removing a cover keeps its image in its owner's Files; `previous` is
    // what the client's Undo puts back (`{ embedId: previous }`).
    app.delete('/spaces/:spaceId/pages/:id/cover', async (c) => {
        const { previous } = await platform.workspace.pages.setCover(readable(c), c.req.param('id'), null);
        if (previous) {
            platform.workspace.audit({
                actor: c.get('user').id,
                action: 'update',
                targetKind: 'page',
                targetId: c.req.param('id'),
                detail: `cover removed (${previous})`,
            });
        }
        return c.json({ previous });
    });
    // A picture for a page (CB-358): one of the person's own image files,
    // made into an image of the Space exactly as a cover is (media's
    // `coverFromFile`: the same checks, the same 5 MB, the same storage). The
    // page then names `embedId` in an `image` fence. Whoever may edit the
    // Space's pages may add one.
    app.post('/spaces/:spaceId/images', async (c) => {
        const spaceId = readable(c);
        const data = z
            .object({ fileId: z.string().min(1).max(200) })
            .strict()
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Choose an image.' }, 400);
        }
        const userId = c.get('user').id;
        if (!platform.workspace.pages.canEdit(userId, spaceId)) {
            return c.json({ error: 'You can’t edit pages in that Space.' }, 403);
        }
        let embedId: string;
        try {
            embedId = await platform.media.coverFromFile(userId, { fileId: data.data.fileId, spaceId });
        } catch (error) {
            // Media's words name covers; a picture says its own.
            if (error instanceof MediaError && error.status === 413) {
                return c.json({ error: `Images can be at most ${COVER_MAX_BYTES / MB} MB.` }, 413);
            }
            if (error instanceof MediaError && error.status === 415) {
                return c.json({ error: 'That is not an image.' }, 415);
            }
            throw error;
        }
        platform.workspace.audit({
            actor: userId,
            action: 'create',
            targetKind: 'space',
            targetId: spaceId,
            detail: `page image ${embedId}`,
        });
        return c.json({ embedId, url: pageImageUrl(embedId) }, 201);
    });
    // The cover picker's "From this Space": its images the person may see.
    app.get('/spaces/:spaceId/cover-images', async (c) =>
        c.json(await platform.media.spaceImages(c.get('user').id, readable(c))),
    );
    // Admins delete any page, members the pages they created; a page with
    // subpages only with `?subpages=true` (the confirm dialog names them).
    // CB-64: deleted pages are hidden and kept; the delete is audited.
    app.delete('/spaces/:spaceId/pages/:id', async (c) => {
        const user = c.get('user');
        const result = await platform.workspace.pages.delete(readable(c), c.req.param('id'), {
            subpages: c.req.query('subpages') === 'true',
            allowed: (page) => isAdmin(user) || page.createdBy === user.id,
            by: user.id,
        });
        const subpages = result.deleted.length - 1;
        platform.workspace.audit({
            actor: user.id,
            action: 'delete',
            targetKind: 'page',
            targetId: c.req.param('id'),
            detail: subpages ? `with ${subpages} ${subpages === 1 ? 'subpage' : 'subpages'}` : '',
        });
        return c.json(result);
    });
    // CB-142: moves a page, with its subpages, to another Space the person
    // may edit (movePage checks both). It keeps its id: old links find it
    // through `/pages/:id/location`.
    app.post('/spaces/:spaceId/pages/:id/move', async (c) => {
        readable(c);
        const data = z
            .object({
                spaceId: z.string().min(1),
                parentId: z.string().min(1).nullable().default(null),
                expectedRevision: z.number().int().positive().optional(),
            })
            .strict()
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Choose the Space to move the page to.' }, 400);
        }
        const { spaceId: to, ...rest } = data.data;
        // Its pictures, link cards' media and covers get copies in the new
        // Space (CB-358, CB-362, CB-308), as for a socio's move.
        return c.json(
            await movePage(
                platform.workspace,
                platform.pageMoves,
                platform.media,
                { userId: c.get('user').id },
                { spaceId: c.req.param('spaceId'), id: c.req.param('id'), to, ...rest },
            ),
        );
    });
    // Where a live page is now: an old link to a page that was moved.
    app.get('/pages/:id/location', async (c) => {
        const spaceId = await platform.pageMoves.locate(c.req.param('id'));
        return spaceId && spaceAccess.canRead(spaceId, c.get('user').id)
            ? c.json({ spaceId })
            : c.json({ error: 'Page not found.' }, 404);
    });
    app.post('/spaces/:spaceId/pages/:id/conversation', async (c) => {
        readable(c);
        const data = z
            .object({ dotId: z.string().min(1) })
            .strict()
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Choose a specialist.' }, 400);
        }
        return c.json(
            await platform.pages.conversation(
                c.req.param('spaceId'),
                c.req.param('id'),
                data.data.dotId,
                c.get('user').id,
            ),
        );
    });
    app.post('/conversations/:id/page', async (c) => {
        const data = z
            .object({
                title: z.string().trim().min(1).max(160),
                parentId: z.string().nullable().default(null),
            })
            .strict()
            .safeParse(await c.req.json());
        if (!data.success) {
            return c.json({ error: 'Enter a valid page title and parent.' }, 400);
        }
        platform.workspace.requireOwnedThread(c.get('user').id, c.req.param('id'));
        return c.json(
            await platform.pages.saveConversation(c.req.param('id'), data.data.title, data.data.parentId),
            201,
        );
    });
    app.onError((error, c) =>
        error instanceof SyntaxError
            ? c.json({ error: 'Invalid JSON request.' }, 400)
            : error instanceof PageError || error instanceof SpaceAccessError || error instanceof MediaError
              ? c.json(
                    { error: error.message, ...(error instanceof PageChangedDuringMove ? { code: error.code } : {}) },
                    error.status,
                )
              : error.message === 'Conversation does not belong to this socio and owner.'
                ? c.json({ error: error.message }, 404)
                : c.json(
                      {
                          error: 'Page operation could not complete. Check the model setup or retry; your draft has not been discarded.',
                      },
                      503,
                  ),
    );
    return app;
}
