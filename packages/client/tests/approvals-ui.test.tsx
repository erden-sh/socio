// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ApprovalAutoView, ApprovalPolicyView, ApprovalView, ApprovalsState } from '@socio/shared/approvals';
import type { State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const state: State = {
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: false,
};
const workspace = (): WorkspaceState => ({
    user: { id: 'bob', name: 'Bob', role: 'member' },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Dot',
            instructions: 'Dot helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [],
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
});
const review = (extra: Partial<ApprovalAutoView> = {}): ApprovalAutoView => ({
    verdict: 'approved',
    risk: 'low',
    reason: 'A private dataset, as the guidance allows.',
    cause: 'model',
    model: 'judge-1',
    backend: 'shared',
    latencyMs: 1200,
    at: 2,
    undoneAt: null,
    undoOutcome: null,
    undoable: true,
    ...extra,
});
const request = (extra: Partial<ApprovalView>): ApprovalView => ({
    id: 'ap1',
    dotId: 'd1',
    dotName: 'Dot',
    capability: 'data.create_dataset',
    capabilityLabel: 'Create datasets',
    summary: 'Dot wants to create a dataset “Watchlist”',
    details: [],
    status: 'approved',
    decidedVia: 'auto',
    createdAt: 1,
    expiresAt: Date.now() + 86_400_000,
    decidedAt: 2,
    outcome: 'Created dataset “Watchlist”.',
    auto: review(),
    ...extra,
});

let items: ApprovalView[] = [];
let policies: ApprovalPolicyView[] = [];
let guidance = '';
let calls: Array<{ method: string; path: string; body?: unknown }> = [];

const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    if (path === '/api/approvals') {
        const auto = url.searchParams.get('review') === 'auto';
        return [
            200,
            {
                capabilities: [
                    {
                        id: 'data.create_dataset',
                        label: 'Create datasets',
                        description: 'A new dataset.',
                        auto: { allowed: true, maxRisk: 'medium', rules: [], undo: true },
                    },
                    {
                        id: 'grant.change',
                        label: 'Change grants',
                        description: 'Access.',
                        auto: {
                            allowed: true,
                            maxRisk: 'low',
                            rules: ['Write access to shared data always needs you'],
                            undo: true,
                        },
                    },
                    {
                        id: 'app.register',
                        label: 'Publish apps',
                        description: 'Mini apps.',
                        auto: { allowed: false, maxRisk: 'low', rules: [], undo: false },
                    },
                ],
                pending: items.filter((item) => item.status === 'pending'),
                recent: items.filter((item) => item.status !== 'pending' && (!auto || !!item.auto)),
                policies,
                audit: [
                    {
                        id: 'a1',
                        dotId: 'd1',
                        capability: 'data.create_dataset',
                        requestId: 'ap1',
                        event: 'auto_approved',
                        actor: 'auto:judge-1',
                        detail: 'Risk low. A private dataset.',
                        createdAt: 2,
                    },
                ],
                guidance,
            } satisfies ApprovalsState,
        ];
    }
    if (path === '/api/approvals/policies') {
        policies = [...policies.filter((p) => !(p.dotId === body.dotId && p.capability === body.capability)), body];
        return [200, body];
    }
    if (path === '/api/approvals/guidance') {
        guidance = body.guidance;
        return [200, { guidance }];
    }
    const undo = path.match(/^\/api\/approvals\/([^/]+)\/undo$/);
    if (undo) {
        items = items.map((item) =>
            item.id === undo[1]
                ? {
                      ...item,
                      auto: review({
                          undoneAt: 3,
                          undoOutcome: 'Deleted dataset “Watchlist”.',
                          undoable: false,
                      }),
                  }
                : item,
        );
        return [200, items.find((item) => item.id === undo[1])];
    }
    const one = path.match(/^\/api\/approvals\/([^/]+)$/);
    if (one) {
        return [200, items.find((item) => item.id === one[1])];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    calls = [];
    policies = [];
    guidance = 'Datasets are fine.';
    items = [
        request({}),
        request({
            id: 'ap2',
            capability: 'grant.change',
            capabilityLabel: 'Change grants',
            summary: 'Dot asks for read access to dataset “Budget”',
            status: 'pending',
            decidedVia: null,
            decidedAt: null,
            outcome: null,
            auto: review({
                verdict: 'escalated',
                cause: 'risk',
                risk: 'medium',
                reason: 'It is personal finance data.',
                undoable: false,
            }),
        }),
        request({
            id: 'ap3',
            summary: 'Dot wants to create a dataset “Mine”',
            decidedVia: 'user',
            auto: null,
            outcome: 'Created dataset “Mine”.',
        }),
    ];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const [status, body] = respond(new URL(input, 'http://app.test'), init);
        return new Response(JSON.stringify(body), {
            status,
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
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
async function open(path: string) {
    const router = createTestRouter(path);
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    return router;
}
const text = () => host.textContent ?? '';
const button = (name: string, within: ParentNode = host) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const click = (element: HTMLElement | undefined) =>
    act(() => {
        element!.click();
    });
const choose = (label: string, value: string) =>
    act(() => {
        const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
const policyCall = () => calls.filter((call) => call.path === '/api/approvals/policies');

it('offers Auto per capability, shows its limits and a banner, and turns it off', async () => {
    await open('/approvals');
    await until(() => text().includes('Policies'), 'the policies');
    expect(host.querySelector('[data-slot="auto-banner"]')).toBeNull();
    const options = (label: string) =>
        [...host.querySelectorAll<HTMLOptionElement>(`select[aria-label="Approval policy for ${label}"] option`)].map(
            (option) => [option.value, option.disabled],
        );
    expect(options('Create datasets')).toEqual([
        ['manual', false],
        ['auto', false],
        ['bypass', false],
    ]);
    // A capability that is never decided automatically can't be set to Auto.
    expect(options('Publish apps')[1]).toEqual(['auto', true]);
    choose('Approval policy for Change grants', 'auto');
    await until(() => !!host.querySelector('[data-slot="auto-banner"]'), 'the banner');
    expect(policyCall()[0].body).toEqual({
        dotId: 'd1',
        capability: 'grant.change',
        policy: 'auto',
    });
    const banner = host.querySelector('[data-slot="auto-banner"]')!;
    expect(banner.textContent).toContain('Auto approvals are on for Dot: Change grants.');
    const row = host.querySelector('[data-capability="grant.change"]')!;
    expect(row.getAttribute('data-policy')).toBe('auto');
    expect(row.textContent).toContain('Auto');
    expect(row.querySelector('[data-slot="auto-limits"]')?.textContent).toBe(
        'Approved automatically up to low risk; anything riskier comes to you. Always to you: Write access to shared data always needs you. You can undo automatic approvals.',
    );
    click(button('Turn off auto', banner));
    await until(() => !host.querySelector('[data-slot="auto-banner"]'), 'the banner gone');
    expect(policyCall().at(-1)?.body).toEqual({
        dotId: 'd1',
        capability: 'grant.change',
        policy: 'manual',
    });
});

it('edits the guidance for auto approvals', async () => {
    await open('/approvals');
    await until(() => !!host.querySelector('[data-slot="auto-guidance"] textarea'), 'the guidance');
    const area = host.querySelector<HTMLTextAreaElement>('[data-slot="auto-guidance"] textarea')!;
    expect(area.value).toBe('Datasets are fine.');
    const save = button('Save guidance')!;
    expect(save.disabled).toBe(true);
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(area, 'Datasets are fine. Never grant write access.');
        area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await until(() => !button('Save guidance')!.disabled, 'save enabled');
    click(button('Save guidance'));
    await until(() => calls.some((call) => call.path === '/api/approvals/guidance'), 'the save');
    expect(calls.find((call) => call.path === '/api/approvals/guidance')?.body).toEqual({
        guidance: 'Datasets are fine. Never grant write access.',
    });
});

it('marks auto decisions with a badge and the reason, filters them and undoes one', async () => {
    await open('/approvals');
    await until(() => !!host.querySelector('[data-request="ap1"]'), 'recent');
    const row = () => host.querySelector('[data-request="ap1"]')!;
    expect(row().textContent).toContain('Approved (auto)');
    const auto = row().querySelector('[data-slot="auto-review"]')!;
    expect(auto.getAttribute('data-verdict')).toBe('approved');
    expect(auto.textContent).toContain('Approved by auto review:A private dataset, as the guidance allows. (risk low)');
    expect(auto.textContent).toContain('Model judge-1 (default backend), 1.2 s.');
    // The user's own decision has no auto badge.
    expect(host.querySelector('[data-request="ap3"] [data-slot="auto-review"]')).toBeNull();
    // The escalated request waits in a card, with the reason it came to you.
    const card = host.querySelector('[data-slot="approval-card"]')!;
    expect(card.textContent).toContain(
        'Auto review passed this to you:Risk medium is above what is approved automatically for this capability. It is personal finance data.',
    );
    // Filters.
    choose('Show decisions', 'user');
    await until(() => !host.querySelector('[data-request="ap1"]'), 'filtered');
    expect(host.querySelector('[data-request="ap3"]')).not.toBeNull();
    choose('Show decisions', 'auto');
    await until(() => calls.some((call) => call.path === '/api/approvals?review=auto'), 'the auto list');
    await until(() => !!host.querySelector('[data-request="ap1"]'), 'auto');
    expect(host.querySelector('[data-request="ap3"]')).toBeNull();
    // Undo.
    click(button('Undo', row()));
    await until(() => row().textContent!.includes('Undone'), 'undone');
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/approvals/ap1/undo')).toBe(true);
    expect(row().textContent).toContain('Undone: Deleted dataset “Watchlist”.');
    expect(button('Undo', row())).toBeUndefined();
});

it('shows an auto-denied request on its page, without approve or undo', async () => {
    items = [
        request({
            id: 'ap9',
            status: 'denied',
            outcome: 'Denied by auto review: Out of this Dot’s role.',
            auto: review({
                verdict: 'denied',
                risk: 'medium',
                reason: 'Out of this Dot’s role.',
                undoable: false,
            }),
        }),
    ];
    await open('/approvals/ap9');
    await until(
        () => host.querySelector('[data-slot="approval-card"]')?.getAttribute('data-status') === 'denied',
        'the request',
    );
    expect(text()).toContain('Denied (auto)');
    expect(text()).toContain('Denied by auto review:Out of this Dot’s role.');
    expect(text()).toContain('Decided by auto review in your place.');
    expect(button('Approve')).toBeUndefined();
    expect(button('Undo')).toBeUndefined();
});

it('links a chat’s approval card to its Approvals page', async () => {
    const { ApprovalCard } = await import('../src/modules/approvals/ApprovalCard');
    const { setAppNavigator } = await import('../src/modules/pages/page-navigation');
    const visited: string[] = [];
    const unregister = setAppNavigator((path) => visited.push(path));
    try {
        act(() => root.render(<ApprovalCard id="ap3" linkToPage />));
        await until(() => text().includes('Open in Approvals'), 'the link');
        const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
            (item) => item.textContent === 'Open in Approvals',
        )!;
        expect(link.getAttribute('href')).toBe('/approvals/ap3');
        click(link);
        expect(visited).toEqual(['/approvals/ap3']);
    } finally {
        unregister();
    }
});

it('keeps long lines in a chat’s approval card inside the card (CB-107)', async () => {
    const { ApprovalCard } = await import('../src/modules/approvals/ApprovalCard');
    const url = 'https://services.example-crm.test/marketplace/public/app/0123456789abcdef0123456789abcdef';
    act(() =>
        root.render(
            <ApprovalCard
                id="ap3"
                initial={request({
                    id: 'ap3',
                    decidedVia: 'user',
                    auto: null,
                    details: [`│ const base = process.env.CB_DATA_URL ?? '${url}';`],
                })}
            />,
        ),
    );
    await until(() => text().includes('process.env.CB_DATA_URL'), 'the card');
    const card = host.querySelector<HTMLElement>('[data-slot="approval-card"]')!;
    // One column that can shrink below its content, and text that breaks
    // anywhere: a long word wraps instead of widening the chat.
    expect(card.className).toContain('min-w-0');
    expect(card.className).toContain('grid-cols-[minmax(0,1fr)]');
    expect(card.className).toContain('[overflow-wrap:anywhere]');
    const detail = [...card.querySelectorAll('p')].find((p) => p.textContent?.includes(url))!;
    expect(detail.parentElement!.className).toContain('grid-cols-[minmax(0,1fr)]');
    expect(card.querySelector('footer')!.className).toContain('min-w-0');
});
