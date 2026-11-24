// Its turns as a run source in Operations (CB-187): registered on load.
import '@socio/foundation/telegram/run-source';
import type { ModuleServicesAccess, ServerModule } from '../modules/contract.js';
import { NotificationChannels, type NotificationChannelsShape } from '../notifications/contract.js';
import { Jobs, LongRuns, type JobsShape, type LongRunsShape } from '../schedules/contract.js';
import { Audit } from '../workspace/contract.js';

import { Links, type LinksShape } from './contract.js';
import { TelegramHost, type TelegramHostShape } from './tags.js';
import type { TelegramChannel } from './telegram-channel.js';
import { TelegramJobProgress } from './telegram-jobs.js';
import { telegramNotificationChannel } from './telegram-notify.js';
import { telegramRoutes, type TelegramRoutesPlatform } from './telegram-routes.js';

/**
 * What the module's hooks hand on: the channel, when configured, the links, the
 * jobs and their long runs, the notification channels and the setup status. It
 * replaces `platform-needs.ts`; the hooks make it from the app's services
 * (`telegramOf`).
 */
export interface TelegramPlatform extends TelegramRoutesPlatform {
    readonly telegram?: TelegramChannel;
    readonly workspace: TelegramRoutesPlatform['workspace'] & {
        readonly telegram: Pick<LinksShape, 'linkFor' | 'createCode' | 'unlink' | 'threadInfo'>;
    };
    readonly jobs: JobsShape;
    readonly longRuns: LongRunsShape;
    readonly notifications: NotificationChannelsShape;
}

/**
 * `TelegramPlatform` over the app's services: the channel read from
 * `TelegramHost` at each use (it is set after the graph is built), the
 * links (`Links`), the audit, the jobs, the long runs and the
 * notification channels by their tags.
 */
const telegramOf = (services: ModuleServicesAccess): TelegramPlatform => {
    const host = services.get(TelegramHost);
    const audit = services.get(Audit);
    return {
        get telegram() {
            return host.channel;
        },
        workspace: { audit: (entry) => audit.audit(entry), telegram: services.get(Links) },
        setup: (userId) => host.setup(userId),
        jobs: services.get(Jobs),
        longRuns: services.get(LongRuns),
        notifications: services.get(NotificationChannels),
    };
};

/** Each runtime's removal of its Telegram notification channel, by its `TelegramHost`. */
const unregister = new WeakMap<TelegramHostShape, () => void>();
/** Each runtime's job progress messages (CB-145), by its `TelegramHost`. */
const progress = new WeakMap<TelegramHostShape, TelegramJobProgress>();

/**
 * Telegram: account linking routes, the channel's lifecycle and its
 * notification channel (CB-114). The channel itself is built from the
 * environment in index.ts (`platform.useTelegram`). The notification
 * channel is registered even when Telegram isn't configured: it then
 * reaches no one, and says so in Account → Notifications. A job started
 * from a direct message keeps a progress message there (CB-145).
 */
export const telegramModule: Omit<ServerModule, 'id' | 'migrations'> = {
    routes: ({ services }) => telegramRoutes(telegramOf(services)),
    start: async ({ services }) => {
        const key = services.get(TelegramHost);
        const platform = telegramOf(services);
        unregister.get(key)?.();
        unregister.set(key, platform.notifications.register(telegramNotificationChannel(platform)));
        if (platform.telegram) {
            progress.get(key)?.stop();
            const jobs = new TelegramJobProgress(platform);
            jobs.start();
            progress.set(key, jobs);
        }
        await platform.telegram?.start();
    },
    // Hands polling to the next leader (CB-108); replies to messages already
    // received still go out until stop.
    release: ({ services }) => services.get(TelegramHost).channel?.drain(),
    stop: async ({ services }) => {
        const key = services.get(TelegramHost);
        unregister.get(key)?.();
        unregister.delete(key);
        progress.get(key)?.stop();
        progress.delete(key);
        await key.channel?.stop();
    },
    setup: ({ services }) => {
        const { channel } = services.get(TelegramHost);
        return {
            telegram: channel?.status ?? 'not_configured',
            ...(channel?.username ? { telegramBot: channel.username } : {}),
        };
    },
};
