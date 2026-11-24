/**
 * Socio-actor access's layers: they implement `contract.ts` (`Actors`,
 * `AppActors`) over the tags of the features it reads. Only the composition
 * root (`composition/actors.ts`) and tests import this file.
 *
 * What it reads of the features below it in the folder order
 * (scripts/feature-ranks.json) it yields by their contracts' tags:
 * `People`, `Socios` and `Conversations` (the workspace), `Flags`,
 * `RuntimeIdentity`, and its own `ActorsConfig`. What it reads of the rest
 * (a Telegram thread's kind), and what no contract's tag holds yet, it
 * declares here, and the composition root provides it (`ActorsHost`).
 *
 * The service is made by one function (`makeActors`), which both the layer
 * and `buildActors` call (through `composition/actors.ts`), so
 * the two build the same service and register the same listener, in the
 * same order. Its class is also offered by `ActorAccessTag`, which the
 * apps' step and the routes read it from (as `LegacyActors`).
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import type { FlagsShape } from '../flags/contract.js';
import { Flags } from '../flags/contract.js';
import { RuntimeIdentity, type RuntimeOwnershipShape } from '../runtime/contract.js';
import {
    Conversations,
    People,
    Socios,
    type AccessChange,
    type ConversationsShape,
    type PeopleShape,
    type SociosShape,
} from '../workspace/contract.js';

import { appActorAccess } from './apps.js';
import { Actors, ActorsConfig, AppActors, type ActorsConfigShape, type ConversationState } from './contract.js';
import { ActorAccess } from './service.js';

// ── What the composition root provides ───────────────────────────────────

/**
 * What socio access reads that no tag below it holds: the workspace's
 * access changes (`WorkspaceStore.onAccessChange`), a schedule's task
 * (`Store.task`; schedules' `Tasks` isn't offered yet), and a Telegram
 * thread's kind (telegram's `Links.threadInfo`, a folder above actors).
 */
export interface ActorsHostShape {
    /** Hears each change of who may reach what (a socio, a person, a conversation). */
    onAccessChange(listener: (change: AccessChange) => void): unknown;
    /** A live task; a deleted one is missing. */
    task(id: string): Promise<unknown>;
    /** Whether a conversation came from Telegram, and as which kind of chat. */
    threadInfo(threadId: string): Promise<{ readonly kind: string } | undefined>;
}

export class ActorsHost extends Context.Service<ActorsHost, ActorsHostShape>()('socio/actors/ActorsHost') {}

// ── The service's class, under its own tag ───────────────────────────────

/** Socio-actor access, under the graph's `ActorAccessTag` tag (the class). Other features see `Actors`. */
export class ActorAccessTag extends Context.Service<ActorAccessTag, ActorAccess>()('socio/actors/ActorAccess') {}

// ── The service, made the same way on both paths ─────────────────────────

/** What `makeActors` reads. */
export interface ActorsDeps {
    /** The workspace connection, where the actors' tables live. */
    db: DatabaseSync;
    /** This runtime on that connection (CB-108). */
    ownership: RuntimeOwnershipShape;
    config: ActorsConfigShape;
    people: Pick<PeopleShape, 'hasUser' | 'isDeactivated'>;
    socios: Pick<SociosShape, 'canUseDot'>;
    conversations: Pick<ConversationsShape, 'thread'>;
    /** The flags, read at each check. */
    flags: () => Pick<FlagsShape, 'enabled'>;
    host: ActorsHostShape;
}

/**
 * Socio-actor access (CB-232), and its grants checked again on each access
 * change.
 */
export function makeActors(deps: ActorsDeps): ActorAccess {
    const { people, socios, host } = deps;
    const actors = new ActorAccess(deps.db, {
        // Grants and credentials any of the app's runtimes accepts (CB-108).
        ownership: deps.ownership,
        secret: deps.config.secret,
        deps: {
            personActive: (userId) => people.hasUser(userId) && !people.isDeactivated(userId),
            socioUsable: (userId, dotId) => socios.canUseDot(userId, dotId),
            featureOn: (userId, flag) => deps.flags().enabled(flag, userId),
            conversation: (id) => conversationState(deps, id),
        },
        log: (line) => console.log(line),
    });
    // A socio archived or its Spaces changed, a role changed, a chat
    // archived or deleted: those grants are checked again now, not at the
    // next minute's sweep.
    host.onAccessChange((change) => {
        void actors
            .reevaluate(change)
            .catch(() => console.error('Socio access: re-checking grants after a change failed.'));
    });
    return actors;
}

/**
 * Where a grant's conversation stands now (CB-232): a person's
 * chat, a room, a schedule's runs, a Telegram group or topic (refused
 * until it is a room), or gone.
 */
export async function conversationState(
    deps: Pick<ActorsDeps, 'conversations' | 'host'>,
    id: string,
): Promise<ConversationState> {
    if (id.startsWith('schedule:')) {
        return (await deps.host.task(id.slice('schedule:'.length))) ? 'schedule' : 'gone';
    }
    const thread = deps.conversations.thread(id);
    if (!thread || thread.archivedAt) {
        return 'gone';
    }
    if (thread.kind === 'room') {
        return 'room';
    }
    if (thread.team) {
        return 'telegram-group';
    }
    const telegram = await deps.host.threadInfo(id);
    return telegram && telegram.kind !== 'dm' ? 'telegram-group' : 'private';
}

// ── Layers ───────────────────────────────────────────────────────────────

/**
 * Socio-actor access on the workspace's connection, built once, under
 * `ActorAccessTag` and `Actors`, with `AppActors` over it (built once).
 */
export const ActorsLive = (db: DatabaseSync) =>
    Layer.mergeAll(
        Layer.effect(
            Actors,
            Effect.gen(function* () {
                return yield* ActorAccessTag;
            }),
        ),
        Layer.effect(
            AppActors,
            Effect.gen(function* () {
                return appActorAccess(yield* ActorAccessTag);
            }),
        ),
    ).pipe(
        Layer.provideMerge(
            Layer.effect(
                ActorAccessTag,
                Effect.gen(function* () {
                    const identity = yield* RuntimeIdentity;
                    const flags = yield* Flags;
                    return makeActors({
                        db,
                        ownership: identity.attach(db),
                        config: yield* ActorsConfig,
                        people: yield* People,
                        socios: yield* Socios,
                        conversations: yield* Conversations,
                        flags: () => flags,
                        host: yield* ActorsHost,
                    });
                }),
            ),
        ),
    );
