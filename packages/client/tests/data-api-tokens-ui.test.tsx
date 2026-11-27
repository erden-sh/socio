// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DataApiTokenList, DataApiTokenView } from '@socio/shared/dataspace/api-tokens';

import { DataApiTokensSection } from '../src/modules/settings/DataApiTokensSection';
import { SETTINGS_GROUPS, allowed } from '../src/modules/settings/sections';

// Settings → Data API: admins make a token (shown once), see their tokens
// and revoke them. Workspace settings, admins only.

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const view = (fields: Partial<DataApiTokenView> = {}): DataApiTokenView => ({
    id: 't1',
    name: 'Import',
    hint: 'abcdef',
    scopes: ['data:read'],
    statementsPerMinute: 600,
    createdAt: Date.now(),
    createdBy: 'ada',
    createdByName: 'Ada',
    expiresAt: Date.now() + 86_400_000,
    lastUsedAt: null,
    uses: 0,
    revokedAt: null,
    revokedBy: null,
    ...fields,
});

let root: Root;
let host: HTMLElement;
let calls: { method: string; path: string; body?: unknown }[];
let tokens: DataApiTokenView[];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    tokens = [view()];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });
        if (url.pathname === '/api/data/api-tokens' && method === 'GET') {
            const list: DataApiTokenList = {
                tokens,
                scopes: ['data:read', 'data:write', 'data:admin'],
                daysDefault: 7,
                daysMax: 30,
                statementsPerMinuteDefault: 600,
                statementsPerMinuteMax: 100_000,
            };
            return Response.json(list);
        }
        if (url.pathname === '/api/data/api-tokens' && method === 'POST') {
            const made = view({ id: 't2', name: body.name, scopes: body.scopes });
            tokens = [made, ...tokens];
            return Response.json({ apiToken: made, token: 'cbdt_api_secretvalue' }, { status: 201 });
        }
        if (url.pathname === '/api/data/api-tokens/t1' && method === 'DELETE') {
            tokens = tokens.map((token) => (token.id === 't1' ? { ...token, revokedAt: Date.now() } : token));
            return Response.json(tokens.find((token) => token.id === 't1'));
        }
        return Response.json({ error: 'unexpected' }, { status: 404 });
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

const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !check(); i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
        });
    }
    if (!check()) {
        throw new Error(`Timed out waiting for ${what}`);
    }
};
const button = (name: string) =>
    [...document.querySelectorAll('button')].find(
        (item) => item.textContent === name || item.getAttribute('aria-label') === name,
    )!;
const type = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
};

it('is a workspace settings page for admins only', () => {
    const workspace = SETTINGS_GROUPS.find((group) => group.id === 'workspace')!;
    const item = workspace.entries.find((entry) => entry.id === 'data-api')!;
    expect(item).toMatchObject({ role: 'admin', path: '/settings/data-api' });
    expect(allowed(item, { admin: true, operator: false, signIn: true, telegram: false })).toBe(true);
    expect(allowed(item, { admin: false, operator: false, signIn: true, telegram: false })).toBe(false);
});

it('makes a token and shows its value once, lists tokens and revokes one', async () => {
    act(() => root.render(<DataApiTokensSection />));
    await until(() => !!host.querySelector('[data-token="Import"]'), 'the list');
    expect(host.textContent).toContain('cbdt_api_abcdef…');
    expect(host.textContent).not.toContain('secretvalue');

    act(() => button('New token').click());
    await until(() => !!document.querySelector('[data-slot="new-data-api-token"]'), 'the dialog');
    act(() => type(document.querySelector<HTMLInputElement>('[aria-label="Token name"]')!, 'Notion import'));
    const write = [...document.querySelectorAll('label')].find((label) => label.textContent?.includes('data:write'));
    act(() => write!.querySelector<HTMLButtonElement>('button')!.click());
    act(() => button('Make token').click());
    await until(() => !!document.querySelector('[data-slot="data-api-token-value"]'), 'the value');
    expect(document.querySelector<HTMLInputElement>('[aria-label="New data API token"]')!.value).toBe(
        'cbdt_api_secretvalue',
    );
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
        name: 'Notion import',
        scopes: ['data:read', 'data:write'],
        days: 7,
        statementsPerMinute: 600,
    });
    act(() => button('Done').click());
    await until(() => !document.querySelector('[data-slot="data-api-token-value"]'), 'the dialog to close');
    await until(() => !!host.querySelector('[data-token="Notion import"]'), 'the new token listed');
    expect(document.body.textContent).not.toContain('secretvalue');

    act(() => button('Revoke Import').click());
    await until(() => /revoked/.test(host.querySelector('[data-token="Import"]')?.textContent ?? ''), 'the revoke');
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/api/data/api-tokens/t1')).toBe(true);
});
