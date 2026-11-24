import { THREAD_RUNNING_CODE } from '@socio/shared/chat/thread-running';
import { NO_INFERENCE_MESSAGES } from '@socio/shared/inference';

import { failureOf } from './reconnect';

// What a run's answer means for the message it carried. The outbox (its chat
// send) acts on the action; nothing here reads the server's text, only
// statuses and `code`s:
// - the server is away (503 `draining`, a 502 or 504, an unreadable 503,
//   no answer at all): retry, after `Retry-After` when the answer had one;
// - a busy thread (409 `thread_running`, CB-357) is `busy`: a definite
//   answer, the server took nothing, so the chat send re-routes the row to
//   steering while a turn runs and otherwise sends it again after the
//   back-off, never `unknown`. A 409 without that code is a refusal like any
//   other;
// - any other 5xx is ambiguous: it may have started the turn, so the chat
//   send's busy-thread rule checks `/history` and `/steering` before it sends
//   again or re-routes the row to steering. A server from before the code
//   answered a busy thread with a bare 5xx;
// - 413 (too long), 403 (refused) and 404 or 410 (the chat is gone) go to
//   `unsent`;
// - a 400 is the message's content (an attachment the server can't take,
//   `ContentError`, which has no code yet): with attachments it re-uploads
//   them once, then goes to `unsent`;
// - a 429 (`cycle_rate`: too many messages this minute) waits out
//   `Retry-After`, a minute when the answer has none, holding the lane;
// - a readable 503 that isn't `draining` is the server's "Setup required":
//   no model, worded with shared's NO_INFERENCE_MESSAGES, as a run that ends
//   with a `no_inference` RUN_ERROR is;
// - a 401 holds the lane for sign-in (authedFetch has already published it);
// - a stop the app asked for is a stop.

/** How long a 429 with no Retry-After waits: the rate's window is a minute (CB-211). */
export const CYCLE_RATE_WAIT_MS = 60_000;

/** The shared texts a run with no model shows (`NO_INFERENCE_MESSAGES`). */
export type NoInferenceText = (typeof NO_INFERENCE_MESSAGES)[keyof typeof NO_INFERENCE_MESSAGES];

/** Why a message goes to `unsent`. */
export type UnsentReason =
    /** 413: the message is too long for the server. */
    | 'too-large'
    /** 400: the server can't take its content (after one re-upload, with attachments). */
    | 'content'
    /** 403: the server refused it. */
    | 'refused'
    /** 404 or 410: the chat is gone, or the person lost access (UL's list). */
    | 'gone'
    /** Any other 4xx. */
    | 'rejected';

/** What to do with a run that didn't get through, by its answer. */
export type RunFailure =
    /**
     * The server is away: send again after `retryAfterMs` (when it said) or the
     * outbox's back-off. `draining` marks the server's own 503 `draining`, which
     * took nothing; a proxy's 502 or 504, or an unreadable 503, may have come
     * after the server took the run, so the chat send checks before it sends again.
     */
    | { readonly action: 'retry'; readonly retryAfterMs?: number; readonly draining?: true }
    /** A 5xx that may have started the turn: the chat send's busy-thread rule decides. */
    | { readonly action: 'ambiguous'; readonly status: number }
    /**
     * A busy thread (409 `thread_running`, CB-357): the server took nothing,
     * a definite answer. It goes as steering while a turn runs, else again.
     */
    | { readonly action: 'busy' }
    /** A 400 on a message with attachments, the first time: upload them again, then send. */
    | { readonly action: 'reupload' }
    /** A refusal: the row goes to `unsent`, shown in the app's words. */
    | { readonly action: 'unsent'; readonly reason: UnsentReason; readonly status: number }
    /** 429: hold the lane for `retryAfterMs`, then send again. */
    | { readonly action: 'wait'; readonly retryAfterMs: number; readonly code?: string }
    /** No model: show `message`, keep the row until the person acts. */
    | { readonly action: 'setup'; readonly message: NoInferenceText }
    /** 401: held for sign-in. */
    | { readonly action: 'sign-in' }
    /** The run's signal stopped it (the person, a workspace switch, the app). */
    | { readonly action: 'stopped' };

/** An HTTP answer's facts, its body already read. */
export interface RunAnswer {
    readonly status: number;
    /** The body's `code`, if it was the API's JSON with one. */
    readonly code?: string;
    /** The body wasn't the API's JSON (a proxy's page). */
    readonly unreadable: boolean;
    /** `Retry-After`, in milliseconds, if the answer had a usable one. */
    readonly retryAfterMs?: number;
}

/** What the outbox knows about the message, for the 400 rule. */
export interface RunContext {
    /** The message carries attachments. */
    readonly attachments?: boolean;
    /** They were uploaded again already after a 400. */
    readonly reuploaded?: boolean;
}

/** The action for a run's non-2xx answer. */
export function classifyRunAnswer(answer: RunAnswer, context: RunContext = {}): RunFailure {
    const { status, code, unreadable, retryAfterMs } = answer;
    if (status === 401) {
        return { action: 'sign-in' };
    }
    if (code === 'draining') {
        return retryAfterMs === undefined
            ? { action: 'retry', draining: true }
            : { action: 'retry', retryAfterMs, draining: true };
    }
    if (status === 502 || status === 504 || (status === 503 && unreadable)) {
        return withRetryAfter(retryAfterMs);
    }
    if (status === 503) {
        // The server's own 503 that isn't draining: "Setup required" (no model configured).
        return { action: 'setup', message: NO_INFERENCE_MESSAGES.operator };
    }
    if (code === THREAD_RUNNING_CODE) {
        return { action: 'busy' };
    }
    if (status >= 500) {
        return { action: 'ambiguous', status };
    }
    if (status === 429) {
        return {
            action: 'wait',
            retryAfterMs: retryAfterMs ?? CYCLE_RATE_WAIT_MS,
            ...(code === undefined ? {} : { code }),
        };
    }
    if (status === 400 && context.attachments && !context.reuploaded) {
        return { action: 'reupload' };
    }
    return { action: 'unsent', reason: unsentReason(status), status };
}

/** The action for a run that got no answer (`error` is what authedFetch or the stream rejected with). */
export function classifyRunError(error: unknown): RunFailure {
    const failure = failureOf(error);
    if (failure.aborted) {
        return { action: 'stopped' };
    }
    if (failure.network) {
        return { action: 'retry' };
    }
    // Anything else (a refused redirect, a body that isn't SSE) leaves the outcome unknown.
    return { action: 'ambiguous', status: 0 };
}

/** A RUN_ERROR's code that means no model is available, worded; or undefined. */
export function noInferenceText(code: string | undefined): NoInferenceText | undefined {
    switch (code) {
        case 'no_inference':
            return NO_INFERENCE_MESSAGES.connect;
        case 'no_inference_operator':
        case 'model_config':
            return NO_INFERENCE_MESSAGES.operator;
        case 'no_inference_choice':
            return NO_INFERENCE_MESSAGES.choice;
        default:
            return undefined;
    }
}

/**
 * `Retry-After` in milliseconds: whole seconds, or an HTTP date measured
 * against the answer's own `Date` (the server's clock, never the device's).
 * Undefined when it is missing or unreadable.
 */
export function retryAfterMs(headers: Headers): number | undefined {
    const value = headers.get('retry-after')?.trim();
    if (!value) {
        return undefined;
    }
    if (/^\d{1,9}$/.test(value)) {
        return Number(value) * 1000;
    }
    const at = Date.parse(value);
    const now = Date.parse(headers.get('date') ?? '');
    if (Number.isNaN(at) || Number.isNaN(now)) {
        return undefined;
    }
    return Math.max(0, at - now);
}

const withRetryAfter = (ms: number | undefined): RunFailure =>
    ms === undefined ? { action: 'retry' } : { action: 'retry', retryAfterMs: ms };

function unsentReason(status: number): UnsentReason {
    switch (status) {
        case 413:
            return 'too-large';
        case 400:
            return 'content';
        case 403:
            return 'refused';
        case 404:
        case 410:
            return 'gone';
        default:
            return 'rejected';
    }
}

/** For a switch over `RunFailure['action']`: a case left out fails the typecheck. */
export function unhandledRunFailure(failure: never): never {
    throw new Error(`Unhandled run failure: ${JSON.stringify(failure)}`);
}
