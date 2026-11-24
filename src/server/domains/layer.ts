/**
 * The domains layer: one `DomainsService`, offered as `Domains`, over the
 * Integrations context's hosts and operations (`DomainHostsRepo`,
 * `DomainOpsRepo`) and the settings in `DomainsConfig`, which the composition
 * builds from the supplied configuration. Only the composition
 * (`composition/domains.ts`) and tests import this file.
 */
import { Context, Effect, Layer } from 'effect';

import type { UnitOfWork } from '@socio/data/uow';

import { DomainHostsRepo, DomainOpsRepo } from '../integrations/contract.js';

import { Domains, DomainsConfig } from './contract.js';
import { DomainsService, type DomainsServiceOptions } from './service.js';
import { DomainsStore } from './store.js';

/**
 * What the layer takes besides its tags: the unit of work on the
 * repositories' connection (a host's read-then-write is one), and the
 * service's log line, fetch and clock (`DomainsServiceOptions`).
 */
export interface DomainsDeps extends Omit<DomainsServiceOptions, 'config'> {
    readonly uow: UnitOfWork;
}

/** The service, over `DomainsConfig`, `DomainHostsRepo` and `DomainOpsRepo`. */
export const makeDomains = ({ uow, ...options }: DomainsDeps) =>
    Effect.gen(function* () {
        const { domains } = yield* DomainsConfig;
        const store = new DomainsStore({ hosts: yield* DomainHostsRepo, ops: yield* DomainOpsRepo, uow });
        return new DomainsService(store, { ...options, config: domains });
    });

/** The service under its tag. */
export const domainsContext = (domains: DomainsService) => Context.make(Domains, domains);

/** `Domains`, built once; needs `DomainsConfig`, `DomainHostsRepo` and `DomainOpsRepo`. */
export const DomainsLive = (deps: DomainsDeps) => Layer.effectContext(Effect.map(makeDomains(deps), domainsContext));
