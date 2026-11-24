import { describe, expect, it } from 'vitest';

import type { Answered } from '../../src/net/authed-fetch';
import { CONTACT_WRITE_MS, countsAsContact, createContactTracker } from '../../src/sync/contact';
import { DAY, httpDate, MINUTE, ORIGIN, settle, T0 } from '../net/helpers';

import { syncSetup } from './helpers';

// The last contact: only 2xx or 304
// answers to requests that carried the session cookie, from /api
// routes past the session check, never /api/auth/*.

async function tracked() {
    const writes: number[] = [];
    let tracker: ReturnType<typeof createContactTracker> | undefined;
    const s = await syncSetup({ onAnswer: (answer) => tracker?.onAnswer(answer) });
    tracker = createContactTracker({
        jar: s.jar,
        persist: async (at) => {
            writes.push(at);
        },
    });
    return { s, tracker, writes };
}

describe('the last contact', () => {
    it('counts 2xx and 304 answers under /api, never /api/auth', () => {
        const url = (path: string) => new URL(path, ORIGIN);
        expect(countsAsContact(url('/api/state'), 200)).toBe(true);
        expect(countsAsContact(url('/api/workspace'), 304)).toBe(true);
        expect(countsAsContact(url('/api/conversations'), 201)).toBe(true);
        for (const status of [301, 401, 403, 404, 500, 502, 503]) {
            expect(countsAsContact(url('/api/state'), status), String(status)).toBe(false);
        }
        for (const path of ['/api/auth/session', '/api/auth', '/api/auth/sign-in/email', '/ping', '/apiary', '/']) {
            expect(countsAsContact(url(path), 200), path).toBe(false);
        }
    });

    it('records a 200 and a 304 from the sync sources, in the server’s time', async () => {
        const { s, tracker, writes } = await tracked();
        try {
            const { cursor } = await s.state.pull('', null);
            expect(tracker.last()).toBe(T0);
            expect(writes).toEqual([T0]);
            s.clock.server += 2 * MINUTE;
            s.clock.skew = -DAY;
            await s.state.pull('', cursor);
            expect(s.server.requests.at(-1)?.status).toBe(304);
            // The answer's Date, not the device clock, a day off.
            expect(tracker.last()).toBe(T0 + 2 * MINUTE);
            expect(writes).toEqual([T0, T0 + 2 * MINUTE]);
        } finally {
            await s.close();
        }
    });

    it('records no contact from a session answer with user: null, nor from a live one', async () => {
        const { s, tracker, writes } = await tracked();
        try {
            const live = await s.authed('/api/auth/session');
            expect(((await live.json()) as { user: unknown }).user).not.toBeNull();
            s.server.end();
            const dead = await s.authed('/api/auth/session');
            expect(dead.status).toBe(200);
            expect(((await dead.json()) as { user: unknown }).user).toBeNull();
            expect(tracker.last()).toBeNull();
            expect(writes).toEqual([]);
            // The next /api request answers 401: no contact either.
            await expect(s.state.pull('', null)).rejects.toMatchObject({ status: 401 });
            expect(tracker.last()).toBeNull();
        } finally {
            await s.close();
        }
    });

    it('records nothing for an answer to a request without the session cookie', () => {
        const writes: number[] = [];
        const jar = { sessionCookie: '__Host-cb.session_token', serverNow: () => T0 } as never;
        const tracker = createContactTracker({ jar, persist: async (at) => void writes.push(at) });
        const answered = (cookie: string | null): Answered => ({
            url: new URL('/api/state', ORIGIN),
            status: 200,
            date: httpDate(T0),
            sent: { cookie, sessionExpiresAt: null, sessionWithheld: false },
        });
        tracker.onAnswer(answered(null));
        tracker.onAnswer(answered('theme=dark'));
        tracker.onAnswer(answered('x__Host-cb.session_token=t1'));
        expect(tracker.last()).toBeNull();
        tracker.onAnswer(answered('theme=dark; __Host-cb.session_token=t1.c2ln'));
        expect(tracker.last()).toBe(T0);
    });

    it('writes at most once a minute, the rest on flush, and never moves back', async () => {
        const writes: number[] = [];
        let serverNow = T0;
        const jar = { sessionCookie: 'cb.session_token', serverNow: () => serverNow } as never;
        const tracker = createContactTracker({ jar, persist: async (at) => void writes.push(at) });
        const answer = (at: number) => {
            serverNow = at;
            tracker.onAnswer({
                url: new URL('/api/state', ORIGIN),
                status: 304,
                date: null,
                sent: { cookie: 'cb.session_token=t1', sessionExpiresAt: null, sessionWithheld: false },
            });
        };
        answer(T0);
        answer(T0 + 15_000);
        answer(T0 + 30_000);
        await settle();
        expect(writes).toEqual([T0]);
        answer(T0 + CONTACT_WRITE_MS);
        await settle();
        expect(writes).toEqual([T0, T0 + CONTACT_WRITE_MS]);
        answer(T0 + CONTACT_WRITE_MS + 15_000);
        answer(T0);
        expect(tracker.last()).toBe(T0 + CONTACT_WRITE_MS + 15_000);
        await tracker.flush();
        expect(writes).toEqual([T0, T0 + CONTACT_WRITE_MS, T0 + CONTACT_WRITE_MS + 15_000]);
        await tracker.flush();
        expect(writes).toHaveLength(3);
    });

    it('flushes the last contact even when the write in flight fails, and rejects when its own does', async () => {
        const writes: number[] = [];
        const errors: unknown[] = [];
        let failures = 1;
        const jar = { sessionCookie: 'cb.session_token', serverNow: () => T0 } as never;
        const tracker = createContactTracker({
            jar,
            persist: async (at) => {
                if (failures > 0) {
                    failures -= 1;
                    throw new Error('locked');
                }
                writes.push(at);
            },
            onError: (error) => errors.push(error),
        });
        const answer = () =>
            tracker.onAnswer({
                url: new URL('/api/state', ORIGIN),
                status: 200,
                date: null,
                sent: { cookie: 'cb.session_token=t1', sessionExpiresAt: null, sessionWithheld: false },
            });
        answer();
        // The app goes to the background while that write is still in flight, and it fails.
        await tracker.flush();
        expect(errors).toHaveLength(1);
        expect(writes).toEqual([T0]);

        const failing = createContactTracker({
            jar,
            persist: async () => {
                throw new Error('locked');
            },
        });
        failing.onAnswer({
            url: new URL('/api/state', ORIGIN),
            status: 200,
            date: null,
            sent: { cookie: 'cb.session_token=t1', sessionExpiresAt: null, sessionWithheld: false },
        });
        await expect(failing.flush()).rejects.toThrow('locked');
    });

    it('tries a failed write again with the next answer', async () => {
        const writes: number[] = [];
        const errors: unknown[] = [];
        let fail = true;
        let serverNow = T0;
        const jar = { sessionCookie: 'cb.session_token', serverNow: () => serverNow } as never;
        const tracker = createContactTracker({
            jar,
            persist: async (at) => {
                if (fail) {
                    throw new Error('locked');
                }
                writes.push(at);
            },
            onError: (error) => errors.push(error),
        });
        const answer = (at: number) => {
            serverNow = at;
            tracker.onAnswer({
                url: new URL('/api/workspace', ORIGIN),
                status: 200,
                date: null,
                sent: { cookie: 'cb.session_token=t1', sessionExpiresAt: null, sessionWithheld: false },
            });
        };
        answer(T0);
        await settle();
        expect(errors).toHaveLength(1);
        fail = false;
        answer(T0 + 15_000);
        await tracker.flush();
        expect(writes).toEqual([T0 + 15_000]);
    });
});
