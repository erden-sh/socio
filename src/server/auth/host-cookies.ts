/**
 * `__Host-` names for Better Auth's cookies over https.
 *
 * Better Auth names its secure cookies `__Secure-cb.<name>` and can't use
 * the `__Host-` prefix. A `__Secure-` cookie may carry a Domain, so a page
 * on any subdomain of the app's host (a mini app on
 * `x.brain.example`) could set `__Secure-cb.session_token` (or
 * `cb.session_token`) with `Domain=brain.example` and the browser would
 * send it to the app: cookie tossing (a session swap, a login CSRF). A
 * `__Host-` cookie is host-only by rule (Secure, Path=/, no Domain), so
 * nothing on another host can set one the app would receive.
 *
 * So over https the provider renames every `__Secure-cb.*` cookie Better
 * Auth sets to `__Host-cb.*`, and builds the Cookie header Better Auth sees
 * from the `__Host-cb.*` cookies alone (renamed back), dropping any
 * `__Secure-cb.*` or `cb.*` cookie the browser sent. Over http (local
 * development) both directions are left as they are.
 */
const SECURE = '__Secure-';
const HOST = '__Host-';

export class HostCookies {
    private warned = new Set<string>();

    /**
     * @param secure Better Auth's `useSecureCookies` (an https APP_ORIGIN).
     * @param prefix Better Auth's `cookiePrefix`.
     */
    constructor(
        readonly secure: boolean,
        private prefix = 'cb',
        private warn: (message: string) => void = console.warn,
    ) {}

    /** The session cookie's name in the browser. */
    get sessionCookie() {
        return `${this.secure ? HOST : ''}${this.prefix}.session_token`;
    }

    /** Whether the request carries a session cookie Better Auth would read. */
    hasSession(headers: Headers) {
        return cookiePairs(headers.get('cookie')).some(([name]) => name === this.sessionCookie);
    }

    /** Whether the browser sent Better Auth's cookie `name` (`dont_remember`), under its browser name. */
    hasCookie(headers: Headers, name: string) {
        const full = `${this.secure ? HOST : ''}${this.prefix}.${name}`;
        return cookiePairs(headers.get('cookie')).some(([key]) => key === full);
    }

    /** The session cookie's value as the browser sent it, if it did. */
    sessionValue(headers: Headers): string | undefined {
        return cookiePairs(headers.get('cookie')).find(([name]) => name === this.sessionCookie)?.[1];
    }

    /**
     * The session cookie again, with this value and life, as Better Auth sets
     * it (HttpOnly, SameSite=Strict, Path=/, Secure over https), under the
     * browser's name: a device session's renewal (CB-352).
     */
    sessionSetCookie(value: string, maxAgeSeconds: number): string {
        return [
            `${this.sessionCookie}=${value}`,
            `Max-Age=${maxAgeSeconds}`,
            'Path=/',
            'HttpOnly',
            ...(this.secure ? ['Secure'] : []),
            'SameSite=Strict',
        ].join('; ');
    }

    /**
     * The request headers Better Auth sees. Over https: only `__Host-cb.*`
     * cookies, as `__Secure-cb.*`; every other cookie is dropped, so a cookie
     * planted from a subdomain never reaches it.
     */
    incoming(headers: Headers): Headers {
        if (!this.secure) {
            return headers;
        }
        const out = new Headers(headers);
        const from = `${HOST}${this.prefix}.`;
        const to = `${SECURE}${this.prefix}.`;
        const kept = cookiePairs(headers.get('cookie'))
            .filter(([name]) => name.startsWith(from))
            .map(([name, value]) => `${to}${name.slice(from.length)}=${value}`);
        if (kept.length) {
            out.set('cookie', kept.join('; '));
        } else {
            out.delete('cookie');
        }
        return out;
    }

    /**
     * Set-Cookie headers for the browser. Over https, `__Secure-cb.<name>`
     * becomes `__Host-cb.<name>` when the cookie meets the `__Host-` rules
     * (Secure, Path=/, no Domain); one that doesn't is passed on unchanged
     * and logged once per name (it would then be ignored on the way back).
     */
    outgoing(setCookies: readonly string[]): string[] {
        if (!this.secure) {
            return [...setCookies];
        }
        const from = `${SECURE}${this.prefix}.`;
        return setCookies.map((header) => {
            const name = header.slice(0, header.indexOf('=')).trim();
            if (!name.startsWith(from)) {
                return header;
            }
            const attributes = header
                .split(';')
                .slice(1)
                .map((part) => {
                    const index = part.indexOf('=');
                    return index < 0
                        ? [part.trim().toLowerCase(), '']
                        : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()];
                });
            const has = (key: string) => attributes.some(([k]) => k === key);
            const path = attributes.filter(([k]) => k === 'path').pop()?.[1];
            if (has('domain') || path !== '/' || !has('secure')) {
                if (!this.warned.has(name)) {
                    this.warned.add(name);
                    this.warn(
                        `Auth: the ${name} cookie has a Domain, a Path other than / or no Secure, so it keeps its __Secure- name (and is ignored when it comes back).`,
                    );
                }
                return header;
            }
            return `${HOST}${this.prefix}.${header.slice(from.length)}`;
        });
    }

    /** A response with its Set-Cookie headers renamed (see `outgoing`). */
    response(response: Response): Response {
        if (!this.secure) {
            return response;
        }
        const cookies = response.headers.getSetCookie();
        if (!cookies.length) {
            return response;
        }
        const headers = new Headers(response.headers);
        headers.delete('set-cookie');
        for (const cookie of this.outgoing(cookies)) {
            headers.append('set-cookie', cookie);
        }
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }
}

/** `a=1; b=2` → `[['a', '1'], ['b', '2']]` (values as sent). */
function cookiePairs(header: string | null | undefined) {
    const pairs: [string, string][] = [];
    for (const part of (header ?? '').split(';')) {
        const index = part.indexOf('=');
        if (index < 0) {
            continue;
        }
        const name = part.slice(0, index).trim();
        if (name) {
            pairs.push([name, part.slice(index + 1).trim()]);
        }
    }
    return pairs;
}
