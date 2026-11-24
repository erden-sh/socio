/**
 * The souls layer: it implements `contract.ts`'s `SoulTools` over `Souls` (the
 * `SoulStore` the workspace builds, which the root offers) and the workspace's
 * `Socios` and `People` slices. Only the composition root
 * (`composition/souls.ts`) and tests import this file.
 */
import { Effect, Layer } from 'effect';

import { People, Socios } from '../workspace/contract.js';

import { Souls, SoulTools } from './contract.js';
import type { SoulServices } from './services.js';
import { soulTools } from './tools.js';

/** What `souls/` reads, from the tags. */
export const soulServices = Effect.gen(function* () {
    const services: SoulServices = {
        souls: yield* Souls,
        socios: yield* Socios,
        people: yield* People,
    };
    return services;
});

/** The socio's own Soul tool (CB-330), over the tags. */
export const SoulToolsLive = Layer.effect(
    SoulTools,
    Effect.gen(function* () {
        const services = yield* soulServices;
        return SoulTools.of({ tools: (turn) => soulTools(services, turn) });
    }),
);
