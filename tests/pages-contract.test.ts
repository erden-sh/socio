// The pages contract: the helpers that moved to packages answer as before,
// `PageError` keeps its name, text and JSON, the classes implement the shapes,
// and the tags carry their keys.
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import { insertBlock } from '@socio/foundation/pages/insert-block';
import { PageError } from '@socio/foundation/pages/page-error';
import { percentile } from '@socio/shared/pages/search-timing';
import { markdownSnippet, textSnippet } from '@socio/shared/pages/text-snippet';

import {
    PageConversations,
    PageMoves,
    PageStore,
    PageTools,
    type PageConversationsShape,
    type PageStoreShape,
    type PageToolsShape,
} from '../src/server/pages/contract.js';
import { PageSearch } from '../src/server/pages/page-search.js';
import { PageService } from '../src/server/pages/page-service.js';
import { WorkspacePageTools } from '../src/server/pages/page-tools.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

it('the moved helpers answer as before', () => {
    const parts = textSnippet('The invoice is due', ['voic']);
    expect(parts).toEqual([
        { text: 'The ', match: false },
        { text: 'invoice', match: true },
        { text: ' is due', match: false },
    ]);
    expect(PageSearch.markdownSnippet(parts)).toBe('The **invoice** is due');
    expect(markdownSnippet(parts)).toBe('The **invoice** is due');
    expect(percentile({}, 50)).toBeNull();
    expect(percentile({ 0: 1, 10: 3 }, 50)).toBe(0.26);
    expect(insertBlock('# A\n\ntext', 'BLOCK', 'a')).toBe('# A\n\nBLOCK\n\ntext');
    expect(() => insertBlock('# A', 'BLOCK', 'missing')).toThrow(PageError);
});

it('PageError is still a plain Error with a status', () => {
    const error = new PageError('Page not found.', 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('Error');
    expect(String(error)).toBe('Error: Page not found.');
    expect(JSON.stringify(error)).toBe('{"status":404}');
    expect(new PageError('Bad.').status).toBe(400);
});

it('the tags carry their keys', () => {
    expect([PageMoves.key, PageStore.key, PageConversations.key, PageTools.key]).toEqual([
        'socio/pages/PageMoves',
        'socio/pages/PageStore',
        'socio/pages/PageConversations',
        'socio/pages/PageTools',
    ]);
});

it("the workspace's pages, page conversations and page tools serve their tags", async () => {
    const workspace = new WorkspaceStore(testDatabase());
    try {
        const store: PageStoreShape = workspace.pages;
        const conversations: PageConversationsShape = new PageService(workspace, {
            getOrCreateThread: async () => undefined,
            getThreadMessages: async () => ({ messages: [] }),
        });
        const tools: PageToolsShape = new WorkspacePageTools(workspace);
        const found = await Effect.runPromise(
            Effect.gen(function* () {
                const pageStore = yield* PageStore;
                yield* PageConversations;
                yield* PageTools;
                return pageStore.search({ query: 'anything', spaces: [] });
            }).pipe(
                Effect.provide(
                    Layer.mergeAll(
                        Layer.succeed(PageStore, store),
                        Layer.succeed(PageConversations, conversations),
                        Layer.succeed(PageTools, tools),
                    ),
                ),
            ),
        );
        expect(found.results).toEqual([]);
    } finally {
        workspace.close();
    }
});
