import { DEFAULT_TURN_TIME_LIMIT_SECONDS } from '@socio/foundation/observability/failures';
import { DEFAULT_STEERING_MAX_QUEUED } from '@socio/shared/chat/steering';
import { DEFAULT_TURN_RECALL_TOKENS } from '@socio/shared/context-settings';
import { DEFAULT_COPY_ALERTS } from '@socio/shared/continuous-copy';
import { DEFAULT_DATA_LIMITS, type DataLimits } from '@socio/shared/dataspace/limits';
import type { LimitValues } from '@socio/shared/limits';
import { DEFAULT_EPISODE_RETENTION_DAYS, DEFAULT_SPACE_MEMORY_RETENTION_DAYS } from '@socio/shared/memory/retention';
import { DEFAULT_PLUGIN_BACKUP_MAX_GB } from '@socio/shared/plugins/plugin-backup';
import { ROOM_LIMIT_DEFAULTS, type RoomLimits } from '@socio/shared/rooms/rooms';
import {
    DEFAULT_JOB_SETTINGS,
    DEFAULT_SCHEDULE_SETTINGS,
    type JobSettings,
    type ScheduleSettings,
} from '@socio/shared/schedules/settings';
import { limitsInForce } from '@socio/shared/settings/limits';
import type { Settings } from '@socio/shared/types';

import { DEFAULT_DOT_MODEL_ROUNDS } from '../turns/contract.js';

import type { LimitsShape } from './contract.js';

/**
 * The limits an admin tunes in Settings (CB-108): the server's own, from the
 * environment or built in, under what the admin saved (`settings.limits`).
 * Each service reads its limits through these on every use, so a saved value
 * applies at once, with no restart.
 */
const MB = 1024 * 1024;

/**
 * What the limits read of the platform's configuration (`PlatformConfig`,
 * built from the environment, has every field): the server's own limits,
 * each left out when the environment doesn't set it. Any configuration
 * object is one (`& object`: every field is optional, so a configuration
 * that sets none of them still is, as with `PlatformConfig`).
 */
export type LimitSources = LimitFields & object;

interface LimitFields {
    readonly schedules?: Partial<ScheduleSettings>;
    readonly jobs?: Partial<JobSettings>;
    readonly data?: { readonly limits?: Partial<DataLimits> };
    readonly dotModelRounds?: number;
    readonly turnTimeLimitSeconds?: number;
    readonly turnRecallTokens?: number;
    readonly episodeRetentionDays?: number;
    readonly spaceMemoryRetentionDays?: number;
    readonly steeringMaxQueued?: number;
    readonly roomCycleTokens?: number;
    readonly roomMessagesPerMinute?: number;
    readonly roomHandoffsPerCycle?: number;
    readonly roomCycleSpendUsd?: number;
    readonly copyLagWarnMinutes?: number;
    readonly copyLagCriticalMinutes?: number;
    readonly walWarnMb?: number;
    readonly walCriticalMb?: number;
    readonly pluginBackupMaxGb?: number;
}

/** The limits as the environment and built-in defaults set them. */
export function limitDefaults(config: LimitSources): LimitValues {
    const schedules = { ...DEFAULT_SCHEDULE_SETTINGS, ...config.schedules };
    const jobs = { ...DEFAULT_JOB_SETTINGS, ...config.jobs };
    const data = { ...DEFAULT_DATA_LIMITS, ...config.data?.limits };
    return {
        scheduleMinIntervalMinutes: schedules.minIntervalMs / 60_000,
        schedulesPerUser: schedules.maxActivePerUser,
        jobMaxTimeoutSeconds: jobs.maxTimeoutSeconds,
        jobConcurrency: jobs.concurrency,
        jobsPerUser: jobs.maxJobsPerUser,
        jobItemAttempts: jobs.itemAttempts,
        jobBatchRetries: jobs.batchRetries,
        jobMaxBatches: jobs.maxBatches,
        dataFileMaxMb: data.fileMaxBytes / MB,
        dataDatasetMaxMb: data.datasetMaxBytes / MB,
        dataUserMaxMb: data.userMaxBytes / MB,
        dataMaxDatasets: data.maxDatasets,
        dataSharedRetentionDays: data.sharedRetentionDays,
        dataStampTombstoneDays: data.stampTombstoneDays,
        dataPluginDatasetMaxMb: data.pluginDatasetMaxBytes / MB,
        dataPluginQueryMaxRows: data.pluginQueryMaxRows,
        dataPluginStatementsPerMinute: data.pluginStatementsPerMinute,
        dataAnalyticalMaxMb: data.analyticalMaxBytes / MB,
        dataAnalyticsQueryTimeoutSeconds: data.analyticsQueryTimeoutMs / 1000,
        dataAnalyticsQueryMaxRows: data.analyticsQueryMaxRows,
        dataAppendMaxRows: data.appendMaxRows,
        dataAnalyticsQueryMemoryMb: data.analyticsQueryMemoryMb,
        dataAnalyticsQueryConcurrency: data.analyticsQueryConcurrency,
        dataAnalyticsRetainDays: data.analyticalRetainDays,
        dotModelRounds: config.dotModelRounds ?? DEFAULT_DOT_MODEL_ROUNDS,
        turnTimeLimitSeconds: config.turnTimeLimitSeconds ?? DEFAULT_TURN_TIME_LIMIT_SECONDS,
        turnRecallTokens: config.turnRecallTokens ?? DEFAULT_TURN_RECALL_TOKENS,
        episodeRetentionDays: config.episodeRetentionDays ?? DEFAULT_EPISODE_RETENTION_DAYS,
        spaceMemoryRetentionDays: config.spaceMemoryRetentionDays ?? DEFAULT_SPACE_MEMORY_RETENTION_DAYS,
        steeringMaxQueued: config.steeringMaxQueued ?? DEFAULT_STEERING_MAX_QUEUED,
        roomCycleTokens: config.roomCycleTokens ?? ROOM_LIMIT_DEFAULTS.cycleTokens,
        roomMessagesPerMinute: config.roomMessagesPerMinute ?? ROOM_LIMIT_DEFAULTS.messagesPerMinute,
        roomHandoffsPerCycle: config.roomHandoffsPerCycle ?? ROOM_LIMIT_DEFAULTS.handoffsPerCycle,
        // No spend cap unless one is set.
        roomCycleSpendUsd: config.roomCycleSpendUsd ?? 0,
        copyLagWarnMinutes: config.copyLagWarnMinutes ?? DEFAULT_COPY_ALERTS.copyLagWarnMinutes,
        copyLagCriticalMinutes: config.copyLagCriticalMinutes ?? DEFAULT_COPY_ALERTS.copyLagCriticalMinutes,
        walWarnMb: config.walWarnMb ?? DEFAULT_COPY_ALERTS.walWarnMb,
        walCriticalMb: config.walCriticalMb ?? DEFAULT_COPY_ALERTS.walCriticalMb,
        pluginBackupMaxGb: config.pluginBackupMaxGb ?? DEFAULT_PLUGIN_BACKUP_MAX_GB,
    };
}

/** What an admin saved for the schedule service, in its own units. */
export function scheduleOverrides(settings: Settings): Partial<ScheduleSettings> {
    const { scheduleMinIntervalMinutes: minutes, schedulesPerUser: perUser } = settings.limits ?? {};
    return {
        ...(minutes === undefined ? {} : { minIntervalMs: minutes * 60_000 }),
        ...(perUser === undefined ? {} : { maxActivePerUser: perUser }),
    };
}

/** What an admin saved for the job service. */
export function jobOverrides(settings: Settings): Partial<JobSettings> {
    const { jobMaxTimeoutSeconds, jobConcurrency, jobsPerUser, jobItemAttempts, jobBatchRetries, jobMaxBatches } =
        settings.limits ?? {};
    return {
        ...(jobMaxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds: jobMaxTimeoutSeconds }),
        ...(jobConcurrency === undefined ? {} : { concurrency: jobConcurrency }),
        ...(jobsPerUser === undefined ? {} : { maxJobsPerUser: jobsPerUser }),
        ...(jobItemAttempts === undefined ? {} : { itemAttempts: jobItemAttempts }),
        ...(jobBatchRetries === undefined ? {} : { batchRetries: jobBatchRetries }),
        ...(jobMaxBatches === undefined ? {} : { maxBatches: jobMaxBatches }),
    };
}

/** What an admin saved for the data space, in bytes. */
export function dataOverrides(settings: Settings): Partial<DataLimits> {
    const {
        dataFileMaxMb,
        dataDatasetMaxMb,
        dataUserMaxMb,
        dataMaxDatasets,
        dataSharedRetentionDays,
        dataStampTombstoneDays,
        dataPluginDatasetMaxMb,
        dataPluginQueryMaxRows,
        dataPluginStatementsPerMinute,
        dataAnalyticalMaxMb,
        dataAnalyticsQueryTimeoutSeconds,
        dataAnalyticsQueryMaxRows,
        dataAppendMaxRows,
        dataAnalyticsQueryMemoryMb,
        dataAnalyticsQueryConcurrency,
        dataAnalyticsRetainDays,
    } = settings.limits ?? {};
    return {
        ...(dataFileMaxMb === undefined ? {} : { fileMaxBytes: Math.floor(dataFileMaxMb * MB) }),
        ...(dataDatasetMaxMb === undefined ? {} : { datasetMaxBytes: Math.floor(dataDatasetMaxMb * MB) }),
        ...(dataUserMaxMb === undefined ? {} : { userMaxBytes: Math.floor(dataUserMaxMb * MB) }),
        ...(dataMaxDatasets === undefined ? {} : { maxDatasets: dataMaxDatasets }),
        ...(dataSharedRetentionDays === undefined ? {} : { sharedRetentionDays: dataSharedRetentionDays }),
        ...(dataStampTombstoneDays === undefined ? {} : { stampTombstoneDays: dataStampTombstoneDays }),
        ...(dataPluginDatasetMaxMb === undefined
            ? {}
            : { pluginDatasetMaxBytes: Math.floor(dataPluginDatasetMaxMb * MB) }),
        ...(dataPluginQueryMaxRows === undefined ? {} : { pluginQueryMaxRows: dataPluginQueryMaxRows }),
        ...(dataPluginStatementsPerMinute === undefined
            ? {}
            : { pluginStatementsPerMinute: dataPluginStatementsPerMinute }),
        ...(dataAnalyticalMaxMb === undefined ? {} : { analyticalMaxBytes: Math.floor(dataAnalyticalMaxMb * MB) }),
        ...(dataAnalyticsQueryTimeoutSeconds === undefined
            ? {}
            : { analyticsQueryTimeoutMs: Math.floor(dataAnalyticsQueryTimeoutSeconds * 1000) }),
        ...(dataAnalyticsQueryMaxRows === undefined ? {} : { analyticsQueryMaxRows: dataAnalyticsQueryMaxRows }),
        ...(dataAppendMaxRows === undefined ? {} : { appendMaxRows: dataAppendMaxRows }),
        ...(dataAnalyticsQueryMemoryMb === undefined ? {} : { analyticsQueryMemoryMb: dataAnalyticsQueryMemoryMb }),
        ...(dataAnalyticsQueryConcurrency === undefined
            ? {}
            : { analyticsQueryConcurrency: dataAnalyticsQueryConcurrency }),
        ...(dataAnalyticsRetainDays === undefined ? {} : { analyticalRetainDays: dataAnalyticsRetainDays }),
    };
}

/**
 * How long a turn may run now (CB-123), in ms: the admin's setting over
 * `TURN_TIME_LIMIT_SECONDS`. A turn reads it once, when it starts, so a
 * change applies to new turns only.
 */
export const turnTimeLimitMs = (settings: Settings, config: LimitSources) =>
    limitsInForce(settings, limitDefaults(config)).turnTimeLimitSeconds * 1000;

/**
 * The most messages a person may queue in a chat now (CB-170): the admin's
 * setting over `STEERING_MAX_QUEUED`. Checked on each new one; lowering it
 * leaves what waits already.
 */
export const steeringMaxQueued = (settings: Settings, config: LimitSources) =>
    limitsInForce(settings, limitDefaults(config)).steeringMaxQueued;

/**
 * A message's work cycle bounds in the workspace now (CB-211):
 * the turn time limit, the token, rate and handoff limits, the queue
 * limit, and a spend cap only when an admin set one (0 is none). A room's
 * own, lower values go on top of these (`effectiveRoomLimits`).
 */
export function cycleLimits(settings: Settings, config: LimitSources): RoomLimits {
    return cycleLimitsOf(limitsInForce(settings, limitDefaults(config)));
}

/** A message's work cycle bounds from the limits in force (`cycleLimits`). */
function cycleLimitsOf(limits: LimitValues): RoomLimits {
    return {
        cycleTimeMs: limits.turnTimeLimitSeconds * 1000,
        cycleTokens: limits.roomCycleTokens,
        messagesPerMinute: limits.roomMessagesPerMinute,
        maxQueued: limits.steeringMaxQueued,
        handoffsPerCycle: limits.roomHandoffsPerCycle,
        cycleSpendUsd: limits.roomCycleSpendUsd > 0 ? limits.roomCycleSpendUsd : null,
    };
}

/**
 * The `Limits` tag's methods over the platform's configuration
 * (`contract.ts`): the functions above, each read on every call as today,
 * so a saved value applies at once.
 */
export function limitsFor(config: LimitSources): LimitsShape {
    return limitsOver(() => limitDefaults(config));
}

/**
 * The `Limits` tag's methods over the server's own limits (`defaults`, a
 * fresh object on each call): the admin's saved values are read on every
 * call, so a saved value applies at once.
 */
export function limitsOver(defaults: () => LimitValues): LimitsShape {
    const inForce = (settings: Settings) => limitsInForce(settings, defaults());
    return {
        defaults,
        inForce,
        turnTimeLimitMs: (settings) => inForce(settings).turnTimeLimitSeconds * 1000,
        cycleLimits: (settings) => cycleLimitsOf(inForce(settings)),
    };
}
