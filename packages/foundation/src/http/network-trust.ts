import type { IncomingMessage } from 'node:http';

import type { Context, MiddlewareHandler } from 'hono';

import { inSubnet, parseSubnet } from './subnet.js';

/**
 * Which networks the app trusts, and how far (CB-309).
 *
 * The app sits on several overlays. Socios' computers reach it on the
 * `computers` network for the data API only, and they have open internet,
 * so a prompt-injected shell there must not reach sign-in or the rest of
 * the API, nor choose the client address the rate limits count.
 *
 * - `COMPUTERS_SUBNET`: requests whose TCP peer is in it reach only
 *   `COMPUTER_ROUTES`; everything else is a 403 before any route runs.
 * - `TRUSTED_PROXY_SUBNETS` (comma-separated): with `AUTH_TRUST_PROXY`,
 *   `X-Forwarded-For` counts only when the peer is in one of them (the
 *   reverse proxy's network). Unset, any peer outside `COMPUTERS_SUBNET`
 *   counts as the proxy, as before; a warning says so at start.
 */
export interface NetworkTrust {
    computers?: { base: number; mask: number };
    proxies: { base: number; mask: number }[];
}

type Env = Record<string, string | undefined>;

export function networkTrustFromEnv(env: Env): NetworkTrust {
    const computersText = env.COMPUTERS_SUBNET?.trim();
    const computers = computersText ? parseSubnet(computersText) : undefined;
    if (computersText && !computers) {
        throw new Error('COMPUTERS_SUBNET must be an IPv4 subnet, e.g. 10.0.28.0/24.');
    }
    const proxies = (env.TRUSTED_PROXY_SUBNETS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
            const subnet = parseSubnet(value);
            if (!subnet) {
                throw new Error(`TRUSTED_PROXY_SUBNETS: "${value}" is not an IPv4 subnet, e.g. 10.0.4.0/24.`);
            }
            return subnet;
        });
    return { ...(computers ? { computers } : {}), proxies };
}

/** The TCP peer of a request (undefined in tests that call `app.request`). */
export function peerAddress(c: Context) {
    return (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress;
}

/** Whether the peer may speak for the client in `X-Forwarded-For`. */
export function peerIsProxy(trust: NetworkTrust, peer: string | undefined) {
    if (inSubnet(trust.computers, peer)) {
        return false;
    }
    if (!trust.proxies.length) {
        return true;
    }
    return trust.proxies.some((subnet) => inSubnet(subnet, peer));
}

/**
 * The client address for rate limits and audit: the last forwarded hop
 * when the proxy is trusted and the peer is the proxy, else the socket.
 */
export function clientAddress(c: Context, trustProxy: boolean, trust: NetworkTrust) {
    const peer = peerAddress(c);
    if (trustProxy && peerIsProxy(trust, peer)) {
        const forwarded = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
        if (forwarded) {
            return forwarded;
        }
    }
    return peer;
}

/**
 * What a socio's computer may call: the data API and its job API
 * (`CB_DATA_URL`), the health check its startup wait polls, and the actor
 * routes mini apps and plugins use for approvals.
 */
export const COMPUTER_ROUTES: readonly RegExp[] = [
    /^\/healthz$/,
    /^\/api\/data(?:\/|$)/,
    /^\/api\/apps\/actor(?:\/|$)/,
    /^\/api\/plugins\/[^/]+\/actor(?:\/|$)/,
];

export const computerMayCall = (path: string) => COMPUTER_ROUTES.some((route) => route.test(path));

/** Refuses requests from the computers network outside `COMPUTER_ROUTES`. */
export function computersGuard(trust: NetworkTrust): MiddlewareHandler {
    return async (c, next) => {
        if (inSubnet(trust.computers, peerAddress(c)) && !computerMayCall(c.req.path)) {
            return c.json({ error: 'Not available from a socio’s computer.' }, 403);
        }
        await next();
    };
}
