// Domains' contract: the error that moved there, `DomainsService` serves the
// shape, and the tags carry their `socio/domains/*` keys.
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import { domainsRepositories } from '../src/server/composition/domains.js';
import { Domains, DomainsConfig, DomainsError, type DomainsShape } from '../src/server/domains/contract.js';
import { DomainsService } from '../src/server/domains/service.js';
import { domainsSettingsFromEnv } from '../src/server/domains/settings.js';
import { DomainsStore } from '../src/server/domains/store.js';

import { testDatabase } from './helpers/test-database.js';

it('keeps the error a plain Error with its code, service and status', () => {
    const error = new DomainsError('busy', 'Another domain operation is running.', 'npm', 409);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainsError');
    expect([error.code, error.message, error.service, error.status]).toEqual([
        'busy',
        'Another domain operation is running.',
        'npm',
        409,
    ]);
});

it('the tags carry their keys', () => {
    expect(Domains.key).toBe('socio/domains/Domains');
    expect(DomainsConfig.key).toBe('socio/domains/DomainsConfig');
});

it('a DomainsService serves the shape, off without settings', async () => {
    const domains: DomainsShape = new DomainsService(new DomainsStore(domainsRepositories(testDatabase())), {
        config: domainsSettingsFromEnv({}),
        log: () => {},
    });
    const status = await Effect.runPromise(
        Domains.use((tag) => Effect.promise(() => tag.status())).pipe(Effect.provide(Layer.succeed(Domains, domains))),
    );
    expect(domains.enabled).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.missing).toContain('DOMAINS_ZONE');
    expect(await domains.recover()).toBe(0);
    await expect(domains.startEnsureBase('admin')).rejects.toMatchObject({ code: 'not_configured' });
});
