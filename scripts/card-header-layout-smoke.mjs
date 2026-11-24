#!/usr/bin/env node
// Loopback-only browser regression for card headers with an action (CB-262),
// on the real Card components and production CSS. Starts no Socio server.
// node scripts/card-header-layout-smoke.mjs [--webkit] [--shots DIR]
//
// On a phone (390 and 430 px wide) the action goes under the description at
// full width and the title and description keep the whole header; on a wide
// screen the action stays beside them, top-aligned at the right edge.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const useWebkit = process.argv.includes('--webkit');
const shotsIndex = process.argv.indexOf('--shots');
const shots = shotsIndex < 0 ? undefined : resolve(process.argv[shotsIndex + 1]);
if (shots) {
    await mkdir(shots, { recursive: true });
}
const fixture = await build({
    stdin: {
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Button } from './packages/client/src/components/ui/button';
      import { Input } from './packages/client/src/components/ui/input';
      import { Card, CardAction, CardDescription, CardHeader, CardTitle } from './packages/client/src/components/ui/card';
      const text = 'Each socio has a scratch dataset for you, created the first time it needs one. Other datasets a socio uses only with your grant.';
      function Fixture() {
        return <main style={{ padding: 16, display: 'grid', gap: 16 }}>
          <Card data-case="form"><CardHeader>
            <CardTitle>Datasets</CardTitle>
            <CardDescription>{text}</CardDescription>
            <CardAction><form className="flex gap-2">
              <Input aria-label="New dataset name" placeholder="New dataset" />
              <Button type="submit">Create</Button>
            </form></CardAction>
          </CardHeader></Card>
          <Card data-case="button"><CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>{text}</CardDescription>
            <CardAction><Button>Open Media</Button></CardAction>
          </CardHeader></Card>
          <Card data-case="title-only"><CardHeader>
            <CardTitle>Running work</CardTitle>
            <CardAction><Button>Stop</Button></CardAction>
          </CardHeader></Card>
          <Card data-case="no-action"><CardHeader>
            <CardTitle>Usage</CardTitle>
            <CardDescription>{text}</CardDescription>
          </CardHeader></Card>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `,
        resolveDir: root,
        loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    alias: { '@': resolve(root, 'packages/client/src') },
    define: { 'process.env.NODE_ENV': '"production"' },
});
const server = await createServer({
    root,
    configFile: false,
    plugins: [
        tailwindcss(),
        {
            name: 'card-header-fixture',
            configureServer(server) {
                server.middlewares.use((request, response, next) => {
                    if (request.url === '/card-fixture.js') {
                        response.setHeader('Content-Type', 'text/javascript');
                        response.end(fixture.outputFiles[0].text);
                    } else if (request.url === '/card-fixture') {
                        response.setHeader('Content-Type', 'text/html');
                        response.end(
                            '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/packages/client/src/globals.css"><div id="root"></div><script type="module" src="/card-fixture.js"></script>',
                        );
                    } else {
                        next();
                    }
                });
            },
        },
    ],
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { noDiscovery: true, include: [] },
});
try {
    await server.listen();
    const base = server.resolvedUrls.local[0];
    const browser = await (useWebkit ? webkit : chromium).launch();
    try {
        for (const width of [390, 430, 1280]) {
            const narrow = width < 768;
            const page = await browser.newPage({
                viewport: { width, height: 900 },
                hasTouch: narrow,
            });
            const errors = [];
            page.on('pageerror', (error) => errors.push(String(error)));
            await page.goto(base + 'card-fixture');
            await page.locator('[data-case="no-action"]').waitFor();
            await page.evaluate(() => document.fonts.ready);
            const cases = await page.evaluate(() =>
                [...document.querySelectorAll('[data-case]')].map((card) => {
                    const box = (slot) => card.querySelector(`[data-slot="${slot}"]`)?.getBoundingClientRect();
                    const header = card.querySelector('[data-slot="card-header"]');
                    const style = getComputedStyle(header);
                    const left = header.getBoundingClientRect().left;
                    const content = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
                    const at = (rect) =>
                        rect && {
                            left: Math.round(rect.left - left - parseFloat(style.paddingLeft)),
                            right: Math.round(rect.right - left - parseFloat(style.paddingLeft)),
                            top: Math.round(rect.top),
                            bottom: Math.round(rect.bottom),
                            width: Math.round(rect.width),
                        };
                    return {
                        name: card.dataset.case,
                        content: Math.round(content),
                        title: at(box('card-title')),
                        description: at(box('card-description')),
                        action: at(box('card-action')),
                        overflow: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
                    };
                }),
            );
            for (const c of cases) {
                const where = `${width}px ${c.name}`;
                assert.equal(c.overflow, false, `${where}: no page overflow`);
                assert.equal(c.title.left, 0, `${where}: title at the left edge`);
                if (c.description) {
                    assert.equal(c.description.left, 0, `${where}: description left`);
                    assert.ok(c.description.top >= c.title.bottom, `${where}: description under the title`);
                }
                if (!c.action) {
                    assert.equal(c.description.width, c.content, `${where}: full width`);
                    continue;
                }
                const above = c.description ?? c.title;
                if (narrow) {
                    assert.equal(above.width, c.content, `${where}: text at full width`);
                    assert.ok(c.action.top >= above.bottom, `${where}: action below`);
                    assert.equal(c.action.left, 0, `${where}: action at the left`);
                    assert.equal(c.action.width, c.content, `${where}: action full width`);
                } else {
                    assert.equal(c.action.top, c.title.top, `${where}: action on top`);
                    assert.equal(c.action.right, c.content, `${where}: action at right`);
                    assert.ok(above.right <= c.action.left, `${where}: text beside the action`);
                }
            }
            assert.deepEqual(errors, []);
            if (shots) {
                await page.screenshot({
                    path: resolve(shots, `card-header-${width}.png`),
                    fullPage: true,
                });
            }
            await page.close();
            console.log(
                `card-header-layout: ${useWebkit ? 'webkit' : 'chromium'} ${width}px ok (${cases.length} cards)`,
            );
        }
    } finally {
        await browser.close();
    }
} finally {
    await server.close();
}
