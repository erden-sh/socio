import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { gatewayStampKey, signGatewayStamp } from '@socio/foundation/actors/keys';
import type { ActorScope, Audience } from '@socio/shared/actor-scopes';
import { validCodingRepository } from '@socio/shared/coding/coding-repos';

import { gatewaySourcesOf } from '../../src/server/gateway/adopted.js';
import { gitGateway } from '../../src/server/gateway/git.js';
import { modelGateway } from '../../src/server/gateway/model.js';
import { createGatewayServer } from '../../src/server/gateway/server.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

/**
 * The model gateway (CB-239) on a real platform, with a loopback fake
 * of an OpenAI-compatible backend: nothing leaves the machine. The fake
 * records what reached it (method, path, headers, body) so tests can say
 * what never did.
 */

export const EGRESS_SECRET = 'gateway-test-egress-secret-0123456789';
export const UPSTREAM_KEY = 'sk-upstream-operator-key-0123456789';

export interface Seen {
    path: string;
    headers: IncomingMessage['headers'];
    body: Record<string, unknown>;
    closed: boolean;
}

/** How the fake answers the next requests. */
export interface FakeMode {
    /** Stream chunks of this text, then usage (unless `noUsage`). */
    text: string;
    noUsage?: boolean;
    /** Answer this status with this body instead. */
    status?: number;
    errorBody?: string;
    /** Wait this long before answering (ms). */
    delayMs?: number;
    /** Answer only once this settles: a test holds requests open until it is ready. */
    gate?: Promise<unknown>;
    /** Never stop streaming (ignores any limit). */
    endless?: boolean;
    /** Send headers, then nothing (a hung stream). */
    hang?: boolean;
}

export async function fakeUpstream() {
    const seen: Seen[] = [];
    const mode: FakeMode = { text: 'Hello from the fake.' };
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const entry: Seen = {
                path: req.url ?? '',
                headers: req.headers,
                body: chunks.length
                    ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
                    : {},
                closed: false,
            };
            seen.push(entry);
            res.on('close', () => {
                if (!res.writableFinished) {
                    entry.closed = true;
                }
            });
            const answer = () => {
                if (mode.status) {
                    res.writeHead(mode.status, { 'content-type': 'application/json' });
                    res.end(mode.errorBody ?? '{"error":{"message":"nope"}}');
                    return;
                }
                const usage = {
                    prompt_tokens: 120,
                    completion_tokens: 7,
                    total_tokens: 127,
                    prompt_tokens_details: { cached_tokens: 100 },
                };
                if (!entry.body.stream) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            id: 'c1',
                            object: 'chat.completion',
                            choices: [
                                {
                                    index: 0,
                                    message: { role: 'assistant', content: mode.text },
                                    finish_reason: 'stop',
                                },
                            ],
                            ...(mode.noUsage ? {} : { usage }),
                        }),
                    );
                    return;
                }
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const chunk = (delta: unknown, extra: object = {}) =>
                    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }], ...extra })}\n\n`;
                if (mode.hang) {
                    res.write(chunk({ role: 'assistant', content: '' }));
                    return;
                }
                if (mode.endless) {
                    const timer = setInterval(() => {
                        if (res.destroyed) {
                            return clearInterval(timer);
                        }
                        res.write(chunk({ content: 'x'.repeat(400) }));
                    }, 2);
                    res.on('close', () => clearInterval(timer));
                    return;
                }
                for (const word of mode.text.split(' ')) {
                    res.write(chunk({ content: `${word} ` }));
                }
                if (!mode.noUsage) {
                    res.write(
                        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage })}\n\n`,
                    );
                }
                res.end('data: [DONE]\n\n');
            };
            if (mode.gate) {
                void mode.gate.then(answer, answer);
            } else if (mode.delayMs) {
                setTimeout(answer, mode.delayMs);
            } else {
                answer();
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        seen,
        mode,
        url: `http://127.0.0.1:${port}/v1`,
        reset(next: Partial<FakeMode> = {}) {
            for (const key of Object.keys(mode)) {
                delete (mode as never)[key];
            }
            Object.assign(mode, { text: 'Hello from the fake.' }, next);
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

export interface GatewaySetupOptions {
    flags?: Record<string, boolean>;
    codeUsers?: string[];
    subnet?: string;
}

export async function gatewaySetup(options: GatewaySetupOptions = {}) {
    const cleanup: Array<() => unknown> = [];
    const { platform, store, workspace, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            sessionSecret: 'gateway-platform-secret-0123456789ab',
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: options.flags ?? {
                'socio-actor-access': true,
                'coding-sessions': true,
            },
        },
        // Who may run code (CB-376): the people the `code:run` permission covers.
        codeRunners: options.codeUsers ?? ['alice', 'olga'],
    });
    // These tests drive the gateways with stand-in prompt runs (no
    // `coding_runs` rows), so instead of the coding sessions' check their
    // runs are live while their credential row exists.
    platform.actors.credentials.holders.override('prompt-run', () => true);
    cleanup.push(dispose);
    for (const user of [
        { id: 'alice', name: 'Alice', role: 'member' as const },
        { id: 'bob', name: 'Bob', role: 'member' as const },
        { id: 'olga', name: 'Olga', role: 'admin' as const },
    ]) {
        workspace.recordUser(user);
    }
    const socio = workspace.dots()[0]!;
    const upstream = await fakeUpstream();
    cleanup.push(() => upstream.close());
    const backend = await platform.inference.createBackend({
        label: 'Homelab',
        baseUrl: upstream.url,
        model: 'qwen38',
        apiKey: UPSTREAM_KEY,
    });
    const gateway = modelGateway(platform);
    await gateway.settings.saveModel(
        'orion',
        {
            label: 'Homelab (qwen38)',
            backendId: backend.id,
            upstreamModel: 'qwen38-coder',
            maxOutputTokens: 4000,
        },
        'olga',
    );
    const server = createGatewayServer(
        gatewaySourcesOf(platform),
        {
            port: 0,
            host: '127.0.0.1',
            egressSecret: EGRESS_SECRET,
            subnet: options.subnet ?? '127.0.0.0/8',
        },
        { log: () => {} },
    )!;
    await server.listen();
    cleanup.unshift(() => server.close());
    const stampKey = gatewayStampKey(EGRESS_SECRET);
    const chats = new Map<string, string>();
    const chatFor = (personId: string) => {
        let id = chats.get(personId);
        if (!id) {
            id = workspace.bindThread(`chat-${personId}`, socio.id, 'Coding', personId).id;
            chats.set(personId, id);
        }
        return id;
    };

    /** A coding session's grant, sandbox and prompt credential (the coding sessions' part). */
    async function session(
        input: {
            personId?: string;
            model?: string;
            repository?: string;
            session?: string;
            scopes?: ActorScope[];
            audiences?: Audience[];
            credentialAudiences?: Audience[];
            credentialScopes?: ActorScope[];
            ttlMs?: number;
        } = {},
    ) {
        const personId = input.personId ?? 'alice';
        // Coding grants name both gateways (CB-239): coding-git's audience
        // allows them only for a repository on Settings → Coding → Repositories.
        const repository = input.repository ?? 'erden-sh/socio';
        const { repos } = gitGateway(platform);
        if (validCodingRepository(repository) && !repos.get(repository)) {
            await repos.save(repository, {}, 'olga');
        }
        const grant = await platform.actors.grants.create({
            personId,
            socioId: socio.id,
            audiences: input.audiences ?? ['gateway:model', 'gateway:git'],
            scopes: input.scopes ?? ['model:invoke', 'git:read'],
            resources: {
                session: input.session ?? `session-${personId}`,
                repository,
                model: input.model ?? 'orion',
            },
            conversationId: chatFor(personId),
            conversationKind: 'private',
            task: 'Fix the flaky test',
            approvedBy: personId,
            correlationId: 'corr-grant',
        });
        const context = await platform.actors.contexts.open({
            grant,
            kind: 'sandbox',
            audience: 'gateway:model',
            correlationId: 'corr-context',
        });
        const issued = await platform.actors.credentials.issue({
            grant,
            kind: 'cbgw',
            audiences: input.credentialAudiences ?? grant.audiences,
            ...(input.credentialScopes ? { scopes: input.credentialScopes } : {}),
            contextId: context.id,
            holder: { kind: 'prompt-run', id: `run-${context.id}` },
            ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
            correlationId: 'corr-credential',
        });
        return {
            grant,
            sandboxId: context.id,
            runId: `run-${context.id}`,
            token: issued.token,
        };
    }

    // The egress proxy never stamps twice with the same time for a sandbox:
    // the listener refuses a stamp it has seen.
    let lastTs = 0;
    const stampTime = () => (lastTs = Math.max(Date.now(), lastTs + 1));

    /** A request as the coding egress proxy forwards it (stamped). */
    function call(
        path: string,
        input: {
            method?: 'GET' | 'POST' | 'PUT';
            token?: string;
            sandboxId: string;
            body?: unknown;
            headers?: Record<string, string>;
            stamp?: string | null;
            signal?: AbortSignal;
        },
    ) {
        const method = input.method ?? (input.body === undefined ? 'GET' : 'POST');
        const stamp =
            input.stamp === null
                ? undefined
                : (input.stamp ?? signGatewayStamp(stampKey, input.sandboxId, method, path, stampTime()));
        return fetch(`http://127.0.0.1:${server.port}${path}`, {
            method,
            headers: {
                ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
                ...(stamp ? { 'x-cb-sandbox': stamp } : {}),
                ...input.headers,
            },
            ...(input.body === undefined
                ? {}
                : {
                      body: typeof input.body === 'string' ? input.body : JSON.stringify(input.body),
                  }),
            signal: input.signal,
        });
    }

    const chat = (
        s: { token: string; sandboxId: string },
        body: Record<string, unknown> = {},
        extra: { headers?: Record<string, string>; signal?: AbortSignal } = {},
    ) =>
        call('/v1/chat/completions', {
            token: s.token,
            sandboxId: s.sandboxId,
            body: {
                model: 'orion',
                messages: [{ role: 'user', content: 'Say hello.' }],
                ...body,
            },
            ...extra,
        });

    return {
        platform,
        workspace,
        store,
        socio,
        backend,
        gateway,
        server,
        upstream,
        stampKey,
        session,
        call,
        chat,
        async close() {
            for (const fn of cleanup.splice(0)) {
                await fn();
            }
        },
    };
}

/** Waits until `check` holds, polling every 5 ms, for at most `ms`. */
export async function until(check: () => boolean, ms = 3_000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error('Timed out waiting.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
