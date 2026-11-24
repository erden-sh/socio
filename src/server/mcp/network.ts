import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import { MCP_LIMITS } from '@socio/shared/mcp-connections';

import { isPublicAddress } from '../../net/public-address.js';

import { mcpAssert, mcpError } from './errors.js';

export interface McpAddress {
    address: string;
    family: number;
}
export interface McpNetworkOptions {
    lookup?: (hostname: string) => Promise<McpAddress[]>;
    /** Trusted fixture seam; production always uses fresh pinned TLS below. */
    request?: (url: URL, address: McpAddress, init: RequestInit, signal: AbortSignal) => Promise<Response>;
    signal?: AbortSignal;
    maxBytes?: number;
    timeoutMs?: number;
    maxRequests?: number;
    maxTotalBytes?: number;
}
export function mcpUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw mcpError('Enter a public HTTPS MCP server URL.');
    }
    mcpAssert(
        value.length <= 2048 &&
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.hash &&
            !url.search &&
            (!url.port || url.port === '443'),
        'Use public HTTPS on port 443 without credentials, a query or a fragment.',
    );
    const host = url.hostname.toLowerCase();
    const literal = host.replace(/^\[|\]$/g, '');
    mcpAssert(!isIP(literal) || isPublicAddress(literal), 'Private or special network destinations are blocked.');
    mcpAssert(
        !host.endsWith('.') && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local'),
        'Private MCP destinations are not supported.',
    );
    return url;
}
/** Shared DNS policy for pinned server fetches and browser consent destinations.
 * Browser DNS cannot be pinned by Socio: revalidation narrows, but cannot remove,
 * the browser-side DNS rebinding race. Never send tokens to a consent endpoint.
 */
export async function resolvePublicMcpDestination(value: string | URL, options: McpNetworkOptions = {}) {
    const url = oauthUrl(String(value)),
        host = url.hostname.replace(/^\[|\]$/g, '');
    const signal = AbortSignal.any([
        AbortSignal.timeout(Math.min(options.timeoutMs ?? 10000, MCP_LIMITS.requestMs)),
        ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(mcpError('External DNS lookup timed out or was canceled.', 504));
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        const addresses = await Promise.race([
            isIP(host)
                ? Promise.resolve([{ address: host, family: isIP(host) }])
                : (options.lookup ?? ((hostname) => lookup(hostname, { all: true })))(host),
            cancelled,
        ]);
        mcpAssert(
            addresses.length > 0 &&
                addresses.length <= 32 &&
                addresses.every((a) => isIP(a.address) === a.family && isPublicAddress(a.address)),
            'Private or special network destinations are blocked.',
        );
        signal.throwIfAborted();
        return { url, address: addresses[0]! };
    } finally {
        signal.removeEventListener('abort', abort);
    }
}
/** OAuth endpoints may legitimately have static query parameters; never fragments or URL credentials. */
export function oauthUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw mcpError('The server supplied an invalid authorization URL.');
    }
    const query = url.search;
    url.search = '';
    mcpUrl(url.href);
    url.search = query;
    mcpAssert(value.length <= 8192, 'Authorization URL is too long.');
    return url;
}
async function send(url: URL, address: McpAddress, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const headers = Object.fromEntries(new Headers(init.headers));
    const body = init.body;
    mcpAssert(
        body === undefined ||
            body === null ||
            typeof body === 'string' ||
            body instanceof URLSearchParams ||
            body instanceof Uint8Array,
        'Unsupported MCP request body.',
    );
    const bytes = body instanceof URLSearchParams ? body.toString() : body;
    mcpAssert(bytes == null || Buffer.byteLength(bytes) <= MCP_LIMITS.catalogBytes, 'MCP request is too large.');
    return new Promise((resolve, reject) => {
        const agent = new https.Agent({
            keepAlive: false,
            rejectUnauthorized: true,
        });
        const request = https.request(
            url,
            {
                method: init.method ?? 'GET',
                signal,
                agent,
                rejectUnauthorized: true,
                headers: {
                    ...headers,
                    'accept-encoding': 'identity',
                    'user-agent': 'Socio MCP client',
                },
                lookup: (_hostname, options, callback) =>
                    options.all ? callback(null, [address]) : callback(null, address.address, address.family),
            },
            (response) => {
                response.once('close', () => agent.destroy());
                const status = response.statusCode ?? 502;
                if ([204, 205, 304].includes(status)) {
                    response.resume();
                    resolve(
                        new Response(null, {
                            status,
                            headers: response.headers as Record<string, string>,
                        }),
                    );
                    return;
                }
                resolve(
                    new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
                        status,
                        headers: Object.fromEntries(
                            Object.entries(response.headers)
                                .filter(([, v]) => v !== undefined)
                                .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value!]),
                        ),
                    }),
                );
            },
        );
        request.once('error', () => {
            agent.destroy();
            reject(
                mcpError(
                    signal.aborted
                        ? 'External request was canceled or timed out.'
                        : 'Could not reach the external server.',
                    502,
                ),
            );
        });
        request.end(bytes);
    });
}
/** All MCP/OAuth traffic, including discovery/token calls, uses this gate. No proxy/global agent, cookies or redirects. */
export function guardedMcpFetch(options: McpNetworkOptions = {}): typeof fetch {
    let requests = 0,
        totalBytes = 0;
    return async (input, init = {}) => {
        mcpAssert(++requests <= (options.maxRequests ?? 18), 'External connection exceeded its request budget.');
        const original = input instanceof Request ? input.url : String(input);
        const url = oauthUrl(original);
        const signal = AbortSignal.any([
            AbortSignal.timeout(options.timeoutMs ?? MCP_LIMITS.requestMs),
            ...(options.signal ? [options.signal] : []),
            ...(init.signal ? [init.signal] : []),
        ]);
        signal.throwIfAborted();
        const headers = new Headers(init.headers);
        for (const key of ['cookie', 'proxy-authorization', 'host', 'x-api-key']) {
            mcpAssert(!headers.has(key), 'Ambient credentials are forbidden on external connections.');
        }
        mcpAssert(!(input instanceof Request), 'Use an explicit MCP URL and request options.');
        const { address } = await resolvePublicMcpDestination(url, {
            ...options,
            signal,
        });
        signal.throwIfAborted();
        const response = await (options.request ?? send)(
            url,
            address,
            { ...init, headers, redirect: 'error', credentials: 'omit' },
            signal,
        );
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw mcpError('External redirects are not followed.', 502);
        }
        if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
            await response.body?.cancel();
            throw mcpError('Compressed MCP responses are not supported.');
        }
        const max = options.maxBytes ?? MCP_LIMITS.resultBytes;
        if (!response.body) {
            return response;
        }
        let bytes = 0,
            frames = 0,
            frameText = '';
        const sse = response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream';
        const decoder = new TextDecoder();
        const body = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    bytes += chunk.byteLength;
                    totalBytes += chunk.byteLength;
                    mcpAssert(
                        totalBytes <= (options.maxTotalBytes ?? 2 * MCP_LIMITS.resultBytes),
                        'External connection exceeded its response budget.',
                    );
                    if (sse) {
                        frameText += decoder.decode(chunk, { stream: true });
                        for (
                            let boundary = frameText.match(/\r\n\r\n|\n\n|\r\r/);
                            boundary;
                            boundary = frameText.match(/\r\n\r\n|\n\n|\r\r/)
                        ) {
                            mcpAssert(
                                Buffer.byteLength(frameText.slice(0, boundary.index)) <= 64 * 1024 && ++frames <= 100,
                                'External event stream exceeds its frame limit.',
                            );
                            frameText = frameText.slice(boundary.index! + boundary[0].length);
                        }
                        mcpAssert(
                            Buffer.byteLength(frameText) <= 64 * 1024,
                            'External event stream exceeds its frame limit.',
                        );
                    }
                    if (bytes > max) {
                        throw mcpError('External response exceeds its size limit.', 502);
                    }
                    signal.throwIfAborted();
                    controller.enqueue(chunk);
                },
            }),
            { signal },
        );
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
}
