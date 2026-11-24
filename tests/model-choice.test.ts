import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { NO_INFERENCE_MESSAGES, type ModelChoice, type ModelOptions } from '@socio/shared/inference';
import type { Conversation, Dot, User, WorkspaceState } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import type { ByoKind, InferenceRequest } from '../src/server/inference/contract.js';
import { FAKE_BYO_KIND, fakeByoKind } from '../src/server/inference/fake-byo.js';
import { openAICompatibleModel } from '../src/server/inference/openai-compatible.js';
import { InferenceService } from '../src/server/inference/service.js';

import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'model-choice-test-secret-0123456789';
const MULTI = 'byo-multi';
const MULTI_URL = 'https://multi.invalid/v1';
const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const MODEL_CONFIG: PlatformConfig = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    sessionSecret: SECRET,
};
const orion = {
    label: 'Homelab',
    baseUrl: 'http://orion.invalid/v1',
    model: 'qwen',
};
const lab = { label: 'Lab', baseUrl: 'http://lab.invalid/v1', model: 'big' };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

/** A bring-your-own kind with two models; its model id is the one asked for. */
function multiKind(): ByoKind {
    const base = fakeByoKind({ baseUrl: MULTI_URL });
    return {
        ...base,
        id: MULTI,
        label: 'Multi',
        models: {
            choices: [
                { id: 'small', label: 'Small' },
                { id: 'large', label: 'Large' },
            ],
            default: 'small',
        },
        adapterFor: (connection, _access, settings) => {
            const { token } = connection.credentials as { token?: string };
            return token
                ? openAICompatibleModel({
                      source: { type: 'byo', kind: MULTI },
                      label: 'Multi',
                      baseUrl: MULTI_URL,
                      model: settings.model ?? 'small',
                      apiKey: token,
                      capabilities: { acceptsImages: false },
                  })
                : undefined;
        },
    };
}

async function connect(inference: InferenceService, userId: string, kind: string) {
    await inference.connect(userId, kind, {});
    expect(await inference.connect(userId, kind, {})).toEqual({
        state: 'connected',
    });
}

async function service() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const inference = new InferenceService(workspace.db, {
        secret: SECRET,
        log: () => {},
    });
    inference.register(fakeByoKind({ baseUrl: 'https://fake.invalid/v1' }));
    inference.register(multiKind());
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND, MULTI] });
    const a = await inference.createBackend(orion);
    const b = await inference.createBackend(lab);
    return { workspace, inference, a, b };
}

/** Where a request ends up: the backend's label, the kind and model, or why not. */
async function where(inference: InferenceService, request: InferenceRequest) {
    const resolution = await inference.resolve(request);
    if (!resolution.ok) {
        return resolution.reason;
    }
    const { model } = resolution;
    return model.source.type === 'shared' ? model.label : `${model.source.kind}:${model.model}`;
}

it('runs a turn on its chosen model; a Dot default gives way, a chat’s own choice does not', async () => {
    const { inference, b } = await service();
    const onLab: ModelChoice = { source: 'shared', backendId: b.id };
    const large: ModelChoice = { source: 'byo', kind: MULTI, model: 'large' };
    const chat = { userId: 'bob', purpose: 'chat' } as const;
    // No choice: the default backend (bob has no connection yet).
    expect(await where(inference, chat)).toBe('Homelab');
    // A shared backend, for the user's own turns; workspace work ignores it.
    expect(await where(inference, { ...chat, choice: onLab })).toBe('Lab');
    expect(await where(inference, { ...chat, purpose: 'scheduled', choice: onLab })).toBe('Lab');
    expect(
        await where(inference, {
            userId: 'bob',
            purpose: 'title',
            choice: onLab,
        }),
    ).toBe('Homelab');
    // A subscription model the user isn't connected to: a Dot's default falls
    // back to the automatic order, a chat's own choice fails.
    expect(await where(inference, { ...chat, choice: large })).toBe('Homelab');
    expect(await where(inference, { ...chat, choice: large, strict: true })).toBe('choice_unavailable');
    // Connected: that model, not the operator's default for the kind.
    await connect(inference, 'bob', MULTI);
    expect(await where(inference, chat)).toBe('byo-multi:small');
    expect(await where(inference, { ...chat, choice: large, strict: true })).toBe('byo-multi:large');
    // Without a model: the operator's choice for the kind.
    await inference.updateSettings({ byoModels: { [MULTI]: 'large' } });
    expect(await where(inference, { ...chat, choice: { source: 'byo', kind: MULTI } })).toBe('byo-multi:large');
    // A user's connection never serves someone else's turn.
    expect(await where(inference, { userId: 'alice', purpose: 'chat', choice: large })).toBe('Homelab');
    // A disabled backend or a disallowed kind can't serve.
    await inference.updateBackend(b.id, { ...lab, enabled: false });
    expect(await where(inference, { ...chat, choice: onLab, strict: true })).toBe('choice_unavailable');
    expect(await where(inference, { ...chat, choice: onLab })).toBe('byo-multi:large');
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    expect(await where(inference, { ...chat, choice: large, strict: true })).toBe('choice_unavailable');
});

it('lists the models a user can pick and checks choices before they are saved', async () => {
    const { inference, a, b } = await service();
    await connect(inference, 'bob', MULTI);
    const options = await inference.options('bob');
    expect(options.options.map(({ key, group, label, available }) => [key, group, label, available])).toEqual([
        // The default backend first, then the rest by name.
        [`shared:${a.id}`, 'Homelab', 'qwen', true],
        [`shared:${b.id}`, 'Lab', 'big', true],
        [`byo:${FAKE_BYO_KIND}`, 'Fake subscription', 'Fake subscription', false],
        [`byo:${MULTI}:small`, 'Multi', 'Small', true],
        [`byo:${MULTI}:large`, 'Multi', 'Large', true],
    ]);
    expect(options.automatic).toBe('Multi');
    expect(options.options[2].detail).toContain('Account → Inference');
    // Shows no secrets.
    expect(JSON.stringify(options)).not.toMatch(/token|apiKey/i);
    await inference.updateBackend(b.id, { ...lab, enabled: false });
    expect((await inference.options('alice')).options.map((o) => o.group)).toEqual([
        'Homelab',
        'Fake subscription',
        'Multi',
        'Multi',
    ]);
    const problem = (choice: ModelChoice, userId?: string) => inference.choiceProblem(choice, userId);
    expect(await problem({ source: 'shared', backendId: a.id })).toBeUndefined();
    expect(await problem({ source: 'shared', backendId: b.id })).toMatch(/not available/);
    expect(await problem({ source: 'shared', backendId: 'nope' })).toMatch(/not available/);
    expect(await problem({ source: 'byo', kind: 'byo-other' })).toMatch(/not allowed/);
    expect(await problem({ source: 'byo', kind: MULTI, model: 'huge' })).toMatch(/no model "huge"/);
    // A Dot's default may name a subscription; a chat's needs a connection.
    expect(await problem({ source: 'byo', kind: MULTI, model: 'large' })).toBe(undefined);
    expect(await problem({ source: 'byo', kind: MULTI, model: 'large' }, 'alice')).toMatch(/Connect Multi/);
    expect(await problem({ source: 'byo', kind: MULTI, model: 'large' }, 'bob')).toBeUndefined();
});

async function turn(agent: DotAgent, threadId: string) {
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

it('runs a Dot’s turns on its default model unless the conversation picked another', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { workspace, inference, b } = await service();
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
        ...dot,
        inference: { source: 'shared', backendId: b.id },
    });
    expect(workspace.dot(dot.id)?.inference).toEqual({
        source: 'shared',
        backendId: b.id,
    });
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        urls.push(String(url));
        return completion({ role: 'assistant', content: 'Hi.' });
    });
    const agent = () =>
        new DotAgent(store, workspace, MODEL_CONFIG, dot.id, false, undefined, {
            inference,
        });
    workspace.bindThread('t-default', dot.id, 'Hi', 'bob');
    workspace.bindThread('t-own', dot.id, 'Hi', 'bob', {
        source: 'byo',
        kind: MULTI,
        model: 'large',
    });
    const events = await turn(agent(), 't-default');
    expect(events.some((e) => e.type === 'RUN_FINISHED')).toBe(true);
    expect(urls).toEqual(['http://lab.invalid/v1/chat/completions']);
    // Its own model, not connected: a clear failure, not another model.
    expect((await turn(agent(), 't-own')).find((e) => e.type === 'RUN_ERROR')).toEqual({
        type: 'RUN_ERROR',
        message: NO_INFERENCE_MESSAGES.choice,
        code: 'no_inference_choice',
        timestamp: expect.any(Number),
    });
    expect(urls).toHaveLength(1);
    // Back to the Dot's default.
    expect(workspace.setThreadInference('t-own', null)?.inference).toBeNull();
    await turn(agent(), 't-own');
    expect(urls).toHaveLength(2);
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
    platform.inference.register(multiKind());
    await platform.inference.updateSettings({ allowedByoKinds: [MULTI] });
    const shared = await platform.inference.createBackend(orion);
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
    return { platform, as, shared };
}

it('lets admins set a Dot’s default model and owners pick a chat’s', async () => {
    const { platform, as, shared } = await appFixture();
    const alice = await as('alice');
    const bob = await as('bob');
    const large: ModelChoice = { source: 'byo', kind: MULTI, model: 'large' };
    const workspace = async (user: typeof bob) => (await (await user('/workspace')).json()) as WorkspaceState;
    const dot = (await workspace(alice)).dots[0];
    const edit = (body: Partial<Dot>) => ({
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        ...body,
    });
    // Every user sees the picker's entries.
    const options = (await (await bob('/me/inference/options')).json()) as ModelOptions;
    expect(options.options.map((option) => option.key)).toEqual([
        `shared:${shared.id}`,
        `byo:${MULTI}:small`,
        `byo:${MULTI}:large`,
    ]);
    // Admins set a Dot's default (a subscription model is fine: each person's own).
    expect((await bob(`/dots/${dot.id}`, 'PUT', edit({ inference: large }))).status).toBe(403);
    expect(
        (await alice(`/dots/${dot.id}`, 'PUT', edit({ inference: { source: 'byo', kind: MULTI, model: 'huge' } })))
            .status,
    ).toBe(400);
    expect((await alice(`/dots/${dot.id}`, 'PUT', edit({ inference: large }))).status).toBe(200);
    expect((await workspace(bob)).dots[0].inference).toEqual(large);
    // Omitted keeps it; null clears it.
    await alice(`/dots/${dot.id}`, 'PUT', edit({}));
    expect(platform.workspace.dot(dot.id)?.inference).toEqual(large);
    await alice(`/dots/${dot.id}`, 'PUT', edit({ inference: null }));
    expect(platform.workspace.dot(dot.id)?.inference).toBeNull();
    // A new chat's own model: one the user can run on now.
    const create = (inference?: ModelChoice) => bob('/conversations', 'POST', { dotId: dot.id, inference });
    const refused = await create(large);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Connect Multi/);
    const created = await create({ source: 'shared', backendId: shared.id });
    expect(created.status).toBe(201);
    const thread = (await created.json()) as Conversation;
    expect(thread.inference).toEqual({ source: 'shared', backendId: shared.id });
    expect((await workspace(bob)).conversations.find((c) => c.id === thread.id)?.inference).toEqual({
        source: 'shared',
        backendId: shared.id,
    });
    expect(((await (await create()).json()) as Conversation).inference).toBeNull();
    // The owner changes it later; nobody else can.
    expect((await alice(`/conversations/${thread.id}`, 'PATCH', { inference: null })).status).toBe(404);
    expect((await bob(`/conversations/${thread.id}`, 'PATCH', { inference: large })).status).toBe(400);
    const reset = await bob(`/conversations/${thread.id}`, 'PATCH', {
        inference: null,
    });
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as Conversation).inference).toBeNull();
});
