import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';
import { appLink, pairClaimBodySchema, pairRedeemBodySchema } from '@socio/shared/device-sign-in';

import { signInAndCommit, type Store } from '../src/data';
import { type AddDevice, type AddDeviceView, createAddDevice, otherAccounts } from '../src/data/add-device';
import {
    CLAIM_DEAD,
    CLAIM_DENIED,
    CLAIM_EXPIRED,
    CLAIM_METHOD_OFF,
    CLAIM_MS,
    CLAIM_SIGNED_OUT,
    CLAIM_WRONG_APP,
    cancelPairing,
    claimLine,
    claimPairing,
    CODE_USED,
    countdownLabel,
    deviceLinkAddress,
    deviceLinkConfig,
    otherAccountLine,
    otherAccountQuestion,
    PAIR_CANCEL_PATH,
    PAIR_CLAIM_PATH,
    POLL_MS,
    pollVerdict,
    readDeviceLink,
    secondsLeft,
    shownDigits,
    signInAsQuestion,
} from '../src/net/add-device';
import { AbortedError } from '../src/net/errors';
import { probeWorkspace } from '../src/net/probe';
import { createPublicFetch } from '../src/net/public-fetch';
import { deviceLabel } from '../src/net/sheet-sign-in';
import { AUTH_SESSION_PATH, LOGOUT_PATH, PAIR_REDEEM_PATH, redeemPairing, SESSION_PATH } from '../src/net/sign-in';
import type { SignInProblem } from '../src/net/sign-in';

import { addWorkspace, launch, phone, type Phone, sha256 } from './helpers/store';
import {
    answer,
    cookieValue,
    deferred,
    httpDate,
    ORIGIN,
    SESSION,
    sentHeaders,
    sessionSetCookie,
    T0,
} from './net/helpers';

// Add a device, on the new device, under Node: the link, the view models, and the whole
// flow against a workspace that answers as the server does (src/server/auth/device-sign-in.ts):
// the first claim uses the pairing code up; the redeem answers `not_allowed_yet` until the web types
// the digits, `too_many` past one poll a second, 403 `denied` after a deny, 3 wrong tries, the claim's
// 2 minutes or 15 s with no poll from the web page; then the session cookie. The time is a fake
// clock the test moves, with the flow's sleeps on it.

const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';
const LINK_HOST = 'link-staging.socio.sh';
const HOST = new URL(ORIGIN).host;
const sha256Base64 = async (text: string) => createHash('sha256').update(text).digest('base64');
const nodeBytes = (length: number) => new Uint8Array(randomBytes(length));
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const newCode = () => Array.from({ length: 12 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
/** Digits that stand out in a search of every stored byte and log line. */
const DIGITS = '907153';

const deviceLinkFor = (code: string, host = HOST, variant: 'development' | 'preview' = 'development') =>
    appLink({ kind: 'd', variant, host, fields: { c: code } }, LINK_HOST);

interface Account {
    readonly email: string;
    readonly appUserId: string;
    readonly name: string;
    banned: boolean;
}

interface Pairing {
    code: string;
    variant: string;
    account: Account;
    claimId: string | null;
    challenge: string | null;
    claimExpiresAt: number;
    webPolledAt: number;
    tries: number;
    allowed: boolean;
    denied: boolean;
    used: boolean;
    lastRedeem: number | null;
}

/** A workspace that answers as the server does, with the web's side (`web`) driven by the test. */
function workspace(clock: { now: number }) {
    const accounts: Account[] = [
        { email: 'ada@example.test', appUserId: 'u-ada', name: 'Ada', banned: false },
        { email: 'ben@example.test', appUserId: 'u-ben', name: 'Ben', banned: false },
    ];
    const pairings: Pairing[] = [];
    const sessions = new Map<string, Account>();
    const claims: unknown[] = [];
    const redeems: number[] = [];
    const tooMany: number[] = [];
    const refuse: { next: 'not_authorized' | 'method_off' | 'BANNED_USER' | null } = { next: null };
    const offline = { redeem: false, cancel: false };
    const cancels: string[] = [];
    /** Holds the next redeem's answer until the test lets it go. */
    const hold: { next: Promise<void> | null } = { next: null };
    let issued = 0;
    const json = (status: number, body: unknown, setCookie: string[] = []) =>
        answer(status, { date: httpDate(clock.now), headers: { 'content-type': 'application/json' }, setCookie, body });
    const stateOf = (row: Pairing) => {
        if (row.denied) {
            return 'denied';
        }
        if (row.claimExpiresAt <= clock.now || clock.now - row.webPolledAt > 15_000) {
            return 'expired';
        }
        return row.allowed ? 'allowed' : 'waiting';
    };
    const calls: { url: string; init: FetchRequestInit }[] = [];
    const fetch = async (url: string, init: FetchRequestInit): Promise<Response> => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        const cookie = cookieValue(sentHeaders({ url, init }).cookie, SESSION);
        const signedIn = cookie === undefined ? undefined : sessions.get(cookie);
        if (path === '/.well-known/socio/workspace') {
            return json(404, { error: 'Not found.' });
        }
        if (path === PAIR_CLAIM_PATH) {
            const body = JSON.parse(String(init.body)) as unknown;
            claims.push(body);
            const parsed = pairClaimBodySchema.safeParse(body);
            if (!parsed.success) {
                return json(400, { code: 'code_invalid' });
            }
            const row = pairings.find(
                (entry) => entry.code === parsed.data.code && entry.claimId === null && !entry.denied,
            );
            if (row === undefined) {
                return json(400, { error: 'This code was already used.', code: 'code_invalid' });
            }
            row.claimId = randomBytes(18).toString('base64url');
            row.challenge = parsed.data.challenge;
            row.claimExpiresAt = clock.now + CLAIM_MS;
            row.webPolledAt = clock.now;
            if (parsed.data.variant !== row.variant) {
                row.denied = true;
                return json(400, { code: 'wrong_variant' });
            }
            return json(200, {
                claimId: row.claimId,
                digits: DIGITS,
                expiresAt: new Date(row.claimExpiresAt).toISOString(),
                workspace: { name: 'Acme', host: HOST },
                account: { name: row.account.name, email: row.account.email },
            });
        }
        if (path === PAIR_CANCEL_PATH) {
            if (offline.cancel) {
                throw new TypeError('Network request failed');
            }
            const { claimId } = JSON.parse(String(init.body)) as { claimId: string };
            cancels.push(claimId);
            const row = pairings.find((entry) => entry.claimId === claimId);
            if (row !== undefined) {
                row.denied = true;
            }
            return json(200, { state: 'denied' });
        }
        if (path === PAIR_REDEEM_PATH) {
            if (hold.next !== null) {
                const wait = hold.next;
                hold.next = null;
                await wait;
            }
            if (offline.redeem) {
                throw new TypeError('Network request failed');
            }
            const parsed = pairRedeemBodySchema.safeParse(JSON.parse(String(init.body)));
            if (!parsed.success) {
                return json(400, { code: 'code_invalid' });
            }
            const row = pairings.find((entry) => entry.claimId === parsed.data.claimId);
            if (row === undefined) {
                return json(400, { code: 'code_invalid' });
            }
            if (row.lastRedeem !== null && clock.now - row.lastRedeem < 1000) {
                tooMany.push(clock.now);
                return json(429, { code: 'too_many' });
            }
            row.lastRedeem = clock.now;
            redeems.push(clock.now);
            const state = stateOf(row);
            if (state === 'waiting') {
                return json(400, { code: 'not_allowed_yet' });
            }
            if (state !== 'allowed' || row.used) {
                return json(403, { code: 'denied' });
            }
            row.used = true;
            if (createHash('sha256').update(parsed.data.verifier).digest('base64url') !== row.challenge) {
                return json(400, { code: 'code_invalid' });
            }
            if (refuse.next !== null) {
                const code = refuse.next;
                refuse.next = null;
                return json(403, { code });
            }
            issued += 1;
            const token = `tok${issued}.c2ln`;
            sessions.set(token, row.account);
            return json(200, { deviceId: `dev-${issued}` }, [sessionSetCookie(token)]);
        }
        if (path === SESSION_PATH) {
            return json(200, {
                provider: 'betterauth',
                branding: { name: 'Acme', logo: '/favicon.svg' },
                user: signedIn === undefined ? null : { id: signedIn.appUserId, name: signedIn.name, role: 'member' },
            });
        }
        if (path === AUTH_SESSION_PATH) {
            return json(200, null);
        }
        if (path === LOGOUT_PATH) {
            return json(200, { ok: true }, [sessionSetCookie('', 0)]);
        }
        return json(404, { error: 'Not found.' });
    };
    const fetchFn = Object.assign(fetch, { calls });
    /** The web's side: a QR code for an account, its poll, its typed digits, its "Not my device". */
    const web = {
        mint(email = 'ada@example.test', variant = 'development') {
            const account = accounts.find((entry) => entry.email === email);
            if (account === undefined) {
                throw new Error('No such account.');
            }
            const row: Pairing = {
                code: newCode(),
                variant,
                account,
                claimId: null,
                challenge: null,
                claimExpiresAt: 0,
                webPolledAt: 0,
                tries: 0,
                allowed: false,
                denied: false,
                used: false,
                lastRedeem: null,
            };
            pairings.push(row);
            return row;
        },
        poll(row: Pairing) {
            row.webPolledAt = clock.now;
        },
        confirm(row: Pairing, digits: string) {
            if (stateOf(row) !== 'waiting') {
                return 'refused';
            }
            if (digits === DIGITS) {
                row.allowed = true;
                return 'allowed';
            }
            row.tries += 1;
            if (row.tries >= 3) {
                row.denied = true;
            }
            return row.denied ? 'denied' : 'wrong';
        },
        deny(row: Pairing) {
            row.denied = true;
        },
    };
    return { fetch: fetchFn, web, claims, redeems, tooMany, refuse, sessions, offline, cancels, hold };
}

/** The flow's sleeps, on the fake clock: `advance` wakes them in order. */
function timers(clock: { now: number }) {
    const sleepers: { at: number; resolve: () => void }[] = [];
    const sleep = (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
                reject(new AbortedError(''));
                return;
            }
            const sleeper = { at: clock.now + ms, resolve };
            sleepers.push(sleeper);
            signal.addEventListener(
                'abort',
                () => {
                    sleepers.splice(sleepers.indexOf(sleeper), 1);
                    reject(new AbortedError(''));
                },
                { once: true },
            );
        });
    const idle = async () => {
        for (let i = 0; i < 30; i += 1) {
            await new Promise((done) => setImmediate(done));
        }
    };
    return {
        sleep,
        idle,
        /** Moves the clock `ms` on, waking each sleep when its time comes, and letting what it starts run. */
        async advance(ms: number, each?: () => void) {
            const target = clock.now + ms;
            await idle();
            for (;;) {
                sleepers.sort((a, b) => a.at - b.at);
                const next = sleepers[0];
                if (next === undefined || next.at > target) {
                    break;
                }
                sleepers.shift();
                clock.now = Math.max(clock.now, next.at);
                each?.();
                next.resolve();
                await idle();
            }
            clock.now = target;
            each?.();
            await idle();
        },
    };
}

function foreground() {
    let active = true;
    const listeners = new Set<() => void>();
    return {
        active: () => active,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(next: boolean) {
            active = next;
            for (const listener of listeners) {
                listener();
            }
        },
    };
}

let device: Phone;
let logs: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-pair-')));
    logs = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(device.root, { recursive: true, force: true });
});

/** Every byte the phone holds, and every log line. */
function everything(): string {
    const files = readdirSync(device.root, { recursive: true, encoding: 'utf8' })
        .map((path) => join(device.root, path))
        .filter((path) => statSync(path).isFile())
        .map((path) => readFileSync(path).toString('latin1'));
    return [...files, ...device.keychain.values(), JSON.stringify(logs.map((spy) => spy.mock.calls))].join('\n');
}

/** The flow as src/platform/add-device.ts binds it, on this store and server. */
function flowOn(store: Store, server: ReturnType<typeof workspace>, clock: { now: number }) {
    const time = timers(clock);
    const app = foreground();
    const publicFetch = createPublicFetch({ fetch: server.fetch, userAgent: USER_AGENT });
    const flow = createAddDevice({
        variant: 'development',
        platform: 'android',
        label: deviceLabel('android'),
        probe: (text, signal) =>
            probeWorkspace(text, { variant: 'development', publicFetch, isKnown: () => false, signal }),
        claim: (input, signal) => claimPairing({ ...input, fetch: server.fetch, userAgent: USER_AGENT, signal }),
        redeem: (job, signal) =>
            redeemPairing({ ...job, fetch: server.fetch, userAgent: USER_AGENT, signal, now: () => clock.now }),
        signIn: ({ origin, email, manifest, signal, stage }) =>
            signInAndCommit(
                { origin, email, logo: null, manifest, signal, stage },
                {
                    store,
                    hash: sha256,
                    fetch: server.fetch,
                    userAgent: USER_AGENT,
                    now: () => clock.now,
                    randomBytes: nodeBytes,
                },
            ),
        others: (origin, email) => otherAccounts(store, origin, email),
        cancel: (origin, claimId) => cancelPairing({ origin, claimId, fetch: server.fetch, userAgent: USER_AGENT }),
        randomBytes: nodeBytes,
        sha256: sha256Base64,
        foreground: app,
        now: () => clock.now,
        sleep: time.sleep,
    });
    const views: AddDeviceView[] = [];
    flow.subscribe(() => views.push(flow.view()));
    return { flow, time, app, views };
}

async function setUp() {
    const clock = { now: T0 };
    const server = workspace(clock);
    const { store } = await launch(device, { now: () => clock.now });
    return { clock, server, store, ...flowOn(store, server, clock) };
}

const LINKS = { variant: 'development' as const, linkHost: LINK_HOST };
const linkOf = (code: string) => {
    const link = readDeviceLink(deviceLinkFor(code), LINKS);
    if (link === null) {
        throw new Error('Not a device link.');
    }
    return link;
};

/** Opens the link and presses Continue: the digits show. */
async function toDigits(flow: AddDevice, time: ReturnType<typeof timers>, code: string) {
    flow.start(linkOf(code));
    await vi.waitFor(() => expect(flow.view()).toMatchObject({ step: 'confirm', name: 'Acme', host: HOST }));
    flow.continue();
    await vi.waitFor(() => expect(flow.view().step).not.toBe('claiming'));
    await time.idle();
}

describe('the view models', () => {
    it('reads only this build’s Add a device links', () => {
        const code = newCode();
        expect(readDeviceLink(deviceLinkFor(code), LINKS)).toEqual({ code, host: HOST });
        expect(readDeviceLink(deviceLinkFor(code.toLowerCase()), LINKS)).toEqual({ code, host: HOST });
        // Another variant, another link host, another kind, a short code: none.
        expect(readDeviceLink(deviceLinkFor(code, HOST, 'preview'), LINKS)).toBeNull();
        expect(readDeviceLink(deviceLinkFor(code).replace(LINK_HOST, 'link.socio.sh'), LINKS)).toBeNull();
        expect(
            readDeviceLink(
                appLink({ kind: 'c', variant: 'development', host: HOST, fields: { code: 'ABCDEFGH' } }, LINK_HOST),
                LINKS,
            ),
        ).toBeNull();
        expect(readDeviceLink(deviceLinkFor('ABCDEFGH'), LINKS)).toBeNull();
        expect(readDeviceLink(`${deviceLinkFor(code)}&x=1`, LINKS)).toBeNull();
        expect(deviceLinkConfig({ linkHost: LINK_HOST }, 'development')).toEqual(LINKS);
        expect(deviceLinkConfig({}, 'development')).toBeNull();
    });

    it('checks the link’s host as a typed address', () => {
        expect(deviceLinkAddress('brain.example.test', 'production')).toEqual({
            ok: true,
            address: { origin: 'https://brain.example.test', host: 'brain.example.test' },
        });
        expect(deviceLinkAddress('brain.example.test:8443', 'production')).toEqual({ ok: false, problem: 'port' });
        expect(deviceLinkAddress('brain.example.test:8443', 'preview')).toMatchObject({ ok: true });
        // A development build's local server is the plain http it already takes; nowhere else.
        expect(deviceLinkAddress('10.0.2.2:4351', 'development')).toMatchObject({
            ok: true,
            address: { origin: 'http://10.0.2.2:4351' },
        });
        expect(deviceLinkAddress('10.0.2.2:4351', 'preview')).toMatchObject({
            ok: true,
            address: { origin: 'https://10.0.2.2:4351' },
        });
    });

    it('words the questions, the digits and the countdown, never with “phone”', () => {
        const ada = { name: 'Ada', email: 'ada@example.test' };
        expect(signInAsQuestion('Acme', ada)).toBe('Sign in to Acme as Ada (ada@example.test)?');
        expect(signInAsQuestion('Acme', { name: '', email: 'ada@example.test' })).toBe(
            'Sign in to Acme as ada@example.test?',
        );
        expect(otherAccountQuestion('Acme', 'ada@example.test', 'ben@example.test')).toBe(
            'This device is signed in to Acme as ada@example.test. Sign in as ben@example.test instead?',
        );
        expect(otherAccountLine(3)).toMatch(/3 unsent items will be deleted/);
        expect(otherAccountLine(null)).toMatch(/Anything they haven't sent yet will be deleted/);
        expect(shownDigits('907153')).toBe('907 153');
        expect(secondsLeft(T0 + CLAIM_MS, T0)).toBe(120);
        expect(secondsLeft(T0 + CLAIM_MS, T0 + 1)).toBe(120);
        expect(secondsLeft(T0 + CLAIM_MS, T0 + CLAIM_MS + 5)).toBe(0);
        expect(countdownLabel(120)).toBe('Expires in 2:00');
        expect(countdownLabel(65)).toBe('Expires in 1:05');
        for (const line of [CODE_USED, CLAIM_DENIED, CLAIM_EXPIRED, CLAIM_SIGNED_OUT, CLAIM_METHOD_OFF, CLAIM_DEAD]) {
            expect(line).not.toMatch(/phone/i);
        }
        expect(CODE_USED).toBe('This code was already used. Make a new one on your computer.');
    });

    it('words each refusal, and polls past the ones that mean “not yet”', () => {
        const problem = (kind: SignInProblem['kind']): SignInProblem =>
            kind === 'rate-limited'
                ? { kind, status: 429, code: 'too_many', retryAfterSeconds: null }
                : ({ kind, status: 400, code: null } as SignInProblem);
        expect(pollVerdict(problem('not-allowed-yet'), false)).toEqual({ kind: 'wait', reaching: true });
        expect(pollVerdict(problem('rate-limited'), false)).toEqual({ kind: 'wait', reaching: true });
        expect(pollVerdict(problem('unreachable'), false)).toEqual({ kind: 'wait', reaching: false });
        expect(pollVerdict(problem('server-error'), false)).toEqual({ kind: 'wait', reaching: false });
        expect(pollVerdict(problem('sheet-denied'), false)).toEqual({ kind: 'ended', line: CLAIM_DENIED });
        expect(pollVerdict(problem('sheet-denied'), true)).toEqual({ kind: 'ended', line: CLAIM_EXPIRED });
        expect(pollVerdict(problem('not-authorized'), false)).toEqual({ kind: 'ended', line: CLAIM_SIGNED_OUT });
        expect(pollVerdict(problem('sheet-off'), false)).toEqual({ kind: 'ended', line: CLAIM_METHOD_OFF });
        expect(pollVerdict(problem('deactivated'), false)).toEqual({ kind: 'ended', line: DEACTIVATED_MESSAGE });
        expect(pollVerdict(problem('code-invalid'), false)).toEqual({ kind: 'ended', line: CLAIM_DEAD });
        expect(claimLine({ kind: 'code-used', status: 400 })).toBe(CODE_USED);
        expect(claimLine({ kind: 'wrong-variant', status: 400 })).toBe(CLAIM_WRONG_APP);
    });
});

describe('Add a device', () => {
    it('opening the link claims nothing; Continue claims with a fresh challenge and the device label', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        flow.start(linkOf(row.code));
        await time.idle();
        expect(flow.view()).toEqual({ step: 'confirm', host: HOST, name: 'Acme' });
        expect(server.claims).toEqual([]);
        flow.continue();
        await time.idle();
        expect(server.claims).toHaveLength(1);
        const body = server.claims[0] as Record<string, string>;
        expect(Object.keys(body).sort()).toEqual(['challenge', 'code', 'label', 'platform', 'variant']);
        expect(body).toMatchObject({
            code: row.code,
            label: 'Socio app on Android',
            platform: 'android',
            variant: 'development',
        });
        expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(flow.view()).toMatchObject({
            step: 'digits',
            name: 'Acme',
            host: HOST,
            account: { name: 'Ada', email: 'ada@example.test' },
            digits: DIGITS,
            reaching: true,
        });
        flow.leave();
    });

    it('signs in once the web types the digits, through the commit', async () => {
        const { server, flow, time, store } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        // Two polls before the web types them, each `not_allowed_yet`.
        await time.advance(4000, () => server.web.poll(row));
        expect(server.redeems).toHaveLength(2);
        expect(flow.view().step).toBe('digits');
        expect(server.web.confirm(row, DIGITS)).toBe('allowed');
        await time.advance(2000, () => server.web.poll(row));
        await vi.waitFor(() => expect(flow.view()).toEqual({ step: 'signed-in' }));
        const rows = await store.registry.byOrigin(ORIGIN);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ state: 'ready', appUserId: 'u-ada', personEmail: 'ada@example.test' });
        // Nothing of the claim is left anywhere: the digits, the claim id, the verifier.
        const kept = everything();
        expect(kept).not.toContain(DIGITS);
        expect(kept).not.toContain(row.claimId);
        expect(kept).not.toContain(row.code);
    });

    it('a used code says so, and claims nothing more', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        // Someone else's device claimed it first.
        await claimPairing({
            origin: ORIGIN,
            code: row.code,
            challenge: 'x'.repeat(43),
            label: 'Socio app on iPhone',
            platform: 'ios',
            variant: 'development',
            fetch: server.fetch,
            userAgent: USER_AGENT,
        });
        flow.start(linkOf(row.code));
        await time.idle();
        flow.continue();
        await time.idle();
        expect(flow.view()).toMatchObject({ step: 'refused', line: CODE_USED });
        expect(server.redeems).toEqual([]);
    });

    it('a deny on the web ends the claim, and the digits leave the screen', async () => {
        const { server, flow, time, views } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        await time.advance(2000, () => server.web.poll(row));
        server.web.deny(row);
        await time.advance(2000, () => server.web.poll(row));
        expect(flow.view()).toEqual({ step: 'ended', host: HOST, name: 'Acme', line: CLAIM_DENIED });
        const redeemsAtEnd = server.redeems.length;
        await time.advance(10_000);
        expect(server.redeems).toHaveLength(redeemsAtEnd);
        expect(JSON.stringify(flow.view())).not.toContain(DIGITS);
        expect(views.at(-1)?.step).toBe('ended');
    });

    it('three wrong tries on the web end the claim; the right digits after them fail', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        expect(server.web.confirm(row, '111111')).toBe('wrong');
        expect(server.web.confirm(row, '222222')).toBe('wrong');
        expect(server.web.confirm(row, '333333')).toBe('denied');
        expect(server.web.confirm(row, DIGITS)).toBe('refused');
        await time.advance(2000, () => server.web.poll(row));
        expect(flow.view()).toMatchObject({ step: 'ended', line: CLAIM_DENIED });
    });

    it('ends at 2 minutes, by this device’s clock, and polls no more', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        await time.advance(CLAIM_MS - 1000, () => server.web.poll(row));
        expect(flow.view().step).toBe('digits');
        await time.advance(2000, () => server.web.poll(row));
        expect(flow.view()).toMatchObject({ step: 'ended', line: CLAIM_EXPIRED });
        const polls = server.redeems.length;
        expect(server.redeems.every((at) => at < row.claimExpiresAt)).toBe(true);
        await time.advance(10_000);
        expect(server.redeems).toHaveLength(polls);
    });

    it('the web page closing (no poll for 15 s) is a refusal it words', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        await time.advance(20_000);
        expect(flow.view()).toMatchObject({ step: 'ended', line: CLAIM_DENIED });
    });

    it('polls every 2 s, never faster than the server’s one a second', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        await time.advance(30_000, () => server.web.poll(row));
        expect(server.redeems).toHaveLength(15);
        const gaps = server.redeems.slice(1).map((at, i) => at - server.redeems[i]);
        expect(gaps.every((gap) => gap === POLL_MS)).toBe(true);
        expect(server.tooMany).toEqual([]);
        flow.leave();
    });

    it('no answer keeps polling and says it can’t reach; the network back, it goes on', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        server.offline.redeem = true;
        await time.advance(6000, () => server.web.poll(row));
        expect(flow.view()).toMatchObject({ step: 'digits', reaching: false, digits: DIGITS });
        server.offline.redeem = false;
        await time.advance(2000, () => server.web.poll(row));
        expect(flow.view()).toMatchObject({ step: 'digits', reaching: true });
        server.web.confirm(row, DIGITS);
        await time.advance(2000, () => server.web.poll(row));
        await vi.waitFor(() => expect(flow.view()).toEqual({ step: 'signed-in' }));
    });

    it('asks first when this device holds the workspace for someone else; Cancel changes nothing', async () => {
        const { server, flow, time, store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const row = server.web.mint('ben@example.test');
        await toDigits(flow, time, row.code);
        expect(flow.view()).toEqual({
            step: 'other-account',
            host: HOST,
            name: 'Acme',
            current: 'ada@example.test',
            next: 'ben@example.test',
            unsent: 0,
        });
        // No digits yet, and no poll: the person hasn't said yes.
        expect(JSON.stringify(flow.view())).not.toContain(DIGITS);
        await time.advance(10_000, () => server.web.poll(row));
        expect(server.redeems).toEqual([]);
        flow.leave();
        await time.advance(10_000);
        expect(server.redeems).toEqual([]);
        expect((await store.registry.byOrigin(ORIGIN)).map((entry) => entry.id)).toEqual([ada.id]);
    });

    it('“Sign in as” the other account shows the digits, then replaces that copy without asking again', async () => {
        const { server, flow, time, store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const row = server.web.mint('ben@example.test');
        await toDigits(flow, time, row.code);
        flow.switchAccount();
        await time.idle();
        expect(flow.view()).toMatchObject({
            step: 'digits',
            account: { name: 'Ben', email: 'ben@example.test' },
            digits: DIGITS,
        });
        server.web.confirm(row, DIGITS);
        await time.advance(2000, () => server.web.poll(row));
        await vi.waitFor(() => expect(flow.view()).toEqual({ step: 'signed-in' }));
        const rows = await store.registry.byOrigin(ORIGIN);
        expect(rows.map((entry) => entry.appUserId)).toEqual(['u-ben']);
        expect(rows[0].id).not.toBe(ada.id);
    });

    it('the same person signing in again isn’t asked', async () => {
        const { server, flow, time, store } = await setUp();
        await addWorkspace(store, ORIGIN, 'u-ada');
        const row = server.web.mint('ada@example.test');
        await toDigits(flow, time, row.code);
        expect(flow.view().step).toBe('digits');
        server.web.confirm(row, DIGITS);
        await time.advance(2000, () => server.web.poll(row));
        await vi.waitFor(() => expect(flow.view()).toEqual({ step: 'signed-in' }));
    });

    it('pauses in the background and goes on when the app comes back within the claim', async () => {
        const { server, flow, time, app } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        await time.advance(2000, () => server.web.poll(row));
        expect(server.redeems).toHaveLength(1);
        app.set(false);
        await time.advance(30_000, () => server.web.poll(row));
        expect(server.redeems).toHaveLength(1);
        server.web.confirm(row, DIGITS);
        app.set(true);
        await time.advance(0);
        await vi.waitFor(() => expect(flow.view()).toEqual({ step: 'signed-in' }));
        expect(server.redeems).toHaveLength(2);
    });

    it('back after the claim’s 2 minutes, it ends without polling', async () => {
        const { server, flow, time, app } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        app.set(false);
        await time.advance(CLAIM_MS + 1000, () => server.web.poll(row));
        expect(flow.view()).toMatchObject({ step: 'ended', line: CLAIM_EXPIRED });
        app.set(true);
        await time.advance(5000);
        expect(server.redeems).toEqual([]);
    });

    it('leaving the screen stops polling at once and drops the digits', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        await time.advance(2000, () => server.web.poll(row));
        flow.leave();
        expect(flow.view()).toEqual({ step: 'idle' });
        server.web.confirm(row, DIGITS);
        await time.advance(20_000, () => server.web.poll(row));
        expect(server.redeems).toHaveLength(1);
        expect(server.sessions.size).toBe(0);
    });

    it('a kill mid-claim leaves nothing; the same link after it is a used code', async () => {
        const { clock, server, flow, time } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        await time.advance(2000, () => server.web.poll(row));
        // The process dies: nothing of the claim was written.
        expect(everything()).not.toContain(DIGITS);
        expect(everything()).not.toContain(row.claimId);
        const { store } = await launch(device, { now: () => clock.now });
        const again = flowOn(store, server, clock);
        await toDigits(again.flow, again.time, row.code);
        expect(again.flow.view()).toMatchObject({ step: 'refused', line: CODE_USED });
    });

    it('a sign-out or the method turned off on the web during the redeem is worded', async () => {
        for (const [code, line] of [
            ['not_authorized', CLAIM_SIGNED_OUT],
            ['method_off', CLAIM_METHOD_OFF],
            ['BANNED_USER', DEACTIVATED_MESSAGE],
        ] as const) {
            const { server, flow, time, store } = await setUp();
            const row = server.web.mint();
            await toDigits(flow, time, row.code);
            server.refuse.next = code;
            server.web.confirm(row, DIGITS);
            await time.advance(2000, () => server.web.poll(row));
            expect(flow.view()).toMatchObject({ step: 'ended', line });
            expect(await store.registry.byOrigin(ORIGIN)).toEqual([]);
            rmSync(device.root, { recursive: true, force: true });
            device = phone(mkdtempSync(join(tmpdir(), 'socio-pair-')));
        }
    });

    it('the digits are in no log, problem or stored byte, whatever the end', async () => {
        const { server, flow, time } = await setUp();
        const row = server.web.mint();
        await toDigits(flow, time, row.code);
        server.web.confirm(row, '000001');
        server.web.deny(row);
        await time.advance(2000, () => server.web.poll(row));
        const kept = everything();
        expect(kept).not.toContain(DIGITS);
        expect(kept).not.toContain(row.code);
        expect(kept).not.toContain(row.claimId);
        expect(JSON.stringify(flow.view())).not.toContain(DIGITS);
    });

    describe('Cancel ends a live claim on the server', () => {
        it('Cancel on the digits calls it once with the claim id, and the web sees it refused', async () => {
            const { server, flow, time } = await setUp();
            const row = server.web.mint();
            await toDigits(flow, time, row.code);
            await time.advance(2000, () => server.web.poll(row));
            flow.leave();
            await time.idle();
            expect(server.cancels).toEqual([row.claimId]);
            expect(row.denied).toBe(true);
            expect(server.web.confirm(row, DIGITS)).toBe('refused');
            await time.advance(10_000);
            expect(server.redeems).toHaveLength(1);
            expect(everything()).not.toContain(row.claimId);
        });

        it('the other-account question’s Cancel calls it too (the claim was made to ask it)', async () => {
            const { server, flow, time, store } = await setUp();
            await addWorkspace(store, ORIGIN, 'u-ada');
            const row = server.web.mint('ben@example.test');
            await toDigits(flow, time, row.code);
            expect(flow.view().step).toBe('other-account');
            flow.leave();
            await time.idle();
            expect(server.cancels).toEqual([row.claimId]);
        });

        it('leaving before Continue has nothing to cancel', async () => {
            const { server, flow, time } = await setUp();
            const row = server.web.mint();
            flow.start(linkOf(row.code));
            await vi.waitFor(() => expect(flow.view().step).toBe('confirm'));
            flow.leave();
            await time.idle();
            expect(server.cancels).toEqual([]);
        });

        it('is never called after a commit, an end or the 2 minutes', async () => {
            const signedIn = await setUp();
            const first = signedIn.server.web.mint();
            await toDigits(signedIn.flow, signedIn.time, first.code);
            signedIn.server.web.confirm(first, DIGITS);
            await signedIn.time.advance(2000, () => signedIn.server.web.poll(first));
            await vi.waitFor(() => expect(signedIn.flow.view()).toEqual({ step: 'signed-in' }));
            signedIn.flow.leave();

            const denied = await setUp();
            const second = denied.server.web.mint();
            await toDigits(denied.flow, denied.time, second.code);
            denied.server.web.deny(second);
            await denied.time.advance(2000, () => denied.server.web.poll(second));
            expect(denied.flow.view().step).toBe('ended');
            denied.flow.leave();

            const expired = await setUp();
            const third = expired.server.web.mint();
            await toDigits(expired.flow, expired.time, third.code);
            expired.app.set(false);
            await expired.time.advance(CLAIM_MS + 1000, () => expired.server.web.poll(third));
            expired.flow.leave();

            await expired.time.idle();
            expect([...signedIn.server.cancels, ...denied.server.cancels, ...expired.server.cancels]).toEqual([]);
        });

        it('a failed cancel is silent, and leaves nothing behind', async () => {
            const { server, flow, time } = await setUp();
            const row = server.web.mint();
            await toDigits(flow, time, row.code);
            server.offline.cancel = true;
            flow.leave();
            await time.idle();
            expect(flow.view()).toEqual({ step: 'idle' });
            expect(server.cancels).toEqual([]);
            expect(everything()).not.toContain(row.claimId);
            // A cancel that never answers gives up after its timeout, without rejecting.
            // As expo/fetch does, it rejects once its signal aborts.
            const never = Object.assign(
                (_url: string, init: FetchRequestInit) =>
                    new Promise<Response>((_resolve, reject) =>
                        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
                    ),
                { calls: [] },
            );
            await expect(
                cancelPairing({
                    origin: ORIGIN,
                    claimId: 'c'.repeat(24),
                    fetch: never,
                    userAgent: USER_AGENT,
                    timeoutMs: 10,
                }),
            ).resolves.toBeUndefined();
        });

        it('a redeem in flight that answers `denied` after Cancel says nothing', async () => {
            const { server, flow, time } = await setUp();
            const row = server.web.mint();
            await toDigits(flow, time, row.code);
            const held = deferred();
            server.hold.next = held.promise;
            await time.advance(2000, () => server.web.poll(row));
            flow.leave();
            await time.idle();
            held.resolve();
            await time.advance(5000);
            expect(flow.view()).toEqual({ step: 'idle' });
            expect(server.cancels).toEqual([row.claimId]);
        });
    });
});
