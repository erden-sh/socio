import { Hono } from 'hono';
import { expect, it } from 'vitest';

import type { User } from '@socio/shared/types';

import { signInLinkMessage, signInLinkSubject, SIGN_IN_LINK_SECONDS } from '../src/auth/sign-in-links.js';
import type { AppEnv } from '../src/http/app-env.js';
import { requireAdmin, requireOperator } from '../src/http/guards.js';
import { localRequest } from '../src/http/local-request.js';
import { RateLimits } from '../src/http/rate-limits.js';

// The route guards, RateLimits and localRequest moved here from
// src/server/auth unchanged. These pin what they answer.

const guarded = (guard: typeof requireAdmin, user: User | undefined) => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        if (user) {
            c.set('user', user);
        }
        await next();
    });
    app.post('/change', guard, (c) => c.json({ ok: true }));
    return app.request('/change', { method: 'POST' });
};
const person = (role: User['role']): User => ({ id: role, name: role, role });

it('lets admins through requireAdmin, and answers others 403', async () => {
    expect((await guarded(requireAdmin, person('admin'))).status).toBe(200);
    // A retired `operator` an older release still wrote reads as an admin (CB-390).
    expect((await guarded(requireAdmin, { id: 'o', name: 'o', role: 'operator' as User['role'] })).status).toBe(200);
    for (const user of [person('member'), undefined]) {
        const response = await guarded(requireAdmin, user);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Only an admin can change this.' });
    }
});

it('keeps requireOperator as an alias of requireAdmin (CB-390)', async () => {
    expect(requireOperator).toBe(requireAdmin);
    expect((await guarded(requireOperator, person('admin'))).status).toBe(200);
    for (const user of [person('member'), undefined]) {
        const response = await guarded(requireOperator, user);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Only an admin can change this.' });
    }
});

it('counts uses per key in fixed windows', () => {
    const limits = new RateLimits(2, 1000);
    expect([limits.take('a', 0), limits.take('a', 1), limits.take('a', 2)]).toEqual([true, true, false]);
    expect(limits.take('b', 2)).toBe(true);
    // A new window starts when the old one ends.
    expect(limits.take('a', 1000)).toBe(true);
});

it('takes a request with no socket and no forwarding headers as local, and none with them', async () => {
    const app = new Hono();
    app.get('/', (c) => c.json({ local: localRequest(c) }));
    expect(await (await app.request('/')).json()).toEqual({ local: true });
    for (const header of [
        'forwarded',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-real-ip',
        'cf-connecting-ip',
        'true-client-ip',
        'via',
    ]) {
        const response = await app.request('/', { headers: { [header]: '127.0.0.1' } });
        expect(await response.json(), header).toEqual({ local: false });
    }
    const at = (remoteAddress: string, host = 'localhost:3000') =>
        app.request(`http://${host}/`, { headers: { host } }, { incoming: { socket: { remoteAddress } } });
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        expect(await (await at(address)).json()).toEqual({ local: true });
    }
    for (const address of ['10.0.0.2', '::2', '128.0.0.1']) {
        expect(await (await at(address)).json()).toEqual({ local: false });
    }
    // A loopback peer is not enough: a tunnel or same-host proxy connects from
    // loopback but forwards a public Host.
    for (const host of ['127.0.0.1:3000', '[::1]:3000', 'app.localhost', 'LOCALHOST']) {
        expect(await (await at('127.0.0.1', host)).json(), host).toEqual({ local: true });
    }
    for (const host of ['brain.example.test', 'abc.trycloudflare.com', '10.0.0.2:3000', 'localhost.example.com']) {
        expect(await (await at('127.0.0.1', host)).json(), host).toEqual({ local: false });
    }
});

it('words a sign-in link with its lifetime', () => {
    expect(SIGN_IN_LINK_SECONDS).toBe(900);
    expect(signInLinkMessage({ url: 'https://example.test/l', expiresAt: new Date(0) })).toBe(
        "Your Socio sign-in link (works once, for 15 minutes; ignore it if you didn't ask for it):\nhttps://example.test/l",
    );
});

// CB-352: a code the Socio app asked for, in the same channels.
it('words a sign-in code for the app, and leaves the link as it was', () => {
    const code = {
        kind: 'code' as const,
        code: 'ABCDEFGH',
        openUrl: 'https://link.socio.sh/app/c#code=ABCDEFGH&ws=acme.example.com',
        expiresAt: new Date(0),
    };
    expect(signInLinkMessage(code)).toBe(
        'Your Socio sign-in code: ABCD-EFGH. Only type this into the Socio app on your own device. It works once, for 15 minutes. Open in the Socio app: https://link.socio.sh/app/c#code=ABCDEFGH&ws=acme.example.com',
    );
    expect(signInLinkSubject(code)).toBe('Your Socio sign-in code');
    const link = { kind: 'link' as const, url: 'https://example.test/l', expiresAt: new Date(0) };
    expect(signInLinkMessage(link)).toBe(signInLinkMessage({ url: 'https://example.test/l', expiresAt: new Date(0) }));
    expect(signInLinkSubject(link)).toBe('Your Socio sign-in link');
});

it('words "Send me a link for the app" without anything that signs in (CB-352)', () => {
    const link = { kind: 'app' as const, url: 'https://link.socio.sh/app/w/brain.example.com' };
    expect(signInLinkMessage(link)).toBe(
        'Open your workspace in the Socio app (install it first if you need to), then sign in there:\nhttps://link.socio.sh/app/w/brain.example.com',
    );
    expect(signInLinkSubject(link)).toBe('Your workspace in the Socio app');
});
