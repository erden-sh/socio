import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';
import {
    appLink,
    codeRedeemBodySchema,
    codeRequestBodySchema,
    type WorkspaceManifest,
} from '@socio/shared/device-sign-in';

import { signInAndCommit, type SignInOutcome, type Store } from '../src/data';
import { CODE_PENDING_KEY, type CodeFlow, createCodeFlow } from '../src/data/code-flow';
import type { StagedLogo } from '../src/data/logo';
import {
    AUTH_SESSION_PATH,
    CODE_REDEEM_PATH,
    CODE_TRIES_USED,
    LOGOUT_PATH,
    redeemSignInCode,
    SESSION_PATH,
    type SignInProblem,
} from '../src/net';
import { deviceLabel } from '../src/net/sheet-sign-in';
import {
    CODE_EXPIRED,
    CODE_METHOD_OFF,
    CODE_REQUEST_PATH,
    CODE_UNREACHED,
    CODE_WRONG,
    CODE_WRONG_APP,
    codeButtonLabel,
    codeChannel,
    codeRefusal,
    codeRequestLine,
    codeSentLine,
    codeStepTitle,
    codeToSubmit,
    CODE_TRIES,
    codeWrongLine,
    readCodeField,
    readCodeLink,
    requestSignInCode,
    sendAgainLabel,
    sendAgainSeconds,
    SIGN_IN_CODE_MS,
} from '../src/net/sign-in-codes';

import { launch, phone, type Phone, sha256 } from './helpers/store';
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

// Sign-in codes by email or Telegram, under Node: the view models, the request, the
// pending request in secure storage, the code's link (filling in only the request that asked), and
// the redeem through `signInAndCommit` against a workspace that answers as the server's endpoints do
// (src/server/auth/device-sign-in.ts): 5 tries then `too_many`, and each refusal worded.
// The code, the verifier and the request id are in no log, problem or stored byte once done.

const USER_AGENT = 'Socio/0.1.0 (Android; Android 16)';
const LINK_HOST = 'link-staging.socio.sh';
const HOST = new URL(ORIGIN).host;
const LINKS = { variant: 'development' as const, linkHost: LINK_HOST };
const sha256Base64 = async (text: string) => createHash('sha256').update(text).digest('base64');
const nodeBytes = (length: number) => new Uint8Array(randomBytes(length));
const MASCOT: StagedLogo = { kind: 'mascot' };
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

const codeLink = (code: string, host = HOST, variant: 'development' | 'preview' = 'development') =>
    appLink({ kind: 'c', variant, host, fields: { code } }, LINK_HOST);

interface Account {
    readonly email: string;
    readonly appUserId: string;
    readonly name: string;
    banned: boolean;
}

interface CodeRow {
    challenge: string;
    variant: string;
    code: string;
    account: Account | undefined;
    tries: number;
    expiresAt: number;
    used: boolean;
}

/**
 * A workspace that answers as the server does: `device/code` always answers a request id and "sends" a
 * code only to an account it knows (`sent`); `code/redeem` counts a try first (5 per request, then
 * 429 `too_many`), compares the code, uses it up, then checks the verifier (S256), the variant,
 * the channel and the person. `refuse.next` makes the next good redeem answer one of the server's later refusals.
 */
function workspace(clock: { now: number }) {
    const accounts: Account[] = [
        { email: 'ada@example.test', appUserId: 'u-ada', name: 'Ada', banned: false },
        { email: 'cy@example.test', appUserId: 'u-cy', name: 'Cy', banned: true },
    ];
    const rows = new Map<string, CodeRow>();
    const sent = new Map<string, string>();
    const sessions = new Map<string, Account>();
    const challenges: string[] = [];
    const refuse: { next: 'not_authorized' | 'method_off' | null; requests: number | null } = {
        next: null,
        requests: null,
    };
    let issued = 0;
    const json = (status: number, body: unknown, setCookie: string[] = []) =>
        answer(status, { date: httpDate(clock.now), headers: { 'content-type': 'application/json' }, setCookie, body });
    const fetch = fakeFetch((url: string, init: FetchRequestInit) => {
        const path = new URL(url).pathname;
        const cookie = cookieValue(sentHeaders({ url, init }).cookie, SESSION);
        const signedIn = cookie === undefined ? undefined : sessions.get(cookie);
        if (path === CODE_REQUEST_PATH) {
            if (refuse.requests !== null) {
                return answer(429, { headers: { 'x-retry-after': String(refuse.requests) } });
            }
            const parsed = codeRequestBodySchema.safeParse(JSON.parse(String(init.body)));
            if (!parsed.success) {
                return json(400, { message: 'Enter a valid email address.', code: 'code_invalid' });
            }
            challenges.push(parsed.data.challenge);
            const id = randomBytes(18).toString('base64url');
            const account = accounts.find((entry) => entry.email === parsed.data.email);
            const code = newCode();
            rows.set(id, {
                challenge: parsed.data.challenge,
                variant: parsed.data.variant,
                code,
                account,
                tries: 0,
                expiresAt: clock.now + SIGN_IN_CODE_MS,
                used: false,
            });
            if (account !== undefined) {
                sent.set(account.email, code);
            }
            return json(200, { requestId: id });
        }
        if (path === CODE_REDEEM_PATH) {
            const parsed = codeRedeemBodySchema.safeParse(JSON.parse(String(init.body)));
            if (!parsed.success) {
                return json(400, { code: 'code_invalid' });
            }
            const row = rows.get(parsed.data.requestId);
            if (row === undefined || row.used || row.tries >= 5 || row.expiresAt <= clock.now) {
                if (row !== undefined && row.expiresAt <= clock.now) {
                    return json(400, { code: 'code_expired' });
                }
                return row !== undefined && row.tries >= 5
                    ? json(429, { code: 'too_many' })
                    : json(400, { code: 'code_invalid' });
            }
            row.tries += 1;
            if (parsed.data.code !== row.code || row.account === undefined) {
                return json(400, { code: 'code_invalid' });
            }
            row.used = true;
            if (createHash('sha256').update(parsed.data.verifier).digest('base64url') !== row.challenge) {
                return json(400, { code: 'code_invalid' });
            }
            if (parsed.data.variant !== row.variant) {
                return json(400, { code: 'wrong_variant' });
            }
            if (refuse.next !== null) {
                const code = refuse.next;
                refuse.next = null;
                return json(403, { code });
            }
            if (row.account.banned) {
                return json(403, { code: 'BANNED_USER' });
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
    });
    return { fetch, rows, sent, sessions, challenges, refuse, accounts };
}

let device: Phone;
let logs: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-code-')));
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

/** The flow as src/platform/code-sign-in.ts binds it, on this store and server. */
function flowOn(store: Store, server: ReturnType<typeof workspace>, clock: { now: number }): CodeFlow {
    return createCodeFlow({
        keys: store.keys,
        randomBytes: nodeBytes,
        sha256: sha256Base64,
        platform: 'android',
        variant: 'development',
        links: LINKS,
        now: () => clock.now,
        request: (input) => requestSignInCode({ ...input, fetch: server.fetch, userAgent: USER_AGENT }),
        redeem: (job, installId) =>
            redeemSignInCode({
                ...job,
                installId,
                label: deviceLabel('android'),
                fetch: server.fetch,
                userAgent: USER_AGENT,
                now: () => clock.now,
            }),
        signIn: ({ origin, email, stage }) =>
            signInAndCommit(
                { origin, email, logo: null, stage },
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
}

async function setUp() {
    const clock = { now: T0 };
    const server = workspace(clock);
    const { store } = await launch(device, { now: () => clock.now });
    const flow = flowOn(store, server, clock);
    return { clock, server, store, flow };
}

const send = (flow: CodeFlow, email = 'ada@example.test') =>
    flow.send({ origin: ORIGIN, name: 'Acme', email, channel: 'email' });
const redeem = (flow: CodeFlow, typed: string) => flow.redeem({ origin: ORIGIN, typed, logo: MASCOT });
const problemOf = (result: Awaited<ReturnType<typeof redeem>>): SignInProblem | null =>
    result.kind === 'outcome' && result.outcome.kind === 'problem' ? result.outcome.problem : null;
const kindOf = (outcome: SignInOutcome) => outcome.kind;

const manifest = (signInCodes: 'email' | 'telegram' | null) =>
    ({
        methods: { password: true, passkey: true, sheet: true, signInCodes, addDevice: false },
    }) as WorkspaceManifest;

describe('the view models', () => {
    it('offers the manifest’s one channel: email only while it says so, else Telegram, else none', () => {
        expect(codeChannel(manifest('email'))).toBe('email');
        expect(codeChannel(manifest('telegram'))).toBe('telegram');
        expect(codeChannel(manifest(null))).toBeNull();
        expect(codeChannel(null)).toBeNull();
        expect(codeButtonLabel('email')).toBe('Email me a code');
        expect(codeButtonLabel('telegram')).toBe('Send a code to my Telegram');
        expect(codeStepTitle('email')).toBe('Enter the code we sent to your email');
        expect(codeStepTitle('telegram')).toBe('Enter the code we sent to your Telegram');
    });

    it('never says whether the email has an account', () => {
        for (const channel of ['email', 'telegram'] as const) {
            expect(codeSentLine(channel, 'person@example.test')).toMatch(
                /^If person@example\.test has an account here/,
            );
        }
    });

    it('takes the code with or without its dash, spaces or case, pasted or typed', () => {
        for (const typed of ['ABCD-EFGH', 'ABCDEFGH', 'abcd-efgh', ' abcd efgh ', 'AbCd-EfGh']) {
            expect(readCodeField(typed)).toEqual({ code: 'ABCDEFGH', hint: null });
        }
        expect(readCodeField('ABCD-EFG')).toEqual({ code: null, hint: null });
        expect(readCodeField('')).toEqual({ code: null, hint: null });
        // Symbols codes never use say so; too long says the length.
        expect(readCodeField('ABCD-EFG0').hint).toMatch(/never use 0, 1, I, L, O or U/);
        expect(readCodeField('ABCD-EFGO').hint).toMatch(/never use/);
        expect(readCodeField('ABCD-EFGHJ').hint).toBe('A code has 8 letters and digits.');
    });

    it('submits on the last symbol or a paste, once per code, with no button (owner, 2026-11-26)', () => {
        // Typed to its last symbol, with or without the dash, any case.
        expect(codeToSubmit('ABCD-EFG', 'ABCD-EFGH')).toBe('ABCDEFGH');
        expect(codeToSubmit('abcdefg', 'abcdefgh')).toBe('ABCDEFGH');
        // Pasted whole into an empty field, spaces and dashes stripped.
        expect(codeToSubmit('', ' abcd - efgh ')).toBe('ABCDEFGH');
        // Not whole yet, or not a code: nothing goes.
        expect(codeToSubmit('', 'ABCD-EFG')).toBeNull();
        expect(codeToSubmit('ABCD-EFG', 'ABCD-EFG0')).toBeNull();
        expect(codeToSubmit('ABCD-EFGH', 'ABCD-EFGHJ')).toBeNull();
        // The same code again (a dash added, a symbol's case changed) isn't sent twice in a row.
        expect(codeToSubmit('ABCDEFGH', 'ABCD-EFGH')).toBeNull();
        expect(codeToSubmit('ABCD-EFGH', 'abcd-efgh')).toBeNull();
        // Another whole code (one symbol fixed) goes.
        expect(codeToSubmit('ABCD-EFGH', 'ABCD-EFGJ')).toBe('ABCDEFGJ');
    });

    it('says the tries left after a wrong code', () => {
        expect(CODE_TRIES).toBe(5);
        expect(codeWrongLine(1)).toBe('That code isn’t right. 4 tries left.');
        expect(codeWrongLine(4)).toBe('That code isn’t right. 1 try left.');
        expect(codeWrongLine(5)).toMatch(/last try\. Ask for a new code/);
        expect(codeWrongLine(9)).toMatch(/last try/);
    });

    it('keeps the server’s count of tries', () => {
        const server = readFileSync(join(import.meta.dirname, '../../../src/server/auth/device-sign-in.ts'), 'utf8');
        expect(server).toMatch(new RegExp(`export const CODE_TRIES = ${CODE_TRIES};`));
    });

    it('Send again waits 60 s after each send, counting down whole seconds', () => {
        expect(sendAgainSeconds(T0, T0)).toBe(60);
        expect(sendAgainSeconds(T0, T0 + 1)).toBe(60);
        expect(sendAgainSeconds(T0, T0 + 59_001)).toBe(1);
        expect(sendAgainSeconds(T0, T0 + 60_000)).toBe(0);
        expect(sendAgainSeconds(T0, T0 + 3_600_000)).toBe(0);
        // A clock that went back waits the whole minute.
        expect(sendAgainSeconds(T0, T0 - 5_000)).toBe(60);
        expect(sendAgainLabel(42)).toBe('Send again in 42 s');
        expect(sendAgainLabel(0)).toBe('Send again');
    });

    it('words each refusal, and starts over for every dead request', () => {
        const problem = (kind: SignInProblem['kind'], code: string | null = null): SignInProblem =>
            kind === 'rate-limited'
                ? { kind, status: 429, code, retryAfterSeconds: 30 }
                : ({ kind, status: 400, code } as SignInProblem);
        expect(codeRefusal(problem('code-invalid'))).toEqual({ line: CODE_WRONG, startOver: false });
        expect(codeRefusal(problem('code-expired'))).toEqual({ line: CODE_EXPIRED, startOver: true });
        expect(codeRefusal(problem('too-many-tries'))).toEqual({ line: CODE_TRIES_USED, startOver: true });
        expect(codeRefusal(problem('wrong-variant'))).toEqual({ line: CODE_WRONG_APP, startOver: true });
        expect(codeRefusal(problem('not-authorized'))).toEqual({ line: CODE_UNREACHED, startOver: true });
        expect(codeRefusal(problem('sheet-off'))).toEqual({ line: CODE_METHOD_OFF, startOver: true });
        expect(codeRefusal(problem('deactivated'))).toEqual({ line: DEACTIVATED_MESSAGE, startOver: true });
        // Waiting, no answer or a failing server keep the request.
        expect(codeRefusal(problem('rate-limited'))).toEqual({
            line: 'Too many tries. Wait 30 seconds, then try again.',
            startOver: false,
        });
        expect(codeRefusal(problem('unreachable')).startOver).toBe(false);
        expect(codeRefusal(problem('server-error')).startOver).toBe(false);
        expect(codeRequestLine({ kind: 'rate-limited', status: 429, retryAfterSeconds: null })).toBe(
            'Too many codes asked for. Wait a few minutes, then try again.',
        );
        expect(codeRequestLine({ kind: 'rate-limited', status: 429, retryAfterSeconds: 120 })).toBe(
            'Too many codes asked for. Wait 2 minutes, then try again.',
        );
    });
});

describe('the code’s link', () => {
    it('reads only this build’s `c` link, with a code of the right shape', () => {
        expect(readCodeLink(codeLink('ABCDEFGH'), LINKS)).toEqual({ code: 'ABCDEFGH', host: HOST });
        expect(readCodeLink(codeLink('abcd-efgh'), LINKS)).toEqual({ code: 'ABCDEFGH', host: HOST });
        expect(readCodeLink(codeLink('ABCDEFGH', HOST, 'preview'), LINKS)).toBeNull();
        expect(readCodeLink(codeLink('ABCD'), LINKS)).toBeNull();
        expect(readCodeLink(codeLink('ABCDEFGH').replace(LINK_HOST, 'evil.example.test'), LINKS)).toBeNull();
        expect(
            readCodeLink(
                appLink(
                    {
                        kind: 'cb',
                        variant: 'development',
                        host: HOST,
                        fields: { code: 'ABCDEFGHJKMN', state: 'x'.repeat(43) },
                    },
                    LINK_HOST,
                ),
                LINKS,
            ),
        ).toBeNull();
    });

    it('with no pending request it only shows the code, and stores nothing', async () => {
        const { flow, server } = await setUp();
        expect(await flow.readLink(codeLink('ABCDEFGH'))).toEqual({ kind: 'show', code: 'ABCDEFGH' });
        expect(device.keychain.has(CODE_PENDING_KEY)).toBe(false);
        expect(server.fetch.calls).toHaveLength(0);
        expect(await flow.readLink('https://example.test/')).toEqual({ kind: 'not-code-link' });
    });

    it('fills the code in only on the device that asked, for that workspace', async () => {
        const { flow, server, clock } = await setUp();
        expect((await send(flow)).kind).toBe('sent');
        const code = server.sent.get('ada@example.test')!;
        expect(await flow.readLink(codeLink(code))).toEqual({ kind: 'fill', code });
        // Another workspace's code only shows.
        expect(await flow.readLink(codeLink(code, 'other.example.test'))).toEqual({ kind: 'show', code });
        // Past its 15 minutes the request is gone: the link only shows, and the entry is deleted.
        clock.now += SIGN_IN_CODE_MS;
        expect(await flow.readLink(codeLink(code))).toEqual({ kind: 'show', code });
        expect(device.keychain.has(CODE_PENDING_KEY)).toBe(false);
    });
});

describe('asking for a code', () => {
    it('sends the email, a fresh challenge per request, the platform and the variant; no cookie', async () => {
        const { flow, server } = await setUp();
        await send(flow, ' ada@example.test ');
        await send(flow);
        expect(server.fetch.calls).toHaveLength(2);
        const [first, second] = server.fetch.calls.map((call) => JSON.parse(String(call.init.body)));
        expect(Object.keys(first).sort()).toEqual(['challenge', 'email', 'platform', 'variant']);
        expect(first).toMatchObject({ email: 'ada@example.test', platform: 'android', variant: 'development' });
        expect(first.challenge).not.toBe(second.challenge);
        const headers = sentHeaders(server.fetch.calls[0]);
        expect(headers.cookie).toBeUndefined();
        expect(headers.origin).toBe(ORIGIN);
    });

    it('answers the same for an email with no account, and keeps only the pending entry', async () => {
        const { flow } = await setUp();
        const known = await send(flow);
        const unknown = await send(flow, 'nobody@example.test');
        expect(known.kind).toBe('sent');
        expect(unknown.kind).toBe('sent');
        const stored = JSON.parse(device.keychain.get(CODE_PENDING_KEY)!);
        expect(Object.keys(stored).sort()).toEqual(
            ['channel', 'email', 'name', 'origin', 'requestId', 'sentAt', 'v', 'variant', 'verifier'].sort(),
        );
        expect(await flow.pending()).toEqual({
            origin: ORIGIN,
            name: 'Acme',
            email: 'nobody@example.test',
            channel: 'email',
            sentAt: T0,
        });
    });

    it('a refused Send again keeps the code already sent', async () => {
        const { flow, server } = await setUp();
        await send(flow);
        const before = device.keychain.get(CODE_PENDING_KEY);
        server.refuse.requests = 90;
        expect(await send(flow)).toEqual({
            kind: 'problem',
            problem: { kind: 'rate-limited', status: 429, retryAfterSeconds: 90 },
        });
        expect(device.keychain.get(CODE_PENDING_KEY)).toBe(before);
    });

    it('an address the server refuses is an invalid email; no answer is unreachable', async () => {
        const { flow } = await setUp();
        expect(await send(flow, 'not an email')).toEqual({
            kind: 'problem',
            problem: { kind: 'invalid-email', status: 400 },
        });
        const down = fakeFetch(() => Promise.reject(new TypeError('Network request failed')));
        const answerless = await requestSignInCode({
            origin: ORIGIN,
            email: 'ada@example.test',
            challenge: 'c'.repeat(43),
            platform: 'ios',
            variant: 'development',
            fetch: down,
            userAgent: USER_AGENT,
        });
        expect(answerless.ok).toBe(false);
    });
});

describe('redeeming', () => {
    it('signs in with the code typed any way, commits, and deletes the pending entry', async () => {
        const { flow, server } = await setUp();
        await send(flow);
        const code = server.sent.get('ada@example.test')!;
        const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
        const result = await redeem(flow, typed);
        expect(result.kind === 'outcome' && kindOf(result.outcome)).toBe('committed');
        expect(device.keychain.has(CODE_PENDING_KEY)).toBe(false);
        const body = JSON.parse(
            String(server.fetch.calls.find((call) => call.url.endsWith(CODE_REDEEM_PATH))!.init.body),
        );
        expect(Object.keys(body).sort()).toEqual(['code', 'installId', 'label', 'requestId', 'variant', 'verifier']);
        expect(body.code).toBe(code);
        expect(body.label).toBe('Socio app on Android');
        // The install id went in the body and the header both.
        const call = server.fetch.calls.find((entry) => entry.url.endsWith(CODE_REDEEM_PATH))!;
        expect(sentHeaders(call)['x-socio-install']).toBe(body.installId);
        // Nothing of the request is left on the phone or in a log.
        const all = everything();
        for (const secret of [code, body.verifier, body.requestId]) {
            expect(all).not.toContain(secret);
        }
    });

    it('5 wrong tries, then `too_many`: the request is dead and starts over', async () => {
        const { flow, server } = await setUp();
        await send(flow);
        const right = server.sent.get('ada@example.test')!;
        const wrong = right === '22222222' ? '33333333' : '22222222';
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            const result = await redeem(flow, wrong);
            expect(problemOf(result)?.kind).toBe('code-invalid');
            expect(result.kind === 'outcome' && result.startOver).toBe(false);
            expect(device.keychain.has(CODE_PENDING_KEY)).toBe(true);
        }
        const sixth = await redeem(flow, right);
        expect(problemOf(sixth)).toEqual({ kind: 'too-many-tries', status: 429, code: 'too_many' });
        expect(sixth.kind === 'outcome' && sixth.startOver).toBe(true);
        expect(device.keychain.has(CODE_PENDING_KEY)).toBe(false);
        expect(await redeem(flow, right)).toEqual({ kind: 'no-request' });
    });

    it('a 429 from the rate limiter (no `too_many`) only asks to wait', async () => {
        const flowFetch = fakeFetch(() => answer(429, { headers: { 'x-retry-after': '12' } }));
        const result = await redeemSignInCode({
            origin: ORIGIN,
            requestId: 'r'.repeat(24),
            code: 'ABCDEFGH',
            verifier: 'v'.repeat(43),
            installId: 'i'.repeat(43),
            label: 'Socio app on Android',
            variant: 'development',
            email: 'ada@example.test',
            fetch: flowFetch,
            userAgent: USER_AGENT,
        });
        expect(result.ok === false && result.problem).toEqual({
            kind: 'rate-limited',
            status: 429,
            code: null,
            retryAfterSeconds: 12,
        });
    });

    it('each later refusal is worded and starts over', async () => {
        const cases: Array<{
            arrange: (context: Awaited<ReturnType<typeof setUp>>) => void;
            email?: string;
            kind: SignInProblem['kind'];
            line: string;
        }> = [
            { arrange: ({ clock }) => (clock.now += SIGN_IN_CODE_MS - 1), kind: 'code-expired', line: CODE_EXPIRED },
            {
                arrange: ({ server }) => (server.refuse.next = 'not_authorized'),
                kind: 'not-authorized',
                line: CODE_UNREACHED,
            },
            { arrange: ({ server }) => (server.refuse.next = 'method_off'), kind: 'sheet-off', line: CODE_METHOD_OFF },
            { arrange: () => undefined, email: 'cy@example.test', kind: 'deactivated', line: DEACTIVATED_MESSAGE },
        ];
        for (const entry of cases) {
            const context = await setUp();
            const email = entry.email ?? 'ada@example.test';
            await send(context.flow, email);
            const code = context.server.sent.get(email)!;
            entry.arrange(context);
            if (entry.kind === 'code-expired') {
                // The server's 15 minutes passed first; the app's entry still lives for a moment.
                for (const row of context.server.rows.values()) {
                    row.expiresAt = context.clock.now;
                }
            }
            const result = await redeem(context.flow, code);
            const problem = problemOf(result);
            expect(problem?.kind).toBe(entry.kind);
            expect(codeRefusal(problem!).line).toBe(entry.line);
            expect(result.kind === 'outcome' && result.startOver).toBe(true);
            expect(device.keychain.has(CODE_PENDING_KEY)).toBe(false);
            rmSync(device.root, { recursive: true, force: true });
            device = phone(mkdtempSync(join(tmpdir(), 'socio-code-')));
        }
    });

    it('a code asked for by another build is `wrong_variant`, worded, and starts over', async () => {
        const { flow, server } = await setUp();
        await send(flow);
        const code = server.sent.get('ada@example.test')!;
        for (const row of server.rows.values()) {
            row.variant = 'preview';
        }
        const result = await redeem(flow, code);
        expect(problemOf(result)?.kind).toBe('wrong-variant');
        expect(codeRefusal(problemOf(result)!).line).toBe(CODE_WRONG_APP);
        expect(result.kind === 'outcome' && result.startOver).toBe(true);
    });

    it('a request on the phone for another workspace, or none, is no request', async () => {
        const { flow } = await setUp();
        expect(await redeem(flow, 'ABCDEFGH')).toEqual({ kind: 'no-request' });
        await send(flow);
        expect(await flow.redeem({ origin: 'https://other.example.test', typed: 'ABCDEFGH', logo: MASCOT })).toEqual({
            kind: 'no-request',
        });
        expect(await redeem(flow, 'ABC')).toEqual({ kind: 'not-a-code' });
    });

    it('the pending entry outlives a kill, and expires after 15 minutes (swept)', async () => {
        const { flow, server, clock } = await setUp();
        await send(flow);
        const code = server.sent.get('ada@example.test')!;
        // A relaunch: a new flow on a new store over the same keychain.
        const { store } = await launch(device, { now: () => clock.now });
        const again = flowOn(store, server, clock);
        expect(await again.readLink(codeLink(code))).toEqual({ kind: 'fill', code });
        clock.now += SIGN_IN_CODE_MS;
        await again.sweep();
        expect(device.keychain.has(CODE_PENDING_KEY)).toBe(false);
    });
});
