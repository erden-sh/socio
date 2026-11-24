import { readFileSync } from 'node:fs';

import { expect, it, vi } from 'vitest';

// public/sw.js (CB-114), run with a fake worker scope: push shows the
// payload's notification, a click focuses or opens the brain, and a
// replaced subscription is sent to the server. No fetch handler, ever.

const source = readFileSync('public/sw.js', 'utf8');
const ORIGIN = 'https://brain.example';

interface FakeClient {
    url: string;
    focus: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
}

/** A worker scope with the parts sw.js uses; `fire` runs one event to its end. */
function worker({ windows = [] as FakeClient[] } = {}) {
    const handlers = new Map<string, (event: unknown) => void>();
    const subscription = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/new',
        toJSON: () => ({
            endpoint: 'https://fcm.googleapis.com/fcm/send/new',
            keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) },
        }),
    };
    const self = {
        location: { origin: ORIGIN },
        addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
        skipWaiting: vi.fn(),
        registration: {
            showNotification: vi.fn(async () => undefined),
            pushManager: { subscribe: vi.fn(async () => subscription) },
        },
        clients: {
            matchAll: vi.fn(async () => windows),
            openWindow: vi.fn(async () => null),
            claim: vi.fn(async () => undefined),
        },
        fetch: vi.fn(async (url: string) =>
            url.endsWith('/channels')
                ? Response.json({ channels: [], pushKey: 'AQIDBA' })
                : Response.json({ id: 'sub1', label: 'Chrome on Linux' }, { status: 201 }),
        ),
    };
    new Function('self', source)(self);
    const fire = async (type: string, event: Record<string, unknown> = {}) => {
        let done: Promise<unknown> = Promise.resolve();
        handlers.get(type)!({
            ...event,
            waitUntil: (promise: Promise<unknown>) => (done = promise),
        });
        await done;
    };
    return { self, fire, handlers };
}
const push = (payload: unknown) => ({
    data: {
        json: () => (typeof payload === 'string' ? JSON.parse(payload) : structuredClone(payload)),
    },
});
const client = (path: string): FakeClient => {
    const item: FakeClient = {
        url: `${ORIGIN}${path}`,
        focus: vi.fn(async () => item),
        navigate: vi.fn(async () => item),
    };
    return item;
};

it('is push-only: no fetch handler, and it takes over at once', async () => {
    const { handlers, self, fire } = worker();
    expect([...handlers.keys()].sort()).toEqual([
        'activate',
        'install',
        'notificationclick',
        'push',
        'pushsubscriptionchange',
    ]);
    expect(source).not.toMatch(/caches\./);
    await fire('install');
    expect(self.skipWaiting).toHaveBeenCalled();
    await fire('activate');
    expect(self.clients.claim).toHaveBeenCalled();
});

it("shows a push with the payload's title, body, icon, image, tag and link", async () => {
    const { self, fire } = worker();
    await fire(
        'push',
        push({
            kind: 'message',
            title: 'Scout: Report ready',
            body: 'The weekly numbers are in.',
            link: '/chats/c1',
            icon: `${ORIGIN}/api/dots/d1/avatar`,
            image: `${ORIGIN}/api/notifications/images/t1`,
            tag: 'c1',
        }),
    );
    expect(self.registration.showNotification).toHaveBeenCalledWith('Scout: Report ready', {
        body: 'The weekly numbers are in.',
        icon: `${ORIGIN}/api/dots/d1/avatar`,
        image: `${ORIGIN}/api/notifications/images/t1`,
        tag: 'c1',
        renotify: true,
        data: { link: `${ORIGIN}/chats/c1` },
    });
});

it('shows a kind it does not know as the generic notification, without a tag', async () => {
    const { self, fire } = worker();
    await fire('push', push({ kind: 'poll', title: 'Scout', body: 'Pick one', link: '/x' }));
    expect(self.registration.showNotification).toHaveBeenCalledWith('Scout', {
        body: 'Pick one',
        icon: '/icons/icon-192.png',
        renotify: false,
        data: { link: `${ORIGIN}/x` },
    });
});

it('still shows a notification for a missing or unreadable payload', async () => {
    const { self, fire } = worker();
    const fallback = [
        'Socio',
        {
            body: 'Open Socio to see what’s new.',
            icon: '/icons/icon-192.png',
            data: { link: '/' },
        },
    ];
    await fire('push', {});
    await fire('push', push('not json'));
    await fire('push', push({ kind: 'message' }));
    expect(self.registration.showNotification.mock.calls).toEqual([fallback, fallback, fallback]);
});

it('keeps a link to another site in the brain', async () => {
    const { self, fire } = worker();
    await fire(
        'push',
        push({
            kind: 'message',
            title: 'T',
            body: '',
            link: 'https://evil.example/',
        }),
    );
    expect((self.registration.showNotification.mock.calls[0] as unknown[])[1]).toMatchObject({
        data: { link: `${ORIGIN}/` },
    });
});

const click = (link: string) => {
    const notification = { close: vi.fn(), data: { link } };
    return { notification };
};

it('focuses a window already on the link', async () => {
    const home = client('/');
    const chat = client('/chats/c1');
    const { self, fire } = worker({ windows: [home, chat] });
    const event = click(`${ORIGIN}/chats/c1`);
    await fire('notificationclick', event);
    expect(event.notification.close).toHaveBeenCalled();
    expect(chat.focus).toHaveBeenCalled();
    expect(home.focus).not.toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
    expect(self.clients.matchAll).toHaveBeenCalledWith({
        type: 'window',
        includeUncontrolled: true,
    });
});

it('else brings another window of the brain there', async () => {
    const home = client('/');
    const { self, fire } = worker({ windows: [home] });
    await fire('notificationclick', click(`${ORIGIN}/chats/c1`));
    expect(home.focus).toHaveBeenCalled();
    expect(home.navigate).toHaveBeenCalledWith(`${ORIGIN}/chats/c1`);
    expect(self.clients.openWindow).not.toHaveBeenCalled();
});

it('else opens a window (also when the window is not its to navigate)', async () => {
    const { self, fire } = worker();
    await fire('notificationclick', click(`${ORIGIN}/chats/c1`));
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/chats/c1`);

    const old = client('/');
    old.navigate.mockRejectedValue(new TypeError('not controlled'));
    const other = worker({ windows: [old] });
    await other.fire('notificationclick', click(`${ORIGIN}/chats/c1`));
    expect(other.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/chats/c1`);
});

it('subscribes again with the old key and tells the server', async () => {
    const { self, fire } = worker();
    const key = new Uint8Array([9, 9, 9]).buffer;
    await fire('pushsubscriptionchange', {
        oldSubscription: { options: { applicationServerKey: key } },
    });
    expect(self.registration.pushManager.subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: key,
    });
    expect(self.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = self.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/notifications/push/subscriptions');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(String(init.body))).toEqual({
        endpoint: 'https://fcm.googleapis.com/fcm/send/new',
        keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) },
    });
});

it("asks the server for its key when the old subscription's is gone", async () => {
    const { self, fire } = worker();
    await fire('pushsubscriptionchange', {});
    expect(self.fetch.mock.calls[0]).toEqual(['/api/notifications/channels', { credentials: 'same-origin' }]);
    const options = (
        self.registration.pushManager.subscribe.mock.calls[0] as unknown as [{ applicationServerKey: Uint8Array }]
    )[0];
    expect([...options.applicationServerKey]).toEqual([1, 2, 3, 4]);
    expect(self.fetch.mock.calls[1]![0]).toBe('/api/notifications/push/subscriptions');
});

it("sends the browser's own new subscription without subscribing again", async () => {
    const { self, fire } = worker();
    await fire('pushsubscriptionchange', {
        newSubscription: {
            toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/ff' }),
        },
    });
    expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    const [, init] = self.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
        endpoint: 'https://fcm.googleapis.com/fcm/send/ff',
    });
});
