// The relay under test, and a Socio server that pushes to it the way the server does.

import { createHash, createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import * as webpush from 'web-push';

import type { Providers } from '../src/providers';
import { QUOTAS, rateLimitQuotas } from '../src/quotas';
import { createRelay } from '../src/relay';

import { FakeD1 } from './fakes/d1';
import { FakeProviders } from './fakes/providers';
import { FakeRateLimit } from './fakes/rate-limit';

/** A made-up origin (.test is reserved); no relay host has been chosen. */
export const ORIGIN = 'https://relay.example.test';

/** The server's own web-push, the root's install; the relay doesn't depend on it. */
export const webpushVersion = (
    JSON.parse(readFileSync(createRequire(import.meta.url).resolve('web-push/package.json'), 'utf8')) as {
        version: string;
    }
).version;

export function setup(
    options: {
        origin?: string;
        start?: number;
        providers?: Providers;
        /** Per-minute push limits to use instead of QUOTAS'. */
        limits?: Partial<Record<'registration' | 'vapidKey' | 'global' | 'registerClient' | 'registryGlobal', number>>;
        /** Shared with another harness: two relays on one D1, as two Cloudflare locations are. */
        db?: FakeD1;
        /** The D1 write budget; high by default so other tests never meet it. */
        writeBudget?: number;
    } = {},
) {
    let nowMs = options.start ?? Date.now();
    const clock = () => nowMs;
    const db = options.db ?? new FakeD1();
    const providers = new FakeProviders();
    const limits = {
        RL_REGISTRATION: new FakeRateLimit(
            options.limits?.registration ?? QUOTAS.registration.limit,
            QUOTAS.registration.period,
            clock,
        ),
        RL_VAPID_KEY: new FakeRateLimit(
            options.limits?.vapidKey ?? QUOTAS.vapidKey.limit,
            QUOTAS.vapidKey.period,
            clock,
        ),
        RL_GLOBAL: new FakeRateLimit(options.limits?.global ?? QUOTAS.global.limit, QUOTAS.global.period, clock),
        RL_REGISTER_CLIENT: new FakeRateLimit(
            options.limits?.registerClient ?? QUOTAS.registerClient.limit,
            QUOTAS.registerClient.period,
            clock,
        ),
        RL_REGISTRY_GLOBAL: new FakeRateLimit(
            options.limits?.registryGlobal ?? QUOTAS.registryGlobal.limit,
            QUOTAS.registryGlobal.period,
            clock,
        ),
    };
    const logs: string[] = [];
    const log = (event: string) => logs.push(event);
    const relay = createRelay({
        db,
        quotas: rateLimitQuotas(limits, log),
        providers: options.providers ?? providers,
        origin: options.origin ?? ORIGIN,
        now: clock,
        writeBudget: options.writeBudget ?? 1_000_000,
        log,
    });
    return {
        relay,
        db,
        providers,
        limits,
        logs,
        advance: (ms: number) => {
            nowMs += ms;
        },
        setNow: (ms: number) => {
            nowMs = ms;
        },
        call: (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
            relay.fetch(
                new Request(`${ORIGIN}${path}`, {
                    method,
                    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
                    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
                }),
            ),
    };
}

export type Harness = ReturnType<typeof setup>;

/** A Socio server: its VAPID key pair, as `PushChannel` keeps one per workspace. */
export const newServer = () => webpush.generateVAPIDKeys();
export type Server = ReturnType<typeof newServer>;

/** A phone's registration in one workspace, with the id and secret the app picks. */
export function newRegistration(server: Server, overrides: Record<string, unknown> = {}) {
    return {
        id: randomBytes(16).toString('base64url'),
        secret: randomBytes(32).toString('base64url'),
        platform: 'ios',
        nativeToken: randomBytes(32).toString('hex'),
        bundleId: 'com.ingenioventures.socio.dev',
        apnsEnv: 'sandbox',
        vapidKey: server.publicKey,
        ...overrides,
    };
}

export const androidToken = () =>
    `${randomBytes(11).toString('base64url')}:APA91b${randomBytes(100).toString('base64url')}`;

/** The phone's Web Push keys (the app makes these natively; NKi, NKa). */
export function phoneKeys() {
    const ecdh = createECDH('prime256v1');
    return { p256dh: ecdh.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

export const topicOf = (tag: string) => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

/** web-push 4.0.0 exactly as src/server/notifications/push.ts calls it. */
export function pushRequest(server: Server, endpoint: string, payload: string, tag?: string) {
    const details = webpush.generateRequestDetails({ endpoint, keys: phoneKeys() }, payload, {
        vapidDetails: { subject: 'https://socio.invalid', publicKey: server.publicKey, privateKey: server.privateKey },
        TTL: 24 * 60 * 60,
        urgency: 'normal',
        ...(tag ? { topic: topicOf(tag) } : {}),
    });
    return new Request(details.endpoint, {
        method: details.method,
        headers: details.headers as Record<string, string>,
        ...(details.body ? { body: new Uint8Array(details.body) } : {}),
    });
}

/** Registers a phone and returns its endpoint. */
export async function registered(h: Harness, server: Server, overrides: Record<string, unknown> = {}) {
    const registration = newRegistration(server, overrides);
    const response = await h.call('POST', '/v1/registrations', registration);
    if (response.status !== 201) {
        throw new Error(`registration answered ${response.status}`);
    }
    const { endpoint } = (await response.json()) as { endpoint: string };
    return { registration, endpoint };
}

export const message = (body = 'The weekly report is ready for review.') =>
    JSON.stringify({ kind: 'message', title: 'Ana in #launch', body, link: '/rooms/r1', tag: 'room:r1' });
