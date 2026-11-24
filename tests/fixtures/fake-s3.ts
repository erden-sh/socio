import { createHash } from 'node:crypto';
import {
    createServer,
    request as httpRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { S3Settings } from '@socio/data/storage/settings';

import { sha256Hex, signRequest } from '../../src/server/storage/sigv4.js';

export interface RecordedS3Request {
    method: string;
    /** The bucket and key, decoded: `company-brain/tenants/main/…` (also when virtual-hosted). */
    path: string;
    /** Whether the bucket came in the host name (virtual-hosted style). */
    virtualHosted: boolean;
    query: Record<string, string>;
    headers: IncomingHttpHeaders;
    body: Buffer;
    /** What the fake answered (403 for a bad signature). */
    status: number;
}

const ACCESS_KEY = 'FAKEACCESSKEY0000001';
const SECRET_KEY = 'fake-secret-key-0123456789abcdefghijklmnop';

const read = (request: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
const xmlError = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * An in-process S3 on loopback for the storage and backup tests (CB-54,
 * CB-63): buckets, PUT/GET/HEAD/DELETE of objects with ETags and
 * LastModified, and ListObjectsV2 (prefix, max-keys, continuation),
 * path-style or virtual-hosted (`<bucket>.<virtualHost>`, reached through
 * `hostFetch`). Outside us-east-1, CreateBucket must name the region in a
 * LocationConstraint, as AWS wants. Every request's SigV4 signature is checked
 * against the key pair (403 on a mismatch, a wrong key or a body that
 * doesn't match its hash), and every request is recorded, so tests can
 * check that nothing but sealed bytes and opaque keys leave the app.
 * Faults: `failNext(n, status, method?)`, `dropNext(n)` (the connection is cut),
 * `delayMs`.
 */
export async function startFakeS3(options: { region?: string; virtualHost?: string } = {}) {
    const region = options.region ?? 'us-east-1';
    const virtualHost = options.virtualHost ?? 's3.test';
    const buckets = new Set<string>();
    /** `bucket/key` → bytes. */
    const objects = new Map<string, Buffer>();
    /** `bucket/key` → when it was last written; objects set directly are new. */
    const modified = new Map<string, number>();
    const etag = (body: Buffer) => createHash('md5').update(body).digest('hex');
    const lastModified = (path: string) => new Date(modified.get(path) ?? 0).toISOString();
    const requests: RecordedS3Request[] = [];
    const faults = {
        fail: 0,
        status: 500,
        /** Only requests of this method count toward `fail`; any when unset. */
        method: undefined as string | undefined,
        drop: 0,
        delayMs: 0,
    };

    const verify = (request: IncomingMessage, url: URL, body: Buffer) => {
        const auth = String(request.headers.authorization ?? '');
        const match = auth.match(
            /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/,
        );
        if (!match || match[1] !== ACCESS_KEY || match[3] !== region) {
            return false;
        }
        const signed = match[4].split(';');
        if (!['host', 'x-amz-date', 'x-amz-content-sha256'].every((name) => signed.includes(name))) {
            return false;
        }
        const hash = String(request.headers['x-amz-content-sha256'] ?? '');
        if (hash !== sha256Hex(body)) {
            return false;
        }
        const stamp = String(request.headers['x-amz-date'] ?? '');
        const now = new Date(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
        if (Number.isNaN(now.getTime()) || stamp.slice(0, 8) !== match[2]) {
            return false;
        }
        const headers = Object.fromEntries(
            signed
                .filter((name) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(name))
                .map((name) => [name, String(request.headers[name] ?? '')]),
        );
        const expected = signRequest({
            method: request.method ?? 'GET',
            url,
            headers,
            bodyHash: hash,
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            region,
            now,
        });
        return expected.authorization === auth;
    };

    const list = (bucket: string, query: URLSearchParams) => {
        const prefix = query.get('prefix') ?? '';
        const max = Math.min(Number(query.get('max-keys') ?? 1000) || 1000, 1000);
        const after = query.get('continuation-token')
            ? Buffer.from(query.get('continuation-token')!, 'base64url').toString()
            : '';
        const keys = [...objects.keys()]
            .filter((path) => path.startsWith(`${bucket}/`))
            .map((path) => path.slice(bucket.length + 1))
            .filter((key) => key.startsWith(prefix) && key > after)
            .sort();
        const page = keys.slice(0, max);
        const truncated = keys.length > page.length;
        return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${page
            .map(
                (key) =>
                    `<Contents><Key>${escape(key)}</Key><LastModified>${lastModified(`${bucket}/${key}`)}</LastModified><ETag>&quot;${etag(objects.get(`${bucket}/${key}`)!)}&quot;</ETag><Size>${objects.get(`${bucket}/${key}`)!.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
            )
            .join(
                '',
            )}${truncated ? `<NextContinuationToken>${Buffer.from(page[page.length - 1]).toString('base64url')}</NextContinuationToken>` : ''}</ListBucketResult>`;
    };

    const handle = async (request: IncomingMessage, response: ServerResponse) => {
        const body = await read(request);
        const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
        const hosted = url.hostname.endsWith(`.${virtualHost}`)
            ? url.hostname.slice(0, -virtualHost.length - 1)
            : undefined;
        const path = decodeURIComponent(hosted ? `${hosted}${url.pathname}` : url.pathname.slice(1)).replace(/\/$/, '');
        const record: RecordedS3Request = {
            method: request.method ?? 'GET',
            path,
            virtualHosted: !!hosted,
            query: Object.fromEntries(url.searchParams),
            headers: request.headers,
            body,
            status: 0,
        };
        requests.push(record);
        const send = (status: number, text = '', headers = {}) => {
            record.status = status;
            response.writeHead(status, headers);
            response.end(text);
        };
        if (faults.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, faults.delayMs));
        }
        if (faults.drop > 0) {
            faults.drop--;
            record.status = -1;
            request.socket.destroy();
            return;
        }
        if (!verify(request, url, body)) {
            return send(403, xmlError('SignatureDoesNotMatch'));
        }
        if (faults.fail > 0 && (!faults.method || faults.method === request.method)) {
            faults.fail--;
            return send(faults.status, xmlError('InternalError'));
        }
        const [bucket, ...rest] = path.split('/');
        const key = rest.join('/');
        const method = request.method;
        if (!key) {
            if (method === 'HEAD') {
                return send(buckets.has(bucket) ? 200 : 404);
            }
            if (method === 'PUT') {
                if (buckets.has(bucket)) {
                    return send(409, xmlError('BucketAlreadyOwnedByYou'));
                }
                // As AWS: us-east-1 takes no constraint, any other region its own.
                const constraint = body
                    .toString('utf8')
                    .match(/<LocationConstraint>([^<]*)<\/LocationConstraint>/)?.[1];
                if ((constraint ?? 'us-east-1') !== region) {
                    return send(400, xmlError('IllegalLocationConstraintException'));
                }
                buckets.add(bucket);
                return send(200);
            }
            if (method === 'GET' && url.searchParams.get('list-type') === '2') {
                if (!buckets.has(bucket)) {
                    return send(404, xmlError('NoSuchBucket'));
                }
                return send(200, list(bucket, url.searchParams), {
                    'content-type': 'application/xml',
                });
            }
            return send(400, xmlError('NotImplemented'));
        }
        if (!buckets.has(bucket)) {
            return send(404, xmlError('NoSuchBucket'));
        }
        const stored = objects.get(`${bucket}/${key}`);
        if (method === 'PUT') {
            objects.set(`${bucket}/${key}`, body);
            modified.set(`${bucket}/${key}`, Date.now());
            return send(200, '', { etag: `"${etag(body)}"` });
        }
        if (method === 'GET') {
            return stored
                ? (() => {
                      record.status = 200;
                      response.writeHead(200, {
                          'content-type': 'application/octet-stream',
                          'content-length': stored.length,
                      });
                      response.end(stored);
                  })()
                : send(404, xmlError('NoSuchKey'));
        }
        if (method === 'HEAD') {
            return stored
                ? send(200, '', {
                      'content-length': stored.length,
                      etag: `"${etag(stored)}"`,
                  })
                : send(404);
        }
        if (method === 'DELETE') {
            objects.delete(`${bucket}/${key}`);
            return send(204);
        }
        return send(400, xmlError('NotImplemented'));
    };

    const server = createServer((request, response) => {
        handle(request, response).catch(() => {
            if (!response.headersSent) {
                response.writeHead(500);
            }
            response.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    /**
     * A `fetch` that sends every request to this fake, keeping the URL's host
     * as the Host header: virtual-hosted URLs (`<bucket>.s3.test`) without DNS.
     */
    const hostFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(String(input instanceof Request ? input.url : input));
        const headers = {
            ...(init?.headers as Record<string, string> | undefined),
            host: target.host,
        };
        // A file the store streams (putFile) comes as a ReadableStream.
        const body =
            init?.body instanceof ReadableStream
                ? await new Response(init.body).arrayBuffer().then((data) => Buffer.from(data))
                : init?.body
                  ? Buffer.from(init.body as Uint8Array)
                  : undefined;
        return new Promise<Response>((resolve, reject) => {
            const outgoing = httpRequest(
                {
                    host: '127.0.0.1',
                    port,
                    method: init?.method ?? 'GET',
                    path: `${target.pathname}${target.search}`,
                    headers,
                    signal: init?.signal ?? undefined,
                },
                (incoming) => {
                    const chunks: Buffer[] = [];
                    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
                    incoming.on('end', () => {
                        const status = incoming.statusCode ?? 500;
                        const empty = [204, 205, 304].includes(status) || init?.method === 'HEAD';
                        resolve(
                            new Response(empty ? null : Buffer.concat(chunks), {
                                status,
                                headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
                                    value === undefined ? [] : [[name, String(value)] as [string, string]],
                                ),
                            }),
                        );
                    });
                    incoming.on('error', reject);
                },
            );
            outgoing.on('error', reject);
            outgoing.end(body);
        });
    }) as typeof fetch;
    return {
        url,
        /** The virtual-hosted endpoint: `http://<virtualHost>:<port>` (use `hostFetch`). */
        virtualUrl: `http://${virtualHost}:${port}`,
        hostFetch,
        buckets,
        objects,
        modified,
        requests,
        faults,
        /** Settings for an S3ObjectStore against this fake. */
        settings: (overrides: Partial<S3Settings> = {}): S3Settings => ({
            endpoint: url,
            bucket: 'company-brain',
            region,
            accessKeyId: ACCESS_KEY,
            secretAccessKey: SECRET_KEY,
            ...overrides,
        }),
        /** The next `n` signed requests (of `method`, when given) get `status`. */
        failNext(n: number, status = 500, method?: string) {
            faults.fail = n;
            faults.status = status;
            faults.method = method;
        },
        /** The next `n` requests have their connection cut. */
        dropNext(n: number) {
            faults.drop = n;
        },
        /** Every stored byte, for checks that no plaintext reached S3. */
        allBytes: () => Buffer.concat([...objects.values()]),
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
export type FakeS3 = Awaited<ReturnType<typeof startFakeS3>>;
