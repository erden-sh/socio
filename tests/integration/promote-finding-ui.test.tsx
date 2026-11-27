// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';
import type { Dot, WorkspaceState } from '@socio/shared/types';

import { PromoteFindingDialog } from '../../packages/client/src/modules/spaces/PromoteFindingDialog';
// The dialog's words (spaces.promote), as the client's tests read them.
import '../../packages/client/tests/setup/en-us-i18n';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// What Radix Select needs from the DOM that jsdom leaves out.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia = (query: string) =>
    ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
    }) as unknown as MediaQueryList;

let root: Root;
let host: HTMLElement;
let routes: Record<string, (init?: RequestInit, url?: URL) => [number, unknown] | Promise<[number, unknown]>>;
let calls: { method: string; path: string; body?: unknown }[];
let asks: { prompt: string; dotId: string }[];

beforeEach(() => {
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const path = url.pathname;
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const handler = routes[`${method} ${path}`];
        const [status, body] = handler ? await handler(init, url) : [404, { error: 'Not found.' }];
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    routes = {};
    calls = [];
    asks = [];
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

async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 200; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}

const dot = (id: string): Dot =>
    ({
        id,
        name: id === 'd1' ? 'Sebas' : 'Manny',
        spaceIds: ['s1'],
        archivedAt: null,
    }) as unknown as Dot;

const page: Page = {
    id: 'p1',
    spaceId: 's1',
    title: 'Onboarding notes',
    content: 'New hires need a checklist before their first day.',
} as unknown as Page;

function workspaceWith(dots: Dot[], missing: string[] = []): WorkspaceState {
    return {
        dots,
        setup: { missing },
    } as unknown as WorkspaceState;
}

function render(node: ReactNode) {
    act(() => root.render(<MemoryRouter>{node}</MemoryRouter>));
}

const fullDialog = (extra?: { onClose?: () => void; onAskGoal?: (p: string, d: string) => void }) => (
    <PromoteFindingDialog
        page={page}
        workspace={workspaceWith([dot('d1')])}
        onClose={extra?.onClose ?? (() => {})}
        onAskGoal={extra?.onAskGoal ?? ((prompt, dotId) => asks.push({ prompt, dotId }))}
    />
);

const form = () => document.body.querySelector<HTMLFormElement>('[data-slot="promote-finding-form"]')!;

const setValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
};

it('prefills the title and a body with a citation to the page', () => {
    render(fullDialog());
    const fields = form();
    const title = fields.querySelector<HTMLInputElement>('input')!;
    const body = fields.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(title.value).toBe('Onboarding notes');
    expect(body.value).toContain('From [Onboarding notes](/spaces/s1/pages/p1)');
    expect(body.value).toContain('New hires need a checklist');
});

it('offers issue, schedule and goal when a specialist can reach the page', () => {
    render(fullDialog());
    const labels = [...form().querySelectorAll('[role="radiogroup"] label')]
        .map((label) => label.textContent)
        .filter(Boolean);
    expect(labels.some((t) => t!.includes('Board issue'))).toBe(true);
    expect(labels.some((t) => t!.includes('Recurring schedule'))).toBe(true);
    expect(labels.some((t) => t!.includes('Goal'))).toBe(true);
});

it('drops schedule and goal when no specialist can reach the page, keeping only issue', () => {
    render(<PromoteFindingDialog page={page} workspace={workspaceWith([])} onClose={() => {}} onAskGoal={() => {}} />);
    // No destination radio group when only one destination remains.
    expect(form().querySelector('[role="radiogroup"]')).toBeNull();
    expect(form().querySelector('select[name="follow-up-destination"]')).toBeNull();
});

it('drops schedule (but keeps goal) when inference is not set up', () => {
    render(
        <PromoteFindingDialog
            page={page}
            workspace={workspaceWith([dot('d1')], ['inference'])}
            onClose={() => {}}
            onAskGoal={() => {}}
        />,
    );
    const labels = [...form().querySelectorAll('[role="radiogroup"] label')]
        .map((label) => label.textContent)
        .filter(Boolean);
    expect(labels.some((t) => t!.includes('Board issue'))).toBe(true);
    expect(labels.some((t) => t!.includes('Goal'))).toBe(true);
    expect(labels.some((t) => t!.includes('Recurring schedule'))).toBe(false);
});

it('creates nothing until the user confirms; files an issue on confirm', async () => {
    const error = vi.spyOn(toast, 'success').mockImplementation(() => 0);
    routes['POST /api/issues'] = () => [
        201,
        {
            issue: { number: 42, title: 'Onboarding notes' },
            comments: [],
            attachments: [],
            events: [],
            users: {},
        },
    ];
    render(<PromoteFindingDialog page={page} workspace={workspaceWith([])} onClose={() => {}} onAskGoal={() => {}} />);
    // No call yet.
    expect(calls.some((c) => c.path === '/api/issues')).toBe(false);
    // Edit the title (it is already prefilled) and submit.
    const fields = form();
    const title = fields.querySelector<HTMLInputElement>('input')!;
    act(() => setValue(title, 'Onboarding checklist'));
    act(() => form().requestSubmit());
    await until(() => calls.some((c) => c.method === 'POST' && c.path === '/api/issues'), 'the issue POST');
    expect(calls.find((c) => c.path === '/api/issues')?.body).toMatchObject({
        title: 'Onboarding checklist',
        kind: 'improvement',
        area: 'spaces',
    });
    expect(calls.find((c) => c.path === '/api/issues')?.body).toHaveProperty('body');
    await until(() => error.mock.calls.length > 0, 'the success toast');
    expect(error).toHaveBeenCalled();
});

it('creates a schedule on confirm through /tasks, bound to a page conversation', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => 0);
    routes['POST /api/spaces/s1/pages/p1/conversation'] = () => [200, { id: 'c1' }];
    routes['POST /api/tasks'] = () => [201, { id: 't1' }];
    render(fullDialog());
    // Pick the schedule destination.
    const scheduleLabel = [...form().querySelectorAll('[role="radiogroup"] label')].find((label) =>
        label.textContent?.includes('Recurring schedule'),
    )!;
    act(() => scheduleLabel.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    act(() => form().requestSubmit());
    await until(() => calls.some((c) => c.method === 'POST' && c.path === '/api/tasks'), 'the tasks POST');
    // The conversation was ensured first, then the task bound to it.
    expect(calls.map((c) => c.path)).toEqual(['/api/spaces/s1/pages/p1/conversation', '/api/tasks']);
    expect(calls.find((c) => c.path === '/api/tasks')?.body).toMatchObject({
        threadId: 'c1',
        intervalSeconds: 86400,
    });
    expect(success).toHaveBeenCalled();
});

it('asks the specialist for a goal on confirm, instead of creating anything', async () => {
    const message = vi.spyOn(toast, 'message').mockImplementation(() => 0);
    render(fullDialog());
    const goalLabel = [...form().querySelectorAll('[role="radiogroup"] label')].find((label) =>
        label.textContent?.includes('Goal'),
    )!;
    act(() => goalLabel.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    act(() => form().requestSubmit());
    await until(() => asks.length === 1, 'the goal ask');
    expect(asks[0]!.dotId).toBe('d1');
    expect(asks[0]!.prompt).toContain('From [Onboarding notes](/spaces/s1/pages/p1)');
    // No server create call was made: the goal path goes through the chat.
    expect(calls).toEqual([]);
    expect(message).toHaveBeenCalled();
});
