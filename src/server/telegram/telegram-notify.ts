import type { NotificationTarget } from '@socio/shared/notifications';

import type { ChannelResult, NotificationChannel, RenderedNotification } from '../notifications/contract.js';

import type { ChannelShape, LinksShape } from './contract.js';

/** The channel as notifications use it: `TelegramChannel`, when configured. */
export type NotifyingChannel = Pick<ChannelShape, 'status' | 'sendDirect'> & {
    sendPhotoDirect(
        telegramUserId: string,
        bytes: Buffer,
        mediaType: string,
        caption: string,
        signal?: AbortSignal,
    ): Promise<unknown>;
};

/** Telegram's limit for a photo's caption. */
export const CAPTION_LIMIT = 1024;

/**
 * Telegram as a notification channel (CB-114): a direct message from the
 * bot to the person's linked Telegram account. It reaches them only while
 * they're linked and the bot is online; `telegram-module.ts` registers it
 * whether or not Telegram is configured, so Account → Notifications says
 * why it reaches nowhere. Off until the person turns it on
 * (`DEFAULT_CHANNEL_PREFERENCES`): Telegram keeps bot messages readable
 * on its servers, so private mode ("<Dot> needs you") suits it.
 *
 * The message is the title, the body and the link, without a link
 * preview; an image is uploaded by the bot (`sendPhotoDirect`), so
 * Telegram never fetches it from the brain or anywhere else. Nothing here
 * logs the message.
 */
export function telegramNotificationChannel(platform: {
    readonly telegram?: NotifyingChannel;
    readonly workspace: { readonly telegram: Pick<LinksShape, 'linkFor'> };
}): NotificationChannel {
    const online = () => platform.telegram?.status === 'online';
    const linkFor = (userId: string) => platform.workspace.telegram.linkFor(userId);
    return {
        id: 'telegram',
        label: 'Telegram',
        async targets(userId): Promise<NotificationTarget[]> {
            const link = await linkFor(userId);
            if (!link || !online()) {
                return [];
            }
            return [
                {
                    id: link.telegramUserId,
                    label: link.username ? `@${link.username}` : 'Telegram',
                    createdAt: link.linkedAt,
                },
            ];
        },
        async note(userId) {
            if (!(await linkFor(userId))) {
                return 'Link your Telegram account first (Settings → Telegram).';
            }
            if (!online()) {
                return 'Telegram is not connected right now.';
            }
            return undefined;
        },
        async send(userId, target, notification, signal): Promise<ChannelResult> {
            const cancelled = () => ({
                outcome: 'failed' as const,
                error: 'Notification delivery canceled; external outcome may be unknown.',
            });
            if (signal?.aborted) {
                return cancelled();
            }
            // Relinked or unlinked since the targets were read: not theirs now.
            if ((await linkFor(userId))?.telegramUserId !== target.id) {
                return { outcome: 'gone' };
            }
            if (signal?.aborted) {
                return cancelled();
            }
            const channel = platform.telegram;
            try {
                if (!channel) {
                    throw new Error('Telegram is not connected.');
                }
                if (notification.image) {
                    await channel.sendPhotoDirect(
                        target.id,
                        notification.image.bytes,
                        notification.image.mediaType,
                        captionOf(notification),
                        signal,
                    );
                } else {
                    await channel.sendDirect(target.id, textOf(notification), signal);
                }
                return { outcome: 'sent' };
            } catch (error) {
                return {
                    outcome: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        },
    };
}

/** "<title>\n<body>\n\n<link>". */
export const textOf = (notification: RenderedNotification) =>
    `${notification.title}\n${notification.body}\n\n${notification.url}`;

/**
 * The text as a photo's caption: within `CAPTION_LIMIT`, the body cut
 * short ("…") before the title or the link is, so the link still opens.
 */
export function captionOf(notification: RenderedNotification) {
    const text = textOf(notification);
    if (text.length <= CAPTION_LIMIT) {
        return text;
    }
    const { title, url } = notification;
    const room = CAPTION_LIMIT - `${title}\n…\n\n${url}`.length;
    return room > 0 ? `${title}\n${clip(notification.body, room)}…\n\n${url}` : clip(text, CAPTION_LIMIT);
}

/** At most `max` UTF-16 units (as Telegram counts), never half a character. */
const clip = (text: string, max: number) => {
    const cut = text.slice(0, max);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};
