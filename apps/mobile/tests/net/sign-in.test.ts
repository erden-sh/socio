import { inspect } from 'node:util';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';

import { type JarStore, memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { AbortedError } from '../../src/net/errors';
import {
    LOGOUT_PATH,
    SESSION_PATH,
    SIGN_IN_PATH,
    SIGN_OUT_TIMEOUT_MS,
    type SignInOptions,
    type SignInProblem,
    type SignInResult,
    signInWithPassword,
    type StagedSignIn,
} from '../../src/net/sign-in';
import {
    EMAIL_NOT_VERIFIED,
    GENERIC,
    INVALID_EMAIL,
    NOT_SIGNED_IN,
    PASSWORD_OFF,
    SERVER_ERROR,
    signInCopy,
    UNREACHABLE,
    WRONG_CREDENTIALS,
} from '../../src/net/sign-in-copy';

import {
    answer,
    type AnswerOptions,
    type Call,
    cookieValue,
    deferred,
    fakeFetch,
    httpDate,
    ORIGIN,
    SESSION,
    sentHeaders,
    sessionSetCookie,
    T0,
} from './helpers';

// Signing in (src/net/sign-in.ts)
// against a fake workspace that answers as the real one does
// (src/server/auth/better-auth.ts on Better Auth 1.7.10): the request, the
// session check that gives the app user id, each refusal's mapping to the copy
// table, the staging jar discarded on failure and cancel, and the password
// going nowhere but the request's body.

const USER_AGENT = 'Socio/0.1.0 (Pixel 4; Android 13)';
const EMAIL = 'ada@example.test';
/** Distinctive, so a search finds any copy of it. */
const PASSWORD = 'pw-7f3a-correct-horse-battery';
/** Better Auth's raw session token; the cookie is it and its signature. */
const TOKEN = 'rawtoken7f3a';
const COOKIE = `${TOKEN}.c2lnbmF0dXJl%3D`;
/** Text the server sends that must never reach the person. */
const SERVER_TEXT = 'Server words the app must not show.';

const json = (status: number, body: unknown, options: AnswerOptions = {}) =>
    answer(status, {
        date: httpDate(T0),
        ...options,
        headers: { 'content-type': 'application/json', ...options.headers },
        body,
    });

/** Better Auth's 200: its `user.id` is Better Auth's id, and neither it nor `token` may be used. */
const signedIn = () =>
    json(
        200,
        {
            redirect: false,
            token: TOKEN,
            url: null,
            user: { id: 'better-auth-id-1', email: EMAIL, name: 'Ada', appUserId: 'body-app-user-id' },
        },
        { setCookie: [sessionSetCookie(COOKIE)] },
    );

const sessionView = (user: unknown) =>
    json(200, {
        provider: 'betterauth',
        branding: { name: 'Acme', logo: '/favicon.svg' },
        methods: { passkey: false, password: true, signUp: false, emailReset: false, signInLink: false, providers: [] },
        user,
    });

/** `GET /api/auth/session`: the app user for the jar's cookie, `user: null` without it. */
const sessionFor = (call: Call) =>
    cookieValue(sentHeaders(call).cookie, SESSION) === COOKIE
        ? sessionView({ id: 'u-ada', name: 'Ada', role: 'member' })
        : sessionView(null);

interface Workspace {
    signIn?: (call: Call) => Response | Promise<Response>;
    session?: (call: Call) => Response | Promise<Response>;
    logout?: (call: Call) => Response | Promise<Response>;
}

/** A fetch that answers as the workspace does. */
function workspace(handlers: Workspace = {}) {
    return fakeFetch((url: string, init: FetchRequestInit) => {
        const call = { url, init };
        switch (new URL(url).pathname) {
            case SIGN_IN_PATH:
                return handlers.signIn?.(call) ?? signedIn();
            case SESSION_PATH:
                return handlers.session?.(call) ?? sessionFor(call);
            case LOGOUT_PATH:
                return handlers.logout?.(call) ?? json(200, { ok: true }, { setCookie: [sessionSetCookie('', 0)] });
            default:
                return json(404, { error: 'Not found.' });
        }
    });
}

/** A staging store that keeps every value written to it. */
function recordingStore(): JarStore & { readonly value: string | null; readonly writes: string[] } {
    const inner = memoryJarStore();
    const writes: string[] = [];
    return {
        get value() {
            return inner.value;
        },
        writes,
        read: () => inner.read(),
        write: async (value) => {
            writes.push(value);
            await inner.write(value);
        },
    };
}

function signIn(fetch: SignInOptions['fetch'], options: Partial<SignInOptions> = {}): Promise<SignInResult> {
    return signInWithPassword({
        origin: ORIGIN,
        email: EMAIL,
        password: PASSWORD,
        fetch,
        userAgent: USER_AGENT,
        now: () => T0,
        ...options,
    });
}

function staged(result: SignInResult): StagedSignIn {
    if (!result.ok) {
        throw new Error(`Expected a sign-in, got ${result.problem.kind}.`);
    }
    return result.signIn;
}

function problemOf(result: SignInResult): SignInProblem {
    if (result.ok) {
        throw new Error('Expected a problem, got a sign-in.');
    }
    return result.problem;
}

/** Each call as `METHOD /path`. */
const paths = (fetch: { readonly calls: readonly Call[] }) =>
    fetch.calls.map((call) => `${call.init.method ?? 'GET'} ${new URL(call.url).pathname}`);

/** The last call was the sign-out, with the staged session's cookie. */
function signedOut(fetch: { readonly calls: readonly Call[] }) {
    const logout = fetch.calls.at(-1);
    expect(logout?.url).toBe(`${ORIGIN}${LOGOUT_PATH}`);
    expect(logout?.init.method).toBe('POST');
    expect(sentHeaders(logout).cookie).toBe(`${SESSION}=${COOKIE}`);
}

/** The staging store holds no cookie and no session: the jar was discarded. */
function emptied(store: { readonly value: string | null }) {
    expect(store.value).not.toBeNull();
    expect(JSON.parse(store.value!)).toMatchObject({ cookies: [], sessionExpiresAt: null });
}

/** Every console method, spied, so a test can show nothing was logged. */
const CONSOLE = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
    consoleSpies = CONSOLE.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('signInWithPassword: the request', () => {
    it('posts exactly {email, password} to the workspace, through a fresh jar, with Origin and JSON', async () => {
        const fetch = workspace();
        staged(await signIn(fetch, { email: `  ${EMAIL} ` }));
        const [post] = fetch.calls;
        expect(post.url).toBe(`${ORIGIN}${SIGN_IN_PATH}`);
        expect(post.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
        expect(JSON.parse(String(post.init.body))).toEqual({ email: EMAIL, password: PASSWORD });
        expect(sentHeaders(post)).toEqual({
            accept: 'application/json',
            'content-type': 'application/json',
            origin: ORIGIN,
            'user-agent': USER_AGENT,
        });
    });

    it('then asks the session through the same jar, with the new cookie', async () => {
        const fetch = workspace();
        staged(await signIn(fetch));
        expect(fetch.calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`)).toEqual([
            `POST ${SIGN_IN_PATH}`,
            `GET ${SESSION_PATH}`,
        ]);
        const get = fetch.calls[1];
        expect(sentHeaders(get).cookie).toBe(`${SESSION}=${COOKIE}`);
        expect(sentHeaders(get).origin).toBe(ORIGIN);
        expect(get.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    });

    it('takes the app user id from the session’s user.id, never the sign-in body’s user.id, appUserId or token', async () => {
        const signInBody = staged(await signIn(workspace()));
        expect(signInBody).toMatchObject({
            origin: ORIGIN,
            appUserId: 'u-ada',
            personName: 'Ada',
            personEmail: EMAIL,
            workspaceName: 'Acme',
        });
        const { jar: _jar, ...fields } = signInBody;
        const text = JSON.stringify(fields);
        for (const unused of ['better-auth-id-1', 'body-app-user-id', TOKEN]) {
            expect(text).not.toContain(unused);
        }
    });

    it('stages the cookies in memory only, in a jar a workspace’s jar slot can open', async () => {
        const store = recordingStore();
        const result = staged(await signIn(workspace(), { stagingStore: store }));
        const copy = memoryJarStore(result.jar.serialize());
        const jar = await openCookieJar({ origin: ORIGIN, store: copy, now: () => T0 });
        expect(jar.session()?.value).toBe(COOKIE);
        expect(jar.sessionExpiresAt()).toBe(T0 + 604_800_000);
    });

    it('needs an empty staging store: a jar with cookies in it is never sent', async () => {
        const fetch = workspace();
        const stale = memoryJarStore(JSON.stringify({ v: 1, origin: ORIGIN, offset: 0, cookies: [] }));
        await expect(signIn(fetch, { stagingStore: stale })).rejects.toThrow(/fresh staging jar/);
        expect(fetch.calls).toEqual([]);
    });
});

describe('signInWithPassword: each refusal, by its code, to the copy table', () => {
    // Each answer as the server gives it (status, code, headers), with its text
    // replaced by SERVER_TEXT, which must never come back.
    const cases: Array<{
        name: string;
        reply: () => Response;
        kind: SignInProblem['kind'];
        copy: string;
        action?: 'retry' | 'open-web';
    }> = [
        {
            name: '401 INVALID_EMAIL_OR_PASSWORD',
            reply: () => json(401, { error: SERVER_TEXT, code: 'INVALID_EMAIL_OR_PASSWORD' }),
            kind: 'wrong-credentials',
            copy: WRONG_CREDENTIALS,
        },
        {
            name: '403 BANNED_USER',
            reply: () => json(403, { error: SERVER_TEXT, code: 'BANNED_USER' }),
            kind: 'deactivated',
            copy: DEACTIVATED_MESSAGE,
        },
        {
            name: '403 METHOD_OFF',
            reply: () => json(403, { error: SERVER_TEXT, code: 'METHOD_OFF' }),
            kind: 'method-off',
            copy: PASSWORD_OFF,
            action: 'open-web',
        },
        {
            name: '400 EMAIL_PASSWORD_DISABLED',
            reply: () => json(400, { error: SERVER_TEXT, code: 'EMAIL_PASSWORD_DISABLED' }),
            kind: 'password-disabled',
            copy: PASSWORD_OFF,
            action: 'open-web',
        },
        {
            name: '400 INVALID_EMAIL',
            reply: () => json(400, { error: SERVER_TEXT, code: 'INVALID_EMAIL' }),
            kind: 'invalid-email',
            copy: INVALID_EMAIL,
        },
        {
            name: '403 EMAIL_NOT_VERIFIED',
            reply: () => json(403, { error: SERVER_TEXT, code: 'EMAIL_NOT_VERIFIED' }),
            kind: 'email-not-verified',
            copy: EMAIL_NOT_VERIFIED,
        },
        {
            name: 'a 500',
            reply: () => json(500, { error: SERVER_TEXT }),
            kind: 'server-error',
            copy: SERVER_ERROR,
        },
        {
            name: 'a proxy’s 502 page',
            reply: () => new Response(`<html>${SERVER_TEXT}</html>`, { status: 502 }),
            kind: 'server-error',
            copy: SERVER_ERROR,
        },
        {
            name: 'a code the table doesn’t know (PASSWORD_TOO_LONG)',
            reply: () => json(400, { error: SERVER_TEXT, code: 'PASSWORD_TOO_LONG' }),
            kind: 'unknown',
            copy: GENERIC,
        },
        {
            name: 'the edge’s cross-origin 403, which has no code',
            reply: () => json(403, { error: SERVER_TEXT }),
            kind: 'unknown',
            copy: GENERIC,
        },
        {
            name: 'a 415',
            reply: () => json(415, { error: SERVER_TEXT }),
            kind: 'unknown',
            copy: GENERIC,
        },
        {
            name: 'a code that is Object’s own key',
            reply: () => json(400, { error: SERVER_TEXT, code: 'constructor' }),
            kind: 'unknown',
            copy: GENERIC,
        },
        {
            name: 'an answer that isn’t JSON',
            reply: () => new Response(SERVER_TEXT, { status: 400 }),
            kind: 'unknown',
            copy: GENERIC,
        },
    ];

    for (const { name, reply, kind, copy, action = 'retry' } of cases) {
        it(`${name} is ${kind}`, async () => {
            const store = recordingStore();
            const result = await signIn(workspace({ signIn: reply }), { stagingStore: store });
            const problem = problemOf(result);
            expect(problem.kind).toBe(kind);
            expect(signInCopy(problem)).toEqual({ message: copy, action });
            expect(JSON.stringify(result)).not.toContain(SERVER_TEXT);
            emptied(store);
        });
    }

    it('keeps the code for Advanced mode only when it is an identifier, never a sentence', async () => {
        const known = problemOf(
            await signIn(workspace({ signIn: () => json(401, { code: 'INVALID_EMAIL_OR_PASSWORD' }) })),
        );
        expect(known).toEqual({ kind: 'wrong-credentials', status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' });
        const sentence = problemOf(await signIn(workspace({ signIn: () => json(400, { code: SERVER_TEXT }) })));
        expect(sentence).toEqual({ kind: 'unknown', status: 400, code: null });
    });

    it('a 429 surfaces X-Retry-After’s seconds, and the line says how long to wait', async () => {
        const reply = () =>
            json(429, { error: 'Too many requests. Please try again later.' }, { headers: { 'X-Retry-After': '42' } });
        const problem = problemOf(await signIn(workspace({ signIn: reply })));
        expect(problem).toEqual({ kind: 'rate-limited', status: 429, code: null, retryAfterSeconds: 42 });
        expect(signInCopy(problem)).toEqual({
            message: 'Too many tries. Wait 42 seconds, then try again.',
            action: 'retry',
        });
    });

    it('a 429 takes a proxy’s Retry-After in seconds, and says "a minute" with none it can read', async () => {
        const proxy = problemOf(
            await signIn(workspace({ signIn: () => answer(429, { headers: { 'Retry-After': '90' } }) })),
        );
        expect(proxy).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 90 });
        expect(signInCopy(proxy).message).toBe('Too many tries. Wait 2 minutes, then try again.');
        const dated = problemOf(
            await signIn(
                workspace({ signIn: () => answer(429, { headers: { 'Retry-After': httpDate(T0 + 60_000) } }) }),
            ),
        );
        expect(dated).toMatchObject({ kind: 'rate-limited', retryAfterSeconds: null });
        expect(signInCopy(dated).message).toBe('Too many tries. Wait a minute, then try again.');
    });

    it('no answer at all, offline or TLS, is unreachable', async () => {
        for (const failure of [
            new TypeError('Network request failed'),
            new Error('java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.'),
            new Error('The certificate for this server is invalid.'),
        ]) {
            const store = recordingStore();
            const result = await signIn(
                fakeFetch(() => Promise.reject(failure)),
                { stagingStore: store },
            );
            expect(problemOf(result)).toEqual({ kind: 'unreachable', status: null, code: null });
            expect(signInCopy(problemOf(result))).toEqual({ message: UNREACHABLE, action: 'retry' });
            emptied(store);
        }
    });

    it('a redirect is never followed, and is unknown', async () => {
        const store = recordingStore();
        const result = await signIn(
            workspace({ signIn: () => answer(302, { headers: { location: 'https://evil.example.test/' } }) }),
            { stagingStore: store },
        );
        expect(problemOf(result)).toEqual({ kind: 'unknown', status: null, code: null });
        emptied(store);
    });
});

describe('signInWithPassword: the session check', () => {
    it('an accepted sign-in whose session says user: null didn’t sign in, and its jar is discarded', async () => {
        const store = recordingStore();
        const result = await signIn(workspace({ session: () => sessionView(null) }), { stagingStore: store });
        expect(problemOf(result)).toEqual({ kind: 'not-signed-in', status: 200, code: null });
        expect(signInCopy(problemOf(result)).message).toBe(NOT_SIGNED_IN);
        // The cookie had landed before the check; it is gone now.
        expect(store.writes.some((value) => value.includes(COOKIE))).toBe(true);
        emptied(store);
    });

    it('an accepted sign-in whose session check fails signs that session out before discarding the jar', async () => {
        const failures: Array<() => Response | Promise<Response>> = [
            () => sessionView(null),
            () => Promise.reject(new TypeError('Network request failed')),
            () => json(503, { error: SERVER_TEXT }),
            () => new Response('<html></html>', { status: 200 }),
        ];
        for (const session of failures) {
            const store = recordingStore();
            const fetch = workspace({ session });
            const result = await signIn(fetch, { stagingStore: store });
            expect(result.ok).toBe(false);
            expect(paths(fetch)).toEqual([`POST ${SIGN_IN_PATH}`, `GET ${SESSION_PATH}`, `POST ${LOGOUT_PATH}`]);
            signedOut(fetch);
            emptied(store);
        }
    });

    it('a refusal leaves no session to sign out, so nothing more is sent', async () => {
        const fetch = workspace({ signIn: () => json(401, { code: 'INVALID_EMAIL_OR_PASSWORD' }) });
        expect(problemOf(await signIn(fetch)).kind).toBe('wrong-credentials');
        expect(paths(fetch)).toEqual([`POST ${SIGN_IN_PATH}`]);
    });

    it('a session check that fails discards the jar the sign-in filled', async () => {
        const failures: Array<{ session: () => Response | Promise<Response>; kind: SignInProblem['kind'] }> = [
            { session: () => Promise.reject(new TypeError('Network request failed')), kind: 'unreachable' },
            { session: () => json(503, { error: SERVER_TEXT }), kind: 'server-error' },
            { session: () => new Response('<html></html>', { status: 200 }), kind: 'unknown' },
            { session: () => json(200, { user: { id: 'u-ada' } }), kind: 'unknown' },
            { session: () => sessionView({ id: '', name: 'Ada' }), kind: 'unknown' },
            { session: () => sessionView('u-ada'), kind: 'unknown' },
        ];
        for (const { session, kind } of failures) {
            const store = recordingStore();
            const result = await signIn(workspace({ session }), { stagingStore: store });
            expect(problemOf(result).kind).toBe(kind);
            emptied(store);
        }
    });
});

describe('the staging jar on cancel', () => {
    it('a sign-in cancelled before it starts sends nothing', async () => {
        const fetch = workspace();
        const cancel = new AbortController();
        cancel.abort();
        await expect(signIn(fetch, { signal: cancel.signal })).rejects.toBeInstanceOf(AbortedError);
        expect(fetch.calls).toEqual([]);
    });

    it('cancelled while the server answers: it rejects with AbortedError, and the jar is discarded', async () => {
        for (const step of [SIGN_IN_PATH, SESSION_PATH]) {
            const held = deferred();
            const store = recordingStore();
            const cancel = new AbortController();
            const fetch = workspace({
                signIn: async () => {
                    if (step === SIGN_IN_PATH) {
                        await held.promise;
                    }
                    return signedIn();
                },
                session: async (call) => {
                    await held.promise;
                    return sessionFor(call);
                },
            });
            const pending = signIn(fetch, { signal: cancel.signal, stagingStore: store });
            await vi.waitFor(() => expect(fetch.calls.at(-1)?.url).toBe(`${ORIGIN}${step}`));
            cancel.abort();
            held.resolve();
            await expect(pending).rejects.toBeInstanceOf(AbortedError);
            emptied(store);
            // The person went back: it stops at once, with no sign-out.
            expect(fetch.calls.at(-1)?.url).toBe(`${ORIGIN}${step}`);
        }
    });

    it('a staged sign-in discarded keeps nothing, and can’t be committed after', async () => {
        const store = recordingStore();
        const result = staged(await signIn(workspace(), { stagingStore: store }));
        expect(store.value).toContain(COOKIE);
        await result.jar.discard();
        await result.jar.discard();
        expect(result.jar.discarded).toBe(true);
        emptied(store);
        expect(() => result.jar.serialize()).toThrow(/discarded/);
    });

    it('cancel signs the new session out with its cookie, Origin and a JSON body, then discards the jar', async () => {
        const store = recordingStore();
        const fetch = workspace();
        const result = staged(await signIn(fetch, { stagingStore: store }));
        await result.cancel();
        const logout = fetch.calls[2];
        expect(logout.url).toBe(`${ORIGIN}${LOGOUT_PATH}`);
        expect(logout.init).toMatchObject({ method: 'POST', body: '{}', credentials: 'omit', redirect: 'error' });
        expect(sentHeaders(logout)).toMatchObject({
            cookie: `${SESSION}=${COOKIE}`,
            origin: ORIGIN,
            'content-type': 'application/json',
        });
        expect(result.jar.discarded).toBe(true);
        emptied(store);
        await result.cancel();
        expect(fetch.calls).toHaveLength(3);
    });

    it('release, as a commit that didn’t happen calls it, signs the session out once; cancel after it sends nothing', async () => {
        const store = recordingStore();
        const fetch = workspace();
        const result = staged(await signIn(fetch, { stagingStore: store }));
        await Promise.all([result.jar.release(), result.jar.release()]);
        expect(paths(fetch)).toEqual([`POST ${SIGN_IN_PATH}`, `GET ${SESSION_PATH}`, `POST ${LOGOUT_PATH}`]);
        signedOut(fetch);
        expect(result.jar.discarded).toBe(true);
        emptied(store);
        await result.cancel();
        await result.jar.release();
        expect(fetch.calls).toHaveLength(3);
    });

    it('release after a discard (a commit that happened) sends nothing', async () => {
        const fetch = workspace();
        const result = staged(await signIn(fetch));
        await result.jar.discard();
        await result.jar.release();
        await result.cancel();
        expect(paths(fetch)).toEqual([`POST ${SIGN_IN_PATH}`, `GET ${SESSION_PATH}`]);
    });

    it('a sign-out that gets no answer gives up after SIGN_OUT_TIMEOUT_MS, and the jar is discarded', async () => {
        const store = recordingStore();
        const fetch = workspace({
            logout: (call) =>
                new Promise<Response>((_, reject) => {
                    call.init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        });
        const result = staged(await signIn(fetch, { stagingStore: store }));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            let settled = false;
            const released = result.cancel().then(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS - 1);
            expect(fetch.calls.at(-1)?.url).toBe(`${ORIGIN}${LOGOUT_PATH}`);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await released;
            expect(result.jar.discarded).toBe(true);
            emptied(store);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancel discards the jar even when the sign-out gets no answer', async () => {
        const store = recordingStore();
        const fetch = workspace({ logout: () => Promise.reject(new TypeError('Network request failed')) });
        const result = staged(await signIn(fetch, { stagingStore: store }));
        await result.cancel();
        expect(result.jar.discarded).toBe(true);
        emptied(store);
    });
});

describe('the password', () => {
    /** Every way a result or an error could show the password. */
    const shows = (value: unknown) =>
        JSON.stringify(value)?.includes(PASSWORD) === true ||
        inspect(value, { depth: 20, showHidden: true, getters: true }).includes(PASSWORD);

    it('goes into the sign-in request’s body and nowhere else: no result, error, log or staged value', async () => {
        const runs: Array<{ fetch: ReturnType<typeof workspace>; signal?: AbortSignal }> = [
            { fetch: workspace() },
            {
                fetch: workspace({
                    signIn: () => json(401, { error: SERVER_TEXT, code: 'INVALID_EMAIL_OR_PASSWORD' }),
                }),
            },
            { fetch: workspace({ signIn: () => json(429, {}, { headers: { 'X-Retry-After': '3' } }) }) },
            { fetch: workspace({ signIn: () => Promise.reject(new TypeError('Network request failed')) }) },
            { fetch: workspace({ session: () => Promise.reject(new TypeError('Network request failed')) }) },
            { fetch: workspace({ session: () => sessionView(null) }) },
        ];
        const aborted = new AbortController();
        const late = workspace({
            session: async (call) => {
                aborted.abort();
                return sessionFor(call);
            },
        });
        runs.push({ fetch: late, signal: aborted.signal });

        for (const { fetch, signal } of runs) {
            const store = recordingStore();
            let outcome: unknown;
            try {
                outcome = await signIn(fetch, { stagingStore: store, signal });
                if ((outcome as SignInResult).ok) {
                    const result = staged(outcome as SignInResult);
                    expect(shows(result.jar.serialize())).toBe(false);
                    await result.cancel();
                }
            } catch (error) {
                outcome = error;
            }
            expect(shows(outcome)).toBe(false);
            expect(store.writes.some((value) => value.includes(PASSWORD))).toBe(false);
            const withPassword = fetch.calls.filter((call) => shows(call));
            expect(withPassword.map((call) => new URL(call.url).pathname)).toEqual(
                fetch.calls.length > 0 && new URL(fetch.calls[0].url).pathname === SIGN_IN_PATH ? [SIGN_IN_PATH] : [],
            );
            for (const call of fetch.calls) {
                expect(shows(call.init.headers)).toBe(false);
            }
        }
        for (const spy of consoleSpies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });
});
