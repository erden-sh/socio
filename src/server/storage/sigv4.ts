import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for S3's REST API, header signing only (CB-54).
 * The scope is deliberately small: path-style URLs, one region, no
 * presigned URLs (bytes always pass through the app, which decrypts them)
 * and no chunked payloads. Checked against AWS's published example
 * (tests/sigv4.test.ts).
 */
export interface SignInput {
    method: string;
    url: URL | string;
    /** Extra headers to sign (e.g. `range`); host and the x-amz ones always are. */
    headers?: Record<string, string>;
    /** Hex SHA-256 of the body (`sha256Hex(new Uint8Array())` for none). */
    bodyHash: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service?: string;
    now?: Date;
}

export const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Uint8Array | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986: everything but unreserved characters is percent-encoded. */
export const uriEncode = (value: string) =>
    encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** Each path segment encoded once (S3 keys are not normalized). */
function canonicalUri(pathname: string) {
    return (
        pathname
            .split('/')
            .map((segment) => uriEncode(decodeURIComponent(segment)))
            .join('/') || '/'
    );
}

/** Names and values encoded, sorted by name then value. */
export function canonicalQuery(params: URLSearchParams) {
    return [...params]
        .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
        .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
        .map(([name, value]) => `${name}=${value}`)
        .join('&');
}

/** `20130524T000000Z`. */
export const amzDate = (now: Date) =>
    now
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');

/**
 * The headers to send: the given ones plus `host`, `x-amz-date`,
 * `x-amz-content-sha256` and `authorization`, all lowercase.
 */
export function signRequest(input: SignInput): Record<string, string> {
    const url = typeof input.url === 'string' ? new URL(input.url) : input.url;
    const service = input.service ?? 's3';
    const stamp = amzDate(input.now ?? new Date());
    const date = stamp.slice(0, 8);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
        headers[name.toLowerCase()] = value;
    }
    headers.host = url.host;
    headers['x-amz-date'] = stamp;
    headers['x-amz-content-sha256'] = input.bodyHash;
    const names = Object.keys(headers).sort();
    const canonical = [
        input.method.toUpperCase(),
        canonicalUri(url.pathname),
        canonicalQuery(url.searchParams),
        names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''),
        names.join(';'),
        input.bodyHash,
    ].join('\n');
    const scope = `${date}/${input.region}/${service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), service), 'aws4_request');
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    return {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    };
}
