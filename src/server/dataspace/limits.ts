import { ANALYTICAL_RETAIN_DAYS_MAX } from '@socio/shared/dataspace/analytics';

import type { DataLimits, DataSettings } from './contract.js';

const MB = 1024 * 1024;

function positive(env: Record<string, string | undefined>, name: string, scale = 1): number | undefined {
    const raw = env[name]?.trim();
    if (!raw) {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive number.`);
    }
    return Math.floor(value * scale);
}

export function dataSettingsFromEnv(env: Record<string, string | undefined>, defaultDir: string): DataSettings {
    const limits: Partial<DataLimits> = {};
    const set = <K extends keyof DataLimits>(key: K, value: number | undefined) => {
        if (value !== undefined) {
            limits[key] = value;
        }
    };
    set('datasetMaxBytes', positive(env, 'DATA_DATASET_MAX_MB', MB));
    set('userMaxBytes', positive(env, 'DATA_USER_MAX_MB', MB));
    set('fileMaxBytes', positive(env, 'DATA_FILE_MAX_MB', MB));
    set('maxDatasets', positive(env, 'DATA_MAX_DATASETS'));
    set('queryTimeoutMs', positive(env, 'DATA_QUERY_TIMEOUT_MS'));
    set('queryMaxRows', positive(env, 'DATA_QUERY_MAX_ROWS'));
    set('queryMaxBytes', positive(env, 'DATA_QUERY_MAX_BYTES'));
    set('statementsPerMinute', positive(env, 'DATA_STATEMENTS_PER_MINUTE'));
    set('pluginDatasetMaxBytes', positive(env, 'DATA_PLUGIN_DATASET_MAX_MB', MB));
    set('pluginQueryMaxRows', positive(env, 'DATA_PLUGIN_QUERY_MAX_ROWS'));
    set('pluginStatementsPerMinute', positive(env, 'DATA_PLUGIN_STATEMENTS_PER_MINUTE'));
    set('batchTimeoutMs', positive(env, 'DATA_BATCH_TIMEOUT_MS'));
    // Analytical tables (CB-369).
    set('analyticalMaxBytes', positive(env, 'DATA_ANALYTICS_MAX_MB', MB));
    set('analyticsQueryTimeoutMs', positive(env, 'DATA_ANALYTICS_QUERY_TIMEOUT_SECONDS', 1000));
    set('analyticsQueryMaxRows', positive(env, 'DATA_ANALYTICS_QUERY_MAX_ROWS'));
    set('analyticsQueryMaxBytes', positive(env, 'DATA_ANALYTICS_QUERY_MAX_MB', MB));
    set('analyticsQueryMemoryMb', positive(env, 'DATA_ANALYTICS_QUERY_MEMORY_MB'));
    set('analyticsThreads', positive(env, 'DATA_ANALYTICS_THREADS'));
    set('analyticsQueryTempMb', positive(env, 'DATA_ANALYTICS_QUERY_TEMP_MB'));
    set('analyticsJoinMaxRows', positive(env, 'DATA_ANALYTICS_JOIN_MAX_ROWS'));
    set('analyticsJoinMaxBytes', positive(env, 'DATA_ANALYTICS_JOIN_MAX_MB', MB));
    set('analyticsQueryConcurrency', positive(env, 'DATA_ANALYTICS_QUERY_CONCURRENCY'));
    set('appendMaxRows', positive(env, 'DATA_ANALYTICS_APPEND_MAX_ROWS'));
    set('appendMaxBytes', positive(env, 'DATA_ANALYTICS_APPEND_MAX_MB', MB));
    // 0 keeps shared areas' items until someone deletes them.
    const retention = env.DATA_SHARED_RETENTION_DAYS?.trim();
    if (retention) {
        const days = Number(retention);
        if (!Number.isInteger(days) || days < 0) {
            throw new Error('DATA_SHARED_RETENTION_DAYS must be a whole number of days (0 keeps everything).');
        }
        limits.sharedRetentionDays = days;
    }
    // CB-387: analytical tables' retention when nothing else sets one; 0 keeps everything.
    const analyticalRetention = env.DATA_ANALYTICS_RETAIN_DAYS?.trim();
    if (analyticalRetention) {
        const days = Number(analyticalRetention);
        if (!Number.isInteger(days) || days < 0 || days > ANALYTICAL_RETAIN_DAYS_MAX) {
            throw new Error(
                `DATA_ANALYTICS_RETAIN_DAYS must be a whole number of days from 0 to ${ANALYTICAL_RETAIN_DAYS_MAX} (0 keeps everything).`,
            );
        }
        limits.analyticalRetainDays = days;
    }
    // CB-451: days row stamps' tombstones are kept for changes reads.
    const tombstones = env.DATA_STAMP_TOMBSTONE_DAYS?.trim();
    if (tombstones) {
        const days = Number(tombstones);
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
            throw new Error('DATA_STAMP_TOMBSTONE_DAYS must be a whole number of days from 1 to 3650.');
        }
        limits.stampTombstoneDays = days;
    }
    const ttl = positive(env, 'DATA_TOKEN_TTL_MINUTES', 60_000);
    // CB-369: the analytics process for analytical tables; `off` refuses them.
    const analytics = env.DATA_ANALYTICS_MODE?.trim() || 'child';
    if (analytics !== 'child' && analytics !== 'off') {
        throw new Error('DATA_ANALYTICS_MODE must be child or off.');
    }
    return {
        analyticsMode: analytics,
        userDataDir: env.USER_DATA_DIR?.trim() || defaultDir,
        apiUrl: env.DATA_API_URL?.trim().replace(/\/$/, '') || undefined,
        ...(ttl ? { tokenTtlMs: ttl } : {}),
        limits,
    };
}
