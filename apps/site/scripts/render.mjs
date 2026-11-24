#!/usr/bin/env node
// Renders the built site (dist/, from `pnpm run build`) with Playwright's Chromium, offline:
//
//   node scripts/render.mjs og            the link-preview images (public/og/<page>.png, 1200×630)
//                                         and public/apple-touch-icon.png (180×180), committed
//   node scripts/render.mjs shots <dir>   every page at 1440 and 390, light and dark, as
//                                         <dir>/<page>-<desktop|mobile>-<light|dark>.png, and the
//                                         cookie dialog at those sizes and at 320×568
//
// The pages are served from dist/ through a route on a made-up origin; every other request is
// aborted, so nothing leaves the machine. Run `pnpm run build` first (and again after `og`, so
// dist/ carries the new images).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { chromium } from 'playwright';

import { PAGE_KEYS, PAGES } from '../src/build/facts.ts';
import { ogHtml, touchIconHtml } from '../src/build/og.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const ORIGIN = 'http://site.invalid';
const TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('Build the site first: pnpm run build');
}
const css = /<link rel="stylesheet" href="([^"]+)">/.exec(readFileSync(join(DIST, 'index.html'), 'utf8'))[1];
const extra = new Map();

/** Serves dist/ (and the templates in `extra`) at ORIGIN; aborts anything else. */
async function serve(context) {
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) {
            return route.abort();
        }
        let path = decodeURIComponent(url.pathname);
        if (extra.has(path)) {
            return route.fulfill({ body: extra.get(path), contentType: 'text/html' });
        }
        if (path.endsWith('/')) {
            path += 'index.html';
        }
        if (!extname(path)) {
            path += '.html';
        }
        const file = join(DIST, path);
        if (!file.startsWith(DIST) || !existsSync(file)) {
            return route.fulfill({ status: 404, body: 'not found' });
        }
        return route.fulfill({
            body: readFileSync(file),
            contentType: TYPES[extname(file)] ?? 'application/octet-stream',
        });
    });
}

const [mode, out] = process.argv.slice(2);
const browser = await chromium.launch();
try {
    if (mode === 'og') {
        mkdirSync(join(ROOT, 'public/og'), { recursive: true });
        const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, colorScheme: 'light' });
        await serve(context);
        const tab = await context.newPage();
        for (const key of PAGE_KEYS) {
            extra.set(`/_og/${key}`, ogHtml(key, css));
            await tab.goto(`${ORIGIN}/_og/${key}`, { waitUntil: 'load' });
            await tab.screenshot({ path: join(ROOT, 'public/og', `${key}.png`) });
        }
        await tab.setViewportSize({ width: 180, height: 180 });
        extra.set('/_og/touch', touchIconHtml(css));
        await tab.goto(`${ORIGIN}/_og/touch`, { waitUntil: 'load' });
        await tab.screenshot({ path: join(ROOT, 'public/apple-touch-icon.png') });
        await context.close();
    } else if (mode === 'shots' && out) {
        mkdirSync(out, { recursive: true });
        const SIZES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
        for (const scheme of ['light', 'dark']) {
            for (const [size, viewport] of Object.entries(SIZES)) {
                const context = await browser.newContext({
                    viewport,
                    colorScheme: scheme,
                    deviceScaleFactor: size === 'mobile' ? 2 : 1,
                });
                await serve(context);
                const tab = await context.newPage();
                for (const key of PAGE_KEYS) {
                    await tab.goto(`${ORIGIN}${PAGES[key].path}`, { waitUntil: 'load' });
                    await tab.screenshot({ path: join(out, `${key}-${size}-${scheme}.png`), fullPage: true });
                }
                // The Cookie settings dialog, opened as the footer's button opens it.
                await tab.goto(`${ORIGIN}/cookies`, { waitUntil: 'load' });
                await tab.click('.footer-bottom [data-open-cookie-settings]');
                await tab.screenshot({ path: join(out, `consent-settings-${size}-${scheme}.png`) });
                await context.close();
            }
            // The dialog on a small phone (320×568), where it has to scroll.
            const small = await browser.newContext({
                viewport: { width: 320, height: 568 },
                colorScheme: scheme,
                deviceScaleFactor: 2,
            });
            await serve(small);
            const tab = await small.newPage();
            await tab.goto(`${ORIGIN}/cookies`, { waitUntil: 'load' });
            await tab.click('.footer-bottom [data-open-cookie-settings]');
            await tab.screenshot({ path: join(out, `consent-settings-320x568-${scheme}.png`) });
            await small.close();
        }
    } else {
        throw new Error('Usage: node scripts/render.mjs og | shots <dir>');
    }
} finally {
    await browser.close();
}
console.log('done');
