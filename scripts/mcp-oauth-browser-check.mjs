// Local, disposable HTTPS origins only. Run: node --import tsx scripts/mcp-oauth-browser-check.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { chromium } from 'playwright';

import { mcpPublicRoutes } from '../src/server/mcp/routes.ts';

const dir = mkdtempSync(join(tmpdir(), 'socio-mcp-cookie-'));
let browser, server;
try {
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            join(dir, 'key.pem'),
            '-out',
            join(dir, 'cert.pem'),
            '-days',
            '1',
            '-subj',
            '/CN=socio.test',
        ],
        { stdio: 'ignore' },
    );
    const app = new Hono();
    const requests = [];
    let origin, provider;
    app.use('*', async (c, next) => {
        requests.push({
            path: c.req.path,
            url: c.req.url,
            cookie: c.req.header('cookie') ?? '',
            referer: c.req.header('referer') ?? '',
            site: c.req.header('sec-fetch-site') ?? '',
        });
        await next();
    });
    app.get('/seed', (c) => {
        c.header('Set-Cookie', 'fixture_session=owner; Secure; HttpOnly; SameSite=Strict; Path=/', { append: true });
        c.header('Set-Cookie', 'fixture_nonce=bound; Secure; HttpOnly; SameSite=Lax; Path=/api/mcp-connections/oauth', {
            append: true,
        });
        return c.html(`<a href="${provider}/authorize">Go to provider</a>`);
    });
    app.get('/authorize', (c) =>
        c.html(
            `<a href="${origin}/api/mcp-connections/oauth/callback?state=${'s'.repeat(43)}&code=local-code">Return to Socio</a>`,
        ),
    );
    app.post('/api/mcp-connections/oauth/complete', async (c) => {
        assert.match(c.req.header('cookie') ?? '', /fixture_session=owner/);
        assert.match(c.req.header('cookie') ?? '', /fixture_nonce=bound/);
        assert.equal(c.req.header('origin'), origin);
        assert.equal(c.req.header('sec-fetch-site'), 'same-origin');
        assert.equal(c.req.header('referer'), undefined);
        assert.deepEqual(await c.req.json(), {
            state: 's'.repeat(43),
            code: 'local-code',
        });
        return c.json({ id: 'fixture' });
    });
    app.get('/settings/account', (c) => c.html('<p>Account settings</p>'));
    app.route('/', mcpPublicRoutes({ origin: 'https://socio.test' }));
    server = createServer(
        {
            key: readFileSync(join(dir, 'key.pem')),
            cert: readFileSync(join(dir, 'cert.pem')),
        },
        async (req, res) => {
            try {
                const chunks = [];
                for await (const chunk of req) {
                    chunks.push(chunk);
                }
                const body = Buffer.concat(chunks),
                    url = 'https://' + req.headers.host + req.url;
                const response = await app.fetch(
                    new Request(url, {
                        method: req.method,
                        headers: req.headers,
                        ...(body.length ? { body } : {}),
                    }),
                );
                res.statusCode = response.status;
                for (const [key, value] of response.headers) {
                    if (key !== 'set-cookie') {
                        res.setHeader(key, value);
                    }
                }
                const cookies = response.headers.getSetCookie();
                if (cookies.length) {
                    res.setHeader('set-cookie', cookies);
                }
                res.end(Buffer.from(await response.arrayBuffer()));
            } catch {
                res.statusCode = 500;
                res.end('Fixture failed');
            }
        },
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    origin = `https://socio.test:${port}`;
    provider = `https://provider.test:${port}`;
    browser = await chromium.launch({
        args: ['--host-resolver-rules=MAP socio.test 127.0.0.1, MAP provider.test 127.0.0.1', '--no-proxy-server'],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(origin + '/seed');
    await page.getByRole('link', { name: 'Go to provider' }).click();
    await page.getByRole('link', { name: 'Return to Socio' }).click();
    await page.waitForURL(origin + '/settings/account?mcp=review');
    const callback = requests.find((r) => r.path === '/api/mcp-connections/oauth/callback'),
        complete = requests.find((r) => r.path === '/api/mcp-connections/oauth/complete');
    assert(callback && complete);
    assert.equal(callback.site, 'cross-site');
    assert.doesNotMatch(callback.cookie, /fixture_session/);
    assert.match(callback.cookie, /fixture_nonce=bound/);
    assert.match(complete.cookie, /fixture_session=owner/);
    assert.equal(complete.site, 'same-origin');
    assert.equal(complete.referer, '');
    assert(requests.every((r) => r.path === '/api/mcp-connections/oauth/callback' || !/state=|local-code/.test(r.url)));
    assert.equal(await page.evaluate(() => document.cookie), '');
    console.log(
        JSON.stringify({
            crossSiteCallback: true,
            strictSessionAbsentOnCallback: true,
            strictSessionPresentOnSameOriginCompletion: true,
            laxNoncePresent: true,
            noCompletionReferrer: true,
            secretFreeReturn: true,
        }),
    );
} finally {
    await browser?.close();
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    rmSync(dir, { recursive: true, force: true });
}
