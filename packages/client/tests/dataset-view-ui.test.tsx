// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DatasetView } from '@socio/shared/data-types';
import { VIEW_NO_ACCESS, type ViewQueryResult } from '@socio/shared/dataset-view';

import { niceTicks } from '../src/components/charts/scale';
import RichEditor from '../src/modules/pages/editor/RichEditor';
import { blocks } from '../src/modules/pages/editor/slash-commands';
import { DatasetViewDisplay } from '../src/views/DatasetViewDisplay';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    // ProseMirror measures; jsdom has no layout.
    Range.prototype.getClientRects = () =>
        ({
            length: 0,
            item: () => null,
            [Symbol.iterator]: [][Symbol.iterator],
        }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    document.elementFromPoint = () => null;
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
const render = async (node: React.ReactNode) => {
    root = createRoot(host);
    await act(async () => root!.render(node));
};
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const text = () => host.textContent ?? '';

const result = (rows: ViewQueryResult['rows'], patch: Partial<ViewQueryResult> = {}): ViewQueryResult => ({
    columns: ['month', 'total'],
    rows,
    truncated: false,
    ms: 1,
    maxRows: 500,
    dataset: { id: 'd1', name: 'Sales', owned: true, sharedHere: true },
    cached: false,
    at: Date.now(),
    ...patch,
});
const months = (n: number) => Array.from({ length: n }, (_, i) => [`m${i + 1}`, (i + 1) * 10]);

it('pages a table, with column headers and numbers right-aligned', async () => {
    await render(<DatasetViewDisplay result={result(months(30))} display="table" title="Sales" />);
    const table = host.querySelector('table[aria-label="Sales"]')!;
    expect([...table.querySelectorAll('th')].map((th) => [th.textContent, th.className])).toEqual([
        ['month', ''],
        ['total', 'numeric'],
    ]);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(25);
    expect(host.querySelector('[data-slot="view-rows-range"]')!.textContent).toBe('1–25 of 30');
    const next = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Next')!;
    await act(async () => next.click());
    expect(table.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(host.querySelector('[data-slot="view-rows-range"]')!.textContent).toBe('26–30 of 30');
    expect(next.disabled).toBe(true);
});

it('draws bar and line charts, and says why it can’t', async () => {
    await render(<DatasetViewDisplay result={result(months(4))} display="bar" x="month" y="total" title="Sales" />);
    const bars = host.querySelector('svg[data-chart="bar"]')!;
    expect(bars.getAttribute('role')).toBe('img');
    expect(bars.getAttribute('aria-label')).toMatch(/^Sales: Bar chart of total by month, 4 points/);
    expect(bars.querySelectorAll('.marks path')).toHaveLength(4);
    // Keyboard: arrows move the readout along the points.
    await act(async () => bars.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(host.querySelector('.series-chart-tooltip')!.textContent).toBe('10m1');
    act(() => root!.unmount());
    await render(
        <DatasetViewDisplay result={result([...months(3), ['m4', null]], { truncated: true })} display="line" />,
    );
    const line = host.querySelector('svg[data-chart="line"]')!;
    expect(line.querySelector('path.line')!.getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+L[\d.]+,[\d.]+$/);
    expect(line.querySelectorAll('circle')).toHaveLength(3);
    expect(host.querySelector('[data-slot="view-truncated"]')!.textContent).toMatch(/views stop at 500 rows/);
    act(() => root!.unmount());
    await render(<DatasetViewDisplay result={result(months(2))} display="bar" y="price" />);
    expect(text()).toMatch(/no column “price”.*It returns month, total/);
    act(() => root!.unmount());
    await render(<DatasetViewDisplay result={result([['a', 'x']])} display="line" y="total" />);
    expect(text()).toMatch(/Column “total” has no numbers/);
    act(() => root!.unmount());
    await render(<DatasetViewDisplay result={result([])} display="bar" />);
    expect(text()).toBe('The query returned no rows.');
    expect(niceTicks(0, 160)).toEqual([0, 50, 100, 150, 200]);
    expect(niceTicks(-3, 7)).toEqual([-4, -2, 0, 2, 4, 6, 8]);
});

const page = { spaceId: 's1', pageId: 'p1' };
const content = (spec: Record<string, unknown>) => `# Report\n\n\`\`\`dataset-view\n${JSON.stringify(spec)}\n\`\`\`\n`;
type Reply = { status: number; body: unknown } | Promise<never>;
function stubFetch(views: () => Reply, datasets: DatasetView[] = []) {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const path = String(url);
            calls.push({
                path,
                body: init?.body ? JSON.parse(String(init.body)) : undefined,
            });
            const reply = path === '/api/data/views/query' ? await views() : { status: 200, body: datasets };
            return new Response(JSON.stringify(reply.body), {
                status: reply.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }),
    );
    return calls;
}
const editor = async (value: string, onChange = vi.fn()) => {
    await render(<RichEditor value={value} onChange={onChange} onNotice={() => {}} page={page} />);
    await flush();
    await flush();
    return onChange;
};

it('loads a view block for the viewer: loading, data, then a refresh', async () => {
    let release!: (value: Reply) => void;
    const calls = stubFetch(
        () =>
            new Promise((resolve) => {
                release = resolve as never;
            }) as never,
    );
    await editor(
        content({
            datasetId: 'd1',
            query: 'SELECT month, total FROM sales',
            display: 'table',
        }),
    );
    const block = host.querySelector('[data-slot="dataset-view"]')!;
    expect(block).toBeTruthy();
    expect(block.getAttribute('contenteditable')).toBe('false');
    expect(block.querySelector('[data-state="loading"]')).toBeTruthy();
    expect(calls[0]).toEqual({
        path: '/api/data/views/query',
        body: {
            spaceId: 's1',
            pageId: 'p1',
            datasetId: 'd1',
            query: 'SELECT month, total FROM sales',
        },
    });
    await act(async () => release({ status: 200, body: result(months(3)) }));
    await flush();
    expect(block.getAttribute('data-status')).toBe('ready');
    expect(block.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(block.querySelector('.dataset-view-heading strong')!.textContent).toBe('Sales');
    // Read-only until Edit: no query field shown.
    expect(block.querySelector('textarea')).toBeNull();
    const refresh = block.querySelector<HTMLButtonElement>('button[aria-label="Refresh view"]')!;
    await act(async () => refresh.click());
    await act(async () => release({ status: 200, body: result(months(4)) }));
    await flush();
    expect(calls[1].body).toMatchObject({ fresh: true });
    expect(block.querySelectorAll('tbody tr')).toHaveLength(4);
});

it('shows the placeholder to a viewer without access, and errors as errors', async () => {
    let reply: Reply = {
        status: 403,
        body: { error: VIEW_NO_ACCESS, code: 'no_access' },
    };
    stubFetch(() => reply);
    await editor(content({ datasetId: 'd1', query: 'SELECT 1', display: 'bar' }));
    const block = host.querySelector('[data-slot="dataset-view"]')!;
    expect(block.getAttribute('data-status')).toBe('denied');
    expect(block.querySelector('[data-state="denied"]')!.textContent).toContain(
        'ask its owner to share it with this Space',
    );
    expect(block.querySelector('table, svg[data-chart]')).toBeNull();
    act(() => root!.unmount());
    reply = { status: 400, body: { error: 'no such table: sales' } };
    await editor(content({ datasetId: 'd1', query: 'SELECT 1', display: 'bar' }));
    expect(host.querySelector('[data-state="error"]')!.textContent).toBe('no such table: sales');
    act(() => root!.unmount());
    // The owner is told when others can't see it yet.
    reply = {
        status: 200,
        body: result(months(2), {
            dataset: { id: 'd1', name: 'Sales', owned: true, sharedHere: false },
        }),
    };
    await editor(content({ datasetId: 'd1', query: 'SELECT 1', display: 'line' }));
    expect(host.querySelector('[data-slot="view-private"]')!.textContent).toMatch(/Only you can see this data/);
    expect(host.querySelector('svg[data-chart="line"]')).toBeTruthy();
    // The chart has a table view too.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Show as a table"]')!.click());
    expect(host.querySelector('table')).toBeTruthy();
});

const dataset = (patch: Partial<DatasetView>): DatasetView => ({
    id: 'd1',
    name: 'Sales',
    description: '',
    kind: 'dataset',
    ownerUserId: 'alice',
    createdByDotId: null,
    scratchForDotId: null,
    fromDeletedDot: false,
    sharedSpaceId: null,
    retentionDays: null,
    sizeBytes: 0,
    tableCount: 1,
    createdAt: 0,
    updatedAt: 0,
    access: 'owner',
    ...patch,
});
const change = (element: Element, value: string) => {
    const proto =
        element instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : element instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
};

it('inserts a view from the block menu and saves its spec into the page', async () => {
    const calls = stubFetch(
        () => ({ status: 200, body: result(months(3)) }),
        [
            dataset({}),
            dataset({
                id: 'd2',
                name: 'Theirs',
                access: 'read',
                ownerName: 'Bob',
                ownerUserId: 'bob',
                sharedSpaceId: 's1',
            }),
            dataset({
                id: 'd3',
                name: 'Elsewhere',
                access: 'read',
                ownerUserId: 'bob',
                sharedSpaceId: 's2',
            }),
        ],
    );
    const block = blocks.find((b) => b.title === 'Dataset view')!;
    expect(block.description).toMatch(/live table or chart/);
    const onChange = await editor('# Report\n\n');
    // The slash menu runs the block's command on the editor.
    const prose = host.querySelector('.ProseMirror')!;
    const tiptap = (prose as unknown as { editor: import('@tiptap/core').Editor }).editor;
    await act(async () => {
        block.run(tiptap, {
            from: tiptap.state.doc.content.size - 1,
            to: tiptap.state.doc.content.size - 1,
        });
    });
    await flush();
    const form = host.querySelector('form[aria-label="Edit dataset view"]')!;
    expect(form).toBeTruthy();
    const options = [...form.querySelectorAll('select[aria-label="Dataset"] option')].map((o) => o.textContent);
    // Own datasets and those shared with this page's Space, not others.
    expect(options).toEqual(['Choose a dataset', 'Sales', 'Theirs (shared by Bob)']);
    await act(async () => {
        change(form.querySelector('select[aria-label="Dataset"]')!, 'd1');
        change(form.querySelector('textarea[aria-label="View query"]')!, 'SELECT month, total FROM sales');
        change(form.querySelector('select[aria-label="Display"]')!, 'bar');
    });
    const button = (label: string) => [...form.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await act(async () => button('Run').click());
    await flush();
    expect(calls.filter((c) => c.path === '/api/data/views/query')).toHaveLength(1);
    expect(host.querySelector('svg[data-chart="bar"]')).toBeTruthy();
    await act(async () => {
        change(form.querySelector('select[aria-label="Auto-refresh"]')!, '60');
        change(form.querySelector('input[aria-label="View title"]')!, 'Monthly');
    });
    await act(async () => button('Save view').click());
    await flush();
    expect(host.querySelector('form[aria-label="Edit dataset view"]')).toBeNull();
    const markdown = onChange.mock.calls.at(-1)![0] as string;
    expect(markdown).toContain(
        '```dataset-view\n{\n  "datasetId": "d1",\n  "query": "SELECT month, total FROM sales",\n  "display": "bar",\n  "title": "Monthly",\n  "refresh": 60\n}\n```',
    );
});
