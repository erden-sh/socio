// Pages' services are layers over the tags of other features' contracts; the
// page views moved from live/views/pages.ts behind `PagesViews` and answer as
// the plain views (pages/views.ts) do over the workspace's own pages, Space
// access and counters (live's copy, since deleted, read the same); in the
// server's graph the tags hold the instances `Platform` holds.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { PageConversations, PageCounters, PagesViews, PageStore, PageTools } from '../src/server/pages/contract.js';
import { PageConversationsLive, PagesViewsLive, PageToolsLive } from '../src/server/pages/layer.js';
import { PageService } from '../src/server/pages/page-service.js';
import { WorkspacePageTools } from '../src/server/pages/page-tools.js';
import {
    pageSearchView,
    pageTitlesView,
    pageTreeView,
    spaceLibraryView,
    spacePagesVersion,
    spacePagesView,
    spaceRadarView,
} from '../src/server/pages/views.js';
import { Access } from '../src/server/spaces/contract.js';
import { Runner } from '../src/server/turns/contract.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const config = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    appOrigin: 'https://app.example.invalid',
};

function workspaceWithPages() {
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    return { workspace, runner, space: workspace.spaces()[0]!.id };
}

it('the new tags carry their keys', () => {
    expect([PagesViews.key, PageCounters.key]).toEqual(['socio/pages/PagesViews', 'socio/pages/PageCounters']);
});

it('builds the page conversations, tools and views from the tags, and the views answer as live’s', async () => {
    const { workspace, runner, space } = workspaceWithPages();
    const plan = await workspace.pages.create(space, { title: 'Plan', content: '# Plan\n\nThe invoice is due.' });
    await workspace.pages.create(space, { title: 'Child', content: 'Under the plan.', parentId: plan.id });
    const services = Layer.mergeAll(
        WorkspaceLive(workspace),
        Layer.succeed(Access, workspace.spaceAccess),
        Layer.succeed(PageStore, workspace.pages),
        Layer.succeed(PageCounters, workspace.counters),
        Layer.succeed(Runner, runner),
    );
    const { conversations, tools, views } = await Effect.runPromise(
        Effect.gen(function* () {
            return {
                conversations: yield* PageConversations,
                tools: yield* PageTools,
                views: yield* PagesViews,
            };
        }).pipe(
            Effect.provide(
                Layer.mergeAll(PageConversationsLive, PageToolsLive, PagesViewsLive).pipe(Layer.provide(services)),
            ),
        ),
    );
    expect(conversations).toBeInstanceOf(PageService);
    expect(tools).toBeInstanceOf(WorkspacePageTools);
    // What live's copy read: the workspace's pages, Space access and counters.
    const platform = { spaceAccess: workspace.spaceAccess, pages: workspace.pages, counters: workspace.counters };
    for (const viewer of ['alice', 'bob']) {
        expect(views.spacePagesView(viewer, space)).toEqual(spacePagesView(platform, viewer, space));
        expect(views.spaceLibraryView(viewer, space, { limit: 1, include: plan.id })).toEqual(
            spaceLibraryView(platform, viewer, space, { limit: 1, include: plan.id }),
        );
        expect(views.pageTitlesView(viewer)).toEqual(pageTitlesView(platform, viewer));
        expect(views.pageSearchView(viewer, { q: 'invoice' })).toEqual(
            pageSearchView(platform, viewer, { q: 'invoice' }),
        );
        expect(views.pageTreeView(viewer, space)).toEqual(pageTreeView(platform, viewer, space));
        // The radar is computed at `Date.now()`: the same clock for both.
        vi.useFakeTimers({ toFake: ['Date'] });
        expect(views.spaceRadarView(viewer, space)).toEqual(spaceRadarView(platform, viewer, space));
        vi.useRealTimers();
    }
    expect(views.pageTreeView('alice', space)).toHaveLength(2);
    expect(views.spacePagesVersion(space)).toBe(spacePagesVersion(platform, space));
    // A Space nobody may read is a 404, word for word as live's.
    const refusal = (view: () => unknown) => {
        try {
            view();
        } catch (error) {
            return { error, status: (error as { status?: number }).status };
        }
        return undefined;
    };
    expect(refusal(() => views.pageTreeView('alice', 'nope'))).toEqual(
        refusal(() => pageTreeView(platform, 'alice', 'nope')),
    );
    expect(refusal(() => views.pageTreeView('alice', 'nope'))?.status).toBe(404);
    expect(() => views.pageSearchView('alice', { q: 'x', space: 'nope' })).toThrow('Space not found.');
});

it('in the server’s graph, the tags hold the workspace’s pages and `Platform.pages`', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    const { runtime, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config,
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
        store.close();
        workspace.close();
    });
    const context = await runtime.context();
    expect(Context.get(context, PageStore)).toBe(workspace.pages);
    expect(Context.get(context, PageConversations)).toBe(platform.pages);
    expect(Context.get(context, PageTools)).toBeInstanceOf(WorkspacePageTools);
    const space = workspace.spaces()[0]!.id;
    expect(Context.get(context, PagesViews).spacePagesVersion(space)).toBe(
        spacePagesVersion({ counters: platform.workspace.counters }, space),
    );
});
