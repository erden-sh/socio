import { afterEach, expect, it } from 'vitest';

import { modelGateway } from '../src/server/gateway/model.js';

import { gatewaySetup, UPSTREAM_KEY } from './support/gateway-fixture.js';
import { fakeModelApis, sseEvents } from './support/model-fakes.js';

// CB-326: the Anthropic Messages route for coding sessions, which
// Claude Code reaches with ANTHROPIC_BASE_URL at the gateway and the
// session's token as a bearer. The same stamp, credential, model binding,
// body rules, reservation and metering as the other two APIs, against a
// loopback fake of a Messages backend. Negative cases first.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function setup() {
    const f = await gatewaySetup();
    cleanup.push(() => f.close());
    const apis = await fakeModelApis();
    cleanup.push(() => apis.close());
    const backend = await f.platform.inference.createBackend({
        label: 'Messages backend',
        baseUrl: apis.url,
        model: 'claude-x',
        apiKey: UPSTREAM_KEY,
    });
    await f.gateway.settings.saveModel(
        'claude',
        {
            label: 'Claude X',
            backendId: backend.id,
            upstreamModel: 'claude-x-upstream',
            maxOutputTokens: 3000,
        },
        'olga',
    );
    const messages = (
        s: { token: string; sandboxId: string },
        body: Record<string, unknown> = {},
        headers: Record<string, string> = {},
    ) =>
        f.call('/v1/messages', {
            token: s.token,
            sandboxId: s.sandboxId,
            body: {
                model: 'claude',
                max_tokens: 1000,
                messages: [{ role: 'user', content: 'Say hello.' }],
                stream: true,
                ...body,
            },
            headers,
        });
    return { ...f, apis, messages };
}

it('refuses a missing stamp, a missing or foreign credential, before any upstream call', async () => {
    const f = await setup();
    const s = await f.session({ model: 'claude' });
    const other = await f.session({ model: 'claude', personId: 'olga' });
    const body = { model: 'claude', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
    for (const attempt of [
        { token: s.token, sandboxId: s.sandboxId, stamp: null },
        { sandboxId: s.sandboxId },
        { token: other.token, sandboxId: s.sandboxId },
    ]) {
        const response = await f.call('/v1/messages', { ...attempt, body });
        expect(response.status).toBe(401);
    }
    // An x-api-key alone isn't the gateway's credential: Claude Code sends a bearer.
    const keyOnly = await f.call('/v1/messages', {
        sandboxId: s.sandboxId,
        body,
        headers: { 'x-api-key': s.token },
    });
    expect(keyOnly.status).toBe(401);
    expect(await keyOnly.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    expect(f.apis.seen).toHaveLength(0);
});

it('lets a session use only the model on its card, and refuses provider-side tools', async () => {
    const f = await setup();
    const s = await f.session({ model: 'claude' });
    for (const model of ['orion', 'claude-x-upstream']) {
        expect((await f.messages(s, { model })).status, model).toBe(404);
    }
    const tools = await f.messages(s, { tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
    expect(tools.status).toBe(400);
    expect(f.apis.seen).toHaveLength(0);
});

it('streams a Messages answer with only checked fields upstream, the backend’s own key, and meters it', async () => {
    const f = await setup();
    const s = await f.session({ model: 'claude' });
    const response = await f.messages(s, { metadata: { user_id: 'alice@example.test' } }, { 'x-trace': 'secret' });
    expect(response.status).toBe(200);
    const events = await sseEvents(response);
    expect(
        events
            .filter((event) => event.type === 'content_block_delta')
            .map((event) => (event.delta as { text: string }).text)
            .join(''),
    ).toBe('Hello from the fake.');
    const [seen] = f.apis.seen;
    expect(seen!.path).toBe('/v1/messages');
    expect(seen!.headers['x-api-key']).toBe(UPSTREAM_KEY);
    expect(seen!.headers.authorization).toBeUndefined();
    expect(seen!.headers['x-trace']).toBeUndefined();
    expect(seen!.body.model).toBe('claude-x-upstream');
    expect(seen!.body).not.toHaveProperty('metadata');
    expect(JSON.stringify(seen!.body)).not.toContain('alice');
    const ledger = modelGateway(f.platform).ledger;
    await expect
        .poll(() => ledger.session(s.grant.resources!.session as string, f.gateway.settings.limits()).used)
        .toBeGreaterThan(0);
});
