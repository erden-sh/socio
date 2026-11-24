import { Context, Effect, Layer } from 'effect';

/**
 * The computers' construction: the computers layer (`computers/layer.ts`) wired
 * into the graph at the step the server has always built it at.
 */
import type { ComputerService } from '../computers/computer-service.js';
import { ComputerRecords, Computers, ComputersConfig, type ComputersConfigShape } from '../computers/contract.js';
import { ComputersBoot, computerService, ComputerWorkLive, ScreenshotsLive } from '../computers/layer.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { LegacyDotExtensions } from './dots.js';
import { Ports } from './ports.js';

/** The computers, under the graph's `LegacyComputers` tag (the class): the same object `Computers` offers. */
export class LegacyComputers extends Context.Service<LegacyComputers, ComputerService>()(
    'socio/composition/computers/ComputerService',
) {}

/**
 * `ComputersConfig` from the supplied startup configuration
 * (`PlatformConfig`; moving env parsing here is a later change).
 */
const computersConfig = (config: PlatformConfig): ComputersConfigShape => ({
    computerSupervisorUrl: config.computerSupervisorUrl,
    computerSupervisorToken: config.computerSupervisorToken,
    computerToken: config.computerToken,
    computerNamespace: config.computerNamespace,
    computerDiskUsageUrl: config.computerDiskUsageUrl,
});

/**
 * The workspace's computer records: the workspace store still makes them
 * (moving them here is a later change), and every `ComputerService` on the
 * workspace reads the same object.
 */
const ComputerRecordsHere = Layer.effect(
    ComputerRecords,
    Effect.gen(function* () {
        return (yield* LegacyWorkspace).computers;
    }),
);

/**
 * The computers' step of the graph: the computers layer's service, which
 * fills its port, offered as `Computers` and `LegacyComputers`, with
 * `ComputersConfig`. `bridges`, a leaf bridge at the chain's front:
 * `ComputerRecords`, `ComputerWork` and `Screenshots`, which build nothing
 * and take no listener; this step and the apps' read them, and the
 * settings' tags, from the graph.
 */
export const computersLayers = {
    computers: Layer.effectContext(
        Effect.gen(function* () {
            const config = ComputersConfig.of(computersConfig(yield* LegacyConfig));
            const boot = ComputersBoot.of({ hooks: (yield* LegacyDotExtensions).computer });
            const computers = (yield* Ports).computers.fill(
                yield* computerService.pipe(
                    Effect.provideService(ComputersConfig, config),
                    Effect.provideService(ComputersBoot, boot),
                ),
            );
            return Context.make(LegacyComputers, computers).pipe(
                Context.add(Computers, computers),
                Context.add(ComputersConfig, config),
            );
        }),
    ),
    bridges: Layer.mergeAll(ComputerRecordsHere, ComputerWorkLive, ScreenshotsLive),
};
