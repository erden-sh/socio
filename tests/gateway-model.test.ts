import { connect } from 'node:net';

import { afterEach, expect, it } from 'vitest';

import { signGatewayStamp } from '@socio/foundation/actors/keys';

import { gatewaySourcesOf } from '../src/server/gateway/adopted.js';
import { codingSessionOf, modelGateway } from '../src/server/gateway/model.js';
import { createGatewayServer } from '../src/server/gateway/server.js';

import { EGRESS_SECRET, UPSTREAM_KEY, gatewaySetup, until } from './support/gateway-fixture.js';

// CB-239: the model gateway on its internal listener, against a
// loopback fake of an OpenAI-compatible backend. Negative cases first.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function setup(options?: Parameters<typeof gatewaySetup>[0]) {
    const f = await gatewaySetup(options);
    cleanup.push(() => f.close());
    return f;
}

const errorOf = async (response: Response) =>
    ((await response.json()) as { error: { type: string; code: string } }).error;

it('refuses requests without a valid, fresh, unreplayed stamp, before any upstream call', async () => {
    const f = await setup();
    const s = await f.session();
    const path = '/v1/chat/completions';
    const body = { model: 'orion', messages: [{ role: 'user', content: 'hi' }] };
    const cases: (string | null)[] = [
        null,
        'garbage',
        // A bad MAC.
        `${s.sandboxId}.${Date.now()}.${'A'.repeat(43)}`,
        // Stale: 31 s old.
        signGatewayStamp(f.stampKey, s.sandboxId, 'POST', path, Date.now() - 31_000),
        // Another path or method.
        signGatewayStamp(f.stampKey, s.sandboxId, 'POST', '/v1/models'),
        signGatewayStamp(f.stampKey, s.sandboxId, 'GET', path),
        // Signed with another key.
        signGatewayStamp(Buffer.from('another-key-another-key-another-k'), s.sandboxId, 'POST', path),
    ];
    for (const stamp of cases) {
        const response = await f.call(path, {
            token: s.token,
            sandboxId: s.sandboxId,
            body,
            stamp,
        });
        expect(response.status, String(stamp)).toBe(401);
        expect((await errorOf(response)).code).toBe('invalid_stamp');
    }
    // A replayed stamp: the first use passes, the second is refused.
    const stamp = signGatewayStamp(f.stampKey, s.sandboxId, 'POST', path);
    expect(
        (
            await f.call(path, {
                token: s.token,
                sandboxId: s.sandboxId,
                body,
                stamp,
            })
        ).status,
    ).toBe(200);
    const replay = await f.call(path, {
        token: s.token,
        sandboxId: s.sandboxId,
        body,
        stamp,
    });
    expect(replay.status).toBe(401);
    expect(f.upstream.seen).toHaveLength(1);
});

it('verifies the stamp over the exact request-target, query string included (the sandbox’s contract)', async () => {
    const f = await setup();
    const s = await f.session();
    const target = '/v1/models?limit=5&service=x';
    // Signed over the path and query as sent: accepted.
    expect((await f.call(target, { token: s.token, sandboxId: s.sandboxId })).status).toBe(200);
    // Signed over the path alone, or another query: refused.
    for (const signed of ['/v1/models', '/v1/models?limit=6&service=x']) {
        const response = await f.call(target, {
            token: s.token,
            sandboxId: s.sandboxId,
            stamp: signGatewayStamp(f.stampKey, s.sandboxId, 'GET', signed),
        });
        expect(response.status, signed).toBe(401);
    }
});

it('closes connections from outside the gateway subnet, and all of them without one', async () => {
    const f = await setup();
    for (const subnet of ['10.0.0.0/8', undefined]) {
        const server = createGatewayServer(
            gatewaySourcesOf(f.platform),
            { port: 0, host: '127.0.0.1', egressSecret: EGRESS_SECRET, subnet },
            { log: () => {} },
        )!;
        await server.listen();
        cleanup.push(() => server.close());
        const closed = await new Promise<string>((resolve) => {
            const socket = connect(server.port!, '127.0.0.1', () =>
                socket.write('GET /v1/models HTTP/1.1\r\nHost: x\r\n\r\n'),
            );
            let data = '';
            socket.on('data', (chunk) => (data += chunk.toString()));
            socket.on('close', () => resolve(data));
            socket.on('error', () => resolve(data));
        });
        expect(closed).toBe('');
    }
    expect(f.upstream.seen).toHaveLength(0);
});

it('serves only its routes: other paths 404, other methods 405', async () => {
    const f = await setup();
    const s = await f.session();
    for (const path of [
        '/v1/completions',
        // Messages is served since CB-326; token counting isn't.
        '/v1/messages/count_tokens',
        '/dispatch/v1/messages',
        '/dispatch/v1/responses',
        '/v1/embeddings',
        '/api/workspace',
        '/v1/models/../admin',
    ]) {
        expect((await f.call(path, { token: s.token, sandboxId: s.sandboxId })).status).toBe(404);
    }
    expect(
        (
            await f.call('/v1/models', {
                method: 'PUT',
                token: s.token,
                sandboxId: s.sandboxId,
                body: {},
            })
        ).status,
    ).toBe(405);
});

it('refuses a missing, malformed, foreign or mis-bound credential with 401', async () => {
    const f = await setup();
    const s = await f.session();
    const other = await f.session({ personId: 'olga' });
    const tries: { token?: string; sandboxId: string }[] = [
        { sandboxId: s.sandboxId },
        { token: 'cbgw_short', sandboxId: s.sandboxId },
        { token: `cbsa_${'a'.repeat(43)}`, sandboxId: s.sandboxId },
        { token: `cbgw_${'a'.repeat(43)}`, sandboxId: s.sandboxId },
        // Olga's credential through Alice's sandbox's stamp.
        { token: other.token, sandboxId: s.sandboxId },
    ];
    for (const attempt of tries) {
        const response = await f.chat(attempt as never);
        expect(response.status).toBe(401);
        expect((await errorOf(response)).code).toBe('invalid_api_key');
    }
    // A Git-only credential is for the other audience.
    const git = await f.session({ credentialAudiences: ['gateway:git'] });
    expect((await f.chat(git)).status).toBe(401);
    // A credential without `model:invoke` for this audience.
    const readOnly = await f.session({ credentialScopes: ['git:read'] });
    expect((await f.chat(readOnly)).status).toBe(403);
    expect(f.upstream.seen).toHaveLength(0);
    const denies = f.platform.actors.audit.list({ personId: 'alice' }, 100).filter((row) => row.decision === 'deny');
    expect(denies.length).toBeGreaterThan(0);
});

it('refuses people off the code-access list, with the feature off, and after revocation', async () => {
    const f = await setup({ codeUsers: ['olga'] });
    const s = await f.session();
    const response = await f.chat(s);
    expect(response.status).toBe(403);
    expect(f.upstream.seen).toHaveLength(0);

    const off = await setup({ flags: { 'socio-actor-access': true } });
    const t = await off.session();
    expect((await off.chat(t)).status).toBe(403);

    const g = await setup();
    const u = await g.session();
    expect((await g.chat(u)).status).toBe(200);
    await g.platform.actors.revoke({ grantId: u.grant.id }, 'alice', 'person_revoked');
    expect([401, 403]).toContain((await g.chat(u)).status);
});

it('stops a prompt’s credential when its run ends; the next prompt’s works', async () => {
    const f = await setup();
    const s = await f.session();
    expect((await f.chat(s)).status).toBe(200);
    await f.platform.actors.credentials.revokeHolder('prompt-run', s.runId);
    expect((await f.chat(s)).status).toBe(401);
    const next = await f.platform.actors.credentials.issue({
        grant: s.grant,
        kind: 'cbgw',
        audiences: s.grant.audiences,
        contextId: s.sandboxId,
        holder: { kind: 'prompt-run', id: 'run-2' },
        correlationId: 'c',
    });
    expect((await f.chat({ token: next.token, sandboxId: s.sandboxId })).status).toBe(200);
});

it('lets a session use only the model on its card', async () => {
    const f = await setup();
    await f.gateway.settings.saveModel(
        'other',
        {
            label: 'Other',
            backendId: f.backend.id,
            upstreamModel: 'qwen38-other',
            maxOutputTokens: 1000,
        },
        'olga',
    );
    const s = await f.session();
    const models = (await (await f.call('/v1/models', { token: s.token, sandboxId: s.sandboxId })).json()) as {
        data: { id: string }[];
    };
    expect(models.data.map((model) => model.id)).toEqual(['orion']);
    for (const model of ['other', 'gpt-5', 'qwen38-coder', undefined]) {
        const response = await f.chat(s, { model });
        expect(response.status, String(model)).toBe(404);
        expect((await errorOf(response)).code).toBe('model_not_found');
    }
    // A disabled model is gone for its sessions too.
    await f.gateway.settings.saveModel(
        'orion',
        {
            label: 'Homelab (qwen38)',
            backendId: f.backend.id,
            upstreamModel: 'qwen38-coder',
            maxOutputTokens: 4000,
            enabled: false,
        },
        'olga',
    );
    expect((await f.chat(s)).status).toBe(404);
    expect(f.upstream.seen).toHaveLength(0);
    expect(
        f.platform.actors.audit.list({ grantId: s.grant.id }, 50).some((row) => row.reason === 'resource_denied'),
    ).toBe(true);
});

it('keeps code on the operator’s servers unless an admin allows an outside model for the repository', async () => {
    const f = await setup();
    await f.gateway.settings.saveModel(
        'grok',
        {
            label: 'Grok 5',
            backendId: f.backend.id,
            upstreamModel: 'grok-5',
            maxOutputTokens: 1000,
            outsideProvider: true,
        },
        'olga',
    );
    const s = await f.session({ model: 'grok' });
    expect((await f.gateway.settings.forRepository('erden-sh/socio')).map((model) => model.id)).toEqual(['orion']);
    const listed = (await (await f.call('/v1/models', { token: s.token, sandboxId: s.sandboxId })).json()) as {
        data: unknown[];
    };
    expect(listed.data).toEqual([]);
    expect((await f.chat(s, { model: 'grok' })).status).toBe(404);
    // Allowed for another repository only: still refused here.
    await f.gateway.settings.setRepositories('grok', ['erden-sh/other'], 'olga');
    expect((await f.chat(s, { model: 'grok' })).status).toBe(404);
    expect(f.upstream.seen).toHaveLength(0);
    await f.gateway.settings.setRepositories('grok', ['ERDEN-SH/Socio', 'erden-sh/other'], 'olga');
    expect((await f.chat(s, { model: 'grok' })).status).toBe(200);
    expect(f.upstream.seen[0]!.body.model).toBe('grok-5');
    expect((await f.gateway.settings.forRepository('erden-sh/socio')).map((model) => model.id)).toEqual([
        'grok',
        'orion',
    ]);
    // Each allowance change is audited with the admin and both values.
    const settings = f.platform.actors.audit.list({}, 100).filter((row) => row.phase === 'setting');
    expect(settings.filter((row) => row.action === 'coding.model.repositories')).toHaveLength(2);
    expect(settings.every((row) => row.actorBy === 'olga')).toBe(true);
});

it('sends nothing that identifies the person, and no client header, upstream', async () => {
    const f = await setup();
    const s = await f.session();
    const response = await f.chat(
        s,
        {
            user: 'alice@example.com',
            metadata: { person: 'alice' },
            store: true,
            service_tier: 'flex',
            messages: [
                { role: 'system', content: 'You code.', name: 'alice' },
                { role: 'user', content: 'Say hello.', name: 'Alice Example' },
            ],
        },
        {
            headers: {
                cookie: 'session=alice-cookie',
                'x-cb-user': 'alice',
                'x-forwarded-for': '203.0.113.9',
                'x-custom-trace': 'alice-trace',
                'user-agent': 'opencode/alice-laptop',
            },
        },
    );
    expect(response.status).toBe(200);
    const seen = f.upstream.seen[0]!;
    expect(seen.path).toBe('/v1/chat/completions');
    for (const key of ['user', 'metadata', 'store', 'service_tier']) {
        expect(seen.body).not.toHaveProperty(key);
    }
    expect(JSON.stringify(seen.body)).not.toMatch(/alice/i);
    expect(seen.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(seen.headers['user-agent']).toMatch(/^socio-gateway\//);
    const allowed = new Set([
        'host',
        'connection',
        'content-type',
        'content-length',
        'accept',
        'authorization',
        'user-agent',
        'accept-encoding',
        'accept-language',
        'sec-fetch-mode',
    ]);
    expect(Object.keys(seen.headers).filter((key) => !allowed.has(key))).toEqual([]);
    expect(JSON.stringify(seen.headers)).not.toMatch(/alice|cbgw_|203\.0\.113/i);
    // The dropped fields' names are kept for the session's diagnostics.
    await until(() => f.gateway.ledger.session('session-alice', f.gateway.settings.limits()).dropped.length > 0);
    expect(
        f.gateway.ledger
            .session('session-alice', f.gateway.settings.limits())
            .dropped.map((entry) => entry.field)
            .sort(),
    ).toEqual(['messages[].name', 'metadata', 'service_tier', 'store', 'user']);
});

it('forwards only plain function tools and known shapes', async () => {
    const f = await setup();
    const s = await f.session();
    const refused: Record<string, unknown>[] = [
        { tools: [{ type: 'web_search_preview' }] },
        { tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] },
        {
            tools: [
                { type: 'function', function: { name: 'read', parameters: {} } },
                { type: 'file_search', vector_store_ids: ['x'] },
            ],
        },
        { tools: [{ type: 'function', function: { name: 'bad name!' } }] },
        {
            tools: [{ type: 'function', function: { name: 'x', parameters: 'any' } }],
        },
        { tool_choice: { type: 'function', function: { name: 'not_listed' } } },
        { response_format: { type: 'web_page' } },
        {
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: 'https://example.com/x.png' },
                        },
                    ],
                },
            ],
        },
        {
            messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }],
        },
        { messages: [{ role: 'browser', content: 'x' }] },
        { messages: [] },
        { temperature: 9 },
        { max_tokens: 0 },
    ];
    for (const body of refused) {
        const response = await f.chat(s, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
    }
    // A data image on a model that takes none is refused too.
    const image = await f.chat(s, {
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: 'data:image/png;base64,AAAA' },
                    },
                ],
            },
        ],
    });
    expect(image.status).toBe(400);
    expect(f.upstream.seen).toHaveLength(0);

    const ok = await f.chat(s, {
        web_search_options: { search_context_size: 'high' },
        tools: [
            {
                type: 'function',
                function: {
                    name: 'read',
                    description: 'Read a file',
                    parameters: {
                        type: 'object',
                        properties: { path: { type: 'string' } },
                    },
                    cache_control: { type: 'ephemeral' },
                },
                provider_options: { web: true },
            },
        ],
        tool_choice: { type: 'function', function: { name: 'read' } },
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'x', schema: {}, extra: 1 },
        },
        messages: [
            {
                role: 'user',
                content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
            },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 't1',
                        type: 'function',
                        function: { name: 'read', arguments: '{}' },
                    },
                ],
                reasoning_content: 'hidden',
            },
            { role: 'tool', tool_call_id: 't1', content: 'file' },
        ],
    });
    expect(ok.status).toBe(200);
    const sent = f.upstream.seen[0]!.body;
    expect(Object.keys(sent).sort()).toEqual(
        ['max_completion_tokens', 'messages', 'model', 'response_format', 'stream', 'tool_choice', 'tools'].sort(),
    );
    expect(sent.tools).toEqual([
        {
            type: 'function',
            function: {
                name: 'read',
                description: 'Read a file',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                },
            },
        },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/cache_control|provider_options|reasoning_content|web_search|extra/);
});

it('refuses schemas with a remote $ref, too deep or too large, anywhere in a tool or response format', async () => {
    const f = await setup();
    const s = await f.session();
    const tool = (parameters: unknown) => ({
        tools: [{ type: 'function', function: { name: 'read', parameters } }],
    });
    const format = (schema: unknown) => ({
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'answer', schema },
        },
    });
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) {
        deep = { type: 'object', properties: { x: deep } };
    }
    const refused: Record<string, unknown>[] = [
        tool({ $ref: 'https://attacker.example/schema.json' }),
        tool({
            type: 'object',
            properties: {
                path: { allOf: [{ $ref: 'http://169.254.169.254/latest' }] },
            },
        }),
        tool({ type: 'object', $defs: { a: { $ref: 'file:///etc/passwd' } } }),
        tool({ type: 'object', properties: { a: { $ref: 42 } } }),
        tool({ $dynamicRef: 'https://attacker.example/meta' }),
        tool({ items: [{ $ref: '//attacker.example/x' }] }),
        format({ $ref: 'https://attacker.example/answer.json' }),
        format({
            type: 'object',
            properties: { a: { anyOf: [{ $ref: 'urn:x' }] } },
        }),
        tool(deep),
        format(deep),
        tool({
            type: 'object',
            properties: Object.fromEntries(
                Array.from({ length: 2_000 }, (_, i) => [`p${i}`, { type: 'string', description: 'x'.repeat(40) }]),
            ),
        }),
    ];
    for (const extra of refused) {
        const response = await f.chat(s, extra);
        expect(response.status, JSON.stringify(extra).slice(0, 120)).toBe(400);
        expect((await errorOf(response)).code).toBe('unsupported_schema');
    }
    expect(f.upstream.seen).toHaveLength(0);
    // References inside the schema pass, as written.
    const local = {
        type: 'object',
        $defs: { path: { type: 'string' } },
        properties: { path: { $ref: '#/$defs/path' } },
    };
    expect((await f.chat(s, { ...tool(local), ...format(local) })).status).toBe(200);
    const sent = f.upstream.seen[0]!.body as {
        tools: [{ function: { parameters: unknown } }];
        response_format: { json_schema: { schema: unknown } };
    };
    expect(sent.tools[0].function.parameters).toEqual(local);
    expect(sent.response_format.json_schema.schema).toEqual(local);
});

it('clamps the completion limit to the model, the request and the budget left', async () => {
    const f = await setup();
    const s = await f.session();
    await f.chat(s, { max_completion_tokens: 999_999 });
    expect(f.upstream.seen.at(-1)!.body.max_completion_tokens).toBe(4000);
    await f.chat(s, { max_tokens: 300 });
    expect(f.upstream.seen.at(-1)!.body.max_completion_tokens).toBe(300);
    expect(f.upstream.seen.at(-1)!.body).not.toHaveProperty('max_tokens');
    // A session budget with 1 000 tokens left (after what it used so far).
    const used = f.gateway.ledger.session('session-alice', f.gateway.settings.limits()).used;
    await f.gateway.settings.saveLimits({ sessionTokens: used + 1_000 }, 'olga');
    await f.chat(s);
    const prompt = f.upstream.seen.at(-1)!.body;
    expect(prompt.max_completion_tokens).toBeLessThan(1_000);
    expect(prompt.max_completion_tokens).toBeGreaterThan(900);
});

it('streams with usage forced on, records real usage, or an estimate when none is sent', async () => {
    const f = await setup();
    const s = await f.session();
    const response = await f.chat(s, { stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('Hello');
    expect(text).toContain('[DONE]');
    expect(f.upstream.seen[0]!.body.stream_options).toEqual({
        include_usage: true,
    });
    await until(() => f.gateway.openRequests === 0);
    const db = f.platform.workspace.db;
    const rows = () =>
        db.prepare('SELECT * FROM gateway_usage ORDER BY id').all() as {
            promptTokens: number;
            completionTokens: number;
            cachedTokens: number;
            estimated: number;
            status: string;
            personId: string;
            modelId: string;
        }[];
    expect(rows()).toMatchObject([
        {
            promptTokens: 120,
            completionTokens: 7,
            cachedTokens: 100,
            estimated: 0,
            status: 'ok',
            personId: 'alice',
            modelId: 'orion',
        },
    ]);
    f.upstream.reset({
        noUsage: true,
        text: 'one two three four five six seven eight',
    });
    await (await f.chat(s, { stream: true })).text();
    await (await f.chat(s)).json();
    await until(() => rows().length === 3);
    expect(
        rows()
            .slice(1)
            .map((row) => [row.estimated, row.status]),
    ).toEqual([
        [1, 'ok'],
        [1, 'ok'],
    ]);
    expect(rows()[1]!.completionTokens).toBeGreaterThan(5);
    expect(
        (
            db.prepare('SELECT COUNT(*) AS n FROM gateway_reservations').get() as {
                n: number;
            }
        ).n,
    ).toBe(0);
});

it('aborts the upstream request when the client disconnects, and frees its slot', async () => {
    const f = await setup();
    const s = await f.session();
    f.upstream.reset({ hang: true });
    const controller = new AbortController();
    const response = await f.chat(s, { stream: true }, { signal: controller.signal });
    expect(response.status).toBe(200);
    await until(() => f.gateway.openRequests === 1);
    controller.abort();
    await until(() => f.upstream.seen[0]!.closed);
    await until(() => f.gateway.openRequests === 0);
    const db = f.platform.workspace.db;
    await until(
        () =>
            (
                db.prepare('SELECT COUNT(*) AS n FROM gateway_reservations').get() as {
                    n: number;
                }
            ).n === 0,
    );
    expect(db.prepare('SELECT status, estimated FROM gateway_usage').all()).toEqual([
        { status: 'client_closed', estimated: 1 },
    ]);
});

it('ends a stream past its output cap with an OpenAI-shaped error', async () => {
    const f = await setup();
    const s = await f.session();
    f.upstream.reset({ endless: true });
    const response = await f.chat(s, { stream: true, max_completion_tokens: 50 });
    const text = await response.text();
    expect(text).toContain('output_limit_exceeded');
    await until(() => f.upstream.seen[0]!.closed);
    expect(text.length).toBeLessThan(2_000);
});

it('ends an open stream within moments of its grant’s revocation (CB-232)', async () => {
    const f = await setup();
    const s = await f.session();
    f.upstream.reset({ hang: true });
    const response = await f.chat(s, { stream: true });
    const reading = response.text();
    await until(() => f.gateway.openRequests === 1);
    await f.platform.actors.revoke({ grantId: s.grant.id }, 'alice', 'person_revoked');
    const text = await reading;
    expect(text).toContain('access_denied');
    await until(() => f.upstream.seen[0]!.closed);
    expect(f.gateway.openRequests).toBe(0);
});

it('ends an open stream within the 5-s re-check when its model is disabled or loses its outside allowance', async () => {
    const f = await setup();
    await f.gateway.settings.saveModel(
        'grok',
        {
            label: 'Grok 5',
            backendId: f.backend.id,
            upstreamModel: 'grok-5',
            maxOutputTokens: 1000,
            outsideProvider: true,
        },
        'olga',
    );
    await f.gateway.settings.setRepositories('grok', ['erden-sh/socio'], 'olga');
    const local = await f.session({ session: 'local' });
    const outside = await f.session({ session: 'outside', model: 'grok' });
    f.upstream.reset({ hang: true });
    const readLocal = (await f.chat(local, { stream: true })).text();
    const readOutside = (await f.chat(outside, { model: 'grok', stream: true })).text();
    await until(() => f.gateway.openRequests === 2);
    // The credentials and grants stay valid: only the request terms change.
    await f.gateway.settings.saveModel(
        'orion',
        {
            label: 'Homelab (qwen38)',
            backendId: f.backend.id,
            upstreamModel: 'qwen38-coder',
            maxOutputTokens: 4000,
            enabled: false,
        },
        'olga',
    );
    await f.gateway.settings.setRepositories('grok', [], 'olga');
    const [a, b] = await Promise.all([readLocal, readOutside]);
    expect(a).toContain('access_denied');
    expect(b).toContain('access_denied');
    await until(() => f.gateway.openRequests === 0, 9_000);
    await until(() => f.upstream.seen.every((seen) => seen.closed));
}, 20_000);

it('runs exactly one of 10 concurrent requests when the budget fits one', async () => {
    const f = await setup();
    const s = await f.session();
    await f.gateway.settings.saveLimits(
        // One request reserves its prompt (10 tokens estimated) and the
        // model's 4 000 output tokens; what is left fits no second prompt.
        { sessionTokens: 4_015, inFlightPerSession: 16, inFlightPerPerson: 64 },
        'olga',
    );
    // The admitted request stays open upstream until every other one has
    // been answered (or reached upstream too): its reservation must hold
    // them all, however slowly they arrive. A fixed delay let a slow
    // machine finish the first before the last arrived, freeing its budget.
    let release!: () => void;
    f.upstream.reset({ gate: new Promise<void>((resolve) => (release = resolve)) });
    let settled = 0;
    const requests = Array.from({ length: 10 }, () => f.chat(s).finally(() => settled++));
    await until(() => settled + f.upstream.seen.length >= 10, 10_000);
    release();
    const responses = await Promise.all(requests);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, ...Array(9).fill(429)]);
    const refusals = await Promise.all(responses.filter((r) => r.status === 429).map(errorOf));
    expect(new Set(refusals.map((e) => e.code))).toEqual(new Set(['session_budget_exhausted']));
    expect(f.upstream.seen).toHaveLength(1);
});

it('holds the per-session request rate and in-flight cap', async () => {
    const f = await setup();
    const s = await f.session();
    await f.gateway.settings.saveLimits({ requestsPerMinute: 3 }, 'olga');
    for (let n = 0; n < 3; n++) {
        expect((await f.chat(s)).status).toBe(200);
    }
    const limited = await f.chat(s);
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe('rate_limit_exceeded');

    const g = await setup();
    const t = await g.session();
    await g.gateway.settings.saveLimits({ inFlightPerSession: 1 }, 'olga');
    g.upstream.reset({ hang: true });
    const first = await g.chat(t, { stream: true });
    const second = await g.chat(t, { stream: true });
    expect(second.status).toBe(429);
    expect((await errorOf(second)).code).toBe('too_many_in_flight');
    await first.body?.cancel();
});

it('passes no upstream error text through', async () => {
    const f = await setup();
    const s = await f.session();
    f.upstream.reset({
        status: 500,
        errorBody: `{"error":{"message":"key ${UPSTREAM_KEY} for org alice-corp failed"}}`,
    });
    const response = await f.chat(s);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(UPSTREAM_KEY);
    expect(text).not.toContain('alice-corp');
    expect(JSON.parse(text)).toMatchObject({
        error: { type: 'api_error', code: 'upstream_error' },
    });
});

it('stores no prompt, completion or credential anywhere', async () => {
    const f = await setup();
    const s = await f.session();
    f.upstream.reset({ text: 'COMPLETION-MARKER-7f3a' });
    await (
        await f.chat(s, {
            stream: true,
            messages: [{ role: 'user', content: 'PROMPT-MARKER-91bc' }],
            tools: [
                {
                    type: 'function',
                    function: { name: 'TOOLNAME_MARKER', parameters: { type: 'object' } },
                },
            ],
            unknown_field_marker: 'VALUE-MARKER-22aa',
        })
    ).text();
    await (
        await f.chat(s, {
            messages: [{ role: 'user', content: 'PROMPT-MARKER-91bc' }],
        })
    ).json();
    await until(() => f.gateway.openRequests === 0);
    const db = f.platform.workspace.db;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
        }[]
    ).map((row) => row.name);
    for (const table of tables) {
        const dump = JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());
        for (const marker of [
            'PROMPT-MARKER',
            'COMPLETION-MARKER',
            'TOOLNAME_MARKER',
            'VALUE-MARKER',
            s.token,
            UPSTREAM_KEY,
        ]) {
            expect(dump.includes(marker), `${table} holds ${marker}`).toBe(false);
        }
    }
});

it('reads the coding session from the grant’s resources', () => {
    expect(
        codingSessionOf({
            id: 'g1',
            resources: { repository: 'ErDeN-Sh/Socio', model: 'orion' },
        }),
    ).toEqual({
        sessionId: 'g1',
        repository: 'erden-sh/socio',
        model: 'orion',
    });
    for (const resources of [
        null,
        { repository: 'erden-sh/socio' },
        { model: 'orion' },
        { repository: '../etc', model: 'orion' },
        { repository: 'a/b', model: 'Not A Name' },
        { repositories: ['a/b', 'c/d'], model: 'orion' },
    ]) {
        expect(codingSessionOf({ id: 'g', resources }), JSON.stringify(resources)).toBeUndefined();
    }
});

it('is one gateway per platform, registered as the gateway:model audience', async () => {
    const f = await setup();
    expect(modelGateway(f.platform)).toBe(f.gateway);
    expect(f.platform.actors.audiences.for('gateway:model')).toBeDefined();
});

it('logs each coding session gateway request and response in the exchange log (CB-326 step 6)', async () => {
    const f = await setup();
    const s = await f.session();
    const response = await f.chat(s);
    expect(response.status).toBe(200);
    // The exchange row is written after the response settles: one row for the
    // chat, with the session, the holder, the api, the route, sizes and hashes.
    // The session id is the grant's `session` resource (`session-alice`).
    const sessionId = 'session-alice';
    await until(
        () =>
            (
                f.platform.workspace.db
                    .prepare('SELECT COUNT(*) n FROM gateway_exchanges WHERE sessionId=?')
                    .get(sessionId) as {
                    n: number;
                }
            ).n === 1,
    );
    const row = f.platform.workspace.db.prepare('SELECT * FROM gateway_exchanges WHERE sessionId=?').get(sessionId) as {
        holderId: string;
        api: string;
        route: string;
        model: string;
        upstreamKind: string;
        status: string;
        requestBytes: number;
        responseBytes: number;
        requestHash: string;
        responseHash: string;
        bodyPath: null;
    };
    expect(row.holderId).toBe('alice');
    expect(row.api).toBe('chat');
    expect(row.route).toBe('/v1/chat/completions');
    expect(row.model).toBe('orion');
    expect(row.upstreamKind).toBe('gateway');
    expect(row.status).toBe('ok');
    expect(row.requestBytes).toBeGreaterThan(0);
    expect(row.responseBytes).toBeGreaterThan(0);
    expect(row.requestHash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(row.responseHash).toMatch(/^[A-Za-z0-9_-]+$/);
    // No body store wired here: the path is null (metadata + hashes only).
    expect(row.bodyPath).toBeNull();
});
