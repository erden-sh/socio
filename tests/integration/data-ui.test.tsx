// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ApprovalView, ApprovalsState } from '@socio/shared/approvals';
import type { DataSpaceState, DatasetView, RowsPage, SharedAreaView } from '@socio/shared/data-types';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from '../../packages/client/tests/helpers/app-router';
import { DEFAULT_DATA_LIMITS } from '../../src/server/dataspace/contract';

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
const users = {
    alice: { id: 'alice', name: 'Alice', role: 'admin' as Role },
    bob: { id: 'bob', name: 'Bob', role: 'member' as Role },
};
let me: keyof typeof users = 'bob';
const workspace = (): WorkspaceState => ({
    user: users[me],
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
const dataset = (extra: Partial<DatasetView> = {}): DatasetView => ({
    id: 'ds1',
    name: 'Dot scratch',
    description: 'Dot’s working data.',
    kind: 'scratch',
    ownerUserId: 'bob',
    createdByDotId: 'd1',
    scratchForDotId: 'd1',
    dotName: 'Dot',
    fromDeletedDot: false,
    sharedSpaceId: null,
    retentionDays: null,
    sizeBytes: 8192,
    tableCount: 1,
    createdAt: 1,
    updatedAt: 1,
    access: 'owner',
    ...extra,
});
const usage = {
    userId: 'bob',
    datasets: 1,
    datasetBytes: 8192,
    files: 0,
    fileBytes: 0,
    totalBytes: 8192,
};
let approval: ApprovalView;
let calls: Array<{ method: string; path: string; body?: unknown }> = [];
let datasets: DatasetView[] = [];
let shared: SharedAreaView[] = [];

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
    if (path === '/api/data') {
        return [
            200,
            {
                datasets,
                shared,
                grants: [],
                files: [],
                usage: {
                    limits: DEFAULT_DATA_LIMITS,
                    own: usage,
                    ...(users[me].role === 'admin'
                        ? {
                              all: [
                                  {
                                      ...usage,
                                      userName: 'Bob',
                                      deletedDatasets: 1,
                                      deletedFiles: 2,
                                      deletedBytes: 3 * 1048576,
                                  },
                              ],
                          }
                        : {}),
                },
            } satisfies DataSpaceState,
        ];
    }
    if (path === '/api/data/datasets/ds1') {
        return [
            200,
            {
                dataset: datasets[0],
                tables: [
                    {
                        name: 'prices',
                        rowCount: 120,
                        columns: [
                            {
                                name: 'sku',
                                type: 'TEXT',
                                notNull: false,
                                primaryKey: true,
                                defaultValue: null,
                            },
                            {
                                name: 'region',
                                type: 'TEXT',
                                notNull: false,
                                primaryKey: false,
                                defaultValue: null,
                            },
                        ],
                        indexes: [
                            { name: 'prices_by_region', columns: ['region', 'sku'], unique: false },
                            { name: 'prices_region_u', columns: ['region'], unique: true },
                        ],
                    },
                ],
            },
        ];
    }
    if (path === '/api/data/datasets/ds1/tables/prices/rows') {
        const offset = Number(url.searchParams.get('offset'));
        return [
            200,
            {
                table: 'prices',
                offset,
                limit: 50,
                total: 120,
                columns: ['sku'],
                rows: Array.from({ length: Math.min(50, 120 - offset) }, (_, i) => [`sku-${offset + i}`]),
                truncated: offset + 50 < 120,
                ms: 1,
            } satisfies RowsPage,
        ];
    }
    if (path === '/api/data/datasets/ds1/query') {
        return [
            200,
            {
                columns: ['n'],
                rows: [[120]],
                truncated: false,
                ms: 2,
                dataset: 'Dot scratch',
            },
        ];
    }
    if (path === '/api/data/shared/d1/files' && method === 'DELETE') {
        shared[0].files = [];
        return [200, { ok: true }];
    }
    if (path === '/api/data/audit') {
        return [200, []];
    }
    if (path === '/api/approvals') {
        return [
            200,
            {
                capabilities: [
                    {
                        id: 'data.create_dataset',
                        label: 'Create datasets',
                        description: 'A new dataset.',
                    },
                    {
                        id: 'grant.change',
                        label: 'Change grants',
                        description: 'Access.',
                    },
                ],
                pending: approval.status === 'pending' ? [approval] : [],
                recent: approval.status === 'pending' ? [] : [approval],
                policies: [],
                audit: [],
            } satisfies ApprovalsState,
        ];
    }
    if (path === '/api/approvals/policies') {
        return [200, body];
    }
    if (path === `/api/approvals/${approval.id}/decision`) {
        approval = {
            ...approval,
            status: body.decision === 'approve' ? 'approved' : 'denied',
            decidedVia: 'user',
            outcome: body.decision === 'approve' ? 'Created dataset “Watchlist”.' : null,
        };
        return [200, approval];
    }
    if (path === `/api/approvals/${approval.id}`) {
        return [200, approval];
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
    me = 'bob';
    calls = [];
    datasets = [dataset()];
    shared = [];
    approval = {
        id: 'ap1',
        dotId: 'd1',
        dotName: 'Dot',
        capability: 'data.create_dataset',
        capabilityLabel: 'Create datasets',
        summary: 'Dot wants to create a dataset “Watchlist”',
        details: ['Shares to watch'],
        status: 'pending',
        decidedVia: null,
        createdAt: 1,
        expiresAt: Date.now() + 86_400_000,
        decidedAt: null,
        outcome: null,
    };
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
const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const click = (element: HTMLElement | undefined) =>
    act(() => {
        element!.click();
    });
const tab = (name: string) =>
    act(() => {
        const trigger = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
            (item) => item.textContent === name,
        )!;
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        trigger.click();
    });

it('lists the user’s datasets, and shows everyone’s usage to admins only', async () => {
    await open('/data');
    await until(() => !!host.querySelector('[data-dataset="Dot scratch"]'), 'the datasets');
    expect(text()).toContain('Scratch · Dot');
    tab('Usage');
    await until(() => text().includes('Your usage'), 'the usage tab');
    expect(host.querySelector('[data-slot="data-usage-all"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    me = 'alice';
    await open('/data?tab=usage');
    await until(() => !!host.querySelector('[data-slot="data-usage-all"]'), 'everyone’s usage');
    const all = host.querySelector('[data-slot="data-usage-all"]')!;
    expect(all.textContent).toContain('Bob');
    // CB-64: what they deleted is kept, and shown apart from their usage.
    expect(all.textContent).toContain('Deleted, kept');
    expect(all.textContent).toContain('3 MB');
});

it('points the Files tab to Media', async () => {
    await open('/data?tab=files');
    await until(() => !!host.querySelector('[data-slot="data-files-moved"]'), 'the files card');
    const card = host.querySelector('[data-slot="data-files-moved"]')!;
    expect(card.textContent).toContain('Files and chat attachments are in Media');
    expect(card.querySelector('a')!.getAttribute('href')).toBe('/media');
});

it('browses a table a page at a time and runs a read-only query', async () => {
    await open('/data/datasets/ds1');
    await until(() => text().includes('sku-0'), 'the first page of rows');
    expect(host.querySelector('[data-slot="rows-range"]')!.textContent).toBe('1–50 of 120');
    click(button('Next'));
    await until(() => text().includes('sku-50'), 'the second page');
    expect(calls.some((call) => call.path.includes('offset=50'))).toBe(true);
    const sql = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL query"]')!;
    expect(sql.value).toBe('SELECT * FROM "prices" LIMIT 20');
    click(button('Run query'));
    await until(() => !!host.querySelector('table[aria-label="Query result"]'), 'the result');
    expect(calls.find((call) => call.path === '/api/data/datasets/ds1/query')?.body).toEqual({
        sql: 'SELECT * FROM "prices" LIMIT 20',
    });
    expect(button('Delete')).toBeDefined();
    expect(host.querySelector('[data-slot="dataset-retention"]')).not.toBeNull();
});

it('lists the selected table’s indexes, read-only (CB-355)', async () => {
    await open('/data/datasets/ds1');
    await until(() => text().includes('sku-0'), 'the first page of rows');
    const list = host.querySelector('ul[aria-label="Indexes of prices"]')!;
    expect(list).not.toBeNull();
    expect([...list.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
        'prices_by_region on region, sku',
        'prices_region_u on region (unique)',
    ]);
    // Read-only: nothing to add or drop an index with.
    expect(list.querySelector('button, input, a')).toBeNull();
    expect(calls.some((call) => call.path.includes('/indexes'))).toBe(false);
});

// jsdom has no layout: this pins the classes that keep the page inside a
// phone (CB-162); the `mobile-fit` smoke scenario measures it for real.
it('keeps the dataset page inside a narrow screen', async () => {
    await open('/data/datasets/ds1');
    await until(() => text().includes('sku-0'), 'the first page of rows');
    const cards = host.querySelector('[data-slot="dataset-page"] > [data-page-body] > .grid')!;
    expect(cards.className).toContain('grid-cols-[minmax(0,1fr)]');
    const settings = host.querySelector('[data-slot="dataset-retention"]')!.closest('[data-slot="card-content"]')!;
    expect(settings.className).toMatch(/(^| )grid( |$)/);
    expect(settings.className).toContain('sm:flex');
    const chip = host.querySelector('[role="tab"]')!;
    expect(chip.className).toContain('whitespace-normal');
    expect(host.querySelector('table[aria-label="Rows of prices"]')!.parentElement!.className).toContain(
        'overflow-x-auto',
    );
});

it('shows a dataset shared by someone else read-only', async () => {
    datasets = [
        dataset({
            access: 'read',
            ownerUserId: 'alice',
            ownerName: 'Alice',
            kind: 'dataset',
            sharedSpaceId: 's1',
        }),
    ];
    await open('/data/datasets/ds1');
    await until(() => text().includes('Shared by Alice'), 'the shared dataset');
    expect(button('Delete')).toBeUndefined();
    expect(host.querySelector('[data-slot="dataset-retention"]')).toBeNull();
    expect(text()).toContain('Export SQLite');
});

it('approves a pending request and sets a bypass policy per Dot', async () => {
    await open('/approvals');
    await until(() => !!host.querySelector('[data-slot="approval-card"]'), 'the pending request');
    expect(text()).toContain('Dot wants to create a dataset “Watchlist”');
    click(button('Approve'));
    await until(() => text().includes('Created dataset “Watchlist”.'), 'the outcome');
    expect(calls.find((call) => call.path === '/api/approvals/ap1/decision')?.body).toEqual({ decision: 'approve' });
    act(() => {
        const select = host.querySelector<HTMLSelectElement>(
            'select[aria-label="Approval policy for Create datasets"]',
        )!;
        select.value = 'bypass';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => calls.some((call) => call.path === '/api/approvals/policies'), 'the policy');
    expect(calls.find((call) => call.path === '/api/approvals/policies')?.body).toEqual({
        dotId: 'd1',
        capability: 'data.create_dataset',
        policy: 'bypass',
    });
});

it('opens one request from its link and denies it', async () => {
    await open('/approvals/ap1');
    await until(() => !!button('Deny'), 'the request');
    click(button('Deny'));
    await until(
        () => host.querySelector('[data-slot="approval-card"]')?.getAttribute('data-status') === 'denied',
        'denied',
    );
    expect(button('Approve')).toBeUndefined();
});

it('browses company shared data and confirms deletion for everyone', async () => {
    shared = [
        {
            dotId: 'd1',
            dotName: 'Manny',
            archived: false,
            dataset: null,
            files: [
                {
                    path: 'report.txt',
                    size: 24,
                    mediaType: 'text/plain',
                    updatedAt: 1,
                    added: { by: 'Alice', via: 'computer', at: 1 },
                },
            ],
            totalBytes: 24,
            retentionDays: 0,
        },
    ];
    await open('/data?tab=shared');
    await until(() => text().includes('report.txt'), 'shared report');
    expect(text()).toContain('Alice');
    expect(text()).toContain('Kept until someone deletes them.');
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe(
        '/api/data/shared/d1/files/raw?path=report.txt',
    );
    click(button('Delete file'));
    expect(document.body.textContent).toContain('for everyone who uses this socio');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    click(button('Cancel'));
    expect(text()).toContain('report.txt');
    click(button('Delete file'));
    click(button('Delete'));
    await until(() => !text().includes('report.txt'), 'removed shared file');
    expect(calls).toContainEqual({
        method: 'DELETE',
        path: '/api/data/shared/d1/files?path=report.txt',
        body: undefined,
    });
});
