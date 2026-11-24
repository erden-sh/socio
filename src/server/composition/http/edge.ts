/**
 * The HTTP edge no single feature owns: the computers guard, compression,
 * timing, the ping, the API's body limits, its host, origin and content-type
 * checks, the security headers and the last-resort error answer. `index.ts`
 * mounts each where app.ts did.
 */
import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { allowedHost, originList } from '@socio/foundation/http/allowed-host';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { compression } from '@socio/foundation/http/compression';
import { localRequest } from '@socio/foundation/http/local-request';
import { computersGuard, type NetworkTrust } from '@socio/foundation/http/network-trust';
import { securityHeaders } from '@socio/foundation/http/security-headers';
import { UPLOAD_HEADER } from '@socio/shared/media-types';

import type { AuthSetup } from '../../auth/contract.js';
import { DATA_APPEND_PATH, DATA_UPLOAD_PATH } from '../../dataspace/routes.js';
import { ATTACHMENT_UPLOAD_PATH } from '../../issues/routes.js';
import { MEDIA_UPLOAD_PATH } from '../../media/contract.js';
import { TRANSCRIPTION_PATH } from '../../voice/contract.js';

/** The most a signed-in chat's run or connect may carry (CB-156). */
export const CHAT_REQUEST_BYTES = 32 * 1024 * 1024;
const CHAT_RUNTIME_PREFIX = '/api/copilotkit/';

export function mountComputersGuard(app: Hono<AppEnv>, network: NetworkTrust) {
    // CB-309: a socio's computer reaches the data API and nothing else,
    // before any other middleware or route sees the request.
    app.use('*', computersGuard(network));
}

/** Compression, the Server-Timing header and the connection badge's ping. */
export function mountCompressionAndPing(app: Hono<AppEnv>) {
    // gzip for everything after this, pages and health included (index.ts
    // adds them later); never streams, files or sign-in (compression.ts).
    app.use('*', compression());
    // CB-299: response-header processing time, distinct from network delay
    // and stream lifetime. Numeric only; no request or account data.
    app.use('*', async function serverTiming(c, next) {
        const started = performance.now();
        await next();
        c.header('Server-Timing', `app;dur=${(performance.now() - started).toFixed(1)}`);
    });
    // The connection badge's round trip (CB-263, connection-status.ts): an
    // empty 204, never cached, with no session or lookup, so it costs next to
    // nothing and says only that the app answered.
    app.get('/ping', (c) => c.body(null, 204, { 'Cache-Control': 'no-store' }));
}

/**
 * The API's 1 MB body limit, but for the uploads and chat runs that set
 * their own. Returns the limit, which the chat limit falls back to.
 */
export function mountBodyLimit(app: Hono<AppEnv>) {
    const limit = bodyLimit({
        maxSize: 1_000_000,
        onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    });
    // Attachment, data file and media uploads and dictation recordings set
    // their own, larger limits (issues/routes.ts, data/routes.ts,
    // media/routes.ts, workspace-routes.ts); a chat's runs and connects get
    // theirs once the person is known (below).
    app.use('/api/*', (c, next) =>
        (c.req.method === 'POST' &&
            (ATTACHMENT_UPLOAD_PATH.test(c.req.path) ||
                MEDIA_UPLOAD_PATH.test(c.req.path) ||
                c.req.path === TRANSCRIPTION_PATH ||
                // CB-369: an analytical append streams to disk under its own limit.
                DATA_APPEND_PATH.test(c.req.path))) ||
        (c.req.method === 'PUT' && DATA_UPLOAD_PATH.test(c.req.path)) ||
        c.req.path.startsWith(CHAT_RUNTIME_PREFIX)
            ? next()
            : limit(c, next),
    );
    return limit;
}

/**
 * A browser's API request: the host, mock sign-in's loopback rule, the
 * origin, Fetch Metadata and JSON-only bodies. Data tokens and plugin
 * services passed their own checks already; service keys get the host check.
 */
export function mountRequestChecks(
    app: Hono<AppEnv>,
    {
        auth,
        origin,
        navigationPaths,
        tokenPaths,
    }: {
        auth: AuthSetup;
        origin: string | string[] | undefined;
        navigationPaths: Set<string>;
        tokenPaths: Set<string>;
    },
) {
    app.use('/api/*', async function browserChecks(c, next) {
        if (c.get('dataToken') || c.get('pluginService')) {
            return next();
        }
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        const origins = originList(origin);
        if (!allowedHost(c.req.url, origins)) {
            return c.json({ error: 'Unrecognized host.' }, 403);
        }
        // Mock auth lets anyone pick any user: only this machine may ask, not
        // another one, nor a proxy forwarding for one.
        if (auth.provider.kind === 'mock' && !localRequest(c)) {
            return c.json({ error: 'Mock sign-in works only on this machine (loopback).' }, 403);
        }
        if (c.get('serviceKey')) {
            if (
                !['GET', 'HEAD'].includes(c.req.method) &&
                !c.req.header('content-type')?.includes('application/json')
            ) {
                return c.json({ error: 'Use application/json.' }, 415);
            }
            return next();
        }
        // Agents' OAuth token requests (CB-90) carry no cookies (the provider
        // drops them), so no page can make one count as the person.
        if (c.req.method === 'POST' && tokenPaths.has(c.req.path)) {
            return next();
        }
        const requestOrigin = c.req.header('origin');
        const allowedOrigins = new Set(origins ?? [new URL(c.req.url).origin]);
        if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
            return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
        }
        // An identity provider redirects back to its callback from its own site.
        // Same-site counts as another site: a sibling subdomain (a mini app on
        // `x.<APPS_HOST>` under the app's own host) gets SameSite=Strict
        // cookies sent, so only the app's own origin may call the API.
        if (
            ['cross-site', 'same-site'].includes(c.req.header('sec-fetch-site') ?? '') &&
            !(c.req.method === 'GET' && navigationPaths.has(c.req.path))
        ) {
            return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
        }
        // Raw uploads (CB-54, CB-101): octet-stream on their paths, with a custom
        // header a cross-site form can't send and a cross-origin script can't
        // without a preflight, which the app never grants.
        const rawUpload =
            c.req.method === 'POST' &&
            (MEDIA_UPLOAD_PATH.test(c.req.path) || c.req.path === TRANSCRIPTION_PATH) &&
            c.req.header(UPLOAD_HEADER) === '1' &&
            !!c.req.header('content-type')?.startsWith('application/octet-stream');
        if (
            !['GET', 'HEAD'].includes(c.req.method) &&
            !rawUpload &&
            !c.req.header('content-type')?.includes('application/json')
        ) {
            return c.json({ error: 'Use application/json.' }, 415);
        }
        await next();
    });
}

/**
 * A chat's runs and connects (CB-156), signed in: up to
 * `CHAT_REQUEST_BYTES`; anyone else gets the API's `limit`.
 */
export function mountChatLimit(app: Hono<AppEnv>, limit: MiddlewareHandler<AppEnv>) {
    // A chat's runs and connects (CB-156), signed in: nothing before the
    // check above reads a body, so a request without a session never gets
    // past 1 MB. Its requests carry only what the server doesn't have
    // (requestMessages), but a tab opened before that sends the whole
    // conversation, screenshots included: about 1.7 MB each. The runner
    // rebuilds history from storage and fitting cuts what the model can't
    // take, so such a request is taken; each new message is still at most
    // NEW_MESSAGE_BYTES (platform.ts).
    const chatLimit = bodyLimit({
        maxSize: CHAT_REQUEST_BYTES,
        onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    });
    app.use(`${CHAT_RUNTIME_PREFIX}*`, (c, next) =>
        c.get('user') && !c.get('serviceKey') && !c.get('dataToken') ? chatLimit(c, next) : limit(c, next),
    );
}

/** The last-resort answer: a logged 500 with no detail. */
export function mountErrorAnswer(app: Hono<AppEnv>) {
    app.onError((error, c) => {
        console.error('API request failed:', error.name);
        return c.json(
            {
                error: 'The server could not complete this request. Check server logs and database access.',
            },
            500,
        );
    });
}

/** The security headers, on everything index.ts adds after the app's own routes. */
export function mountSecurityHeaders(app: Hono<AppEnv>) {
    app.use('*', securityHeaders);
}

/** The edge's own steps, the ones no feature owns, as index.ts orders them, and the chat request limit. */
export const edgeRoutes = {
    computersGuard: mountComputersGuard,
    compressionAndPing: mountCompressionAndPing,
    bodyLimit: mountBodyLimit,
    requestChecks: mountRequestChecks,
    chatLimit: mountChatLimit,
    errorAnswer: mountErrorAnswer,
    securityHeaders: mountSecurityHeaders,
    chatRequestBytes: CHAT_REQUEST_BYTES,
};
