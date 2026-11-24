import { z } from 'zod';

/**
 * An embedded dataset view: a page block bound to a
 * read-only query on one dataset, shown as a table or a simple chart.
 *
 * In page Markdown it is a fenced code block with the `dataset-view` info
 * string and the spec as JSON, so it survives source mode, downloads and
 * any Markdown tool:
 *
 * ```dataset-view
 * { "datasetId": "…", "query": "SELECT month, total FROM sales", "display": "bar", "x": "month", "y": "total" }
 * ```
 *
 * The data is never stored in the page: each viewer's browser asks
 * `POST /api/data/views/query`, which reads through that viewer's own access.
 */
export const DATASET_VIEW_LANG = 'dataset-view';
export const VIEW_DISPLAYS = ['table', 'bar', 'line'] as const;
export type ViewDisplay = (typeof VIEW_DISPLAYS)[number];
/** Auto-refresh bounds, in seconds. */
export const VIEW_REFRESH_MIN = 10;
export const VIEW_REFRESH_MAX = 86_400;

const param = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const column = z.string().trim().min(1).max(128);

export const viewSpecSchema = z
    .object({
        datasetId: z.string().trim().min(1).max(64),
        query: z.string().trim().min(1).max(20_000),
        params: z.array(param).max(100).optional(),
        display: z.enum(VIEW_DISPLAYS).default('table'),
        x: column.optional(),
        y: column.optional(),
        title: z.string().trim().max(160).optional(),
        refresh: z.number().int().min(VIEW_REFRESH_MIN).max(VIEW_REFRESH_MAX).optional(),
    })
    .strict();
export type ViewSpec = z.infer<typeof viewSpecSchema>;

/** The spec as stored: keys in a fixed order, empty optionals left out. */
export function normalizeViewSpec(input: z.input<typeof viewSpecSchema>) {
    const spec = viewSpecSchema.parse(input);
    const out: ViewSpec = {
        datasetId: spec.datasetId,
        query: spec.query,
        display: spec.display,
    };
    if (spec.params?.length) {
        out.params = spec.params;
    }
    if (spec.x) {
        out.x = spec.x;
    }
    if (spec.y) {
        out.y = spec.y;
    }
    if (spec.title) {
        out.title = spec.title;
    }
    if (spec.refresh) {
        out.refresh = spec.refresh;
    }
    return out;
}

/**
 * A block as the editor holds it, which may not be finished yet (no
 * dataset or query chosen): the spec's fields, leniently read.
 */
export type ViewDraft = Omit<ViewSpec, 'datasetId' | 'query'> & {
    datasetId: string;
    query: string;
};
export function viewDraft(value: unknown): ViewDraft | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const v = value as Record<string, unknown>;
    const text = (key: string, max: number) =>
        typeof v[key] === 'string' ? (v[key] as string).trim().slice(0, max) : '';
    const out: ViewDraft = {
        datasetId: text('datasetId', 64),
        query: text('query', 20_000),
        display: VIEW_DISPLAYS.includes(v.display as ViewDisplay) ? (v.display as ViewDisplay) : 'table',
    };
    const params = Array.isArray(v.params) ? v.params.filter((p) => param.safeParse(p).success).slice(0, 100) : [];
    if (params.length) {
        out.params = params as ViewSpec['params'];
    }
    const x = text('x', 128);
    const y = text('y', 128);
    const title = text('title', 160);
    if (x) {
        out.x = x;
    }
    if (y) {
        out.y = y;
    }
    if (title) {
        out.title = title;
    }
    const refresh = Number(v.refresh);
    if (Number.isInteger(refresh) && refresh > 0) {
        out.refresh = Math.min(VIEW_REFRESH_MAX, Math.max(VIEW_REFRESH_MIN, refresh));
    }
    return out;
}

/** The block's body: JSON, with backticks escaped so it never closes its fence. */
export function viewSpecBody(spec: ViewDraft) {
    return JSON.stringify(spec, null, 2).replace(/`/g, '\\u0060');
}

/** The whole fenced block, as page Markdown. */
export function viewSpecMarkdown(spec: ViewDraft) {
    return `\`\`\`${DATASET_VIEW_LANG}\n${viewSpecBody(spec)}\n\`\`\``;
}

/** A block body back to a spec; undefined when it isn't a valid one. */
export function parseViewSpec(body: string): ViewSpec | undefined {
    try {
        const parsed = viewSpecSchema.safeParse(JSON.parse(body));
        return parsed.success ? normalizeViewSpec(parsed.data) : undefined;
    } catch {
        return undefined;
    }
}

/** The view query route's body: the block's query, and the page it is on. */
export const viewQueryBody = z
    .object({
        spaceId: z.string().min(1).max(64),
        pageId: z.string().min(1).max(64),
        datasetId: z.string().trim().min(1).max(64),
        query: z.string().trim().min(1).max(20_000),
        params: z.array(param).max(100).optional(),
        /** Skip the short result cache (the Refresh button). */
        fresh: z.boolean().optional(),
    })
    .strict();
export type ViewQueryBody = z.infer<typeof viewQueryBody>;

/** What the route answers with data. */
export interface ViewQueryResult {
    columns: string[];
    rows: Array<Array<string | number | boolean | null | { $blob: string }>>;
    truncated: boolean;
    ms: number;
    /** The row cap that applied (the data space's queryMaxRows). */
    maxRows: number;
    dataset: { id: string; name: string; owned: boolean; sharedHere: boolean };
    cached: boolean;
    at: number;
}

/** The refusal a viewer without access gets, instead of data. */
export const VIEW_NO_ACCESS = 'You don’t have access to this dataset — ask its owner to share it with this Space.';
export const VIEW_NO_ACCESS_CODE = 'no_access';
