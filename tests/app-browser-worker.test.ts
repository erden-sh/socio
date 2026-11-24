import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { contextKey, verifyContextProof } from '@socio/foundation/actors/keys';

import { OFF_ORIGIN_PAGE } from '../src/app-browser/intercept.js';
import { sealForWorker } from '../src/app-browser/protocol.js';
import { ContextWorker } from '../src/app-browser/worker.js';

// CB-232: the context worker's origin lock and credential injection,
// with a real sandboxed headless Chromium against loopback fakes only. The
// "app" is a fake app server behind the fake internal upstream; "outside"
// is another loopback server and UDP socket that must see nothing at all.

const ORIGIN = 'https://deals.apps.test';
const SECRET = 'app-browser-test-secret-0123456789';

interface Seen {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: Buffer;
}

let app: Server;
let outside: Server;
let udp: Socket;
let upstream: string;
let outsidePort: number;
let udpPort: number;
const seen: Seen[] = [];
const outsideHits: string[] = [];
let outsideConnections = 0;
let udpPackets = 0;
const wsHeaders: IncomingMessage['headers'][] = [];

const listen = (server: Server) =>
    new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    );

function pageHtml() {
    const out = `http://127.0.0.1:${outsidePort}`;
    return `<!doctype html><html><head><title>Deals</title>
<link rel="dns-prefetch" href="//leak-dns.outside.test">
<link rel="preconnect" href="${out}">
<link rel="prefetch" href="${out}/prefetch">
<link rel="stylesheet" href="${out}/style.css">
</head><body>
<h1>Pipeline</h1>
<a href="/next">Next page</a>
<button id="go" onclick="location.href='/redirect-out'">Leave</button>
<form method="post" action="/submit"><label>Note <input name="note"></label><button>Save</button></form>
<img src="${out}/pixel.png">
<p id="echo">pending</p>
<p id="cookie">cookie:${''}</p>
<p id="rtc">rtc</p>
<script>
  document.getElementById('cookie').textContent = 'cookie:' + document.cookie;
  fetch('/api/echo').then(r => r.json()).then(j => { document.getElementById('echo').textContent = 'echo ' + j.authorization; });
  fetch('${out}/fetch', { mode: 'no-cors' }).catch(() => {});
  try { navigator.sendBeacon('${out}/beacon', 'x'); } catch {}
  try { new EventSource('${out}/events'); } catch {}
  try { window.open('${out}/popup'); } catch {}
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
    pc.createDataChannel('x');
    pc.createOffer().then(o => pc.setLocalDescription(o));
    document.getElementById('rtc').textContent = 'rtc made';
  } catch (e) { document.getElementById('rtc').textContent = 'rtc refused'; }
</script>
</body></html>`;
}

beforeAll(async () => {
    outside = createServer((req, res) => {
        outsideHits.push(req.url ?? '');
        res.end('outside');
    });
    outside.on('connection', () => outsideConnections++);
    outsidePort = await listen(outside);
    udp = createSocket('udp4');
    udp.on('message', () => udpPackets++);
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    udpPort = udp.address().port;

    app = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            seen.push({
                method: req.method ?? '',
                url: req.url ?? '',
                headers: req.headers,
                body,
            });
            const url = req.url ?? '/';
            if (url === '/' || url.startsWith('/?')) {
                res.setHeader('content-type', 'text/html; charset=utf-8');
                res.setHeader('set-cookie', 'session=leaked; Path=/');
                res.setHeader('x-cb-actor', 'v1.should-not-reach-the-page');
                res.end(pageHtml());
            } else if (url === '/api/echo') {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ authorization: req.headers.authorization }));
            } else if (url === '/next') {
                res.setHeader('content-type', 'text/html');
                res.end('<title>Next</title><p>Second page</p>');
            } else if (url === '/redirect-in') {
                res.statusCode = 302;
                res.setHeader('location', '/next');
                res.end();
            } else if (url === '/redirect-out') {
                res.statusCode = 302;
                res.setHeader('location', `http://127.0.0.1:${outsidePort}/landing?token=abc`);
                res.end();
            } else if (url === '/redirect-protocol-relative') {
                res.statusCode = 301;
                res.setHeader('location', `//127.0.0.1:${outsidePort}/x`);
                res.end();
            } else if (url === '/submit') {
                res.setHeader('content-type', 'text/html');
                res.end(`<title>Saved</title><p>saved ${body.length}</p>`);
            } else if (url === '/data-nav') {
                res.setHeader('content-type', 'text/html');
                res.end(`<title>Data</title><script>location.href='data:text/html,<p>elsewhere</p>'</script>`);
            } else if (url === '/ws-page') {
                res.setHeader('content-type', 'text/html');
                res.end(`<title>WS</title><p id="s">waiting</p><script>
          const ws = new WebSocket('wss://deals.apps.test/ws');
          ws.onmessage = (e) => { document.getElementById('s').textContent = 'got ' + e.data; };
          ws.onopen = () => ws.send('hello');
          const other = new WebSocket('ws://127.0.0.1:${outsidePort}/ws');
          other.onerror = () => {};
        </script>`);
            } else {
                res.statusCode = 404;
                res.end('missing');
            }
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    app.on('upgrade', (req, socket, head) => {
        wsHeaders.push(req.headers);
        wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(`echo:${data.toString()}`)));
    });
    upstream = `http://127.0.0.1:${await listen(app)}`;
});

afterAll(async () => {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => outside.close(resolve));
    udp.close();
});

async function worker() {
    const w = new ContextWorker();
    const contextId = randomUUID();
    const token = `cbsa_${randomBytes(32).toString('base64url')}`;
    const key = contextKey(SECRET, contextId);
    expect(
        await w.handle({
            id: 1,
            type: 'init',
            contextId,
            origin: ORIGIN,
            upstream,
        }),
    ).toEqual({ ok: true, result: {} });
    const sealed = sealForWorker(w.keys.publicKey, contextId, {
        token,
        key: key.toString('base64url'),
        expiresAt: Date.now() + 15 * 60_000,
    });
    expect((await w.handle({ id: 2, type: 'credential', sealed })).ok).toBe(true);
    let id = 10;
    const run = async (command: Record<string, unknown>) => {
        const result = await w.handle({
            id: id++,
            type: 'command',
            command: command as never,
        });
        if (!result.ok) {
            throw new Error(result.error);
        }
        return result.result as Record<string, unknown>;
    };
    return { w, contextId, token, key, run };
}

const sha256Hex = (body: Buffer) => (body.length ? createHash('sha256').update(body).digest('hex') : '');

describe('the origin lock', { timeout: 60_000 }, () => {
    it('refuses commands before it holds a credential, and a credential sealed for another context', async () => {
        const w = new ContextWorker();
        const contextId = randomUUID();
        await w.handle({
            id: 1,
            type: 'init',
            contextId,
            origin: ORIGIN,
            upstream,
        });
        expect(
            await w.handle({
                id: 2,
                type: 'command',
                command: { op: 'open', path: '/' },
            }),
        ).toEqual({ ok: false, error: 'This app browser’s access has ended.' });
        const other = sealForWorker(w.keys.publicKey, randomUUID(), {
            token: `cbsa_${randomBytes(32).toString('base64url')}`,
            key: randomBytes(32).toString('base64url'),
            expiresAt: Date.now() + 60_000,
        });
        expect(await w.handle({ id: 3, type: 'credential', sealed: other })).toEqual({
            ok: false,
            error: 'Invalid credential.',
        });
        // Sealed for another worker's key: unreadable here.
        const stranger = new ContextWorker();
        const notMine = sealForWorker(stranger.keys.publicKey, contextId, {
            token: `cbsa_${randomBytes(32).toString('base64url')}`,
            key: randomBytes(32).toString('base64url'),
            expiresAt: Date.now() + 60_000,
        });
        expect(await w.handle({ id: 4, type: 'credential', sealed: notMine })).toEqual({
            ok: false,
            error: 'Invalid credential.',
        });
        // An origin with a path or credentials is not an origin.
        const bad = new ContextWorker();
        expect(
            await bad.handle({
                id: 1,
                type: 'init',
                contextId,
                origin: 'https://user:pw@deals.apps.test',
                upstream,
            }),
        ).toEqual({ ok: false, error: 'Invalid context.' });
        await w.close();
    });

    it('injects the credential and a valid context proof at the network layer; the page never sees either', async () => {
        seen.length = 0;
        outsideHits.length = 0;
        outsideConnections = 0;
        udpPackets = 0;
        const { w, token, key, run } = await worker();
        try {
            const opened = await run({ op: 'open', path: '/?stage=open' });
            expect(opened).toMatchObject({ status: 200, title: 'Deals' });
            // Let the page's script and Chromium's own background work run.
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            const first = seen.find((s) => s.url === '/?stage=open')!;
            expect(first.headers.authorization).toBe(`Bearer ${token}`);
            expect(first.headers.host).toBe('deals.apps.test');
            expect(first.headers.cookie).toBeUndefined();
            expect(
                verifyContextProof(key, first.headers['x-cb-context'] as string, {
                    method: 'GET',
                    host: 'deals.apps.test',
                    requestTarget: '/?stage=open',
                    bodyDigest: '',
                }),
            ).toBe(true);
            // The proof is bound to the request: another target fails.
            expect(
                verifyContextProof(key, first.headers['x-cb-context'] as string, {
                    method: 'GET',
                    host: 'deals.apps.test',
                    requestTarget: '/next',
                    bodyDigest: '',
                }),
            ).toBe(false);
            // The page's own fetch to the app was signed too.
            expect(seen.some((s) => s.url === '/api/echo')).toBe(true);
            const snap = await run({ op: 'snapshot' });
            const text = String(snap.snapshot);
            // The app echoed the Authorization header into the page: the worker
            // took its own token out before anything left it.
            expect(text).toContain('echo Bearer [redacted]');
            expect(text).not.toContain(token);
            // No cookie reached the page (Set-Cookie dropped), nor any x-cb-*.
            expect(text).toContain('cookie:');
            expect(text).not.toContain('session=leaked');
            // WebRTC's constructor is gone before page script runs.
            expect(text).toContain('rtc refused');
            // Nothing left for the outside: not a connection, not a packet.
            expect(outsideConnections).toBe(0);
            expect(outsideHits).toEqual([]);
            expect(udpPackets).toBe(0);
            expect(Number(snap.blocked)).toBeGreaterThan(0);
        } finally {
            await w.close();
        }
    });

    it('follows redirects on the app origin and ends navigations that leave it, sending nothing there', async () => {
        outsideConnections = 0;
        outsideHits.length = 0;
        const { w, run } = await worker();
        try {
            expect(await run({ op: 'open', path: '/redirect-in' })).toMatchObject({
                title: 'Next',
                url: `${ORIGIN}/next`,
            });
            const out = await run({ op: 'open', path: '/redirect-out' });
            expect(out).toMatchObject({
                title: 'Stopped',
                stopped: 'The app browser stopped the app tried to send you to another site.',
            });
            // Counted for the context audit.
            expect(out.offOriginRedirects).toBe(1);
            expect(String((await run({ op: 'snapshot' })).snapshot)).toContain(
                'The app tried to send you to another site',
            );
            expect(OFF_ORIGIN_PAGE).not.toContain('127.0.0.1');
            await run({ op: 'open', path: '/redirect-protocol-relative' });
            // A script navigation to a data: document is undone.
            await run({ op: 'open', path: '/data-nav' });
            await new Promise((resolve) => setTimeout(resolve, 500));
            const after = await run({ op: 'snapshot' });
            expect(String(after.snapshot)).not.toContain('elsewhere');
            expect(outsideConnections).toBe(0);
            expect(outsideHits).toEqual([]);
        } finally {
            await w.close();
        }
    });

    it('signs a POST over its exact body, and clicks and types only from the newest snapshot', async () => {
        seen.length = 0;
        const { w, key, run } = await worker();
        try {
            await run({ op: 'open', path: '/' });
            const snap = await run({ op: 'snapshot' });
            const text = String(snap.snapshot);
            const field = /textbox "Note" \[ref=(e\d+)\]/.exec(text)?.[1];
            const save = /button "Save" \[ref=(e\d+)\]/.exec(text)?.[1];
            expect(field && save).toBeTruthy();
            await expect(
                run({
                    op: 'click',
                    ref: save,
                    snapshotId: Number(snap.snapshotId) - 1,
                }),
            ).rejects.toThrow('take a fresh app_snapshot');
            await run({
                op: 'type',
                ref: field,
                snapshotId: snap.snapshotId,
                text: 'call back friday',
            });
            const clicked = await run({
                op: 'click',
                ref: save,
                snapshotId: snap.snapshotId,
            });
            expect(clicked).toMatchObject({ title: 'Saved' });
            const post = seen.find((s) => s.method === 'POST')!;
            expect(post.body.toString()).toBe('note=call+back+friday');
            expect(
                verifyContextProof(key, post.headers['x-cb-context'] as string, {
                    method: 'POST',
                    host: 'deals.apps.test',
                    requestTarget: '/submit',
                    bodyDigest: sha256Hex(post.body),
                }),
            ).toBe(true);
            expect(post.headers.origin).toBe(ORIGIN);
            const shot = await run({ op: 'screenshot' });
            expect(String(shot.base64).length).toBeGreaterThan(1000);
            expect(shot).toMatchObject({ width: 1280, height: 800 });
        } finally {
            await w.close();
        }
    });

    it('bridges the app’s WebSockets with the credential in headers, and closes any other', async () => {
        wsHeaders.length = 0;
        outsideConnections = 0;
        const { w, token, key, run } = await worker();
        try {
            await run({ op: 'open', path: '/ws-page' });
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            expect(String((await run({ op: 'snapshot' })).snapshot)).toContain('got echo:hello');
            expect(wsHeaders).toHaveLength(1);
            expect(wsHeaders[0]!.authorization).toBe(`Bearer ${token}`);
            expect(wsHeaders[0]!.host).toBe('deals.apps.test');
            expect(wsHeaders[0]!.cookie).toBeUndefined();
            expect(
                verifyContextProof(key, wsHeaders[0]!['x-cb-context'] as string, {
                    method: 'GET',
                    host: 'deals.apps.test',
                    requestTarget: '/ws',
                    bodyDigest: '',
                }),
            ).toBe(true);
            expect(outsideConnections).toBe(0);
        } finally {
            await w.close();
        }
    });

    it('control: without the lock and flags the same harness sees a leak', async () => {
        outsideConnections = 0;
        const browser = await chromium.launch({
            headless: true,
            chromiumSandbox: true,
        });
        try {
            const page = await browser.newPage();
            await page.setContent(`<img src="http://127.0.0.1:${outsidePort}/pixel.png">`);
            await page.waitForTimeout(500);
            expect(outsideConnections).toBeGreaterThan(0);
        } finally {
            await browser.close();
        }
    });

    it('stops sending once the credential has expired', async () => {
        seen.length = 0;
        const { w, run } = await worker();
        await run({ op: 'open', path: '/' });
        const count = seen.length;
        const contextId = (w as unknown as { contextId: string }).contextId;
        // A credential that has already ended is refused outright.
        const stale = sealForWorker(w.keys.publicKey, contextId, {
            token: `cbsa_${randomBytes(32).toString('base64url')}`,
            key: randomBytes(32).toString('base64url'),
            expiresAt: Date.now() - 1,
        });
        expect(await w.handle({ id: 99, type: 'credential', sealed: stale })).toEqual({
            ok: false,
            error: 'Expired credential.',
        });
        expect(seen.length).toBe(count);
        await w.close();
    });
});
