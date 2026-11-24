import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

import { isLocalRedirect, LOOPBACK_HOSTS } from '@socio/foundation/agents/clients';

import { isPublicAddress } from '../../net/public-address.js';

import type { CimdOptions, CimdShape, ClientMetadata } from './contract.js';

/**
 * Client ID Metadata Documents (CB-90, draft-ietf-oauth-client-id-metadata-
 * document): an MCP client's `client_id` is an https URL, and the brain
 * fetches it for the client's name, logo and redirect URIs. The fetch is a
 * request-forgery risk, so it goes only to public addresses (checked after
 * DNS, and the connection pinned to the checked address), never follows a
 * redirect, reads at most 8 KB within 5 s, and keeps what it read in a
 * bounded cache.
 */

/** The largest document read. */
export const CIMD_MAX_BYTES = 8 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;
/** Documents kept in memory, at most. */
const CACHE_ENTRIES = 200;
/** How long a document stays fresh: its Cache-Control, within these. */
const MIN_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const USER_AGENT = 'Socio/0.1 (OAuth client metadata)';
const MAX_REDIRECT_URIS = 20;

export class CimdError extends Error {}

/** A loopback http redirect without a port: any port matches (RFC 8252 §7.3). */
const portless = (uri: string) => {
    try {
        const url = new URL(uri);
        return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) && !url.port ? url : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Whether `requested` is one of the document's redirect URIs, exactly. The
 * one allowance: a loopback http URI the document lists without a port
 * matches it on any port, as native apps pick theirs when they start.
 */
export function redirectUriMatches(requested: string, registered: readonly string[]) {
    if (registered.includes(requested)) {
        return true;
    }
    let url: URL;
    try {
        url = new URL(requested);
    } catch {
        return false;
    }
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(url.hostname)) {
        return false;
    }
    const withoutPort = new URL(url);
    withoutPort.port = '';
    return registered.some((entry) => portless(entry)?.href === withoutPort.href);
}

/** Why this client id can't be a metadata document URL, if it can't. */
export function clientIdProblem(clientId: string): string | undefined {
    let url: URL;
    try {
        url = new URL(clientId);
    } catch {
        return 'The client id is not a URL.';
    }
    if (url.protocol !== 'https:') {
        return 'The client id must be an https URL.';
    }
    if (url.username || url.password) {
        return 'The client id must not carry credentials.';
    }
    if (clientId.includes('#')) {
        return 'The client id must not have a fragment.';
    }
    if (url.port) {
        return 'The client id must use the standard https port.';
    }
    if (url.pathname === '/' || url.pathname === '') {
        return 'The client id must have a path.';
    }
    if (/\/\.\.?(\/|\?|$)/.test(clientId.replace(/%2e/gi, '.'))) {
        return 'The client id must not have dot segments.';
    }
    if (url.href !== clientId) {
        return 'The client id must be a normalized URL.';
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
        return 'The client id must name a host, not an address.';
    }
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        !host.includes('.')
    ) {
        return 'The client id must be on a public host.';
    }
    return undefined;
}

/** The fetch: pinned to the checked address, no redirects, identity only. */
const httpsRequest: NonNullable<CimdOptions['request']> = (url, address, signal) =>
    new Promise((resolve, reject) => {
        const request = https.request(
            url,
            {
                method: 'GET',
                signal,
                headers: {
                    Accept: 'application/json',
                    'Accept-Encoding': 'identity',
                    'User-Agent': USER_AGENT,
                },
                lookup: (_hostname, options, callback) => {
                    if (options.all) {
                        callback(null, [address]);
                    } else {
                        callback(null, address.address, address.family);
                    }
                },
            },
            resolve,
        );
        request.on('error', reject);
        request.end();
    });

const dnsAll = async (hostname: string) =>
    (await dnsLookup(hostname, { all: true })).map(({ address, family }) => ({
        address,
        family,
    }));

/** How long a response may be kept, by its Cache-Control. */
function ttl(control: string | undefined) {
    const value = (control ?? '').toLowerCase();
    if (/\bno-store\b/.test(value)) {
        return 0;
    }
    const age = /\bmax-age=(\d+)/.exec(value);
    if (!age) {
        return DEFAULT_TTL_MS;
    }
    return Math.min(Math.max(Number(age[1]) * 1000, MIN_TTL_MS), MAX_TTL_MS);
}

const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : undefined;
const httpsUrl = (value: unknown) => {
    const url = text(value, 2048);
    if (!url) {
        return undefined;
    }
    try {
        return new URL(url).protocol === 'https:' ? url : undefined;
    } catch {
        return undefined;
    }
};

/** A redirect URI the brain may send a code to. */
function acceptableRedirect(uri: string) {
    if (uri.includes('#')) {
        return false;
    }
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return false;
    }
    if (url.username || url.password) {
        return false;
    }
    if (url.protocol === 'https:') {
        return true;
    }
    if (url.protocol === 'http:') {
        return LOOPBACK_HOSTS.includes(url.hostname);
    }
    // An app's own scheme, reverse-domain style (RFC 8252 §7.1).
    return /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:$/i.test(url.protocol);
}

/** Fields only the server sets: a document carrying one is refused. */
const SERVER_FIELDS = [
    'client_secret',
    'client_secret_expires_at',
    'client_id_issued_at',
    'registration_access_token',
    'registration_client_uri',
];

/** Checks a fetched document against the URL it came from. */
export function parseClientMetadata(clientId: string, value: unknown): ClientMetadata {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CimdError('The client metadata is not a JSON object.');
    }
    const doc = value as Record<string, unknown>;
    if (doc.client_id !== clientId) {
        throw new CimdError('The client metadata names another client id than its URL.');
    }
    for (const field of SERVER_FIELDS) {
        if (field in doc) {
            throw new CimdError(`The client metadata must not set ${field}.`);
        }
    }
    const method = doc.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') {
        throw new CimdError('Only public clients (token_endpoint_auth_method "none") can connect.');
    }
    const grants = doc.grant_types;
    if (
        grants !== undefined &&
        (!Array.isArray(grants) ||
            !grants.includes('authorization_code') ||
            grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token'))
    ) {
        throw new CimdError('The client must use the authorization code grant (and refresh tokens).');
    }
    const responses = doc.response_types;
    if (responses !== undefined && (!Array.isArray(responses) || responses.some((type) => type !== 'code'))) {
        throw new CimdError('The client must use response type "code".');
    }
    const uris = doc.redirect_uris;
    if (
        !Array.isArray(uris) ||
        !uris.length ||
        uris.length > MAX_REDIRECT_URIS ||
        uris.some((uri) => typeof uri !== 'string' || !acceptableRedirect(uri))
    ) {
        throw new CimdError('The client metadata needs redirect_uris: https, loopback http or an app scheme.');
    }
    const host = new URL(clientId).hostname;
    const redirectUris = [...new Set(uris as string[])];
    return {
        clientId,
        host,
        name: text(doc.client_name, 100) ?? host,
        redirectUris,
        logoUri: httpsUrl(doc.logo_uri),
        clientUri: httpsUrl(doc.client_uri),
        applicationType: redirectUris.some(isLocalRedirect) ? 'native' : 'web',
    };
}

interface CacheEntry {
    metadata: ClientMetadata;
    expiresAt: number;
}

/** Fetches and caches client metadata documents, safely. */
export class CimdFetcher implements CimdShape {
    private cache = new Map<string, CacheEntry>();
    private lookup: NonNullable<CimdOptions['lookup']>;
    private request: NonNullable<CimdOptions['request']>;
    private now: () => number;
    private timeoutMs: number;
    constructor(options: CimdOptions = {}) {
        this.lookup = options.lookup ?? dnsAll;
        this.request = options.request ?? httpsRequest;
        this.now = options.now ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? CIMD_TIMEOUT_MS;
    }

    /** The cached document, while it is fresh. */
    cached(clientId: string) {
        const entry = this.cache.get(clientId);
        return entry && entry.expiresAt > this.now() ? entry.metadata : undefined;
    }

    /**
     * The client's document: from the cache while fresh, else fetched.
     * Throws a `CimdError` saying why it can't be used.
     */
    async get(clientId: string): Promise<ClientMetadata> {
        const cached = this.cached(clientId);
        if (cached) {
            return cached;
        }
        const { metadata, maxAgeMs } = await this.fetch(clientId);
        this.cache.delete(clientId);
        if (maxAgeMs > 0) {
            this.cache.set(clientId, {
                metadata,
                expiresAt: this.now() + maxAgeMs,
            });
            // The oldest goes first once the ceiling is reached.
            while (this.cache.size > CACHE_ENTRIES) {
                this.cache.delete(this.cache.keys().next().value!);
            }
        }
        return metadata;
    }

    private async fetch(clientId: string) {
        const problem = clientIdProblem(clientId);
        if (problem) {
            throw new CimdError(problem);
        }
        const url = new URL(clientId);
        const signal = AbortSignal.timeout(this.timeoutMs);
        const failed = (error: unknown): never => {
            if (error instanceof CimdError) {
                throw error;
            }
            throw new CimdError(
                signal.aborted
                    ? 'The client metadata took too long to load.'
                    : 'The client metadata could not be loaded.',
            );
        };
        const addresses = await this.lookup(url.hostname).catch(failed);
        // Every address must be public, so a rebinding answer can't slip in.
        if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
            throw new CimdError('The client metadata host is on a private or special network.');
        }
        const response = await this.request(url, addresses[0], signal).catch(failed);
        try {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400) {
                throw new CimdError('The client metadata URL redirects; it must not.');
            }
            if (status !== 200) {
                throw new CimdError(`The client metadata answered ${status}.`);
            }
            const type = String(response.headers['content-type'] ?? '');
            if (!/^application\/([\w.-]+\+)?json\s*(;|$)/i.test(type)) {
                throw new CimdError('The client metadata is not JSON.');
            }
            const encoding = String(response.headers['content-encoding'] ?? 'identity');
            if (encoding !== 'identity') {
                throw new CimdError('The client metadata must not be compressed.');
            }
            if (Number(response.headers['content-length'] ?? 0) > CIMD_MAX_BYTES) {
                throw new CimdError('The client metadata is too large.');
            }
            const body = await read(response, signal).catch(failed);
            let value: unknown;
            try {
                value = JSON.parse(body.toString('utf8'));
            } catch {
                throw new CimdError('The client metadata is not valid JSON.');
            }
            return {
                metadata: parseClientMetadata(clientId, value),
                maxAgeMs: ttl([response.headers['cache-control']].flat().join(', ') || undefined),
            };
        } finally {
            response.resume();
        }
    }
}

/** The body, up to the cap. */
function read(response: IncomingMessage, signal: AbortSignal) {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const abort = () => {
            response.destroy();
            reject(new CimdError('The client metadata took too long to load.'));
        };
        signal.addEventListener('abort', abort, { once: true });
        response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > CIMD_MAX_BYTES) {
                signal.removeEventListener('abort', abort);
                response.destroy();
                reject(new CimdError('The client metadata is too large.'));
            } else {
                chunks.push(chunk);
            }
        });
        response.on('error', (error) => {
            signal.removeEventListener('abort', abort);
            reject(error);
        });
        response.on('end', () => {
            signal.removeEventListener('abort', abort);
            resolve(Buffer.concat(chunks));
        });
    });
}
