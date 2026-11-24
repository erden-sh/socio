// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { NotificationChannelView } from '@socio/shared/notifications';

import type { Shell } from '../src/shell/shell-context';

// Settings → Account → Notifications (CB-114). The server, the service
// worker and the push service are fakes; nothing leaves the test.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { NotificationsSection, PUSH_TARGET_KEY } = await import('../src/modules/settings/NotificationsSection');
const { ShellContext } = await import('../src/shell/shell-context');

const PUSH_KEY = 'BAECAwQ'; // 04 01 02 03 04
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/here';

let channels: NotificationChannelView[];
let testAnswer: unknown;
let requests: { url: string; method: string; body?: unknown }[];
let subscribeAnswer: () => Response;

const push = (targets: NotificationChannelView['targets'] = []): NotificationChannelView => ({
    id: 'push',
    label: 'Push notifications',
    enabled: true,
    content: 'message',
    targets,
    ...(targets.length
        ? {}
        : {
              note: 'Turn it on in each browser or installed app you want them in.',
          }),
});
const telegram = (): NotificationChannelView => ({
    id: 'telegram',
    label: 'Telegram',
    enabled: false,
    content: 'private',
    targets: [],
    note: 'Link your Telegram account first (Settings → Telegram).',
});

/** The browser's push parts, as far as the page uses them. */
let subscription: {
    endpoint: string;
    options: { applicationServerKey: ArrayBuffer | null };
    toJSON: () => unknown;
    unsubscribe: ReturnType<typeof vi.fn>;
} | null;
const pushManager = {
    getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(
        async (options: { applicationServerKey: Uint8Array }) =>
            (subscription = {
                endpoint: ENDPOINT,
                options: {
                    applicationServerKey: options.applicationServerKey.slice().buffer,
                },
                toJSON: () => ({
                    endpoint: ENDPOINT,
                    expirationTime: null,
                    keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) },
                }),
                unsubscribe: vi.fn(async () => true),
            }),
    ),
};
const worker = { pushManager };
let permission: NotificationPermission;
const requestPermission = vi.fn(async () => permission);

function fakeBrowser({
    userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
    standalone = false,
    capable = true,
} = {}) {
    Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: userAgent,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
        configurable: true,
        value: /iPhone|iPad/.test(userAgent) ? 5 : 0,
    });
    globalThis.matchMedia = ((query: string) => ({
        matches: standalone && query === '(display-mode: standalone)',
    })) as unknown as typeof matchMedia;
    const scope = globalThis as Record<string, unknown>;
    if (capable) {
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {
                getRegistration: vi.fn(async () => worker),
                register: vi.fn(async () => worker),
                ready: Promise.resolve(worker),
            },
        });
        scope.PushManager = function PushManager() {};
        const notification = Object.defineProperty(function Notification() {}, 'permission', { get: () => permission });
        scope.Notification = Object.assign(notification, { requestPermission });
    } else {
        delete (navigator as unknown as Record<string, unknown>).serviceWorker;
        delete scope.PushManager;
        delete scope.Notification;
    }
}

let root: Root | undefined;
let host: HTMLElement;
beforeEach(() => {
    channels = [push([{ id: 'sub1', label: 'Edge on Windows' }]), telegram()];
    testAnswer = { channels: [{ channel: 'push', sent: 1, failed: 0 }] };
    requests = [];
    subscription = null;
    permission = 'default';
    localStorage.clear();
    pushManager.subscribe.mockClear();
    requestPermission.mockClear();
    subscribeAnswer = () => Response.json({ id: 'sub2', label: 'Chrome on Linux' }, { status: 201 });
    fakeBrowser();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const path = String(url);
        const method = init?.method ?? 'GET';
        requests.push({
            url: path,
            method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (path === '/api/issues/subscriptions') {
            return Response.json({ items: [], next: null });
        }
        if (path === '/api/notifications/channels') {
            return Response.json({ channels, pushKey: PUSH_KEY });
        }
        if (path === '/api/notifications/test') {
            return Response.json(testAnswer);
        }
        if (path === '/api/notifications/push/subscriptions') {
            const answer = subscribeAnswer();
            if (answer.ok) {
                channels = [push([...channels[0]!.targets, { id: 'sub2', label: 'Chrome on Linux' }]), telegram()];
            }
            return answer;
        }
        if (path.startsWith('/api/notifications/push/subscriptions/')) {
            channels = [push([]), telegram()];
            return Response.json({ ok: true });
        }
        return Response.json({ ok: true });
    });
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host?.remove();
    vi.restoreAllMocks();
});

const settle = () =>
    act(async () => {
        for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 0));
        }
    });

async function render({ saved = {} as Record<string, unknown> } = {}) {
    const mutate = vi.fn(async () => true);
    const shell = {
        workspace: { preferences: { notifications: saved } },
        mutate,
    } as unknown as Shell;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
        root!.render(
            <MemoryRouter>
                <ShellContext.Provider value={shell}>
                    <NotificationsSection telegram />
                </ShellContext.Provider>
            </MemoryRouter>,
        ),
    );
    await settle();
    return { mutate };
}
const card = (id: string) =>
    host.querySelector<HTMLElement>(`[data-slot="notification-channel"][data-channel="${id}"]`)!;
const button = (name: string | RegExp, within: ParentNode = host) =>
    [...within.querySelectorAll('button')].find((item) =>
        typeof name === 'string'
            ? item.textContent === name || item.getAttribute('aria-label') === name
            : name.test(item.textContent ?? ''),
    );
const click = async (element: Element | null | undefined) => {
    if (!element) {
        throw new Error('Nothing to click');
    }
    await act(async () => (element as HTMLElement).click());
    await settle();
};

it('lists each channel with its switch, what it shows and where it goes', async () => {
    await render();
    expect(requests[0]).toMatchObject({ url: '/api/notifications/channels' });
    const pushCard = card('push');
    expect(pushCard.querySelector('h3')!.textContent).toBe('Push notifications');
    expect(pushCard.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    const radios = [...pushCard.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => [radio.value, radio.checked])).toEqual([
        ['message', true],
        ['private', false],
    ]);
    expect(pushCard.textContent).toContain('Show the message');
    expect(pushCard.textContent).toContain('Private (“<socio> needs you”)');
    expect([...pushCard.querySelectorAll('[data-slot="push-device"]')].map((row) => row.textContent)).toEqual([
        'Edge on WindowsRemove',
    ]);
    expect(button('Turn on for this browser', pushCard)).toBeTruthy();

    const telegramCard = card('telegram');
    expect(telegramCard.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    const note = telegramCard.querySelector('[data-slot="channel-note"]')!;
    expect(note.textContent).toContain('Link your Telegram account first');
    expect(note.querySelector('a')!.getAttribute('href')).toBe('/settings/telegram');
});

it('saves the whole map on a switch or a content choice', async () => {
    const { mutate } = await render({
        saved: { sms: { enabled: true, content: 'private' } },
    });
    await click(card('push').querySelector('[role="switch"]'));
    expect(mutate).toHaveBeenLastCalledWith('/preferences', 'PATCH', {
        notifications: {
            sms: { enabled: true, content: 'private' },
            push: { enabled: false, content: 'message' },
            telegram: { enabled: false, content: 'private' },
        },
    });
    expect(card('push').querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    await click(card('push').querySelector('input[value="private"]'));
    expect(mutate).toHaveBeenLastCalledWith('/preferences', 'PATCH', {
        notifications: {
            sms: { enabled: true, content: 'private' },
            push: { enabled: false, content: 'private' },
            telegram: { enabled: false, content: 'private' },
        },
    });
    await click(card('telegram').querySelector('[role="switch"]'));
    expect(mutate).toHaveBeenLastCalledWith('/preferences', 'PATCH', {
        notifications: {
            sms: { enabled: true, content: 'private' },
            push: { enabled: false, content: 'private' },
            telegram: { enabled: true, content: 'private' },
        },
    });
});

it('puts a choice back when it could not be saved', async () => {
    const { mutate } = await render();
    mutate.mockResolvedValueOnce(false);
    await click(card('push').querySelector('input[value="private"]'));
    expect(card('push').querySelector<HTMLInputElement>('input[value="message"]')!.checked).toBe(true);
});

it('sends a test and says where it went, or that no channel is on', async () => {
    await render();
    await click(button('Send a test notification'));
    expect(requests.at(-1)).toMatchObject({
        url: '/api/notifications/test',
        method: 'POST',
    });
    expect(host.querySelector('[data-slot="test-result"]')!.textContent).toBe('Sent to Push notifications (1 sent).');
    testAnswer = {
        channels: [
            { channel: 'push', sent: 1, failed: 1 },
            { channel: 'telegram', sent: 1, failed: 0 },
        ],
    };
    await click(button('Send a test notification'));
    expect(host.querySelector('[data-slot="test-result"]')!.textContent).toBe(
        'Sent to Push notifications (1 sent, 1 failed) and Telegram (1 sent).',
    );
    testAnswer = { channels: [] };
    await click(button('Send a test notification'));
    expect(host.querySelector('[data-slot="test-result"]')!.textContent).toContain('No channel is on');
});

it('removes a device', async () => {
    await render();
    await click(button('Remove Edge on Windows'));
    expect(requests.find((request) => request.method === 'DELETE')).toMatchObject({
        url: '/api/notifications/push/subscriptions/sub1',
    });
    expect(host.querySelector('[data-slot="push-device"]')).toBeNull();
    expect(card('push').textContent).toContain('Turn it on in each browser or installed app');
});

it('turns push on in this browser, then says so', async () => {
    permission = 'default';
    requestPermission.mockImplementationOnce(async () => (permission = 'granted'));
    await render();
    await click(button('Turn on for this browser'));
    expect(requestPermission).toHaveBeenCalled();
    const options = pushManager.subscribe.mock.calls[0]![0] as {
        userVisibleOnly: boolean;
        applicationServerKey: Uint8Array;
    };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([4, 1, 2, 3, 4]);
    expect(requests.find((request) => request.url === '/api/notifications/push/subscriptions')?.body).toEqual({
        endpoint: ENDPOINT,
        expirationTime: null,
        keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(20) },
        installed: false,
    });
    expect(JSON.parse(localStorage.getItem(PUSH_TARGET_KEY)!)).toEqual({
        endpoint: ENDPOINT,
        id: 'sub2',
    });
    expect(host.querySelector('[data-slot="push-here"]')!.textContent).toBe('On in this browser.');
    expect(button('Turn on for this browser')).toBeUndefined();

    // Removing this browser's own device stops its subscription too.
    const mine = subscription!;
    await click(button('Remove Chrome on Linux'));
    expect(mine.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem(PUSH_TARGET_KEY)).toBeNull();
});

it('says when permission is refused, or the server refuses the push service', async () => {
    requestPermission.mockImplementationOnce(async () => (permission = 'denied'));
    await render();
    await click(button('Turn on for this browser'));
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(host.querySelector('[data-slot="push-error"]')!.textContent).toContain(
        'Notifications are blocked for this site in your browser’s settings',
    );
    act(() => root!.unmount());
    host.remove();

    permission = 'granted';
    subscribeAnswer = () =>
        Response.json({ error: 'This browser’s push service is not one the brain sends to.' }, { status: 400 });
    await render();
    await click(button('Turn on for this browser'));
    expect(host.querySelector('[data-slot="push-error"]')!.textContent).toBe(
        'This browser’s push service is not one the brain sends to.',
    );
    act(() => root!.unmount());
    host.remove();

    pushManager.subscribe.mockRejectedValueOnce(
        new DOMException('Registration failed - push service error', 'AbortError'),
    );
    subscription = null;
    await render();
    await click(button('Turn on for this browser'));
    expect(host.querySelector('[data-slot="push-error"]')!.textContent).toBe(
        'Registration failed - push service error',
    );
});

it('shows blocked notifications before anyone asks', async () => {
    permission = 'denied';
    await render();
    expect(card('push').querySelector('[data-slot="push-unavailable"]')!.textContent).toContain(
        'Notifications are blocked for this site',
    );
    expect(button('Turn on for this browser')).toBeUndefined();
});

it('sends an iPhone outside the installed app to the Home Screen first', async () => {
    fakeBrowser({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
        capable: false,
    });
    await render();
    const message = card('push').querySelector('[data-slot="push-unavailable"]')!;
    expect(message.getAttribute('data-reason')).toBe('ios');
    expect(message.textContent).toContain('Add Socio to your Home Screen first, then turn notifications on in the app');
    expect(button('Turn on for this browser')).toBeUndefined();
    act(() => root!.unmount());
    host.remove();

    // An iPad's Safari says it's a Mac; the installed app has push.
    fakeBrowser({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1',
        capable: true,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
        configurable: true,
        value: 5,
    });
    await render();
    expect(card('push').querySelector('[data-slot="push-unavailable"]')!.getAttribute('data-reason')).toBe('ios');
    act(() => root!.unmount());
    host.remove();
    fakeBrowser({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
        standalone: true,
    });
    await render();
    expect(button('Turn on for this browser')).toBeTruthy();
});

it('says when the browser has no push at all', async () => {
    fakeBrowser({ capable: false });
    await render();
    expect(card('push').querySelector('[data-slot="push-unavailable"]')!.getAttribute('data-reason')).toBe(
        'unsupported',
    );
});

it('creates and cancels an explicit future-only issue subscription from the person’s notification settings', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    const id = '12345678-1234-4123-8123-123456789abc';
    let subscribed = false,
        cancelled = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url) === '/api/issues/subscriptions') {
            if (init?.method === 'POST') {
                expect(JSON.parse(String(init.body))).toEqual({
                    issues: ['CB-12', 'CB-34'],
                    targetStatus: 'done',
                });
                subscribed = true;
                return Response.json({ outcome: 'subscribed', alreadyMatched: true });
            }
            return Response.json({
                items: subscribed
                    ? [
                          {
                              id,
                              issues: ['CB-12', 'CB-34'],
                              targetStatus: 'done',
                              state: cancelled ? 'cancelled' : 'watching',
                              createdAt: new Date().toISOString(),
                              triggeredAt: null,
                              cancelledAt: null,
                              cancelReason: null,
                          },
                      ]
                    : [],
                next: null,
            });
        }
        if (String(url) === '/api/issues/subscriptions/' + id && init?.method === 'DELETE') {
            cancelled = true;
            return Response.json({ outcome: 'cancelled' });
        }
        return original(url, init);
    });
    await render();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Subscribed issue keys"]')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'CB-12, CB-34');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
        input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await settle();
    expect(host.textContent).toContain('No historical notice was sent');
    expect(host.textContent).toContain('CB-12');
    await click(button('Unsubscribe CB-12, CB-34'));
    expect(cancelled).toBe(true);
    expect(host.textContent).toContain('Canceled');
});

it('lets a person hide that they are in a room, while Rooms are on (CB-216)', async () => {
    const mutate = vi.fn(async () => true);
    const shell = (rooms: boolean, roomPresence?: 'hidden') =>
        ({
            state: { settings: { rooms: { enabled: rooms } } },
            workspace: { preferences: { notifications: {}, roomPresence } },
            mutate,
        }) as unknown as Shell;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const show = async (value: Shell) => {
        await act(async () =>
            root!.render(
                <MemoryRouter>
                    <ShellContext.Provider value={value}>
                        <NotificationsSection telegram />
                    </ShellContext.Provider>
                </MemoryRouter>,
            ),
        );
        await settle();
    };
    await show(shell(false));
    expect(host.querySelector('[data-slot="room-notifications"]')).toBeNull();
    await show(shell(true));
    const card = host.querySelector('[data-slot="room-notifications"]')!;
    expect(card.textContent).toContain('Notify me about');
    const toggle = card.querySelector<HTMLElement>('[aria-label="Show when I’m in a room"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await click(toggle);
    expect(mutate).toHaveBeenCalledWith('/preferences', 'PATCH', {
        roomPresence: 'hidden',
    });
    await show(shell(true, 'hidden'));
    expect(host.querySelector('[aria-label="Show when I’m in a room"]')!.getAttribute('aria-checked')).toBe('false');
});
