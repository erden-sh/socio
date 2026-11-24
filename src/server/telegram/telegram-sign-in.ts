import { signInLinkMessage } from '@socio/foundation/auth/sign-in-links';

import type { SignInLinkSender } from '../auth/contract.js';

import type { ChannelShape, LinksShape } from './contract.js';

/**
 * One-time sign-in links by Telegram: a direct message from the bot to the
 * Telegram account linked to the app user (`telegram_links`), while the bot
 * is running. The message holds the link and a note, never the email.
 */
export function telegramSignInLinks(platform: {
    readonly telegram?: Pick<ChannelShape, 'status' | 'sendDirect'>;
    readonly workspace: { readonly telegram: Pick<LinksShape, 'linkFor'> };
}): SignInLinkSender {
    const linked = async (userId: string) => (await platform.workspace.telegram.linkFor(userId))?.telegramUserId;
    return {
        via: 'telegram',
        canDeliver: async (userId) => platform.telegram?.status === 'online' && !!(await linked(userId)),
        available: () => platform.telegram?.status === 'online',
        recipient: async (userId) => {
            const telegramUserId = await linked(userId);
            return telegramUserId ? String(telegramUserId) : null;
        },
        async deliver(userId, link) {
            const telegramUserId = await linked(userId);
            if (!telegramUserId || !platform.telegram) {
                throw new Error('This person has no linked Telegram.');
            }
            await platform.telegram.sendDirect(telegramUserId, signInLinkMessage(link));
        },
    };
}
