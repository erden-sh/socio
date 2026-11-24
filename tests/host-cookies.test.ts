import { expect, it, vi } from 'vitest';

import { HostCookies } from '../src/server/auth/host-cookies.js';

const headers = (cookie: string) => new Headers({ cookie, accept: '*/*' });

it('shows Better Auth only __Host-cb.* cookies, under their __Secure- names', () => {
    const cookies = new HostCookies(true);
    const seen = cookies.incoming(
        headers(
            '__Secure-cb.session_token=tossed; cb.session_token=tossed2; __Host-cb.session_token=mine.sig; sidebar_state=true; __Host-cb.state=a=b',
        ),
    );
    expect(seen.get('cookie')).toBe('__Secure-cb.session_token=mine.sig; __Secure-cb.state=a=b');
    expect(seen.get('accept')).toBe('*/*');
    // Nothing of its own left: no Cookie header at all.
    expect(cookies.incoming(headers('__Secure-cb.session_token=x; cb.session_token=y')).has('cookie')).toBe(false);
    expect(cookies.hasSession(headers('__Secure-cb.session_token=x'))).toBe(false);
    expect(cookies.hasSession(headers('a=1; __Host-cb.session_token=x'))).toBe(true);
});

it('renames __Secure-cb.* Set-Cookies that meet the __Host- rules, and logs the rest once', () => {
    const warn = vi.fn();
    const cookies = new HostCookies(true, 'cb', warn);
    const ok = '__Secure-cb.session_token=v.sig; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Strict';
    const domain = '__Secure-cb.session_data=v; Domain=brain.example.com; Path=/; Secure';
    const path = '__Secure-cb.state=v; Path=/api; Secure';
    const insecure = '__Secure-cb.other=v; Path=/';
    const foreign = 'something=else; Path=/';
    expect(cookies.outgoing([ok, domain, path, insecure, foreign])).toEqual([
        `__Host-${ok.slice('__Secure-'.length)}`,
        domain,
        path,
        insecure,
        foreign,
    ]);
    expect(warn).toHaveBeenCalledTimes(3);
    cookies.outgoing([domain, path]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toMatch(/__Secure-cb\.session_data/);
});

it('changes nothing over http', () => {
    const cookies = new HostCookies(false);
    expect(cookies.sessionCookie).toBe('cb.session_token');
    const sent = headers('cb.session_token=x; __Host-cb.session_token=y');
    expect(cookies.incoming(sent)).toBe(sent);
    const set = ['cb.session_token=x; Path=/; HttpOnly'];
    expect(cookies.outgoing(set)).toEqual(set);
    const response = new Response(null, { headers: { 'set-cookie': set[0] } });
    expect(cookies.response(response)).toBe(response);
});

it('rewrites a response, keeping its status, body and other headers', async () => {
    const cookies = new HostCookies(true);
    const response = new Response('{"ok":true}', {
        status: 302,
        headers: [
            ['location', 'https://brain.example.com/'],
            ['set-cookie', '__Secure-cb.session_token=a; Path=/; Secure; HttpOnly'],
            ['set-cookie', '__Secure-cb.state=; Max-Age=0; Path=/; Secure'],
        ],
    });
    const out = cookies.response(response);
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('https://brain.example.com/');
    expect(out.headers.getSetCookie()).toEqual([
        '__Host-cb.session_token=a; Path=/; Secure; HttpOnly',
        '__Host-cb.state=; Max-Age=0; Path=/; Secure',
    ]);
    expect(await out.text()).toBe('{"ok":true}');
});
