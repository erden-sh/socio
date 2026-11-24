import {
    type ChannelPreference,
    NOTIFICATION_CONTENT,
    type NotificationChannelView,
    type NotificationPreferences,
} from '@socio/shared/notifications';
import type { UserPreferences } from '@socio/shared/voice/dictation';

import type { AuthedFetch } from '../net/authed-fetch';

import { readAnswer } from './outbox-answers';
import type { WriteHold } from './session';
import type { NetworkSource } from './triggers';

// Settings → Notifications' requests, the scope's `notificationSettings`,
// online only and never through the outbox:
// - **The channels** (`GET /api/notifications/channels`): each channel's on/off,
//   what it shows and where it goes (its targets), as the web's Notifications
//   section reads them.
// - **A channel's change** is `PATCH /api/preferences {notifications}`, which
//   replaces the whole map, so it is built the web's way
//   (`mergedNotifications`): the stored preferences (the shell's workspace row),
//   then the listed channels, then the change. A channel the server didn't list
//   keeps what was stored. What it shows is per channel, for every device.
// - **Room presence** (`PATCH /api/preferences {roomPresence}`), the same rule.
// - **The test** (`POST /api/notifications/test`) goes to every channel that's
//   on and every device on it, and links to `/settings/notifications`.
// - **Refused before any request** (`blocked()`) while NetInfo says offline, the
//   server is away or writes wait (`writeHold`); reading the channels goes while
//   writes wait. The screen says "Needs a connection". One request at a time:
//   a change while another is in flight is refused (`busy`); reading the
//   channels waits for it to end, then goes (a screen that retried at once
//   would spin). `dispose` wakes the reads still waiting, which answer
//   `no-answer` and send nothing, as does every request after it.
// - Every preferences answer (the whole stored preferences) goes into the
//   shell's workspace row (`confirmPreferences`), so the next change merges over it.
// No React Native: tests/sync runs it under Node against a fake fetch.

export const CHANNELS_PATH = '/api/notifications/channels';
export const PREFERENCES_PATH = '/api/preferences';
export const TEST_PATH = '/api/notifications/test';

/** `GET /api/notifications/channels`. */
export interface ChannelsAnswer {
    readonly channels: readonly NotificationChannelView[];
}

/** `POST /api/notifications/test`: per channel that's on and reaches somewhere. */
export interface TestReport {
    readonly channel: string;
    readonly sent: number;
    readonly failed: number;
}

/** Why nothing can be sent now. */
export type NotificationSettingsBlock = 'offline' | 'away' | 'sign-in' | 'update';

/** What a request came to. */
export type NotificationSettingsOutcome<T> =
    | { readonly kind: 'done'; readonly value: T }
    /** Nothing was sent (offline, away, a sign-in or an update). */
    | { readonly kind: 'blocked'; readonly reason: NotificationSettingsBlock }
    /** Nothing was sent: another request is in flight (a change; a read waits for it). */
    | { readonly kind: 'busy' }
    /** A refusal: its `code`, else `http-<status>`. */
    | { readonly kind: 'refused'; readonly reason: string }
    /** It went and no answer came. */
    | { readonly kind: 'no-answer' };

export interface NotificationSettingsOptions {
    readonly fetch: AuthedFetch;
    readonly network: NetworkSource;
    /** Whether the server is away (the scheduler's status). */
    readonly away: () => boolean;
    /** Why writes wait (session.ts's `writeHold`). */
    readonly hold: () => WriteHold;
    /** The person's stored preferences, as the shell's workspace row holds them. */
    readonly stored: () => UserPreferences | undefined;
    /** The server's answer to a preferences change: the whole stored preferences. */
    readonly confirmPreferences: (preferences: UserPreferences) => void;
}

export interface NotificationSettings {
    /** Why nothing can be sent now, or null. */
    blocked(): NotificationSettingsBlock | null;
    /** Whether a request is in flight. */
    busy(): boolean;
    /** Calls `listener` after each change of `blocked()` or `busy()`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Reads the channels; while another request is in flight, waits for it to end first (never `busy`). */
    channels(): Promise<NotificationSettingsOutcome<ChannelsAnswer>>;
    /** Saves one channel's change over `listed` (the channels as shown) and the stored preferences. */
    saveChannel(
        listed: readonly NotificationChannelView[],
        channel: string,
        change: Partial<ChannelPreference>,
    ): Promise<NotificationSettingsOutcome<UserPreferences>>;
    setRoomPresence(hidden: boolean): Promise<NotificationSettingsOutcome<UserPreferences>>;
    sendTest(): Promise<NotificationSettingsOutcome<readonly TestReport[]>>;
    /** Stops listening to the network; waiting reads and later requests answer `no-answer`, sending nothing. */
    dispose(): void;
}

/**
 * The whole notifications map a change sends, the web's way: the stored
 * preferences (kept for channels this server doesn't list now), then the
 * listed channels as they show, then the change.
 */
export function mergedNotifications(
    stored: NotificationPreferences | undefined,
    listed: readonly Pick<NotificationChannelView, 'id' | 'enabled' | 'content'>[],
    channel: string,
    change: Partial<ChannelPreference>,
): NotificationPreferences {
    const all: NotificationPreferences = {
        ...stored,
        ...Object.fromEntries(listed.map((item) => [item.id, { enabled: item.enabled, content: item.content }])),
    };
    const before = all[channel];
    if (before === undefined) {
        throw new Error(`No channel ${channel} to change.`);
    }
    all[channel] = { ...before, ...change };
    return all;
}

const isContent = (value: unknown) =>
    typeof value === 'string' && (NOTIFICATION_CONTENT as readonly string[]).includes(value);

/** The channels answer, its items checked; null for anything else. */
function readChannels(body: unknown): ChannelsAnswer | null {
    const channels = (body as { channels?: unknown } | null)?.channels;
    if (!Array.isArray(channels)) {
        return null;
    }
    const ok = channels.every(
        (item: Partial<NotificationChannelView> | null) =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.id === 'string' &&
            typeof item.label === 'string' &&
            typeof item.enabled === 'boolean' &&
            isContent(item.content) &&
            Array.isArray(item.targets),
    );
    return ok ? { channels: channels as NotificationChannelView[] } : null;
}

function readReports(body: unknown): readonly TestReport[] | null {
    const channels = (body as { channels?: unknown } | null)?.channels;
    if (!Array.isArray(channels)) {
        return null;
    }
    return channels.flatMap((item: Partial<TestReport> | null) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.channel === 'string' &&
        typeof item.sent === 'number' &&
        typeof item.failed === 'number'
            ? [{ channel: item.channel, sent: item.sent, failed: item.failed }]
            : [],
    );
}

const readPreferences = (body: unknown): UserPreferences | null =>
    body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as UserPreferences) : null;

export function createNotificationSettings(options: NotificationSettingsOptions): NotificationSettings {
    const { fetch, network, away, hold, stored, confirmPreferences } = options;
    const listeners = new Set<() => void>();
    let inFlight = false;
    /** Reads waiting for the request in flight to end; kept apart from `listeners`, which `dispose` clears. */
    const waiting = new Set<() => void>();
    let disposed = false;
    const wakeWaiting = () => {
        const woken = [...waiting];
        waiting.clear();
        for (const wake of woken) {
            wake();
        }
    };
    let connected: boolean | null = null;
    const tell = () => {
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const unsubscribe = network.subscribe((next) => {
        if (next.connected !== null && next.connected !== connected) {
            connected = next.connected;
            tell();
        }
    });
    network
        .current()
        .then((next) => {
            if (connected === null && next.connected !== null) {
                connected = next.connected;
                tell();
            }
        })
        .catch(() => {});

    const blocked = (): NotificationSettingsBlock | null => {
        if (connected === false) {
            return 'offline';
        }
        if (away()) {
            return 'away';
        }
        return hold();
    };

    /**
     * One request, refused before sending while blocked; while busy a write is
     * refused and a read waits for the other to end. `read` takes the 2xx body
     * (null: unreadable).
     */
    const once = async <T>(
        path: string,
        init: { method: 'GET' | 'POST' | 'PATCH'; json?: unknown },
        read: (body: unknown) => T | null,
        writes: boolean,
    ): Promise<NotificationSettingsOutcome<T>> => {
        // Checked again right before it goes, with no await between: two reads woken together go one at a time.
        while (!writes && inFlight && !disposed) {
            await new Promise<void>((resolve) => waiting.add(resolve));
        }
        // Disposed (while it waited or before): the settings are gone, so nothing goes.
        if (disposed) {
            return { kind: 'no-answer' };
        }
        const reason = blocked();
        if (reason !== null && (writes || reason === 'offline' || reason === 'away')) {
            return { kind: 'blocked', reason };
        }
        if (inFlight) {
            return { kind: 'busy' };
        }
        inFlight = true;
        tell();
        try {
            let answer;
            try {
                answer = await readAnswer(await fetch(path, init.json === undefined ? { method: init.method } : init));
            } catch {
                return { kind: 'no-answer' };
            }
            if (answer.status < 200 || answer.status >= 300) {
                return { kind: 'refused', reason: answer.code ?? `http-${answer.status}` };
            }
            const value = read(answer.body);
            return value === null ? { kind: 'refused', reason: `http-${answer.status}` } : { kind: 'done', value };
        } finally {
            inFlight = false;
            tell();
            wakeWaiting();
        }
    };

    const patch = async (json: Partial<UserPreferences>) => {
        const outcome = await once(PREFERENCES_PATH, { method: 'PATCH', json }, readPreferences, true);
        if (outcome.kind === 'done') {
            confirmPreferences(outcome.value);
        }
        return outcome;
    };

    return {
        blocked,
        busy: () => inFlight,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        channels: () => once(CHANNELS_PATH, { method: 'GET' }, readChannels, false),
        saveChannel(listed, channel, change) {
            return patch({ notifications: mergedNotifications(stored()?.notifications, listed, channel, change) });
        },
        setRoomPresence: (hidden) => patch({ roomPresence: hidden ? 'hidden' : 'shown' }),
        sendTest: () => once(TEST_PATH, { method: 'POST', json: {} }, readReports, true),
        dispose() {
            disposed = true;
            unsubscribe();
            listeners.clear();
            wakeWaiting();
        },
    };
}
