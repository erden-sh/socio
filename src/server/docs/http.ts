import type { Hono } from 'hono';

import { originList } from '@socio/foundation/http/allowed-host';
import type { AppContext, AppEnv } from '@socio/foundation/http/app-env';
import { pageGuard } from '@socio/foundation/web/guard';
import type { WebServices } from '@socio/shared/web/web';

/**
 * What the exports read of the pages' options (web's `WebOptions`, which
 * satisfies it): the app's origins for the guard, and the services of one
 * request, with the headers to set on its response.
 */
export interface DocsExportOptions {
    origin?: string | string[];
    services: (c: AppContext) => {
        services: Pick<WebServices, 'user' | 'docsSearch' | 'docsLlms' | 'docsMarkdown'>;
        headers: [name: string, value: string][];
    };
}

/** Must precede static files: `.md` and `.txt` are protected exports, not assets. */
export function mountDocsExports(app: Hono<AppEnv>, options: DocsExportOptions) {
    app.use('*', async (c, next) => {
        const path = c.req.path;
        const raw =
            path === '/llms.txt' ||
            path === '/llms-full.txt' ||
            path === '/docs/search' ||
            (path.startsWith('/docs') && path.endsWith('.md'));
        if (!raw) {
            if (/^\/docs(?:[/.]|$)/.test(path)) {
                c.header('Cache-Control', 'private, no-store');
                c.header('Vary', 'Cookie, Origin, Accept');
            }
            return next();
        }
        c.header('Cache-Control', 'private, no-store');
        c.header('Vary', 'Cookie, Origin, Accept');
        c.header('X-Content-Type-Options', 'nosniff');
        if (['cross-site', 'same-site'].includes(c.req.header('sec-fetch-site') ?? '')) {
            return c.text('Not found.', 404);
        }
        const respond = async () => {
            const { services, headers } = options.services(c);
            // Fresh request identity BEFORE path lookup or query processing, including 404s.
            await services.user();
            let body: string | null;
            if (path === '/docs/search') {
                const query = c.req.query('query') ?? c.req.query('q') ?? '';
                if (query.length > 128) {
                    return c.json({ error: 'Query too long.' }, 400);
                }
                const result = (await services.docsSearch?.(query)) ?? [];
                for (const [name, value] of headers) {
                    c.header(name, value, { append: true });
                }
                return c.json(result);
            }
            if (path === '/llms.txt' || path === '/llms-full.txt') {
                body = (await services.docsLlms?.(path === '/llms-full.txt')) ?? null;
            } else {
                body = (await services.docsMarkdown?.(path.slice(0, -3))) ?? null;
            }
            for (const [name, value] of headers) {
                c.header(name, value, { append: true });
            }
            if (body === null) {
                return c.text('Not found.', 404);
            }
            c.header(
                'Content-Type',
                path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
            );
            return c.req.method === 'HEAD' ? c.body(null) : c.body(body);
        };
        const guarded = await pageGuard(originList(options.origin))(c, async () => {
            c.res = await respond();
        });
        return guarded ?? c.res;
    });
}
