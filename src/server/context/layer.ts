/**
 * The context's layer: its stores on the workspace connection, the fitting, the
 * replies reactions are for, and the steering turns, each offered under its
 * contract tag and built from other features' tags. Only the composition
 * (`composition/context.ts`) and tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Cycles } from '../cycles/contract.js';
import { Media } from '../media/contract.js';
import { EventReplay } from '../replay/contract.js';
import { Orchestrator } from '../rooms/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Runner } from '../turns/contract.js';
import { Conversations, People, Socios } from '../workspace/contract.js';

import { ChatNotes, ContextFitting, DotReplies, Reactions, Steering, TimeMarkers, WaitingTurns } from './contract.js';
import { contextFitting } from './fit.js';
import { contextNotes } from './notes.js';
import { dotReplies } from './reaction-routes.js';
import { messageReactions } from './reactions.js';
import type { SteeringTurnSources } from './sources.js';
import { SteeringTurns } from './steering-turns.js';
import { steeringQueue } from './steering.js';
import { timeMarkers } from './time-markers.js';

/**
 * The stores every caller gets on `db` (one per connection: their
 * constructors only keep it) and the fitting, under their tags.
 */
export const contextStores = (db: DatabaseSync) =>
    Context.make(ChatNotes, contextNotes(db)).pipe(
        Context.add(TimeMarkers, timeMarkers(db)),
        Context.add(ContextFitting, contextFitting),
        Context.add(Steering, steeringQueue(db)),
        Context.add(Reactions, messageReactions(db)),
    );

/** `ChatNotes`, `TimeMarkers`, `ContextFitting`, `Steering` and `Reactions` on `db`. */
export const ContextStoresLive = (db: DatabaseSync) => Layer.effectContext(Effect.sync(() => contextStores(db)));

/** A Dot's stored replies (`dotMessage`), over the `Runner` and `EventReplay`. */
export const DotRepliesLive = Layer.effect(
    DotReplies,
    Effect.gen(function* () {
        return dotReplies(yield* Runner, yield* EventReplay);
    }),
);

/**
 * What the composition gives the steering turns besides the tags: the drain
 * (the `draining` port), setup (`AppStatus.setup`) and
 * the log, read at the moment of use; the conversations' Telegram facts
 * (`Links.threadInfo`, which `telegram/`, above context in the folder
 * order, offers); and the Dots' agents (`DotAgents`, which `dots/`, also
 * above context, offers).
 */
export type SteeringLate = Pick<SteeringTurnSources, 'draining' | 'setup' | 'log' | 'links' | 'agents'>;

/** The steering turns over the tags (and `late`); built once, as the constructor did. */
export const makeSteeringTurns = (late: SteeringLate) =>
    Effect.gen(function* () {
        const sources: SteeringTurnSources = {
            queue: yield* Steering,
            runner: yield* Runner,
            conversations: yield* Conversations,
            socios: yield* Socios,
            people: yield* People,
            links: late.links,
            settings: yield* WorkspaceSettings,
            orchestrator: yield* Orchestrator,
            cycles: yield* Cycles,
            media: yield* Media,
            agents: late.agents,
            draining: () => late.draining(),
            setup: () => late.setup(),
            log: (line) => late.log(line),
        };
        return new SteeringTurns(sources);
    });

/** `WaitingTurns`: the steering turns, built from the tags. */
export const SteeringTurnsLive = (late: SteeringLate) => Layer.effect(WaitingTurns, makeSteeringTurns(late));
