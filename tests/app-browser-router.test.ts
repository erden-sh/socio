import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { contextKey } from '@socio/foundation/actors/keys';

import { appBrowserConfigFromEnv } from '../src/app-browser/main.js';
import { commandSchema, openSealed, sealForWorker, workerKeyPair } from '../src/app-browser/protocol.js';
import { AppBrowserRouter, sameUserLaunch, setprivLaunch, workerEnv } from '../src/app-browser/router.js';

// CB-232: the app browser's router. It speaks only with the bearer
// secret, starts one worker process per context, relays the worker's key
// out and the sealed credential in, and holds no credential itself. Workers
// run real sandboxed Chromium against a loopback fake app; nothing else is
// contacted.

const SECRET = 'router-test-secret-0123456789abcdef';
const ORIGIN = 'https://board.apps.test';
let app: Server;
let upstream: string;
const seenAuth: string[] = [];

beforeAll(async () => {
    app = createServer((req, res) => {
        seenAuth.push(String(req.headers.authorization ?? ''));
        res.setHeader('content-type', 'text/html');
        res.end('<title>Board</title><p>Board page</p>');
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    upstream = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => app.close(resolve)));

const credential = (contextId: string, ttl = 15 * 60_000) => ({
    token: `cbsa_${randomBytes(32).toString('base64url')}`,
    key: contextKey('instance-secret-0123456789abcdef', contextId).toString('base64url'),
    expiresAt: Date.now() + ttl,
});

function router(max = 2) {
    const r = new AppBrowserRouter({
        secret: SECRET,
        upstream,
        max,
        launch: sameUserLaunch,
    });
    const http = r.app();
    const call = (method: string, path: string, body?: unknown, secret: string | null = SECRET) =>
        http.request(path, {
            method,
            headers: {
                ...(secret ? { authorization: `Bearer ${secret}` } : {}),
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    return { r, call };
}

describe('the router API', { timeout: 120_000 }, () => {
    it('answers nothing without its own secret', async () => {
        const { call } = router();
        expect((await call('GET', '/healthz', undefined, null)).status).toBe(200);
        for (const secret of [null, 'wrong-secret-0123456789abcdefgh', `${SECRET}x`]) {
            expect((await call('GET', '/contexts', undefined, secret)).status).toBe(401);
            expect(
                (
                    await call(
                        'POST',
                        '/contexts',
                        { contextId: randomUUID(), grantId: randomUUID(), origin: ORIGIN },
                        secret,
                    )
                ).status,
            ).toBe(401);
        }
        expect(
            () =>
                new AppBrowserRouter({
                    secret: 'short',
                    upstream,
                    max: 1,
                    launch: sameUserLaunch,
                }),
        ).toThrow('24 characters');
    });

    it('refuses malformed requests before starting anything', async () => {
        const { r, call } = router();
        const contextId = randomUUID();
        for (const body of [
            { contextId: 'not-a-uuid', grantId: randomUUID(), origin: ORIGIN },
            {
                contextId,
                grantId: randomUUID(),
                origin: 'https://board.apps.test/path',
            },
            { contextId, grantId: randomUUID(), origin: 'javascript:alert(1)' },
            {
                contextId,
                grantId: randomUUID(),
                origin: 'https://u:p@board.apps.test',
            },
            { contextId, grantId: randomUUID(), origin: ORIGIN, extra: 1 },
        ]) {
            expect((await call('POST', '/contexts', body)).status).toBe(400);
        }
        // A router that restarted refuses an open meant for its older boot.
        const stale = await call('POST', '/contexts', {
            contextId,
            grantId: randomUUID(),
            origin: ORIGIN,
            bootId: randomUUID(),
        });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({ bootId: r.bootId });
        expect(
            (
                await call('PUT', `/contexts/${contextId}/credential`, {
                    sealed: 'cbsa_x',
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await call('POST', `/contexts/${contextId}/commands`, {
                    command: { op: 'open', path: '/' },
                })
            ).status,
        ).toBe(404);
        expect(r.list().contexts).toEqual([]);
    });

    it('opens a worker per context, relays only sealed credentials, and closes by context and by grant', async () => {
        const { r, call } = router(2);
        try {
            const grantId = randomUUID();
            const contextId = randomUUID();
            const opened = await call('POST', '/contexts', {
                contextId,
                grantId,
                origin: ORIGIN,
                bootId: r.bootId,
            });
            expect(opened.status).toBe(200);
            const { workerKey, bootId } = (await opened.json()) as {
                workerKey: string;
                bootId: string;
            };
            expect(bootId).toBe(r.bootId);
            // Commands wait for a credential.
            const early = await call('POST', `/contexts/${contextId}/commands`, {
                command: { op: 'open', path: '/' },
            });
            expect(early.status).toBe(422);
            // A credential sealed to another key, or for another context, fails.
            const secret = credential(contextId);
            const wrongKey = sealForWorker(workerKeyPair().publicKey, contextId, secret);
            expect(
                (
                    await call('PUT', `/contexts/${contextId}/credential`, {
                        sealed: wrongKey,
                    })
                ).status,
            ).toBe(400);
            const wrongContext = sealForWorker(workerKey, randomUUID(), secret);
            expect(
                (
                    await call('PUT', `/contexts/${contextId}/credential`, {
                        sealed: wrongContext,
                    })
                ).status,
            ).toBe(400);
            const sealed = sealForWorker(workerKey, contextId, secret);
            expect((await call('PUT', `/contexts/${contextId}/credential`, { sealed })).status).toBe(200);
            seenAuth.length = 0;
            const page = await call('POST', `/contexts/${contextId}/commands`, {
                command: { op: 'open', path: '/' },
            });
            expect(page.status).toBe(200);
            expect(await page.json()).toMatchObject({
                result: { title: 'Board', url: `${ORIGIN}/` },
            });
            expect(seenAuth).toContain(`Bearer ${secret.token}`);
            // The self-test command is not Socio's to send.
            expect(
                (
                    await call('POST', `/contexts/${contextId}/commands`, {
                        command: { op: 'sandbox' },
                    })
                ).status,
            ).toBe(400);
            // A second context of the same grant, then the cap.
            const second = randomUUID();
            expect(
                (
                    await call('POST', '/contexts', {
                        contextId: second,
                        grantId,
                        origin: ORIGIN,
                    })
                ).status,
            ).toBe(200);
            const third = await call('POST', '/contexts', {
                contextId: randomUUID(),
                grantId: randomUUID(),
                origin: ORIGIN,
            });
            expect(third.status).toBe(429);
            expect(await third.json()).toEqual({ error: 'The app browser is busy.' });
            expect(
                (
                    (await (await call('GET', '/contexts')).json()) as {
                        contexts: unknown[];
                    }
                ).contexts,
            ).toHaveLength(2);
            // A revocation closes every context of the grant.
            expect(await (await call('DELETE', `/grants/${grantId}`)).json()).toEqual({
                closed: 2,
            });
            expect(r.list().contexts).toEqual([]);
        } finally {
            await r.stop();
        }
    });

    it('gives neither a context id nor a slot twice to opens at the same time', async () => {
        const { r } = router(1);
        try {
            const contextId = randomUUID();
            const same = await Promise.all([
                r.open({ contextId, grantId: randomUUID(), origin: ORIGIN }),
                r.open({ contextId, grantId: randomUUID(), origin: ORIGIN }),
            ]);
            expect(same.map((result) => result.status).sort()).toEqual([200, 409]);
            await r.close(contextId);
            const racing = await Promise.all([
                r.open({
                    contextId: randomUUID(),
                    grantId: randomUUID(),
                    origin: ORIGIN,
                }),
                r.open({
                    contextId: randomUUID(),
                    grantId: randomUUID(),
                    origin: ORIGIN,
                }),
            ]);
            expect(racing.map((result) => result.status).sort()).toEqual([200, 429]);
            expect(r.list().contexts).toHaveLength(1);
        } finally {
            await r.stop();
        }
    });

    it('closes contexts idle past the limit', async () => {
        let now = 1_000_000;
        const r = new AppBrowserRouter({
            secret: SECRET,
            upstream,
            max: 1,
            idleMs: 10 * 60_000,
            launch: sameUserLaunch,
            now: () => now,
        });
        try {
            expect(
                (
                    await r.open({
                        contextId: randomUUID(),
                        grantId: randomUUID(),
                        origin: ORIGIN,
                    })
                ).status,
            ).toBe(200);
            now += 9 * 60_000;
            expect(await r.closeIdle()).toBe(0);
            now += 60_000;
            expect(await r.closeIdle()).toBe(1);
            expect(r.list().contexts).toEqual([]);
        } finally {
            await r.stop();
        }
    });

    it('passes its start-up self-test: the renderer runs in Chromium’s sandbox', async () => {
        const { r } = router(1);
        const report = await r.selfTest();
        expect(report).toMatchObject({ sandboxed: true });
        expect(report.renderers).toBeGreaterThan(0);
    });
});

describe('the command vocabulary', () => {
    it('takes only paths on the app origin, and nothing beyond the six commands', () => {
        for (const path of [
            '//evil.example/x',
            '/\\evil.example',
            'https://evil.example/',
            'evil',
            '/a\u0000b',
            '/a b',
            '/a\tb',
            `/${'a'.repeat(2048)}`,
        ]) {
            expect(commandSchema.safeParse({ op: 'open', path }).success).toBe(false);
        }
        for (const path of ['/', '/deals?stage=open&x=%2F', '/a/b#frag']) {
            expect(commandSchema.safeParse({ op: 'open', path }).success).toBe(true);
        }
        for (const command of [
            { op: 'eval', script: '1' },
            { op: 'open', path: '/', url: 'https://evil.example' },
            { op: 'click', ref: 'e1' },
            { op: 'click', ref: 'e1; drop', snapshotId: 1 },
            { op: 'type', ref: 'e1', snapshotId: 1, text: 'x'.repeat(16_001) },
            { op: 'cookies' },
        ]) {
            expect(commandSchema.safeParse(command).success).toBe(false);
        }
    });
});

describe('what a worker inherits', () => {
    it('gets none of the router’s secrets in its environment', () => {
        const env = workerEnv({
            PATH: '/usr/bin',
            NODE_ENV: 'production',
            PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
            APP_BROWSER_SECRET: 'router-secret',
            APP_BROWSER_SECRET_FILE: '/run/secrets/x',
            BROWSER_SECRET: 'other',
            SESSION_SECRET: 'instance',
        });
        expect(Object.keys(env).sort()).toEqual(['HOME', 'NODE_ENV', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'TMPDIR']);
        expect(JSON.stringify(env)).not.toMatch(/secret|instance|other/i);
    });

    it('runs each slot as its own user with no capabilities and no new privileges', () => {
        const launch = setprivLaunch(21000);
        const first = launch(0);
        const second = launch(3);
        expect(first.command).toBe('setpriv');
        expect(first.args.slice(0, 7)).toEqual([
            '--reuid=21000',
            '--regid=21000',
            '--clear-groups',
            '--inh-caps=-all',
            '--ambient-caps=-all',
            '--no-new-privs',
            '--',
        ]);
        expect(second.args[0]).toBe('--reuid=21003');
        expect(first.env).not.toHaveProperty('APP_BROWSER_SECRET');
    });

    it('starts only with its own secret, an upstream and, in production, a UID per context', () => {
        const base = {
            APP_BROWSER_SECRET: SECRET,
            APP_BROWSER_UPSTREAM: 'http://company-brain-app:4312',
        };
        expect(appBrowserConfigFromEnv(base)).toMatchObject({ max: 8, port: 4360 });
        expect(() => appBrowserConfigFromEnv({ ...base, APP_BROWSER_SECRET: 'short' })).toThrow('24 characters');
        expect(() => appBrowserConfigFromEnv({ ...base, NODE_ENV: 'production' })).toThrow(
            'APP_BROWSER_UID_BASE is required',
        );
        expect(() => appBrowserConfigFromEnv({ ...base, APP_BROWSER_UID_BASE: '0' })).toThrow('UID of 1000 or more');
    });
});

describe('the router process’s memory', { timeout: 120_000 }, () => {
    let child: ChildProcess | undefined;
    let dir: string;
    afterAll(async () => {
        // Only the process this test started, by its own PID.
        if (child?.pid && child.exitCode === null) {
            const exited = new Promise((resolve) => child!.once('exit', resolve));
            child.kill('SIGTERM');
            await exited;
        }
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('never holds a context’s credential or key, only sealed bytes', async () => {
        dir = mkdtempSync(join(tmpdir(), 'app-browser-heap-'));
        const free = createServer();
        await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
        const port = (free.address() as AddressInfo).port;
        await new Promise((resolve) => free.close(resolve));
        child = spawn(
            process.execPath,
            ['--heapsnapshot-signal=SIGUSR2', `--diagnostic-dir=${dir}`, '--import', 'tsx', 'src/app-browser/main.ts'],
            {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
                    APP_BROWSER_SECRET: SECRET,
                    APP_BROWSER_UPSTREAM: upstream,
                    APP_BROWSER_PORT: String(port),
                    APP_BROWSER_MAX: '1',
                },
                stdio: 'ignore',
            },
        );
        const base = `http://127.0.0.1:${port}`;
        const call = (method: string, path: string, body?: unknown) =>
            fetch(`${base}${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${SECRET}`,
                    'content-type': 'application/json',
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        await vi.waitFor(async () => expect((await fetch(`${base}/healthz`)).ok).toBe(true), {
            timeout: 60_000,
            interval: 250,
        });
        const contextId = randomUUID();
        const opened = (await (
            await call('POST', '/contexts', {
                contextId,
                grantId: randomUUID(),
                origin: ORIGIN,
            })
        ).json()) as { workerKey: string };
        const secret = credential(contextId);
        const sealed = sealForWorker(opened.workerKey, contextId, secret);
        expect((await call('PUT', `/contexts/${contextId}/credential`, { sealed })).status).toBe(200);
        seenAuth.length = 0;
        expect(
            (
                await call('POST', `/contexts/${contextId}/commands`, {
                    command: { op: 'open', path: '/' },
                })
            ).status,
        ).toBe(200);
        // The worker used it: the credential was live in the worker.
        expect(seenAuth).toContain(`Bearer ${secret.token}`);
        child.kill('SIGUSR2');
        const snapshot = await vi.waitFor(
            () => {
                const file = readdirSync(dir).find((name) => name.endsWith('.heapsnapshot'));
                expect(file).toBeTruthy();
                const text = readFileSync(join(dir, file!), 'utf8');
                expect(text.trimEnd().endsWith('}')).toBe(true);
                return text;
            },
            { timeout: 60_000, interval: 500 },
        );
        // The snapshot holds the router's strings (its own secret and the
        // context id it relays)…
        expect(snapshot).toContain(contextId);
        // …and not the credential, its key, or anything a worker could open.
        expect(snapshot).not.toContain(secret.token);
        expect(snapshot).not.toContain(secret.key);
        expect(snapshot).not.toContain(secret.token.slice(5, 30));
        // The sealed bytes it relayed are useless without the worker's key.
        expect(openSealed(workerKeyPair(), contextId, sealed)).toBeUndefined();
    });
});
