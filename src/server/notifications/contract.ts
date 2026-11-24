/**
 * What other features may know of notifications (CB-114): their tags, the
 * slices of the service they call, and the plain types a module needs to
 * add a channel or send a notice. It imports only `effect` and `@socio/*`,
 * and holds no logic.
 *
 * The types here moved from `channel.ts`, `service.ts`, `presence.ts` and
 * `push.ts`, whose re-exports were later dropped. `NotificationService`
 * implements `Notifier`, `NotificationChannels`, `AppDeliveries` and
 * `InAppNotices`; its `presence` (`PresenceTracker`) implements `UserPresence`
 * and its `push` (`PushChannel`) implements `PushKeys`. `layer.ts` provides
 * every tag over one service.
 *
 * Moved to packages: `notificationLimits` (the limits in force) to
 * `@socio/shared/notifications/limits`, and `parsePresence` and `isTabId`
 * (the presence header) to `@socio/shared/notifications/presence`.
 *
 * Not here, on purpose:
 * - `NOTIFICATIONS_SEALED_SQL` stays in `infra/sqlite/sealed.ts`: SQL on the
 *   Notifications tables stays inside its infra
 *   (tests/integration/notification-boundary.test.ts). Backup's recovery
 *   drill should get it from the composition root.
 * - `notificationLimitsFromEnv` and `pushSettingsFromEnv` read the
 *   environment for `PlatformConfig`, in `composition/config.ts`;
 *   only the entry (`index.ts`) calls them. `composition/notifications.ts`
 *   builds `NotificationsConfig` from that config.
 * - The image route (`/notification-images/:token`) and the account routes
 *   are notifications' own: `NotificationService.image`, `views`, `test`,
 *   `seenInApp`, `usage`, `reachable` and `prune` have no tag.
 */
import { Context } from 'effect';

import type { SealState } from '@socio/foundation/keys/secret-box';
import type {
    InAppNotice,
    NotificationDailyLimits,
    NotificationTarget,
    NotifyOutcome,
} from '@socio/shared/notifications';
import type { Dot } from '@socio/shared/types';
import type { UserPreferences } from '@socio/shared/voice/dictation';

// ── Channels ─────────────────────────────────────────────────────────────

/** An image to show with a notification, kept in the brain (images.ts). */
export interface NotificationImage {
    bytes: Buffer;
    mediaType: string;
    /** Its address in the brain: `/notification-images/<token>`, absolute. */
    url: string;
}

/** A notification as one channel shows it, after its person's content choice. */
export interface RenderedNotification {
    title: string;
    body: string;
    /** The page it opens: a path in the brain, and that path as an absolute URL. */
    path: string;
    url: string;
    /** The Dot's avatar, absolute. */
    icon?: string;
    /** Never in private mode. */
    image?: NotificationImage;
    /** One per chat: a newer one replaces it. */
    tag?: string;
}

export type ChannelResult =
    | { outcome: 'sent' }
    /** The target no longer exists (an expired push subscription). */
    | { outcome: 'gone' }
    | { outcome: 'failed'; error: string };

/**
 * A way to reach a person (CB-114): Web Push (push.ts), Telegram
 * (telegram-notify.ts), later others. A module registers its channel with
 * `platform.notifications.register`, so a new one needs no change to
 * `notify_user`. Each person turns each channel on or off and picks what
 * it shows (`NotificationPreferences`).
 */
export interface NotificationChannel {
    id: string;
    label: string;
    /** Where it reaches this person now; none when it can't. */
    targets(userId: string): NotificationTarget[] | Promise<NotificationTarget[]>;
    /** Why it reaches nowhere, for Account → Notifications. */
    note?(userId: string): string | undefined | Promise<string | undefined>;
    send(
        userId: string,
        target: NotificationTarget,
        notification: RenderedNotification,
        signal?: AbortSignal,
    ): Promise<ChannelResult>;
}

/** What a notification says, before a channel's content choice. */
export interface NotificationContentInput {
    /** The Dot's name; the brain's own for a test. */
    from: string;
    title?: string;
    message: string;
    path: string;
    icon?: string;
    image?: NotificationImage;
    tag?: string;
}

// ── Notices ──────────────────────────────────────────────────────────────

/** One notification for one person, from a Dot's turn (tools.ts). */
export interface NotifyInput {
    userId: string;
    dot: { id: string; name: string };
    threadId: string;
    trigger: string;
    causeId: string | null;
    title?: string;
    message: string;
    /** A path in the brain; the turn's chat when not given. */
    path?: string;
    image?: Omit<NotificationImage, 'url'>;
}

export interface ChannelReport {
    channel: string;
    sent: number;
    failed: number;
}

export interface NotifyResult {
    outcome: NotifyOutcome;
    channels?: ChannelReport[];
    message: string;
}

/** A notice from Socio itself, without a Dot (`notifyFromApp`). */
export interface AppNotice {
    userId: string;
    trigger: string;
    title: string;
    message: string;
    path: string;
}

/** A trusted durable outbox's notice, under the id its caller claimed (`queueFromApp`). */
export interface QueuedAppNotice extends AppNotice {
    id: string;
}

/** A notice about a room for one of its members (`notifyPerson`, CB-216). */
export interface PersonNotice {
    userId: string;
    /** The room it is about: looking at it counts as present. */
    threadId?: string;
    dotId?: string;
    trigger: string;
    causeId: string | null;
    /** Who it is from, as the channels name it (the room, a socio). */
    from: string;
    title: string;
    message: string;
    path: string;
    icon?: string;
}

// ── Presence ─────────────────────────────────────────────────────────────

/**
 * `present`: looking at the chat the turn is in; `in_app`: using the brain
 * elsewhere; `away`: neither, as far as anything knows (presence.ts).
 */
export type Presence = 'present' | 'in_app' | 'away';

// ── Push ─────────────────────────────────────────────────────────────────

/**
 * The push services browsers subscribe with: FCM (Chrome, Android), WNS
 * (Edge on Windows), Apple (Safari, iPhone and iPad) and Mozilla
 * (Firefox), and the Socio mobile app's push relay (apps/push-relay). A
 * subscription's endpoint must be on one, over https, so a forged one
 * can't make the server call anything else.
 * `PUSH_ENDPOINT_HOSTS` replaces the list (tests: a fake on loopback), so
 * a deployment that sets it must name the relay's hosts too, or phones
 * lose their push.
 */
export const DEFAULT_PUSH_HOSTS = [
    '*.googleapis.com',
    '*.notify.windows.com',
    '*.push.apple.com',
    '*.push.services.mozilla.com',
    // The Socio push relay's hosts (production, then staging). Exact
    // names, never `*.socio.sh`: any other host on the domain would then
    // receive pushes. Bench tests of a relay on workers.dev set
    // `PUSH_ENDPOINT_HOSTS` themselves. A later host change adds the new
    // host and keeps the old ones until phones have re-registered on it.
    'push.socio.sh',
    'push-staging.socio.sh',
];

export interface PushSettings {
    /** Host patterns: `host` or `*.domain`. */
    hosts: readonly string[];
    /** Plain http too (only for a test's fake service on loopback). */
    allowHttp?: boolean;
}

// ── App deliveries ───────────────────────────────────────────────────────

/** The app outbox's external delivery queue, as `appDeliveryStatus` reports it. */
export interface AppDeliveryStatus {
    accepting: boolean;
    running: number;
    queued: number;
    concurrency: number;
    queueLimit: number;
    abortRequested: number;
    skipped: number;
    failedTasks: number;
}

/** What stopping the queue left: whether it drained in time, and its status. */
export interface AppDeliveryStop extends AppDeliveryStatus {
    drained: boolean;
}

// ── Notifier ─────────────────────────────────────────────────────────────

/**
 * Sending a notice (`LegacyNotifications`), as other folders and the
 * composition call it: a Dot's turn (`notify`, from coding's reports and
 * schedules' long-run reports), Socio itself to its admins and operators
 * (`notifyFromApp`), and rooms to their members (`notifyPerson`).
 * `NotificationService` implements it.
 */
export interface NotifierShape {
    /**
     * A Dot's notification: nothing while the person looks at the turn's
     * chat, a toast while they're elsewhere in the brain, else every channel
     * they turned on that reaches them, within the daily limits.
     */
    readonly notify: (input: NotifyInput, limits?: NotificationDailyLimits) => Promise<NotifyResult>;
    /** A notice from Socio itself; Dots' daily limits don't count it. */
    readonly notifyFromApp: (input: AppNotice) => Promise<ChannelReport[]>;
    /** A notice about a room for one of its members; the caller sends each cause once. */
    readonly notifyPerson: (input: PersonNotice) => Promise<{ presence: Presence; channels: ChannelReport[] }>;
}

export class Notifier extends Context.Service<Notifier, NotifierShape>()('socio/notifications/Notifier') {}

// ── NotificationChannels ─────────────────────────────────────────────────

/** Where a module adds its channel (Telegram's). `NotificationService` implements it. */
export interface NotificationChannelsShape {
    /** Adds a channel; returns its removal (a module's `stop`). */
    readonly register: (channel: NotificationChannel) => () => void;
}

export class NotificationChannels extends Context.Service<NotificationChannels, NotificationChannelsShape>()(
    'socio/notifications/NotificationChannels',
) {}

// ── AppDeliveries ────────────────────────────────────────────────────────

/**
 * The app outbox's notices and their external delivery queue, as issues'
 * subscriptions queue them and the platform resumes and stops the queue.
 * `NotificationService` implements it. (Issues' own `Deliveries` tag,
 * `socio/issues/Deliveries`, is the bridge over these methods.)
 */
export interface AppDeliveriesShape {
    /** Records the notice and its in-app fallback; the caller claims its id in this same unit. */
    readonly queueFromApp: (input: QueuedAppNotice) => Promise<void>;
    readonly resumeAppDeliveries: () => void;
    readonly stopAppDeliveries: (timeoutMs?: number, signal?: AbortSignal) => Promise<AppDeliveryStop>;
}

export class AppDeliveries extends Context.Service<AppDeliveries, AppDeliveriesShape>()(
    'socio/notifications/AppDeliveries',
) {}

// ── InAppNotices ─────────────────────────────────────────────────────────

/** The person's unseen notices, as the state view reads them (`/api/state`). */
export interface InAppNoticesShape {
    /** The person's unseen notices of the last day, oldest first. */
    readonly inApp: (userId: string, now?: number) => Promise<InAppNotice[]>;
}

export class InAppNotices extends Context.Service<InAppNotices, InAppNoticesShape>()(
    'socio/notifications/InAppNotices',
) {}

// ── UserPresence ─────────────────────────────────────────────────────────

/**
 * Whether a person is using the brain right now, in memory (presence.ts):
 * the live poll reports tabs, Telegram reports messages, rooms read who is
 * looking. `PresenceTracker` implements it.
 */
export interface UserPresenceShape {
    /** A poll from one of the person's tabs: active on `path`, or not (undefined). */
    readonly tab: (userId: string, tab: string, path: string | undefined, now?: number) => void;
    /** The tab was hidden or closed. */
    readonly away: (userId: string, tab: string) => void;
    /** The person wrote in a Telegram conversation (its app thread). */
    readonly telegramMessage: (userId: string, threadId: string, now?: number) => void;
    readonly judge: (userId: string, threadId?: string, now?: number) => Presence;
    /** Who is looking at the chat now: the people with a fresh tab in use on it. */
    readonly viewing: (threadId: string, now?: number) => string[];
}

export class UserPresence extends Context.Service<UserPresence, UserPresenceShape>()(
    'socio/notifications/UserPresence',
) {}

// ── PushKeys ─────────────────────────────────────────────────────────────

/**
 * The Web Push key pair, sealed under the data key, as the platform counts
 * and re-seals stored credentials (CB-62). `PushChannel` implements it.
 */
export interface PushKeysShape {
    readonly sealStates: () => Promise<Record<SealState, number>>;
    /** Seals the key pair again under the current data key; idempotent. */
    readonly reseal: () => Promise<{ resealed: number; unreadable: number }>;
}

export class PushKeys extends Context.Service<PushKeys, PushKeysShape>()('socio/notifications/PushKeys') {}

// ── What notifications reads of the workspace ────────────────────────────

/**
 * The workspace reads notifications makes: a person's preferences, whether
 * they were deactivated, and a socio. Spelled out here so notifications
 * names no folder above it; the composition root provides
 * `NotificationsWorkspace` over the workspace's `People` and `Socios`
 * slices, each read at the moment of use.
 */
export interface NotificationsWorkspaceShape {
    preferences(userId: string): UserPreferences;
    isDeactivated(userId: string): boolean;
    dot(id: string): Dot | undefined;
}

export class NotificationsWorkspace extends Context.Service<NotificationsWorkspace, NotificationsWorkspaceShape>()(
    'socio/notifications/NotificationsWorkspace',
) {}

// ── The module's tools ───────────────────────────────────────────────────

/**
 * A goal by its schedule's task, for what started a `notify_user` turn:
 * schedules' `Goals.byTask`, by the slice the tool calls (schedules is
 * above notifications in the folder order, so the port is declared here
 * and the composition provides it from `Goals`).
 */
export interface NotificationGoalsShape {
    byTask(taskId: string): Promise<{ id: string } | undefined>;
}

export class NotificationGoals extends Context.Service<NotificationGoals, NotificationGoalsShape>()(
    'socio/notifications/NotificationGoals',
) {}

// ── Config ───────────────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields notifications reads. `PlatformConfig` has
 * each of them with this type, so the composition root can provide the tag
 * from it.
 */
export interface NotificationsConfigShape {
    /** `PUSH_ENDPOINT_HOSTS`: the push services subscriptions may use; `DEFAULT_PUSH_HOSTS` when unset. */
    readonly push?: PushSettings;
    /** The app's origin, for links, icons and images. */
    readonly appOrigin?: string;
    /** `NOTIFY_PER_*_DAILY`: `notify_user`'s limits under an admin's (`notificationLimits`). */
    readonly notificationLimits?: NotificationDailyLimits;
}

export class NotificationsConfig extends Context.Service<NotificationsConfig, NotificationsConfigShape>()(
    'socio/notifications/NotificationsConfig',
) {}
