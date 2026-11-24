import type { Message } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';

import { HISTORY_AFTER_HEADER } from '@socio/shared/chat/chat-history';
import { NO_INFERENCE_MESSAGES } from '@socio/shared/inference';
import { pageReviewTool } from '@socio/shared/pages/page-review';
import { AG_UI_EVENT } from '@socio/shared/runs/event-types';

import { createAuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { AbortedError, NetworkError, RedirectRefusedError } from '../../src/net/errors';
import { classifyRunAnswer, classifyRunError, noInferenceText, retryAfterMs } from '../../src/net/run-answer';
import { connectPath, createRunClient, runPath, stopPath } from '../../src/net/run-client';

import {
    answer,
    fakeFetch,
    httpDate,
    ORIGIN,
    sentHeaders,
    sessionSetCookie,
    settle,
    streamedAnswer,
    T0,
} from './helpers';

// The run client over authedFetch and readSse, against a
// fake run endpoint. The contract test against a local server is
// tests/contract/run-client.test.ts.

const DOT = 'dot-1';
const THREAD = 'thread-1';

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const started = (runId = 'run-1') => frame({ type: 'RUN_STARTED', threadId: THREAD, runId });
const text = (delta: string) => frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta });
const textStart = () => frame({ type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' });
const finished = (runId = 'run-1') => frame({ type: 'RUN_FINISHED', threadId: THREAD, runId });

const user = (id: string, content: string): Message => ({ id, role: 'user', content });
const reply = (id: string, content: string): Message => ({ id, role: 'assistant', content });

/** A stored conversation: two finished runs. */
const STORED: Message[] = [user('u1', 'hello'), reply('a0', 'hi'), user('u2', 'more'), reply('a00', 'sure')];

async function setup(respond: Parameters<typeof fakeFetch>[0]) {
    const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
    await jar.apply(new URL(`${ORIGIN}/api/auth/sign-in/email`), [sessionSetCookie('t1.c2ln%3D')], httpDate(T0));
    const scope = new AbortController();
    const fetch = fakeFetch(respond);
    const request = createAuthedFetch({
        origin: ORIGIN,
        jar,
        fetch,
        userAgent: 'Socio/0.1.0 (Android; Android 16)',
        signal: scope.signal,
        timeZone: () => 'America/New_York',
    });
    let ids = 0;
    const client = createRunClient({ fetch: request, newId: () => `id-${++ids}` });
    return { client, fetch, scope };
}

const sentBody = (call: { init: { body?: unknown } } | undefined) =>
    JSON.parse(String(call?.init.body)) as Record<string, unknown>;

describe('the run body', () => {
    it('is AG-UI’s RunAgentInput with the page review tool and a device id', async () => {
        const { client } = await setup(() => answer(200));
        const body = client.body({ threadId: THREAD, stored: STORED, message: user('u3', 'next') });
        expect(body).toEqual({
            threadId: THREAD,
            runId: 'id-1',
            messages: [user('u3', 'next')],
            tools: [
                {
                    name: 'review_space_page',
                    description: pageReviewTool.description,
                    parameters: pageReviewTool.parameters,
                },
            ],
            context: [],
            state: {},
            forwardedProps: {},
        });
    });

    it('carries the stored tail and exactly one row’s message: two queued rows never share a body', async () => {
        const { client } = await setup(() => answer(200));
        // A turn the server stored with no reply (it failed), then two rows queued on the device.
        const stored = [...STORED, user('u3', 'never answered')];
        const first = client.body({ threadId: THREAD, stored, message: user('q1', 'first queued') });
        const second = client.body({ threadId: THREAD, stored, message: user('q2', 'second queued') });
        expect(first.messages.map((message) => message.id)).toEqual(['u3', 'q1']);
        expect(second.messages.map((message) => message.id)).toEqual(['u3', 'q2']);
        expect(first.runId).not.toBe(second.runId);
    });

    it('sends a page review’s tool result after its call, and a message the server stored only once', async () => {
        const { client } = await setup(() => answer(200));
        const call: Message = {
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', type: 'function', function: { name: pageReviewTool.name, arguments: '{}' } }],
        };
        const result: Message = { id: 'r1', role: 'tool', toolCallId: 'call-1', content: '{"approved":false}' };
        const review = client.body({
            threadId: THREAD,
            stored: [...STORED, user('u3', 'draft it'), call],
            message: result,
        });
        expect(review.messages).toEqual([result]);
        // A retry of a message the server already stored (no reply yet): it goes once.
        const again = client.body({ threadId: THREAD, stored: [...STORED, user('u3', 'x')], message: user('u3', 'x') });
        expect(again.messages).toEqual([user('u3', 'x')]);
    });
});

describe('a run', () => {
    it('posts the body to the run path as JSON with the time zone, and reduces the stream as it comes', async () => {
        const stream = streamedAnswer();
        const { client, fetch } = await setup(() => stream.response);
        const body = client.body({ threadId: THREAD, stored: STORED, message: user('u3', 'next') });
        const seen: string[] = [];
        const outcome = client.run(DOT, body, { onEvent: (event, turn) => seen.push(`${event.type}:${turn.running}`) });
        await settle();
        const [call] = fetch.calls;
        expect(call?.url).toBe(`${ORIGIN}${runPath(DOT)}`);
        expect(call?.init.method).toBe('POST');
        expect(sentHeaders(call)).toMatchObject({
            accept: 'text/event-stream',
            'content-type': 'application/json',
            'x-time-zone': 'America/New_York',
            origin: ORIGIN,
        });
        expect(sentBody(call)).toEqual(JSON.parse(JSON.stringify(body)));
        stream.push(started());
        stream.push(textStart());
        stream.push(text('Hel'));
        await settle();
        expect(seen).toEqual(['RUN_STARTED:true', 'TEXT_MESSAGE_START:true', 'TEXT_MESSAGE_CONTENT:true']);
        stream.push(text('lo'));
        stream.push(finished());
        stream.end();
        const result = await outcome;
        expect(result).toMatchObject({ kind: 'ended', runId: 'run-1' });
        expect(result.kind === 'ended' && result.error).toBeUndefined();
        expect(result.turn.running).toBe(false);
    });

    it('ends with the RUN_ERROR’s code, and no model is the shared text', async () => {
        const stream = streamedAnswer();
        const { client } = await setup(() => stream.response);
        const outcome = client.run(DOT, client.body({ threadId: THREAD, stored: [], message: user('u1', 'hi') }));
        stream.push(started());
        stream.push(frame({ type: 'RUN_ERROR', message: 'No inference available.', code: 'no_inference' }));
        stream.end();
        const result = await outcome;
        expect(result).toMatchObject({
            kind: 'ended',
            runId: 'run-1',
            error: { code: 'no_inference', setup: NO_INFERENCE_MESSAGES.connect },
        });
    });

    it('a stream broken after RUN_STARTED is dropped: the server has the turn', async () => {
        const stream = streamedAnswer();
        const { client } = await setup(() => stream.response);
        const outcome = client.run(DOT, client.body({ threadId: THREAD, stored: [], message: user('u1', 'hi') }));
        stream.push(started('run-9'));
        await settle();
        stream.fail();
        expect(await outcome).toMatchObject({ kind: 'dropped', runId: 'run-9' });
    });

    it('a run’s stream broken before RUN_STARTED is ambiguous: the server accepted the POST', async () => {
        const stream = streamedAnswer();
        const { client } = await setup(() => stream.response);
        const outcome = client.run(DOT, client.body({ threadId: THREAD, stored: [], message: user('u1', 'hi') }));
        await settle();
        stream.fail();
        expect(await outcome).toMatchObject({ kind: 'failed', failure: { action: 'ambiguous', status: 200 } });
    });

    it('a connect’s stream broken before RUN_STARTED is retry: a connect sends nothing', async () => {
        const stream = streamedAnswer();
        const { client } = await setup(() => stream.response);
        const outcome = client.connect(DOT, THREAD);
        await settle();
        stream.fail();
        expect(await outcome).toMatchObject({ kind: 'failed', failure: { action: 'retry' } });
    });

    it('its own signal between the 200 and RUN_STARTED is stopped, flagged accepted', async () => {
        const stop = new AbortController();
        const stream = streamedAnswer({ signal: stop.signal });
        const { client } = await setup(() => stream.response);
        const outcome = client.run(DOT, client.body({ threadId: THREAD, stored: [], message: user('u1', 'hi') }), {
            signal: stop.signal,
        });
        await settle();
        stop.abort();
        const result = await outcome;
        expect(result).toMatchObject({ kind: 'failed', failure: { action: 'stopped' }, accepted: true });
        expect(result.kind === 'failed' && result.startedRunId).toBeUndefined();
    });

    it('no answer at all is retry; an empty 200 or one that isn’t a stream is ambiguous', async () => {
        const offline = await setup(() => Promise.reject(new Error('fetch failed: offline')));
        const body = offline.client.body({ threadId: THREAD, stored: [], message: user('u1', 'hi') });
        expect(await offline.client.run(DOT, body)).toMatchObject({ kind: 'failed', failure: { action: 'retry' } });
        const empty = streamedAnswer();
        const quiet = await setup(() => empty.response);
        const pending = quiet.client.run(DOT, body);
        empty.end();
        expect(await pending).toMatchObject({ kind: 'failed', failure: { action: 'ambiguous', status: 200 } });
        const json = await setup(() => answer(200, { body: {} }));
        expect(await json.client.run(DOT, body)).toMatchObject({ kind: 'failed', failure: { action: 'ambiguous' } });
    });

    it('its own signal stops it after RUN_STARTED, and the outcome says it had started', async () => {
        const stop = new AbortController();
        const stream = streamedAnswer({ signal: stop.signal });
        const { client, scope } = await setup(() => stream.response);
        const outcome = client.run(DOT, client.body({ threadId: THREAD, stored: [], message: user('u1', 'hi') }), {
            signal: stop.signal,
        });
        stream.push(started('run-5'));
        await settle();
        stop.abort();
        expect(await outcome).toMatchObject({
            kind: 'failed',
            failure: { action: 'stopped' },
            startedRunId: 'run-5',
        });
        expect(scope.signal.aborted).toBe(false);
    });

    it.each<{
        status: number;
        body?: Record<string, unknown>;
        headers: Record<string, string>;
        action: Record<string, unknown>;
    }>([
        {
            status: 503,
            body: { error: 'Updating', code: 'draining' },
            headers: { 'retry-after': '60' },
            action: { action: 'retry', retryAfterMs: 60_000, draining: true },
        },
        { status: 502, body: undefined, headers: {}, action: { action: 'retry' } },
        { status: 504, body: undefined, headers: {}, action: { action: 'retry' } },
        {
            status: 500,
            body: { error: 'Thread already running' },
            headers: {},
            action: { action: 'ambiguous', status: 500 },
        },
        {
            status: 409,
            body: { error: 'Thread already running', code: 'thread_running' },
            headers: {},
            action: { action: 'busy' },
        },
        // Only the code counts, never the text.
        {
            status: 409,
            body: { error: 'Something else', code: 'thread_running' },
            headers: {},
            action: { action: 'busy' },
        },
        {
            status: 409,
            body: { error: 'Thread already running' },
            headers: {},
            action: { action: 'unsent', reason: 'rejected' },
        },
        {
            status: 413,
            body: { error: 'This message is too long to send.' },
            headers: {},
            action: { action: 'unsent', reason: 'too-large' },
        },
        { status: 403, body: { error: 'denied' }, headers: {}, action: { action: 'unsent', reason: 'refused' } },
        {
            status: 400,
            body: { error: 'That attachment is gone.' },
            headers: {},
            action: { action: 'unsent', reason: 'content' },
        },
        { status: 404, body: { error: 'gone' }, headers: {}, action: { action: 'unsent', reason: 'gone' } },
        {
            status: 429,
            body: { error: 'Too many', code: 'cycle_rate' },
            headers: {},
            action: { action: 'wait', retryAfterMs: 60_000, code: 'cycle_rate' },
        },
        {
            status: 429,
            body: { error: 'Too many', code: 'cycle_rate' },
            headers: { 'retry-after': '12' },
            action: { action: 'wait', retryAfterMs: 12_000 },
        },
        {
            status: 503,
            body: { error: 'Setup required: model.' },
            headers: {},
            action: { action: 'setup', message: NO_INFERENCE_MESSAGES.operator },
        },
    ])('a $status $body.code answer: $action.action', async ({ status, body, headers, action }) => {
        const { client } = await setup(() =>
            body === undefined
                ? new Response('<html>Bad gateway</html>', { status, headers })
                : answer(status, { body, headers }),
        );
        const result = await client.run(DOT, client.body({ threadId: THREAD, stored: [], message: user('u1', 'hi') }));
        expect(result).toMatchObject({ kind: 'failed', failure: action });
    });

    it('a 400 with attachments re-uploads once, then goes to unsent', async () => {
        const { client } = await setup(() => answer(400, { body: { error: 'Upload expired.' } }));
        const body = client.body({ threadId: THREAD, stored: [], message: user('u1', 'see attached') });
        expect(await client.run(DOT, body, { attachments: true })).toMatchObject({ failure: { action: 'reupload' } });
        expect(await client.run(DOT, body, { attachments: true, reuploaded: true })).toMatchObject({
            failure: { action: 'unsent', reason: 'content' },
        });
    });
});

describe('connect and stop', () => {
    it('connect replays the runs after the cursor through x-cb-history-after', async () => {
        const stream = streamedAnswer();
        const { client, fetch } = await setup(() => stream.response);
        const outcome = client.connect(DOT, THREAD, { after: 41 });
        stream.push(started('run-a'));
        stream.push(finished('run-a'));
        stream.push(started('run-b'));
        stream.push(textStart());
        stream.push(text('live'));
        stream.push(finished('run-b'));
        stream.end();
        const result = await outcome;
        const [call] = fetch.calls;
        expect(call?.url).toBe(`${ORIGIN}${connectPath(DOT)}`);
        expect(sentHeaders(call)[HISTORY_AFTER_HEADER]).toBe('41');
        expect(sentBody(call)).toMatchObject({ threadId: THREAD, messages: [] });
        expect(result).toMatchObject({ kind: 'ended', runId: 'run-b' });
    });

    it('connect with nothing to replay ends quietly', async () => {
        const stream = streamedAnswer();
        const { client, fetch } = await setup(() => stream.response);
        const outcome = client.connect(DOT, THREAD);
        stream.end();
        expect(await outcome).toMatchObject({ kind: 'ended', runId: undefined });
        expect(sentHeaders(fetch.calls[0])[HISTORY_AFTER_HEADER]).toBeUndefined();
    });

    it('stop posts once to the stop path; offline is reported, never queued', async () => {
        const { client, fetch } = await setup(() => answer(200, { body: { stopped: true } }));
        expect(await client.stop(DOT, THREAD)).toEqual({ ok: true });
        expect(fetch.calls[0]?.url).toBe(`${ORIGIN}${stopPath(DOT, THREAD)}`);
        expect(fetch.calls[0]?.init.method).toBe('POST');
        const offline = await setup(() => Promise.reject(new Error('fetch failed')));
        expect(await offline.client.stop(DOT, THREAD)).toEqual({ ok: false, offline: true });
        expect(offline.fetch.calls).toHaveLength(1);
        const refused = await setup(() => answer(403, { body: { error: 'no', code: 'not_initiator' } }));
        expect(await refused.client.stop(DOT, THREAD)).toEqual({ ok: false, offline: false, status: 403 });
    });
});

describe('event names', () => {
    it('shared’s AG_UI_EVENT strings are @ag-ui/core’s EventType, key for key and value for value', () => {
        expect({ ...AG_UI_EVENT }).toEqual({ ...EventType });
    });
});

describe('reading the answer', () => {
    it('Retry-After is seconds, or an HTTP date on the server’s clock, never the device’s', () => {
        expect(retryAfterMs(new Headers({ 'retry-after': '30' }))).toBe(30_000);
        expect(retryAfterMs(new Headers({ 'retry-after': httpDate(T0 + 45_000), date: httpDate(T0) }))).toBe(45_000);
        expect(retryAfterMs(new Headers({ 'retry-after': httpDate(T0) }))).toBeUndefined();
        expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
        expect(retryAfterMs(new Headers())).toBeUndefined();
    });

    it('a 401 holds for sign-in; an unreadable 503 is away; a 501 is ambiguous', () => {
        expect(classifyRunAnswer({ status: 401, unreadable: false })).toEqual({ action: 'sign-in' });
        expect(classifyRunAnswer({ status: 503, unreadable: true })).toEqual({ action: 'retry' });
        expect(classifyRunAnswer({ status: 501, unreadable: false })).toEqual({ action: 'ambiguous', status: 501 });
        expect(classifyRunAnswer({ status: 409, unreadable: false })).toEqual({
            action: 'unsent',
            reason: 'rejected',
            status: 409,
        });
        // A busy thread (CB-357) is its code, never the 409 alone, nor the text: a definite answer.
        expect(classifyRunAnswer({ status: 409, code: 'thread_running', unreadable: false })).toEqual({
            action: 'busy',
        });
    });

    it('errors: an abort is a stop, no answer is retry, anything else unknown', () => {
        expect(classifyRunError(new AbortedError(ORIGIN))).toEqual({ action: 'stopped' });
        expect(classifyRunError(new NetworkError(ORIGIN))).toEqual({ action: 'retry' });
        expect(classifyRunError(new RedirectRefusedError(ORIGIN))).toEqual({ action: 'ambiguous', status: 0 });
    });

    it('RUN_ERROR codes for no model take the shared texts', () => {
        expect(noInferenceText('no_inference')).toBe(NO_INFERENCE_MESSAGES.connect);
        expect(noInferenceText('no_inference_operator')).toBe(NO_INFERENCE_MESSAGES.operator);
        expect(noInferenceText('model_config')).toBe(NO_INFERENCE_MESSAGES.operator);
        expect(noInferenceText('no_inference_choice')).toBe(NO_INFERENCE_MESSAGES.choice);
        expect(noInferenceText('cycle_limit')).toBeUndefined();
    });
});
