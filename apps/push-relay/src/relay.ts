// The relay's HTTP API.
//
// For the app, with the registration's id and secret chosen by the app and stored before the call,
// so a retry after a kill finds the same registration:
//
//   POST   /v1/registrations      {id, secret, platform, nativeToken, bundleId, apnsEnv, vapidKey}
//          201 {endpoint}  new
//          200 {endpoint}  the same id and secret again (a retry); a changed nativeToken is stored
//          403             the id exists with another secret
//          409             the id exists bound to another VAPID key, platform, bundle id or APNs host
//                          (a registration is never rebound)
//          400             anything invalid, including a bundle id outside the app's three variants
//          429             with Retry-After: the caller's address or everyone together called
//                          the registration routes too often (rate-limiting bindings, per location,
//                          before anything reads D1), or the D1 write budget (src/write-budget.ts,
//                          across every location) is spent for this minute. The address is hashed
//                          into the limiter's key, never kept
//   PUT    /v1/registrations/:id  {secret, nativeToken?}   the daily refresh: 204, 403, 410 unknown,
//                                                         429 as for POST
//   DELETE /v1/registrations/:id  {secret}                 204, 403, 410 unknown, 429 from the
//                                                         bindings only, counted apart from writes
//                                                         (never the write budget: a create prepaid
//                                                         its delete), so a revocation lands
//
// For Socio servers, as a Web Push service (RFC 8030, 8291, 8292), at the `endpoint` above:
//
//   POST   /v1/push/:id   aes128gcm body, `Authorization: vapid t=…, k=…`, TTL, Topic
//          201  forwarded (whole, or as the generic alert when it doesn't fit: a provider message
//               over 4096 bytes, a provider refusing the size, or a body over 8 KiB, which is
//               never read past that and never refused for its size)
//          401  a missing or invalid VAPID header (bad signature, `aud` not RELAY_ORIGIN, `exp`)
//          403  `k` isn't the key the registration is bound to
//          410  the registration doesn't exist (or the id is malformed), or the phone's native
//               token is permanently gone: the provider said so for the token the registration
//               still holds, which is then cleared in the same statement that checks it (a stale
//               "gone" for a token the phone has since replaced answers 503); a `PUT` or a
//               retried `POST` with a new token revives it
//          415  a Content-Encoding other than aes128gcm
//          429  a quota, with Retry-After
//          503  the store or the provider failed, with Retry-After
//
// Anything else answers 400, and a known path with the wrong method 405. Nothing answers 404, and
// only a registration that is really gone answers 410: a Socio server deletes its subscription on
// either (src/server/notifications/push.ts).
//
// The secret is kept only as its SHA-256. Logs carry no IPs, ids, tokens, keys or secrets.

import { encode } from './base64url';
import { fits, messageFor, type ApnsEnv, type Outcome, type Platform, type Providers } from './providers';
import { RETRY_AFTER_S, type Quotas } from './quotas';
import {
    EXPIRE_DAYS,
    StoreDown,
    dateOf,
    registrationStore,
    type Database,
    type Registration,
    type RegistrationStore,
} from './registrations';
import { canonicalKey, checkVapid } from './vapid';
import { DEFAULT_REGISTRATION_WRITE_BUDGET, WRITE_COST } from './write-budget';

/** The bundle ids (iOS) and application ids (Android) of the app's three variants (apps/mobile/variant.ts). */
export const BUNDLE_IDS: readonly string[] = [
    'com.ingenioventures.socio',
    'com.ingenioventures.socio.preview',
    'com.ingenioventures.socio.dev',
];

/**
 * Web Push bodies are read up to this much. Past it the relay stops reading and sends the generic
 * alert (over the size limit, the generic alert, never an error): web-push sends up to
 * two 4 KiB records, and even one never fits a provider.
 */
export const MAX_PUSH_BODY = 8192;
/** Registration and refresh bodies are small JSON. */
const MAX_JSON_BODY = 8192;
/** The longest TTL passed on (FCM's maximum, 28 days). */
const MAX_TTL_S = 28 * 24 * 60 * 60;
/** What a store or provider failure answers in Retry-After. */
const RETRY_DOWN_S = 30;

const ID = /^[A-Za-z0-9_-]{22,64}$/;
/** At least 32 random bytes in base64url. */
const SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;
/** APNs device tokens are hex (32 bytes today; Apple says not to rely on the length). */
const APNS_TOKEN = /^[0-9A-Fa-f]{32,400}$/;
/** FCM registration tokens: URL-safe characters and colons. */
const FCM_TOKEN = /^[A-Za-z0-9_:.-]{20,4096}$/;

export interface RelayDeps {
    db: Database;
    quotas: Quotas;
    providers: Providers;
    /** The relay's own origin (RELAY_ORIGIN): the VAPID audience, and the endpoints' origin. */
    origin: string;
    now?: () => number;
    /** The D1 write budget, billed rows a minute (REGISTRATION_WRITE_BUDGET); the default otherwise. */
    writeBudget?: number;
    /** One short line per event; never an IP, id, token, key or secret. */
    log?: (event: string) => void;
}

const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });
const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status: number, error: string) => json(status, { error });

class Answer extends Error {
    constructor(readonly response: Response) {
        super('answer');
    }
}

/** An origin the relay can use: http(s), no path, query or credentials. */
export function validOrigin(origin: unknown): origin is string {
    if (typeof origin !== 'string') {
        return false;
    }
    try {
        const url = new URL(origin);
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin;
    } catch {
        return false;
    }
}

async function sha256(text: string) {
    return encode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function sameHash(a: string, b: string) {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

/** The body, at most `max` bytes; null past it, with the rest left unread. */
async function readUpTo(request: Request, max: number): Promise<Uint8Array | null> {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
        await request.body?.cancel().catch(() => {});
        return null;
    }
    if (!request.body) {
        return new Uint8Array();
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.length;
        if (size > max) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
    const bytes = await readUpTo(request, MAX_JSON_BODY);
    if (!bytes) {
        throw new Answer(problem(413, 'too large'));
    }
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
    } catch {
        // falls through to the 400
    }
    throw new Answer(problem(400, 'a JSON object is required'));
}

const validToken = (platform: Platform, token: unknown): token is string =>
    typeof token === 'string' && (platform === 'ios' ? APNS_TOKEN : FCM_TOKEN).test(token);

export function createRelay(deps: RelayDeps) {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? ((event: string) => console.log(`push-relay: ${event}`));
    const store: RegistrationStore = registrationStore(deps.db);
    const endpointOf = (id: string) => ({ endpoint: `${deps.origin}/v1/push/${id}` });

    /** The registration behind `id` when `secret` is its secret; an answer otherwise. */
    async function authorized(id: string, secret: unknown): Promise<Registration> {
        if (typeof secret !== 'string' || !SECRET.test(secret)) {
            throw new Answer(problem(400, 'secret'));
        }
        const row = await store.get(id);
        if (!row) {
            throw new Answer(empty(410));
        }
        if (!sameHash(row.secret_hash, await sha256(secret))) {
            throw new Answer(problem(403, 'secret'));
        }
        return row;
    }

    const limited = () => new Answer(empty(429, { 'retry-after': String(RETRY_AFTER_S) }));

    /**
     * The registration routes' quotas, per client address and everyone's, checked before the body
     * is read or D1 is touched, on every registration route: `POST`, `PUT` and `DELETE` all read
     * D1 before they know who is asking, so without them unknown ids would cost unlimited reads.
     * Writes and deletes count apart, so a flood of writes never blocks a revocation.
     */
    async function registryQuota(request: Request, kind: 'write' | 'delete') {
        if (!(await deps.quotas.takeRegistry({ client: request.headers.get('cf-connecting-ip'), kind }))) {
            await request.body?.cancel().catch(() => {});
            throw limited();
        }
    }

    /**
     * Charges a write's billed cost to the D1 write budget (src/write-budget.ts), once the request
     * is valid and before any registration is read or written; 429 when it doesn't fit.
     */
    const withinBudget = (cost: number) =>
        store.charge(Math.floor(now() / 60_000), cost, deps.writeBudget ?? DEFAULT_REGISTRATION_WRITE_BUDGET);

    async function charge(cost: number) {
        if (!(await withinBudget(cost))) {
            throw limited();
        }
    }

    async function register(request: Request): Promise<Response> {
        await registryQuota(request, 'write');
        const input = await readJson(request);
        const { id, secret, platform, nativeToken, bundleId } = input;
        const vapidKey = canonicalKey(input.vapidKey);
        const apnsEnv = input.apnsEnv ?? null;
        if (
            typeof id !== 'string' ||
            !ID.test(id) ||
            typeof secret !== 'string' ||
            !SECRET.test(secret) ||
            (platform !== 'ios' && platform !== 'android') ||
            !validToken(platform, nativeToken) ||
            typeof bundleId !== 'string' ||
            !BUNDLE_IDS.includes(bundleId) ||
            (platform === 'ios' ? apnsEnv !== 'sandbox' && apnsEnv !== 'production' : apnsEnv !== null) ||
            !vapidKey
        ) {
            return problem(400, 'invalid registration');
        }
        // A create's cost, whether this turns out a create or a retry: the retry can't be known
        // before the read, and the budget is checked before it.
        await charge(WRITE_COST.create);
        const nowMs = now();
        const row: Registration = {
            id,
            platform,
            native_token: nativeToken,
            bundle_id: bundleId,
            apns_env: apnsEnv as ApnsEnv | null,
            vapid_key: vapidKey,
            secret_hash: await sha256(secret),
            created_at: Math.floor(nowMs / 1000),
            refreshed_on: dateOf(nowMs),
        };
        let existing = await store.get(id);
        if (!existing) {
            if (await store.insert(row)) {
                return json(201, endpointOf(id));
            }
            // Another request with this id got there first: answer as its retry.
            existing = await store.get(id);
            if (!existing) {
                throw new StoreDown('A registration vanished while it was made.');
            }
        }
        if (!sameHash(existing.secret_hash, row.secret_hash)) {
            return problem(403, 'secret');
        }
        if (
            existing.vapid_key !== row.vapid_key ||
            existing.platform !== row.platform ||
            existing.bundle_id !== row.bundle_id ||
            existing.apns_env !== row.apns_env
        ) {
            return problem(409, 'the registration is bound to another key or app');
        }
        if (existing.native_token !== row.native_token) {
            await store.refresh(id, row.native_token, row.refreshed_on);
        }
        return json(200, endpointOf(id));
    }

    async function refresh(request: Request, id: string): Promise<Response> {
        await registryQuota(request, 'write');
        const input = await readJson(request);
        if (typeof input.secret !== 'string' || !SECRET.test(input.secret)) {
            return problem(400, 'secret');
        }
        await charge(WRITE_COST.refresh);
        const row = await authorized(id, input.secret);
        if (input.nativeToken === undefined) {
            // The date only: writing back the token read above could undo a rotation that raced it.
            await store.touch(id, dateOf(now()));
            return empty(204);
        }
        if (!validToken(row.platform, input.nativeToken)) {
            return problem(400, 'nativeToken');
        }
        await store.refresh(id, input.nativeToken, dateOf(now()));
        return empty(204);
    }

    async function remove(request: Request, id: string): Promise<Response> {
        await registryQuota(request, 'delete');
        const input = await readJson(request);
        await authorized(id, input.secret);
        await store.remove(id);
        return empty(204);
    }

    /** Forwards `p`, the ciphertext; with none (a body too big to read), the generic alert. */
    async function deliver(registration: Registration, p: string | null, ttl: number, topic: string | undefined) {
        const target = {
            id: registration.id,
            platform: registration.platform,
            nativeToken: registration.native_token,
            bundleId: registration.bundle_id,
            apnsEnv: registration.apns_env,
        };
        const full = p === null ? null : messageFor(target, p);
        const send = (generic: boolean) =>
            deps.providers.send({
                target,
                message: !generic && full ? full : messageFor(target),
                generic: generic || !full,
                ttl,
                ...(topic ? { topic } : {}),
                nowMs: now(),
            });
        let outcome: Outcome;
        try {
            if (full && fits(full)) {
                outcome = await send(false);
                // The provider counts differently than we measure: resend once without the ciphertext.
                if (outcome === 'too-large') {
                    outcome = await send(true);
                }
            } else {
                outcome = await send(true);
            }
        } catch (error) {
            // The message only: an error's text may hold the native token (it's in APNs' URL).
            log(`provider threw ${(error as Error)?.name ?? 'an error'}`);
            outcome = 'failed';
        }
        if (outcome === 'sent') {
            return empty(201);
        }
        // A gone token is cleared and answers 410 only if the registration still holds it. If the
        // phone rotated to a new token while this push was out, the answer is about the old one:
        // 503, so the server keeps the subscription. The row stays either way, for a `PUT` with a
        // new token or the 60-day expiry.
        // Clearing the token is a D1 write, so it charges the write budget first; if the budget is
        // spent, the "gone" waits for a later push (503 keeps the subscription meanwhile).
        if (outcome === 'gone') {
            if (!(await withinBudget(WRITE_COST.tokenClear))) {
                log('provider gone, write budget spent');
                outcome = 'failed';
            } else if (await store.clearToken(registration.id, registration.native_token)) {
                return empty(410);
            } else {
                log('provider gone for a replaced token');
                outcome = 'failed';
            }
        }
        log(`provider ${outcome}`);
        return empty(503, { 'retry-after': String(RETRY_DOWN_S) });
    }

    async function push(request: Request, id: string): Promise<Response> {
        // The broad quotas come before any D1 read, so pushes to unknown ids can't cost unlimited
        // reads: everyone's first, then the key's once its signature checks (src/quotas.ts).
        const tooMany = () => empty(429, { 'retry-after': String(RETRY_AFTER_S) });
        if (!(await deps.quotas.takeGlobalPush())) {
            return tooMany();
        }
        const vapid = await checkVapid(request.headers.get('authorization'), deps.origin, now());
        if (!vapid.ok) {
            return problem(401, `vapid: ${vapid.reason}`);
        }
        if (!(await deps.quotas.takeVapidKey(vapid.key))) {
            return tooMany();
        }
        const registration = await store.get(id);
        if (!registration) {
            return empty(410);
        }
        if (registration.vapid_key !== vapid.key) {
            return problem(403, 'the VAPID key is not the one this registration is bound to');
        }
        // A provider said its token is gone and no new one has come since.
        if (registration.native_token === '') {
            return empty(410);
        }
        if (request.headers.get('content-encoding')?.trim().toLowerCase() !== 'aes128gcm') {
            return problem(415, 'aes128gcm only');
        }
        // Over MAX_PUSH_BODY: null, and the generic alert goes out instead.
        const body = await readUpTo(request, MAX_PUSH_BODY);
        if (body?.length === 0) {
            return problem(400, 'an encrypted body is required');
        }
        if (!(await deps.quotas.takeRegistrationPush(registration.id))) {
            return tooMany();
        }
        const ttl = Math.min(Math.max(Math.floor(Number(request.headers.get('ttl')) || 0), 0), MAX_TTL_S);
        const topic = request.headers.get('topic')?.trim();
        if (!body) {
            log('body over the read limit: generic alert');
        }
        return deliver(registration, body && encode(body), ttl, topic && TOPIC.test(topic) ? topic : undefined);
    }

    async function route(request: Request): Promise<Response> {
        const parts = new URL(request.url).pathname.split('/').slice(1);
        const method = request.method;
        if (parts[0] !== 'v1' || parts.length < 2 || parts.length > 3) {
            return empty(400);
        }
        if (parts[1] === 'registrations' && parts.length === 2) {
            return method === 'POST' ? register(request) : empty(405, { allow: 'POST' });
        }
        if (parts[1] === 'registrations') {
            if (method !== 'PUT' && method !== 'DELETE') {
                return empty(405, { allow: 'PUT, DELETE' });
            }
            if (!ID.test(parts[2])) {
                return problem(400, 'id');
            }
            return method === 'PUT' ? refresh(request, parts[2]) : remove(request, parts[2]);
        }
        if (parts[1] === 'push' && parts.length === 3) {
            if (method !== 'POST') {
                return empty(405, { allow: 'POST' });
            }
            // A malformed id can never be a registration: gone, as an unknown one is.
            return ID.test(parts[2]) ? push(request, parts[2]) : empty(410);
        }
        return empty(400);
    }

    return {
        async fetch(request: Request): Promise<Response> {
            if (!validOrigin(deps.origin)) {
                log('RELAY_ORIGIN is not set to an origin');
                return empty(503, { 'retry-after': String(RETRY_DOWN_S) });
            }
            try {
                return await route(request);
            } catch (error) {
                if (error instanceof Answer) {
                    return error.response;
                }
                if (error instanceof StoreDown) {
                    log('store failed');
                    return empty(503, { 'retry-after': String(RETRY_DOWN_S) });
                }
                log(`unexpected ${(error as Error)?.name ?? 'error'}`);
                return empty(500);
            }
        },

        /** The daily task: drops registrations not refreshed in 60 days, and old write counts. */
        async expire(): Promise<number> {
            const cutoff = dateOf(now() - EXPIRE_DAYS * 24 * 60 * 60 * 1000);
            const dropped = await store.expire(cutoff);
            // The write budget's counts: only the current minute matters; keep the last hour. These
            // deletes, and the registrations' (prepaid by each create), are in the budget's
            // arithmetic (src/write-budget.ts), so the cron charges nothing.
            await store.dropBudgetBefore(Math.floor(now() / 60_000) - 60);
            log(`expired registrations: ${dropped}`);
            return dropped;
        },
    };
}

export type Relay = ReturnType<typeof createRelay>;
