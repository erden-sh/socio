import type { NotificationChannelView, NotificationContent } from '@socio/shared/notifications';
import type { UserPreferences } from '@socio/shared/voice/dictation';

import type { NotificationSettingsBlock, NotificationSettingsOutcome, TestReport } from '../sync/notification-settings';

// Settings → Notifications' words and rows, from the web's NotificationsSection
// and Rooms card:
// each channel on or off and what it shows, which applies to every device on
// it; whether rooms show the person; this phone's own "Show message text"; the
// test, which goes to every device and channel that's on. No quiet hours: the
// web has none. No React Native, so tests/shell runs it under
// Node.

export const NOTIFICATIONS_TITLE = 'Notifications';

/** Settings' row to the screen. */
export const NOTIFICATIONS_ROW = {
    title: 'Notifications',
    subtitle: 'Where socios reach you, what they show, and a test.',
    testID: 'settings-notifications-screen',
} as const;

export const INTRO =
    'A socio can notify you when something needs you: unattended work that finished, a problem, a decision only you can make. It goes to the channels you turn on here, and only while you aren’t using Socio. While you are, it shows in the app instead.';

/** Under the channels: what a channel's choice reaches. */
export const CHANNELS_NOTE = 'What each channel shows applies to every device on it, this phone’s included.';

export const CONTENT_CHOICES: readonly {
    readonly value: NotificationContent;
    readonly label: string;
    readonly note: string;
}[] = [
    {
        value: 'message',
        label: 'Show the message',
        note: 'The socio’s name, its message and, where the device shows one, its image.',
    },
    {
        value: 'private',
        label: 'Private (“<socio> needs you”)',
        note: 'Only which socio needs you: the message stays in Socio until you open it.',
    },
];

/** This phone's own setting: shown here, kept on the phone (registry migration 7). */
export const SHOW_TEXT_ROW = {
    title: 'Show message text in notifications',
    subtitle: 'On this phone only. Off, notifications say only that something is new in the workspace.',
    testID: 'notifications-show-text',
} as const;

export const PRESENCE_ROW = {
    title: 'Hide my presence in rooms',
    subtitle: 'Room members won’t see your avatar while you have their room open.',
    testID: 'notifications-hide-presence',
} as const;

export const TEST_COPY = {
    title: 'Send a test notification',
    note: 'Sends a test to every device and channel that’s on, even while you’re here.',
    sending: 'Sending…',
    nothing: 'No channel is on, so nothing was sent. Turn one on above.',
} as const;

/**
 * Show-text was kept, but the phone's notifications didn't take it: they keep
 * the old setting until Socio next starts, which hands it over again.
 */
export const SHOW_TEXT_PENDING = 'Saved. Notifications follow it the next time Socio starts.';

export const LOADING = 'Loading…';
export const SAVE_FAILED = 'Couldn’t save that. Try again.';
export const LOAD_FAILED = 'Couldn’t load your notifications.';
export const NO_ANSWER = 'No answer from the workspace. Check before you try again.';
export const TRY_AGAIN = 'Try again';

/** Why a request can't go now, in the screen's words. */
export const BLOCK_COPY: Readonly<Record<NotificationSettingsBlock, string>> = {
    offline: 'Needs a connection',
    away: 'Needs a connection',
    'sign-in': 'Sign in again to do this',
    update: 'Update Socio to do this',
};

/** What an outcome says on screen, or null when it worked (or another request is going). */
export function outcomeCopy(outcome: NotificationSettingsOutcome<unknown>, failed: string): string | null {
    switch (outcome.kind) {
        case 'done':
        case 'busy':
            return null;
        case 'blocked':
            return BLOCK_COPY[outcome.reason];
        case 'no-answer':
            return NO_ANSWER;
        case 'refused':
            return outcome.reason === 'http-401' ? BLOCK_COPY['sign-in'] : failed;
    }
}

/** One channel as the screen draws it. */
export interface ChannelRow {
    readonly id: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly content: NotificationContent;
    /** Where it goes ("Goes to Pixel, Firefox on Mac."), or why it reaches nowhere. */
    readonly reaches: string;
    readonly testID: string;
}

/** The channels as listed, in the server's order. */
export function channelRows(channels: readonly NotificationChannelView[]): ChannelRow[] {
    return channels.map((channel) => ({
        id: channel.id,
        label: channel.label,
        enabled: channel.enabled,
        content: channel.content,
        reaches:
            channel.targets.length > 0
                ? `Goes to ${channel.targets.map((target) => target.label).join(', ')}.`
                : (channel.note ?? 'It reaches nowhere yet.'),
        testID: `notifications-channel-${channel.id}`,
    }));
}

/** The channels with one change shown at once, before the server answers. */
export function withChange(
    channels: readonly NotificationChannelView[],
    id: string,
    change: Partial<Pick<NotificationChannelView, 'enabled' | 'content'>>,
): NotificationChannelView[] {
    return channels.map((channel) => (channel.id === id ? { ...channel, ...change } : channel));
}

/** This phone's label as the server lists it on the push channel (its subscription), or null. */
export function thisPhoneLabel(
    channels: readonly NotificationChannelView[],
    subscriptionId: string | null,
): string | null {
    if (subscriptionId === null) {
        return null;
    }
    const push = channels.find((channel) => channel.id === 'push');
    return push?.targets.find((target) => target.id === subscriptionId)?.label ?? null;
}

/** Whether the person hides their presence in rooms (the web's `roomPresence`, shown unless 'hidden'). */
export const presenceHidden = (preferences: UserPreferences | undefined) => preferences?.roomPresence === 'hidden';

/** "Push notifications (2 sent)", "Telegram (1 failed)". */
const reportLine = (label: string, sent: number, failed: number) =>
    `${label} (${[sent > 0 ? `${sent} sent` : '', failed > 0 ? `${failed} failed` : ''].filter(Boolean).join(', ')})`;

/** What the test's answer says, the web's words. */
export function testLine(reports: readonly TestReport[], channels: readonly NotificationChannelView[]): string {
    const label = (id: string) => channels.find((channel) => channel.id === id)?.label ?? id;
    const reached = reports.filter((report) => report.sent > 0 || report.failed > 0);
    return reached.length === 0
        ? TEST_COPY.nothing
        : `Sent to ${reached.map((report) => reportLine(label(report.channel), report.sent, report.failed)).join(' and ')}.`;
}
