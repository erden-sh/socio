// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FAILURE_CATEGORIES } from '@socio/shared/failure-taxonomy';
import type { CursorPage, OpsWindow } from '@socio/shared/operations/operations';
import type {
    OpsFailureRow,
    OpsReliability,
    OpsReliabilityBreakdown,
    OpsReliabilityFriction,
    OpsReliabilityIssues,
    OpsReliabilitySeries,
} from '@socio/shared/operations/operations-reliability';
import type { State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// Operations → Reliability (CB-189): the totals, the failure rate by
// category, where failures happen, recurring friction, the recent failures
// with their traces on demand, and the board.
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
const workspace = (): WorkspaceState => ({
    user: { id: 'alice', name: 'Alice', role: 'admin' },
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
const DAY = 24 * HOUR;
const window_: OpsWindow = {
    from: NOW - 7 * DAY,
    to: NOW,
    bucket: 'day',
    buckets: ['hour', 'day', 'week', 'month'],
    previous: { from: NOW - 14 * DAY, to: NOW - 7 * DAY },
    timeZone: 'UTC',
};
const status = { state: 'ready' as const, asOf: NOW - 60_000, earliest: 0 };
const FAILURES = 60;
const failure = (index: number): OpsFailureRow => ({
    runId: `r${index}`,
    threadId: 't1',
    socioId: 'd1',
    socioName: 'Manny',
    source: 'web',
    status: 'failed',
    startedAt: NOW - index * HOUR,
    finishedAt: NOW - index * HOUR + 1000,
    level: index % 3 ? 'turn' : 'tool',
    category: index % 2 ? 'quotas' : 'unclassified',
    rule: index % 2 ? 'quota_code' : 'generic_code',
    code: index % 2 ? 'chatgpt_usage_limit' : 'tool_error',
    endReason: 'error',
    model: 'gpt-5',
    tool: index % 3 ? null : 'run_query',
    toolFailures: index % 3 ? 0 : 1,
});

let requests: string[] = [];
const respond = (url: URL): [number, unknown] => {
    const path = url.pathname;
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path.startsWith('/api/operations/') || path.startsWith('/api/runs/')) {
        requests.push(`${path}${url.search}`);
    }
    if (path === '/api/operations/settings') {
        return [200, { timeZone: 'UTC', defaults: { timeZone: 'UTC' } }];
    }
    if (path === '/api/operations/reliability') {
        return [
            200,
            {
                status,
                window: window_,
                summary: {
                    turns: 200,
                    failures: 20,
                    previousTurns: 100,
                    previousFailures: 5,
                    stopped: 4,
                    interrupted: 2,
                    retries: 9,
                    retriedTurns: 6,
                    fallbacks: 1,
                    toolCalls: 300,
                    toolFailures: 12,
                    categories: FAILURE_CATEGORIES.map((category, i) => ({
                        category,
                        turns: category === 'stopped' ? 4 : i,
                        tools: category === 'unclassified' ? 5 : 0,
                    })),
                },
            } satisfies OpsReliability,
        ];
    }
    if (path === '/api/operations/reliability/series') {
        return [
            200,
            {
                status,
                window: window_,
                points: Array.from({ length: 7 }, (_, i) => ({
                    at: NOW - (7 - i) * DAY,
                    turns: i ? 20 : 0,
                    failures: i,
                    counts: FAILURE_CATEGORIES.map((_, c) => (c === 2 ? i : 0)),
                })),
            } satisfies OpsReliabilitySeries,
        ];
    }
    if (path.startsWith('/api/operations/reliability/breakdown/')) {
        const by = path.split('/').at(-1) as OpsReliabilityBreakdown['by'];
        return [
            200,
            {
                status,
                window: window_,
                by,
                rows: [
                    {
                        key: by === 'tool' ? 'http_get' : 'd1',
                        label: by === 'socio' ? 'Manny' : null,
                        total: 40,
                        failed: 10,
                        category: 'external_service',
                        code: 'failed',
                        p50Ms: 820,
                        p95Ms: 2400,
                    },
                ],
            } satisfies OpsReliabilityBreakdown,
        ];
    }
    if (path === '/api/operations/reliability/friction') {
        return [
            200,
            {
                status,
                window: window_,
                from: NOW - 7 * DAY,
                rows: [
                    {
                        category: 'quotas',
                        code: 'chatgpt_usage_limit',
                        tool: null,
                        people: 3,
                        failures: 8,
                        mostForOne: 4,
                        lastAt: NOW - HOUR,
                    },
                ],
            } satisfies OpsReliabilityFriction,
        ];
    }
    if (path === '/api/operations/reliability/issues') {
        return [
            200,
            {
                status,
                window: window_,
                issues: {
                    reported: 9,
                    resolved: 6,
                    previousReported: 4,
                    previousResolved: 3,
                    bugsReported: 5,
                    open: 11,
                    medianResolveMs: 3 * DAY,
                    p90ResolveMs: 9 * DAY,
                    failuresReported: 2,
                    medianReportMs: 2 * 3_600_000,
                    p90ReportMs: 5 * 3_600_000,
                    points: Array.from({ length: 7 }, (_, i) => ({
                        at: NOW - (7 - i) * DAY,
                        reported: i,
                        resolved: 1,
                    })),
                },
            } satisfies OpsReliabilityIssues,
        ];
    }
    if (path === '/api/operations/reliability/failures') {
        const category = url.searchParams.get('category');
        const all = Array.from({ length: FAILURES }, (_, i) => failure(i)).filter(
            (row) => !category || row.category === category,
        );
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Number(url.searchParams.get('limit'));
        const end = Math.min(all.length, start + limit);
        return [
            200,
            {
                items: all.slice(start, end),
                next: end < all.length ? String(end) : null,
            } satisfies CursorPage<OpsFailureRow>,
        ];
    }
    if (path.startsWith('/api/runs/') && path.endsWith('/trace')) {
        return [
            200,
            {
                runId: 'r1',
                status: 'failed',
                startedAt: NOW - HOUR,
                finishedAt: NOW - HOUR + 1000,
                trace: {
                    rounds: [],
                    tools: [],
                    waits: [],
                    end: { reason: 'error', rounds: 1, cap: 12 },
                },
            },
        ];
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
    requests = [];
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
            observe() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('fetch', async (input: string) => {
        const [code, body] = respond(new URL(input, 'http://app.test'));
        return new Response(JSON.stringify(body), {
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
const button = (name: string, within: ParentNode = host) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const failureRows = () => host.querySelectorAll('[data-slot="ops-failure"]').length;

it('shows what fails and why, and opens a failure’s trace on demand', async () => {
    const router = createTestRouter('/operations/reliability?range=30d');
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => host.querySelectorAll('[data-slot="ops-tile"]').length >= 6, 'the tiles');
    const tiles = Object.fromEntries(
        [...host.querySelectorAll<HTMLElement>('[data-slot="ops-tile"]')].map((tile) => [
            tile.dataset.tile,
            tile.textContent,
        ]),
    );
    // 10% now against 5% before: worse, in points.
    expect(tiles['failure-rate']).toBe('Failure rate10%+5.0 pts vs the period before');
    expect(tiles.interrupted).toContain('2');
    expect(tiles.stopped).toBe('Stopped4By a person or an operator: not failures');
    expect(tiles.retries).toBe('Retries and fallbacks9in 6 turns · 1 moved to the shared model');
    // Every category, Unclassified on its own; interrupted beside runtime.
    await until(() => host.querySelectorAll('[data-slot="ops-category"]').length === 9, 'the categories');
    const category = (id: string) =>
        host.querySelector(`[data-slot="ops-category"][data-category="${id}"]`)!.textContent;
    expect(category('unclassified')).toContain('8 turns · 5 tool calls');
    expect(category('runtime_error')).toContain('2 interrupted');
    // Tools with their latency.
    await until(() => !!host.querySelector('[data-slot="ops-breakdown-row"]'), 'the tools');
    expect(host.querySelector('[data-slot="ops-breakdown-row"]')!.textContent).toContain(
        '10 of 40 failed (25%) · p50 820 ms · p95 2.4 s',
    );
    expect(host.querySelector('[data-slot="ops-friction-row"]')!.textContent).toContain(
        '3 people · 8 times (most for one: 4)',
    );
    await until(() => !!host.querySelector('[data-slot="ops-issues"] [data-tile="resolve-time"]'), 'the board');
    expect(host.querySelector('[data-slot="ops-issues"] [data-tile="resolve-time"]')!.textContent).toBe(
        'Time to resolve3.0 daysMedian · 90% within 9.0 days',
    );
    // Failure to report (CB-194): failed turns filed about from Runs.
    expect(host.querySelector('[data-slot="ops-issues"] [data-tile="report-time"]')!.textContent).toBe(
        'Time to report2 hMedian · 2 failed turns filed from Runs · 90% within 5 h',
    );

    // The recent failures, a page at a time; one opens its trace.
    await until(() => failureRows() === 50, 'the first page');
    expect(requests).toContain('/api/operations/reliability/failures?range=30d&limit=50');
    expect(requests.some((line) => line.startsWith('/api/runs/'))).toBe(false);
    const first = host.querySelector<HTMLButtonElement>('[data-slot="ops-failure"] button[aria-expanded]')!;
    act(() => first.click());
    await until(() => !!host.querySelector('[data-slot="ops-failure"] [data-slot="run-timeline"]'), 'the trace');
    // Opened from here, for the access log's entry (CB-188).
    expect(requests).toContain('/api/runs/r0/trace?via=reliability');

    // A category narrows the list through the address.
    act(() => button('Show', host.querySelector('[data-slot="ops-category"][data-category="quotas"]')!)!.click());
    await until(
        () =>
            router.state.location.search === '?range=30d&category=quotas' &&
            requests.includes('/api/operations/reliability/failures?range=30d&category=quotas&limit=50'),
        'the narrowed list',
    );
    await until(() => failureRows() === 30, 'the quotas');
    act(() => button('Show every failure, not only Quotas and limits')!.click());
    await until(() => router.state.location.search === '?range=30d', 'the filter cleared');
});
