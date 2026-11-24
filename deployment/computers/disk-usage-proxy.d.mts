import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface DiskUsageRoute {
    method: 'GET';
    path: string;
    query: Record<string, string>;
    upstream?: string;
    note: string;
}
export const DISK_USAGE_ROUTES: readonly DiskUsageRoute[];
export function matchDiskUsageRoute(method: string | undefined, url: string | undefined): DiskUsageRoute | undefined;
export function filterVolumes(report: unknown, namespace: string): unknown;
export function filterContainers(list: unknown, namespace: string): unknown[];
export function engineGet(socketPath: string, path: string, timeoutMs: number, maxBytes?: number): Promise<unknown>;

/** The proxy's own route for the deployment's resource use (CB-321). */
export const DEPLOYMENT_STATS_PATH: '/deployment/stats';
export const DEPLOYMENT_STATS_MAX_CONTAINERS: number;
export const DEPLOYMENT_CONTAINER_FIELDS: readonly (keyof DeploymentContainerStats)[];
export interface DeploymentScope {
    stacks: string[];
    pluginPrefix: string;
    node: string | null;
}
export function deploymentScope(options?: {
    stacks?: string | readonly string[];
    pluginPrefix?: string;
    node?: string;
}): DeploymentScope;
export type DeploymentMemberKind = 'stack' | 'plugin' | 'computer';
export function deploymentMember(
    container: unknown,
    scope: DeploymentScope,
    namespace: string,
): { kind: DeploymentMemberKind; stack: string | null; service: string } | undefined;
export function deploymentListPaths(scope: DeploymentScope, namespace: string): string[];
export function statsNumbers(
    stats: unknown,
    hostMemoryBytes?: number,
): { cpuPercent: number | null; memoryBytes: number | null; memoryLimitBytes: number | null; cpus: number | null };
/** One running container of the deployment: names and numbers only. */
export interface DeploymentContainerStats {
    kind: DeploymentMemberKind;
    stack: string | null;
    service: string;
    node: string | null;
    /** Percent of one CPU (150 is one and a half CPUs). */
    cpuPercent: number | null;
    memoryBytes: number | null;
    /** Null when the container has no memory limit. */
    memoryLimitBytes: number | null;
    /** The service's replaced tasks Swarm still keeps; null for computers. */
    restarts: number | null;
}
export interface DeploymentStats {
    node: { name: string | null; cpus: number | null; memoryBytes: number | null };
    containers: DeploymentContainerStats[];
    truncated: boolean;
}
export function readDeploymentStats(options: {
    get: (path: string, timeoutMs?: number) => Promise<unknown>;
    scope: DeploymentScope;
    namespace: string;
    hostMemoryBytes?: number;
    statsTimeoutMs?: number;
}): Promise<DeploymentStats>;

export interface DiskUsageOptions {
    namespace: string | undefined;
    token: string | undefined;
    minIntervalMs?: number;
    /** How long a deployment stats answer is reused (default 15 s). */
    statsIntervalMs?: number;
    statsTimeoutMs?: number;
    /** `SOCIO_STACKS`: comma-separated stack names. */
    stacks?: string | readonly string[];
    /** `PLUGIN_NAME_PREFIX`, default `socio-plugin`. */
    pluginPrefix?: string;
    /** `DISK_USAGE_NODE`: the node's name, reported with each container. */
    node?: string;
    hostMemoryBytes?: number;
    now?: () => number;
}
export function diskUsageHandler(
    options: DiskUsageOptions & { get: (path: string, timeoutMs?: number) => Promise<unknown> },
): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export function startDiskUsageProxy(
    options: DiskUsageOptions & {
        socketPath?: string;
        host?: string;
        port?: number;
        timeoutMs?: number;
    },
): Promise<Server>;
