import type { IncomingMessage } from 'node:http';

import type { Context } from 'hono';

const LOOPBACK_ADDRESS = /^(127\.|::1$|::ffff:127\.)/;
/** Headers a reverse proxy, CDN or tunnel adds when it forwards someone else's request. */
const FORWARDING_HEADERS = [
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'x-client-ip',
    'x-cluster-client-ip',
    'true-client-ip',
    'cf-connecting-ip',
    'fastly-client-ip',
    'via',
];

/** `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`, with or without a port. */
export function loopbackHost(host: string | undefined) {
    if (!host) {
        return false;
    }
    const name = host
        .trim()
        .toLowerCase()
        .replace(/:\d+$/, '')
        .replace(/^\[(.*)\]$/, '$1');
    return (
        name === 'localhost' ||
        name.endsWith('.localhost') ||
        name === '::1' ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
    );
}

/**
 * A request from this machine itself: a loopback peer, a loopback Host and
 * no proxy's forwarding headers. A proxy or tunnel on this host connects from
 * loopback too, but forwards a public Host (or adds forwarding headers), so
 * it doesn't pass. In-process requests (tests) have no socket and count as
 * local when they carry no forwarding headers.
 */
export function localRequest(c: Context) {
    if (FORWARDING_HEADERS.some((name) => c.req.header(name))) {
        return false;
    }
    const address = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress;
    if (address === undefined) {
        return true;
    }
    return LOOPBACK_ADDRESS.test(address) && loopbackHost(c.req.header('host') ?? new URL(c.req.url).host);
}
