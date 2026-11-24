/**
 * The domains feature's construction: `domains/layer.ts` builds the service and
 * offers it as `Domains`; this file builds `DomainsConfig` from the supplied
 * configuration and the hosts' and operations' repositories on the workspace
 * connection, and adds the tag the other steps read it from.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { sqliteData } from '@socio/data/open';

import { DomainsConfig, type DomainsConfigShape } from '../domains/contract.js';
import { domainsContext, makeDomains } from '../domains/layer.js';
import { DomainsService } from '../domains/service.js';
import { type DomainsRepositories } from '../domains/store.js';
import { DomainHostsRepo, DomainOpsRepo } from '../integrations/contract.js';
import { sqliteIntegrationRepositories } from '../integrations/infra/sqlite/index.js';

import { LegacyConfig, LegacyModuleContext } from './base.js';
import type { PlatformConfig } from './config.js';

/** What domains reads of the configuration: `PlatformConfig.domains`, as the entry parsed it. */
export const domainsConfig = (config: PlatformConfig): DomainsConfigShape => ({ domains: config.domains });

/**
 * The domains' hosts and operations on `db`, and the unit of work they
 * share (the Integrations context's SQLite repositories).
 */
export function domainsRepositories(db: DatabaseSync): DomainsRepositories {
    const data = sqliteData(db);
    const repositories = sqliteIntegrationRepositories(data);
    return { hosts: repositories.domainHosts, ops: repositories.domainOps, uow: data.uow };
}

/** Domains, under the graph's `LegacyDomains` tag (the class). */
export class LegacyDomains extends Context.Service<LegacyDomains, DomainsService>()(
    'socio/composition/domains/DomainsService',
) {}

/** `DomainsConfig`, from the process's config. */
const DomainsConfigLive = Layer.effect(
    DomainsConfig,
    Effect.gen(function* () {
        return domainsConfig(yield* LegacyConfig);
    }),
);

/**
 * The hosts' and operations' repositories on the modules' connection, for
 * this step only: the Integrations' own step, which offers the same tags,
 * comes later in the graph.
 */
const DomainRepositoriesLive = Layer.effectContext(
    Effect.gen(function* () {
        const { hosts, ops } = domainsRepositories((yield* LegacyModuleContext).db);
        return Context.make(DomainHostsRepo, hosts).pipe(Context.add(DomainOpsRepo, ops));
    }),
);

/**
 * Domains' step of the graph: `domains/layer.ts`'s service, offered as
 * `Domains` and `LegacyDomains`, with `DomainsConfig`. The module's
 * `succeed` hook still calls `recover()`, in the modules' order.
 */
export const domainsLayers = {
    domains: Layer.effectContext(
        Effect.gen(function* () {
            const { db, log } = yield* LegacyModuleContext;
            const domains = yield* makeDomains({ uow: sqliteData(db).uow, log });
            return domainsContext(domains).pipe(Context.add(LegacyDomains, domains));
        }),
    ).pipe(Layer.provide(DomainRepositoriesLive), Layer.provideMerge(DomainsConfigLive)),
};
