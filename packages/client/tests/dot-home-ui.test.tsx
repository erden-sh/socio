// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ApprovalView } from '@socio/shared/approvals';
import type { DotFiledItem } from '@socio/shared/issues/issue-types';
import type { GoalView, ScheduleView, SchedulesState } from '@socio/shared/schedule-types';
import type { Conversation, Dot, DotRun, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// CB-89: a Dot's home page. The sidebar's Dot opens it, it lists this
// person's chats, goals and schedules with this Dot only, an archived
// Dot's is read-only, and the Dot's crumb over a chat is a menu of its
// chats. The live chat is a stand-in, as in chat-menu-ui.test.tsx.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/modules/chat/ClientChat', () => ({
    ClientChat: () => <div data-slot="live-chat-stand-in" />,
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
    configured: true,
};
const chat = (id: string, title: string, extra: Partial<Conversation> = {}): Conversation => ({
    id,
    dotId: 'd1',
    ownerId: 'bob',
    title,
    createdAt: 1,
    ...extra,
});
const dot = (id: string, name: string, extra: Partial<Dot> = {}): Dot => ({
    id,
    spaceId: 's1',
    spaceIds: ['s1'],
    name,
    instructions: `${name} helps.`,
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
    ...extra,
});
let chats: Conversation[] = [];
let dots: Dot[] = [];
const workspace = (): WorkspaceState => ({
    user: { id: 'bob', name: 'Bob', role: 'member' },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots,
    conversations: chats.filter((c) => !c.archivedAt),
    archived: chats.filter((c) => c.archivedAt),
    setup: {
        model: true,
        voice: false,
        telegram: 'not_configured',
        missing: [],
    },
    calls: [],
});
const goal = (id: string, dotId: string, title: string): GoalView => ({
    id,
    userId: 'bob',
    dotId,
    title,
    detail: '',
    status: 'active',
    progress: id === 'G-1' ? 'Read the first draft' : null,
    comments:
        id === 'G-1'
            ? [
                  {
                      id: 'GC-1',
                      author: 'person',
                      body: 'Aim for Friday.',
                      createdAt: 2,
                  },
              ]
            : [],
    scheduleId: `task-${id}`,
    threadId: null,
    cadence: 'every day at 09:00',
    nextRunAt: 2_000_000_000_000,
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
});
const schedule = (id: string, dotId: string, title: string, extra: Partial<ScheduleView> = {}): ScheduleView => ({
    id,
    title,
    prompt: '',
    kind: 'turn',
    cadence: 'every Monday at 08:00',
    timezone: 'UTC',
    intervalSeconds: null,
    status: 'scheduled',
    origin: 'dot',
    dotId,
    dotName: null,
    jobId: null,
    jobName: null,
    threadId: null,
    nextRunAt: 2_000_000_000_000,
    lastRun: null,
    error: null,
    createdAt: 1,
    ...extra,
});
// The server's answers: already only Bob's (the routes' own tests check).
const schedules = (): Partial<SchedulesState> => ({
    goals: [goal('G-1', 'd1', 'Ship the guide'), goal('G-2', 'd2', 'Ada goal')],
    schedules: [
        schedule('task-G-1', 'd1', 'Goal: Ship the guide'),
        schedule('t1', 'd1', 'Weekly review'),
        schedule('t2', 'd2', 'Ada schedule'),
        schedule('t3', 'd1', 'Old one', { status: 'cancelled' }),
    ],
    jobs: [],
});
const approval = (id: string, dotId: string, summary: string) =>
    ({ id, dotId, summary, status: 'pending', createdAt: 1 }) as ApprovalView;
const runs: DotRun[] = [
    {
        runId: 'r1',
        threadId: 'c1',
        title: 'Garden plan',
        status: 'running',
        source: 'web',
        startedAt: 5,
        finishedAt: null,
    },
    {
        runId: 'r2',
        threadId: 'c2',
        title: 'Other chat',
        status: 'failed',
        source: 'web',
        startedAt: 4,
        finishedAt: 5,
    },
];
const filed: DotFiledItem[] = [{ number: 12, title: 'Export to calendar', status: 'triage', filedAt: 3 }];

let asked: string[] = [];
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    asked.push(`${init?.method ?? 'GET'} ${path}${url.search}`);
    if (path === '/api/schedules') {
        return [200, schedules()];
    }
    if (path === '/api/approvals') {
        return [
            200,
            {
                pending: [approval('a1', 'd1', 'Create dataset “Plants”'), approval('a2', 'd2', 'Ada wants a dataset')],
            },
        ];
    }
    if (path === '/api/dots/d1/runs' || path === '/api/dots/d3/runs' || path === '/api/dots/d4/runs') {
        return [200, path.includes('d1') ? runs : []];
    }
    if (path === '/api/issues/filed') {
        return [200, url.searchParams.get('dot') === 'd1' ? filed : []];
    }
    if (path === '/api/dots/d3/unarchive') {
        dots = dots.map((item) => (item.id === 'd3' ? { ...item, archivedAt: undefined } : item));
        return [200, {}];
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
    Element.prototype.scrollIntoView = () => {};
    dots = [
        dot('d1', 'Dot'),
        dot('d2', 'Ada'),
        dot('d3', 'Retired', { ownerId: 'bob', archivedAt: 9, archivedBy: 'bob' }),
    ];
    chats = [
        chat('c1', 'Garden plan'),
        chat('c2', 'Other chat'),
        chat('c3', 'Ada’s chat', { dotId: 'd2' }),
        chat('a1', 'Old trip', { archivedAt: 500 }),
        chat('a2', 'Ada’s old trip', { archivedAt: 400, dotId: 'd2' }),
        chat('r1', 'Retired chat', { dotId: 'd3' }),
    ];
    asked = [];
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
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
const home = () => host.querySelector<HTMLElement>('[data-slot="dot-home"]');
const panel = (name: string) => host.querySelector<HTMLElement>(`[data-panel="${name}"]`);
const rows = (element: Element | null | undefined) =>
    [...(element?.querySelectorAll('[data-slot="dot-panel-item"]') ?? [])].map((row) => row.textContent ?? '');
const crumb = () =>
    host.querySelector('[data-slot="app-header"]')?.querySelector('[data-slot="breadcrumb-page"]')?.textContent;
const click = (element: HTMLElement | null | undefined) => act(() => element!.click());
const key = (target: Element, name: string) =>
    act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });

it('opens the Dot’s home page from the sidebar, whatever chats it has', async () => {
    const router = await open('/chats/c3');
    await until(() => crumb() === 'Ada’s chat', 'the chat');
    const sidebarDot = (name: string) =>
        [...host.querySelectorAll<HTMLAnchorElement>('[data-dot-row] [data-sidebar="menu-button"]')].find(
            (link) => link.textContent?.trim() === name,
        );
    // Dot has chats, Ada too: both go home, never into a chat.
    expect(sidebarDot('Dot')?.getAttribute('href')).toBe('/dots/d1');
    expect(sidebarDot('Ada')?.getAttribute('href')).toBe('/dots/d2');
    click(sidebarDot('Dot'));
    await until(() => !!home(), 'the home page');
    expect(router.state.location.pathname).toBe('/dots/d1');
    expect(crumb()).toBe('Dot');
    // A company socio (no owner) is the unmarked default: CB-269 labels
    // private socios with a "Personal" badge, not company ones.
    expect(home()!.querySelector('[data-slot="dot-visibility-badge"]')).toBeNull();
    expect(sidebarDot('Dot')?.title).toContain('everyone can see and use it');
    // The Dot is the active row; New chat starts one under it.
    expect(sidebarDot('Dot')?.getAttribute('aria-current')).toBe('page');
    const newChat = host.querySelector<HTMLAnchorElement>('[data-slot="dot-home-new-chat"]');
    expect(newChat?.getAttribute('href')).toBe('/dots/d1/new');
    click(newChat);
    await until(() => crumb() === 'New chat', 'a new chat');
    expect(router.state.location.pathname).toBe('/dots/d1/new');
    expect(host.querySelector('textarea[aria-label="Start a conversation"]')).not.toBeNull();
});

it('shows only this person’s chats, goals, schedules, turns and filings with this Dot', async () => {
    await open('/dots/d1');
    await until(() => rows(panel('goals')).length > 0, 'the goals');
    // Now: active chats, the turn in progress, the approval waiting.
    expect(rows(panel('active-chats'))).toEqual([
        expect.stringContaining('Garden plan'),
        expect.stringContaining('Other chat'),
    ]);
    await until(() => rows(panel('running')).length > 0, 'the turns');
    expect(rows(panel('running'))).toEqual([expect.stringContaining('Garden plan')]);
    await until(() => rows(panel('approvals')).length > 0, 'the approvals');
    expect(rows(panel('approvals'))).toEqual([expect.stringContaining('Create dataset “Plants”')]);
    // Earlier: archived chats, finished turns, its filings.
    expect(rows(panel('archived-chats'))).toEqual([expect.stringContaining('Old trip')]);
    expect(rows(panel('recent-runs'))).toEqual([expect.stringMatching(/Other chat.*Failed/)]);
    await until(() => rows(panel('filings')).length > 0, 'the filings');
    expect(rows(panel('filings'))).toEqual([expect.stringMatching(/CB-12 Export to calendar.*Triage/)]);
    // Next: its goal (with progress) and its schedule, not the goal's own
    // schedule twice, a canceled one or Ada's.
    expect(rows(panel('goals'))).toEqual([
        expect.stringMatching(/Ship the guide.*Active · 1 comment.*Read the first draft/),
    ]);
    expect(rows(panel('schedules'))).toEqual([expect.stringContaining('Weekly review')]);
    expect(home()!.textContent).not.toMatch(/Ada/);
    expect(asked).toContain('GET /api/issues/filed?dot=d1');
    expect(asked).toContain('GET /api/dots/d1/runs');
    // The tabs: Active, then Archived (linkable as ?tab=archived).
    const list = () => rows(host.querySelector('[role="tabpanel"][data-state="active"]'));
    expect(list()).toEqual([expect.stringContaining('Garden plan'), expect.stringContaining('Other chat')]);
    const archivedTab = host.querySelector<HTMLElement>('[data-slot="dot-chats-archived"]')!;
    act(() => {
        archivedTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await until(() => list().length === 1, 'the archived tab');
    expect(list()).toEqual([expect.stringContaining('Old trip')]);
});

it('folds the panels into one line while every one is empty, leading with its avatar, state and New chat (CB-308)', async () => {
    dots = [...dots, dot('d4', 'Quiet')];
    await open('/dots/d4');
    const quiet = () => host.querySelector<HTMLElement>('[data-slot="dot-home-quiet"]');
    await until(() => !!quiet(), 'the quiet line');
    expect(quiet()!.textContent).toContain('Nothing running, waiting for you or scheduled');
    expect([...quiet()!.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
        ['Approvals', '/approvals'],
        ['Schedules', '/schedules'],
        ['Board', '/issues'],
    ]);
    // The panels stay mounted, out of sight, to come back on their own.
    const panels = host.querySelector<HTMLElement>('[data-slot="dot-home-panels"]')!;
    expect(panels.hidden).toBe(true);
    expect(panel('approvals')).not.toBeNull();
    // The page leads with the avatar, its state word and New chat.
    expect(home()!.querySelector('[data-slot="dot-state"]')?.textContent).toBe('Idle');
    expect(host.querySelector('[data-slot="dot-home-new-chat"]')?.getAttribute('href')).toBe('/dots/d4/new');
});

it('keeps the panels when anything is in them, and says Working while a turn runs (CB-308)', async () => {
    await open('/dots/d1');
    await until(() => rows(panel('running')).length > 0, 'the turns');
    expect(host.querySelector('[data-slot="dot-home-quiet"]')).toBeNull();
    expect(host.querySelector<HTMLElement>('[data-slot="dot-home-panels"]')!.hidden).toBe(false);
    expect(home()!.querySelector('[data-slot="dot-state"]')?.textContent).toBe('Working');
});

it('shows an archived Dot read-only, with Unarchive for its owner', async () => {
    await open('/dots/d3');
    await until(() => !!home(), 'the home page');
    const banner = host.querySelector<HTMLElement>('[data-slot="dot-archived"]');
    expect(home()!.querySelector('[data-slot="dot-visibility-badge"]')?.textContent).toBe('Personal');
    expect(banner?.textContent).toContain('This socio is archived.');
    // No New chat or settings, but its chats are listed.
    expect(host.querySelector('[data-slot="dot-home-new-chat"]')).toBeNull();
    expect(home()!.textContent).not.toContain('Settings');
    expect(rows(panel('active-chats'))).toEqual([expect.stringContaining('Retired chat')]);
    const unarchive = [...banner!.querySelectorAll('button')].find((button) => button.textContent === 'Unarchive');
    click(unarchive);
    await until(() => !!host.querySelector('[data-slot="dot-home-new-chat"]'), 'the Dot back');
    expect(asked).toContain('POST /api/dots/d3/unarchive');
});

it('hides another person’s Dot, and keeps old links to a Dot working', async () => {
    // An unknown (or someone else's own) Dot isn't in the workspace.
    const router = await open('/dots/someone-elses');
    await until(() => /Socio not found/.test(host.textContent ?? ''), 'not found');
    // `/dots/:id` was a new chat: it opens the home page, with New chat.
    await act(() => router.navigate('/dots/d2'));
    await until(() => !!home(), 'the home page');
    expect(crumb()).toBe('Ada');
    expect(home()!.textContent).toContain('New chat');
});

it('labels a personal socio with a "Personal" badge in its sidebar row and crumb (CB-269)', async () => {
    // A personal, non-archived socio owned by Bob, with one chat. Company
    // socios (d1, d2) stay unmarked: only a private socio gets the badge.
    dots = [dot('d1', 'Dot'), dot('d2', 'Ada'), dot('d4', 'Mine', { ownerId: 'bob' })];
    chats = [
        chat('c1', 'Garden plan'),
        chat('c2', 'Other chat'),
        chat('c3', 'Ada’s chat', { dotId: 'd2' }),
        chat('c4', 'Mine chat', { dotId: 'd4' }),
    ];
    const router = await open('/chats/c4');
    await until(() => crumb() === 'Mine chat', 'the personal chat');
    // The sidebar row for the personal socio carries the badge; the company
    // rows do not.
    const personalRow = host.querySelector<HTMLElement>('[data-dot-row="d4"]')!;
    const companyRow = host.querySelector<HTMLElement>('[data-dot-row="d1"]')!;
    expect(personalRow.querySelector('[data-slot="dot-visibility-badge"]')?.textContent).toBe('Personal');
    expect(companyRow.querySelector('[data-slot="dot-visibility-badge"]')).toBeNull();
    // The Dot crumb over the chat labels the personal socio too.
    const trigger = host.querySelector<HTMLElement>('[data-slot="dot-crumb"]')!;
    expect(trigger.querySelector('[data-slot="dot-visibility-badge"]')?.textContent).toBe('Personal');
    expect(router.state.location.pathname).toBe('/chats/c4');
});

it('lists the Dot’s chats in its crumb over a chat, with All chats and New chat', async () => {
    const router = await open('/chats/c2');
    await until(() => crumb() === 'Other chat', 'the chat');
    const trigger = host.querySelector<HTMLElement>('[data-slot="dot-crumb"]')!;
    expect(trigger.textContent).toBe('Dot');
    key(trigger, 'Enter');
    await until(() => !!document.querySelector('[data-slot="dot-crumb-menu"]'), 'the menu');
    const menu = document.querySelector<HTMLElement>('[data-slot="dot-crumb-menu"]')!;
    const chatsListed = [...menu.querySelectorAll<HTMLAnchorElement>('[data-chat]')];
    // This Dot's live chats only: not Ada's, not the archived one.
    expect(chatsListed.map((link) => link.textContent)).toEqual(['Garden plan', 'Other chat']);
    expect(chatsListed[1]!.getAttribute('aria-current')).toBe('page');
    expect(menu.querySelector('[data-slot="dot-crumb-home"]')?.getAttribute('href')).toBe('/dots/d1');
    expect(menu.querySelector('[data-slot="dot-crumb-new"]')?.getAttribute('href')).toBe('/dots/d1/new');
    click(chatsListed[0]);
    await until(() => crumb() === 'Garden plan', 'the other chat');
    expect(router.state.location.pathname).toBe('/chats/c1');
});
