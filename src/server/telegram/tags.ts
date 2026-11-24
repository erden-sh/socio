/**
 * What the Telegram module's hooks read of the platform's Telegram, by
 * tag: the channel, which the boot step sets after the graph is built
 * (`useTelegram`), and the setup status the link route reports. The
 * composition provides it over its late-bound port; `contract.ts` can't
 * name the channel's class.
 */
import { Context } from 'effect';

import type { SetupStatus } from '@socio/shared/types';

import type { TelegramChannel } from './telegram-channel.js';

export interface TelegramHostShape {
    /** The channel when configured, read at each use: it is set after the graph is built. */
    readonly channel: TelegramChannel | undefined;
    /** The setup status (`AppStatus.setup`), for the link route. */
    setup(userId?: string): Promise<SetupStatus>;
}

export class TelegramHost extends Context.Service<TelegramHost, TelegramHostShape>()('socio/telegram/TelegramHost') {}
