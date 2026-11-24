/**
 * Notifications from Dots (CB-114): a Dot calls `notify_user` for the
 * person it works for, and the server sends it to the channels that person
 * turned on (Web Push, Telegram, later others), unless they are using the
 * brain right now (presence).
 */

/** What a channel shows: the Dot's message, or only "<Dot> needs you". */
export const NOTIFICATION_CONTENT = ['message', 'private'] as const;
export type NotificationContent = (typeof NOTIFICATION_CONTENT)[number];

/** One person's choice for one channel. */
export interface ChannelPreference {
    enabled: boolean;
    content: NotificationContent;
}

/** By channel id (`push`, `telegram`); a channel not listed has its default. */
export type NotificationPreferences = Record<string, ChannelPreference>;

/**
 * Push is on once a device is added (adding one is the choice); Telegram
 * is off until switched on: Telegram keeps bot messages readable. A new
 * channel is off until its person turns it on.
 */
export const DEFAULT_CHANNEL_PREFERENCES: Readonly<Record<string, ChannelPreference>> = {
    push: { enabled: true, content: 'message' },
    telegram: { enabled: false, content: 'message' },
};
export const channelPreference = (
    preferences: NotificationPreferences | undefined,
    channel: string,
): ChannelPreference =>
    preferences?.[channel] ??
    DEFAULT_CHANNEL_PREFERENCES[channel] ?? {
        enabled: false,
        content: 'message',
    };

/** A place one channel reaches: a browser for push, the linked account for Telegram. */
export interface NotificationTarget {
    id: string;
    label: string;
    createdAt?: number;
}

/** `GET /api/notifications/channels`: what Account → Notifications shows. */
export interface NotificationChannelView {
    id: string;
    label: string;
    enabled: boolean;
    content: NotificationContent;
    targets: NotificationTarget[];
    /** Why it reaches nowhere yet (no device, Telegram not linked). */
    note?: string;
}

/**
 * What the service worker gets (encrypted end to end). `kind` lets richer
 * notifications come later: the worker shows kinds it knows, and any
 * other as this generic one.
 */
export interface PushPayload {
    kind: 'message';
    title: string;
    body: string;
    /** A path in the brain, opened on a click. */
    link: string;
    icon?: string;
    image?: string;
    /** Notifications with one tag replace each other (one per chat). */
    tag?: string;
}

/** A notification shown in the app instead, while its person is using it. */
export interface InAppNotice {
    id: string;
    title: string;
    body: string;
    link: string;
    createdAt: number;
}

/** What `notify_user` tells the Dot. */
export type NotifyOutcome = 'sent' | 'present' | 'shown_in_app' | 'unreachable' | 'rate_limited';

/**
 * The header each tab's `/api/state` poll carries while the person is
 * using it (visible, focused, input in the last minute): the path shown.
 */
export const PRESENCE_HEADER = 'X-CB-Presence';
/** `POST` with `sendBeacon` when a tab is hidden or closed. */
export const PRESENCE_AWAY_PATH = '/api/notifications/away';
/** Input counts as using the brain for this long. */
export const PRESENCE_INPUT_MS = 60_000;

/** `notify_user`'s limits per day: per Dot and person, and per person. */
export interface NotificationDailyLimits {
    perDot: number;
    perUser: number;
}
export const DEFAULT_NOTIFICATION_LIMITS: NotificationDailyLimits = {
    perDot: 20,
    perUser: 40,
};

export const NOTIFY_LIMITS = {
    message: 500,
    title: 80,
    link: 500,
    imageBytes: 1024 * 1024,
};
