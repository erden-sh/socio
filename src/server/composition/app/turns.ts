/**
 * The turns edge (`AppTurns`): the chat's runtime requests (`handle`), a
 * socio's turn (`turn`, `turnOutcome`), `history` and `requireReady`, and the
 * request senders' map, read through the tag. Built after every service it
 * reads (`composition/index.ts`, after `liveLayers.counters`); it fills
 * `ports.turns` for the steps built before it, and registers no listener, so
 * the graph's order doesn't change.
 */
import type { CopilotHonoApp } from '@copilotkit/runtime/v2';
import { Context, Effect, Layer } from 'effect';

import { TURN_FAILURE_MESSAGES, reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import type { InferencePurpose } from '@socio/foundation/turns/inference-purpose';
import { acceptedMessages, openClientCalls, senderOf } from '@socio/foundation/workspace/client-messages';
import { isApprovalNote } from '@socio/shared/approvals';
import { THREAD_RUNNING_CODE, THREAD_RUNNING_MESSAGE } from '@socio/shared/chat/thread-running';
import { legacyMediaStream, wantsLegacyMedia } from '@socio/shared/media/legacy-media';
import { ContentError, checkNewUserContent } from '@socio/shared/media/refs';
import { ROOM_DENIAL_MESSAGES, turnContextProblems } from '@socio/shared/rooms/rooms';
import type { RunActor } from '@socio/shared/runs/run-trace';
import { TIME_ZONE_HEADER } from '@socio/shared/time-zone';
import type { AgentRunSource } from '@socio/shared/types';

import type { ApprovalService } from '../../approvals/service.js';
import { steeringQueue } from '../../context/steering.js';
import type { WorkCycles } from '../../cycles/service.js';
import type { DotExtensions, DotTurnServices } from '../../dots/contract.js';
import { DotAgentCore } from '../../dots/dot-agent.js';
import type { InferenceService } from '../../inference/service.js';
import type { MediaService } from '../../media/service.js';
import { rememberBrowserTimeZone } from '../../memory/time-zone.js';
import { roomReaderEvents } from '../../rooms/reader-events.js';
import type { RoomStreams } from '../../rooms/streams.js';
import { drainingResponse } from '../../runtime/shutdown.js';
import type { PlatformTurnOptions, RuntimeScope, TurnOutcome } from '../../turns/contract.js';
import { runThreadTurnOutcome } from '../../turns/headless.js';
import type { LocalAgentRunner } from '../../turns/local-runner.js';
import { validateRuntimeScope } from '../../turns/runtime-scope.js';
import { conversationStream } from '../../workspace/conversation-stream.js';
import { LegacyApprovals } from '../approvals.js';
import { LegacyConfig, LegacyRunner, LegacyStore, LegacyWorkspace } from '../base.js';
import type { PlatformConfig } from '../config.js';
import { dotTurnStoreOf, type CoreStore } from '../core-store.js';
import { LegacyCycles } from '../cycles.js';
import { LegacyDotExtensions, LegacyRuntimeHandler } from '../dots.js';
import { LegacyInference } from '../inference.js';
import { LegacyMedia } from '../media.js';
import { Ports, type PlatformPorts, type TurnsShape } from '../ports.js';
import { LegacyRoomStreams } from '../rooms.js';
import type { AppWorkspace } from '../workspace-parts.js';

import { historyOf } from './conversations.js';
import { AppDotTurnServices } from './dot-turns.js';

/**
 * Who sent each runtime request (`handle`), for its agent list, and when
 * it came (CB-185: a turn's queue time). The one map: `handle` writes it
 * and `RequestSenders` (the root's tag, `composition/root.ts`) reads it.
 */
export const requestUsers = new WeakMap<Request, { userId: string; receivedAt: number }>();

/**
 * The most one message a run introduces may take, as JSON (CB-156): the
 * person's text, or anything else a client sends that the conversation
 * hasn't stored. A chat's request may be far larger (a tab opened before
 * CB-156 sends the whole stored conversation, which passes), but what a
 * run stores anew stays bounded.
 */
export const NEW_MESSAGE_BYTES = 1_000_000;

/**
 * A run request as the runtime gets it (CB-225): its thread, run id and
 * tools, `messages` for the request's, and nothing else of the client's.
 * No context or state, which the model would read as system prompts; no
 * forwarded props, which switch runtime features; no `resume`, which the
 * agent would give the model as tool results. The app sends none of them:
 * its client has no readable context, generative UI, shared agent state
 * or interrupts.
 */
function runRequest(request: Request, body: object, messages: unknown) {
    const { threadId, runId, tools } = body as Record<string, unknown>;
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    return new Request(request.url, {
        method: request.method,
        headers,
        body: JSON.stringify({
            threadId,
            runId,
            messages,
            tools,
            context: [],
            state: {},
            forwardedProps: {},
        }),
        signal: request.signal,
    });
}

/** Whether `messages` brings a person's message not yet in `known`. */
function hasNewMessage(messages: unknown, known: ReadonlySet<string>) {
    return (
        Array.isArray(messages) &&
        messages.some(
            (message: { id?: unknown; role?: unknown } | null) =>
                message?.role === 'user' && !(typeof message.id === 'string' && known.has(message.id)),
        )
    );
}

/** Whether a run request answers an interrupt (`resume`), which none has. */
function resumes(body: unknown) {
    const resume = (body as { resume?: unknown } | null)?.resume;
    return Array.isArray(resume) ? resume.length > 0 : resume != null;
}

/** Whether `messages` brings one, not yet in `known`, over the bound. */
function oversizedNewMessage(messages: unknown, known: ReadonlySet<string>) {
    return (
        Array.isArray(messages) &&
        messages.some(
            (message: { id?: unknown } | null) =>
                !(typeof message?.id === 'string' && known.has(message.id)) &&
                Buffer.byteLength(JSON.stringify(message) ?? '') > NEW_MESSAGE_BYTES,
        )
    );
}

/** The turns edge: `ports.turns`'s shape, and the chat's runtime requests. */
export interface AppTurnsShape extends TurnsShape {
    /** Serves the runtime for a signed-in user; threads must be theirs. */
    handle(request: Request, userId: string): Promise<Response>;
}

/** The turns edge (`composition/app/turns.ts`), one per runtime. */
export class AppTurns extends Context.Service<AppTurns, AppTurnsShape>()('socio/composition/app/AppTurns') {}

/** What the turns edge reads, each the graph's one instance. */
interface TurnsSources {
    readonly store: CoreStore;
    readonly workspace: AppWorkspace;
    readonly config: PlatformConfig;
    readonly runner: LocalAgentRunner;
    readonly cycles: WorkCycles;
    readonly media: MediaService;
    readonly approvals: ApprovalService;
    readonly roomStreams: RoomStreams;
    readonly inference: InferenceService;
    readonly dotExtensions: DotExtensions;
    /** What a Dot's turns call of other features (`AppDotTurnServices`). */
    readonly dotServices: DotTurnServices;
    readonly handler: CopilotHonoApp;
    /** `draining` and `setup`, read at the moment of use. */
    readonly ports: Pick<PlatformPorts, 'draining' | 'setup'>;
}

/** The turns edge over its sources, behind `AppTurns`. */
export function appTurns(sources: TurnsSources): AppTurnsShape {
    const { store, workspace, config, runner, cycles, media, approvals, roomStreams, handler, ports } = sources;
    const requireReady = async () => {
        const missing = (await ports.setup.get().setup()).missing;
        if (missing.length) {
            throw new Error(`Setup required: ${missing.join(', ')}. Configure the model in the server environment.`);
        }
    };
    // `ConversationAdmin.history`'s implementation (`composition/app/conversations.ts`).
    const history = historyOf({ workspace, runner });
    const forgedNote = async (body: unknown) => {
        const { threadId, messages } = (body ?? {}) as {
            threadId?: unknown;
            messages?: unknown;
        };
        if (!Array.isArray(messages) || typeof threadId !== 'string') {
            return false;
        }
        for (const message of messages as Array<{
            id?: unknown;
            content?: unknown;
            metadata?: unknown;
        }>) {
            if (
                !!message &&
                isApprovalNote(message) &&
                !(typeof message.id === 'string' && (await approvals.isNote(message.id, threadId, message.content)))
            ) {
                return true;
            }
        }
        return false;
    };
    const handle = async (request: Request, userId: string): Promise<Response> => {
        const receivedAt = Date.now();
        // COMPAT(ag-ui-1.0): a client that doesn't say it reads AG-UI 1.0's
        // media parts (the native app builds already shipped) gets its
        // stream's attachments as the pre-1.0 reference. Remove with
        // `@socio/shared/media/legacy-media`.
        const legacy = wantsLegacyMedia(request.headers);
        const forClient = (response: Response) => (legacy ? legacyMediaStream(response) : response);
        let body: unknown;
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            body = await request
                .clone()
                .json()
                .catch(() => null);
        }
        let scope: RuntimeScope;
        try {
            scope = validateRuntimeScope(request, workspace, body, userId);
        } catch (error) {
            return Response.json(
                {
                    error: error instanceof Error ? error.message : 'Conversation scope denied.',
                },
                { status: 403 },
            );
        }
        // A room's stream, for this member as the rule lets them see it
        // (CB-212): their own, closed when their access ends.
        if (scope.room && scope.action === 'read' && scope.threadId) {
            return forClient(
                conversationStream({
                    runner,
                    streams: roomStreams,
                    readerEvents: roomReaderEvents,
                    threadId: scope.threadId,
                    reader: userId,
                    room: true,
                    signal: request.signal,
                    mode: {
                        kind: 'connect',
                        headers: Object.fromEntries(request.headers),
                    },
                }),
            );
        }
        // In a room, Stop is the running cycle's initiator's or an admin's
        // (CB-208).
        if (
            scope.room &&
            scope.action === 'stop' &&
            scope.threadId &&
            !(await cycles.mayStop(scope.threadId, userId))
        ) {
            return Response.json({ error: ROOM_DENIAL_MESSAGES.not_initiator, code: 'not_initiator' }, { status: 403 });
        }
        const run = /^\/api\/copilotkit\/agent\/[^/]+\/run$/.test(new URL(request.url).pathname);
        if (run && ports.draining.get()) {
            return drainingResponse();
        }
        // Approval notes are the server's to write (CB-58): one a client sends
        // must be one this conversation got from it, unchanged.
        if (run && (await forgedNote(body))) {
            return Response.json(
                {
                    error: 'This conversation holds a note Socio did not write.',
                },
                { status: 403 },
            );
        }
        // Socio's turns never wait on an interrupt (CB-225): an answer to one
        // would reach the model as a tool's result the conversation never
        // stored.
        if (run && resumes(body)) {
            return Response.json(
                { error: 'This conversation has no question waiting for an answer.' },
                { status: 403 },
            );
        }
        // The messages the runtime gets, when not the request's own (CB-225).
        let messagesTaken: unknown[] | undefined;
        // New messages carry attachment references, never bytes (CB-54, CB-7).
        if (run && body && typeof body === 'object') {
            try {
                const { threadId, messages } = body as {
                    threadId?: unknown;
                    messages?: unknown;
                };
                if (typeof threadId === 'string') {
                    const known = runner.knownMessageIds(threadId);
                    // The chat says this one is too long and gives its text back.
                    if (oversizedNewMessage(messages, known)) {
                        return Response.json({ error: 'This message is too long to send.' }, { status: 413 });
                    }
                    checkNewUserContent(messages, known);
                    // validateRuntimeScope checked the thread is this user's.
                    const thread = workspace.requireThread(threadId);
                    // The chat's messages a minute (CB-211): turned away here, with
                    // the text kept in the box, rather than stored and refused; the
                    // run's start counts it, and checks again.
                    if (hasNewMessage(messages, known) && !(await cycles.withinRate(threadId))) {
                        return Response.json(
                            {
                                error: TURN_FAILURE_MESSAGES.cycle_rate,
                                code: 'cycle_rate',
                            },
                            { status: 429 },
                        );
                    }
                    // Ids still waiting in the steering queue are the server's to
                    // deliver (CB-223): never a client's new message, nor its files.
                    const queued = await steeringQueue(workspace.db).ids(threadId);
                    await media.bindNew(
                        { userId, dotId: thread.dotId, threadId },
                        messages,
                        new Set([...known, ...queued]),
                    );
                    // Who sent them is the person signed in, and the conversation is
                    // what the runner stored (CB-225): only new messages go on, the
                    // person's, and a review's result. A running turn's messages are
                    // passed over too: the runner refuses the request as the chat is
                    // busy. Both read again after the wait, the running turn's
                    // first: a turn is stored as finished before it stops running,
                    // so one that ends meanwhile is in one set or the other.
                    if (Array.isArray(messages)) {
                        const running = runner.activeMessageIds(threadId);
                        const held = runner.knownMessageIds(threadId);
                        messagesTaken = await acceptedMessages(
                            messages,
                            new Set([...held, ...running]),
                            senderOf(workspace.users(), userId),
                            async () => openClientCalls(await runner.messages(threadId)),
                            queued,
                        );
                        if (!messagesTaken) {
                            return Response.json(
                                {
                                    error: 'This conversation holds a note Socio did not write.',
                                },
                                { status: 403 },
                            );
                        }
                    }
                }
            } catch (error) {
                if (!(error instanceof ContentError)) {
                    throw error;
                }
                return Response.json({ error: error.message }, { status: 400 });
            }
        }
        if (run && body && typeof body === 'object') {
            request = runRequest(request, body, messagesTaken ?? (body as { messages?: unknown }).messages);
        }
        // The conversation's turn is still running, here or on another live
        // runtime (CB-357): refused with a code the clients match, before the
        // run is stored. Checked last, after the waits above, so a turn that
        // ended meanwhile lets the request through. The runner still refuses
        // a run that slips in after this check; this answer is the readable one.
        const runThread =
            run && body && typeof body === 'object' ? (body as { threadId?: unknown }).threadId : undefined;
        if (typeof runThread === 'string' && (await runner.isRunning({ threadId: runThread }))) {
            return Response.json({ error: THREAD_RUNNING_MESSAGE, code: THREAD_RUNNING_CODE }, { status: 409 });
        }
        // The browser's time zone goes to a profile that has none (CB-159), so
        // the person's Telegram, scheduled and job turns get it too, and a
        // detected one follows it (CB-176); not while an admin has turned
        // memory off. Best effort: the turn uses the zone it came with either
        // way, and a failed write never fails the chat.
        if (run && store.slices.settings.settings().memoryAllowed) {
            try {
                await rememberBrowserTimeZone(
                    store.profiles,
                    userId,
                    request.headers.get(TIME_ZONE_HEADER),
                    Date.now(),
                    store.timeZoneNotes,
                );
            } catch (error) {
                reportFailure('Time zone', [safeFailure(error)]);
            }
        }
        requestUsers.set(request, { userId, receivedAt });
        return forClient(await handler.fetch(request));
    };
    /**
     * `turn`, with the run id and token usage; `textOnly` turns have no tools.
     * A channel turn (`actingUserId`) acts for that user, as Telegram's do.
     * A step of an existing work cycle (CB-211: an approval decided, a
     * handoff, CB-206/209) passes its `context`: it runs in that cycle, as
     * its acting person and initiator, with what is left of its budget; a
     * context that breaks the rules (`turnContextProblems`) is refused.
     */
    const turnOutcome = async (
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        options: PlatformTurnOptions = {},
    ): Promise<TurnOutcome> => {
        const receivedAt = options.receivedAt ?? Date.now();
        await requireReady();
        const thread = workspace.requireThread(threadId);
        const { context } = options;
        if (context) {
            const problems = turnContextProblems(context);
            if (context.conversationId !== threadId) {
                problems.push('another conversation');
            }
            // A room's other active socios answer in it too (CB-206: a handoff,
            // a named socio); anywhere else only its own.
            if (
                context.socio.dotId !== thread.dotId &&
                !(thread.kind === 'room' && workspace.answers(threadId, context.socio.dotId))
            ) {
                problems.push('another socio');
            }
            if (problems.length) {
                throw new Error(`Turn context refused: ${problems.join('; ')}.`);
            }
        }
        // The context's acting person, when not the owner, as a channel turn's.
        // In a room, the person whose message or decision started it (CB-208):
        // never the room's sentinel owner.
        const actingUserId = context
            ? context.actingUserId !== thread.ownerId
                ? context.actingUserId
                : undefined
            : (options.actingUserId ??
              (thread.kind === 'room' && options.trigger?.kind === 'person' ? options.trigger.id : undefined));
        const trigger: RunActor =
            context?.initiator ??
            options.trigger ??
            (options.cause
                ? { kind: 'schedule', id: options.cause.id }
                : actingUserId
                  ? { kind: 'person', id: actingUserId }
                  : options.source === 'voice'
                    ? { kind: 'person', id: thread.ownerId }
                    : { kind: 'system' });
        const purpose: InferencePurpose = options.source === 'scheduled' ? options.source : 'chat';
        return runThreadTurnOutcome(
            runner,
            new DotAgentCore(
                sources.dotServices,
                dotTurnStoreOf(store),
                workspace,
                config,
                // The cycle's socio for this step (CB-206), else the chat's own.
                context?.socio.dotId ?? thread.dotId,
                // A channel's turn (a Telegram chat's person); a room's sender
                // acts in the app, with its tools (CB-209).
                !!actingUserId && thread.kind !== 'room',
                actingUserId,
                {
                    ...(context ? { context } : {}),
                    textOnly: options.textOnly,
                    inference: sources.inference,
                    purpose,
                    extensions: sources.dotExtensions,
                    serverPrompt: !options.spoken,
                    ...(options.spoken ? { spoken: true } : {}),
                    ...(options.cause ? { cause: options.cause } : {}),
                },
            ),
            threadId,
            prompt,
            signal,
            options.metadata,
            options.source,
            {
                messageId: options.messageId,
                onStarted: options.onStarted,
                signals: {
                    receivedAt,
                    trigger,
                    ...(context ? { cycleId: context.cycleId, hop: context.hop } : {}),
                    ...(options.news ? { news: true } : {}),
                },
            },
        );
    };
    const turn = async (
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        metadata?: Record<string, unknown>,
        source?: AgentRunSource,
    ): Promise<string> => (await turnOutcome(threadId, prompt, signal, { metadata, source })).text;
    return { handle, turn, turnOutcome, history, requireReady };
}

/** The step, as `composition/index.ts` places it: builds `AppTurns` and fills `ports.turns`. */
export const appTurnsLayers = {
    step: Layer.effect(
        AppTurns,
        Effect.gen(function* () {
            const ports = yield* Ports;
            const turns = appTurns({
                store: yield* LegacyStore,
                workspace: yield* LegacyWorkspace,
                config: yield* LegacyConfig,
                runner: yield* LegacyRunner,
                cycles: yield* LegacyCycles,
                media: yield* LegacyMedia,
                approvals: yield* LegacyApprovals,
                roomStreams: yield* LegacyRoomStreams,
                inference: yield* LegacyInference,
                dotExtensions: yield* LegacyDotExtensions,
                dotServices: yield* AppDotTurnServices,
                handler: yield* LegacyRuntimeHandler,
                ports,
            });
            return ports.turns.fill(turns);
        }),
    ),
};
