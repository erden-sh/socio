import type { InAppNotice } from '@socio/shared/notifications';

/**
 * The Notifications context's repositories (CB-110): one per
 * aggregate, async, taking and returning plain domain types. Only
 * `notifications/infra` implements them; nothing else touches the
 * notification tables. Every write works inside or outside a unit of work:
 * outside one it opens its own, so there is a single writer path.
 */

/** A browser a person turned push on in (CB-114). */
export interface PushSubscription {
    id: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    /** A short label from its browser ("Edge on Windows"). */
    device: string;
    createdAt: number;
    lastSentAt: number | null;
    failures: number;
}

/** What a browser subscribes with. */
export interface PushSubscriptionInput {
    endpoint: string;
    p256dh: string;
    auth: string;
    device: string;
}

/** What a notification is recorded with: the turn's, never the model's. */
export interface NotificationRecord {
    userId: string;
    dotId: string | null;
    threadId: string | null;
    trigger: string;
    causeId: string | null;
    title: string;
    message: string;
    link: string;
    imageToken: string | null;
    presence: 'present' | 'in_app' | 'away';
}

export type DeliveryOutcome = 'sent' | 'gone' | 'failed';

/** Where one notification went: per channel and target, how it went. */
export interface NotificationDelivery {
    notificationId: string;
    channel: string;
    target: string;
    outcome: DeliveryOutcome;
    error: string | null;
    at: number;
}

/** PushSubscription. An endpoint is one browser. */
export interface PushSubscriptionRepository {
    /** The person's, oldest first. */
    forUser(userId: string): Promise<PushSubscription[]>;
    byId(id: string): Promise<PushSubscription | undefined>;
    byEndpoint(endpoint: string): Promise<PushSubscription | undefined>;
    /**
     * Saves a new one as `id`; a known endpoint keeps its id and creation,
     * and takes the new person, keys and device, with its failures cleared.
     */
    save(id: string, userId: string, input: PushSubscriptionInput, createdAt: number): Promise<void>;
    /** Removes one of the person's own; false when it isn't theirs. */
    removeOwn(userId: string, id: string): Promise<boolean>;
    remove(id: string): Promise<void>;
    removeAll(): Promise<void>;
    /** A push went out: stamped, failures cleared. */
    sent(id: string, now: number): Promise<void>;
    /** A push failed: counted. */
    failed(id: string): Promise<void>;
}

/** Notification (its deliveries). */
export interface NotificationRepository {
    insert(id: string, record: NotificationRecord, createdAt: number): Promise<void>;
    addDelivery(delivery: NotificationDelivery): Promise<void>;
    /** Sent by socios since `since`: by this one for the person, and for the person by all. */
    usage(dotId: string, userId: string, since: number): Promise<{ byDot: number; byUser: number }>;
    /** Removes those made before `before`, with their deliveries. */
    removeBefore(before: number): Promise<void>;
    /** Prunes delivery history independently of the retained notification record. */
    removeDeliveriesBefore(before: number): Promise<void>;
    /** Retention of records only; deliveries keep their independent policy. */
    removeRecordsBefore(before: number): Promise<void>;
}

/** A notification shown as a toast while its person is in the app. */
export interface InAppNoticeRepository {
    insert(notice: {
        id: string;
        userId: string;
        notificationId: string;
        title: string;
        body: string;
        link: string;
        createdAt: number;
    }): Promise<void>;
    /** The person's unseen ones made after `since`, oldest first, at most `limit`. */
    unseen(userId: string, since: number, limit: number): Promise<InAppNotice[]>;
    markSeen(userId: string, ids: readonly string[], now: number): Promise<void>;
    removeBefore(before: number): Promise<void>;
}

/** A notification's image, behind a random token until it expires. */
export interface NotificationImageRepository {
    insert(image: {
        token: string;
        userId: string;
        mediaType: string;
        bytes: Uint8Array;
        expiresAt: number;
    }): Promise<void>;
    /** The image while its token works. */
    live(token: string, now: number): Promise<{ mediaType: string; bytes: Uint8Array } | undefined>;
    removeExpired(now: number): Promise<void>;
}

/** The context's own settings (the sealed Web Push key pair). */
export interface NotificationSettingRepository {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
}

export interface NotificationRepositories {
    subscriptions: PushSubscriptionRepository;
    notifications: NotificationRepository;
    inApp: InAppNoticeRepository;
    images: NotificationImageRepository;
    settings: NotificationSettingRepository;
}
