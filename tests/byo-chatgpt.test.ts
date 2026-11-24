import { chat, maxIterations, toolDefinition } from '@tanstack/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ChatGptError, chatGptFailure } from '@socio/foundation/inference/chatgpt-errors';
import { modelDebug } from '@socio/foundation/observability/failures';

import { CODEX_CLIENT_ID } from '../src/server/inference/chatgpt/endpoints.js';
import {
    CHATGPT_DEFAULT_MODEL,
    chatGptAdapter,
    createChatGptByoKind,
    ensureFresh,
    listModels,
    readBlob,
    redactSecrets,
    startLogin,
    type ByoConnectionContext,
    type ChatGptCredentials,
} from '../src/server/inference/chatgpt/index.js';
import { resetRefreshState } from '../src/server/inference/chatgpt/refresh.js';

import {
    FAKE_ACCOUNT,
    FAKE_EMAIL,
    FAKE_NAME,
    startFakeChatGpt,
    textReply,
    toolCallReply,
} from './fixtures/fake-chatgpt.js';
import { takeEgressAttempts } from './setup/egress-guard.js';

type Fake = Awaited<ReturnType<typeof startFakeChatGpt>>;
let fake: Fake;
let logged: string[];

beforeEach(async () => {
    resetRefreshState();
    fake = await startFakeChatGpt();
    logged = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
            logged.push(args.map((arg) => String(arg)).join(' '));
        });
    }
});
afterEach(async () => {
    vi.restoreAllMocks();
    await fake.close();
    // Nothing in these tests may leave loopback.
    expect(takeEgressAttempts()).toEqual([]);
});

/** Credentials as the fake issues them, optionally expiring soon. */
function issued(expiresInMs = 3600_000): ChatGptCredentials {
    const tokens = fake.issue();
    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accountId: FAKE_ACCOUNT,
        planType: 'plus',
        expiresAt: Date.now() + expiresInMs,
    };
}

function memoryConnection(userId = 'user-1') {
    let blob: unknown;
    const saves: unknown[] = [];
    const context: ByoConnectionContext = {
        userId,
        load: async () => blob,
        save: async (next) => {
            saves.push(next);
            blob = structuredClone(next);
        },
        remove: async () => {
            blob = undefined;
        },
    };
    return { context, saves, blob: () => blob };
}

async function collect(stream: AsyncIterable<unknown>) {
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of stream) {
        chunks.push(chunk as Record<string, unknown>);
    }
    return chunks;
}

/** Everything a test observed leaving the module: events, logs, saves. */
const noSecrets = (text: string, credentials: ChatGptCredentials[]) => {
    for (const secret of credentials.flatMap((c) => [c.accessToken, c.refreshToken])) {
        expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(FAKE_EMAIL);
    expect(text).not.toContain(FAKE_NAME);
};

describe('device-code login', () => {
    it('stays pending until the user approves, then returns credentials', async () => {
        let clock = Date.now();
        const login = await startLogin({
            endpoints: fake.endpoints,
            now: () => clock,
        });
        expect(login.userCode).toBe('ABCD-1234');
        expect(login.verificationUrl).toBe(`${fake.endpoints.issuer}/codex/device`);
        expect(login.expiresAt).toBe(clock + 15 * 60_000);
        expect(JSON.parse(fake.requests[0].body)).toEqual({
            client_id: CODEX_CLIENT_ID,
        });

        expect(await login.poll()).toBe('pending');
        // Within the server's interval: no second request.
        expect(await login.poll()).toBe('pending');
        expect(fake.requests.filter((r) => r.path.endsWith('/deviceauth/token'))).toHaveLength(1);

        fake.state.device = 'approved';
        clock += 1000;
        const [first, second] = await Promise.all([login.poll(), login.poll()]);
        expect(second).toBe(first);
        if (first === 'pending' || 'error' in first) {
            throw new Error('not signed in');
        }
        const { credentials } = first;
        expect(credentials).toMatchObject({
            accountId: FAKE_ACCOUNT,
            planType: 'plus',
        });
        expect(credentials.idToken).toBeUndefined();
        expect(fake.state.accessTokens.has(credentials.accessToken)).toBe(true);
        expect(fake.state.refreshTokens.has(credentials.refreshToken)).toBe(true);
        noSecrets(JSON.stringify({ ...credentials, accessToken: '', refreshToken: '' }), []);

        const exchange = fake.requests.find((r) => r.path === '/oauth/token');
        expect(exchange?.headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(Object.fromEntries(new URLSearchParams(exchange?.body))).toEqual({
            grant_type: 'authorization_code',
            client_id: CODEX_CLIENT_ID,
            code: 'authz-code-fixture',
            redirect_uri: `${fake.endpoints.issuer}/deviceauth/callback`,
            code_verifier: 'verifier-fixture',
        });
        // One exchange only; later polls repeat the final answer.
        expect(await login.poll()).toBe(first);
        expect(fake.requests.filter((r) => r.path === '/oauth/token')).toHaveLength(1);
        noSecrets(logged.join('\n'), [credentials]);
    });

    it('expires after 15 minutes without asking the server again', async () => {
        let clock = Date.now();
        const login = await startLogin({
            endpoints: fake.endpoints,
            now: () => clock,
        });
        expect(await login.poll()).toBe('pending');
        clock += 15 * 60_000;
        const before = fake.requests.length;
        expect(await login.poll()).toMatchObject({ error: 'expired' });
        expect(fake.requests.length).toBe(before);
    });

    it('reports a denied sign-in', async () => {
        fake.state.device = 'denied';
        const login = await startLogin({ endpoints: fake.endpoints });
        expect(await login.poll()).toMatchObject({
            error: 'denied',
            message: expect.stringContaining('did not approve'),
        });
    });
});

describe('refresh', () => {
    it('rotates the refresh token and saves before returning', async () => {
        const old = issued(60_000);
        const order: string[] = [];
        const fresh = await ensureFresh(
            old,
            async (next) => {
                order.push(`save ${next.refreshToken}`);
            },
            { endpoints: fake.endpoints },
        );
        order.push('returned');
        expect(fresh.refreshToken).not.toBe(old.refreshToken);
        expect(fresh.accessToken).not.toBe(old.accessToken);
        expect(order).toEqual([`save ${fresh.refreshToken}`, 'returned']);
        expect(fake.state.refreshTokens.has(old.refreshToken)).toBe(false);
        const request = fake.requests.find((r) => r.path === '/oauth/token');
        expect(JSON.parse(request?.body ?? '{}')).toEqual({
            client_id: CODEX_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: old.refreshToken,
        });
        expect(request?.headers.originator).toBe('codex_cli_rs');
    });

    it('leaves a token that is not near expiry alone', async () => {
        const credentials = issued();
        const save = vi.fn();
        expect(await ensureFresh(credentials, save, { endpoints: fake.endpoints })).toBe(credentials);
        expect(save).not.toHaveBeenCalled();
        expect(fake.state.refreshCount).toBe(0);
    });

    it('refreshes once for concurrent callers, and late callers get the rotation', async () => {
        const old = issued(1000);
        fake.state.refreshDelayMs = 50;
        const save = vi.fn(async () => {});
        const results = await Promise.all(
            Array.from({ length: 5 }, () => ensureFresh({ ...old }, save, { endpoints: fake.endpoints })),
        );
        expect(fake.state.refreshCount).toBe(1);
        expect(save).toHaveBeenCalledTimes(1);
        expect(new Set(results.map((r) => r.refreshToken)).size).toBe(1);
        // A caller still holding the spent token gets the rotated credentials.
        const late = await ensureFresh({ ...old }, save, {
            endpoints: fake.endpoints,
        });
        expect(late.refreshToken).toBe(results[0].refreshToken);
        expect(fake.state.refreshCount).toBe(1);
    });

    it('marks the connection for re-login on invalid_grant', async () => {
        fake.state.refreshError = 'invalid_grant';
        const markNeedsRelogin = vi.fn(async () => {});
        const error = await ensureFresh(issued(1000), vi.fn(), {
            endpoints: fake.endpoints,
            markNeedsRelogin,
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ChatGptError);
        expect(error).toMatchObject({ code: 'chatgpt_needs_relogin', status: 400 });
        expect(markNeedsRelogin).toHaveBeenCalledTimes(1);
    });

    it('refuses a refresh for a different account', async () => {
        fake.state.refreshAccount = 'acct-someone-else';
        const markNeedsRelogin = vi.fn(async () => {});
        await expect(
            ensureFresh(issued(1000), vi.fn(), {
                endpoints: fake.endpoints,
                markNeedsRelogin,
            }),
        ).rejects.toMatchObject({ code: 'chatgpt_needs_relogin' });
        expect(markNeedsRelogin).toHaveBeenCalled();
    });

    it('keeps a still-valid token when the auth server is down', async () => {
        const credentials = issued(60_000);
        await fake.close();
        expect(await ensureFresh(credentials, vi.fn(), { endpoints: fake.endpoints })).toBe(credentials);
        fake = await startFakeChatGpt();
    });
});

describe('chat adapter', () => {
    function adapterWith(credentials: ChatGptCredentials, model?: string) {
        let current = credentials;
        const saved: ChatGptCredentials[] = [];
        const markNeedsRelogin = vi.fn(async () => {});
        const adapter = chatGptAdapter({
            endpoints: fake.endpoints,
            getCredentials: async () => current,
            saveCredentials: async (next) => {
                saved.push(next);
                current = next;
            },
            markNeedsRelogin,
            ...(model ? { model } : {}),
        });
        return { adapter, saved, markNeedsRelogin, current: () => current };
    }

    const responsesRequests = () => fake.requests.filter((r) => r.path === '/backend-api/codex/responses');

    it('streams text with the CLI request shape and headers', async () => {
        const credentials = issued();
        const { adapter } = adapterWith(credentials);
        fake.state.replies.push(textReply('Hello from your plan.'));
        const chunks = await collect(
            chat({
                adapter,
                stream: true,
                messages: [{ role: 'user', content: 'Hi there' }],
                systemPrompts: ['You are a Dot.', 'Be brief.'],
                modelOptions: { max_completion_tokens: 2200, temperature: 0.2 },
                debug: modelDebug,
            }),
        );
        const deltas = chunks.filter((chunk) => chunk.type === 'TEXT_MESSAGE_CONTENT').map((chunk) => chunk.delta);
        expect(deltas.join('')).toBe('Hello from your plan.');
        expect(deltas.length).toBeGreaterThan(1);
        const finished = chunks.find((chunk) => chunk.type === 'RUN_FINISHED');
        expect(finished?.usage).toMatchObject({
            promptTokens: 42,
            completionTokens: 7,
            totalTokens: 49,
        });

        const [request] = responsesRequests();
        expect(request.headers.authorization).toBe(`Bearer ${credentials.accessToken}`);
        expect(request.headers['chatgpt-account-id']).toBe(FAKE_ACCOUNT);
        expect(request.headers.originator).toBe('codex_cli_rs');
        expect(request.headers.accept).toBe('text/event-stream');
        expect(request.headers['user-agent']).toBe('codex_cli_rs/0.161.0 (socio)');
        const body = JSON.parse(request.body);
        expect(body).toEqual({
            model: CHATGPT_DEFAULT_MODEL,
            instructions: 'You are a Dot.\nBe brief.',
            input: [
                {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Hi there' }],
                },
            ],
            tool_choice: 'auto',
            parallel_tool_calls: true,
            reasoning: { effort: 'low', summary: 'auto' },
            store: false,
            stream: true,
            include: ['reasoning.encrypted_content'],
            text: { verbosity: 'low' },
        });
        noSecrets(JSON.stringify(chunks) + logged.join('\n'), [credentials]);
    });

    it('streams the reasoning summary as reasoning, before the answer', async () => {
        const { adapter } = adapterWith(issued());
        fake.state.replies.push(textReply('Sunny.', 'resp_1', { summary: 'Checking the forecast.' }));
        const chunks = await collect(
            chat({
                adapter,
                stream: true,
                messages: [{ role: 'user', content: 'Weather?' }],
                debug: modelDebug,
            }),
        );
        const types = chunks.map((chunk) => chunk.type);
        const reasoning = chunks
            .filter((chunk) => chunk.type === 'REASONING_MESSAGE_CONTENT')
            .map((chunk) => chunk.delta)
            .join('');
        expect(reasoning).toBe('Checking the forecast.');
        expect(types.indexOf('REASONING_MESSAGE_CONTENT')).toBeLessThan(types.indexOf('TEXT_MESSAGE_CONTENT'));
        expect(
            chunks
                .filter((chunk) => chunk.type === 'TEXT_MESSAGE_CONTENT')
                .map((chunk) => chunk.delta)
                .join(''),
        ).toBe('Sunny.');
    });

    it('starts each part of a reasoning summary on its own paragraph', async () => {
        const { adapter } = adapterWith(issued());
        fake.state.replies.push(
            textReply('Done.', 'resp_1', {
                summary: ['**Designing paged data fetches**\n\nPages of 100.', '**Checking API upsert support**'],
            }),
        );
        const chunks = await collect(
            chat({
                adapter,
                stream: true,
                messages: [{ role: 'user', content: 'Plan it.' }],
                debug: modelDebug,
            }),
        );
        expect(
            chunks
                .filter((chunk) => chunk.type === 'REASONING_MESSAGE_CONTENT')
                .map((chunk) => chunk.delta)
                .join(''),
        ).toBe('**Designing paged data fetches**\n\nPages of 100.\n\n**Checking API upsert support**');
    });

    it('drops reasoning summaries for a model whose backend refuses them', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        // Its own model: a refusal is remembered per model, for the process.
        const { adapter } = adapterWith(issued(), 'gpt-6-luna');
        const ask = () =>
            collect(
                chat({
                    adapter,
                    stream: true,
                    messages: [{ role: 'user', content: 'Hi' }],
                    debug: modelDebug,
                }),
            );
        fake.state.replies.push(
            {
                status: 400,
                body: {
                    error: {
                        message: "Unsupported parameter: 'reasoning.summary'.",
                        type: 'invalid_request_error',
                    },
                },
            },
            textReply('Without a summary.'),
            textReply('Still without.'),
        );
        const first = await ask();
        expect(
            first
                .filter((chunk) => chunk.type === 'TEXT_MESSAGE_CONTENT')
                .map((chunk) => chunk.delta)
                .join(''),
        ).toBe('Without a summary.');
        await ask();
        expect(responsesRequests().map((request) => JSON.parse(request.body).reasoning.summary ?? null)).toEqual([
            'auto',
            null,
            null,
        ]);
    });

    it('passes images through as input_image parts', async () => {
        const { adapter } = adapterWith(issued());
        fake.state.replies.push(textReply('A red square.'));
        await collect(
            chat({
                adapter,
                stream: true,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', content: 'What is this?' },
                            {
                                type: 'image',
                                source: {
                                    type: 'data',
                                    value: 'iVBORw0KGgo=',
                                    mimeType: 'image/png',
                                },
                            },
                        ],
                    },
                ],
                debug: modelDebug,
            }),
        );
        const body = JSON.parse(responsesRequests()[0].body);
        expect(body.input[0].content[1]).toEqual({
            type: 'input_image',
            image_url: 'data:image/png;base64,iVBORw0KGgo=',
            detail: 'auto',
        });
    });

    it('runs a tool call round trip', async () => {
        const credentials = issued();
        const { adapter } = adapterWith(credentials);
        const execute = vi.fn(async ({ city }: { city: string }) => ({
            city,
            forecast: 'sunny',
        }));
        const weather = toolDefinition({
            name: 'get_weather',
            description: 'Weather for a city',
            inputSchema: z.object({ city: z.string() }),
        }).server(execute);
        fake.state.replies.push(toolCallReply('get_weather', { city: 'Lisbon' }), textReply('It is sunny in Lisbon.'));
        const chunks = await collect(
            chat({
                adapter,
                stream: true,
                messages: [{ role: 'user', content: 'Weather in Lisbon?' }],
                systemPrompts: ['You are a Dot.'],
                tools: [weather],
                agentLoopStrategy: maxIterations(3),
                debug: modelDebug,
            }),
        );
        expect(execute).toHaveBeenCalledWith({ city: 'Lisbon' }, expect.anything());
        expect(
            chunks
                .filter((chunk) => chunk.type === 'TEXT_MESSAGE_CONTENT')
                .map((chunk) => chunk.delta)
                .join(''),
        ).toBe('It is sunny in Lisbon.');

        const [first, second] = responsesRequests().map((r) => JSON.parse(r.body));
        expect(first.tools).toEqual([
            expect.objectContaining({
                type: 'function',
                name: 'get_weather',
                description: 'Weather for a city',
            }),
        ]);
        expect(second.input).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'get_weather',
                    arguments: JSON.stringify({ city: 'Lisbon' }),
                }),
                {
                    type: 'function_call_output',
                    call_id: 'call_1',
                    output: JSON.stringify({ city: 'Lisbon', forecast: 'sunny' }),
                },
            ]),
        );
        noSecrets(JSON.stringify(chunks) + logged.join('\n'), [credentials]);
    });

    it('maps a usage limit to a friendly, typed error', async () => {
        const credentials = issued();
        const { adapter } = adapterWith(credentials);
        const resetsAt = Math.floor(Date.UTC(2026, 9, 9, 14, 30) / 1000);
        fake.state.replies.push({
            status: 429,
            body: {
                error: {
                    type: 'usage_limit_reached',
                    message: `The usage limit has been reached for ${FAKE_EMAIL}`,
                    plan_type: 'plus',
                    resets_at: resetsAt,
                },
            },
        });
        const chunks = await collect(
            chat({
                adapter,
                stream: true,
                messages: [{ role: 'user', content: 'Hi' }],
                debug: modelDebug,
            }),
        );
        const error = chunks.find((chunk) => chunk.type === 'RUN_ERROR');
        expect(error).toMatchObject({
            code: 'chatgpt_usage_limit',
            message:
                'You have reached your ChatGPT Plus plan’s usage limit for now. It resets at 2026-10-09 14:30 UTC.',
        });
        expect(chatGptFailure(error)).toEqual({
            code: 'chatgpt_usage_limit',
            message: error?.message,
        });
        noSecrets(JSON.stringify(chunks) + logged.join('\n'), [credentials]);
    });

    it('maps plan and stream failures to typed errors', async () => {
        const { adapter } = adapterWith(issued());
        fake.state.replies.push(
            { status: 429, body: { error: { type: 'usage_not_included' } } },
            {
                events: [
                    { type: 'response.created', response: { id: 'r', model: 'm' } },
                    {
                        type: 'response.failed',
                        response: {
                            id: 'r',
                            error: {
                                code: 'rate_limit_exceeded',
                                message: 'Quoting your conversation: secret plans',
                            },
                        },
                    },
                ],
            },
            { status: 400, body: { detail: 'Unsupported model: gpt-unknown' } },
        );
        const run = async () => {
            const chunks = await collect(
                chat({
                    adapter,
                    stream: true,
                    messages: [{ role: 'user', content: 'Hi' }],
                    debug: modelDebug,
                }),
            );
            return chunks.find((chunk) => chunk.type === 'RUN_ERROR');
        };
        expect(await run()).toMatchObject({ code: 'chatgpt_not_entitled' });
        const failed = await run();
        expect(failed).toMatchObject({ code: 'chatgpt_rate_limited' });
        expect(JSON.stringify(failed)).not.toContain('secret plans');
        expect(await run()).toMatchObject({ code: 'chatgpt_model_unavailable' });
    });

    it('refreshes and retries once on a 401', async () => {
        const credentials = issued();
        fake.state.accessTokens.delete(credentials.accessToken);
        const { adapter, saved } = adapterWith(credentials);
        fake.state.replies.push(textReply('Back again.'));
        const chunks = await collect(
            chat({
                adapter,
                stream: true,
                messages: [{ role: 'user', content: 'Hi' }],
                debug: modelDebug,
            }),
        );
        expect(chunks.some((chunk) => chunk.type === 'RUN_FINISHED')).toBe(true);
        expect(saved).toHaveLength(1);
        expect(responsesRequests()).toHaveLength(2);
        expect(responsesRequests()[1].headers.authorization).toBe(`Bearer ${saved[0].accessToken}`);
    });

    it('does not ask for a new sign-in when refresh after a 401 fails transiently', async () => {
        const credentials = issued();
        fake.state.accessTokens.delete(credentials.accessToken);
        fake.state.refreshError = 'temporarily_unavailable';
        const { adapter, markNeedsRelogin } = adapterWith(credentials);
        const chunks = await collect(
            chat({
                adapter,
                stream: true,
                messages: [{ role: 'user', content: 'Hi' }],
                debug: modelDebug,
            }),
        );
        expect(chunks.find((chunk) => chunk.type === 'RUN_ERROR')).toMatchObject({
            code: 'chatgpt_unavailable',
        });
        expect(markNeedsRelogin).not.toHaveBeenCalled();
        expect(responsesRequests()).toHaveLength(1);
    });

    it('asks for a new sign-in when the refresh token is dead', async () => {
        const credentials = issued(1000);
        fake.state.refreshError = 'refresh_token_expired';
        const { adapter, markNeedsRelogin } = adapterWith(credentials);
        const chunks = await collect(
            chat({
                adapter,
                stream: true,
                messages: [{ role: 'user', content: 'Hi' }],
                debug: modelDebug,
            }),
        );
        expect(chunks.find((chunk) => chunk.type === 'RUN_ERROR')).toMatchObject({
            code: 'chatgpt_needs_relogin',
        });
        expect(markNeedsRelogin).toHaveBeenCalled();
        expect(responsesRequests()).toHaveLength(0);
        noSecrets(JSON.stringify(chunks) + logged.join('\n'), [credentials]);
    });

    it('refuses structured output', async () => {
        const { adapter } = adapterWith(issued());
        await expect(adapter.structuredOutput()).rejects.toMatchObject({
            code: 'chatgpt_unsupported',
        });
    });
});

describe('BYO kind', () => {
    it('connects, shows only the plan, and disconnects with a revoke', async () => {
        let clock = Date.now();
        const kind = createChatGptByoKind({
            endpoints: fake.endpoints,
            now: () => clock,
        });
        expect(kind.id).toBe('byo-chatgpt');
        expect(kind.label).toBe('ChatGPT (your plan)');
        const connection = memoryConnection();
        expect(await kind.pollConnect(connection.context)).toEqual({
            state: 'none',
        });
        const started = await kind.startConnect(connection.context);
        expect(started).toEqual({
            userCode: 'ABCD-1234',
            verificationUrl: `${fake.endpoints.issuer}/codex/device`,
            expiresAt: expect.any(Number),
        });
        expect(await kind.pollConnect(connection.context)).toEqual({
            state: 'pending',
        });
        expect(await kind.status(connection.context)).toMatchObject({
            state: 'connecting',
        });
        fake.state.device = 'approved';
        clock += 1000;
        const done = await kind.pollConnect(connection.context);
        expect(done).toEqual({
            state: 'connected',
            status: {
                state: 'connected',
                label: 'Connected · plan: Plus',
                plan: 'Plus',
            },
        });
        const status = await kind.status(connection.context);
        expect(status).toEqual({
            state: 'connected',
            label: 'Connected · plan: Plus',
            plan: 'Plus',
        });
        // What the client sees carries no ids, names, emails or tokens.
        const shown = JSON.stringify([started, done, status]);
        expect(shown).not.toContain(FAKE_ACCOUNT);
        noSecrets(shown, []);
        // The stored blob holds no ID token, so no email or name either.
        const stored = readBlob(connection.blob());
        expect(stored?.credentials?.accountId).toBe(FAKE_ACCOUNT);
        expect(JSON.stringify(connection.blob())).not.toContain(FAKE_EMAIL);
        expect(JSON.stringify(connection.blob())).not.toContain(FAKE_NAME);

        // A turn on the connection, then disconnect.
        fake.state.replies.push(textReply('Hi!'));
        const chunks = await collect(
            chat({
                adapter: kind.adapterFor(connection.context),
                stream: true,
                messages: [{ role: 'user', content: 'Hello' }],
                debug: modelDebug,
            }),
        );
        expect(chunks.some((chunk) => chunk.type === 'RUN_FINISHED')).toBe(true);
        const refreshToken = stored?.credentials?.refreshToken;
        await kind.disconnect(connection.context);
        expect(fake.state.revoked).toEqual([refreshToken]);
        expect(connection.blob()).toBeUndefined();
        expect(await kind.status(connection.context)).toEqual({
            state: 'not_connected',
            label: 'Not connected',
        });
        noSecrets(logged.join('\n'), stored?.credentials ? [stored.credentials] : []);
    });

    it('shows needs_reconnect after a dead refresh token', async () => {
        const kind = createChatGptByoKind({ endpoints: fake.endpoints });
        const connection = memoryConnection();
        await connection.context.save({ version: 1, credentials: issued(1000) });
        fake.state.refreshError = 'invalid_grant';
        const chunks = await collect(
            chat({
                adapter: kind.adapterFor(connection.context),
                stream: true,
                messages: [{ role: 'user', content: 'Hello' }],
                debug: modelDebug,
            }),
        );
        expect(chunks.find((chunk) => chunk.type === 'RUN_ERROR')).toMatchObject({
            code: 'chatgpt_needs_relogin',
        });
        expect(connection.blob()).toEqual({ version: 1, needsRelogin: true });
        expect(await kind.status(connection.context)).toMatchObject({
            state: 'needs_reconnect',
        });
        // Nothing usable is left: the next turn asks to connect.
        const next = await collect(
            chat({
                adapter: kind.adapterFor(connection.context),
                stream: true,
                messages: [{ role: 'user', content: 'Hello' }],
                debug: modelDebug,
            }),
        );
        expect(next.find((chunk) => chunk.type === 'RUN_ERROR')).toMatchObject({
            code: 'chatgpt_not_connected',
        });
    });

    it('lists models from the static catalog without any request', () => {
        const kind = createChatGptByoKind({ endpoints: fake.endpoints });
        expect(kind.listModels()).toBe(listModels());
        expect(listModels()[0].id).toBe(CHATGPT_DEFAULT_MODEL);
        expect(listModels().map((model) => model.id)).toContain('gpt-5.5');
        expect(kind.capabilities()).toEqual({
            model: CHATGPT_DEFAULT_MODEL,
            acceptsImages: true,
            tools: true,
            // The catalog's 272,000 tokens at its effective 95% (CB-129).
            contextWindow: 258_400,
            outputReserve: 32_000,
        });
        expect(fake.requests).toHaveLength(0);
    });
});

describe('redaction', () => {
    it('removes tokens, JWTs and emails', () => {
        const credentials = issued();
        const text = redactSecrets(
            `auth ${credentials.accessToken} refresh=${encodeURIComponent(credentials.refreshToken)} Bearer abc.def for ${FAKE_EMAIL} account ${credentials.accountId}`,
            [credentials.accessToken, credentials.refreshToken, credentials.accountId],
        );
        noSecrets(text, [credentials]);
        expect(text).not.toContain(FAKE_ACCOUNT);
        expect(text).toContain('[redacted]');
        expect(text).toContain('[email]');
    });

    it('keeps errors free of provider text and credentials', () => {
        const error = new ChatGptError('chatgpt_rejected', {
            status: 400,
            providerCode: `bad ${FAKE_EMAIL}`,
        });
        expect(error.providerCode).toBeUndefined();
        expect(error.detail).toBe('chatgpt_rejected HTTP 400');
        expect(JSON.parse(JSON.stringify(error))).toEqual({
            name: 'ChatGptError',
            code: 'chatgpt_rejected',
            message: error.message,
            status: 400,
        });
    });
});

describe('egress', () => {
    it('reaches OpenAI only through the configured endpoints', async () => {
        // Defaults point at OpenAI; the test guard refuses the connection, which
        // shows where an unconfigured login and adapter would go.
        await expect(startLogin()).rejects.toMatchObject({
            code: 'chatgpt_unavailable',
        });
        expect(takeEgressAttempts()).toEqual(['auth.openai.com:443']);
        const credentials = issued();
        const chunks = await collect(
            chat({
                adapter: chatGptAdapter({
                    getCredentials: async () => credentials,
                    saveCredentials: async () => {},
                }),
                stream: true,
                messages: [{ role: 'user', content: 'Hi' }],
                debug: modelDebug,
            }),
        );
        expect(chunks.find((chunk) => chunk.type === 'RUN_ERROR')).toMatchObject({
            code: 'chatgpt_unavailable',
        });
        expect(takeEgressAttempts()).toEqual(['chatgpt.com:443']);
    });
});
