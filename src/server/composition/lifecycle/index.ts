/**
 * Boot and shutdown order: the per-feature steps the process entry (index.ts)
 * ran, in its order. Each step lives in its feature's
 * `composition/lifecycle/<x>.ts`; this file only orders them, in phases,
 * because index.ts does process work between them (the database, the config,
 * the HTTP server):
 *
 * 1. `startAuth` and `seedCodeGroup` (CB-376), before the stores open;
 * 2. `syncAccounts`, once they are;
 * 3. `bootFeatures`, once the layers are built: backups, inference kinds,
 *    Telegram, the task runner, the leader lease;
 * 4. `loadDocs`, before the app is made;
 * 5. `startFeatures`, once the pages are mounted: socio access, the
 *    gateway's and the mini apps' internal listeners; then `warmUp`, the
 *    first requests' one-time work, before the server listens;
 * 6. `listening`, when the server listens;
 * 7. `shutdownSteps`, the drain and stop order on a signal.
 */
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

import { Context } from 'effect';

import type { DataKeys } from '@socio/foundation/keys/data-keys';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';

import type { AuthSetup } from '../../auth/contract.js';
import type { BackupSettings } from '../../backup/contract.js';
import { abortComputerActions, computerActionsInFlight } from '../../computers/computer-service.js';
import type { AppEdge, AppRuntime } from '../../main.js';
import type { LeaderLease } from '../../runtime/background.js';
import { forceStop } from '../../runtime/force-stop.js';
import { createShutdown, drainMsInForce } from '../../runtime/shutdown.js';
import { limitsFor } from '../../settings/limits.js';
import type { SqliteStateStore } from '../../telegram/channel-state.js';
import type { Runner } from '../../turns/runner.js';
import { runSourceOf } from '../app/conversations.js';
import { LeaderWork } from '../app/work.js';
import { LegacyRunner, LegacyWorkspace } from '../base.js';
import type { PlatformConfig } from '../config.js';
import type { CoreStore } from '../core-store.js';
import { LegacyJobs } from '../schedules.js';
import type { AppWorkspace } from '../workspace-parts.js';

import { actorsLifecycle } from './actors.js';
import { appsLifecycle } from './apps.js';
import { authLifecycle } from './auth.js';
import { backupLifecycle } from './backup.js';
import { docsLifecycle } from './docs.js';
import { gatewayLifecycle } from './gateway.js';
import { inferenceLifecycle } from './inference.js';
import { runtimeLifecycle } from './runtime.js';
import { telegramLifecycle } from './telegram.js';
import { turnsLifecycle } from './turns.js';
import { voiceLifecycle } from './voice.js';
import { warmLifecycle } from './warm.js';

type Env = Record<string, string | undefined>;

/** Phase 1, after the database's boot step and before the stores open. */
export const startAuth = authLifecycle.startProvider;
export const seedCodeGroup = authLifecycle.seedCodeGroup;

/** Phase 2, the provider's accounts in the workspace. */
export const syncAccounts = authLifecycle.syncAccounts;

/**
 * Phase 3, once the layers are built: what each feature starts with the
 * runtime, in the process entry's order. Returns the task runner, its
 * research config and the leader lease, which the app and the shutdown
 * use.
 */
export function bootFeatures({
    database,
    telegramState,
    connection,
    backupSettings,
    dataKeys,
    config,
    store,
    workspace,
    edge,
    auth,
    env,
    superseded,
}: {
    database: string;
    /** Telegram's state store, opened only when Telegram is on. */
    telegramState: () => SqliteStateStore;
    connection: DatabaseSync;
    backupSettings: BackupSettings;
    dataKeys: DataKeys;
    config: PlatformConfig;
    store: CoreStore;
    workspace: AppWorkspace;
    edge: AppEdge;
    auth: AuthSetup;
    env: Env;
    /** Another task led while this one stalled: restart as a follower. */
    superseded: () => void;
}) {
    backupLifecycle.start({ database, backupSettings, dataKeys, config, store, edge });
    inferenceLifecycle.registerKinds(edge, env);
    // A deactivated person is not a user here (accounts.ts); createApp ends
    // what acts for them when they are deactivated.
    const isUser = authLifecycle.activeUsers(auth);
    telegramLifecycle.start({ edge, store, workspace, config, stateStore: telegramState, isUser, auth, env });
    const { researchConfig, runner } = turnsLifecycle.taskRunner({
        store,
        config,
        edge,
        isUser,
        leading: (): boolean => leader.current(),
    });
    const { leader, pruning } = runtimeLifecycle.leadership({ edge, runner, connection, superseded });
    return { researchConfig, runner, leader, pruning };
}

/** Phase 4: the docs catalog, before the app is made. */
export const loadDocs = docsLifecycle.load;

/**
 * Phase 5, once the pages are mounted: what runs on every runtime, not
 * only the leader. The gateway's and the mini apps' listeners are returned
 * for the shutdown.
 */
export function startFeatures(edge: AppEdge, env: Env) {
    actorsLifecycle.watch(edge);
    const gateway = gatewayLifecycle.start(edge, env);
    const appsInternal = appsLifecycle.startInternal(edge, env);
    Context.get(edge.services, LeaderWork).awaitListening();
    return { gateway, appsInternal };
}

/**
 * Phase 5b, right before the server listens: what the first requests would
 * otherwise load on the main thread (sign-in, a page's first render), so
 * `/healthz` answers only once it is done (`warm.ts`).
 */
export const warmUp = warmLifecycle.warmUp;

/** Phase 6, when the server listens: then `announce`, then leads at once unless another live task does. */
export function listening(edge: AppEdge, leader: LeaderLease, announce: () => void) {
    Context.get(edge.services, LeaderWork).markListening();
    announce();
    // Leads at once unless another live task does (a start-first deploy's
    // previous task), then when that one hands over.
    void leader.start();
}

/**
 * Phase 7: drains first (CB-37): running turns finish, new ones are
 * refused. With SHUTDOWN_FORCE (development) they are stopped at once
 * instead; worker runs keep running in the worker, as on any restart, and
 * the next task follows them.
 */
export function shutdownSteps({
    env,
    shutdownForce,
    config,
    store,
    workspace,
    connection,
    edge,
    appRuntime,
    runner,
    leader,
    pruning,
    started,
    server,
}: {
    env: Env;
    shutdownForce: boolean;
    config: PlatformConfig;
    store: CoreStore;
    workspace: AppWorkspace;
    connection: DatabaseSync;
    edge: AppEdge;
    appRuntime: AppRuntime;
    runner: Runner;
    leader: LeaderLease;
    pruning: ReturnType<typeof setInterval>;
    started: ReturnType<typeof startFeatures>;
    server: Server;
}) {
    const { services } = edge;
    const work = Context.get(services, LeaderWork);
    return createShutdown({
        drain: () => {
            // Hands the leader's work to the next task at once (CB-108).
            void leader.stop();
            runner.drain();
            work.drain();
            voiceLifecycle.closeDictation(edge);
        },
        inProgress: () => runner.running + work.inProgress(),
        // Read when the drain starts, so the limit saved in Settings counts.
        drainMs: () => drainMsInForce(env, store.slices.settings.settings(), limitsFor(config)),
        force: shutdownForce
            ? () =>
                  forceStop(
                      {
                          // What the force stop reads (`WorkPlatform`), from the graph's tags.
                          platform: {
                              runner: Context.get(services, LegacyRunner),
                              jobs: Context.get(services, LegacyJobs),
                              drain: () => work.drain(),
                              runSource: runSourceOf(Context.get(services, LegacyWorkspace)),
                          },
                          scheduler: runner,
                          computers: { inFlight: computerActionsInFlight, abort: abortComputerActions },
                      },
                      { by: 'shutdown', hold: false },
                  )
            : undefined,
        stopRunner: () => runner.stop(),
        stopPlatform: async () => {
            clearInterval(pruning);
            await leader.stop();
            try {
                await work.stop();
            } finally {
                await appRuntime.dispose();
            }
        },
        closeServer: async () => {
            await gatewayLifecycle.stop(started.gateway);
            await appsLifecycle.stopInternal(started.appsInternal);
            await new Promise<void>((resolve, reject) => {
                // Any live dictation still open: its upgraded socket would hold the
                // close until its own limit.
                voiceLifecycle.closeDictation(edge);
                // Responses still streaming end with the platform stop; their
                // connections then close at once instead of idling on keep-alive.
                const sweep = setInterval(() => {
                    if ('closeIdleConnections' in server) {
                        server.closeIdleConnections();
                    }
                }, 250);
                server.close((error) => {
                    clearInterval(sweep);
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        },
        closeDatabase: () => {
            store.close();
            workspace.close();
            if (connection.isOpen) {
                connection.close();
            }
        },
        exit: (code) => process.exit(code),
        log: (line) => console.log(line),
        report: (operation, error) => reportFailure(operation, [safeFailure(error)]),
    });
}
