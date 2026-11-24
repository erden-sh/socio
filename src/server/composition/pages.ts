/**
 * The pages feature's construction: pages' search retention, and pages' steps
 * of the graph over `pages/layer.ts`.
 */
import { Context, Effect, Layer } from 'effect';

import { PageError } from '@socio/foundation/pages/page-error';

import { DatasetViewTools, DataViewPages, type DataSpaceShape } from '../dataspace/contract.js';
import { Counters } from '../live/contract.js';
import { Media, type MediaEmbedsShape } from '../media/contract.js';
import {
    PageConversations,
    PageCounters,
    PageMoves,
    type PageMovesShape,
    PageStore,
    type PageStoreShape,
    PageTools,
    type PageToolsShape,
} from '../pages/contract.js';
import { pageService, PagesViewsLive, PageToolsLive } from '../pages/layer.js';
import { PageService } from '../pages/page-service.js';
import { Creation, SpacePages, type SpaceCreationShape, type SpacePagesShape } from '../spaces/contract.js';

import { LegacyWorkspace } from './base.js';
import { LegacyData } from './dataspace.js';
import type { ResourcePolicy } from './operations.js';
import { LegacyResourcePolicy } from './operations.js';

/**
 * Datasets in Spaces (CB-451, decision 15): a dataset's parent is checked
 * against the live pages, and the datasets under pages that leave a Space
 * (deleted, or moved to another) move up in the pages' own transaction.
 */
export function usePageDatasets(
    pages: Pick<PageStoreShape, 'get' | 'usePagesGone'>,
    data: Pick<DataSpaceShape, 'usePlacementPages' | 'reparentSpaceItems'>,
) {
    data.usePlacementPages((spaceId, pageId) => {
        try {
            pages.get(spaceId, pageId);
            return true;
        } catch (error) {
            if (error instanceof PageError) {
                return false;
            }
            throw error;
        }
    });
    pages.usePagesGone((spaceId, pageIds, parentId) => {
        data.reparentSpaceItems(spaceId, pageIds, parentId);
    });
}

/** Pages' search retention, and their covers from the media files. */
export function usePageRetention(
    workspace: { pages: Pick<PageStoreShape, 'setSearchRetention' | 'useCovers'> },
    resourcePolicy: ResourcePolicy,
    media: Pick<MediaEmbedsShape, 'coverView'>,
) {
    workspace.pages.setSearchRetention(resourcePolicy);
    // A page's cover is a media embed (CB-308): gone with its image file.
    workspace.pages.useCovers((id) => media.coverView(id));
}

/** Pages' conversations, under the graph's `LegacyPages` tag (the class). */
export class LegacyPages extends Context.Service<LegacyPages, PageService>()('socio/composition/pages/PageService') {}

/** The workspace's pages (`WorkspaceStore` still builds them). */
const PageStoreFromWorkspace = Layer.effect(
    PageStore,
    Effect.gen(function* () {
        return (yield* LegacyWorkspace).pages;
    }),
);

/** Live's change counters, as the page views' version reads them. */
const PageCountersFromLive = Layer.effect(
    PageCounters,
    Effect.gen(function* () {
        return yield* Counters;
    }),
);

/**
 * The Spaces module's page tools (`SpacePages`): the page tools with the
 * page moves and the media a move copies (CB-362), and a socio's
 * `create_space` with the Spaces' `Creation` (read as the tool is made),
 * as the module made them with the platform's. Left out (a test's turn),
 * no moves and no `create_space`.
 */
export const spacePages = (
    tools: PageToolsShape,
    moves?: PageMovesShape,
    creation?: () => SpaceCreationShape,
    media?: Pick<MediaEmbedsShape, 'coverFromEmbed' | 'copyEmbedToSpace'>,
): SpacePagesShape => ({
    tools: (input) => tools.tools({ ...input, moves, media }),
    ...(creation ? { createSpace: (turn) => tools.createSpace(creation(), turn) } : {}),
    pageContext: (input) => tools.access({ ...input, moves, media }).context(),
});

/**
 * The ports two lower modules declare over the pages: the Spaces'
 * `SpacePages` and the data space's `DatasetViewTools` (the page tools
 * themselves) and `DataViewPages` (the workspace's pages themselves).
 * Build nothing, start nothing.
 */
const ModulePortsLive = Layer.mergeAll(
    Layer.effect(
        SpacePages,
        Effect.gen(function* () {
            const creation = yield* Creation;
            return spacePages(yield* PageTools, yield* PageMoves, () => creation, yield* Media);
        }),
    ),
    Layer.effect(
        DatasetViewTools,
        Effect.gen(function* () {
            return yield* PageTools;
        }),
    ),
    Layer.effect(
        DataViewPages,
        Effect.gen(function* () {
            return yield* PageStore;
        }),
    ),
);

/**
 * Pages' steps of the graph, in the graph's order (the page moves come
 * from the root, `main.ts`): the workspace's pages (`PageStore`), with
 * their search retention and covers once media exists; then the page
 * conversations (`PageConversations`, and `LegacyPages`), near the end;
 * then, after live's counters, the page tools (`PageTools`) and the page
 * views (`PagesViews`), and the ports over the page tools (`SpacePages`,
 * `DatasetViewTools`). No step registers a listener.
 */
export const pagesLayers = {
    retention: Layer.effectDiscard(
        Effect.gen(function* () {
            const pages = yield* PageStore;
            usePageRetention({ pages }, yield* LegacyResourcePolicy, yield* Media);
            usePageDatasets(pages, yield* LegacyData);
        }),
    ).pipe(Layer.provideMerge(PageStoreFromWorkspace)),
    service: Layer.effectContext(
        Effect.gen(function* () {
            const service = yield* pageService;
            return Context.make(LegacyPages, service).pipe(Context.add(PageConversations, service));
        }),
    ),
    bridges: ModulePortsLive.pipe(
        Layer.provideMerge(Layer.mergeAll(PageToolsLive, PagesViewsLive.pipe(Layer.provide(PageCountersFromLive)))),
    ),
};
