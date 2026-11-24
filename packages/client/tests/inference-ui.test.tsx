// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    NO_INFERENCE_MESSAGES,
    type InferenceAvailability,
    type ModelOptions,
    type InferenceBackendView,
    type OperatorInferenceState,
    type UserInferenceState,
} from '@socio/shared/inference';
import type { OperatorWork } from '@socio/shared/operator';
import type { State, User, WorkspaceState } from '@socio/shared/types';

import { visibleModules } from '../src/modules/derive';
import { BackendEditor } from '../src/modules/operator/BackendEditor';
import { OperatorPage } from '../src/modules/operator/OperatorPage';
import { clientModules } from '../src/modules/registry';
import { InferenceSection } from '../src/modules/settings/InferenceSection';
import type { ModuleContext } from '../src/modules/types';
import { NoInferenceNotice } from '../src/shell/NoInferenceNotice';
import { ShellContext, type Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const olga: User = { id: 'olga', name: 'Olga', role: 'admin' };
const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };

let root: Root;
let host: HTMLElement;
let routes: Record<string, (body?: unknown) => [number, unknown]>;
let calls: { method: string; path: string; body?: unknown }[];

function shellFor(user: User, inference?: InferenceAvailability, openTarget = vi.fn()): Shell {
    const workspace = {
        user,
        spaces: [],
        dots: [],
        conversations: [],
        setup: { missing: [], inference },
        calls: [],
    } as unknown as WorkspaceState;
    return {
        state: { settings: { paused: false } } as unknown as State,
        workspace,
        admin: user.role === 'admin',
        configured: true,
        openTarget,
    } as unknown as Shell;
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    // Radix switches measure themselves.
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
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
    vi.restoreAllMocks();
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
function render(node: ReactNode, shell: Shell = shellFor(olga)) {
    act(() =>
        root.render(
            <ShellContext.Provider value={shell}>
                {/* A data router: the Platform page revalidates its loader. */}
                <RouterProvider router={createMemoryRouter([{ path: '*', element: node }])} />
            </ShellContext.Provider>,
        ),
    );
}
const text = () => document.body.textContent ?? '';
const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const button = (name: string) =>
    [...document.body.querySelectorAll('button')].find((element) => element.textContent?.trim() === name);
const click = (element: HTMLElement | undefined | null) =>
    act(() => element!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

it('shows the Platform page to admins only (CB-390: no operator role)', () => {
    const contextFor = (user: User) =>
        ({
            admin: user.role === 'admin',
            workspace: shellFor(user).workspace,
            state: {},
            configured: true,
            homeDot: { id: 'd1' },
        }) as unknown as ModuleContext;
    const ids = (user: User) => visibleModules(clientModules, contextFor(user)).map((m) => m.id);
    expect(ids(olga)).toContain('operator');
    expect(ids(alice)).toContain('operator');
    expect(ids(bob)).not.toContain('operator');
});

const seeded: InferenceBackendView = {
    id: 'b1',
    kind: 'openai-compatible',
    label: 'Self-hosted (qwen38-flash)',
    enabled: true,
    config: { baseUrl: 'http://model.example.test:8016/v1', model: 'qwen38-flash' },
    hasApiKey: true,
    capabilities: {
        acceptsImages: true,
        maxImages: 4,
        maxCompletionTokens: 8192,
    },
    status: 'ready',
    isDefault: true,
    lastTest: null,
    createdAt: 1,
    updatedAt: 1,
};

it('lists backends, tests one and allows a subscription kind', async () => {
    let operator: OperatorInferenceState = {
        backends: [seeded],
        defaultBackendId: 'b1',
        byoKinds: [
            {
                id: 'byo-fake',
                label: 'Fake subscription',
                description: 'Testing.',
                allowed: false,
            },
        ],
    };
    routes['GET /api/inference'] = () => [200, operator];
    routes['POST /api/inference/backends/b1/test'] = () => {
        operator = {
            ...operator,
            backends: [
                {
                    ...seeded,
                    lastTest: {
                        ok: true,
                        at: 5,
                        detail: 'Reachable; qwen38-flash is listed.',
                    },
                },
            ],
        };
        return [200, operator.backends[0]];
    };
    routes['PUT /api/inference/settings'] = (body) => {
        const { allowedByoKinds } = body as { allowedByoKinds: string[] };
        operator = {
            ...operator,
            byoKinds: operator.byoKinds.map((kind) => ({
                ...kind,
                allowed: allowedByoKinds.includes(kind.id),
            })),
        };
        return [200, operator];
    };
    render(<OperatorPage />);
    await until(() => text().includes('Self-hosted (qwen38-flash)'), 'backend');
    expect(text()).toContain('Ready');
    expect(text()).toContain('Default');
    expect(text()).toContain('images (up to 4)');
    expect(text()).toContain('key stored');
    click(byLabel('Test Self-hosted (qwen38-flash)'));
    await until(() => text().includes('Test passed'), 'test result');
    expect(text()).toContain('Reachable; qwen38-flash is listed.');
    click(byLabel('Allow Fake subscription'));
    await until(() => byLabel('Allow Fake subscription')?.dataset.state === 'checked', 'allowed kind');
    expect(calls.find((call) => call.path === '/api/inference/settings')?.body).toEqual({
        allowedByoKinds: ['byo-fake'],
    });
});

it('lets the operator pick the model for a kind that has one', async () => {
    let operator: OperatorInferenceState = {
        backends: [],
        defaultBackendId: null,
        byoKinds: [
            {
                id: 'byo-chatgpt',
                label: 'ChatGPT',
                description: 'Your own ChatGPT plan.',
                allowed: true,
                models: {
                    choices: [
                        { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
                        { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Legacy.' },
                    ],
                    default: 'gpt-6.1-sol',
                    selected: 'gpt-6.1-sol',
                    help: 'If chats fail, choose gpt-5.5.',
                },
            },
        ],
    };
    routes['GET /api/inference'] = () => [200, operator];
    routes['PUT /api/inference/settings'] = (body) => {
        const { byoModels } = body as { byoModels: Record<string, string> };
        operator = {
            ...operator,
            byoKinds: operator.byoKinds.map((kind) => ({
                ...kind,
                models: kind.models && {
                    ...kind.models,
                    selected: byoModels[kind.id] ?? kind.models.selected,
                },
            })),
        };
        return [200, operator];
    };
    render(<OperatorPage />);
    await until(() => !!byLabel('ChatGPT model'), 'model select');
    const select = byLabel('ChatGPT model') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
        'GPT-6.1-Sol (default)',
        'GPT-5.5 · Legacy.',
    ]);
    expect(text()).toContain('If chats fail, choose gpt-5.5.');
    act(() => {
        select.value = 'gpt-5.5';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => (byLabel('ChatGPT model') as HTMLSelectElement).value === 'gpt-5.5', 'chosen model');
    expect(calls.find((call) => call.path === '/api/inference/settings')?.body).toEqual({
        byoModels: { 'byo-chatgpt': 'gpt-5.5' },
    });
});

it('adds a backend with a write-only key', async () => {
    routes['GET /api/inference'] = () => [200, { backends: [], defaultBackendId: null, byoKinds: [] }];
    routes['POST /api/inference/backends'] = () => [201, seeded];
    render(<OperatorPage />);
    await until(() => text().includes('No backends yet'), 'empty state');
    expect(text()).toContain('No subscription kinds are installed');
    // Its own page, not a dialog: a dialog's lower fields sat under an
    // iPhone's keyboard.
    expect([...document.querySelectorAll('a')].find((a) => a.textContent === 'Add backend')?.getAttribute('href')).toBe(
        '/settings/operator/backends/new',
    );
    act(() => root.unmount());
    root = createRoot(host);
    render(<BackendEditor />);
    await until(() => !!document.querySelector('form'), 'the form');
    const set = (placeholder: string, value: string) => {
        const input = document.querySelector<HTMLInputElement>(`input[placeholder^="${placeholder}"]`)!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    set('Homelab', 'Homelab');
    set('http://localhost', 'http://model.example.test:8016/v1');
    set('qwen38-flash', 'qwen38-flash');
    set('Optional', 'sk-typed');
    act(() => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => calls.some((call) => call.method === 'POST'), 'the create request');
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
        label: 'Homelab',
        baseUrl: 'http://model.example.test:8016/v1',
        model: 'qwen38-flash',
        apiKey: 'sk-typed',
        acceptsImages: false,
        maxImages: null,
        maxCompletionTokens: null,
        contextWindow: null,
        titleModelOptions: null,
    });
});

it('edits a backend on its own page, its context window included', async () => {
    routes['GET /api/inference'] = () => [200, { backends: [seeded], defaultBackendId: 'b1', byoKinds: [] }];
    routes['PUT /api/inference/backends/b1'] = () => [200, seeded];
    render(<OperatorPage />);
    await until(() => text().includes('Self-hosted (qwen38-flash)'), 'backend');
    expect(byLabel('Edit Self-hosted (qwen38-flash)')?.getAttribute('href')).toBe('/settings/operator/backends/b1');
    act(() => root.unmount());
    root = createRoot(host);
    render(<BackendEditor backend={seeded} />);
    await until(() => !!document.querySelector('form'), 'the form');
    // No window saved: the field is empty and says what blank means, but
    // takes a number like any other.
    const input = [...document.querySelectorAll('label')]
        .find((label) => label.textContent?.startsWith('Context window'))!
        .querySelector('input')!;
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Default: 32,768');
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '262144');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => calls.some((call) => call.method === 'PUT'), 'the save request');
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
        label: 'Self-hosted (qwen38-flash)',
        baseUrl: 'http://model.example.test:8016/v1',
        model: 'qwen38-flash',
        acceptsImages: true,
        maxImages: 4,
        maxCompletionTokens: 8192,
        contextWindow: 262144,
        titleModelOptions: null,
        enabled: true,
    });
});

it('connects and disconnects a subscription from Account → Inference', async () => {
    let state: UserInferenceState = {
        kinds: [
            {
                id: 'byo-fake',
                label: 'Fake subscription',
                description: 'Testing.',
                state: 'disconnected',
            },
        ],
        active: null,
    };
    let steps = 0;
    routes['GET /api/me/inference'] = () => [200, state];
    routes['POST /api/me/inference/byo-fake/connect'] = () => {
        steps++;
        if (steps === 1) {
            return [
                200,
                {
                    state: 'pending',
                    userCode: 'FAKE-0000',
                    message: 'Confirm.',
                    pollMs: 500,
                },
            ];
        }
        state = {
            kinds: [{ ...state.kinds[0], state: 'connected' }],
            active: { source: 'byo', label: 'Fake subscription' },
        };
        return [200, { state: 'connected' }];
    };
    routes['DELETE /api/me/inference/byo-fake'] = () => {
        state = {
            kinds: [{ ...state.kinds[0], state: 'disconnected' }],
            active: null,
        };
        return [200, { ok: true }];
    };
    render(<InferenceSection />);
    await until(() => text().includes('Not connected'), 'the kind');
    expect(text()).toContain('No model is available for your chats yet.');
    click(button('Connect'));
    await until(() => text().includes('FAKE-0000'), 'the code');
    await until(() => text().includes('your own subscription'), 'connected');
    expect(steps).toBe(2);
    click(button('Disconnect'));
    await until(() => text().includes('Not connected'), 'disconnected');
});

it('tells the user how to get a model when none is available', () => {
    const openTarget = vi.fn();
    render(<NoInferenceNotice />, shellFor(bob, { available: false, byoAllowed: true }, openTarget));
    expect(text()).toContain(NO_INFERENCE_MESSAGES.connect);
    click(button('Open Account → Inference'));
    expect(openTarget).toHaveBeenCalledWith({ path: '/settings/inference' });
    render(<NoInferenceNotice />, shellFor(bob, { available: false, byoAllowed: false }));
    expect(text()).toContain(NO_INFERENCE_MESSAGES.operator);
    expect(button('Open Account → Inference')).toBeUndefined();
    render(
        <NoInferenceNotice />,
        shellFor(bob, {
            available: true,
            source: 'shared',
            label: 'Homelab',
            byoAllowed: false,
        }),
    );
    expect(document.querySelector('[data-slot="no-inference"]')).toBeNull();
});

it('follows the explicit model even when automatic inference is unavailable', () => {
    const choice = { source: 'shared' as const, backendId: 'selected' };
    const models: ModelOptions = {
        automatic: null,
        options: [
            {
                key: 'shared:selected',
                choice,
                label: 'Fixture model',
                group: 'Fixture backend',
                available: true,
            },
        ],
    };
    const shell = shellFor(bob, { available: false, byoAllowed: true });
    render(<NoInferenceNotice choice={choice} options={models} />, shell);
    expect(document.querySelector('[data-slot="no-inference"]')).toBeNull();
    // Changing back to automatic must bring the actual no-model state back.
    render(<NoInferenceNotice choice={null} options={models} />, shell);
    expect(text()).toContain(NO_INFERENCE_MESSAGES.connect);
});

it('does not flash a false warning while an explicit choice loads', () => {
    render(
        <NoInferenceNotice choice={{ source: 'shared', backendId: 'selected' }} />,
        shellFor(bob, { available: false, byoAllowed: false }),
    );
    expect(document.querySelector('[data-slot="no-inference"]')).toBeNull();
});

it('explains an unavailable explicit choice even when automatic inference works', () => {
    const choice = { source: 'byo' as const, kind: 'chatgpt', model: 'fixture' };
    const models: ModelOptions = {
        automatic: 'shared:default',
        options: [
            {
                key: 'byo:chatgpt:fixture',
                choice,
                label: 'Fixture',
                group: 'ChatGPT',
                available: false,
            },
        ],
    };
    const shell = shellFor(bob, { available: true, byoAllowed: true });
    render(<NoInferenceNotice choice={choice} options={models} />, shell);
    expect(text()).toContain(NO_INFERENCE_MESSAGES.choice);
    expect(button('Open Account → Inference')).toBeDefined();
    render(<NoInferenceNotice choice={{ source: 'shared', backendId: 'deleted' }} options={models} />, shell);
    expect(text()).toContain(NO_INFERENCE_MESSAGES.choice);
});

it('in development, shows the badge and stops all running work after a confirmation', async () => {
    const idle = {
        turns: 0,
        scheduledTasks: 0,
        computerActions: 0,
        jobRuns: 0,
    };
    let work: OperatorWork = {
        environment: 'development',
        forceStop: true,
        draining: false,
        work: { ...idle, turns: 2, computerActions: 1 },
    };
    routes['GET /api/inference'] = () => [200, { backends: [], defaultBackendId: null, byoKinds: [] }];
    routes['GET /api/operator/work'] = () => [200, work];
    routes['POST /api/operator/force-stop'] = () => {
        work = {
            ...work,
            draining: true,
            work: idle,
        };
        return [
            200,
            {
                turns: 2,
                turnSources: { web: 2 },
                scheduledTasks: 0,
                computerActions: 1,
                held: true,
            },
        ];
    };
    render(<OperatorPage />);
    await until(() => text().includes('Running work'), 'running work');
    expect(document.body.querySelector('[data-slot="environment-badge"]')?.textContent).toBe('Development');
    expect(text()).toContain('2 running turns');
    click(button('Stop all running work'));
    await until(() => text().includes('Stop all running work?'), 'confirm');
    const counts = document.body.querySelector('[data-slot="force-stop-counts"]');
    expect(counts?.textContent).toContain('2 running turns');
    expect(counts?.textContent).toContain('1 computer action');
    // Nothing is stopped before the confirmation.
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    const confirm = [...document.body.querySelectorAll('[role="dialog"] button')]
        .filter((element) => element.textContent?.trim() === 'Stop all running work')
        .at(-1) as HTMLElement;
    click(confirm);
    await until(() => text().includes('New work is held until the server restarts.'), 'held');
    expect(calls.find((call) => call.path === '/api/operator/force-stop')?.body).toEqual({ hold: true });
    expect(text()).not.toContain('Stop all running work?');
});

it('in production, shows neither the badge nor the force stop', async () => {
    routes['GET /api/inference'] = () => [200, { backends: [], defaultBackendId: null, byoKinds: [] }];
    routes['GET /api/operator/work'] = () => [
        200,
        {
            environment: 'production',
            forceStop: false,
            draining: false,
            work: {
                turns: 1,
                scheduledTasks: 0,
                computerActions: 0,
                jobRuns: 0,
            },
        } satisfies OperatorWork,
    ];
    render(<OperatorPage />);
    await until(() => calls.some((call) => call.path === '/api/operator/work'), 'work');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.body.querySelector('[data-slot="environment-badge"]')).toBeNull();
    expect(text()).not.toContain('Running work');
    expect(button('Stop all running work')).toBeUndefined();
});

it('shows page search timings by day next to the operator status', async () => {
    routes['GET /api/inference'] = () => [200, { backends: [], defaultBackendId: null, byoKinds: [] }];
    const sizes = {
        pages: 2000,
        textBytes: 7.9 * 1024 * 1024,
        wordBytes: 3.9 * 1024 * 1024,
        trigramBytes: 15.6 * 1024 * 1024,
    };
    routes['GET /api/operator/page-search'] = () => [
        200,
        {
            now: sizes,
            revisions: { revisions: 1204, pages: 310, bytes: 8.2 * 1024 * 1024 },
            days: [
                {
                    day: '2026-10-11',
                    queries: 1240,
                    empty: 31,
                    corrected: 12,
                    trigram: 80,
                    p50: 4.2,
                    p95: 9.81,
                    p99: 14,
                    maxMs: 30,
                    sizes,
                },
            ],
        },
    ];
    render(<OperatorPage />);
    await until(() => !!document.querySelector('[data-slot="page-search-day"]'), 'the rollup');
    expect(document.querySelector('[data-slot="page-search-index"]')?.textContent).toBe(
        'Index now: 2,000 pages · words 3.9 MB · trigram 15.6 MB · text 7.9 MB',
    );
    expect(document.querySelector('[data-slot="page-revisions-kept"]')?.textContent).toBe(
        'Earlier versions kept: 1,204 revisions of 310 pages · 8.2 MB, not searched',
    );
    expect([...document.querySelectorAll('[data-slot="page-search-day"] td')].map((cell) => cell.textContent)).toEqual([
        '2026-10-11',
        '1,240',
        '31',
        '12',
        '4.2 ms',
        '9.8 ms',
        '14 ms',
        '27.4 MB',
    ]);
    expect(text()).toContain('no search words are kept');
});
