import { describe, expect, it } from 'vitest';

import { noStore } from '../../src/net/fetch-function';

import { answer, fakeFetch, ORIGIN } from './helpers';

// CB-356: every request the app sends asks for no-store, so neither iOS's
// URLCache nor OkHttp's cache keeps a workspace's answer.

describe('noStore', () => {
    it('adds Cache-Control: no-store over any the caller set, keeping the rest of the request', async () => {
        const fetch = fakeFetch(() => answer(200));
        const signal = new AbortController().signal;
        await noStore(fetch)(`${ORIGIN}/api/state`, {
            method: 'GET',
            headers: { Accept: 'application/json', 'Cache-Control': 'max-age=60' },
            credentials: 'omit',
            redirect: 'error',
            signal,
        });
        expect(fetch.calls).toEqual([
            {
                url: `${ORIGIN}/api/state`,
                init: {
                    method: 'GET',
                    headers: { accept: 'application/json', 'cache-control': 'no-store' },
                    credentials: 'omit',
                    redirect: 'error',
                    signal,
                },
            },
        ]);
    });

    it('takes headers in any form, or none', async () => {
        const fetch = fakeFetch(() => answer(200));
        const request = noStore(fetch);
        await request(ORIGIN, {});
        await request(ORIGIN, { headers: [['x-one', '1']] });
        await request(ORIGIN, { headers: new Headers({ 'X-Two': '2' }) });
        expect(fetch.calls.map((call) => call.init.headers)).toEqual([
            { 'cache-control': 'no-store' },
            { 'x-one': '1', 'cache-control': 'no-store' },
            { 'x-two': '2', 'cache-control': 'no-store' },
        ]);
    });
});
