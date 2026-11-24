import { afterEach, expect, it } from 'vitest';

import {
    pluginUpdateAck,
    pluginUpdateAdditionLabel,
    pluginUpdateDiff,
    type PluginUpdateReview,
} from '@socio/shared/plugins/plugin-update';
import type { PluginManifest } from '@socio/shared/plugins/plugins';

import { parseManifest } from '../src/server/plugins/catalog.js';

import { cleanup, IMAGE, manifest, world } from './helpers/plugin-world.js';

// CB-531: an update from the catalog adopts what the new manifest adds (a
// host it reaches, a scope, a secret, a dataset or write access, a public
// path, more resources) only with an acknowledgment of exactly that diff,
// bound to the installed and the target revisions.

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

type World = Awaited<ReturnType<typeof world>>;

const base = { ...manifest('plain'), config: { REGION: { description: 'Region' }, OLD: { description: 'Old' } } };

/** Puts a manifest for `plain` in the catalog, as a catalog refresh would. */
const offer = (f: World, patch: Record<string, unknown>) =>
    (f.platform.plugins as unknown as { catalog: Map<string, unknown> }).catalog.set(
        'plain',
        parseManifest({ ...base, ...patch }, 'catalog'),
    );

const ADDS = {
    version: '2.0.0',
    config: { REGION: base.config.REGION },
    permissions: ['person:read'],
    secrets: [{ name: 'RESEND_API_KEY', required: false }],
    webhooks: [{ path: '/hooks/in' }],
    datasets: [{ name: 'events' }],
    service: { ...base.service, egress: ['api.example.com'], resources: { memoryMb: 512 } },
};

async function installed() {
    const f = await world();
    return { f, admin: await installed_(f) };
}

/** `plain` installed in `f`, with settings, disabled. */
async function installed_(f: World) {
    offer(f, {});
    const admin = await f.as('alice');
    expect((await admin('/plugins/plain/install', 'POST', {})).status).toBe(200);
    expect((await admin('/plugins/plain/config', 'PUT', { config: { REGION: 'us', OLD: 'x' } })).status).toBe(200);
    // Disabled: the update adopts the manifest with no service to provision.
    expect((await admin('/plugins/plain/disable', 'POST')).status).toBe(200);
    return admin;
}

const listed = async (admin: Awaited<ReturnType<World['as']>>) =>
    (
        (await admin('/plugins')).body as { installed: Array<{ id: string; update?: PluginUpdateReview }> }
    ).installed.find((row) => row.id === 'plain')!.update;

it('lists every addition in plain words, and the stored settings the update deletes', () => {
    const next = { ...base, ...ADDS, config: { REGION: base.config.REGION } } as unknown as PluginManifest;
    const diff = pluginUpdateDiff(base as unknown as PluginManifest, next, { REGION: 'us', OLD: 'x' });
    expect(diff.additions.map((addition) => addition.key)).toEqual([
        'egress:api.example.com',
        'permission:person:read',
        'secret:RESEND_API_KEY',
        'dataset:events',
        'webhook:POST /hooks/in',
        'memory:512',
    ]);
    expect(diff.additions.map(pluginUpdateAdditionLabel)).toContain('Can now reach api.example.com');
    expect(diff.additions.map(pluginUpdateAdditionLabel)).toContain('Asks for a new optional secret RESEND_API_KEY');
    expect(diff.removedSettings).toEqual(['OLD']);
    // A read need that now writes, more CPUs, a raised webhook limit, a new volume.
    const reader = { ...base, datasets: [{ name: 'events', access: 'read' }], webhooks: [{ path: '/h' }] };
    const writer = {
        ...reader,
        datasets: [{ name: 'events', access: 'write' }],
        webhooks: [{ path: '/h', perMinute: 600 }],
        service: {
            ...base.service,
            resources: { cpus: 2 },
            volumes: [{ name: 'data', mount: '/data', ephemeral: true }],
        },
    };
    expect(
        pluginUpdateDiff(reader as unknown as PluginManifest, writer as unknown as PluginManifest, {}).additions.map(
            (addition) => addition.key,
        ),
    ).toEqual(['dataset-write:events', 'webhook-limit:POST /h', 'cpus:2', 'volume:data']);
    // Turning into an embed, and a socio action added or raised a tier.
    const tab = { ...base, delegation: { contract: 1, actions: { list: 'read' } } };
    const embed = {
        ...tab,
        display: 'embed',
        delegation: { contract: 1, actions: { list: 'write', send: 'consequential' } },
    };
    expect(
        pluginUpdateDiff(tab as unknown as PluginManifest, embed as unknown as PluginManifest, {}).additions.map(
            (addition) => addition.key,
        ),
    ).toEqual(['display:embed', 'action:list:write', 'action:send:consequential']);
    // A lower tier asks less, and dropping alwaysAsk skips the person's card: both are reviewed.
    const strict = { ...base, delegation: { contract: 1, alwaysAsk: true, actions: { purge: 'admin' } } };
    const relaxed = { ...base, delegation: { contract: 1, actions: { purge: 'write' } } };
    expect(
        pluginUpdateDiff(strict as unknown as PluginManifest, relaxed as unknown as PluginManifest, {}).additions.map(
            (addition) => addition.key,
        ),
    ).toEqual(['action:purge:write', 'delegation.alwaysAsk']);
    // A Socio Secret and a mounted runtime secret are separate, even under one name.
    const socio = { ...base, secrets: [{ name: 'API_KEY', required: false }] };
    const mounted = { ...socio, service: { ...base.service, secrets: [{ name: 'API_KEY', target: 'api_key' }] } };
    expect(
        pluginUpdateDiff(socio as unknown as PluginManifest, mounted as unknown as PluginManifest, {}).additions.map(
            (addition) => addition.key,
        ),
    ).toEqual(['service-secret:API_KEY']);
    expect(
        pluginUpdateDiff(
            mounted as unknown as PluginManifest,
            { ...mounted, secrets: [], service: base.service } as unknown as PluginManifest,
            {},
        ).additions,
    ).toEqual([]);
    const swap = { ...base, service: { ...base.service, secrets: [{ name: 'API_KEY', target: 'api_key' }] } };
    expect(
        pluginUpdateDiff(swap as unknown as PluginManifest, socio as unknown as PluginManifest, {}).additions.map(
            (addition) => addition.key,
        ),
    ).toEqual(['secret:API_KEY']);
    // Removals and an image or version change add nothing.
    const smaller = {
        ...writer,
        version: '3.0.0',
        webhooks: [],
        datasets: [],
        service: { ...base.service, image: IMAGE('other') },
    };
    expect(
        pluginUpdateDiff(writer as unknown as PluginManifest, smaller as unknown as PluginManifest, {}).additions,
    ).toEqual([]);
    // `host` and `host:443` are one host.
    const at443 = { ...base, service: { ...base.service, egress: ['api.example.com:443'] } };
    const plain443 = { ...base, service: { ...base.service, egress: ['API.example.com'] } };
    expect(
        pluginUpdateDiff(at443 as unknown as PluginManifest, plain443 as unknown as PluginManifest, {}).additions,
    ).toEqual([]);
});

it('refuses an update that adds anything without an acknowledgment, answering the diff', async () => {
    const { f, admin } = await installed();
    offer(f, ADDS);
    const refused = await admin('/plugins/plain/update', 'POST', {});
    expect(refused.status).toBe(409);
    const review = refused.body.update as PluginUpdateReview;
    expect(review.additions.map((addition) => addition.key)).toContain('egress:api.example.com');
    expect(review.removedSettings).toEqual(['OLD']);
    expect(review.version).toBe('2.0.0');
    // The old sensitive-scope acknowledgment is not one.
    expect((await admin('/plugins/plain/update', 'POST', { acknowledged: ['bridge.openAnyHttps'] })).status).toBe(409);
    expect(f.platform.plugins.get('plain')).toMatchObject({ version: '1.0.0' });
    expect(f.platform.plugins.get('plain')!.manifest.service?.egress).toBeUndefined();
    expect(f.workspace.auditOf('plugin', 'plain').filter((line) => line.action === 'update')).toEqual([]);
});

it('refuses a stale acknowledgment: another target, a partial diff, or a catalog changed since', async () => {
    const { f, admin } = await installed();
    offer(f, ADDS);
    const review = (await listed(admin))!;
    const ack = pluginUpdateAck(review);
    // Missing one addition, or naming one more.
    const partial = { ...ack, additions: ack.additions.slice(1) };
    expect((await admin('/plugins/plain/update', 'POST', { acknowledged: partial })).status).toBe(409);
    const extra = { ...ack, additions: [...ack.additions, 'egress:other.example.com'] };
    expect((await admin('/plugins/plain/update', 'POST', { acknowledged: extra })).status).toBe(409);
    // Bound to the target revision: the catalog adds another host after the page listed it.
    offer(f, { ...ADDS, service: { ...ADDS.service, egress: ['api.example.com', 'evil.example.com'] } });
    const stale = await admin('/plugins/plain/update', 'POST', { acknowledged: ack });
    expect(stale.status).toBe(409);
    expect((stale.body.update as PluginUpdateReview).additions.map((addition) => addition.key)).toContain(
        'egress:evil.example.com',
    );
    // Even when the diff's keys are the same, a different target is another update.
    offer(f, { ...ADDS, version: '2.0.1' });
    expect((await admin('/plugins/plain/update', 'POST', { acknowledged: ack })).status).toBe(409);
    expect(f.platform.plugins.get('plain')).toMatchObject({ version: '1.0.0' });
});

it('updates with the acknowledgment of exactly its diff, and audits what was acknowledged', async () => {
    const { f, admin } = await installed();
    offer(f, ADDS);
    const review = (await listed(admin))!;
    const done = await admin('/plugins/plain/update', 'POST', { acknowledged: pluginUpdateAck(review) });
    expect(done.status).toBe(200);
    expect(f.platform.plugins.get('plain')).toMatchObject({ version: '2.0.0' });
    expect(f.platform.plugins.get('plain')!.manifest.service?.egress).toEqual(['api.example.com']);
    const [line] = f.workspace.auditOf('plugin', 'plain').filter((entry) => entry.action === 'update');
    expect(line!.detail).toContain('acknowledged egress:api.example.com (Can now reach api.example.com)');
    expect(line!.detail).toContain('secret:RESEND_API_KEY (Asks for a new optional secret RESEND_API_KEY)');
    expect(line!.detail).toContain(`revision ${review.to}`);
});

it('needs no acknowledgment for an update that adds nothing', async () => {
    const { f, admin } = await installed();
    offer(f, { version: '1.1.0', service: { ...base.service, image: IMAGE('next') } });
    const review = (await listed(admin))!;
    expect(review.additions).toEqual([]);
    expect((await admin('/plugins/plain/update', 'POST', {})).status).toBe(200);
    expect(f.platform.plugins.get('plain')).toMatchObject({ version: '1.1.0' });
    const [line] = f.workspace.auditOf('plugin', 'plain').filter((entry) => entry.action === 'update');
    expect(line!.detail).toContain('acknowledged nothing (it adds nothing)');
});

it('refuses an acknowledged update when the installed manifest changed before it committed', async () => {
    const { f, admin } = await installed();
    offer(f, ADDS);
    const review = (await listed(admin))!;
    // Another runtime adopts a different manifest after this one checked the acknowledgment.
    const plugins = f.platform.plugins as unknown as {
        db: import('node:sqlite').DatabaseSync;
        checkConfig: (...args: unknown[]) => void;
    };
    const check = plugins.checkConfig.bind(plugins);
    const other = { ...base, version: '1.5.0', service: { ...base.service, egress: ['other.example.com'] } };
    plugins.checkConfig = (...args) => {
        plugins.db
            .prepare('UPDATE plugin_installs SET version=?, manifest=? WHERE id=?')
            .run('1.5.0', JSON.stringify(other), 'plain');
        check(...args);
    };
    const refused = await admin('/plugins/plain/update', 'POST', { acknowledged: pluginUpdateAck(review) });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(/changed while it was updating/);
    expect(f.platform.plugins.current('plain')).toMatchObject({ version: '1.5.0' });
    expect(f.platform.plugins.current('plain')!.manifest.service?.egress).toEqual(['other.example.com']);
});

it('refuses an update when a settings save meanwhile makes it reach a host the review did not list', async () => {
    const f = await world();
    const field = (fallback: string) => ({ URL: { description: 'Where it posts', type: 'url', default: fallback } });
    const egress = { ...base.service, egress: [{ fromConfig: 'URL' }] };
    const plugins = f.platform.plugins as unknown as {
        db: import('node:sqlite').DatabaseSync;
        checkConfig: (...args: unknown[]) => void;
    };
    // Installed (disabled, as this runtime has no egress proxy) with the old default, overridden.
    const admin = await installed_(f);
    const old = parseManifest({ ...base, config: field('https://old.example.com'), service: egress }, 'catalog');
    plugins.db
        .prepare('UPDATE plugin_installs SET manifest=?, config=? WHERE id=?')
        .run(JSON.stringify(old), JSON.stringify({ URL: 'https://old.example.com' }), 'plain');
    // The new default isn't reached while the stored value overrides it: nothing to acknowledge.
    offer(f, { version: '1.1.0', config: field('https://new.example.com'), service: egress });
    expect((await listed(admin))!.additions).toEqual([]);
    // The override is cleared after the update checked the (empty) diff, before it commits.
    const check = plugins.checkConfig.bind(plugins);
    plugins.checkConfig = (...args) => {
        plugins.db.prepare('UPDATE plugin_installs SET config=? WHERE id=?').run('{}', 'plain');
        check(...args);
    };
    const refused = await admin('/plugins/plain/update', 'POST', {});
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toMatch(/changed while it was updating/);
    expect(f.platform.plugins.current('plain')).toMatchObject({ version: '1.0.0' });
    // Reviewed again, the new host is listed.
    plugins.checkConfig = check;
    expect((await listed(admin))!.additions.map((addition) => addition.key)).toEqual(['egress:new.example.com']);
});
