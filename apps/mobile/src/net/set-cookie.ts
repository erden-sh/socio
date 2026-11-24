import { parseCookieDate } from './cookie-date';

// Set-Cookie, read the way a browser's cookie store reads it (RFC 6265, 5.2
// and 5.3, with RFC 6265bis's cookie prefixes and limits), for a jar that
// holds one workspace's origin and sends to it alone:
// - attribute names are case-insensitive, and the last of each counts;
// - Max-Age wins over Expires, and a Max-Age of 0 or less deletes the cookie;
// - values are kept exactly as sent, never decoded;
// - every cookie is host-only: a Domain that covers the host is accepted but
//   widens nothing, and one that doesn't refuses the cookie;
// - a `__Secure-` cookie needs Secure, and a `__Host-` cookie needs Secure,
//   Path=/ and no Domain; a Secure cookie needs https.

/** A cookie in the jar. */
export interface Cookie {
    readonly name: string;
    /** As the server sent it: never decoded, quotes kept. */
    readonly value: string;
    readonly path: string;
    readonly secure: boolean;
    /**
     * When it expires, in the server's clock (milliseconds since the epoch), or
     * null for a cookie with neither Max-Age nor Expires. At or before the
     * server's now, the Set-Cookie deletes the cookie.
     */
    readonly expiresAt: number | null;
}

/** The earliest instant a Date holds: what a Max-Age of 0 or less sets (RFC 6265, 5.2.2). */
export const EARLIEST = -8.64e15;
/** Longest a cookie may live, from Max-Age or Expires (RFC 6265bis, 5.5: 400 days). */
const MAX_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;
/** Longest name and value together, and longest attribute value (RFC 6265bis, 5.6). */
const MAX_NAME_VALUE = 4096;
const MAX_ATTRIBUTE_VALUE = 1024;
/** Control characters, which no name or value may hold: they would break the Cookie header. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x08\x0A-\x1F\x7F]/;
const MAX_AGE = /^-?\d+$/;
const IP_ADDRESS = /^(?:\d+\.){3}\d+$|^\[/;

/**
 * The Set-Cookie headers in one header value, as React Native gives them:
 * its Headers joins repeated headers with `, ` (and iOS joins them natively
 * too), while an Expires date holds a comma of its own
 * (`Expires=Thu, 05 Nov 2026 09:00:00 GMT`). So it splits only at a comma
 * followed by a cookie's `name=`.
 */
export function splitSetCookie(joined: string): string[] {
    const headers: string[] = [];
    let start = 0;
    for (let index = joined.indexOf(','); index !== -1; index = joined.indexOf(',', index + 1)) {
        if (startsCookie(joined, index + 1)) {
            headers.push(joined.slice(start, index));
            start = index + 1;
        }
    }
    headers.push(joined.slice(start));
    return headers.map((header) => header.trim()).filter((header) => header !== '');
}

/** Whether `text` holds `name=` at `from`, after any spaces: a cookie, not the rest of a date. */
function startsCookie(text: string, from: number): boolean {
    let index = from;
    while (text[index] === ' ' || text[index] === '\t') {
        index++;
    }
    const nameStart = index;
    while (index < text.length && !'=;, \t'.includes(text[index] ?? '')) {
        index++;
    }
    return index > nameStart && text[index] === '=';
}

/**
 * The cookie one Set-Cookie header sets for a response to `request`, or null
 * when the jar must ignore it. `serverNow` is the server's time for that
 * response, from its Date header: Max-Age counts from it, and an expiry at or
 * before it means the header deletes the cookie.
 */
export function readSetCookie(header: string, request: URL, serverNow: number): Cookie | null {
    const [pair = '', ...attributes] = header.split(';');
    const equals = pair.indexOf('=');
    if (equals === -1) {
        return null;
    }
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (name === '' || CONTROL.test(name) || CONTROL.test(value) || name.length + value.length > MAX_NAME_VALUE) {
        return null;
    }

    let maxAge: number | undefined;
    let expires: number | undefined;
    let domain: string | undefined;
    let path: string | undefined;
    let secure = false;
    for (const attribute of attributes) {
        const split = attribute.indexOf('=');
        const key = (split === -1 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
        const text = split === -1 ? '' : attribute.slice(split + 1).trim();
        if (text.length > MAX_ATTRIBUTE_VALUE) {
            continue;
        }
        if (key === 'max-age') {
            if (MAX_AGE.test(text)) {
                maxAge = Number(text);
            }
        } else if (key === 'expires') {
            const date = parseCookieDate(text);
            if (date !== null) {
                expires = date;
            }
        } else if (key === 'domain') {
            if (text !== '') {
                domain = (text.startsWith('.') ? text.slice(1) : text).toLowerCase();
            }
        } else if (key === 'path') {
            // One that doesn't start with `/` means the default path, even after a good one.
            path = text.startsWith('/') ? text : undefined;
        } else if (key === 'secure') {
            secure = true;
        }
    }

    if (secure && request.protocol !== 'https:') {
        return null;
    }
    if (domain !== undefined && !domainMatches(request.hostname.toLowerCase(), domain)) {
        return null;
    }
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('__secure-') && !secure) {
        return null;
    }
    if (lowerName.startsWith('__host-') && (!secure || domain !== undefined || path !== '/')) {
        return null;
    }

    let expiresAt: number | null = null;
    if (maxAge !== undefined) {
        expiresAt = maxAge <= 0 ? EARLIEST : serverNow + Math.min(maxAge * 1000, MAX_LIFETIME_MS);
    } else if (expires !== undefined) {
        expiresAt = Math.min(expires, serverNow + MAX_LIFETIME_MS);
    }
    return { name, value, path: path ?? defaultPath(request.pathname), secure, expiresAt };
}

/** RFC 6265, 5.1.3: the host is the domain, or a name under it (never an IP address). */
function domainMatches(host: string, domain: string): boolean {
    return host === domain || (host.endsWith(`.${domain}`) && !IP_ADDRESS.test(host));
}

/** RFC 6265, 5.1.4: the request path's directory, for a cookie with no Path. */
export function defaultPath(requestPath: string): string {
    const last = requestPath.lastIndexOf('/');
    return requestPath.startsWith('/') && last > 0 ? requestPath.slice(0, last) : '/';
}

/** RFC 6265, 5.1.4: whether a cookie with `cookiePath` goes with a request for `requestPath`. */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
    return (
        requestPath === cookiePath ||
        (requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'))
    );
}
