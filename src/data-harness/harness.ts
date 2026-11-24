/**
 * The data API test harness (CB-476): Socio's own app, booted in this
 * process over a temporary database and data space, with one service plugin
 * installed from the manifest a test gives, serving that plugin's
 * `/api/data` routes. Nothing here reimplements the data API: requests run
 * through the app `createApp` builds over the graph `startAppRuntime`
 * builds (the data token middleware, the write guard, the query runner and
 * its authorizer, the limits and caps, batches with `expectChanges` and
 * `RETURNING`, read batches and the per-plugin budget), exactly as the
 * server runs them. Only what a plugin's tests can't reach is left out:
 * there is no apps runtime (the plugin's service is never started), no
 * sign-in, and no background work.
 *
 * docs/DATA-TEST-HARNESS.md is the guide; `main.ts` serves it over HTTP
 * for a plugin in another repository.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createAdaptorServer } from '@hono/node-server';
import { Context } from 'effect';

import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { IdentityGrant } from '@socio/shared/identity-delivery';
import type { PluginBindingChoices } from '@socio/shared/plugins/bindings';
import { OPEN_ANY_HTTPS_SCOPE } from '@socio/shared/plugins/plugins';

import { pluginProof } from '../apps-runtime/keys.js';
import { createApp } from '../server/app.js';
import type { AuthSetup } from '../server/auth/contract.js';
import { LeaderWork } from '../server/composition/app/work.js';
import { LegacyWorkspace } from '../server/composition/base.js';
import type { PlatformConfig } from '../server/composition/config.js';
import { openCoreStore, taskRunnerStoreOf } from '../server/composition/core-store.js';
import { LegacyData } from '../server/composition/dataspace.js';
import { LegacyPlugins } from '../server/composition/plugins.js';
import { workspaceStoreParts } from '../server/composition/workspace-parts.js';
import type { DataLimits } from '../server/dataspace/contract.js';
import { startAppRuntime } from '../server/main.js';
import { bootDatabase } from '../server/modules/boot.js';
import type { PluginRuntime } from '../server/plugins/contract.js';
import { InlineReplayer } from '../server/replay/pool.js';
import { LocalAgentRunner } from '../server/turns/local-runner.js';
import { Runner } from '../server/turns/runner.js';
import { WorkspaceStore } from '../server/workspace/workspace.js';

/** The admin the harness acts as for what only an admin may do (a plugin's budget). */
export const HARNESS_ADMIN = 'harness-admin';

/** The routes a plugin's service reaches: the data API and its token exchange. */
const SERVED = /^\/api\/data(?:\/|$)|^\/api\/workload\/data-token$/;

/** Where the harness's in-process `fetch` pretends Socio is. */
export const HARNESS_ORIGIN = 'http://socio-data-harness.invalid';

export interface DataHarnessOptions {
    /**
     * The plugin's manifest, as its catalog lists it: at least `id`, and
     * the `datasets` its tests use. `name`, `version`, `author`,
     * `description`, `display` and `permissions` get placeholders when left
     * out, and so does `service` (it is never started).
     */
    manifest: Record<string, unknown> & { id: string };
    /**
     * The data space's limits, as `DATA_*` sets them in production
     * (`dataSettingsFromEnv`); Socio's defaults otherwise.
     */
    limits?: Partial<DataLimits>;
    /** The data tokens' lifetime, `DATA_TOKEN_TTL_MINUTES` in production; a plugin's is at most 15 minutes. */
    tokenTtlMs?: number;
    /** `child` (the default) forks the analytics process for analytical tables when first used; `off` refuses them. */
    analyticsMode?: 'child' | 'off';
    /** Operational log lines; dropped by default. */
    log?: (line: string) => void;
}

/** A plugin's data token, as `POST /api/workload/data-token` answers it. */
export interface HarnessToken {
    token: string;
    expiresAt: number;
    dataUrl: string;
    datasets: Array<{ id: string; name: string; description?: string; access?: string }>;
    unbound: string[];
}

let template: Uint8Array | undefined;
/**
 * A database as the boot step leaves it: `bootDatabase` (the server's own
 * step) runs once per process over a scratch file (most of a second), and
 * each harness gets an in-memory copy of the result.
 */
function migrated() {
    if (!template) {
        const scratch = mkdtempSync(join(tmpdir(), 'socio-data-harness-boot-'));
        try {
            const path = join(scratch, 'socio.sqlite');
            bootDatabase(path, { backupDirectory: join(scratch, 'backups'), log: () => {} });
            const booted = new DatabaseSync(path);
            try {
                // Out of WAL, which an in-memory copy can't open.
                booted.exec('PRAGMA journal_mode=DELETE');
                template = booted.serialize();
            } finally {
                booted.close();
            }
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }
    const db = new DatabaseSync(':memory:');
    db.deserialize(template);
    applyConnectionPragmas(db, {});
    return db;
}

/** A provider that signs nobody in: the harness serves token routes only. */
const noSignIn: AuthSetup = {
    provider: {
        kind: 'test',
        resolve: async () => null,
        users: () => [],
        routes: () => undefined,
        signInMethods: () => ({ passkey: false, password: false, oauth: [] }) as never,
        mayRunCode: async () => false,
    },
    secureCookies: false,
};

const PLACEHOLDER_IMAGE = `socio-data-harness-plugin@sha256:${'0'.repeat(64)}`;

type DeclaredNeed = { name: string; access?: string; tables?: unknown[]; description?: string };

/** The manifest's read needs, which the harness gives writers. */
function readNeeds(manifest: DataHarnessOptions['manifest']): DeclaredNeed[] {
    const datasets = Array.isArray(manifest.datasets) ? (manifest.datasets as DeclaredNeed[]) : [];
    return datasets.filter((need) => need && need.access === 'read');
}

/** A writer's need for a read need: the same tables (a column's type is TEXT when absent, as a reader's). */
const sourceNeed = (need: DeclaredNeed) => ({
    name: need.name,
    access: 'write',
    ...(need.tables ? { tables: need.tables } : {}),
});

/** The manifest with what the harness never uses filled in. */
function catalogEntry(manifest: DataHarnessOptions['manifest']) {
    return {
        name: manifest.id,
        version: '0.0.0',
        author: 'Data harness',
        description: 'A plugin under test',
        display: 'tab',
        permissions: [],
        service: { image: PLACEHOLDER_IMAGE, port: 8080 },
        ...manifest,
    };
}

/** One boot: the app, its graph and the plugin installed in it. */
async function boot(options: DataHarnessOptions) {
    const log = options.log ?? (() => {});
    const dir = mkdtempSync(join(tmpdir(), 'socio-data-harness-'));
    const opened: Array<() => unknown> = [() => rmSync(dir, { recursive: true, force: true })];
    const close = async () => {
        let failure: { error: unknown } | undefined;
        for (const step of opened.splice(0).reverse()) {
            try {
                await step();
            } catch (error) {
                failure ??= { error };
            }
        }
        if (failure) {
            throw failure.error;
        }
    };
    try {
        const catalog = join(dir, 'catalog.json');
        const sources = readNeeds(options.manifest).map((need, index) => ({
            need: need.name,
            id: `harness-source-${index + 1}`,
        }));
        writeFileSync(
            catalog,
            JSON.stringify({
                plugins: [
                    catalogEntry(options.manifest),
                    ...sources.map((source, index) =>
                        catalogEntry({
                            id: source.id,
                            name: `Source of ${source.need}`,
                            datasets: [sourceNeed(readNeeds(options.manifest)[index]!)],
                        }),
                    ),
                ],
            }),
        );
        // The apps runtime's side: the identity Socio delivers with the
        // service, which the plugin's task would read from its file.
        const identities = new Map<string, IdentityGrant>();
        const status = (id: string, replicas = 1) => ({
            id,
            service: `socio-plugin-${id}`,
            image: PLACEHOLDER_IMAGE,
            replicas,
            running: replicas,
            state: 'running' as const,
            ...(identities.get(id) ? { identity: identities.get(id)!.version } : {}),
        });
        const runtime: PluginRuntime = {
            provisionService: async (id, spec, identity) => {
                if (identity) {
                    identities.set(id, identity);
                }
                return status(id, spec.replicas);
            },
            scaleService: async (id, replicas) => status(id, replicas),
            removeService: async (id) => void identities.delete(id),
            serviceStatus: async (id) => status(id),
        };
        const secret = randomBytes(32).toString('base64url');
        const sessionSecret = randomBytes(32).toString('base64url');
        const db = migrated();
        opened.push(() => db.isOpen && db.close());
        const store = openCoreStore(db);
        const workspace = new WorkspaceStore(db, workspaceStoreParts);
        opened.push(() => workspace.close());
        opened.push(() => store.close());
        workspace.recordUser({ id: HARNESS_ADMIN, name: 'Harness admin', role: 'admin' });
        const config: PlatformConfig = {
            baseUrl: '',
            voiceName: 'marin',
            runtimeUrl: '',
            sessionSecret,
            data: {
                userDataDir: join(dir, 'userdata'),
                limits: options.limits ?? {},
                analyticsMode: options.analyticsMode ?? 'child',
                ...(options.tokenTtlMs ? { tokenTtlMs: options.tokenTtlMs } : {}),
            },
            apps: appsSettingsFromEnv({ APPS_HOST: 'apps.socio-data-harness.invalid' }, HARNESS_ORIGIN),
            appsRuntime: { url: 'http://127.0.0.1:9', token: secret, ingress: { host: '127.0.0.1', port: 9 } },
            plugins: { catalogs: [{ kind: 'file', path: catalog }], runtime },
        };
        const agentDb = migrated();
        opened.push(() => agentDb.isOpen && agentDb.close());
        const agents = new LocalAgentRunner(agentDb, { replayer: new InlineReplayer() });
        opened.push(() => agents.close());
        const started = await startAppRuntime({ db, store, workspace, config, runner: agents, auth: noSignIn, log });
        opened.push(() => started.runtime.dispose());
        opened.push(() => Context.get(started.services, LeaderWork).stop());
        const plugins = Context.get(started.services, LegacyPlugins);
        const data = Context.get(started.services, LegacyData);
        const people = Context.get(started.services, LegacyWorkspace);
        plugins.useActiveUsers(() => people.users());
        const research = new Runner(taskRunnerStoreOf(store), async () => {
            throw new Error('The data harness runs no tasks.');
        });
        const app = createApp({
            store,
            runner: research,
            config: { mode: 'live', baseUrl: '' },
            edge: started.edge,
            auth: noSignIn,
            runtime: started.runtime,
        });
        /** A plugin installed as an admin installs it, and its identity as its task gets it. */
        const install = async (id: string, bindings?: PluginBindingChoices) => {
            // The harness is the developer's own: a sensitive scope the
            // manifest asks for is acknowledged, as an admin would on install.
            await plugins.install(id, {}, { by: HARNESS_ADMIN, bindings, acknowledged: [OPEN_ANY_HTTPS_SCOPE] });
            const identity = identities.get(id);
            if (!identity) {
                throw new Error(`The data harness: installing ${id} delivered no identity.`);
            }
            return { identity: identity.token, proof: pluginProof(secret, id) };
        };
        /** `POST /api/workload/data-token`, as a plugin's service makes it. */
        const exchange = async (who: { identity: string; proof: string }, body: unknown = {}) => {
            const response = await app.request(`${HARNESS_ORIGIN}/api/workload/data-token`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${who.identity}`,
                    'x-cb-plugin-proof': who.proof,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
            });
            const answer = (await response.json()) as HarnessToken & { error?: string };
            if (response.status !== 200) {
                throw new Error(
                    `The data harness: the data token exchange answered ${response.status}: ${answer.error}`,
                );
            }
            return answer;
        };
        // Each read need reads what another plugin writes, as in a
        // workspace: a source plugin writes a dataset with the need's
        // tables, and the need is bound to it.
        const sourceTokens: Record<string, { who: { identity: string; proof: string }; token: HarnessToken }> = {};
        const bindings: PluginBindingChoices = {};
        for (const source of sources) {
            const who = await install(source.id);
            const token = await exchange(who);
            sourceTokens[source.need] = { who, token };
            bindings[source.need] = { datasetId: token.datasets[0]!.id };
        }
        const id = options.manifest.id;
        const who = await install(id, bindings);
        const token = await exchange(who);
        return {
            id,
            app,
            data,
            ...who,
            token,
            sources: sourceTokens,
            exchange,
            close,
        };
    } catch (error) {
        await close().catch(() => {});
        throw error;
    }
}

export type DataHarness = Awaited<ReturnType<typeof startDataHarness>>;

/**
 * Boots the harness: Socio over a temporary data space with the plugin
 * installed and a data token issued for it. `fetch` (or `handle`) serves
 * the plugin's routes in process; `listen` serves them on loopback.
 * `reset` boots a fresh data space (a new token: read `token` again);
 * `close` stops it and deletes its files.
 */
export async function startDataHarness(options: DataHarnessOptions) {
    let world = await boot(options);
    const servers = new Set<Server>();

    /** Serves the plugin-facing routes through Socio's app; anything else is 404. */
    const handle = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (!SERVED.test(url.pathname)) {
            return Response.json(
                { error: 'The data harness serves /api/data and /api/workload/data-token only.' },
                {
                    status: 404,
                },
            );
        }
        return world.app.fetch(request);
    };

    return {
        /** The plugin's id. */
        get pluginId() {
            return world.id;
        },
        /** The current data token (`cbdt_`), its expiry and the datasets it reaches. */
        get token() {
            return world.token.token;
        },
        get expiresAt() {
            return world.token.expiresAt;
        },
        get datasets() {
            return world.token.datasets;
        },
        /**
         * The writers of the plugin's read needs, by need name: each a
         * source plugin's write token for the dataset the need is bound
         * to, to put the rows the plugin reads there.
         */
        get sources(): Record<string, HarnessToken> {
            return Object.fromEntries(Object.entries(world.sources).map(([need, item]) => [need, item.token]));
        },
        /**
         * The plugin's identity token and the proof of its id, as its task
         * gets them (`SOCIO_IDENTITY_FILE`, `CB_PLUGIN_PROOF`), for code that
         * exchanges them for a data token itself.
         */
        get identity() {
            return world.identity;
        },
        get proof() {
            return world.proof;
        },
        /** In-process Socio's `/api` base, for `socioApp({ apiUrl })` or a driver's base URL. */
        apiUrl: `${HARNESS_ORIGIN}/api`,
        handle,
        /** An in-process `fetch` (a driver's, or `fakeSocio({ data })`'s). */
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
            handle(new Request(input, init))) as typeof fetch,
        /** A new data token, as a plugin renews one; `datasets` narrows it by need name. */
        async renew(datasets?: string[]) {
            world.token = await world.exchange(world, datasets ? { datasets } : {});
            for (const item of Object.values(world.sources)) {
                item.token = await world.exchange(item.who);
            }
            return world.token;
        },
        /**
         * Sets the plugin's statement budget (operations a minute) as an
         * admin does on its page (CB-473), or `null` back to the default.
         */
        setBudget(statementsPerMinute: number | null) {
            return world.data.setPluginBudget(HARNESS_ADMIN, world.id, statementsPerMinute);
        },
        /** A fresh data space: the old one is closed and deleted, and a new token issued. */
        async reset() {
            const old = world;
            world = await boot(options);
            await old.close();
        },
        /** Serves the routes on `host:port` (loopback, any free port by default). */
        async listen({ host = '127.0.0.1', port = 0 }: { host?: string; port?: number } = {}) {
            const server = createAdaptorServer({ fetch: handle, hostname: host }) as Server;
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => resolve());
            });
            servers.add(server);
            const address = server.address() as AddressInfo;
            const origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
            return {
                origin,
                apiUrl: `${origin}/api`,
                server,
                close: () =>
                    new Promise<void>((resolve) => {
                        servers.delete(server);
                        server.close(() => resolve());
                        server.closeAllConnections();
                    }),
            };
        },
        async close() {
            for (const server of servers) {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
            servers.clear();
            await world.close();
        },
    };
}
