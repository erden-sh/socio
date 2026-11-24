// The runtime's layers (`runtime/layer.ts`) and its step of the graph
// (`composition/runtime.ts`), with the tags they read stubbed.
import { Effect, Layer } from 'effect';
import { expect, it, vi } from 'vitest';

import { RuntimeSession } from '@socio/data/runtime-ownership';

import { LeaderWork, type LeaderWorkShape } from '../src/server/composition/app/work.js';
import { LegacyConfig, LegacyRunner } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { platformPorts, Ports } from '../src/server/composition/ports.js';
import { runtimeLayers } from '../src/server/composition/runtime.js';
import {
    Lifecycle,
    RuntimeConfig,
    RuntimeIdentity,
    type RuntimeIdentityShape,
} from '../src/server/runtime/contract.js';
import { LifecycleLive, RuntimeConfigLive, RuntimeIdentityLive } from '../src/server/runtime/layer.js';
import type { LocalAgentRunner } from '../src/server/turns/local-runner.js';

it('RuntimeIdentityLive serves the identity it reads when built', async () => {
    const session: RuntimeIdentityShape = new RuntimeSession({ heartbeat: false });
    const read = vi.fn(() => session);
    const layer = RuntimeIdentityLive(Effect.sync(read));
    expect(read).not.toHaveBeenCalled();
    const identity = await Effect.runPromise(RuntimeIdentity.use(Effect.succeed).pipe(Effect.provide(layer)));
    expect(identity).toBe(session);
    expect(read).toHaveBeenCalledTimes(1);
});

it('RuntimeConfigLive serves the config it reads when built', async () => {
    const read = vi.fn(() => ({ environment: 'development' as const }));
    const layer = RuntimeConfigLive(Effect.sync(read));
    expect(read).not.toHaveBeenCalled();
    const config = await Effect.runPromise(
        Effect.gen(function* () {
            return yield* RuntimeConfig;
        }).pipe(Effect.provide(layer)),
    );
    expect(config).toEqual({ environment: 'development' });
    expect(read).toHaveBeenCalledTimes(1);
});

it('LifecycleLive reads the drain when it runs, not when built', async () => {
    let draining = false;
    const drain = vi.fn(() => {
        draining = true;
    });
    const layer = LifecycleLive(Effect.succeed({ draining: () => draining, drain }));
    const read = Lifecycle.use((lifecycle) => lifecycle.draining).pipe(Effect.provide(layer));
    expect(await Effect.runPromise(read)).toBe(false);
    draining = true;
    expect(await Effect.runPromise(read)).toBe(true);
    draining = false;
    await Effect.runPromise(Lifecycle.use((lifecycle) => lifecycle.drain).pipe(Effect.provide(layer)));
    expect(drain).toHaveBeenCalledTimes(1);
    expect(await Effect.runPromise(read)).toBe(true);
});

/** The runtime's steps of the graph over stubs of what they read: the runner, the ports, `LeaderWork` and the supplied config. */
function runtimeStep(config: PlatformConfig) {
    const session = new RuntimeSession({ heartbeat: false });
    const ports = platformPorts();
    const drain = vi.fn(() => ports.draining.fill(true));
    const deps = Layer.mergeAll(
        Layer.succeed(LegacyRunner, { runtime: session } as unknown as LocalAgentRunner),
        Layer.succeed(Ports, ports),
        Layer.succeed(LeaderWork, { drain } as unknown as LeaderWorkShape),
        Layer.succeed(LegacyConfig, config),
    );
    return {
        session,
        drain,
        step: Layer.mergeAll(runtimeLayers.bridges, runtimeLayers.lifecycle).pipe(Layer.provide(deps)),
    };
}

it("the runtime's steps serve the runner's identity, the supplied config and LeaderWork's drain", async () => {
    const { session, drain, step } = runtimeStep({ environment: 'development' } as PlatformConfig);
    const result = await Effect.runPromise(
        Effect.gen(function* () {
            const identity = yield* RuntimeIdentity;
            const config = yield* RuntimeConfig;
            const lifecycle = yield* Lifecycle;
            const before = yield* lifecycle.draining;
            yield* lifecycle.drain;
            return { identity, config, before, after: yield* lifecycle.draining };
        }).pipe(Effect.provide(step)),
    );
    expect(result.identity).toBe(session);
    expect(result.config).toEqual({ environment: 'development' });
    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
    expect(drain).toHaveBeenCalledTimes(1);
});

it("the runtime's step takes RuntimeConfig from the supplied config, not the environment", async () => {
    const previous = process.env.APP_ENV;
    process.env.APP_ENV = 'development';
    try {
        const { step } = runtimeStep({} as PlatformConfig);
        const config = await Effect.runPromise(
            Effect.gen(function* () {
                return yield* RuntimeConfig;
            }).pipe(Effect.provide(step)),
        );
        // Unset in the supplied config: production, whatever APP_ENV says.
        expect(config).toEqual({ environment: 'production' });
    } finally {
        if (previous === undefined) {
            delete process.env.APP_ENV;
        } else {
            process.env.APP_ENV = previous;
        }
    }
});
