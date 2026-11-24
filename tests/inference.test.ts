import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { SecretBox } from '@socio/foundation/keys/secret-box';
import { TURN_FAILURE_MESSAGES } from '@socio/foundation/observability/failures';
import type { InferencePurpose } from '@socio/foundation/turns/inference-purpose';
import {
    NO_INFERENCE_MESSAGES,
    type InferenceBackendView,
    type OperatorInferenceState,
    type UserInferenceState,
} from '@socio/shared/inference';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { ThreadTitler } from '../src/server/chat-name-suggestions/thread-titles.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { FAKE_BYO_KIND, fakeByoKind } from '../src/server/inference/fake-byo.js';
import { InferenceService } from '../src/server/inference/service.js';
import { TelegramChannel } from '../src/server/telegram/telegram-channel.js';

import { fakeTelegram } from './fixtures/fake-telegram.js';
import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { telegramServices } from './helpers/telegram-channel.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'inference-test-secret-0123456789';
const BYO_URL = 'https://byo.invalid/v1';
const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const MODEL_CONFIG: PlatformConfig = {
    baseUrl: 'https://model.invalid/v1',
    apiKey: 'local-key',
    model: 'custom-model',
    maxCompletionTokens: 8192,
    titleModelOptions: { chat_template_kwargs: { enable_thinking: false } },
    voiceName: 'marin',
    runtimeUrl: '',
    sessionSecret: SECRET,
};

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

function service(options: { fetch?: typeof fetch } = {}) {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const log: string[] = [];
    const inference = new InferenceService(workspace.db, {
        secret: SECRET,
        log: (line) => log.push(line),
        ...options,
    });
    inference.register(fakeByoKind({ baseUrl: BYO_URL }));
    return { workspace, inference, log };
}

/** Connects a user's fake subscription through its two connect steps. */
async function connectFake(inference: InferenceService, userId: string) {
    expect(await inference.connect(userId, FAKE_BYO_KIND, {})).toMatchObject({
        state: 'pending',
        userCode: 'FAKE-0000',
    });
    expect(await inference.connect(userId, FAKE_BYO_KIND, {})).toEqual({
        state: 'connected',
    });
}

const backend = {
    label: 'Homelab',
    baseUrl: 'http://orion.invalid:8016/v1',
    model: 'qwen',
    apiKey: 'sk-backend-plaintext-marker',
};

it('seals secrets with a key derived from SESSION_SECRET', () => {
    const box = new SecretBox(SECRET);
    const sealed = box.seal({ apiKey: 'sk-plain' });
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('sk-plain');
    expect(box.open(sealed)).toEqual({ apiKey: 'sk-plain' });
    // Each seal is fresh; another secret can't open it.
    expect(box.seal({ apiKey: 'sk-plain' })).not.toBe(sealed);
    expect(() => new SecretBox('another-secret-0123456789').open(sealed)).toThrow();
});

it('keeps no plaintext key or token in the database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-inference-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'brain.sqlite'));
    const workspace = new WorkspaceStore(path);
    const inference = new InferenceService(workspace.db, {
        secret: SECRET,
        log: () => {},
    });
    inference.register(fakeByoKind({ baseUrl: BYO_URL }));
    const created = await inference.createBackend(backend);
    expect(created).toMatchObject({ hasApiKey: true, status: 'ready' });
    expect(JSON.stringify(created)).not.toContain(backend.apiKey);
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    await connectFake(inference, 'bob');
    const { token } = (await inference.store.connection('bob', FAKE_BYO_KIND))!.credentials as { token: string };
    // Readable back through the store, with the same secret only.
    expect((await inference.store.backend(created.id))!.apiKey).toBe(backend.apiKey);
    workspace.close();
    const files = readdirSync(dir).map((name) => readFileSync(join(dir, name)).toString('latin1'));
    for (const secret of [backend.apiKey, token]) {
        expect(files.some((file) => file.includes(secret))).toBe(false);
    }
    // Another SESSION_SECRET: the key is unreadable, the connection gone.
    const reopened = new WorkspaceStore(path);
    const rotated = new InferenceService(reopened.db, {
        secret: 'rotated-secret-0123456789abcdef',
        log: () => {},
    });
    rotated.register(fakeByoKind({ baseUrl: BYO_URL }));
    expect((await rotated.operatorState()).backends[0]).toMatchObject({
        hasApiKey: true,
        status: 'key_unreadable',
    });
    expect(await rotated.shared()).toBeUndefined();
    expect(await rotated.store.connection('bob', FAKE_BYO_KIND)).toBeUndefined();
    reopened.close();
});

it('seeds the first backend from the environment once; then the database wins', async () => {
    const { workspace, inference, log } = service();
    expect(await inference.seed({ ...MODEL_CONFIG, baseUrl: '' })).toBe('none');
    expect(await inference.store.backends()).toEqual([]);
    expect(
        await inference.seed({
            ...MODEL_CONFIG,
            acceptsImages: true,
            maxImages: 6,
        }),
    ).toBe('seeded');
    const [seeded] = (await inference.operatorState()).backends;
    expect(seeded).toMatchObject({
        kind: 'openai-compatible',
        label: 'Self-hosted (custom-model)',
        enabled: true,
        isDefault: true,
        status: 'ready',
        hasApiKey: true,
        config: {
            baseUrl: 'https://model.invalid/v1',
            model: 'custom-model',
            titleModelOptions: { chat_template_kwargs: { enable_thinking: false } },
        },
        capabilities: {
            acceptsImages: true,
            maxImages: 6,
            maxCompletionTokens: 8192,
        },
    });
    expect(log).toEqual([expect.stringContaining('created the backend')]);
    // Same settings on the next boot: nothing happens, nothing is logged.
    log.length = 0;
    expect(
        await inference.seed({
            ...MODEL_CONFIG,
            acceptsImages: true,
            maxImages: 6,
        }),
    ).toBe('kept');
    expect(log).toEqual([]);
    // Changed settings: still one backend, unchanged, and a notice naming
    // the variables (never their values).
    await inference.seed({ ...MODEL_CONFIG, model: 'other', apiKey: 'sk-new' });
    expect(await inference.store.backends()).toHaveLength(1);
    expect((await inference.store.backends())[0].config.model).toBe('custom-model');
    expect(log).toEqual([
        expect.stringContaining('OPENAI_MODEL, OPENAI_API_KEY, MODEL_ACCEPTS_IMAGES, MODEL_MAX_IMAGES changed'),
    ]);
    expect(log.join('\n')).not.toContain('sk-new');
    // Deleted on the Operator page: the environment does not bring it back.
    await inference.deleteBackend(seeded.id);
    await inference.seed(MODEL_CONFIG);
    expect(await inference.store.backends()).toEqual([]);
    expect(await inference.store.defaultBackendId()).toBeNull();
    // The seed is sealed: the key is not in the settings table either.
    const raw = workspace.db.prepare("SELECT value FROM inference_settings WHERE key='envSeed'").get() as {
        value: string;
    };
    expect(raw.value).not.toContain('local-key');
});

it('does not seed over backends an operator created first', async () => {
    const { inference } = service();
    const created = await inference.createBackend(backend);
    expect(created.isDefault).toBe(true);
    expect(await inference.seed(MODEL_CONFIG)).toBe('kept');
    expect(await inference.store.backends()).toHaveLength(1);
});

const resolveFor = async (inference: InferenceService, userId: string | undefined, purpose: InferencePurpose) => {
    const resolution = await inference.resolve({ userId, purpose });
    return resolution.ok ? (resolution.model.source.type === 'byo' ? 'byo' : 'shared') : resolution.reason;
};
const matrix = async (inference: InferenceService, userId = 'bob') =>
    Object.fromEntries(
        await Promise.all(
            (['chat', 'scheduled', 'title', 'learning'] as const).map(async (purpose) => [
                purpose,
                await resolveFor(inference, userId, purpose),
            ]),
        ),
    );

it('resolves user turns to their own connection, the rest to the default backend', async () => {
    const { inference } = service();
    // Nothing at all.
    expect(await matrix(inference)).toEqual({
        chat: 'ask_operator',
        scheduled: 'ask_operator',
        title: 'ask_operator',
        learning: 'ask_operator',
    });
    expect(await inference.availability('bob')).toEqual({
        available: false,
        byoAllowed: false,
    });
    // A default shared backend: everything runs on it.
    const shared = await inference.createBackend(backend);
    const sharedOnly = {
        chat: 'shared',
        scheduled: 'shared',
        title: 'shared',
        learning: 'shared',
    };
    expect(await matrix(inference)).toEqual(sharedOnly);
    // Connected but not allowed: still the shared backend.
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    await connectFake(inference, 'bob');
    await inference.updateSettings({ allowedByoKinds: [] });
    expect(await matrix(inference)).toEqual(sharedOnly);
    expect((await inference.userState('bob')).kinds).toEqual([
        expect.objectContaining({
            id: FAKE_BYO_KIND,
            state: 'connected',
            detail: expect.stringContaining('no longer allows'),
        }),
    ]);
    // Allowed and connected: the user's own turns use it; background work doesn't.
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    expect(await matrix(inference)).toEqual({
        ...sharedOnly,
        chat: 'byo',
        scheduled: 'byo',
    });
    expect(await inference.availability('bob')).toMatchObject({
        available: true,
        source: 'byo',
        label: 'Fake subscription',
    });
    // Allowed, not connected (alice): the shared backend.
    expect(await matrix(inference, 'alice')).toEqual(sharedOnly);
    // A pending connection doesn't count.
    await inference.connect('alice', FAKE_BYO_KIND, {});
    expect((await inference.userKind('alice', FAKE_BYO_KIND))?.state).toBe('pending');
    expect(await resolveFor(inference, 'alice', 'chat')).toBe('shared');
    // Default disabled: connected users keep chatting, others are told to connect.
    await inference.updateBackend(shared.id, { ...backend, enabled: false });
    expect(await matrix(inference)).toEqual({
        chat: 'byo',
        scheduled: 'byo',
        title: 'ask_operator',
        learning: 'ask_operator',
    });
    expect(await resolveFor(inference, 'alice', 'chat')).toBe('connect_byo');
    expect(await inference.availability('alice')).toEqual({
        available: false,
        byoAllowed: true,
    });
    // BYO not allowed either: ask an operator.
    await inference.updateSettings({ allowedByoKinds: [] });
    expect(await resolveFor(inference, 'bob', 'chat')).toBe('ask_operator');
    // Disconnected and removed users lose their connection.
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    expect(await inference.disconnect('bob', FAKE_BYO_KIND)).toBe(true);
    expect(await resolveFor(inference, 'bob', 'chat')).toBe('connect_byo');
    await inference.forgetUser('alice');
    expect(await inference.store.connectedKinds('alice')).toEqual([]);
});

it('builds the shared model from the backend: adapter, capabilities, completion cap', async () => {
    const { inference } = service();
    await inference.createBackend({
        ...backend,
        acceptsImages: true,
        maxImages: 2,
        titleModelOptions: { think: false },
    });
    const resolution = await inference.resolve({ purpose: 'title' });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
        return;
    }
    expect(resolution.model).toMatchObject({
        label: 'Homelab',
        model: 'qwen',
        capabilities: { acceptsImages: true, maxImages: 2 },
        modelOptions: { max_completion_tokens: 2200 },
        chatCompletions: {
            baseUrl: backend.baseUrl,
            apiKey: backend.apiKey,
            model: 'qwen',
            titleModelOptions: { think: false },
        },
    });
    expect(resolution.model.adapter().model).toBe('qwen');
});

it('skips titles while there is no shared backend', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => runner.close(),
        () => workspace.close(),
    );
    const thread = workspace.bindThread('thread', workspace.dots()[0].id, 'A question', 'bob');
    const requests: string[] = [];
    // The default shared backend, absent at first.
    const shared: { endpoint?: { baseUrl: string; model: string } } = {};
    const titler = new ThreadTitler(
        workspace,
        runner,
        () => shared.endpoint,
        async (url) => {
            requests.push(String(url));
            return Response.json({
                choices: [{ message: { content: 'Backups' } }],
            });
        },
    );
    const run = (
        titler as unknown as {
            onRun(threadId: string, status: string): void;
        }
    ).onRun.bind(titler);
    vi.spyOn(runner, 'messages').mockResolvedValue([
        { id: 'u', role: 'user', content: 'How do I back up?' },
        { id: 'a', role: 'assistant', content: 'Copy the file.' },
    ]);
    run(thread.id, 'finished');
    await titler.idle();
    expect(requests).toEqual([]);
    expect(workspace.isTitled(thread.id)).toBe(false);
    shared.endpoint = { baseUrl: 'http://orion.invalid/v1', model: 'qwen' };
    run(thread.id, 'finished');
    await titler.idle();
    expect(requests).toEqual(['http://orion.invalid/v1/chat/completions']);
    expect(workspace.thread(thread.id)?.title).toBe('Backups');
});

/** Runs one DotAgent turn as `userId` and returns its events. */
async function turnEvents(agent: DotAgent, threadId: string) {
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(() => runner.close());
    const input: RunAgentInput = {
        threadId,
        runId: `run-${Math.random()}`,
        state: {},
        context: [],
        messages: [{ id: 'u1', role: 'user', content: 'Hello?' }],
        tools: [],
        forwardedProps: {},
    };
    agent.threadId = threadId;
    agent.setMessages(input.messages);
    return lastValueFrom(runner.run({ threadId, agent, input }).pipe(toArray()));
}

it('ends a turn without a model with the friendly message, never a stack trace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { workspace, inference } = service();
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const dot = workspace.dots()[0];
    workspace.bindThread('t-bob', dot.id, 'Hi', 'bob');
    const agent = () =>
        new DotAgent(store, workspace, MODEL_CONFIG, dot.id, false, undefined, {
            inference,
        });
    const errorOf = async () => (await turnEvents(agent(), 't-bob')).find((e) => e.type === 'RUN_ERROR');
    expect(await errorOf()).toEqual({
        type: 'RUN_ERROR',
        message: NO_INFERENCE_MESSAGES.operator,
        code: 'no_inference_operator',
        timestamp: expect.any(Number),
    });
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    expect(await errorOf()).toEqual({
        type: 'RUN_ERROR',
        message: NO_INFERENCE_MESSAGES.connect,
        code: 'no_inference',
        timestamp: expect.any(Number),
    });
    expect(TURN_FAILURE_MESSAGES.no_inference).toBe(
        'No model is available. Connect your own subscription in Account → Inference.',
    );
    // Connected: the turn goes to the user's own subscription, with its token.
    await connectFake(inference, 'bob');
    const { token } = (await inference.store.connection('bob', FAKE_BYO_KIND))!.credentials as { token: string };
    const requests: { url: string; auth: string | null; model: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        requests.push({
            url: String(url),
            auth: new Headers(init?.headers).get('authorization'),
            model: JSON.parse(String(init?.body)).model,
        });
        return completion({ role: 'assistant', content: 'From your plan.' });
    });
    const events = await turnEvents(agent(), 't-bob');
    expect(events.some((e) => e.type === 'RUN_FINISHED')).toBe(true);
    expect(requests).toEqual([
        {
            url: `${BYO_URL}/chat/completions`,
            auth: `Bearer ${token}`,
            model: 'fake-subscription',
        },
    ]);
});

it('keeps today’s behavior on the backend seeded from the environment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { workspace, platform, dispose } = await makeTestRuntime({
        config: { ...MODEL_CONFIG, acceptsImages: false },
    });
    cleanup.push(dispose);
    expect(await platform.setup('bob')).toMatchObject({
        model: true,
        missing: [],
        inference: {
            available: true,
            source: 'shared',
            label: 'Self-hosted (custom-model)',
            byoAllowed: false,
        },
    });
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const auth: (string | null)[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        urls.push(String(url));
        auth.push(new Headers(init?.headers).get('authorization'));
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return body.stream
            ? completion({ role: 'assistant', content: 'Answer.' })
            : Response.json({ choices: [{ message: { content: 'A title' } }] });
    });
    const thread = await platform.createConversation(workspace.dots()[0].id, 'First', 'bob');
    expect(await platform.turn(thread.id, 'Hello', new AbortController().signal)).toBe('Answer.');
    await platform.titles.idle();
    expect(urls).toEqual(['https://model.invalid/v1/chat/completions', 'https://model.invalid/v1/chat/completions']);
    expect(auth).toEqual(['Bearer local-key', 'Bearer local-key']);
    expect(bodies[0]).toMatchObject({
        model: 'custom-model',
        max_completion_tokens: 8192,
        stream: true,
    });
    expect(bodies[1]).toMatchObject({
        model: 'custom-model',
        chat_template_kwargs: { enable_thinking: false },
    });
    expect(workspace.thread(thread.id)?.title).toBe('A title');
});

async function appFixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, platform, dispose } = await makeTestRuntime({
        config: MODEL_CONFIG,
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const probes: string[] = [];
    platform.inference.register(fakeByoKind({ baseUrl: BYO_URL }));
    // The operator's Test reaches a stubbed /models.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        probes.push(`${String(url)} ${new Headers(init?.headers).get('authorization')}`);
        return Response.json({ data: [{ id: 'custom-model' }] });
    });
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    return { platform, as, probes };
}

it('lets admins alone manage backends; keys are write-only (CB-390)', async () => {
    const { as, probes, platform } = await appFixture();
    const olga = await as('olga');
    const alice = await as('alice');
    const bob = await as('bob');
    // Every admin, not only the first (CB-390: no operator tier).
    expect((await alice('/inference')).status).toBe(200);
    for (const user of [bob]) {
        expect((await user('/inference')).status).toBe(403);
        expect((await user('/inference/backends', 'POST', backend)).status).toBe(403);
        expect((await user('/inference/settings', 'PUT', { allowedByoKinds: [] })).status).toBe(403);
    }
    const state = (await (await olga('/inference')).json()) as OperatorInferenceState;
    expect(state.backends).toHaveLength(1);
    const [seeded] = state.backends;
    expect(seeded).toMatchObject({ isDefault: true, hasApiKey: true });
    expect(JSON.stringify(state)).not.toContain('local-key');
    expect(state.byoKinds).toEqual([expect.objectContaining({ id: FAKE_BYO_KIND, allowed: false })]);
    // Add, test, make default, disable, delete.
    const response = await olga('/inference/backends', 'POST', backend);
    expect(response.status).toBe(201);
    const added = (await response.json()) as InferenceBackendView;
    expect(added).toMatchObject({ label: 'Homelab', isDefault: false });
    expect(JSON.stringify(added)).not.toContain(backend.apiKey);
    const tested = (await (await olga(`/inference/backends/${added.id}/test`, 'POST')).json()) as InferenceBackendView;
    expect(tested.lastTest).toMatchObject({
        ok: false,
        detail: 'Reachable, but qwen is not among its 1 models.',
    });
    expect(probes).toEqual([`http://orion.invalid:8016/v1/models Bearer ${backend.apiKey}`]);
    const retested = (await (
        await olga(`/inference/backends/${seeded.id}/test`, 'POST')
    ).json()) as InferenceBackendView;
    expect(retested.lastTest).toMatchObject({
        ok: true,
        detail: 'Reachable; custom-model is listed.',
    });
    // Editing without a key keeps it.
    const edited = (await (
        await olga(`/inference/backends/${added.id}`, 'PUT', {
            ...backend,
            apiKey: '',
            label: 'Homelab 2',
        })
    ).json()) as InferenceBackendView;
    expect(edited).toMatchObject({ label: 'Homelab 2', hasApiKey: true });
    expect(
        (
            await olga('/inference/backends/x', 'PUT', {
                ...backend,
                baseUrl: 'file:///etc',
            })
        ).status,
    ).toBe(400);
    const switched = (await (
        await olga('/inference/settings', 'PUT', {
            defaultBackendId: added.id,
            allowedByoKinds: [FAKE_BYO_KIND],
        })
    ).json()) as OperatorInferenceState;
    expect(switched.defaultBackendId).toBe(added.id);
    expect(switched.byoKinds[0].allowed).toBe(true);
    expect((await olga('/inference/settings', 'PUT', { allowedByoKinds: ['nope'] })).status).toBe(400);
    expect((await bob(`/inference/backends/${added.id}`, 'DELETE')).status).toBe(403);
    expect((await olga(`/inference/backends/${added.id}`, 'DELETE')).status).toBe(200);
    // The backend goes (settings with a secret); the audit says which (CB-64).
    expect(platform.workspace.auditOf('inference_backend', added.id)).toMatchObject([
        { actor: 'olga', action: 'remove', detail: `Homelab 2 (${added.kind})` },
    ]);
    expect(JSON.stringify(platform.workspace.auditOf('inference_backend', added.id))).not.toContain(backend.apiKey);
    expect(((await (await olga('/inference')).json()) as OperatorInferenceState).defaultBackendId).toBeNull();
});

it('lets every user connect and disconnect allowed kinds', async () => {
    const { platform, as } = await appFixture();
    const bob = await as('bob');
    const olga = await as('olga');
    const state = async () => (await (await bob('/me/inference')).json()) as UserInferenceState;
    expect(await state()).toEqual({
        kinds: [],
        active: { source: 'shared', label: 'Self-hosted (custom-model)' },
    });
    expect((await bob(`/me/inference/${FAKE_BYO_KIND}/connect`, 'POST', {})).status).toBe(404);
    await olga('/inference/settings', 'PUT', {
        allowedByoKinds: [FAKE_BYO_KIND],
    });
    expect((await state()).kinds).toEqual([expect.objectContaining({ id: FAKE_BYO_KIND, state: 'disconnected' })]);
    const step = await bob(`/me/inference/${FAKE_BYO_KIND}/connect`, 'POST', {});
    expect(await step.json()).toMatchObject({ state: 'pending' });
    await bob(`/me/inference/${FAKE_BYO_KIND}/connect`, 'POST', {});
    const connected = await state();
    expect(connected.active).toEqual({
        source: 'byo',
        label: 'Fake subscription',
    });
    expect(JSON.stringify(connected)).not.toMatch(/token/i);
    // The workspace setup says so too, for bob only.
    const workspace = await (await bob('/workspace')).json();
    expect(workspace.setup.inference).toMatchObject({ source: 'byo' });
    expect((await platform.setup('alice')).inference).toMatchObject({
        source: 'shared',
    });
    expect((await bob(`/me/inference/${FAKE_BYO_KIND}`, 'DELETE')).status).toBe(200);
    expect((await bob(`/me/inference/${FAKE_BYO_KIND}`, 'DELETE')).status).toBe(404);
    expect((await state()).active?.source).toBe('shared');
});

it('answers Telegram turns on the linked user’s model, or says how to get one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bot = await fakeTelegram();
    const { workspace, inference } = service();
    const store = new Store(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const channel = new TelegramChannel({
        settings: {
            token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012',
            allowedChatIds: [],
        },
        runner,
        store,
        workspace,
        ...telegramServices({ store, workspace, config: MODEL_CONFIG, runner, inference }),
        isUser: (id) => ['alice', 'bob'].includes(id),
        apiRoot: bot.apiRoot,
    });
    cleanup.push(
        () => bot.close(),
        () => {
            runner.close();
            store.close();
        },
        () => channel.stop(),
    );
    await channel.start();
    for (const [userId, telegramId] of [
        ['alice', 42],
        ['bob', 43],
    ] as const) {
        await workspace.telegram.redeem((await workspace.telegram.createCode(userId)).code, String(telegramId));
    }
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    await connectFake(inference, 'bob');
    const passthrough = globalThis.fetch.bind(globalThis);
    const models: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
        if (!String(url).startsWith(BYO_URL)) {
            return passthrough(url, init);
        }
        models.push(String(url));
        return Promise.resolve(completion({ role: 'assistant', content: 'Hello from your plan' }));
    });
    const texts = () =>
        bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => String(c.body.text));
    // Bob (connected) gets an answer from his subscription.
    bot.message({
        text: 'hi',
        chat: { id: 43, type: 'private' },
        from: { id: 43 },
    });
    await expect.poll(() => texts().some((t) => t.includes('Hello from your plan'))).toBe(true);
    expect(models).toEqual([`${BYO_URL}/chat/completions`]);
    // Alice (not connected, no shared backend) is told how to connect.
    bot.message({
        text: 'hi',
        chat: { id: 42, type: 'private' },
        from: { id: 42 },
    });
    await expect.poll(() => texts().includes(NO_INFERENCE_MESSAGES.connect)).toBe(true);
    expect(models).toHaveLength(1);
});
