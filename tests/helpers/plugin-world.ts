import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import { pluginServiceName } from '@socio/shared/plugins/plugin-service';

import { MemoryDocker } from '../../src/apps-runtime/docker.js';
import { SwarmIdentityDelivery } from '../../src/apps-runtime/identity-delivery.js';
import { pluginProof } from '../../src/apps-runtime/keys.js';
import { PluginServices } from '../../src/apps-runtime/services.js';
import { DEFAULT_MOCK_USERS } from '../../src/server/auth/config.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import type { PluginRuntime } from '../../src/server/plugins/contract.js';

import { makeTestRuntime } from './test-runtime.js';

// The world service plugins' datasets are tested in (tests/plugin-datasets*.test.ts):
// a runtime with a file catalog of service plugins, a memory Docker for their
// services, and the helpers a plugin's service and a person call with. Each
// test file registers `cleanup` in its own afterEach.

export const SECRET = 'plugin-datasets-runtime-secret-0123456789';
export const SESSION = 'plugin-datasets-session-secret-0123456789';
export const SHARED = 'shared-plugin-service-token-0123456789abc';
export const IMAGE = (name: string) => `company-brain-plugin-${name}@sha256:${'b'.repeat(64)}`;

export const cleanup: Array<() => unknown> = [];

export const manifest = (id: string, datasets?: unknown[]) => ({
    id,
    name: id === 'datasync' ? 'Data sync' : 'Reports',
    version: '1.0.0',
    author: 'Socio tests',
    description: 'A test plugin',
    display: 'tab',
    permissions: [],
    service: { image: IMAGE(id), port: 8080, env: { SOCIO_API_URL: 'http://app:4310' } },
    ...(datasets ? { datasets } : {}),
});

/** An analytical table a manifest declares (CB-387). */
export const HISTORY_TABLE = {
    table: 'occupancy',
    kind: 'analytical',
    columns: [
        { name: 'event_day', type: 'DATE', notNull: true },
        { name: 'space_id', type: 'TEXT', notNull: true },
        { name: 'people', type: 'INTEGER' },
    ],
    partitionBy: { column: 'event_day', grain: 'day' },
    retainDays: 30,
};

/** `extra`: more manifests in the catalog, for a test's own plugin. */
export async function world(limits: Record<string, number> = {}, extra: unknown[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'socio-plugin-datasets-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const catalog = join(dir, 'catalog.json');
    writeFileSync(
        catalog,
        JSON.stringify({
            plugins: [
                manifest('datasync', [
                    { name: 'stripe', description: 'Charges, normalized' },
                    { name: 'marts', description: 'Rebuilt on a timer' },
                ]),
                manifest('reports', [{ name: 'reports' }]),
                manifest('plain'),
                // CB-369: a dataset whose tables the manifest declares.
                manifest('tabled', [
                    {
                        name: 'marts',
                        tables: [
                            {
                                table: 'daily',
                                columns: [
                                    { name: 'day', type: 'TEXT', primaryKey: true },
                                    { name: 'total', type: 'INTEGER' },
                                ],
                                history: false,
                            },
                            { table: 'facts', columns: [{ name: 'id', type: 'TEXT', primaryKey: true }] },
                        ],
                    },
                ]),
                // CB-387: analytical tables the manifest declares.
                manifest('history', [{ name: 'history', tables: [HISTORY_TABLE] }]),
                ...extra,
            ],
        }),
    );
    const engine = new MemoryDocker();
    const services = new PluginServices(engine, {
        allow: ['company-brain-plugin-'],
        maxReplicas: 5,
        secret: SECRET,
        pull: false,
        identity: new SwarmIdentityDelivery(engine),
    });
    const runtime: PluginRuntime = {
        provisionService: (id, spec, identity) => services.ensure(id, spec, identity),
        scaleService: (id, replicas) => services.scale(id, replicas),
        removeService: (id) => services.remove(id),
        serviceStatus: (id) => services.status(id),
    };
    const {
        app: http,
        workspace,
        platform,
        dispose,
    } = await makeTestRuntime({
        config: {
            sessionSecret: SESSION,
            data: { userDataDir: dir, limits },
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://brain.example'),
            appsRuntime: { url: 'http://127.0.0.1:9', token: SECRET, ingress: { host: '127.0.0.1', port: 9 } },
            plugins: { catalogs: [{ kind: 'file', path: catalog }], runtime, serviceToken: SHARED },
        },
        app: {
            config: { mode: 'live' as const, baseUrl: '' },
            auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SESSION), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    platform.context.log = () => {};
    (platform.plugins as unknown as { options: { log: (line: string) => void } }).options.log = () => {};
    platform.plugins.useActiveUsers(() => DEFAULT_MOCK_USERS);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    /** The identity the runtime delivered for a plugin, as its task reads it. */
    const delivered = (id: string) => {
        const spec = engine.specNamed(pluginServiceName(id));
        const ref = spec?.TaskTemplate.ContainerSpec.Secrets?.find((secret) => secret.File.Name === 'socio_identity');
        const created = ref && engine.created.get(ref.SecretID);
        return created ? Buffer.from(created.Data, 'base64').toString('utf8') : undefined;
    };
    const proof = (id: string) => pluginProof(SECRET, id);
    /** `POST /api/workload/data-token` as a plugin's service makes it. */
    const exchange = async (bearer: string | undefined, proofOf: string | undefined, body?: unknown) => {
        const response = await http.request('http://company-brain-app:4310/api/workload/data-token', {
            method: 'POST',
            headers: {
                ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
                ...(proofOf ? { 'x-cb-plugin-proof': proofOf } : {}),
                'content-type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
            status: response.status,
            body: (await response.json()) as {
                token: string;
                expiresAt: number;
                dataUrl: string;
                datasets: Array<{ id: string; name: string; description: string }>;
                error?: string;
            },
        };
    };
    /** The data API with a bearer data token, from the plugin's network. */
    const withToken =
        (token: string, headers: Record<string, string> = {}) =>
        async (path: string, method = 'GET', body?: unknown) => {
            const response = await http.request(`http://company-brain-app:4310/api${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...headers,
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const text = await response.text();
            let json: Record<string, unknown> = {};
            try {
                json = JSON.parse(text) as Record<string, unknown>;
            } catch {
                json = { text };
            }
            return { status: response.status, body: json as Record<string, unknown> };
        };
    const as = async (userId: string) => {
        const login = await http.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return async (path: string, method = 'GET', body?: unknown) => {
            const response = await http.request(`/api${path}`, {
                method,
                headers: { cookie, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const text = await response.text();
            return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
        };
    };
    /** Installs datasync and gives back a data token for it. */
    const datasync = async () => {
        await platform.plugins.install('datasync');
        const identity = delivered('datasync')!;
        const issued = await exchange(identity, proof('datasync'));
        expect(issued.status).toBe(200);
        return { identity, ...issued.body, api: withToken(issued.body.token) };
    };
    /**
     * A plugin's datasets (`plugin:<id>`): the workspace datasets ever bound
     * to its needs (CB-451), live or not; any other owner's by owner.
     */
    const datasetRows = (owner: string) =>
        (owner.startsWith('plugin:')
            ? workspace.db
                  .prepare(
                      'SELECT DISTINCT d.id, d.name, d.ownerUserId, d.deletedAt FROM data_datasets d JOIN data_plugin_bindings b ON b.datasetId = d.id WHERE b.pluginId=? ORDER BY d.name',
                  )
                  .all(owner.slice('plugin:'.length))
            : workspace.db
                  .prepare(
                      'SELECT id, name, ownerUserId, deletedAt FROM data_datasets WHERE ownerUserId=? ORDER BY name',
                  )
                  .all(owner)
        ).map((row) => ({ ...row })) as Array<{
            id: string;
            name: string;
            ownerUserId: string;
            deletedAt: number | null;
        }>;
    return { http, workspace, platform, delivered, proof, exchange, withToken, as, datasync, datasetRows };
}
