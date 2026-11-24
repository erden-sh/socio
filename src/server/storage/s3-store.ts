import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { checkKey, checkPrefix, StorageUnavailableError } from '@socio/data/object-store';
import type { S3Settings } from '@socio/data/storage/settings';
import { writeAll } from '@socio/foundation/keys/sealed-files';

import type { S3ObjectStoreShape, S3StoreOptions } from './contract.js';
import { sha256Hex, signRequest, uriEncode } from './sigv4.js';

const EMPTY = new Uint8Array();
const EMPTY_HASH = sha256Hex(EMPTY);
const PAGE = 1000;

/** A request body read from a file as it is sent (CB-378): its size and SHA-256 are known first. */
interface FileBody {
    path: string;
    size: number;
    hash: string;
}
/** The SHA-256 of a file, a chunk at a time. */
async function sha256File(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
        hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
}

const unescapeXml = (text: string) =>
    text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
    const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
    return match ? unescapeXml(match[1]) : undefined;
};
/** Without quotes: stores differ on whether they keep them. */
const etagOf = (value: string | null | undefined) => (value ? value.replace(/^"|"$/g, '') : undefined);

/**
 * Objects in a bucket of any S3-compatible store (CB-54; SeaweedFS's S3
 * gateway in the bundled stack), over `fetch` with in-house SigV4, path-style
 * or virtual-hosted. Every request has a
 * timeout; network errors and 5xx answers are retried with backoff (PUTs
 * too: they write the same sealed bytes to the same key). The payload hash
 * is the body's real SHA-256, so the server checks integrity as well.
 * Requests carry no metadata headers and no content types but
 * `application/octet-stream`. Errors never name keys or credentials.
 */
export class S3ObjectStore implements S3ObjectStoreShape {
    readonly driver = 's3' as const;
    private endpoint: string;
    private fetch: typeof fetch;
    constructor(
        private settings: S3Settings,
        private options: S3StoreOptions = {},
    ) {
        this.endpoint = settings.endpoint.replace(/\/+$/, '');
        this.fetch = options.fetch ?? fetch;
    }
    private url(key?: string, query: Record<string, string> = {}) {
        const pathStyle = this.settings.forcePathStyle !== false;
        const segments = key ? key.split('/') : [];
        const path = (pathStyle ? [this.settings.bucket, ...segments] : segments).map(uriEncode).join('/');
        // Encoded as SigV4 encodes the canonical query, so no value changes in transit.
        const search = Object.entries(query)
            .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
            .sort()
            .join('&');
        const base = new URL(this.endpoint);
        // Virtual-hosted: the bucket is the host's first label (signed as `host`).
        if (!pathStyle) {
            base.hostname = `${this.settings.bucket}.${base.hostname}`;
        }
        return new URL(`${base.origin}/${path}${search ? `?${search}` : ''}`);
    }
    /**
     * One request, retried; a Response for any status below 500. A file
     * body is read again for each attempt, and never held whole.
     */
    private async request(
        method: string,
        url: URL,
        body: Uint8Array | FileBody = EMPTY,
        contentType = 'application/octet-stream',
    ): Promise<Response> {
        const retries = this.options.retries ?? 2;
        const backoff = this.options.backoffMs ?? 250;
        const file = body instanceof Uint8Array ? undefined : body;
        const length = file ? file.size : (body as Uint8Array).length;
        const bodyHash = file ? file.hash : length ? sha256Hex(body as Uint8Array) : EMPTY_HASH;
        let failure = 'no answer';
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt) {
                await new Promise((resolve) => setTimeout(resolve, backoff * 2 ** (attempt - 1)));
            }
            const headers = signRequest({
                method,
                url,
                headers: length ? { 'content-type': contentType } : {},
                bodyHash,
                accessKeyId: this.settings.accessKeyId,
                secretAccessKey: this.settings.secretAccessKey,
                region: this.settings.region,
            });
            // Undici sets Host from the URL; it is signed, not sent twice.
            delete headers.host;
            const stream = file && length ? createReadStream(file.path) : undefined;
            if (stream) {
                // A stream has no length of its own; S3 wants one.
                headers['content-length'] = String(length);
            }
            try {
                const response = await this.fetch(url, {
                    method,
                    headers,
                    body: stream
                        ? (Readable.toWeb(stream) as ReadableStream<Uint8Array>)
                        : // Any Uint8Array is a valid body; the DOM types want an ArrayBuffer one.
                          method === 'PUT' && length && !file
                          ? (body as Uint8Array<ArrayBuffer>)
                          : undefined,
                    ...(stream ? { duplex: 'half' } : {}),
                    signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
                } as RequestInit);
                if (response.status < 500) {
                    return response;
                }
                failure = `HTTP ${response.status}`;
                await response.arrayBuffer().catch(() => undefined);
            } catch (error) {
                failure = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'unreachable';
            } finally {
                stream?.destroy();
            }
        }
        throw new StorageUnavailableError(`Object storage ${method} failed: ${failure}.`);
    }
    /** Any answer but the expected ones is a failure (403: the key pair). */
    private async refused(method: string, response: Response): Promise<never> {
        await response.arrayBuffer().catch(() => undefined);
        throw new StorageUnavailableError(`Object storage ${method} failed: HTTP ${response.status}.`);
    }
    async put(key: string, body: Uint8Array): Promise<void> {
        const response = await this.request('PUT', this.url(checkKey(key)), body);
        if (!response.ok) {
            return this.refused('PUT', response);
        }
        await response.arrayBuffer().catch(() => undefined);
    }
    async get(key: string) {
        const response = await this.request('GET', this.url(checkKey(key)));
        if (response.status === 404) {
            await response.arrayBuffer().catch(() => undefined);
            return undefined;
        }
        if (!response.ok) {
            return this.refused('GET', response);
        }
        try {
            return new Uint8Array(await response.arrayBuffer());
        } catch {
            throw new StorageUnavailableError('Object storage GET failed: the body was cut off.');
        }
    }
    /** `put` of a file, read as it is sent (twice: its SHA-256 is signed first). */
    async putFile(key: string, path: string) {
        const url = this.url(checkKey(key));
        const { size } = await stat(path);
        const response = await this.request('PUT', url, {
            path,
            size,
            hash: size ? await sha256File(path) : EMPTY_HASH,
        });
        if (!response.ok) {
            return this.refused('PUT', response);
        }
        await response.arrayBuffer().catch(() => undefined);
        return size;
    }
    /** `get` into a file, written as it arrives. */
    async getFile(key: string, path: string) {
        const response = await this.request('GET', this.url(checkKey(key)));
        if (response.status === 404) {
            await response.arrayBuffer().catch(() => undefined);
            return undefined;
        }
        if (!response.ok) {
            return this.refused('GET', response);
        }
        const out = await open(path, 'w', 0o600);
        let size = 0;
        try {
            await out.chmod(0o600);
            if (!response.body) {
                return 0;
            }
            const chunks = response.body[Symbol.asyncIterator]();
            for (;;) {
                let next: IteratorResult<Uint8Array>;
                try {
                    next = await chunks.next();
                } catch {
                    throw new StorageUnavailableError('Object storage GET failed: the body was cut off.');
                }
                if (next.done) {
                    return size;
                }
                try {
                    await writeAll(out, next.value);
                } catch (error) {
                    await chunks.return?.();
                    throw error;
                }
                size += next.value.length;
            }
        } finally {
            await out.close();
        }
    }
    async head(key: string) {
        const response = await this.request('HEAD', this.url(checkKey(key)));
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            return this.refused('HEAD', response);
        }
        return {
            size: Number(response.headers.get('content-length') ?? 0),
            etag: etagOf(response.headers.get('etag')),
        };
    }
    async delete(key: string) {
        const response = await this.request('DELETE', this.url(checkKey(key)));
        if (!response.ok && response.status !== 404) {
            return this.refused('DELETE', response);
        }
        await response.arrayBuffer().catch(() => undefined);
    }
    async list(prefix: string, cursor?: string) {
        const response = await this.request(
            'GET',
            this.url(undefined, {
                'list-type': '2',
                'max-keys': String(PAGE),
                prefix: checkPrefix(prefix),
                ...(cursor ? { 'continuation-token': cursor } : {}),
            }),
        );
        if (!response.ok) {
            return this.refused('LIST', response);
        }
        const xml = await response.text();
        // Narrow regexes are enough: keys are our own charset (keys.ts).
        const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, entry]) => {
            const etag = etagOf(tag(entry, 'ETag'));
            const modified = Date.parse(tag(entry, 'LastModified') ?? '');
            return {
                key: tag(entry, 'Key') ?? '',
                size: Number(tag(entry, 'Size') ?? 0),
                ...(etag ? { etag } : {}),
                ...(Number.isNaN(modified) ? {} : { modified }),
            };
        });
        const next = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
        return next ? { keys, next } : { keys };
    }
    /**
     * HEAD the bucket, then create it when missing: in its region, which S3
     * wants named (LocationConstraint) for any region but us-east-1.
     */
    async ensureReady() {
        const head = await this.request('HEAD', this.url());
        if (head.ok) {
            return;
        }
        if (head.status !== 404) {
            return this.refused('HEAD bucket', head);
        }
        const region = this.settings.region;
        const created = await this.request(
            'PUT',
            this.url(),
            region === 'us-east-1'
                ? EMPTY
                : new TextEncoder().encode(
                      `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`,
                  ),
            'application/xml',
        );
        // 409: created meanwhile (BucketAlreadyOwnedByYou).
        if (!created.ok && created.status !== 409) {
            return this.refused('PUT bucket', created);
        }
        await created.arrayBuffer().catch(() => undefined);
    }
}
