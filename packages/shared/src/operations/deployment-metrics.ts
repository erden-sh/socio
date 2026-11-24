import { z } from 'zod';

import type { DeploymentSnapshot } from '../deployment-resources.js';

/**
 * The deployment's resource use now (CB-321): every container of its
 * stacks, plugin services and socios' computers, with CPU, memory used and
 * limit, and restarts. One adapter per platform, like the updater's.
 * Today's is the single-node
 * Swarm one, the read-only disk usage proxy.
 */
export interface DeploymentMetrics {
    snapshot(signal?: AbortSignal): Promise<DeploymentSnapshot>;
}

/** The disk usage proxy's own route (deployment/computers/disk-usage-proxy.mjs). */
export const DEPLOYMENT_STATS_PATH = '/deployment/stats';
/** One read may take this long: the engine samples each container's CPU for about a second. */
export const DEPLOYMENT_STATS_TIMEOUT_MS = 60_000;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const amount = z.number().finite().min(0).nullable();
// Only the fields the port reports are kept: anything else the proxy might
// send is dropped, never stored or shown.
const containerSchema = z.object({
    kind: z.enum(['stack', 'plugin', 'computer']),
    stack: z.string().regex(NAME).nullable(),
    service: z.string().regex(NAME),
    node: z.string().regex(NAME).nullable(),
    cpuPercent: amount,
    memoryBytes: amount,
    memoryLimitBytes: amount,
    restarts: z.number().int().min(0).nullable(),
});
const snapshotSchema = z.object({
    node: z.object({
        name: z.string().regex(NAME).nullable(),
        cpus: amount,
        memoryBytes: amount,
    }),
    containers: z.array(containerSchema).max(1000),
    truncated: z.boolean(),
});

export type DeploymentStatsRead = (path: string, signal: AbortSignal) => Promise<unknown>;

/**
 * The single-node Swarm adapter: the disk usage proxy, which reaches the
 * engine with list and stats GETs only, filtered to the deployment's
 * containers, and answers numbers only (CB-321). The app checks the shape
 * again and keeps only the port's fields.
 */
export class DiskUsageDeploymentMetrics implements DeploymentMetrics {
    constructor(private read: DeploymentStatsRead) {}

    async snapshot(signal?: AbortSignal): Promise<DeploymentSnapshot> {
        const bounded = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(DEPLOYMENT_STATS_TIMEOUT_MS)])
            : AbortSignal.timeout(DEPLOYMENT_STATS_TIMEOUT_MS);
        const answer = snapshotSchema.parse(await this.read(DEPLOYMENT_STATS_PATH, bounded));
        return {
            node: { ...answer.node },
            containers: answer.containers.map((row) => ({ ...row })),
            truncated: answer.truncated,
        };
    }
}
