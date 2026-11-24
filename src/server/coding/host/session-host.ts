/**
 * The coding session host entry point (CB-326 step 1):
 * a Node process that runs inside each coding sandbox and bridges Socio's app
 * to a vendored provider driver over one ndjson stream. Today the only driver
 * is `provider-codex` (over `codex app-server`); the shape generalizes to the
 * other harnesses once their drivers are wired.
 *
 * The supervisor's `startHost` (deployment/computers/coding-sandbox.mjs) execs
 * this entry inside the sandbox as `node session-host.js <sessionId> <kind>
 * <model>`. The entry reads the session's `cbgw_` from `/run/socio/token`
 * (exactly as `with-token` does), spawns `codex app-server` with the gateway as
 * its only model provider, opens a provider session, and bridges:
 *
 *   - **stdin** — newline-delimited commands from the app's HostDriver:
 *     `{op: "turn_start"|"turn_steer"|"turn_interrupt"|"thread_resume"|
 *      "respond_runtime"|"close", payload?}`. One command per line.
 *   - **stdout** — newline-delimited `ProviderAdapterV2Event`s from the driver
 *     (`provider_turn.updated`, `turn.terminal`, `runtime_request.updated`, …),
 *     plus a `{type:"heartbeat"}` every 15 s so the supervisor's stream does
 *     not idle out, and a `{type:"ack", op}` per command.
 *
 * The app's `HostDriver` (`src/server/coding/hostDriver.ts`) already consumes
 * this exact contract; the supervisor replays stdout ndjson to the app over
 * `GET /sandboxes/:id/host/stream` and forwards commands via
 * `POST /sandboxes/:id/host/command`. So this entry is the third party the
 * other two were written against.
 *
 * Credentials: the `cbgw_` stays in the entry's process env (read from the
 * token file, never argv); the spawned `codex` child receives it as
 * `SOCIO_GATEWAY_TOKEN` (its `model_providers.socio.env_key`). No vendor login
 * is present; the gateway is the only model provider.
 *
 * Failures: on a codex crash the entry emits a `turn.terminal{status:"failed"}`
 * and exits non-zero so the supervisor settles the host as ended.
 */

import { readFileSync } from 'node:fs';

import * as NodeServices from '@effect/platform-node/NodeServices';
import { CodexDriver } from '@t3tools/provider-codex/server/driver';
import type { ProviderInstance } from '@t3tools/provider-core/server/driver';
import * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter';
import * as CodexClient from 'effect-codex-app-server/client';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';

import { GATEWAY_ROUTES, type GatewayRoute } from './gatewayAuth.js';
import { providerHostLayer, type SocioProviderHostPaths } from './providerHost.js';

/** The default sandbox paths (the image mounts `/work` and preps `/work/repo`). */
const DEFAULT_CWD = '/work/repo';
const DEFAULT_STATE_DIR = '/work/state';
const TOKEN_FILE = '/run/socio/token';

/** The `codex app-server` config flags pointing codex at Socio's gateway. */
const codexConfigArgs = (route: GatewayRoute): ReadonlyArray<string> => {
    // The same `model_providers.socio` shape as `CODEX_OVERRIDES` in
    // coding-sandbox.mjs, but as `codex app-server` `-c` flags (the app-server
    // reads the same codex config). The gateway is the only provider; no
    // OpenAI login, approvals off (the container is the boundary), telemetry off.
    const overrides = [
        'model_provider="socio"',
        'model_providers.socio.name="Socio"',
        `model_providers.socio.base_url="${route.baseUrl}"`,
        `model_providers.socio.env_key="${route.envVar}"`,
        `model_providers.socio.wire_api="${route.wireApi}"`,
        'model_providers.socio.requires_openai_auth=false',
        'approval_policy="never"',
        'sandbox_mode="danger-full-access"',
        'check_for_update_on_startup=false',
        'web_search="disabled"',
        'analytics.enabled=false',
        'history.persistence="none"',
    ];
    return overrides.flatMap((value) => ['-c', value]);
};

/** Reads the session's `cbgw_` token file; fails closed if absent or empty. */
const readToken = (): string => {
    const file = process.env.SOCIO_HOST_TOKEN_FILE ?? TOKEN_FILE;
    const token = readFileSync(file, 'utf8').trim();
    if (!token) {
        throw new Error(`session-host: empty token file ${file}`);
    }
    return token;
};

/** A command from the app's HostDriver, parsed from one stdin ndjson line. */
interface HostCommand {
    readonly op:
        | 'turn_start'
        | 'turn_steer'
        | 'turn_interrupt'
        | 'thread_resume'
        | 'thread_snapshot'
        | 'thread_rollback'
        | 'thread_fork'
        | 'respond_runtime'
        | 'close';
    readonly payload?: unknown;
}

/** One stdin line parsed to a command, or undefined for a blank/comment line. */
const parseCommand = (line: string): HostCommand | undefined => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(trimmed) as HostCommand;
        return parsed?.op ? parsed : undefined;
    } catch {
        return undefined;
    }
};

/** Writes one event as an ndjson line to stdout. */
const emit = (event: { type: string; [k: string]: unknown }): void => {
    process.stdout.write(JSON.stringify(event) + '\n');
};

/**
 * Builds one session: spawns `codex app-server`, builds the layers, opens a
 * provider session. Returns the runtime + the scope that owns the codex child
 * (close it to end the session). Run with `Effect.runPromise`.
 */
const buildSession = Effect.fn('session-host.buildSession')(function* (sessionId: string, kind: string) {
    const route: GatewayRoute = GATEWAY_ROUTES[kind] ?? GATEWAY_ROUTES.codex!;
    const token = readToken();

    // Spawn `codex app-server` with the gateway as its only model provider.
    // The token reaches codex as the provider's env_key; the entry's own env
    // is not inherited (only the token + a clean PATH), so no stray secrets.
    // `SOCIO_HOST_CODEX_BIN` overrides the binary (tests point it at a mock peer).
    const codexBin = process.env.SOCIO_HOST_CODEX_BIN ?? 'codex';
    const command = ChildProcess.make(codexBin, ['app-server', ...codexConfigArgs(route)], {
        env: { [route.envVar]: token, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(command);

    const paths: SocioProviderHostPaths = {
        cwd: process.env.SOCIO_HOST_CWD ?? DEFAULT_CWD,
        stateDir: process.env.SOCIO_HOST_STATE_DIR ?? DEFAULT_STATE_DIR,
        attachmentsDir: process.env.SOCIO_HOST_ATTACHMENTS_DIR ?? `${DEFAULT_STATE_DIR}/attachments`,
    };
    const clientLayer = CodexClient.layerChildProcess(handle);
    const baseLayer = Layer.mergeAll(NodeServices.layer, providerHostLayer(paths), clientLayer);

    // Build the layer's context in a scope the entry owns, so closing the scope
    // kills the codex child when the session ends.
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(baseLayer, scope);

    const instance = (yield* CodexDriver.create({
        instanceId: `socio-codex-${sessionId}` as never,
        displayName: 'Codex',
        environment: [] as never,
        enabled: true,
        config: {} as never,
    }).pipe(Effect.provideContext(context), Effect.provideService(Scope.Scope, scope))) as ProviderInstance;

    const adapter = instance.orchestrationAdapter;
    const runtime = (yield* adapter
        .openSession({
            providerSessionId: `session-${sessionId}` as never,
        } as never)
        .pipe(
            Effect.provideContext(context),
            Effect.provideService(Scope.Scope, scope),
        )) as ProviderAdapter.ProviderAdapterV2SessionRuntime;

    return { runtime, scope, context };
});

/** Per-session turn state the dispatcher mutates as the host runs. */
interface SessionState {
    readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
    readonly model: string;
    readonly sessionId: string;
    /** The provider thread `ensureThread` returned; reused across turns. */
    providerThread: { providerThreadId: string } | null;
}

/** A minimal runtime policy for a host session: full access, default mode. */
const HOST_RUNTIME_POLICY = {
    runtimeMode: 'full-access' as never,
    interactionMode: 'default' as never,
    cwd: null,
} as never;

/** Dispatches one stdin command to the runtime, emitting an ack. */
const dispatchCommand = Effect.fn('session-host.dispatch')(function* (cmd: HostCommand, state: SessionState) {
    const { runtime, model, sessionId } = state;
    switch (cmd.op) {
        case 'turn_start': {
            const payload = cmd.payload as { message?: string } | undefined;
            // A turn needs a native thread; ensure one (once) before the first
            // turn, then reuse it. The codex adapter captures the native id.
            if (!state.providerThread) {
                state.providerThread = (yield* runtime.ensureThread({
                    threadId: sessionId as never,
                    title: sessionId,
                    modelSelection: { model } as never,
                    runtimePolicy: HOST_RUNTIME_POLICY,
                } as never)) as unknown as { providerThreadId: string };
            }
            yield* runtime.startTurn({
                threadId: sessionId as never,
                message: { text: payload?.message ?? '' } as never,
                modelSelection: { model } as never,
                runtimePolicy: HOST_RUNTIME_POLICY,
            } as never);
            break;
        }
        case 'turn_steer': {
            const payload = cmd.payload as { message?: string; providerTurnId?: string } | undefined;
            yield* runtime.steerTurn({
                threadId: sessionId as never,
                providerThread: state.providerThread as never,
                providerTurnId: payload?.providerTurnId as never,
                message: { text: payload?.message ?? '' } as never,
            } as never);
            break;
        }
        case 'turn_interrupt': {
            const payload = cmd.payload as { providerTurnId?: string } | undefined;
            yield* runtime.interruptTurn({
                providerThread: state.providerThread as never,
                providerTurnId: payload?.providerTurnId as never,
            } as never);
            break;
        }
        case 'thread_resume': {
            const payload = cmd.payload as { providerThread?: { providerThreadId?: string } } | undefined;
            const thread = payload?.providerThread ?? null;
            if (thread) {
                state.providerThread = thread as { providerThreadId: string };
            }
            yield* runtime.resumeThread({
                providerThread: (thread ?? state.providerThread) as never,
            } as never);
            break;
        }
        case 'thread_snapshot': {
            // readThreadSnapshot: pull the thread's turns from codex and emit a
            // thread.snapshot event carrying the snapshot so the app can render
            // the transcript boundary for rollback/fork selection.
            const snapshot = (yield* runtime.readThreadSnapshot({
                providerThread: state.providerThread as never,
            } as never)) as unknown as { providerTurns?: unknown[] };
            emit({ type: 'thread.snapshot', snapshot });
            break;
        }
        case 'thread_rollback': {
            // rollbackThread: revert the codex conversation before the target
            // turn. The app supplies the target turn + the full turn list; codex
            // emits thread/reverted → provider_thread.updated on the event stream.
            const payload = cmd.payload as
                | {
                      providerTurn?: { id?: string; nativeTurnRef?: { nativeId?: string } };
                      providerThreadTurns?: unknown[];
                  }
                | undefined;
            const targetTurn = payload?.providerTurn ?? null;
            const snapshot = (yield* runtime.rollbackThread({
                providerThread: state.providerThread as never,
                target: {
                    type: 'provider_turn',
                    checkpointId: 'cp' as never,
                    appRunOrdinal: 1,
                    providerTurn: targetTurn as never,
                },
                providerThreadTurns: (payload?.providerThreadTurns ?? []) as never,
            } as never)) as unknown as { providerTurns?: unknown[] };
            emit({ type: 'thread.rolledback', snapshot });
            break;
        }
        case 'thread_fork': {
            // forkThread: fork the codex thread (optionally through a turn) into
            // a new native thread. The new providerThread is emitted so the app
            // can record the forked thread.
            const payload = cmd.payload as { providerTurnId?: string; targetThreadId?: string } | undefined;
            const forked = (yield* runtime.forkThread({
                sourceProviderThread: state.providerThread as never,
                providerTurnId: payload?.providerTurnId as never,
                targetThreadId: (payload?.targetThreadId ?? 'fork') as never,
            } as never)) as { providerThreadId?: string; forkedFrom?: { providerThreadId?: string } };
            emit({ type: 'thread.forked', fork: forked });
            break;
        }
        case 'respond_runtime': {
            const payload = cmd.payload as { requestId?: string; decision?: string } | undefined;
            yield* runtime.respondToRuntimeRequest({
                requestId: payload?.requestId as never,
                decision: (payload?.decision ?? 'decline') as never,
            } as never);
            break;
        }
        case 'close':
            break;
    }
    emit({ type: 'ack', op: cmd.op });
});

// Main: parse argv, build the session, drain events, drive stdin, close.

const [sessionIdArg, kindArg, modelArg] = process.argv.slice(2);

if (!sessionIdArg) {
    process.stderr.write('session-host: usage: node session-host.js <sessionId> [kind] [model]\n');
    process.exit(2);
}

const sessionId = sessionIdArg;
const kind = kindArg ?? 'codex';
const model = modelArg ?? '';

Effect.runPromise(
    buildSession(sessionId, kind).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(Scope.Scope, Scope.makeUnsafe()),
    ),
).then(
    ({ runtime, scope, context }) => {
        const state: SessionState = { runtime, model, sessionId, providerThread: null };

        // Drain the runtime's event stream to stdout as ndjson, for the session's life.
        const drain = Effect.runPromise(
            Stream.runForEach(runtime.events, (event) =>
                Effect.sync(() => emit(event as { type: string; [k: string]: unknown })),
            ).pipe(Effect.provideContext(context)),
        ).catch(() => undefined);

        // Heartbeat every 15 s so the supervisor's stream does not idle out.
        const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 15_000);

        const runCommand = (cmd: HostCommand): Promise<void> =>
            Effect.runPromise(dispatchCommand(cmd, state).pipe(Effect.provideContext(context))).catch(() => undefined);

        const cleanup = () => {
            clearInterval(heartbeat);
            // Close the scope (kills the codex child) and let the drain flush
            // remaining events, then exit. The supervisor treats process exit
            // as the session ending; an explicit exit avoids the codex child or
            // the stream keeping the event loop alive.
            void Effect.runPromise(Scope.close(scope, Exit.void))
                .finally(() => drain)
                .finally(() => process.exit(0));
        };

        // Read stdin ndjson and dispatch commands; `close` or EOF ends the session.
        let buffer = '';
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                const cmd = parseCommand(line);
                if (!cmd) {
                    continue;
                }
                void runCommand(cmd);
                if (cmd.op === 'close') {
                    process.stdin.removeListener('data', onData);
                    process.stdin.removeListener('end', onEnd);
                    cleanup();
                    return;
                }
            }
        };
        const onEnd = () => {
            process.stdin.removeListener('data', onData);
            cleanup();
        };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
        process.stdin.on('end', onEnd);
    },
    (error) => {
        emit({ type: 'turn.terminal', status: 'failed', failure: String(error) });
        process.exitCode = 1;
    },
);
