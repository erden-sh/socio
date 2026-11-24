/**
 * `POST /api/data/specs/run` (CB-451): a query spec checked for the person
 * asking, compiled to one SQLite statement and
 * run through `DataSpace.query` as them, with its answer shaped into a
 * `SpecResult`. Answers are kept briefly per dataset version, statement
 * and viewer (the embedded views' model, with the viewer in the key,
 * because `$me` and access differ per person), and runs that miss the
 * cache are limited per viewer.
 *
 * Every query that runs, or is answered from the cache, is reported to
 * `onQuery` with its timings and outcome but never its values or who
 * asked: a later change records them in `data_query_runs` for Operations.
 */
import { DataError } from '@socio/foundation/dataspace/data-error';
import type { CellValue, DatasetDetail, QueryResult } from '@socio/shared/data-types';
import { containsDay, type ClosedRange } from '@socio/shared/dataset-query/dates';
import type { FieldSetting } from '@socio/shared/dataset-query/kinds';
import type { SpecCell, SpecColumn, SpecResult, SpecRow, SpecRunBody } from '@socio/shared/dataset-query/result';
import type { FilterValue, SpecProblem } from '@socio/shared/dataset-query/spec';
import { rowidKey, rowKey, type KeyValue } from '@socio/shared/dataset-views/schema';
import { ianaTimeZone } from '@socio/shared/time-zone';

import { checkSpec, parseSpec, specFields } from './check.js';
import { bucketPartial, compileSpec, tooManyBuckets, type CompiledSpec, type Plan } from './compile.js';

/** What the runner reads, as the person asking. */
export interface SpecRunSources {
    /** The dataset and its tables, through the person's own read access (404 otherwise). */
    detailFor(userId: string, datasetId: string): DatasetDetail;
    /** The dataset's version (`Dataset.updatedAt`), for the cache; through the same access. */
    datasetVersion(userId: string, datasetId: string): number;
    /** The table's field settings; none without it. */
    fieldSettings?(datasetId: string, table: string): FieldSetting[];
    /** The workspace's people, to sort and name person fields. */
    specPeople?(): ReadonlyArray<{ id: string; name: string }>;
    /** The data space's read-only query, as the person: authorizer, runner process, timeout, row and byte caps. */
    query(
        actor: { kind: 'user'; userId: string },
        datasetId: string,
        sql: string,
        params: Array<string | number | null>,
    ): Promise<QueryResult & { datasetId: string }>;
}

/** One source query, for Operations: what ran and how long, never values or the viewer. */
export interface SpecQueryTiming {
    startedAt: number;
    sourceKind: 'dataset';
    /** `<datasetId>/<table>`. */
    sourceRef: string;
    surface: 'view' | 'dashboard' | 'agent' | 'plugin_page';
    engine: 'sqlite';
    /** The runner's own time for the statement. */
    readMs: number;
    /** Compiling, running and shaping. */
    totalMs: number;
    rows: number;
    bytes: number;
    outcome: 'ok' | 'error' | 'timeout' | 'too_large' | 'no_access';
    errorCode?: string;
    cached: boolean;
}

export interface SpecRunOptions {
    /** How long an answer is reused for the same dataset version, statement and viewer. */
    cacheTtlMs?: number;
    /** Runs a minute per viewer that miss the cache. */
    perMinute?: number;
    maxEntries?: number;
    maxBytes?: number;
    now?: () => number;
    /** Each query, run or cached: a later change records them. */
    onQuery?: (timing: SpecQueryTiming) => void;
}

/** A spec that didn't check: every problem, with its path. */
export interface SpecRunRefusal {
    ok: false;
    problems: SpecProblem[];
}

interface Entry {
    at: number;
    bytes: number;
    result: Omit<SpecResult, 'cached'>;
}

/** `{ "$param": name }` tokens replaced by the dashboard's values. */
export function withParams(spec: unknown, params: Record<string, FilterValue> | undefined): unknown {
    const isParam = (v: unknown): v is { $param: string } =>
        !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '$param' in v;
    const walk = (v: unknown, depth: number): unknown => {
        if (depth > 40 || !v || typeof v !== 'object') {
            return v;
        }
        if (isParam(v)) {
            return params && Object.hasOwn(params, v.$param) ? params[v.$param] : v;
        }
        if (Array.isArray(v)) {
            return v.flatMap((item) => {
                const out = walk(item, depth + 1);
                // A list parameter inside a list (`is_any_of: [{ $param }]`) is its items.
                return isParam(item) && Array.isArray(out) ? out : [out];
            });
        }
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
    };
    return params ? walk(spec, 0) : spec;
}

export class SpecRunner {
    private cache = new Map<string, Entry>();
    private running = new Map<string, Promise<Entry>>();
    private rate = new Map<string, number[]>();
    private bytes = 0;
    private ttl: number;
    private perMinute: number;
    private maxEntries: number;
    private maxBytes: number;
    private now: () => number;

    constructor(
        private sources: SpecRunSources,
        private options: SpecRunOptions = {},
    ) {
        this.ttl = options.cacheTtlMs ?? 15_000;
        this.perMinute = options.perMinute ?? 120;
        this.maxEntries = options.maxEntries ?? 200;
        this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
        this.now = options.now ?? Date.now;
    }

    /** The answer, or the spec's problems. Throws the data space's errors (404, 429, 504 …). */
    async run(
        userId: string,
        body: SpecRunBody,
        surface: SpecQueryTiming['surface'] = 'view',
    ): Promise<SpecResult | SpecRunRefusal> {
        const started = this.now();
        const input = withParams(body.spec, body.params);
        const { spec, problems } = parseSpec(input);
        if (!spec) {
            return { ok: false, problems };
        }
        const source = spec.source;
        if (!('dataset' in source)) {
            return {
                ok: false,
                problems: [
                    { path: '$.source', message: 'Plugin data sources aren’t available yet; use a dataset table.' },
                ],
            };
        }
        const detail = this.sources.detailFor(userId, source.dataset);
        const table = detail.tables.find((t) => t.name === source.table);
        if (!table) {
            return {
                ok: false,
                problems: [
                    {
                        path: '$.source.table',
                        message: `Dataset "${detail.dataset.name}" has no table "${source.table.slice(0, 80)}".`,
                    },
                ],
            };
        }
        const settings = this.sources.fieldSettings?.(source.dataset, source.table);
        const check = checkSpec(input, { table, settings });
        if (!check.ok || !check.spec) {
            return { ok: false, problems: check.problems };
        }
        if (check.engine === 'duckdb') {
            return {
                ok: false,
                problems: [
                    {
                        path: '$.source.table',
                        message: `"${table.name}" is an analytical table; specs on analytical tables come with the DuckDB compiler.`,
                    },
                ],
            };
        }
        const timeZone =
            (check.spec.timeZone && ianaTimeZone(check.spec.timeZone)) ||
            (body.timeZone && ianaTimeZone(body.timeZone)) ||
            'UTC';
        const people = this.sources.specPeople?.() ?? [];
        const compiled = compileSpec({
            spec: check.spec,
            fields: specFields(table.columns, settings),
            table: { name: table.name, columns: table.columns },
            timeZone,
            now: started,
            me: userId,
            people,
        });
        const version = this.sources.datasetVersion(userId, source.dataset);
        // The plan too: names, labels and windows shape the answer, and the statement doesn't hold them.
        const key = JSON.stringify([source.dataset, version, userId, compiled.sql, compiled.params, compiled.plan]);
        const timing = (
            entry: { readMs: number; rows: number; bytes: number },
            cached: boolean,
            outcome: SpecQueryTiming['outcome'] = 'ok',
            errorCode?: string,
        ) =>
            this.options.onQuery?.({
                startedAt: started,
                sourceKind: 'dataset',
                sourceRef: `${source.dataset}/${table.name}`,
                surface,
                engine: 'sqlite',
                readMs: entry.readMs,
                totalMs: Math.max(0, this.now() - started),
                rows: entry.rows,
                bytes: entry.bytes,
                outcome,
                ...(errorCode ? { errorCode } : {}),
                cached,
            });
        const hit = this.cache.get(key);
        if (hit && !body.fresh && started - hit.at < this.ttl) {
            timing({ readMs: 0, rows: hit.result.rows.length, bytes: hit.bytes }, true);
            return { ...hit.result, cached: true };
        }
        const pending = this.running.get(key);
        if (pending) {
            const entry = await pending;
            timing({ readMs: 0, rows: entry.result.rows.length, bytes: entry.bytes }, true);
            return { ...entry.result, cached: true };
        }
        this.limit(userId, started);
        const run = this.sources
            .query({ kind: 'user', userId }, source.dataset, compiled.sql, compiled.params)
            .then((raw): Entry => {
                const result = shapeResult(compiled, raw, people, this.now());
                const entry: Entry = { at: this.now(), bytes: JSON.stringify(raw.rows).length, result };
                this.store(key, entry);
                timing({ readMs: raw.ms, rows: raw.rows.length, bytes: entry.bytes }, false);
                return entry;
            })
            .catch((error: unknown) => {
                const status = error instanceof DataError ? error.status : 500;
                const outcome: SpecQueryTiming['outcome'] =
                    status === 504
                        ? 'timeout'
                        : status === 413
                          ? 'too_large'
                          : status === 403 || status === 404
                            ? 'no_access'
                            : 'error';
                timing({ readMs: 0, rows: 0, bytes: 0 }, false, outcome, String(status));
                throw error;
            })
            .finally(() => this.running.delete(key));
        this.running.set(key, run);
        const entry = await run;
        return { ...entry.result, cached: false };
    }

    private limit(viewer: string, now: number) {
        const recent = (this.rate.get(viewer) ?? []).filter((at) => at > now - 60_000);
        if (recent.length >= this.perMinute) {
            this.rate.set(viewer, recent);
            throw new DataError(
                `Too many queries: at most ${this.perMinute} a minute. Wait a minute, or refresh less often.`,
                429,
            );
        }
        recent.push(now);
        this.rate.set(viewer, recent);
    }

    private store(key: string, entry: Entry) {
        const old = this.cache.get(key);
        if (old) {
            this.bytes -= old.bytes;
            this.cache.delete(key);
        }
        if (entry.bytes > this.maxBytes) {
            return;
        }
        this.cache.set(key, entry);
        this.bytes += entry.bytes;
        const cutoff = this.now() - this.ttl;
        for (const [k, e] of this.cache) {
            if (this.cache.size <= this.maxEntries && this.bytes <= this.maxBytes && e.at >= cutoff) {
                break;
            }
            // Oldest first (insertion order): expired, or over the caps.
            this.cache.delete(k);
            this.bytes -= e.bytes;
        }
    }
}

const scalar = (v: CellValue | undefined): SpecCell =>
    v === undefined || v === null ? null : typeof v === 'object' ? null : v;

/** The statement's rows as a `SpecResult`: the compiler's plan names what each column holds. */
export function shapeResult(
    compiled: CompiledSpec,
    raw: QueryResult,
    people: ReadonlyArray<{ id: string; name: string }>,
    at: number,
): Omit<SpecResult, 'cached'> {
    const plan = compiled.plan;
    const index = new Map(raw.columns.map((c, i) => [c, i]));
    const get = (row: CellValue[], column: string) => {
        const i = index.get(column);
        return i === undefined ? null : scalar(row[i]);
    };
    const windowInfo = (w: { label: string; range: ClosedRange | null }) =>
        w.range
            ? { label: w.label, from: w.range.from, to: w.range.to, partial: containsDay(w.range, plan.today) }
            : undefined;
    const base = {
        engine: 'sqlite' as const,
        truncated: raw.truncated,
        timeZone: plan.timeZone,
        today: plan.today,
        sourceRange: plan.sourceRange,
        at,
    };
    const groupValue = (g: Plan['groups'][number], value: SpecCell): SpecCell => {
        if (g.labels) {
            return typeof value === 'number' ? (g.labels[value] ?? null) : null;
        }
        if (g.checkbox) {
            return value === null ? null : value === 1 || value === true;
        }
        return value;
    };
    const personIds = new Set<string>();
    const users = () => {
        if (!personIds.size) {
            return {};
        }
        const byId = new Map(people.map((p) => [p.id, p.name]));
        const out: Record<string, { name: string }> = {};
        for (const id of personIds) {
            const name = byId.get(id);
            if (name !== undefined) {
                out[id] = { name };
            }
        }
        return Object.keys(out).length ? { users: out } : {};
    };
    const notePeople = (kind: string, value: SpecCell) => {
        if (kind === 'person' && typeof value === 'string' && value) {
            personIds.add(value);
        } else if (kind === 'people' && typeof value === 'string') {
            try {
                const items: unknown = JSON.parse(value);
                if (Array.isArray(items)) {
                    items.filter((x): x is string => typeof x === 'string').forEach((x) => personIds.add(x));
                }
            } catch {
                // Not a list: no people to name.
            }
        }
    };

    if (plan.mode === 'rows') {
        const columns: SpecColumn[] = [
            ...plan.fields.map((f) => ({ name: f.name, kind: f.kind, role: 'field' as const, field: f.name })),
            ...plan.groups
                .filter((g) => g.name !== g.field)
                .map((g) => ({
                    name: g.name,
                    kind: g.kind,
                    role: (g.labels ? 'segment' : 'group') as SpecColumn['role'],
                    ...(g.field ? { field: g.field } : {}),
                })),
        ];
        const keyCount = Math.max(plan.keys.length, 1);
        const rows: SpecRow[] = raw.rows.map((row) => {
            const values: Record<string, SpecCell> = {};
            plan.fields.forEach((f, i) => {
                const value = scalar(row[keyCount + i]);
                values[f.name] = value;
                notePeople(f.kind, value);
            });
            plan.groups.forEach((g, i) => {
                if (g.name === g.field) {
                    return;
                }
                values[g.name] = groupValue(g, scalar(row[keyCount + plan.fields.length + i]));
            });
            const keyValues = row.slice(0, keyCount).map((v) => scalar(v) as KeyValue);
            const key = plan.keys.length ? rowKey(keyValues) : rowidKey(Number(keyValues[0]));
            return { key, values };
        });
        const count = raw.rows.length ? Number(raw.rows[0]![raw.columns.length - 1] ?? 0) : 0;
        const window = plan.windows[0] ? windowInfo(plan.windows[0]) : undefined;
        return {
            ...base,
            columns,
            rows,
            totals: plan.totals ? { count } : null,
            ...(window ? { window } : {}),
            ...users(),
        };
    }

    // Aggregates. A filled calendar past the cap is refused, never cut short.
    const over = index.get('c_over');
    if (over !== undefined && raw.rows.some((row) => row[over] === 1)) {
        throw tooManyBuckets(plan.bucket!);
    }
    const timeName = plan.timeName ?? 'time';
    const labels = plan.windows.map((w) => w.label);
    const suffix = (name: string, w: number) => (plan.comparison ? `${name}:${labels[w]}` : name);
    const columns: SpecColumn[] = [];
    if (plan.comparison && plan.bucket) {
        columns.push({ name: 'period', kind: 'number', role: 'period' });
    }
    for (const g of plan.groups) {
        columns.push({
            name: g.name,
            kind: g.kind,
            role: g.labels ? 'segment' : 'group',
            ...(g.field ? { field: g.field } : {}),
        });
    }
    plan.windows.forEach((w, j) => {
        if (!plan.comparison && j > 0) {
            return;
        }
        const partial = plan.comparison && w.range ? { partial: containsDay(w.range, plan.today) } : {};
        const windowed = plan.comparison ? { window: w.label } : {};
        if (plan.bucket) {
            columns.push({
                name: suffix(timeName, j),
                kind: 'date',
                role: 'time',
                field: timeName,
                ...windowed,
                ...partial,
            });
        }
        for (const m of plan.measures) {
            columns.push({
                name: suffix(m.name, j),
                kind: m.kind,
                role: 'measure',
                measure: m.name,
                ...(m.field ? { field: m.field } : {}),
                ...(m.currency ? { currency: m.currency } : {}),
                ...(m.minorUnits ? { minorUnits: true } : {}),
                ...windowed,
                ...partial,
            });
        }
    });

    /** Rows of one kind, merged across windows by their grouping (and bucket place, with comparison windows). */
    const pivot = (kind: number, dims: string[]): SpecRow[] => {
        const out = new Map<string, SpecRow & { partialWindows: string[] }>();
        for (const row of raw.rows) {
            if (Number(row[index.get('c_kind')!]) !== kind) {
                continue;
            }
            const w = Number(row[index.get('c_w')!]);
            const place = get(row, 'c_i');
            const bucket = get(row, 'c_b');
            const groupValues = plan.groups.map((_, i) => get(row, `c_g${i}`));
            const keyParts = [
                ...(dims.includes('c_b') ? [plan.comparison ? place : bucket] : []),
                ...groupValues.filter((_, i) => dims.includes(`c_g${i}`)),
            ];
            const key = JSON.stringify(plan.comparison ? keyParts : [w, ...keyParts]);
            let target = out.get(key);
            if (!target) {
                const values: Record<string, SpecCell> = {};
                if (plan.comparison && plan.bucket && dims.includes('c_b')) {
                    values.period = typeof place === 'number' ? place + 1 : null;
                }
                plan.groups.forEach((g, i) => {
                    if (dims.includes(`c_g${i}`)) {
                        values[g.name] = groupValue(g, groupValues[i]!);
                        notePeople(g.kind, groupValues[i]!);
                    }
                });
                // Every window's columns, empty until its row comes.
                labels.forEach((_, j) => {
                    if (!plan.comparison && j > 0) {
                        return;
                    }
                    if (plan.bucket && dims.includes('c_b')) {
                        values[suffix(timeName, j)] = null;
                    }
                    for (const m of plan.measures) {
                        values[suffix(m.name, j)] = null;
                    }
                });
                target = { values, partialWindows: [] };
                out.set(key, target);
            }
            if (plan.bucket && dims.includes('c_b')) {
                target.values[suffix(timeName, w)] = bucket;
                if (typeof bucket === 'string' && bucketPartial(bucket, plan.bucket, plan.today)) {
                    target.partialWindows.push(labels[w]!);
                }
            }
            plan.measures.forEach((m, i) => {
                target.values[suffix(m.name, w)] = get(row, `c_r${i}`);
            });
            const unverified = get(row, 'c_unv');
            if (kind === 9 && typeof unverified === 'number' && unverified > 0) {
                target.unverified = true;
            }
        }
        return [...out.values()].map(({ partialWindows, ...row }) =>
            partialWindows.length ? { ...row, partial: plan.comparison ? partialWindows : true } : row,
        );
    };
    const dims = [...(plan.bucket ? ['c_b'] : []), ...plan.groups.map((_, i) => `c_g${i}`)];
    const rows = pivot(9, dims);
    const totalRows = raw.rows.filter((r) => Number(r[index.get('c_kind')!]) === 0);
    let totals: Record<string, SpecCell> | null = null;
    if (plan.totals) {
        totals = {};
        for (const row of totalRows) {
            const w = Number(row[index.get('c_w')!]);
            if (!plan.comparison && w > 0) {
                continue;
            }
            plan.measures.forEach((m, i) => {
                totals![suffix(m.name, w)] = get(row, `c_r${i}`);
            });
        }
    }
    const first = totalRows.find((r) => Number(r[index.get('c_w')!]) === 0);
    const excluded =
        plan.verified && first
            ? {
                  excluded: {
                      rows: Number(get(first, 'c_unv') ?? 0),
                      value: Object.fromEntries(
                          totalRows.flatMap((row) => {
                              const w = Number(row[index.get('c_w')!]);
                              return plan.comparison || w === 0
                                  ? plan.baseMeasures.map((i) => [
                                        suffix(plan.measures[i]!.name, w),
                                        get(row, `c_x${i}`) as number | null,
                                    ])
                                  : [];
                          }),
                      ),
                  },
              }
            : {};
    const coverage =
        plan.coverage && first
            ? {
                  coverage: {
                      fields: Object.fromEntries(
                          plan.coverage.map((f, i) => [f, Number(get(first, `c_cov${i}`) ?? 0)]),
                      ),
                      none: Number(get(first, 'c_none') ?? 0),
                  },
              }
            : {};
    const subtotals = plan.subtotals
        ? {
              subtotals: {
                  [dims[0] === 'c_b' ? timeName : plan.groups[0]!.name]: pivot(1, [dims[0]!]),
                  [dims[1] === 'c_b' ? timeName : plan.groups[dims[0] === 'c_b' ? 0 : 1]!.name]: pivot(2, [dims[1]!]),
              },
          }
        : {};
    const windowFields = plan.comparison
        ? { windows: plan.windows.map(windowInfo).filter((w) => w !== undefined) }
        : plan.windows[0]?.range
          ? { window: windowInfo(plan.windows[0])! }
          : {};
    return {
        ...base,
        columns,
        rows,
        totals,
        ...subtotals,
        ...excluded,
        ...coverage,
        ...windowFields,
        ...users(),
    };
}
