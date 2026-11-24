import type { ResourceHistory } from './operations/operations-resources.js';

/**
 * The deployment's resource use (CB-321):
 * every container of its stacks, plugin services and socios' computers,
 * read through the `DeploymentMetrics` port. Kept apart from the host-wide
 * numbers, which include other tenants on a shared host.
 */
export type DeploymentMemberKind = 'stack' | 'plugin' | 'computer';

/** One running container, as the port reports it: names and numbers only. */
export interface ContainerSample {
    kind: DeploymentMemberKind;
    /** The stack's name, for a stack's task. */
    stack: string | null;
    service: string;
    node: string | null;
    /** Percent of one CPU: 150 is one and a half CPUs. */
    cpuPercent: number | null;
    memoryBytes: number | null;
    /** Null when the container has no memory limit. */
    memoryLimitBytes: number | null;
    /** Replaced tasks the orchestrator still keeps for the service; null when unknown. */
    restarts: number | null;
}
export interface DeploymentSnapshot {
    node: { name: string | null; cpus: number | null; memoryBytes: number | null };
    containers: ContainerSample[];
    /** More containers ran than one answer measures. */
    truncated: boolean;
}

/** Per service (all its containers together), stored with the resource samples' retention. */
export const DEPLOYMENT_SERVICE_METRICS = {
    cpuPercent: 'CPU',
    memoryBytes: 'Memory in use',
    memoryLimitBytes: 'Memory limit',
    restarts: 'Restarts',
    containers: 'Containers',
    unlimitedContainers: 'Containers without a memory limit',
} as const;
export type DeploymentServiceMetric = keyof typeof DEPLOYMENT_SERVICE_METRICS;

/** The whole deployment at once. */
export const DEPLOYMENT_TOTAL_METRICS = {
    cpuPercent: 'Deployment CPU',
    memoryBytes: 'Deployment memory in use',
    memoryLimitBytes: 'Sum of memory limits',
    limitedMemoryBytes: 'Memory in use by services with a limit',
    services: 'Services',
    unlimitedServices: 'Services without a memory limit',
    restarts: 'Restarts',
    nodeCpus: 'Node CPUs',
    nodeMemoryBytes: 'Node memory',
} as const;
export type DeploymentTotalMetric = keyof typeof DEPLOYMENT_TOTAL_METRICS;

/**
 * Whether the deployment's numbers can be shown: `off` without the disk
 * usage proxy (COMPUTER_DISK_USAGE_URL), `pending` before the first sample,
 * `unavailable` when the last read failed or the numbers are stale.
 */
export type DeploymentMetricsState = 'off' | 'pending' | 'ok' | 'unavailable';

export interface DeploymentServiceRow {
    kind: DeploymentMemberKind;
    stack: string | null;
    service: string;
    node: string | null;
    /** No memory limit on at least one of its containers: it can starve its neighbors. */
    noLimit: boolean;
    history: ResourceHistory<DeploymentServiceMetric>;
}
export interface DeploymentResourcesView {
    state: DeploymentMetricsState;
    /** When the last read through the port failed, if this server tried. */
    failedAt: number | null;
    totals: ResourceHistory<DeploymentTotalMetric>;
    /** The services in the latest sample, the largest memory first. */
    services: DeploymentServiceRow[];
}
/** What Health shows of it, read live. */
export interface DeploymentHealth {
    state: DeploymentMetricsState;
    measuredAt: number | null;
    services: number | null;
    unlimitedServices: number | null;
}

const KIND: Record<DeploymentMemberKind, true> = { stack: true, plugin: true, computer: true };
const SCOPE = 'deploy:';
/** The socios' computers are one row: the computers panel shows each. */
export const COMPUTERS_SERVICE = 'computers';

/** The sample scope of a service: kind, node, stack and name; none of them has a colon. */
export function deploymentScopeId(
    kind: DeploymentMemberKind,
    node: string | null,
    stack: string | null,
    service: string,
) {
    return `${SCOPE}${kind}:${node ?? ''}:${stack ?? ''}:${service}`;
}
export const DEPLOYMENT_TOTALS_SCOPE = `${SCOPE}total`;
export const DEPLOYMENT_SERVICE_SCOPE_PREFIX = SCOPE;
export function parseDeploymentScopeId(scopeId: string) {
    if (!scopeId.startsWith(SCOPE)) {
        return undefined;
    }
    const parts = scopeId.slice(SCOPE.length).split(':');
    const [kind, node, stack, service] = parts;
    if (parts.length !== 4 || !kind || !Object.hasOwn(KIND, kind) || !service) {
        return undefined;
    }
    return { kind: kind as DeploymentMemberKind, node: node || null, stack: stack || null, service };
}

const sum = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length ? known.reduce((total, value) => total + value, 0) : null;
};

/**
 * A snapshot rolled up per service and for the deployment. A service's
 * memory limit is the sum of its containers' limits, or null when any of
 * them has none; restarts are the service's (the same on each replica).
 * The computers roll up into one row.
 */
export function summarizeDeployment(snapshot: DeploymentSnapshot) {
    const groups = new Map<string, { kind: DeploymentMemberKind; stack: string | null; rows: ContainerSample[] }>();
    for (const row of snapshot.containers) {
        const service = row.kind === 'computer' ? COMPUTERS_SERVICE : row.service;
        const scopeId = deploymentScopeId(row.kind, row.node, row.stack, service);
        const group = groups.get(scopeId) ?? { kind: row.kind, stack: row.stack, rows: [] };
        group.rows.push(row);
        groups.set(scopeId, group);
    }
    const services = new Map<string, Record<DeploymentServiceMetric, number | null>>();
    for (const [scopeId, { rows }] of groups) {
        const unlimited = rows.filter((row) => row.memoryLimitBytes === null).length;
        const restarts = rows.map((row) => row.restarts).filter((value): value is number => value !== null);
        services.set(scopeId, {
            cpuPercent: sum(rows.map((row) => row.cpuPercent)),
            memoryBytes: sum(rows.map((row) => row.memoryBytes)),
            memoryLimitBytes: unlimited ? null : sum(rows.map((row) => row.memoryLimitBytes)),
            restarts: restarts.length ? Math.max(...restarts) : null,
            containers: rows.length,
            unlimitedContainers: unlimited,
        });
    }
    const values = [...services.values()];
    const limited = values.filter((value) => value.memoryLimitBytes !== null);
    const totals: Record<DeploymentTotalMetric, number | null> = {
        cpuPercent: sum(values.map((value) => value.cpuPercent)),
        memoryBytes: sum(values.map((value) => value.memoryBytes)),
        memoryLimitBytes: sum(limited.map((value) => value.memoryLimitBytes)),
        limitedMemoryBytes: sum(limited.map((value) => value.memoryBytes)),
        services: values.length,
        unlimitedServices: values.length - limited.length,
        restarts: sum(values.map((value) => value.restarts)),
        nodeCpus: snapshot.node.cpus,
        nodeMemoryBytes: snapshot.node.memoryBytes,
    };
    return { totals, services };
}
