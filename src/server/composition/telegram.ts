/**
 * Telegram's part of the graph: its layers (`telegram/layer.ts`) over what the
 * boot made: the workspace's Telegram links behind `Links`, `TelegramConfig`
 * from the process's config, and `ChannelServices`, what the channel uses of
 * other features, from their tags.
 *
 * Not here: `Channel`, which the boot step makes after the graph is built
 * (`composition/lifecycle/telegram.ts`, then `LeaderWork.useTelegram`),
 * from the `ChannelServices` built here, read from the built services
 * (`AppEdge.services`). The bot's settings
 * come from `telegramFromEnv`, which logs and throws: it runs in that boot
 * step, on the environment the entry hands it, as it did.
 */
import { Effect, Layer } from 'effect';

import type { SetupStatus } from '@socio/shared/types';

import { AppsTelegram } from '../apps/contract.js';
import type { TelegramConfigShape } from '../telegram/contract.js';
import { ChannelServicesLive, LinksLive, TelegramConfigLive } from '../telegram/layer.js';
import { TelegramHost, type TelegramHostShape } from '../telegram/tags.js';
import type { TelegramChannel } from '../telegram/telegram-channel.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import { Ports } from './ports.js';

/**
 * What `telegram/` reads of the process's config (`PlatformConfig`): the
 * app's address for links in direct messages (`APP_ORIGIN`). The bot's
 * settings and `TELEGRAM_API_ROOT` aren't in it: the boot step reads them
 * from the environment it is given, as before (moving that parsing here is
 * a later change).
 */
export const telegramConfig = (config: { appOrigin?: string }): TelegramConfigShape => ({
    appOrigin: config.appOrigin,
});

/**
 * What the Telegram module's hooks read of the platform's Telegram
 * (`TelegramHost`): the channel, from its late-bound port at each use (the
 * boot step sets it after the graph, `useTelegram`), and the setup status,
 * from its late-bound port at each use (`composition/app/status.ts` fills
 * it). Builds nothing.
 */
export const telegramHost = (
    channel: () => TelegramChannel | undefined,
    setup: (userId?: string) => Promise<SetupStatus>,
): TelegramHostShape => ({
    get channel() {
        return channel();
    },
    setup: (userId) => setup(userId),
});

const TelegramHostLive = Layer.effect(
    TelegramHost,
    Effect.gen(function* () {
        const ports = yield* Ports;
        return telegramHost(
            () => ports.telegram.peek(),
            (userId) => ports.setup.get().setup(userId),
        );
    }),
);

/**
 * Telegram's steps of the graph: `links` first, with the leaf bridges
 * (`Links`, the links the workspace holds: the same object, so the steps
 * that read it yield it instead of providing a copy); `bridges` at its
 * end, `TelegramConfig` and `ChannelServices` over the workspace and the
 * other features' tags, with what the modules' hooks read (`TelegramHost`,
 * the apps' `AppsTelegram`).
 */
export const telegramLayers = {
    links: Layer.unwrap(
        Effect.gen(function* () {
            return LinksLive((yield* LegacyWorkspace).telegram);
        }),
    ),
    bridges: Layer.mergeAll(
        TelegramHostLive,
        // The links the workspace holds, as the apps module's routes read
        // them (`AppsTelegram`).
        Layer.effect(
            AppsTelegram,
            LegacyWorkspace.useSync((workspace) => workspace.telegram),
        ),
        TelegramConfigLive(
            Effect.gen(function* () {
                return telegramConfig(yield* LegacyConfig);
            }),
        ),
        ChannelServicesLive(
            Effect.gen(function* () {
                return yield* LegacyWorkspace;
            }),
        ),
    ),
};
