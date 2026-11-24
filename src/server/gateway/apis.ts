import { sanitizeChatRequest } from './chat-request.js';
import { StreamMeter, answerChars, usageOf, type ReportedUsage } from './chat-stream.js';
import { sanitizeGeminiRequest, withGeminiLimit } from './gemini-request.js';
import { GeminiStreamMeter, geminiAnswerChars, geminiUsageOf } from './gemini-stream.js';
import { sanitizeMessagesRequest } from './messages-request.js';
import { MessagesStreamMeter, messagesAnswerChars, messagesUsageOf } from './messages-stream.js';
import { sanitizeResponsesRequest } from './responses-request.js';
import { ResponsesStreamMeter, responsesAnswerChars, responsesUsageOf } from './responses-stream.js';

/**
 * The model APIs the gateway speaks (CB-239): OpenAI Chat
 * Completions (OpenCode's `@ai-sdk/openai-compatible`), OpenAI Responses
 * (OpenCode on a person's ChatGPT plan; Codex) and Anthropic Messages
 * (Claude Code's since CB-326), and the Gemini API's
 * `generateContent` (Gemini CLI's, CB-326). Each has its own body
 * rules (the `*-request.ts` files), its own usage and output counting, its
 * own error shape and its own place for the completion limit; everything
 * else (credential, model binding, rate, reservation, metering,
 * revocation, time limits) is one pipeline in model.ts.
 */

export type ModelApiId = 'chat' | 'responses' | 'messages' | 'gemini';

/** What a sanitizer answers: the shape every `*-request.ts` shares. */
export type Sanitized =
    | {
          ok: true;
          body: Record<string, unknown>;
          stream: boolean;
          requestedCompletion?: number;
          promptTokens: number;
          dropped: string[];
      }
    | { ok: false; code: string; message: string; param?: string };

export type ErrorType =
    | 'invalid_request_error'
    | 'authentication_error'
    | 'permission_error'
    | 'not_found_error'
    | 'rate_limit_error'
    | 'insufficient_quota'
    | 'api_error';

export interface OutputMeter {
    push(text: string): void;
    readonly usage?: ReportedUsage;
    readonly outputTokens: number;
}

export interface ModelApi {
    id: ModelApiId;
    /**
     * The upstream path under the backend's base URL, for the backend's own
     * model: fixed for the OpenAI and Anthropic APIs (the model goes in the
     * body); the Gemini API names the model, and whether it streams, in it.
     */
    upstreamPath(model: string, stream: boolean): string;
    /** Whether the backend's model goes in the upstream body as `model`. */
    modelInBody: boolean;
    /**
     * `stream`: what the request's path asked (the Gemini API's
     * `streamGenerateContent`); the other APIs say so in the body.
     */
    sanitize(body: unknown, shape: { acceptsImages: boolean; personalPlan: boolean; stream?: boolean }): Sanitized;
    /** The upstream body with the clamped completion limit in this API's own field. */
    withLimit(body: Record<string, unknown>, limit: number): Record<string, unknown>;
    /**
     * The request header the session's token may come in besides
     * `Authorization: Bearer` (the Gemini API's `x-goog-api-key`).
     */
    keyHeader?: string;
    usageOf(body: unknown): ReportedUsage | undefined;
    answerChars(body: unknown): number;
    meter(): OutputMeter;
    /** An error answer in this API's own shape. */
    error(status: number, type: ErrorType, code: string, message: string, param?: string | null): Response;
    /** The same, as the last event of a stream. */
    streamError(type: ErrorType, code: string, message: string): string;
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
        },
    });

/** An OpenAI-shaped error: `{ error: { type, code, message } }`. */
export function openAiError(
    status: number,
    type: ErrorType,
    code: string,
    message: string,
    param: string | null = null,
) {
    return json(status, { error: { type, code, message, param } });
}

/** Anthropic's error types, from ours. */
const ANTHROPIC_TYPE: Record<ErrorType, string> = {
    invalid_request_error: 'invalid_request_error',
    authentication_error: 'authentication_error',
    permission_error: 'permission_error',
    not_found_error: 'not_found_error',
    rate_limit_error: 'rate_limit_error',
    insufficient_quota: 'rate_limit_error',
    api_error: 'api_error',
};

/** An Anthropic-shaped error: `{ type: 'error', error: { type, message } }`. */
export function anthropicError(status: number, type: ErrorType, _code: string, message: string) {
    return json(status, {
        type: 'error',
        error: { type: ANTHROPIC_TYPE[type], message },
    });
}

/** A completion limit in a top-level body field. */
const limitIn =
    (field: string) =>
    (body: Record<string, unknown>, limit: number): Record<string, unknown> => ({ ...body, [field]: limit });

export const CHAT_API: ModelApi = {
    id: 'chat',
    upstreamPath: () => '/chat/completions',
    modelInBody: true,
    sanitize: (body, shape) => sanitizeChatRequest(body, { acceptsImages: shape.acceptsImages }),
    withLimit: limitIn('max_completion_tokens'),
    usageOf,
    answerChars,
    meter: () => new StreamMeter(),
    error: openAiError,
    streamError: (type, code, message) =>
        `data: ${JSON.stringify({ error: { type, code, message, param: null } })}\n\n`,
};

export const RESPONSES_API: ModelApi = {
    id: 'responses',
    upstreamPath: () => '/responses',
    modelInBody: true,
    sanitize: sanitizeResponsesRequest,
    withLimit: limitIn('max_output_tokens'),
    usageOf: responsesUsageOf,
    answerChars: responsesAnswerChars,
    meter: () => new ResponsesStreamMeter(),
    error: openAiError,
    // The Responses stream's own `error` event.
    streamError: (_type, code, message) =>
        `event: error\ndata: ${JSON.stringify({ type: 'error', code, message, param: null })}\n\n`,
};

export const MESSAGES_API: ModelApi = {
    id: 'messages',
    upstreamPath: () => '/messages',
    modelInBody: true,
    sanitize: (body, shape) => sanitizeMessagesRequest(body, { acceptsImages: shape.acceptsImages }),
    withLimit: limitIn('max_tokens'),
    usageOf: messagesUsageOf,
    answerChars: messagesAnswerChars,
    meter: () => new MessagesStreamMeter(),
    error: anthropicError,
    streamError: (type, _code, message) =>
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: ANTHROPIC_TYPE[type], message } })}\n\n`,
};

/** The Gemini API's status names (`google.rpc.Code`), from ours. */
const GEMINI_STATUS: Record<ErrorType, string> = {
    invalid_request_error: 'INVALID_ARGUMENT',
    authentication_error: 'UNAUTHENTICATED',
    permission_error: 'PERMISSION_DENIED',
    not_found_error: 'NOT_FOUND',
    rate_limit_error: 'RESOURCE_EXHAUSTED',
    insufficient_quota: 'RESOURCE_EXHAUSTED',
    api_error: 'INTERNAL',
};

/** The Gemini API's status name for an HTTP status, where one says it plainly. */
const GEMINI_STATUS_OF_HTTP: Record<number, string> = {
    400: 'INVALID_ARGUMENT',
    401: 'UNAUTHENTICATED',
    403: 'PERMISSION_DENIED',
    404: 'NOT_FOUND',
    413: 'INVALID_ARGUMENT',
    415: 'INVALID_ARGUMENT',
    429: 'RESOURCE_EXHAUSTED',
    502: 'UNAVAILABLE',
    504: 'DEADLINE_EXCEEDED',
};

/** A Gemini-shaped error: `{ error: { code, message, status } }`. */
export function geminiError(status: number, type: ErrorType, _code: string, message: string) {
    return json(status, {
        error: { code: status, message, status: GEMINI_STATUS_OF_HTTP[status] ?? GEMINI_STATUS[type] },
    });
}

/** The HTTP status a Gemini error status stands for, for the last event of a stream. */
const GEMINI_HTTP: Record<string, number> = {
    INVALID_ARGUMENT: 400,
    UNAUTHENTICATED: 401,
    PERMISSION_DENIED: 403,
    NOT_FOUND: 404,
    RESOURCE_EXHAUSTED: 429,
    INTERNAL: 500,
};

/**
 * Gemini CLI's (CB-326): `generateContent` and, with `?alt=sse`,
 * `streamGenerateContent`, forwarded to a backend that speaks the Gemini
 * API (Google's, `<baseUrl>` ending in `/v1beta`, or a compatible proxy)
 * with the backend's model in the path and its key as `x-goog-api-key`.
 */
export const GEMINI_API: ModelApi = {
    id: 'gemini',
    upstreamPath: (model, stream) =>
        `/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    modelInBody: false,
    sanitize: (body, shape) =>
        sanitizeGeminiRequest(body, { acceptsImages: shape.acceptsImages, stream: shape.stream }),
    withLimit: withGeminiLimit,
    keyHeader: 'x-goog-api-key',
    usageOf: geminiUsageOf,
    answerChars: geminiAnswerChars,
    meter: () => new GeminiStreamMeter(),
    error: geminiError,
    // A chunk that is an error, as the Gemini API ends a broken stream.
    streamError: (type, _code, message) =>
        `data: ${JSON.stringify({ error: { code: GEMINI_HTTP[GEMINI_STATUS[type]] ?? 500, message, status: GEMINI_STATUS[type] } })}\n\n`,
};
