import { describe, expect, it } from 'vitest';

import {
    appFromUserAgent,
    appVerdict,
    CLIENT_COMPAT_PATH,
    compareAppVersions,
    isAppVersion,
    readClientUpdateRequired,
} from '@socio/shared/client-compat';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import {
    CLIENT_COMPAT_DISMISSED_KEY,
    CLIENT_COMPAT_KEY,
    compatFromAnswer,
    compatState,
    createClientCompat,
    readKept,
} from '../../src/sync/client-compat';
import type { ViewState } from '../../src/sync/view-state';

// Whether this app is new enough for one workspace's server (CB-553,
// src/sync/client-compat.ts): the numbers read from `GET /api/client/compat`,
// kept in cache.db's kv, the gate and the banner, a 426, and two workspaces
// on one phone whose servers ask different things.

const IOS = 'Socio/0.2.7 (iPhone; iOS 26)';
const ANDROID = 'Socio/0.2.7 (Android; Android 16)';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const numbers = (minimum: string, recommended: string) => ({
    platforms: { ios: { minimum, recommended }, android: { minimum, recommended } },
});

function memoryViewState(initial: Record<string, string> = {}): ViewState & { values: Map<string, string> } {
    const values = new Map(Object.entries(initial));
    return {
        values,
        get: (key) => values.get(key) ?? null,
        set: (key, value) => void values.set(key, value),
        flush: async () => {},
        close: async () => {},
    };
}

/** A workspace server whose answer to the compat endpoint the test sets. */
function fakeServer(answer: () => Response | Promise<Response>) {
    const asked: string[] = [];
    const fetch: AuthedFetch = async (input) => {
        asked.push(input);
        return answer();
    };
    return { fetch, asked };
}

describe('app versions', () => {
    it('orders by parts, a missing part 0, numbers not text', () => {
        expect(compareAppVersions('0.2.7', '0.2.7')).toBe(0);
        expect(compareAppVersions('0.2', '0.2.0')).toBe(0);
        expect(compareAppVersions('1', '1.0.0.0')).toBe(0);
        expect(compareAppVersions('0.2.10', '0.2.9')).toBe(1);
        expect(compareAppVersions('0.10.0', '0.9.9')).toBe(1);
        expect(compareAppVersions('0.2.7', '0.2.7.1')).toBe(-1);
        expect(compareAppVersions('0.3', '0.2.99')).toBe(1);
        expect(compareAppVersions('0.2.6', '0.2.7')).toBe(-1);
    });

    it('takes plain whole-number versions only', () => {
        for (const version of ['0.2.7', '1', '1.0', '9999.9999.9999.9999']) {
            expect(isAppVersion(version), version).toBe(true);
        }
        for (const version of ['', 'v0.2.7', '0.2.7-rc.1', '0.2.7.1.2', '0..1', ' 0.2.7', '10000', 7, null]) {
            expect(isAppVersion(version), String(version)).toBe(false);
        }
    });

    it('reads the app and its platform from its own User-Agent, an iPad as iOS', () => {
        expect(appFromUserAgent(IOS)).toEqual({ version: '0.2.7', platform: 'ios' });
        expect(appFromUserAgent('Socio/0.3 (iPad; iOS 26)')).toEqual({ version: '0.3', platform: 'ios' });
        expect(appFromUserAgent(ANDROID)).toEqual({ version: '0.2.7', platform: 'android' });
        expect(appFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)')).toBeNull();
        expect(appFromUserAgent('Socio/dev (iPhone; iOS 26)')).toBeNull();
        expect(appFromUserAgent(null)).toBeNull();
    });

    it('is refused below the minimum, asked between, current at or above the recommendation', () => {
        const compat = { minimum: '0.2.7', recommended: '0.2.9' };
        expect(appVerdict('0.2.6', compat)).toBe('required');
        expect(appVerdict('0.2.7', compat)).toBe('recommended');
        expect(appVerdict('0.2.8', compat)).toBe('recommended');
        expect(appVerdict('0.2.9', compat)).toBe('current');
        expect(appVerdict('0.3', compat)).toBe('current');
    });

    it('reads only a well-formed 426 body', () => {
        expect(readClientUpdateRequired({ code: 'client_update_required', minimum: '0.2.8', platform: 'ios' })).toEqual(
            { minimum: '0.2.8', platform: 'ios' },
        );
        expect(readClientUpdateRequired({ code: 'other', minimum: '0.2.8', platform: 'ios' })).toBeNull();
        expect(readClientUpdateRequired({ code: 'client_update_required', minimum: 'x', platform: 'ios' })).toBeNull();
        expect(readClientUpdateRequired('nope')).toBeNull();
    });
});

describe('reading the endpoint’s answer', () => {
    it('takes the platform’s numbers, a recommendation below the minimum as the minimum', async () => {
        expect(await compatFromAnswer(json(200, numbers('0.2.7', '0.2.9')), 'ios')).toEqual({
            kind: 'known',
            minimum: '0.2.7',
            recommended: '0.2.9',
        });
        expect(await compatFromAnswer(json(200, numbers('0.2.8', '0.2.1')), 'android')).toEqual({
            kind: 'known',
            minimum: '0.2.8',
            recommended: '0.2.8',
        });
    });

    it('reads an older server (a 404, a page that isn’t its JSON) as no app minimum', async () => {
        expect(await compatFromAnswer(new Response('Not found', { status: 404 }), 'ios')).toEqual({ kind: 'none' });
        // Asked with no cookie, an older server's session check answers before its 404.
        expect(await compatFromAnswer(json(401, { code: 'sign_in' }), 'ios')).toEqual({ kind: 'none' });
        expect(await compatFromAnswer(new Response('<!doctype html>', { status: 200 }), 'ios')).toEqual({
            kind: 'none',
        });
        expect(await compatFromAnswer(json(200, { platforms: {} }), 'ios')).toEqual({ kind: 'none' });
    });

    it('keeps what was known for the server away or any other refusal', async () => {
        for (const status of [500, 502, 503, 403, 429]) {
            expect(await compatFromAnswer(json(status, {}), 'ios'), String(status)).toBeNull();
        }
    });

    it('reads a kept copy back, and nothing from one it can’t read', () => {
        expect(readKept(JSON.stringify({ v: 1, minimum: '0.2.7', recommended: '0.2.8' }), 'ios')).toEqual({
            kind: 'known',
            minimum: '0.2.7',
            recommended: '0.2.8',
        });
        expect(readKept(JSON.stringify({ v: 1, none: true }), 'ios')).toEqual({ kind: 'none' });
        expect(readKept(JSON.stringify({ v: 2, minimum: '0.2.7', recommended: '0.2.8' }), 'ios')).toEqual({
            kind: 'unknown',
        });
        expect(readKept('{', 'ios')).toEqual({ kind: 'unknown' });
        expect(readKept(null, 'ios')).toEqual({ kind: 'unknown' });
    });
});

describe('the gate and the banner', () => {
    const known = (minimum: string, recommended: string) => ({ kind: 'known', minimum, recommended }) as const;

    it('closes below the minimum, and after a 426 whatever was known', () => {
        expect(compatState(known('0.2.8', '0.2.8'), '0.2.7', false, null)).toEqual({
            required: true,
            minimum: '0.2.8',
            recommended: null,
            version: '0.2.7',
        });
        expect(compatState({ kind: 'none' }, '0.2.7', true, null).required).toBe(true);
        expect(compatState({ kind: 'unknown' }, null, true, null).required).toBe(true);
    });

    it('shows the banner between the two, until dismissed for that recommendation', () => {
        expect(compatState(known('0.2.7', '0.2.9'), '0.2.7', false, null)).toMatchObject({
            required: false,
            recommended: '0.2.9',
        });
        expect(compatState(known('0.2.7', '0.2.9'), '0.2.7', false, '0.2.9').recommended).toBeNull();
        // A higher recommendation shows it again.
        expect(compatState(known('0.2.7', '0.3.0'), '0.2.7', false, '0.2.9').recommended).toBe('0.3.0');
    });

    it('shows neither at or above the recommendation, nor for a server with none, nor before any answer', () => {
        expect(compatState(known('0.2.7', '0.2.7'), '0.2.7', false, null)).toMatchObject({
            required: false,
            recommended: null,
        });
        expect(compatState({ kind: 'none' }, '0.2.7', false, null)).toMatchObject({
            required: false,
            recommended: null,
        });
        expect(compatState({ kind: 'unknown' }, '0.2.7', false, null)).toMatchObject({
            required: false,
            recommended: null,
        });
    });
});

describe('one workspace’s compat', () => {
    it('reads the endpoint, keeps the answer, and closes the gate below the minimum', async () => {
        const server = fakeServer(() => json(200, numbers('0.2.8', '0.2.8')));
        const viewState = memoryViewState();
        const compat = createClientCompat({ fetch: server.fetch, userAgent: IOS, viewState });
        const heard: boolean[] = [];
        compat.subscribe(() => heard.push(compat.state().required));
        expect(compat.state().required).toBe(false);
        await compat.check();
        expect(server.asked).toEqual([CLIENT_COMPAT_PATH]);
        expect(compat.state()).toEqual({ required: true, minimum: '0.2.8', recommended: null, version: '0.2.7' });
        expect(heard).toEqual([true]);
        expect(JSON.parse(viewState.values.get(CLIENT_COMPAT_KEY)!)).toEqual({
            v: 1,
            minimum: '0.2.8',
            recommended: '0.2.8',
        });
    });

    it('shows the kept gate at a cold start offline, before any answer', async () => {
        const viewState = memoryViewState({
            [CLIENT_COMPAT_KEY]: JSON.stringify({ v: 1, minimum: '0.2.8', recommended: '0.2.8' }),
        });
        const server = fakeServer(() => Promise.reject(new TypeError('Network request failed')));
        const errors: unknown[] = [];
        const compat = createClientCompat({
            fetch: server.fetch,
            userAgent: ANDROID,
            viewState,
            onError: (error) => errors.push(error),
        });
        expect(compat.state().required).toBe(true);
        await compat.check();
        // No answer: what was known stands.
        expect(compat.state().required).toBe(true);
        expect(errors).toHaveLength(1);
    });

    it('opens again once the server lowers its minimum (the foreground’s or Check again’s read)', async () => {
        let minimum = '0.2.8';
        const server = fakeServer(() => json(200, numbers(minimum, minimum)));
        const compat = createClientCompat({ fetch: server.fetch, userAgent: IOS, viewState: memoryViewState() });
        await compat.check();
        expect(compat.state().required).toBe(true);
        minimum = '0.2.7';
        await compat.check();
        expect(compat.state().required).toBe(false);
    });

    it('closes at once on a 426, reads once, and opens if the numbers say this app is fine', async () => {
        let answer = json(200, numbers('0.2.7', '0.2.7'));
        const server = fakeServer(() => answer);
        const compat = createClientCompat({ fetch: server.fetch, userAgent: IOS, viewState: memoryViewState() });
        await compat.check();
        answer = json(200, numbers('0.2.8', '0.2.8'));
        compat.refused();
        expect(compat.state().required).toBe(true);
        // A pull's further 426s while closed read nothing more.
        compat.refused();
        compat.refused();
        await compat.check();
        expect(server.asked).toHaveLength(3);
        expect(compat.state().minimum).toBe('0.2.8');
        // A 426 the numbers don't back (the minimum lowered meanwhile) opens with the next read.
        answer = json(200, numbers('0.2.7', '0.2.7'));
        await compat.check();
        expect(compat.state().required).toBe(false);
    });

    it('keeps one read in flight, and one asked meanwhile runs once after it', async () => {
        let release = () => {};
        const server = fakeServer(
            () =>
                new Promise<Response>((done) => {
                    release = () => done(json(200, numbers('0.2.7', '0.2.7')));
                }),
        );
        const compat = createClientCompat({ fetch: server.fetch, userAgent: IOS, viewState: memoryViewState() });
        const first = compat.check();
        void compat.check();
        void compat.check();
        await Promise.resolve();
        release();
        await new Promise((done) => setTimeout(done, 0));
        release();
        await first;
        expect(server.asked).toHaveLength(2);
    });

    it('treats a server without the endpoint as having no app minimum, and remembers that', async () => {
        const viewState = memoryViewState({
            [CLIENT_COMPAT_KEY]: JSON.stringify({ v: 1, minimum: '0.2.8', recommended: '0.2.8' }),
        });
        const compat = createClientCompat({
            fetch: fakeServer(() => new Response('Not found', { status: 404 })).fetch,
            userAgent: IOS,
            viewState,
        });
        expect(compat.state().required).toBe(true);
        await compat.check();
        expect(compat.known()).toEqual({ kind: 'none' });
        expect(compat.state()).toMatchObject({ required: false, recommended: null });
        expect(viewState.values.get(CLIENT_COMPAT_KEY)).toBe(JSON.stringify({ v: 1, none: true }));
    });

    it('keeps what it knew through a 5xx', async () => {
        let answer = json(200, numbers('0.2.7', '0.2.9'));
        const compat = createClientCompat({
            fetch: fakeServer(() => answer).fetch,
            userAgent: IOS,
            viewState: memoryViewState(),
        });
        await compat.check();
        answer = json(503, { code: 'draining' });
        await compat.check();
        expect(compat.known()).toEqual({ kind: 'known', minimum: '0.2.7', recommended: '0.2.9' });
    });

    it('dismisses the banner for its recommendation only, kept across a reopen', async () => {
        let recommended = '0.2.9';
        const server = fakeServer(() => json(200, numbers('0.2.7', recommended)));
        const viewState = memoryViewState();
        const compat = createClientCompat({ fetch: server.fetch, userAgent: IOS, viewState });
        await compat.check();
        expect(compat.state().recommended).toBe('0.2.9');
        compat.dismiss();
        expect(compat.state().recommended).toBeNull();
        expect(viewState.values.get(CLIENT_COMPAT_DISMISSED_KEY)).toBe('0.2.9');

        const reopened = createClientCompat({ fetch: server.fetch, userAgent: IOS, viewState });
        expect(reopened.state().recommended).toBeNull();
        recommended = '0.3.0';
        await reopened.check();
        expect(reopened.state().recommended).toBe('0.3.0');
    });

    it('reads nothing for a User-Agent that isn’t the app’s', async () => {
        const server = fakeServer(() => json(200, numbers('9.0', '9.0')));
        const compat = createClientCompat({
            fetch: server.fetch,
            userAgent: 'something-else/1.0',
            viewState: memoryViewState(),
        });
        await compat.check();
        expect(server.asked).toEqual([]);
        expect(compat.state().required).toBe(false);
    });

    it('takes no answer and tells nobody once disposed', async () => {
        let release = () => {};
        const server = fakeServer(
            () =>
                new Promise<Response>((done) => {
                    release = () => done(json(200, numbers('0.2.8', '0.2.8')));
                }),
        );
        const compat = createClientCompat({ fetch: server.fetch, userAgent: IOS, viewState: memoryViewState() });
        let told = 0;
        compat.subscribe(() => told++);
        const reading = compat.check();
        await Promise.resolve();
        compat.dispose();
        release();
        await reading;
        expect(compat.state().required).toBe(false);
        expect(told).toBe(0);
        compat.refused();
        expect(compat.state().required).toBe(false);
    });
});

describe('two workspaces on one phone', () => {
    it('gates only the one whose server needs a newer app', async () => {
        const acme = createClientCompat({
            fetch: fakeServer(() => json(200, numbers('0.2.8', '0.2.8'))).fetch,
            userAgent: IOS,
            viewState: memoryViewState(),
        });
        const globex = createClientCompat({
            fetch: fakeServer(() => json(200, numbers('0.2.7', '0.2.7'))).fetch,
            userAgent: IOS,
            viewState: memoryViewState(),
        });
        const older = createClientCompat({
            fetch: fakeServer(() => new Response('Not found', { status: 404 })).fetch,
            userAgent: IOS,
            viewState: memoryViewState(),
        });
        await Promise.all([acme.check(), globex.check(), older.check()]);
        expect(acme.state().required).toBe(true);
        expect(globex.state().required).toBe(false);
        expect(older.state().required).toBe(false);
        // A 426 from one workspace's server closes that one alone.
        globex.refused();
        expect(globex.state().required).toBe(true);
        expect(older.state().required).toBe(false);
    });
});
