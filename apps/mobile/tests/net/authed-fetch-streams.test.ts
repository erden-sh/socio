import { describe, expect, it } from 'vitest';

import { createAuthedFetch, UPLOAD_PATH } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { AbortedError } from '../../src/net/errors';
import { readSse, type SseFrame } from '../../src/net/read-sse';

import {
    answer,
    deferred,
    fakeFetch,
    httpDate,
    ORIGIN,
    sentHeaders,
    sessionSetCookie,
    settle,
    streamedAnswer,
    T0,
} from './helpers';

// What the chat's requests add to authedFetch: a raw body for
// uploads, only to the upload path; a signal per request beside the scope's;
// the answer handed back with its body unread, so a stream is read live; and
// the device's time zone on the requests that ask for it.

const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';

/** An answer that never comes, rejecting as expo/fetch does once the request's signal aborts. */
const never = (signal: AbortSignal | null | undefined) =>
    new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('FetchError: aborted')));
    });

async function setup(respond: Parameters<typeof fakeFetch>[0] = () => answer(200, { date: httpDate(T0) })) {
    const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
    await jar.apply(new URL(`${ORIGIN}/api/auth/sign-in/email`), [sessionSetCookie('t1.c2ln%3D')], httpDate(T0));
    const scope = new AbortController();
    const fetch = fakeFetch(respond);
    const zone = { value: 'America/New_York' as string | undefined };
    const request = createAuthedFetch({
        origin: ORIGIN,
        jar,
        fetch,
        userAgent: USER_AGENT,
        signal: scope.signal,
        timeZone: () => zone.value,
    });
    return { jar, scope, fetch, request, zone };
}

describe('authedFetch: raw uploads', () => {
    it('sends a file’s bytes raw to the upload path, with the headers the server asks for', async () => {
        const { fetch, request } = await setup(() => answer(201, { body: { item: {}, attachment: {} } }));
        const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
        const response = await request(`${UPLOAD_PATH}?purpose=attachment&threadId=t1`, {
            upload: { body: bytes, name: 'Café menu #2.jpg', type: 'image/jpeg' },
        });
        expect(response.status).toBe(201);
        const [call] = fetch.calls;
        expect(call?.url).toBe(`${ORIGIN}/api/media/uploads?purpose=attachment&threadId=t1`);
        expect(call?.init.method).toBe('POST');
        expect(call?.init.body).toBe(bytes);
        const headers = sentHeaders(call);
        expect(headers['content-type']).toBe('application/octet-stream');
        expect(headers['x-cb-upload']).toBe('1');
        expect(headers['x-file-name']).toBe('Caf%C3%A9%20menu%20%232.jpg');
        expect(headers['x-file-type']).toBe('image/jpeg');
        expect(headers.origin).toBe(ORIGIN);
        expect(headers.cookie).toContain('t1.c2ln%3D');
    });

    it('sends a dataset file’s bytes raw to its dataset’s files (CB-469), and nowhere under it', async () => {
        const { fetch, request } = await setup(() => answer(201, { body: { schema: 1, file: {} } }));
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        await request('/api/data/datasets/ds%20acme/files', {
            upload: { body: bytes, name: 'acme brief.pdf', type: 'application/pdf' },
        });
        const [call] = fetch.calls;
        expect(call?.url).toBe(`${ORIGIN}/api/data/datasets/ds%20acme/files`);
        expect(call?.init.body).toBe(bytes);
        expect(sentHeaders(call)['x-cb-upload']).toBe('1');
        expect(sentHeaders(call)['x-file-name']).toBe('acme%20brief.pdf');
        const upload = { body: bytes, name: 'a.pdf' };
        for (const path of [
            '/api/data/datasets/ds1/files/f1',
            '/api/data/datasets/ds1/tables/t/files',
            '/api/data/datasets//files',
            '/api/data/datasets/ds1/rows',
        ]) {
            await expect(request(path, { upload })).rejects.toThrow(TypeError);
        }
        expect(fetch.calls).toHaveLength(1);
    });

    it('leaves X-File-Type out when the type isn’t known', async () => {
        const { fetch, request } = await setup();
        await request(UPLOAD_PATH, { upload: { body: new Uint8Array([1]), name: 'notes' } });
        expect(sentHeaders(fetch.calls[0])).not.toHaveProperty('x-file-type');
    });

    it('refuses a raw body anywhere but the upload path, and sends nothing', async () => {
        const { fetch, request } = await setup();
        const upload = { body: new Uint8Array([1]), name: 'a.txt' };
        for (const path of [
            '/api/conversations',
            '/api/media/uploads/x',
            '/api/media/upload',
            '/api/copilotkit/agent/d1/run',
        ]) {
            await expect(request(path, { method: 'POST', upload })).rejects.toThrow(TypeError);
        }
        await expect(request(UPLOAD_PATH, { method: 'PUT', upload })).rejects.toThrow(TypeError);
        await expect(request(UPLOAD_PATH, { upload, json: { a: 1 } })).rejects.toThrow(TypeError);
        await expect(request(UPLOAD_PATH, { upload: { ...upload, name: '  ' } })).rejects.toThrow(TypeError);
        expect(fetch.calls).toHaveLength(0);
    });

    it('keeps every other write JSON, and lets no caller set the upload headers by hand', async () => {
        const { fetch, request } = await setup();
        await request('/api/conversations', { method: 'POST', json: { title: 'x' } });
        expect(sentHeaders(fetch.calls[0])['content-type']).toBe('application/json');
        expect(sentHeaders(fetch.calls[0])).not.toHaveProperty('x-cb-upload');
        for (const name of ['X-CB-Upload', 'X-File-Name', 'x-file-type', 'X-Time-Zone']) {
            await expect(request(UPLOAD_PATH, { method: 'POST', json: {}, headers: { [name]: '1' } })).rejects.toThrow(
                TypeError,
            );
        }
        expect(fetch.calls).toHaveLength(1);
    });
});

describe('authedFetch: a signal per request', () => {
    it('stops one request on its own signal, and leaves the scope’s other requests running', async () => {
        const held = deferred<Response>();
        const { fetch, request, scope } = await setup((url, init) =>
            url.endsWith('/run') ? never(init.signal) : held.promise,
        );
        const own = new AbortController();
        const run = request('/api/copilotkit/agent/d1/run', { method: 'POST', json: {}, signal: own.signal }).catch(
            (caught: unknown) => caught,
        );
        const state = request('/api/state');
        await settle();
        const runSignal = fetch.calls[0]?.init.signal;
        expect(runSignal).not.toBe(scope.signal);
        own.abort();
        expect(runSignal?.aborted).toBe(true);
        expect(fetch.calls[1]?.init.signal?.aborted).toBe(false);
        held.resolve(answer(200));
        expect((await state).status).toBe(200);
        expect(await run).toBeInstanceOf(AbortedError);
        expect(scope.signal.aborted).toBe(false);
    });

    it('stops a request with its own signal when the scope closes', async () => {
        const { fetch, request, scope } = await setup((_url, init) => never(init.signal));
        const own = new AbortController();
        const run = request('/api/state', { signal: own.signal }).catch((caught: unknown) => caught);
        await settle();
        scope.abort('switched');
        expect(fetch.calls[0]?.init.signal?.aborted).toBe(true);
        expect(fetch.calls[0]?.init.signal?.reason).toBe('switched');
        expect(await run).toBeInstanceOf(AbortedError);
        expect(own.signal.aborted).toBe(false);
    });

    it('sends nothing when its own signal has already aborted', async () => {
        const { fetch, request } = await setup();
        const own = new AbortController();
        own.abort();
        await expect(request('/api/state', { signal: own.signal })).rejects.toBeInstanceOf(AbortedError);
        expect(fetch.calls).toHaveLength(0);
    });
});

describe('authedFetch: streamed answers', () => {
    it('hands the answer back with its body unread, its Set-Cookie applied, and the stream read live', async () => {
        let stream!: ReturnType<typeof streamedAnswer>;
        const { jar, request } = await setup((_url, init) => {
            stream = streamedAnswer({ setCookie: [sessionSetCookie('slid')], signal: init.signal });
            return stream.response;
        });
        const response = await request('/api/conversations/t1/stream?after=3', {
            headers: { accept: 'text/event-stream' },
        });
        expect(response.bodyUsed).toBe(false);
        expect(jar.session()?.value).toBe('slid');
        const frames: SseFrame[] = [];
        const done = readSse(response, (frame) => frames.push(frame));
        stream.push('data: {"type":"RUN_STARTED","runId":"r4"}\n\n');
        await settle();
        expect(frames).toEqual([{ kind: 'event', event: { type: 'RUN_STARTED', runId: 'r4' } }]);
        stream.push('event: cursor\nid: 4\ndata: {"seq":4}\n\n');
        stream.end();
        await done;
        expect(frames.at(-1)).toEqual({ kind: 'cursor', seq: 4 });
    });

    it('stops a body mid-read when the request’s own signal aborts', async () => {
        let stream!: ReturnType<typeof streamedAnswer>;
        const { request } = await setup((_url, init) => {
            stream = streamedAnswer({ signal: init.signal });
            return stream.response;
        });
        const own = new AbortController();
        const response = await request('/api/copilotkit/agent/d1/run', {
            method: 'POST',
            json: {},
            signal: own.signal,
        });
        const frames: SseFrame[] = [];
        const done = readSse(response, (frame) => frames.push(frame), { signal: own.signal }).catch(
            (caught: unknown) => caught,
        );
        stream.push('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"TEXT_');
        await settle();
        own.abort();
        expect(await done).toBeInstanceOf(AbortedError);
        expect(frames).toHaveLength(1);
    });
});

describe('authedFetch: the device’s time zone', () => {
    it('sends X-Time-Zone only on requests that ask for it', async () => {
        const { fetch, request } = await setup();
        await request('/api/state');
        await request('/api/copilotkit/agent/d1/run', { method: 'POST', json: {}, timeZone: true });
        expect(sentHeaders(fetch.calls[0])).not.toHaveProperty('x-time-zone');
        expect(sentHeaders(fetch.calls[1])['x-time-zone']).toBe('America/New_York');
    });

    it('leaves it out when the device’s zone isn’t known', async () => {
        const { fetch, request, zone } = await setup();
        zone.value = undefined;
        await request('/api/copilotkit/agent/d1/run', { method: 'POST', json: {}, timeZone: true });
        expect(sentHeaders(fetch.calls[0])).not.toHaveProperty('x-time-zone');
    });

    it('takes the device’s zone through shared’s ianaTimeZone by default', async () => {
        const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: () => T0 });
        const fetch = fakeFetch();
        const request = createAuthedFetch({
            origin: ORIGIN,
            jar,
            fetch,
            userAgent: USER_AGENT,
            signal: new AbortController().signal,
        });
        await request('/api/copilotkit/agent/d1/run', { method: 'POST', json: {}, timeZone: true });
        const sent = sentHeaders(fetch.calls[0])['x-time-zone'];
        expect(sent).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});
