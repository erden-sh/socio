// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PluginUpdateReview } from '@socio/shared/plugins/plugin-update';
import type { State, User, WorkspaceState } from '@socio/shared/types';

import type { InstalledRow, PluginBackups, PluginList } from '../src/modules/plugins/plugin-rows';
import PluginManageRoute from '../src/modules/plugins/PluginManage.route';
import { PluginsPage } from '../src/modules/plugins/PluginsPage';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Radix selects measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const admin: User = { id: 'u-ada', name: 'Ada Admin', role: 'admin' };

const planner = (patch: Partial<InstalledRow> = {}): InstalledRow => ({
    id: 'events',
    name: 'Events',
    description: 'Event docs and invoices.',
    author: 'Example Co',
    version: '1.2.0',
    permissions: [],
    icon: '',
    enabled: true,
    display: 'embed',
    replicas: 2,
    running: 2,
    state: 'running',
    origin: 'https://events.apps.example',
    mode: 'service',
    audience: 'admins',
    config: { EDGE_URL: 'https://edge.example' },
    configFields: {
        EDGE_URL: { description: 'Where the edge listens.' },
        EDGE_ENABLED: { description: 'Turns the edge link on.', default: 'false' },
    },
    ...patch,
});

const TYPED: InstalledRow['configFields'] = {
    SYNC: { description: 'Sync on.', type: 'boolean', default: 'false' },
    LIMIT: { description: 'Rows.', type: 'integer', min: 1, max: 100, required: true },
    MODE: { description: 'How.', type: 'enum', options: ['pit', 'oauth'] },
    WHEN: { description: 'When.', type: 'cron' },
    EDGE: { description: 'Edge.', type: 'url' },
    NOTE: { description: 'Free text.' },
};

let host: HTMLDivElement;
let root: Root;
let list: PluginList;
let requests: { path: string; method: string; body?: unknown }[];
let refreshes: number;
/** Set: the next settings save fails with this message. */
let refuseSave: string | undefined;
/** Set: settings saves wait for it before they answer. */
let holdSaves: Promise<void> | undefined;
/** What a service plugin's save answers as the server's wait before it applies (CB-398 follow-up). */
let applyInMs: number;
/** Set: what a settings save answers as the hosts its settings allow (CB-441). */
let saveEgress: InstalledRow['egress'];
/** Set: applies wait for it before they answer. */
let holdApplies: Promise<void> | undefined;
/** Set: the next apply fails with this message. */
let refuseApply: string | undefined;
/** What `/api/plugins/events/backups` answers (CB-458 step 5). */
let backups: PluginBackups | undefined;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    refreshes = 0;
    refuseSave = undefined;
    holdSaves = undefined;
    holdApplies = undefined;
    refuseApply = undefined;
    applyInMs = 60_000;
    saveEgress = undefined;
    backups = undefined;
    list = {
        catalog: [],
        installed: [
            planner(),
            planner({ id: 'calendar', name: 'Calendar', mode: 'bundled', configFields: {} }),
            planner({ id: 'typed', name: 'Typed', config: { NOTE: 'hello' }, configFields: TYPED }),
        ],
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        requests.push({
            path: url.pathname,
            method,
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const reply = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (url.pathname === '/api/plugins' && method === 'GET') {
            return reply(list);
        }
        if (url.pathname === '/api/plugins/events/backups' && method === 'GET' && backups) {
            return reply(backups);
        }
        if (url.pathname === '/api/plugins/events/backup' && method === 'POST' && backups) {
            backups = { ...backups, backup: { ...backups.backup, running: true } };
            return reply({ coalesced: false, backup: backups.backup }, 202);
        }
        if (url.pathname === '/api/plugins/events' && method === 'DELETE') {
            list = { ...list, installed: list.installed.filter((row) => row.id !== 'events') };
            return reply({ ok: true, dataKept: true });
        }
        if (url.pathname.endsWith('/config') && method === 'PUT' && holdSaves) {
            await holdSaves;
        }
        if (url.pathname.endsWith('/config') && method === 'PUT' && refuseSave) {
            const error = refuseSave;
            refuseSave = undefined;
            return reply({ error }, 400);
        }
        if (url.pathname.endsWith('/config') && method === 'PUT' && !url.pathname.includes('/calendar/')) {
            return reply({ ok: true, applyInMs, ...(saveEgress ? { egress: saveEgress } : {}) });
        }
        if (url.pathname.endsWith('/apply') && method === 'POST') {
            await holdApplies;
            if (refuseApply) {
                const error = refuseApply;
                refuseApply = undefined;
                return reply({ error }, 503);
            }
            return reply({ ok: true, applied: true });
        }
        return reply({ ok: true });
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

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}

function shell(): Shell {
    return {
        state: { settings: { name: 'Socio' } } as unknown as State,
        workspace: { user: admin, spaces: [], dots: [], conversations: [], calls: [] } as unknown as WorkspaceState,
        admin: true,
        configured: true,
        refresh: async () => {
            refreshes += 1;
        },
    } as unknown as Shell;
}

function open(entry: string) {
    const router = createMemoryRouter(
        [
            { path: '/plugins', Component: PluginsPage },
            { path: '/settings/plugins/:pluginId', Component: PluginManageRoute },
        ],
        { initialEntries: [entry] },
    );
    act(() =>
        root.render(
            <ShellContext.Provider value={shell()}>
                <RouterProvider router={router} />
            </ShellContext.Provider>,
        ),
    );
    return router;
}

const slot = (name: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const button = (label: string, scope: ParentNode = document) =>
    [...scope.querySelectorAll('button')].find((b) => b.textContent === label || b.ariaLabel === label);
const type = (input: HTMLInputElement, value: string) =>
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });

it('lists installed plugins as an overview that links to each plugin’s own page (CB-393)', async () => {
    const router = open('/plugins?tab=installed');
    await until(() => !!slot('plugin-installed'), 'the overview');
    const rows = [...document.querySelectorAll('[data-slot="plugin-row"]')];
    expect(rows.map((row) => row.querySelector('[data-slot="plugin-manage-link"]')?.getAttribute('href'))).toEqual([
        '/settings/plugins/events',
        '/settings/plugins/calendar',
        '/settings/plugins/typed',
    ]);
    // No settings, Scale or Uninstall on the overview.
    expect(slot('plugin-settings')).toBeNull();
    expect(button('Uninstall')).toBeUndefined();
    expect(document.body.textContent).not.toMatch(/Scale|replicas for/i);

    act(() => (rows[0]!.querySelector('[data-slot="plugin-manage-link"]') as HTMLAnchorElement).click());
    await until(() => !!slot('plugin-overview'), 'the plugin page');
    expect(router.state.location.pathname).toBe('/settings/plugins/events');
    expect(slot('plugin-page')?.querySelector('h1')?.textContent).toBe('Events');
});

it('opens a plugin’s page from its path, with settings and no replica control (CB-393, CB-394, CB-396)', async () => {
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const settings = slot('plugin-settings')!;
    const labels = [...settings.querySelectorAll('label')].map((label) => label.textContent);
    expect(labels).toEqual(['EDGE_URL', 'EDGE_ENABLED']);
    // Each field is labelled and described.
    const edge = settings.querySelector<HTMLInputElement>('input')!;
    expect(edge.value).toBe('https://edge.example');
    expect(document.getElementById(edge.getAttribute('aria-describedby')!)?.textContent).toContain(
        'Where the edge listens.',
    );
    expect(document.body.textContent).toContain('Default: false');
    expect(document.body.textContent).not.toMatch(/Scale|Fewer replicas|More replicas/);
    expect(document.querySelector('input[name="replicas"]')).toBeNull();
    // Settings, its datasets (CB-451), then the danger zone, and Uninstall only there.
    const regions = [...document.querySelectorAll('[role="region"]')].map((region) => region.getAttribute('data-slot'));
    expect(regions).toEqual([
        'plugin-overview',
        'plugin-access',
        'plugin-settings-card',
        'plugin-datasets-card',
        'plugin-danger-zone',
    ]);
    expect(button('Uninstall…', slot('plugin-settings-card')!)).toBeUndefined();
    expect(button('Uninstall…', slot('plugin-danger-zone')!)).toBeDefined();

    // Saved as it changes: leaving the field saves it at once.
    type(edge, '  https://edge.lab  ');
    act(() => edge.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await until(() => requests.some((r) => r.method === 'PUT'), 'the save');
    expect(requests.find((r) => r.method === 'PUT')).toEqual({
        path: '/api/plugins/events/config',
        method: 'PUT',
        body: { config: { EDGE_URL: 'https://edge.lab' } },
    });
});

it('says so for a plugin that is not installed', async () => {
    open('/settings/plugins/nope');
    await until(() => !!slot('plugin-missing'), 'the missing note');
    expect(slot('plugin-page')?.querySelector('h1')?.textContent).toBe('Plugin not installed');
    expect(slot('plugin-back')?.getAttribute('href')).toBe('/plugins?tab=installed');
});

it('uninstalls only after the plugin’s name is typed exactly, then goes back to the overview (CB-397)', async () => {
    const router = open('/settings/plugins/events');
    await until(() => !!slot('plugin-danger-zone'), 'the danger zone');
    const zone = slot('plugin-danger-zone')!;
    expect(button('Uninstall…', zone)!.className).toContain('destructive');
    act(() => button('Uninstall…', zone)!.click());
    await until(() => !!slot('plugin-uninstall'), 'the dialog');
    const dialog = slot('plugin-uninstall')!;
    const confirm = button('Uninstall', dialog)!;
    expect(confirm.disabled).toBe(true);
    const field = dialog.querySelector<HTMLInputElement>('input[aria-label="Plugin name"]')!;
    type(field, 'lab events');
    expect(confirm.disabled).toBe(true);
    expect(slot('uninstall-name-mismatch', dialog)).not.toBeNull();
    // Enter with the wrong name does nothing.
    act(() => field.form!.requestSubmit());
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);

    type(field, 'Events');
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    await until(() => router.state.location.pathname === '/plugins', 'the overview');
    expect(router.state.location.search).toBe('?tab=installed');
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([{ path: '/api/plugins/events', method: 'DELETE' }]);
    expect(refreshes).toBe(1);
});

it('keeps the plugin when the dialog is closed without confirming', async () => {
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-danger-zone'), 'the danger zone');
    act(() => button('Uninstall…')!.click());
    await until(() => !!slot('plugin-uninstall'), 'the dialog');
    act(() => button('Keep it', slot('plugin-uninstall')!)!.click());
    await until(() => !slot('plugin-uninstall'), 'the dialog to close');
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
});

const puts = () => requests.filter((r) => r.method === 'PUT').map((r) => (r.body as { config: unknown }).config);
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const status = () => slot('save-status')?.dataset.status;
const key = (init: KeyboardEventInit, target: EventTarget = document.body) =>
    act(() => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
const setting = (key: string) =>
    document.querySelector<HTMLElement>(`[data-slot="plugin-setting"][data-key="${key}"]`)!;
const blur = (element: HTMLElement) => act(() => element.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
const choose = (select: HTMLSelectElement, value: string) =>
    act(() => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });

it('renders each setting by its type and checks it before saving (CB-395)', async () => {
    open('/settings/plugins/typed');
    await until(() => !!slot('plugin-settings'), 'the settings');
    expect(
        [...document.querySelectorAll<HTMLElement>('[data-slot="plugin-setting"]')].map((el) => el.dataset.type),
    ).toEqual(['boolean', 'integer', 'enum', 'cron', 'url', 'string']);
    const sync = setting('SYNC').querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sync.getAttribute('aria-checked')).toBe('false');
    const limit = setting('LIMIT').querySelector('input')!;
    // Text with a numeric keyboard: half-typed input stays as typed, for the check.
    expect(limit.type).toBe('text');
    expect(limit.inputMode).toBe('numeric');
    expect(limit.getAttribute('aria-required')).toBe('true');
    expect(setting('LIMIT').textContent).toContain('Required.');
    const mode = setting('MODE').querySelector('select')!;
    expect([...mode.options].map((option) => option.value)).toEqual(['', 'pit', 'oauth']);
    const when = setting('WHEN').querySelector('input')!;
    const edge = setting('EDGE').querySelector('input')!;

    // An unset required setting says so as the page opens.
    expect(setting('LIMIT').textContent).toContain('This setting is required.');
    // Errors show once a field is left.
    type(limit, '1e');
    blur(limit);
    expect(setting('LIMIT').textContent).toContain('Enter a whole number.');
    type(limit, '0');
    blur(limit);
    expect(setting('LIMIT').querySelector('[data-slot="plugin-setting-error"]')?.textContent).toBe(
        'Use a number from 1 to 100.',
    );
    expect(limit.getAttribute('aria-invalid')).toBe('true');
    type(when, 'nightly');
    blur(when);
    expect(setting('WHEN').textContent).toMatch(/Enter a cron expression/);
    type(edge, 'edge.example');
    blur(edge);
    expect(setting('EDGE').textContent).toMatch(/http or https/);

    // Nothing invalid was sent; an empty required one shows its error too.
    type(limit, '');
    blur(limit);
    expect(setting('LIMIT').textContent).toContain('This setting is required.');
    await settled();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);

    // Each valid change saves; the invalid ones keep their saved value.
    act(() => sync.click());
    expect(sync.getAttribute('aria-checked')).toBe('true');
    await until(() => puts().length === 1, 'the switch’s save');
    expect(puts()[0]).toEqual({ NOTE: 'hello', SYNC: 'true' });
    type(limit, '25');
    type(when, '0 9 * * 1-5');
    type(edge, 'https://edge.example');
    blur(edge);
    await until(() => puts().length === 2, 'the typed save');
    choose(mode, 'oauth');
    await until(() => puts().length === 3, 'the list’s save');
    expect(document.querySelectorAll('[data-slot="plugin-setting-error"]')).toHaveLength(0);
    expect(puts()[2]).toEqual({
        NOTE: 'hello',
        SYNC: 'true',
        LIMIT: '25',
        WHEN: '0 9 * * 1-5',
        EDGE: 'https://edge.example',
        MODE: 'oauth',
    });
});

it('shows a saved value that no longer fits its type, with its error, at once (CB-395 review)', async () => {
    list = {
        catalog: [],
        installed: [
            planner({
                id: 'typed',
                name: 'Typed',
                config: { MODE: 'basic', LIMIT: '5' },
                configFields: TYPED,
            }),
        ],
    };
    open('/settings/plugins/typed');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const mode = setting('MODE').querySelector('select')!;
    expect(mode.value).toBe('basic');
    expect(mode.selectedOptions[0]?.textContent).toBe('basic (not a choice)');
    expect(setting('MODE').querySelector('[data-slot="plugin-setting-error"]')?.textContent).toBe(
        'Choose one of: pit, oauth.',
    );
    expect(setting('LIMIT').querySelector('[data-slot="plugin-setting-error"]')).toBeNull();
    choose(mode, 'pit');
    await until(() => puts().length === 1, 'the save');
    expect(puts()[0]).toEqual({ MODE: 'pit', LIMIT: '5' });
});

it('saves typing once it rests, says Saved, and shows a refused save’s reason (CB-398)', async () => {
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-settings'), 'the settings');
    expect(button('Save settings')).toBeUndefined();
    const edge = setting('EDGE_URL').querySelector('input')!;
    type(edge, 'https://edge.one');
    type(edge, 'https://edge.two');
    await settled();
    expect(puts()).toEqual([]);
    // One save for the burst, after the pause.
    await until(() => puts().length === 1, 'the debounced save');
    expect(puts()).toEqual([{ EDGE_URL: 'https://edge.two' }]);
    await until(() => status() === 'saved', 'Saved');
    expect(slot('save-status')!.textContent).toBe('Saved');

    refuseSave = 'EDGE_URL: Enter a full http or https address.';
    type(edge, 'https://edge.three');
    blur(edge);
    await until(() => !!host.querySelector('[role="alert"]'), 'the error');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('EDGE_URL: Enter a full http or https address.');
    expect(status()).toBe('idle');
});

it('undoes and redoes this page’s saves with buttons and the keyboard (CB-398)', async () => {
    open('/settings/plugins/typed');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const undo = button('Undo')!;
    const redo = button('Redo')!;
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
    const sync = setting('SYNC').querySelector<HTMLButtonElement>('[role="switch"]')!;
    const note = setting('NOTE').querySelector('input')!;
    act(() => sync.click());
    await until(() => puts().length === 1, 'the first save');
    type(note, 'second');
    blur(note);
    await until(() => puts().length === 2, 'the second save');
    expect(undo.disabled).toBe(false);

    // Undo saves the step before, and shows it.
    act(() => undo.click());
    await until(() => puts().length === 3, 'the undo');
    expect(puts()[2]).toEqual({ NOTE: 'hello', SYNC: 'true' });
    expect(note.value).toBe('hello');
    expect(redo.disabled).toBe(false);
    // Ctrl+Z, then Ctrl+Shift+Z and Ctrl+Y (⌘ works as Ctrl).
    key({ key: 'z', ctrlKey: true });
    await until(() => puts().length === 4, 'Ctrl+Z');
    expect(puts()[3]).toEqual({ NOTE: 'hello' });
    expect(sync.getAttribute('aria-checked')).toBe('false');
    expect(undo.disabled).toBe(true);
    key({ key: 'Z', metaKey: true, shiftKey: true });
    await until(() => puts().length === 5, '⌘⇧Z');
    expect(puts()[4]).toEqual({ NOTE: 'hello', SYNC: 'true' });
    key({ key: 'y', ctrlKey: true }, note);
    await until(() => puts().length === 6, 'Ctrl+Y in a field');
    expect(puts()[5]).toEqual({ NOTE: 'second', SYNC: 'true' });
    expect(note.value).toBe('second');
    expect(redo.disabled).toBe(true);

    // A new change after an undo drops the steps ahead of it.
    act(() => undo.click());
    await until(() => puts().length === 7, 'the undo');
    act(() => sync.click());
    await until(() => puts().length === 8, 'the new change');
    expect(puts()[7]).toEqual({ NOTE: 'hello', SYNC: 'false' });
    expect(redo.disabled).toBe(true);

    // Typing that hasn't saved yet is saved, then undone.
    type(note, 'pending');
    key({ key: 'z', ctrlKey: true }, note);
    await until(() => puts().length === 10, 'the flush and the undo');
    expect(puts()[8]).toEqual({ NOTE: 'pending', SYNC: 'false' });
    expect(puts()[9]).toEqual({ NOTE: 'hello', SYNC: 'false' });
    expect(note.value).toBe('hello');
});

it('leaves undo alone with nothing to undo, and puts a failed undo back (CB-398)', async () => {
    open('/settings/plugins/typed');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => document.body.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    const sync = setting('SYNC').querySelector<HTMLButtonElement>('[role="switch"]')!;
    act(() => sync.click());
    await until(() => puts().length === 1, 'the save');
    refuseSave = 'Could not reach the runtime.';
    act(() => button('Undo')!.click());
    await until(() => !!host.querySelector('[role="alert"]'), 'the error');
    // Still where it was: the switch on, Undo still offered.
    expect(sync.getAttribute('aria-checked')).toBe('true');
    expect(button('Undo')!.disabled).toBe(false);
    act(() => button('Undo')!.click());
    await until(() => puts().length === 3, 'the retry');
    expect(sync.getAttribute('aria-checked')).toBe('false');
});

/** Releases for held saves, so a failed test leaves no plugin's queue stuck. */
const holds: (() => void)[] = [];
afterEach(() => holds.splice(0).forEach((release) => release()));

function held() {
    let release = () => {};
    holdSaves = new Promise<void>((resolve) => {
        release = () => {
            holdSaves = undefined;
            resolve();
        };
    });
    holds.push(release);
    return release;
}

it('holds the fields while an undo is on its way, so nothing typed is lost (CB-398 review)', async () => {
    open('/settings/plugins/typed');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const note = setting('NOTE').querySelector('input')!;
    type(note, 'first');
    blur(note);
    await until(() => puts().length === 1, 'the save');
    const release = held();
    act(() => button('Undo')!.click());
    await until(() => puts().length === 2, 'the undo request');
    expect(note.disabled).toBe(true);
    release();
    await until(() => !note.disabled, 'the fields back');
    expect(note.value).toBe('hello');
    type(note, 'after');
    blur(note);
    await until(() => puts().length === 3, 'the next save');
    expect(puts()[2]).toEqual({ NOTE: 'after' });
});

it('keeps a plugin’s saves in order across leaving and reopening its page (CB-398 review)', async () => {
    const router = open('/settings/plugins/typed');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const release = held();
    let note = setting('NOTE').querySelector('input')!;
    type(note, 'a');
    blur(note);
    await until(() => puts().length === 1, 'the first save on its way');
    type(note, 'b');
    // Leaving with "b" still being typed saves it, behind "a".
    await act(async () => {
        await router.navigate('/plugins');
    });
    await act(async () => {
        await router.navigate('/settings/plugins/typed');
    });
    await settled();
    // Only "a" has reached the server; "b" waits behind it, and the page
    // waits for both before it opens.
    expect(puts()).toEqual([{ NOTE: 'a' }]);
    expect(slot('plugin-settings')).toBeNull();
    release();
    await until(() => !!slot('plugin-settings'), 'the settings again');
    expect(puts()).toEqual([{ NOTE: 'a' }, { NOTE: 'b' }]);
    note = setting('NOTE').querySelector('input')!;
    type(note, 'c');
    blur(note);
    await until(() => puts().length === 3, 'the last save');
    expect(puts()[2]).toEqual({ NOTE: 'c' });
});

it('opens a plugin’s page again only after its saves on their way land (CB-398 review)', async () => {
    // The server keeps what it is sent, as the real one does.
    const typed = list.installed.find((row) => row.id === 'typed')!;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const answer = await original(input, init);
        if (String(input).endsWith('/typed/config') && init?.method === 'PUT' && answer.ok) {
            typed.config = (JSON.parse(String(init.body)) as { config: Record<string, string> }).config;
        }
        return answer;
    });
    const router = open('/settings/plugins/typed');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const release = held();
    const note = setting('NOTE').querySelector('input')!;
    type(note, 'first page');
    blur(note);
    await until(() => puts().length === 1, 'the save on its way');
    await act(async () => {
        await router.navigate('/plugins');
    });
    await act(async () => {
        await router.navigate('/settings/plugins/typed');
    });
    await settled();
    // Still loading: it waits for the save.
    expect(slot('plugin-settings')).toBeNull();
    release();
    await until(() => !!slot('plugin-settings'), 'the settings again');
    expect(setting('NOTE').querySelector('input')!.value).toBe('first page');
    act(() => setting('SYNC').querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await until(() => puts().length === 2, 'the toggle');
    expect(puts()[1]).toEqual({ NOTE: 'first page', SYNC: 'true' });
});

const applies = () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/apply')).map((r) => r.path);
const applyStatus = () => slot('apply-status')?.dataset.status;

it('says saved settings reach the plugin in a few seconds, and applies them once after the saves settle (CB-398 follow-up)', async () => {
    applyInMs = 150;
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const edge = setting('EDGE_URL').querySelector('input')!;
    for (const value of ['https://a.example', 'https://b.example', 'https://c.example']) {
        type(edge, value);
        blur(edge);
        await until(
            () => (puts().at(-1) as { EDGE_URL?: string } | undefined)?.EDGE_URL === value,
            `the save of ${value}`,
        );
    }
    await until(() => applyStatus() === 'pending', 'the wait');
    expect(slot('apply-status')!.textContent).toContain('in a few seconds');
    expect(applies()).toEqual([]);
    await until(() => applyStatus() === 'applied', 'Applied');
    expect(applies()).toEqual(['/api/plugins/events/apply']);
    expect(slot('apply-status')!.textContent).toBe('Applied.');
});

it('applies saved settings at once with Apply now, or as the page is left (CB-398 follow-up)', async () => {
    const router = open('/settings/plugins/events');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const edge = setting('EDGE_URL').querySelector('input')!;
    type(edge, 'https://now.example');
    blur(edge);
    await until(() => applyStatus() === 'pending', 'the wait');
    let release = () => {};
    holdApplies = new Promise<void>((resolve) => (release = resolve));
    act(() => button('Apply now')!.click());
    await until(() => applyStatus() === 'applying', 'Applying');
    release();
    await until(() => applyStatus() === 'applied', 'Applied');
    expect(applies()).toEqual(['/api/plugins/events/apply']);

    // Typing, then leaving at once: the save lands, then the apply.
    holdApplies = undefined;
    type(edge, 'https://left.example');
    await act(async () => {
        await router.navigate('/plugins');
    });
    await until(() => applies().length === 2, 'the apply on leaving');
    const order = requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
    expect(order.slice(-2)).toEqual(['PUT /api/plugins/events/config', 'POST /api/plugins/events/apply']);
    expect(puts().at(-1)).toEqual({ EDGE_URL: 'https://left.example' });
});

it('applies nothing for a plugin that runs inside Socio (CB-398 follow-up)', async () => {
    list.installed[1] = {
        ...list.installed[1]!,
        configFields: { WEEK: { description: 'Week start.' } },
    };
    const router = open('/settings/plugins/calendar');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const week = setting('WEEK').querySelector('input')!;
    type(week, 'monday');
    blur(week);
    await until(() => status() === 'saved', 'Saved');
    expect(slot('apply-status')).toBeNull();
    await act(async () => {
        await router.navigate('/plugins');
    });
    await settled();
    expect(applies()).toEqual([]);
});

it('shows why an apply failed until a retry applies them (CB-398 follow-up review)', async () => {
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-settings'), 'the settings');
    const edge = setting('EDGE_URL').querySelector('input')!;
    type(edge, 'https://retry.example');
    blur(edge);
    await until(() => applyStatus() === 'pending', 'the wait');
    refuseApply = 'The workspace app runtime is not answering.';
    act(() => button('Apply now')!.click());
    await until(() => applyStatus() === 'failed', 'the failure');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('The workspace app runtime is not answering.');
    act(() => button('Apply now')!.click());
    await until(() => applyStatus() === 'applied', 'Applied');
    expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('shows the hosts a service plugin may reach, a url setting’s included, and follows a save (CB-441)', async () => {
    list.installed.push(
        planner({
            id: 'forms',
            name: 'Forms',
            config: {},
            configFields: { WORKER_URL: { description: 'The Worker.', type: 'url' } },
            egress: {
                hosts: ['api.example.com'],
                settings: [{ field: 'WORKER_URL', problem: 'it is empty' }],
            },
        }),
    );
    open('/settings/plugins/forms');
    await until(() => !!slot('plugin-egress'), 'the outbound network section');
    const regions = [...document.querySelectorAll('[role="region"]')].map((region) => region.getAttribute('data-slot'));
    expect(regions).toEqual([
        'plugin-overview',
        'plugin-access',
        'plugin-settings-card',
        'plugin-egress',
        'plugin-datasets-card',
        'plugin-danger-zone',
    ]);
    const hosts = () => [...slot('plugin-egress-hosts')!.querySelectorAll('li')].map((li) => li.textContent);
    expect(hosts()).toEqual(['api.example.com']);
    expect(slot('plugin-egress-problem')?.textContent).toBe(
        'No host added from WORKER_URL: it is empty. Set it to an https address to allow its host.',
    );

    saveEgress = {
        hosts: ['api.example.com', 'forms.acme.workers.dev'],
        settings: [{ field: 'WORKER_URL', host: 'forms.acme.workers.dev' }],
    };
    const input = setting('WORKER_URL').querySelector('input')!;
    type(input, 'https://forms.acme.workers.dev');
    blur(input);
    await until(() => hosts().length === 2, 'the resolved host');
    expect(hosts()).toEqual(['api.example.com', 'forms.acme.workers.devfrom the setting WORKER_URL']);
    expect(slot('plugin-egress-problem')).toBeNull();
    // Saved, not applied yet: the page says the running service keeps what it had.
    expect(slot('plugin-egress-pending')?.textContent).toMatch(/Until they apply, the running service keeps/);
    // Applied: the note goes.
    act(() => button('Apply now')!.click());
    await until(() => !slot('plugin-egress-pending'), 'the applied settings');
});

it('says clearing the last host takes effect only once the settings apply, and keeps saying so when the apply fails (CB-441 review)', async () => {
    list.installed.push(
        planner({
            id: 'forms',
            name: 'Forms',
            config: { WORKER_URL: 'https://forms.acme.workers.dev' },
            configFields: { WORKER_URL: { description: 'The Worker.', type: 'url' } },
            egress: {
                hosts: ['forms.acme.workers.dev'],
                settings: [{ field: 'WORKER_URL', host: 'forms.acme.workers.dev' }],
            },
        }),
    );
    open('/settings/plugins/forms');
    await until(() => !!slot('plugin-egress'), 'the outbound network section');
    expect(slot('plugin-egress-pending')).toBeNull();

    saveEgress = { hosts: [], settings: [{ field: 'WORKER_URL', problem: 'it is empty' }] };
    const input = setting('WORKER_URL').querySelector('input')!;
    type(input, '');
    blur(input);
    await until(() => !slot('plugin-egress-hosts'), 'the cleared host');
    const section = slot('plugin-egress')!;
    expect(section.textContent).toContain('Its settings allow its service nothing outside Socio, once they apply.');
    expect(section.textContent).not.toMatch(/can’t reach anything/);
    expect(slot('plugin-egress-pending')).not.toBeNull();

    // A failed apply leaves the running service as it was, and the note stays.
    refuseApply = 'The workspace app runtime is unavailable right now.';
    act(() => button('Apply now')!.click());
    await until(() => !!host.querySelector('[role="alert"]'), 'the apply error');
    expect(slot('plugin-egress-pending')).not.toBeNull();
});

it('shows no outbound network section for a plugin that runs inside Socio (CB-441)', async () => {
    open('/settings/plugins/calendar');
    await until(() => !!slot('plugin-overview'), 'the plugin page');
    expect(slot('plugin-egress')).toBeNull();
});

it('shows bridge.openAnyHttps as a sensitive scope at install and on the plugin’s page', async () => {
    list = {
        catalog: [
            {
                id: 'events',
                name: 'Events',
                version: '1.2.0',
                author: 'Example Co',
                description: 'Event docs and invoices.',
                display: 'embed',
                mode: 'service',
                audience: 'admins',
                permissions: [],
                openAnyHttps: true,
                icon: '',
                installed: false,
            },
            {
                id: 'quiet',
                name: 'Quiet',
                version: '1.0.0',
                author: 'Example Co',
                description: 'Opens nothing.',
                display: 'embed',
                mode: 'service',
                audience: 'admins',
                permissions: [],
                icon: '',
                installed: false,
            },
        ],
        installed: [planner({ openAnyHttps: true })],
    };
    open('/plugins?app=events');
    await until(() => !!slot('plugin-sensitive-scope'), 'the sensitive scope');
    const scope = slot('plugin-sensitive-scope')!;
    expect(scope.textContent).toContain('Sensitive scope');
    expect(scope.textContent).toContain('bridge.openAnyHttps');
    expect(scope.textContent).toContain('Open any https link in a new tab, after you confirm each one.');
    expect(document.body.textContent).not.toContain('Asks for no extra permissions.');
    act(() => root.unmount());
    root = createRoot(host);

    // A plugin without it shows no warning.
    open('/plugins?app=quiet');
    await until(() => document.body.textContent!.includes('Asks for no extra permissions.'), 'the permissions');
    expect(slot('plugin-sensitive-scope')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);

    open('/settings/plugins/events');
    await until(() => !!slot('plugin-overview'), 'the plugin page');
    expect(slot('plugin-sensitive-scope', slot('plugin-overview')!)?.textContent).toContain('Sensitive scope');
});

it('warns before install about a plugin’s own storage, and flags an installed one that isn’t backed up (CB-458)', async () => {
    const entry = (id: string, storageWarnings?: NonNullable<PluginList['catalog'][number]['storageWarnings']>) => ({
        id,
        name: id,
        version: '1.0.0',
        author: 'Example Co',
        description: 'Keeps notes.',
        display: 'embed' as const,
        mode: 'service' as const,
        audience: 'admins' as const,
        permissions: [],
        icon: '',
        installed: false,
        ...(storageWarnings ? { storageWarnings } : {}),
    });
    list = {
        catalog: [
            entry('notes', [
                { kind: 'not_backed_up', message: 'Not backed up: this release is the last that installs it' },
                {
                    kind: 'private_storage',
                    message: 'Keeps data in private storage; plugins should use workspace datasets and files',
                },
            ]),
            entry('plain'),
        ],
        installed: [
            planner({ backup: { state: 'not_backed_up', declared: false, volumes: ['data'] } }),
            planner({ id: 'kept', name: 'Kept', backup: { state: 'not_backed_up', declared: true, volumes: ['db'] } }),
            planner({ id: 'typed', name: 'Typed' }),
        ],
    };
    open('/plugins?app=notes');
    await until(() => !!slot('plugin-storage-warnings'), 'the storage warnings');
    const warnings = [...slot('plugin-storage-warnings')!.querySelectorAll('[data-warning]')];
    expect(warnings.map((item) => item.getAttribute('data-warning'))).toEqual(['not_backed_up', 'private_storage']);
    expect(warnings[0]!.textContent).toContain('Not backed up: this release is the last that installs it.');
    expect(warnings[1]!.textContent).toContain('plugins should use workspace datasets and files.');
    act(() => root.unmount());
    root = createRoot(host);

    open('/plugins?app=plain');
    await until(() => document.body.textContent!.includes('Asks for no extra permissions.'), 'the permissions');
    expect(slot('plugin-storage-warnings')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);

    open('/plugins?tab=installed');
    await until(() => !!slot('plugin-installed'), 'the overview');
    const rows = [...document.querySelectorAll('[data-slot="plugin-row"]')];
    expect(rows.map((row) => row.querySelector('[data-slot="plugin-not-backed-up"]')?.textContent ?? null)).toEqual([
        'Not backed up',
        'Not backed up',
        null,
    ]);
    act(() => root.unmount());
    root = createRoot(host);

    open('/settings/plugins/events');
    await until(() => !!slot('plugin-overview'), 'the plugin page');
    const overview = slot('plugin-overview')!;
    expect(slot('plugin-not-backed-up', overview)?.textContent).toBe('Not backed up');
    expect(slot('plugin-backup', overview)?.textContent).toContain('the installed version doesn’t declare backups');
    expect(slot('plugin-backup', overview)?.className).toContain('text-destructive');
    act(() => root.unmount());
    root = createRoot(host);

    open('/settings/plugins/typed');
    await until(() => !!slot('plugin-overview'), 'the plugin page');
    expect(slot('plugin-backup')).toBeNull();
    expect(slot('plugin-not-backed-up')).toBeNull();
});

it('shows a plugin’s backups, starts Back up now, and lists what the workspace keeps (CB-458 step 5)', async () => {
    const at = Date.UTC(2026, 10, 22, 9);
    const backup = {
        state: 'ok' as const,
        declared: true,
        volumes: ['data'],
        lastSuccessAt: at,
        sizeBytes: 3 * 1024 * 1024,
    };
    list = { catalog: [], installed: [planner({ backup })] };
    backups = {
        backup,
        history: [
            {
                snapshotId: '01JREQUEST00000000000000000',
                takenAt: at,
                reason: 'request',
                note: 'Imported 1,200 notes',
                version: '1.2.0',
                bytes: 3 * 1024 * 1024,
            },
            {
                snapshotId: '01JSCHEDULED000000000000000',
                takenAt: at - 86_400_000,
                reason: 'scheduled',
                run: '20261121-090000',
                version: '1.2.0',
                bytes: 2048,
            },
        ],
    };
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-backup-history'), 'the backups');
    const section = slot('plugin-backups')!;
    expect(section.querySelector('h2')!.textContent).toBe('Backups');
    const status = slot('plugin-backup-status', section)!;
    expect(status.getAttribute('data-state')).toBe('ok');
    expect(status.textContent).toContain('is backed up with every scheduled backup');
    expect(status.textContent).toContain('(3.0 MB)');
    expect(status.className).not.toContain('text-destructive');
    const rows = [...slot('plugin-backup-history', section)!.querySelectorAll('li')];
    expect(rows.map((row) => row.getAttribute('data-snapshot'))).toEqual([
        '01JREQUEST00000000000000000',
        '01JSCHEDULED000000000000000',
    ]);
    expect(rows[0]!.textContent).toContain('Asked for by the plugin: Imported 1,200 notes · 3.0 MB · version 1.2.0');
    expect(rows[1]!.textContent).toContain('Scheduled · 2.0 KB');
    // Healthy: no badge in the overview.
    expect(slot('plugin-not-backed-up')).toBeNull();
    expect(slot('plugin-backup-failing')).toBeNull();

    const button = slot('plugin-backup-now', section) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    await until(
        () => requests.some((r) => r.path === '/api/plugins/events/backup' && r.method === 'POST'),
        'the start',
    );
    await until(() => slot('plugin-backup-status')!.textContent!.startsWith('Backing up now…'), 'running');
    expect((slot('plugin-backup-now') as HTMLButtonElement).disabled).toBe(true);
});

it('shows a failing plugin backup in red, with a badge, and no Back up now while disabled', async () => {
    const backup = {
        state: 'failing' as const,
        declared: true,
        volumes: ['data'],
        lastError: 'The snapshot ran out of time.',
        lastErrorAt: Date.UTC(2026, 10, 22, 9),
    };
    list = { catalog: [], installed: [planner({ backup, enabled: false })] };
    backups = { backup, history: [] };
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-backup-history-empty'), 'the backups');
    expect(slot('plugin-backup-failing', slot('plugin-overview')!)?.textContent).toBe('Backup failing');
    const status = slot('plugin-backup-status')!;
    expect(status.textContent).toContain('Its last backup failed');
    expect(status.textContent).toContain('The snapshot ran out of time.');
    expect(status.textContent).toContain('It has no good backup yet.');
    expect(status.className).toContain('text-destructive');
    expect((slot('plugin-backup-now') as HTMLButtonElement).disabled).toBe(true);
});

it('has no Backups section for a plugin that declares no backup', async () => {
    list = {
        catalog: [],
        installed: [planner({ backup: { state: 'not_backed_up', declared: false, volumes: ['data'] } })],
    };
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-overview'), 'the plugin page');
    expect(slot('plugin-backups')).toBeNull();
    expect(requests.some((r) => r.path.endsWith('/backups'))).toBe(false);
});

const REVIEW = {
    version: '2.0.0',
    from: 'a'.repeat(64),
    to: 'b'.repeat(64),
    additions: [
        { key: 'egress:api.example.com', kind: 'egress', host: 'api.example.com' },
        { key: 'secret:RESEND_API_KEY', kind: 'secret', name: 'RESEND_API_KEY', required: false },
        { key: 'bridge.openAnyHttps', kind: 'bridge-open-any-https' },
    ],
    removedSettings: ['OLD_REGION'],
    openAnyHttps: true,
    addsOpenAnyHttps: true,
} satisfies PluginUpdateReview;

it('reviews what an update adds, in plain words, before adopting it with an acknowledgment of exactly that', async () => {
    list = { catalog: [], installed: [planner({ update: REVIEW })] };
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-update'), 'the update button');
    act(() => slot('plugin-update')!.click());
    await until(() => !!slot('plugin-update-review'), 'the review');
    const review = slot('plugin-update-review')!;
    expect(review.textContent).toContain('Update Events to 2.0.0?');
    const additions = slot('plugin-update-additions', review)!.textContent;
    expect(additions).toContain('Can now reach api.example.com');
    expect(additions).toContain('Asks for a new optional secret RESEND_API_KEY');
    expect(slot('plugin-sensitive-scope', review)?.textContent).toContain('Sensitive scope');
    expect(slot('plugin-update-removed-settings', review)?.textContent).toContain('OLD_REGION');
    expect(requests.some((r) => r.path.endsWith('/update'))).toBe(false);
    // Cancel keeps the installed version.
    act(() => button('Cancel', review)!.click());
    await until(() => !slot('plugin-update-review'), 'the review to close');
    expect(requests.some((r) => r.path.endsWith('/update'))).toBe(false);
    // Update adopts it.
    act(() => slot('plugin-update')!.click());
    await until(() => !!slot('plugin-update-review'), 'the review');
    await act(async () => slot('plugin-update-confirm')!.click());
    await until(() => !slot('plugin-update-review'), 'the review to close');
    // The acknowledgment names the review's revisions and every addition it listed.
    expect(requests.filter((r) => r.path.endsWith('/update'))).toEqual([
        {
            path: '/api/plugins/events/update',
            method: 'POST',
            body: {
                acknowledged: {
                    from: REVIEW.from,
                    to: REVIEW.to,
                    additions: ['egress:api.example.com', 'secret:RESEND_API_KEY', 'bridge.openAnyHttps'],
                },
            },
        },
    ]);
});

it('confirms an update that adds nothing without an acknowledgment', async () => {
    list = {
        catalog: [],
        installed: [
            planner({
                update: {
                    ...REVIEW,
                    version: '1.3.0',
                    additions: [],
                    removedSettings: [],
                    openAnyHttps: false,
                    addsOpenAnyHttps: false,
                },
            }),
        ],
    };
    open('/settings/plugins/events');
    await until(() => !!slot('plugin-update'), 'the update button');
    act(() => slot('plugin-update')!.click());
    await until(() => !!slot('plugin-update-review'), 'the review');
    expect(slot('plugin-update-review')!.textContent).toContain('adds no access');
    expect(slot('plugin-update-additions')).toBeNull();
    await act(async () => slot('plugin-update-confirm')!.click());
    await until(() => requests.some((r) => r.path.endsWith('/update')), 'the update');
    expect(requests.find((r) => r.path.endsWith('/update'))).toEqual({
        path: '/api/plugins/events/update',
        method: 'POST',
    });
});
