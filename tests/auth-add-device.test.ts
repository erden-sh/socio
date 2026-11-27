import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';
import { INSTALL_HEADER, LINK_STAGING_HOST, PAIR_CLAIM_MS, parseAppLink } from '@socio/shared/device-sign-in';

import { BetterAuthProvider } from '../src/server/auth/better-auth.js';
import type { DeviceSignInEvent } from '../src/server/auth/contract.js';
import { CLAIM_MS, CLAIM_POLL_MS } from '../src/server/auth/device-sign-in.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import { schemas } from '../src/server/modules/index.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-352: Add a device, the QR code and the 6-digit confirmation.
// CB-352: the app's devices, install ids and 30-day device sessions.

const SECRET = 'test-session-secret-0123456789';
const ORIGIN = 'http://localhost:4310';
const PASSWORD = 'correct-horse-battery';
const APP_UA = 'Socio/0.6.1 (iPhone; iOS 26)';

class Jar {
    private cookies = new Map<string, string>();
    store(response: Response) {
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(';');
            const index = pair.indexOf('=');
            const name = pair.slice(0, index).trim();
            const value = pair.slice(index + 1);
            if (!value || /max-age=0/i.test(header)) {
                this.cookies.delete(name);
            } else {
                this.cookies.set(name, value);
            }
        }
        return response;
    }
    get header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

const fastHasher = {
    hash: async (password: string) => `test:${password}`,
    verify: async ({ hash, password }: { hash: string; password: string }) => hash === `test:${password}`,
};

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
    vi.restoreAllMocks();
});

async function brain(env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-devices-'));
    const path = join(dir, 'brain.sqlite');
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const auth = authFromEnv(
        {
            AUTH_PROVIDER: 'betterauth',
            APP_ORIGIN: ORIGIN,
            SESSION_SECRET: SECRET,
            AUTH_TRUST_PROXY: 'true',
            AUTH_APP_PREVIEW_LINKS: 'true',
            ...env,
        },
        '127.0.0.1',
        { database: path, hasher: fastHasher },
    );
    const provider = auth.provider as BetterAuthProvider;
    const clientIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const { app, dispose } = await makeTestRuntime({
        database: path,
        config: { baseUrl: 'https://model.invalid' },
        app: { config: { mode: 'live' as const, baseUrl: 'https://model.invalid' }, origin: [ORIGIN], auth },
    });
    const db = new DatabaseSync(path);
    cleanups.push(async () => {
        db.close();
        provider.close();
        await dispose();
        rmSync(dir, { recursive: true, force: true });
    });
    const call = async (jar: Jar, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
        jar.store(
            await app.request(path, {
                method: init.body === undefined ? 'GET' : 'POST',
                headers: {
                    origin: ORIGIN,
                    'x-forwarded-for': clientIp,
                    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
                    ...(jar.header ? { cookie: jar.header } : {}),
                    ...init.headers,
                },
                body: init.body === undefined ? undefined : JSON.stringify(init.body),
            }),
        );
    /** A password sign-in, from the app when `installId` is given. */
    const signIn = async (email: string, installId?: string, jar = new Jar()) => {
        const response = await call(jar, '/api/auth/sign-in/email', {
            body: { email, password: PASSWORD },
            headers: installId ? { [INSTALL_HEADER]: installId, 'user-agent': APP_UA } : {},
        });
        expect(response.status).toBe(200);
        return { jar, response };
    };
    const account = async (email: string, name: string) => {
        await provider.createAccount({ email, name, role: 'member', password: PASSWORD });
        return db.prepare('SELECT id FROM auth_user WHERE email = ?').get(email) as { id: string };
    };
    const sessions = (accountId: string) =>
        db
            .prepare('SELECT token, deviceId, expiresAt FROM auth_session WHERE userId = ? ORDER BY createdAt')
            .all(accountId) as { token: string; deviceId: string | null; expiresAt: string | number }[];
    const devices = (accountId: string) =>
        db.prepare('SELECT * FROM auth_device WHERE userId = ? ORDER BY createdAt').all(accountId) as Record<
            string,
            unknown
        >[];
    /** The app's request, through the provider's resolve. */
    const resolve = async (jar: Jar, installId?: string) => {
        const request = new Request(`${ORIGIN}/api/rooms`, {
            headers: {
                ...(jar.header ? { cookie: jar.header } : {}),
                ...(installId ? { [INSTALL_HEADER]: installId } : {}),
            },
        });
        const cookies: string[] = [];
        const user = await provider.resolve(request, (name, value) => {
            if (name === 'Set-Cookie') {
                cookies.push(value);
            }
        });
        for (const cookie of cookies) {
            jar.store(new Response(null, { headers: [['set-cookie', cookie]] }));
        }
        return { user, cookies, refusal: provider.deviceRefusal(request) };
    };
    /** Moves a session's expiry, as time passing would. */
    const expireIn = async (token: string, seconds: number) => {
        const context = await (await provider.auth()).$context;
        await context.internalAdapter.updateSession(token, { expiresAt: new Date(Date.now() + seconds * 1000) });
    };
    /** Saves the access policy as an operator would (the store's row). */
    const savePolicy = (policy: Record<string, unknown>) => {
        db.prepare(
            `INSERT INTO access_policy(id, version, policy, updatedAt, updatedBy) VALUES (1, 1, ?, ?, 'test')
             ON CONFLICT(id) DO UPDATE SET policy = excluded.policy, version = version + 1`,
        ).run(JSON.stringify(policy), Date.now());
    };
    return { app, provider, db, call, signIn, account, sessions, devices, resolve, expireIn, savePolicy };
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');
function pkce() {
    const verifier = b64(randomBytes(32));
    return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
}
type Brain = Awaited<ReturnType<typeof brain>>;

/** The web makes a QR code; its link's pairing code. */
async function qr(b: Brain, web: Jar) {
    const answer = await b.call(web, '/api/auth/device/pair', { body: {} });
    expect(answer.status).toBe(200);
    const { link, variant, pairingId } = (await answer.json()) as { link: string; variant: string; pairingId: string };
    const parsed = parseAppLink(link);
    expect(parsed).toMatchObject({ kind: 'd', variant, host: new URL(ORIGIN).host });
    expect(new URL(link).search).toBe('');
    return { link, variant, pairingId, code: (parsed!.fields as { c: string }).c };
}

/** A device claims the code: its digits and claim id. */
async function claim(b: Brain, code: string, flow = pkce(), variant = 'preview') {
    const answer = await b.call(new Jar(), '/api/auth/device/pair/claim', {
        body: { code, challenge: flow.challenge, label: 'Pixel 9', platform: 'android', variant },
    });
    return { answer, flow, body: (await answer.clone().json()) as { claimId: string; digits: string; code?: string } };
}

const otherDigits = (digits: string) => String((Number(digits) + 1) % 1_000_000).padStart(6, '0');
const status = (b: Brain, web: Jar, pairingId: string) => b.call(web, `/api/auth/device/pair/${pairingId}`);
const confirm = (b: Brain, web: Jar, pairingId: string, digits: string) =>
    b.call(web, `/api/auth/device/pair/${pairingId}/confirm`, { body: { digits } });
const pairRedeem = (b: Brain, claimId: string, verifier: string, jar = new Jar(), installId = b64(randomBytes(32))) =>
    b.call(jar, '/api/auth/device/pair/redeem', { body: { claimId, verifier, installId } });

/** Holds the next session creation until `resume()`; `inside` resolves once it started. */
async function holdCreateSession(b: Brain) {
    const adapter = (await (await b.provider.auth()).$context).internalAdapter;
    const make = adapter.createSession.bind(adapter);
    let reached!: () => void;
    const inside = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const held = new Promise<void>((resolve) => (resume = resolve));
    const spy = vi.spyOn(adapter, 'createSession').mockImplementation(async (...args) => {
        reached();
        await held;
        return make(...args);
    });
    return { inside, resume, restore: () => spy.mockRestore() };
}

const deviceSessions = (b: Brain) =>
    b.db.prepare('SELECT count(*) AS n FROM auth_session WHERE deviceId IS NOT NULL').get() as { n: number };

describe('Add a device', () => {
    it('gives the web the claim’s real lifetime for its countdown (CB-567)', () => {
        expect(PAIR_CLAIM_MS).toBe(CLAIM_MS);
    });

    it('signs the new device in once the web types the digits it shows, as that web session’s person and method', async () => {
        const b = await brain();
        const ada = await b.account('ada@example.com', 'Ada');
        const events: DeviceSignInEvent[] = [];
        b.provider.onDeviceSignIn((event) => {
            events.push(event);
        });
        const { jar: web } = await b.signIn('ada@example.com');
        const { code, pairingId } = await qr(b, web);
        // The web knows only its pairing id: before a claim, nothing to show.
        expect(await (await status(b, web, pairingId)).json()).toEqual({
            state: 'unclaimed',
            platform: null,
            label: null,
            claimedAt: null,
        });
        const { answer, flow, body } = await claim(b, code);
        expect(answer.status).toBe(200);
        expect(body).toMatchObject({
            digits: expect.stringMatching(/^\d{6}$/),
            account: { name: 'Ada', email: 'ada@example.com' },
            workspace: { host: new URL(ORIGIN).host },
        });
        // The page sees the device's type and time, never the digits.
        const seen = await status(b, web, pairingId);
        const page = await seen.text();
        expect(JSON.parse(page)).toMatchObject({ state: 'waiting', platform: 'android', label: 'Pixel 9' });
        expect(page).not.toContain(body.digits);
        const early = await pairRedeem(b, body.claimId, flow.verifier);
        expect(await early.json()).toMatchObject({ code: 'not_allowed_yet' });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const ok = await confirm(b, web, pairingId, `${body.digits.slice(0, 3)} ${body.digits.slice(3)}`);
        expect(await ok.json()).toEqual({ state: 'allowed', triesLeft: 3 });
        const installId = b64(randomBytes(32));
        const jar = new Jar();
        const signed = await pairRedeem(b, body.claimId, flow.verifier, jar, installId);
        expect(signed.status).toBe(200);
        const { deviceId } = (await signed.json()) as { deviceId: string };
        expect(b.db.prepare('SELECT signInMethod FROM auth_session WHERE deviceId = ?').get(deviceId)).toEqual({
            signInMethod: 'password',
        });
        expect((await b.resolve(jar, installId)).user?.name).toBe('Ada');
        expect(b.devices(ada.id)).toMatchObject([
            { id: deviceId, label: 'Pixel 9', platform: 'android', variant: 'preview' },
        ]);
        expect(await (await status(b, web, pairingId)).json()).toMatchObject({ state: 'signed_in' });
        await vi.waitFor(() => expect(events).toEqual([expect.objectContaining({ deviceId, label: 'Pixel 9' })]));
        // Never twice.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect((await pairRedeem(b, body.claimId, flow.verifier)).status).not.toBe(200);
    });

    it('lets nobody but the claiming device be allowed when another device claims the code first', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const { code, pairingId } = await qr(b, web);
        // Someone who saw the QR code on a shared screen claims it first.
        const thief = await claim(b, code);
        expect(thief.answer.status).toBe(200);
        // The person's own device gets "already used", and no digits.
        const mine = await claim(b, code);
        expect(mine.answer.status).toBe(400);
        expect(mine.body).toMatchObject({ code: 'code_invalid' });
        expect(JSON.stringify(mine.body)).not.toMatch(/digits/);
        // Whatever the person types, it isn't the thief's digits: three tries end it.
        for (const left of [2, 1, 0]) {
            const wrong = await confirm(b, web, pairingId, otherDigits(thief.body.digits));
            expect(await wrong.json()).toEqual({ state: left ? 'waiting' : 'denied', triesLeft: left });
        }
        const late = await confirm(b, web, pairingId, thief.body.digits);
        expect(await late.json()).toMatchObject({ code: 'denied' });
        const redeemed = await pairRedeem(b, thief.body.claimId, thief.flow.verifier);
        expect(await redeemed.json()).toMatchObject({ code: 'denied' });
    });

    it('refuses a confirm or a look from another session of the same person', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const { jar: other } = await b.signIn('ada@example.com');
        const { code, pairingId } = await qr(b, web);
        const { body } = await claim(b, code);
        expect((await confirm(b, other, pairingId, body.digits)).status).toBe(403);
        expect((await status(b, other, pairingId)).status).toBe(403);
        expect((await b.call(other, `/api/auth/device/pair/${pairingId}/deny`, { body: {} })).status).toBe(403);
    });

    it('voids the last QR code when the web makes a new one, and ends a claim on “Not my device”', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const first = await qr(b, web);
        const second = await qr(b, web);
        expect((await claim(b, first.code)).answer.status).toBe(400);
        const { body, flow } = await claim(b, second.code);
        expect((await b.call(web, `/api/auth/device/pair/${second.pairingId}/deny`, { body: {} })).status).toBe(200);
        expect(await (await confirm(b, web, second.pairingId, body.digits)).json()).toMatchObject({ code: 'denied' });
        expect(await (await pairRedeem(b, body.claimId, flow.verifier)).json()).toMatchObject({ code: 'denied' });
    });

    it('lets "Not my device" win over a redeem already making the session: no cookie, no session left', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq = await qr(b, web);
        const { body, flow } = await claim(b, pq.code);
        await confirm(b, web, pq.pairingId, body.digits);
        const context = await (await b.provider.auth()).$context;
        const adapter = context.internalAdapter;
        const make = adapter.createSession.bind(adapter);
        let reached!: () => void;
        const inside = new Promise<void>((resolve) => (reached = resolve));
        let resume!: () => void;
        const held = new Promise<void>((resolve) => (resume = resolve));
        const spy = vi.spyOn(adapter, 'createSession').mockImplementation(async (...args) => {
            reached();
            await held;
            return make(...args);
        });
        const device = new Jar();
        const redeeming = pairRedeem(b, body.claimId, flow.verifier, device);
        await inside;
        expect((await b.call(web, `/api/auth/device/pair/${pq.pairingId}/deny`, { body: {} })).status).toBe(200);
        resume();
        const answer = await redeeming;
        spy.mockRestore();
        expect(answer.status).toBe(403);
        expect(await answer.json()).toMatchObject({ code: 'denied' });
        expect(answer.headers.get('set-cookie') ?? '').not.toMatch(/session_token=[^;]+/);
        expect(await (await status(b, web, pq.pairingId)).json()).toMatchObject({ state: 'denied' });
        const user = b.db.prepare("SELECT id FROM auth_user WHERE email = 'ada@example.com'").get() as { id: string };
        expect(
            b.db
                .prepare('SELECT count(*) AS n FROM auth_session WHERE userId = ? AND deviceId IS NOT NULL')
                .get(user.id),
        ).toEqual({ n: 0 });
    });

    it('lets signing out on the web win over a redeem already making the session', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq = await qr(b, web);
        const { body, flow } = await claim(b, pq.code);
        await confirm(b, web, pq.pairingId, body.digits);
        const hold = await holdCreateSession(b);
        const redeeming = pairRedeem(b, body.claimId, flow.verifier);
        await hold.inside;
        expect((await b.call(web, '/api/auth/logout', { body: {} })).status).toBe(200);
        hold.resume();
        const answer = await redeeming;
        hold.restore();
        expect(answer.status).toBe(403);
        expect(await answer.json()).toMatchObject({ code: 'not_authorized' });
        expect(answer.headers.get('set-cookie') ?? '').not.toMatch(/session_token=[^;]+/);
        expect(deviceSessions(b)).toEqual({ n: 0 });
    });

    it('leaves room for a device polling the whole 2 minutes, and others behind the same address', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq = await qr(b, web);
        const { body, flow } = await claim(b, pq.code);
        // 150 polls from this address (other claims, so the per-claim second doesn't bite).
        for (let i = 0; i < 150; i++) {
            expect((await pairRedeem(b, b64(randomBytes(18)), flow.verifier)).status).not.toBe(429);
        }
        await confirm(b, web, pq.pairingId, body.digits);
        expect((await pairRedeem(b, body.claimId, flow.verifier)).status).toBe(200);
    });

    it('kills a QR code denied before any device claimed it (the page closed)', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const { code, pairingId } = await qr(b, web);
        expect((await b.call(web, `/api/auth/device/pair/${pairingId}/deny`, { body: {} })).status).toBe(200);
        expect(await (await status(b, web, pairingId)).json()).toMatchObject({ state: 'denied' });
        const late = await claim(b, code);
        expect(late.answer.status).toBe(400);
        expect(JSON.stringify(late.body)).not.toMatch(/digits|email/);
    });

    it('lets a claim die at 2 minutes, and when its page stops polling', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq1 = await qr(b, web);
        const expired = await claim(b, pq1.code);
        b.db
            .prepare('UPDATE auth_device_pairing SET claimExpiresAt = ? WHERE claimId = ?')
            .run(Date.now() - 1, expired.body.claimId);
        expect(await (await status(b, web, pq1.pairingId)).json()).toMatchObject({ state: 'expired' });
        expect(await (await confirm(b, web, pq1.pairingId, expired.body.digits)).json()).toMatchObject({
            code: 'denied',
        });
        const pq2 = await qr(b, web);
        const quiet = await claim(b, pq2.code);
        b.db
            .prepare('UPDATE auth_device_pairing SET lastPolledAt = ? WHERE claimId = ?')
            .run(Date.now() - CLAIM_POLL_MS - 1, quiet.body.claimId);
        expect(await (await confirm(b, web, pq2.pairingId, quiet.body.digits)).json()).toMatchObject({
            code: 'denied',
        });
    });

    it('burns a confirmed claim redeemed with the wrong verifier', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq3 = await qr(b, web);
        const { body, flow } = await claim(b, pq3.code);
        await confirm(b, web, pq3.pairingId, body.digits);
        expect(await (await pairRedeem(b, body.claimId, pkce().verifier)).json()).toMatchObject({
            code: 'code_invalid',
        });
        // The web says it failed, never "signed in".
        expect(await (await status(b, web, pq3.pairingId)).json()).toMatchObject({ state: 'denied' });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect((await pairRedeem(b, body.claimId, flow.verifier)).status).not.toBe(200);
    });

    it('refuses the sign-in once the web session that confirmed it ended', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq4 = await qr(b, web);
        const { body, flow } = await claim(b, pq4.code);
        await confirm(b, web, pq4.pairingId, body.digits);
        await b.call(web, '/api/auth/logout', { body: {} });
        expect(await (await pairRedeem(b, body.claimId, flow.verifier)).json()).toMatchObject({
            code: 'not_authorized',
        });
    });

    it('caps confirm tries per web session, as well as per claim', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const codes: number[] = [];
        for (let round = 0; round < 4; round++) {
            const pq5 = await qr(b, web);
            const { body } = await claim(b, pq5.code);
            for (let i = 0; i < 3; i++) {
                codes.push((await confirm(b, web, pq5.pairingId, otherDigits(body.digits))).status);
            }
        }
        // 10 tries per 15 minutes per session, whatever the claims.
        expect(codes.filter((code) => code === 429)).toHaveLength(2);
    });

    it('refuses a code claimed by another build, and offers nothing where the production app can’t go', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq6 = await qr(b, web);
        const wrong = await claim(b, pq6.code, pkce(), 'production');
        expect(wrong.body).toMatchObject({ code: 'wrong_variant' });
        // Without the test setting, an http origin (or one on another port) gets no QR code.
        const plain = await brain({ AUTH_APP_PREVIEW_LINKS: 'false' });
        await plain.account('bob@example.com', 'Bob');
        const answer = await plain.call((await plain.signIn('bob@example.com')).jar, '/api/auth/device/pair', {
            body: {},
        });
        expect(answer.status).toBe(403);
        expect(await answer.json()).toMatchObject({ code: 'not_authorized' });
    });

    it('never writes the digits to a log line, the audit or a stored row', async () => {
        const lines: string[] = [];
        const b = await brain();
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
                lines.push(args.map(String).join(' '));
            });
        }
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq7 = await qr(b, web);
        const { body, flow } = await claim(b, pq7.code);
        await confirm(b, web, pq7.pairingId, body.digits);
        await pairRedeem(b, body.claimId, flow.verifier);
        expect(lines.join('\n')).not.toContain(body.digits);
        const rows = JSON.stringify(b.db.prepare('SELECT * FROM auth_device_pairing').all());
        expect(rows).not.toMatch(new RegExp(`\\b${body.digits}\\b`));
        const audit = JSON.stringify(b.db.prepare('SELECT * FROM workspace_audit').all());
        expect(audit).not.toContain(body.digits);
    });
});

describe('Add a device for a development build (AUTH_APP_DEV_LINKS)', () => {
    it('makes no development links by default', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const asked = await b.call(web, '/api/auth/device/pair', { body: { variant: 'development' } });
        expect(asked.status).toBe(403);
        expect(await asked.json()).toMatchObject({ code: 'not_authorized' });
        const plain = await brain({ AUTH_APP_PREVIEW_LINKS: 'false' });
        await plain.account('ada@example.com', 'Ada');
        const { jar: local } = await plain.signIn('ada@example.com');
        expect((await plain.call(local, '/api/auth/device/pair', { body: {} })).status).toBe(403);
    });

    it('makes development links on the development link host when on, and a development build signs in', async () => {
        const b = await brain({ AUTH_APP_PREVIEW_LINKS: 'false', AUTH_APP_DEV_LINKS: 'true' });
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const answer = await b.call(web, '/api/auth/device/pair', { body: {} });
        const { link, variant, pairingId } = (await answer.json()) as {
            link: string;
            variant: string;
            pairingId: string;
        };
        expect(variant).toBe('development');
        expect(link.startsWith('https://link-staging.socio.sh/dev/d/')).toBe(true);
        const parsed = parseAppLink(link, LINK_STAGING_HOST)!;
        const { body, flow } = await claim(b, (parsed.fields as { c: string }).c, pkce(), 'development');
        await confirm(b, web, pairingId, body.digits);
        expect((await pairRedeem(b, body.claimId, flow.verifier)).status).toBe(200);
    });

    it('refuses to start with development links under NODE_ENV=production', () => {
        expect(() =>
            authFromEnv(
                {
                    AUTH_PROVIDER: 'betterauth',
                    APP_ORIGIN: ORIGIN,
                    SESSION_SECRET: SECRET,
                    AUTH_APP_DEV_LINKS: 'true',
                    NODE_ENV: 'production',
                },
                '127.0.0.1',
                { database: ':memory:', hasher: fastHasher },
            ),
        ).toThrow(/AUTH_APP_DEV_LINKS/);
    });
});

describe('the new device’s Cancel', () => {
    it('ends its own claim and the QR code at once, idempotently, and the web sees it', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq = await qr(b, web);
        const { body, flow } = await claim(b, pq.code);
        for (let i = 0; i < 2; i++) {
            const cancelled = await b.call(new Jar(), '/api/auth/device/pair/cancel', {
                body: { claimId: body.claimId },
            });
            expect(cancelled.status).toBe(200);
            expect(await cancelled.json()).toEqual({ state: 'denied' });
        }
        expect(await (await status(b, web, pq.pairingId)).json()).toMatchObject({ state: 'denied' });
        expect(await (await confirm(b, web, pq.pairingId, body.digits)).json()).toMatchObject({ code: 'denied' });
        expect(await (await pairRedeem(b, body.claimId, flow.verifier)).json()).toMatchObject({ code: 'denied' });
    });

    it('cancels nobody else’s claim: an unknown or malformed id gets the same answer and changes nothing', async () => {
        const b = await brain();
        await b.account('ada@example.com', 'Ada');
        const { jar: web } = await b.signIn('ada@example.com');
        const pq = await qr(b, web);
        const { body, flow } = await claim(b, pq.code);
        for (const claimId of [b64(randomBytes(18)), pq.pairingId, 'short']) {
            const answer = await b.call(new Jar(), '/api/auth/device/pair/cancel', { body: { claimId } });
            expect(answer.status).toBe(200);
            expect(await answer.json()).toEqual({ state: 'denied' });
        }
        await confirm(b, web, pq.pairingId, body.digits);
        expect((await pairRedeem(b, body.claimId, flow.verifier)).status).toBe(200);
        // After a sign-in, a late Cancel undoes nothing.
        await b.call(new Jar(), '/api/auth/device/pair/cancel', { body: { claimId: body.claimId } });
        expect(await (await status(b, web, pq.pairingId)).json()).toMatchObject({ state: 'signed_in' });
    });
});
