/**
 * Standard Webhooks (spec v1) signing and verification for Socio Forms
 * receivers and the adapters that feed them (CB-479). The wire format is the
 * Forms plugin's receiver contract, docs/specs/FORMS-WEBHOOKS.md:
 *
 *     key            = base64_decode(secret without "whsec_")
 *     signed_content = webhook-id + "." + webhook-timestamp + "." + raw body
 *     signature      = "v1," + base64(HMAC_SHA256(key, signed_content))
 *
 * This file imports nothing and uses only Web Crypto (`crypto.subtle`,
 * `crypto.getRandomValues`), `TextEncoder`, `atob` and `btoa`, so it runs
 * unchanged in Workers, browsers, Node and Bun. Keep it that way: no
 * `node:` imports, no other module of this package.
 */

/** How far `webhook-timestamp` may be from the receiver's clock, either way. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** How long `MemorySeenStore` keeps an id by default: the contract's 7 days. */
export const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const PREFIX = 'whsec_';
const MIN_KEY_BYTES = 24;
const MAX_KEY_BYTES = 64;
/** Limits on attacker-controlled headers, so a hostile request stays cheap. */
const MAX_ID_LENGTH = 256;
const MAX_SIGNATURE_HEADER_LENGTH = 4096;
const MAX_SIGNATURE_ENTRIES = 16;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The three signed headers. */
export type WebhookHeaders = {
    'webhook-id': string;
    'webhook-timestamp': string;
    'webhook-signature': string;
};

/** Fetch `Headers`, or a plain object such as Node's `IncomingHttpHeaders`. */
export type HeadersLike = Headers | Record<string, string | readonly string[] | undefined>;

export type WebhookBody = Uint8Array | ArrayBuffer | string;

export type VerifyFailure =
    /** A signed header is absent or empty. */
    | 'missing_headers'
    /** A header is repeated, too long, or the timestamp isn't Unix seconds. */
    | 'malformed_headers'
    /** The timestamp is more than the tolerance in the past. */
    | 'timestamp_too_old'
    /** The timestamp is more than the tolerance in the future. */
    | 'timestamp_too_new'
    /** `webhook-signature` holds no well-formed `v1,` entry. */
    | 'no_signature'
    /** No `v1,` entry matches any secret. */
    | 'bad_signature';

export type VerifyResult = { ok: true; id: string; timestamp: number } | { ok: false; reason: VerifyFailure };

export interface VerifyOptions {
    /** The clock, in milliseconds like `Date.now` (the default). */
    now?: () => number;
    /** The replay window in seconds, either way; 300 by default. */
    toleranceSeconds?: number;
}

const encoder = new TextEncoder();

function bytesOf(body: WebhookBody): Uint8Array {
    if (typeof body === 'string') {
        return encoder.encode(body);
    }
    return body instanceof Uint8Array ? body : new Uint8Array(body);
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

/** Standard base64 with padding, or undefined when it isn't. Never throws. */
function fromBase64(text: string): Uint8Array | undefined {
    if (!BASE64.test(text)) {
        return undefined;
    }
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** The key of a `whsec_` secret. Throws without echoing the secret. */
function keyOf(secret: string, index: number): Uint8Array {
    if (typeof secret !== 'string' || !secret.startsWith(PREFIX)) {
        throw new TypeError(`webhooks: secret ${index + 1} is not a whsec_ secret.`);
    }
    const key = fromBase64(secret.slice(PREFIX.length));
    if (!key || key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES) {
        throw new TypeError(
            `webhooks: secret ${index + 1} must be whsec_ and the base64 of ${MIN_KEY_BYTES} to ${MAX_KEY_BYTES} bytes.`,
        );
    }
    return key;
}

function keysOf(secrets: readonly string[]): Uint8Array[] {
    if (!Array.isArray(secrets) || secrets.length === 0) {
        throw new TypeError('webhooks: at least one secret is needed.');
    }
    return secrets.map(keyOf);
}

async function hmac(key: Uint8Array, id: string, timestamp: string, body: Uint8Array): Promise<Uint8Array> {
    const prefix = encoder.encode(`${id}.${timestamp}.`);
    const content = new Uint8Array(prefix.length + body.length);
    content.set(prefix);
    content.set(body, prefix.length);
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, content as BufferSource));
}

/** Equal-length byte comparison whose time doesn't depend on where they differ. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i]! ^ b[i]!;
    }
    return diff === 0;
}

/** One header's value: undefined when absent, null when repeated. */
function header(headers: HeadersLike, name: string): string | null | undefined {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return headers.get(name) ?? undefined;
    }
    const record = headers as Record<string, string | readonly string[] | undefined>;
    let found: string | readonly string[] | undefined;
    let count = 0;
    for (const key of Object.keys(record)) {
        if (key.toLowerCase() === name) {
            found = record[key];
            count++;
        }
    }
    if (count > 1) {
        return null;
    }
    if (Array.isArray(found)) {
        return found.length === 0 ? undefined : found.length === 1 ? found[0] : null;
    }
    return typeof found === 'string' ? found : undefined;
}

/**
 * Verify one delivery: its raw body bytes, as received, before any parsing.
 * Accepts when any `v1,` entry of `webhook-signature` matches any secret
 * (rotation on both sides) and the timestamp is within the window. Never
 * throws on what the request holds; throws a `TypeError` only for a
 * malformed secret, which is the receiver's own configuration.
 */
export async function verify(
    rawBody: WebhookBody,
    headers: HeadersLike,
    secrets: readonly string[],
    opts: VerifyOptions = {},
): Promise<VerifyResult> {
    const keys = keysOf(secrets);
    const tolerance = opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
    if (!headers || typeof headers !== 'object') {
        return { ok: false, reason: 'missing_headers' };
    }
    const id = header(headers, 'webhook-id');
    const timestamp = header(headers, 'webhook-timestamp');
    const signature = header(headers, 'webhook-signature');
    if (id === null || timestamp === null || signature === null) {
        return { ok: false, reason: 'malformed_headers' };
    }
    if (!id || !timestamp || !signature) {
        return { ok: false, reason: 'missing_headers' };
    }
    if (id.length > MAX_ID_LENGTH || signature.length > MAX_SIGNATURE_HEADER_LENGTH || !/^\d{1,12}$/.test(timestamp)) {
        return { ok: false, reason: 'malformed_headers' };
    }
    // Fetch `Headers` and Node join a repeated header with ", ", which no
    // single space-separated signature list contains.
    if (signature.includes(', ')) {
        return { ok: false, reason: 'malformed_headers' };
    }
    const seconds = Number(timestamp);
    const nowSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
    if (nowSeconds - seconds > tolerance) {
        return { ok: false, reason: 'timestamp_too_old' };
    }
    if (seconds - nowSeconds > tolerance) {
        return { ok: false, reason: 'timestamp_too_new' };
    }
    const candidates: Uint8Array[] = [];
    for (const entry of signature.split(' ')) {
        if (!entry.startsWith('v1,')) {
            continue; // other versions are ignored, as the spec says
        }
        const bytes = fromBase64(entry.slice(3));
        if (bytes && bytes.length === 32) {
            candidates.push(bytes);
        }
        if (candidates.length >= MAX_SIGNATURE_ENTRIES) {
            break;
        }
    }
    if (candidates.length === 0) {
        return { ok: false, reason: 'no_signature' };
    }
    let body: Uint8Array;
    try {
        body = bytesOf(rawBody);
    } catch {
        return { ok: false, reason: 'bad_signature' };
    }
    let matched = false;
    for (const key of keys) {
        const expected = await hmac(key, id, timestamp, body);
        for (const candidate of candidates) {
            // No early return: every comparison runs, whichever matches.
            matched = equalBytes(expected, candidate) || matched;
        }
    }
    return matched ? { ok: true, id, timestamp: seconds } : { ok: false, reason: 'bad_signature' };
}

export interface SignInput {
    /** The delivery id, stable across retries (`msg_…` by convention). */
    id: string;
    /** Unix seconds, or a `Date`, when this attempt is signed. */
    timestamp: number | Date;
    /** The exact bytes that will be sent. */
    body: WebhookBody;
}

/** Sign a delivery with every secret: one `v1,` entry each, space-separated. */
export async function sign(input: SignInput, secrets: readonly string[]): Promise<WebhookHeaders> {
    const keys = keysOf(secrets);
    const { id } = input;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
        throw new TypeError(`webhooks: id must be 1 to ${MAX_ID_LENGTH} characters.`);
    }
    const seconds = input.timestamp instanceof Date ? Math.floor(input.timestamp.getTime() / 1000) : input.timestamp;
    if (!Number.isSafeInteger(seconds) || seconds < 0) {
        throw new TypeError('webhooks: timestamp must be whole Unix seconds or a Date.');
    }
    const timestamp = String(seconds);
    const body = bytesOf(input.body);
    const entries = await Promise.all(keys.map(async (key) => `v1,${toBase64(await hmac(key, id, timestamp, body))}`));
    return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': entries.join(' ') };
}

/** A new secret: `whsec_` and the base64 of 32 random bytes. */
export function generateSecret(): string {
    return PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The secrets in a Socio Secret's value: one, or two while rotating,
 * separated by whitespace or commas. Throws a `TypeError` (that never
 * echoes the value) for none, more than two, or a malformed one.
 */
export function parseSecrets(value: string): string[] {
    const secrets = String(value ?? '')
        .split(/[\s,]+/)
        .filter(Boolean);
    if (secrets.length === 0 || secrets.length > 2) {
        throw new TypeError(`webhooks: expected one or two whsec_ secrets, found ${secrets.length}.`);
    }
    secrets.forEach(keyOf);
    return secrets;
}

/**
 * Where a receiver remembers the ids it processed. `has` before handling,
 * `add` after a handler succeeds: at-least-once, so two concurrent copies of
 * one delivery can both run; key your own writes on `submissionId` too.
 */
export interface SeenStore {
    has(id: string): boolean | Promise<boolean>;
    add(id: string, ttlSeconds: number): void | Promise<void>;
}

/** An in-memory `SeenStore` for one process, bounded in size. */
export class MemorySeenStore implements SeenStore {
    private readonly entries = new Map<string, number>();

    constructor(private readonly options: { maxEntries?: number; now?: () => number } = {}) {}

    has(id: string) {
        const until = this.entries.get(id);
        if (until === undefined) {
            return false;
        }
        if (until <= this.now()) {
            this.entries.delete(id);
            return false;
        }
        return true;
    }

    add(id: string, ttlSeconds: number) {
        const now = this.now();
        this.entries.delete(id);
        this.entries.set(id, now + ttlSeconds * 1000);
        const max = this.options.maxEntries ?? 100_000;
        for (const [key, until] of this.entries) {
            if (this.entries.size <= max && until > now) {
                break;
            }
            this.entries.delete(key);
        }
    }

    private now() {
        return (this.options.now ?? Date.now)();
    }
}

/** A verified delivery, as a receiver hands it to your handler. */
export interface WebhookEvent<T = unknown> {
    id: string;
    /** `webhook-timestamp`, Unix seconds. */
    timestamp: number;
    /** The raw body, as UTF-8 text. */
    body: string;
    /** The body parsed as JSON. */
    payload: T;
}

export interface ReceiverOptions extends VerifyOptions {
    secrets: readonly string[];
    seen: SeenStore;
    /** How long an id is remembered; 7 days by default. */
    seenTtlSeconds?: number;
    /** Larger bodies answer 413 before any verification; 1 MiB by default. */
    maxBodyBytes?: number;
}

export type WebhookHandler<T = unknown> = (event: WebhookEvent<T>) => void | Response | Promise<void | Response>;

function json(status: number, value: unknown) {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function readLimited(request: Request, max: number): Promise<Uint8Array | undefined> {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
        return undefined;
    }
    if (!request.body) {
        return new Uint8Array(0);
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
            // Not awaited: on a tee'd stream (a `Request.clone()` kept elsewhere),
            // cancel waits for the other branch, which may never finish.
            reader.cancel().catch(() => {});
            return undefined;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}

/**
 * A fetch-style receiver: `const receive = receiver({ secrets, seen })`, then
 * `return receive(request, async (event) => { … })`. A bad signature answers
 * 401 with its reason; a repeated `webhook-id` answers 200 without calling
 * the handler; a verified new delivery calls the handler, and its id is
 * stored once the handler succeeds (it returns nothing, answered 204, or a
 * 2xx `Response`). A handler that throws (500) or returns any other status
 * leaves the id unstored, so the sender's retry runs it again.
 */
export function receiver(options: ReceiverOptions) {
    keysOf(options.secrets); // refuse a bad secret at setup, not per request
    const secrets = [...options.secrets];
    const ttl = options.seenTtlSeconds ?? SEEN_TTL_SECONDS;
    const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    const verifyOptions: VerifyOptions = { now: options.now, toleranceSeconds: options.toleranceSeconds };

    return async function receive<T = unknown>(request: Request, handler: WebhookHandler<T>): Promise<Response> {
        if (request.method !== 'POST') {
            return json(405, { error: 'method_not_allowed' });
        }
        let raw: Uint8Array | undefined;
        try {
            raw = await readLimited(request, maxBodyBytes);
        } catch {
            return json(400, { error: 'unreadable_body' });
        }
        if (!raw) {
            return json(413, { error: 'body_too_large' });
        }
        const verdict = await verify(raw, request.headers, secrets, verifyOptions);
        if (!verdict.ok) {
            return json(401, { error: verdict.reason });
        }
        if (await options.seen.has(verdict.id)) {
            return json(200, { duplicate: true });
        }
        let body: string;
        let payload: T;
        try {
            body = new TextDecoder('utf-8', { fatal: true }).decode(raw);
            payload = JSON.parse(body) as T;
        } catch {
            return json(400, { error: 'invalid_json' });
        }
        let response: void | Response;
        try {
            response = await handler({ id: verdict.id, timestamp: verdict.timestamp, body, payload });
        } catch {
            return json(500, { error: 'handler_failed' });
        }
        if (!response || response.ok) {
            // Only a success is remembered: the sender retries anything else.
            await options.seen.add(verdict.id, ttl);
        }
        return response ?? new Response(null, { status: 204 });
    };
}
