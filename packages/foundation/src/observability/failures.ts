import { EventType } from '@ag-ui/core';

import {
    ROOM_FAILURE_NOTES,
    TURN_FAILURE_MESSAGES,
    timeLimitMessage,
    turnFailureKind,
    type TurnFailure,
} from '@socio/shared/turn-failures';

// The fixed words of a failed turn live in shared, where the clients word a
// room's problems from the RUN_ERROR code with the same table.
export { ROOM_FAILURE_NOTES, TURN_FAILURE_MESSAGES, turnFailureKind, type TurnFailure };

// Never pass provider messages or stacks to logs as they are: they can
// contain credentials. Provider text goes through failureDetail() first.
export function safeFailure(error: unknown): string {
    const name =
        error instanceof Error && ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
            ? error.name
            : 'Error';
    const status = error !== null && typeof error === 'object' && 'status' in error ? error.status : undefined;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? `${name} (HTTP ${status})`
        : name;
}

export const reportFailure = (operation: string, errors: string[]) =>
    console.error(`${operation}: ${errors.join('; ')}`);

/** The turn time limit when neither the environment nor Settings set one. */
export const DEFAULT_TURN_TIME_LIMIT_SECONDS = 300;

/**
 * `TURN_TIME_LIMIT_SECONDS`: how long one turn may run, 300 s by default.
 * Reasoning models with tools (the computer's browser, web search) need
 * minutes; the shutdown drain follows this limit. An admin may override it
 * in Settings (CB-123): the limit in force is `turnTimeLimitMs` in limits.ts.
 */
export function turnTimeLimitMsFromEnv(env: Record<string, string | undefined>) {
    return (turnTimeLimitSecondsFromEnv(env) ?? DEFAULT_TURN_TIME_LIMIT_SECONDS) * 1000;
}

/** `TURN_TIME_LIMIT_SECONDS`, the limit's starting value; undefined when unset. */
export function turnTimeLimitSecondsFromEnv(env: Record<string, string | undefined>) {
    const raw = env.TURN_TIME_LIMIT_SECONDS?.trim();
    if (!raw) {
        return undefined;
    }
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) {
        throw new Error('TURN_TIME_LIMIT_SECONDS must be a whole number from 10 to 3600.');
    }
    return seconds;
}

/** Whether `message` is one of the fixed texts a user sees for a failed turn. */
export const isTurnFailureMessage = (message: string) => turnFailureKind(message) !== undefined;

/** A failure whose kind is known where it is thrown. */
export class TurnFailureError extends Error {
    constructor(
        readonly kind: TurnFailure,
        message: string,
    ) {
        super(message);
    }
}

const messageOf = (error: unknown) =>
    typeof error === 'string'
        ? error
        : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? error.message
          : '';

/**
 * The provider's HTTP status. The model stream only keeps the message, which
 * the OpenAI SDK starts with the status ("400 image input requires ...").
 */
function statusOf(error: unknown) {
    const status = error !== null && typeof error === 'object' && 'status' in error ? error.status : undefined;
    if (typeof status === 'number') {
        return status;
    }
    const leading = messageOf(error).match(/^([1-5]\d\d)\b/);
    return leading ? Number(leading[1]) : undefined;
}

export function failureKind(error: unknown): TurnFailure {
    if (error instanceof TurnFailureError) {
        return error.kind;
    }
    const status = statusOf(error);
    if (status === 401 || status === 403 || status === 404) {
        return 'model_config';
    }
    if (status === 408 || status === 429 || (status && status >= 500)) {
        return 'model_unavailable';
    }
    if (status && status >= 400) {
        return 'model_rejected';
    }
    if (
        (error instanceof Error && error.name === 'TimeoutError') ||
        /connection error|timed out|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(
            messageOf(error),
        )
    ) {
        return 'model_unavailable';
    }
    return 'failed';
}

/**
 * The failure's own text for operators (server log, admin views), with what
 * could carry credentials or conversation content removed: tokens and other
 * long opaque strings, URL query strings, email addresses and long quoted
 * spans (a provider may echo part of the request). Never shown to users.
 */
export function failureDetail(error: unknown): string {
    const text = messageOf(error)
        .replace(/\s+/g, ' ')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/(\bhttps?:\/\/[^\s?#]+)[?#]\S*/gi, '$1?[redacted]')
        .replace(/[^\s@'"`]+@[^\s@'"`]+\.\w+/g, '[email]')
        .replace(/[A-Za-z0-9+/_=.-]{32,}/g, '[redacted]')
        .replace(/(["'`])[^"'`]{41,}\1/g, '$1[redacted]$1')
        .trim();
    const label = safeFailure(error);
    if (!text) {
        return label;
    }
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * The RUN_ERROR for a failed turn: a friendly `message`, the failure kind as
 * `code`, and the operator detail in `errorDetail`. LocalAgentRunner removes
 * `errorDetail` before the event is stored or sent (it keeps it in the run's
 * `agent_runs.errorDetail` column), so it never reaches a client.
 */
export function turnError(
    kind: TurnFailure,
    error?: unknown,
    /** The time limit the turn had, named in the `time_limit` message. */
    limitMs?: number,
) {
    return {
        type: EventType.RUN_ERROR as const,
        message:
            kind === 'time_limit' && limitMs !== undefined ? timeLimitMessage(limitMs) : TURN_FAILURE_MESSAGES[kind],
        code: kind,
        ...(error === undefined ? {} : { errorDetail: failureDetail(error) }),
    };
}

/**
 * tanstack-ai logs caught errors with metadata that can hold conversation
 * content (e.g. raw tool arguments). Keep only the error label.
 */
const quiet = () => {};
export const modelDebug = {
    provider: false,
    output: false,
    middleware: false,
    tools: false,
    agentLoop: false,
    config: false,
    request: false,
    sandbox: false,
    errors: true,
    logger: {
        debug: quiet,
        info: quiet,
        warn: quiet,
        error: (message: string) => reportFailure('Model stream', [message]),
    },
};
