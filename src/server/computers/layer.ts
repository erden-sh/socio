/**
 * The computers' layers: they implement `contract.ts`'s `Computers`,
 * `ComputerWork` and `Screenshots`. The service is built from the tags it
 * reads: the workspace's `Socios`, the computers' own `ComputerRecords` (which
 * the workspace store still holds), `ComputersConfig`, the settings'
 * `WorkspaceSettings` (whether agents are paused), and `ComputersBoot`, the
 * dots' computer hooks, which no feature's tag offers yet. Only the composition
 * root (`composition/computers.ts`) and tests import this file.
 *
 * The service stays the promise-based `ComputerService`: its callers (the
 * routes, the tools, other features) await it as before.
 */
import { Context, Effect, Layer } from 'effect';

import type { ComputerHooks } from '@socio/foundation/turns/turn';

import { WorkspaceSettings } from '../settings/contract.js';
import { Socios, type SociosShape } from '../workspace/contract.js';

import { abortComputerActions, ComputerService, computerActionsInFlight } from './computer-service.js';
import { screenshotResult } from './computer-tools.js';
import {
    ComputerRecords,
    Computers,
    ComputersConfig,
    ComputerWork,
    Screenshots,
    type ComputerRecordsShape,
    type ComputersConfigShape,
} from './contract.js';

/**
 * What the boot step hands the computers that no feature's tag offers: the
 * computer hooks the modules give every Dot turn (`DotExtensions.computer`:
 * the data space's token for an exec, and the end of a computer session).
 */
export interface ComputersBootShape {
    readonly hooks?: ComputerHooks;
}

export class ComputersBoot extends Context.Service<ComputersBoot, ComputersBootShape>()(
    'socio/computers/ComputersBoot',
) {}

/** Everything the platform's computer service is made of, from the tags or a platform built on its own. */
export interface ComputerParts extends ComputersBootShape {
    readonly socios: Pick<SociosShape, 'dot' | 'dots'>;
    readonly records: ComputerRecordsShape;
    readonly config: ComputersConfigShape;
    /** Whether an admin paused the agents, read on every agent action. */
    readonly paused: () => boolean;
}

/**
 * The platform's computer service. Each read goes to its slice at the
 * moment of use; the records object is the one the workspace store holds,
 * so the service shares its stuck browsers and restarts with every Dot
 * turn's own service on that workspace.
 */
export function makeComputers(parts: ComputerParts): ComputerService {
    const { socios, records } = parts;
    return new ComputerService(
        {
            dot: (id) => socios.dot(id),
            dots: () => socios.dots(),
            computers: records,
        },
        parts.config,
        parts.paused,
        undefined,
        undefined,
        parts.hooks,
    );
}

/** The service, from the tags it reads. */
export const computerService = Effect.gen(function* () {
    const settings = yield* WorkspaceSettings;
    return makeComputers({
        socios: yield* Socios,
        records: yield* ComputerRecords,
        config: yield* ComputersConfig,
        paused: () => settings.settings().paused,
        hooks: (yield* ComputersBoot).hooks,
    });
});

/** `Computers`, over a service built once. */
export const ComputersLive = Layer.effect(Computers, computerService);

/**
 * The computer actions in progress, across every `ComputerService` of the
 * process (each Dot turn has its own): the module's own set.
 */
export const ComputerWorkLive = Layer.succeed(
    ComputerWork,
    ComputerWork.of({ inFlight: computerActionsInFlight, abort: abortComputerActions }),
);

/** A screenshot's result as history keeps it (CB-157). */
export const ScreenshotsLive = Layer.succeed(Screenshots, Screenshots.of({ result: screenshotResult }));
