import { createECDH, createPublicKey, randomBytes, verify, type ECDH } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ToolDefinition } from '@copilotkit/runtime/v2';
import ece from 'http_ece';
import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { characterOf, dotAvatarPath, LOCALS } from '@socio/shared/mascot';
import type { PushPayload } from '@socio/shared/notifications';
import { notificationLimits } from '@socio/shared/notifications/limits';
import { parsePresence } from '@socio/shared/notifications/presence';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import {
    notificationLimitsFromEnv,
    pushSettingsFromEnv,
    type PlatformConfig,
} from '../src/server/composition/config.js';
import { render } from '../src/server/notifications/channel.js';
import { DEFAULT_PUSH_HOSTS } from '../src/server/notifications/contract.js';
import { IMAGE_TTL_MS } from '../src/server/notifications/domain/rules.js';
import { PresenceTracker, TAB_FRESH_MS, TELEGRAM_FRESH_MS } from '../src/server/notifications/presence.js';
import { allowedEndpoint } from '../src/server/notifications/push.js';
import { deviceLabel } from '../src/server/notifications/routes.js';
import { brainPath } from '../src/server/notifications/tools.js';

import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'notifications-test-secret-0123456789abcdef';
const ORIGIN = 'https://brain.example';
const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) {
        await step();
    }
    vi.restoreAllMocks();
});

/** A push service on loopback: records each push, answers `status`. */
async function fakePushService() {
    const pushes: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
    let status = 201;
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            pushes.push({
                path: request.url ?? '',
                headers: request.headers,
                body: Buffer.concat(chunks),
            });
            response.writeHead(status).end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address() as AddressInfo;
    return {
        base: `http://127.0.0.1:${port}`,
        pushes,
        answer: (next: number) => (status = next),
    };
}

/** A browser's subscription: its own key pair and auth secret. */
function browserKeys() {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = randomBytes(16);
    return {
        ecdh,
        auth,
        keys: {
            p256dh: ecdh.getPublicKey().toString('base64url'),
            auth: auth.toString('base64url'),
        },
    };
}

/** What the browser reads: the push decrypted with its key (RFC 8291). */
const decrypt = (body: Buffer, ecdh: ECDH, auth: Buffer) =>
    JSON.parse(
        ece
            .decrypt(body, {
                version: 'aes128gcm',
                privateKey: ecdh,
                authSecret: auth.toString('base64url'),
            })
            .toString('utf8'),
    ) as PushPayload;

/** The VAPID header's JWT, checked against the key it names (RFC 8292). */
function vapid(header: string | undefined) {
    const match = header?.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(match, header).toBeTruthy();
    const [, token, key] = match!;
    const [head, claims, signature] = token!.split('.');
    const raw = Buffer.from(key!, 'base64url');
    const publicKey = createPublicKey({
        key: {
            kty: 'EC',
            crv: 'P-256',
            x: raw.subarray(1, 33).toString('base64url'),
            y: raw.subarray(33).toString('base64url'),
        },
        format: 'jwk',
    });
    expect(
        verify(
            'sha256',
            Buffer.from(`${head}.${claims}`),
            { key: publicKey, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signature!, 'base64url'),
        ),
    ).toBe(true);
    return {
        key: key!,
        claims: JSON.parse(Buffer.from(claims!, 'base64url').toString()) as {
            aud: string;
            sub: string;
            exp: number;
        },
    };
}

async function setup(config: Partial<PlatformConfig> = {}) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, workspace, platform, app, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            sessionSecret: SECRET,
            appOrigin: ORIGIN,
            push: { hosts: ['127.0.0.1'], allowHttp: true },
            ...config,
        },
        app: {
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const dot = workspace.dots()[0]!;
    const thread = workspace.bindThread('origin', dot.id, 'Chat', 'alice');
    const turn = (overrides: Partial<DotTurn> = {}): DotTurn => ({
        dot: workspace.dot(dot.id)!,
        userId: 'alice',
        threadId: thread.id,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
        ...overrides,
    });
    const notifyTool = (overrides: Partial<DotTurn> = {}) => {
        const tool = platform.dotExtensions.tools(turn(overrides)).find((item) => item.name === 'notify_user') as
            | (ToolDefinition & { execute: (input: unknown) => Promise<unknown> })
            | undefined;
        return tool && ((input: unknown) => tool.execute(input) as Promise<Record<string, unknown>>);
    };
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return (path: string, init: RequestInit = {}) =>
            app.request(path, {
                ...init,
                headers: {
                    cookie,
                    ...(init.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
                    ...(init.headers as Record<string, string>),
                },
            });
    };
    return { store, workspace, platform, app, dot, thread, turn, notifyTool, as };
}

it('allows push endpoints only on the push services, over https', () => {
    const settings = { hosts: DEFAULT_PUSH_HOSTS };
    for (const endpoint of [
        'https://fcm.googleapis.com/fcm/send/abc',
        'https://wns2-par02p.notify.windows.com/w/?token=abc',
        'https://web.push.apple.com/QGv',
        'https://updates.push.services.mozilla.com/wpush/v2/abc',
        'https://push.socio.sh/push/abc',
        'https://push-staging.socio.sh/push/abc',
    ]) {
        expect(allowedEndpoint(endpoint, settings), endpoint).toBe(true);
    }
    for (const endpoint of [
        'http://fcm.googleapis.com/fcm/send/abc',
        'https://googleapis.com.evil.example/x',
        'https://evilgoogleapis.com/x',
        'https://169.254.169.254/latest',
        'https://user:pass@fcm.googleapis.com/x',
        'https://localhost/x',
        'not a url',
        // Only the relay's own hosts: no lookalikes, no other socio.sh host,
        // and no longer the workers.dev names it had before socio.sh.
        'https://evil.socio.sh/push/abc',
        'https://push.socio.sh.evil.com/push/abc',
        'https://push-socio.sh/push/abc',
        'http://push.socio.sh/push/abc',
        'http://push-staging.socio.sh/push/abc',
        'https://socio-push.example.workers.dev/push/abc',
        'https://socio-push-staging.example.workers.dev/push/abc',
    ]) {
        expect(allowedEndpoint(endpoint, settings), endpoint).toBe(false);
    }
    expect(pushSettingsFromEnv({}).hosts).toEqual(DEFAULT_PUSH_HOSTS);
    expect(pushSettingsFromEnv({ PUSH_ENDPOINT_HOSTS: ' push.example , *.b.example' }).hosts).toEqual([
        'push.example',
        '*.b.example',
    ]);
});

it('allows the push relay by its exact socio.sh hosts, never a wildcard', () => {
    expect(DEFAULT_PUSH_HOSTS).toEqual([
        '*.googleapis.com',
        '*.notify.windows.com',
        '*.push.apple.com',
        '*.push.services.mozilla.com',
        'push.socio.sh',
        'push-staging.socio.sh',
    ]);
    expect(DEFAULT_PUSH_HOSTS.some((host) => host.endsWith('socio.sh') && host.includes('*'))).toBe(false);
    expect(DEFAULT_PUSH_HOSTS.some((host) => host.endsWith('workers.dev'))).toBe(false);
    // A deployment that sets the list replaces it: the relay must be named.
    const custom = pushSettingsFromEnv({ PUSH_ENDPOINT_HOSTS: '*.googleapis.com' });
    expect(allowedEndpoint('https://push.socio.sh/push/abc', custom)).toBe(false);
});

it('renders the message, or in private mode only "<Dot> needs you", with no text or image', () => {
    const input = {
        from: 'Ada',
        title: 'Report ready',
        message: 'Two invoices look duplicated.',
        path: '/chats/t1',
        icon: '/icons/icon-192.png',
        image: {
            bytes: PNG,
            mediaType: 'image/png',
            url: `${ORIGIN}/notification-images/x`,
        },
        tag: 't1',
    };
    expect(render(input, 'message', ORIGIN)).toMatchObject({
        title: 'Ada: Report ready',
        body: 'Two invoices look duplicated.',
        url: `${ORIGIN}/chats/t1`,
        icon: `${ORIGIN}/icons/icon-192.png`,
        image: input.image,
    });
    const quiet = render(input, 'private', ORIGIN);
    expect(quiet).toEqual({
        title: 'Ada needs you',
        body: 'Open Socio to see why.',
        path: '/chats/t1',
        url: `${ORIGIN}/chats/t1`,
        icon: `${ORIGIN}/icons/icon-192.png`,
        tag: 't1',
    });
    expect(JSON.stringify(quiet)).not.toMatch(/invoice|Report/);
});

it('judges presence: the same chat, elsewhere in the brain, or away', () => {
    const presence = new PresenceTracker();
    const now = 1_000_000;
    expect(presence.judge('alice', 't1', now)).toBe('away');
    presence.tab('alice', 'tab-aaaaaaaa', '/chats/t1', now);
    expect(presence.judge('alice', 't1', now)).toBe('present');
    expect(presence.judge('alice', 't2', now)).toBe('in_app');
    expect(presence.judge('bob', 't1', now)).toBe('away');
    // Stale: no report for longer than a few polls.
    expect(presence.judge('alice', 't1', now + TAB_FRESH_MS + 1)).toBe('away');
    // A poll saying the tab isn't in use, and the beacon, end it.
    presence.tab('alice', 'tab-aaaaaaaa', '/chats/t1', now);
    presence.tab('alice', 'tab-aaaaaaaa', undefined, now + 1);
    expect(presence.judge('alice', 't1', now + 2)).toBe('away');
    presence.tab('alice', 'tab-bbbbbbbb', '/spaces', now);
    presence.away('alice', 'tab-bbbbbbbb');
    expect(presence.judge('alice', 't1', now)).toBe('away');
    // Telegram: a message counts as being in that chat for two minutes.
    presence.telegramMessage('alice', 't9', now);
    expect(presence.judge('alice', 't9', now + TELEGRAM_FRESH_MS)).toBe('present');
    expect(presence.judge('alice', 't9', now + TELEGRAM_FRESH_MS + 1)).toBe('away');
    expect(parsePresence('tab-aaaaaaaa /chats/t1')).toEqual({
        tab: 'tab-aaaaaaaa',
        path: '/chats/t1',
    });
    expect(parsePresence('tab-aaaaaaaa -')).toEqual({
        tab: 'tab-aaaaaaaa',
        path: undefined,
    });
    for (const bad of [undefined, '', 'short /x', 'tab-aaaaaaaa x', 'a b c']) {
        expect(parsePresence(bad), String(bad)).toBeUndefined();
    }
});

it('pushes to an away person: encrypted for their browser, signed by the server, private when they chose it', async () => {
    const push = await fakePushService();
    const { platform, workspace, notifyTool, thread, dot } = await setup();
    const browser = browserKeys();
    const row = await platform.notifications.push.subscribe('alice', {
        endpoint: `${push.base}/push/one`,
        ...browser.keys,
        device: 'Edge on Windows',
    });
    const notify = notifyTool()!;
    const result = await notify({
        title: 'Report ready',
        message: 'Two invoices look duplicated.',
    });
    expect(result).toMatchObject({
        outcome: 'sent',
        channels: [{ channel: 'push', sent: 1, failed: 0 }],
    });
    expect(push.pushes).toHaveLength(1);
    const [sent] = push.pushes;
    expect(sent!.path).toBe('/push/one');
    expect(sent!.headers['content-encoding']).toBe('aes128gcm');
    expect(sent!.headers.ttl).toBe('86400');
    expect(sent!.headers.urgency).toBe('normal');
    expect(sent!.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const signed = vapid(sent!.headers.authorization);
    expect(signed.key).toBe(await platform.notifications.push.publicKey());
    expect(signed.claims.aud).toBe(push.base);
    // The VAPID subject is the brain's origin: never an email address.
    expect(signed.claims.sub).toBe(ORIGIN);
    const payload = decrypt(sent!.body, browser.ecdh, browser.auth);
    expect(payload).toEqual({
        kind: 'message',
        title: `${dot.name}: Report ready`,
        body: 'Two invoices look duplicated.',
        link: `/chats/${thread.id}`,
        icon: `${ORIGIN}${dotAvatarPath(dot)}`,
        tag: thread.id,
    });
    // The ciphertext doesn't carry the text.
    expect(sent!.body.toString('latin1')).not.toContain('invoices');
    // Recorded with the turn's cause and each delivery.
    const recorded = workspace.db.prepare('SELECT * FROM notifications').all() as {
        trigger: string;
        presence: string;
        dotId: string;
    }[];
    expect(recorded).toMatchObject([{ trigger: 'chat', presence: 'away', dotId: dot.id }]);
    expect((await platform.notifications.push.subscription(row.id))!.lastSentAt).toBeGreaterThan(0);

    // Private: only "<Dot> needs you" leaves the brain. A character chosen
    // since (CB-256) is the icon from then on.
    const other = LOCALS.find((local) => local !== characterOf(dot))!;
    workspace.updateDot(dot.id, { ...workspace.dot(dot.id)!, character: other });
    workspace.setPreferences('alice', {
        notifications: { push: { enabled: true, content: 'private' } },
    });
    await notify({ message: 'Secret numbers: 42.' });
    const quiet = decrypt(push.pushes[1]!.body, browser.ecdh, browser.auth);
    expect(quiet.title).toBe(`${dot.name} needs you`);
    expect(quiet.icon).toBe(`${ORIGIN}/locals/${other}.png`);
    expect(JSON.stringify(quiet)).not.toContain('42');

    // Off: nothing is sent, and the Dot is told.
    workspace.setPreferences('alice', {
        notifications: { push: { enabled: false, content: 'message' } },
    });
    expect(await notify({ message: 'Anyone?' })).toMatchObject({
        outcome: 'unreachable',
    });
    expect(push.pushes).toHaveLength(2);
});

it('drops a subscription the push service says is gone', async () => {
    const push = await fakePushService();
    const { platform, notifyTool } = await setup();
    const row = await platform.notifications.push.subscribe('alice', {
        endpoint: `${push.base}/push/gone`,
        ...browserKeys().keys,
        device: 'Chrome on Android',
    });
    push.answer(410);
    expect(await notifyTool()!({ message: 'Hello' })).toMatchObject({
        outcome: 'unreachable',
        channels: [{ channel: 'push', sent: 0, failed: 1 }],
    });
    expect(await platform.notifications.push.subscription(row.id)).toBeUndefined();
    // A failure that isn't "gone" keeps it, counted.
    const kept = await platform.notifications.push.subscribe('alice', {
        endpoint: `${push.base}/push/flaky`,
        ...browserKeys().keys,
        device: 'Chrome on Android',
    });
    push.answer(500);
    await notifyTool()!({ message: 'Hello again' });
    expect((await platform.notifications.push.subscription(kept.id))!.failures).toBe(1);
});

it('sends nothing while the person looks at the chat, and a toast while they are elsewhere in the brain', async () => {
    const push = await fakePushService();
    const { platform, notifyTool, thread, as } = await setup();
    await platform.notifications.push.subscribe('alice', {
        endpoint: `${push.base}/push/one`,
        ...browserKeys().keys,
        device: 'Edge on Windows',
    });
    const alice = await as('alice');
    // The tab's poll says it's on this chat.
    await alice('/api/state', {
        headers: { 'X-CB-Presence': `tab-aaaaaaaa /chats/${thread.id}` },
    });
    expect(await notifyTool()!({ message: 'Done.' })).toMatchObject({
        outcome: 'present',
    });
    // Elsewhere: shown in the app, on the next poll.
    await alice('/api/state', {
        headers: { 'X-CB-Presence': 'tab-aaaaaaaa /spaces' },
    });
    expect(await notifyTool()!({ title: 'Heads up', message: 'Done again.' })).toMatchObject({
        outcome: 'shown_in_app',
    });
    expect(push.pushes).toHaveLength(0);
    const state = (await (await alice('/api/state')).json()) as {
        notices: { id: string; title: string; body: string; link: string }[];
    };
    expect(state.notices).toMatchObject([{ body: 'Done again.', link: `/chats/${thread.id}` }]);
    expect(state.notices[0]!.title).toContain('Heads up');
    // Seen: gone for every tab.
    await alice('/api/notifications/in-app/seen', {
        method: 'POST',
        body: JSON.stringify({ ids: [state.notices[0]!.id] }),
    });
    expect(((await (await alice('/api/state')).json()) as { notices: unknown[] }).notices).toEqual([]);
    // The tab hidden (the beacon): away, so it's pushed.
    await alice('/api/notifications/away', {
        method: 'POST',
        body: JSON.stringify({ tab: 'tab-aaaaaaaa' }),
    });
    expect(await notifyTool()!({ message: 'Now?' })).toMatchObject({
        outcome: 'sent',
    });
    expect(push.pushes).toHaveLength(1);
});

it('limits notifications per Dot and person, and per person, with the admin’s over the environment’s', async () => {
    const push = await fakePushService();
    const { platform, store, notifyTool } = await setup({
        notificationLimits: { perDot: 2, perUser: 40 },
    });
    await platform.notifications.push.subscribe('alice', {
        endpoint: `${push.base}/push/one`,
        ...browserKeys().keys,
        device: 'Edge on Windows',
    });
    const notify = notifyTool()!;
    expect((await notify({ message: '1' })).outcome).toBe('sent');
    expect((await notify({ message: '2' })).outcome).toBe('sent');
    expect((await notify({ message: '3' })).outcome).toBe('rate_limited');
    await store.updateSettings({
        notificationDailyLimits: { perDot: 5, perUser: 3 },
    });
    expect((await notifyTool()!({ message: '3' })).outcome).toBe('sent');
    expect((await notifyTool()!({ message: '4' })).outcome).toBe('rate_limited');
    expect(notificationLimitsFromEnv({})).toEqual({ perDot: 20, perUser: 40 });
    expect(notificationLimitsFromEnv({ NOTIFY_PER_DOT_DAILY: '0' }).perDot).toBe(0);
    expect(() => notificationLimitsFromEnv({ NOTIFY_PER_USER_DAILY: '-1' })).toThrow();
    expect(notificationLimits({} as never)).toEqual({ perDot: 20, perUser: 40 });
});

it('gives notify_user to turns that act for their person, links only into the brain', async () => {
    const { notifyTool } = await setup();
    expect(notifyTool({ purpose: 'title' })).toBeUndefined();
    expect(notifyTool({ purpose: 'learning' })).toBeUndefined();
    expect(notifyTool({ purpose: 'scheduled' })).toBeDefined();
    expect(await notifyTool()!({ message: 'x', link: 'https://evil.example/' })).toMatchObject({ outcome: 'invalid' });
    expect(brainPath('/schedules/s1?x=1#y', ORIGIN)).toBe('/schedules/s1?x=1#y');
    expect(brainPath(`${ORIGIN}/spaces/a`, ORIGIN)).toBe('/spaces/a');
    expect(brainPath('//evil.example/x', ORIGIN)).toBeUndefined();
    expect(brainPath('javascript:alert(1)', ORIGIN)).toBeUndefined();
});

it('keeps an image in the brain behind an expiring token, served without a session', async () => {
    const push = await fakePushService();
    const { platform, notifyTool, app } = await setup();
    const browser = browserKeys();
    await platform.notifications.push.subscribe('alice', {
        endpoint: `${push.base}/push/one`,
        ...browser.keys,
        device: 'Edge on Windows',
    });
    // A public image, read through the Dot's web reads.
    const read = vi
        .spyOn((await import('../src/server/web/web-reads.js')).WebReads.prototype, 'read')
        .mockResolvedValue({
            ok: true,
            status: 200,
            url: 'https://images.example/chart.png',
            contentType: 'image/png',
            headers: {},
            body: PNG,
            bytes: PNG.length,
            complete: true,
        } as never);
    const result = await notifyTool()!({
        message: 'Chart attached.',
        image: 'https://images.example/chart.png',
    });
    expect(result.outcome).toBe('sent');
    expect(read).toHaveBeenCalledOnce();
    const payload = decrypt(push.pushes[0]!.body, browser.ecdh, browser.auth);
    // Never the third-party URL: the brain's own address.
    expect(payload.image).toMatch(new RegExp(`^${ORIGIN}/notification-images/[A-Za-z0-9_-]{43}$`));
    const path = new URL(payload.image!).pathname;
    const image = await app.request(path);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    expect((await app.request('/notification-images/nope')).status).toBe(404);
    // After 7 days the token no longer works.
    const token = path.split('/').pop()!;
    expect(await platform.notifications.image(token, Date.now() + IMAGE_TTL_MS + 1)).toBeUndefined();

    // Not an image: sent without it, and the Dot is told.
    read.mockResolvedValue({
        ok: true,
        status: 200,
        url: 'https://images.example/page.html',
        contentType: 'text/html',
        headers: {},
        body: Buffer.from('<html></html>'),
        bytes: 13,
        complete: true,
    } as never);
    const plain = await notifyTool()!({
        message: 'Again.',
        image: 'https://images.example/page.html',
    });
    expect(plain).toMatchObject({ outcome: 'sent' });
    expect(String(plain.imageNote)).toMatch(/PNG, JPEG, GIF or WebP/);
    expect(decrypt(push.pushes[1]!.body, browser.ecdh, browser.auth).image).toBeUndefined();
});

it('keeps each person’s subscriptions and channels their own', async () => {
    const push = await fakePushService();
    const { as, platform } = await setup();
    const alice = await as('alice');
    const bob = await as('bob');
    const subscribe = (who: typeof alice, endpoint: string) =>
        who('/api/notifications/push/subscriptions', {
            method: 'POST',
            headers: {
                'user-agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0',
            },
            body: JSON.stringify({ endpoint, keys: browserKeys().keys }),
        });
    const created = await subscribe(alice, `${push.base}/push/a`);
    expect(created.status).toBe(201);
    const { id, label } = (await created.json()) as { id: string; label: string };
    expect(label).toBe('Edge on Windows');
    // Installed, then renewed by the service worker (no `installed`): the
    // device keeps its label.
    const installed = await alice('/api/notifications/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
            endpoint: `${push.base}/push/app`,
            keys: browserKeys().keys,
            installed: true,
        }),
    });
    expect(((await installed.json()) as { label: string }).label).toMatch(/^Socio app on /);
    const renewed = await alice('/api/notifications/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
            endpoint: `${push.base}/push/app`,
            keys: browserKeys().keys,
        }),
    });
    expect(((await renewed.json()) as { label: string }).label).toMatch(/^Socio app on /);
    const appId = (
        (await (await alice('/api/notifications/channels')).json()) as {
            channels: { id: string; targets: { id: string; label: string }[] }[];
        }
    ).channels
        .find((c) => c.id === 'push')!
        .targets.find((t) => t.label.startsWith('Socio app'))!.id;
    await alice(`/api/notifications/push/subscriptions/${appId}`, {
        method: 'DELETE',
    });
    expect((await subscribe(alice, 'https://evil.example/push')).status).toBe(400);
    const channels = (await (await alice('/api/notifications/channels')).json()) as {
        channels: { id: string; enabled: boolean; targets: { id: string }[] }[];
        pushKey: string;
    };
    expect(channels.pushKey).toBe(await platform.notifications.push.publicKey());
    expect(channels.channels.find((c) => c.id === 'push')).toMatchObject({
        enabled: true,
        targets: [{ id }],
    });
    // Bob can't see or remove Alice's.
    const bobs = (await (await bob('/api/notifications/channels')).json()) as {
        channels: { id: string; targets: unknown[]; note?: string }[];
    };
    expect(bobs.channels.find((c) => c.id === 'push')).toMatchObject({
        targets: [],
    });
    expect(
        (
            await bob(`/api/notifications/push/subscriptions/${id}`, {
                method: 'DELETE',
            })
        ).status,
    ).toBe(404);
    // The test goes to Alice's channels.
    const test = (await (await alice('/api/notifications/test', { method: 'POST' })).json()) as { channels: unknown };
    expect(test.channels).toEqual([{ channel: 'push', sent: 1, failed: 0 }]);
    expect(push.pushes).toHaveLength(1);
    expect(
        (
            await alice(`/api/notifications/push/subscriptions/${id}`, {
                method: 'DELETE',
            })
        ).status,
    ).toBe(200);
    // Preferences: each channel's choice, validated.
    const saved = await alice('/api/preferences', {
        method: 'PATCH',
        body: JSON.stringify({
            notifications: {
                push: { enabled: true, content: 'private' },
                telegram: { enabled: true, content: 'message' },
            },
        }),
    });
    expect(saved.status).toBe(200);
    expect(
        (
            await alice('/api/preferences', {
                method: 'PATCH',
                body: JSON.stringify({
                    notifications: { push: { enabled: true, content: 'loud' } },
                }),
            })
        ).status,
    ).toBe(400);
    expect(
        deviceLabel(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
            true,
        ),
    ).toBe('Socio app on iPhone');
});

it('seals the push key, re-seals it with the data key, and starts over when it can’t be opened', async () => {
    const { platform, workspace } = await setup();
    const key = await platform.notifications.push.publicKey();
    // Without a data key, the key from SESSION_SECRET is the current one.
    expect(await platform.notifications.push.sealStates()).toMatchObject({
        current: 1,
    });
    // Another server secret can't open it: a new key, subscriptions dropped.
    await platform.notifications.push.subscribe('alice', {
        endpoint: 'https://fcm.googleapis.com/fcm/send/x',
        ...browserKeys().keys,
        device: 'Chrome on Android',
    });
    // Other servers over the same workspace's connection, each with a
    // store of its own.
    const server = async (config: Partial<PlatformConfig>) => {
        const storeDb = testDatabase();
        cleanup.push(() => storeDb.close());
        const t = await makeTestRuntime({
            database: { store: storeDb, workspace: workspace.db },
            config: {
                apiKey: '',
                model: '',
                sessionSecret: 'another-secret-0123456789abcdef-xyz',
                appOrigin: ORIGIN,
                ...config,
            },
        });
        cleanup.push(t.dispose);
        return t.platform;
    };
    const other = await server({});
    expect(await other.notifications.push.publicKey()).not.toBe(key);
    expect(await other.notifications.push.subscriptions('alice')).toEqual([]);
    // A data key: the pair is sealed again under it.
    const dataKey = randomBytes(32);
    const keyed = await server({ dataKeys: { current: dataKey } });
    expect(await keyed.notifications.push.sealStates()).toMatchObject({
        legacy: 1,
    });
    expect(await keyed.notifications.push.reseal()).toEqual({
        resealed: 1,
        unreadable: 0,
    });
    expect(await keyed.notifications.push.sealStates()).toMatchObject({
        current: 1,
    });
    expect(await keyed.notifications.push.publicKey()).toBe(await other.notifications.push.publicKey());
});

it('records a scheduled turn with its task, and tells the Dot whether the person is reachable', async () => {
    const push = await fakePushService();
    const { platform, workspace, turn, notifyTool } = await setup();
    const status = async () =>
        await platform.capabilities.list().find((definition) => definition.id === 'notifications')!.status!(turn());
    expect(await status()).toMatchObject({
        enabled: true,
        details: { reachable: false },
        usage: { sentByYouToday: 0, sentToPersonToday: 0 },
    });
    await platform.notifications.push.subscribe('alice', {
        endpoint: `${push.base}/push/one`,
        ...browserKeys().keys,
        device: 'Edge on Windows',
    });
    expect((await status()).details).toEqual({ reachable: true });
    const notify = notifyTool({
        purpose: 'scheduled',
        cause: { kind: 'schedule', id: 'task-1' },
    })!;
    expect((await notify({ message: 'The digest is ready.' })).outcome).toBe('sent');
    expect(workspace.db.prepare('SELECT trigger, causeId FROM notifications').all() as unknown).toEqual([
        { trigger: 'scheduled', causeId: 'task-1' },
    ]);
    expect((await status()).usage).toEqual({
        sentByYouToday: 1,
        sentToPersonToday: 1,
    });
});

it.each([201, 410, 500])(
    'does not record late push response %s after cancellation even if fetch ignores the signal',
    async (status) => {
        const { platform } = await setup();
        const push = platform.notifications.push;
        const browser = browserKeys();
        const row = await push.subscribe('alice', {
            endpoint: 'http://127.0.0.1/push/held',
            ...browser.keys,
            device: 'Held transport',
        });
        let release!: (response: Response) => void;
        const transport = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const subscriptions = (
            push as unknown as {
                repos: {
                    subscriptions: {
                        sent: (...args: unknown[]) => unknown;
                        failed: (...args: unknown[]) => unknown;
                        remove: (...args: unknown[]) => unknown;
                    };
                };
            }
        ).repos.subscriptions;
        const sent = vi.spyOn(subscriptions, 'sent');
        const failed = vi.spyOn(subscriptions, 'failed');
        const remove = vi.spyOn(subscriptions, 'remove');
        const controller = new AbortController();
        const sending = push.send(
            'alice',
            { id: row.id, label: 'Held' },
            render({ from: 'Socio', title: 'Ready', message: 'Done', path: '/issues' }, 'private', ORIGIN),
            controller.signal,
        );
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        expect(transport.mock.calls[0]![1]!.signal).toBeDefined();
        controller.abort();
        release(new Response(null, { status }));
        expect(await sending).toMatchObject({ outcome: 'failed' });
        expect(sent).not.toHaveBeenCalled();
        expect(failed).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    },
);
