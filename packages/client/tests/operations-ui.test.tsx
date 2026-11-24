// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ClassifyUseView, SessionLabelRow, SessionLabelView } from '@socio/shared/classify';
import type {
    CursorPage,
    OperationsSettingsView,
    OpsOverview,
    OpsSeries,
    OpsTurnRow,
    OpsWindow,
} from '@socio/shared/operations/operations';
import type {
    OpsActivity,
    OpsChatRow,
    OpsPersonRow,
    OpsSessionRow,
    OpsSocioRow,
    OpsValue,
} from '@socio/shared/operations/operations-activity';
import type { HealthFacts, HealthScheduleRow, OpsHealth } from '@socio/shared/operations/operations-health';
import type { OpsThemes } from '@socio/shared/operations/operations-themes';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// The Operations shell (CB-164): admins only, its range and filters in the
// address, the shared cursor list, and its Settings page.
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
    configured: true,
};
let role: Role = 'admin';
const workspace = (): WorkspaceState => ({
    user: { id: 'alice', name: 'Alice', role },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Manny',
            instructions: 'Manny helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [],
    setup: {
        model: true,
        voice: false,
        telegram: 'not_configured',
        missing: [],
    },
    calls: [],
});

const NOW = Date.UTC(2026, 9, 22, 12);
const HOUR = 3_600_000;
const window_: OpsWindow = {
    from: NOW - 7 * 24 * HOUR,
    to: NOW,
    bucket: 'day',
    buckets: ['hour', 'day', 'week', 'month'],
    previous: null,
    timeZone: 'UTC',
};
const TURNS = 120;
const turn = (index: number): OpsTurnRow => ({
    runId: `r${index}`,
    threadId: 't1',
    socioId: 'd1',
    socioName: 'Manny',
    source: 'web',
    status: index === 3 ? 'failed' : 'finished',
    startedAt: NOW - index * HOUR,
    finishedAt: NOW - index * HOUR + 1000,
    tokens: 1200,
    toolCalls: 1,
    toolErrors: 0,
});

let requests: string[] = [];
let settings: OperationsSettingsView;
let failNextPage = false;
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path.startsWith('/api/operations/')) {
        requests.push(`${method} ${path}${url.search}`);
        if (role === 'member') {
            return [403, { error: 'Only an admin can.' }];
        }
    }
    if (path === '/api/operations/settings') {
        if (method === 'PUT') {
            const body = JSON.parse(String(init!.body)) as Partial<
                Record<'timeZone' | 'sessionGapMinutes', string | number | null>
            >;
            settings = {
                ...settings,
                ...(body.timeZone !== undefined ? { timeZone: String(body.timeZone) } : {}),
                ...(body.sessionGapMinutes !== undefined
                    ? {
                          sessionGapMinutes:
                              body.sessionGapMinutes === null
                                  ? settings.defaults.sessionGapMinutes
                                  : Number(body.sessionGapMinutes),
                      }
                    : {}),
            };
        }
        return [200, settings];
    }
    if (path === '/api/operations/overview') {
        return [
            200,
            {
                status: { state: 'ready', asOf: NOW - 60_000, earliest: 0 },
                window: { ...window_, timeZone: settings.timeZone },
                tiles: [
                    { id: 'turns', value: 120, previous: 100 },
                    { id: 'failed', value: 3, previous: 1 },
                    { id: 'people', value: 4, previous: 4 },
                    { id: 'messages', value: 300, previous: 0 },
                    { id: 'chats', value: 12, previous: null },
                    { id: 'tokens', value: 144_000, previous: 120_000 },
                ],
            } satisfies OpsOverview,
        ];
    }
    if (path.startsWith('/api/operations/series/')) {
        return [
            200,
            {
                status: { state: 'ready', asOf: NOW, earliest: 0 },
                window: window_,
                metric: 'turns',
                points: Array.from({ length: 7 }, (_, index) => ({
                    at: NOW - (7 - index) * 24 * HOUR,
                    value: index * 3,
                })),
            } satisfies OpsSeries,
        ];
    }
    if (path === '/api/operations/turns') {
        if (failNextPage && url.searchParams.get('cursor')) {
            failNextPage = false;
            return [500, { error: 'The server could not complete this request.' }];
        }
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Number(url.searchParams.get('limit'));
        const end = Math.min(TURNS, start + limit);
        return [
            200,
            {
                items: Array.from({ length: end - start }, (_, i) => turn(start + i)),
                next: end < TURNS ? String(end) : null,
            } satisfies CursorPage<OpsTurnRow>,
        ];
    }
    if (path === '/api/operations/health') {
        return [
            200,
            {
                status: { state: 'ready', asOf: NOW, earliest: 0 },
                window: window_,
                facts: healthFacts,
                live: {
                    analytics: { mode: 'child', state: 'ready', asOf: Date.now() },
                    staleAfterMs: 300_000,
                    backup: null,
                    deployment: { state: 'ok', measuredAt: Date.now(), services: 9, unlimitedServices: 2 },
                },
            } satisfies OpsHealth,
        ];
    }
    if (path.startsWith('/api/operations/health/series/')) {
        return [
            200,
            {
                status: { state: 'ready', asOf: NOW, earliest: 0 },
                window: window_,
                metric: 'first_output',
                points: Array.from({ length: 7 }, (_, index) => ({
                    at: NOW - (7 - index) * 24 * HOUR,
                    n: index,
                    p95: index ? index * 400 : null,
                })),
            },
        ];
    }
    if (path === '/api/operations/health/schedules') {
        return [
            200,
            {
                items: [
                    {
                        id: 's1',
                        title: 'Morning brief',
                        socioId: 'd1',
                        socioName: 'Manny',
                        personId: 'alice',
                        state: 'failing',
                        status: 'scheduled',
                        cadence: 'daily',
                        nextRunAt: null,
                        lastRunAt: null,
                        updatedAt: NOW,
                        error: 'The model was busy.',
                    },
                ],
                next: null,
            } satisfies CursorPage<HealthScheduleRow>,
        ];
    }
    if (path.startsWith('/api/operations/health/')) {
        return [200, { items: [], next: null }];
    }
    const activityAnswer = activityRoutes(path, url, init);
    if (activityAnswer) {
        return activityAnswer;
    }
    return [404, { error: 'Not found.' }];
};

/** Activity's and Value's answers (CB-190). */
function activityRoutes(path: string, url: URL, init?: RequestInit): [number, unknown] | undefined {
    const method = init?.method ?? 'GET';
    const ready = { state: 'ready' as const, asOf: NOW - 60_000, earliest: 0 };
    const points = Array.from({ length: 7 }, (_, index) => ({
        at: NOW - (7 - index) * 24 * HOUR,
    }));
    if (path === '/api/operations/activity') {
        return [
            200,
            {
                status: ready,
                window: window_,
                sessionGapMinutes: settings.sessionGapMinutes,
                tiles: [
                    { id: 'people', value: 4, previous: 3 },
                    { id: 'returning', value: 2, previous: 2 },
                    { id: 'stickiness', value: 0.42, previous: 0.5 },
                    { id: 'sessions', value: 31, previous: 20 },
                    { id: 'chats', value: 9, previous: 9 },
                    { id: 'length', value: 6.5, previous: 4 },
                ],
                points: points.map((point, index) => ({
                    ...point,
                    people: index,
                    sessions: index * 2,
                    messages: index * 5,
                })),
                sources: [
                    {
                        key: 'web',
                        label: 'Web app',
                        kind: 'human',
                        turns: 80,
                        messages: 90,
                        people: 4,
                    },
                    {
                        key: 'scheduled',
                        label: 'Schedule',
                        kind: 'automation',
                        turns: 12,
                        messages: 0,
                        people: 0,
                    },
                ],
                participation: {
                    chats: 9,
                    withSeveralPeople: 2,
                    withSeveralSocios: 1,
                    collaboration: 3,
                },
                features: [
                    {
                        id: 'pages',
                        label: 'Space pages',
                        tools: ['read_page'],
                        calls: 40,
                        people: 3,
                        socios: 1,
                        errors: 2,
                        refusals: 0,
                    },
                ],
                spaces: [
                    {
                        spaceId: 's1',
                        name: 'Everyday',
                        writesByPeople: 3,
                        writesBySocios: 5,
                        pages: 4,
                        people: 4,
                        socios: 1,
                        turns: 92,
                    },
                ],
            } satisfies OpsActivity,
        ];
    }
    if (path === '/api/operations/value') {
        return [
            200,
            {
                status: ready,
                window: window_,
                sessionGapMinutes: settings.sessionGapMinutes,
                tiles: [
                    { id: 'completed', value: 12, previous: 10 },
                    { id: 'answered', value: 15, previous: 15 },
                    { id: 'abandoned', value: 3, previous: 5 },
                    { id: 'completedShare', value: 0.4, previous: 1 / 3 },
                    { id: 'resumption', value: 0.25, previous: null },
                ],
                points: points.map((point, index) => ({
                    ...point,
                    completed: index,
                    answered: 1,
                    abandoned: 0,
                })),
                approvals: [
                    {
                        capability: 'web.post',
                        requested: 5,
                        approved: 3,
                        denied: 1,
                        expired: 1,
                        executed: 3,
                        failed: 0,
                    },
                ],
                reactions: {
                    socioMessages: 40,
                    reacted: 10,
                    up: 8,
                    down: 1,
                    retry: 1,
                    needsWork: 0,
                },
                intents: [
                    {
                        intent: 'write',
                        sessions: 6,
                        people: 3,
                        completed: 4,
                        answered: 1,
                        abandoned: 1,
                    },
                    {
                        intent: null,
                        sessions: 4,
                        people: 2,
                        completed: 0,
                        answered: 3,
                        abandoned: 1,
                    },
                ],
            } satisfies OpsValue,
        ];
    }
    if (path === '/api/operations/activity/people') {
        return [
            200,
            {
                items: [
                    {
                        personId: 'u1',
                        name: 'Bea',
                        messages: 20,
                        sessions: 6,
                        chats: 2,
                        socios: 1,
                        activeDays: 4,
                        toolCalls: 9,
                        completed: 3,
                        lastAt: NOW - HOUR,
                    },
                    {
                        personId: 'telegram-team:-1001',
                        name: null,
                        messages: 5,
                        sessions: 2,
                        chats: 1,
                        socios: 1,
                        activeDays: 1,
                        toolCalls: 0,
                        completed: 0,
                        lastAt: NOW - 2 * HOUR,
                    },
                ],
                next: null,
            } satisfies CursorPage<OpsPersonRow>,
        ];
    }
    if (path === '/api/operations/activity/chats') {
        return [
            200,
            {
                items: [
                    {
                        threadId: 'thread/1',
                        socioId: 'd1',
                        socioName: 'Manny',
                        ownerKind: 'team',
                        people: 3,
                        socios: 2,
                        messages: 40,
                        sessions: 5,
                        activeDays: 3,
                        resumed: true,
                        lastAt: NOW - HOUR,
                    },
                ],
                next: null,
            } satisfies CursorPage<OpsChatRow>,
        ];
    }
    if (path === '/api/operations/activity/socios') {
        return [
            200,
            {
                items: [
                    {
                        socioId: 'd1',
                        name: 'Manny',
                        people: 4,
                        sessions: 30,
                        chats: 9,
                        messages: 90,
                        turns: 92,
                        perChat: 6.5,
                        repeatUse: 0.5,
                        collaboration: 3,
                        completed: 12,
                        answered: 15,
                        abandoned: 3,
                        returnRate: 0.75,
                        lastAt: NOW - HOUR,
                    },
                ],
                next: null,
            } satisfies CursorPage<OpsSocioRow>,
        ];
    }
    if (path === '/api/operations/value/sessions') {
        return [
            200,
            {
                items: [
                    {
                        id: 't1@1',
                        threadId: 't1',
                        socioId: 'd1',
                        socioName: 'Manny',
                        source: url.searchParams.get('outcome') ?? 'web',
                        startedAt: NOW - HOUR,
                        endedAt: NOW - HOUR + 60_000,
                        messages: 4,
                        people: 1,
                        socios: 1,
                        outcome: 'abandoned',
                    },
                ],
                next: null,
            } satisfies CursorPage<OpsSessionRow>,
        ];
    }
    // Themes (CB-199).
    if (path === '/api/operations/themes') {
        return [200, themesAnswer()];
    }
    if (path === '/api/classify/uses/intent' || path === '/api/classify/uses/themes') {
        const use = path.endsWith('intent') ? 'intent' : 'themes';
        if (method === 'PUT') {
            classifyPuts.push({ use, body: JSON.parse(String(init!.body)) });
        }
        return [200, classifyView(use)];
    }
    if (path === '/api/classify/uses/failures') {
        return [200, classifyView('failures')];
    }
    if (path === '/api/classify/sessions') {
        requests.push(`${method} ${path}${url.search}`);
        return [
            200,
            {
                items: [SESSION_ROW],
                next: null,
            } satisfies CursorPage<SessionLabelRow>,
        ];
    }
    if (path === '/api/classify/sessions/r9') {
        requests.push(`${method} ${path}${url.search}`);
        return [
            200,
            {
                ...SESSION_ROW,
                input: {
                    title: 'Invoices for March',
                    messages: ['Draft the invoices email to <email>', 'Shorter'],
                },
                intentLabels: [
                    { value: 'ask', hint: 'A question.' },
                    { value: 'write', hint: 'Writing.' },
                ],
            } satisfies SessionLabelView,
        ];
    }
    if (path === '/api/classify/sessions/r9/intent') {
        classifyPuts.push({
            use: 'session-intent',
            body: JSON.parse(String(init!.body)),
        });
        return [200, { ...SESSION_ROW, input: { title: '', messages: [] }, intentLabels: [] }];
    }
    return undefined;
}

let classifyPuts: { use: string; body: unknown }[] = [];
const classifyView = (use: 'failures' | 'intent' | 'themes'): ClassifyUseView => ({
    use,
    enabled: use === 'intent',
    provider: 'workspace',
    threshold: 0.8,
    perDay: 300,
    defaults: {
        enabled: false,
        provider: 'workspace',
        threshold: 0.8,
        perDay: 300,
    },
    available: true,
    version: 'workspace:tiny/p1',
    versionPassed: false,
    golden: 2,
    callsToday: 1,
    evalCallsToday: 0,
    tokensToday: 100,
    costToday: null,
    unknownCostCalls: 1,
    evaluating: false,
    lastEval: null,
    labelsVersion: 1,
    ...(use === 'intent'
        ? {
              labels: [
                  { value: 'ask', hint: 'A question.' },
                  { value: 'write', hint: 'Writing.' },
              ],
              defaultLabels: [
                  { value: 'ask', hint: 'A question.' },
                  { value: 'write', hint: 'Writing.' },
              ],
          }
        : {}),
});
const SESSION_ROW: SessionLabelRow = {
    runId: 'r9',
    threadId: 't1',
    socioId: 'd1',
    startedAt: NOW - HOUR,
    intent: {
        label: null,
        suggestion: {
            value: 'write',
            confidence: 0.86,
            provider: 'workspace',
            version: 'workspace:tiny/p1',
            applied: false,
            at: NOW,
        },
    },
    themes: {
        label: null,
        suggestion: {
            topics: ['March invoices'],
            outcome: 'resolved',
            confidence: 0.7,
            provider: 'workspace',
            version: 'workspace:tiny/p1',
            applied: false,
            at: NOW,
        },
    },
};
const themesAnswer = (): OpsThemes => ({
    status: { state: 'ready', asOf: NOW, earliest: NOW - 30 * 24 * HOUR },
    window: { ...window_, bucket: 'week' },
    sessionGapMinutes: 30,
    facts: {
        sessions: 20,
        withIntent: 15,
        withThemes: 10,
        minPeople: 3,
        weeks: [NOW - 14 * 24 * HOUR, NOW - 7 * 24 * HOUR],
        weekSessions: [4, 6],
        intents: [
            {
                intent: 'write',
                sessions: 10,
                people: 4,
                completed: 5,
                answered: 3,
                abandoned: 2,
            },
            {
                intent: null,
                sessions: 5,
                people: 3,
                completed: 0,
                answered: 4,
                abandoned: 1,
            },
        ],
        themes: [
            {
                key: 'invoice march',
                topic: 'March invoices',
                sessions: 8,
                people: 4,
                completed: 4,
                answered: 2,
                abandoned: 2,
                hints: { resolved: 3, unresolved: 1, unclear: 4 },
                weeks: [3, 5],
                intents: [
                    { intent: 'write', sessions: 6 },
                    { intent: null, sessions: 2 },
                ],
            },
        ],
        hidden: { themes: 2, sessions: 2 },
        more: 0,
    },
});

const spread = (n: number, p50: number | null, p95: number | null) => ({
    n,
    p50,
    p95,
});
const HEALTH: HealthFacts = {
    tokens: {
        byModel: [
            {
                key: 'gpt-5',
                name: null,
                turns: 9,
                input: 9000,
                output: 900,
                cached: 0,
            },
        ],
        bySocio: [],
        byPerson: [],
        byReasoning: [
            {
                kind: 'summary',
                turns: 6,
                output: 600,
                reportedTurns: 6,
                reasoning: 1200,
            },
            {
                kind: 'unknown',
                turns: 3,
                output: 300,
                reportedTurns: 0,
                reasoning: null,
            },
        ],
    },
    latency: {
        firstOutput: spread(20, 400, 2400),
        firstOutputByModel: [{ key: 'gpt-5', errors: 0, ...spread(20, 400, 2400) }],
        tools: spread(0, null, null),
        byTool: [],
    },
    queues: {
        turns: spread(5, 100, 900),
        jobWait: spread(0, null, null),
        jobWake: spread(0, null, null),
        scheduleLate: spread(4, 1000, 420_000),
    },
    schedules: {
        failing: 1,
        paused: 0,
        overdue: 0,
        ok: 3,
        stopped: 1,
        runs: 12,
        failedRuns: 2,
        lateRuns: 1,
    },
    goals: {
        stalled: 1,
        active: 2,
        done: 1,
        cancelled: 0,
        doneInRange: 1,
        cancelledInRange: 0,
    },
    longRuns: {
        running: 0,
        waiting: 0,
        deadItems: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
    },
    jobRuns: { total: 0, failed: 0 },
    coverage: [
        { id: 'trace', covered: 9, total: 9 },
        { id: 'dueAt', covered: 3, total: 12 },
    ],
    sources: [
        { source: 'agent_runs', at: Date.now() - 30_000 },
        { source: 'job_runs', at: Date.now() - 3_600_000 },
    ],
};
let healthFacts: HealthFacts | null = HEALTH;

// The list's end: tests say when it scrolls into view.
let observers: Array<{
    callback: IntersectionObserverCallback;
    nodes: Element[];
}> = [];
const scrollToEnd = () =>
    act(() => {
        for (const observer of observers) {
            observer.callback(
                observer.nodes.map((target) => ({ isIntersecting: true, target }) as never),
                observer as never,
            );
        }
    });

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
    role = 'admin';
    requests = [];
    classifyPuts = [];
    failNextPage = false;
    healthFacts = HEALTH;
    observers = [];
    settings = {
        timeZone: 'UTC',
        sessionGapMinutes: 30,
        defaults: { timeZone: 'UTC', sessionGapMinutes: 30 },
    };
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            nodes: Element[] = [];
            constructor(public callback: IntersectionObserverCallback) {
                observers.push(this);
            }
            observe(node: Element) {
                this.nodes.push(node);
            }
            disconnect() {
                observers = observers.filter((item) => item !== this);
            }
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
const where = (router: ReturnType<typeof createTestRouter>) =>
    `${router.state.location.pathname}${router.state.location.search}`;
const heading = () => host.querySelector('h1')?.textContent;
const pressed = () =>
    [...host.querySelectorAll<HTMLElement>('[aria-label="Range"] [aria-pressed="true"]')].map(
        (button) => button.textContent,
    );
const button = (name: string, within: ParentNode = host) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const rows = () => host.querySelectorAll('[data-slot="ops-turn"]').length;
const sidebar = () => host.querySelector<HTMLElement>('[data-slot="sidebar"]');

it('opens for admins from the sidebar, with the range and filters from its address', async () => {
    const router = await open('/operations?range=30d&socio=d1');
    await until(() => heading() === 'Overview', 'the Overview');
    // The secondary sidebar group lists it.
    expect(sidebar()!.querySelector('a[href="/operations"]')?.textContent).toContain('Operations');
    expect(pressed()).toEqual(['30d']);
    expect(host.querySelector('[data-slot="ops-filter"]')?.textContent).toContain('Socio: Manny');
    await until(() => host.querySelectorAll('[data-slot="ops-tile"]').length === 6, 'the tiles');
    expect(requests).toContain('GET /api/operations/overview?range=30d&socio=d1');
    const tiles = Object.fromEntries(
        [...host.querySelectorAll<HTMLElement>('[data-slot="ops-tile"]')].map((tile) => [
            tile.dataset.tile,
            tile.textContent,
        ]),
    );
    expect(tiles.turns).toBe('Turns120+20% vs the 30 days before');
    expect(tiles.failed).toBe('Failed turns3+200% vs the 30 days before');
    expect(tiles.people).toBe('Active people4Same vs the 30 days before');
    expect(tiles.messages).toContain('New');
    expect(tiles.chats).toBe('Chats with activity12');
    expect(tiles.tokens).toBe('Tokens144K+20% vs the 30 days before');
    expect(host.querySelector('[data-slot="ops-status"]')?.textContent).toBe('Data as of Oct 22, 11:59 (UTC).');
    // The section nav keeps the slice.
    const nav = host.querySelector('[aria-label="Operations"]')!;
    expect(nav.querySelector('a[href^="/operations/reliability"]')?.getAttribute('href')).toBe(
        '/operations/reliability?range=30d&socio=d1',
    );

    // A new range is a new address; the default one is left out.
    act(() => button('7d')!.click());
    await until(() => where(router) === '/operations?socio=d1', 'the 7 days');
    expect(pressed()).toEqual(['7d']);
    await until(() => requests.includes('GET /api/operations/overview?socio=d1'), 'the new answer');
    act(() => button('Clear Socio: Manny')!.click());
    await until(() => where(router) === '/operations', 'the filter cleared');
    expect(host.querySelector('[data-slot="ops-filter"]')).toBeNull();
    // Back goes to the view before.
    await act(() => router.navigate(-1));
    await until(() => where(router) === '/operations?socio=d1', 'back');

    // Custom days, then a coarser cut.
    act(() => button('Custom')!.click());
    const form = host.querySelector<HTMLFormElement>('[data-slot="ops-custom-range"]')!;
    const [from, to] = [...form.querySelectorAll('input')];
    const type = (input: HTMLInputElement, value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    type(from!, '2026-10-01');
    type(to!, '2026-10-14');
    act(() => form.requestSubmit());
    await until(() => where(router) === '/operations?from=2026-10-01&to=2026-10-14&socio=d1', 'the custom range');
    expect(pressed()).toEqual(['Custom']);

    // Another section keeps it.
    act(() => nav.querySelector<HTMLAnchorElement>('a[href^="/operations/reliability"]')!.click());
    await until(() => heading() === 'Reliability', 'Reliability');
    expect(where(router)).toBe('/operations/reliability?from=2026-10-01&to=2026-10-14&socio=d1');
    expect(host.querySelector('[data-slot="ops-failures"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="header"], [data-slot="app-header"]')?.textContent).toContain('Reliability');
    // An unknown section goes to Overview.
    await act(() => router.navigate('/operations/nowhere'));
    await until(() => where(router) === '/operations', 'Overview');
});

it('loads more turns as the list’s end scrolls in, and with Load more', async () => {
    await open('/operations');
    await until(() => rows() === 50, 'the first page');
    expect(requests).toContain('GET /api/operations/turns?limit=50');
    scrollToEnd();
    await until(() => rows() === 100, 'the second page');
    expect(requests).toContain('GET /api/operations/turns?limit=50&cursor=50');
    // A page that fails says so and is tried again from the same place.
    failNextPage = true;
    act(() => button('Load more')!.click());
    await until(() => !!host.querySelector('[data-slot="infinite-list"] [role="alert"]'), 'the error');
    expect(rows()).toBe(100);
    act(() => button('Try again')!.click());
    await until(() => rows() === TURNS, 'the last page');
    expect(requests.filter((line) => line.endsWith('cursor=100'))).toHaveLength(2);
    expect(button('Load more')).toBeUndefined();
    expect(host.querySelector('[data-slot="infinite-list"] [role="status"]')?.textContent).toBe(
        'Showing 120, all of them.',
    );
    // A socio's name narrows the view to it, and the list starts over.
    const first = host.querySelector<HTMLAnchorElement>('[data-slot="ops-turn"] a')!;
    expect(first.getAttribute('href')).toBe('/operations?socio=d1');
    act(() => first.click());
    await until(() => requests.includes('GET /api/operations/turns?socio=d1&limit=50'), 'the narrowed list');
    await until(() => rows() === 50, 'its first page');
});

it('saves the reporting time zone on its Settings page', async () => {
    settings = {
        timeZone: 'UTC',
        sessionGapMinutes: 30,
        defaults: { timeZone: 'UTC', sessionGapMinutes: 30 },
    };
    await open('/operations/settings');
    await until(() => heading() === 'Settings', 'Settings');
    expect(host.querySelector('[data-slot="ops-range-bar"]')).toBeNull();
    const input = host.querySelector<HTMLInputElement>('[data-slot="ops-time-zone-setting"] input')!;
    await until(() => input.value === 'UTC' && !input.disabled, 'the setting');
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Europe/Madrid');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('Save')!.click());
    await until(() => requests.includes('PUT /api/operations/settings'), 'the save');
    await until(() => !!button('Use the server’s (UTC)'), 'the way back to the server’s');
    expect(settings.timeZone).toBe('Europe/Madrid');
});

it('is not there for members, and its pages send them home', async () => {
    role = 'member';
    const router = await open('/operations');
    await until(() => router.state.location.pathname === '/', 'home');
    expect(sidebar()!.querySelector('a[href="/operations"]')).toBeNull();
    expect(requests).toEqual([]);
});

it('shows Health: live backups and freshness, kinds kept apart, gaps and lists', async () => {
    await open('/operations/health?range=30d');
    await until(() => heading() === 'Health', 'Health');
    await until(() => !!host.querySelector('[data-slot="ops-health-schedule"]'), 'the schedules list');
    const text = () => host.textContent ?? '';
    expect(requests).toContain('GET /api/operations/health?range=30d');
    expect(text()).toContain('Backups aren’t set up on this server.');
    // CB-321: the deployment's own numbers, read live.
    const deployment = host.querySelector('[data-slot="ops-health-deployment"]')?.textContent;
    expect(deployment).toContain('Current');
    expect(deployment).toContain('9 services');
    expect(deployment).toContain('2 without a memory limit');
    // The job runs' copy is an hour old: stale; the turns' isn't.
    const sources = [...host.querySelectorAll<HTMLElement>('[data-slot="ops-health-source"]')];
    expect(sources.map((row) => [row.textContent?.includes('Stale'), !!row.dataset.stale])).toEqual([
        [false, false],
        [true, true],
    ]);
    expect(host.querySelector('[data-stat="first-output"]')?.textContent).toContain('2.4 s');
    expect(host.querySelector('[data-slot="ops-health-schedule"]')?.textContent).toContain('Failing');
    // A short signal says why.
    const due = host.querySelector('[data-coverage="dueAt"]')!.textContent!;
    expect(due).toContain('25% · 3 of 12');
    expect(due).toContain('lateness skips them');
    expect(host.querySelector('[data-coverage="trace"]')!.textContent).not.toContain('Older');
    expect(host.querySelector('[data-slot="ops-health-chart"]')).not.toBeNull();
});

it('says Health has no numbers yet while analytics has no data, and still shows what is live', async () => {
    healthFacts = null;
    await open('/operations/health');
    await until(() => !!host.querySelector('[data-slot="ops-health-empty"]'), 'the empty state');
    expect(host.textContent).toContain('Backups aren’t set up on this server.');
    expect(host.querySelector('[data-slot="ops-health-latency"]')).toBeNull();
    expect(requests.some((line) => line.includes('/health/schedules'))).toBe(false);
});

it('shows Activity: tiles, channels, feature use, and people and chats to open', async () => {
    const router = await open('/operations/activity?range=30d');
    await until(() => heading() === 'Activity', 'Activity');
    await until(() => host.querySelectorAll('[data-slot="ops-tile"]').length === 6, 'the tiles');
    const tiles = Object.fromEntries(
        [...host.querySelectorAll('[data-slot="ops-tile"]')].map((tile) => [
            tile.getAttribute('data-tile'),
            tile.querySelector('strong')!.textContent,
        ]),
    );
    expect(tiles).toMatchObject({
        people: '4',
        stickiness: '42%',
        length: '6.5',
    });
    expect(requests).toContain('GET /api/operations/activity?range=30d');
    const sources = [...host.querySelectorAll('[data-slot="ops-source"]')];
    expect(sources.map((row) => row.textContent)).toEqual([
        expect.stringContaining('Web appPeople'),
        expect.stringContaining('ScheduleAutomation'),
    ]);
    expect(sources[0]!.querySelector('a')!.getAttribute('href')).toBe('/operations/activity?range=30d&source=web');
    expect(host.querySelector('[data-slot="ops-feature"]')!.textContent).toContain('Space pages');
    // People, last active first; a team's topic says so.
    await until(() => host.querySelectorAll('[data-slot="ops-person"]').length === 2, 'the people');
    const people = [...host.querySelectorAll('[data-slot="ops-person"]')];
    expect(people[1]!.textContent).toContain('A Telegram team');
    const bea = people[0]!.querySelector('a')!;
    expect(bea.getAttribute('href')).toBe('/operations/activity?range=30d&person=u1');
    act(() => bea.click());
    await until(() => where(router) === '/operations/activity?range=30d&person=u1', 'the person’s view');
    await until(() => requests.includes('GET /api/operations/activity?range=30d&person=u1'), 'the person’s numbers');
});

it('shows Value: outcomes, approvals, reactions, and sessions that open their chat', async () => {
    await open('/operations/value');
    await until(() => heading() === 'Value', 'Value');
    await until(() => !!host.querySelector('[data-slot="ops-outcomes"] [role="img"]'), 'the outcomes');
    expect(host.querySelector('[data-slot="ops-outcomes"] [role="img"]')!.getAttribute('aria-label')).toBe(
        'Completed 40%, Answered 50%, Abandoned 10%',
    );
    expect(host.querySelector('[data-slot="ops-approval"]')!.textContent).toContain(
        '5 asked → 3 allowed, 1 denied, 1 expired → 3 done',
    );
    expect(host.querySelector('[data-slot="ops-reactions"]')!.textContent).toContain('10 of 40 (25%)');
    await until(() => !!host.querySelector('[data-slot="ops-usefulness"]'), 'the socios');
    expect(host.querySelector('[data-slot="ops-usefulness"]')!.textContent).toContain(
        '40% completed of 30 sessions · 75% back within 7 days',
    );
    // Completion by intent (CB-199).
    const intents = host.querySelector('[data-slot="ops-value-intent-table"]')!;
    expect(intents.querySelector('[data-intent="write"]')!.textContent).toContain('Write6367%17%');
    expect(intents.textContent).toContain('No intent');
});

it('shows Themes: intents and named themes with outcomes, the floor, and the review', async () => {
    await open('/operations/themes?range=30d');
    await until(() => heading() === 'Themes', 'Themes');
    await until(() => !!host.querySelector('[data-slot="ops-theme"]'), 'the themes');
    expect(requests).toContain('GET /api/operations/themes?range=30d');
    const intents = host.querySelector('[data-slot="ops-intents"]')!.textContent!;
    expect(intents).toContain('Write');
    expect(intents).toContain('No intent');
    const theme = host.querySelector('[data-slot="ops-theme"]')!;
    expect(theme.textContent).toContain('March invoices');
    expect(theme.textContent).toContain('25%');
    expect(theme.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
        'Completed 50%, Answered 25%, Abandoned 25%',
    );
    expect(host.querySelector('[data-slot="ops-themes-hidden"]')!.textContent).toContain(
        '2 smaller themes not named: fewer than 3 people each',
    );
    // Themes is off: the page says so, with the way to Settings.
    await until(() => /Theme labels are off/.test(host.textContent ?? ''), 'the note');
    expect(host.textContent).toContain('Intent labels are on, but the model’s answers are suggestions');
    // The review: opening a session reads it on the access log, then saves.
    await until(() => !!host.querySelector('[data-slot="ops-review-item"]'), 'the review');
    expect(requests).toContain('GET /api/classify/sessions?use=intent&unreviewed=1&via=themes&limit=20');
    act(() => host.querySelector<HTMLButtonElement>('[data-slot="ops-review-item"] button')!.click());
    await until(() => !!host.querySelector('[data-slot="ops-session-label"]'), 'the session');
    expect(requests).toContain('GET /api/classify/sessions/r9?via=themes');
    expect(host.textContent).toContain('Draft the invoices email to <email>');
    act(() => button('Save intent')!.click());
    await until(() => classifyPuts.length > 0, 'the save');
    expect(classifyPuts).toEqual([{ use: 'session-intent', body: { value: 'write' } }]);
});

it('edits intent’s list on the Settings page', async () => {
    await open('/operations/settings');
    await until(() => !!host.querySelector('[data-slot="intent-labels"]'), 'the intents');
    expect(host.querySelector('[data-slot="theme-label-settings"]')).not.toBeNull();
    const list = host.querySelector('[data-slot="intent-labels"]')!;
    act(() => button('Add an intent', list)!.click());
    const inputs = [...list.querySelectorAll<HTMLInputElement>('input')];
    const type = (input: HTMLInputElement, value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    type(inputs.at(-2)!, 'Sell');
    type(inputs.at(-1)!, 'Sales work.');
    act(() => button('Save intents', list)!.click());
    await until(() => classifyPuts.length > 0, 'the save');
    expect(classifyPuts[0]).toEqual({
        use: 'intent',
        body: {
            labels: [
                { value: 'ask', hint: 'A question.' },
                { value: 'write', hint: 'Writing.' },
                { value: 'sell', hint: 'Sales work.' },
            ],
        },
    });
});

it('saves the session gap on the Settings page', async () => {
    await open('/operations/settings');
    const input = host.querySelector<HTMLInputElement>('[data-slot="ops-session-gap-setting"] input')!;
    await until(() => input.value === '30' && !input.disabled, 'the setting');
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '45');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
        host.querySelector<HTMLButtonElement>('[data-slot="ops-session-gap-setting"] button[type="submit"]')!.click(),
    );
    await until(() => settings.sessionGapMinutes === 45, 'the save');
    await until(() => !!button('Use the server’s (30 minutes)'), 'the way back to the server’s');
});
