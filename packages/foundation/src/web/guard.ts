import { randomBytes } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { allowedHost } from '../http/allowed-host.js';
import type { AppEnv } from '../http/app-env.js';

/** Route discovery (react-router.config.ts `routeDiscovery.manifestPath`). */
export const MANIFEST_PATH = '/__manifest';

/**
 * Loader data for a client navigation (`/issues.data`, and `/issues/_.data`
 * for `/issues/`) or route discovery: what a page in another site must not
 * read with this user's cookies.
 */
export const isDataRequest = (path: string) => path.endsWith('.data') || path === MANIFEST_PATH;

/**
 * A page opened from another site: a link in web mail or Telegram Web, or
 * an identity provider's redirect back after sign-in. The browser leaves
 * out SameSite=Strict cookies, the session's among them, so the page
 * would render signed out. This answers a page that opens the same address
 * again from this site, with the cookies: public/reopen.js reloads it (a
 * reload keeps a #hash), and without JavaScript a meta refresh to the
 * address does (without its hash, which the server never sees: a refresh
 * to the same address and hash would only scroll). It sets
 * `REOPENED_COOKIE` for a few seconds, so a browser that still calls that
 * request cross-site gets the page instead of a loop.
 */
export const reopenPage = (url: string) => {
    const { pathname, search } = new URL(url);
    // One leading slash: `//elsewhere.example/` would leave the site.
    const address = `/${pathname.replace(/^\/+/, '')}${search}`.replace(
        /[&"'<>]/g,
        (char) => `&#${char.charCodeAt(0)};`,
    );
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><script src="/theme-init.js"></script><script src="/reopen.js"></script><noscript><meta http-equiv="refresh" content="0;url=${address}"></noscript><title>Socio</title></head><body></body></html>`;
};
export const REOPENED_COOKIE = 'cb_reopened';

const fromOtherSite = (c: Context) =>
    c.req.method === 'GET' &&
    c.req.header('sec-fetch-site') === 'cross-site' &&
    c.req.header('sec-fetch-mode') === 'navigate' &&
    !isDataRequest(c.req.path);

const refuse = (c: Context, message: string, status: 403 | 405) => {
    c.header('Cache-Control', 'no-store');
    return c.text(message, status);
};

/**
 * What every request to the page renderer passes first. Pages only read:
 * GET and HEAD, nothing else (there are no actions). The host check is the
 * API's. Top-level navigations from other sites stay allowed (Telegram and
 * email links), but their data requests don't: like the API, a same-site
 * page (a mini app on a sibling host) counts as another site. A page
 * opened from another site is opened again from this one, so it gets the
 * session (`reopenPage`). Each page gets its own CSP nonce
 * (security-headers.ts).
 */
export function pageGuard(
    origins?: string[],
    frameSrc?: (path: string) => string | undefined,
): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
            c.header('Allow', 'GET, HEAD');
            return refuse(c, 'Method not allowed.', 405);
        }
        if (!allowedHost(c.req.url, origins)) {
            return refuse(c, 'Unrecognized host.', 403);
        }
        if (isDataRequest(c.req.path) && ['cross-site', 'same-site'].includes(c.req.header('sec-fetch-site') ?? '')) {
            return refuse(c, 'Cross-site requests are not allowed.', 403);
        }
        if (fromOtherSite(c) && !getCookie(c, REOPENED_COOKIE)) {
            c.header('Cache-Control', 'no-store');
            setCookie(c, REOPENED_COOKIE, '1', {
                path: '/',
                maxAge: 10,
                httpOnly: true,
                sameSite: 'Lax',
            });
            return c.html(reopenPage(c.req.url));
        }
        c.set('cspNonce', randomBytes(16).toString('base64'));
        // frame-src is this document's policy. Opening an embed must load the
        // document (`reloadDocument`); a client-side navigation keeps the old CSP.
        const frame = frameSrc?.(c.req.path);
        if (frame) {
            c.set('frameSrc', frame);
        }
        await next();
    };
}
