import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OpsBucket, OpsFilters } from '@socio/shared/operations/operations';
import { analyticsDefaults } from '@socio/shared/operations/operations-analytics';
import type { OpsGrounding } from '@socio/shared/operations/operations-grounding';
import type { OpsIssueVelocity } from '@socio/shared/operations/operations-reliability';
import { RUN_REF_KINDS, type RunRefKind } from '@socio/shared/runs/run-refs';

import { AnalyticsEngine } from '../src/server/operations/analytics/engine.js';
import '../src/server/operations/etl/sources.js';
import { ETL_STEPS, ETL_VERSION } from '../src/server/operations/analytics/steps.js';
import type { OpsQueryName } from '../src/server/operations/domain/ops-queries.js';
import type { OpsScope } from '../src/server/operations/domain/reader.js';
import { MemoryGrounding } from '../src/server/operations/infra/memory/grounding.js';
import {
    MemoryOpsReader,
    type IssueFact,
    type IssueRunFact,
    type RunRefFact,
} from '../src/server/operations/infra/memory/reader.js';

import { seedKnowledge } from './fixtures/seed-ops-knowledge.js';
import { PEOPLE, random, seedOpsDatabase, SOCIOS, TEAM } from './fixtures/seed-ops-runs.js';

// Operations' grounding and report links (CB-194): what turns read
// (`run_refs`) and the turns items were filed from (`issue_runs`), copied
// into the analytics store and answered as the in-memory reader answers
// from what was written: the Space heatmap, the pages read most, one
// chat's grounding and the time from a failure to its report.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function seeded(now: number) {
    const dir = mkdtempSync(join(tmpdir(), 'ops-grounding-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const sqlitePath = join(dir, 'company-brain.sqlite');
    const runs = seedOpsDatabase(sqlitePath, {
        turns: 240,
        start: now - 20 * DAY,
        spanMs: 19 * DAY,
    });
    cleanup.push(() => runs.db.close());
    const knowledge = seedKnowledge(runs.db, { now, pages: 200 });
    const rand = random(23);
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
    // What turns read: pages by every route (the same page by a search and
    // a read in one turn counts once in a Space), a removed page, datasets
    // and recalls, which have no Space.
    const refs: RunRefFact[] = [];
    const seen = new Set<string>();
    const insert = runs.db.prepare(
        'INSERT OR IGNORE INTO run_refs (runId, threadId, kind, spaceId, refId, at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const add = (ref: RunRefFact) => {
        const key = `${ref.runId} ${ref.kind} ${ref.refId}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        insert.run(ref.runId, ref.threadId, ref.kind, ref.spaceId, ref.refId, ref.at);
        refs.push(ref);
    };
    const pages = knowledge.facts.pages;
    const datasets = knowledge.facts.datasets;
    runs.db.exec('BEGIN');
    for (const turn of runs.turns) {
        if (rand() < 0.3) {
            continue;
        }
        const at = turn.startedAt + 1000;
        for (let n = Math.floor(rand() * 4); n >= 0; n--) {
            const page = rand() < 0.05 ? { pageId: 'page-gone', spaceId: 'space-gone' } : pick(pages);
            const kind = pick<RunRefKind>(['page', 'search', 'context']);
            add({
                runId: turn.runId,
                threadId: turn.threadId,
                kind,
                spaceId: page.spaceId,
                refId: page.pageId,
                at: at + n,
            });
            if (kind === 'search' && rand() < 0.5) {
                add({
                    runId: turn.runId,
                    threadId: turn.threadId,
                    kind: 'page',
                    spaceId: page.spaceId,
                    refId: page.pageId,
                    at: at + n + 1,
                });
            }
        }
        if (rand() < 0.3) {
            add({
                runId: turn.runId,
                threadId: turn.threadId,
                kind: 'dataset',
                spaceId: null,
                refId: pick(datasets).id,
                at: at + 10,
            });
        }
        if (rand() < 0.2) {
            add({
                runId: turn.runId,
                threadId: turn.threadId,
                kind: 'recall',
                spaceId: null,
                refId: `call-${Math.floor(rand() * 5)}`,
                at: at + 20,
            });
        }
    }
    // Items filed from failed turns ("File issue" in Runs), one from a
    // finished turn (not a failure) and a socio's filing in its turn.
    const issues: IssueFact[] = [];
    const issueRuns: IssueRunFact[] = [];
    const issue = runs.db.prepare(
        "INSERT INTO issues (id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES (?, ?, 'Run failed', 'secret detail', 'triage', 'medium', 'bug', ?, 'web', ?, ?)",
    );
    const link = runs.db.prepare(
        'INSERT INTO issue_runs (issueId, runId, threadId, via, linkedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const failed = runs.turns.filter((turn) => turn.status === 'failed' && turn.finishedAt != null);
    const finished = runs.turns.find((turn) => turn.status === 'finished')!;
    const linked = [
        ...failed.slice(0, 12).map((turn) => ({ turn, via: 'report' as const })),
        { turn: finished, via: 'report' as const },
        { turn: failed[12] ?? failed[0]!, via: 'socio' as const },
    ];
    linked.forEach(({ turn, via }, index) => {
        const id = `filed-${index}`;
        const reporterId = via === 'socio' ? `dot:${turn.socioId}` : pick(PEOPLE);
        const createdAt = (turn.finishedAt ?? turn.startedAt) + (index + 1) * 37 * 60_000;
        issue.run(id, 5000 + index, reporterId, createdAt, createdAt);
        link.run(id, turn.runId, turn.threadId, via, reporterId, createdAt);
        issues.push({
            id,
            kind: 'bug',
            reporterId,
            createdAt,
            closedAt: null,
        });
        issueRuns.push({
            issueId: id,
            runId: turn.runId,
            via,
            linkedAt: createdAt,
        });
    });
    runs.db.exec('COMMIT');
    return { dir, sqlitePath, runs, knowledge, refs, issues, issueRuns };
}
type Seeded = ReturnType<typeof seeded>;

function engine(s: Seeded) {
    const e = new AnalyticsEngine({
        dir: join(s.dir, 'analytics'),
        sqlitePath: s.sqlitePath,
        defaults: analyticsDefaults({}),
        defaultTimeZone: 'UTC',
        steps: ETL_STEPS,
        etlVersion: ETL_VERSION,
        lockRetryMs: 100,
        log: () => {},
    });
    cleanup.push(() => e.stop());
    return e;
}

function memoryOf(s: Seeded) {
    return new MemoryOpsReader({
        turns: s.runs.turns,
        messages: s.runs.messages,
        issues: s.issues,
        knowledge: { ...s.knowledge.facts, spaces: s.knowledge.spaces() },
        grounding: { refs: s.refs, issueRuns: s.issueRuns },
    });
}

async function until<T>(check: () => T | Promise<T>, timeoutMs = 60_000) {
    const started = Date.now();
    for (;;) {
        const value = await check();
        if (value) {
            return value as NonNullable<T>;
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error('Timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function ask<T = unknown>(e: AnalyticsEngine, query: OpsQueryName, params: object = {}): Promise<T> {
    const answer = await e.handle({ op: 'query', query, params });
    if (!answer.ok) {
        throw new Error(`${query}: ${answer.error}`);
    }
    return answer.value as T;
}

function scopeOf(
    {
        from,
        to,
        bucket = 'day',
        timeZone = 'UTC',
    }: { from: number | null; to: number; bucket?: OpsBucket; timeZone?: string },
    filters: OpsFilters = {},
): OpsScope {
    return {
        window: { from, to, bucket, buckets: [bucket], previous: null, timeZone },
        filters,
    };
}

/** Waits until the store holds every reference, page and turn. */
async function caughtUp(e: AnalyticsEngine, s: Seeded) {
    const runs = new Set(s.refs.map((ref) => ref.runId)).size;
    const all = scopeOf({ from: null, to: Date.now() + DAY });
    await until(async () => {
        if (e.status().state !== 'ready') {
            return false;
        }
        const [grounding, knowledge, turns] = await Promise.all([
            ask<OpsGrounding>(e, 'grounding', all).catch(() => undefined),
            ask<{ totals: { pages: number } }>(e, 'knowledge', all).catch(() => undefined),
            ask<{ id: string; value: number | null }[]>(e, 'overview', all).catch(() => undefined),
        ]);
        return (
            grounding?.runs === runs &&
            knowledge?.totals.pages === s.knowledge.facts.pages.length &&
            turns?.find((tile) => tile.id === 'turns')?.value === s.runs.turns.length
        );
    }, 120_000);
}

describe('grounding in the analytics store', () => {
    it('answers the heatmap, pages and a chat’s grounding as the in-memory reader does', async () => {
        const now = Date.now();
        const s = seeded(now);
        const e = engine(s);
        await e.start();
        await caughtUp(e, s);
        const memory = memoryOf(s);
        const to = now + DAY;
        const scopes: Array<[string, OpsScope]> = [
            ['all time, by day', scopeOf({ from: null, to })],
            ['a week, by hour', scopeOf({ from: now - 7 * DAY, to, bucket: 'hour' })],
            [
                'a month, by week, New York',
                scopeOf({
                    from: now - 30 * DAY,
                    to,
                    bucket: 'week',
                    timeZone: 'America/New_York',
                }),
            ],
            ['Kolkata (a half-hour zone)', scopeOf({ from: now - 10 * DAY, to, timeZone: 'Asia/Kolkata' })],
            ['a Space', scopeOf({ from: null, to }, { space: 'space-1' })],
            ['a socio', scopeOf({ from: null, to }, { socio: SOCIOS[0]!.id })],
            ['a person', scopeOf({ from: null, to }, { person: PEOPLE[0] })],
            ['a source', scopeOf({ from: null, to }, { source: 'telegram' })],
            ['nothing matches', scopeOf({ from: null, to }, { space: 'nope' })],
        ];
        for (const [label, scope] of scopes) {
            expect(await ask(e, 'grounding', scope), label).toEqual(await memory.grounding(scope));
        }

        const all = (await memory.grounding(scopes[0]![1]))!;
        // Something to compare: Spaces, cells, a removed page, every kind.
        expect(all.spaces.length).toBeGreaterThan(1);
        expect(all.cells.length).toBeGreaterThan(10);
        expect(all.kinds.map((kind) => kind.kind)).toEqual([...RUN_REF_KINDS]);
        expect(all.kinds.every((kind) => kind.refs > 0)).toBe(true);
        expect(all.spaces.map((space) => space.spaceId)).toContain('space-gone');
        // Recalls and datasets have no Space: the heatmap's reads are pages'.
        const pageReads = new Set(
            s.refs
                .filter((ref) => ['page', 'search', 'context'].includes(ref.kind))
                .map((ref) => `${ref.runId} ${ref.refId}`),
        ).size;
        expect(all.spaces.reduce((sum, space) => sum + space.reads, 0)).toBe(pageReads);
        // References only: no page text, item body or query went in.
        const text = JSON.stringify(all);
        expect(text).not.toContain('secret');

        // One chat's grounding, whatever the range; a chat with none is empty.
        const threads = [...new Set(s.refs.map((ref) => ref.threadId))];
        for (const threadId of [...threads.slice(0, 5), TEAM, 'no-such-chat']) {
            expect(await ask(e, 'chatGrounding', { threadId }), threadId).toEqual(await memory.chatGrounding(threadId));
        }
        const busiest = (await memory.chatGrounding(threads[0]!))!;
        expect(busiest.refs.length).toBeGreaterThan(0);
        expect(busiest.refs.filter((ref) => ref.kind === 'recall').every((ref) => !ref.title)).toBe(true);
    }, 300_000);

    it('measures the time from a failed turn to its report', async () => {
        const now = Date.now();
        const s = seeded(now);
        const e = engine(s);
        await e.start();
        await caughtUp(e, s);
        const memory = memoryOf(s);
        const expected = await memory.issueVelocity(scopeOf({ from: null, to: now + DAY }));
        await until(
            async () =>
                (await ask<OpsIssueVelocity>(e, 'issueVelocity', scopeOf({ from: null, to: now + DAY })))
                    .failuresReported === expected.failuresReported,
        );
        const pick = ({ failuresReported, medianReportMs, p90ReportMs }: OpsIssueVelocity) => ({
            failuresReported,
            medianReportMs,
            p90ReportMs,
        });
        const to = now + DAY;
        for (const scope of [
            scopeOf({ from: null, to }),
            scopeOf({ from: now - 7 * DAY, to }),
            scopeOf({ from: null, to }, { person: PEOPLE[1] }),
        ]) {
            expect(pick(await ask<OpsIssueVelocity>(e, 'issueVelocity', scope)), JSON.stringify(scope.filters)).toEqual(
                pick(await memory.issueVelocity(scope)),
            );
        }
        // Only people's reports of failed turns: the finished turn's item and
        // the socio's filing are linked, but not counted.
        const all = await memory.issueVelocity(scopeOf({ from: null, to }));
        expect(all.failuresReported).toBe(Math.min(12, s.runs.turns.filter((t) => t.status === 'failed').length));
        expect(all.medianReportMs).toBeGreaterThan(0);
        expect(all.p90ReportMs).toBeGreaterThanOrEqual(all.medianReportMs!);
    }, 300_000);
});

describe('MemoryGrounding', () => {
    const scope = scopeOf({ from: 0, to: 10 * HOUR, bucket: 'hour' });
    const ref = (
        runId: string,
        kind: RunRefKind,
        refId: string,
        at: number,
        spaceId: string | null = 's1',
    ): RunRefFact => ({
        runId,
        threadId: `t-${runId}`,
        kind,
        spaceId,
        refId,
        at,
    });

    it('counts each turn and page once in a Space, and leaves recalls and datasets off the map', () => {
        const grounding = new MemoryGrounding(
            [
                ref('r1', 'search', 'p1', HOUR),
                ref('r1', 'page', 'p1', HOUR + 1),
                ref('r1', 'context', 'p2', HOUR + 2),
                ref('r2', 'page', 'p1', 3 * HOUR),
                ref('r2', 'recall', 'call-1', 3 * HOUR, null),
                ref('r3', 'dataset', 'd1', 4 * HOUR, null),
                // Outside the window.
                ref('r4', 'page', 'p1', 11 * HOUR),
            ],
            () => [],
            {
                spaces: [{ id: 's1', name: 'Handbook' }],
                pages: [
                    {
                        pageId: 'p1',
                        spaceId: 's1',
                        title: 'Pricing',
                        chars: 10,
                        revision: 1,
                        createdAt: 0,
                        updatedAt: 0,
                    },
                ],
                datasets: [
                    {
                        id: 'd1',
                        ownerId: 'alice',
                        name: 'Prices',
                        scratch: false,
                        sizeBytes: 0,
                        historyBytes: 0,
                        tables: 1,
                        createdAt: 0,
                        updatedAt: 0,
                        deletedAt: null,
                    },
                ],
            },
        ).grounding(scope);
        expect(grounding.runs).toBe(3);
        expect(grounding.kinds).toEqual([
            { kind: 'page', refs: 2, runs: 2 },
            { kind: 'search', refs: 1, runs: 1 },
            { kind: 'context', refs: 1, runs: 1 },
            { kind: 'dataset', refs: 1, runs: 1 },
            { kind: 'recall', refs: 1, runs: 1 },
        ]);
        expect(grounding.spaces).toEqual([{ spaceId: 's1', name: 'Handbook', reads: 3, pages: 2, chats: 2 }]);
        expect(grounding.cells).toEqual([
            { spaceId: 's1', at: HOUR, reads: 2 },
            { spaceId: 's1', at: 3 * HOUR, reads: 1 },
        ]);
        expect(grounding.buckets).toHaveLength(10);
        expect(grounding.pages).toEqual([
            {
                pageId: 'p1',
                spaceId: 's1',
                spaceName: 'Handbook',
                title: 'Pricing',
                reads: 2,
                chats: 2,
                lastAt: 3 * HOUR,
            },
            {
                pageId: 'p2',
                spaceId: null,
                spaceName: null,
                title: null,
                reads: 1,
                chats: 1,
                lastAt: HOUR + 2,
            },
        ]);
    });
});
