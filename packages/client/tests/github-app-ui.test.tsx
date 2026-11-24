// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { GitHubAppView } from '@socio/shared/github-types';

import { GitHubAppSetting } from '../src/modules/settings/GitHubAppSetting';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let routes: Record<string, (body: unknown) => [number, unknown]>;
let calls: { method: string; path: string; body: unknown }[];
let assign: ReturnType<typeof vi.fn>;

const view = (fields: Partial<GitHubAppView> = {}): GitHubAppView => ({
    repository: 'acme/socio',
    repositorySource: 'env',
    app: null,
    installation: null,
    unreadable: false,
    canConnect: true,
    ...fields,
});

/** The page's address, as GitHub sent the admin back to it. */
function at(search: string) {
    assign = vi.fn();
    vi.stubGlobal('location', {
        origin: 'http://localhost:3000',
        pathname: '/settings/workspace',
        search,
        hash: '',
        assign,
    });
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    routes = { 'GET /api/github': () => [200, view()] };
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://localhost:3000');
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });
        const handler = routes[`${method} ${url.pathname}`];
        const [code, answer] = handler ? handler(body) : [404, { error: 'Not found.' }];
        return new Response(JSON.stringify(answer), {
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
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);

it('starts Connect GitHub from Settings', async () => {
    at('');
    routes['POST /api/github/connect'] = () => [200, { url: '/api/github/manifest?state=s1' }];
    act(() => root.render(<GitHubAppSetting />));
    await until(() => !!button('Connect GitHub'), 'the card');
    expect(host.querySelector('[data-slot="github-app-status"]')!.textContent).toBe('GitHub is not connected.');
    // Nothing to paste: no secret field.
    expect(host.querySelector('input[type="password"]')).toBeNull();
    act(() => button('Connect GitHub')!.click());
    await until(() => assign.mock.calls.length > 0, 'the manifest page');
    expect(assign).toHaveBeenCalledWith('/api/github/manifest?state=s1');
});

it('finishes each step when GitHub sends the admin back, and clears the code from the address', async () => {
    at('?code=abc123&state=s1');
    const replace = vi.spyOn(window.history, 'replaceState');
    routes['POST /api/github/created'] = () => [
        200,
        {
            url: 'https://github.com/apps/socio-1/installations/new?state=s2',
        },
    ];
    act(() => root.render(<GitHubAppSetting />));
    await until(() => assign.mock.calls.length > 0, 'the install page');
    expect(calls.find((c) => c.path === '/api/github/created')!.body).toEqual({
        code: 'abc123',
        state: 's1',
    });
    expect(assign).toHaveBeenCalledWith('https://github.com/apps/socio-1/installations/new?state=s2');
    expect(replace).toHaveBeenCalledWith(null, '', '/settings/workspace');
    act(() => root.unmount());
    root = createRoot(host);

    at('?installation_id=5000&setup_action=install&state=s2');
    routes['POST /api/github/installed'] = () => [
        200,
        view({
            app: {
                source: 'settings',
                id: '1',
                slug: 'socio-1',
                owner: 'acme',
            },
            installation: { id: '5000', account: 'acme' },
        }),
    ];
    act(() => root.render(<GitHubAppSetting />));
    await until(() => !!button('Disconnect'), 'the connected card');
    expect(host.querySelector('[data-slot="github-app-status"]')!.textContent).toBe(
        'Connected: GitHub App socio-1, installed on acme.',
    );
    expect(button('Connect again')).toBeDefined();
});

it('offers Disconnect, not Connect, when the saved App can’t be read', async () => {
    at('');
    routes['GET /api/github'] = () => [200, view({ unreadable: true })];
    routes['DELETE /api/github/app'] = () => [200, view()];
    act(() => root.render(<GitHubAppSetting />));
    await until(() => !!button('Disconnect'), 'the card');
    expect(host.querySelector('[data-slot="github-app-status"]')!.textContent).toContain(
        'The GitHub App saved here can’t be read: its data key is gone. Select Disconnect, then Connect GitHub.',
    );
    expect(button('Connect GitHub')!.disabled).toBe(true);
    act(() => button('Disconnect')!.click());
    await until(() => !button('Disconnect'), 'the disconnected card');
    expect(calls.at(-1)).toMatchObject({
        method: 'DELETE',
        path: '/api/github/app',
    });
    expect(button('Connect GitHub')!.disabled).toBe(false);
});

it('shows a failed step’s reason', async () => {
    at('?code=abc123&state=old');
    routes['POST /api/github/created'] = () => [
        409,
        {
            error: 'This GitHub step has expired, was used already, or was not started here; select Connect GitHub again.',
        },
    ];
    act(() => root.render(<GitHubAppSetting />));
    await until(() => !!host.querySelector('[role="alert"]'), 'the error');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('This GitHub step has expired');
    expect(assign).not.toHaveBeenCalled();
});

const field = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!;
const type = (id: string, value: string) =>
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(id), value);
        field(id).dispatchEvent(new Event('input', { bubbles: true }));
    });
const leave = (id: string) =>
    act(async () => {
        field(id).dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

it('saves the repository as its field is left, with Undo (CB-308)', async () => {
    at('');
    vi.mocked(toast.success).mockReset();
    routes['PUT /api/github'] = (body) => {
        const { repository } = body as { repository: string | null };
        return [
            200,
            view({
                repository: repository ?? 'acme/socio',
                repositorySource: repository ? 'settings' : 'env',
            }),
        ];
    };
    act(() => root.render(<GitHubAppSetting />));
    await until(() => !!field('github-app-repository'), 'the card');
    const card = host.querySelector('[data-slot="github-app"]')!;
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Save');
    const puts = () => calls.filter((call) => call.method === 'PUT');
    // Unchanged, or not owner/name: nothing is saved.
    await leave('github-app-repository');
    type('github-app-repository', 'acme');
    await leave('github-app-repository');
    expect(puts()).toEqual([]);
    expect(card.querySelector('[role="alert"]')!.textContent).toBe(
        'Name the repository as owner/name, such as acme/app.',
    );
    type('github-app-repository', ' acme/app ');
    await leave('github-app-repository');
    await until(() => puts().length === 1, 'the save');
    expect(puts()[0].body).toEqual({ repository: 'acme/app' });
    await until(() => card.querySelector('[data-slot="save-status"]')!.textContent === 'Saved', 'Saved');
    expect(card.querySelector('[role="alert"]')).toBeNull();
    const [text, options] = vi.mocked(toast.success).mock.lastCall! as [
        string,
        { action: { label: string; onClick: () => void } },
    ];
    expect(text).toBe('GitHub App owner from acme/app');
    expect(options.action.label).toBe('Undo');
    // Undo goes back to the server's repository, not a copy of it here.
    await act(async () => options.action.onClick());
    await until(() => puts().length === 2, 'the undo');
    expect(puts()[1].body).toEqual({ repository: null });
    await until(() => field('github-app-repository').value === 'acme/socio', 'the server’s repository');
});
