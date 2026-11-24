/**
 * Telegram's layers: the links behind `Links`, the config behind
 * `TelegramConfig`, and `ChannelServices`, what the channel uses of other
 * features, yielded from their tags. Only the composition
 * (`composition/telegram.ts`) and tests import this file.
 *
 * The channel itself (`Channel`) is not built here: the boot step makes it
 * after the graph, once auth knows who is a user and the bot's settings are
 * read from the environment (`composition/lifecycle/telegram.ts`), and
 * `LeaderWork.useTelegram` sets it, as before. That boot step builds it from
 * `ChannelServices`.
 */
import { Context, Effect, Layer } from 'effect';

import { DotReplies, Reactions } from '../context/contract.js';
import { DotAgents } from '../dots/contract.js';
import { MemoryItems } from '../memory/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { SkillRegistry } from '../skills/contract.js';

import { Links, TelegramConfig, type LinksShape, type TelegramConfigShape } from './contract.js';
import type { TelegramStore, TelegramTurnServices, TelegramWorkspace } from './slices.js';

/**
 * What the channel uses of the rest of the app (`TelegramChannelOptions`
 * without its own settings and the boot step's parts): the workspace, the
 * settings and memories, and the services of `TelegramTurnServices`.
 */
export interface ChannelServicesShape extends TelegramTurnServices {
    readonly workspace: TelegramWorkspace;
    readonly store: TelegramStore;
}

/** `ChannelServices`, built once in the graph and read by the boot step that makes the channel. */
export class ChannelServices extends Context.Service<ChannelServices, ChannelServicesShape>()(
    'socio/telegram/ChannelServices',
) {}

/** `Links`: the workspace's Telegram links store (`WorkspaceStore.telegram`), until it is built here. */
export const LinksLive = (links: LinksShape) => Layer.succeed(Links, links);

/** `TelegramConfig`, as the composition builds it. */
export const TelegramConfigLive = <R>(config: Effect.Effect<TelegramConfigShape, never, R>) =>
    Layer.effect(TelegramConfig, config);

/**
 * `ChannelServices` over `workspace` (the conversations, the socios and the
 * Telegram links store the channel binds them in) and the tags: `DotAgents`
 * for each turn's agent, `SkillRegistry` for the command menus, `Reactions`
 * and `DotReplies` for reactions in direct messages, and
 * `WorkspaceSettings` and `MemoryItems` for the pause and `/memories`.
 */
export const ChannelServicesLive = <R>(workspace: Effect.Effect<TelegramWorkspace, never, R>) =>
    Layer.effect(
        ChannelServices,
        Effect.gen(function* () {
            const settings = yield* WorkspaceSettings;
            return ChannelServices.of({
                workspace: yield* workspace,
                store: { settings: () => settings.settings(), memoryItems: yield* MemoryItems },
                agents: yield* DotAgents,
                skills: yield* SkillRegistry,
                reactions: yield* Reactions,
                replies: yield* DotReplies,
            });
        }),
    );
