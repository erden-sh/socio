// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { LIMIT_KEYS, type LimitValues } from '@socio/shared/limits';
import type { State, User, WorkspaceState } from '@socio/shared/types';

import { WorkspaceSettings } from '../src/modules/settings/WorkspaceSettings';

// The limit cards in Settings → General (CB-108).

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

const defaults: LimitValues = {
    scheduleMinIntervalMinutes: 15,
    schedulesPerUser: 20,
    jobMaxTimeoutSeconds: 900,
    jobConcurrency: 2,
    jobsPerUser: 50,
    jobItemAttempts: 3,
    jobBatchRetries: 5,
    jobMaxBatches: 200,
    dataFileMaxMb: 25,
    dataDatasetMaxMb: 100,
    dataUserMaxMb: 1024,
    dataMaxDatasets: 50,
    dataSharedRetentionDays: 0,
    dataStampTombstoneDays: 30,
    dataPluginDatasetMaxMb: 100,
    dataPluginQueryMaxRows: 500,
    dataPluginStatementsPerMinute: 600,
    dataAnalyticalMaxMb: 1024,
    dataAnalyticsQueryTimeoutSeconds: 30,
    dataAnalyticsQueryMaxRows: 10_000,
    dataAppendMaxRows: 200_000,
    dataAnalyticsQueryMemoryMb: 512,
    dataAnalyticsQueryConcurrency: 2,
    dataAnalyticsRetainDays: 0,
    dotModelRounds: 30,
    turnTimeLimitSeconds: 300,
    turnRecallTokens: 1000,
    episodeRetentionDays: 180,
    spaceMemoryRetentionDays: 365,
    steeringMaxQueued: 5,
    roomCycleTokens: 2_000_000,
    roomMessagesPerMinute: 20,
    roomHandoffsPerCycle: 4,
    roomCycleSpendUsd: 0,
    copyLagWarnMinutes: 5,
    copyLagCriticalMinutes: 30,
    walWarnMb: 256,
    walCriticalMb: 1024,
    pluginBackupMaxGb: 20,
};

const page = (user: User, mutate = vi.fn(async () => true), limits: Partial<LimitValues> = {}) =>
    act(async () =>
        root.render(
            <WorkspaceSettings
                state={
                    {
                        settings: {
                            researchAllowed: true,
                            memoryAllowed: true,
                            limits: { ...defaults, ...limits },
                            limitDefaults: defaults,
                        },
                    } as State
                }
                workspace={
                    {
                        user,
                        setup: { missing: [], telegram: 'not_configured' },
                    } as unknown as WorkspaceState
                }
                mutate={mutate}
            />,
        ),
    );
const input = (key: string) => host.querySelector<HTMLInputElement>(`#limit-${key}`)!;
const type = (field: HTMLInputElement, value: string) =>
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
const submit = (slot: string) =>
    act(async () => host.querySelector<HTMLFormElement>(`[data-slot="limits-${slot}"]`)!.requestSubmit());

it('shows members every limit, and no way to change one', async () => {
    await page({ id: 'bob', name: 'Bob', role: 'member' });
    for (const key of LIMIT_KEYS) {
        expect(input(key).value).toBe(String(defaults[key]));
        expect(input(key).disabled).toBe(true);
    }
    expect(host.textContent).toContain('Only an admin can change these limits.');
    expect(host.querySelector('[data-slot="limits-data-space"] button')).toBeNull();
});

it('saves only the limits that differ from the server’s, and checks the rest', async () => {
    const mutate = vi.fn(async () => true);
    await page({ id: 'alice', name: 'Alice', role: 'admin' }, mutate);
    expect(host.querySelector('[data-slot="limits-schedules-jobs"] h3')!.textContent).toBe('Schedules and jobs');
    expect(host.textContent).toContain('The server starts at 1,024.');

    type(input('jobConcurrency'), '0');
    await submit('schedules-jobs');
    expect(mutate).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(
        'Jobs running at once: use a number from 1 to 32 jobs.',
    );
    type(input('jobConcurrency'), '');
    await submit('schedules-jobs');
    expect(mutate).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(
        'Jobs running at once: use a number from 1 to 32 jobs.',
    );

    type(input('jobConcurrency'), '6');
    await submit('schedules-jobs');
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        limits: {
            scheduleMinIntervalMinutes: null,
            schedulesPerUser: null,
            jobMaxTimeoutSeconds: null,
            jobConcurrency: 6,
            jobsPerUser: null,
            jobItemAttempts: null,
            jobBatchRetries: null,
            jobMaxBatches: null,
        },
    });

    type(input('roomCycleSpendUsd'), '12.5');
    await submit('rooms');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        limits: {
            roomCycleSpendUsd: 12.5,
            roomCycleTokens: null,
            roomHandoffsPerCycle: null,
            roomMessagesPerMinute: null,
        },
    });
});

it('lets an admin raise the per-plugin backup size over the server’s 20 GiB (CB-458)', async () => {
    const mutate = vi.fn(async () => true);
    await page({ id: 'alice', name: 'Alice', role: 'admin' }, mutate);
    const card = host.querySelector('[data-slot="limits-plugin-backups"]')!;
    expect(card.querySelector('h3')!.textContent).toBe('Plugin backups');
    expect(card.textContent).toContain('Largest snapshot per plugin');
    expect(input('pluginBackupMaxGb').value).toBe('20');
    expect(input('pluginBackupMaxGb').disabled).toBe(false);

    type(input('pluginBackupMaxGb'), '0');
    await submit('plugin-backups');
    expect(mutate).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(
        'Largest snapshot per plugin: use a number from 1 to 10,240 GiB.',
    );

    type(input('pluginBackupMaxGb'), '64');
    await submit('plugin-backups');
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', { limits: { pluginBackupMaxGb: 64 } });
});

it('does not check a field left at a server value outside the ranges', async () => {
    const mutate = vi.fn(async () => true);
    // The environment accepts 0.5 MB and a cap with three decimals.
    const odd = { ...defaults, dataFileMaxMb: 0.5, roomCycleSpendUsd: 12.345 };
    await act(async () =>
        root.render(
            <WorkspaceSettings
                state={
                    {
                        settings: {
                            researchAllowed: true,
                            memoryAllowed: true,
                            limits: odd,
                            limitDefaults: odd,
                        },
                    } as State
                }
                workspace={
                    {
                        user: { id: 'alice', name: 'Alice', role: 'admin' },
                        setup: { missing: [], telegram: 'not_configured' },
                    } as unknown as WorkspaceState
                }
                mutate={mutate}
            />,
        ),
    );
    type(input('dataMaxDatasets'), '7');
    await submit('data-space');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        limits: {
            dataFileMaxMb: null,
            dataDatasetMaxMb: null,
            dataUserMaxMb: null,
            dataMaxDatasets: 7,
            dataStampTombstoneDays: null,
        },
    });
    // A value the admin types is still held to the range.
    type(input('dataFileMaxMb'), '0.7');
    await submit('data-space');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Largest file: use a number from 1 to 250 MB.');
});

it('goes back to the server’s defaults', async () => {
    const mutate = vi.fn(async () => true);
    await page({ id: 'alice', name: 'Alice', role: 'admin' }, mutate, {
        dataFileMaxMb: 200,
    });
    expect(input('dataFileMaxMb').value).toBe('200');
    const reset = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="limits-data-space"] button')].find(
        (button) => button.textContent === 'Use the server’s defaults',
    )!;
    expect(reset.disabled).toBe(false);
    await act(async () => reset.click());
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        limits: {
            dataFileMaxMb: null,
            dataDatasetMaxMb: null,
            dataUserMaxMb: null,
            dataMaxDatasets: null,
            dataStampTombstoneDays: null,
        },
    });
    // Nothing saved in the other cards: nothing to go back from.
    const other = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="limits-rooms"] button')].find(
        (button) => button.textContent === 'Use the server’s defaults',
    )!;
    expect(other.disabled).toBe(true);
});
