import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { TURN_FAILURE_MESSAGES } from '@socio/foundation/observability/failures';
import { OUTPUT_LIMIT_NOTE } from '@socio/foundation/turns/output-limit';
import {
    NO_INFERENCE_MESSAGES,
    type ByoConnectStep,
    type OperatorInferenceState,
    type UserInferenceState,
} from '@socio/shared/inference';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { CHATGPT_KIND, chatGptEndpointsFromEnv, chatGptKind } from '../src/server/inference/chatgpt-kind.js';
import { CHATGPT_DEFAULT_MODEL, CHATGPT_STANDARD_MODEL, readBlob } from '../src/server/inference/chatgpt/index.js';
import { resetRefreshState } from '../src/server/inference/chatgpt/refresh.js';
import { TelegramChannel } from '../src/server/telegram/telegram-channel.js';

import {
    FAKE_ACCOUNT,
    FAKE_EMAIL,
    FAKE_NAME,
    cutOffReply,
    startFakeChatGpt,
    textReply,
    toolCallReply,
} from './fixtures/fake-chatgpt.js';
import { fakeTelegram } from './fixtures/fake-telegram.js';
import { pngOf } from './fixtures/media.js';
import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { telegramServices } from './helpers/telegram-channel.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';
import { takeEgressAttempts } from './setup/egress-guard.js';

// The ChatGPT kind gets the real fetch: tests stub the global one for the
// shared backend only.
const realFetch = globalThis.fetch.bind(globalThis);
const SECRET = 'byo-chatgpt-wiring-secret-0123456789';
const SHARED_URL = 'https://model.invalid/v1';
const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
// No model settings: nothing seeds a shared backend.
const BASE_CONFIG: PlatformConfig = {
    baseUrl: '',
    voiceName: 'marin',
    runtimeUrl: '',
    sessionSecret: SECRET,
};
const SHARED_CONFIG: PlatformConfig = {
    ...BASE_CONFIG,
    baseUrl: SHARED_URL,
    apiKey: 'local-key',
    model: 'custom-model',
};

type Fake = Awaited<ReturnType<typeof startFakeChatGpt>>;
let fake: Fake;
const cleanup: Array<() => unknown> = [];
beforeEach(async () => {
    resetRefreshState();
    fake = await startFakeChatGpt();
});
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
    await fake.close();
    expect(takeEgressAttempts()).toEqual([]);
});

/** A platform and app with the ChatGPT kind on the fake, and API callers per user. */
async function fixture(config: PlatformConfig = BASE_CONFIG) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, platform, store, workspace, dispose } = await makeTestRuntime({
        config,
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    let clock = Date.now();
    platform.inference.register(
        chatGptKind({
            endpoints: fake.endpoints,
            fetch: realFetch,
            now: () => clock,
        }),
    );
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return async <T = unknown>(
            path: string,
            method = 'GET',
            body?: unknown,
        ): Promise<{ status: number; body: T }> => {
            const response = await app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: (await response.json()) as T };
        };
    };
    const dot = workspace.dots()[0];
    workspace.bindThread('t-bob', dot.id, 'Hi', 'bob');
    /** One web turn as bob: DotAgent on the platform's registry, via the runner. */
    const turn = async (text: string | unknown[] = 'Hello?', options: { extensions?: boolean } = {}) => {
        const runner = new LocalAgentRunner(testDatabase());
        cleanup.push(() => runner.close());
        const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
            inference: platform.inference,
            ...(options.extensions ? { extensions: platform.dotExtensions } : {}),
        });
        const input: RunAgentInput = {
            threadId: 't-bob',
            runId: `run-${Math.random()}`,
            state: {},
            context: [],
            messages: [{ id: `u-${Math.random()}`, role: 'user', content: text as never }],
            tools: [],
            forwardedProps: {},
        };
        agent.threadId = 't-bob';
        agent.setMessages(input.messages);
        return lastValueFrom(runner.run({ threadId: 't-bob', agent, input }).pipe(toArray()));
    };
    return {
        platform,
        workspace,
        store,
        as,
        turn,
        tick: (ms: number) => (clock += ms),
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The operator allows the kind; bob connects through the account dialog's API. */
async function allowAndConnect(f: Fixture) {
    const olga = await f.as('olga');
    const allowed = await olga<OperatorInferenceState>('/inference/settings', 'PUT', {
        allowedByoKinds: [CHATGPT_KIND],
    });
    expect(allowed.status).toBe(200);
    const bob = await f.as('bob');
    const first = await bob<ByoConnectStep>(`/me/inference/${CHATGPT_KIND}/connect`, 'POST', {});
    expect(first).toEqual({
        status: 200,
        body: {
            state: 'pending',
            userCode: 'ABCD-1234',
            verificationUrl: `${fake.endpoints.issuer}/codex/device`,
            message: 'Open the sign-in page, sign in to ChatGPT and enter this code.',
            pollMs: 1000,
        },
    });
    // Not entered yet: the poll keeps showing the code.
    f.tick(1000);
    const waiting = await bob<ByoConnectStep>(`/me/inference/${CHATGPT_KIND}/connect`, 'POST', {});
    expect(waiting.body).toMatchObject({
        state: 'pending',
        userCode: 'ABCD-1234',
    });
    fake.state.device = 'approved';
    f.tick(1000);
    const done = await bob<ByoConnectStep>(`/me/inference/${CHATGPT_KIND}/connect`, 'POST', {});
    expect(done.body).toEqual({ state: 'connected' });
    return { olga, bob };
}

const responsesRequests = () => fake.requests.filter((r) => r.path === '/backend-api/codex/responses');
const errorOf = (events: { type: string }[]) => events.find((event) => event.type === 'RUN_ERROR');
const textOf = (events: { type: string }[]) =>
    events
        .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
        .map((event) => (event as unknown as { delta: string }).delta)
        .join('');

it('connects a ChatGPT plan through the registry and runs Dot turns on it', async () => {
    const f = await fixture();
    // Registered but not allowed: nobody can connect, and the operator sees it.
    const bobFirst = await f.as('bob');
    expect((await bobFirst(`/me/inference/${CHATGPT_KIND}/connect`, 'POST', {})).status).toBe(404);
    const olgaFirst = await f.as('olga');
    const before = await olgaFirst<OperatorInferenceState>('/inference');
    expect(before.body.byoKinds).toEqual([
        expect.objectContaining({
            id: CHATGPT_KIND,
            label: 'ChatGPT',
            allowed: false,
            models: expect.objectContaining({
                default: CHATGPT_DEFAULT_MODEL,
                selected: CHATGPT_DEFAULT_MODEL,
                help: expect.stringContaining(CHATGPT_STANDARD_MODEL),
            }),
        }),
    ]);
    expect(fake.requests).toEqual([]);

    const { bob } = await allowAndConnect(f);
    const state = await bob<UserInferenceState>('/me/inference');
    expect(state.body).toEqual({
        kinds: [
            expect.objectContaining({
                id: CHATGPT_KIND,
                state: 'connected',
                detail: 'Plan: Plus',
            }),
        ],
        active: { source: 'byo', label: 'ChatGPT' },
    });
    // Nothing the browser sees names the account, the person or a token.
    const shown = JSON.stringify(state.body);
    for (const secret of [FAKE_ACCOUNT, FAKE_EMAIL, FAKE_NAME, 'rt_']) {
        expect(shown).not.toContain(secret);
    }
    const stored = (await f.platform.inference.store.connection('bob', CHATGPT_KIND))!;
    expect(readBlob(stored.credentials)?.credentials?.accountId).toBe(FAKE_ACCOUNT);
    expect(stored.meta).toEqual({ plan: 'Plus' });
    const sealed = f.workspace.db.prepare('SELECT credentials FROM user_inference_connections').get() as {
        credentials: string;
    };
    // The tokens themselves (a fixed prefix like "rt_" turns up in random
    // ciphertext now and then, so check the values).
    const tokens = readBlob(stored.credentials)!.credentials!;
    expect(tokens.refreshToken.length).toBeGreaterThan(8);
    expect(sealed.credentials).not.toContain(tokens.refreshToken);
    expect(sealed.credentials).not.toContain(tokens.accessToken);
    expect(sealed.credentials).not.toContain(FAKE_ACCOUNT);

    // A turn streams from the fake Responses endpoint on bob's own token.
    fake.state.replies.push(textReply('Hello from your plan.'));
    const events = await f.turn();
    expect(errorOf(events)).toBeUndefined();
    expect(textOf(events)).toBe('Hello from your plan.');
    expect(events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').length).toBeGreaterThan(1);
    const [request] = responsesRequests();
    const credentials = readBlob(stored.credentials)!.credentials!;
    expect(request.headers.authorization).toBe(`Bearer ${credentials.accessToken}`);
    expect(request.headers['chatgpt-account-id']).toBe(FAKE_ACCOUNT);
    expect(JSON.parse(request.body)).toMatchObject({
        model: CHATGPT_DEFAULT_MODEL,
        store: false,
        stream: true,
    });

    // A tool call round trip: the Dot lists its Spaces, then answers.
    fake.state.replies.push(toolCallReply('list_authorized_spaces', {}), textReply('You have Spaces.', 'resp_2'));
    const tooled = await f.turn('Which Spaces can you use?');
    expect(errorOf(tooled)).toBeUndefined();
    expect(tooled.some((e) => e.type === 'TOOL_CALL_START')).toBe(true);
    expect(textOf(tooled)).toBe('You have Spaces.');
    const followUp = JSON.parse(responsesRequests()[2].body) as {
        input: { type?: string; call_id?: string }[];
    };
    expect(followUp.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1')).toBe(true);

    // The operator's model choice reaches the request.
    const olga = await f.as('olga');
    expect(
        (
            await olga('/inference/settings', 'PUT', {
                byoModels: { [CHATGPT_KIND]: 'not-a-model' },
            })
        ).status,
    ).toBe(400);
    const chosen = await olga<OperatorInferenceState>('/inference/settings', 'PUT', {
        byoModels: { [CHATGPT_KIND]: CHATGPT_STANDARD_MODEL },
    });
    expect(chosen.body.byoKinds[0].models?.selected).toBe(CHATGPT_STANDARD_MODEL);
    expect((await bob('/inference/settings', 'PUT', { byoModels: {} })).status).toBe(403);
    fake.state.replies.push(textReply('On 5.5.'));
    await f.turn();
    expect(JSON.parse(responsesRequests().at(-1)!.body).model).toBe(CHATGPT_STANDARD_MODEL);

    // Disconnect revokes the refresh token and deletes the connection.
    const refreshToken = credentials.refreshToken;
    expect((await bob(`/me/inference/${CHATGPT_KIND}`, 'DELETE')).status).toBe(200);
    expect(fake.state.revoked).toEqual([refreshToken]);
    expect(await f.platform.inference.store.connection('bob', CHATGPT_KIND)).toBe(undefined);
    // With nothing else, the chat says how to get a model.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorOf(await f.turn())).toEqual({
        type: 'RUN_ERROR',
        message: NO_INFERENCE_MESSAGES.connect,
        code: 'no_inference',
        timestamp: expect.any(Number),
    });
});

it('sends an attached image to ChatGPT as input_image, keeping only the reference in the run (CB-54)', async () => {
    const f = await fixture();
    await allowAndConnect(f);
    const photo = pngOf(300, 7);
    const { attachment } = await f.platform.media.upload('bob', {
        name: 'square.png',
        bytes: photo,
        purpose: 'attachment',
        threadId: 't-bob',
    });
    fake.state.replies.push(textReply('A square.'));
    const events = await f.turn(
        [
            { type: 'text', text: 'What is this?' },
            {
                type: 'binary',
                id: attachment!.id,
                mimeType: 'image/png',
                filename: 'square.png',
            },
        ],
        { extensions: true },
    );
    expect(errorOf(events)).toBeUndefined();
    const body = JSON.parse(responsesRequests()[0].body) as {
        input: {
            role?: string;
            content?: { type: string; image_url?: string }[];
        }[];
    };
    const parts = body.input.flatMap((item) => (item.role === 'user' ? (item.content ?? []) : []));
    expect(parts).toContainEqual(
        expect.objectContaining({
            type: 'input_image',
            image_url: `data:image/png;base64,${photo.toString('base64')}`,
        }),
    );
    // The run's events (what the runner stores) carry the reference only.
    const stored = JSON.stringify(events);
    expect(stored).toContain(attachment!.id);
    expect(stored).not.toContain(photo.toString('base64'));
});

it('shows a usage limit as its friendly message, in the app and in Telegram', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture();
    await allowAndConnect(f);
    const limit = {
        status: 429,
        body: {
            error: {
                type: 'usage_limit_reached',
                message: `The usage limit has been reached for ${FAKE_EMAIL}`,
                plan_type: 'plus',
                resets_at: Math.floor(Date.UTC(2026, 9, 9, 14, 30) / 1000),
            },
        },
    };
    const friendly =
        'You have reached your ChatGPT Plus plan’s usage limit for now. It resets at 2026-10-09 14:30 UTC.';
    fake.state.replies.push(limit);
    const events = await f.turn();
    expect(errorOf(events)).toEqual({
        type: 'RUN_ERROR',
        message: friendly,
        code: 'chatgpt_usage_limit',
        timestamp: expect.any(Number),
    });
    expect(JSON.stringify(events)).not.toContain(FAKE_EMAIL);

    // Telegram: the same message as the reply.
    const bot = await fakeTelegram();
    const runner = new LocalAgentRunner(testDatabase());
    const channel = new TelegramChannel({
        settings: {
            token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012',
            allowedChatIds: [],
        },
        runner,
        store: f.store,
        workspace: f.workspace,
        ...telegramServices({
            store: f.store,
            workspace: f.workspace,
            config: BASE_CONFIG,
            runner,
            inference: f.platform.inference,
        }),
        isUser: (id) => USERS.some((user) => user.id === id),
        apiRoot: bot.apiRoot,
    });
    cleanup.push(
        () => bot.close(),
        () => runner.close(),
        () => channel.stop(),
    );
    await channel.start();
    await f.workspace.telegram.redeem((await f.workspace.telegram.createCode('bob')).code, '43');
    fake.state.replies.push(limit);
    bot.message({
        text: 'hi',
        chat: { id: 43, type: 'private' },
        from: { id: 43 },
    });
    const texts = () =>
        bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => String(c.body.text));
    await expect.poll(() => texts().includes(friendly)).toBe(true);
    expect(texts().join('\n')).not.toContain(FAKE_EMAIL);
});

it('skips a tool call the output limit cut off on ChatGPT and carries on, ending plainly when it happens again (CB-126)', async () => {
    const f = await fixture();
    await allowAndConnect(f);
    // The production case: a large file in one call, cut off by the backend.
    fake.state.replies.push(
        cutOffReply('computer_files_write', '{"path":"report.md","contents":"# Report'),
        textReply('I will write the report in parts.', 'resp_2'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const events = await f.turn('Write the report.');
    expect(errorOf(events)).toBeUndefined();
    expect(textOf(events)).toBe('I will write the report in parts.');
    const followUp = JSON.parse(responsesRequests().at(-1)!.body) as {
        input: { type?: string; call_id?: string; output?: string }[];
    };
    expect(followUp.input).toContainEqual(
        expect.objectContaining({
            type: 'function_call_output',
            call_id: 'call_cut',
            output: expect.stringContaining(OUTPUT_LIMIT_NOTE),
        }),
    );

    // Cut off twice in one turn: the plain message, not the generic one.
    fake.state.replies.push(
        cutOffReply('computer_files_write', '{"path":"a.md","contents":"#', 'call_a'),
        cutOffReply('computer_files_write', '{"path":"a.md","contents":"#', 'call_b'),
    );
    const again = await f.turn('Write it again.');
    expect(errorOf(again)).toEqual({
        type: 'RUN_ERROR',
        message: TURN_FAILURE_MESSAGES.output_limit,
        code: 'output_limit',
        timestamp: expect.any(Number),
    });
});

it('persists a rotated refresh token before the turn uses it', async () => {
    const f = await fixture();
    // A short-lived first token: the next turn refreshes it first.
    fake.state.accessTtl = 60;
    await allowAndConnect(f);
    fake.state.accessTtl = 3600;
    const before = readBlob(
        (await f.platform.inference.store.connection('bob', CHATGPT_KIND))!.credentials,
    )!.credentials!;
    fake.state.replies.push(textReply('Fresh.'));
    const events = await f.turn();
    expect(textOf(events)).toBe('Fresh.');
    expect(fake.state.refreshCount).toBe(1);
    const after = readBlob(
        (await f.platform.inference.store.connection('bob', CHATGPT_KIND))!.credentials,
    )!.credentials!;
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(fake.state.refreshTokens.has(before.refreshToken)).toBe(false);
    expect(fake.state.refreshTokens.has(after.refreshToken)).toBe(true);
    // The turn ran on the rotated access token, and the next one still works.
    expect(responsesRequests()[0].headers.authorization).toBe(`Bearer ${after.accessToken}`);
    fake.state.replies.push(textReply('Again.'));
    expect(textOf(await f.turn())).toBe('Again.');
    expect(fake.state.refreshCount).toBe(1);
});

it('falls back to the default backend when the plan can’t serve, else says how to connect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture(SHARED_CONFIG);
    fake.state.accessTtl = 60;
    const { bob } = await allowAndConnect(f);
    // The sign-in ended: the refresh before the turn is refused.
    fake.state.refreshError = 'invalid_grant';
    const shared: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (!String(url).startsWith(SHARED_URL)) {
            return realFetch(url, init);
        }
        shared.push(String(url));
        return completion({ role: 'assistant', content: 'From the shared model.' });
    });
    const events = await f.turn();
    expect(errorOf(events)).toBeUndefined();
    expect(textOf(events)).toBe('From the shared model.');
    expect(shared).toEqual([`${SHARED_URL}/chat/completions`]);
    expect(responsesRequests()).toEqual([]);
    // Bob is asked to sign in again; his chats run on the shared model.
    expect((await bob<UserInferenceState>('/me/inference')).body).toEqual({
        kinds: [
            expect.objectContaining({
                id: CHATGPT_KIND,
                state: 'expired',
                detail: 'Sign in again: ChatGPT ended this sign-in.',
            }),
        ],
        active: { source: 'shared', label: 'Self-hosted (custom-model)' },
    });

    // Without a shared backend either, the turn says how to connect.
    const backend = (await f.platform.inference.store.backends())[0];
    await f.platform.inference.store.setEnabled(backend.id, false);
    expect(errorOf(await f.turn())).toEqual({
        type: 'RUN_ERROR',
        message: NO_INFERENCE_MESSAGES.connect,
        code: 'no_inference',
        timestamp: expect.any(Number),
    });
});

it('cancels a sign-in in progress and removes connections with the account', async () => {
    const f = await fixture();
    const olga = await f.as('olga');
    await olga('/inference/settings', 'PUT', { allowedByoKinds: [CHATGPT_KIND] });
    const bob = await f.as('bob');
    const path = `/me/inference/${CHATGPT_KIND}/connect`;
    expect((await bob<ByoConnectStep>(path, 'POST', {})).body.state).toBe('pending');
    expect((await bob<ByoConnectStep>(path, 'POST', { cancel: true })).body).toEqual({ state: 'disconnected' });
    // A new Connect starts a new sign-in.
    const usercodes = () => fake.requests.filter((r) => r.path === '/api/accounts/deviceauth/usercode').length;
    expect(usercodes()).toBe(1);
    expect((await bob<ByoConnectStep>(path, 'POST', {})).body.state).toBe('pending');
    expect(usercodes()).toBe(2);
    fake.state.device = 'approved';
    f.tick(1000);
    expect((await bob<ByoConnectStep>(path, 'POST', {})).body.state).toBe('connected');
    // An account removal (onUserRemoved → forgetUser) revokes and deletes.
    await f.platform.inference.forgetUser('bob');
    expect(fake.state.revoked).toHaveLength(1);
    expect(await f.platform.inference.store.connectedKinds('bob')).toEqual([]);
});

it('reads the testing-only endpoint overrides from the environment', () => {
    expect(chatGptEndpointsFromEnv({})).toBeUndefined();
    expect(
        chatGptEndpointsFromEnv({
            CHATGPT_AUTH_ISSUER: ' http://127.0.0.1:9 ',
            CHATGPT_BASE_URL: 'http://127.0.0.1:9/backend-api/codex',
        }),
    ).toEqual({
        issuer: 'http://127.0.0.1:9',
        codexBaseUrl: 'http://127.0.0.1:9/backend-api/codex',
    });
});
