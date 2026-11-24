/**
 * Service accounts' layers: they implement `contract.ts`. Only the composition
 * root (`composition/service-accounts.ts`) and tests import this file.
 *
 * One `ServiceAccounts`, built once on the workspace's connection, offered
 * whole (`ServiceAccountsService`: the admin routes and the composition
 * use every method) and as the contract's `Accounts` (what other features
 * call). Service accounts read no other feature and no config.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Accounts } from './contract.js';
import { ServiceAccounts } from './service-accounts.js';

/**
 * The workspace's connection, opened and migrated by the boot step, that the
 * accounts and keys live on. A stand-in for the app's `Database` tag, which no
 * feature offers yet: the composition root provides it from the workspace
 * store.
 */
export class ServiceAccountsDatabase extends Context.Service<ServiceAccountsDatabase, DatabaseSync>()(
    'socio/service-accounts/ServiceAccountsDatabase',
) {}

/**
 * The whole service, with the admin routes' methods, and what the
 * composition holds (`LegacyServiceAccounts`). Other features see `Accounts`.
 */
export class ServiceAccountsService extends Context.Service<ServiceAccountsService, ServiceAccounts>()(
    'socio/service-accounts/ServiceAccountsService',
) {}

/** The service on the connection; built once. */
export const ServiceAccountsServiceLive = Layer.effect(
    ServiceAccountsService,
    Effect.gen(function* () {
        return ServiceAccountsService.of(new ServiceAccounts(yield* ServiceAccountsDatabase));
    }),
);

/** `Accounts`: the same service, as the contract's slice. */
export const AccountsLive = Layer.effect(
    Accounts,
    Effect.gen(function* () {
        return Accounts.of(yield* ServiceAccountsService);
    }),
);

/** Both tags, over one service; needs `ServiceAccountsDatabase`. */
export const ServiceAccountsLive = AccountsLive.pipe(Layer.provideMerge(ServiceAccountsServiceLive));
