import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, expect, it } from 'vitest';

// jsdom 31 fetches subresources and XHRs through undici 8 (its jsdom-dispatcher). A global
// `undici` override in pnpm-workspace.yaml once forced undici 6 onto it, and the loader then
// never finished: no script ran and the load event never fired. This loads a page, an external
// script and an XHR from a local server through that loader, so a forced undici shows up here.

type Window = {
    loaded?: string;
    addEventListener(type: 'load', listener: () => void): void;
    close(): void;
    XMLHttpRequest: new () => {
        open(method: string, url: string): void;
        send(): void;
        responseText: string;
        onload: (() => void) | null;
        onerror: (() => void) | null;
    };
};
type JSDOMModule = {
    JSDOM: {
        fromURL(url: string, options: { resources: 'usable'; runScripts: 'dangerously' }): Promise<{ window: Window }>;
    };
};

const { JSDOM } = createRequire(import.meta.url)('jsdom') as JSDOMModule;

let server: Server;
let base: string;

beforeAll(async () => {
    server = createServer((request, response) => {
        if (request.url === '/') {
            response.setHeader('content-type', 'text/html');
            response.end('<!doctype html><script src="/app.js"></script>');
        } else if (request.url === '/app.js') {
            response.setHeader('content-type', 'text/javascript');
            response.end('window.loaded = "script ran";');
        } else if (request.url === '/data') {
            response.end('xhr answered');
        } else {
            response.statusCode = 404;
            response.end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('loads a page, its external script and an XHR through the resource loader', async () => {
    const dom = await JSDOM.fromURL(`${base}/`, { resources: 'usable', runScripts: 'dangerously' });
    try {
        await new Promise<void>((resolve) => dom.window.addEventListener('load', resolve));
        expect(dom.window.loaded).toBe('script ran');

        const text = await new Promise<string>((resolve, reject) => {
            const xhr = new dom.window.XMLHttpRequest();
            xhr.open('GET', `${base}/data`);
            xhr.onload = () => resolve(xhr.responseText);
            xhr.onerror = () => reject(new Error('the XHR failed'));
            xhr.send();
        });
        expect(text).toBe('xhr answered');
    } finally {
        dom.window.close();
    }
}, 15_000);
