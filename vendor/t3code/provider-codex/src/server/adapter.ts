import type {
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from '@t3tools/contracts';
import { ProviderDriverKind } from '@t3tools/contracts';
import * as CodexClient from 'effect-codex-app-server/client';
import type * as EffectCodexSchema from 'effect-codex-app-server/schema';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import * as Ref from 'effect/Ref';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

import * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter';

import { CODEX_DRIVER_KIND } from './driver.ts';
import { toMcpElicitationResponse } from './mcpElicitation.ts';

/** A fallback native thread id when the response did not name one. */
const cryptoId = (): string =>
  `socio_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

/**
 * A pending runtime request (CB-326 step 4): the codex app-server's approval
 * requests are synchronous server-requests, but `ProviderAdapterV2` is async
 * (a `runtime_request.updated` event streams out, the host responds later via
 * `respondToRuntimeRequest`). The bridge is a `Deferred`: the server-request
 * handler emits the event and awaits the Deferred; `respondToRuntimeRequest`
 * resolves it with the decision, and the handler returns the codex-shaped
 * response. Modelled on T3's `CodexAdapterV2` (`PendingCodexRuntimeRequest`).
 */
type PendingRuntimeRequest = {
  readonly requestKind: 'command' | 'file-read' | 'file-change' | 'mcp-elicitation' | 'permission';
  readonly decision: Deferred.Deferred<ProviderApprovalDecision, never>;
};

/**
 * Socio's Codex `ProviderAdapterV2` (CB-326): maps `codex app-server`
 * JSON-RPC notifications (effect-codex-app-server) to T3's
 * `ProviderAdapterV2` event stream, and implements the session/turn lifecycle
 * over the JSON-RPC client's requests. This is Socio's rewrite of T3's
 * `CodexAdapterV2` (the conservative option) over the cleanly-packaged
 * client, not an extraction of it.
 *
 * Codex notification → ProviderAdapterV2 event mapping:
 *   thread/started            → app_thread.created, provider_thread.updated
 *   thread/status/changed     → provider_session.updated
 *   turn/started             → provider_turn.updated
 *   turn/completed           → turn.terminal (completed)
 *   item/started, item/completed → turn_item.updated
 *   item/agentMessage/delta  → message.updated (delta)
 *   command/exec/outputDelta → command_output.delta
 *   thread/tokenUsage/updated → (usage; step 6 logs it)
 *
 * The session/turn methods (ensureThread, resumeThread, startTurn, steerTurn,
 * interruptTurn, respondToRuntimeRequest) call the client's request methods
 * (`thread/create`, `turn/start`, `turn/interrupt`, …). The exact codex
 * app-server method names are in `effect-codex-app-server/_generated/meta.gen`.
 *
 * This slice implements the event stream + the methods step 3's long-lived
 * sessions need first (ensureThread, resumeThread, startTurn, interruptTurn,
 * respondToRuntimeRequest, readThreadSnapshot). forkThread, rollbackThread,
 * MCP apps and subagents follow; they throw a typed error until wired so the
 * surface is honest.
 */

/** A typed error for not-yet-wired adapter methods. */
export class CodexAdapterNotImplemented extends Schema.TaggedError<CodexAdapterNotImplemented>()(
  'CodexAdapterNotImplemented',
  {
    method: Schema.String,
    driver: ProviderDriverKind,
  },
) {
  override get message() {
    return `${this.method} is not implemented for the ${this.driver} adapter yet.`;
  }
}

const notImplemented = (method: string) =>
  Effect.fail(
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CODEX_DRIVER_KIND,
      detail: `${method} is not implemented for the ${CODEX_DRIVER_KIND} adapter yet.`,
      cause: new CodexAdapterNotImplemented({ method, driver: CODEX_DRIVER_KIND }),
    }),
  );

/**
 * Builds one session runtime: an events stream fed by the codex app-server
 * client's notifications, plus the session/turn methods. The client is
 * started (over stdio to `codex app-server`) by the driver's `create()`,
 * which provides the `CodexAppServerClient` service; this consumes it.
 */
export const makeSessionRuntime = Effect.fn('CodexAdapter.makeSessionRuntime')(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerSession: OrchestrationV2ProviderSession;
    readonly client: CodexClient.CodexAppServerClient['Service'];
  }) {
    const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    // The queue lives for the session scope; close it when the scope unwinds so
    // the event stream terminates and the codex child is reaped.
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  // The native codex thread id, captured from the `thread/started` notification
  // (after `thread/start`) and the `thread/start` response. Used as the
  // `threadId` field of `turn/start`, `turn/steer` and `turn/interrupt`.
  const nativeThreadId = yield* Ref.make<string | null>(null);
  // Pending runtime requests (CB-326 step 4): a server-request handler emits a
  // runtime_request.updated event and awaits its Deferred; respondToRuntimeRequest
  // resolves it. Keyed by the Socio-side runtime-request id.
  const pendingRuntimeRequests = yield* Ref.make(new Map<string, PendingRuntimeRequest>());

    // Map incoming codex notifications to ProviderAdapterV2 events. The codex
    // app-server emits many notification kinds; the essential ones for a
    // long-lived coding session are mapped here. Rarer ones (skills, fs,
    // project, account) are ignored for now — they carry no turn state.
    //
    // The codex client strictly decodes *known* notifications and dispatches
    // them through `handleServerNotification` (per method); unknown methods go
    // to `handleUnknownServerNotification`. All the methods mapped here are
    // known, so each is registered with `handleServerNotification`. The shared
    // `mapNotification` body is reused by the unknown fallback for any future
    // method that joins the schema.
    const mapNotification = (method: string, params: unknown) =>
      Effect.gen(function* () {
        switch (method) {
          case 'thread/started': {
            // The notification's `thread.id` is the native thread id; capture it
            // for turn/start, turn/steer and turn/interrupt. Emit both
            // app_thread.created (the app-thread exists) and provider_thread.updated
            // (the native thread backing it).
            const thread = (params as { thread?: { id?: unknown } } | undefined)?.thread;
            if (typeof thread?.id === 'string') {
              yield* Ref.set(nativeThreadId, thread.id);
              const now = new Date();
              yield* Queue.offer(queue, {
                type: 'provider_thread.updated',
                driver: CODEX_DRIVER_KIND,
                providerThread: {
                  id: thread.id as never,
                  driver: CODEX_DRIVER_KIND,
                  providerInstanceId: input.instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: null,
                  ownerNodeId: null,
                  nativeThreadRef: thread.id as never,
                  nativeConversationHeadRef: null,
                  status: 'idle',
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  createdAt: now,
                  updatedAt: now,
                },
              } as never);
            }
            yield* Queue.offer(queue, {
              type: 'app_thread.created',
              driver: CODEX_DRIVER_KIND,
              appThread: params as never,
            });
            break;
          }
          case 'thread/status/changed': {
            yield* Queue.offer(queue, {
              type: 'provider_session.updated',
              driver: CODEX_DRIVER_KIND,
              providerSession: params as never,
            });
            break;
          }
          case 'turn/started': {
            // turn/started → provider_turn.updated (status running). The turn id
            // is the native turn ref; its ordinal is per-thread (we keep a
            // running count below; the app assigns the real ordinal in step 3).
            const turn = (params as { turn?: { id?: unknown; status?: unknown } } | undefined)?.turn;
            if (typeof turn?.id === 'string') {
              yield* Queue.offer(queue, {
                type: 'provider_turn.updated',
                driver: CODEX_DRIVER_KIND,
                providerTurn: {
                  id: turn.id as never,
                  providerThreadId: (yield* Ref.get(nativeThreadId)) as never,
                  nodeId: '' as never,
                  runAttemptId: null,
                  nativeTurnRef: turn.id as never,
                  ordinal: 0,
                  status: 'running',
                  startedAt: null,
                  completedAt: null,
                },
              } as never);
            }
            break;
          }
          case 'turn/completed': {
            // turn/completed → turn.terminal (completed/interrupted/failed) and
            // provider_turn.updated. Codex status maps: completed→completed,
            // interrupted→interrupted, failed→failed, inProgress→ (no terminal).
            const turn = (params as {
              turn?: { id?: unknown; status?: unknown; startedAt?: unknown; completedAt?: unknown };
            } | undefined)?.turn;
            const status = turn?.status;
            if (typeof turn?.id === 'string' && status === 'completed') {
              yield* Queue.offer(queue, {
                type: 'turn.terminal',
                driver: CODEX_DRIVER_KIND,
                providerThreadId: (yield* Ref.get(nativeThreadId)) as never,
                providerTurnId: turn.id as never,
                runOrdinal: 1,
                status: 'completed',
                failure: null,
                threadDisposition: 'reusable',
              } as never);
            }
            break;
          }
          case 'thread/reverted': {
            // thread/reverted → provider_thread.updated. Codex emits this after a
            // thread/revert replaces the durable history with a prefix; the app
            // treats it as the thread backing the session changing state.
            yield* Queue.offer(queue, {
              type: 'provider_thread.updated',
              driver: CODEX_DRIVER_KIND,
              providerThread: {
                id: (yield* Ref.get(nativeThreadId)) as never,
                driver: CODEX_DRIVER_KIND,
                providerInstanceId: input.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: null,
                ownerNodeId: null,
                nativeThreadRef: (yield* Ref.get(nativeThreadId)) as never,
                nativeConversationHeadRef: null,
                status: 'idle',
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            } as never);
            break;
          }
          case 'item/started':
          case 'item/completed': {
            // item/started, item/completed → turn_item.updated. The item's id,
            // type and status are the fields step 3 persists as a thread event.
            const item = (params as { item?: { id?: unknown; type?: unknown } } | undefined)?.item;
            if (typeof item?.id === 'string') {
              yield* Queue.offer(queue, {
                type: 'turn_item.updated',
                driver: CODEX_DRIVER_KIND,
                turnItem: params as never,
              } as never);
            }
            break;
          }
          case 'item/agentMessage/delta': {
            // A streaming delta of the agent's message text. The full message
            // arrives in item/completed; this delta is for live display only.
            yield* Queue.offer(queue, {
              type: 'message.updated',
              driver: CODEX_DRIVER_KIND,
              message: params as never,
            } as never);
            break;
          }
          case 'command/exec/outputDelta': {
            // A chunk of a command's stdout/stderr. Maps to command_output.delta
            // for the run's live progress; the threadId/itemId come from params.
            yield* Queue.offer(queue, {
              type: 'command_output.delta',
              driver: CODEX_DRIVER_KIND,
              threadId: ((params as { threadId?: unknown } | undefined)?.threadId ?? '') as never,
              itemId: ((params as { turnId?: unknown } | undefined)?.turnId ?? '') as never,
              chunk: (params as { delta?: unknown } | undefined)?.delta ?? '',
            } as never);
            break;
          }
          case 'thread/tokenUsage/updated': {
            // Usage is logged by the gateway (step 6); the adapter forwards it
            // as a provider_turn.updated with token counts when present.
            yield* Queue.offer(queue, params as never);
            break;
          }
          default:
            // Ignored: a notification with no ProviderAdapterV2 mapping yet
            // (skills, fs, project, account, mcpServer, thread/compacted …).
            break;
        }
      });

    // Known notifications: the client decodes the payload, then calls the
    // handler with the typed value. Each is registered per method.
    yield* input.client.handleServerNotification('thread/started', (p) => mapNotification('thread/started', p));
    yield* input.client.handleServerNotification('thread/status/changed', (p) =>
      mapNotification('thread/status/changed', p),
    );
    yield* input.client.handleServerNotification('turn/started', (p) => mapNotification('turn/started', p));
    yield* input.client.handleServerNotification('turn/completed', (p) => mapNotification('turn/completed', p));
    yield* input.client.handleServerNotification('thread/reverted', (p) => mapNotification('thread/reverted', p));
    yield* input.client.handleServerNotification('item/started', (p) => mapNotification('item/started', p));
    yield* input.client.handleServerNotification('item/completed', (p) => mapNotification('item/completed', p));
    yield* input.client.handleServerNotification('item/agentMessage/delta', (p) =>
      mapNotification('item/agentMessage/delta', p),
    );
    yield* input.client.handleServerNotification('command/exec/outputDelta', (p) =>
      mapNotification('command/exec/outputDelta', p),
    );
    yield* input.client.handleServerNotification('thread/tokenUsage/updated', (p) =>
      mapNotification('thread/tokenUsage/updated', p),
    );

    // Unknown notifications (anything not yet in the generated schema) fall
    // through here so future codex methods are mapped when added.
    yield* input.client.handleUnknownServerNotification((method: string, params: unknown) =>
      mapNotification(method, params),
    );

    // CB-326 step 4: the codex app-server's runtime-request server-requests
    // (item/commandExecution/requestApproval, item/fileChange/requestApproval,
    // item/permissions/requestApproval, mcpServer/elicitation/request) are
    // synchronous, but ProviderAdapterV2 is async (a runtime_request.updated
    // event streams out, the host responds later via respondToRuntimeRequest).
    // The bridge: the handler emits the event, awaits a Deferred, and
    // respondToRuntimeRequest resolves it. Each handler returns the codex
    // response shape for its method; the codex decision unions have no
    // `acceptAlways` (T3 collapses it to `acceptForSession`, mirroring T3's
    // CodexAdapterV2). file-read has no dedicated server-request: in codex,
    // reads flow through `item/permissions/requestApproval`, so the kind is
    // derived from the permission profile (write → file-change, read →
    // file-read, else command) as T3's `providerRequestKindFromPermissions`.
    const emitRuntimeRequest = (
      requestKind: 'command' | 'file-read' | 'file-change' | 'mcp-elicitation' | 'permission',
      requestId: string,
      threadId: string | undefined,
      payload: unknown,
    ) =>
      Effect.gen(function* () {
        const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
        yield* Ref.update(pendingRuntimeRequests, (current) => {
          const updated = new Map(current);
          updated.set(requestId, { requestKind, decision });
          return updated;
        });
        // Emit the runtime_request.updated event the host turns into a Socio
        // approval card. The payload carries the action.
        yield* Queue.offer(queue, {
          type: 'runtime_request.updated',
          driver: CODEX_DRIVER_KIND,
          threadId: (threadId ?? null) as never,
          runtimeRequest: {
            id: requestId as never,
            kind: requestKind as never,
            status: 'pending' as never,
            payload: payload as never,
          } as never,
        } as never);
        return decision;
      });

    const awaitDecision = (requestId: string, decision: Deferred.Deferred<ProviderApprovalDecision, never>) =>
      Deferred.await(decision).pipe(
        Effect.ensuring(
          Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.delete(requestId);
            return updated;
          }),
        ),
      );

    // item/commandExecution/requestApproval → command (T3 line 5197).
    yield* input.client.handleServerRequest(
      'item/commandExecution/requestApproval',
      (raw: unknown) =>
        Effect.gen(function* () {
          const payload = raw as {
            threadId?: string;
            turnId?: string;
            itemId?: string;
            approvalId?: string;
            command?: string;
            reason?: string;
          };
          const requestId = String(payload.approvalId ?? payload.itemId ?? cryptoId());
          const decision = yield* emitRuntimeRequest(
            'command',
            requestId,
            payload.threadId,
            { command: payload.command ?? payload.reason ?? '' },
          );
          const resolved = yield* awaitDecision(requestId, decision);
          return {
            decision: resolved === 'acceptAlways' ? 'acceptForSession' : resolved,
          } satisfies { decision: ProviderApprovalDecision };
        }),
    );

    // item/fileChange/requestApproval → file-change (T3 line 5268). The native
    // id is the itemId; the change kinds (item/started's `fileChange`) are not
    // carried here — Socio's card shows the reason, if any.
    yield* input.client.handleServerRequest(
      'item/fileChange/requestApproval',
      (raw: unknown) =>
        Effect.gen(function* () {
          const payload = raw as {
            threadId?: string;
            turnId?: string;
            itemId?: string;
            reason?: string;
            grantRoot?: string | null;
          };
          const requestId = String(payload.itemId ?? cryptoId());
          const decision = yield* emitRuntimeRequest(
            'file-change',
            requestId,
            payload.threadId,
            { reason: payload.reason ?? payload.grantRoot ?? '' },
          );
          const resolved = yield* awaitDecision(requestId, decision);
          return {
            decision: resolved === 'acceptAlways' ? 'acceptForSession' : resolved,
          } satisfies { decision: ProviderApprovalDecision };
        }),
    );

    // item/permissions/requestApproval → file-read/file-change/permission (T3
    // line 5340). The kind is derived from the requested permission profile:
    // write → file-change, read → file-read, else command. The response grants
    // the requested permissions on accept (session-scoped on acceptForSession),
    // or an empty profile on decline/cancel (T3's permissionsResponseFromDecision).
    yield* input.client.handleServerRequest(
      'item/permissions/requestApproval',
      (raw: unknown) =>
        Effect.gen(function* () {
          const payload = raw as {
            threadId?: string;
            turnId?: string;
            itemId?: string;
            reason?: string | null;
            permissions?: {
              fileSystem?: {
                read?: ReadonlyArray<string> | null;
                write?: ReadonlyArray<string> | null;
                entries?: ReadonlyArray<{ access?: string }> | null;
              } | null;
            } | null;
          };
          const has = (access: 'read' | 'write') =>
            (payload.permissions?.fileSystem?.[access]?.length ?? 0) > 0 ||
            (payload.permissions?.fileSystem?.entries?.some((e) => e?.access === access) ?? false);
          const requestKind: 'file-read' | 'file-change' | 'command' = has('write')
            ? 'file-change'
            : has('read')
              ? 'file-read'
              : 'command';
          const requestId = String(payload.itemId ?? cryptoId());
          const decision = yield* emitRuntimeRequest(
            requestKind,
            requestId,
            payload.threadId,
            { reason: payload.reason ?? '' },
          );
          const resolved = yield* awaitDecision(requestId, decision);
          if (resolved !== 'accept' && resolved !== 'acceptForSession' && resolved !== 'acceptAlways') {
            return { permissions: {}, scope: 'turn' as const } as never;
          }
          return {
            permissions: (payload.permissions ?? {}) as Record<string, unknown>,
            scope: (resolved === 'acceptForSession' || resolved === 'acceptAlways' ? 'session' : 'turn') as
              | 'turn'
              | 'session',
          } as never;
        }),
    );

    // mcpServer/elicitation/request → mcp-elicitation (T3 line 5401). The
    // response is built from the form's defaults on accept; url-mode and
    // unfilled-required elicitations are declined (toMcpElicitationResponse).
    yield* input.client.handleServerRequest(
      'mcpServer/elicitation/request',
      (raw: unknown) =>
        Effect.gen(function* () {
          const payload = raw as EffectCodexSchema.McpServerElicitationRequestParams & {
            threadId?: string;
          };
          const requestId = `mcp-elicitation:${payload.serverName}`;
          const decision = yield* emitRuntimeRequest(
            'mcp-elicitation',
            requestId,
            payload.threadId,
            { message: payload.message, serverName: payload.serverName, mode: payload.mode },
          );
          const resolved = yield* awaitDecision(requestId, decision);
          return toMcpElicitationResponse(payload, resolved);
        }),
    );

    const events: Stream.Stream<ProviderAdapter.ProviderAdapterV2Event> = Stream.fromQueue(queue);

    // The model name from a ModelSelection (providerThread carries the chosen
    // model; modelSelection its id). Codex takes a model string on thread/start
    // and turn/start.
    const modelOf = (selection: { readonly model?: string } | undefined): string | undefined =>
      selection?.model;

    // Build a ProviderThread from the native thread id + the codex response.
    const providerThreadOf = (nativeId: string): OrchestrationV2ProviderThread =>
      ({
        providerThreadId: nativeId as never,
        providerSessionId: input.providerSessionId,
        providerInstanceId: input.instanceId,
        driver: CODEX_DRIVER_KIND,
      }) as never;

    return {
      instanceId: input.instanceId,
      driver: CODEX_DRIVER_KIND,
      providerSessionId: input.providerSessionId,
      providerSession: input.providerSession,
      events,
      ensureThread: (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) =>
        Effect.gen(function* () {
          // Resume an existing native thread, else start a new one. The native
          // id is captured from the response (and the thread/started notification).
          const existing = threadInput.existingProviderThread;
          if (existing && threadInput.forceNewNativeThread !== true) {
            const nativeId = String(
              (existing as { providerThreadId?: unknown }).providerThreadId ?? '',
            );
            yield* Ref.set(nativeThreadId, nativeId);
            return providerThreadOf(nativeId);
          }
          const response = (yield* input.client.request('thread/start', {
            model: modelOf(threadInput.modelSelection as never) ?? null,
            cwd: threadInput.title ?? null,
          } as never)) as { thread?: { id?: unknown } };
          const nativeId =
            typeof response?.thread?.id === 'string' ? response.thread.id : cryptoId();
          yield* Ref.set(nativeThreadId, nativeId);
          return providerThreadOf(nativeId);
        }),
      resumeThread: (resumeInput: {
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly threadId?: ThreadId;
      }) =>
        Effect.gen(function* () {
          const nativeId = String(
            (resumeInput.providerThread as { providerThreadId?: unknown }).providerThreadId ?? '',
          );
          yield* Ref.set(nativeThreadId, nativeId);
          return resumeInput.providerThread;
        }),
      startTurn: (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Effect.gen(function* () {
          const threadId = yield* Ref.get(nativeThreadId);
          if (threadId === null) {
            return yield* notImplemented('startTurn (no native thread)');
          }
          yield* input.client.request('turn/start', {
            threadId,
            input: [{ type: 'text', text: turnInput.message.text ?? '' }],
            model: modelOf(turnInput.modelSelection as never) ?? null,
          } as never);
        }),
      steerTurn: (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) =>
        Effect.gen(function* () {
          const threadId = yield* Ref.get(nativeThreadId);
          if (threadId === null) {
            return yield* notImplemented('steerTurn (no native thread)');
          }
          yield* input.client.request('turn/steer', {
            threadId,
            expectedTurnId: String(steerInput.providerTurnId ?? ''),
            input: [{ type: 'text', text: steerInput.message.text ?? '' }],
          } as never);
        }),
      interruptTurn: (interruptInput: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
        Effect.gen(function* () {
          const threadId = yield* Ref.get(nativeThreadId);
          if (threadId === null) {
            return yield* notImplemented('interruptTurn (no native thread)');
          }
          yield* input.client.request('turn/interrupt', {
            threadId,
            turnId: String(interruptInput.providerTurnId ?? ''),
          } as never);
        }),
      respondToRuntimeRequest: (runtimeInput: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) =>
        Effect.gen(function* () {
          // Resolve the pending Deferred for this request id with the host's
          // decision, unblocking the server-request handler (CB-326 step 4).
          const id = String(runtimeInput.requestId);
          const pending = yield* Ref.modify(pendingRuntimeRequests, (current) => {
            const entry = current.get(id);
            const updated = new Map(current);
            updated.delete(id);
            return [entry, updated] as const;
          });
          if (!pending) {
            return yield* notImplemented('respondToRuntimeRequest (no pending request)');
          }
          yield* Deferred.succeed(pending.decision, runtimeInput.decision ?? 'decline');
        }),
      readThreadSnapshot: (
        snapshotInput: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput,
      ) =>
        Effect.gen(function* () {
          // Codex exposes no single `thread/snapshot`; a snapshot is assembled
          // from `thread/read` (metadata) + `thread/turns/list` (paginated turns),
          // mirroring how T3's opencode adapter reads `session.read` + `message.list`.
          // Messages/runtimeRequests are left empty — the app reconstructs them
          // from the thread events it already persisted; the snapshot's load-bearing
          // field for rollback/fork boundary selection is `providerTurns`.
          const nativeId = String(
            (snapshotInput.providerThread as { providerThreadId?: unknown }).providerThreadId ?? '',
          );
          yield* input.client.request('thread/read', { threadId: nativeId } as never);
          const turnsResponse = (yield* input.client.request('thread/turns/list', {
            threadId: nativeId,
            sortDirection: 'asc',
            limit: 100,
          } as never)) as {
            data?: ReadonlyArray<{
              id?: unknown;
              status?: unknown;
              startedAt?: unknown;
              completedAt?: unknown;
            }>;
            nextCursor?: string | null;
          };
          const turns = (turnsResponse.data ?? []).map((turn, index) => ({
            id: String(turn.id ?? '') as never,
            providerThreadId: nativeId as never,
            nodeId: '' as never,
            runAttemptId: null,
            nativeTurnRef: String(turn.id ?? '') as never,
            ordinal: index + 1,
            status: (turn.status === 'completed'
              ? 'completed'
              : turn.status === 'interrupted'
                ? 'interrupted'
                : turn.status === 'failed'
                  ? 'failed'
                  : 'running') as never,
            startedAt: null,
            completedAt: null,
          })) as never;
          return {
            providerThread: snapshotInput.providerThread,
            providerTurns: turns,
            messages: [],
            runtimeRequests: [],
          } as never;
        }),
      rollbackThread: (rollbackInput: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
        Effect.gen(function* () {
          // Codex's `thread/revert` replaces the durable conversation history
          // with the prefix before `beforeTurnId`. It does NOT revert local
          // file changes — that matches T3's "Leave files to T3 checkpoints"
          // design (opencode adapter, line 2883). The app layer owns filesystem
          // checkpoints; this adapter reverts the conversation only.
          const nativeId = String(
            (rollbackInput.providerThread as { providerThreadId?: unknown }).providerThreadId ?? '',
          );
          // Find the native turn id to revert before. For a `thread_start`
          // target, revert before the first known turn (the earliest in
          // providerThreadTurns); for a `provider_turn` target, use that turn.
          const target = rollbackInput.target;
          let beforeTurnId: string;
          if (target.type === 'provider_turn') {
            beforeTurnId = String(
              (target.providerTurn as { nativeTurnRef?: { nativeId?: unknown }; id?: unknown })
                .nativeTurnRef?.nativeId ??
                (target.providerTurn as { id?: unknown }).id ??
                '',
            );
          } else {
            const first = rollbackInput.providerThreadTurns[0];
            beforeTurnId = String(
              (first as { nativeTurnRef?: { nativeId?: unknown }; id?: unknown } | undefined)
                ?.nativeTurnRef?.nativeId ??
                (first as { id?: unknown } | undefined)?.id ??
                '',
            );
          }
          if (!beforeTurnId) {
            return yield* notImplemented('rollbackThread (no native turn boundary)');
          }
          yield* Ref.set(nativeThreadId, nativeId);
          yield* input.client.request('thread/revert', {
            threadId: nativeId,
            beforeTurnId,
          } as never);
          // The thread/reverted notification emits provider_thread.updated; the
          // snapshot returned here is the post-revert state (turns after the
          // boundary are gone).
          return {
            providerThread: rollbackInput.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          } as never;
        }),
      forkThread: (forkInput: ProviderAdapter.ProviderAdapterV2ForkThreadInput) =>
        Effect.gen(function* () {
          // Codex's `thread/fork` creates a new native thread from the source,
          // optionally through `lastTurnId` (inclusive). ACP can only fork the
          // session head; codex can fork through a turn (canForkFromTurn: true).
          const sourceNativeId = String(
            (forkInput.sourceProviderThread as { providerThreadId?: unknown }).providerThreadId ?? '',
          );
          const lastTurnId =
            forkInput.providerTurnId != null
              ? String(forkInput.providerTurnId)
              : (forkInput.sourceProviderTurns?.[0] as { id?: unknown } | undefined)?.id != null
                ? String((forkInput.sourceProviderTurns![0] as { id?: unknown }).id)
                : null;
          const forked = (yield* input.client.request('thread/fork', {
            threadId: sourceNativeId,
            lastTurnId,
            model: modelOf(forkInput.modelSelection as never) ?? null,
            cwd: null,
            ephemeral: false,
          } as never)) as { thread?: { id?: unknown } };
          const forkedNativeId =
            typeof forked?.thread?.id === 'string' ? forked.thread.id : cryptoId();
          return {
            providerThreadId: forkedNativeId as never,
            providerSessionId: input.providerSessionId,
            providerInstanceId: input.instanceId,
            driver: CODEX_DRIVER_KIND,
            nativeThreadRef: forkedNativeId as never,
            forkedFrom: {
              providerThreadId: sourceNativeId as never,
              providerTurnId: (forkInput.providerTurnId ?? null) as never,
            },
          } as never;
        }),
    } as never as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  },
);

/**
 * The `ProviderAdapterV2` service: `openSession` starts a codex app-server
 * session and returns the runtime; `getCapabilities` reports the codex
 * adapter's reach (the full set once fork/rollback/MCP land).
 */
export const makeAdapter = Effect.fn('CodexAdapter.make')(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly client: CodexClient.CodexAppServerClient['Service'];
}) {
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: input.instanceId,
    driver: CODEX_DRIVER_KIND,
    getCapabilities: () =>
      Effect.succeed({
        sessions: {
          supportsMultipleProviderThreadsPerSession: true,
          supportsModelSwitchInSession: true,
          supportsProviderSwitchingViaHandoff: false,
          supportsRuntimeModeSwitchInSession: false,
          pendingRequestsSurviveRestart: false,
        },
        threads: {
          canCreateEmptyThread: true,
          canReadThreadSnapshot: true,
          canRollbackThread: true,
          canForkThread: true,
          canForkFromTurn: true,
          canForkFromSubagentThread: false,
          exposesNativeThreadId: true,
        },
        turns: {
          exposesNativeTurnId: true,
          emitsTurnStarted: true,
          emitsTurnCompleted: true,
          supportsInterrupt: true,
          supportsActiveSteering: true,
          activeSteeringInterruptsTools: false,
          supportsSteeringByInterruptRestart: true,
          supportsQueuedMessages: true,
          terminalStatusQuality: 'strong',
        },
        streaming: {
          streamsAssistantText: true,
          streamsReasoning: false,
          streamsToolOutput: true,
          streamsPlanText: false,
          emitsMessageCompleted: true,
        },
        tools: {
          exposesToolItemIds: true,
          emitsToolStarted: true,
          emitsToolCompleted: true,
          emitsToolOutput: true,
          supportsMcpTools: true,
          supportsDynamicToolCallbacks: false,
        },
        approvals: {
          supportsCommandApproval: true,
          supportsFileReadApproval: true,
          supportsFileChangeApproval: true,
          supportsApplyPatchApproval: true,
          approvalsHaveNativeRequestIds: true,
          approvalCallbacksAreLiveOnly: true,
          approvalsCanOriginateFromSubagents: false,
        },
        planning: {
          emitsPlanUpdated: false,
          emitsTodoList: false,
          emitsProposedPlan: false,
          supportsStructuredQuestions: false,
          planDeltasHaveItemIds: false,
        },
        subagents: {
          supportsSubagents: false,
          exposesSubagentThreadIds: false,
          emitsSubagentLifecycle: false,
          canWaitForSubagents: false,
          canCloseSubagents: false,
          canForkSubagentThread: false,
        },
        context: {
          acceptsSystemContext: true,
          acceptsDeveloperContext: true,
          acceptsSyntheticUserContext: true,
          canGenerateSummaries: false,
          canConsumeHandoffSummaries: false,
          supportsDeltaHandoff: false,
          supportsFullThreadHandoff: false,
          maxRecommendedHandoffChars: null,
        },
        checkpointing: {
          // Codex's thread/revert reverts conversation history only, not files.
          // Filesystem checkpoints are the app layer's job (T3's design: "Leave
          // files to T3 checkpoints"). providerRollbackReturnsSnapshot: true —
          // rollbackThread returns a ProviderAdapterV2ThreadSnapshot.
          appCanCheckpointFilesystem: true,
          supportsNestedCheckpointScopes: false,
          providerCanRollbackConversation: true,
          providerRollbackReturnsSnapshot: true,
          providerCanReadConversationSnapshot: true,
        },
        identity: {
          nativeThreadIds: 'strong',
          nativeTurnIds: 'strong',
          nativeItemIds: 'strong',
          nativeRequestIds: 'strong',
        },
        runtimePolicy: { enforcement: 'client-boundary' },
      } as never),
    planSelectionTransition: () => notImplemented('planSelectionTransition') as never,
    openSession: (
      sessionInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) =>
      Effect.gen(function* () {
        const providerSession: OrchestrationV2ProviderSession = {
          providerSessionId: sessionInput.providerSessionId,
          providerInstanceId: input.instanceId,
          driver: CODEX_DRIVER_KIND,
          status: 'starting',
        } as never;
        return (yield* makeSessionRuntime({
          instanceId: input.instanceId,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          client: input.client,
        })) as never;
      }) as never,
  }) as never;
});

export type CodexProviderThreadId = ProviderThreadId;
export type CodexProviderTurn = OrchestrationV2ProviderTurn;
