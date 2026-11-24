import { FAILURE_CATEGORIES, isFailure, type FailureCategory } from '@socio/shared/failure-taxonomy';
import { bucketStart, bucketStarts, type OpsWindow } from '@socio/shared/operations/operations';
import {
    BREAKDOWN_LIMIT,
    FRICTION_LIMIT,
    FRICTION_PEOPLE,
    FRICTION_TIMES,
    percentile,
    type OpsBreakdownRow,
    type OpsFailureFilter,
    type OpsFailurePoint,
    type OpsFailureRow,
    type OpsFriction,
    type OpsFrictionRow,
    type OpsReliabilitySummary,
    type ReliabilityDimension,
} from '@socio/shared/operations/operations-reliability';

import { afterCursor } from '../../domain/cursor.js';
import type { OpsPage, OpsPageRequest } from '../../domain/reader.js';

import type { TurnFact } from './facts.js';

/** A tool call, as `f_tool` keeps it (the fields read here). */
export interface ToolFact {
    runId: string;
    /** Its place in the turn's trace. */
    idx: number;
    tool: string;
    code?: string | null;
    /** The failure taxonomy's; null: it worked. */
    category: FailureCategory | null;
    rule?: string;
    startedAt: number;
    durationMs: number;
}

/** Text in the store's order: by code unit, as DuckDB's VARCHAR. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const failed = (turn: TurnFact) => isFailure(turn.failureCategory);
const durationOf = (turn: TurnFact) => (turn.finishedAt == null ? null : turn.finishedAt - turn.startedAt);

/**
 * Reliability from facts in memory (CB-189), as `infra/duckdb/
 * reliability.ts` answers it: `MemoryOpsReader` passes the turns its
 * scope keeps and every tool call.
 */
export class MemoryReliability {
    private readonly byRun = new Map<string, ToolFact[]>();
    constructor(tools: readonly ToolFact[]) {
        for (const tool of [...tools].sort((a, b) => a.idx - b.idx)) {
            const list = this.byRun.get(tool.runId) ?? [];
            list.push(tool);
            this.byRun.set(tool.runId, list);
        }
    }

    private toolsOf(turns: readonly TurnFact[]) {
        return turns.flatMap((turn) => this.byRun.get(turn.runId) ?? []);
    }

    summary(turns: readonly TurnFact[]): Omit<OpsReliabilitySummary, 'previousTurns' | 'previousFailures'> {
        const tools = this.toolsOf(turns);
        return {
            turns: turns.length,
            failures: turns.filter(failed).length,
            stopped: turns.filter((turn) => turn.failureCategory === 'stopped').length,
            interrupted: turns.filter((turn) => turn.status === 'interrupted' && failed(turn)).length,
            retries: turns.reduce((sum, turn) => sum + (turn.retries ?? 0), 0),
            retriedTurns: turns.filter((turn) => (turn.retries ?? 0) > 0).length,
            fallbacks: turns.filter((turn) => turn.fallback).length,
            toolCalls: tools.length,
            toolFailures: tools.filter((tool) => isFailure(tool.category)).length,
            categories: FAILURE_CATEGORIES.map((category) => ({
                category,
                turns: turns.filter((turn) => turn.failureCategory === category).length,
                tools: tools.filter((tool) => tool.category === category).length,
            })),
        };
    }

    series(turns: readonly TurnFact[], window: OpsWindow, start: number): OpsFailurePoint[] {
        const { bucket, timeZone, to } = window;
        const points = new Map(
            bucketStarts(start, to, bucket, timeZone).map((at) => [
                at,
                {
                    at,
                    turns: 0,
                    failures: 0,
                    counts: FAILURE_CATEGORIES.map(() => 0),
                },
            ]),
        );
        for (const turn of turns) {
            const point = points.get(bucketStart(turn.startedAt, bucket, timeZone));
            if (!point) {
                continue;
            }
            point.turns++;
            if (failed(turn)) {
                point.failures++;
            }
            const index = turn.failureCategory ? FAILURE_CATEGORIES.indexOf(turn.failureCategory) : -1;
            if (index >= 0) {
                point.counts[index]!++;
            }
        }
        return [...points.values()];
    }

    breakdown(turns: readonly TurnFact[], by: ReliabilityDimension): OpsBreakdownRow[] {
        interface Row {
            key: string;
            label: string | null;
            category: FailureCategory | null;
            code: string | null;
            ms: number | null;
            fail: boolean;
        }
        const rows: Row[] =
            by === 'tool'
                ? this.toolsOf(turns).map((tool) => ({
                      key: tool.tool,
                      label: null,
                      category: tool.category,
                      code: tool.code ?? null,
                      ms: tool.durationMs,
                      fail: isFailure(tool.category),
                  }))
                : (by === 'code' ? turns.filter(failed) : turns).map((turn) => ({
                      key:
                          (by === 'code'
                              ? turn.failureCode
                              : by === 'socio'
                                ? turn.socioId
                                : by === 'model'
                                  ? turn.model
                                  : turn.source) ?? '',
                      label: by === 'socio' ? (turn.socioName ?? null) : null,
                      category: turn.failureCategory ?? null,
                      code: turn.failureCode ?? null,
                      ms: durationOf(turn),
                      fail: failed(turn),
                  }));
        const groups = new Map<string, Row[]>();
        for (const row of rows) {
            const list = groups.get(row.key) ?? [];
            list.push(row);
            groups.set(row.key, list);
        }
        /** The most frequent value, ties by `order`. */
        const mode = <T>(values: T[], order: (a: T, b: T) => number) => {
            const counts = new Map<T, number>();
            for (const value of values) {
                counts.set(value, (counts.get(value) ?? 0) + 1);
            }
            return [...counts].sort((a, b) => b[1] - a[1] || order(a[0], b[0]))[0]?.[0] ?? null;
        };
        return [...groups]
            .map(([key, list]): OpsBreakdownRow => {
                const failures = list.filter((row) => row.fail);
                const times = list
                    .map((row) => row.ms)
                    .filter((ms): ms is number => ms !== null)
                    .sort((a, b) => a - b);
                return {
                    key,
                    label: list.find((row) => row.label !== null)?.label ?? null,
                    total: list.length,
                    failed: failures.length,
                    category: mode(
                        failures.map((row) => row.category).filter((c): c is FailureCategory => c !== null),
                        (a, b) => FAILURE_CATEGORIES.indexOf(a) - FAILURE_CATEGORIES.indexOf(b),
                    ),
                    code: mode(
                        failures.map((row) => row.code).filter((c): c is string => c !== null),
                        byText,
                    ),
                    p50Ms: percentile(times, 0.5),
                    p95Ms: percentile(times, 0.95),
                };
            })
            .sort((a, b) => b.failed - a.failed || b.total - a.total || byText(a.key, b.key))
            .slice(0, BREAKDOWN_LIMIT);
    }

    failures(turns: readonly TurnFact[], page: OpsPageRequest, filter: OpsFailureFilter = {}): OpsPage<OpsFailureRow> {
        const rows = turns
            .flatMap((turn): OpsFailureRow[] => {
                const broken = (this.byRun.get(turn.runId) ?? []).filter((tool) => isFailure(tool.category));
                const first = broken[0];
                const own = failed(turn);
                if (!own && !first) {
                    return [];
                }
                if (filter.tool && !broken.some((tool) => tool.tool === filter.tool)) {
                    return [];
                }
                const row: OpsFailureRow = {
                    runId: turn.runId,
                    threadId: turn.threadId,
                    socioId: turn.socioId,
                    socioName: turn.socioName ?? null,
                    source: turn.source,
                    status: turn.status,
                    startedAt: turn.startedAt,
                    finishedAt: turn.finishedAt ?? null,
                    level: own ? 'turn' : 'tool',
                    category: own ? turn.failureCategory! : first!.category!,
                    rule: (own ? turn.failureRule : first!.rule) ?? '',
                    code: (own ? turn.failureCode : first!.code) ?? null,
                    endReason: turn.endReason ?? null,
                    model: turn.model ?? null,
                    tool: first?.tool ?? null,
                    toolFailures: broken.length,
                };
                return filter.category && row.category !== filter.category ? [] : [row];
            })
            .filter((row) => afterCursor({ key: row.startedAt, id: row.runId }, page.cursor))
            .sort((a, b) => b.startedAt - a.startedAt || byText(b.runId, a.runId));
        const items = rows.slice(0, page.limit);
        const last = items.at(-1);
        return {
            items,
            next: rows.length > page.limit && last ? { key: last.startedAt, id: last.runId } : null,
        };
    }

    /** `turns` are those of the window's last 7 days (`frictionFrom`). */
    friction(turns: readonly TurnFact[], from: number): OpsFriction {
        interface Seen {
            category: FailureCategory;
            code: string | null;
            tool: string | null;
            people: Map<string, number>;
            lastAt: number;
        }
        const groups = new Map<string, Seen>();
        const add = (
            category: FailureCategory,
            code: string | null,
            tool: string | null,
            person: string,
            at: number,
        ) => {
            const key = JSON.stringify([category, code, tool]);
            let seen = groups.get(key);
            if (!seen) {
                groups.set(key, (seen = { category, code, tool, people: new Map(), lastAt: at }));
            }
            seen.people.set(person, (seen.people.get(person) ?? 0) + 1);
            seen.lastAt = Math.max(seen.lastAt, at);
        };
        for (const turn of turns) {
            if (!turn.personId) {
                continue;
            }
            if (failed(turn)) {
                add(turn.failureCategory!, turn.failureCode ?? null, null, turn.personId, turn.startedAt);
            }
            for (const tool of this.byRun.get(turn.runId) ?? []) {
                if (isFailure(tool.category)) {
                    add(tool.category!, tool.code ?? null, tool.tool, turn.personId, tool.startedAt);
                }
            }
        }
        const nullsFirst = (a: string | null, b: string | null) =>
            a === b ? 0 : a === null ? -1 : b === null ? 1 : byText(a, b);
        const rows = [...groups.values()]
            .map((seen): OpsFrictionRow => ({
                category: seen.category,
                code: seen.code,
                tool: seen.tool,
                people: seen.people.size,
                failures: [...seen.people.values()].reduce((a, b) => a + b, 0),
                mostForOne: Math.max(...seen.people.values()),
                lastAt: seen.lastAt,
            }))
            .filter((row) => row.people >= FRICTION_PEOPLE || row.mostForOne >= FRICTION_TIMES)
            .sort(
                (a, b) =>
                    b.people - a.people ||
                    b.failures - a.failures ||
                    b.lastAt - a.lastAt ||
                    byText(a.category, b.category) ||
                    nullsFirst(a.code, b.code) ||
                    nullsFirst(a.tool, b.tool),
            )
            .slice(0, FRICTION_LIMIT);
        return { from, rows };
    }
}
