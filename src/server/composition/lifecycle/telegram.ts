/**
 * Telegram's boot step, where the process entry ran it: after the graph is
 * built, the channel when the environment configures a bot, over the
 * `ChannelServices` the graph built (`composition/telegram.ts`), then sign-in
 * links through it. It stays a boot step, not a layer, so its lines keep their
 * place in phase 3; it fills `ports.telegram` through `LeaderWork.useTelegram`.
 *
 * Its start and stop stay the module's (`telegram/telegram-module.ts`):
 * the leader starts polling and every runtime stops it with the leader
 * work, in the modules' order, which a finalizer on the layer's scope
 * would not keep (the runtime is disposed after `LeaderWork.stop()`).
 */
import { Context } from 'effect';

import type { AuthSetup } from '../../auth/contract.js';
import type { AppEdge } from '../../main.js';
import type { SqliteStateStore } from '../../telegram/channel-state.js';
import { ChannelServices } from '../../telegram/layer.js';
import { TelegramChannel, telegramFromEnv } from '../../telegram/telegram-channel.js';
import { telegramSignInLinks } from '../../telegram/telegram-sign-in.js';
import { LeaderWork } from '../app/work.js';
import { LegacyRunner, LegacyWorkspace } from '../base.js';
import type { PlatformConfig } from '../config.js';
import type { CoreStore } from '../core-store.js';
import { LegacyMedia } from '../media.js';
import { LegacyNotifications } from '../notifications.js';
import { Ports } from '../ports.js';
import type { AppWorkspace } from '../workspace-parts.js';

/** The Telegram channel when it is configured, and sign-in links through it. */
export function startTelegram({
    edge,
    stateStore,
    isUser,
    auth,
    env,
}: {
    edge: AppEdge;
    /** The stores and config: the channel now reads them through `ChannelServices`. */
    store: CoreStore;
    workspace: AppWorkspace;
    config: PlatformConfig;
    /** Telegram's own state store, opened only when Telegram is on (index.ts runs the boot step first). */
    stateStore: () => SqliteStateStore;
    isUser: (userId: string) => boolean;
    auth: AuthSetup;
    env: Record<string, string | undefined>;
}) {
    const { services } = edge;
    const ports = Context.get(services, Ports);
    const telegramSettings = telegramFromEnv(env);
    if (telegramSettings) {
        const media = Context.get(services, LegacyMedia);
        const notifications = Context.get(services, LegacyNotifications);
        Context.get(services, LeaderWork).useTelegram(
            new TelegramChannel({
                settings: telegramSettings,
                runner: Context.get(services, LegacyRunner),
                // The workspace, the settings and memories, each turn's agent,
                // the skills and the reactions: from the graph's tags.
                ...Context.get(services, ChannelServices),
                attachments: (turn, messages) => media.ingest(turn, messages),
                // A linked person writing in a chat is present there (CB-114).
                presence: (userId, threadId) => notifications.presence.telegramMessage(userId, threadId),
                isUser,
                stateStore: stateStore(),
                // Testing only: a local fake Bot API instead of api.telegram.org.
                apiRoot: env.TELEGRAM_API_ROOT?.trim() || undefined,
            }),
        );
    }
    // One-time sign-in links go to the account's linked Telegram (Better Auth).
    if (ports.telegram.peek()) {
        const workspace = Context.get(services, LegacyWorkspace);
        auth.provider.useSignInLinks?.([
            telegramSignInLinks({
                // The channel's port (`Ports.telegram`), read at each use.
                get telegram() {
                    return ports.telegram.peek();
                },
                workspace,
            }),
        ]);
    }
}

/** Telegram's step, as lifecycle/index.ts runs it. */
export const telegramLifecycle = { start: startTelegram };
