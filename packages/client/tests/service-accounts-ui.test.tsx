// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { ServiceAccountView } from '@socio/shared/service-accounts';

import { ServiceAccountsSection } from '../src/modules/settings/ServiceAccountsSection';

// Radix checkboxes measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host?.textContent}`);
}
const type = (element: HTMLInputElement, value: string) =>
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });

it('adds a service account, makes a key and shows it once', async () => {
    const accounts: ServiceAccountView[] = [];
    const calls: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, body });
        let reply: unknown = accounts;
        if (method === 'POST' && path === '/api/service-accounts') {
            accounts.push({
                id: 'svc_1',
                name: body.name,
                role: body.role,
                description: '',
                createdAt: 1,
                createdBy: 'alice',
                createdByName: 'Alice',
                disabledAt: null,
                keys: [],
            });
            reply = accounts[0];
        }
        if (method === 'POST' && path === '/api/service-accounts/svc_1/keys') {
            const key = {
                id: 'k1',
                name: body.name,
                hint: 'abcdef',
                scopes: body.scopes,
                createdAt: 1,
                createdBy: 'alice',
                createdByName: 'Alice',
                expiresAt: Date.now() + 86_400_000,
                lastUsedAt: null,
                lastUsedIp: null,
                revokedAt: null,
            };
            accounts[0].keys.push(key);
            reply = { key, token: 'cbk_abcdef-secret' };
        }
        return new Response(JSON.stringify(reply), {
            status: method === 'POST' ? 201 : 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ServiceAccountsSection />));
    await until(() => calls.length > 0, 'the list');
    type(host.querySelector<HTMLInputElement>('[aria-label="Service account name"]')!, 'Claude (lead)');
    act(() => {
        const select = host!.querySelector<HTMLSelectElement>('[aria-label="Service account role"]')!;
        select.value = 'admin';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => host!.querySelector<HTMLFormElement>('form[aria-label="Add a service account"]')!.requestSubmit());
    await until(() => !!host!.querySelector('[data-account="Claude (lead)"]'), 'the account');
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
        name: 'Claude (lead)',
        role: 'admin',
    });
    // The new-key form is a dialog, opened from the account.
    expect(document.querySelector('[aria-label="Key name"]')).toBeNull();
    act(() =>
        [...host!.querySelector('[data-account="Claude (lead)"]')!.querySelectorAll('button')]
            .find((button) => button.textContent === 'New key')!
            .click(),
    );
    await until(() => !!document.querySelector('[aria-label="Key name"]'), 'the new-key dialog');
    type(document.querySelector<HTMLInputElement>('[aria-label="Key name"]')!, 'laptop');
    // issues:read is on by default; add issues:write.
    act(() =>
        [...document.querySelectorAll<HTMLLabelElement>('[data-slot="new-service-key"] label')]
            .find((label) => label.textContent?.includes('issues:write'))!
            .querySelector<HTMLElement>('[role="checkbox"]')!
            .click(),
    );
    act(() => document.querySelector<HTMLFormElement>('form[aria-label="New key for Claude (lead)"]')!.requestSubmit());
    await until(() => !!document.querySelector('[data-slot="service-key-token"]'), 'the token');
    expect(calls.find((call) => call.path === '/api/service-accounts/svc_1/keys')?.body).toEqual({
        name: 'laptop',
        scopes: ['issues:read', 'issues:write'],
        days: 90,
    });
    expect(document.querySelector<HTMLInputElement>('[aria-label="New API key"]')!.value).toBe('cbk_abcdef-secret');
    expect(document.body.textContent).toContain('isn’t shown again');
    await until(() => !!host!.querySelector('[data-key="laptop"]'), 'the key row');
    const row = host.querySelector('[data-key="laptop"]')!;
    expect(row.textContent).toContain('cbk_abcdef…');
    // Who made it.
    expect(row.querySelector('[data-slot="key-creator"]')!.textContent).toBe('Alice');
    // Done hides the token for good.
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Done')!.click());
    await until(() => !document.body.textContent!.includes('cbk_abcdef-secret'), 'the token to go');
});

it('disables an account from its menu, after a confirmation', async () => {
    const calls: { method: string; path: string }[] = [];
    const account: ServiceAccountView = {
        id: 'svc_ci',
        name: 'CI',
        role: 'member',
        description: 'deploys',
        createdAt: 1,
        createdBy: 'alice',
        createdByName: 'Alice',
        disabledAt: null,
        keys: [],
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        calls.push({ method: init?.method ?? 'GET', path });
        return new Response(JSON.stringify(path === '/api/service-accounts' ? [account] : { ok: true }), {
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ServiceAccountsSection />));
    await until(() => !!host!.querySelector('[data-account="CI"]'), 'the account');
    // Disable isn't on the row any more: it's in the ⋯ menu.
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Disable')).toBe(false);
    act(() => {
        host!
            .querySelector('[aria-label="Actions for CI"]')!
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await until(() => !!document.querySelector('[role="menuitem"]'), 'the menu');
    act(() => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    await until(() => !!document.querySelector('[data-slot="confirm-disable-service-account"]'), 'the confirmation');
    const confirm = document.querySelector('[data-slot="confirm-disable-service-account"]')!;
    expect(confirm.textContent).toContain('Disable CI?');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await act(async () =>
        [...confirm.querySelectorAll('button')].find((button) => button.textContent === 'Disable')!.click(),
    );
    expect(calls).toContainEqual({ method: 'DELETE', path: '/api/service-accounts/svc_ci' });
});

it('keeps the new-key dialog open until the key comes back, so its secret is shown', async () => {
    const account: ServiceAccountView = {
        id: 'svc_ci',
        name: 'CI',
        role: 'member',
        description: '',
        createdAt: 1,
        createdBy: 'alice',
        createdByName: 'Alice',
        disabledAt: null,
        keys: [],
    };
    let release!: () => void;
    const made = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        if (init?.method === 'POST') {
            await made;
            return new Response(
                JSON.stringify({
                    key: {
                        id: 'k1',
                        name: 'ci',
                        hint: 'abcdef',
                        scopes: ['issues:read'],
                        createdAt: 1,
                        createdBy: 'alice',
                        createdByName: 'Alice',
                        expiresAt: Date.now() + 86_400_000,
                        lastUsedAt: null,
                        lastUsedIp: null,
                        revokedAt: null,
                    },
                    token: 'cbk_abcdef-secret',
                }),
                { status: 201, headers: { 'Content-Type': 'application/json' } },
            );
        }
        return new Response(JSON.stringify(path === '/api/service-accounts' ? [account] : { ok: true }), {
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ServiceAccountsSection />));
    await until(() => !!host!.querySelector('[data-account="CI"]'), 'the account');
    act(() => [...host!.querySelectorAll('button')].find((button) => button.textContent === 'New key')!.click());
    await until(() => !!document.querySelector('[aria-label="Key name"]'), 'the dialog');
    type(document.querySelector<HTMLInputElement>('[aria-label="Key name"]')!, 'ci');
    act(() => document.querySelector<HTMLFormElement>('form[aria-label="New key for CI"]')!.requestSubmit());
    // While it is being made, Escape and Cancel don't close it.
    const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!;
    expect(cancel.disabled).toBe(true);
    act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-slot="new-service-key"]')).not.toBeNull();
    await act(async () => release());
    await until(() => !!document.querySelector('[data-slot="service-key-token"]'), 'the token');
    expect(document.querySelector<HTMLInputElement>('[aria-label="New API key"]')!.value).toBe('cbk_abcdef-secret');
});

it('deletes a revoked key for good after a confirmation; a live key keeps Revoke only (CB-360)', async () => {
    const calls: { method: string; path: string }[] = [];
    const key = (id: string, name: string, revokedAt: number | null) => ({
        id,
        name,
        hint: `${id}abcd`,
        scopes: ['issues:read' as const],
        createdAt: 1,
        createdBy: 'alice',
        createdByName: 'Alice',
        expiresAt: Date.now() + 86_400_000,
        lastUsedAt: null,
        lastUsedIp: null,
        revokedAt,
    });
    const account: ServiceAccountView = {
        id: 'svc_ci',
        name: 'CI',
        role: 'member',
        description: '',
        createdAt: 1,
        createdBy: 'alice',
        createdByName: 'Alice',
        disabledAt: null,
        keys: [key('k1', 'deploys', null), key('k2', 'old laptop', 2)],
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        const method = init?.method ?? 'GET';
        calls.push({ method, path });
        if (method === 'DELETE' && path.endsWith('/record')) {
            account.keys = account.keys.filter((entry) => entry.id !== 'k2');
        }
        return new Response(JSON.stringify(path === '/api/service-accounts' ? [account] : account), {
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ServiceAccountsSection />));
    await until(() => !!host!.querySelector('[data-key="old laptop"]'), 'the keys');
    const labels = (name: string) =>
        [...host!.querySelector(`[data-key="${name}"]`)!.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels('deploys')).toEqual(['Revoke']);
    expect(labels('old laptop')).toEqual(['Delete']);
    act(() => host!.querySelector<HTMLButtonElement>('[aria-label="Delete old laptop"]')!.click());
    await until(() => !!document.querySelector('[data-slot="confirm-delete-service-key"]'), 'the confirmation');
    const confirm = document.querySelector('[data-slot="confirm-delete-service-key"]')!;
    expect(confirm.textContent).toContain('Delete this revoked key for good?');
    expect(confirm.textContent).toContain('Its record and last-use history go; the audit keeps who deleted it.');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await act(async () =>
        [...confirm.querySelectorAll('button')].find((button) => button.textContent === 'Delete')!.click(),
    );
    expect(calls).toContainEqual({ method: 'DELETE', path: '/api/service-accounts/svc_ci/keys/k2/record' });
    await until(() => !host!.querySelector('[data-key="old laptop"]'), 'the key to go');
});
