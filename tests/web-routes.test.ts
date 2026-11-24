import { afterEach, expect, it, vi } from 'vitest';

import type { User } from '@socio/shared/types';
import type { WebStatus } from '@socio/shared/web/web-types';

import { createApp } from '../src/server/app.js';
import type { AuthSetup } from '../src/server/auth/contract.js';
import { webSettingsFromEnv } from '../src/server/web/web-reads.js';

import { staticAuth } from './fixtures/static-auth.js';
import { LocalAgentRunner, Runner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const alice: User = { id: 'alice', name: 'Alice Example', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
/** Nobody is signed in. */
const signedOut: AuthSetup = {
    secureCookies: false,
    provider: {
        kind: 'static',
        users: () => [],
        resolve: async () => null,
        routes: () => {},
    },
};

async function setup(env: Record<string, string> = {}) {
    const db = testDatabase();
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(db);
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    // The server's graph and runtime: web reads' routes read `WebReader`
    // and `WebIdentities` through it (appHandle).
    const { runtime, edge, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            web: webSettingsFromEnv({
                APP_ORIGIN: 'https://brain.example.com',
                ...env,
            }),
        },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    const app = (auth: AuthSetup) =>
        createApp({
            store,
            runner: new Runner(store, { mode: 'live', baseUrl: '' }),
            config: { mode: 'live', baseUrl: '' },
            edge,
            auth,
            runtime,
        });
    return { platform, dot: workspace.dots()[0], app };
}
const patch = (body: unknown) => ({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

it('serves /agents without sign-in: static, honest, no user data', async () => {
    const { app } = await setup({
        AGENTS_CONTACT: 'https://brain.example.com/contact',
    });
    const response = await app(signedOut).request('/agents');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain('SocioAgent/1.0 (user-directed agent; +https://brain.example.com/agents)');
    expect(html).toContain('user-directed');
    expect(html).toContain('30 requests a minute');
    expect(html).toContain('at most 2 MB of a response');
    expect(html).toContain('<code>429</code> or <code>403</code>');
    expect(html).toContain('href="https://brain.example.com/contact"');
    expect(html).not.toMatch(/<script/i);
    // The same page for everyone, signed in or not.
    expect(await (await app(staticAuth(alice)).request('/agents')).text()).toBe(html);
    expect(html).not.toMatch(/alice|Alice Example/);
    // The API itself still needs a sign-in.
    expect((await app(signedOut).request('/api/workspace')).status).toBe(401);
});

it('names the workspace operator as the contact by default, never an email', async () => {
    const { app } = await setup();
    const html = await (await app(signedOut).request('/agents')).text();
    expect(html).toContain('the operator of this Socio workspace');
    expect(html).not.toMatch(/@|mailto:/);
});

it('lets members read a Dot’s web identity and only admins change it', async () => {
    const { app, dot } = await setup();
    const member = app(staticAuth(bob));
    const read = await member.request(`/api/dots/${dot.id}/web`);
    const status = (await read.json()) as WebStatus;
    expect(status).toMatchObject({
        identity: 'agent',
        source: 'default',
        userAgent: 'SocioAgent/1.0 (user-directed agent; +https://brain.example.com/agents)',
    });
    expect(status.audit).toBeUndefined();
    expect((await member.request(`/api/dots/${dot.id}/web`, patch({ identity: 'browser' }))).status).toBe(403);
    const admin = app(staticAuth(alice));
    const changed = (await (
        await admin.request(`/api/dots/${dot.id}/web`, patch({ identity: 'browser' }))
    ).json()) as WebStatus;
    expect(changed).toMatchObject({ identity: 'browser', source: 'dot' });
    expect(changed.audit?.[0]).toMatchObject({
        userId: 'alice',
        outcome: 'identity:browser',
    });
    expect((await admin.request(`/api/dots/${dot.id}/web`, patch({ identity: 'crawler' }))).status).toBe(400);
    expect((await admin.request('/api/dots/missing/web', patch({ identity: 'agent' }))).status).toBe(404);
    const reset = (await (
        await admin.request(`/api/dots/${dot.id}/web`, patch({ identity: null }))
    ).json()) as WebStatus;
    expect(reset).toMatchObject({ identity: 'agent', source: 'default' });
});

it('runs both routes to their end when the client goes away, with no logged failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanup.push(() => errors.mockRestore());
    const { app, dot } = await setup();
    const admin = app(staticAuth(alice));
    // A client already gone: before the web contract the handlers ran to their end
    // anyway, and so do they now (`appHandle(app).uninterruptible`).
    const gone = () => {
        const client = new AbortController();
        client.abort();
        return client.signal;
    };
    const changed = await admin.request(
        new Request(`http://localhost/api/dots/${dot.id}/web`, { ...patch({ identity: 'browser' }), signal: gone() }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ identity: 'browser', source: 'dot' });
    const read = await admin.request(new Request(`http://localhost/api/dots/${dot.id}/web`, { signal: gone() }));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ identity: 'browser' });
    expect(errors).not.toHaveBeenCalled();
});
