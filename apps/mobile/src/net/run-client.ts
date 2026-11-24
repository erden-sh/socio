import type { BaseEvent, Message, RunAgentInput, Tool } from '@ag-ui/core';

import { HISTORY_AFTER_HEADER, requestMessages } from '@socio/shared/chat/chat-history';
import { pageReviewTool } from '@socio/shared/pages/page-review';
import { type LiveTurn, NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';
import { AG_UI_EVENT } from '@socio/shared/runs/event-types';

import { applyRunEvent } from '../chat/live-steps';

import type { AuthedFetch } from './authed-fetch';
import { readText } from './read-body';
import { readSse, type SseFrame } from './read-sse';
import {
    classifyRunAnswer,
    classifyRunError,
    noInferenceText,
    type NoInferenceText,
    retryAfterMs,
    type RunContext,
    type RunFailure,
} from './run-answer';

// The AG-UI run client:
// our own, over `authedFetch` and `readSse`, in place of `@ag-ui/client`'s
// HttpAgent, whose RxJS and zod 3 the app doesn't take (`@ag-ui/core` is a
// devDependency, for types and the event-name parity test).
// - A run is `POST /api/copilotkit/agent/:dotId/run` with AG-UI's
//   RunAgentInput: `{threadId, runId, messages, tools: [review_space_page],
//   context: [], state: {}, forwardedProps: {}}`. `messages` is the stored
//   history's tail plus exactly one outbox row's message or tool result, cut
//   to what the server doesn't have (shared's `requestMessages`, as the web's
//   `sendNewMessagesOnly`). It is never built from overlays: two queued rows
//   never share a body. Ids are made on the device (expo-crypto,
//   injected as `newId`). The device's time zone goes with it (`X-Time-Zone`).
// - The answer's SSE goes into shared's `applyRoomEvent`, the reducer the
//   follow stream uses too, so replaying a run gives the same turn;
//   `applyRunEvent` keeps the running turn's steps beside it (CB-434).
// - `connect` (`…/connect`) replays the runs after `after` (the
//   `x-cb-history-after` header, CB-136) and streams the one running.
// - `stop` (`…/stop/:threadId`) is online only: it is sent once, never queued.
// - What a failed run means for its row is `run-answer.ts`'s classification;
//   the outbox (its chat send) acts on it.

/** The run, connect and stop paths for a socio. */
export const runPath = (dotId: string) => `/api/copilotkit/agent/${encodeURIComponent(dotId)}/run`;
export const connectPath = (dotId: string) => `/api/copilotkit/agent/${encodeURIComponent(dotId)}/connect`;
export const stopPath = (dotId: string, threadId: string) =>
    `/api/copilotkit/agent/${encodeURIComponent(dotId)}/stop/${encodeURIComponent(threadId)}`;

/** The tools a run declares: the page review, which the app implements. */
export const RUN_TOOLS: readonly Tool[] = [
    { name: pageReviewTool.name, description: pageReviewTool.description, parameters: pageReviewTool.parameters },
];

/** What a run's body is built from. */
export interface RunBodyInput {
    readonly threadId: string;
    /** The conversation's stored messages (the history store's runs), oldest first; never overlays. */
    readonly stored: readonly Message[];
    /** Exactly one outbox row's message: the person's, or a page review's tool result. */
    readonly message: Message;
    /** The run's id; a new one by default. */
    readonly runId?: string;
}

/** A RUN_ERROR, as the app reads it. */
export interface RunError {
    /** The server's text, for Advanced mode's detail; the screen words the code. */
    readonly message: string;
    readonly code?: string;
    /** No model is available: the shared text to show. */
    readonly setup?: NoInferenceText;
}

/** How a run (or a connect) ended. */
export type RunOutcome =
    /** The stream ended with the run's RUN_FINISHED or RUN_ERROR. */
    | {
          readonly kind: 'ended';
          readonly runId: string | undefined;
          readonly error?: RunError;
          readonly turn: LiveTurn;
      }
    /**
     * The stream broke off (or ended) after RUN_STARTED without an end: the
     * server has the turn, and the follow stream or `connect` replays it.
     */
    | { readonly kind: 'dropped'; readonly runId: string; readonly turn: LiveTurn; readonly cause: unknown }
    /** The run didn't get through, or its outcome is unknown: the row's action. */
    | {
          readonly kind: 'failed';
          readonly failure: RunFailure;
          readonly turn: LiveTurn;
          /** The run had started (a stop after RUN_STARTED): the server has it, and it runs on. */
          readonly startedRunId?: string;
          /**
           * The server answered the run's POST with its stream but no RUN_STARTED
           * came before the stop: it may hold the turn, so the chat send checks
           * /history and /steering before sending the row again.
           */
          readonly accepted?: true;
      };

/** What happened to a stop. */
export type StopOutcome =
    | { readonly ok: true }
    /** No answer (offline, a dropped connection): nothing to retry, a late stop means nothing. */
    | { readonly ok: false; readonly offline: true }
    | { readonly ok: false; readonly offline: false; readonly status: number };

export interface StreamOptions {
    /** Stops this request alone; the outcome is then `stopped`. */
    readonly signal?: AbortSignal;
    /** Each event, with the turn after it. */
    readonly onEvent?: (event: BaseEvent, turn: LiveTurn) => void;
    /** The signed-in person's app user id, for `applyRoomEvent`'s authors. */
    readonly me?: string;
}

export interface RunClientOptions {
    /** The open workspace's authedFetch. */
    readonly fetch: AuthedFetch;
    /** A fresh id (expo-crypto's `randomUUID`, src/platform/crypto.ts). */
    readonly newId: () => string;
}

export interface RunClient {
    /** The run's body, built only from the stored history and the one row. */
    body(input: RunBodyInput): RunAgentInput;
    /** Sends a run and reads its answer as it streams. */
    run(dotId: string, body: RunAgentInput, options?: StreamOptions & RunContext): Promise<RunOutcome>;
    /** Replays the runs after `after` and streams the running one. */
    connect(
        dotId: string,
        threadId: string,
        options?: StreamOptions & { readonly after?: number },
    ): Promise<RunOutcome>;
    /** Stops the thread's running turn, once. */
    stop(dotId: string, threadId: string, options?: { readonly signal?: AbortSignal }): Promise<StopOutcome>;
}

export function createRunClient({ fetch, newId }: RunClientOptions): RunClient {
    const body = ({ threadId, stored, message, runId }: RunBodyInput): RunAgentInput => ({
        threadId,
        runId: runId ?? newId(),
        messages: requestMessages([...stored.filter((known) => known.id !== message.id), message]),
        tools: [...RUN_TOOLS],
        context: [],
        state: {},
        forwardedProps: {},
    });

    const stream = async (
        path: string,
        json: RunAgentInput,
        headers: Record<string, string>,
        options: StreamOptions & RunContext,
        replay: boolean,
    ): Promise<RunOutcome> => {
        const { signal, onEvent, me } = options;
        let turn = NO_LIVE_TURN;
        let response: Response;
        try {
            response = await fetch(path, {
                method: 'POST',
                json,
                headers: { accept: 'text/event-stream', ...headers },
                timeZone: true,
                ...(signal ? { signal } : {}),
            });
        } catch (error) {
            return { kind: 'failed', failure: classifyRunError(error), turn };
        }
        if (!response.ok) {
            return { kind: 'failed', failure: await failureOfAnswer(response, options), turn };
        }
        if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
            // A 2xx that isn't a stream: whether the turn started is unknown.
            response.body?.cancel().catch(() => {});
            return { kind: 'failed', failure: { action: 'ambiguous', status: response.status }, turn };
        }
        let started: string | undefined;
        let ended: { runId: string | undefined; error?: RunError } | undefined;
        const onFrame = (frame: SseFrame) => {
            if (frame.kind !== 'event') {
                return;
            }
            const event = frame.event as BaseEvent;
            if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
                return;
            }
            const runId = (event as { runId?: unknown }).runId;
            if (event.type === AG_UI_EVENT.RUN_STARTED) {
                started = typeof runId === 'string' ? runId : json.runId;
                ended = undefined;
            } else if (event.type === AG_UI_EVENT.RUN_FINISHED) {
                ended = { runId: typeof runId === 'string' ? runId : started };
            } else if (event.type === AG_UI_EVENT.RUN_ERROR) {
                ended = { runId: started, error: runErrorOf(event) };
            }
            turn = applyRunEvent(turn, event, me);
            onEvent?.(event, turn);
        };
        try {
            await readSse(response, onFrame, signal ? { signal } : {});
        } catch (error) {
            if (ended !== undefined) {
                return { kind: 'ended', runId: ended.runId, ...(ended.error ? { error: ended.error } : {}), turn };
            }
            const failure = classifyRunError(error);
            if (started !== undefined) {
                return failure.action === 'stopped'
                    ? { kind: 'failed', failure, turn, startedRunId: started }
                    : { kind: 'dropped', runId: started, turn, cause: error };
            }
            if (replay) {
                // A connect sends nothing: reading again is always safe.
                return { kind: 'failed', failure, turn };
            }
            // The run's 2xx stream is open, so the server accepted the POST and may
            // be starting the turn before RUN_STARTED: never a plain resend.
            if (failure.action === 'stopped') {
                return { kind: 'failed', failure, turn, accepted: true };
            }
            return { kind: 'failed', failure: { action: 'ambiguous', status: response.status }, turn };
        }
        if (ended === undefined && started === undefined && !replay) {
            // A run's answer that ended with nothing in it: whether the turn started is unknown.
            return { kind: 'failed', failure: { action: 'ambiguous', status: response.status }, turn };
        }
        if (ended !== undefined || started === undefined) {
            return { kind: 'ended', runId: ended?.runId, ...(ended?.error ? { error: ended.error } : {}), turn };
        }
        return { kind: 'dropped', runId: started, turn, cause: null };
    };

    return {
        body,
        run: (dotId, json, options = {}) => stream(runPath(dotId), json, {}, options, false),
        connect: (dotId, threadId, options = {}) =>
            stream(
                connectPath(dotId),
                {
                    threadId,
                    runId: newId(),
                    messages: [],
                    tools: [...RUN_TOOLS],
                    context: [],
                    state: {},
                    forwardedProps: {},
                },
                options.after === undefined ? {} : { [HISTORY_AFTER_HEADER]: String(options.after) },
                options,
                true,
            ),
        stop: async (dotId, threadId, options = {}) => {
            let response: Response;
            try {
                response = await fetch(stopPath(dotId, threadId), {
                    method: 'POST',
                    json: {},
                    ...(options.signal ? { signal: options.signal } : {}),
                });
            } catch (error) {
                if (classifyRunError(error).action === 'stopped') {
                    throw error;
                }
                return { ok: false, offline: true };
            }
            response.body?.cancel().catch(() => {});
            return response.ok ? { ok: true } : { ok: false, offline: false, status: response.status };
        },
    };
}

/** A failed answer's facts, its body read as the API's JSON if it is. */
async function failureOfAnswer(response: Response, context: RunContext & { signal?: AbortSignal }) {
    let code: string | undefined;
    let unreadable = true;
    try {
        const parsed = JSON.parse(await readText(response, context.signal)) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            unreadable = false;
            const value = (parsed as { code?: unknown }).code;
            code = typeof value === 'string' ? value : undefined;
        }
    } catch (error) {
        const failure = classifyRunError(error);
        if (failure.action === 'stopped') {
            return failure;
        }
        // A body that isn't JSON (a proxy's page), or one that broke off: unreadable.
    }
    const wait = retryAfterMs(response.headers);
    return classifyRunAnswer(
        {
            status: response.status,
            unreadable,
            ...(code === undefined ? {} : { code }),
            ...(wait === undefined ? {} : { retryAfterMs: wait }),
        },
        context,
    );
}

function runErrorOf(event: BaseEvent): RunError {
    const { message, code } = event as { message?: unknown; code?: unknown };
    const known = typeof code === 'string' ? code : undefined;
    const setup = noInferenceText(known);
    return {
        message: typeof message === 'string' ? message : '',
        ...(known === undefined ? {} : { code: known }),
        ...(setup === undefined ? {} : { setup }),
    };
}
