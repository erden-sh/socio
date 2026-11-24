import { bucketStart, bucketStarts } from '@socio/shared/operations/operations';
import {
    OPS_CHAT_GROUNDING_MAX,
    OPS_GROUNDING_TOP_PAGES,
    type OpsChatGrounding,
    type OpsChatRef,
    type OpsGrounding,
    type OpsGroundingPage,
    type OpsGroundingSpace,
} from '@socio/shared/operations/operations-grounding';
import { RUN_REF_KINDS, SPACE_REF_KINDS, type RunRefKind } from '@socio/shared/runs/run-refs';

import type { OpsScope } from '../../domain/reader.js';

import type { KnowledgeFacts } from './knowledge.js';

/** One thing a turn read, as `f_run_ref` keeps it. */
export interface RunRefFact {
    runId: string;
    threadId: string;
    kind: RunRefKind;
    spaceId: string | null;
    refId: string;
    at: number;
}

/** An item's link to the turn it was filed from, as `f_issue_run` keeps it. */
export interface IssueRunFact {
    issueId: string;
    runId: string;
    via: 'report' | 'socio';
    linkedAt: number;
}

/** The turn fields grounding filters by. */
interface GroundingTurn {
    runId: string;
    socioId: string;
    source: string;
    personId?: string | null;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pageKinds = new Set<RunRefKind>(SPACE_REF_KINDS);

/**
 * `MemoryOpsReader`'s grounding answers (CB-194), from facts in memory:
 * what the DuckDB queries answer, by the same rules, written plainly, for
 * the contract tests. A Space's reads count each turn and page once per
 * bucket (`(run, page)` pairs), however the turn reached the page.
 */
export class MemoryGrounding {
    constructor(
        private refs: readonly RunRefFact[],
        private turns: () => readonly GroundingTurn[],
        private knowledge: KnowledgeFacts,
    ) {}

    get some() {
        return this.refs.length > 0;
    }

    private matching({ window, filters }: OpsScope) {
        const turns = new Map(this.turns().map((turn) => [turn.runId, turn]));
        return this.refs.filter((ref) => {
            if ((window.from !== null && ref.at < window.from) || ref.at >= window.to) {
                return false;
            }
            if (filters.space && ref.spaceId !== filters.space) {
                return false;
            }
            if (!filters.socio && !filters.person && !filters.source) {
                return true;
            }
            const turn = turns.get(ref.runId);
            return (
                !!turn &&
                (!filters.socio || turn.socioId === filters.socio) &&
                (!filters.source || turn.source === filters.source) &&
                (!filters.person || turn.personId === filters.person)
            );
        });
    }

    grounding(scope: OpsScope): OpsGrounding {
        const { window } = scope;
        const refs = this.matching(scope);
        const spaceNames = new Map((this.knowledge.spaces ?? []).map((space) => [space.id, space.name]));
        const start = window.from ?? (refs.length ? Math.min(...refs.map((ref) => ref.at)) : null);
        const buckets = start === null ? [] : bucketStarts(start, window.to, window.bucket, window.timeZone);
        const columns = new Set(buckets);
        const kinds = RUN_REF_KINDS.map((kind) => {
            const of = refs.filter((ref) => ref.kind === kind);
            return {
                kind,
                refs: of.length,
                runs: new Set(of.map((ref) => ref.runId)).size,
            };
        });
        const read = refs.filter(
            (ref): ref is RunRefFact & { spaceId: string } => pageKinds.has(ref.kind) && ref.spaceId !== null,
        );
        const spaces = new Map<string, { reads: Set<string>; pages: Set<string>; chats: Set<string> }>();
        const cells = new Map<string, Set<string>>();
        for (const ref of read) {
            let space = spaces.get(ref.spaceId);
            if (!space) {
                spaces.set(ref.spaceId, (space = { reads: new Set(), pages: new Set(), chats: new Set() }));
            }
            const pair = `${ref.runId}\u0000${ref.refId}`;
            space.reads.add(pair);
            space.pages.add(ref.refId);
            space.chats.add(ref.threadId);
            const at = bucketStart(ref.at, window.bucket, window.timeZone);
            const key = `${ref.spaceId}\u0000${at}`;
            let cell = cells.get(key);
            if (!cell) {
                cells.set(key, (cell = new Set()));
            }
            cell.add(pair);
        }
        const livePages = new Map((this.knowledge.pages ?? []).map((page) => [page.pageId, page]));
        const pages = new Map<string, { reads: Set<string>; chats: Set<string>; lastAt: number }>();
        for (const ref of refs) {
            if (!pageKinds.has(ref.kind)) {
                continue;
            }
            let page = pages.get(ref.refId);
            if (!page) {
                pages.set(ref.refId, (page = { reads: new Set(), chats: new Set(), lastAt: 0 }));
            }
            page.reads.add(ref.runId);
            page.chats.add(ref.threadId);
            page.lastAt = Math.max(page.lastAt, ref.at);
        }
        return {
            runs: new Set(refs.map((ref) => ref.runId)).size,
            chats: new Set(refs.map((ref) => ref.threadId)).size,
            kinds,
            buckets,
            spaces: [...spaces]
                .map(([spaceId, space]): OpsGroundingSpace => ({
                    spaceId,
                    name: spaceNames.get(spaceId) ?? null,
                    reads: space.reads.size,
                    pages: space.pages.size,
                    chats: space.chats.size,
                }))
                .sort((a, b) => b.reads - a.reads || byText(a.spaceId, b.spaceId)),
            // Only the window's buckets (a long window is cut at the most points).
            cells: [...cells]
                .map(([key, pairs]) => {
                    const [spaceId, at] = key.split('\u0000') as [string, string];
                    return { spaceId, at: Number(at), reads: pairs.size };
                })
                .filter((cell) => columns.has(cell.at))
                .sort((a, b) => byText(a.spaceId, b.spaceId) || a.at - b.at),
            pages: [...pages]
                .map(([pageId, page]): OpsGroundingPage => {
                    const live = livePages.get(pageId);
                    return {
                        pageId,
                        spaceId: live?.spaceId ?? null,
                        spaceName: live ? (spaceNames.get(live.spaceId) ?? null) : null,
                        title: live?.title ?? null,
                        reads: page.reads.size,
                        chats: page.chats.size,
                        lastAt: page.lastAt,
                    };
                })
                .sort((a, b) => b.chats - a.chats || b.reads - a.reads || byText(a.pageId, b.pageId))
                .slice(0, OPS_GROUNDING_TOP_PAGES),
        };
    }

    chatGrounding(threadId: string): OpsChatGrounding {
        const spaceNames = new Map((this.knowledge.spaces ?? []).map((space) => [space.id, space.name]));
        const titles = new Map((this.knowledge.pages ?? []).map((page) => [page.pageId, page.title]));
        const datasets = new Map((this.knowledge.datasets ?? []).map((dataset) => [dataset.id, dataset.name]));
        const grouped = new Map<string, OpsChatRef & { runSet: Set<string> }>();
        for (const ref of this.refs) {
            if (ref.threadId !== threadId) {
                continue;
            }
            const key = `${ref.kind}\u0000${ref.refId}\u0000${ref.spaceId ?? ''}`;
            let row = grouped.get(key);
            if (!row) {
                grouped.set(
                    key,
                    (row = {
                        kind: ref.kind,
                        spaceId: ref.spaceId,
                        spaceName: ref.spaceId ? (spaceNames.get(ref.spaceId) ?? null) : null,
                        refId: ref.refId,
                        title:
                            ref.kind === 'dataset'
                                ? (datasets.get(ref.refId) ?? null)
                                : ref.kind === 'recall'
                                  ? null
                                  : (titles.get(ref.refId) ?? null),
                        runs: 0,
                        firstAt: ref.at,
                        lastAt: ref.at,
                        runSet: new Set(),
                    }),
                );
            }
            row.runSet.add(ref.runId);
            row.firstAt = Math.min(row.firstAt, ref.at);
            row.lastAt = Math.max(row.lastAt, ref.at);
        }
        const all = [...grouped.values()]
            .map(({ runSet, ...row }) => ({ ...row, runs: runSet.size }))
            .sort(
                (a, b) =>
                    b.lastAt - a.lastAt ||
                    byText(a.kind, b.kind) ||
                    byText(a.refId, b.refId) ||
                    byText(a.spaceId ?? '', b.spaceId ?? ''),
            );
        return {
            refs: all.slice(0, OPS_CHAT_GROUNDING_MAX),
            more: all.length > OPS_CHAT_GROUNDING_MAX,
        };
    }
}
