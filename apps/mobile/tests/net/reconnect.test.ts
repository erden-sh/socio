import { describe, expect, it } from 'vitest';

import { UNREADABLE_RESPONSE } from '@socio/shared/reconnect';

import { AbortedError, NetworkError, RedirectRefusedError } from '../../src/net/errors';
import { failureOf, serverAway } from '../../src/net/reconnect';

// The app's errors read into shared's away check (@socio/shared/reconnect, whose
// tests are tests/shared-reconnect.test.ts at the root). Backoff is shared's alone.

/** An HTTP failure as the app's API client will throw it: a status, and the body it read. */
const httpError = (status: number, payload: unknown, message = `HTTP ${status}`) =>
    Object.assign(new Error(message), { status, payload });
const draining = httpError(503, { error: 'Socio is updating. Try again in a minute.', code: 'draining' });

describe('serverAway', () => {
    it('tells a server that is away or restarting from an error it explained', () => {
        for (const away of [
            draining,
            Object.assign(new Error('Socio is updating.'), { status: 503, code: 'draining' }),
            httpError(502, '<html>Bad gateway</html>'),
            httpError(504, 'Gateway timeout'),
            httpError(503, '<html>Service unavailable</html>'),
            httpError(502, undefined, UNREADABLE_RESPONSE),
            httpError(503, undefined, UNREADABLE_RESPONSE),
            new NetworkError(`https://brain.example.test/api/state`, new Error('fetch failed: offline')),
            new TypeError('Failed to fetch'),
            new TypeError('Network request failed'),
            new TypeError('Error in input stream'),
        ]) {
            expect(serverAway(away), String(away)).toBe(true);
        }
        for (const explained of [
            httpError(503, { error: 'Setup required: a model.' }),
            httpError(503, undefined, 'Setup required: a model.'),
            httpError(500, { error: 'Thread already running' }),
            httpError(401, { error: 'Sign in to continue.', code: 'sign_in' }),
            httpError(404, { error: 'Not found.' }),
            new AbortedError('https://brain.example.test/api/state'),
            new RedirectRefusedError('https://brain.example.test/api/state'),
            // expo/fetch's own failure, before authedFetch names it: a plain Error.
            new Error('fetch failed: The Internet connection appears to be offline.'),
            new TypeError("Cannot read properties of undefined (reading 'id')"),
            undefined,
            'Failed to fetch',
        ]) {
            expect(serverAway(explained), String(explained)).toBe(false);
        }
    });

    it('reads what the app knows about each failure', () => {
        expect(failureOf(draining)).toEqual({ status: 503, code: 'draining', unreadable: false });
        expect(failureOf(httpError(502, undefined, UNREADABLE_RESPONSE))).toEqual({
            status: 502,
            code: undefined,
            unreadable: true,
        });
        expect(failureOf(new NetworkError('https://brain.example.test/api/state'))).toEqual({
            code: undefined,
            network: true,
        });
        expect(failureOf(new AbortedError('https://brain.example.test/api/state'))).toEqual({ aborted: true });
        expect(failureOf(undefined)).toEqual({});
    });
});
