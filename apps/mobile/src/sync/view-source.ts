import {
    cellConflict,
    type CellConflict,
    datasetFileUploaded,
    type DatasetFileUploaded,
    exportTooLarge,
    type ExportTooLarge,
    fieldConflict,
    type FieldConflict,
    type FieldSettingsRequest,
    fieldSettingsResponse,
    type FieldSettingsResponse,
    fieldSettingsSaved,
    type FieldSettingsSaved,
    invalidWrite,
    type InvalidWrite,
    type NewViewDefinition,
    optionsInUse,
    type OptionsInUse,
    PEOPLE_DIRECTORY_PATH,
    PEOPLE_LOOKUP_PATH,
    peopleDirectory,
    type PeopleDirectory,
    peopleLookup,
    type PeopleLookup,
    rowChanges,
    type RowChanges,
    rowLookup,
    type RowLookup,
    rowWritten,
    type RowWritten,
    VIEW_WRITE_LIMITS,
    viewConflict,
    type ViewConflict,
    viewDefinitionResponse,
    type ViewDefinitionResponse,
    viewDraftSaved,
    type ViewDraftSaved,
    viewExportSearch,
    viewIndexPage,
    type ViewIndexPage,
    type ViewIndexRequest,
    viewListResponse,
    type ViewListResponse,
    type ViewRow,
    viewRoutes,
    viewRowsPage,
    type ViewRowsPage,
    type ViewRowsRequest,
    viewSaved,
    type ViewSaved,
    type WriteCell,
} from '@socio/shared/dataset-views/contract';
import type { ViewDefinition } from '@socio/shared/dataset-views/definition';
import { DATASET_VIEWS_SCHEMA } from '@socio/shared/dataset-views/schema';
import { changesAction, lookupBatches, planReconcile, reconcileOrRefetch } from '@socio/shared/dataset-views/sync';

import type { AuthedFetch, RawUpload } from '../net/authed-fetch';
import { readJson, readText } from '../net/read-body';

import { HttpError, httpError } from './errors';

// A dataset view's data (CB-469; CB-451), behind one
// interface, `ViewSource`, so the screens never know where it comes from:
// - `createLiveViewSource`: the contract's routes, every path from shared's
//   `viewRoutes` (key-safe: a row key is JCS JSON, always encoded), every
//   answer parsed by the shared zod schemas, the GETs conditional (an ETag kept
//   in memory, a 304 answered from the copy). Reads throw `ViewSourceError`
//   (a 404 is "not served": server v0.51.0 serves none of them).
//   Writes answer an outcome, never throw: saved, a conflict with what is
//   there now (`cell_conflict`, `view_conflict`, `field_conflict`), the
//   options still in use, a new row's problems, or `Refused`, whose `code` is
//   the server's (`VIEW_WRITE_CODES`) or the phone's own (`LOCAL_WRITE_CODES`),
//   worded by `refusalCopy` (src/shell/dataset-writes.ts), never by the
//   server's text.
// - `createFixtureViewSource` (fixture-source.ts): the shared fixtures, the
//   write fixtures included, until the server serves views.
// - `reconcileSpan`: a restore without a full resync, over either.
// No React Native: tests/sync runs it under Node.

/** What a cell edit sends: the field, the value as read, and the new one. */
export interface CellEdit {
    readonly field: string;
    /** The raw value as the phone read it: what the compare-and-set compares. */
    readonly from: unknown;
    readonly to: WriteCell;
}

/** The codes the phone gives a write the server didn't refuse in words of its own. */
export const LOCAL_WRITE_CODES = {
    /** No answer: offline, or the request broke off. */
    network: 'network',
    /** 429: too many at once (uploads). */
    rateLimited: 'rate_limited',
    /** A 404 with no code: a server before the route existed. */
    notServed: 'not_served',
    /** An answer that isn't the contract's shape. */
    unreadable: 'unreadable',
    /** Any other refusal without a code. */
    failed: 'failed',
} as const;

/** A write the server (or the network) refused, with what the screen needs to word it. */
export interface Refused {
    readonly outcome: 'refused';
    /** null: no answer. */
    readonly status: number | null;
    /** `VIEW_WRITE_CODES` or `LOCAL_WRITE_CODES`. */
    readonly code: string;
    /** The server's words, for logs only: the screens word the code. */
    readonly error: string;
    /** The refusal's body as parsed: a 400's problems, a 413's counts. */
    readonly body: unknown;
    /** A 429's Retry-After, in seconds. */
    readonly retryAfterSeconds?: number;
}

export type CellEditResult =
    | { readonly outcome: 'saved'; readonly written: RowWritten }
    /** `409 cell_conflict`: the value now there and the whole row, for Keep mine or Take theirs. */
    | { readonly outcome: 'conflict'; readonly conflict: CellConflict }
    | Refused;

export type DraftResult = { readonly outcome: 'saved'; readonly saved: ViewDraftSaved } | Refused;
export type DropDraftResult = { readonly outcome: 'saved' } | Refused;

export type ViewSaveResult =
    | { readonly outcome: 'saved'; readonly saved: ViewSaved }
    /** `409 view_conflict`: the stored view, who saved it and the difference. */
    | { readonly outcome: 'conflict'; readonly conflict: ViewConflict }
    | Refused;

export type ViewCreateResult = { readonly outcome: 'saved'; readonly saved: ViewSaved } | Refused;

export type RowCreateResult =
    /** `replayed`: a 200 for a `createId` already used, the row it made as it is now. */
    | { readonly outcome: 'created'; readonly written: RowWritten; readonly replayed: boolean }
    /** `400 invalid`: each problem with its path (`$.values.title`). */
    | { readonly outcome: 'invalid'; readonly invalid: InvalidWrite }
    | Refused;

export type FieldSaveResult =
    | { readonly outcome: 'saved'; readonly saved: FieldSettingsSaved }
    | { readonly outcome: 'conflict'; readonly conflict: FieldConflict }
    /** `409 options_in_use`: send again with `confirmRemovedOptions` to remove them anyway. */
    | { readonly outcome: 'in-use'; readonly inUse: OptionsInUse }
    | Refused;

export type UploadResult = { readonly outcome: 'uploaded'; readonly uploaded: DatasetFileUploaded } | Refused;

export type ExportResult =
    /** The CSV as the server wrote it, and the file name it gave. */
    | { readonly outcome: 'csv'; readonly name: string; readonly text: string }
    | { readonly outcome: 'too-large'; readonly tooLarge: ExportTooLarge }
    | Refused;

/** A new row's or a cell's file, as the attach picker gives it. */
export interface DatasetUpload {
    readonly body: RawUpload['body'];
    readonly name: string;
    /** Its MIME type, advisory (the server checks the content). */
    readonly type?: string;
    readonly bytes: number;
}

/** The field settings a save sends: `schema` is the source's. */
export type FieldSave = Omit<FieldSettingsRequest, 'schema'>;

/** Why a read failed, in terms a screen can word. */
export type ViewSourceErrorKind = 'not-served' | 'cursor-stale' | 'refused' | 'failed';

export class ViewSourceError extends Error {
    override name = 'ViewSourceError';
    constructor(
        readonly kind: ViewSourceErrorKind,
        message: string,
        readonly status: number | null = null,
    ) {
        super(message);
    }
}

/** Which table of which dataset. */
export interface TableRef {
    readonly datasetId: string;
    readonly table: string;
}

export interface ViewSource {
    /** Whether this source reads the workspace (false: the fixtures). */
    readonly live: boolean;
    list(ref: TableRef): Promise<ViewListResponse>;
    definition(ref: TableRef, viewId: string): Promise<ViewDefinitionResponse>;
    rows(ref: TableRef, viewId: string, request: ViewRowsRequest): Promise<ViewRowsPage>;
    index(ref: TableRef, viewId: string, request: ViewIndexRequest): Promise<ViewIndexPage>;
    lookup(ref: TableRef, keys: readonly string[]): Promise<RowLookup>;
    changes(ref: TableRef, since: string): Promise<RowChanges>;
    /** Every field's settings, with whether the person may change them. */
    fields(ref: TableRef): Promise<FieldSettingsResponse>;
    /** The workspace's active people, for a person field's picker. */
    people(): Promise<PeopleDirectory>;
    /** Names for person ids, deactivated people included (`active: false`), in batches of 500. */
    lookupPeople(ids: readonly string[]): Promise<PeopleLookup>;

    /** The person's draft of a view, saved whole, parts this client can't read included. */
    saveDraft(ref: TableRef, viewId: string, definition: ViewDefinition, baseVersion: number): Promise<DraftResult>;
    dropDraft(ref: TableRef, viewId: string): Promise<DropDraftResult>;
    /** Save for everyone (or the owner's personal view): `overwrite` is a conflict's Keep mine. */
    saveView(
        ref: TableRef,
        viewId: string,
        definition: ViewDefinition,
        baseVersion: number,
        overwrite?: boolean,
    ): Promise<ViewSaveResult>;
    /** Save as a new view; `fromDraft` names the view whose draft it was, which goes once saved. */
    createView(ref: TableRef, definition: NewViewDefinition, fromDraft?: string): Promise<ViewCreateResult>;
    editCell(ref: TableRef, key: string, edit: CellEdit): Promise<CellEditResult>;
    /** A new row; the same `createId` again answers the row it made (a replay adds nothing). */
    createRow(ref: TableRef, values: Readonly<Record<string, WriteCell>>, createId?: string): Promise<RowCreateResult>;
    saveField(ref: TableRef, field: string, save: FieldSave): Promise<FieldSaveResult>;
    /** One file into the dataset's attachments; a cell edit or a new row then names its id. */
    uploadFile(datasetId: string, upload: DatasetUpload): Promise<UploadResult>;
    /** The view as CSV, what it shows as the person; `useDraft` defaults to true, as a read. */
    exportCsv(ref: TableRef, viewId: string, options: { useDraft?: boolean; name: string }): Promise<ExportResult>;
}

/** The view routes' URLs as the phone sends them: shared's `viewRoutes`, with the GETs' query strings. */
export function viewUrls({ datasetId, table }: TableRef) {
    const routes = viewRoutes(datasetId, table);
    const schema = `schema=${DATASET_VIEWS_SCHEMA}`;
    return {
        ...routes,
        list: `${routes.views}?${schema}`,
        definition: (viewId: string) => `${routes.view(viewId)}?${schema}`,
        changesSince: (since: string) => `${routes.changes}?since=${encodeURIComponent(since)}&${schema}`,
        fieldList: `${routes.fields}?${schema}`,
        exportUrl: (viewId: string, useDraft?: boolean) =>
            `${routes.exportCsv(viewId)}?${viewExportSearch({
                schema: DATASET_VIEWS_SCHEMA,
                ...(useDraft === undefined ? {} : { useDraft }),
            })}`,
    };
}

/** The file name a `Content-Disposition` gives (RFC 6266, `filename*` first), made safe to write. */
export function attachmentName(header: string | null, fallback: string): string {
    let name: string | undefined;
    if (header !== null) {
        const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
        if (star?.[2] !== undefined) {
            try {
                name = decodeURIComponent(star[2].trim());
            } catch {
                name = undefined;
            }
        }
        if (name === undefined) {
            const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
            name = (plain?.[1] ?? plain?.[2])?.trim();
        }
    }
    return safeFileName(name === undefined || name === '' ? fallback : name);
}

/** A file name with no path, control or reserved characters, at most 120 characters. */
export function safeFileName(name: string): string {
    // oxlint-disable-next-line no-control-regex -- control characters are what it removes
    const unsafe = /[\u0000-\u001f\u007f/\\:*?"<>|]+/g;
    const cleaned = name
        .replace(unsafe, '-')
        .replace(/^[.\s-]+/, '')
        .trim();
    return (cleaned === '' ? 'export.csv' : cleaned).slice(0, 120);
}

const NOT_SERVED = 'This server doesn’t serve dataset views yet.';

async function failure(error: unknown): Promise<never> {
    if (error instanceof HttpError) {
        if (error.status === 404) {
            throw new ViewSourceError('not-served', NOT_SERVED, 404);
        }
        if (error.status === 409 && error.code === 'cursor_stale') {
            throw new ViewSourceError('cursor-stale', error.message, 409);
        }
        throw new ViewSourceError(error.status === 403 ? 'refused' : 'failed', error.message, error.status);
    }
    if (error instanceof ViewSourceError) {
        throw error;
    }
    throw new ViewSourceError('failed', error instanceof Error ? error.message : String(error));
}

/** A failed answer as `Refused`: its code, else the phone's for the status. */
export function refusedOf(status: number, body: unknown, retryAfter: string | null = null): Refused {
    const parsed = (body !== null && typeof body === 'object' ? body : {}) as { error?: unknown; code?: unknown };
    const code =
        typeof parsed.code === 'string' && parsed.code !== ''
            ? parsed.code
            : status === 429
              ? LOCAL_WRITE_CODES.rateLimited
              : status === 404
                ? LOCAL_WRITE_CODES.notServed
                : LOCAL_WRITE_CODES.failed;
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    return {
        outcome: 'refused',
        status,
        code,
        error: typeof parsed.error === 'string' ? parsed.error : `HTTP ${status}`,
        body,
        ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSeconds: seconds } : {}),
    };
}

const noAnswer = (error: unknown): Refused => ({
    outcome: 'refused',
    status: null,
    code: LOCAL_WRITE_CODES.network,
    error: error instanceof Error ? error.message : String(error),
    body: null,
});

const unreadable = (status: number, body: unknown, detail: string): Refused => ({
    outcome: 'refused',
    status,
    code: LOCAL_WRITE_CODES.unreadable,
    error: detail,
    body,
});

/** Parses an answer with its schema, or calls it unreadable: a write's answer never throws. */
type Schema<T> = {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: Error };
};

function parsed<T, R>(schema: Schema<T>, status: number, body: unknown, then: (value: T) => R): R | Refused {
    const result = schema.safeParse(body);
    return result.success ? then(result.data) : unreadable(status, body, result.error.message);
}

export interface LiveViewSourceOptions {
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
}

type Answer = { readonly ok: true; readonly status: number; readonly body: unknown; readonly response: Response };

/** The contract's routes on the workspace (step 8 and later). */
export function createLiveViewSource({ fetch, signal }: LiveViewSourceOptions): ViewSource {
    const held = new Map<string, { etag: string; body: unknown }>();
    async function get(path: string): Promise<unknown> {
        try {
            const copy = held.get(path);
            const response = await fetch(
                path,
                copy === undefined ? undefined : { headers: { 'if-none-match': copy.etag } },
            );
            if (response.status === 304 && copy !== undefined) {
                return copy.body;
            }
            if (!response.ok) {
                throw await httpError(response, signal);
            }
            const body = await readJson(response, signal);
            const etag = response.headers.get('etag');
            if (etag !== null) {
                held.set(path, { etag, body });
            }
            return body;
        } catch (error) {
            return failure(error);
        }
    }
    const post = async (path: string, json: unknown) => {
        try {
            const response = await fetch(path, { method: 'POST', json });
            if (!response.ok) {
                throw await httpError(response, signal);
            }
            return await readJson(response, signal);
        } catch (error) {
            return failure(error);
        }
    };
    /** A write: the answer's body when it is 2xx, else `Refused` with the refusal's body. */
    async function write(
        path: string,
        init: { method: string; json?: unknown; upload?: RawUpload; headers?: Record<string, string> },
    ): Promise<Answer | Refused> {
        let response: Response;
        try {
            response = await fetch(path, init);
        } catch (error) {
            return noAnswer(error);
        }
        try {
            const text = await readText(response, signal);
            let body: unknown = null;
            if (text !== '') {
                try {
                    body = JSON.parse(text);
                } catch {
                    body = text;
                }
            }
            return response.ok
                ? { ok: true, status: response.status, body, response }
                : refusedOf(response.status, body, response.headers.get('retry-after'));
        } catch (error) {
            return noAnswer(error);
        }
    }
    const isRefused = (answer: Answer | Refused): answer is Refused => 'outcome' in answer;
    const conflictOf = <T>(answer: Refused, code: string, schema: Schema<T>): { readonly found: T } | Refused | null =>
        answer.status === 409 && answer.code === code
            ? parsed(schema, 409, answer.body, (found: T) => ({ found }))
            : null;

    return {
        live: true,
        list: async (ref) => viewListResponse.parse(await get(viewUrls(ref).list)),
        definition: async (ref, viewId) => viewDefinitionResponse.parse(await get(viewUrls(ref).definition(viewId))),
        rows: async (ref, viewId, request) =>
            viewRowsPage.parse(
                await post(viewUrls(ref).rowsPage(viewId), { ...request, schema: DATASET_VIEWS_SCHEMA }),
            ),
        index: async (ref, viewId, request) =>
            viewIndexPage.parse(await post(viewUrls(ref).index(viewId), { ...request, schema: DATASET_VIEWS_SCHEMA })),
        lookup: async (ref, keys) =>
            rowLookup.parse(await post(viewUrls(ref).lookup, { schema: DATASET_VIEWS_SCHEMA, keys: [...keys] })),
        changes: async (ref, since) => rowChanges.parse(await get(viewUrls(ref).changesSince(since))),
        fields: async (ref) => fieldSettingsResponse.parse(await get(viewUrls(ref).fieldList)),
        people: async () => peopleDirectory.parse(await get(PEOPLE_DIRECTORY_PATH)),
        async lookupPeople(ids) {
            const users: PeopleLookup['users'] = {};
            const unique = [...new Set(ids)];
            for (let at = 0; at < unique.length; at += VIEW_WRITE_LIMITS.lookupPeople) {
                const batch = unique.slice(at, at + VIEW_WRITE_LIMITS.lookupPeople);
                const answer = peopleLookup.parse(
                    await post(PEOPLE_LOOKUP_PATH, { schema: DATASET_VIEWS_SCHEMA, ids: batch }),
                );
                Object.assign(users, answer.users);
            }
            return { schema: DATASET_VIEWS_SCHEMA, users };
        },

        async saveDraft(ref, viewId, definition, baseVersion) {
            const answer = await write(viewUrls(ref).draft(viewId), {
                method: 'PUT',
                json: { schema: DATASET_VIEWS_SCHEMA, definition, baseVersion },
            });
            return isRefused(answer)
                ? answer
                : parsed(viewDraftSaved, answer.status, answer.body, (saved) => ({ outcome: 'saved' as const, saved }));
        },
        async dropDraft(ref, viewId) {
            const answer = await write(viewUrls(ref).draft(viewId), { method: 'DELETE' });
            return isRefused(answer) ? answer : { outcome: 'saved' };
        },
        async saveView(ref, viewId, definition, baseVersion, overwrite) {
            const answer = await write(viewUrls(ref).view(viewId), {
                method: 'PUT',
                json: {
                    schema: DATASET_VIEWS_SCHEMA,
                    definition,
                    baseVersion,
                    ...(overwrite === true ? { overwrite: true } : {}),
                },
            });
            if (isRefused(answer)) {
                const conflict = conflictOf<ViewConflict>(answer, 'view_conflict', viewConflict);
                return conflict === null
                    ? answer
                    : 'found' in conflict
                      ? { outcome: 'conflict', conflict: conflict.found }
                      : conflict;
            }
            return parsed(viewSaved, answer.status, answer.body, (saved) => ({ outcome: 'saved' as const, saved }));
        },
        async createView(ref, definition, fromDraft) {
            const answer = await write(viewUrls(ref).views, {
                method: 'POST',
                json: { schema: DATASET_VIEWS_SCHEMA, definition, ...(fromDraft === undefined ? {} : { fromDraft }) },
            });
            return isRefused(answer)
                ? answer
                : parsed(viewSaved, answer.status, answer.body, (saved) => ({ outcome: 'saved' as const, saved }));
        },
        async editCell(ref, key, edit) {
            const answer = await write(viewUrls(ref).row(key), {
                method: 'PATCH',
                json: { schema: DATASET_VIEWS_SCHEMA, field: edit.field, from: edit.from ?? null, to: edit.to },
            });
            if (isRefused(answer)) {
                const conflict = conflictOf<CellConflict>(answer, 'cell_conflict', cellConflict);
                return conflict === null
                    ? answer
                    : 'found' in conflict
                      ? { outcome: 'conflict', conflict: conflict.found }
                      : conflict;
            }
            return parsed(rowWritten, answer.status, answer.body, (written) => ({
                outcome: 'saved' as const,
                written,
            }));
        },
        async createRow(ref, values, createId) {
            const answer = await write(viewUrls(ref).rows, {
                method: 'POST',
                json: { schema: DATASET_VIEWS_SCHEMA, values, ...(createId === undefined ? {} : { createId }) },
            });
            if (isRefused(answer)) {
                if (answer.status === 400 && answer.code === 'invalid') {
                    return parsed(invalidWrite, 400, answer.body, (invalid) => ({
                        outcome: 'invalid' as const,
                        invalid,
                    }));
                }
                return answer;
            }
            return parsed(rowWritten, answer.status, answer.body, (written) => ({
                outcome: 'created' as const,
                written,
                replayed: answer.status === 200,
            }));
        },
        async saveField(ref, field, save) {
            const answer = await write(viewUrls(ref).field(field), {
                method: 'PUT',
                json: { ...save, schema: DATASET_VIEWS_SCHEMA },
            });
            if (isRefused(answer)) {
                const conflict = conflictOf<FieldConflict>(answer, 'field_conflict', fieldConflict);
                if (conflict !== null) {
                    return 'found' in conflict ? { outcome: 'conflict', conflict: conflict.found } : conflict;
                }
                const inUse = conflictOf<OptionsInUse>(answer, 'options_in_use', optionsInUse);
                if (inUse !== null) {
                    return 'found' in inUse ? { outcome: 'in-use', inUse: inUse.found } : inUse;
                }
                return answer;
            }
            return parsed(fieldSettingsSaved, answer.status, answer.body, (saved) => ({
                outcome: 'saved' as const,
                saved,
            }));
        },
        async uploadFile(datasetId, upload) {
            // Dataset-wide: `files` takes no table.
            const answer = await write(viewRoutes(datasetId, '').files, {
                method: 'POST',
                upload: {
                    body: upload.body,
                    name: upload.name,
                    ...(upload.type === undefined ? {} : { type: upload.type }),
                },
            });
            return isRefused(answer)
                ? answer
                : parsed(datasetFileUploaded, answer.status, answer.body, (uploaded) => ({
                      outcome: 'uploaded' as const,
                      uploaded,
                  }));
        },
        async exportCsv(ref, viewId, { useDraft, name }) {
            let response: Response;
            try {
                response = await fetch(viewUrls(ref).exportUrl(viewId, useDraft), {
                    headers: { accept: 'text/csv' },
                });
            } catch (error) {
                return noAnswer(error);
            }
            try {
                const text = await readText(response, signal);
                if (response.ok) {
                    // TextDecoder drops the UTF-8 byte-order mark the server writes, which
                    // spreadsheets read the encoding by: the file the phone shares keeps it.
                    return {
                        outcome: 'csv',
                        name: attachmentName(response.headers.get('content-disposition'), `${name}.csv`),
                        text: text.startsWith('\uFEFF') ? text : `\uFEFF${text}`,
                    };
                }
                let body: unknown = text;
                try {
                    body = JSON.parse(text);
                } catch {
                    // Not the API's JSON: worded by its status.
                }
                const refused = refusedOf(response.status, body, response.headers.get('retry-after'));
                if (response.status === 413 && refused.code === 'too_many_rows') {
                    return parsed(exportTooLarge, 413, body, (tooLarge) => ({
                        outcome: 'too-large' as const,
                        tooLarge,
                    }));
                }
                return refused;
            } catch (error) {
                return noAnswer(error);
            }
        },
    };
}

// ----- A restore, reconciled -----

/** A span the phone cached: its first page's request, its rows with their stamps, and what it weighs. */
export interface CachedSpan {
    readonly viewId: string;
    /** The span's first page read, as it was sent: the index reads the same. */
    readonly request: ViewRowsRequest;
    readonly rows: readonly ViewRow[];
    /** The span's cached bytes: the index costs about 40 a row. */
    readonly bytes: number;
}

/** What a span became after a sync. */
export type SpanSync =
    /** `changes` applied: the rows to drop and replace, and the token to ask from next. */
    | {
          readonly kind: 'applied';
          readonly rows: readonly ViewRow[];
          readonly removed: readonly string[];
          readonly token: string;
      }
    /** Reconciled by its index: kept rows untouched, only changed and new keys fetched. */
    | {
          readonly kind: 'reconciled';
          readonly rows: readonly ViewRow[];
          readonly kept: number;
          readonly fetched: number;
          readonly next: string | null;
          readonly token: string;
      }
    /** Read again: no stamps (`resync`), nothing cached, or a cache lighter than its index. */
    | { readonly kind: 'refetch'; readonly why: 'resync' | 'no-cache' | 'cheaper' };

/**
 * Syncs one cached span from `since`: `changes` applies in place; `reconcile: true` (a
 * restore, or a `since` below the floor) reads the span's `{ key, stamp }` index with the span's
 * own first request, following `next` only as deep as the span cached, drops keys it no longer
 * lists, looks up only the keys whose stamp differs or that the phone doesn't hold (in batches of
 * 500), and keeps every other row as it is. Never a full resync, unless there is nothing to compare
 * (`resync`) or the cache costs less to read again than its index.
 */
export async function reconcileSpan(
    source: ViewSource,
    ref: TableRef,
    span: CachedSpan,
    since: string,
): Promise<SpanSync> {
    const changes = await source.changes(ref, since);
    const action = changesAction(changes);
    if (action === 'resync') {
        return { kind: 'refetch', why: 'resync' };
    }
    if (action === 'apply') {
        const removed = new Set(changes.deleted.map((d) => d.key));
        const changed = new Map(changes.upserts.map((row) => [row.key, row]));
        return {
            kind: 'applied',
            rows: span.rows.filter((row) => !removed.has(row.key)).map((row) => changed.get(row.key) ?? row),
            removed: [...removed],
            token: changes.token,
        };
    }
    const choice = reconcileOrRefetch({ rows: span.rows.length, bytes: span.bytes });
    if (choice === 'refetch') {
        return { kind: 'refetch', why: span.rows.length === 0 ? 'no-cache' : 'cheaper' };
    }
    const { cursor, around, group, range, useDraft } = span.request;
    const entries: Array<{ key: string; stamp: string }> = [];
    let next: string | null = null;
    let token = changes.token;
    let request: ViewIndexRequest = {
        schema: DATASET_VIEWS_SCHEMA,
        ...(cursor === undefined ? {} : { cursor }),
        ...(around === undefined ? {} : { around }),
        ...(group === undefined ? {} : { group }),
        ...(range === undefined ? {} : { range }),
        ...(useDraft === undefined ? {} : { useDraft }),
    };
    for (;;) {
        const page = await source.index(ref, span.viewId, request);
        entries.push(...page.entries);
        token = page.datasetToken;
        next = page.next;
        if (next === null || entries.length >= span.rows.length) {
            break;
        }
        // Later index pages go by their cursor alone: `around` opens only the first.
        request = {
            schema: DATASET_VIEWS_SCHEMA,
            cursor: next,
            ...(group === undefined ? {} : { group }),
            ...(range === undefined ? {} : { range }),
        };
    }
    const plan = planReconcile(span.rows, entries);
    const fetched = new Map<string, ViewRow>();
    for (const keys of lookupBatches(plan.fetch)) {
        const answer = await source.lookup(ref, keys);
        for (const row of answer.rows) {
            fetched.set(row.key, row);
        }
    }
    const held = new Map(span.rows.map((row) => [row.key, row]));
    const keep = new Set(plan.keep);
    const rows: ViewRow[] = [];
    const seen = new Set<string>();
    for (const key of plan.order) {
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const row = keep.has(key) ? held.get(key) : fetched.get(key);
        if (row !== undefined) {
            rows.push(row);
        }
    }
    return { kind: 'reconciled', rows, kept: plan.keep.length, fetched: fetched.size, next, token };
}
