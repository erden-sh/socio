import { describe, expect, it } from 'vitest';

import { AbortedError, NetworkError } from '../../src/net/errors';
import { readJson, readText } from '../../src/net/read-body';
import { serverAway } from '../../src/net/reconnect';

import { ORIGIN } from './helpers';

// Reading an answer's body: a
// connection that breaks off mid-body, as the proxy cuts it in a restart
// (CB-108), fails with the same NetworkError as no answer at all, so
// `serverAway` rides it out on the phone as the web does.

const STATE_URL = `${ORIGIN}/api/state`;

/**
 * An answer whose body stream errors after its first chunk with a plain Error,
 * as expo/fetch's does (FetchResponse's didFailWithError: `new Error(error)`).
 */
function brokenOff(): Response {
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"conversations":['));
            },
            pull(controller) {
                controller.error(new Error('stream was reset: CANCEL'));
            },
        }),
        { status: 200 },
    );
    Object.defineProperty(response, 'url', { value: STATE_URL });
    return response;
}

describe('reading a body', () => {
    it('turns a body that breaks off into a NetworkError, which counts as the server being away', async () => {
        // Read as it comes, the failure is a plain Error, which serverAway can't tell from a bug.
        const raw = await brokenOff()
            .text()
            .catch((caught: unknown) => caught);
        expect(raw).not.toBeInstanceOf(TypeError);
        expect(serverAway(raw)).toBe(false);

        for (const read of [readText, readJson]) {
            const error = await read(brokenOff()).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(NetworkError);
            expect((error as NetworkError).url).toBe(STATE_URL);
            expect((error as NetworkError).cause).toBeInstanceOf(Error);
            expect(serverAway(error)).toBe(true);
        }
    });

    it('turns a read native code rejects into a NetworkError too', async () => {
        // expo/fetch's text() and json() reject with the native module's coded error.
        const response = Object.assign(new Response('{}'), {
            text: async () => {
                throw Object.assign(new Error('The network connection was lost.'), { code: 'ERR_FETCH_FAILED' });
            },
        });
        const error = await readJson(response).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(NetworkError);
        expect(serverAway(error)).toBe(true);
    });

    it('turns a read the scope stopped into an AbortedError, never the server being away', async () => {
        const scope = new AbortController();
        const response = Object.assign(new Response('{}'), {
            text: async () => {
                scope.abort();
                throw new Error('Fetch request has been canceled');
            },
        });
        const error = await readText(response, scope.signal).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AbortedError);
        expect(serverAway(error)).toBe(false);
        // Already stopped: the body isn't read.
        await expect(readText(new Response('{}'), scope.signal)).rejects.toBeInstanceOf(AbortedError);
    });

    it('reads a whole body, and leaves a body that isn’t JSON to the caller, not the network', async () => {
        expect(await readText(new Response('ok'))).toBe('ok');
        expect(await readJson(new Response('{"ok":true}'))).toEqual({ ok: true });
        const error = await readJson(new Response('<html>Bad gateway</html>', { status: 502 })).catch(
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(SyntaxError);
        expect(serverAway(error)).toBe(false);
    });
});
