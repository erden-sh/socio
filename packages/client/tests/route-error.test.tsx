import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ModuleErrorBoundary } from '../src/modules/gate';
import { AppError, RouteError } from '../src/views/RouteError';

/** A route whose loader throws, rendered as the server renders it. */
async function render(boundary: ComponentType, thrown: unknown) {
    const handler = createStaticHandler([
        {
            id: 'page',
            path: '/page',
            loader: () => {
                throw thrown;
            },
            Component: () => <p>The page.</p>,
            ErrorBoundary: boundary,
        },
    ]);
    const context = await handler.query(new Request('https://socio.example/page'));
    if (context instanceof Response) {
        throw new Error('Unexpected response');
    }
    const html = renderToString(
        <StaticRouterProvider
            router={createStaticRouter(handler.dataRoutes, context)}
            context={context}
            hydrate={false}
        />,
    ).replaceAll('<!-- -->', '');
    return { status: context.statusCode, html };
}

// A loader that throws a 404 means "nothing here": reloading won't help, so
// the error pages say Not found instead (CB-264).
describe('error boundaries and a 404', () => {
    for (const [name, boundary] of [
        ['the app (root and shell)', AppError],
        ['a module page', ModuleErrorBoundary],
        ['a page in the shell', RouteError],
    ] as const) {
        it(`${name} shows Not found for a thrown 404`, async () => {
            const page = await render(boundary, new Response('Not found.', { status: 404 }));
            expect(page.status).toBe(404);
            expect(page.html).toContain('Page not found.');
            expect(page.html).toMatch(/<a [^>]*href="\/"[^>]*>Back to your socios/);
            expect(page.html).not.toMatch(/Something went wrong|Reloading usually fixes it|failed to load/);
        });
        it(`${name} still offers a reload for a real failure`, async () => {
            const page = await render(boundary, new Error('boom'));
            expect(page.status).toBe(500);
            expect(page.html).toContain('Reloading usually fixes it.');
            expect(page.html).not.toContain('not found');
        });
    }
});
