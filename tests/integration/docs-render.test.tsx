import { renderToString } from 'react-dom/server';
import {
    createStaticHandler,
    createStaticRouter,
    MemoryRouter,
    RouterContextProvider,
    StaticRouterProvider,
} from 'react-router';
import { it, expect } from 'vitest';

import type { WebServices } from '@socio/shared/web/web';

import { webContext } from '../../packages/client/src/lib/web-context';
import DocsRoute, { DocsView, ErrorBoundary, loader } from '../../packages/client/src/modules/docs/Docs.route';
import { buildDocsCatalog } from '../../src/server/docs/catalog';

it('SSR renders sanitized catalog data with real Fumadocs UI and metadata, no hidden audience', async () => {
    const docs = await buildDocsCatalog([
        {
            audience: 'user',
            name: 'index.md',
            markdown: '---\ntitle: Help center\ndescription: Useful guides\n---\n\n## Get started\n\n**Hello** world.',
        },
        {
            audience: 'operate',
            name: 'index.md',
            markdown: '---\ntitle: Restricted sentinel\ndescription: Hidden\n---\n\nDO_NOT_SHIP_SENTINEL',
        },
    ]);
    const context = new RouterContextProvider();
    let resolved = false;
    context.set(webContext, {
        nonce: 'synthetic-test-nonce',
        services: {
            user: async () => {
                resolved = true;
                return null;
            },
            docsPage: async (url: string) => {
                expect(resolved).toBe(true);
                return docs.screen(url);
            },
        } as unknown as WebServices,
    });
    const data = await loader({
        context,
        params: { '*': '' },
        request: new Request('https://socio.example/docs'),
        url: new URL('https://socio.example/docs'),
        pattern: '/docs/*',
    });
    const html = renderToString(
        <MemoryRouter initialEntries={['/docs']}>
            <DocsView {...data} />
        </MemoryRouter>,
    );
    expect(html).toContain('Help center');
    expect(html).toContain('Get started');
    expect(html).toContain('<strong>Hello</strong>');
    expect(html).toContain('/docs.md');
    expect(html).not.toMatch(/DO_NOT_SHIP_SENTINEL|Restricted sentinel|\/docs\/operate/);
    await expect(
        loader({
            context,
            params: { '*': 'operate' },
            request: new Request('https://socio.example/docs/operate'),
            url: new URL('https://socio.example/docs/operate'),
            pattern: '/docs/*',
        }),
    ).rejects.toMatchObject({ status: 404 });
});

/**
 * A /docs request rendered as the server does: the route's loader, then
 * its component or its error boundary (CB-264).
 */
async function renderDocs(path: string, services: Partial<WebServices>) {
    const context = new RouterContextProvider();
    context.set(webContext, {
        nonce: 'synthetic-test-nonce',
        services: services as WebServices,
    });
    const handler = createStaticHandler([
        {
            id: 'docs',
            path: '/docs/*',
            loader: (args) => loader({ ...args, context }),
            Component: DocsRoute,
            ErrorBoundary,
        },
    ]);
    const result = await handler.query(new Request(`https://socio.example${path}`));
    if (result instanceof Response) {
        throw new Error('Unexpected response');
    }
    const html = renderToString(
        <StaticRouterProvider
            router={createStaticRouter(handler.dataRoutes, result)}
            context={result}
            hydrate={false}
        />,
    ).replaceAll('<!-- -->', '');
    return { status: result.statusCode, html };
}

it('shows the same Not found page, with a 404, for a missing article and a hidden one (CB-264)', async () => {
    const docs = await buildDocsCatalog([
        {
            audience: 'user',
            name: 'index.md',
            markdown: '---\ntitle: Help center\ndescription: Useful guides\n---\n\nWelcome.',
        },
        {
            audience: 'admin',
            name: 'index.md',
            markdown: '---\ntitle: Admin sentinel title\ndescription: Hidden\n---\n\nADMIN_SENTINEL',
        },
        {
            audience: 'operate',
            name: 'index.md',
            markdown: '---\ntitle: Restricted sentinel\ndescription: Hidden\n---\n\nDO_NOT_SHIP_SENTINEL',
        },
    ]);
    const as = (role?: 'member' | 'admin') => ({
        user: async () => (role ? { id: 'u', name: 'U', role } : null),
        docsPage: async (url: string) => docs.screen(url, role),
        docsTree: async () => docs.tree(role),
    });
    for (const viewer of [as(), as('member')]) {
        const missing = await renderDocs('/docs/no-such-article', viewer);
        const hidden = await renderDocs('/docs/operate', viewer);
        const hiddenAdmin = await renderDocs('/docs/admin', viewer);
        for (const page of [missing, hidden, hiddenAdmin]) {
            expect(page.status).toBe(404);
            expect(page.html).toContain('Article not found');
            expect(page.html).toMatch(/<a href="\/docs">Back to the help center<\/a>/);
            expect(page.html).toContain('Search the help center');
            // The help center's own frame, with the viewer's navigation.
            expect(page.html).toContain('Socio help');
            expect(page.html).toContain('User guides');
            expect(page.html).not.toMatch(/Something went wrong|Reloading usually fixes it|failed to load/);
            expect(page.html).not.toMatch(
                /DO_NOT_SHIP_SENTINEL|Restricted sentinel|ADMIN_SENTINEL|Admin sentinel|Admin guides|Running Socio/,
            );
        }
        // Byte for byte the same: nothing tells a hidden article from no article.
        expect(hidden.html).toBe(missing.html);
        expect(hiddenAdmin.html).toBe(missing.html);
    }
    // Admins read the guides to running Socio too (CB-390: no operator role).
    const admin = await renderDocs('/docs/operate', as('admin'));
    expect(admin.status).toBe(200);
    expect(admin.html).toContain('Admin guides');
    expect(admin.html).toContain('Running Socio');
    expect(admin.html).toContain('DO_NOT_SHIP_SENTINEL');
    expect(admin.html).not.toContain('Operator guides');
    expect((await renderDocs('/docs/nope', as('admin'))).status).toBe(404);
    // A page that exists still renders as an article, with a 200.
    const found = await renderDocs('/docs', as('member'));
    expect(found.status).toBe(200);
    expect(found.html).toContain('Welcome.');
    expect(found.html).not.toContain('Article not found');
});

it('keeps the app error page for docs failures that are not a 404', async () => {
    const page = await renderDocs('/docs/broken', {
        user: async () => null,
        docsPage: async () => {
            throw new Error('catalog down');
        },
    });
    expect(page.status).toBe(500);
    expect(page.html).toContain('Something went wrong.');
    expect(page.html).not.toContain('Article not found');
});
