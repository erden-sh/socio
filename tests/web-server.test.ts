import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { Hono } from 'hono';
import { createContext, type RouterContextProvider, type ServerBuild } from 'react-router';
import { afterAll, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import {
    CONTENT_SECURITY_POLICY,
    pageContentSecurityPolicy,
    securityHeaders,
} from '@socio/foundation/http/security-headers';
import { MANIFEST_PATH, REOPENED_COOKIE, reopenPage } from '@socio/foundation/web/guard';
import { DEFAULT_BRANDING } from '@socio/shared/branding';
import type { WebContext } from '@socio/shared/web/web';

import routerConfig from '../react-router.config';
import { createApp } from '../src/server/app.js';
import type { AuthSetup } from '../src/server/auth/contract.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { requestUserResolver } from '../src/server/auth/request-user.js';
import { createSessionValue, SESSION_COOKIE } from '../src/server/auth/session.js';
import { IMMUTABLE, mountWeb } from '../src/server/web/mount.js';
import { productionWeb } from '../src/server/web/prod.js';
import { webServices } from '../src/server/web/services.js';

import { staticAuth } from './fixtures/static-auth.js';
import { testPageViews } from './helpers/page-views.js';
import { Runner } from './helpers/runners.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// A browser build: one hashed asset and the public files.
const root = mkdtempSync(join(tmpdir(), 'cb-web-'));
mkdirSync(join(root, 'assets'));
mkdirSync(join(root, '.vite'));
writeFileSync(join(root, 'assets', 'app-1.js'), 'console.log("app");');
writeFileSync(join(root, 'theme-init.js'), '// theme');
// A big one with its build-time gzip copy (scripts/precompress.mjs).
const bundle = `export const words = ${JSON.stringify('word '.repeat(2000))};`;
writeFileSync(join(root, 'assets', 'big-1.js'), bundle);
writeFileSync(join(root, 'assets', 'big-1.js.gz'), gzipSync(bundle));
writeFileSync(join(root, '.vite', 'manifest.json'), '{}');
const store = new Store(testDatabase());
afterAll(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
});

// A server build whose document handler echoes what it was given: its own
// context key's value (the build is where the key comes from), and the
// user its services resolve.
const webContext = createContext<WebContext>();
const build = {
    entry: {
        module: {
            webContext,
            default: async (
                request: Request,
                status: number,
                headers: Headers,
                _context: unknown,
                loadContext: RouterContextProvider,
            ) => {
                const { nonce, services } = loadContext.get(webContext);
                headers.set('Content-Type', 'application/json');
                return new Response(
                    JSON.stringify({
                        page: new URL(request.url).pathname,
                        nonce,
                        user: (await services.user())?.id ?? null,
                        // A page the size of a real one, past the gzip threshold.
                        ...(new URL(request.url).searchParams.has('big') ? { padding: 'page '.repeat(1000) } : {}),
                    }),
                    { status, headers },
                );
            },
        },
    },
    // A root and a splat under it (the app's NotFound): every path matches.
    routes: {
        root: { id: 'root', path: '', module: { default: () => null } },
        page: {
            id: 'page',
            parentId: 'root',
            path: '*',
            module: { default: () => null },
        },
    },
    assets: {
        entry: { module: '/assets/entry.js', imports: [] },
        routes: {
            root: {
                id: 'root',
                path: '',
                module: '/assets/root.js',
                hasAction: false,
                hasLoader: false,
                hasClientAction: false,
                hasClientLoader: false,
                hasClientMiddleware: false,
                hasErrorBoundary: false,
            },
            page: {
                id: 'page',
                parentId: 'root',
                path: '*',
                module: '/assets/page.js',
                hasAction: false,
                hasLoader: false,
                hasClientAction: false,
                hasClientLoader: false,
                hasClientMiddleware: false,
                hasErrorBoundary: false,
            },
        },
        url: '/assets/manifest-v1.js',
        version: 'v1',
    },
    publicPath: '/',
    assetsBuildDirectory: root,
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'lazy', manifestPath: MANIFEST_PATH },
} as unknown as ServerBuild;

// The server's order (index.ts): the API, the headers, health, the pages.
// The provider renews its session on every request, as Better Auth's
// sliding sessions do.
const config = { mode: 'sample' as const, baseUrl: 'http://127.0.0.1:1/v1' };
const renewing = staticAuth();
const resolve = renewing.provider.resolve;
renewing.provider.resolve = (request, setHeader) => {
    setHeader?.('Set-Cookie', 'session=renewed; Path=/; HttpOnly');
    return resolve(request, setHeader);
};
const app = createApp({
    auth: renewing,
    store,
    runner: new Runner(store, config),
    config,
    origin: 'https://brain.example',
});
app.all('/api/copilotkit/*', (c) => c.json({ runtime: true }));
app.use('*', securityHeaders);
app.get('/healthz', (c) => c.json({ ok: true }));
mountWeb(app, {
    build,
    mode: 'production',
    clientDir: root,
    origin: 'https://brain.example',
    services: webServices({ store, config, auth: renewing, views: testPageViews() }, requestUserResolver(renewing)),
});

const page = async (response: Response) =>
    response.status === 200
        ? ((await response.json()) as {
              page: string;
              nonce: string;
              user: string | null;
          })
        : undefined;

it('renders every other path as a page, with its own nonce in the CSP and no caching', async () => {
    const nonces = new Set<string>();
    for (const path of ['/', '/spaces/s1/pages/p1', '/chats/c1', '/issues/CB-1', '/no/such/route']) {
        const response = await app.request(path);
        const body = await page(response);
        expect(body?.page, path).toBe(path);
        expect(body!.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
        expect(response.headers.get('content-security-policy')).toBe(pageContentSecurityPolicy(body!.nonce));
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        // The services resolved the user, and the renewed cookie came along.
        expect(body!.user).toBe('owner');
        expect(response.headers.get('set-cookie')).toBe('session=renewed; Path=/; HttpOnly');
        nonces.add(body!.nonce);
    }
    expect(nonces.size).toBe(5);
    // The page's own host (APP_ORIGIN) is a page too.
    expect((await page(await app.request('https://brain.example/runs')))?.page).toBe('/runs');
});

it('keeps the API, health, the CopilotKit runtime and files ahead of the pages', async () => {
    const unknown = await app.request('/api/unknown');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found.' });
    // Any method, not only GET.
    const posted = await app.request('/api/unknown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    expect(posted.status).toBe(404);
    expect(posted.headers.get('content-type')).toMatch(/json/);
    expect(await (await app.request('/api/state')).json()).toHaveProperty('tasks');
    const health = await app.request('/healthz');
    expect(await health.json()).toEqual({ ok: true });
    expect(health.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(
        await (
            await app.request('/api/copilotkit/agent/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            })
        ).json(),
    ).toEqual({ runtime: true });
});

it('serves files with their cache headers, and a missing one as a plain 404', async () => {
    const asset = await app.request('/assets/app-1.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('console.log');
    expect(asset.headers.get('cache-control')).toBe(IMMUTABLE);
    // Files get the strict policy: no nonce.
    expect(asset.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    const theme = await app.request('/theme-init.js');
    expect(theme.status).toBe(200);
    expect(theme.headers.get('cache-control')).toBe('no-cache');
    // An old build's chunk after a deploy: 404, never a page, never cached,
    // so the browser's import fails and the tab reloads.
    for (const path of ['/assets/app-0.js', '/favicon.ico', '/x/style.css']) {
        const missing = await app.request(path);
        expect(missing.status, path).toBe(404);
        expect(missing.headers.get('cache-control'), path).toBe('no-store');
        expect(await missing.text(), path).toBe('Not found.');
    }
    // A release's page has dots in its address, and is still a page (CB-168).
    const release = await app.request('/releases/v0.5.0');
    expect(await release.text()).not.toBe('Not found.');
    // Dot segments are never served, even when the file exists.
    const manifest = await app.request('/.vite/manifest.json');
    expect(manifest.status).toBe(404);
    expect(await manifest.text()).toBe('Not found.');
});

const GZIP = { 'Accept-Encoding': 'gzip, deflate, br, zstd' };
const gunzip = (response: Response) => new Response(response.body!.pipeThrough(new DecompressionStream('gzip'))).text();

it('sends build files gzipped from their build-time copy, and plain to a range request', async () => {
    const gzipped = await app.request('/assets/big-1.js', { headers: GZIP });
    expect(gzipped.status).toBe(200);
    expect(gzipped.headers.get('content-encoding')).toBe('gzip');
    expect(gzipped.headers.get('vary')).toBe('Accept-Encoding');
    expect(gzipped.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(gzipped.headers.get('content-type')).toMatch(/javascript/);
    expect(Number(gzipped.headers.get('content-length'))).toBe(gzipSync(bundle).byteLength);
    expect(await gunzip(gzipped)).toBe(bundle);
    const plain = await app.request('/assets/big-1.js');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(plain.headers.get('vary')).toBe('Accept-Encoding');
    expect(await plain.text()).toBe(bundle);
    const range = await app.request('/assets/big-1.js', {
        headers: { ...GZIP, Range: 'bytes=0-9' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-encoding')).toBeNull();
    expect(await range.text()).toBe(bundle.slice(0, 10));
});

it('gzips a page when asked, with its own nonce in the CSP and no caching', async () => {
    const response = await app.request('/chats/c1?big', { headers: GZIP });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBe('session=renewed; Path=/; HttpOnly');
    const body = JSON.parse(await gunzip(response)) as { nonce: string };
    expect(response.headers.get('content-security-policy')).toBe(pageContentSecurityPolicy(body.nonce));
    const plain = await app.request('/chats/c1?big');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect((await plain.json()).nonce).not.toBe(body.nonce);
});

it('refuses what pages never take: other methods, other hosts, data for other sites', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const response = await app.request('/settings', { method });
        expect(response.status, method).toBe(405);
        expect(response.headers.get('allow')).toBe('GET, HEAD');
    }
    // Also a file's path: only GET and HEAD read files.
    expect((await app.request('/assets/app-1.js', { method: 'POST' })).status).toBe(405);
    const head = await app.request('/settings', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('no-store');
    expect((await app.request('http://brain.evil/')).status).toBe(403);
    // A link from another site opens the page (Telegram, email)...
    for (const site of ['cross-site', 'same-site', 'same-origin', 'none']) {
        expect(
            (
                await app.request('/approvals/a1', {
                    headers: { 'sec-fetch-site': site },
                })
            ).status,
            site,
        ).toBe(200);
    }
    // ...but another site's page can't read its data or route manifest.
    for (const path of ['/approvals/a1.data', '/issues/_.data', `${MANIFEST_PATH}?version=v1&paths=%2F`]) {
        for (const site of ['cross-site', 'same-site']) {
            const response = await app.request(path, {
                headers: { 'sec-fetch-site': site },
            });
            expect(response.status, `${path} ${site}`).toBe(403);
            expect(response.headers.get('cache-control')).toBe('no-store');
        }
    }
    const data = await app.request('/approvals/a1.data', {
        headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(data.status).toBe(200);
    expect(data.headers.get('cache-control')).toBe('no-store');
});

it('opens a page from another site again from this one, so it gets the session cookie', async () => {
    // A link in web mail or an identity provider's redirect: the browser
    // leaves the SameSite=Strict session cookie out of this request.
    const navigate = {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
    };
    const reopen = await app.request('/approvals/a1?view=list&q=%22x%22', {
        headers: navigate,
    });
    expect(reopen.status).toBe(200);
    const html = await reopen.text();
    expect(html).toBe(reopenPage('http://localhost/approvals/a1?view=list&q=%22x%22'));
    expect(html).toContain('<script src="/reopen.js"></script>');
    // Without JavaScript, a refresh to the address (attribute-escaped).
    expect(html).toContain(
        '<noscript><meta http-equiv="refresh" content="0;url=/approvals/a1?view=list&#38;q=%22x%22"></noscript>',
    );
    expect(reopenPage('http://localhost/a?b="<x>\'')).toContain('url=/a?b=%22%3Cx%3E%27"');
    // Never to another site.
    for (const path of ['//elsewhere.example/x', '/\\elsewhere.example/x']) {
        expect(reopenPage(`http://localhost${path}`), path).toContain('url=/elsewhere.example/x"');
    }
    expect(reopen.headers.get('content-type')).toMatch(/^text\/html/);
    expect(reopen.headers.get('cache-control')).toBe('no-store');
    // No inline script: the strict policy, no nonce.
    expect(reopen.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    const set = reopen.headers.get('set-cookie') ?? '';
    expect(set).toContain(`${REOPENED_COOKIE}=1`);
    expect(set).toContain('Max-Age=10');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    // The reload comes from this site; were it still called cross-site, the
    // cookie makes it the page, not another round.
    expect(
        (
            await page(
                await app.request('/approvals/a1', {
                    headers: { ...navigate, cookie: `${REOPENED_COOKIE}=1` },
                }),
            )
        )?.page,
    ).toBe('/approvals/a1');
    for (const headers of [
        { ...navigate, 'sec-fetch-site': 'same-origin' },
        { ...navigate, 'sec-fetch-site': 'same-site' },
        { ...navigate, 'sec-fetch-site': 'none' },
        // Not a navigation (an image or a prefetch): nothing to reopen.
        { ...navigate, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    ]) {
        expect((await page(await app.request('/approvals/a1', { headers })))?.page, JSON.stringify(headers)).toBe(
            '/approvals/a1',
        );
    }
    // The script reloads, which keeps an old `/#/spaces/…` link's hash.
    expect(readFileSync('public/reopen.js', 'utf8')).toContain('location.reload()');
});

it('sends a tab on an older build to load the page again', async () => {
    expect(routerConfig.routeDiscovery.manifestPath).toBe(MANIFEST_PATH);
    const stale = await app.request(`${MANIFEST_PATH}?version=v0&paths=%2F`);
    expect(stale.status).toBe(204);
    expect(stale.headers.get('x-remix-reload-document')).toBe('true');
    expect(stale.headers.get('cache-control')).toBe('no-store');
    // The current version's manifest keeps React Router's own caching.
    const current = await app.request(`${MANIFEST_PATH}?version=v1&paths=%2F`);
    expect(current.status).toBe(200);
    expect(current.headers.get('cache-control')).toBe(IMMUTABLE);
});

it('refuses to start without a page build or its context key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-web-build-'));
    try {
        await expect(productionWeb(dir)).rejects.toThrow('run pnpm run build');
        mkdirSync(join(dir, 'server'));
        writeFileSync(join(dir, 'server', 'index.js'), 'export const entry = { module: {} };');
        await expect(productionWeb(dir)).rejects.toThrow('entry.server.tsx must export webContext');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

it('resolves the user once per page request, and signs mock auth from another machine out', async () => {
    const alice = { id: 'alice', name: 'Alice', role: 'admin' as const };
    const provider = new MockAuthProvider([alice], 'test-secret');
    let resolved = 0;
    const resolveAlice = provider.resolve.bind(provider);
    provider.resolve = (request) => {
        resolved++;
        return resolveAlice(request);
    };
    const auth: AuthSetup = { provider, secureCookies: false };
    const services = webServices({ store, config, auth, views: testPageViews() }, requestUserResolver(auth));
    const probe = new Hono<AppEnv>();
    probe.get('/', async (c) => {
        const { services: page } = services(c);
        const [first, second] = await Promise.all([page.user(), page.user()]);
        const state = await page.state().catch((error: Error) => error.message);
        return c.json({
            same: first === second,
            user: first?.id ?? null,
            state: typeof state === 'string' ? state : 'state',
            workspace: await page.workspace().catch((error: Error) => error.message),
            signIn: await page.signIn(),
        });
    });
    const cookie = `${SESSION_COOKIE}=${createSessionValue('test-secret', 'alice')}`;
    // In-process requests have no socket: they count as this machine.
    const local = await (await probe.request('/', { headers: { cookie } })).json();
    expect(local).toEqual({
        same: true,
        user: 'alice',
        state: 'state',
        // No platform: no workspace.
        signIn: { provider: 'mock', branding: DEFAULT_BRANDING },
    });
    expect(resolved).toBe(1);
    // Forwarded by a proxy: someone else's machine, so nobody is signed in.
    const forwarded = await (
        await probe.request('/', {
            headers: { cookie, 'x-forwarded-for': '203.0.113.9' },
        })
    ).json();
    expect(forwarded).toMatchObject({
        user: null,
        state: 'Signed out: no data for this request.',
    });
    expect(resolved).toBe(1);
});
