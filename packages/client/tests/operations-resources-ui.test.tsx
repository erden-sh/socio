// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    RESOURCE_DEFAULTS,
    RESOURCE_METRICS,
    type ResourceHistory,
    type ResourceValues,
} from '@socio/shared/operations/operations-resources';

import { api } from '../src/lib/api';
import { ResourcePanel } from '../src/modules/operations/ResourcePanel';
import { ResourceSettings } from '../src/modules/operations/ResourceSettings';

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

it('saves zero retention, shows server defaults, and offers an explicit reset', async () => {
    const calls: unknown[] = [];
    const view = {
        policy: { ...RESOURCE_DEFAULTS },
        defaults: { ...RESOURCE_DEFAULTS, sampleDays: 9 },
    };
    vi.mocked(api).mockImplementation(async (_path, method, body) => {
        if (method === 'PUT') {
            calls.push(body);
            const change = body as Record<string, number | null>;
            for (const [key, value] of Object.entries(change)) {
                view.policy[key as keyof typeof RESOURCE_DEFAULTS] =
                    value ?? view.defaults[key as keyof typeof RESOURCE_DEFAULTS];
            }
        }
        return structuredClone(view) as never;
    });
    act(() => root.render(<ResourceSettings />));
    await settle();
    expect(host.textContent).toContain('agent runs are always kept');
    const input = Array.from(host.querySelectorAll('label'))
        .find((label) => label.textContent?.includes('Resource samples'))!
        .querySelector('input')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => host.querySelector<HTMLFormElement>('form')!.requestSubmit());
    await settle();
    expect(calls).toContainEqual(expect.objectContaining({ sampleDays: 0 }));
    act(() =>
        Array.from(host.querySelectorAll('button'))
            .find((button) => button.textContent === 'Use server defaults')!
            .click(),
    );
    await settle();
    expect(calls.at(-1)).toEqual(Object.fromEntries(Object.keys(RESOURCE_DEFAULTS).map((key) => [key, null])));
    expect(input.value).toBe('9');
});

it('shows gaps instead of invented zeroes and displays actual zero measurements', async () => {
    const values = Object.fromEntries(Object.keys(RESOURCE_METRICS).map((key) => [key, null])) as ResourceValues;
    values.walBytes = 0;
    values.rssBytes = 1048576;
    const history: ResourceHistory = {
        latest: { at: 1000, values },
        hourly: [
            {
                at: 0,
                samples: 1,
                values,
                observedAt: Object.fromEntries(Object.keys(values).map((key) => [key, 1000])) as Record<
                    keyof ResourceValues,
                    number
                >,
            },
        ],
        collectedEverySeconds: 300,
        gaps: [
            {
                metric: 'userdataBytes',
                label: RESOURCE_METRICS.userdataBytes,
                lastAt: null,
                state: 'missing',
            },
        ],
    };
    vi.mocked(api).mockResolvedValue(history);
    act(() => root.render(<ResourcePanel />));
    await settle();
    const pairs = Array.from(host.querySelectorAll('dl > div'));
    expect(pairs.find((pair) => pair.textContent?.includes('Database WAL'))?.textContent).toContain('0 MiB');
    expect(pairs.find((pair) => pair.textContent?.includes('Process CPU'))?.textContent).toContain('—');
    expect(host.querySelector('[data-slot="ops-collection-gaps"]')?.textContent).toContain('no history');
    expect(host.textContent).toContain('Most recent 24 hourly averages');
});
