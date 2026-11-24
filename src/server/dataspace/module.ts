import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';

import { ActorActions, Actors } from '../actors/contract.js';
import type { ModuleServicesAccess, ServerModule } from '../modules/contract.js';
import { Spaces } from '../workspace/contract.js';

import { DataCounters, DatasetViewTools, DataViewPages } from './contract.js';
import { dataSchema } from './migrations.js';
import { dataRoutes } from './routes.js';
import type { DataSpace } from './space.js';
import { DataSpaceInstance } from './tags.js';
import { DATA_TOOL_NAMES, FILE_TOOL_NAMES, dataTools } from './tools.js';

const MB = 1048576;

/**
 * The data space. The service lives on the platform (`platform.data`);
 * the module owns its tables, the `/api/data` routes (sessions and scoped
 * tokens), the Dot tools, its capabilities, retention and reconciliation
 * with deleted Dots. `jobRoutes`: the job checkpoint routes it mounts at
 * `/api/data/job` (schedules' `jobCheckpointRoutesOf`), over the app's
 * services, which the module registry passes in.
 *
 * Its hooks read the data space (`DataSpaceInstance`, `tags.ts`), socio
 * access (`Actors`, `ActorActions`), the Spaces and the pages the embedded
 * views read (`Spaces`, `DataViewPages`) from the app's services at the
 * moment of use.
 */
export const makeDataModule = (jobRoutes: (services: ModuleServicesAccess) => Hono<AppEnv>): ServerModule => ({
    ...dataSchema,
    routes: ({ services }) => {
        const spaces = services.get(Spaces);
        return dataRoutes(
            {
                data: services.get(DataSpaceInstance),
                actors: services.get(Actors),
                workspace: {
                    pages: services.get(DataViewPages),
                    readsSpace: (...args) => spaces.readsSpace(...args),
                },
                counters: services.get(DataCounters),
            },
            services.get(ActorActions),
            () => jobRoutes(services),
        );
    },
    dotTools: ({ services }, turn) => {
        const data = services.get(DataSpaceInstance);
        return [
            ...dataTools(data, turn),
            // Embedded views: a page tool (pages' `PageTools`, as
            // `DatasetViewTools`), offered with the data tools.
            ...services.get(DatasetViewTools).datasetViews(data, turn),
        ];
    },
    capabilities: ({ services }) => [
        {
            id: 'data',
            label: 'Data space',
            description:
                'Persistent datasets (SQLite): your scratch dataset, which you shape freely, plus datasets the user granted you. A personal socio’s scratch is in the user’s own data space; a company socio’s scratch is its shared dataset, the same one its jobs and computer use, which admins and the people who use the socio can see. Use it for anything that should outlive this conversation or be tracked over time; query with SQL, and show results to people with insert_dataset_view (a live table or chart in a Space page). New datasets, writes to Space-shared datasets and access changes need the user’s approval.',
            tools: DATA_TOOL_NAMES,
            approvals: [
                APPROVAL_CAPABILITIES.createDataset,
                APPROVAL_CAPABILITIES.writeShared,
                APPROVAL_CAPABILITIES.grantChange,
            ],
            status: (turn) => {
                const data = services.get(DataSpaceInstance);
                const { limits } = data;
                const summary = data.summary(turn.userId, turn.dot.id);
                return {
                    enabled: true,
                    limits: {
                        datasetMaxMB: limits.datasetMaxBytes / MB,
                        userMaxMB: limits.userMaxBytes / MB,
                        maxDatasets: limits.maxDatasets,
                        queryTimeoutSeconds: limits.queryTimeoutMs / 1000,
                        queryMaxRows: limits.queryMaxRows,
                        insertMaxRows: limits.insertMaxRows,
                        operationsPerMinute: limits.statementsPerMinute,
                    },
                    usage: {
                        usedMB: Math.round((summary.usage.totalBytes / MB) * 100) / 100,
                        datasets: summary.usage.datasets,
                        files: summary.usage.files,
                    },
                    details: {
                        scratch: summary.scratch,
                        grantedDatasets: summary.grantedDatasets,
                    },
                };
            },
        },
        {
            id: 'files',
            label: 'Files',
            description:
                'Files in the user’s data space (exports, snapshots, notes, chat attachments), encrypted at rest. You have your own folder and any folders the user granted you; files the user attached in this conversation are readable too (see attachments). files_copy puts a readable file where your computer can reach it.',
            tools: FILE_TOOL_NAMES,
            status: (turn) => {
                const data = services.get(DataSpaceInstance);
                const summary = data.summary(turn.userId, turn.dot.id);
                return {
                    enabled: true,
                    limits: { fileMaxMB: data.limits.fileMaxBytes / MB },
                    details: {
                        ownFolder: summary.ownFolder,
                        grantedFolders: summary.grantedFolders,
                    },
                };
            },
        },
    ],
    setup: ({ services }) => ({ storage: services.get(DataSpaceInstance).storageStatus() }),
    health: ({ services }) => ({ datasetFiles: services.get(DataSpaceInstance).missingDatasetFiles() }),
    start: ({ services, log }) => {
        const data = services.get(DataSpaceInstance);
        // CB-451: `plugin:<id>` datasets are bound to their plugins, and move
        // to the workspace once no runtime of the previous release runs (the
        // plugins' needs are wired by now). The hourly run repeats it.
        adoptPluginDatasets(data, log);
        data.reconcileDots();
        // In the background: an unreachable S3 must not hold up startup.
        if (data.objects.driver === 's3') {
            void moveLocalFiles(data, log, true);
        }
    },
    stop: ({ services }) => services.get(DataSpaceInstance).close(),
    tick: {
        everyMs: 60 * 60_000,
        run: async ({ services, log }) => {
            const data = services.get(DataSpaceInstance);
            const deleted = data.applyRetention();
            if (deleted) {
                log(`Data space: deleted ${deleted} dataset(s) past their retention.`);
            }
            const shared = await data.applySharedRetention();
            if (shared) {
                log(`Data space: deleted ${shared} shared item(s) past their retention.`);
            }
            data.reconcileDots();
            adoptPluginDatasets(data, log);
            if (data.objects.driver === 's3') {
                void moveLocalFiles(data, log, data.migrationDue());
            }
            // What interrupted analytical appends left (CB-369).
            const swept = data.sweepAnalytical();
            if (swept) {
                log(`Data space: removed ${swept} file(s) interrupted analytical appends left.`);
            }
            // Row history (CB-369 Phase H): once a night, off-hours.
            if (data.historyMaintenanceDue()) {
                // Partition retention first (CB-387): what it retires leaves
                // queries now and the disk with the sweep, 48 hours later.
                const retention = data.applyAnalyticalRetention();
                if (retention.partitions || retention.failed) {
                    log(
                        `Data space: retired ${retention.partitions} analytical partition(s) past their retention (${retention.rows} row(s))${retention.failed ? `, ${retention.failed} dataset(s) failed` : ''}.`,
                    );
                }
                const history = await data.maintainHistory();
                if (history.pruned || history.compacted || history.failed) {
                    log(
                        `Data space: pruned row history in ${history.pruned} dataset(s) (${history.rows} row(s)), compacted ${history.compacted}${history.failed ? `, ${history.failed} failed` : ''}.`,
                    );
                }
            }
        },
    },
});

/** CB-451's migration of plugin datasets (`DataSpace.adoptPluginOwnedDatasets`); logs counts only. */
function adoptPluginDatasets(data: DataSpace, log: (line: string) => void) {
    try {
        const { bound, moved } = data.adoptPluginOwnedDatasets();
        if (bound || moved) {
            log(`Data space: bound ${bound} plugin dataset(s) to their plugins, moved ${moved} to the workspace.`);
        }
    } catch (error) {
        log(
            `Data space: adopting plugin datasets failed (${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}).`,
        );
    }
}

/**
 * Probes S3 (creating the bucket on first use), then, when asked, moves
 * local files there (CB-54). Logs counts only, never names.
 */
async function moveLocalFiles(data: DataSpace, log: (line: string) => void, migrate: boolean) {
    try {
        if (!(await data.probeStorage())) {
            log('Data space: object storage is unreachable; files are unavailable.');
            return;
        }
        if (!migrate) {
            return;
        }
        const result = await data.migrateToObjectStore();
        const parts = [
            result.moved && `moved ${result.moved} file(s) to object storage`,
            result.cleaned && `removed ${result.cleaned} local copy(ies)`,
            result.missing && `${result.missing} file(s) missing locally`,
            result.mismatched && `${result.mismatched} upload(s) to retry`,
            result.unavailable && 'stopped: object storage is unreachable',
        ].filter(Boolean);
        if (parts.length) {
            log(`Data space: ${parts.join('; ')}.`);
        }
    } catch {
        log('Data space: moving files to object storage failed.');
    }
}
