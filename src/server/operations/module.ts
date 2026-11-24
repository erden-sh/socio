import { sqliteData } from '@socio/data/open';
import { MODULE_IDS } from '@socio/shared/modules';

import { Apps } from '../apps/contract.js';
import { Capabilities } from '../capabilities/contract.js';
import { Computers } from '../computers/contract.js';
import type { ServerModule } from '../modules/contract.js';
import { Rooms } from '../rooms/contract.js';
import { Limits, WorkspaceSettings } from '../settings/contract.js';
import { ChatHistory, Conversations, People, Socios, Spaces } from '../workspace/contract.js';

import { accessLogRoutes, auditor } from './access-log.js';
import { AnalyticsStore } from './analytics/connect.js';
import { OperationsBackups, OperationsConfig } from './contract.js';
import { deploymentHealth } from './deployment-samples.js';
import { AnalyticsOpsReader } from './infra/analytics/reader.js';
import { MemoryOpsReader } from './infra/memory/reader.js';
import { sqliteOperationsRepositories } from './infra/sqlite/access-log.js';
import { liveHealth } from './live-health.js';
import { operationsSchema } from './migrations.js';
import { pricing, pricingRoutes, recordBackends } from './pricing/routes.js';
import { CoverageModules } from './queries/coverage.js';
import { resourceRoutes } from './resource-routes.js';
import { resourcePolicyView } from './retention.js';
import { operationsRoutes } from './routes.js';
import { resourceSampler } from './sampler.js';
import { transcriptRoutes } from './transcripts.js';

/**
 * Operations (CB-164): the admins' dashboard of how the workspace is
 * used, what fails and what it costs. Every `/api/operations/*` path is
 * admins' (operators pass). Its numbers come from the analytics store
 * (CB-186, CB-187) through the `OpsReader` port; with analytics off
 * (`OPS_ANALYTICS_MODE=off`), an empty in-memory one answers, and the
 * dashboard says analytics isn't running. Person-level rows and chats'
 * content are written to its access log as they are opened (CB-188).
 */
export const operationsModule: ServerModule = {
    ...operationsSchema,
    id: MODULE_IDS.operations,
    access: 'admin',
    routes: (context) => {
        const { db, services } = context;
        // The limits in force (Settings' `Limits`) and a chat's history pages
        // (the workspace's `ChatHistory`) are the app's services, as are the
        // workspace's settings, Operations' config, the people, socios,
        // Spaces and chats the pages name, the analytics store, the backups,
        // the computers, the capabilities, the modules the coverage matrix
        // lists and the rooms' oversight.
        const limits = services.get(Limits);
        const store = services.get(WorkspaceSettings);
        const config = services.get(OperationsConfig);
        const people = services.get(People);
        const socios = services.get(Socios);
        const spaces = services.get(Spaces);
        const conversations = services.get(Conversations);
        const workspace = {
            users: () => people.users(),
            dot: (id: string) => socios.dot(id),
            spaces: () => spaces.spaces(),
            thread: (id: string) => conversations.thread(id),
            withDeletedThread: (id: string) => conversations.withDeletedThread(id),
        };
        const { accessLog: log } = sqliteOperationsRepositories(sqliteData(db));
        const audit = auditor({ log });
        const analytics = services.get(AnalyticsStore);
        const backups = services.get(OperationsBackups);
        const capabilities = services.get(Capabilities);
        const reader = analytics ? new AnalyticsOpsReader(analytics) : new MemoryOpsReader();
        const app = operationsRoutes({
            reader,
            settings: store,
            env: config.operations,
            audit,
            health: liveHealth(
                {
                    analytics,
                    get backups() {
                        return backups.backups;
                    },
                    apps: services.get(Apps),
                },
                store,
                () =>
                    deploymentHealth({
                        owner: services,
                        metrics: services.get(Computers).deployment,
                        data: sqliteData(db),
                        now: Date.now(),
                        intervalSeconds: resourcePolicyView(store.settings().operations, config.operations?.resources)
                            .policy.sampleEverySeconds,
                    }),
            ),
            capabilities,
            limits: () => limits.inForce(store.settings()),
            // Read-only: the coverage matrix lists modules' tools, never runs one.
            coverage: { ...services.get(CoverageModules), capabilities },
        });
        app.route('/', accessLogRoutes({ log, names: workspace }));
        app.route('/', resourceRoutes(context));
        app.route('/', pricingRoutes(context));
        app.route(
            '/',
            transcriptRoutes({
                audit,
                workspace,
                history: services.get(ChatHistory),
                grounding: (threadId) => reader.chatGrounding(threadId),
                rooms: services.get(Rooms),
            }),
        );
        return app;
    },
    start: (context) => {
        // Computer polling can time out independently of application readiness.
        void resourceSampler(context)
            .start()
            .catch(() => {
                context.log('Operations: resource collection failed; missing measurements remain visible.');
            });
    },
    tick: {
        everyMs: 60_000,
        run: (context) => {
            // The backends' providers for the cost step, and the daily price
            // sync (CB-195), which starts in the background when due.
            void recordBackends(context)
                .then(() => pricing(context).sync.tick())
                .catch(() => undefined);
            return resourceSampler(context).collect();
        },
    },
    // The leader hands over (CB-108) or the process stops: the sampler and
    // the price sync (CB-195) stop, so only one runtime runs them.
    release: async (context) => {
        await pricing(context).sync.stop();
        await resourceSampler(context).stop();
    },
    stop: async (context) => {
        await pricing(context).sync.stop();
        await resourceSampler(context).stop();
    },
};
