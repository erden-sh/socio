/**
 * Memory's layers: they implement `contract.ts`. Only the composition root and
 * tests import this file.
 *
 * The five repositories are the ones the core store holds
 * (`Store.memoryItems`, ...), constructed in `composition/core-store.ts`;
 * everything else is made once from tags: the repositories,
 * the workspace's slices (`People`, `Spaces`, `Socios`, `Audit`,
 * `Conversations`), the rooms' access, the workspace's settings and
 * memory's own `MemoryConfig`. The Spaces' access and Telegram's links,
 * which features above memory in the folder order offer, the composition
 * gives (`MemoryAbove`). Each service
 * calls today's functions with them, so nothing a caller sees changes.
 * Nothing is started here and nothing is read from the database: the
 * retention sweeps stay the memories module's tick (`module.ts`).
 */
import { Effect, Layer } from 'effect';

import { Access as RoomAccess } from '../rooms/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Audit, Conversations, People, Socios, Spaces } from '../workspace/contract.js';

import {
    Episodes,
    MemoriesView,
    MemoryConfig,
    MemoryItems,
    Profiles,
    SpaceMemories,
    SpaceMemory,
    TimeZoneNotes,
    TimeZones,
    TurnMemory,
    type EpisodeRepository,
    type MemoryRepository,
    type ProfileRepository,
    type SpaceMemoryRepository,
    type TimeZoneNoteRepository,
} from './contract.js';
import { timeZones, turnMemory } from './recall.js';
import { retentionInForce } from './retention.js';
import { memoriesViews } from './routes.js';
import { spaceMemoryService, type SpaceMemoryAccess } from './space-memory.js';
import type { TelegramThreads } from './turn.js';

/**
 * What memory reads of features above it in the folder order, which the
 * composition gives from their tags: Telegram's links (`Links`), for
 * whether a chat came from a Telegram group, and the Spaces' access
 * (`SpaceAccess`).
 */
export interface MemoryAbove {
    readonly telegram: TelegramThreads;
    readonly spaceAccess: SpaceMemoryAccess;
}

/** The repositories as the boot step's store holds them. */
export interface StoredMemoryRepositories {
    readonly memoryItems: MemoryRepository;
    readonly profiles: ProfileRepository;
    readonly timeZoneNotes: TimeZoneNoteRepository;
    readonly episodes: EpisodeRepository;
    readonly spaceMemories: SpaceMemoryRepository;
}

/** The five repositories, one tag each, the very objects the store holds. */
export const MemoryRepositoriesLive = (repositories: StoredMemoryRepositories) =>
    Layer.mergeAll(
        Layer.succeed(MemoryItems, repositories.memoryItems),
        Layer.succeed(Profiles, repositories.profiles),
        Layer.succeed(TimeZoneNotes, repositories.timeZoneNotes),
        Layer.succeed(Episodes, repositories.episodes),
        Layer.succeed(SpaceMemories, repositories.spaceMemories),
    );

/** A turn's recall (`TurnMemory`), over the repositories and what it reads of the workspace. */
export const TurnMemoryLive = ({ telegram, spaceAccess }: MemoryAbove) =>
    Layer.effect(
        TurnMemory,
        Effect.gen(function* () {
            const conversations = yield* Conversations;
            const spaces = yield* Spaces;
            const socios = yield* Socios;
            const roomAccess = yield* RoomAccess;
            return TurnMemory.of(
                turnMemory(
                    {
                        memoryItems: yield* MemoryItems,
                        profiles: yield* Profiles,
                        episodes: yield* Episodes,
                        spaceMemories: yield* SpaceMemories,
                    },
                    {
                        thread: (...args) => conversations.thread(...args),
                        spaces: (...args) => spaces.spaces(...args),
                        canAccessSpace: (...args) => socios.canAccessSpace(...args),
                        telegram,
                        roomAccess,
                        spaceAccess,
                    },
                ),
            );
        }),
    );

/** A person's time zone (`TimeZones`), over their profile and time zone notes. */
export const TimeZonesLive = Layer.effect(
    TimeZones,
    Effect.gen(function* () {
        return TimeZones.of(timeZones({ profiles: yield* Profiles, timeZoneNotes: yield* TimeZoneNotes }));
    }),
);

/**
 * Space memory (`SpaceMemory`), with the retention in force read at each
 * sweep: an admin's over `MemoryConfig`'s.
 */
export const SpaceMemoryLive = ({ spaceAccess }: Pick<MemoryAbove, 'spaceAccess'>) =>
    Layer.effect(
        SpaceMemory,
        Effect.gen(function* () {
            const people = yield* People;
            const socios = yield* Socios;
            const conversations = yield* Conversations;
            const audit = yield* Audit;
            const settings = yield* WorkspaceSettings;
            const config = yield* MemoryConfig;
            return SpaceMemory.of(
                spaceMemoryService(
                    { spaceMemories: yield* SpaceMemories },
                    {
                        users: (...args) => people.users(...args),
                        dot: (...args) => socios.dot(...args),
                        thread: (...args) => conversations.thread(...args),
                        allows: (...args) => conversations.allows(...args),
                        audit: (...args) => audit.audit(...args),
                        spaceAccess,
                    },
                    () => retentionInForce(settings.settings(), config).spaceMemoryRetentionDays,
                ),
            );
        }),
    );

/** What the Memories page shows its person (`MemoriesView`). */
export const MemoriesViewLive = Layer.effect(
    MemoriesView,
    Effect.gen(function* () {
        return MemoriesView.of(
            memoriesViews({
                memoryItems: yield* MemoryItems,
                profiles: yield* Profiles,
                timeZoneNotes: yield* TimeZoneNotes,
            }),
        );
    }),
);

/**
 * Memory: the repositories' tags over the store's, and the four services
 * over them, each made once; `above` from the composition.
 */
export const MemoryLive = (repositories: StoredMemoryRepositories, above: MemoryAbove) =>
    Layer.mergeAll(TurnMemoryLive(above), TimeZonesLive, SpaceMemoryLive(above), MemoriesViewLive).pipe(
        Layer.provideMerge(MemoryRepositoriesLive(repositories)),
    );
