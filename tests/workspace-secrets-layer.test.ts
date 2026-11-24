// Socio Secrets' layer and the composition's step build one
// `WorkspaceSecrets`, offered under every tag, over the workspace's audit and
// people and the workloads `SecretsHost` names; the step hands the apps its
// redaction and setup checks.
import { randomBytes } from 'node:crypto';

import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import type { AppsService } from '../src/server/apps/service.js';
import { AdminNotices } from '../src/server/composition/app/notices.js';
import { LegacyApps } from '../src/server/composition/apps.js';
import { LegacyWorkspace } from '../src/server/composition/base.js';
import { PlatformKeys } from '../src/server/composition/keys.js';
import { platformPorts, Ports } from '../src/server/composition/ports.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import { LegacyWorkspaceSecrets, workspaceSecretsLayers } from '../src/server/composition/workspace-secrets.js';
import type { PluginService } from '../src/server/plugins/service.js';
import { Secrets, SecretsAdmin, type SecretApp } from '../src/server/workspace-secrets/contract.js';
import { SecretsHost, WorkspaceSecretsLive, type SecretsHostShape } from '../src/server/workspace-secrets/layer.js';
import { WorkspaceSecrets } from '../src/server/workspace-secrets/service.js';
import { Audit, People, type AuditShape, type PeopleShape } from '../src/server/workspace/contract.js';
import type { WorkspaceAuditEntry } from '../src/server/workspace/contract.js';

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

const keys: DataKeyring = { current: randomBytes(32), legacy: 'workspace-secrets-layer-secret-0123456789' };
const VALUE = 'sk_live_LayerValue0123456789abcdef';

/** The workspace's audit (recorded) and people. */
function workspaceSlices() {
    const lines: WorkspaceAuditEntry[] = [];
    const audit = { audit: (entry: WorkspaceAuditEntry) => void lines.push(entry) } as unknown as AuditShape;
    const people = { users: () => [{ id: 'carol', name: 'Carol', role: 'admin' }] } as unknown as PeopleShape;
    return { lines, audit, people };
}

const bookings: SecretApp = { id: 'bookings', name: 'Bookings', status: 'promoted' };
const declared = () => [{ name: 'STRIPE_API_KEY', required: true }];

it('offers one service as Secrets and SecretsAdmin, over SecretsHost, Audit and People', async () => {
    const { lines, audit, people } = workspaceSlices();
    const host: SecretsHostShape = {
        apps: { list: () => [bookings], get: (id) => (id === 'bookings' ? bookings : undefined), declared },
        plugins: { list: () => [], get: () => undefined, declared: () => [] },
        notifyAdmins: async () => {},
    };
    const layer = WorkspaceSecretsLive(database(), keys).pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(SecretsHost, host),
                Layer.succeed(Audit, audit),
                Layer.succeed(People, people),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const secrets = Context.get(context, SecretsAdmin);
    expect(secrets).toBeInstanceOf(WorkspaceSecrets);
    expect(Context.get(context, Secrets)).toBe(secrets);

    const created = await secrets.create('carol', { name: 'STRIPE_API_KEY', value: VALUE });
    expect(secrets.needsSetup('bookings')).toEqual(['STRIPE_API_KEY']);
    await secrets.grant('carol', created.id, 'bookings');
    expect(secrets.needsSetup('bookings')).toEqual([]);
    const read = secrets.read('bookings', 'STRIPE_API_KEY');
    expect(read).toMatchObject({ ok: true, secret: { value: VALUE } });
    // The audit gets every change and read, never a value; names come from People.
    expect(lines.map((line) => line.action)).toEqual(['create', 'grant', 'read']);
    expect(JSON.stringify(lines)).not.toContain(VALUE);
    expect(secrets.state().secrets[0]).toMatchObject({ name: 'STRIPE_API_KEY', createdByName: 'Carol' });
});

it("builds the graph's step from the apps, the plugins' port and the admins' notices, under the legacy tag too", async () => {
    const db = database();
    const { audit, people } = workspaceSlices();
    const app = { id: 'bookings', name: 'Bookings', status: 'promoted', liveVersion: 2 };
    const bound: Array<{ values(appId: string): string[]; needsSetup(appId: string): string[] }> = [];
    const apps = {
        all: () => [app, { id: 'draft', name: 'Draft', status: 'development', liveVersion: null }],
        get: (id: string) => (id === 'bookings' ? app : undefined),
        promotions: {
            manifestOf: (appId: string, version: number) =>
                appId === 'bookings' && version === 2 ? { secrets: declared() } : undefined,
        },
        useWorkloadSecrets: (checks: (typeof bound)[number]) => void bound.push(checks),
    } as unknown as AppsService;
    const ports = platformPorts();
    const notices: unknown[] = [];
    const adminNotices = {
        notifyAdmins: async (notice: unknown) => void notices.push(notice),
        notifyOperators: async () => {},
    };
    const layer = workspaceSecretsLayers.workspaceSecrets.pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(LegacyWorkspace, { db } as WorkspaceStore),
                Layer.succeed(PlatformKeys, { secret: 'unused', keys }),
                Layer.succeed(LegacyApps, apps),
                Layer.succeed(AdminNotices, adminNotices),
                Layer.succeed(Ports, ports),
                Layer.succeed(Audit, audit),
                Layer.succeed(People, people),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const secrets = Context.get(context, LegacyWorkspaceSecrets);
    expect(Context.get(context, Secrets)).toBe(secrets);
    expect(Context.get(context, SecretsAdmin)).toBe(secrets);

    // The plugins are reached through their late-bound port, at the moment of use.
    ports.plugins.fill({
        list: () => [{ id: 'sync', mode: 'service', enabled: true, manifest: { name: 'Sync', secrets: declared() } }],
        get: (id: string) =>
            id === 'sync'
                ? { id: 'sync', mode: 'service', enabled: true, manifest: { name: 'Sync', secrets: declared() } }
                : undefined,
        identityIssue: () => undefined,
    } as unknown as PluginService);
    // Only apps in the workspace app runtime, and service plugins, are workloads.
    expect(secrets.state().apps.map((entry) => entry.appId)).toEqual(['bookings', 'plugin:sync']);

    // The apps got its redaction and setup checks, on the same service.
    expect(bound).toHaveLength(1);
    expect(bound[0]!.needsSetup('bookings')).toEqual(['STRIPE_API_KEY']);
    const created = await secrets.create('carol', { name: 'STRIPE_API_KEY', value: VALUE });
    await secrets.grant('carol', created.id, 'bookings');
    expect(secrets.read('bookings', 'STRIPE_API_KEY').ok).toBe(true);
    expect(bound[0]!.values('bookings')).toContain(VALUE);
    expect(bound[0]!.needsSetup('bookings')).toEqual([]);
});
