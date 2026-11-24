import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';

import { Context } from 'effect';

import {
    egressCredentialKey,
    gatewayStampKey,
    signGatewayStamp,
    verifyEgressCredential,
    type EgressCredentialClaims,
} from '@socio/foundation/actors/keys';
import type { DotTurn } from '@socio/foundation/turns/turn';

import {
    execPlan,
    parseCreateRequest,
    parseStartRequest,
    sandboxConfig,
} from '../../deployment/computers/coding-sandbox.mjs';
import { diagnosticsToken } from '../../src/coding-egress/proxy.js';
import { CodingService } from '../../src/server/coding/layer.js';
import { AppTurns } from '../../src/server/composition/app/turns.js';
import type { PlatformConfig } from '../../src/server/composition/config.js';
import type { AppWorkspace as WorkspaceStore } from '../../src/server/composition/workspace-parts.js';
import { gatewaySourcesOf, HostedGateway } from '../../src/server/gateway/adopted.js';
import { gitGateway } from '../../src/server/gateway/git.js';
import { modelGateway } from '../../src/server/gateway/model.js';
import { createGatewayServer } from '../../src/server/gateway/server.js';
import type { AppEdge } from '../../src/server/main.js';
import type { Store } from '../helpers/stores.js';
import type { TestPlatform } from '../helpers/test-platform.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

import { fakeUpstream, UPSTREAM_KEY } from './gateway-fixture.js';

/**
 * Coding sessions (CB-239) on real platforms, with every outside system a
 * loopback fake: the computer supervisor's sandbox API (each request checked
 * with the supervisor's own parsers, so the sessions speak exactly its
 * contract), the egress proxy's diagnostics listener, and an
 * OpenAI-compatible backend behind the coding model gateway listener.
 * Nothing starts a container or reaches outside the machine. Two platforms
 * may share one database: two runtimes of a deploy (CB-108).
 */

export const EGRESS_SECRET = 'coding-test-egress-secret-0123456789';
export const SUPERVISOR_TOKEN = 'coding-test-supervisor-token-0123456789';
export const REPO = 'erden-sh/socio';
const IMAGE = `socio-coding@sha256:${'a'.repeat(64)}`;
const config = sandboxConfig({ CODING_SANDBOX_IMAGE: IMAGE }, 'company-brain');

export interface FakeExec {
    sessionId: string;
    runId: string;
    kind: string;
    params: Record<string, unknown>;
    state: 'running' | 'exited' | 'timed-out' | 'failed';
    exitCode?: number;
    stdout: string;
    stderr: string;
}

const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(text ? JSON.parse(text) : undefined);
            } catch {
                resolve('unparseable');
            }
        });
    });

/** OpenCode's `run --format json` events, as the fake agent prints them. */
export const openCodeOutput = (text: string, extra: object[] = []) =>
    [
        { type: 'step_start', sessionID: 'ses_fake01', part: {} },
        {
            type: 'tool_use',
            sessionID: 'ses_fake01',
            part: {
                tool: 'edit',
                state: { status: 'completed', title: 'src/index.ts' },
            },
        },
        ...extra,
        { type: 'text', sessionID: 'ses_fake01', part: { type: 'text', text } },
        { type: 'step_finish', sessionID: 'ses_fake01', part: {} },
    ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n';

export async function fakeSupervisor() {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const refusals: string[] = [];
    const sandboxes = new Map<
        string,
        {
            volumeKey: string;
            state: string;
            proxy?: EgressCredentialClaims;
            /** The supervisor's listing of a container whose network is gone. */
            networkMissing?: boolean;
        }
    >();
    const execs = new Map<string, FakeExec>();
    const tokens = new Map<string, string>();
    const removed: string[] = [];
    const workspacesRemoved: string[] = [];
    /** CB-326 step 3: the session host each sandbox runs, if `hostMode` started it. */
    const hosts = new Map<
        string,
        { kind: string; closed: boolean; commands: string[]; stream?: import('node:stream').PassThrough }
    >();
    /** The ndjson lines the host has emitted on its stream, recorded for tests. */
    const hostEvents = new Map<string, Array<{ type: string; [key: string]: unknown }>>();
    /** CB-326 step 4: the respond_runtime payloads the app sent back, recorded for tests. */
    const hostResponses = new Map<string, Array<{ requestId?: string; decision?: string }>>();
    const behavior: {
        /** `exists`: the remote has the session branch (setup's exit 3). */
        setup: 'ok' | 'fail' | 'hang' | 'exists';
        /** Called when a prompt starts; finish it with `finish`. */
        onPrompt?: (exec: FakeExec, token: string | undefined) => void;
        /** More of the diff, as the agent's work left it. */
        diffTail?: string;
        down: boolean;
        /** CB-326 step 4: the host emits a runtime_request.updated on turn_start. */
        runtimeRequest?: boolean;
    } = { setup: 'ok', down: false };
    const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const view = (exec: FakeExec) => ({
        runId: exec.runId,
        kind: exec.kind,
        state: exec.state,
        ...(exec.exitCode !== undefined ? { exitCode: exec.exitCode } : {}),
        stdout: exec.stdout,
        stderr: exec.stderr,
        truncated: { stdout: false, stderr: false },
        startedAt: new Date().toISOString(),
    });
    const server: Server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://fake');
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        requests.push({ method: req.method ?? '', path: url.pathname, body });
        if (req.headers.authorization !== `Bearer ${SUPERVISOR_TOKEN}`) {
            return json(res, 401, { error: 'Unauthorized.' });
        }
        if (behavior.down) {
            return json(res, 503, { error: 'Docker is away.' });
        }
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'workspaces' && req.method === 'DELETE') {
            workspacesRemoved.push(parts[1]!);
            return json(res, 200, { removed: true });
        }
        if (parts[0] !== 'sandboxes') {
            return json(res, 404, { error: 'Not found.' });
        }
        if (parts.length === 1 && req.method === 'GET') {
            return json(res, 200, {
                sandboxes: [...sandboxes].map(([sessionId, sandbox]) => ({
                    sessionId,
                    state: sandbox.state,
                    ...(sandbox.networkMissing ? { networkMissing: true } : {}),
                })),
            });
        }
        if (parts.length === 1 && req.method === 'POST') {
            const parsed = parseCreateRequest(body, config);
            if (!parsed.ok) {
                refusals.push(`create: ${parsed.reason}`);
                return json(res, 400, { error: parsed.reason });
            }
            const existing = sandboxes.get(parsed.value.sessionId);
            if (!existing) {
                sandboxes.set(parsed.value.sessionId, {
                    volumeKey: parsed.value.volumeKey,
                    state: 'network-ready',
                });
            }
            return json(res, existing ? 200 : 201, {
                sessionId: parsed.value.sessionId,
                state: 'network-ready',
                subnet: '10.213.0.16/28',
                proxyAddress: '10.213.0.18:3128',
            });
        }
        const sessionId = parts[1]!;
        const sandbox = sandboxes.get(sessionId);
        if (parts.length === 2 && req.method === 'DELETE') {
            removed.push(sessionId);
            const had = sandboxes.delete(sessionId);
            for (const [id, exec] of execs) {
                if (exec.sessionId === sessionId) {
                    execs.delete(id);
                }
            }
            return json(res, 200, { removed: had });
        }
        if (!sandbox) {
            return json(res, 404, { error: 'No such sandbox.' });
        }
        if (parts[2] === 'start' && req.method === 'POST') {
            const parsed = parseStartRequest(body);
            if (!parsed.ok) {
                refusals.push(`start: ${parsed.reason}`);
                return json(res, 400, { error: parsed.reason });
            }
            const claims = verifyEgressCredential(
                egressCredentialKey(EGRESS_SECRET),
                parsed.value.user,
                parsed.value.password,
            );
            if (!claims) {
                refusals.push('start: credential');
                return json(res, 400, { error: 'Bad credential.' });
            }
            sandbox.proxy = claims;
            sandbox.state = 'running';
            return json(res, 200, { state: 'running' });
        }
        if (parts[2] === 'exec' && parts.length === 3 && req.method === 'POST') {
            if (sandbox.state !== 'running') {
                return json(res, 409, { error: 'Not running.' });
            }
            const input = (body ?? {}) as {
                runId?: string;
                kind?: string;
                params?: Record<string, unknown>;
            };
            const plan = execPlan(input.kind, input.params, config);
            if (!plan.ok) {
                refusals.push(`exec ${input.kind}: ${plan.reason}`);
                return json(res, 400, { error: plan.reason });
            }
            const exec: FakeExec = {
                sessionId,
                runId: String(input.runId),
                kind: String(input.kind),
                params: input.params ?? {},
                state: 'running',
                stdout: '',
                stderr: '',
            };
            execs.set(exec.runId, exec);
            if (exec.kind === 'token') {
                tokens.set(sessionId, String(exec.params.token));
                Object.assign(exec, { state: 'exited', exitCode: 0 });
            } else if (exec.kind === 'setup') {
                if (behavior.setup === 'ok') {
                    Object.assign(exec, {
                        state: 'exited',
                        exitCode: 0,
                        stdout: 'ready\n',
                    });
                } else if (behavior.setup === 'exists') {
                    Object.assign(exec, {
                        state: 'exited',
                        exitCode: 3,
                        stderr: 'setup: the session branch already exists on the remote\n',
                    });
                } else if (behavior.setup === 'fail') {
                    Object.assign(exec, {
                        state: 'exited',
                        exitCode: 128,
                        stderr: 'fatal: could not read from remote repository\n',
                    });
                }
            } else if (exec.kind === 'prompt') {
                behavior.onPrompt?.(exec, tokens.get(sessionId));
            } else if (exec.kind === 'status') {
                Object.assign(exec, {
                    state: 'exited',
                    exitCode: 0,
                    stdout: `# branch.oid abc\n# branch.head ${'x'}\n# branch.ab +2 -0\n`,
                });
            } else if (exec.kind === 'changes') {
                Object.assign(exec, {
                    state: 'exited',
                    exitCode: 0,
                    stdout: 'M\tsrc/index.ts\nA\tdocs/new.md\n',
                });
            } else if (exec.kind === 'diff') {
                Object.assign(exec, {
                    state: 'exited',
                    exitCode: 0,
                    stdout:
                        'diff --git a/src/index.ts b/src/index.ts\n+export const answer = 43; // cbgw_' +
                        'A'.repeat(43) +
                        // The sandbox's proxy credential, as an agent could print it.
                        '\n+// HTTP_PROXY=http://eyJzIjoic2Vzcy0xIn0:' +
                        'P'.repeat(43) +
                        '@10.213.0.2:3128\n' +
                        (behavior.diffTail ?? ''),
                });
            }
            return json(res, exec.state === 'running' ? 202 : 200, view(exec));
        }
        if (parts[2] === 'exec' && parts.length === 4) {
            const exec = execs.get(parts[3]!);
            if (!exec || exec.sessionId !== sessionId) {
                return json(res, 404, { error: 'No such run in this sandbox.' });
            }
            if (req.method === 'DELETE') {
                if (exec.state === 'running') {
                    return json(res, 409, { error: 'Still running.' });
                }
                execs.delete(exec.runId);
                return json(res, 200, { forgotten: true });
            }
            return json(res, 200, view(exec));
        }
        // CB-326 step 3: the session-host routes. POST /host starts the host
        // process; GET /host/stream is the long-lived ndjson event stream; POST
        // /host/command sends one command (turn_start/…/close). A fake host
        // emits a provider_thread.updated + turn.terminal on turn_start so a
        // test can observe the lifecycle without a real codex app-server.
        if (parts[2] === 'host' && parts.length === 3 && req.method === 'POST') {
            const parsed = body as { kind?: string; model?: string } | undefined;
            const kind = parsed?.kind ?? 'opencode';
            const existing = hosts.get(sessionId);
            if (existing && !existing.closed && existing.kind === kind) {
                return json(res, 200, { sessionId, state: 'running' });
            }
            const stream = new PassThrough();
            hosts.set(sessionId, { kind, closed: false, commands: [], stream });
            hostEvents.set(sessionId, []);
            return json(res, 201, { sessionId, hostPid: 1, state: 'running' });
        }
        if (parts[2] === 'host' && parts[3] === 'stream' && req.method === 'GET') {
            const host = hosts.get(sessionId);
            if (!host || host.closed) {
                return json(res, 409, { error: 'No host stream.' });
            }
            res.writeHead(200, { 'content-type': 'application/x-ndjson' });
            // Replay any events already recorded, then stream live ones.
            const send = (event: { type: string; [key: string]: unknown }) => {
                res.write(JSON.stringify(event) + '\n');
            };
            for (const event of hostEvents.get(sessionId) ?? []) {
                send(event);
            }
            host.stream?.on('data', (chunk: Buffer) => res.write(chunk));
            req.on('close', () => {
                host.stream?.removeAllListeners();
            });
            return;
        }
        if (parts[2] === 'host' && parts[3] === 'command' && req.method === 'POST') {
            const host = hosts.get(sessionId);
            if (!host || host.closed) {
                return json(res, 404, { error: 'No host.' });
            }
            const parsed = body as
                | { op?: string; payload?: { message?: string; requestId?: string; decision?: string } }
                | undefined;
            const op = parsed?.op ?? '';
            host.commands.push(op);
            if (op === 'close') {
                host.closed = true;
                host.stream?.end();
                return json(res, 204, {});
            }
            if (op === 'respond_runtime') {
                // CB-326 step 4: the app sends the person's decision back.
                // Record it so a test can assert the loop closed.
                hostResponses.set(sessionId, [...(hostResponses.get(sessionId) ?? []), parsed!.payload!]);
                return json(res, 200, { ok: true });
            }
            if (op === 'turn_start') {
                // A fake turn: thread updated, then terminal (completed). The
                // app-side driver writes these to coding_thread_events.
                const emit = (event: { type: string; [key: string]: unknown }) => {
                    hostEvents.get(sessionId)!.push(event);
                    host.stream?.write(JSON.stringify(event) + '\n');
                };
                emit({ type: 'provider_turn.updated', providerTurn: { id: 't1', status: 'running' } });
                // CB-326 step 4: when asked, emit a runtime request (command
                // approval) before the turn terminates, so the driver files a
                // coding_runtime_command approval and the test decides it.
                if (behavior.runtimeRequest) {
                    emit({
                        type: 'runtime_request.updated',
                        runtimeRequest: {
                            id: 'rr1',
                            kind: 'command',
                            status: 'pending',
                            payload: { command: 'rm -rf /' },
                        },
                    });
                }
                emit({ type: 'turn.terminal', providerThreadId: 'th1', providerTurnId: 't1', status: 'completed' });
            }
            return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'Not found.' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        refusals,
        sandboxes,
        execs,
        tokens,
        removed,
        workspacesRemoved,
        /** CB-326 step 3: the session hosts the fake supervisor is running. */
        hosts,
        /** The ndjson events each host has emitted (recorded for tests). */
        hostEvents,
        /** The respond_runtime payloads the app sent back (recorded for tests). */
        hostResponses,
        behavior,
        /** Ends a running exec as the agent would. */
        finish(runId: string, outcome: Partial<FakeExec> = {}) {
            const exec = execs.get(runId);
            if (!exec) {
                throw new Error(`No exec ${runId}`);
            }
            Object.assign(exec, {
                state: 'exited',
                exitCode: 0,
                stdout: openCodeOutput('Done: the flaky test now waits for the server.'),
                ...outcome,
            });
        },
        /** The supervisor restarted: it forgot every exec (the supervisor keeps them in memory). */
        forgetAll() {
            execs.clear();
        },
        prompts: () => [...execs.values()].filter((exec) => exec.kind === 'prompt'),
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** The egress proxy's diagnostics listener, on loopback. */
export async function fakeDiagnostics() {
    const denials = new Map<string, Array<{ target: string; count: number }>>();
    const asked: string[] = [];
    const token = diagnosticsToken(EGRESS_SECRET);
    const server = createServer((req, res) => {
        asked.push(req.url ?? '');
        if (req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401).end();
            return;
        }
        const id = /^\/denials\/([A-Za-z0-9_-]{1,64})$/.exec(req.url ?? '')?.[1];
        if (!id) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                sandboxId: id,
                denials: (denials.get(id) ?? []).map((entry) => ({
                    ...entry,
                    firstAt: 1,
                    lastAt: 2,
                })),
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}`,
        denials,
        asked,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

export interface CodingWorldOptions {
    flags?: Record<string, boolean>;
    codeUsers?: string[];
    push?: boolean;
    /** A second platform on the same database (two runtimes). */
    runtimes?: 1 | 2;
    /** How long a tool waits for a run within its turn (ms). */
    waitMs?: number;
    /** CB-326 step 3: run new sessions on the session host (CODING_HOST_MODE). */
    hostMode?: boolean;
}

/**
 * A runtime's coding sessions, from what its graph built: its one service
 * (`CodingService`), what its gateways' module hosts of it (the tools and
 * routes, `HostedGateway`), and its turns (`AppTurns`), which the tests
 * replace with recorded ones.
 */
export function codingOf(edge: AppEdge) {
    return {
        service: Context.get(edge.services, CodingService),
        hosted: Context.get(edge.services, HostedGateway).coding,
        turns: Context.get(edge.services, AppTurns),
    };
}

/** Platforms, fakes and helpers for coding sessions' tests. */
export async function codingWorld(options: CodingWorldOptions = {}) {
    const cleanup: Array<() => unknown> = [];
    const config: Partial<PlatformConfig> = {
        apiKey: '',
        model: '',
        sessionSecret: 'coding-platform-secret-0123456789ab',
        appOrigin: 'https://socio.example',
        // Its flags are in development: only an internal deployment has them (CB-503).
        deploymentKind: 'internal',
        featureFlags: options.flags ?? {
            'socio-actor-access': true,
            'coding-sessions': true,
        },
    };
    // Who may run code (CB-376): the people the `code:run` permission covers.
    const codeRunners = options.codeUsers ?? ['alice', 'bob', 'olga'];
    const a = await makeTestRuntime({ config, codeRunners });
    cleanup.push(a.dispose);
    const { workspace } = a;
    for (const user of [
        { id: 'alice', name: 'Alice', role: 'member' as const },
        { id: 'bob', name: 'Bob', role: 'member' as const },
        { id: 'olga', name: 'Olga', role: 'admin' as const },
    ]) {
        workspace.recordUser(user);
    }
    // A second runtime on the same database: over `a`'s connection, which
    // its dispose leaves open.
    let b: { store: Store; workspace: WorkspaceStore; platform: TestPlatform; edge: AppEdge } | undefined;
    if (options.runtimes === 2) {
        const second = await makeTestRuntime({ database: a.db, config: a.config, codeRunners });
        b = { store: second.store, workspace: second.workspace, platform: second.platform, edge: second.edge };
        // Runs before `a.dispose` (cleanup runs in order): the connection stays open until then.
        cleanup.unshift(second.dispose);
    }
    const coding = codingOf(a.edge);
    const otherCoding = b ? codingOf(b.edge) : undefined;
    const socio = workspace.dots()[0]!;
    workspace.updateDot(socio.id, {
        name: 'Rulo',
        instructions: socio.instructions,
        researchAllowed: socio.researchAllowed,
        memoryAllowed: socio.memoryAllowed,
        spaceId: socio.spaceId,
        spaceIds: socio.spaceIds,
    });
    const upstream = await fakeUpstream();
    cleanup.push(() => upstream.close());
    const backend = await a.platform.inference.createBackend({
        label: 'Homelab',
        baseUrl: upstream.url,
        model: 'qwen38',
        apiKey: UPSTREAM_KEY,
    });
    await modelGateway(a.platform).settings.saveModel(
        'orion',
        {
            label: 'Homelab (qwen38)',
            backendId: backend.id,
            upstreamModel: 'qwen38-coder',
            maxOutputTokens: 4000,
        },
        'olga',
    );
    await gitGateway(a.platform).repos.save(
        REPO,
        options.push === false ? {} : { push: true, pushChecklistConfirmed: true },
        'olga',
    );
    const supervisor = await fakeSupervisor();
    cleanup.push(() => supervisor.close());
    const diagnostics = await fakeDiagnostics();
    cleanup.push(() => diagnostics.close());
    const gateway = createGatewayServer(
        gatewaySourcesOf(a.platform),
        {
            port: 0,
            host: '127.0.0.1',
            egressSecret: EGRESS_SECRET,
            subnet: '127.0.0.0/8',
        },
        { log: () => {} },
    )!;
    await gateway.listen();
    cleanup.unshift(() => gateway.close());
    for (const { service } of [coding, ...(otherCoding ? [otherCoding] : [])]) {
        service.configure({
            supervisorUrl: supervisor.url,
            supervisorToken: SUPERVISOR_TOKEN,
            egressSecret: EGRESS_SECRET,
            diagnosticsUrl: diagnostics.url,
            pollSeconds: 0,
            retryMs: 10,
            waitMs: options.waitMs ?? 2_000,
            ...(options.hostMode ? { hostMode: true } : {}),
        });
    }
    const chats = new Map<string, string>();
    const chatOf = (personId: string, title = 'Coding') => {
        const key = `${personId}:${title}`;
        let id = chats.get(key);
        if (!id) {
            id = workspace.bindThread(`chat-${personId}-${chats.size}`, socio.id, title, personId).id;
            chats.set(key, id);
        }
        return id;
    };
    const turnOf = (personId = 'alice', extra: Partial<DotTurn> = {}, platform = a.platform): DotTurn => ({
        dot: platform.workspace.dot(socio.id)!,
        userId: personId,
        threadId: chatOf(personId),
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
        ...extra,
    });
    /** Runs one coding tool for a turn. */
    const tool =
        (name: string, turn: DotTurn = turnOf()) =>
        async (input: Record<string, unknown> = {}) => {
            const found = (
                coding.hosted.tools.dotTools(turn) as unknown as Array<{
                    name: string;
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }>
            ).find((item) => item.name === name);
            if (!found) {
                throw new Error(`No tool ${name}`);
            }
            return found.execute(input);
        };
    const stampKey = gatewayStampKey(EGRESS_SECRET);
    let lastTs = 0;
    /** A model call as the egress proxy forwards a sandbox's (stamped). */
    const modelCall = (sandboxId: string, token: string | undefined, model = 'orion') => {
        const path = '/v1/chat/completions';
        const ts = (lastTs = Math.max(Date.now(), lastTs + 1));
        return fetch(`http://127.0.0.1:${gateway.port}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                'x-cb-sandbox': signGatewayStamp(stampKey, sandboxId, 'POST', path, ts),
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Fix the test.' }],
            }),
        });
    };
    /** Starts a session through the tool and the person's click. */
    const started = async (input: Record<string, unknown> = {}, turn = turnOf()) => {
        const asked = await tool(
            'coding_start',
            turn,
        )({
            repository: REPO,
            task: 'Fix the flaky test',
            push: true,
            ...input,
        });
        if (asked.status !== 'pending_approval') {
            throw new Error(`Not pending: ${JSON.stringify(asked)}`);
        }
        const approval = (asked.approval as { id: string }).id;
        const decided = await a.platform.approvals.decide(approval, turn.userId, true);
        const session = coding.service.sessions.ofPerson(turn.userId, 5).find((item) => item.approvalId === approval);
        return { asked, approval, decided, session };
    };
    return {
        connection: a.db,
        /** Who may run code now (CB-376); change it to revoke or grant. */
        codeRunners,
        platform: a.platform,
        store: a.store,
        workspace,
        other: b?.platform,
        /** The second runtime's coding sessions, when there is one. */
        otherCoding,
        socio,
        upstream,
        supervisor,
        diagnostics,
        gateway,
        service: coding.service,
        /** The runtime's turns (`AppTurns`): the coding sessions' reports and continuations run through them. */
        turns: coding.turns,
        /** The coding session routes the gateways' module mounts under `/api/gateway`. */
        routes: () => coding.hosted.routes()!,
        /** The socio's coding tools for a turn, as the gateways' module hands them over. */
        tools: (turn: DotTurn) => coding.hosted.tools.dotTools(turn),
        chatOf,
        turnOf,
        tool,
        modelCall,
        started,
        close: async () => {
            for (const fn of cleanup.splice(0)) {
                await fn();
            }
        },
    };
}

/** Waits until `check` holds (async allowed), polling every 10 ms. */
export async function eventually(check: () => boolean | Promise<boolean>, ms = 5_000) {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) {
            throw new Error('Timed out waiting.');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
