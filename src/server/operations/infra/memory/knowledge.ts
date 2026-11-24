import type { OpsFilters } from '@socio/shared/operations/operations';
import {
    OPS_STALE_DAYS,
    type OpsDatasetRow,
    type OpsKnowledge,
    type OpsPageRow,
    type OpsRequestRow,
    type OpsSpaceRow,
    type OpsStorage,
    type OpsToolUse,
} from '@socio/shared/operations/operations-knowledge';

import { afterCursor } from '../../domain/cursor.js';
import {
    searchTimings,
    storageOf,
    storedMs,
    type DataAccessFact,
    type DatabaseFact,
    type DatasetDayFact,
    type DatasetFact,
    type LifetimeFact,
    type OwnerFilesFact,
    type PageEditFact,
    type PageFact,
    type PageUseFact,
    type SearchDayFact,
    type SpaceFact,
} from '../../domain/knowledge.js';
import type { OpsPage, OpsPageRequest, OpsScope } from '../../domain/reader.js';

const DAY = 86_400_000;

/** A tool call, as `f_tool` keeps it (the fields read here). */
export interface ToolFact {
    tool: string;
    outcome: string;
    startedAt: number;
    socioId: string | null;
    spaceId?: string | null;
    source: string;
    /** The person whose message started its turn, when a person did. */
    personId?: string | null;
}

/** What the Knowledge and Capabilities sections read (CB-191). */
export interface KnowledgeFacts {
    spaces?: readonly SpaceFact[];
    pages?: readonly PageFact[];
    use?: readonly PageUseFact[];
    edits?: readonly PageEditFact[];
    searchDays?: readonly SearchDayFact[];
    access?: readonly DataAccessFact[];
    datasets?: readonly DatasetFact[];
    datasetDays?: readonly DatasetDayFact[];
    lifetimes?: readonly LifetimeFact[];
    owners?: readonly OwnerFilesFact[];
    database?: DatabaseFact | null;
    tools?: readonly ToolFact[];
    requests?: readonly OpsRequestRow[];
}

const inRange = (at: number, from: number | null, to: number) => (from === null || at >= from) && at < to;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `MemoryOpsReader`'s Knowledge and Capabilities answers (CB-191), from
 * facts in memory: what the DuckDB queries answer, by the same rules,
 * written plainly, for the contract tests.
 */
export class MemoryKnowledge {
    constructor(private facts: KnowledgeFacts) {}

    /** Whether it holds anything at all. */
    get some() {
        return Object.values(this.facts).some((value) => (Array.isArray(value) ? value.length > 0 : !!value));
    }

    knowledge({ window, filters }: OpsScope): OpsKnowledge {
        const { from, to } = window;
        const staleBefore = to - OPS_STALE_DAYS * DAY;
        const pages = this.livePages(filters.space);
        const edits = this.edits(filters, from, to);
        const rows = new Map<string, Omit<OpsSpaceRow, 'spaceId' | 'name'>>();
        const row = (id: string) => {
            let found = rows.get(id);
            if (!found) {
                rows.set(id, (found = { pages: 0, chars: 0, created: 0, edits: 0, stale: 0 }));
            }
            return found;
        };
        for (const page of pages) {
            const space = row(page.spaceId);
            space.pages++;
            space.chars += page.chars;
            if (inRange(page.createdAt, from, to)) {
                space.created++;
            }
            if (page.activeAt < staleBefore) {
                space.stale++;
            }
        }
        for (const edit of edits) {
            row(edit.spaceId).edits++;
        }
        for (const space of this.facts.spaces ?? []) {
            if (!space.deletedAt && (!filters.space || space.id === filters.space)) {
                row(space.id);
            }
        }
        const names = new Map((this.facts.spaces ?? []).map((space) => [space.id, space.name]));
        const spaces = [...rows]
            .map(([spaceId, counts]) => ({
                spaceId,
                name: names.get(spaceId) ?? null,
                ...counts,
            }))
            .sort((a, b) => b.pages - a.pages || byText(a.spaceId, b.spaceId));
        const sum = (key: keyof Omit<OpsSpaceRow, 'spaceId' | 'name'>) =>
            spaces.reduce((total, space) => total + space[key], 0);
        return {
            spaces,
            totals: {
                pages: sum('pages'),
                chars: sum('chars'),
                created: sum('created'),
                edits: sum('edits'),
                stale: sum('stale'),
                editors: new Set(
                    edits.filter((edit) => edit.authorId !== null).map((edit) => `${edit.authorKind}:${edit.authorId}`),
                ).size,
            },
            search: this.search(from, to),
            access: this.accessSummary(filters, from, to),
        };
    }

    pages({ window, filters }: OpsScope, page: OpsPageRequest): OpsPage<OpsPageRow> {
        const staleBefore = window.to - OPS_STALE_DAYS * DAY;
        const counts = new Map<string, number>();
        for (const edit of this.edits({ ...filters, space: undefined }, window.from, window.to)) {
            counts.set(edit.pageId, (counts.get(edit.pageId) ?? 0) + 1);
        }
        const names = new Map((this.facts.spaces ?? []).map((space) => [space.id, space.name]));
        const { cursor } = page;
        const rows = this.livePages(filters.space)
            .filter(
                (row) =>
                    !cursor ||
                    row.activeAt > (cursor.key as number) ||
                    (row.activeAt === cursor.key && row.pageId > cursor.id),
            )
            .sort((a, b) => a.activeAt - b.activeAt || byText(a.pageId, b.pageId));
        const items = rows.slice(0, page.limit).map((row): OpsPageRow => ({
            pageId: row.pageId,
            spaceId: row.spaceId,
            spaceName: names.get(row.spaceId) ?? null,
            title: row.title,
            chars: row.chars,
            revision: row.revision,
            edits: counts.get(row.pageId) ?? 0,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            usedAt: row.usedAt,
            activeAt: row.activeAt,
            stale: row.activeAt < staleBefore,
        }));
        const last = items.at(-1);
        return {
            items,
            next: rows.length > page.limit && last ? { key: last.activeAt, id: last.pageId } : null,
        };
    }

    datasets({ window, filters }: OpsScope, page: OpsPageRequest): OpsPage<OpsDatasetRow> {
        const stats = new Map<string, { n: number; denied: number; last: number }>();
        for (const access of this.access(filters, window.from, window.to)) {
            if (access.datasetId === null) {
                continue;
            }
            const found = stats.get(access.datasetId) ?? {
                n: 0,
                denied: 0,
                last: -Infinity,
            };
            found.n++;
            if (access.outcome === 'denied') {
                found.denied++;
            }
            found.last = Math.max(found.last, access.at);
            stats.set(access.datasetId, found);
        }
        const rows = (this.facts.datasets ?? [])
            .filter(
                (dataset) =>
                    dataset.deletedAt === null &&
                    (!filters.person || dataset.ownerId === filters.person) &&
                    (!filters.socio || (stats.get(dataset.id)?.n ?? 0) > 0),
            )
            .map((dataset) => ({
                dataset,
                key: { key: dataset.sizeBytes + dataset.historyBytes, id: dataset.id },
            }))
            .filter(({ key }) => afterCursor(key, page.cursor))
            .sort((a, b) => b.key.key - a.key.key || byText(b.key.id, a.key.id));
        const items = rows.slice(0, page.limit);
        return {
            items: items.map(({ dataset }) => {
                const found = stats.get(dataset.id);
                return {
                    datasetId: dataset.id,
                    name: dataset.name,
                    scratch: dataset.scratch,
                    sizeBytes: dataset.sizeBytes,
                    historyBytes: dataset.historyBytes,
                    tables: dataset.tables,
                    createdAt: dataset.createdAt,
                    updatedAt: dataset.updatedAt,
                    accesses: found?.n ?? 0,
                    denied: found?.denied ?? 0,
                    lastAccessAt: found ? found.last : null,
                };
            }),
            next: rows.length > page.limit ? items.at(-1)!.key : null,
        };
    }

    storage({ window }: OpsScope): OpsStorage {
        return storageOf(
            {
                datasets: this.facts.datasets ?? [],
                days: this.facts.datasetDays ?? [],
                lifetimes: this.facts.lifetimes ?? [],
                owners: this.facts.owners ?? [],
                database: this.facts.database ?? null,
            },
            window,
        );
    }

    toolUse({ window, filters }: OpsScope): OpsToolUse[] {
        const tools = new Map<string, OpsToolUse>();
        for (const call of this.facts.tools ?? []) {
            if (
                !inRange(call.startedAt, window.from, window.to) ||
                (filters.socio && call.socioId !== filters.socio) ||
                (filters.space && call.spaceId !== filters.space) ||
                (filters.source && call.source !== filters.source) ||
                (filters.person && call.personId !== filters.person)
            ) {
                continue;
            }
            const found = tools.get(call.tool) ?? {
                tool: call.tool,
                calls: 0,
                errors: 0,
                refused: 0,
            };
            found.calls++;
            if (call.outcome === 'error' || call.outcome === 'timeout') {
                found.errors++;
            }
            if (call.outcome === 'refused') {
                found.refused++;
            }
            tools.set(call.tool, found);
        }
        return [...tools.values()].sort((a, b) => b.calls - a.calls || byText(a.tool, b.tool));
    }

    requests(page: OpsPageRequest): OpsPage<OpsRequestRow> {
        const rows = (this.facts.requests ?? [])
            .map((request) => ({
                request,
                key: { key: request.lastAt, id: request.issueId },
            }))
            .filter(({ key }) => afterCursor(key, page.cursor))
            .sort((a, b) => b.key.key - a.key.key || byText(b.key.id, a.key.id));
        const items = rows.slice(0, page.limit);
        return {
            items: items.map(({ request }) => ({ ...request })),
            next: rows.length > page.limit ? items.at(-1)!.key : null,
        };
    }

    private livePages(space: string | undefined) {
        const used = new Map((this.facts.use ?? []).map((use) => [use.pageId, use.usedAt]));
        return (this.facts.pages ?? [])
            .filter((page) => !space || page.spaceId === space)
            .map((page) => {
                const usedAt = used.get(page.pageId) ?? null;
                return {
                    ...page,
                    usedAt,
                    activeAt: Math.max(page.updatedAt, usedAt ?? 0),
                };
            });
    }

    private edits(filters: OpsFilters, from: number | null, to: number) {
        return (this.facts.edits ?? []).filter(
            (edit) =>
                inRange(edit.at, from, to) &&
                (!filters.space || edit.spaceId === filters.space) &&
                (!filters.socio || (edit.authorKind === 'socio' && edit.authorId === filters.socio)) &&
                (!filters.person || (edit.authorKind === 'person' && edit.authorId === filters.person)),
        );
    }

    private access(filters: OpsFilters, from: number | null, to: number) {
        return (this.facts.access ?? []).filter(
            (access) =>
                inRange(access.at, from, to) &&
                (!filters.socio || access.socioId === filters.socio) &&
                (!filters.person || access.ownerId === filters.person),
        );
    }

    private search(from: number | null, to: number): OpsKnowledge['search'] {
        const days = (this.facts.searchDays ?? [])
            .filter((day) => inRange(day.at, from, to))
            .sort((a, b) => a.at - b.at);
        const histogram: Record<number, number> = {};
        for (const day of days) {
            for (const [bucket, count] of Object.entries(day.histogram)) {
                histogram[Number(bucket)] = (histogram[Number(bucket)] ?? 0) + count;
            }
        }
        const maxMs = days.length ? Math.max(...days.map((day) => storedMs(day.maxMs))) : null;
        const total = (key: 'queries' | 'empty' | 'corrected' | 'trigram') =>
            days.reduce((sum, day) => sum + day[key], 0);
        return {
            queries: total('queries'),
            empty: total('empty'),
            corrected: total('corrected'),
            trigram: total('trigram'),
            ...searchTimings(histogram, maxMs),
            maxMs,
            days: days.map((day) => ({
                at: day.at,
                queries: day.queries,
                empty: day.empty,
            })),
        };
    }

    private accessSummary(filters: OpsFilters, from: number | null, to: number): OpsKnowledge['access'] {
        const list = this.access(filters, from, to);
        const group = (key: (access: DataAccessFact) => string) => {
            const counts = new Map<string, number>();
            for (const access of list) {
                counts.set(key(access), (counts.get(key(access)) ?? 0) + 1);
            }
            return counts;
        };
        return {
            total: list.length,
            denied: list.filter((access) => access.outcome === 'denied').length,
            errors: list.filter((access) => access.outcome === 'error').length,
            datasets: new Set(list.map((access) => access.datasetId).filter((id): id is string => id !== null)).size,
            chats: new Set(list.flatMap((access) => (access.threadId ? [access.threadId] : []))).size,
            actions: [...group((access) => `${access.action}\u0000${access.outcome}`)]
                .map(([key, count]) => {
                    const [action, outcome] = key.split('\u0000') as [string, string];
                    return { action, outcome, count };
                })
                .sort((a, b) => b.count - a.count || byText(a.action, b.action) || byText(a.outcome, b.outcome)),
            actors: [...group((access) => access.actorKind)]
                .map(([kind, count]) => ({ kind, count }))
                .sort((a, b) => b.count - a.count || byText(a.kind, b.kind)),
        };
    }
}
