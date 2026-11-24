/**
 * The integrations' construction: `integrations/layer.ts` offers each
 * repository tag over one set of repositories; this step builds them once on
 * the workspace's connection. The context reads no configuration (no
 * `IntegrationsConfig`), and has no routes, module or lifecycle of its own.
 * Telegram, the web reader and the computers each use their own repository
 * set through `composition/integration-stores.ts`; domains already reads the
 * repository tags.
 */
import { Effect, Layer } from 'effect';

import { integrationRepositories, integrationsContext } from '../integrations/layer.js';

import { LegacyWorkspace } from './base.js';

/**
 * The integrations' step of the graph: each repository tag, over one set
 * of repositories built once on the workspace's connection.
 */
export const integrationsLayers = {
    bridges: Layer.effectContext(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            return integrationsContext(integrationRepositories(db));
        }),
    ),
};
