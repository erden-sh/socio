#!/usr/bin/env node
// Loopback-only browser regression for the real board and production CSS.
// Starts no Socio server and writes no issue, account or production data.
// node scripts/issue-board-scroll-smoke.mjs [--baseline] [--webkit] [--shots DIR]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const useWebkit = process.argv.includes('--webkit');
const shotsIndex = process.argv.indexOf('--shots');
const shots = shotsIndex < 0 ? undefined : resolve(process.argv[shotsIndex + 1]);
if (shots) {
    await mkdir(shots, { recursive: true });
}
const fixture = await build({
    stdin: {
        contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { MemoryRouter } from 'react-router';
      import { IssueBoard } from './packages/client/src/modules/issues/IssueBoard';
      const statuses = ['triage', 'open', 'ready', 'in_progress', 'in_review', 'done'];
      const seed = statuses.flatMap((status, column) => Array.from({ length: 35 }, (_, i) => ({
        number: column * 35 + i + 1, id: 'fixture-' + column + '-' + i,
        title: 'Card ' + i + ': scrolling remains stable across varying title lengths ' + ' words'.repeat(i % 6),
        excerpt: 'A bounded local fixture with enough cards to scroll each column. ' + 'Description '.repeat(i % 5),
        status, priority: 'medium', kind: 'bug', area: null, labels: [],
        reporterId: 'fixture', assigneeId: null, createdAt: 1, updatedAt: 1,
      })));
      function Fixture() {
        const [issues, setIssues] = useState(seed);
        const [selecting, setSelecting] = useState(false);
        const [selected, setSelected] = useState(new Set());
        return <MemoryRouter><div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <header style={{ flexShrink: 0, height: 100 }}>
            <button id="fixture-select" onClick={() => setSelecting(!selecting)}>Select cards</button>
            <output id="fixture-selected">{selected.size}</output>
          </header>
          <main style={{ minHeight: 0, flex: 1 }}><IssueBoard issues={issues} users={{}} statuses={statuses} canMove={true}
            onMove={(issue, status) => setIssues(current => current.map(row => row.number === issue.number ? { ...row, status } : row))}
            selection={{ active: selecting, selected, toggle: number => setSelected(current => {
              const next = new Set(current); if (next.has(number)) next.delete(number); else next.add(number); return next;
            }) }} /></main>
        </div></MemoryRouter>;
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
            name: 'issue-board-fixture',
            configureServer(server) {
                server.middlewares.use((request, response, next) => {
                    if (request.url === '/board-fixture.js') {
                        response.setHeader('Content-Type', 'text/javascript');
                        response.end(fixture.outputFiles[0].text);
                    } else if (request.url === '/board-fixture') {
                        response.setHeader('Content-Type', 'text/html');
                        response.end(
                            '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/packages/client/src/globals.css"><div id="root"></div><script type="module" src="/board-fixture.js"></script>',
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
async function touchSwipe(page, from, to) {
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: from[0], y: from[1] }],
        });
        for (let step = 1; step <= 10; step++) {
            await client.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [
                    {
                        x: from[0] + ((to[0] - from[0]) * step) / 10,
                        y: from[1] + ((to[1] - from[1]) * step) / 10,
                    },
                ],
            });
            await page.waitForTimeout(20);
        }
        await client.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        });
        await page.waitForTimeout(400);
    } finally {
        await client.detach();
    }
}
const results = [];
try {
    await server.listen();
    const base = server.resolvedUrls.local[0];
    for (const [engine, browserType] of useWebkit ? [['webkit', webkit]] : [['chromium', chromium]]) {
        const browser = await browserType.launch();
        try {
            for (const [width, height] of [
                [390, 720],
                [390, 180],
                [1280, 720],
            ]) {
                const page = await browser.newPage({
                    viewport: { width, height },
                    hasTouch: width < 768,
                });
                const errors = [];
                page.on('pageerror', (error) => {
                    errors.push(String(error));
                    console.error(error);
                });
                await page.goto(base + 'board-fixture');
                const board = page.locator('[data-slot="issue-board"]');
                await page.locator('[data-slot="issue-card"]').last().waitFor({ state: 'attached' });
                await page.evaluate(() => document.fonts.ready);
                await board.evaluate((node) => {
                    node.scrollLeft = 137;
                });
                await page.waitForTimeout(400);
                const horizontal = await board.evaluate((node) => ({
                    left: node.scrollLeft,
                    top: node.scrollTop,
                    snap: getComputedStyle(node).scrollSnapType,
                    height: node.clientHeight,
                    contentHeight: node.scrollHeight,
                }));
                await board.evaluate((node) => {
                    node.scrollLeft = 0;
                });
                const list = page.locator('[data-slot="issue-column"]').first().locator('ul');
                const before = await list.evaluate((node) => {
                    const card = node.querySelectorAll('[data-slot="issue-card"]')[5];
                    const rect = card.getBoundingClientRect();
                    return {
                        top: rect.top,
                        height: rect.height,
                        width: rect.width,
                        client: node.clientHeight,
                        total: node.scrollHeight,
                    };
                });
                await list.evaluate((node) => {
                    node.scrollTop = 500;
                });
                await page.waitForTimeout(400);
                const after = await list.evaluate((node) => {
                    const card = node.querySelectorAll('[data-slot="issue-card"]')[5];
                    const rect = card.getBoundingClientRect();
                    const cards = [...node.querySelectorAll('[data-slot="issue-card"]')].map((card) =>
                        card.getBoundingClientRect(),
                    );
                    return {
                        top: rect.top,
                        height: rect.height,
                        width: rect.width,
                        scroll: node.scrollTop,
                        overlap: cards.slice(1).some((card, i) => card.top < cards[i].bottom - 1),
                    };
                });
                let touch;
                if (engine === 'chromium' && width < 768 && height >= 300) {
                    await list.evaluate((node) => {
                        node.scrollTop = 0;
                    });
                    await touchSwipe(page, [140, 550], [140, 250]);
                    const vertical = await list.evaluate((node) => node.scrollTop);
                    await touchSwipe(page, [270, 350], [70, 350]);
                    touch = {
                        vertical,
                        horizontal: await board.evaluate((node) => node.scrollLeft),
                    };
                    assert.ok(touch.vertical > 100, 'a touch swipe must scroll the card column');
                    assert.ok(touch.horizontal > 100, 'a touch swipe over cards must scroll the board');
                    await board.evaluate((node) => {
                        node.scrollLeft = 0;
                    });
                }
                const result = {
                    engine,
                    width,
                    height,
                    horizontal,
                    touch,
                    before,
                    after,
                    errors,
                };
                results.push(result);
                console.log(JSON.stringify(result));
                if (shots) {
                    await page.screenshot({
                        path: resolve(shots, `${engine}-${width}-${height}.png`),
                    });
                }
                if (!baseline) {
                    assert.ok(
                        Math.abs(horizontal.left - 137) <= 1,
                        'horizontal scroll must retain the requested position without snap-back',
                    );
                    assert.equal(
                        horizontal.contentHeight,
                        horizontal.height,
                        'board must not create a second vertical scroll area',
                    );
                    assert.ok(before.total > before.client, 'dense column must overflow vertically');
                    assert.ok(after.scroll > 450, 'column must scroll independently');
                    assert.ok(
                        Math.abs(after.top - before.top + after.scroll) <= 1,
                        'card position must change only by the scroll distance',
                    );
                    assert.equal(after.height, before.height);
                    assert.equal(after.width, before.width);
                    assert.equal(after.overlap, false, 'cards must retain their full height without overlap');
                    assert.deepEqual(errors, []);
                }
                if (height < 300) {
                    await page.close();
                    continue;
                }
                // Exercise the same touch-accessible Move menu and selection after scrolling.
                await list.evaluate((node) => {
                    node.scrollTop = 0;
                });
                await page.getByRole('button', { name: 'Move CB-1', exact: true }).click();
                await page.getByRole('menuitemradio', { name: 'Open', exact: true }).click();
                assert.equal(await page.locator('[data-status="open"] [data-issue="CB-1"]').count(), 1);
                await page.locator('#fixture-select').click();
                await page.locator('[data-status="triage"] [data-slot="issue-card"]').first().click();
                assert.equal(await page.locator('#fixture-selected').textContent(), '1');
                assert.deepEqual(errors, []);
                await page.close();
            }
        } finally {
            await browser.close();
        }
    }
    if (shots) {
        await writeFile(resolve(shots, 'results.json'), JSON.stringify(results, null, 2));
    }
} finally {
    await server.close();
}
