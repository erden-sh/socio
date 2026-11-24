import { afterEach, expect, it } from 'vitest';

import { modelGateway } from '../src/server/gateway/model.js';

import { gatewaySetup, UPSTREAM_KEY } from './support/gateway-fixture.js';
import { fakeModelApis, sseEvents } from './support/model-fakes.js';

// CB-326: the Gemini API's generateContent for coding sessions,
// which Gemini CLI reaches with GOOGLE_GEMINI_BASE_URL at the gateway and
// the session's token as its x-goog-api-key. The model and streaming are in
// the path. The same stamp, credential, model binding, body rules,
// reservation and metering as the other APIs, against a loopback fake of a
// Gemini backend. Negative cases first.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const STREAM = (model: string) => `/v1beta/models/${model}:streamGenerateContent?alt=sse`;
const WHOLE = (model: string) => `/v1beta/models/${model}:generateContent`;
const ASK = { contents: [{ role: 'user', parts: [{ text: 'Say hello.' }] }] };

async function setup() {
    const f = await gatewaySetup();
    cleanup.push(() => f.close());
    const apis = await fakeModelApis();
    cleanup.push(() => apis.close());
    const backend = await f.platform.inference.createBackend({
        label: 'Gemini backend',
        baseUrl: apis.url,
        model: 'gemini-x',
        apiKey: UPSTREAM_KEY,
    });
    await f.gateway.settings.saveModel(
        'gemini',
        {
            label: 'Gemini X',
            backendId: backend.id,
            upstreamModel: 'gemini-x-upstream',
            maxOutputTokens: 3000,
        },
        'olga',
    );
    const gemini = (
        s: { token: string; sandboxId: string },
        body: Record<string, unknown> = ASK,
        options: { path?: string; headers?: Record<string, string> } = {},
    ) =>
        f.call(options.path ?? STREAM('gemini'), {
            sandboxId: s.sandboxId,
            body,
            headers: { 'x-goog-api-key': s.token, ...options.headers },
        });
    return { ...f, apis, gemini };
}

it('refuses a missing stamp, a missing or foreign key, before any upstream call', async () => {
    const f = await setup();
    const s = await f.session({ model: 'gemini' });
    const other = await f.session({ model: 'gemini', personId: 'olga' });
    const attempts: { headers: Record<string, string>; stamp?: null; path?: string }[] = [
        { headers: { 'x-goog-api-key': s.token }, stamp: null },
        { headers: {} },
        { headers: { 'x-goog-api-key': other.token } },
        { headers: { 'x-goog-api-key': `${s.token}x` } },
        // The key belongs in Gemini's header, never as a query parameter.
        { headers: {}, path: `${STREAM('gemini')}&key=${s.token}` },
    ];
    for (const attempt of attempts) {
        const response = await f.call(attempt.path ?? STREAM('gemini'), {
            sandboxId: s.sandboxId,
            body: ASK,
            headers: attempt.headers,
            ...('stamp' in attempt ? { stamp: attempt.stamp } : {}),
        });
        expect(response.status, JSON.stringify(attempt)).toBe(401);
    }
    const refused = await f.gemini(s, ASK, { headers: { 'x-goog-api-key': other.token } });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { code: 401, status: 'UNAUTHENTICATED' } });
    expect(f.apis.seen).toHaveLength(0);
});

it('serves generateContent and streamGenerateContent only: other methods and paths are not found', async () => {
    const f = await setup();
    const s = await f.session({ model: 'gemini' });
    for (const path of [
        '/v1beta/models/gemini:countTokens',
        '/v1beta/models/gemini:embedContent',
        '/v1beta/models/gemini',
        '/v1beta/models/..%2Fx:generateContent',
        '/v1beta/tunedModels/gemini:generateContent',
    ]) {
        expect((await f.gemini(s, ASK, { path })).status, path).toBe(404);
    }
    expect(f.apis.seen).toHaveLength(0);
});

it('lets a session use only the model on its card, and refuses provider-side tools and stored files', async () => {
    const f = await setup();
    const s = await f.session({ model: 'gemini' });
    for (const model of ['orion', 'gemini-x-upstream', 'gemini-3-pro-preview']) {
        const response = await f.gemini(s, ASK, { path: STREAM(model) });
        expect(response.status, model).toBe(404);
        expect(await response.json()).toMatchObject({ error: { status: 'NOT_FOUND' } });
    }
    for (const body of [
        { ...ASK, tools: [{ googleSearch: {} }] },
        { ...ASK, tools: [{ codeExecution: {} }] },
        { ...ASK, tools: [{ urlContext: {} }] },
        { ...ASK, cachedContent: 'cachedContents/abc' },
        { contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'https://example.test/x.png' } }] }] },
    ]) {
        const response = await f.gemini(s, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 400, status: 'INVALID_ARGUMENT' } });
    }
    expect(f.apis.seen).toHaveLength(0);
});

it('streams a Gemini answer with only checked fields upstream, the backend’s model and key, and meters it', async () => {
    const f = await setup();
    const s = await f.session({ model: 'gemini' });
    const response = await f.gemini(
        s,
        {
            ...ASK,
            labels: { person: 'alice@example.test' },
            generationConfig: { temperature: 0.5, maxOutputTokens: 100_000 },
            tools: [
                {
                    functionDeclarations: [
                        { name: 'read_file', description: 'Reads', parametersJsonSchema: { type: 'object' } },
                    ],
                },
            ],
        },
        { headers: { 'x-trace': 'secret', authorization: 'Bearer not-a-gateway-token' } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const chunks = await sseEvents(response);
    expect(
        chunks
            .map(
                (chunk) =>
                    (chunk.candidates as { content: { parts: { text: string }[] } }[])[0]!.content.parts[0]!.text,
            )
            .join(''),
    ).toBe('Hello from the fake.');
    const [seen] = f.apis.seen;
    expect(seen!.path).toBe('/v1/models/gemini-x-upstream:streamGenerateContent?alt=sse');
    expect(seen!.headers['x-goog-api-key']).toBe(UPSTREAM_KEY);
    expect(seen!.headers.authorization).toBeUndefined();
    expect(seen!.headers['x-trace']).toBeUndefined();
    expect(seen!.body).not.toHaveProperty('model');
    expect(seen!.body).not.toHaveProperty('labels');
    expect(JSON.stringify(seen!.body)).not.toContain('alice');
    // The completion limit is clamped to the model's, inside generationConfig.
    expect(seen!.body.generationConfig).toEqual({ temperature: 0.5, maxOutputTokens: 3000 });
    expect(seen!.body.tools).toEqual([
        {
            functionDeclarations: [
                { name: 'read_file', description: 'Reads', parametersJsonSchema: { type: 'object' } },
            ],
        },
    ]);
    const ledger = modelGateway(f.platform).ledger;
    // The fake reports 30 prompt tokens and 4 + 3 (thinking) of output.
    await expect
        .poll(() => ledger.session(s.grant.resources!.session as string, f.gateway.settings.limits()).used)
        .toBe(37);
});

it('answers generateContent whole, metered by its usageMetadata', async () => {
    const f = await setup();
    const s = await f.session({ model: 'gemini' });
    const response = await f.gemini(s, ASK, { path: WHOLE('gemini') });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        candidates: [{ content: { parts: [{ text: 'Hello from the fake.' }] } }],
    });
    const [seen] = f.apis.seen;
    expect(seen!.path).toBe('/v1/models/gemini-x-upstream:generateContent');
    expect(seen!.body.generationConfig).toEqual({ maxOutputTokens: 3000 });
    const ledger = modelGateway(f.platform).ledger;
    await expect
        .poll(() => ledger.session(s.grant.resources!.session as string, f.gateway.settings.limits()).used)
        .toBe(37);
});

it('passes the backend’s failure as the gateway’s own, never the backend’s text', async () => {
    const f = await setup();
    const s = await f.session({ model: 'gemini' });
    f.apis.mode.status = 429;
    const busy = await f.gemini(s);
    expect(busy.status).toBe(429);
    const body = JSON.stringify(await busy.json());
    expect(body).toContain('RESOURCE_EXHAUSTED');
    expect(body).not.toMatch(/SECRET|sk-abc/);
});
