import { describe, expect, it } from 'vitest';

import { defaultPath, EARLIEST, pathMatches, readSetCookie, splitSetCookie } from '../../src/net/set-cookie';

import { LOCAL_ORIGIN, ORIGIN, T0 } from './helpers';

// The Set-Cookie splitter and parser.

const HTTPS = new URL(`${ORIGIN}/api/auth/sign-in/email`);
const HTTP = new URL(`${LOCAL_ORIGIN}/api/auth/sign-in/email`);
const read = (header: string, request = HTTPS) => readSetCookie(header, request, T0);
const DAY_MS = 86_400_000;

describe('splitSetCookie', () => {
    it("splits iOS's joined form only at a comma followed by a cookie's name=", () => {
        const joined = [
            '__Host-cb.session_token=t1.c2ln%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Strict',
            '__Host-cb.session_data=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure',
            'theme=dark; Expires=Thursday, 03-Dec-26 09:00:00 GMT; Path=/',
            'lang=en',
        ];
        expect(splitSetCookie(joined.join(', '))).toEqual(joined);
        // No space or a tab after the comma, as some stacks join them.
        expect(splitSetCookie('a=1; Path=/,b=2,\tc=3')).toEqual(['a=1; Path=/', 'b=2', 'c=3']);
    });

    it('keeps a comma that no name= follows: in a date, or in a value', () => {
        expect(splitSetCookie('a=1; Expires=Thu, 05 Nov 2026 09:00:00 GMT')).toEqual([
            'a=1; Expires=Thu, 05 Nov 2026 09:00:00 GMT',
        ]);
        expect(splitSetCookie('list=1,2,3; Path=/')).toEqual(['list=1,2,3; Path=/']);
        expect(splitSetCookie('')).toEqual([]);
    });
});

describe('readSetCookie', () => {
    it('reads the session cookie Better Auth sets over https, its value kept as sent', () => {
        expect(
            read('__Host-cb.session_token=t1.c2ln%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Strict'),
        ).toEqual({
            name: '__Host-cb.session_token',
            value: 't1.c2ln%3D',
            path: '/',
            secure: true,
            expiresAt: T0 + 7 * DAY_MS,
        });
        expect(read('q="a b%20c=="; Path=/')?.value).toBe('"a b%20c=="');
        expect(read('  spaced  =  value  ; Path=/')).toMatchObject({ name: 'spaced', value: 'value' });
    });

    it('reads attribute names in any case, and the last of each', () => {
        expect(read('a=1; MAX-AGE=60; pAtH=/api; SECURE')).toEqual({
            name: 'a',
            value: '1',
            path: '/api',
            secure: true,
            expiresAt: T0 + 60_000,
        });
        expect(read('a=1; Max-Age=60; max-age=120')?.expiresAt).toBe(T0 + 120_000);
        expect(read('a=1; Path=/api; Path=/')?.path).toBe('/');
    });

    it('lets Max-Age win over Expires, in either order', () => {
        const expires = 'Expires=Wed, 02 Dec 2026 09:00:00 GMT';
        expect(read(`a=1; ${expires}; Max-Age=60`)?.expiresAt).toBe(T0 + 60_000);
        expect(read(`a=1; Max-Age=60; ${expires}`)?.expiresAt).toBe(T0 + 60_000);
        expect(read(`a=1; ${expires}`)?.expiresAt).toBe(Date.UTC(2026, 11, 2, 9));
        // A Max-Age that isn't a whole number is ignored, so Expires counts.
        expect(read(`a=1; Max-Age=1.5; ${expires}`)?.expiresAt).toBe(Date.UTC(2026, 11, 2, 9));
        expect(read('a=1; Max-Age=soon')?.expiresAt).toBeNull();
        expect(read('a=1; Expires=someday')?.expiresAt).toBeNull();
    });

    it('deletes with a Max-Age of 0 or less, or an Expires in the past', () => {
        expect(read('a=; Max-Age=0; Path=/')?.expiresAt).toBe(EARLIEST);
        expect(read('a=; Max-Age=-1; Path=/')?.expiresAt).toBe(EARLIEST);
        expect(read('a=; Max-Age=0; Expires=Wed, 02 Dec 2026 09:00:00 GMT')?.expiresAt).toBe(EARLIEST);
        expect(read('a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT')?.expiresAt).toBeLessThanOrEqual(T0);
    });

    it('lives at most 400 days, from Max-Age or Expires', () => {
        expect(read('a=1; Max-Age=99999999999')?.expiresAt).toBe(T0 + 400 * DAY_MS);
        expect(read('a=1; Expires=Fri, 01 Jan 2100 00:00:00 GMT')?.expiresAt).toBe(T0 + 400 * DAY_MS);
    });

    it('has no expiry with neither Max-Age nor Expires', () => {
        expect(read('a=1; Path=/')?.expiresAt).toBeNull();
    });

    it('ignores a header with no name, no =, a control character or too much text', () => {
        for (const header of ['novalue', '=value', 'a=1\r\nX-Injected: yes', 'a\u0000=1', `a=${'x'.repeat(4096)}`]) {
            expect(read(header), header).toBeNull();
        }
    });

    it('takes a Secure cookie only over https', () => {
        expect(read('a=1; Secure', HTTP)).toBeNull();
        expect(read('a=1', HTTP)).toMatchObject({ secure: false });
    });

    it('keeps every cookie host-only: a Domain over the host is accepted, any other refuses it', () => {
        const host = { name: 'a', value: '1', path: '/', secure: false, expiresAt: null };
        expect(read('a=1; Path=/; Domain=brain.example.test')).toEqual(host);
        expect(read('a=1; Path=/; Domain=.Example.Test')).toEqual(host);
        expect(read('a=1; Path=/; Domain=')).toEqual(host);
        expect(read('a=1; Domain=evil.example.test')).toBeNull();
        expect(read('a=1; Domain=ample.test')).toBeNull();
        expect(read('a=1; Domain=sub.brain.example.test')).toBeNull();
        expect(readSetCookie('a=1; Domain=0.0.1', new URL('http://127.0.0.1:4352/'), T0)).toBeNull();
    });

    it('holds __Host- cookies to Secure, Path=/ and no Domain, over https, whatever the case of the prefix', () => {
        expect(read('__Host-a=1; Secure; Path=/')).toMatchObject({ name: '__Host-a', path: '/', secure: true });
        expect(read('__Host-a=1; Path=/')).toBeNull();
        expect(read('__Host-a=1; Secure')).toBeNull(); // the default path here is /api/auth/sign-in
        expect(read('__Host-a=1; Secure; Path=/api')).toBeNull();
        expect(read('__Host-a=1; Secure; Path=/; Domain=brain.example.test')).toBeNull();
        expect(read('__host-a=1; Path=/')).toBeNull();
        expect(read('__HOST-a=1; Secure; Path=/')).toMatchObject({ name: '__HOST-a' });
        expect(read('__Host-a=1; Secure; Path=/', HTTP)).toBeNull();
        // A clearing cookie that breaks the rules clears nothing: it is ignored like any other.
        expect(read('__Host-cb.session_token=; Max-Age=0; Path=/')).toBeNull();
    });

    it('holds __Secure- cookies to Secure, over https', () => {
        expect(read('__Secure-a=1; Secure; Path=/api; Domain=example.test')).toMatchObject({ path: '/api' });
        expect(read('__Secure-a=1')).toBeNull();
        expect(read('__secure-a=1; Path=/')).toBeNull();
        expect(read('__Secure-a=1; Secure', HTTP)).toBeNull();
    });

    it('takes the request path’s directory when Path is missing or isn’t a path', () => {
        expect(read('a=1')?.path).toBe('/api/auth/sign-in');
        expect(read('a=1; Path=api')?.path).toBe('/api/auth/sign-in');
        expect(read('a=1; Path=/x; Path=')?.path).toBe('/api/auth/sign-in');
        expect(readSetCookie('a=1', new URL(`${ORIGIN}/healthz`), T0)?.path).toBe('/');
    });
});

describe('paths', () => {
    it('gives the default path as RFC 6265 does', () => {
        expect(defaultPath('/')).toBe('/');
        expect(defaultPath('/api')).toBe('/');
        expect(defaultPath('/api/state')).toBe('/api');
        expect(defaultPath('/api/auth/')).toBe('/api/auth');
        expect(defaultPath('')).toBe('/');
    });

    it('matches a request path to a cookie path on whole segments', () => {
        expect(pathMatches('/', '/api/state')).toBe(true);
        expect(pathMatches('/api', '/api')).toBe(true);
        expect(pathMatches('/api', '/api/state')).toBe(true);
        expect(pathMatches('/api/', '/api/state')).toBe(true);
        expect(pathMatches('/api', '/apis')).toBe(false);
        expect(pathMatches('/api/state', '/api')).toBe(false);
    });
});
