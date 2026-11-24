import type { IncomingMessage, ServerResponse } from 'node:http';

import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Context, Hono, Next } from 'hono';
import { createRequestHandler, type RequestHandler, type ServerBuild } from 'react-router';

import { originList } from '@socio/foundation/http/allowed-host';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { MANIFEST_PATH, pageGuard } from '@socio/foundation/web/guard';

import { requestContext } from './context.js';
import type { WebOptions } from './contract.js';

/** Connect-style middlewares: Vite's, in development. */
export type NodeMiddlewares = (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
) => void;

export interface WebBuild {
    /** The pages' server build, or (development) a loader of the current one. */
    build: ServerBuild | (() => Promise<ServerBuild>);
    mode: 'production' | 'development';
    /** Production: the browser build's files (dist/web/client). */
    clientDir?: string;
    /** Development: Vite serves the modules, styles and public files. */
    middlewares?: NodeMiddlewares;
}

/** Everything `mountWeb` takes: the build, and the options in `contract.ts`. */
export interface WebMountOptions extends WebBuild, WebOptions {}

/** Hashed build files: a name never changes its content. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * The last path segment names a file (`app.js`, `favicon.svg`). A
 * release's page (`/releases/v0.5.0`, CB-168) is a page.
 */
const looksLikeFile = (path: string) =>
    /\.[a-z0-9]+$/i.test(path.slice(path.lastIndexOf('/') + 1)) && !/^\/releases\/v\d+\.\d+\.\d+$/.test(path);

/** A missing file: a plain 404 that no cache keeps, never a page. */
const missing = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    return c.text('Not found.', 404);
};

/**
 * Production: files from the browser build, with their cache headers. The
 * build writes a `.gz` next to each text file (scripts/precompress.mjs),
 * sent to a browser that takes gzip; a range request gets the plain file.
 */
function staticFiles(root: string) {
    const plain = serveStatic<AppEnv>({ root });
    const precompressed = serveStatic<AppEnv>({ root, precompressed: true });
    return async (c: Context<AppEnv>, next: Next) => {
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
            return next();
        }
        // Dot segments (`/.vite/manifest.json`) are never served.
        if (c.req.path.split('/').some((segment) => segment.startsWith('.'))) {
            return missing(c);
        }
        // Set before the file's response is made, so it carries the header.
        c.header('Cache-Control', c.req.path.startsWith('/assets/') ? IMMUTABLE : 'no-cache');
        const serve = c.req.header('Range') === undefined ? precompressed : plain;
        const served = await serve(c, async () => {});
        if (served) {
            return served;
        }
        c.header('Cache-Control', undefined);
        // `/assets/<old hash>.js` after a deploy: a 404 the browser's import
        // fails on, so the page reloads. Loader data (`.data`) isn't a file.
        if (looksLikeFile(c.req.path) && !c.req.path.endsWith('.data')) {
            return missing(c);
        }
        return next();
    };
}

/** Development: Vite's middlewares answer first, else the request goes on. */
function nodeMiddlewares(middlewares: NodeMiddlewares) {
    return (c: Context<AppEnv>, next: Next) => {
        const env = c.env as HttpBindings | undefined;
        if (!env?.incoming || !env.outgoing) {
            return next();
        }
        const { incoming, outgoing } = env;
        return new Promise<Response | void>((resolve, reject) => {
            // Vite answered (or the browser went away): nothing left to send.
            outgoing.once('close', () => resolve(RESPONSE_ALREADY_SENT));
            middlewares(incoming, outgoing, (error) => (error ? reject(error) : resolve(next())));
        });
    };
}

/**
 * The pages, registered after every API route and `/healthz` (and after
 * the docs' exports, which the composition mounts first,
 * `composition/http/web.ts`): an unknown
 * `/api/…` path answers JSON 404 (any method); then files; then the page
 * guard; then React Router renders the page or answers its data request,
 * with this request's services in the router context. Pages and their
 * data are per user, so nothing here is cached (`no-store`); hashed
 * assets are cached for good.
 */
export function mountWeb(app: Hono<AppEnv>, options: WebMountOptions) {
    app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
    if (options.middlewares) {
        app.use('*', nodeMiddlewares(options.middlewares));
    } else if (options.clientDir) {
        app.use('*', staticFiles(options.clientDir));
    }
    app.use('*', pageGuard(originList(options.origin), options.frameSrc));
    const handlers = new WeakMap<ServerBuild, RequestHandler>();
    const handlerFor = (build: ServerBuild) => {
        let handler = handlers.get(build);
        if (!handler) {
            handler = createRequestHandler(build, options.mode);
            handlers.set(build, handler);
        }
        return handler;
    };
    app.all('*', async (c) => {
        const build = typeof options.build === 'function' ? await options.build() : options.build;
        const { services, headers: set } = options.services(c);
        const response = await handlerFor(build)(
            c.req.raw,
            requestContext(build, { services, nonce: c.get('cspNonce')! }),
        );
        const headers = new Headers(response.headers);
        // A renewed session cookie: the loaders ran before the answer.
        for (const [name, value] of set) {
            headers.append(name, value);
        }
        // Route discovery keeps React Router's own caching (immutable for a
        // version's manifest); everything else is this user's.
        if (!(c.req.path === MANIFEST_PATH && headers.has('Cache-Control'))) {
            headers.set('Cache-Control', 'no-store');
        }
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    });
}
