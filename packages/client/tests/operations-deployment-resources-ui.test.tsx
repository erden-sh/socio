// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    DEPLOYMENT_SERVICE_METRICS,
    DEPLOYMENT_TOTAL_METRICS,
    type DeploymentResourcesView,
    type DeploymentServiceMetric,
    type DeploymentTotalMetric,
} from '@socio/shared/deployment-resources';
import type { ResourceHistory } from '@socio/shared/operations/operations-resources';

import { api } from '../src/lib/api';
import { DeploymentResourcesPanel } from '../src/modules/operations/DeploymentResourcesPanel';
import { ResourcePanel } from '../src/modules/operations/ResourcePanel';

// CB-321: the deployment's own numbers, apart from the host-wide ones.
vi.mock('../src/lib/api', () => ({ api: vi.fn() }));
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});
const settle = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};
const GiB = 1024 ** 3;
function history<Metric extends string>(
    metrics: Record<Metric, string>,
    values: Partial<Record<Metric, number | null>> | null,
): ResourceHistory<Metric> {
    const full = Object.fromEntries(
        Object.keys(metrics).map((key) => [key, values?.[key as Metric] ?? null]),
    ) as Record<Metric, number | null>;
    return {
        latest: values ? { at: 1000, values: full } : null,
        hourly: values
            ? [
                  {
                      at: 0,
                      samples: 1,
                      values: full,
                      observedAt: Object.fromEntries(Object.keys(full).map((key) => [key, 1000])) as Record<
                          Metric,
                          number
                      >,
                  },
              ]
            : [],
        gaps: [],
        collectedEverySeconds: 300,
    };
}
const totals = (values: Partial<Record<DeploymentTotalMetric, number | null>> | null) =>
    history(DEPLOYMENT_TOTAL_METRICS, values);
const service = (values: Partial<Record<DeploymentServiceMetric, number | null>>) =>
    history(DEPLOYMENT_SERVICE_METRICS, values);
const VIEW: DeploymentResourcesView = {
    state: 'ok',
    failedAt: null,
    totals: totals({
        cpuPercent: 71,
        memoryBytes: 4 * GiB,
        memoryLimitBytes: 8 * GiB,
        limitedMemoryBytes: 3 * GiB,
        services: 2,
        unlimitedServices: 1,
        restarts: 2,
        nodeCpus: 16,
        nodeMemoryBytes: 64 * GiB,
    }),
    services: [
        {
            kind: 'stack',
            stack: 'company-brain',
            service: 'company-brain_app',
            node: 'node-1',
            noLimit: false,
            history: service({
                cpuPercent: 40,
                memoryBytes: 1.5 * GiB,
                memoryLimitBytes: 3 * GiB,
                restarts: 2,
                containers: 1,
                unlimitedContainers: 0,
            }),
        },
        {
            kind: 'stack',
            stack: 'company-brain',
            service: 'company-brain_litestream',
            node: 'node-1',
            noLimit: true,
            history: service({
                cpuPercent: 1,
                memoryBytes: 100 * 1048576,
                memoryLimitBytes: null,
                restarts: 0,
                containers: 1,
                unlimitedContainers: 1,
            }),
        },
    ],
};

it('shows totals against the sum of limits, each service against its limit, restarts and a no-limit flag', async () => {
    vi.mocked(api).mockResolvedValue(structuredClone(VIEW));
    act(() => root.render(<DeploymentResourcesPanel />));
    await settle();
    expect(vi.mocked(api).mock.calls[0]![0]).toBe('/operations/resources/deployment');
    const panel = host.querySelector('[data-slot="ops-deployment-resources"]')!;
    expect(panel.textContent).toContain('apart from the host-wide ones');
    const totalsText = host.querySelector('[data-slot="ops-deployment-totals"]')!.textContent;
    expect(totalsText).toContain('4 GiB of 8 GiB limits');
    expect(totalsText).toContain('37.5% of the sum of limits');
    expect(totalsText).toContain('of the node’s 16 CPUs');
    const rows = Array.from(host.querySelectorAll('[data-slot="ops-deployment-service"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('company-brain_app');
    expect(rows[0]!.textContent).toContain('1.5 GiB / 3 GiB');
    expect(rows[0]!.textContent).toContain('50% of limit');
    expect(rows[0]!.querySelectorAll('td')[3]!.textContent).toBe('2');
    expect(rows[0]!.textContent).not.toContain('No limit');
    expect(rows[1]!.getAttribute('data-no-limit')).toBe('true');
    expect(rows[1]!.textContent).toContain('no limit');
    expect(rows[1]!.textContent).toContain('No limit: can starve its neighbors');
    expect(host.querySelector('[data-slot="ops-deployment-state"]')).toBeNull();
});

it('says the deployment metrics are unavailable without the proxy, and shows what it has when a read fails', async () => {
    vi.mocked(api).mockResolvedValue({ state: 'off', failedAt: null, totals: totals(null), services: [] });
    act(() => root.render(<DeploymentResourcesPanel />));
    await settle();
    const off = host.querySelector('[data-slot="ops-deployment-state"]')!;
    expect(off.getAttribute('data-state')).toBe('off');
    expect(off.textContent).toContain('Deployment metrics are unavailable');
    expect(off.textContent).toContain('COMPUTER_DISK_USAGE_URL');
    expect(host.querySelector('[data-slot="ops-deployment-totals"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    vi.mocked(api).mockResolvedValue({ ...structuredClone(VIEW), state: 'unavailable', failedAt: 5000 });
    act(() => root.render(<DeploymentResourcesPanel />));
    await settle();
    const failed = host.querySelector('[data-slot="ops-deployment-state"]')!;
    expect(failed.textContent).toContain('Deployment metrics are unavailable');
    expect(failed.textContent).toContain('last numbers collected');
    expect(host.querySelectorAll('[data-slot="ops-deployment-service"]')).toHaveLength(2);
});

it('labels the host panel as host-wide', async () => {
    vi.mocked(api).mockResolvedValue(history({ rssBytes: 'Process memory' }, null));
    act(() => root.render(<ResourcePanel />));
    await settle();
    expect(host.textContent).toContain('Server resources (host-wide)');
    expect(host.textContent).toContain('other tenants included');
});
