/**
 * The price sync's only way out (CB-195). Every request is a plain GET of
 * a public price list: a generic User-Agent and `Accept`, no cookies, no
 * credentials, no referrer, no redirects, nothing about the workspace,
 * its people or this server. Only the hosts a source names are fetched
 * (a next-page link elsewhere is refused), and a body is cut off at
 * `maxBytes`. `OPS_PRICE_SYNC_URL` (an origin) sends every request there
 * instead, path and query kept: a loopback fake or an offline mirror.
 */

/** Generic on purpose: it names no product, install, person or contact. */
export const PRICE_SYNC_USER_AGENT = 'research-script/0.1';

export interface PriceFetchOptions {
    /** Every request goes to this origin instead (a loopback fake, a mirror). */
    origin?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
}

/** Reads one JSON document from a source's host. */
export type PriceGet = (url: string, hosts: readonly string[]) => Promise<unknown>;

export class PriceFetchError extends Error {}

export function priceFetcher({
    origin,
    fetch = globalThis.fetch,
    timeoutMs = 120_000,
    maxBytes = 64 * 1024 * 1024,
    signal,
}: PriceFetchOptions = {}): PriceGet {
    const target = origin ? new URL(origin) : undefined;
    return async (address, hosts) => {
        const url = new URL(address);
        if (url.protocol !== 'https:' || !hosts.includes(url.hostname)) {
            throw new PriceFetchError(`refused a link to ${url.hostname}`);
        }
        url.port = '';
        if (target) {
            url.protocol = target.protocol;
            url.host = target.host;
        }
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'user-agent': PRICE_SYNC_USER_AGENT,
                accept: 'application/json',
            },
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            redirect: 'error',
            cache: 'no-store',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new PriceFetchError(`HTTP ${response.status}`);
        }
        const declared = Number(response.headers.get('content-length'));
        if (declared > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new PriceFetchError('the list is too large');
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                size += value.byteLength;
                if (size > maxBytes) {
                    await reader.cancel().catch(() => undefined);
                    throw new PriceFetchError('the list is too large');
                }
                chunks.push(value);
            }
        }
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
            throw new PriceFetchError('the list is not JSON');
        }
    };
}

/** `OPS_PRICE_SYNC_URL`: an http(s) origin, or undefined. */
export function priceSyncOrigin(value: string | undefined) {
    const raw = value?.trim();
    if (!raw) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('OPS_PRICE_SYNC_URL must be an http(s) origin, such as http://127.0.0.1:4499.');
    }
    if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username ||
        url.password ||
        (url.pathname !== '/' && url.pathname !== '') ||
        url.search
    ) {
        throw new Error('OPS_PRICE_SYNC_URL must be an http(s) origin, such as http://127.0.0.1:4499.');
    }
    return url.origin;
}
