import { createHash } from 'node:crypto';

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { McpConnections } from './connections.js';
import { MCP_CALLBACK, McpConnectionError } from './contract.js';
import { fingerprint } from './json.js';
import { McpOAuth, mcpClientMetadata } from './oauth.js';

const COMPLETE = '/api/mcp-connections/oauth/complete';
const RETURN = '/settings/account';
const cookieName = (stateHash: string) => 'mcp_oauth_' + stateHash.slice(0, 24);
const cookiePath = '/api/mcp-connections/oauth';
export interface McpRouteServices {
    connections: McpConnections;
    oauth: McpOAuth;
    socios: (userId: string) => Array<{ id: string; name: string }>;
}
// Trusted static script, with a hash CSP. It removes the sensitive query before
// any asynchronous work; there are no resources, user text, or provider URLs.
const landingScript = `const query=new URLSearchParams(location.search);history.replaceState(null,'',location.pathname);const state=query.get('state'),code=query.get('code');if(!state||!code){location.replace('${RETURN}?mcp=cancelled')}else{fetch('${COMPLETE}',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,code})}).then(r=>{location.replace('${RETURN}?mcp='+ (r.ok?'review':'failed'))}).catch(()=>{location.replace('${RETURN}?mcp=failed')})}`;
export function mcpPublicRoutes(oauth: McpOAuth) {
    const app = new Hono<AppEnv>();
    app.get('/.well-known/socio-mcp-client.json', (c) => {
        try {
            return c.json({
                client_id: oauth.origin + '/.well-known/socio-mcp-client.json',
                ...mcpClientMetadata(oauth.origin),
            });
        } catch {
            return c.json({ error: 'External OAuth is not configured.' }, 503);
        }
    });
    app.get(MCP_CALLBACK, (c) => {
        c.header('Cache-Control', 'no-store');
        c.header('Referrer-Policy', 'no-referrer');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header(
            'Content-Security-Policy',
            `default-src 'none'; script-src 'sha256-${createHash('sha256').update(landingScript).digest('base64')}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        return c.html(
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connecting to Socio</title><script>${landingScript}</script></head><body><p>Completing your connection…</p><noscript>Enable JavaScript, then reconnect from your account settings.</noscript></body></html>`,
        );
    });
    return app;
}
export function mcpConnectionRoutes({ connections, oauth, socios }: McpRouteServices) {
    const app = new Hono<AppEnv>();
    app.use('/mcp-connections', async (c, next) => {
        if (c.get('dataToken') || c.get('serviceKey')) {
            return c.json({ error: 'Use your signed-in personal account.' }, 403);
        }
        await next();
    });
    app.use('/mcp-connections/*', async (c, next) => {
        if (c.get('dataToken') || c.get('serviceKey')) {
            return c.json({ error: 'Use your signed-in personal account.' }, 403);
        }
        await next();
    });
    app.onError((error, c) => {
        if (error instanceof McpConnectionError) {
            return c.json({ error: error.message }, error.status as 400);
        }
        if (error instanceof z.ZodError) {
            return c.json({ error: 'Invalid connection settings.' }, 400);
        }
        // Remote messages may contain secrets. Never return or log their errors.
        return c.json({ error: 'The connection operation could not complete.' }, 502);
    });
    app.get('/mcp-connections', (c) => {
        const user = c.get('user').id;
        return c.json({
            connections: connections.list(user).map((row) => ({ ...row, grants: connections.grants(user, row.id) })),
            socios: socios(user),
        });
    });
    app.post('/mcp-connections', async (c) =>
        c.json(await connections.create(c.get('user').id, await c.req.json()), 201),
    );
    app.post('/mcp-connections/:id/discover', async (c) =>
        c.json(await oauth.discover(c.get('user').id, c.req.param('id'), c.req.raw.signal)),
    );
    app.post('/mcp-connections/:id/authorize', async (c) => {
        const result = await oauth.authorize(c.get('user').id, c.req.param('id'), await c.req.json(), c.req.raw.signal);
        const { cookie, stateHash, ...view } = result;
        setCookie(c, cookieName(stateHash), cookie, {
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
            path: cookiePath,
            maxAge: 600,
        });
        c.header('Cache-Control', 'no-store');
        return c.json(view);
    });
    app.post('/mcp-connections/oauth/complete', async (c) => {
        const data = z
            .object({
                state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
                code: z.string().min(1).max(4096),
            })
            .strict()
            .parse(await c.req.json());
        const name = cookieName(fingerprint(data.state)),
            cookie = getCookie(c, name) ?? '';
        // Same-origin JSON completion uses the existing Strict session, in addition
        // to the separate nonce cookie and single-use owner-bound durable attempt.
        deleteCookie(c, name, {
            path: cookiePath,
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
        });
        c.header('Cache-Control', 'no-store');
        const row = await oauth.callback(c.get('user').id, data.state, cookie, data.code, c.req.raw.signal);
        await oauth.catalog(c.get('user').id, row.id, c.req.raw.signal);
        return c.json({ id: row.id });
    });
    app.post('/mcp-connections/:id/catalog', async (c) =>
        c.json(await oauth.catalog(c.get('user').id, c.req.param('id'), c.req.raw.signal)),
    );
    app.put('/mcp-connections/:id/grants', async (c) =>
        c.json(await connections.grant(c.get('user').id, c.req.param('id'), await c.req.json())),
    );
    app.post('/mcp-connections/:id/disconnect', async (c) =>
        c.json(await connections.disconnect(c.get('user').id, c.req.param('id'))),
    );
    app.delete('/mcp-connections/:id', async (c) => {
        await connections.remove(c.get('user').id, c.req.param('id'));
        return c.json({ removed: true });
    });
    return app;
}
