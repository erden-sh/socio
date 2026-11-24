/**
 * Service accounts' construction: `service-accounts/layer.ts` in the graph.
 */
import { Effect, Layer } from 'effect';

import { ServiceAccountsDatabase, ServiceAccountsLive, ServiceAccountsService } from '../service-accounts/layer.js';

import { LegacyWorkspace } from './base.js';

/**
 * Service accounts, under the graph's `LegacyServiceAccounts` tag (`platform.serviceAccounts`):
 * the layer's whole service.
 */
export { ServiceAccountsService as LegacyServiceAccounts };

/**
 * Service accounts' step of the graph: `ServiceAccountsLive`, the service
 * under `Accounts` (and whole, as `ServiceAccountsService`), on the
 * workspace's connection. They read no config, so there is no
 * `ServiceAccountsConfig`; no step registers a listener, and there is
 * nothing to start or stop.
 */
export const serviceAccountsLayers = {
    serviceAccounts: ServiceAccountsLive.pipe(
        Layer.provide(
            Layer.effect(
                ServiceAccountsDatabase,
                Effect.gen(function* () {
                    return (yield* LegacyWorkspace).db;
                }),
            ),
        ),
    ),
};
