/**
 * The runtime's part of the graph: its layers (`runtime/layer.ts`) over what
 * the boot made, the process's runtime identity, `RuntimeConfig` from the
 * supplied config, and the drain.
 *
 * Not yet: `WorkControl`, whose `running` and `forceStop` need the task
 * runner, made after the graph (`composition/lifecycle/turns.ts`).
 */
import { Effect, Layer } from 'effect';

import { LifecycleLive, RuntimeConfigLive, RuntimeIdentityLive } from '../runtime/layer.js';

import { LeaderWork } from './app/work.js';
import { LegacyConfig, LegacyRunner } from './base.js';
import { Ports } from './ports.js';

/**
 * The runtime's steps of the graph. `bridges`, a leaf bridge at its front:
 * the identity the runner made (`runner.runtime`, the one session its
 * turns, the job runs and the coding sessions attach to), and the supplied
 * config's `environment` (`APP_ENV`), production when unset. `lifecycle`,
 * placed after `LeaderWork`: the drain, its port read when the Effect
 * runs, and `LeaderWork.drain()`. It builds nothing and takes no listener,
 * and nothing in the graph yields `Lifecycle` (the operator routes read it
 * from the built services), so its place changes no order.
 */
export const runtimeLayers = {
    bridges: Layer.mergeAll(
        RuntimeIdentityLive(
            Effect.gen(function* () {
                return (yield* LegacyRunner).runtime;
            }),
        ),
        RuntimeConfigLive(
            Effect.gen(function* () {
                return { environment: (yield* LegacyConfig).environment ?? 'production' };
            }),
        ),
    ),
    lifecycle: LifecycleLive(
        Effect.gen(function* () {
            const ports = yield* Ports;
            const work = yield* LeaderWork;
            return { draining: () => ports.draining.get(), drain: () => work.drain() };
        }),
    ),
};
