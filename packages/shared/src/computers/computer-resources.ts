import type { ResourceHistory } from '../operations/operations-resources.js';

export const COMPUTER_RESOURCE_METRICS = {
    cpuPercent: 'CPU',
    memoryBytes: 'Memory working set',
    memoryLimitBytes: 'Memory limit',
    volumeBytes: 'Owned computer volumes',
    containerBytes: 'Computer container layer',
} as const;
export type ComputerResourceMetric = keyof typeof COMPUTER_RESOURCE_METRICS;
export type ComputerResourceValues = Record<ComputerResourceMetric, number | null>;
export interface ComputerResourceStats {
    botId: string;
    container: string;
    instance: string;
    running: boolean;
    values: ComputerResourceValues;
}
export interface ComputerResourceRow {
    dotId: string;
    name: string;
    running: boolean | null;
    history: ResourceHistory<ComputerResourceMetric>;
    /** OOM attempts in the requested period, among the retained application attempts. */
    appOoms: number;
    lastAppOomAt: number | null;
}
/**
 * The computers' disk usage (CB-197): measured through a read-only Docker
 * proxy every `everyMinutes`, for all computers at once. `off` when no proxy
 * is set up (COMPUTER_DISK_USAGE_URL), `pending` before the first result,
 * `unavailable` when the last measurement failed and no recent one is left.
 */
export interface ComputerDiskStatus {
    state: 'off' | 'pending' | 'ok' | 'unavailable';
    measuredAt: number | null;
    everyMinutes: number;
}
export interface ComputerResourcesView {
    rows: ComputerResourceRow[];
    disk: ComputerDiskStatus;
    more: boolean;
    from: number | null;
    to: number;
}
