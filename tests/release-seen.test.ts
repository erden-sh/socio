import { afterEach, expect, it } from 'vitest';

import type { User } from '@socio/shared/types';
import { compareVersions, isReleaseVersion } from '@socio/shared/updates/release-seen';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { ReleaseData } from '../src/server/updates/contract.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-166: the newest release each person has seen in What's new, the
// releases they were shown, and what admins read of both.

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

// The releases the app's own routes (CB-165) serve in these tests.
const RELEASES: ReleaseData = {
    version: '0.6.1',
    commit: null,
    releases: [
        {
            version: '0.6.1',
            tag: 'v0.6.1',
            date: '2026-10-22',
            summary: 'Steadier.',
            highlights: [],
            url: '/releases/v0.6.1',
            notesMarkdown: '### Fixed\n\n- Steadier.',
        },
        {
            version: '0.6.0',
            tag: 'v0.6.0',
            date: '2026-10-22',
            summary: 'Steering.',
            highlights: [],
            url: '/releases/v0.6.0',
            notesMarkdown: '### New\n\n- Steering.',
        },
    ],
};

async function fixture() {
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://unused.invalid/v1',
            apiKey: 'fixture',
            model: 'fixture',
            voiceName: 'marin',
            runtimeUrl: '',
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            releases: () => RELEASES,
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    // Any path, as anyone: a session cookie, a bearer token, other headers.
    const send = async (
        path: string,
        { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> },
    ) => {
        const response = await app.request(`http://localhost${path}`, {
            method,
            headers: {
                ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
        };
    };
    const cookieOf = async (userId: string) =>
        (
            await app.request('/api/auth/mock/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            })
        ).headers
            .get('set-cookie')!
            .split(';')[0]!;
    const as = async (userId?: string) => {
        const cookie = userId
            ? (
                  await app.request('/api/auth/mock/login', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ userId }),
                  })
              ).headers
                  .get('set-cookie')!
                  .split(';')[0]!
            : '';
        return async (method = 'GET', body?: unknown) => {
            const response = await app.request('/api/releases/seen', {
                method,
                headers: {
                    ...(cookie ? { cookie } : {}),
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: await response.json() };
        };
    };
    return {
        app,
        platform,
        workspace,
        send,
        cookies: { alice: await cookieOf('alice'), bob: await cookieOf('bob') },
        alice: await as('alice'),
        bob: await as('bob'),
    };
}

it('orders release versions by SemVer precedence', () => {
    const sorted = [
        '0.6.1',
        '0.7.0',
        '0.9.0',
        '0.10.0',
        '1.0.0-alpha',
        '1.0.0-alpha.1',
        '1.0.0-alpha.beta',
        '1.0.0-beta',
        '1.0.0-beta.2',
        '1.0.0-beta.11',
        '1.0.0-rc.1',
        '1.0.0',
        '1.2.0',
        '1.10.0',
        '2.0.0',
    ];
    for (const [index, version] of sorted.entries()) {
        expect(compareVersions(version, version)).toBe(0);
        for (const later of sorted.slice(index + 1)) {
            expect(compareVersions(version, later), `${version} < ${later}`).toBe(-1);
            expect(compareVersions(later, version)).toBe(1);
        }
    }
    // Build metadata doesn't count.
    expect(compareVersions('0.7.0+build.5', '0.7.0')).toBe(0);
    for (const good of ['0.7.0', '0.1.0', '1.6.0', '0.8.0-rc.1', '0.7.0+build.5']) {
        expect(isReleaseVersion(good), good).toBe(true);
    }
    for (const bad of ['v0.7.0', '0.7', '00.7.0', '0.7.0-', '0.7.0 ', '', `0.7.0-${'a'.repeat(64)}`, 1, null]) {
        expect(isReleaseVersion(bad), String(bad)).toBe(false);
    }
});

it('keeps each person’s last seen release, moving only forward', async () => {
    const { alice, bob } = await fixture();
    expect(await alice()).toEqual({ status: 200, body: { lastSeen: null } });
    expect(await alice('POST', { version: '0.6.1' })).toEqual({
        status: 200,
        body: { lastSeen: '0.6.1' },
    });
    // An older tab can't take it back.
    expect((await alice('POST', { version: '0.6.0' })).body).toEqual({
        lastSeen: '0.6.1',
    });
    expect((await alice('POST', { version: '0.7.0-rc.1' })).body).toEqual({
        lastSeen: '0.7.0-rc.1',
    });
    // SemVer, not text: 0.10 is after 0.7.
    expect((await alice('POST', { version: '0.7.0' })).body).toEqual({
        lastSeen: '0.7.0',
    });
    expect((await alice('POST', { version: '0.10.0' })).body).toEqual({
        lastSeen: '0.10.0',
    });
    expect((await alice()).body).toEqual({ lastSeen: '0.10.0' });
    // Bob's is his own.
    expect((await bob()).body).toEqual({ lastSeen: null });
});

it('refuses a bad version and anyone signed out', async () => {
    const { app, alice } = await fixture();
    for (const bad of [
        { version: 'v0.7.0' },
        { version: '0.7' },
        { version: 160 },
        { version: '0.7.0', extra: true },
        {},
        '0.7.0',
        null,
    ]) {
        expect((await alice('POST', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await alice()).body).toEqual({ lastSeen: null });
    for (const method of ['GET', 'POST']) {
        expect(
            (
                await app.request('/api/releases/seen', {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    ...(method === 'POST' ? { body: JSON.stringify({ version: '0.7.0' }) } : {}),
                })
            ).status,
        ).toBe(401);
    }
});

it('lives beside the releases API: "seen" is never a release’s tag', async () => {
    const { app, alice } = await fixture();
    expect((await alice()).body).toEqual({ lastSeen: null });
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const tag = await app.request('/api/releases/v0.6.1', {
        headers: { cookie },
    });
    expect(tag.status).toBe(200);
    expect(await tag.json()).toMatchObject({ version: '0.6.1' });
    const list = await app.request('/api/releases?limit=5', {
        headers: { cookie },
    });
    expect(await list.json()).toMatchObject({ current: '0.6.1' });
});

it('keeps the first time each release was shown, idempotently', async () => {
    const { send, cookies, workspace } = await fixture();
    const views = (cookie: string, versions: unknown) =>
        send('/api/releases/views', {
            method: 'POST',
            body: { versions },
            headers: { cookie },
        });
    expect(await views(cookies.bob, ['0.6.1', '0.6.0', '0.6.1'])).toEqual({
        status: 200,
        body: { ok: true },
    });
    const first = workspace.releaseViews('bob');
    expect(first.map((view) => view.version)).toEqual(['0.6.1', '0.6.0']);
    // Shown again later: the first time stays.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await views(cookies.bob, ['0.6.1'])).status).toBe(200);
    expect(workspace.releaseViews('bob')).toEqual(first);
    // Alice's are her own.
    expect(workspace.releaseViews('alice')).toEqual([]);
    for (const bad of [[], ['0.5.0'], ['v0.6.1'], [61], '0.6.1', Array.from({ length: 51 }, () => '0.6.1')]) {
        expect((await views(cookies.bob, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(
        (
            await send('/api/releases/views', {
                method: 'POST',
                body: { versions: ['0.6.1'], extra: 1 },
                headers: { cookie: cookies.bob },
            })
        ).status,
    ).toBe(400);
    expect(
        (
            await send('/api/releases/views', {
                method: 'POST',
                body: { versions: ['0.6.1'] },
            })
        ).status,
    ).toBe(401);
});

it('shows admins what a person has seen, and nobody else', async () => {
    const { send, cookies } = await fixture();
    await send('/api/releases/views', {
        method: 'POST',
        body: { versions: ['0.6.0'] },
        headers: { cookie: cookies.bob },
    });
    await send('/api/releases/seen', {
        method: 'POST',
        body: { version: '0.6.1' },
        headers: { cookie: cookies.bob },
    });
    const read = await send('/api/admin/people/bob/releases', {
        headers: { cookie: cookies.alice },
    });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
        userId: 'bob',
        lastSeen: '0.6.1',
        views: [{ version: '0.6.0', firstSeenAt: expect.any(Number) }],
    });
    expect(
        (
            await send('/api/admin/people/nobody/releases', {
                headers: { cookie: cookies.alice },
            })
        ).status,
    ).toBe(404);
    // A member can't read anyone's, their own included.
    for (const id of ['alice', 'bob']) {
        expect(
            (
                await send(`/api/admin/people/${id}/releases`, {
                    headers: { cookie: cookies.bob },
                })
            ).status,
        ).toBe(403);
    }
    expect((await send('/api/admin/people/bob/releases', {})).status).toBe(401);
});

it('refuses service keys, data tokens and other sites', async () => {
    const { send, cookies, platform, workspace } = await fixture();
    const robot = platform.serviceAccounts.create({ name: 'Robot', role: 'admin' }, 'alice');
    const { token: key } = platform.serviceAccounts.createKey(
        robot.id,
        { name: 'k', scopes: ['issues:read'], days: 30 },
        'alice',
    );
    const token = platform.data.tokens.issue({
        userId: 'bob',
        dotId: workspace.dots()[0]!.id,
        purpose: 'computer',
        session: 'check',
    });
    const calls: [string, string, unknown?][] = [
        ['/api/releases/seen', 'GET'],
        ['/api/releases/seen', 'POST', { version: '0.6.1' }],
        ['/api/releases/views', 'POST', { versions: ['0.6.1'] }],
        ['/api/admin/people/bob/releases', 'GET'],
    ];
    for (const [path, method, body] of calls) {
        // A service key, even an admin's, reaches none of them.
        expect(
            (
                await send(path, {
                    method,
                    body,
                    headers: { authorization: `Bearer ${key}` },
                })
            ).status,
            `${method} ${path} with a service key`,
        ).toBe(403);
        // A data token is only for /api/data: here it is no sign-in at all.
        expect(
            (
                await send(path, {
                    method,
                    body,
                    headers: { authorization: `Bearer ${token}` },
                })
            ).status,
            `${method} ${path} with a data token`,
        ).toBe(401);
    }
    // Another site can't write for a signed-in person.
    for (const [path, , body] of calls.filter(([, method]) => method === 'POST')) {
        expect(
            await send(path, {
                method: 'POST',
                body,
                headers: { cookie: cookies.bob, origin: 'https://evil.example' },
            }),
        ).toEqual({
            status: 403,
            body: { error: 'Cross-origin requests are not allowed.' },
        });
    }
    expect(workspace.lastSeenRelease('bob')).toBeNull();
    expect(workspace.releaseViews('bob')).toEqual([]);
});
