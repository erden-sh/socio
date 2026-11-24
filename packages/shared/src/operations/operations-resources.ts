/** Resource collection and retention (CB-193); zero days always keeps history. */
export const OPS_RETENTION = {
    pageUseDays: { label: 'Page use days', days: 400, env: 'OPS_PAGE_USE_DAYS' },
    pageSearchDays: {
        label: 'Daily search statistics',
        days: 0,
        env: 'OPS_PAGE_SEARCH_DAYS',
    },
    notificationDays: {
        label: 'Notification records',
        days: 0,
        env: 'OPS_NOTIFICATION_DAYS',
    },
    deliveryDays: {
        label: 'Notification deliveries',
        days: 400,
        env: 'OPS_NOTIFICATION_DELIVERY_DAYS',
    },
    noticeDays: { label: 'In-app notices', days: 0, env: 'OPS_NOTICE_DAYS' },
    sampleDays: {
        label: 'Resource samples and hourly rollups',
        days: 400,
        env: 'OPS_SAMPLE_DAYS',
    },
    factDays: { label: 'Derived analytics facts', days: 0, env: 'OPS_FACT_DAYS' },
    hourlyDays: {
        label: 'Hourly analytics rollups (within retained facts)',
        days: 0,
        env: 'OPS_HOURLY_DAYS',
    },
} as const;
export type OpsRetentionKey = keyof typeof OPS_RETENTION;
export type ResourcePolicy = Record<OpsRetentionKey, number> & {
    sampleEverySeconds: number;
};
export const RESOURCE_DEFAULTS: ResourcePolicy = {
    ...(Object.fromEntries(Object.entries(OPS_RETENTION).map(([key, spec]) => [key, spec.days])) as Record<
        OpsRetentionKey,
        number
    >),
    sampleEverySeconds: 300,
};
export interface ResourcePolicyView {
    policy: ResourcePolicy;
    defaults: ResourcePolicy;
}
export const RESOURCE_METRICS = {
    rssBytes: 'Process memory',
    cpuPercent: 'Process CPU',
    load1: 'System load (1 minute)',
    load5: 'System load (5 minutes)',
    load15: 'System load (15 minutes)',
    freeMemoryBytes: 'Free system memory',
    totalMemoryBytes: 'System memory',
    volumeBytes: 'Data volume capacity',
    volumeFreeBytes: 'Data volume free space',
    databasePages: 'Database pages',
    databaseFreePages: 'Database free pages',
    walBytes: 'Database WAL',
    userdataBytes: 'Local userdata size (daily)',
    datasetBytes: 'Dataset bytes (daily)',
    fileBytes: 'Stored file bytes (daily)',
    mediaBytes: 'Media bytes (daily)',
} as const;
export type ResourceMetric = keyof typeof RESOURCE_METRICS;
export type ResourceValues = Record<ResourceMetric, number | null>;
export interface ResourceSample<Metric extends string = ResourceMetric> {
    at: number;
    values: Record<Metric, number | null>;
}
export interface ResourceHour<Metric extends string = ResourceMetric> {
    at: number;
    samples: number;
    values: Record<Metric, number | null>;
    observedAt: Record<Metric, number | null>;
}
export interface ResourceHistory<Metric extends string = ResourceMetric> {
    latest: ResourceSample<Metric> | null;
    hourly: ResourceHour<Metric>[];
    gaps: Array<{
        metric: Metric;
        label: string;
        lastAt: number | null;
        state: 'missing' | 'stale';
    }>;
    collectedEverySeconds: number;
}
