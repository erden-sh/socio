import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import {
    deploymentScopeId,
    parseDeploymentScopeId,
    summarizeDeployment,
    type ContainerSample,
    type DeploymentResourcesView,
    type DeploymentSnapshot,
} from '@socio/shared/deployment-resources';
import type { DeploymentMetrics } from '@socio/shared/operations/deployment-metrics';
import type { OpsHealth } from '@socio/shared/operations/operations-health';

import { ComputerService } from '../src/server/computers/computer-service.js';
import { ResourceSampler } from '../src/server/operations/sampler.js';

import { staticAuth } from './fixtures/static-auth.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import type { TestPlatform } from './helpers/test-platform.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-321: the Operations dashboard sees the whole deployment.
const GiB = 1024 ** 3;
const TOKEN = 'supervisor-token-with-24-characters';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});

const container = (patch: Partial<ContainerSample>): ContainerSample => ({
    kind: 'stack',
    stack: 'company-brain',
    service: 'company-brain_app',
    node: 'node-1',
    cpuPercent: 10,
    memoryBytes: GiB,
    memoryLimitBytes: 3 * GiB,
    restarts: 0,
    ...patch,
});
const SNAPSHOT: DeploymentSnapshot = {
    node: { name: 'node-1', cpus: 16, memoryBytes: 64 * GiB },
    truncated: false,
    containers: [
        container({ restarts: 2 }),
        container({
            service: 'company-brain_seaweedfs',
            cpuPercent: 5,
            memoryBytes: 512 * 1048576,
            memoryLimitBytes: GiB,
        }),
        container({
            service: 'company-brain_litestream',
            cpuPercent: 1,
            memoryBytes: 100 * 1048576,
            memoryLimitBytes: null,
        }),
        container({
            kind: 'plugin',
            stack: null,
            service: 'socio-plugin-weather',
            cpuPercent: 2,
            memoryBytes: 50 * 1048576,
            memoryLimitBytes: 256 * 1048576,
        }),
        container({
            kind: 'plugin',
            stack: null,
            service: 'socio-plugin-weather',
            cpuPercent: 3,
            memoryBytes: 60 * 1048576,
            memoryLimitBytes: 256 * 1048576,
        }),
        container({
            kind: 'computer',
            stack: null,
            service: 'company-brain-computer-d1',
            cpuPercent: 20,
            memoryBytes: GiB,
            memoryLimitBytes: 2 * GiB,
            restarts: null,
        }),
        container({
            kind: 'computer',
            stack: null,
            service: 'company-brain-computer-d2',
            cpuPercent: 30,
            memoryBytes: GiB,
            memoryLimitBytes: 2 * GiB,
            restarts: null,
        }),
    ],
};

async function platformFixture(config: { computerDiskUsageUrl?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb321-deployment-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            runtimeUrl: '',
            voiceName: 'marin',
            data: { userDataDir: dir },
            operations: { resources: { sampleDays: 9 } },
            computerSupervisorToken: TOKEN,
            ...config,
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: staticAuth({ id: 'admin', name: 'Admin', role: 'admin' }),
        },
    });
    cleanup.push(dispose);
    const view = async () =>
        (await (await app.request('/api/operations/resources/deployment')).json()) as DeploymentResourcesView;
    return { platform, app, view };
}
function useMetrics(platform: TestPlatform, metrics: DeploymentMetrics | null) {
    vi.spyOn(platform.computers, 'deployment', 'get').mockReturnValue(metrics);
}

it('rolls a snapshot up per service and for the deployment, flagging services without a limit', () => {
    const { totals, services } = summarizeDeployment(SNAPSHOT);
    expect(services.get(deploymentScopeId('stack', 'node-1', 'company-brain', 'company-brain_app'))).toEqual({
        cpuPercent: 10,
        memoryBytes: GiB,
        memoryLimitBytes: 3 * GiB,
        restarts: 2,
        containers: 1,
        unlimitedContainers: 0,
    });
    // Two replicas: used and limits add up, restarts are the service's.
    expect(services.get(deploymentScopeId('plugin', 'node-1', null, 'socio-plugin-weather'))).toMatchObject({
        cpuPercent: 5,
        memoryBytes: 110 * 1048576,
        memoryLimitBytes: 512 * 1048576,
        containers: 2,
    });
    expect(
        services.get(deploymentScopeId('stack', 'node-1', 'company-brain', 'company-brain_litestream')),
    ).toMatchObject({
        memoryLimitBytes: null,
        unlimitedContainers: 1,
    });
    // The computers are one row.
    expect(services.get(deploymentScopeId('computer', 'node-1', null, 'computers'))).toMatchObject({
        cpuPercent: 50,
        memoryBytes: 2 * GiB,
        memoryLimitBytes: 4 * GiB,
        restarts: null,
        containers: 2,
    });
    expect(services.size).toBe(5);
    expect(totals).toEqual({
        cpuPercent: 71,
        memoryBytes: GiB + 512 * 1048576 + 100 * 1048576 + 110 * 1048576 + 2 * GiB,
        memoryLimitBytes: 3 * GiB + GiB + 512 * 1048576 + 4 * GiB,
        limitedMemoryBytes: GiB + 512 * 1048576 + 110 * 1048576 + 2 * GiB,
        services: 5,
        unlimitedServices: 1,
        restarts: 2,
        nodeCpus: 16,
        nodeMemoryBytes: 64 * GiB,
    });
    expect(parseDeploymentScopeId('deploy:stack:node-1:company-brain:company-brain_app')).toEqual({
        kind: 'stack',
        node: 'node-1',
        stack: 'company-brain',
        service: 'company-brain_app',
    });
    for (const bad of ['deploy:total', 'deploy:other:n::s', 'deploy:stack:n:s', 'd1', 'deploy:constructor:n::s']) {
        expect(parseDeploymentScopeId(bad)).toBeUndefined();
    }
});

it('reads the disk usage proxy’s stats route with the supervisor token and keeps only the port’s fields', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answer = {
        ...SNAPSHOT,
        extra: 'dropped',
        containers: SNAPSHOT.containers.map((row) => ({ ...row, Env: ['SECRET=1'], Mounts: ['/etc'] })),
    };
    const transport = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const service = (computerDiskUsageUrl?: string) =>
        new ComputerService(
            workspace,
            {
                computerSupervisorToken: TOKEN,
                computerDiskUsageUrl,
            },
            () => false,
            transport,
        );
    expect(service().deployment).toBeNull();
    expect(service('  ').deployment).toBeNull();
    const metrics = service('http://company-brain-disk-usage:4301/').deployment!;
    const snapshot = await metrics.snapshot();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://company-brain-disk-usage:4301/deployment/stats');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(snapshot).toEqual(SNAPSHOT);
    expect(JSON.stringify(snapshot)).not.toMatch(/Env|SECRET|Mounts|extra/);
});

it('stores per-service samples with each resource sample and shows totals, services and restarts', async () => {
    const { platform, view } = await platformFixture({ computerDiskUsageUrl: 'http://company-brain-disk-usage:4301' });
    const snapshot = vi.fn(async () => SNAPSHOT);
    useMetrics(platform, { snapshot });
    const now = Date.now();
    await new ResourceSampler(platform.context).collect(now);
    expect(snapshot).toHaveBeenCalledTimes(1);
    const body = await view();
    expect(body.state).toBe('ok');
    expect(body.failedAt).toBeNull();
    expect(body.totals.latest).toMatchObject({
        at: now,
        values: { services: 5, unlimitedServices: 1, cpuPercent: 71 },
    });
    expect(body.services.map((row) => [row.service, row.noLimit])).toEqual([
        ['computers', false],
        ['company-brain_app', false],
        ['company-brain_seaweedfs', false],
        ['socio-plugin-weather', false],
        ['company-brain_litestream', true],
    ]);
    expect(body.services[1]).toMatchObject({
        kind: 'stack',
        stack: 'company-brain',
        node: 'node-1',
        history: { latest: { values: { restarts: 2, memoryLimitBytes: 3 * GiB } } },
    });
    expect(body.services[1]!.history.hourly).toHaveLength(1);
    // A service gone from the next sample isn't shown as current.
    snapshot.mockResolvedValueOnce({ ...SNAPSHOT, containers: SNAPSHOT.containers.slice(0, 1) });
    await new ResourceSampler(platform.context).collect(now + 300_000);
    const next = await view();
    expect(next.services.map((row) => row.service)).toEqual(['company-brain_app']);
});

it('says the deployment metrics are unavailable without the proxy or when a read fails, and still samples the host', async () => {
    const off = await platformFixture();
    expect(off.platform.computers.deployment).toBeNull();
    await new ResourceSampler(off.platform.context).collect(Date.now());
    const offView = await off.view();
    expect(offView.state).toBe('off');
    expect(offView.totals.latest).toBeNull();
    expect(offView.services).toEqual([]);

    const failing = await platformFixture({ computerDiskUsageUrl: 'http://company-brain-disk-usage:4301' });
    const snapshot = vi.fn<DeploymentMetrics['snapshot']>(async () => SNAPSHOT);
    useMetrics(failing.platform, { snapshot });
    const now = Date.now();
    await new ResourceSampler(failing.platform.context).collect(now);
    snapshot.mockRejectedValueOnce(new Error('Computer service returned HTTP 502.'));
    const sampler = new ResourceSampler(failing.platform.context);
    await expect(sampler.collect(now + 300_000)).resolves.toBeUndefined();
    const view = await failing.view();
    expect(view.state).toBe('unavailable');
    expect(view.failedAt).toBe(now + 300_000);
    // What it has stays shown.
    expect(view.totals.latest?.at).toBe(now);
    expect(view.services).toHaveLength(5);
    const host = await failing.app.request('/api/operations/resources');
    expect((await host.json()).latest.at).toBe(now + 300_000);

    // A proxy that answers nonsense is a failed read too.
    useMetrics(failing.platform, {
        snapshot: async () => {
            throw new Error('malformed');
        },
    });
    await expect(new ResourceSampler(failing.platform.context).collect(now + 600_000)).resolves.toBeUndefined();
});

it('puts the deployment metrics’ state on Health’s live part', async () => {
    const { platform, app } = await platformFixture({ computerDiskUsageUrl: 'http://company-brain-disk-usage:4301' });
    useMetrics(platform, { snapshot: async () => SNAPSHOT });
    const now = Date.now();
    await new ResourceSampler(platform.context).collect(now);
    const health = (await (await app.request('/api/operations/health')).json()) as OpsHealth;
    expect(health.live.deployment).toEqual({ state: 'ok', measuredAt: now, services: 5, unlimitedServices: 1 });
    useMetrics(platform, null);
    const off = (await (await app.request('/api/operations/health')).json()) as OpsHealth;
    expect(off.live.deployment).toMatchObject({ state: 'off' });
});
