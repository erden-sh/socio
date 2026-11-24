// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { COMPUTER_RESOURCE_METRICS, type ComputerResourcesView } from '@socio/shared/computers/computer-resources';

import { api } from '../src/lib/api';
import { ComputerResourcesPanel } from '../src/modules/operations/ComputerResourcesPanel';

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
it('shows actual zeroes, an unlimited memory limit, stopped state, and retained per-socio OOM counts', async () => {
    const values = {
        cpuPercent: 0,
        memoryBytes: 0,
        memoryLimitBytes: 0,
        volumeBytes: 0,
        containerBytes: 0,
    };
    const view: ComputerResourcesView = {
        from: 0,
        to: 2000,
        more: false,
        disk: { state: 'ok', measuredAt: 900, everyMinutes: 15 },
        rows: [
            {
                dotId: 'd1',
                name: 'Fixture socio',
                running: false,
                appOoms: 3,
                lastAppOomAt: 1000,
                history: {
                    collectedEverySeconds: 300,
                    gaps: [],
                    latest: { at: 1000, values },
                    hourly: [
                        {
                            at: 0,
                            samples: 1,
                            values,
                            observedAt: {
                                cpuPercent: 1000,
                                memoryBytes: 1000,
                                memoryLimitBytes: 1000,
                                volumeBytes: 1000,
                                containerBytes: 1000,
                            },
                        },
                    ],
                },
            },
        ],
    };
    vi.mocked(api).mockResolvedValue(view);
    act(() =>
        root.render(
            <MemoryRouter initialEntries={['/operations/health?socio=d1']}>
                <ComputerResourcesPanel />
            </MemoryRouter>,
        ),
    );
    await settle();
    expect(vi.mocked(api).mock.calls[0][0]).toContain('socio=d1');
    const cells = host.querySelector('tbody > tr')!.children;
    expect(cells[0].textContent).toContain('Fixture socio');
    expect(cells[0].textContent).toContain('Stopped');
    expect(cells[1].textContent).toBe('0%');
    expect(cells[2].textContent).toBe('0 MiB / Unlimited');
    expect(cells[3].textContent).toBe('0 MiB0 MiB container layer');
    expect(cells[4].textContent).toContain('3');
    expect(host.textContent).toContain('Disk usage is measured through Docker every 15 minutes. Last measured');
    expect(host.textContent).toContain('retained attempts');
    expect(host.textContent).toContain('Hourly history');
});
it('marks unavailable telemetry as missing instead of inventing zero resource usage', async () => {
    vi.mocked(api).mockResolvedValue({
        from: 0,
        to: 2000,
        more: false,
        rows: [
            {
                dotId: 'd1',
                name: 'New socio',
                running: true,
                appOoms: 0,
                lastAppOomAt: null,
                history: {
                    collectedEverySeconds: 300,
                    latest: null,
                    hourly: [],
                    gaps: Object.entries(COMPUTER_RESOURCE_METRICS).map(([metric, label]) => ({
                        metric,
                        label,
                        lastAt: null,
                        state: 'missing',
                    })),
                },
            },
        ],
    });
    act(() =>
        root.render(
            <MemoryRouter>
                <ComputerResourcesPanel />
            </MemoryRouter>,
        ),
    );
    await settle();
    expect(host.textContent).toContain('No samples yet');
    expect(host.textContent).toContain('Missing or stale');
    const cells = host.querySelector('tbody > tr')!.children;
    expect(cells[1].textContent).toBe('—');
    expect(cells[2].textContent).toBe('— / —');
    expect(cells[3].textContent).toBe('—');
});

const runningRow = (volumeBytes: number | null) => ({
    dotId: 'd1',
    name: 'Busy socio',
    running: true,
    appOoms: 0,
    lastAppOomAt: null,
    history: {
        collectedEverySeconds: 300,
        gaps: [],
        hourly: [],
        latest: {
            at: 1000,
            values: {
                cpuPercent: 5,
                memoryBytes: 1048576,
                memoryLimitBytes: 2097152,
                volumeBytes,
                containerBytes: null,
            },
        },
    },
});
it.each([
    ['off', null, 'Not set up', 'Disk usage is not set up: it needs the read-only disk usage proxy'],
    ['pending', null, 'Not measured yet', 'measured through Docker every 15'],
    ['unavailable', 1000, 'Unavailable', 'Disk usage is unavailable: the last measurement through Docker failed.'],
] as const)('says why disk usage is missing when the proxy is %s (CB-197)', async (state, measuredAt, cell, note) => {
    vi.mocked(api).mockResolvedValue({
        from: 0,
        to: 2000,
        more: false,
        disk: { state, measuredAt, everyMinutes: 15 },
        rows: [runningRow(null)],
    } satisfies ComputerResourcesView);
    act(() =>
        root.render(
            <MemoryRouter>
                <ComputerResourcesPanel />
            </MemoryRouter>,
        ),
    );
    await settle();
    const cells = host.querySelector('tbody > tr')!.children;
    expect(cells[3].textContent).toBe(cell);
    expect(host.textContent).toContain(note);
    expect(!!host.querySelector('[role="status"]')).toBe(state === 'unavailable');
});
it('shows a measured per-computer volume size (CB-197)', async () => {
    vi.mocked(api).mockResolvedValue({
        from: 0,
        to: 2000,
        more: false,
        disk: { state: 'ok', measuredAt: 1000, everyMinutes: 15 },
        rows: [runningRow(5 * 1048576)],
    } satisfies ComputerResourcesView);
    act(() =>
        root.render(
            <MemoryRouter>
                <ComputerResourcesPanel />
            </MemoryRouter>,
        ),
    );
    await settle();
    expect(host.querySelector('tbody > tr')!.children[3].textContent).toBe('5 MiB');
});
