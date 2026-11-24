import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appLink } from '@socio/shared/device-sign-in';

import { signInAndCommit, type Store } from '../src/data';
import {
    createInvite,
    EMAIL_MISMATCH,
    EMAIL_NEEDED,
    type InviteView,
    knownWorkspaces,
    sameNameLine,
} from '../src/data/invite';
import { createExternalLinks, type LinkAction, type LinkNavigator } from '../src/navigation/links';
import { createWorkspaceLinkHold } from '../src/navigation/workspace-link';
import {
    checkNewPassword,
    INVITE_NO_ACCOUNT,
    INVITE_PASSWORD_OFF,
    INVITE_USED,
    type InviteLink,
    joinQuestion,
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    passwordRuleLine,
    readInviteLink,
    RESET_PASSWORD_PATH,
    sameNameWarning,
    setPasswordFromInvite,
    setPasswordLine,
} from '../src/net/invite';
import { probeWorkspace } from '../src/net/probe';
import { NOT_AVAILABLE, NOT_SOCIO } from '../src/net/probe-copy';
import { createPublicFetch } from '../src/net/public-fetch';
import { LOGOUT_PATH, SESSION_PATH, SIGN_IN_PATH } from '../src/net/sign-in';
import { UNREACHABLE } from '../src/net/sign-in-copy';

import { addWorkspace, launch, phone, type Phone, sha256 } from './helpers/store';
import { answer, cookieValue, httpDate, ORIGIN, SESSION, sentHeaders, sessionSetCookie, T0 } from './net/helpers';

// Invites when the app is installed first, under Node: the link, the password rules, the
// reset-password request, the view models, and the whole flow against a workspace that answers as
// Better Auth 1.7.10's `/reset-password` and `/sign-in/email` do (src/server/auth/better-auth.ts:
// invite tokens last three days, a used one is gone, MIN_PASSWORD 10). The token and the password
// are searched for in every stored byte, log line, view and navigation action.

const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';
const LINK_HOST = 'link-staging.socio.sh';
const HOST = new URL(ORIGIN).host;
const LINKS = { variant: 'development' as const, linkHost: LINK_HOST };
const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60_000;
const nodeBytes = (length: number) => new Uint8Array(randomBytes(length));
const newToken = () => randomBytes(24).toString('base64url');

const inviteUrl = (token: string, host = HOST, variant: 'development' | 'preview' | 'production' = 'development') =>
    appLink({ kind: 'i', variant, host, fields: { t: token } }, LINK_HOST);

interface Account {
    readonly email: string;
    readonly appUserId: string;
    readonly name: string;
    password: string | null;
}

/** A workspace that answers as Better Auth does for invites, password sign-in and the session. */
function workspace(clock: { now: number }) {
    const accounts: Account[] = [
        { email: 'ada@example.test', appUserId: 'u-ada', name: 'Ada', password: null },
        { email: 'ben@example.test', appUserId: 'u-ben', name: 'Ben', password: 'ben-password-1' },
    ];
    const tokens = new Map<string, { account: Account | null; expiresAt: number }>();
    const sessions = new Map<string, Account>();
    const resets: unknown[] = [];
    const flags = { offline: false, notSocio: false, passwordsOff: false, gone: false };
    let issued = 0;
    const json = (status: number, body: unknown, setCookie: string[] = []) =>
        answer(status, { date: httpDate(clock.now), headers: { 'content-type': 'application/json' }, setCookie, body });
    const calls: { url: string; init: FetchRequestInit }[] = [];
    const fetch = async (url: string, init: FetchRequestInit): Promise<Response> => {
        calls.push({ url, init });
        if (flags.offline) {
            throw new TypeError('Network request failed');
        }
        const path = new URL(url).pathname;
        const cookie = cookieValue(sentHeaders({ url, init }).cookie, SESSION);
        const signedIn = cookie === undefined ? undefined : sessions.get(cookie);
        if (path === '/.well-known/socio/workspace') {
            if (!flags.passwordsOff) {
                return json(404, { error: 'Not found.' });
            }
            return json(200, {
                id: 'ws_acme',
                origin: ORIGIN,
                name: 'Acme',
                branding: { name: 'Acme', logo: '/favicon.svg' },
                methods: { password: false, passkey: true, sheet: true, signInCodes: null, addDevice: true },
                serverVersion: '0.40.0',
                protocol: 1,
                policy: { leaseDays: 30, wipeDays: 30, appLock: false, notificationText: true },
            });
        }
        if (path === RESET_PASSWORD_PATH) {
            const body = JSON.parse(String(init.body)) as { newPassword: string; token: string };
            resets.push(body);
            if (body.newPassword.length < 10) {
                return json(400, { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' });
            }
            const row = tokens.get(body.token);
            if (row === undefined || row.expiresAt < clock.now) {
                return json(400, { code: 'INVALID_TOKEN', message: 'Invalid token' });
            }
            if (row.account === null || flags.gone) {
                return json(400, { code: 'USER_NOT_FOUND', message: 'User not found' });
            }
            row.account.password = body.newPassword;
            tokens.delete(body.token);
            return json(200, { status: true });
        }
        if (path === SIGN_IN_PATH) {
            const { email, password } = JSON.parse(String(init.body)) as { email: string; password: string };
            const account = accounts.find((entry) => entry.email === email.toLowerCase());
            if (account === undefined || account.password === null || account.password !== password) {
                return json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
            }
            issued += 1;
            const token = `tok${issued}.c2ln`;
            sessions.set(token, account);
            return json(200, { token, user: { id: 'ba-1' } }, [sessionSetCookie(token)]);
        }
        if (path === SESSION_PATH) {
            if (flags.notSocio) {
                return answer(200, { headers: { 'content-type': 'text/html' }, body: '<html></html>' });
            }
            return json(200, {
                provider: 'betterauth',
                branding: { name: 'Acme', logo: '/favicon.svg' },
                user: signedIn === undefined ? null : { id: signedIn.appUserId, name: signedIn.name, role: 'member' },
            });
        }
        if (path === LOGOUT_PATH) {
            return json(200, { ok: true }, [sessionSetCookie('', 0)]);
        }
        return json(404, { error: 'Not found.' });
    };
    /** The admin's side: an invite for an account, three days long, as `passwordLink` makes it. */
    const admin = {
        invite(email = 'ada@example.test', expiresIn = 3 * DAY) {
            const token = newToken();
            tokens.set(token, {
                account: accounts.find((entry) => entry.email === email) ?? null,
                expiresAt: clock.now + expiresIn,
            });
            return token;
        },
    };
    return { fetch: Object.assign(fetch, { calls }), admin, accounts, resets, flags, sessions };
}

let device: Phone;
let logs: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-invite-')));
    logs = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(device.root, { recursive: true, force: true });
});

/** Every byte the device holds, and every log line. */
function everything(): string {
    const files = readdirSync(device.root, { recursive: true, encoding: 'utf8' })
        .map((path) => join(device.root, path))
        .filter((path) => statSync(path).isFile())
        .map((path) => readFileSync(path).toString('latin1'));
    return [...files, ...device.keychain.values(), JSON.stringify(logs.map((spy) => spy.mock.calls))].join('\n');
}

/** The flow as src/platform/invite.ts binds it, on this store and server. */
function flowOn(
    store: Store,
    server: ReturnType<typeof workspace>,
    clock: { now: number },
    variant = 'development' as const,
) {
    const publicFetch = createPublicFetch({ fetch: server.fetch, userAgent: USER_AGENT });
    const flow = createInvite({
        variant,
        probe: (text, signal) => probeWorkspace(text, { variant, publicFetch, isKnown: () => false, signal }),
        known: () => knownWorkspaces(store),
        setPassword: (input, signal) =>
            setPasswordFromInvite({ ...input, fetch: server.fetch, userAgent: USER_AGENT, signal }),
        signIn: ({ origin, email, password, manifest, signal }) =>
            signInAndCommit(
                { origin, email, password, logo: null, manifest, signal },
                {
                    store,
                    hash: sha256,
                    fetch: server.fetch,
                    userAgent: USER_AGENT,
                    now: () => clock.now,
                    randomBytes: nodeBytes,
                },
            ),
    });
    const views: InviteView[] = [];
    flow.subscribe(() => views.push(flow.view()));
    return { flow, views };
}

async function setUp() {
    const clock = { now: T0 };
    const server = workspace(clock);
    const { store } = await launch(device, { now: () => clock.now });
    return { clock, server, store, ...flowOn(store, server, clock) };
}

const linkOf = (token: string, host = HOST): InviteLink => {
    const link = readInviteLink(inviteUrl(token, host), LINKS);
    if (link === null) {
        throw new Error('Not an invite link.');
    }
    return link;
};

/** Opens the link and presses Join: the set-password form shows. */
async function toForm(flow: ReturnType<typeof createInvite>, token: string) {
    flow.start(linkOf(token));
    await vi.waitFor(() => expect(flow.view()).toMatchObject({ step: 'join', name: 'Acme', host: HOST }));
    flow.join();
    expect(flow.view()).toMatchObject({ step: 'password', busy: false, line: null });
}

describe('the link and the rules', () => {
    it('reads only this build’s invite links, the token from the fragment', () => {
        const token = newToken();
        expect(readInviteLink(inviteUrl(token), LINKS)).toEqual({ host: HOST, token });
        expect(readInviteLink(inviteUrl(token, 'brain.example.test:8443'), LINKS)).toEqual({
            host: 'brain.example.test:8443',
            token,
        });
        // Another variant, link host or kind, a token that isn't one, a query: none.
        expect(readInviteLink(inviteUrl(token, HOST, 'preview'), LINKS)).toBeNull();
        expect(readInviteLink(inviteUrl(token).replace(LINK_HOST, 'link.socio.sh'), LINKS)).toBeNull();
        expect(
            readInviteLink(appLink({ kind: 'w', variant: 'development', host: HOST, fields: {} }, LINK_HOST), LINKS),
        ).toBeNull();
        expect(readInviteLink(inviteUrl('short'), LINKS)).toBeNull();
        expect(readInviteLink(inviteUrl('has space in it, long enough'), LINKS)).toBeNull();
        expect(readInviteLink(inviteUrl(token).replace('#', '?x=1#'), LINKS)).toBeNull();
        expect(readInviteLink(`${inviteUrl(token)}&x=1`, LINKS)).toBeNull();
    });

    it('checks a new password as the web’s form does, with the server’s minimum', () => {
        expect(checkNewPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1), 'a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(
            'too-short',
        );
        expect(checkNewPassword('a'.repeat(MIN_PASSWORD_LENGTH), 'a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
        expect(checkNewPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1), 'a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(
            'too-long',
        );
        expect(checkNewPassword(PASSWORD, `${PASSWORD}!`)).toBe('differ');
        expect(passwordRuleLine('too-short')).toBe('Use at least 10 characters.');
        // The server's and the web's minimum: shared has no constant for it yet, so this holds the three together.
        const server = readFileSync(join(__dirname, '../../../src/server/auth/better-auth.ts'), 'utf8');
        expect(server).toMatch(new RegExp(`const MIN_PASSWORD = ${MIN_PASSWORD_LENGTH};`));
        const web = readFileSync(join(__dirname, '../../../packages/client/src/shell/SignIn.tsx'), 'utf8');
        const setPassword = web.slice(web.indexOf('function SetPassword'));
        expect(setPassword).toContain(`minLength={${MIN_PASSWORD_LENGTH}}`);
        expect(setPassword).toContain(`maxLength={${MAX_PASSWORD_LENGTH}}`);
    });

    it('says the question with the host, and warns about a workspace of the same name', () => {
        expect(joinQuestion('Acme', 'acme.example.com')).toBe('Join Acme (acme.example.com)?');
        const known = [{ name: 'acme ', origin: 'https://acme.example.com', state: 'ready' }];
        expect(sameNameLine('Acme', 'https://acme.example.com', known)).toBe(sameNameWarning('Acme', null));
        expect(sameNameLine('Acme', 'https://acme-login.example.net', known)).toBe(
            sameNameWarning('Acme', 'acme.example.com'),
        );
        expect(sameNameWarning('Acme', 'acme.example.com')).toContain('at acme.example.com');
        expect(sameNameLine('Globex', 'https://acme.example.com', known)).toBeNull();
        for (const line of [sameNameWarning('Acme', null), sameNameWarning('Acme', 'a.test')]) {
            expect(line).toContain('device');
            expect(line).not.toMatch(/phone/i);
        }
    });

    it('words every refusal, and only an invite that can’t work again ends the form', () => {
        expect(setPasswordLine({ kind: 'invite-used', status: 400 })).toEqual({ line: INVITE_USED, spent: true });
        expect(setPasswordLine({ kind: 'no-account', status: 400 })).toEqual({ line: INVITE_NO_ACCOUNT, spent: true });
        expect(setPasswordLine({ kind: 'weak-password', status: 400, rule: 'too-short' })).toEqual({
            line: 'Use at least 10 characters.',
            spent: false,
        });
        expect(setPasswordLine({ kind: 'rate-limited', status: 429, retryAfterSeconds: 42 }).line).toBe(
            'Too many tries. Wait 42 seconds, then try again.',
        );
        expect(setPasswordLine({ kind: 'unreachable', status: null })).toEqual({ line: UNREACHABLE, spent: false });
    });
});

describe('setPasswordFromInvite', () => {
    const answering = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        const calls: { url: string; init: FetchRequestInit }[] = [];
        const fetch = async (url: string, init: FetchRequestInit) => {
            calls.push({ url, init });
            return answer(status, { headers: { 'content-type': 'application/json', ...headers }, body });
        };
        return { fetch, calls };
    };

    it('posts the web’s request, with no cookie, and nothing else', async () => {
        const token = newToken();
        const { fetch, calls } = answering(200, { status: true });
        await expect(
            setPasswordFromInvite({ origin: ORIGIN, token, password: PASSWORD, fetch, userAgent: USER_AGENT }),
        ).resolves.toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${ORIGIN}${RESET_PASSWORD_PATH}`);
        expect(calls[0].init.method).toBe('POST');
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ newPassword: PASSWORD, token });
        const headers = sentHeaders(calls[0]);
        expect(headers.cookie).toBeUndefined();
        expect(headers.origin).toBe(ORIGIN);
        expect(calls[0].init.credentials).toBe('omit');
        // The token is in the body alone: never in the URL.
        expect(calls[0].url).not.toContain(token);
    });

    it.each([
        [400, { code: 'INVALID_TOKEN' }, { kind: 'invite-used', status: 400 }],
        [400, { code: 'PASSWORD_TOO_SHORT' }, { kind: 'weak-password', status: 400, rule: 'too-short' }],
        [400, { code: 'PASSWORD_TOO_LONG' }, { kind: 'weak-password', status: 400, rule: 'too-long' }],
        [400, { code: 'USER_NOT_FOUND' }, { kind: 'no-account', status: 400 }],
        [404, { error: 'Not found.' }, { kind: 'unknown', status: 404 }],
        [502, null, { kind: 'server-error', status: 502 }],
        [200, { status: false }, { kind: 'unknown', status: 200 }],
    ])('reads a %i %j by its code alone', async (status, body, problem) => {
        const { fetch } = answering(status, body);
        await expect(
            setPasswordFromInvite({
                origin: ORIGIN,
                token: newToken(),
                password: PASSWORD,
                fetch,
                userAgent: USER_AGENT,
            }),
        ).resolves.toEqual({ ok: false, problem });
    });

    it('takes the limiter’s wait, and no answer as unreachable', async () => {
        const limited = answering(429, { message: 'Too many requests.' }, { 'x-retry-after': '30' });
        await expect(
            setPasswordFromInvite({
                origin: ORIGIN,
                token: newToken(),
                password: PASSWORD,
                fetch: limited.fetch,
                userAgent: USER_AGENT,
            }),
        ).resolves.toEqual({ ok: false, problem: { kind: 'rate-limited', status: 429, retryAfterSeconds: 30 } });
        const offline = async () => {
            throw new TypeError('Network request failed');
        };
        await expect(
            setPasswordFromInvite({
                origin: ORIGIN,
                token: newToken(),
                password: PASSWORD,
                fetch: offline,
                userAgent: USER_AGENT,
            }),
        ).resolves.toEqual({ ok: false, problem: { kind: 'unreachable', status: null } });
    });
});

describe('an invite, from the link to the workspace', () => {
    it('joins: the password set, the person signed in and committed, and the token and password nowhere', async () => {
        const { server, store, flow, views } = await setUp();
        const token = server.admin.invite();
        await toForm(flow, token);
        expect(views.find((view) => view.step === 'join')).toMatchObject({ warning: null });
        flow.submit({ email: ' ada@example.test ', password: PASSWORD, repeat: PASSWORD });
        await vi.waitFor(() => expect(flow.view()).toEqual({ step: 'signed-in' }));
        expect(server.resets).toEqual([{ newPassword: PASSWORD, token }]);
        const rows = await store.registry.list();
        expect(rows).toMatchObject([
            { origin: ORIGIN, appUserId: 'u-ada', personEmail: 'ada@example.test', state: 'ready' },
        ]);
        // The steps it showed, in order.
        expect([...new Set(views.map((view) => view.step))]).toEqual([
            'checking',
            'join',
            'password',
            'signing-in',
            'signed-in',
        ]);
        flow.leave();
        // Never stored, logged, or put in a view.
        const held = `${everything()}\n${JSON.stringify(views)}`;
        expect(held).not.toContain(token);
        expect(held).not.toContain(PASSWORD);
    });

    it('an expired invite: worded, and the form goes', async () => {
        const { server, store, flow } = await setUp();
        const token = server.admin.invite('ada@example.test', -1);
        await toForm(flow, token);
        flow.submit({ email: 'ada@example.test', password: PASSWORD, repeat: PASSWORD });
        await vi.waitFor(() => expect(flow.view()).toMatchObject({ step: 'ended', line: INVITE_USED }));
        // No sign-in was tried, nothing stored.
        expect(server.fetch.calls.some((call) => call.url.endsWith(SIGN_IN_PATH))).toBe(false);
        expect(await store.registry.list()).toEqual([]);
        expect(everything()).not.toContain(token);
    });

    it('an invite used already: the same words', async () => {
        const first = await setUp();
        const token = first.server.admin.invite();
        await toForm(first.flow, token);
        first.flow.submit({ email: 'ada@example.test', password: PASSWORD, repeat: PASSWORD });
        await vi.waitFor(() => expect(first.flow.view().step).toBe('signed-in'));
        // The same link opened again.
        const { flow } = flowOn(first.store, first.server, first.clock);
        await toForm(flow, token);
        flow.submit({ email: 'ada@example.test', password: 'another password', repeat: 'another password' });
        await vi.waitFor(() => expect(flow.view()).toMatchObject({ step: 'ended', line: INVITE_USED }));
    });

    it('a weak password: the web’s rules first, then the server’s, and the form stays', async () => {
        const { server, flow } = await setUp();
        const token = server.admin.invite();
        await toForm(flow, token);
        flow.submit({ email: 'ada@example.test', password: 'short', repeat: 'short' });
        expect(flow.view()).toMatchObject({
            step: 'password',
            line: passwordRuleLine('too-short'),
            detail: 'too-short',
        });
        flow.submit({ email: 'ada@example.test', password: PASSWORD, repeat: 'something else' });
        expect(flow.view()).toMatchObject({ step: 'password', line: passwordRuleLine('differ') });
        flow.submit({ email: 'not an email', password: PASSWORD, repeat: PASSWORD });
        expect(flow.view()).toMatchObject({ step: 'password', line: EMAIL_NEEDED });
        expect(server.resets).toEqual([]);
        // The server's own rule (a stricter server) is worded the same and keeps the invite.
        const strict = vi.fn(async () => ({
            ok: false as const,
            problem: { kind: 'weak-password' as const, status: 400, rule: 'too-short' as const },
        }));
        const strictFlow = createInvite({
            variant: 'development',
            probe: async () => ({
                kind: 'found',
                address: { origin: ORIGIN, host: HOST },
                workspace: { provider: 'betterauth', name: 'Acme', logo: null, methods: null, manifest: null },
                redirectedFrom: null,
            }),
            known: async () => [],
            setPassword: strict,
            signIn: vi.fn(),
        });
        await toForm(strictFlow, token);
        strictFlow.submit({ email: 'ada@example.test', password: PASSWORD, repeat: PASSWORD });
        await vi.waitFor(() =>
            expect(strictFlow.view()).toMatchObject({
                step: 'password',
                busy: false,
                line: 'Use at least 10 characters.',
            }),
        );
    });

    it('a refused host: a production build takes no port, and nothing is asked of it', async () => {
        const clock = { now: T0 };
        const server = workspace(clock);
        const { store } = await launch(device, { now: () => clock.now });
        const { flow } = flowOn(store, server, clock, 'production' as 'development');
        flow.start({ host: 'brain.example.test:8443', token: newToken() });
        await vi.waitFor(() =>
            expect(flow.view()).toMatchObject({ step: 'refused', line: NOT_AVAILABLE, detail: 'port' }),
        );
        expect(server.fetch.calls).toEqual([]);
    });

    it('a host that isn’t a workspace, or one with passwords off: refused, the token never sent', async () => {
        const { server, flow } = await setUp();
        server.flags.notSocio = true;
        flow.start(linkOf(server.admin.invite()));
        await vi.waitFor(() => expect(flow.view()).toMatchObject({ step: 'refused', line: NOT_SOCIO }));
        server.flags.notSocio = false;
        server.flags.passwordsOff = true;
        flow.start(linkOf(server.admin.invite()));
        await vi.waitFor(() => expect(flow.view()).toMatchObject({ step: 'refused', line: INVITE_PASSWORD_OFF }));
        expect(server.resets).toEqual([]);
    });

    it('a workspace of the same name on the device at another host: the warning', async () => {
        const { server, store, flow } = await setUp();
        await addWorkspace(store, 'https://acme.example.com', 'u-other');
        flow.start(linkOf(server.admin.invite()));
        await vi.waitFor(() =>
            expect(flow.view()).toMatchObject({ step: 'join', warning: sameNameWarning('Acme', 'acme.example.com') }),
        );
    });

    it('the wrong email: the password is set, so only the email is asked again', async () => {
        const { server, flow, views } = await setUp();
        const token = server.admin.invite();
        await toForm(flow, token);
        flow.submit({ email: 'ada@example.tset', password: PASSWORD, repeat: PASSWORD });
        await vi.waitFor(() =>
            expect(flow.view()).toMatchObject({ step: 'sign-in', email: 'ada@example.tset', line: EMAIL_MISMATCH }),
        );
        flow.signIn('ada@example.test');
        await vi.waitFor(() => expect(flow.view()).toEqual({ step: 'signed-in' }));
        expect(server.resets).toHaveLength(1);
        expect(JSON.stringify(views)).not.toContain(PASSWORD);
    });

    it('no answer while setting it: worded, the form and the invite stay', async () => {
        const { server, flow } = await setUp();
        const token = server.admin.invite();
        await toForm(flow, token);
        server.flags.offline = true;
        flow.submit({ email: 'ada@example.test', password: PASSWORD, repeat: PASSWORD });
        await vi.waitFor(() => expect(flow.view()).toMatchObject({ step: 'password', busy: false, line: UNREACHABLE }));
        server.flags.offline = false;
        flow.submit({ email: 'ada@example.test', password: PASSWORD, repeat: PASSWORD });
        await vi.waitFor(() => expect(flow.view().step).toBe('signed-in'));
    });

    it('leaving drops the token: nothing can be sent after', async () => {
        const { server, flow } = await setUp();
        const token = server.admin.invite();
        await toForm(flow, token);
        flow.leave();
        expect(flow.view()).toEqual({ step: 'idle' });
        flow.submit({ email: 'ada@example.test', password: PASSWORD, repeat: PASSWORD });
        flow.join();
        await new Promise((done) => setTimeout(done, 10));
        expect(server.resets).toEqual([]);
        expect(everything()).not.toContain(token);
    });
});

describe('an invite link reaches the Invite screen', () => {
    function fakeContainer(routeNames: string[], ready = true) {
        const dispatched: LinkAction[] = [];
        const container: LinkNavigator & { ready: boolean; routeNames: string[] } = {
            ready,
            routeNames,
            isReady() {
                return this.ready;
            },
            getRootState() {
                return this.ready ? { key: 'root-1', routeNames: this.routeNames } : undefined;
            },
            dispatch: (action) => dispatched.push(action),
        };
        return { container, dispatched };
    }

    function wiring() {
        const links = createExternalLinks({ resolve: () => undefined, report: vi.fn() });
        const overGate = vi.fn();
        const hold = createWorkspaceLinkHold<InviteLink>({
            read: (url) => readInviteLink(url, LINKS),
            open: () => links.openRoute('Invite', 'popTo'),
            overGate,
        });
        return { links, hold, overGate };
    }

    it('at a cold start: held until the gate shows Add workspace, then taken once, with no token in the navigation', async () => {
        const { container, dispatched } = fakeContainer([], false);
        const { links, hold } = wiring();
        const clock = { now: T0 };
        const server = workspace(clock);
        const token = server.admin.invite();
        // The launch URL comes before the container is attached or ready.
        expect(hold.receive(inviteUrl(token))).toBe(true);
        expect(links.pending()).toBe('route:Invite');
        links.attach(container);
        expect(dispatched).toEqual([]);
        container.ready = true;
        container.routeNames = ['AddWorkspace', 'WorkspaceAddress', 'Invite'];
        links.flush();
        expect(dispatched).toEqual([{ target: 'root-1', type: 'POP_TO', payload: { name: 'Invite' } }]);
        // Nothing of the link in the navigation: no params, no path.
        expect(JSON.stringify(dispatched)).not.toContain(token);
        // The screen mounts and takes it, once, and the flow joins with it.
        const link = hold.take();
        expect(link).toEqual({ host: HOST, token });
        expect(hold.take()).toBeNull();
        const { store } = await launch(device, { now: () => clock.now });
        const { flow } = flowOn(store, server, clock);
        flow.start(link!);
        await vi.waitFor(() => expect(flow.view()).toMatchObject({ step: 'join', name: 'Acme' }));
        flow.join();
        flow.submit({ email: 'ada@example.test', password: PASSWORD, repeat: PASSWORD });
        await vi.waitFor(() => expect(flow.view()).toEqual({ step: 'signed-in' }));
        expect(everything()).not.toContain(token);
    });

    it('over the shell: Add workspace first; another variant’s link is left alone', () => {
        const { container, dispatched } = fakeContainer(['Tabs']);
        const { links, hold, overGate } = wiring();
        links.attach(container);
        expect(hold.receive(inviteUrl(newToken(), HOST, 'preview'))).toBe(false);
        expect(overGate).not.toHaveBeenCalled();
        expect(hold.receive(inviteUrl(newToken()))).toBe(true);
        expect(overGate).toHaveBeenCalledOnce();
        // The gate hasn't shown Invite yet: it waits.
        expect(dispatched).toEqual([]);
        expect(links.pending()).toBe('route:Invite');
    });
});
