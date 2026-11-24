import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { gatewayStampKey, signGatewayStamp } from '@socio/foundation/actors/keys';
import { personalModelId } from '@socio/shared/coding/coding-gateway';

import { modelGateway } from '../src/server/gateway/model.js';
import { personalPlansDefault } from '../src/server/gateway/options.js';
import { CHATGPT_KIND, chatGptKind } from '../src/server/inference/chatgpt-kind.js';
import { CHATGPT_DEFAULT_MODEL } from '../src/server/inference/chatgpt/index.js';
import { resetRefreshState } from '../src/server/inference/chatgpt/refresh.js';

import { FAKE_ACCOUNT, startFakeChatGpt, textReply } from './fixtures/fake-chatgpt.js';
import type { TestPlatform } from './helpers/test-platform.js';
import { EGRESS_SECRET as CODING_EGRESS_SECRET, REPO, codingWorld, eventually } from './support/coding-fixture.js';
import { gatewaySetup } from './support/gateway-fixture.js';
import { sseEvents } from './support/model-fakes.js';

// CB-239: a person's own ChatGPT plan as the backend of their own coding
// sessions. Off by default; only where an admin turns it on; only the
// person's own session in their private chat (never a room or anyone else's);
// the gateway holds the plan's token and the sandbox only its `cbgw_`. A
// loopback fake of ChatGPT's auth server and Codex backend. Negative cases
// first.

const PLAN_MODEL = personalModelId(CHATGPT_KIND);
const realFetch = globalThis.fetch.bind(globalThis);
type Fake = Awaited<ReturnType<typeof startFakeChatGpt>>;
let fake: Fake;
const cleanup: Array<() => unknown> = [];
beforeEach(async () => {
    resetRefreshState();
    fake = await startFakeChatGpt();
});
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    await fake.close();
});

/** The ChatGPT kind on the fake, allowed by the operator. */
async function withPlans(platform: TestPlatform) {
    platform.inference.register(chatGptKind({ endpoints: fake.endpoints, fetch: realFetch }));
    await platform.inference.updateSettings({ allowedByoKinds: [CHATGPT_KIND] });
}

/** A person's ChatGPT connection, as a finished sign-in leaves it. */
async function connect(platform: TestPlatform, personId: string) {
    const tokens = fake.issue();
    await platform.inference.store.saveConnection(
        personId,
        CHATGPT_KIND,
        {
            version: 1,
            credentials: {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                idToken: tokens.id_token,
                accountId: FAKE_ACCOUNT,
                planType: 'plus',
                expiresAt: Date.now() + 3_600_000,
            },
        },
        { plan: 'plus' },
    );
    return tokens.access_token;
}

const codexRequests = () => fake.requests.filter((r) => r.path === '/backend-api/codex/responses');

async function gatewayWorld() {
    const f = await gatewaySetup();
    cleanup.push(() => f.close());
    await withPlans(f.platform);
    // Lists the repository, as a coding grant needs.
    await f.session();
    /** A plan session's grant and prompt credential (the coding sessions' part). */
    const planSession = async (personId = 'alice', kind: 'private' | 'room' = 'private') => {
        const conversationId = f.workspace.bindThread(
            `plan-${personId}-${kind}-${Math.random()}`,
            f.socio.id,
            'Coding',
            personId,
        ).id;
        const grant = await f.platform.actors.grants.create({
            personId,
            socioId: f.socio.id,
            audiences: ['gateway:model', 'gateway:git'],
            scopes: ['model:invoke', 'git:read'],
            resources: {
                session: `plan-session-${personId}-${kind}`,
                repository: 'erden-sh/socio',
                model: PLAN_MODEL,
                plan: CHATGPT_KIND,
            },
            conversationId,
            conversationKind: kind,
            task: 'Fix the flaky test',
            approvedBy: personId,
            correlationId: 'corr-grant',
        });
        const context = await f.platform.actors.contexts.open({
            grant,
            kind: 'sandbox',
            audience: 'gateway:model',
            correlationId: 'corr-context',
        });
        const issued = await f.platform.actors.credentials.issue({
            grant,
            kind: 'cbgw',
            audiences: grant.audiences,
            contextId: context.id,
            holder: { kind: 'prompt-run', id: `run-${context.id}` },
            correlationId: 'corr-credential',
        });
        return { grant, sandboxId: context.id, token: issued.token };
    };
    const responses = (s: { token: string; sandboxId: string }, body: Record<string, unknown> = {}) =>
        f.call('/v1/responses', {
            token: s.token,
            sandboxId: s.sandboxId,
            body: {
                model: PLAN_MODEL,
                instructions: 'You are a coding agent.',
                input: [{ role: 'user', content: 'Fix the test.' }],
                stream: true,
                ...body,
            },
        });
    return { ...f, planSession, responses };
}

const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string } }).error;

it('reads CODING_PERSONAL_PLANS as off unless it says on, and stops on a mistake', () => {
    for (const value of [undefined, '', 'off', 'false', '0', 'no']) {
        expect(personalPlansDefault({ CODING_PERSONAL_PLANS: value })).toBe(false);
    }
    for (const value of ['on', 'true', '1', 'yes', 'ON']) {
        expect(personalPlansDefault({ CODING_PERSONAL_PLANS: value })).toBe(true);
    }
    expect(() => personalPlansDefault({ CODING_PERSONAL_PLANS: 'sometimes' })).toThrow(/CODING_PERSONAL_PLANS/);
});

it('is off by default: a plan session’s requests go nowhere', async () => {
    const f = await gatewayWorld();
    await connect(f.platform, 'alice');
    expect(f.gateway.options.view()).toEqual({
        personalPlans: false,
        personalPlansDefault: false,
        personalPlansSaved: false,
    });
    const s = await f.planSession();
    const response = await f.responses(s);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('model_not_found');
    expect(codexRequests()).toHaveLength(0);
});

it('serves the person’s own session (private or room) on their own connected plan', async () => {
    const f = await gatewayWorld();
    await f.gateway.options.save({ personalPlans: true }, 'olga');
    await connect(f.platform, 'alice');
    // A room's session is allowed on a personal plan too (per-user providers:
    // the "private chat only" limit is lifted).
    const room = await f.planSession('alice', 'room');
    const policy = f.gateway.policy();
    expect(
        await policy.resourceAllowed!({
            grant: room.grant,
            audience: 'gateway:model',
            resource: { kind: 'model', id: PLAN_MODEL },
        }),
    ).toBe(true);
    const mine = await f.planSession('alice');
    expect(
        await policy.resourceAllowed!({
            grant: mine.grant,
            audience: 'gateway:model',
            resource: { kind: 'model', id: PLAN_MODEL },
        }),
    ).toBe(true);
    // Olga's session: she has no plan connected, and Alice's never serves her.
    const olga = await f.planSession('olga');
    expect((await f.responses(olga)).status).toBe(404);
    // The operator stops allowing the kind: Alice's own session stops too.
    const own = await f.planSession('alice');
    await f.platform.inference.updateSettings({ allowedByoKinds: [] });
    expect((await f.responses(own)).status).toBe(404);
    expect(codexRequests()).toHaveLength(0);
});

it('runs a session on the person’s plan: their token stays in the gateway, the sandbox has its cbgw_', async () => {
    const f = await gatewayWorld();
    await f.gateway.options.save({ personalPlans: true }, 'olga');
    const access = await connect(f.platform, 'alice');
    const s = await f.planSession();
    // Only the Responses API, and only streamed.
    const chat = await f.call('/v1/chat/completions', {
        token: s.token,
        sandboxId: s.sandboxId,
        body: { model: PLAN_MODEL, messages: [{ role: 'user', content: 'x' }] },
    });
    expect(chat.status).toBe(400);
    expect((await errorOf(chat)).code).toBe('unsupported_endpoint');
    // Nor Messages (Claude Code's, CB-326), in Anthropic's error shape.
    const messages = await f.call('/v1/messages', {
        token: s.token,
        sandboxId: s.sandboxId,
        body: { model: PLAN_MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'x' }], stream: true },
    });
    expect(messages.status).toBe(400);
    expect(await messages.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    // Nor the Gemini API (Gemini CLI's, CB-326), in its own error shape.
    const gemini = await f.call(`/v1beta/models/${PLAN_MODEL}:streamGenerateContent?alt=sse`, {
        sandboxId: s.sandboxId,
        body: { contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
        headers: { 'x-goog-api-key': s.token },
    });
    expect(gemini.status).toBe(400);
    expect(await gemini.json()).toMatchObject({ error: { code: 400, status: 'INVALID_ARGUMENT' } });
    const unstreamed = await f.responses(s, { stream: false });
    expect(unstreamed.status).toBe(400);
    expect((await errorOf(unstreamed)).code).toBe('stream_required');
    expect(codexRequests()).toHaveLength(0);

    const models = (await (await f.call('/v1/models', { token: s.token, sandboxId: s.sandboxId })).json()) as {
        data: { id: string }[];
    };
    expect(models.data.map((model) => model.id)).toEqual([PLAN_MODEL]);

    fake.state.replies.push(textReply('Fixed it on your plan.'));
    const response = await f.responses(s, {
        temperature: 0.2,
        max_output_tokens: 500,
        user: 'alice',
    });
    expect(response.status).toBe(200);
    const text = (await sseEvents(response))
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => event.delta)
        .join('');
    expect(text).toBe('Fixed it on your plan.');
    const [sent] = codexRequests();
    expect(sent!.headers.authorization).toBe(`Bearer ${access}`);
    expect(sent!.headers['chatgpt-account-id']).toBe(FAKE_ACCOUNT);
    expect(sent!.headers['x-cb-sandbox']).toBeUndefined();
    expect(JSON.stringify(sent!.headers)).not.toContain(s.token);
    const body = JSON.parse(sent!.body) as Record<string, unknown>;
    expect(body.model).toBe(CHATGPT_DEFAULT_MODEL);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    for (const field of ['max_output_tokens', 'temperature', 'user']) {
        expect(body).not.toHaveProperty(field);
    }
    // Metered like any session: 42 in, 7 out, on the plan's kind.
    const ledger = modelGateway(f.platform).ledger;
    await expect
        .poll(() => ledger.session(s.grant.resources!.session as string, f.gateway.settings.limits()).used)
        .toBe(49);
    expect(ledger.summary().models.map((row) => row.id)).toContain(PLAN_MODEL);
    // Turning personal plans off ends it.
    await f.gateway.options.save({ personalPlans: false }, 'olga');
    expect((await f.responses(s)).status).toBe(404);
    // Every change is audited, with its old and new values.
    const settings = f.platform.actors.audit.list({}, 200).filter((row) => row.action === 'coding.personalPlans');
    expect(settings.map((row) => JSON.parse(row.detail!).new)).toEqual(expect.arrayContaining([true, false]));
});

it('says when the plan’s usage limit is reached, and never passes ChatGPT’s text', async () => {
    const f = await gatewayWorld();
    await f.gateway.options.save({ personalPlans: true }, 'olga');
    await connect(f.platform, 'alice');
    const s = await f.planSession();
    fake.state.replies.push({
        status: 429,
        body: { error: { message: 'Plan of Fake Person is out of usage' } },
    });
    const response = await f.responses(s);
    expect(response.status).toBe(429);
    const text = await response.text();
    expect(text).toContain('upstream_busy');
    expect(text).not.toContain('Fake Person');
});

it('refuses the admin’s mistakes and lets only `personal-` names mean plans', async () => {
    const f = await gatewayWorld();
    await expect(f.gateway.options.save({ personalPlans: 'yes' }, 'olga')).rejects.toThrow(/true, false or null/);
    await expect(f.gateway.options.save({ other: true }, 'olga')).rejects.toThrow(/Unknown setting/);
    await expect(
        f.gateway.settings.saveModel(
            PLAN_MODEL,
            {
                label: 'Sneaky',
                backendId: f.backend.id,
                upstreamModel: 'x',
                maxOutputTokens: 100,
            },
            'olga',
        ),
    ).rejects.toThrow(/own plans/);
});

// The coding_start side (the coding sessions' tools), with the fake supervisor.

async function startWorld() {
    const world = await codingWorld();
    cleanup.push(() => world.close());
    await withPlans(world.platform);
    return world;
}

it('coding_start: refuses a personal plan while off or unconnected; allows it in a room', async () => {
    const world = await startWorld();
    const start = (turn = world.turnOf()) =>
        world.tool(
            'coding_start',
            turn,
        )({
            repository: REPO,
            task: 'Fix it',
            model: 'byo:byo-chatgpt',
        });
    expect(await start()).toMatchObject({
        status: 'refused',
        error: expect.stringContaining('Personal plans aren’t allowed'),
    });
    await modelGateway(world.platform).options.save({ personalPlans: true }, 'olga');
    expect(await start()).toMatchObject({
        status: 'refused',
        error: expect.stringContaining('connect it under Account'),
    });
    await connect(world.platform, 'alice');
    // The "private chat only" limit is lifted (per-user providers): a byo
    // choice is allowed in a room too, no longer refused.
    const roomId = world.chatOf('alice', 'Sales room');
    const thread = world.workspace.slices.conversations.thread.bind(world.workspace.slices.conversations);
    vi.spyOn(world.workspace.slices.conversations, 'thread').mockImplementation((id: string) => {
        const found = thread(id);
        return found && id === roomId ? { ...found, kind: 'room', title: 'Sales room' } : found;
    });
    expect(await start(world.turnOf('alice', { threadId: roomId }))).toMatchObject({
        status: 'pending_approval',
    });
});

it('coding_start: the card says the session runs on the person’s plan, and the agent reaches it only through the gateway', async () => {
    const world = await startWorld();
    await modelGateway(world.platform).options.save({ personalPlans: true }, 'olga');
    const access = await connect(world.platform, 'alice');
    const asked = await world.tool('coding_start')({
        repository: REPO,
        task: 'Fix the flaky test',
        model: 'byo:byo-chatgpt',
    });
    expect(asked).toMatchObject({ status: 'pending_approval' });
    const approval = (asked.approval as { id: string }).id;
    const view = await world.platform.approvals.get(approval, 'alice');
    expect(view.card).toMatchObject({
        kind: 'coding_session',
        plan: { label: 'ChatGPT' },
        model: { outsideProvider: true },
    });
    expect(view.details?.join(' ')).toContain('your own ChatGPT');
    // The prompt run's model call, as the sandbox's agent makes it.
    const stampKey = gatewayStampKey(CODING_EGRESS_SECRET);
    let answered: Response | undefined;
    world.supervisor.behavior.onPrompt = (exec, token) => {
        void (async () => {
            const path = '/v1/responses';
            answered = await fetch(`http://127.0.0.1:${world.gateway.port}${path}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${token}`,
                    'x-cb-sandbox': signGatewayStamp(stampKey, exec.sessionId, 'POST', path),
                },
                body: JSON.stringify({
                    model: exec.params.model,
                    input: 'Fix the test.',
                    stream: true,
                }),
            });
            await answered.text();
            world.supervisor.finish(exec.runId);
        })();
    };
    await world.platform.approvals.decide(approval, 'alice', true);
    const session = world.service.sessions.ofPerson('alice', 5).find((item) => item.approvalId === approval)!;
    expect(session.plan).toBe(CHATGPT_KIND);
    expect(session.model).toBe(PLAN_MODEL);
    await eventually(() => world.service.sessions.get(session.id)!.state === 'ready');
    fake.state.replies.push(textReply('Done on your plan.'));
    await world.tool('coding_prompt')({ message: 'Fix the test.' });
    await eventually(() => answered !== undefined);
    expect(answered!.status).toBe(200);
    // The prompt went to the Responses provider; the token never left Socio.
    const prompt = [...world.supervisor.execs.values()].find((exec) => exec.kind === 'prompt')!;
    expect(prompt.params).toMatchObject({ model: PLAN_MODEL, api: 'responses' });
    expect(JSON.stringify([...world.supervisor.execs.values()])).not.toContain(access);
    expect(codexRequests()[0]!.headers.authorization).toBe(`Bearer ${access}`);
    // Personal plans turned off: the leader's tick ends the session.
    await modelGateway(world.platform).options.save({ personalPlans: false }, 'olga');
    await world.service.tick();
    expect(world.service.sessions.get(session.id)!.state).toBe('ended');
    expect(world.service.sessions.get(session.id)!.endReason).toBe('revoked');
});
