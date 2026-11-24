// Local actual-component layout/security check; no provider calls or accounts.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import tailwind from '@tailwindcss/vite';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const text = '<img src="https://untrusted.invalid/image" onerror="alert(1)">' + 'Long remote metadata '.repeat(20);
const state = {
    socios: [{ id: 'dot', name: 'My socio' }],
    connections: [
        {
            id: '88b88b88-8888-4888-8888-888888888888',
            name: text.slice(0, 80),
            url: 'https://mcp.example.test/' + 'path/'.repeat(40),
            authentication: 'none',
            state: 'review',
            generation: 2,
            catalogRevision: 'c'.repeat(64),
            createdAt: 1,
            updatedAt: 1,
            grants: [],
            tools: [
                {
                    name: 'allowed',
                    description: text,
                    inputSchema: {
                        type: 'object',
                        properties: { note: { type: 'string', description: text } },
                    },
                    supported: true,
                    fingerprint: 'f'.repeat(64),
                },
            ],
        },
    ],
};
const fixture = await build({
    stdin: {
        contents: `import React from 'react';import{createRoot}from'react-dom/client';import{McpConnectionsSection}from'./packages/client/src/modules/settings/McpConnectionsSection';createRoot(document.getElementById('root')).render(<McpConnectionsSection/>);`,
        resolveDir: root,
        loader: 'tsx',
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    format: 'esm',
    alias: { '@': root + '/packages/client/src' },
    plugins: [
        {
            name: 'mock-only-local-api',
            setup(b) {
                b.onResolve({ filter: /^\.\.\/\.\.\/lib\/api$/ }, (args) =>
                    args.importer.endsWith('/McpConnectionsSection.tsx')
                        ? { path: 'api', namespace: 'fixture' }
                        : undefined,
                );
                b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
                    loader: 'js',
                    contents: `const state=${JSON.stringify(state)};window.actions=[];export async function api(path,method='GET',body){window.actions.push({path,method,body});if(method==='GET')return structuredClone(state);if(path.endsWith('/grants')){state.connections[0].grants=[{...body,revision:'changed'}];return [];}throw Error('Unexpected local fixture operation')}`,
                }));
            },
        },
    ],
});
const server = await createServer({
    root,
    configFile: false,
    plugins: [
        tailwind(),
        {
            name: 'fixture',
            configureServer(s) {
                s.middlewares.use((req, res, next) => {
                    if (req.url === '/fixture.js') {
                        res.setHeader('Content-Type', 'text/javascript');
                        res.end(fixture.outputFiles[0].text);
                    } else if (req.url === '/fixture') {
                        res.setHeader('Content-Type', 'text/html');
                        res.end(
                            '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/packages/client/src/globals.css"><main id="root" class="mx-auto max-w-3xl min-w-0 p-4"></main><script type="module" src="/fixture.js"></script>',
                        );
                    } else {
                        next();
                    }
                });
            },
        },
    ],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
    await server.listen();
    browser = await chromium.launch();
    const evidence = [];
    for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } }),
            foreign = [];
        page.on('request', (request) => {
            if (!request.url().startsWith(server.resolvedUrls.local[0])) {
                foreign.push(request.url());
            }
        });
        await page.goto(server.resolvedUrls.local[0] + 'fixture');
        await page.getByRole('button', { name: 'Save tool access for this socio' }).waitFor();
        await page.getByText('Full schema and provider hints', { exact: true }).click();
        assert.equal(await page.locator('img,iframe').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.deepEqual(await page.evaluate(() => window.actions.map((a) => a.method)), ['GET']);
        await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Save tool access for this socio' }).click();
        await page.waitForFunction(() => window.actions.some((a) => a.method === 'PUT'));
        const receipt = await page.evaluate(() => window.actions.find((a) => a.method === 'PUT'));
        assert.deepEqual(receipt.body.tools, ['allowed']);
        assert.equal(receipt.body.generation, 2);
        assert.equal(receipt.body.catalogRevision, 'c'.repeat(64));
        assert.deepEqual(foreign, []);
        evidence.push({
            width,
            documentWidth: await page.evaluate(() => document.documentElement.scrollWidth),
            remoteRequests: foreign.length,
            explicitGrant: true,
            renderedActiveRemoteElements: 0,
        });
        await page.close();
    }
    console.log(JSON.stringify(evidence));
} finally {
    await browser?.close();
    await server.close();
}
