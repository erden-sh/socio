// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { UpdatesView } from '@socio/shared/updates/updates';

import { UpdatesCard } from '../src/modules/operator/UpdatesCard';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
// Radix's Switch measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

let root: Root;
let host: HTMLElement;
let routes: Record<string, (body?: unknown) => [number, unknown]>;
let calls: { method: string; path: string; body?: unknown }[];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    routes = {};
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });
        const handler = routes[`${method} ${url.pathname}`];
        const [code, reply] = handler ? handler(body) : [404, { error: 'Not found.' }];
        return new Response(JSON.stringify(reply), {
            status: code,
            headers: { 'Content-Type': 'application/json' },
        });
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

async function until(check: () => boolean, what: string, ms = 3000) {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
const text = () => document.body.textContent ?? '';
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;
const click = (element: HTMLElement) => act(() => element.click());

const view = (patch: Partial<UpdatesView> = {}): UpdatesView => ({
    current: { version: '0.21.0', commit: 'abc1234' },
    settings: {
        feed: { kind: 'github', repository: 'acme/socio' },
        checkHours: 24,
        autoApply: false,
        staleDays: 90,
        source: 'environment',
    },
    defaults: {
        feed: { kind: 'github', repository: 'acme/socio' },
        checkHours: 24,
        autoApply: false,
        staleDays: 90,
    },
    token: 'environment',
    check: { running: false, at: Date.parse('2026-10-27T10:00:00Z'), ok: true },
    available: [
        {
            version: '0.23.0',
            tag: 'v0.23.0',
            date: '2026-11-02',
            notesMarkdown: '### Upgrading\n\n- Create the updater token.',
            upgrading: ['Create the updater token.'],
        },
        {
            version: '0.22.0',
            tag: 'v0.22.0',
            date: '2026-10-30',
            notesMarkdown: '### New\n\n- A thing.',
            upgrading: [],
        },
    ],
    updater: {
        configured: true,
        reachable: true,
        status: {
            stack: 'company-brain',
            tagKeys: ['IMAGE_TAG'],
            job: null,
            history: [],
        },
    },
    backups: { running: false, offsite: true },
    ...patch,
});

it('shows newer releases with their steps, and confirms the steps before updating', async () => {
    routes['GET /api/updates'] = () => [200, view()];
    routes['POST /api/updates/apply'] = () => [
        202,
        {
            preparing: {
                target: 'v0.23.0',
                phase: 'backing_up',
                startedAt: 1,
                requestedBy: 'olga',
            },
        },
    ];
    act(() => root.render(<UpdatesCard />));
    await until(() => text().includes('v0.23.0'), 'the releases');
    expect(text()).toContain('This server runs Socio v0.21.0 (abc1234).');
    expect(text()).toContain('1 upgrading step');
    expect(text()).toContain('No upgrading steps');
    expect(text()).toContain('Create the updater token.');
    expect(text()).toContain(
        'The updater changes IMAGE_TAG on stack company-brain, after a backup that includes the off-site copy.',
    );
    // Updating through v0.23.0 lists every release's steps up to it.
    await click(button('Update to v0.23.0'));
    await until(() => !!document.querySelector('[role="dialog"]'), 'the dialog');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('v0.22.0: no upgrading steps');
    expect(dialog.textContent).toContain('v0.23.0: 1 upgrading step');
    const start = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Update to v0.23.0')!;
    expect(start.disabled).toBe(true);
    const box = dialog.querySelector<HTMLElement>('[aria-label="I have read these steps"]')!;
    await click(box);
    expect(start.disabled).toBe(false);
    await click(start);
    await until(
        () => calls.some((call) => call.method === 'POST' && call.path === '/api/updates/apply'),
        'the apply request',
    );
    expect(calls.find((call) => call.path === '/api/updates/apply')!.body).toEqual({
        tag: 'v0.23.0',
        confirmUpgrading: true,
    });
});

it('needs no confirmation for a release without steps, and is notify-only without the updater', async () => {
    routes['GET /api/updates'] = () => [200, view()];
    routes['POST /api/updates/apply'] = () => [
        202,
        {
            preparing: {
                target: 'v0.22.0',
                phase: 'backing_up',
                startedAt: 1,
                requestedBy: 'olga',
            },
        },
    ];
    act(() => root.render(<UpdatesCard />));
    await until(() => !!button('Update to v0.22.0'), 'the button');
    await click(button('Update to v0.22.0'));
    await until(() => !!document.querySelector('[role="dialog"]'), 'the dialog');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[aria-label="I have read these steps"]')).toBeNull();
    const start = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Update to v0.22.0')!;
    await click(start);
    await until(() => calls.some((call) => call.path === '/api/updates/apply'), 'the apply request');
    expect(calls.find((call) => call.path === '/api/updates/apply')!.body).toEqual({
        tag: 'v0.22.0',
    });
    act(() => root.unmount());

    root = createRoot(host);
    routes['GET /api/updates'] = () => [200, view({ updater: { configured: false } })];
    act(() => root.render(<UpdatesCard />));
    await until(() => text().includes('notify-only'), 'the notice');
    expect(button('Update to v0.22.0')).toBeUndefined();
});

it('shows an update in progress and a rollback', async () => {
    const job = {
        id: 'j',
        target: 'v0.22.0',
        from: '0.21.0',
        requestedBy: 'olga',
        startedAt: 1,
        updatedAt: 2,
        backup: {
            database: 'company-brain-20261027-101500.sqlite',
            userdata: 'userdata-20261027-101500',
            offsite: true,
            at: 1,
        },
    };
    routes['GET /api/updates'] = () => [
        200,
        view({
            updater: {
                configured: true,
                reachable: true,
                status: {
                    stack: 'company-brain',
                    tagKeys: ['IMAGE_TAG'],
                    history: [],
                    job: {
                        ...job,
                        phase: 'rolled_back',
                        finishedAt: 3,
                        error: '0.22.0 was not healthy within 900 s (last: HTTP 503).',
                        steps: [{ at: 2, line: 'Stack updated; waiting for the new version.' }],
                    },
                },
            },
        }),
    ];
    act(() => root.render(<UpdatesCard />));
    await until(() => text().includes('Rolled back'), 'the job');
    const panel = document.querySelector('[data-slot="updates-job"]')!;
    expect(panel.getAttribute('data-phase')).toBe('rolled_back');
    expect(panel.textContent).toContain('Last update: v0.21.0 → v0.22.0');
    expect(panel.textContent).toContain('not healthy within 900 s');
});

it('saves the feed settings without echoing the token', async () => {
    routes['GET /api/updates'] = () => [200, view()];
    routes['PUT /api/updates/settings'] = () => [
        200,
        view({
            token: 'settings',
            settings: { ...view().settings, checkHours: 6, source: 'settings' },
        }),
    ];
    act(() => root.render(<UpdatesCard />));
    await until(() => !!document.querySelector('[data-slot="updates-settings"]'), 'the form');
    const form = document.querySelector<HTMLFormElement>('[data-slot="updates-settings"]')!;
    const token = form.querySelector<HTMLInputElement>('input[type="password"]')!;
    const hours = form.querySelector<HTMLInputElement>('input[type="number"]')!;
    const set = (input: HTMLInputElement, value: string) =>
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    await set(token, 'ghp_secretToken0123');
    await set(hours, '6');
    await act(() => form.requestSubmit());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the save');
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
        feed: { kind: 'github', repository: 'acme/socio' },
        checkHours: 6,
        autoApply: false,
        staleDays: 90,
        token: 'ghp_secretToken0123',
    });
    await until(() => text().includes('A read token is saved'), 'the saved token');
    expect(token.value).toBe('');
});

it('warns when this server is stale, marks security releases, and saves the window (CB-323)', async () => {
    const security = view({
        available: [
            { ...view().available[1]!, notesMarkdown: 'A fix (security).\n\n### Fixed\n\n- A fix.', security: true },
        ],
        stale: { reason: 'security', newest: 'v0.22.0', behindDays: 3, staleDays: 90, security: ['v0.22.0'] },
    });
    routes['GET /api/updates'] = () => [200, security];
    routes['PUT /api/updates/settings'] = () => [200, view({ settings: { ...view().settings, staleDays: 30 } })];
    act(() => root.render(<UpdatesCard />));
    await until(() => !!document.querySelector('[data-slot="updates-stale"]'), 'the warning');
    const warning = document.querySelector<HTMLElement>('[data-slot="updates-stale"]')!;
    expect(warning.dataset.reason).toBe('security');
    expect(warning.textContent).toContain('v0.22.0 fixes a security issue: update soon.');
    expect(warning.textContent).toContain('Security releases warn right away.');
    const row = document.querySelector('[data-slot="update-release"][data-tag="v0.22.0"]')!;
    expect(row.textContent).toContain('Security');

    // The window, where the other update settings are.
    const form = document.querySelector<HTMLFormElement>('[data-slot="updates-settings"]')!;
    const days = form.querySelectorAll<HTMLInputElement>('input[type="number"]')[1]!;
    expect(days.value).toBe('90');
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(days, '30');
        days.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => form.requestSubmit());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the save');
    expect(calls.find((call) => call.method === 'PUT')!.body).toMatchObject({ staleDays: 30 });
});

it('says how far behind an old server is, and shows nothing when it is not stale', async () => {
    routes['GET /api/updates'] = () => [
        200,
        view({ stale: { reason: 'age', newest: 'v0.23.0', behindDays: 120, staleDays: 90, security: [] } }),
    ];
    act(() => root.render(<UpdatesCard />));
    await until(() => !!document.querySelector('[data-slot="updates-stale"]'), 'the warning');
    const warning = document.querySelector<HTMLElement>('[data-slot="updates-stale"]')!;
    expect(warning.textContent).toContain('This server is 120 days behind v0.23.0.');
    expect(warning.textContent).toContain(
        'v0.21.0 came out 120 days before v0.23.0, past the 90-day window set below.',
    );
    act(() => root.unmount());
    root = createRoot(host);
    routes['GET /api/updates'] = () => [200, view()];
    act(() => root.render(<UpdatesCard />));
    await until(() => !!document.querySelector('[data-slot="updates-current"]'), 'the card');
    expect(document.querySelector('[data-slot="updates-stale"]')).toBeNull();
});
