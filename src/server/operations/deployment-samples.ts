import type { SqliteData } from '@socio/data/open';
import {
    DEPLOYMENT_SERVICE_METRICS,
    DEPLOYMENT_SERVICE_SCOPE_PREFIX,
    DEPLOYMENT_TOTAL_METRICS,
    DEPLOYMENT_TOTALS_SCOPE,
    parseDeploymentScopeId,
    summarizeDeployment,
    type DeploymentHealth,
    type DeploymentMetricsState,
    type DeploymentResourcesView,
    type DeploymentServiceMetric,
    type DeploymentServiceRow,
    type DeploymentTotalMetric,
} from '@socio/shared/deployment-resources';
import type { DeploymentMetrics } from '@socio/shared/operations/deployment-metrics';

import { scopesSampledAt, SqliteResourceSamples } from './infra/sqlite/samples.js';

/** The last read through the port on this server, per platform (the leader samples). */
const attempts = new WeakMap<object, { at: number; ok: boolean }>();

const totalsSamples = (data: SqliteData) =>
    new SqliteResourceSamples<DeploymentTotalMetric>(data, DEPLOYMENT_TOTALS_SCOPE, DEPLOYMENT_TOTAL_METRICS);
const serviceSamples = (data: SqliteData, scopeId: string) =>
    new SqliteResourceSamples<DeploymentServiceMetric>(data, scopeId, DEPLOYMENT_SERVICE_METRICS);

/**
 * One deployment sample (CB-321): the totals and each service, with the
 * resource samples' retention. A failed read records nothing (a gap) and
 * is remembered, so the dashboard can say the numbers are unavailable.
 */
export async function sampleDeployment(input: {
    owner: object;
    metrics: DeploymentMetrics | null;
    data: SqliteData;
    at: number;
    keepDays: number;
    signal: AbortSignal;
}) {
    const { owner, metrics, data, at, keepDays, signal } = input;
    if (!metrics) {
        return false;
    }
    let snapshot;
    try {
        snapshot = await metrics.snapshot(signal);
    } catch {
        attempts.set(owner, { at, ok: false });
        return false;
    }
    attempts.set(owner, { at, ok: true });
    const current = () => !signal.aborted;
    const { totals, services } = summarizeDeployment(snapshot);
    await totalsSamples(data).record({ at, values: totals }, keepDays, current);
    for (const [scopeId, values] of services) {
        await serviceSamples(data, scopeId).record({ at, values }, keepDays, current);
    }
    return true;
}

function stateOf(
    metrics: DeploymentMetrics | null,
    latestAt: number | null,
    attempt: { at: number; ok: boolean } | undefined,
    now: number,
    intervalSeconds: number,
): DeploymentMetricsState {
    if (!metrics) {
        return 'off';
    }
    const fresh = latestAt !== null && now - latestAt <= 3 * intervalSeconds * 1000;
    if (attempt && !attempt.ok && (latestAt === null || attempt.at > latestAt)) {
        return 'unavailable';
    }
    return fresh ? 'ok' : latestAt === null ? 'pending' : 'unavailable';
}

/** The Resources panel's deployment view: totals and the services of the latest sample. */
export async function deploymentResources(input: {
    owner: object;
    metrics: DeploymentMetrics | null;
    data: SqliteData;
    now: number;
    intervalSeconds: number;
}): Promise<DeploymentResourcesView> {
    const { owner, metrics, data, now, intervalSeconds } = input;
    const totals = await totalsSamples(data).history(now, intervalSeconds);
    const attempt = attempts.get(owner);
    const latestAt = totals.latest?.at ?? null;
    const services: DeploymentServiceRow[] = [];
    if (latestAt !== null) {
        for (const scopeId of await scopesSampledAt(data, DEPLOYMENT_SERVICE_SCOPE_PREFIX, latestAt)) {
            const parsed = parseDeploymentScopeId(scopeId);
            if (!parsed) {
                continue;
            }
            const history = await serviceSamples(data, scopeId).history(now, intervalSeconds);
            const values = history.latest?.values;
            services.push({
                ...parsed,
                noLimit: !values || values.memoryLimitBytes === null || (values.unlimitedContainers ?? 0) > 0,
                history,
            });
        }
    }
    services.sort(
        (a, b) =>
            (b.history.latest?.values.memoryBytes ?? -1) - (a.history.latest?.values.memoryBytes ?? -1) ||
            a.service.localeCompare(b.service),
    );
    return {
        state: stateOf(metrics, latestAt, attempt, now, intervalSeconds),
        failedAt: attempt && !attempt.ok ? attempt.at : null,
        totals,
        services,
    };
}

/** Health's live line for the deployment's numbers. */
export async function deploymentHealth(input: {
    owner: object;
    metrics: DeploymentMetrics | null;
    data: SqliteData;
    now: number;
    intervalSeconds: number;
}): Promise<DeploymentHealth> {
    const { owner, metrics, data, now, intervalSeconds } = input;
    const latest = metrics ? await totalsSamples(data).latest() : null;
    return {
        state: stateOf(metrics, latest?.at ?? null, attempts.get(owner), now, intervalSeconds),
        measuredAt: latest?.at ?? null,
        services: latest?.values.services ?? null,
        unlimitedServices: latest?.values.unlimitedServices ?? null,
    };
}
