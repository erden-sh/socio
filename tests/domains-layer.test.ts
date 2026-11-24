// The domains layer and the composition's step build one `DomainsService` over
// the hosts' and operations' repositories, with the settings `DomainsConfig`
// carries from the supplied configuration.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { sqliteData } from '@socio/data/open';

import { LegacyConfig, LegacyModuleContext } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { domainsLayers, domainsRepositories, LegacyDomains } from '../src/server/composition/domains.js';
import { Domains, DomainsConfig } from '../src/server/domains/contract.js';
import { DomainsLive } from '../src/server/domains/layer.js';
import { DomainsService } from '../src/server/domains/service.js';
import { domainsSettingsFromEnv } from '../src/server/domains/settings.js';
import { DomainHostsRepo, DomainOpsRepo } from '../src/server/integrations/contract.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

function database() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return db;
}

/** Every setting there, pointing nowhere: nothing in these tests calls out. */
const configured = domainsSettingsFromEnv({
    DOMAINS_ZONE: 'example.test',
    DOMAINS_BASE: 'app.example.test',
    DOMAINS_TARGET_IP: '10.0.0.1',
    DOMAINS_UPSTREAM: 'http://app:4310',
    NPM_API_URL: 'http://npm.invalid/api',
    NPM_CREDENTIALS: JSON.stringify({ email: 'npm@example.test', password: 'npm-password' }),
    CLOUDFLARE_DNS_TOKEN: 'cf-token-0123',
    CLOUDFLARE_API_URL: 'http://cloudflare.invalid',
});

it('offers the service as Domains, from DomainsConfig and the repository tags', async () => {
    const db = database();
    const { hosts, ops, uow } = domainsRepositories(db);
    const layer = DomainsLive({ uow, log: () => {} }).pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(DomainsConfig, { domains: configured }),
                Layer.succeed(DomainHostsRepo, hosts),
                Layer.succeed(DomainOpsRepo, ops),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const domains = Context.get(context, Domains);
    expect(domains).toBeInstanceOf(DomainsService);
    expect(domains.enabled).toBe(true);
    // The store writes through the repositories it was given.
    const service = domains as DomainsService;
    await service.store.startOp('provision', 'x.example.test', 'olga');
    expect(await ops.latest(5)).toHaveLength(1);
    expect(await domains.recover()).toBe(1);
    expect((await ops.latest(5))[0].status).toBe('failed');
});

it("builds the graph's step from the supplied config on the modules' connection, under the legacy tag too", async () => {
    const db = database();
    const logs: string[] = [];
    const step = (config: PlatformConfig) =>
        domainsLayers.domains.pipe(
            Layer.provide(
                Layer.mergeAll(
                    Layer.succeed(LegacyConfig, config),
                    Layer.succeed(LegacyModuleContext, {
                        db,
                        data: sqliteData(db),
                        log: (line: string) => logs.push(line),
                    } as unknown as LegacyModuleContext['Service']),
                ),
            ),
        );
    const config = { domains: configured } as PlatformConfig;
    const context = await Effect.runPromise(Layer.build(step(config)).pipe(Effect.scoped));
    const domains = Context.get(context, LegacyDomains);
    expect(Context.get(context, Domains)).toBe(domains);
    expect(Context.get(context, DomainsConfig)).toEqual({ domains: configured });
    expect(domains.enabled).toBe(true);
    expect(domains.baseNames()).toEqual(['app.example.test', '*.app.example.test']);
    // The step's repositories stay inside it: the Integrations' step offers those tags.
    expect(Context.getOption(context as Context.Context<unknown>, DomainHostsRepo)._tag).toBe('None');
    // Its store is on the modules' connection.
    await domains.store.startOp('provision', 'x.example.test', 'olga');
    expect(db.prepare('SELECT COUNT(*) AS n FROM domain_ops').get()).toEqual({ n: 1 });

    // Without `domains` in the config the service is off, naming every setting.
    const off = await Effect.runPromise(Layer.build(step({} as PlatformConfig)).pipe(Effect.scoped));
    expect(Context.get(off, DomainsConfig)).toEqual({ domains: undefined });
    expect(Context.get(off, Domains).enabled).toBe(false);
    expect((await Context.get(off, Domains).status()).missing).toContain('DOMAINS_ZONE');
});
