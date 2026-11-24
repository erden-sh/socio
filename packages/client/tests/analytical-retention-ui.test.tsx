// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AnalyticalRetention, AnalyticalRetentionPreview } from '@socio/shared/dataspace/analytics';

import { AnalyticalRetentionControl, retentionLine } from '../src/modules/dataspace/AnalyticalRetention';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-387: an admin's retention override on an analytical table, previewed
// before a value that drops partitions is saved.

let host: HTMLDivElement;
let root: Root;
let requests: { path: string; method: string; body?: unknown }[];
let preview: AnalyticalRetentionPreview;

const BASE = '/data/datasets/d1';
const manifest: AnalyticalRetention = { days: 30, source: 'manifest', declared: 30, workspaceDefault: null };

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    preview = {
        table: 'occupancy',
        days: 10,
        partitions: 5,
        parts: 5,
        rows: 1200,
        bytes: 4096,
        firstPartition: '2026-09-26',
        lastPartition: '2026-10-31',
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path: `${url.pathname}${url.search}`, method, ...(body ? { body } : {}) });
        const answer = url.pathname.endsWith('/preview') ? preview : manifest;
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

const render = (retention: AnalyticalRetention, saved = vi.fn()) => {
    act(() =>
        root.render(<AnalyticalRetentionControl base={BASE} table="occupancy" retention={retention} saved={saved} />),
    );
    return saved;
};
const button = (name: RegExp) =>
    [...document.querySelectorAll('button')].find((item) => name.test(item.textContent ?? ''))!;
const type = (value: string) => {
    const input = host.querySelector('input')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

it('says where the retention comes from', () => {
    expect(retentionLine(manifest)).toBe('Retention: 30 days, from the plugin.');
    expect(retentionLine({ ...manifest, days: null, source: 'override', override: null })).toBe(
        'Retention: every partition, from an admin’s override.',
    );
    expect(retentionLine({ days: 40, source: 'default', declared: null, workspaceDefault: 40 })).toBe(
        'Retention: 40 days, from the workspace default.',
    );
});

it('previews a lower retention and saves it only once confirmed', async () => {
    const saved = render(manifest);
    expect(host.textContent).not.toMatch(/Clear override/);
    type('10');
    act(() => button(/Save override/).click());
    await settle();
    expect(requests).toEqual([{ path: `/api${BASE}/tables/occupancy/retention/preview?days=10`, method: 'GET' }]);
    const dialog = document.querySelector('[data-slot="table-retention-preview"]')!;
    expect(dialog.textContent).toMatch(/drops 5 partition\(s\), 2026-09-26 to 2026-10-31: 1200 row\(s\), 4/);
    act(() => button(/Drop them and save/).click());
    await settle();
    expect(requests.at(-1)).toEqual({
        path: `/api${BASE}/tables/occupancy/retention`,
        method: 'PUT',
        body: { days: 10 },
    });
    expect(saved).toHaveBeenCalled();
});

it('saves a longer retention, keep everything, and a lower one that drops nothing at once', async () => {
    render(manifest);
    type('90');
    act(() => button(/Save override/).click());
    await settle();
    act(() => button(/Keep everything/).click());
    await settle();
    preview = { ...preview, partitions: 0, firstPartition: null, lastPartition: null };
    type('20');
    act(() => button(/Save override/).click());
    await settle();
    expect(
        requests.map(({ method, path, body }) => [method, path.replace(`/api${BASE}/tables/occupancy`, ''), body]),
    ).toEqual([
        ['PUT', '/retention', { days: 90 }],
        ['PUT', '/retention', { days: null }],
        ['GET', '/retention/preview?days=20', undefined],
        ['PUT', '/retention', { days: 20 }],
    ]);
    expect(document.querySelector('[data-slot="table-retention-preview"]')).toBeNull();
});

it('previews clearing an override that keeps more than the plugin', async () => {
    render({ days: 90, source: 'override', override: 90, declared: 30, workspaceDefault: null });
    act(() => button(/Clear override \(30 days\)/).click());
    await settle();
    expect(requests).toEqual([{ path: `/api${BASE}/tables/occupancy/retention/preview?days=30`, method: 'GET' }]);
    act(() => button(/Drop them and save/).click());
    await settle();
    expect(requests.at(-1)).toEqual({ path: `/api${BASE}/tables/occupancy/retention`, method: 'DELETE' });
});
