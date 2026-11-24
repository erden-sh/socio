// Socio's service worker (CB-114): Web Push notifications only.
//
// It has no `fetch` handler and keeps no cache, on purpose: every request
// goes to the network as if it weren't here, so deploys, the build-skew
// reloads (build-skew.ts) and the page guard behave exactly as without it.
// Registered by entry.client.tsx; Settings → Account → Notifications
// subscribes with it.
//
// The push payload is a `PushPayload` (packages/shared/src/notifications.ts),
// encrypted end to end by the server. A kind this worker doesn't know
// shows as the generic notification, so newer servers never go silent on
// an older worker. Browsers require a visible notification for every
// push, so a payload that can't be read still shows one.
//
// Everything goes through `self` (the worker's global scope), so
// tests/service-worker.test.ts runs this file with a fake one.
/* global self, URL, atob */

const APP_NAME = 'Socio';
const APP_ICON = '/icons/icon-192.png';
const SUBSCRIPTIONS_PATH = '/api/notifications/push/subscriptions';
const CHANNELS_PATH = '/api/notifications/channels';

/** The payload, or undefined when it's missing or isn't JSON with a title. */
function readPayload(data) {
    if (!data) return undefined;
    try {
        const payload = data.json();
        return payload && typeof payload === 'object' && payload.title ? payload : undefined;
    } catch {
        return undefined;
    }
}

/** A link as a same-origin URL; anything else opens the brain's home. */
function targetUrl(link) {
    const origin = self.location.origin;
    try {
        const url = new URL(typeof link === 'string' ? link : '/', origin);
        return url.origin === origin ? url : new URL('/', origin);
    } catch {
        return new URL('/', origin);
    }
}

/**
 * What `showNotification` gets for a payload: the generic notification
 * for every kind (only `message` exists yet), the fallback without one.
 * A tag replaces the chat's earlier notification, and still alerts.
 */
function notificationFor(payload) {
    if (!payload)
        return {
            title: APP_NAME,
            options: {
                body: 'Open Socio to see what’s new.',
                icon: APP_ICON,
                data: { link: '/' },
            },
        };
    const tag = typeof payload.tag === 'string' ? payload.tag : undefined;
    return {
        title: String(payload.title),
        options: {
            body: typeof payload.body === 'string' ? payload.body : '',
            icon: payload.icon || APP_ICON,
            ...(payload.image ? { image: payload.image } : {}),
            ...(tag ? { tag } : {}),
            renotify: !!tag,
            data: { link: targetUrl(payload.link).href },
        },
    };
}

function showPush(event) {
    const { title, options } = notificationFor(readPayload(event.data));
    return self.registration.showNotification(title, options);
}

/**
 * A click: a window already on the link comes forward; else any window of
 * the brain comes forward and goes there; else a new one opens. Windows
 * opened before this worker took over aren't its to navigate
 * (`navigate` rejects), so those get a new window too.
 */
async function openLink(link) {
    const url = targetUrl(link);
    const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
    });
    const same = (client) => {
        const at = new URL(client.url);
        return at.pathname + at.search === url.pathname + url.search;
    };
    const there = windows.find(same);
    if (there) return there.focus();
    const any = windows[0];
    if (any)
        try {
            const focused = await any.focus();
            return await (focused ?? any).navigate(url.href);
        } catch {
            // Not controlled by this worker: open a window instead.
        }
    return self.clients.openWindow(url.href);
}

function clickNotification(event) {
    event.notification.close();
    return openLink(event.notification.data?.link);
}

/** A base64url key (the server's `pushKey`) as bytes. */
function keyBytes(base64url) {
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/**
 * The push service replaced or dropped this browser's subscription: take
 * the new one (Firefox hands it over) or subscribe again with the same
 * server key, and tell the server, signed in as the person whose browser
 * this is (the session cookie). The old endpoint stops working, and the
 * server drops it at its next send. Signed out, the server refuses it and
 * the person turns push on again in Account → Notifications.
 */
async function resubscribe(event) {
    let subscription = event.newSubscription;
    if (!subscription) {
        let key = event.oldSubscription?.options?.applicationServerKey;
        if (!key) {
            const response = await self.fetch(CHANNELS_PATH, {
                credentials: 'same-origin',
            });
            if (!response.ok) return;
            const { pushKey } = await response.json();
            if (!pushKey) return;
            key = keyBytes(pushKey);
        }
        subscription = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
        });
    }
    await self.fetch(SUBSCRIPTIONS_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
    });
}

// A new version takes over at once: there's no cache to keep in step.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => event.waitUntil(showPush(event)));
self.addEventListener('notificationclick', (event) => event.waitUntil(clickNotification(event)));
self.addEventListener('pushsubscriptionchange', (event) => event.waitUntil(resubscribe(event).catch(() => undefined)));
