/**
 * Memory's construction: the memory layer (`memory/layer.ts`) over the
 * repositories the core store holds (`CoreStore`), and `MemoryConfig` built
 * here from the startup configuration. Nothing here builds a repository: the
 * core store already has them.
 */
import { Effect, Layer } from 'effect';

import {
    MemoryConfig,
    MemorySpaces,
    MemoryTelegram,
    type MemoryConfigShape,
    type MemorySpacesShape,
    type MemoryTelegramShape,
} from '../memory/contract.js';
import { MemoryLive } from '../memory/layer.js';
import { Access as SpaceAccess } from '../spaces/contract.js';
import { Links } from '../telegram/contract.js';

import { LegacyConfig, LegacyStore } from './base.js';
import { SharedChatsLive } from './context.js';

/**
 * `MemoryConfig` from the startup configuration (`LegacyConfig`, the
 * `PlatformConfig` the boot step read): its two retentions, as Settings'
 * `limitDefaults` reads them. The entry parses them with composition's
 * environment readers; this function builds the config from what it supplies.
 */
export function memoryConfig(config: MemoryConfigShape): MemoryConfigShape {
    return MemoryConfig.of({
        episodeRetentionDays: config.episodeRetentionDays,
        spaceMemoryRetentionDays: config.spaceMemoryRetentionDays,
    });
}

/**
 * The ports memory's module declares over telegram's `Links` and the
 * Spaces' `Access` (`MemoryTelegram`, `MemorySpaces`): those very objects.
 */
export const memoryPorts = (above: { telegram: MemoryTelegramShape; spaceAccess: MemorySpacesShape }) =>
    Layer.mergeAll(Layer.succeed(MemoryTelegram, above.telegram), Layer.succeed(MemorySpaces, above.spaceAccess));

/**
 * Memory's step of the graph: the store's five repositories, a turn's
 * recall (`TurnMemory`), time zones (`TimeZones`), Space memory
 * (`SpaceMemory`, with the retention in force read at each sweep) and the
 * Memories page's view (`MemoriesView`), with `MemoryConfig`. Telegram's
 * links, which a turn's recall reads, are the graph's (`telegramLayers.links`,
 * with the leaf bridges at the front of the chain); they and the Spaces'
 * access, both above memory in the folder order, are read here from their
 * tags and given to memory's layer, and offered to its module as the ports
 * it declares (`memoryPorts`). The context's tools' `SharedChats` is
 * `TurnMemory`, offered here where it is built.
 */
export const memoryLayers = {
    bridges: Layer.unwrap(
        Effect.gen(function* () {
            const store = yield* LegacyStore;
            const config = yield* LegacyConfig;
            const above = { telegram: yield* Links, spaceAccess: yield* SpaceAccess };
            return SharedChatsLive.pipe(
                Layer.provideMerge(MemoryLive(store, above)),
                Layer.provideMerge(Layer.succeed(MemoryConfig, memoryConfig(config))),
                // The ports the module's tools read them through.
                Layer.provideMerge(memoryPorts(above)),
            );
        }),
    ),
};
