// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SecretHistory, SecretReadFlagView, WorkspaceSecretsState } from '@socio/shared/workspace-secrets';

import { SETTINGS_GROUPS } from '../src/modules/settings/sections';
import { WorkspaceSecretsSection } from '../src/modules/settings/WorkspaceSecretsSection';

// Settings → Secrets (Socio Secrets phase 1): admins see names, scopes,
// grants, versions and reads, never a value; a value goes in through a
// password field that is cleared after saving.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
let calls: Array<{ method: string; path: string; body?: unknown }>;
let state: WorkspaceSecretsState;

// Phase 4: a flag, a history page and an older page.
const flag: SecretReadFlagView = {
    id: 'f1',
    rule: 'read-after-revoke',
    workload: 'bookings',
    kind: 'app',
    workloadName: 'Bookings',
    secretId: 's1',
    secretName: 'STRIPE_API_KEY',
    explanation: 'Bookings tried to read STRIPE_API_KEY 6 times after its grant was revoked.',
    firstSeenAt: Date.UTC(2026, 10, 2),
    lastSeenAt: Date.UTC(2026, 10, 2, 1),
    dismissedAt: null,
    dismissedByName: null,
};
const event = (id: number, kind: SecretHistory['events'][number]['kind'], detail: string) => ({
    id,
    at: Date.UTC(2026, 10, 1, id),
    kind,
    actorName: kind === 'first-read' ? 'Bookings' : 'Ada',
    workload: kind === 'first-read' ? 'bookings' : null,
    workloadName: kind === 'first-read' ? 'Bookings' : null,
    version: 1,
    detail,
});
const history: SecretHistory = {
    secret: { id: 's1', name: 'STRIPE_API_KEY', scope: 'workspace', appName: null, deletedAt: null },
    versions: [
        {
            version: 1,
            state: 'current',
            setAt: Date.UTC(2026, 10, 1),
            setBy: 'ada',
            setByName: 'Ada',
            retireAt: null,
            lastReadAt: null,
        },
    ],
    reads: [
        {
            workload: 'bookings',
            kind: 'app',
            workloadName: 'Bookings',
            firstReadAt: Date.UTC(2026, 10, 1, 3),
            lastReadAt: Date.UTC(2026, 10, 1, 12),
            reads: 42,
            refused: 2,
            lastRefusedAt: Date.UTC(2026, 10, 1, 13),
        },
    ],
    events: [
        event(3, 'first-read', 'first read by Bookings, version 1'),
        event(2, 'granted', 'granted to app=bookings'),
    ],
    nextBefore: 2,
    flags: [flag],
};
const olderHistory: SecretHistory = { ...history, events: [event(1, 'created', 'version 1 set')], nextBefore: null };

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    state = {
        overlapDefaultMinutes: 60,
        flags: [],
        secrets: [
            {
                id: 's1',
                name: 'STRIPE_API_KEY',
                scope: 'workspace',
                appId: null,
                appName: null,
                description: 'Charges cards',
                createdAt: Date.UTC(2026, 10, 1),
                createdByName: 'Ada',
                updatedAt: Date.UTC(2026, 10, 1),
                versions: [
                    {
                        version: 1,
                        state: 'current',
                        setAt: Date.UTC(2026, 10, 1),
                        setBy: 'ada',
                        setByName: 'Ada',
                        retireAt: null,
                        lastReadAt: null,
                    },
                ],
                grants: [{ appId: 'bookings', kind: 'app', appName: 'Bookings', grantedAt: 1, grantedByName: 'Ada' }],
                lastReadAt: Date.UTC(2026, 10, 1, 12),
                lastReadByName: 'Bookings',
            },
        ],
        apps: [
            {
                appId: 'bookings',
                kind: 'app',
                name: 'Bookings',
                status: 'promoted',
                declared: [
                    {
                        name: 'STRIPE_API_KEY',
                        required: true,
                        description: '',
                        servedBy: { id: 's1', scope: 'workspace' },
                    },
                    { name: 'SLACK_WEBHOOK', required: true, description: 'Posts bookings', servedBy: null },
                ],
                needsSetup: ['SLACK_WEBHOOK'],
            },
            // Socio Secrets phase 2: a service plugin, by its workload key.
            {
                appId: 'plugin:social-strategy',
                kind: 'plugin',
                name: 'Social strategy',
                status: 'enabled',
                declared: [{ name: 'STRIPE_API_KEY', required: true, description: '', servedBy: null }],
                needsSetup: ['STRIPE_API_KEY'],
            },
        ],
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path: url.pathname + url.search,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (url.pathname === '/api/workspace-secrets' && method === 'GET') {
            return Response.json(state);
        }
        if (url.pathname === '/api/workspace-secrets/s1/history') {
            return Response.json(url.searchParams.get('before') ? olderHistory : history);
        }
        if (url.pathname === '/api/plugins/social-strategy/identity') {
            return Response.json({ version: 4 });
        }
        return Response.json({ ok: true });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    throw new Error(`Timed out waiting for ${what}`);
}
const button = (text: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.ariaLabel === text);
function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

it('is an admins’ Settings page', () => {
    expect(SETTINGS_GROUPS.flatMap((group) => group.entries).find((entry) => entry.id === 'secrets')).toMatchObject({
        role: 'admin',
        path: '/settings/secrets',
    });
});

it('lists secrets and apps’ needs without values, and sets a missing one write-only', async () => {
    act(() => root.render(<WorkspaceSecretsSection />));
    await until(() => !!host.querySelector('ul[aria-label="Secrets"]'), 'the list');
    const row = host.querySelector('[data-slot="workspace-secret"]')!;
    expect(row.textContent).toContain('STRIPE_API_KEY');
    expect(row.textContent).toContain('Version 1, set by Ada');
    expect(row.textContent).toContain('last read by Bookings');
    expect(row.textContent).toContain('Bookings');
    const app = host.querySelector('[data-slot="workspace-secret-app"]')!;
    expect(app.textContent).toContain('Needs setup');
    expect(app.textContent).toContain('SLACK_WEBHOOK');

    await act(async () => button('Set a value…')!.click());
    const form = host.querySelector('form[aria-label="Set SLACK_WEBHOOK"]')!;
    const value = form.querySelector('input[type="password"]') as HTMLInputElement;
    expect(value.autocomplete).toBe('new-password');
    type(value, 'https://hooks.invalid/secret-path');
    await act(async () => (form.querySelector('button:not([type="button"])') as HTMLButtonElement).click());
    await until(() => calls.some((call) => call.method === 'POST'), 'the save');
    expect(calls.find((call) => call.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/workspace-secrets',
        body: {
            name: 'SLACK_WEBHOOK',
            description: '',
            value: 'https://hooks.invalid/secret-path',
            scope: 'workload',
            appId: 'bookings',
        },
    });
    await until(() => !host.querySelector('form[aria-label="Set SLACK_WEBHOOK"]'), 'the form to close');
    expect(host.innerHTML).not.toContain('secret-path');

    // Revoking is one explicit action.
    await act(async () => button('Revoke STRIPE_API_KEY from Bookings')!.click());
    await until(() => calls.some((call) => call.method === 'DELETE'), 'the revoke');
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/api/workspace-secrets/s1/grants/bookings');
});

it('lists plugins’ needs apart from apps’, and grants a plugin by its workload key (phase 2)', async () => {
    act(() => root.render(<WorkspaceSecretsSection />));
    await until(() => !!host.querySelector('ul[aria-label="Plugins and the secrets they declare"]'), 'the plugins');
    const plugins = host.querySelector('ul[aria-label="Plugins and the secrets they declare"]')!;
    expect(plugins.textContent).toContain('Social strategy');
    expect(plugins.textContent).toContain('Plugin');
    expect(plugins.textContent).toContain('Needs setup');
    expect(host.querySelector('ul[aria-label="Apps and the secrets they declare"]')!.textContent).not.toContain(
        'Social strategy',
    );
    const grant = [...plugins.querySelectorAll('button')].find((b) => b.textContent?.includes('Grant the workspace'))!;
    await act(async () => grant.click());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the grant');
    expect(calls.find((call) => call.method === 'PUT')?.path).toBe(
        '/api/workspace-secrets/s1/grants/plugin%3Asocial-strategy',
    );
});

it('shows a secret’s history: reads per workload, first reads as their own event, older pages (phase 4)', async () => {
    act(() => root.render(<WorkspaceSecretsSection />));
    await until(() => !!button('History of STRIPE_API_KEY'), 'the history button');
    await act(async () => button('History of STRIPE_API_KEY')!.click());
    await until(() => !!host.querySelector('table[aria-label="Reads of STRIPE_API_KEY"]'), 'the history');
    const reads = host.querySelector('table[aria-label="Reads of STRIPE_API_KEY"]')!;
    expect(reads.textContent).toContain('Bookings');
    expect(reads.textContent).toContain('42');
    const events = () => [...host.querySelectorAll('[data-slot="workspace-secret-event"]')].map((li) => li.textContent);
    expect(events()[0]).toContain('First read by a new workload');
    expect(events()[0]).toContain('first read by Bookings, version 1');
    expect(events()[1]).toContain('Granted');
    // The secret's own flags show in its history.
    expect(host.querySelector('ul[aria-label="Read flags on STRIPE_API_KEY"]')!.textContent).toContain(
        'Reads after a revoke',
    );

    await act(async () => button('Show older')!.click());
    await until(() => events().length === 3, 'the older page');
    expect(calls.map((call) => call.path)).toContain('/api/workspace-secrets/s1/history?before=2');
    expect(events()[2]).toContain('Created');
    expect(button('Show older')).toBeUndefined();
});

it('lists open read flags for admins and dismisses one explicitly (phase 4)', async () => {
    state.flags = [flag];
    act(() => root.render(<WorkspaceSecretsSection />));
    await until(() => !!host.querySelector('ul[aria-label="Read flags"]'), 'the flags');
    const flags = host.querySelector('ul[aria-label="Read flags"]')!;
    expect(flags.textContent).toContain('Reads after a revoke');
    expect(flags.textContent).toContain('Bookings tried to read STRIPE_API_KEY 6 times');
    await act(async () => button('Dismiss the flag on Bookings')!.click());
    await until(() => calls.some((call) => call.method === 'POST'), 'the dismissal');
    expect(calls.find((call) => call.method === 'POST')?.path).toBe('/api/workspace-secrets/flags/f1/dismiss');
});

it('rotates a plugin’s identity through the plugins route, after a confirmation (phase 4)', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    act(() => root.render(<WorkspaceSecretsSection />));
    await until(() => !!button('Rotate Social strategy’s identity'), 'the rotate button');
    // A cancelled confirmation sends nothing.
    await act(async () => button('Rotate Social strategy’s identity')!.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    confirm.mockReturnValue(true);
    await act(async () => button('Rotate Social strategy’s identity')!.click());
    await until(() => calls.some((call) => call.method === 'POST'), 'the rotation');
    expect(calls.find((call) => call.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/plugins/social-strategy/identity',
    });
});

it('shows every plugin service, even one that declares no secrets, so its identity can be rotated', async () => {
    state.apps.push(
        {
            appId: 'plugin:planner',
            kind: 'plugin',
            name: 'Planner',
            status: 'enabled',
            declared: [],
            needsSetup: [],
        },
        {
            appId: 'plugin:paused',
            kind: 'plugin',
            name: 'Paused',
            status: 'disabled',
            declared: [],
            needsSetup: [],
        },
    );
    act(() => root.render(<WorkspaceSecretsSection />));
    await until(() => !!host.querySelector('ul[aria-label="Plugins and the secrets they declare"]'), 'the plugins');
    const plugins = host.querySelector('ul[aria-label="Plugins and the secrets they declare"]')!;
    expect(plugins.textContent).toContain('Planner');
    expect(plugins.textContent).toContain('Declares no secrets.');
    expect(button('Rotate Planner’s identity')).toBeDefined();
    // A disabled plugin has no running service to rotate.
    expect(plugins.textContent).toContain('Paused');
    expect(button('Rotate Paused’s identity')).toBeUndefined();
});

it('lists declared secrets required first, each with its state and one action; replaces a set one (CB-377)', async () => {
    state.apps[0].declared.unshift({
        name: 'OPTIONAL_TOKEN',
        required: false,
        description: 'Long text',
        servedBy: null,
    });
    act(() => root.render(<WorkspaceSecretsSection />));
    await until(() => !!host.querySelector('ul[aria-label="Secrets Bookings declares"]'), 'the rows');
    const rows = [...host.querySelectorAll('ul[aria-label="Secrets Bookings declares"] > li')];
    expect(rows.map((row) => row.querySelector('code')?.textContent)).toEqual([
        'STRIPE_API_KEY',
        'SLACK_WEBHOOK',
        'OPTIONAL_TOKEN',
    ]);
    const state0 = rows[0].querySelector('[data-slot="workspace-secret-state"]')!.textContent;
    expect(state0).toContain('Set');
    expect(state0).toContain('Workspace secret');
    expect(rows[1].querySelector('[data-slot="workspace-secret-state"]')!.textContent).toBe('Not set');
    expect(rows[0].textContent).toContain('Required');
    expect(rows[2].textContent).toContain('Optional');
    expect(host.querySelector('[data-slot="workspace-secret-progress"]')!.textContent).toBe('1 of 2 required set');
    // No value anywhere: only names, states and times.
    expect(host.innerHTML).not.toMatch(/sk_|hooks\.invalid/);

    // "Replace…" on a set one makes a new version of the secret that serves it.
    await act(async () => button('Replace STRIPE_API_KEY')!.click());
    const form = host.querySelector('form[aria-label="Replace STRIPE_API_KEY"]')!;
    type(form.querySelector('input[type="password"]') as HTMLInputElement, 'rotated');
    await act(async () => (form.querySelector('button:not([type="button"])') as HTMLButtonElement).click());
    await until(() => calls.some((call) => call.method === 'POST'), 'the replace');
    expect(calls.find((call) => call.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/workspace-secrets/s1/versions',
        body: { value: 'rotated', overlapMinutes: 60 },
    });
});

it('keeps "Rotate identity" in the plugin’s footer, apart from secret setup (CB-377)', async () => {
    act(() => root.render(<WorkspaceSecretsSection />));
    await until(() => !!button('Rotate Social strategy’s identity'), 'the rotate button');
    const rotate = button('Rotate Social strategy’s identity')!;
    expect(rotate.closest('[data-slot="workspace-secret-identity"]')).not.toBeNull();
    expect(rotate.closest('ul[aria-label="Secrets Social strategy declares"]')).toBeNull();
});
