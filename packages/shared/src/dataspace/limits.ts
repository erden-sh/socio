/**
 * The data space's limits and their built-in defaults, moved here from
 * `server/dataspace/contract.ts` so the settings' limits read them without
 * importing the data space. The data space's contract re-exports them.
 */
import type { DataLimitsView } from '../data-types.js';

const MB = 1024 * 1024;

/**
 * The data space's limits; every one is enforced for every Dot, bypass or
 * not. The view's analytical limits (CB-369) are optional on the wire, for
 * clients of older servers; the server always has them.
 */
export type DataLimits = Required<DataLimitsView>;

export const DEFAULT_DATA_LIMITS: DataLimits = {
    datasetMaxBytes: 100 * MB,
    userMaxBytes: 1024 * MB,
    // Every file, chat attachments included (CB-54).
    fileMaxBytes: 25 * MB,
    maxDatasets: 50,
    queryTimeoutMs: 5_000,
    queryMaxRows: 500,
    queryMaxBytes: 256 * 1024,
    statementsPerMinute: 120,
    insertMaxRows: 1_000,
    // A company socio's shared area (CB-229): what nobody changed for a month.
    sharedRetentionDays: 0,
    // A service plugin's own datasets (`plugin:<id>`): today's defaults,
    // which an admin may raise in Settings for plugins alone.
    pluginDatasetMaxBytes: 100 * MB,
    pluginQueryMaxRows: 500,
    // A plugin's data token (CB-473): its own budget, sized for a plugin
    // page that loads several reads at once for each person using it.
    pluginStatementsPerMinute: 600,
    batchMaxStatements: 32,
    batchTimeoutMs: 30_000,
    // Analytical tables (CB-369). Their bytes have a budget of their own,
    // per owner, apart from `userMaxBytes` (the owner's decision).
    analyticalMaxBytes: 1024 * MB,
    analyticsQueryTimeoutMs: 30_000,
    analyticsQueryMaxRows: 10_000,
    analyticsQueryMaxBytes: 8 * MB,
    analyticsQueryMemoryMb: 512,
    analyticsThreads: 2,
    analyticsQueryTempMb: 2_048,
    analyticsJoinMaxRows: 200_000,
    analyticsJoinMaxBytes: 64 * MB,
    analyticsQueryConcurrency: 2,
    appendMaxRows: 200_000,
    appendMaxBytes: 64 * MB,
    // The workspace's retention for analytical tables nobody set one for
    // (CB-387): 0 keeps everything, so nothing is dropped unless asked.
    analyticalRetainDays: 0,
    // Days a deleted row's stamp is kept for changes reads (CB-451):
    // a cache synced less often than this reconciles instead.
    stampTombstoneDays: 30,
};
