/**
 * The pages layers: they implement `contract.ts`, yielding what they need from
 * the workspace's slices (`Socios`, `Conversations`, `Audit`), the Spaces'
 * `Access`, the turn `Runner` and the workspace's pages (`PageStore`, which
 * `WorkspaceStore` still builds). Only the composition root (`main.ts`,
 * `composition/pages.ts`) and tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';

import { Access } from '../spaces/contract.js';
import { Runner } from '../turns/contract.js';
import { Audit, Conversations, Socios } from '../workspace/contract.js';

import { PageConversations, PageCounters, PageMoves, PagesViews, PageStore, PageTools } from './contract.js';
import { SqlitePageMoves } from './page-moves.js';
import { PageService, runnerThreads } from './page-service.js';
import { WorkspacePageTools } from './page-tools.js';
import type { Pages } from './pages.js';
import { pagesWorkspace as overSlices } from './slices.js';
import { pagesViews } from './views.js';

/**
 * `SqlitePageMoves` on the connection the boot step opened and migrated,
 * beside the workspace's `Pages`; built once.
 */
export const PageMovesLive = (db: DatabaseSync, pages: Pages) =>
    Layer.sync(PageMoves, () => PageMoves.of(new SqlitePageMoves(db, pages)));

/** What `pages/` reads of the workspace, from the tags' slices. */
export const pagesWorkspace = Effect.gen(function* () {
    return overSlices({
        socios: yield* Socios,
        conversations: yield* Conversations,
        audit: yield* Audit,
        pages: yield* PageStore,
        spaceAccess: yield* Access,
    });
});

/**
 * The page conversations (`PageService`), over the workspace's slices and
 * the runner's thread history. The composition root also holds it as
 * `LegacyPages` (the class), so it is an Effect as well as a layer.
 */
export const pageService = Effect.gen(function* () {
    return new PageService(yield* pagesWorkspace, runnerThreads(yield* Runner));
});

export const PageConversationsLive = Layer.effect(PageConversations, pageService);

/** A socio's page tools over the workspace's slices. */
export const PageToolsLive = Layer.effect(
    PageTools,
    Effect.gen(function* () {
        return PageTools.of(new WorkspacePageTools(yield* pagesWorkspace));
    }),
);

/** The page views (moved from `live/views/pages.ts`), with their version. */
export const PagesViewsLive = Layer.effect(
    PagesViews,
    Effect.gen(function* () {
        return PagesViews.of(
            pagesViews({
                spaceAccess: yield* Access,
                pages: yield* PageStore,
                counters: yield* PageCounters,
            }),
        );
    }),
);
