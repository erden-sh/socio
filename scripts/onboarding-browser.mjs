import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname, basename } from 'node:path';

// Local synthetic workspace only: real React controller + bundled Driver.js,
// fake people and preferences. No model/provider, auth or live app requests.
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'artifacts/onboarding-browser-' + Date.now());
mkdirSync(out, { recursive: true, mode: 0o700 });
await build({
    absWorkingDir: root,
    entryPoints: [],
    stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {OnboardingFixture,exampleWorkspace} from './packages/client/tests/fixtures/onboarding-app';const person=document.cookie.match(/fixture_person=([^;]+)/)?.[1]||'member-desktop';const role=person.split('-')[0];fetch('/fixture/preferences').then(r=>r.json()).then(p=>createRoot(document.getElementById('root')).render(<OnboardingFixture browser workspace={exampleWorkspace(role,p)}/>));`,
        resolveDir: root,
        sourcefile: 'onboarding-browser.tsx',
        loader: 'tsx',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    outdir: out,
    entryNames: 'fixture',
    assetNames: 'asset-[hash]',
    loader: { '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    alias: {
        '@copilotkit/web-inspector': resolve(root, 'packages/client/src/no-web-inspector.ts'),
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
});
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>:root{--card:#fff;--card-foreground:#17221d;--border:#d4d4d4;--secondary:#eee;--secondary-foreground:#17221d;--primary:#176047;--ring:#176047;--radius:8px}body{font:16px system-ui;margin:0;padding:20px}main{padding:20px;min-height:400px}button{min-height:44px;margin:4px}textarea{width:80%;min-height:160px}section{padding:12px}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
const preferences = new Map(),
    writes = [];
const server = createServer(async (req, res) => {
    const person = /fixture_person=([^;]+)/.exec(req.headers.cookie || '')?.[1] || 'member-desktop';
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/fixture/preferences') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(preferences.get(person) || {}));
        return;
    }
    if (url.pathname === '/api/preferences') {
        assert.equal(req.method, 'PATCH');
        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }
        const input = JSON.parse(body);
        assert.deepEqual(Object.keys(input), ['onboarding']);
        writes.push({ person, body: input });
        preferences.set(person, {
            ...preferences.get(person),
            ...input.onboarding,
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ dictation: null, onboarding: preferences.get(person) }));
        return;
    }
    if (url.pathname.startsWith('/docs/')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(
            '<!doctype html><title>Topic help fixture</title><h1>Topic help fixture</h1><p>Return to the original tab to continue the same guide step.</p>',
        );
        return;
    }
    const file = resolve(out, basename(url.pathname));
    if (existsSync(file) && file.startsWith(out + '/') && extname(file)) {
        res.setHeader(
            'Content-Type',
            file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream',
        );
        res.end(readFileSync(file));
        return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port,
    result = {
        ok: false,
        checks: [],
        errors: [],
        requests: [],
        closed: false,
        syntheticOnly: true,
    };
let browser;
try {
    browser = await chromium.launch({ headless: true });
    for (const { role, mobile } of [
        { role: 'member', mobile: false },
        { role: 'member', mobile: true },
        { role: 'admin', mobile: false },
    ]) {
        const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
            deviceScaleFactor: mobile ? 3 : 1,
            isMobile: mobile,
            reducedMotion: 'reduce',
        });
        const person = role + '-' + (mobile ? 'mobile' : 'desktop');
        await context.addCookies([{ name: 'fixture_person', value: person, url: origin }]);
        await context.route('**/*', (route) => {
            const request = route.request(),
                u = new URL(request.url());
            result.requests.push({ method: request.method(), path: u.pathname });
            if (u.origin !== origin) {
                result.errors.push('Unexpected foreign request');
                return route.abort();
            }
            if (request.method() !== 'GET' && !(request.method() === 'PATCH' && u.pathname === '/api/preferences')) {
                result.errors.push('Unexpected content mutation');
                return route.abort();
            }
            return route.continue();
        });
        const page = await context.newPage();
        page.on('console', (message) => {
            if (message.type() === 'error') {
                result.errors.push(message.text());
            }
        });
        page.on('pageerror', (e) => result.errors.push(e.message));
        page.on('requestfailed', (r) =>
            result.errors.push(r.method() + ' ' + new URL(r.url()).pathname + ' ' + r.failure()?.errorText),
        );
        await page.goto(origin, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Skip', exact: true }).click();
        await page.waitForTimeout(100);
        await page.reload();
        assert.equal(await page.locator('[data-tour="onboarding-offer"]').count(), 0);
        if (role === 'member') {
            await page.getByRole('button', { name: 'Replay Getting started', exact: true }).click();
            await page.locator('.driver-popover-title').filter({ hasText: 'Welcome to Socio' }).waitFor();
            assert.equal(
                await page
                    .locator('.driver-popover')
                    .evaluate(
                        (el) => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0,
                    ),
                true,
            );
            await page.screenshot({
                path: resolve(out, mobile ? 'mobile-guide.png' : 'desktop-guide.png'),
            });
            const [article] = await Promise.all([
                page.waitForEvent('popup'),
                page.getByRole('link', { name: /Read More about Welcome/ }).click(),
            ]);
            await article.waitForLoadState();
            assert.equal(new URL(article.url()).pathname, '/docs/getting-started');
            await article.close();
            assert.equal(await page.locator('.driver-popover-title').textContent(), 'Welcome to Socio');
            await page.keyboard.press('ArrowRight');
            await page.locator('.driver-popover-title').filter({ hasText: 'Choose a socio' }).waitFor();
            await page.keyboard.press('ArrowRight');
            await page.locator('.driver-popover-title').filter({ hasText: 'Start with a conversation' }).waitFor();
            assert(page.url().endsWith('/dots/fixture-socio/new'));
            assert.equal(await page.getByRole('textbox', { name: 'Message your socio' }).inputValue(), '');
            await page.keyboard.press('Escape');
            await page.locator('.driver-overlay').waitFor({ state: 'detached' });
            await page.waitForTimeout(100);
            await page.reload();
            assert.equal(await page.locator('[data-tour="onboarding-offer"]').count(), 0);
            await page.getByRole('button', { name: 'Replay Getting started', exact: true }).click();
            await page.locator('.driver-popover-title').filter({ hasText: 'Start with a conversation' }).waitFor();
            // Exercise every remaining step, including absent editor/page-chat targets.
            for (let i = 0; i < 8; i++) {
                const next = page.locator('.driver-popover-next-btn');
                if ((await next.textContent()) === 'Done') {
                    await next.click();
                    break;
                }
                await next.click();
                await page.waitForTimeout(1350);
            }
            await page.locator('.driver-overlay').waitFor({ state: 'detached' });
            assert.equal(preferences.get(person)['getting-started'].status, 'completed');
        }
        const focused = [
            'Goals and schedules',
            'The Improvements board',
            ...(role !== 'member' ? ['Admin guide', 'Running Socio'] : []),
        ];
        for (const title of focused) {
            await page.getByRole('button', { name: 'Help & guides', exact: true }).click();
            assert.equal(
                await page.getByRole('heading', { name: 'Admin guide', exact: true }).count(),
                role === 'member' ? 0 : 1,
            );
            assert.equal(
                await page.getByRole('heading', { name: 'Running Socio', exact: true }).count(),
                role === 'member' ? 0 : 1,
            );
            await page.getByRole('button', { name: 'Start ' + title, exact: true }).click();
            await page.locator('.driver-popover').waitFor();
            for (let n = 0; n < 10; n++) {
                const next = page.locator('.driver-popover-next-btn');
                const done = (await next.textContent()) === 'Done';
                const link = page.locator('.socio-tour-links a');
                assert((await link.getAttribute('href')).startsWith('/docs/'));
                await next.click();
                if (done) {
                    break;
                }
                await page.waitForTimeout(1350);
            }
            await page.locator('.driver-overlay').waitFor({ state: 'detached' });
        }
        assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
        result.checks.push({
            role,
            viewport: mobile ? '390x844' : '1280x900',
            focusedGuides: focused,
            skippedAcrossReload: true,
            ...(role === 'member' ? { readMorePreservedStep: true, keyboardRouteResume: true } : {}),
            completed: true,
            noContentWrites: true,
        });
        await page.screenshot({
            path: resolve(out, mobile ? 'mobile.png' : 'desktop.png'),
        });
        await context.close();
    }
    result.ok = true;
} catch (error) {
    result.failure = String(error);
    throw error;
} finally {
    if (browser) {
        await browser.close();
        result.closed = true;
    }
    await new Promise((resolve) => server.close(resolve));
    result.writes = writes;
    writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 2), {
        mode: 0o600,
    });
}
assert(result.ok && result.closed && result.errors.length === 0);
console.log(
    JSON.stringify({
        ok: true,
        checks: result.checks,
        closed: true,
        artifact: out,
    }),
);
