import { serverAway } from '@socio/shared/reconnect';

import { readText } from '../net/read-body';

import type { OutboxWrite, SendOutcome } from './outbox';

// Reading the server's answers to the outbox's writes. Each write
// kind classifies an answer by its status and JSON `code`, never its text,
// into one of these actions; `outcomeOf` turns the action into what the
// outbox does with the row:
//
// - **retry**: the server is away (shared's `serverAway`), with the back-off;
// - **back-off**: a 429, holding the lane for its `Retry-After`, else the
//   kind's window or the back-off (`cycle_rate`, `queue_full`);
// - **merge**, **relocate**, **re-upload**: the kind's own work (a page 409, a
//   page 404, an expired attachment), which rewrites the row and sends it
//   again, or gives up to `unsent`; a kind without that work sends it to
//   `unsent`;
// - **delivered**: a 2xx, or an answer the already-applied rule covers after
//   an ambiguous attempt: a DELETE's 404, an edit's 409 `delivered`;
// - **unsent**: any other refusal, 413 included. What the person wrote moves
//   to user.db's `unsent` and holds its lane and its dependents.
//
// One more, from the outbox's check rather than a kind's rules: **unknown**,
// a server error that isn't the server being away (a plain 500). The request
// may have done something, so a kind that isn't safe to repeat checks before
// it goes again.

/** One answer, read once: its status, JSON body and `code`, and how long it asks to wait. */
export interface Answer {
    readonly status: number;
    /** The API's error code from the JSON body, or null. */
    readonly code: string | null;
    /** The JSON body, or null when it was empty or not JSON. */
    readonly body: unknown;
    /** The body wasn't JSON: a proxy's page, not the API's answer. */
    readonly unreadable: boolean;
    /** `Retry-After` in milliseconds: seconds, or a date read against the answer's `Date` (the server's clock). */
    readonly retryAfterMs: number | null;
}

/** The answers' actions, and the check's `unknown`. */
export type ClassifierAction =
    | { readonly action: 'retry'; readonly reason: string }
    | { readonly action: 'back-off'; readonly delayMs: number | null; readonly reason: string }
    | { readonly action: 'merge' }
    | { readonly action: 'relocate' }
    | { readonly action: 're-upload' }
    | { readonly action: 'delivered' }
    | { readonly action: 'unsent'; readonly reason: string }
    | { readonly action: 'unknown'; readonly reason: string };

export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ClassifyOptions {
    readonly method: WriteMethod;
    /** An earlier attempt may have reached the server (the row was `unknown`): the already-applied rule applies. */
    readonly ambiguous?: boolean;
    /** The kind's own answers, read before the defaults; undefined leaves the answer to them. */
    readonly special?: (answer: Answer) => ClassifierAction | undefined;
}

/** Whole seconds, as the server writes `Retry-After`. */
const SECONDS = /^\d{1,9}$/;

/** `Retry-After` in milliseconds, or null without a readable one. A date is read against `Date`, never the device's clock. */
export function retryAfterMs(headers: Headers): number | null {
    const value = headers.get('retry-after')?.trim();
    if (!value) {
        return null;
    }
    if (SECONDS.test(value)) {
        return Number(value) * 1000;
    }
    const at = Date.parse(value);
    const now = Date.parse(headers.get('date') ?? '');
    if (Number.isNaN(at) || Number.isNaN(now)) {
        return null;
    }
    return Math.max(0, at - now);
}

/** Reads an answer's body once. A body that breaks off throws readText's NetworkError. */
export async function readAnswer(response: Response, signal?: AbortSignal): Promise<Answer> {
    const text = await readText(response, signal);
    let body: unknown = null;
    let unreadable = false;
    if (text.trim() !== '') {
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            unreadable = true;
        }
    }
    const code =
        body !== null && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
            ? (body as { code: string }).code
            : null;
    return { status: response.status, code, body, unreadable, retryAfterMs: retryAfterMs(response.headers) };
}

/** An answer's reason as stored on the row: its code, else its status. Never the server's text. */
export const reasonOf = (answer: Answer) => answer.code ?? `http-${answer.status}`;

/** The outbox's defaults, after the kind's own rules. */
export function classify(answer: Answer, { method, ambiguous = false, special }: ClassifyOptions): ClassifierAction {
    const own = special?.(answer);
    if (own !== undefined) {
        return own;
    }
    const { status, code } = answer;
    if (status >= 200 && status < 300) {
        return { action: 'delivered' };
    }
    if (serverAway({ status, code: code ?? undefined, unreadable: answer.unreadable })) {
        return { action: 'retry', reason: reasonOf(answer) };
    }
    if (ambiguous) {
        // The already-applied rule: what the first attempt did is what this one finds.
        if (method === 'DELETE' && status === 404) {
            return { action: 'delivered' };
        }
        if ((method === 'PATCH' || method === 'PUT') && status === 409 && code === 'delivered') {
            return { action: 'delivered' };
        }
    }
    if (status === 429) {
        return { action: 'back-off', delayMs: answer.retryAfterMs, reason: reasonOf(answer) };
    }
    if (status >= 500) {
        return { action: 'unknown', reason: reasonOf(answer) };
    }
    return { action: 'unsent', reason: reasonOf(answer) };
}

/** A kind's work for merge, relocate and re-upload: a rewritten row to send again, or `unsent`. */
export interface ClassifierWork<Payload> {
    readonly merge?: (write: OutboxWrite<Payload>) => Promise<SendOutcome>;
    readonly relocate?: (write: OutboxWrite<Payload>) => Promise<SendOutcome>;
    readonly reupload?: (write: OutboxWrite<Payload>) => Promise<SendOutcome>;
}

/** What the outbox does for an action. Work a kind doesn't have sends the row to `unsent`. */
export async function outcomeOf<Payload>(
    action: ClassifierAction,
    write: OutboxWrite<Payload>,
    work: ClassifierWork<Payload> = {},
): Promise<SendOutcome> {
    switch (action.action) {
        case 'delivered':
            return { action: 'done' };
        case 'retry':
            return { action: 'retry', reason: action.reason };
        case 'back-off':
            return action.delayMs === null
                ? { action: 'retry', reason: action.reason }
                : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
        case 'unknown':
            return { action: 'unknown', reason: action.reason };
        case 'unsent':
            return { action: 'unsent', reason: action.reason };
        case 'merge':
            return work.merge ? work.merge(write) : { action: 'unsent', reason: 'conflict' };
        case 'relocate':
            return work.relocate ? work.relocate(write) : { action: 'unsent', reason: 'gone' };
        case 're-upload':
            return work.reupload ? work.reupload(write) : { action: 'unsent', reason: 'attachment-expired' };
    }
}
