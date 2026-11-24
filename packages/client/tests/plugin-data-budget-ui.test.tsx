// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PluginDataBudget } from '@socio/shared/data-types';

import { PluginDataBudgetField } from '../src/modules/plugins/PluginDataBudget';

// A plugin's data budget on its page (CB-473): the workspace's default for
// plugins until an admin sets the plugin's own, saved through the data API,
// and cleared back to the default.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
let calls: Array<{ method: string; path: string; body?: unknown }>;
let budget: PluginDataBudget;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    budget = { pluginId: 'events', statementsPerMinute: 600, override: null, workspaceDefault: 600, max: 100_000 };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        const body = init?.body ? (JSON.parse(String(init.body)) as { statementsPerMinute: number | null }) : undefined;
        calls.push({ method, path: url.pathname, ...(body ? { body } : {}) });
        if (method === 'PUT' && body) {
            const override = body.statementsPerMinute;
            budget = {
                ...budget,
                override,
                statementsPerMinute: override ?? budget.workspaceDefault,
                ...(override === null ? { setBy: undefined } : { setBy: 'ada', setAt: 1 }),
            };
        }
        return new Response(JSON.stringify(budget), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

const input = () => host.querySelector<HTMLInputElement>('#plugin-budget-events')!;
const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === text);
const state = () => host.querySelector('[data-slot="plugin-data-budget-state"]')!.textContent;

it('shows the default, raises the plugin’s budget, and clears it back to the default', async () => {
    await act(async () => root.render(<PluginDataBudgetField pluginId="events" />));
    expect(input().value).toBe('600');
    expect(state()).toMatch(/^The workspace’s default for plugins, 600, set in Settings → General → Plugin datasets\./);
    expect(button('Save')!.disabled).toBe(true);
    expect(button('Use the default')).toBeUndefined();

    // Over the ceiling, or not a whole number: nothing to save.
    const type = async (value: string) =>
        act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input(), value);
            input().dispatchEvent(new Event('input', { bubbles: true }));
        });
    await type('100001');
    expect(button('Save')!.disabled).toBe(true);
    await type('2.5');
    expect(button('Save')!.disabled).toBe(true);
    await type('2400');
    await act(async () => button('Save')!.click());
    expect(calls).toContainEqual({
        method: 'PUT',
        path: '/api/data/plugins/events/budget',
        body: { statementsPerMinute: 2400 },
    });
    expect(input().value).toBe('2400');
    expect(state()).toMatch(/^Set for this plugin; the workspace’s default is 600\./);

    await act(async () => button('Use the default')!.click());
    expect(calls.at(-1)).toEqual({
        method: 'PUT',
        path: '/api/data/plugins/events/budget',
        body: { statementsPerMinute: null },
    });
    expect(input().value).toBe('600');
    expect(button('Use the default')).toBeUndefined();
});

it('shows nothing for an answer of another shape', async () => {
    vi.stubGlobal(
        'fetch',
        async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    await act(async () => root.render(<PluginDataBudgetField pluginId="events" />));
    expect(host.querySelector('[data-slot="plugin-data-budget"]')).toBeNull();
});
