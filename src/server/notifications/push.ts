import { createHash, randomUUID } from 'node:crypto';

import * as webpush from 'web-push';

import type { UnitOfWork } from '@socio/data/uow';
import { SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';
import type { NotificationTarget, PushPayload } from '@socio/shared/notifications';

import type {
    ChannelResult,
    NotificationChannel,
    PushKeysShape,
    PushSettings,
    RenderedNotification,
} from './contract.js';
import type { NotificationRepositories, PushSubscriptionInput } from './domain/repositories.js';

/** Whether an endpoint is on an allowed push service. */
export function allowedEndpoint(endpoint: string, settings: PushSettings) {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        return false;
    }
    if (url.username || url.password) {
        return false;
    }
    if (url.protocol !== 'https:' && !(settings.allowHttp && url.protocol === 'http:')) {
        return false;
    }
    const host = url.hostname.toLowerCase();
    return settings.hosts.some((pattern) =>
        pattern.startsWith('*.')
            ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
            : host === pattern,
    );
}

const KEYS = 'vapid';
/** A push waits this long at the push service for a device that's offline. */
const TTL_SECONDS = 24 * 60 * 60;
const TIMEOUT_MS = 15_000;

type VapidKeys = { publicKey: string; privateKey: string };

/**
 * Web Push (CB-114). `web-push` encrypts each payload for its browser (RFC
 * 8291) and signs the request with the server's key (VAPID, RFC 8292);
 * it goes out with `fetch`. The push services see the ciphertext, the
 * endpoint and the timing: the payload is the title, body, link and the
 * addresses of the icon and image (never the image).
 */
export class PushChannel implements NotificationChannel, PushKeysShape {
    readonly id = 'push';
    readonly label = 'Push notifications';
    private box: SecretBox;
    private keys?: Promise<VapidKeys>;

    constructor(
        private uow: UnitOfWork,
        private repos: Pick<NotificationRepositories, 'subscriptions' | 'settings'>,
        private options: {
            secret: DataKeyring;
            settings: PushSettings;
            /** The app's origin: the VAPID subject (no email address). */
            origin?: string;
            log: (line: string) => void;
            fetch?: typeof fetch;
        },
    ) {
        this.box = new SecretBox(options.secret, 'push-keys');
    }

    /**
     * The server's key pair: made once and kept sealed. When it can't be
     * opened (a data key that's gone), a new one replaces it, and every
     * subscription is dropped: they were made for the old key, so people
     * turn push on again. Read or made once per process, in one unit of
     * work, so callers at the same time get the same pair.
     */
    private vapid() {
        this.keys ??= this.uow
            .run(
                async () => {
                    const sealed = await this.repos.settings.get(KEYS);
                    if (sealed) {
                        try {
                            return this.box.open(sealed) as VapidKeys;
                        } catch {
                            await this.repos.subscriptions.removeAll();
                            this.uow.afterCommit(() =>
                                this.options.log(
                                    'Notifications: the push key could not be opened (its data key is gone); made a new one. People turn push on again in Account → Notifications.',
                                ),
                            );
                        }
                    }
                    const keys = webpush.generateVAPIDKeys();
                    await this.repos.settings.set(KEYS, this.box.seal(keys));
                    return keys;
                },
                { label: 'push key' },
            )
            .catch((error: unknown) => {
                this.keys = undefined;
                throw error;
            });
        return this.keys;
    }
    /** The push services subscriptions may use. */
    get settings() {
        return this.options.settings;
    }
    /** What browsers subscribe with (`applicationServerKey`). */
    async publicKey() {
        return (await this.vapid()).publicKey;
    }

    /** The sealed key pair's key, for the data key's counts (CB-62). */
    async sealStates() {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        const sealed = await this.repos.settings.get(KEYS);
        if (sealed) {
            counts[this.box.state(this.box.valueKey(sealed))]++;
        }
        return counts;
    }
    /** Seals the key pair again under the current data key; idempotent. */
    reseal() {
        return this.uow.run(
            async () => {
                const sealed = await this.repos.settings.get(KEYS);
                if (!sealed) {
                    return { resealed: 0, unreadable: 0 };
                }
                let next: string | undefined;
                try {
                    next = this.box.reseal(sealed);
                } catch {
                    return { resealed: 0, unreadable: 1 };
                }
                if (next) {
                    await this.repos.settings.set(KEYS, next);
                }
                return { resealed: next ? 1 : 0, unreadable: 0 };
            },
            { label: 'reseal push key' },
        );
    }

    // --- Subscriptions ---------------------------------------------------

    /** The person's subscriptions, oldest first. */
    subscriptions(userId: string) {
        return this.repos.subscriptions.forUser(userId);
    }
    subscription(id: string) {
        return this.repos.subscriptions.byId(id);
    }
    byEndpoint(endpoint: string) {
        return this.repos.subscriptions.byEndpoint(endpoint);
    }
    /**
     * Saves a browser's subscription for its person. An endpoint is one
     * browser: subscribing again replaces its keys, and moves it to whoever
     * subscribed last in that browser.
     */
    subscribe(userId: string, input: PushSubscriptionInput, now = Date.now()) {
        return this.uow.run(
            async () => {
                const existing = await this.repos.subscriptions.byEndpoint(input.endpoint);
                const id = existing?.id ?? randomUUID();
                await this.repos.subscriptions.save(id, userId, input, now);
                return (await this.repos.subscriptions.byId(id))!;
            },
            { label: 'subscribe to push' },
        );
    }
    /** Removes one of the person's own; false when it isn't theirs. */
    unsubscribe(userId: string, id: string) {
        return this.repos.subscriptions.removeOwn(userId, id);
    }

    async targets(userId: string): Promise<NotificationTarget[]> {
        return (await this.subscriptions(userId)).map((row) => ({
            id: row.id,
            label: row.device,
            createdAt: row.createdAt,
        }));
    }
    async note(userId: string) {
        return (await this.subscriptions(userId)).length
            ? undefined
            : 'Turn it on in each browser or installed app you want them in.';
    }

    /**
     * The push service said the subscription is gone (404, 410), or it can't
     * be used. Awaited, so the unit of work is over before the delivery goes
     * on: queued behind another chain's, never left open (CB-110).
     */
    private drop(id: string) {
        return this.repos.subscriptions.remove(id);
    }
    /** A push's result on its subscription; awaited as `drop` is. */
    private sentTo(id: string, ok: boolean, now = Date.now()) {
        return ok ? this.repos.subscriptions.sent(id, now) : this.repos.subscriptions.failed(id);
    }

    async send(
        userId: string,
        target: NotificationTarget,
        notification: RenderedNotification,
        signal?: AbortSignal,
    ): Promise<ChannelResult> {
        const cancelled = () => ({
            outcome: 'failed' as const,
            error: 'Notification delivery canceled; external outcome may be unknown.',
        });
        if (signal?.aborted) {
            return cancelled();
        }
        const row = await this.repos.subscriptions.byId(target.id);
        if (signal?.aborted) {
            return cancelled();
        }
        if (!row || row.userId !== userId) {
            return { outcome: 'gone' };
        }
        if (!allowedEndpoint(row.endpoint, this.options.settings)) {
            await this.drop(row.id);
            return { outcome: 'gone' };
        }
        const payload: PushPayload = {
            kind: 'message',
            title: notification.title,
            body: notification.body,
            link: notification.path,
            ...(notification.icon ? { icon: notification.icon } : {}),
            ...(notification.image ? { image: notification.image.url } : {}),
            ...(notification.tag ? { tag: notification.tag } : {}),
        };
        const keys = await this.vapid();
        if (signal?.aborted) {
            return cancelled();
        }
        let request: ReturnType<typeof webpush.generateRequestDetails>;
        try {
            request = webpush.generateRequestDetails(
                {
                    endpoint: row.endpoint,
                    keys: { p256dh: row.p256dh, auth: row.auth },
                },
                JSON.stringify(payload),
                {
                    vapidDetails: {
                        subject: vapidSubject(this.options.origin),
                        publicKey: keys.publicKey,
                        privateKey: keys.privateKey,
                    },
                    TTL: TTL_SECONDS,
                    urgency: 'normal',
                    // At most 32 URL-safe characters: one per chat, so a push
                    // waiting for an offline device is replaced by a newer one.
                    ...(notification.tag ? { topic: topicOf(notification.tag) } : {}),
                },
            );
        } catch (error) {
            if (signal?.aborted) {
                return cancelled();
            }
            // A subscription whose keys don't make a valid key: never usable.
            await this.drop(row.id);
            return { outcome: 'failed', error: messageOf(error) };
        }
        let response: Response;
        try {
            response = await (this.options.fetch ?? fetch)(request.endpoint, {
                method: request.method,
                headers: request.headers as Record<string, string>,
                body: request.body ? new Uint8Array(request.body) : undefined,
                redirect: 'error',
                signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
                    : AbortSignal.timeout(TIMEOUT_MS),
            });
            await response.body?.cancel().catch(() => {});
        } catch (error) {
            if (signal?.aborted) {
                return cancelled();
            }
            await this.sentTo(row.id, false);
            return { outcome: 'failed', error: messageOf(error) };
        }
        if (signal?.aborted) {
            return cancelled();
        }
        if (response.status === 404 || response.status === 410) {
            await this.drop(row.id);
            return { outcome: 'gone' };
        }
        if (!response.ok) {
            await this.sentTo(row.id, false);
            return {
                outcome: 'failed',
                error: `The push service answered ${response.status}.`,
            };
        }
        await this.sentTo(row.id, true);
        return { outcome: 'sent' };
    }
}

/** An https origin, or a placeholder: VAPID takes https: or mailto: only. */
const vapidSubject = (origin?: string) =>
    origin?.startsWith('https://') ? origin.replace(/\/$/, '') : 'https://socio.invalid';

const topicOf = (tag: string) => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
