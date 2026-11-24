// The app's runtime for tests: the graph the server builds at boot
// (`startAppRuntime`, main.ts) over a test database, so routes run through
// `handle()` and module hooks read the services the runtime built, as they do
// in the server. `platform` is the tests' view of those services
// (`TestPlatform`).
import { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import type { Hono } from 'hono';

import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';
import type { AppEnv } from '@socio/foundation/http/app-env';

import { createApp, type AppOptions } from '../../src/server/app.js';
import type { AuthSetup } from '../../src/server/auth/contract.js';
import type { PlatformConfig } from '../../src/server/composition/config.js';
import { makeAppLayer, type AppBoot, type AppEdge, type AppRuntime, type AppServices } from '../../src/server/main.js';
import { moduleServices } from '../../src/server/modules/lifecycle.js';

import { LocalAgentRunner, Runner } from './runners.js';
import { Store, WorkspaceStore } from './stores.js';
import { testAuth } from './test-auth.js';
import { testDatabase, testDatabaseFile } from './test-database.js';
import { TestPlatform } from './test-platform.js';

export { TestPlatform };

/**
 * The app a test asks for: `createApp`'s options, less what the runtime
 * supplies. `auth` defaults to the runtime's (the server shares one
 * provider); `runner` (the research runner) may be made over the store.
 */
export type TestAppOptions = Omit<AppOptions, 'store' | 'edge' | 'runtime' | 'runner' | 'config' | 'auth'> &
    Partial<Pick<AppOptions, 'config' | 'auth'>> & {
        runner?: Runner | ((store: Store) => Runner);
    };

/**
 * A database: a file path (written from the migrated template when nothing
 * is there yet), or a connection the caller opened and closes.
 */
export type TestDatabaseSource = string | DatabaseSync;

export interface TestRuntimeOptions {
    /** Fields over the default `PlatformConfig` (no model, no keys, no runtime, voice `marin`). */
    config?: Partial<PlatformConfig>;
    /**
     * The app's database; a fresh in-memory one by default.
     *
     * - A path: one connection over the file, under the store and the
     *   workspace, as the server opens it. `dispose` closes the connection
     *   and the data stays, for a runtime that restarts over it, or for what
     *   opens the file itself (Better Auth, the backup CLI by `DATABASE_PATH`).
     * - A `DatabaseSync`: the caller's connection, under both stores.
     *   `dispose` leaves it open.
     * - `{ store, workspace }`: a connection each, as before they shared one.
     *   A path's connection belongs to that store, as when it opens the path
     *   itself: its `close()` closes only that connection. A `DatabaseSync`
     *   stays the caller's. The
     *   workspace's connection is `db`.
     */
    database?: TestDatabaseSource | { store: TestDatabaseSource; workspace: TestDatabaseSource };
    /** The agent runner; one over a test database of its own by default. `dispose` closes it. */
    runner?: LocalAgentRunner;
    /** The server modules; the server's list by default. */
    modules?: AppBoot['modules'];
    /** The graph's auth provider: `app.auth` when there is an app (as the server shares one), else `testAuth()`. */
    auth?: AuthSetup;
    /**
     * Who may run code (CB-376) with the default `testAuth()`: the people
     * the `code:run` permission covers. The array is read on every check,
     * so a test may change it (`TestRuntime.codeRunners`).
     */
    codeRunners?: string[];
    /**
     * Fakes over the graph's services: the runtime offers these instead
     * (the routes, which read the edge's services, and the module hooks
     * read them), built over the rest of the graph. The graph's own layers
     * were built with the real ones, and `platform`'s members stay the
     * real ones.
     */
    layers?: Layer.Layer<never, never, AppServices>;
    /**
     * Runs once the runtime is built and before `app` is: to set up what
     * the routes find when they mount. A failure here disposes everything,
     * as a failed build does.
     */
    beforeApp?: (runtime: TestRuntime) => unknown;
    /** Builds `createApp` bound to the runtime: the research runner and config default to the platform's. */
    app?: TestAppOptions;
}

export interface TestRuntime {
    readonly runtime: AppRuntime;
    /** The tests' view of the graph's services, with `Platform`'s member names (`TestPlatform`). */
    readonly platform: TestPlatform;
    /** What the HTTP edge and the boot steps take: the runtime and its services (main.ts). */
    readonly edge: AppEdge;
    /** The connection under the store and the workspace (the workspace's, when they have one each). */
    readonly db: DatabaseSync;
    readonly store: Store;
    readonly workspace: WorkspaceStore;
    readonly config: PlatformConfig;
    /** `options.codeRunners`, the array the default `testAuth()` reads (empty when not given). */
    readonly codeRunners: string[];
    /**
     * Another app over this runtime, its platform and its auth (one per role
     * or person, say), as `options.app` builds it. Each wires the platform
     * to its auth provider, as every `createApp` over one platform does.
     */
    readonly makeApp: (options?: TestAppOptions) => Hono<AppEnv>;
    /** Stops the platform, disposes the runtime, closes the stores and the connections it opened. Idempotent. */
    readonly dispose: () => Promise<void>;
}

/** The runtime, with the app when the options ask for one. */
export type TestRuntimeWith<O extends TestRuntimeOptions> = TestRuntime &
    (O extends { app: TestAppOptions } ? { readonly app: Hono<AppEnv> } : unknown);

const DEFAULT_CONFIG: PlatformConfig = { baseUrl: '', voiceName: 'marin', runtimeUrl: '' };

/**
 * `openDatabase` (`@socio/data/open`) over `path`, written from the
 * template first when nothing is there: here so that a connection whose
 * pragmas fail (a file that isn't a database) is closed before the error
 * leaves, as `openDatabase` returns nothing to close then. `env` as there.
 */
function openFile(path: string, env?: Record<string, string | undefined>) {
    const db = new DatabaseSync(testDatabaseFile(path));
    try {
        applyConnectionPragmas(db, env);
    } catch (error) {
        db.close();
        throw error;
    }
    return db;
}

/** A connection over `source`: a path opened (and closed by the helper), else the caller's. */
function connect(source: TestDatabaseSource | undefined) {
    if (source === undefined) {
        return { db: testDatabase(), owned: true };
    }
    if (typeof source === 'string') {
        return { db: openFile(source, {}), owned: true };
    }
    return { db: source, owned: false };
}

/**
 * Makes `store` the owner of the connection the helper opened for it, as
 * when it opens a path itself (`new Store(path)`): its `close()` then
 * closes the connection (the store first keeps its final settings).
 */
function handOver<S extends Store | WorkspaceStore>(store: S, owns: boolean): S {
    const fields = store as unknown as { owned?: boolean };
    if (typeof fields.owned !== 'boolean') {
        throw new Error(`${store.constructor.name} no longer has an \`owned\` flag: update handOver().`);
    }
    if (owns) {
        fields.owned = true;
    }
    return store;
}

/**
 * Builds the server's layer graph and runtime over a test database (a
 * fresh one unless `options.database` names one), as `startAppRuntime`
 * does (the same `makeAppLayer` and module services), plus
 * `options.layers` over it. Call `dispose` when the test ends.
 */
export async function makeTestRuntime<const O extends TestRuntimeOptions = TestRuntimeOptions>(
    options: O = {} as O,
): Promise<TestRuntimeWith<O>> {
    // What is opened so far, for `dispose` to close: a step that fails
    // part way leaves the rest undefined.
    const opened: DatabaseSync[] = [];
    let store: Store | undefined;
    let workspace: WorkspaceStore | undefined;
    let runner: LocalAgentRunner | undefined = options.runner;
    let runtime: AppRuntime | undefined;
    let platformBuilt: TestPlatform | undefined;
    let disposed: Promise<void> | undefined;
    /**
     * Every step runs, each even when one before it failed; the first
     * failure is rethrown once they all have. The platform's stop
     * (`LeaderWork.stop`) closes the runner; closing it again is for a
     * graph never built. The runtime's
     * dispose releases what a partial build made. A store handed a
     * connection closes it; the helper closes what it opened and is still
     * open (a store that failed to build over it); the caller's stay open.
     */
    const dispose = () =>
        (disposed ??= (async () => {
            const steps: Array<() => unknown> = [
                () => platformBuilt?.stop(),
                () => runner?.close(),
                () => runtime?.dispose(),
                () => store?.close(),
                () => workspace?.close(),
                ...opened.map((db) => () => db.isOpen && db.close()),
            ];
            let failure: { error: unknown } | undefined;
            for (const step of steps) {
                try {
                    await step();
                } catch (error) {
                    failure ??= { error };
                }
            }
            if (failure) {
                throw failure.error;
            }
        })());
    try {
        const database = options.database;
        if (typeof database === 'object' && !(database instanceof DatabaseSync)) {
            // A connection each. A path's is opened here, so a store that
            // fails to build over it still leaves it to close, then handed
            // to the store, whose `close()` closes it, as when it opens a
            // path itself.
            const own = (source: TestDatabaseSource) => {
                if (typeof source !== 'string') {
                    return source;
                }
                const db = openFile(source);
                opened.push(db);
                return db;
            };
            const storeDb = own(database.store);
            store = handOver(new Store(storeDb), typeof database.store === 'string');
            const workspaceDb = own(database.workspace);
            workspace = handOver(new WorkspaceStore(workspaceDb), typeof database.workspace === 'string');
        } else {
            const connection = connect(database);
            if (connection.owned) {
                opened.push(connection.db);
            }
            store = new Store(connection.db);
            workspace = new WorkspaceStore(connection.db);
        }
        runner ??= new LocalAgentRunner(testDatabase());
        const config: PlatformConfig = { ...DEFAULT_CONFIG, ...options.config };
        const codeRunners = options.codeRunners ?? [];
        const boot: AppBoot = {
            db: workspace.db,
            store,
            workspace,
            config,
            runner,
            auth: options.auth ?? options.app?.auth ?? testAuth({ codeRunners }),
            ...(options.modules ? { modules: options.modules } : {}),
        };
        // startAppRuntime, with the fakes merged over the graph's output.
        let built: Context.Context<AppServices> | undefined;
        const graph = makeAppLayer(
            boot,
            () => runtime!,
            moduleServices(
                () => runtime!,
                () => built,
            ),
        );
        // The tests' view, read as soon as the server's graph is built and
        // before the fakes are (its members are the graph's own): a fake that
        // fails to build still leaves it to stop.
        const base = Layer.effectDiscard(
            Effect.map(Effect.context<AppServices>(), (context) => {
                platformBuilt = new TestPlatform(context);
            }),
        ).pipe(Layer.provideMerge(graph));
        const appRuntime: AppRuntime = ManagedRuntime.make(
            options.layers ? options.layers.pipe(Layer.provideMerge(base)) : base,
        );
        runtime = appRuntime;
        built = await appRuntime.context();
        const edge: AppEdge = { runtime: appRuntime, services: built };
        const platform = platformBuilt!;
        const appStore = store;
        const makeApp = (app: TestAppOptions = {}) => {
            const appConfig = app.config ?? { mode: 'live', baseUrl: config.baseUrl };
            const research = typeof app.runner === 'function' ? app.runner(appStore) : app.runner;
            return createApp({
                ...app,
                auth: app.auth ?? boot.auth,
                store: appStore,
                runner: research ?? new Runner(appStore, appConfig),
                config: appConfig,
                edge,
                runtime: appRuntime,
            });
        };
        const result: TestRuntime = {
            runtime: appRuntime,
            platform,
            edge,
            db: workspace.db,
            store,
            workspace,
            config,
            codeRunners,
            makeApp,
            dispose,
        };
        await options.beforeApp?.(result);
        if (!options.app) {
            return result as TestRuntimeWith<O>;
        }
        return { ...result, app: makeApp(options.app) } as TestRuntimeWith<O>;
    } catch (error) {
        // A database, graph, hook or app that fails leaves nothing open.
        await dispose().catch(() => {});
        throw error;
    }
}
