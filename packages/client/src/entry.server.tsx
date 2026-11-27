import { AsyncLocalStorage } from 'node:async_hooks';
import { PassThrough } from 'node:stream';

import { createReadableStreamFromReadable } from '@react-router/node';
import { renderToPipeableStream } from 'react-dom/server';
import {
    ServerRouter,
    type EntryContext,
    type HandleDataRequestFunction,
    type HandleErrorFunction,
    type RouterContextProvider,
} from 'react-router';

import { scopeActiveLocale } from '@socio/shared/locale';

import { i18nOf } from './i18n/page-i18n';
import { web } from './lib/web-context';

// The Hono server reads the context key from the build (web-context.ts).
export { webContext } from './lib/web-context';

/**
 * The page's locale while it renders: `@socio/shared/locale`'s helpers
 * sort and format in it, per request, however many pages render at once,
 * so the browser that hydrates in the same locale gets the same text.
 */
const renderLocale = new AsyncLocalStorage<string>();
scopeActiveLocale(() => renderLocale.getStore());

/** Streamed data stops after 5 s; the render is cut off a second later. */
export const streamTimeout = 5_000;

/** Like the API's `onError`: the log names the error, never its message. */
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export const handleError: HandleErrorFunction = (error, { request }) => {
    // A closed tab or a canceled navigation isn't a failure.
    if (request.signal.aborted) {
        return;
    }
    console.error('Page request failed:', errorName(error));
};

/** Loader data is per user: never stored by a cache. */
export const handleDataRequest: HandleDataRequestFunction = (response) => {
    response.headers.set('Cache-Control', 'no-store');
    return response;
};

/**
 * Renders a page, streaming once the shell is ready. Every inline script
 * (React Router's handoff and module bootstrap, React's streaming chunks)
 * carries this response's CSP nonce.
 */
export default function handleRequest(
    request: Request,
    status: number,
    headers: Headers,
    routerContext: EntryContext,
    loadContext: RouterContextProvider,
) {
    const { nonce } = web(loadContext);
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Type', 'text/html; charset=utf-8');
    // HEAD: the same status and headers, without rendering.
    if (request.method === 'HEAD') {
        return new Response(null, { status, headers });
    }
    const locale = i18nOf(routerContext.staticHandlerContext.loaderData.root)?.locale ?? 'en-US';
    return renderLocale.run(locale, () => render(request, status, headers, routerContext, nonce));
}

function render(request: Request, status: number, headers: Headers, routerContext: EntryContext, nonce: string) {
    return new Promise<Response>((resolve, reject) => {
        let statusCode = status;
        let shellRendered = false;
        const { pipe, abort } = renderToPipeableStream(
            <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
            {
                nonce,
                onShellReady() {
                    shellRendered = true;
                    const body = new PassThrough({
                        final(callback) {
                            clearTimeout(timer);
                            callback();
                        },
                    });
                    pipe(body);
                    resolve(
                        new Response(createReadableStreamFromReadable(body), {
                            status: statusCode,
                            headers,
                        }),
                    );
                },
                onShellError: reject,
                onError(error) {
                    statusCode = 500;
                    // Errors before the shell reject above, and React Router logs them.
                    if (shellRendered) {
                        console.error('Page render failed:', errorName(error));
                    }
                },
            },
        );
        const timer = setTimeout(abort, streamTimeout + 1000);
    });
}
