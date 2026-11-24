// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CursorPage, OperationsSettingsView, OpsWindow } from '@socio/shared/operations/operations';
import type { OpsGroundingView } from '@socio/shared/operations/operations-grounding';
import type {
    OpsCapabilitiesView,
    OpsDatasetRow,
    OpsKnowledgeView,
    OpsPageRow,
    OpsRequestRow,
    OpsStorageView,
} from '@socio/shared/operations/operations-knowledge';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// Operations → Knowledge and Capabilities (CB-191): Spaces and pages,
// search, dataset access, storage and limits; the coverage matrix and
// capability requests.
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
const DAY = 24 * HOUR;
const status = { state: 'ready' as const, asOf: NOW - 60_000, earliest: 0 };
const page = (index: number): OpsPageRow => ({
    pageId: `p${index}`,
    spaceId: 's1',
    spaceName: 'Everyday',
    title: `Page ${index}`,
    chars: 1200,
    revision: 2,
    edits: index % 3,
    createdAt: NOW - 300 * DAY,
    updatedAt: NOW - (200 - index) * DAY,
    usedAt: null,
    activeAt: NOW - (200 - index) * DAY,
    stale: 200 - index > 90,
});
const knowledge: OpsKnowledgeView = {
    status,
    window: window_,
    knowledge: {
        spaces: [
            {
                spaceId: 's1',
                name: 'Everyday',
                pages: 70,
                chars: 84_000,
                created: 4,
                edits: 12,
                stale: 30,
            },
            {
                spaceId: 's2',
                name: 'Sales',
                pages: 0,
                chars: 0,
                created: 0,
                edits: 1,
                stale: 0,
            },
        ],
        totals: {
            pages: 70,
            chars: 84_000,
            created: 4,
            edits: 13,
            stale: 30,
            editors: 3,
        },
        search: {
            queries: 40,
            empty: 6,
            corrected: 1,
            trigram: 2,
            p50: 1.2,
            p95: 8.4,
            maxMs: 20,
            days: [
                { at: NOW - 2 * DAY, queries: 15, empty: 2 },
                { at: NOW - DAY, queries: 25, empty: 4 },
            ],
        },
        access: {
            total: 9,
            denied: 2,
            errors: 0,
            datasets: 2,
            chats: 3,
            actions: [
                { action: 'query', outcome: 'ok', count: 7 },
                { action: 'query', outcome: 'denied', count: 2 },
            ],
            actors: [{ kind: 'dot', count: 9 }],
        },
    },
};
const storage: OpsStorageView = {
    status,
    window: window_,
    storage: {
        kinds: [
            {
                kind: 'datasets',
                items: 3,
                bytes: 40 * 1024 * 1024,
                deletedItems: 1,
                deletedBytes: 1024,
            },
            {
                kind: 'history',
                items: 1,
                bytes: 1024 * 1024,
                deletedItems: 0,
                deletedBytes: 0,
            },
            {
                kind: 'files',
                items: 10,
                bytes: 5 * 1024 * 1024,
                deletedItems: 2,
                deletedBytes: 2048,
            },
            {
                kind: 'attachments',
                items: 4,
                bytes: 1024 * 1024,
                deletedItems: 0,
                deletedBytes: 0,
            },
            {
                kind: 'apps',
                items: 2,
                bytes: 300_000,
                deletedItems: 0,
                deletedBytes: 0,
            },
        ],
        database: {
            bytes: 80 * 1024 * 1024,
            freeBytes: 0,
            agentRunsBytes: 60 * 1024 * 1024,
            measuredAt: NOW,
        },
        series: ['datasets', 'history', 'files', 'attachments', 'apps'].map((kind) => ({
            kind: kind as 'datasets',
            points: Array.from({ length: 7 }, (_, index) => ({
                at: NOW - (7 - index) * DAY,
                value: index * 1024 * 1024,
            })),
        })),
        owners: [{ bytes: 45 * 1024 * 1024, datasets: 3 }],
        largestDatasetBytes: 30 * 1024 * 1024,
        largestFileBytes: 1024 * 1024,
    },
    quotas: [
        {
            key: 'dataUserMaxMb',
            label: 'Data per person',
            limit: 50,
            unit: 'MB',
            highest: 45,
            near: 1,
            at: 0,
        },
        {
            key: 'dataMaxDatasets',
            label: 'Datasets per person',
            limit: 50,
            unit: 'datasets',
            highest: 3,
            near: 0,
            at: 0,
        },
        {
            key: 'dataDatasetMaxMb',
            label: 'Largest dataset',
            limit: 100,
            unit: 'MB',
            highest: 30,
            near: null,
            at: null,
        },
        {
            key: 'dataFileMaxMb',
            label: 'Largest file',
            limit: 25,
            unit: 'MB',
            highest: 1,
            near: null,
            at: null,
        },
    ],
};
const capabilities: OpsCapabilitiesView = {
    status,
    window: window_,
    coverage: {
        modules: [
            { id: 'platform', tools: 1, listed: true },
            { id: 'spaces', tools: 1, listed: true },
            { id: 'skills', tools: 1, listed: true },
            { id: 'runs', tools: 0, listed: true },
        ],
        capabilities: [
            {
                id: 'pages',
                label: 'Space pages',
                tools: 1,
                offered: 1,
                approvals: [],
            },
            {
                id: 'computer',
                label: 'Computer',
                tools: 1,
                offered: 0,
                approvals: [],
            },
        ],
        tools: [
            {
                name: 'capabilities',
                module: 'platform',
                capability: null,
                offered: true,
                calls: 2,
                errors: 0,
            },
            {
                name: 'computer_screenshot',
                module: null,
                capability: 'computer',
                offered: false,
                calls: 0,
                errors: 0,
            },
            {
                name: 'end_skill',
                module: 'skills',
                capability: null,
                offered: true,
                calls: 0,
                errors: 0,
            },
            {
                name: 'read_space_page',
                module: 'spaces',
                capability: 'pages',
                offered: true,
                calls: 12,
                errors: 1,
            },
        ],
        unregistered: ['end_skill'],
        unoffered: ['computer_screenshot'],
    },
};
const request = (index: number): OpsRequestRow => ({
    issueId: `i${index}`,
    number: 100 + index,
    title: `Send email ${index}`,
    status: 'open',
    capability: `Send email ${index}`,
    createdAt: NOW - 9 * DAY,
    requesters: 2,
    socios: 1,
    people: 2,
    lastAt: NOW - index * HOUR,
});
const dataset: OpsDatasetRow = {
    datasetId: 'ds1',
    name: 'Prices',
    scratch: false,
    sizeBytes: 30 * 1024 * 1024,
    historyBytes: 1024,
    tables: 3,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    accesses: 7,
    denied: 2,
    lastAccessAt: NOW - HOUR,
};
const PAGES = 70;
const paged = <T,>(url: URL, total: number, make: (index: number) => T): CursorPage<T> => {
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const end = Math.min(total, start + Number(url.searchParams.get('limit')));
    return {
        items: Array.from({ length: end - start }, (_, i) => make(start + i)),
        next: end < total ? String(end) : null,
    };
};

// What grounded chats (CB-194): two Spaces over a week, by day.
const days = Array.from({ length: 7 }, (_, i) => NOW - (7 - i) * DAY);
const grounding: OpsGroundingView = {
    status: { state: 'ready', asOf: NOW, earliest: NOW - 40 * DAY },
    window: window_,
    grounding: {
        runs: 12,
        chats: 5,
        kinds: [
            { kind: 'page', refs: 9, runs: 7 },
            { kind: 'search', refs: 14, runs: 6 },
            { kind: 'context', refs: 3, runs: 3 },
            { kind: 'dataset', refs: 4, runs: 2 },
            { kind: 'recall', refs: 2, runs: 1 },
        ],
        buckets: days,
        spaces: [
            { spaceId: 's1', name: 'Everyday', reads: 11, pages: 4, chats: 4 },
            { spaceId: 'gone', name: null, reads: 2, pages: 1, chats: 1 },
        ],
        cells: [
            { spaceId: 's1', at: days[1]!, reads: 1 },
            { spaceId: 's1', at: days[5]!, reads: 10 },
            { spaceId: 'gone', at: days[5]!, reads: 2 },
        ],
        pages: [
            {
                pageId: 'p1',
                spaceId: 's1',
                spaceName: 'Everyday',
                title: 'Pricing policy',
                reads: 6,
                chats: 4,
                lastAt: NOW - HOUR,
            },
            {
                pageId: 'p-gone',
                spaceId: null,
                spaceName: null,
                title: null,
                reads: 1,
                chats: 1,
                lastAt: NOW - DAY,
            },
        ],
    },
};

let requests: string[] = [];
let settings: OperationsSettingsView;
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
    }
    if (path === '/api/data/shared') {
        return [200, []];
    }
    if (path === '/api/operations/settings') {
        return [200, settings];
    }
    if (path === '/api/operations/knowledge') {
        return [200, knowledge];
    }
    if (path === '/api/operations/storage') {
        return [200, storage];
    }
    if (path === '/api/operations/capabilities') {
        return [200, capabilities];
    }
    if (path === '/api/operations/knowledge/grounding') {
        return [200, grounding];
    }
    if (path === '/api/operations/knowledge/pages') {
        return [200, paged(url, PAGES, page)];
    }
    if (path === '/api/operations/knowledge/datasets') {
        return [200, paged(url, 1, () => dataset)];
    }
    if (path === '/api/operations/capabilities/requests') {
        return [200, paged(url, 3, request)];
    }
    return [404, { error: 'Not found.' }];
};

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

const text = () => host.textContent ?? '';
const slot = (name: string) => host.querySelector<HTMLElement>(`[data-slot="${name}"]`);

it('shows Spaces, pages stalest first, search, dataset access, storage and the limits', async () => {
    const router = await open('/operations/knowledge?range=30d');
    await until(() => heading() === 'Knowledge', 'Knowledge');
    await until(() => !!slot('ops-spaces-table'), 'the Spaces');
    expect(
        [...host.querySelectorAll('[data-slot="ops-tile"]')].slice(0, 8).map((tile) => tile.getAttribute('data-tile')),
    ).toEqual(['pages', 'chars', 'edits', 'stale', 'searches', 'search-p95', 'access', 'denied']);
    expect(slot('ops-spaces-table')!.textContent).toContain('Everyday');
    // Every answer follows the range in the address.
    expect(requests).toEqual(
        expect.arrayContaining([
            'GET /api/operations/knowledge?range=30d',
            'GET /api/operations/storage?range=30d',
            'GET /api/operations/knowledge/pages?range=30d&limit=50',
            'GET /api/operations/knowledge/datasets?range=30d&limit=50',
        ]),
    );
    await until(() => host.querySelectorAll('[data-slot="ops-page"]').length === 50, 'pages');
    expect(slot('ops-page')!.textContent).toContain('Stale');
    scrollToEnd();
    await until(() => host.querySelectorAll('[data-slot="ops-page"]').length === PAGES, 'more pages');
    expect(slot('ops-access-table')!.textContent).toContain('denied');
    await until(() => !!slot('ops-dataset'), 'the datasets');
    expect(slot('ops-dataset')!.textContent).toContain('Prices');
    expect(slot('ops-storage')!.textContent).toContain('60 MB chat history');
    expect(
        [...slot('ops-quotas-table')!.querySelectorAll('[data-quota]')].map((row) => row.getAttribute('data-quota')),
    ).toEqual(['dataUserMaxMb', 'dataMaxDatasets', 'dataDatasetMaxMb', 'dataFileMaxMb']);
    // A Space narrows the page to it, as a shareable link.
    act(() => slot('ops-spaces-table')!.querySelector<HTMLAnchorElement>('[data-space="s1"] a')!.click());
    await until(() => where(router) === '/operations/knowledge?range=30d&space=s1', 'the Space');
    await until(() => requests.includes('GET /api/operations/knowledge?range=30d&space=s1'), 'the Space’s numbers');
    expect(text()).toContain('Show every Space');
});

it('shows the coverage matrix, its gaps first, and capability requests', async () => {
    await open('/operations/capabilities');
    await until(() => heading() === 'Capabilities', 'Capabilities');
    await until(() => !!slot('ops-coverage-table'), 'the matrix');
    const tools = [...slot('ops-coverage-table')!.querySelectorAll('[data-tool]')].map((row) =>
        row.getAttribute('data-tool'),
    );
    // Tools no entry declares come first.
    expect(tools.slice(0, 2)).toEqual(['capabilities', 'end_skill']);
    expect(slot('ops-gaps')!.textContent).toContain('end_skill');
    expect(slot('ops-gaps')!.textContent).toContain('computer_screenshot');
    expect(slot('ops-gaps')!.textContent).toContain('runs');
    await until(() => host.querySelectorAll('[data-slot="ops-request"]').length === 3, 'requests');
    expect(slot('ops-request')!.textContent).toContain('CB-100');
    // Requests don't follow the range: demand builds up.
    expect(requests).toContain('GET /api/operations/capabilities/requests?limit=50');
});

it('maps what grounded chats by Space and day, and lists the pages read most (CB-194)', async () => {
    const router = await open('/operations/knowledge?range=30d');
    await until(() => !!slot('ops-grounding-heatmap'), 'the heatmap');
    expect(requests).toContain('GET /api/operations/knowledge/grounding?range=30d');
    const map = slot('ops-grounding-heatmap')!;
    // A row per Space, a column per day, each cell shaded by its reads and
    // labeled for screen readers and on hover.
    const rows = [...map.querySelectorAll('tbody tr')];
    expect(rows.map((row) => row.getAttribute('data-space'))).toEqual(['s1', 'gone']);
    expect(rows[1]!.textContent).toContain('A removed Space');
    const cells = [...rows[0]!.querySelectorAll<HTMLElement>('td[data-reads]')];
    expect(cells).toHaveLength(7);
    expect(cells.map((cell) => cell.dataset.reads)).toEqual(['0', '1', '0', '0', '0', '10', '0']);
    expect(cells[5]!.title).toContain('Everyday');
    expect(cells[5]!.title).toContain('10 reads');
    expect(cells[5]!.style.background).toContain('chart-1');
    expect(cells[0]!.style.background).toBe('');
    // Every kind is counted, recalls and datasets included.
    expect(slot('ops-grounding-kinds')!.textContent).toContain('Recalls of the chat');
    expect(slot('ops-grounding-kinds')!.textContent).toContain('Dataset queries');
    const pages = slot('ops-grounding-pages')!.textContent;
    expect(pages).toContain('Pricing policy');
    expect(pages).toContain('A removed page');
    // A Space's name narrows Knowledge to it.
    act(() => rows[0]!.querySelector<HTMLAnchorElement>('th a')!.click());
    await until(() => where(router) === '/operations/knowledge?range=30d&space=s1', 'the Space');
});
