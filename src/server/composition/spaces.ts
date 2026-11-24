/**
 * The Spaces feature's construction: Spaces' steps of the graph over
 * `spaces/layer.ts`.
 *
 * Spaces reads no `PlatformConfig` field, so there is no `SpacesConfig`
 * to build here (`spaces/contract.ts`).
 */
import { Context, Effect, Layer } from 'effect';

import { Creation } from '../spaces/contract.js';
import { SpaceCreation } from '../spaces/create.js';
import { AccessLive, spaceCreation, useSpaceContracts as useContractsOn } from '../spaces/layer.js';
import type { LocalAgentRunner } from '../turns/local-runner.js';

import { LegacyWorkspace } from './base.js';
import type { AppWorkspace } from './workspace-parts.js';

/** Private and deleted Spaces, each only while every live runtime enforces it. */
export function useSpaceContracts(workspace: AppWorkspace, runner: LocalAgentRunner) {
    useContractsOn(workspace.spaceAccess, runner.runtime.attach(workspace.db));
}

/** A socio's `create_space`, under the graph's `LegacySpaceCreation` tag. */
export class LegacySpaceCreation extends Context.Service<LegacySpaceCreation, SpaceCreation>()(
    'socio/composition/spaces/SpaceCreation',
) {}

/**
 * Spaces' steps of the graph, in the graph's order: the contracts on the
 * runtime record (offering the workspace's `Access`), then the creation
 * (offered as `Creation`, and as `LegacySpaceCreation`, one instance)
 * once the approvals exist. No step registers a listener; the creation
 * registers its approval capability, as it always has.
 */
export const spacesLayers = {
    contracts: AccessLive(
        Effect.gen(function* () {
            const workspace = yield* LegacyWorkspace;
            return { db: workspace.db, spaceAccess: workspace.spaceAccess };
        }),
    ),
    creation: Layer.effectContext(
        Effect.gen(function* () {
            const creation = yield* spaceCreation;
            return Context.make(LegacySpaceCreation, creation).pipe(Context.add(Creation, creation));
        }),
    ),
};
