/**
 * The runtime's tags, implemented: the process's identity, its config, and
 * the drain. The composition root (`composition/runtime.ts`) provides them
 * from what the boot made: the identity the runner holds and the
 * `LeaderWork` drain, read when each layer is built.
 *
 * Not here yet: `WorkControl`. Its counts and force stop need the task
 * runner, which the boot makes after the layers are built
 * (`composition/lifecycle/turns.ts`), so no layer can hold it yet.
 */
import { Effect, Layer } from 'effect';

import {
    Lifecycle,
    RuntimeConfig,
    RuntimeIdentity,
    type RuntimeConfigShape,
    type RuntimeIdentityShape,
} from './contract.js';

/**
 * `RuntimeIdentity`: the process's one runtime session (CB-108), which its
 * turns, job runs and coding sessions attach to. `identity` reads it when
 * the layer is built; the runner makes it today (`LocalAgentRunner.runtime`).
 */
export const RuntimeIdentityLive = <R>(identity: Effect.Effect<RuntimeIdentityShape, never, R>) =>
    Layer.effect(RuntimeIdentity, identity);

/**
 * `RuntimeConfig` as `config` reads it when the layer is built: from the
 * startup configuration the boot supplied (`PlatformConfig.environment`,
 * production when unset), never from the environment directly.
 */
export const RuntimeConfigLive = <R>(config: Effect.Effect<RuntimeConfigShape, never, R>) =>
    Layer.effect(
        RuntimeConfig,
        Effect.map(config, (read) => RuntimeConfig.of(read)),
    );

/** Where the drain lives: the `draining` port and `LeaderWork.drain()`. */
export interface DrainSource {
    /** Whether the server is draining, now. */
    draining(): boolean;
    /** Starts the drain; a second call does nothing. */
    drain(): void;
}

/**
 * `Lifecycle` over the drain `source` reads when the layer is built. Both
 * members read the source when they run, never when they are made, so a
 * drain started anywhere is seen at once.
 */
export const LifecycleLive = <R>(source: Effect.Effect<DrainSource, never, R>) =>
    Layer.effect(
        Lifecycle,
        Effect.map(source, (drain) =>
            Lifecycle.of({
                draining: Effect.sync(() => drain.draining()),
                drain: Effect.sync(() => drain.drain()),
            }),
        ),
    );
