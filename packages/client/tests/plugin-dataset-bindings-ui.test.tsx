// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DatasetView } from '@socio/shared/data-types';
import type { PluginBindingChoices, PluginBindingPlan } from '@socio/shared/plugins/bindings';

import { DatasetKind } from '../src/modules/dataspace/DataPage';
import {
    bindingsNeedAsking,
    PluginDatasetsSection,
    PluginInstallDialog,
} from '../src/modules/plugins/PluginDatasetBindings';

// Binding a plugin's dataset needs (CB-451): the install screen preselects
// what the server suggests, offers only datasets that fit, and sends the
// admin's choices; the plugin's page shows each binding and changes it; the
// Data page names the plugin that writes, or wrote, a workspace dataset.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
let calls: Array<{ method: string; path: string; body?: unknown }>;

const plan: PluginBindingPlan = {
    pluginId: 'dashboards',
    installed: false,
    needs: [
        {
            need: 'bookings',
            access: 'read',
            implicit: false,
            description: 'Events to chart',
            tables: [{ table: 'events', columns: [{ name: 'id', type: 'TEXT' }] }],
            previous: { datasetId: 'd1', datasetName: 'events' },
            candidates: [
                { id: 'd1', name: 'events', description: '', writer: { id: 'events', name: 'Events' } },
                { id: 'd2', name: 'notes', description: '', problem: 'table "events" is missing' },
            ],
            preselected: { datasetId: 'd1' },
        },
        {
            need: 'cache',
            access: 'write',
            implicit: true,
            description: '',
            tables: [],
            candidates: [],
            preselected: 'new',
        },
    ],
};

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path: url.pathname,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const installed: PluginBindingPlan = {
            ...plan,
            installed: true,
            needs: [
                {
                    ...plan.needs[0]!,
                    bound: { datasetId: 'd1', datasetName: 'events', boundBy: 'ada', boundAt: 1 },
                    previous: undefined,
                    candidates: plan.needs[0]!.candidates.slice(1),
                },
            ],
        };
        return new Response(JSON.stringify(method === 'GET' ? installed : { ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

it('asks at install only when a need declares access or had data before', () => {
    expect(bindingsNeedAsking(plan)).toBe(true);
    expect(bindingsNeedAsking({ ...plan, needs: [plan.needs[1]!] })).toBe(false);
});

it('preselects the dataset used before, keeps misfits unchoosable, and sends the choices', async () => {
    let sent: PluginBindingChoices | undefined;
    await act(async () =>
        root.render(
            <PluginInstallDialog
                name="Dashboards"
                plan={plan}
                onClose={() => undefined}
                onInstall={async (bindings) => {
                    sent = bindings;
                }}
            />,
        ),
    );
    const dialog = document.querySelector('[data-slot="plugin-install-bindings"]')!;
    const select = dialog.querySelector<HTMLSelectElement>('#plugin-need-bookings')!;
    expect(select.value).toBe('d1');
    const options = [...select.options].map((option) => [option.value, option.disabled, option.textContent]);
    expect(options).toEqual([
        ['none', false, 'Not now'],
        ['d1', false, 'events (used before) · written by Events'],
        ['d2', true, 'notes · doesn’t fit'],
    ]);
    expect(dialog.textContent).toContain('table "events" is missing');
    expect(dialog.querySelector<HTMLSelectElement>('#plugin-need-cache')!.value).toBe('new');
    // Not now for the read need, then install.
    await act(async () => {
        select.value = 'none';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const install = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Install')!;
    await act(async () => install.click());
    expect(sent).toEqual({ bookings: null, cache: 'new' });
});

it('shows each binding on the plugin’s page and rebinds through the API', async () => {
    await act(async () => root.render(<PluginDatasetsSection pluginId="dashboards" />));
    expect(host.querySelector('[data-slot="plugin-need-state"]')!.textContent).toBe('Bound to events, read only.');
    const select = host.querySelector<HTMLSelectElement>('#plugin-need-bookings')!;
    expect(select.value).toBe('d1');
    await act(async () => {
        select.value = 'none';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(calls).toContainEqual({
        method: 'PUT',
        path: '/api/plugins/dashboards/bindings/bookings',
        body: { choice: null },
    });
});

it('names the plugin that writes or wrote a workspace dataset', async () => {
    const dataset = { access: 'owner', kind: 'dataset', ownerUserId: 'ws:workspace' } as DatasetView;
    await act(async () =>
        root.render(<DatasetKind dataset={{ ...dataset, plugin: { id: 'events', name: 'Events' } }} />),
    );
    expect(host.textContent).toBe('Written by Events');
    await act(async () =>
        root.render(<DatasetKind dataset={{ ...dataset, wasWrittenBy: { id: 'events', name: 'Events' } }} />),
    );
    expect(host.textContent).toBe('Was written by Events');
});
