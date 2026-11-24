import { afterEach, expect, it } from 'vitest';

import { modelGateway } from '../src/server/gateway/model.js';

import { gatewaySetup, UPSTREAM_KEY } from './support/gateway-fixture.js';
import { fakeModelApis, sseEvents } from './support/model-fakes.js';

// CB-239: the Responses API route for coding sessions, with the same
// stamp, credential, model binding, rate, reservation, metering and audit
// as Chat Completions, against a loopback fake of an OpenAI Responses
// backend. Negative cases first.

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
        label: 'Responses backend',
        baseUrl: apis.url,
        model: 'gpt-x',
        apiKey: UPSTREAM_KEY,
    });
    await f.gateway.settings.saveModel(
        'oai',
        {
            label: 'GPT X',
            backendId: backend.id,
            upstreamModel: 'gpt-x-upstream',
            maxOutputTokens: 3000,
        },
        'olga',
    );
    const responses = (
        s: { token: string; sandboxId: string },
        body: Record<string, unknown> = {},
        headers: Record<string, string> = {},
    ) =>
        f.call('/v1/responses', {
            token: s.token,
            sandboxId: s.sandboxId,
            body: {
                model: 'oai',
                input: [{ role: 'user', content: 'Say hello.' }],
                stream: true,
                ...body,
            },
            headers,
        });
    return { ...f, apis, responses };
}

const errorOf = async (response: Response) =>
    ((await response.json()) as { error: { type: string; code: string } }).error;

it('refuses a missing stamp, a missing or foreign credential, before any upstream call', async () => {
    const f = await setup();
    const s = await f.session({ model: 'oai' });
    const other = await f.session({ model: 'oai', personId: 'olga' });
    const body = { model: 'oai', input: 'hi', stream: true };
    const tries = [
        { token: s.token, sandboxId: s.sandboxId, stamp: null },
        { sandboxId: s.sandboxId },
        { token: other.token, sandboxId: s.sandboxId },
    ];
    for (const attempt of tries) {
        const response = await f.call('/v1/responses', { ...attempt, body });
        expect(response.status).toBe(401);
    }
    // A Git-only credential is for the other audience.
    const git = await f.session({
        model: 'oai',
        credentialAudiences: ['gateway:git'],
    });
    expect((await f.responses(git)).status).toBe(401);
    expect(f.apis.seen).toHaveLength(0);
});

it('lets a session use only the model on its card', async () => {
    const f = await setup();
    const s = await f.session({ model: 'oai' });
    for (const model of ['orion', 'gpt-x-upstream', 'personal-chatgpt']) {
        const response = await f.responses(s, { model });
        expect(response.status, model).toBe(404);
        expect((await errorOf(response)).code).toBe('model_not_found');
    }
    expect(f.apis.seen).toHaveLength(0);
});

it('refuses provider-side tools and stored state, never forwarding them', async () => {
    const f = await setup();
    const s = await f.session({ model: 'oai' });
    const refused: Record<string, unknown>[] = [
        { tools: [{ type: 'web_search' }] },
        { tools: [{ type: 'mcp', server_url: 'https://x.example' }] },
        { previous_response_id: 'resp_0' },
        {
            input: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_image',
                            image_url: 'https://example.com/cat.png',
                        },
                    ],
                },
            ],
        },
    ];
    for (const body of refused) {
        const response = await f.responses(s, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(f.apis.seen).toHaveLength(0);
});

it('streams a Responses answer with only checked fields upstream, and meters it', async () => {
    const f = await setup();
    const s = await f.session({ model: 'oai' });
    const response = await f.responses(
        s,
        {
            instructions: 'Be brief.',
            user: 'alice@example.test',
            metadata: { person: 'alice' },
            safety_identifier: 'alice',
            store: true,
            max_output_tokens: 999_999,
            tools: [
                {
                    type: 'function',
                    name: 'read_file',
                    parameters: { type: 'object', properties: {} },
                },
            ],
        },
        { 'x-trace': 'secret-header', cookie: 'a=b' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = await sseEvents(response);
    expect(
        events
            .filter((event) => event.type === 'response.output_text.delta')
            .map((event) => event.delta)
            .join(''),
    ).toBe('Hello from the fake.');
    const [seen] = f.apis.seen;
    expect(seen!.path).toBe('/v1/responses');
    expect(seen!.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(seen!.headers['user-agent']).toMatch(/^socio-gateway\//);
    expect(seen!.headers['x-trace']).toBeUndefined();
    expect(seen!.headers.cookie).toBeUndefined();
    expect(seen!.body.model).toBe('gpt-x-upstream');
    expect(seen!.body.store).toBe(false);
    expect(seen!.body.max_output_tokens).toBeLessThanOrEqual(3000);
    for (const field of ['user', 'metadata', 'safety_identifier']) {
        expect(seen!.body).not.toHaveProperty(field);
    }
    expect(JSON.stringify(seen!.body)).not.toContain('alice');
    // Usage from response.completed: 50 in, 5 out.
    const ledger = modelGateway(f.platform).ledger;
    await expect
        .poll(() => ledger.session(s.grant.resources!.session as string, f.gateway.settings.limits()).used)
        .toBe(55);
    const dropped = ledger
        .session(s.grant.resources!.session as string, f.gateway.settings.limits())
        .dropped.map((entry) => entry.field);
    expect(dropped).toEqual(expect.arrayContaining(['user', 'metadata', 'safety_identifier']));
});

it('answers a non-streamed request and meters its usage', async () => {
    const f = await setup();
    const s = await f.session({ model: 'oai' });
    const response = await f.responses(s, { stream: false });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { output: unknown[] };
    expect(body.output).toHaveLength(1);
    expect(
        modelGateway(f.platform).ledger.session(s.grant.resources!.session as string, f.gateway.settings.limits()).used,
    ).toBe(55);
});

it('never passes the backend’s error text, which may name its account', async () => {
    const f = await setup();
    const s = await f.session({ model: 'oai' });
    f.apis.mode.status = 500;
    const response = await f.responses(s);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('upstream_error');
    expect(text).not.toContain('SECRET-ACCOUNT');
    expect(text).not.toContain('sk-abc');
});

it('holds the session’s budget across both APIs', async () => {
    const f = await setup();
    await f.gateway.settings.saveLimits({ sessionTokens: 1_000 }, 'olga');
    const s = await f.session({ model: 'oai' });
    // A prompt of about 1 250 tokens can't fit a 1 000-token budget.
    const response = await f.responses(s, { input: 'x'.repeat(5_000) });
    expect(response.status).toBe(429);
    expect((await errorOf(response)).code).toBe('session_budget_exhausted');
    expect(f.apis.seen).toHaveLength(0);
});
