import { createStaticHandler, RouterContextProvider } from 'react-router';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { PROPOSAL_PAGE } from '@socio/shared/learning';
import type { MediaListing } from '@socio/shared/media-types';
import type { WebServices } from '@socio/shared/web/web';

import { webContext } from '../../packages/client/src/lib/web-context.js';
import { testRoutes } from '../../packages/client/tests/helpers/app-router.js';
import { createApp } from '../../src/server/app.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { issueDetailView, issueListView } from '../../src/server/issues/views.js';
import { spacePagesView } from '../../src/server/pages/views.js';
import { userServices } from '../../src/server/web/services.js';
import { pageLoaders, pageUsers } from '../fixtures/page-loaders.js';
import { seedWorkspace, type SeededWorkspace } from '../fixtures/seed-workspace.js';
import { Runner } from '../helpers/runners.js';

// The route modules import the shell; CopilotKit's entry loads its own CSS.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

// The step 6 size budget: loader data is in the
// HTML of every page load, so each kept page loader stays under 64 kB on
// the seeded workspace, as its admin and as its member. The seed is made
// the same way each run, so this is deterministic. Timing is the bench's
// (pnpm run bench:loaders), not the gate's: on a shared host it is noise.
const LIMIT = 64 * 1024;

let seed: SeededWorkspace;
beforeAll(async () => {
    seed = await seedWorkspace();
}, 180_000);
afterAll(() => seed?.close());

/**
 * Opens `address` through the app's routes as a page load does on the
 * server: the module gates, then every loader. Returns `route`'s data.
 */
async function routeData(address: string, services: WebServices, route: string) {
    const handler = createStaticHandler(testRoutes());
    const result = await handler.query(new Request(`http://127.0.0.1${address}`), {
        requestContext: new RouterContextProvider(new Map([[webContext, { services, nonce: '' }]])),
    });
    if (result instanceof Response) {
        throw new Error(`${address} answered ${result.status} ${result.headers.get('location') ?? ''}`);
    }
    expect(result.errors, address).toBeNull();
    expect(result.loaderData, address).toHaveProperty([route]);
    return result.loaderData[route] as unknown;
}

it('keeps every page loader’s data under 64 kB on the seeded workspace', async () => {
    const sources = {
        store: seed.store,
        config: seed.config,
        platform: seed.platform,
        views: seed.views,
        auth: {
            provider: new MockAuthProvider(seed.users, 'size-test-secret'),
            secureCookies: false,
        },
    };
    const kept = (await pageLoaders(seed)).filter((loader) => loader.kept);
    expect(kept.length).toBeGreaterThan(0);
    for (const loader of kept) {
        for (const user of pageUsers(seed, loader)) {
            const name = `${loader.page} as ${user.role}`;
            // The route module's own loader, behind its gate, at the address.
            expect(loader.address, name).toBeDefined();
            const data = await routeData(
                loader.address!(user),
                userServices(sources, async () => user),
                loader.route,
            );
            expect(data, name).not.toBeNull();
            const bytes = Buffer.byteLength(JSON.stringify(data));
            expect(bytes, name).toBeLessThanOrEqual(LIMIT);
            // What the bench times is what the route returns.
            expect(
                await loader.load(
                    userServices(sources, async () => user),
                    user,
                ),
                name,
            ).toEqual(data);
        }
    }
}, 120_000);

it('polls the board and a Space without bodies (CB-71)', async () => {
    const { platform, workspace } = seed;
    const size = (data: unknown) => Buffer.byteLength(JSON.stringify(data));
    // The board: 3,000 issues. 3.76 MB with every body; about 1.1 MB now.
    const board = await issueListView(platform, {}, seed.member.id);
    expect(board.issues).toHaveLength((await platform.board.issues.list()).length);
    for (const issue of board.issues) {
        expect(issue).not.toHaveProperty('body');
        expect(issue.excerpt.length).toBeLessThanOrEqual(160);
    }
    expect(size(board)).toBeLessThanOrEqual(1.25 * 1024 * 1024);
    expect(size(board)).toBeLessThan(size({ issues: await platform.board.issues.list() }) / 3);
    // The largest Space: 708 kB with every body; about 72 kB now.
    const [space] = workspace
        .spaces()
        .map((item) => ({
            id: item.id,
            size: workspace.pages.list(item.id).length,
        }))
        .sort((a, b) => b.size - a.size);
    const pages = spacePagesView(
        { spaceAccess: workspace.spaceAccess, pages: workspace.pages, counters: workspace.counters },
        seed.member.id,
        space!.id,
    );
    expect(pages).toHaveLength(space!.size);
    for (const page of pages) {
        expect(page).not.toHaveProperty('content');
    }
    expect(size(pages)).toBeLessThanOrEqual(80 * 1024);
    // The detail still has the description.
    const [first] = await platform.board.issues.list();
    expect((await issueDetailView(platform, first!)).issue.body).toBe(first!.body);
});

it('carries the first page of a learning container’s proposals only', async () => {
    const sources = {
        store: seed.store,
        config: seed.config,
        platform: seed.platform,
        views: seed.views,
        auth: {
            provider: new MockAuthProvider(seed.users, 'size-test-secret'),
            secureCookies: false,
        },
    };
    const data = (await routeData(
        '/learning',
        userServices(sources, async () => seed.admin),
        'learning',
    )) as {
        open: { id: string; proposals: unknown[]; proposalsCursor?: string };
    };
    // The seed gives each container a year's 75 proposals.
    const all = seed.platform.learning.proposals(data.open.id);
    expect(all.length).toBeGreaterThan(PROPOSAL_PAGE);
    // Only statuses the app writes (the seed once wrote "accepted").
    expect(new Set(all.map((p) => p.status))).toEqual(new Set(['pending', 'published', 'rejected']));
    expect(seed.platform.learning.runs(data.open.id).every((run) => run.status === 'succeeded')).toBe(true);
    expect(data.open.proposals).toHaveLength(PROPOSAL_PAGE);
    expect(data.open.proposalsCursor).toEqual(expect.any(String));
    // 39 kB with all 75; about 15 kB with the first 25.
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(20 * 1024);
}, 60_000);

it('serves the seeded media files’ contents, thumbnails included (CB-69)', async () => {
    const secret = 'size-test-secret-0123456789abcdef';
    const app = createApp({
        store: seed.store,
        runner: new Runner(seed.store, seed.config),
        config: seed.config,
        edge: seed.edge,
        auth: {
            provider: new MockAuthProvider(seed.users, secret),
            secureCookies: false,
        },
    });
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: seed.member.id }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const get = (path: string) => app.request(`/api${path}`, { headers: { cookie } });
    // The Media page's first screen: every item's content is there.
    const listing = (await (await get('/media')).json()) as MediaListing;
    expect(listing.items.length).toBeGreaterThan(0);
    for (const item of listing.items) {
        const content = await get(`/media/items/${item.id}/content`);
        expect(content.status, item.path).toBe(200);
        expect((await content.arrayBuffer()).byteLength, item.path).toBe(item.size);
    }
    // Images are served inline as themselves, for the thumbnails.
    const image = listing.items.find((item) => item.kind === 'image')!;
    expect(image).toBeDefined();
    const content = await get(`/media/items/${image.id}/content`);
    expect(content.headers.get('content-type')).toBe(image.mediaType);
}, 60_000);
