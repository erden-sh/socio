import { afterEach, expect, it } from 'vitest';

import { pluginUpdateAck, type PluginUpdateReview } from '@socio/shared/plugins/plugin-update';

import { parseManifest } from '../src/server/plugins/catalog.js';

import { cleanup, manifest, world } from './helpers/plugin-world.js';

// `bridge.openAnyHttps` is a sensitive scope: the server adopts it only
// for a request that acknowledges it, so a page loaded before the catalog
// changed can't grant it without showing the warning (#636 review).

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

type World = Awaited<ReturnType<typeof world>>;

/** Puts an embed's manifest in the catalog, as a catalog refresh (or a restart) would. */
const offer = (f: World, version: string, openAnyHttps: boolean) =>
    (f.platform.plugins as unknown as { catalog: Map<string, unknown> }).catalog.set(
        'datasync',
        parseManifest(
            {
                ...manifest('datasync'),
                display: 'embed',
                version,
                ...(openAnyHttps ? { bridge: { openAnyHttps } } : {}),
            },
            'catalog',
        ),
    );

type Listed = {
    catalog: Array<{ id: string; openAnyHttps: boolean }>;
    installed: Array<{
        id: string;
        version: string;
        openAnyHttps: boolean;
        update?: PluginUpdateReview;
    }>;
};

it('refuses an update that adds openAnyHttps when the catalog changed after the page listed it', async () => {
    const f = await world();
    const admin = await f.as('alice');
    offer(f, '1.0.0', false);
    expect((await admin('/plugins/datasync/install', 'POST', {})).status).toBe(200);

    // The admin's page lists an update that adds nothing sensitive...
    offer(f, '1.1.0', false);
    const before = (await admin('/plugins')).body as unknown as Listed;
    expect(before.installed[0]!.update).toMatchObject({ version: '1.1.0', addsOpenAnyHttps: false });

    // ...then the catalog changes, and Update is pressed from that page.
    offer(f, '2.0.0', true);
    const stale = await admin('/plugins/datasync/update', 'POST');
    expect(stale.status).toBe(409);
    expect(String(stale.body.error)).toMatch(/This update adds what Data sync 1\.0\.0 doesn’t have/);
    expect((stale.body.update as PluginUpdateReview).addsOpenAnyHttps).toBe(true);
    // The old sensitive-scope acknowledgment alone is not one any more (CB-531).
    expect((await admin('/plugins/datasync/update', 'POST', { acknowledged: ['bridge.openAnyHttps'] })).status).toBe(
        409,
    );
    expect(f.platform.plugins.get('datasync')).toMatchObject({ version: '1.0.0' });
    expect(f.platform.plugins.get('datasync')!.manifest.bridge?.openAnyHttps).toBeUndefined();

    // Reloaded, the page shows the review; confirming it acknowledges the scope.
    const after = (await admin('/plugins')).body as unknown as Listed;
    expect(after.installed[0]!.update).toMatchObject({ version: '2.0.0', addsOpenAnyHttps: true });
    const reviewed = await admin('/plugins/datasync/update', 'POST', {
        acknowledged: pluginUpdateAck(after.installed[0]!.update!),
    });
    expect(reviewed.status).toBe(200);
    expect(f.platform.plugins.get('datasync')).toMatchObject({ version: '2.0.0' });
    const now = (await admin('/plugins')).body as unknown as Listed;
    expect(now.installed[0]).toMatchObject({ version: '2.0.0', openAnyHttps: true });

    // Once it has the scope, a later update needs no acknowledgment again.
    offer(f, '2.1.0', true);
    expect((await admin('/plugins/datasync/update', 'POST')).status).toBe(200);
    expect(f.platform.plugins.get('datasync')).toMatchObject({ version: '2.1.0' });
});

it('refuses to install a plugin with openAnyHttps unless the request acknowledges it', async () => {
    const f = await world();
    const admin = await f.as('alice');
    // Listed without the scope, then the catalog changes before Install.
    offer(f, '1.0.0', false);
    const listed = (await admin('/plugins')).body as unknown as Listed;
    expect(listed.catalog.find((row) => row.id === 'datasync')!.openAnyHttps).toBe(false);
    offer(f, '1.1.0', true);
    const stale = await admin('/plugins/datasync/install', 'POST', {});
    expect(stale.status).toBe(409);
    expect(String(stale.body.error)).toMatch(/This plugin asks for the sensitive scope bridge\.openAnyHttps/);
    expect(f.platform.plugins.get('datasync')).toBeUndefined();
    // A junk acknowledgment is not one.
    expect((await admin('/plugins/datasync/install', 'POST', { acknowledged: 'bridge.openAnyHttps' })).status).toBe(
        409,
    );
    const ok = await admin('/plugins/datasync/install', 'POST', { acknowledged: ['bridge.openAnyHttps'] });
    expect(ok.status).toBe(200);
    expect(f.platform.plugins.get('datasync')).toMatchObject({ version: '1.1.0' });
});
