import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    appLink,
    deviceRedeemBodySchema,
    deviceStartQuerySchema,
    pkceVerifierSchema,
    sheetStateSchema,
    type WorkspaceManifest,
} from '@socio/shared/device-sign-in';

import {
    createSheetFlow,
    SHEET_PENDING_KEY,
    SHEET_PENDING_MS,
    type SheetFlow,
    type SignInFlowDeps,
    signInAndCommit,
    type Store,
    workspaceKeyName,
} from '../src/data';
import {
    AUTH_SESSION_PATH,
    DEVICE_REDEEM_PATH,
    LOGOUT_PATH,
    redeemSheetCode,
    SESSION_PATH,
    SHEET_APPROVER_GONE,
    SHEET_CODE_DEAD,
    SHEET_DENIED,
    SHEET_METHOD_OFF,
    SHEET_WRONG_APP,
    SIGN_IN_PATH,
    signInCopy,
} from '../src/net';
import type { SheetConfig } from '../src/net/auth-sheet';
import {
    base64url,
    deviceLabel,
    deviceStartUrl,
    newSheetSecrets,
    readSheetCallback,
    signInManifest,
    signInWays,
} from '../src/net/sheet-sign-in';
import { signInAgainParams } from '../src/shell/session';

import { addWorkspace, installIdOf, kill, launch, phone, type Phone, sha256 } from './helpers/store';
import {
    answer,
    cookieValue,
    fakeFetch,
    httpDate,
    ORIGIN,
    SESSION,
    sentHeaders,
    sessionSetCookie,
    T0,
} from './net/helpers';

// Signing in through the system sign-in sheet, under Node: the PKCE pair and the start
// page, the callback read back, the pending flow in secure storage (a kill between the sheet and
// the callback, cancel, expiry, a callback that isn't the flow's), and the redeem through
// `signInAndCommit` against a workspace that answers as the server's endpoints do. The verifier, the
// state and the code are in no log, problem or stored byte once the flow is done.

const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';
const LINK_HOST = 'link-staging.socio.sh';
const HOST = new URL(ORIGIN).host;
const DEV: SheetConfig = {
    variant: 'development',
    linkHost: LINK_HOST,
    callback: { kind: 'https', url: `https://${LINK_HOST}/dev/cb`, host: LINK_HOST, path: '/dev/cb' },
};
const sha256Base64 = async (text: string) => createHash('sha256').update(text).digest('base64');
const nodeBytes = (length: number) => new Uint8Array(randomBytes(length));

/** A callback as the server's Continue page sends the browser to it. */
const callbackUrl = (
    fields: { code: string; state: string },
    host = HOST,
    variant: 'development' | 'preview' = 'development',
) => appLink({ kind: 'cb', variant, host, fields }, LINK_HOST);

interface Account {
    readonly email: string;
    readonly appUserId: string;
    readonly name: string;
    banned: boolean;
}

/**
 * A workspace that answers as the server does: `device/start` keeps the challenge, the state and the
 * variant; `approve(state, account)` stands for the person's Continue on the web and gives the
 * callback; `device/redeem` finds the code, checks the verifier (S256), the variant, the ban,
 * then sets the device's session cookie. The session answer names the app user; Better Auth's
 * own (`get-session`) adds the email. Also a password sign-in for a copy already on the phone.
 */
function workspace() {
    const accounts: Account[] = [
        { email: 'ada@example.test', appUserId: 'u-ada', name: 'Ada', banned: false },
        { email: 'bob@example.test', appUserId: 'u-bob', name: 'Bob', banned: false },
    ];
    const requests = new Map<
        string,
        { challenge: string; variant: string; code?: string; account?: Account; used?: boolean }
    >();
    const sessions = new Map<string, Account>();
    const redeemed: Array<Record<string, string>> = [];
    let issued = 0;
    /** Set: the next redeem answers a 403 (refused or signed out on the web while it was in flight), with no cookie. */
    const refuse: { next: 'denied' | 'not_authorized' | null; getSession: boolean } = { next: null, getSession: false };
    const json = (status: number, body: unknown, setCookie: string[] = []) =>
        answer(status, { date: httpDate(T0), headers: { 'content-type': 'application/json' }, setCookie, body });
    const session = (account: Account) => {
        issued += 1;
        const token = `tok${issued}.c2ln`;
        sessions.set(token, account);
        return sessionSetCookie(token);
    };
    const fetch = fakeFetch((url: string, init: FetchRequestInit) => {
        const path = new URL(url).pathname;
        const cookie = cookieValue(sentHeaders({ url, init }).cookie, SESSION);
        const signedIn = cookie === undefined ? undefined : sessions.get(cookie);
        if (path === DEVICE_REDEEM_PATH) {
            const body = JSON.parse(String(init.body)) as Record<string, string>;
            redeemed.push(body);
            const parsed = deviceRedeemBodySchema.safeParse(body);
            const entry = [...requests.values()].find((request) => request.code === parsed.data?.code && !request.used);
            if (!parsed.success || entry?.account === undefined) {
                return json(400, { message: 'This code is not valid.', code: 'code_invalid' });
            }
            entry.used = true;
            if (refuse.next !== null) {
                return json(403, { message: 'Refused.', code: refuse.next });
            }
            const made = createHash('sha256').update(parsed.data.verifier).digest('base64url');
            if (made !== entry.challenge) {
                return json(400, { message: 'This code is not valid.', code: 'code_invalid' });
            }
            if (parsed.data.variant !== entry.variant) {
                return json(400, { message: 'Another build.', code: 'wrong_variant' });
            }
            if (entry.account.banned) {
                return json(403, { message: 'This account is deactivated.', code: 'BANNED_USER' });
            }
            return json(200, { deviceId: `dev-${issued + 1}` }, [session(entry.account)]);
        }
        if (path === SIGN_IN_PATH) {
            const { email } = JSON.parse(String(init.body)) as { email: string };
            const account = accounts.find((entry) => entry.email === email);
            return account === undefined
                ? json(401, { code: 'INVALID_EMAIL_OR_PASSWORD' })
                : json(200, { redirect: false }, [session(account)]);
        }
        if (path === SESSION_PATH) {
            return json(200, {
                provider: 'betterauth',
                branding: { name: 'Acme', logo: '/favicon.svg' },
                user: signedIn === undefined ? null : { id: signedIn.appUserId, name: signedIn.name, role: 'member' },
            });
        }
        if (path === AUTH_SESSION_PATH && refuse.getSession) {
            return json(500, { error: 'Down.' });
        }
        if (path === AUTH_SESSION_PATH) {
            return json(200, signedIn === undefined ? null : { session: {}, user: { email: signedIn.email } });
        }
        if (path === LOGOUT_PATH) {
            if (cookie !== undefined) {
                sessions.delete(cookie);
            }
            return json(200, { ok: true }, [sessionSetCookie('', 0)]);
        }
        return json(404, { error: 'Not found.' });
    });
    return {
        fetch,
        accounts,
        sessions,
        redeemed,
        refuse,
        /** `GET /api/auth/device/start`, as the sheet opens it. */
        start(url: string) {
            const query = deviceStartQuerySchema.parse(Object.fromEntries(new URL(url).searchParams));
            requests.set(query.state, { challenge: query.challenge, variant: query.variant });
        },
        /** The person's Continue on the web: the callback with a fresh code. */
        approve(state: string, email = 'ada@example.test', variant: 'development' | 'preview' = 'development') {
            const entry = requests.get(state);
            if (entry === undefined) {
                throw new Error('No such request.');
            }
            entry.code = 'ABCDEFGHJKMN'
                .split('')
                .sort(() => Math.random() - 0.5)
                .join('');
            entry.account = accounts.find((account) => account.email === email);
            return callbackUrl({ code: entry.code, state }, HOST, variant);
        },
    };
}

let device: Phone;
let logs: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-sheet-')));
    logs = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(device.root, { recursive: true, force: true });
});

const flowOn = (store: Store, now: () => number = () => T0, config: SheetConfig = DEV): SheetFlow =>
    createSheetFlow({
        keys: store.keys,
        randomBytes: nodeBytes,
        sha256: sha256Base64,
        config,
        platform: 'android',
        now,
    });

/** The flow's take, as a taken callback or null. */
const take = async (flow: SheetFlow, url: string) => {
    const result = await flow.take(url);
    return 'taken' in result ? result.taken : null;
};

const deps = (store: Store, server: ReturnType<typeof workspace>): SignInFlowDeps => ({
    store,
    hash: sha256,
    fetch: server.fetch,
    userAgent: USER_AGENT,
    now: () => T0,
    randomBytes: nodeBytes,
});

/** `finishSheetSignIn`'s request, under Node. */
const redeemRequest = (
    taken: { origin: string; code: string; verifier: string; variant: 'development' | 'preview' | 'production' },
    server: ReturnType<typeof workspace>,
) => ({
    origin: taken.origin,
    email: null,
    logo: null,
    stage: (installId: string) =>
        redeemSheetCode({
            origin: taken.origin,
            code: taken.code,
            verifier: taken.verifier,
            installId,
            label: deviceLabel('android'),
            variant: taken.variant,
            fetch: server.fetch,
            userAgent: USER_AGENT,
            now: () => T0,
        }),
});

const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';

/** Every byte the phone holds, and every log line. */
function everything(): string {
    const files = readdirSync(device.root, { recursive: true, encoding: 'utf8' })
        .map((path) => join(device.root, path))
        .filter((path) => statSync(path).isFile())
        .map((path) => readFileSync(path).toString('latin1'));
    return [...files, ...device.keychain.values(), JSON.stringify(logs.map((spy) => spy.mock.calls))].join('\n');
}

describe('the PKCE pair, the start page and the callback', () => {
    it('base64url is unpadded RFC 4648 base64url', () => {
        for (const length of [0, 1, 2, 3, 31, 32, 33]) {
            const bytes = nodeBytes(length);
            expect(base64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
        }
    });

    it('a verifier of 32 random bytes, its S256 challenge and a random state, each as the server takes them', async () => {
        const one = await newSheetSecrets(nodeBytes, sha256Base64);
        const two = await newSheetSecrets(nodeBytes, sha256Base64);
        expect(one.verifier).toHaveLength(43);
        expect(pkceVerifierSchema.safeParse(one.verifier).success).toBe(true);
        expect(sheetStateSchema.safeParse(one.state).success).toBe(true);
        expect(one.challenge).toBe(createHash('sha256').update(one.verifier).digest('base64url'));
        expect(new Set([one.verifier, one.state, two.verifier, two.state]).size).toBe(4);
        await expect(newSheetSecrets(() => new Uint8Array(16), sha256Base64)).rejects.toThrow(/16 bytes/);
    });

    it('the start page carries exactly the challenge, the state, the platform and the variant', async () => {
        const { challenge, state } = await newSheetSecrets(nodeBytes, sha256Base64);
        const url = deviceStartUrl(ORIGIN, { challenge, state, platform: 'ios', variant: 'preview' });
        expect(url.startsWith(`${ORIGIN}/api/auth/device/start?`)).toBe(true);
        expect(deviceStartQuerySchema.parse(Object.fromEntries(new URL(url).searchParams))).toEqual({
            challenge,
            state,
            platform: 'ios',
            variant: 'preview',
        });
    });

    it('reads only this build’s callback: its link host, its variant, no query, every field', () => {
        const fields = { code: 'ABCDEFGHJKMN', state: 's'.repeat(43) };
        expect(readSheetCallback(callbackUrl(fields), DEV)).toEqual({ ...fields, host: HOST });
        expect(readSheetCallback(callbackUrl(fields, HOST, 'preview'), DEV)).toBeNull();
        expect(readSheetCallback(callbackUrl(fields).replace(LINK_HOST, 'link.socio.sh'), DEV)).toBeNull();
        expect(readSheetCallback(callbackUrl(fields).replace('/cb#', '/cb?x=1#'), DEV)).toBeNull();
        expect(readSheetCallback(`https://${LINK_HOST}/dev/cb#code=ABCDEFGHJKMN&ws=${HOST}`, DEV)).toBeNull();
        expect(readSheetCallback(`socio-dev://auth-callback#code=X&state=Y&ws=${HOST}`, DEV)).toBeNull();
        const scheme: SheetConfig = { ...DEV, callback: { kind: 'scheme', url: 'socio-dev://auth-callback' } };
        const fragment = callbackUrl(fields).split('#')[1];
        expect(readSheetCallback(`socio-dev://auth-callback#${fragment}`, scheme)).toEqual({ ...fields, host: HOST });
        expect(readSheetCallback(callbackUrl(fields), scheme)).toBeNull();
    });

    it('offers the sheet only with the manifest’s `sheet` and a build that has one; the password unless turned off', () => {
        const manifest = (methods: Partial<WorkspaceManifest['methods']>) =>
            ({
                methods: {
                    password: true,
                    passkey: true,
                    sheet: true,
                    signInCodes: null,
                    addDevice: false,
                    ...methods,
                },
            }) as WorkspaceManifest;
        expect(signInWays(null, true)).toEqual(['password']);
        expect(signInWays(manifest({}), true)).toEqual(['sheet', 'password']);
        expect(signInWays(manifest({}), false)).toEqual(['password']);
        expect(signInWays(manifest({ sheet: false }), true)).toEqual(['password']);
        expect(signInWays(manifest({ password: false }), true)).toEqual(['sheet']);
        expect(signInWays(manifest({ password: false }), false)).toEqual([]);
        // Sign-in codes: a code by the manifest's channel, after the sheet.
        expect(signInWays(manifest({ signInCodes: 'email' }), true)).toEqual(['sheet', 'code', 'password']);
        expect(signInWays(manifest({ signInCodes: 'telegram', password: false }), false)).toEqual(['code']);
    });

    it('names the device by its platform only', () => {
        expect(deviceLabel('android')).toBe('Socio app on Android');
        expect(deviceLabel('ios')).toBe('Socio app on iPhone');
        expect(deviceLabel('ios', true)).toBe('Socio app on iPad');
    });
});

describe('the pending flow', () => {
    it('is kept in secure storage, indexed, until its callback takes it once', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store);
        const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        expect(stateOf(url)).toBe(state);
        expect(await store.keys.indexed()).toContain(SHEET_PENDING_KEY);
        server.start(url);
        const callback = server.approve(state);
        const [first, second] = await Promise.all([take(flow, callback), take(flow, callback)]);
        expect(first).toMatchObject({ origin: ORIGIN, name: 'Acme', state, variant: 'development' });
        expect(second).toBeNull();
        expect(await store.keys.read(SHEET_PENDING_KEY)).toBeNull();
    });

    it('a callback with another state, another host or no pending flow does nothing, and the flow waits for its own', async () => {
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store);
        const code = 'ABCDEFGHJKMN';
        expect(await take(flow, callbackUrl({ code, state: 'n'.repeat(43) }))).toBeNull();
        const { state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        const kept = await store.keys.read(SHEET_PENDING_KEY);
        expect(await take(flow, callbackUrl({ code, state: 'x'.repeat(43) }))).toBeNull();
        expect(await take(flow, callbackUrl({ code, state }, 'evil.example.test'))).toBeNull();
        expect(await take(flow, callbackUrl({ code, state }, `${HOST}:8443`))).toBeNull();
        expect(await take(flow, callbackUrl({ code, state }, HOST, 'preview'))).toBeNull();
        expect(await take(flow, 'https://example.test/')).toBeNull();
        expect(await store.keys.read(SHEET_PENDING_KEY)).toBe(kept);
        expect(await take(flow, callbackUrl({ code, state }))).toMatchObject({ code, state });
    });

    it('cancel deletes only the flow that was cancelled', async () => {
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store);
        const old = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        const current = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        await flow.cancel(old.state);
        expect(await store.keys.read(SHEET_PENDING_KEY)).not.toBeNull();
        await flow.cancel(current.state);
        expect(await store.keys.read(SHEET_PENDING_KEY)).toBeNull();
        expect(await take(flow, callbackUrl({ code: 'ABCDEFGHJKMN', state: current.state }))).toBeNull();
    });

    it('expires after 15 minutes: its callback does nothing, and launch’s sweep deletes it', async () => {
        let now = T0;
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store, () => now);
        const { state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        now = T0 + SHEET_PENDING_MS - 1;
        await flow.sweep();
        expect(await store.keys.read(SHEET_PENDING_KEY)).not.toBeNull();
        now = T0 + SHEET_PENDING_MS;
        expect(await take(flow, callbackUrl({ code: 'ABCDEFGHJKMN', state }))).toBeNull();
        expect(await store.keys.read(SHEET_PENDING_KEY)).toBeNull();

        await flow.begin({ origin: ORIGIN, name: 'Acme' });
        now += SHEET_PENDING_MS;
        await flow.sweep();
        expect(await store.keys.read(SHEET_PENDING_KEY)).toBeNull();
        await store.keys.write(SHEET_PENDING_KEY, '{not json');
        await flow.sweep();
        expect(await store.keys.read(SHEET_PENDING_KEY)).toBeNull();
    });
});

describe('signing in through the sheet', { timeout: 20_000 }, () => {
    it('a kill between the sheet and the callback: the next launch takes it, redeems and commits', async () => {
        const server = workspace();
        const first = await launch(device, { now: () => T0 });
        const { url, state } = await flowOn(first.store).begin({ origin: ORIGIN, name: 'Acme' });
        server.start(url);
        await kill(first.store);
        const callback = server.approve(state);

        const { store } = await launch(device, { now: () => T0 });
        const taken = await take(flowOn(store), callback);
        expect(taken).not.toBeNull();
        const outcome = await signInAndCommit(redeemRequest(taken!, server), deps(store, server));
        expect(outcome).toMatchObject({ kind: 'committed', committed: 'new' });
        const id = outcome.kind === 'committed' ? outcome.id : '';
        expect(await store.registry.get(id)).toMatchObject({
            origin: ORIGIN,
            appUserId: 'u-ada',
            personName: 'Ada',
            personEmail: 'ada@example.test',
            state: 'ready',
        });
        // The redeem's body and every request of it carry the install id the commit keeps.
        const [body] = server.redeemed;
        expect(body).toMatchObject({ variant: 'development', label: 'Socio app on Android' });
        const kept = await store.keys.read(workspaceKeyName(id, 'install'));
        expect(body.installId).toBe(kept);
        const redeemCall = server.fetch.calls.find((call) => new URL(call.url).pathname === DEVICE_REDEEM_PATH);
        expect(sentHeaders(redeemCall)['x-socio-install']).toBe(kept);
        expect(await store.registry.active()).toBe(id);
    });

    it('a sheet sign-in never reuses a kept install id: the person isn’t known until the server answers', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const flow = flowOn(store);
        const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        server.start(url);
        const taken = await take(flow, server.approve(state));
        const outcome = await signInAndCommit(redeemRequest(taken!, server), deps(store, server));
        expect(outcome).toMatchObject({ kind: 'committed', committed: 'same-person', id: ada.id });
        expect(server.redeemed[0].installId).not.toBe(installIdOf(ada.id));
    });

    it('BANNED_USER on redeem: the deactivated line, nothing committed, no session left, and no copy wiped by guess', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        server.accounts[0].banned = true;
        const flow = flowOn(store);
        const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        server.start(url);
        const taken = await take(flow, server.approve(state));
        const before = (await store.registry.list()).map((row) => row.id);
        const outcome = await signInAndCommit(redeemRequest(taken!, server), deps(store, server));
        expect(outcome).toMatchObject({ kind: 'problem', problem: { kind: 'deactivated', status: 403 }, wiped: [] });
        expect((await store.registry.list()).map((row) => row.id)).toEqual(before);
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'ready' });
        expect(server.sessions.size).toBe(0);
    });

    it('wrong_variant, a dead code and the method turned off are each worded, and nothing is committed', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store);
        const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        server.start(url);
        const taken = await take(flow, server.approve(state));
        const wrong = await signInAndCommit(
            redeemRequest({ ...taken!, variant: 'preview' }, server),
            deps(store, server),
        );
        expect(wrong).toMatchObject({ kind: 'problem', problem: { kind: 'wrong-variant', code: 'wrong_variant' } });
        expect(wrong.kind === 'problem' && signInCopy(wrong.problem).message).toBe(SHEET_WRONG_APP);
        // The code was used up by that try: the server burns it whatever was wrong.
        const again = await signInAndCommit(redeemRequest(taken!, server), deps(store, server));
        expect(again).toMatchObject({ kind: 'problem', problem: { kind: 'code-invalid' } });
        expect(again.kind === 'problem' && signInCopy(again.problem).message).toBe(SHEET_CODE_DEAD);
        expect(signInCopy({ kind: 'sheet-off', status: 403, code: 'method_off' }).message).toBe(SHEET_METHOD_OFF);
        expect(await store.registry.list()).toEqual([]);
        expect(server.sessions.size).toBe(0);
    });

    it.each([
        ['denied', 'sheet-denied', SHEET_DENIED],
        ['not_authorized', 'not-authorized', SHEET_APPROVER_GONE],
    ] as const)(
        'a 403 %s on redeem (refused or signed out on the web meanwhile): its own line, no session, and the flow is over',
        async (code, kind, line) => {
            const server = workspace();
            const { store } = await launch(device, { now: () => T0 });
            const flow = flowOn(store);
            const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
            server.start(url);
            const callback = server.approve(state);
            const taken = await take(flow, callback);
            server.refuse.next = code;
            const outcome = await signInAndCommit(redeemRequest(taken!, server), deps(store, server));
            expect(outcome).toMatchObject({ kind: 'problem', problem: { kind, status: 403, code } });
            expect(outcome.kind === 'problem' && signInCopy(outcome.problem).message).toBe(line);
            expect(await store.registry.list()).toEqual([]);
            expect(server.sessions.size).toBe(0);
            // The pending flow ended when the callback was taken: the same callback again does nothing.
            expect(await store.keys.read(SHEET_PENDING_KEY)).toBeNull();
            expect(await take(flow, callback)).toBeNull();
        },
    );

    it('a verifier other than the sheet’s gets nothing', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store);
        const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        server.start(url);
        const taken = await take(flow, server.approve(state));
        const other = await newSheetSecrets(nodeBytes, sha256Base64);
        const outcome = await signInAndCommit(
            redeemRequest({ ...taken!, verifier: other.verifier }, server),
            deps(store, server),
        );
        expect(outcome).toMatchObject({ kind: 'problem', problem: { kind: 'code-invalid' } });
    });

    it('the verifier, the state and the code are in no log, problem or stored byte once the flow is done', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store);
        const secrets: string[] = [];
        const outcomes: unknown[] = [];
        for (const banned of [true, false]) {
            server.accounts[0].banned = banned;
            const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
            server.start(url);
            const taken = await take(flow, server.approve(state));
            secrets.push(taken!.verifier, taken!.state, taken!.code);
            outcomes.push(await signInAndCommit(redeemRequest(taken!, server), deps(store, server)));
        }
        const cancelled = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        await flow.cancel(cancelled.state);
        secrets.push(cancelled.state);
        expect(outcomes.map((outcome) => (outcome as { kind: string }).kind)).toEqual(['problem', 'committed']);
        const seen = `${everything()}\n${JSON.stringify(outcomes)}`;
        for (const secret of secrets) {
            expect(seen).not.toContain(secret);
        }
    });
});

describe('the sheet sign-in’s edge cases', { timeout: 20_000 }, () => {
    const manifest = (methods: Partial<WorkspaceManifest['methods']> = {}) =>
        ({
            id: 'ws_acme',
            methods: { password: true, passkey: true, sheet: true, signInCodes: null, addDevice: false, ...methods },
        }) as WorkspaceManifest;

    it('signing in again (no manifest in its params) reads the manifest, so the sheet is offered there too', async () => {
        const params = signInAgainParams({ origin: ORIGIN, name: 'Acme' });
        expect('manifest' in params).toBe(false);
        const read = vi.fn(async () => ({ kind: 'manifest' as const, manifest: manifest() }));
        const chosen = await signInManifest(undefined, read);
        expect(read).toHaveBeenCalledOnce();
        expect(signInWays(chosen, true)).toEqual(['sheet', 'password']);
        // No manifest, or no answer: the password form, as before.
        expect(signInWays(await signInManifest(null, async () => ({ kind: 'none', status: 404 })), true)).toEqual([
            'password',
        ]);
        expect(signInWays(await signInManifest(null, async () => ({ kind: 'unreachable' })), true)).toEqual([
            'password',
        ]);
        // The probe's manifest is used as it is, with nothing read.
        const unread = vi.fn();
        expect(await signInManifest(manifest({ sheet: false }), unread)).toMatchObject({ methods: { sheet: false } });
        expect(unread).not.toHaveBeenCalled();
    });

    it('a callback the flow refuses says why, by kind only', async () => {
        let now = T0;
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store, () => now);
        const code = 'ABCDEFGHJKMN';
        expect(await flow.take('https://example.test/')).toEqual({ refused: 'not-callback' });
        expect(await flow.take(callbackUrl({ code, state: 'n'.repeat(43) }))).toEqual({ refused: 'no-flow' });
        const { state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        expect(await flow.take(callbackUrl({ code, state: 'x'.repeat(43) }))).toEqual({ refused: 'state' });
        expect(await flow.take(callbackUrl({ code, state }, 'evil.example.test'))).toEqual({ refused: 'host' });
        now += SHEET_PENDING_MS;
        expect(await flow.take(callbackUrl({ code, state }))).toEqual({ refused: 'expired' });
    });

    it('another account approved in the browser: Cancel signs the redeemed session out and changes nothing', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const flow = flowOn(store);
        const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        server.start(url);
        const taken = await take(flow, server.approve(state, 'bob@example.test'));
        const outcome = await signInAndCommit(redeemRequest(taken!, server), deps(store, server));
        expect(outcome.kind).toBe('other-person');
        expect(server.sessions.size).toBe(1);
        if (outcome.kind === 'other-person') {
            await outcome.cancel();
        }
        expect(server.sessions.size).toBe(0);
        expect((await store.registry.list()).map((row) => row.id)).toEqual([ada.id]);
    });

    it('another account approved in the browser: Confirm wipes the previous person’s copy, then commits', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const flow = flowOn(store);
        const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        server.start(url);
        const taken = await take(flow, server.approve(state, 'bob@example.test'));
        const outcome = await signInAndCommit(redeemRequest(taken!, server), deps(store, server));
        const confirmed = outcome.kind === 'other-person' ? await outcome.confirm() : outcome;
        expect(confirmed).toMatchObject({ kind: 'committed', committed: 'new' });
        const rows = await store.registry.list();
        expect(rows.map((row) => row.appUserId)).toEqual(['u-bob']);
        expect(rows[0]).toMatchObject({ personEmail: 'bob@example.test' });
        expect(await store.registry.get(ada.id)).toBeNull();
    });

    it('a get-session that fails still commits, with no email', async () => {
        const server = workspace();
        server.refuse.getSession = true;
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store);
        const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
        server.start(url);
        const taken = await take(flow, server.approve(state));
        const outcome = await signInAndCommit(redeemRequest(taken!, server), deps(store, server));
        expect(outcome).toMatchObject({ kind: 'committed', committed: 'new' });
        const id = outcome.kind === 'committed' ? outcome.id : '';
        expect(await store.registry.get(id)).toMatchObject({
            appUserId: 'u-ada',
            personName: 'Ada',
            personEmail: null,
        });
    });

    it('signing in again as the same person signs the replaced session out, in the background, with its install id', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const signInOnce = async () => {
            const flow = flowOn(store);
            const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
            server.start(url);
            const taken = await take(flow, server.approve(state));
            const later: Promise<void>[] = [];
            const outcome = await signInAndCommit(redeemRequest(taken!, server), {
                ...deps(store, server),
                later: (work) => later.push(work),
            });
            return { outcome, later };
        };
        const first = await signInOnce();
        expect(first.outcome).toMatchObject({ kind: 'committed', committed: 'new' });
        expect(first.later).toEqual([]);
        const id = first.outcome.kind === 'committed' ? first.outcome.id : '';
        const oldInstall = await store.keys.read(workspaceKeyName(id, 'install'));
        const [oldToken] = [...server.sessions.keys()];

        // The commit answers first; the sign-out is handed to `later`, which nothing waits for.
        const second = await signInOnce();
        expect(second.outcome).toMatchObject({ kind: 'committed', committed: 'same-person', id });
        expect(second.later).toHaveLength(1);
        await second.later[0];
        expect(server.sessions.has(oldToken)).toBe(false);
        expect(server.sessions.size).toBe(1);
        const logout = server.fetch.calls.filter((call) => new URL(call.url).pathname === LOGOUT_PATH);
        expect(logout).toHaveLength(1);
        expect(cookieValue(sentHeaders(logout[0]).cookie, SESSION)).toBe(oldToken);
        expect(sentHeaders(logout[0])['x-socio-install']).toBe(oldInstall);
        expect(await store.keys.read(workspaceKeyName(id, 'install'))).not.toBe(oldInstall);
    });

    it('a replaced session’s sign-out that fails never fails the commit', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const flow = flowOn(store);
        let later: Promise<void>[] = [];
        for (let round = 0; round < 2; round++) {
            const { url, state } = await flow.begin({ origin: ORIGIN, name: 'Acme' });
            server.start(url);
            const taken = await take(flow, server.approve(state));
            later = [];
            const failing = Object.assign(
                async (url: string, init: Parameters<typeof server.fetch>[1]) =>
                    new URL(url).pathname === LOGOUT_PATH
                        ? Promise.reject(new TypeError('offline'))
                        : server.fetch(url, init),
                { calls: [] },
            );
            const outcome = await signInAndCommit(redeemRequest(taken!, server), {
                ...deps(store, server),
                fetch: failing,
                later: (work) => later.push(work),
            });
            expect(outcome).toMatchObject({ kind: 'committed' });
        }
        expect(later).toHaveLength(1);
        await expect(later[0]).resolves.toBeUndefined();
    });
});
