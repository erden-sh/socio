import { afterEach, beforeEach, expect, it } from 'vitest';

import { personalModelId } from '@socio/shared/coding/coding-gateway';

import { modelGateway } from '../src/server/gateway/model.js';
import { claudeApiKeyKind, CLAUDE_API_KEY_KIND } from '../src/server/inference/claude-api-key-kind.js';

import { eventually } from './support/coding-fixture.js';
import { gatewaySetup } from './support/gateway-fixture.js';

const REPO = 'erden-sh/socio';
const CLAUDE_MODEL = personalModelId(CLAUDE_API_KEY_KIND);
const ANTHROPIC_KEY = 'sk-ant-test-key-0123456789';

/** A tiny fake Anthropic Messages API: records the request, answers 200. */
async function startFakeAnthropic() {
    const requests: { headers: Record<string, string>; body: string }[] = [];
    const server = (await import('node:http')).createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') {
                    headers[key] = value;
                }
            }
            requests.push({ headers, body });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    id: 'msg_test',
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Done.' }],
                    model: 'claude-sonnet-5-5',
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 10, output_tokens: 5 },
                }),
            );
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
        port,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

const cleanup: Array<() => Promise<void>> = [];
let anthropic: Awaited<ReturnType<typeof startFakeAnthropic>>;

beforeEach(async () => {
    anthropic = await startFakeAnthropic();
    cleanup.push(() => anthropic.close());
});
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function gatewayWorld() {
    const f = await gatewaySetup();
    cleanup.push(() => f.close());
    // Register the Claude API-key kind pointed at the fake, and allow it.
    f.platform.inference.register(
        claudeApiKeyKind({
            fetch: ((url: string | URL | Request, init?: RequestInit) =>
                fetch(`http://127.0.0.1:${anthropic.port}${new URL(url.toString()).pathname}`, init)) as typeof fetch,
        }),
    );
    await f.platform.inference.updateSettings({ allowedByoKinds: [CLAUDE_API_KEY_KIND] });
    await f.session();
    /** A Claude-key session's grant and prompt credential. */
    const keySession = async (personId = 'alice', kind: 'private' | 'room' = 'private') => {
        const conversationId = f.workspace.bindThread(
            `claude-${personId}-${kind}-${Math.random()}`,
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
                session: `claude-session-${personId}-${kind}`,
                repository: REPO,
                model: CLAUDE_MODEL,
                plan: CLAUDE_API_KEY_KIND,
            },
            conversationId,
            conversationKind: kind,
            task: 'Fix it',
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
    return { ...f, keySession };
}

/** A person's Claude API-key connection, as "connect" leaves it. */
async function connectKey(platform: { inference: { store: { saveConnection: unknown } } }, personId: string) {
    await (
        platform.inference.store as unknown as {
            saveConnection: (userId: string, kind: string, credentials: unknown, meta?: unknown) => Promise<unknown>;
        }
    ).saveConnection(personId, CLAUDE_API_KEY_KIND, { apiKey: ANTHROPIC_KEY }, { plan: 'Claude API key' });
}

it('forwards a coding session’s Messages request to Anthropic with the person’s x-api-key', async () => {
    const f = await gatewayWorld();
    await modelGateway(f.platform).options.save({ personalPlans: true }, 'olga');
    await connectKey(f.platform, 'alice');
    const s = await f.keySession();
    // A Messages request (Claude Code's shape) forwards to the fake Anthropic.
    const response = await f.call('/v1/messages', {
        token: s.token,
        sandboxId: s.sandboxId,
        body: {
            model: CLAUDE_MODEL,
            max_tokens: 100,
            messages: [{ role: 'user', content: 'Fix the test.' }],
            stream: false,
        },
    });
    expect(response.status).toBe(200);
    await eventually(() => anthropic.requests.length === 1);
    expect(anthropic.requests[0]!.headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(anthropic.requests[0]!.headers['anthropic-version']).toBe('2023-06-01');
    // The body reached Anthropic with the transport's model.
    const sent = JSON.parse(anthropic.requests[0]!.body);
    expect(sent.model).toBe('claude-sonnet-5-5');
});

it('refuses a Responses request on a Claude API key (the kind speaks Messages only)', async () => {
    const f = await gatewayWorld();
    await modelGateway(f.platform).options.save({ personalPlans: true }, 'olga');
    await connectKey(f.platform, 'alice');
    const s = await f.keySession();
    const response = await f.call('/v1/responses', {
        token: s.token,
        sandboxId: s.sandboxId,
        body: {
            model: CLAUDE_MODEL,
            input: [{ role: 'user', content: 'Fix the test.' }],
            stream: true,
        },
    });
    expect(response.status).toBe(400);
    const error = (await response.json()) as { error: { code: string; message: string } };
    expect(error.error.code).toBe('unsupported_endpoint');
    expect(error.error.message).toContain('Claude API key');
    expect(anthropic.requests).toHaveLength(0);
});

it('allows a Claude API key session in a room (private-chat-only lifted)', async () => {
    const f = await gatewayWorld();
    await modelGateway(f.platform).options.save({ personalPlans: true }, 'olga');
    await connectKey(f.platform, 'alice');
    const room = await f.keySession('alice', 'room');
    const policy = f.gateway.policy();
    expect(
        await policy.resourceAllowed!({
            grant: room.grant,
            audience: 'gateway:model',
            resource: { kind: 'model', id: CLAUDE_MODEL },
        }),
    ).toBe(true);
});
