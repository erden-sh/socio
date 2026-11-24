import { failureCategory } from '@socio/shared/failure-taxonomy';
import {
    bucketStart,
    bucketStarts,
    OPS_TILES,
    type OpsState,
    type OpsStatus,
    type OpsMetric,
    type OpsPoint,
    type OpsTile,
    type OpsTileId,
    type OpsTurnRow,
} from '@socio/shared/operations/operations';
import type {
    OpsActivityFacts,
    OpsChatRow,
    OpsPersonRow,
    OpsSessionRow,
    OpsSocioRow,
    OpsToolCapability,
    OpsValueFacts,
} from '@socio/shared/operations/operations-activity';
import type { OpsCost } from '@socio/shared/operations/operations-cost';
import type { OpsChatGrounding, OpsGrounding } from '@socio/shared/operations/operations-grounding';
import type { HealthMetric } from '@socio/shared/operations/operations-health';
import type {
    OpsDatasetRow,
    OpsKnowledge,
    OpsPageRow,
    OpsRequestRow,
    OpsStorage,
    OpsToolUse,
} from '@socio/shared/operations/operations-knowledge';
import {
    frictionFrom,
    noIssueVelocity,
    noReliability,
    type OpsBreakdownRow,
    type OpsFailureFilter,
    type OpsFailurePoint,
    type OpsFailureRow,
    type OpsFriction,
    type OpsIssueVelocity,
    type OpsReliabilitySummary,
    type ReliabilityDimension,
} from '@socio/shared/operations/operations-reliability';
import type { OpsThemesFacts } from '@socio/shared/operations/operations-themes';

import { afterCursor } from '../../domain/cursor.js';
import { issueVelocity, type IssueFact } from '../../domain/issue-velocity.js';
import type { OpsPage, OpsPageRequest, OpsReader, OpsScope, OpsSessionOptions } from '../../domain/reader.js';
import type { PoolHour } from '../../pricing/pools.js';

import { MemoryActivity, type ActivityFacts, type ToolFact as ActivityTool } from './activity.js';
import { memoryCost } from './cost.js';
import type { CycleFact, MessageFact, TurnFact } from './facts.js';
import { MemoryGrounding, type IssueRunFact, type RunRefFact } from './grounding.js';
import { MemoryHealth, type HealthMemoryFacts } from './health.js';
import { MemoryKnowledge, type KnowledgeFacts } from './knowledge.js';
import { MemoryReliability, type ToolFact as ReliabilityTool } from './reliability.js';

export type { CycleFact, MessageFact, TurnFact } from './facts.js';

/**
 * A tool call, as `f_tool` keeps it. Reliability (CB-189) reads its place,
 * code, category and time; Activity (CB-190) its outcome, and its turn's
 * chat, socio, source and person. Facts need only what their section
 * reads: the rest comes from the call's turn, and the category from the
 * failure taxonomy over its outcome and code, as the ETL derives them.
 */
export type ToolFact = Pick<ReliabilityTool & ActivityTool, 'runId' | 'tool' | 'startedAt'> &
    Partial<ReliabilityTool & ActivityTool>;

export interface MemoryFacts extends Omit<ActivityFacts, 'tools'> {
    turns?: readonly TurnFact[];
    messages?: readonly MessageFact[];
    /** Tool calls, by their turn's `runId` (CB-189, CB-190). */
    tools?: readonly ToolFact[];
    /** The Improvements board's items (CB-189). */
    issues?: readonly IssueFact[];
    /** Health's facts (CB-192). */
    health?: HealthMemoryFacts;
    /** Pages, datasets, storage, tool calls and requests (CB-191). */
    knowledge?: KnowledgeFacts;
    /** What turns read, and the turns items were filed from (CB-194). */
    grounding?: {
        refs?: readonly RunRefFact[];
        issueRuns?: readonly IssueRunFact[];
    };
    /** Cost pools' hours (CB-196), as `f_pool_hour` keeps them. */
    poolHours?: readonly PoolHour[];
    /** Work cycles (CB-218), as `f_cycle` keeps them. */
    cycles?: readonly CycleFact[];
}
export type { IssueFact, IssueRunFact, RunRefFact };

/** Every field of each tool call, the missing ones derived (`ToolFact`). */
function toolRows(turns: readonly TurnFact[], tools: readonly ToolFact[]): (ReliabilityTool & ActivityTool)[] {
    const byRun = new Map(turns.map((turn) => [turn.runId, turn]));
    return tools.map((tool, index) => {
        const turn = byRun.get(tool.runId);
        const outcome = tool.outcome ?? (tool.category ? 'error' : 'ok');
        return {
            ...tool,
            idx: tool.idx ?? index,
            threadId: tool.threadId ?? turn?.threadId ?? '',
            socioId: tool.socioId !== undefined ? tool.socioId : (turn?.socioId ?? null),
            spaceId: tool.spaceId !== undefined ? tool.spaceId : turn?.spaceId,
            source: tool.source ?? turn?.source ?? '',
            personId: tool.personId !== undefined ? tool.personId : turn?.personId,
            outcome,
            category:
                tool.category !== undefined
                    ? tool.category
                    : failureCategory({
                          level: 'tool',
                          tool: tool.tool,
                          outcome,
                          code: tool.code ?? null,
                      }).category,
            durationMs: tool.durationMs ?? 0,
        };
    });
}

const inRange = (at: number, from: number | null, to: number) => (from === null || at >= from) && at < to;

/**
 * `OpsReader` from facts held in memory: what sections test against, and
 * what the dashboard reads until the analytics store runs (with no facts:
 * `unavailable`, every value null). Answers as the DuckDB store does, by
 * the port's rules.
 */
export class MemoryOpsReader implements OpsReader {
    private readonly turnFacts: readonly TurnFact[];
    private readonly messageFacts: readonly MessageFact[];
    private readonly issueFacts: readonly IssueFact[];
    private readonly reliable: MemoryReliability;
    private readonly state: OpsState;
    private readonly asOf: number | null;
    private readonly healthFacts: MemoryHealth;
    private readonly use: MemoryActivity;
    private readonly knowledgeFacts: MemoryKnowledge;
    private readonly grounded: MemoryGrounding;
    private readonly issueRuns: readonly IssueRunFact[];
    private readonly poolHours: readonly PoolHour[];
    private readonly cycleFacts: readonly CycleFact[];
    private readonly personNames: ReadonlyMap<string, string>;
    private readonly roomTitles: ReadonlyMap<string, string | null>;

    constructor(facts: MemoryFacts = {}, options: { state?: OpsState; asOf?: number | null } = {}) {
        this.turnFacts = facts.turns ?? [];
        this.messageFacts = facts.messages ?? [];
        this.issueFacts = facts.issues ?? [];
        const tools = toolRows(this.turnFacts, facts.tools ?? []);
        this.reliable = new MemoryReliability(tools);
        this.healthFacts = new MemoryHealth(() => this.turnFacts, facts.health ?? {});
        const health = facts.health ?? {};
        this.knowledgeFacts = new MemoryKnowledge(facts.knowledge ?? {});
        this.grounded = new MemoryGrounding(facts.grounding?.refs ?? [], () => this.turnFacts, facts.knowledge ?? {});
        this.issueRuns = facts.grounding?.issueRuns ?? [];
        this.poolHours = facts.poolHours ?? [];
        this.cycleFacts = facts.cycles ?? [];
        this.personNames = new Map((facts.people ?? []).map((person) => [person.id, person.name]));
        this.roomTitles = new Map(
            (facts.chats ?? [])
                .filter((chat) => chat.ownerKind === 'room')
                .map((chat) => [chat.id, chat.title ?? null]),
        );
        const some =
            this.turnFacts.length > 0 ||
            this.messageFacts.length > 0 ||
            this.knowledgeFacts.some ||
            this.grounded.some ||
            !!health.jobRuns?.length ||
            !!health.schedules?.length ||
            !!health.longRuns?.length;
        this.state = options.state ?? (some ? 'ready' : 'unavailable');
        this.use = new MemoryActivity(this.turnFacts, this.messageFacts, { ...facts, tools }, () => this.earliest());
        this.asOf =
            options.asOf !== undefined
                ? options.asOf
                : this.state === 'ready'
                  ? Math.max(
                        0,
                        ...this.turnFacts.map((turn) => turn.finishedAt ?? turn.startedAt),
                        ...this.messageFacts.map((message) => message.at),
                    )
                  : null;
    }

    private earliest() {
        const times = [
            ...this.turnFacts.map((turn) => turn.startedAt),
            ...this.messageFacts.map((message) => message.at),
        ];
        return this.state === 'ready' && times.length ? times.reduce((a, b) => Math.min(a, b)) : null;
    }

    async status(): Promise<OpsStatus> {
        return { state: this.state, asOf: this.asOf, earliest: this.earliest() };
    }

    async activity(
        scope: OpsScope,
        options: OpsSessionOptions & { capabilities: OpsToolCapability[] },
    ): Promise<OpsActivityFacts> {
        return this.use.activity(this.ready(scope), options);
    }
    async value(scope: OpsScope, options: OpsSessionOptions): Promise<OpsValueFacts> {
        return this.use.value(this.ready(scope), options);
    }
    async themes(scope: OpsScope, options: OpsSessionOptions): Promise<OpsThemesFacts | null> {
        return this.state === 'ready' ? this.use.themes(scope, options) : null;
    }
    async activityPeople(
        scope: OpsScope,
        options: OpsSessionOptions,
        page: OpsPageRequest,
    ): Promise<OpsPage<OpsPersonRow>> {
        return this.use.activityPeople(this.ready(scope), options, page);
    }
    async activitySocios(
        scope: OpsScope,
        options: OpsSessionOptions,
        page: OpsPageRequest,
    ): Promise<OpsPage<OpsSocioRow>> {
        return this.use.activitySocios(this.ready(scope), options, page);
    }
    async activityChats(
        scope: OpsScope,
        options: OpsSessionOptions,
        page: OpsPageRequest,
    ): Promise<OpsPage<OpsChatRow>> {
        return this.use.activityChats(this.ready(scope), options, page);
    }
    async activitySessions(
        scope: OpsScope,
        options: OpsSessionOptions,
        page: OpsPageRequest,
    ): Promise<OpsPage<OpsSessionRow>> {
        return this.use.activitySessions(this.ready(scope), options, page);
    }

    /**
     * The scope as Activity reads it: before the store runs, a window with
     * no start and no data, so every answer is empty and its values null.
     */
    private ready(scope: OpsScope): OpsScope {
        return this.state === 'ready' ? scope : { ...scope, window: { ...scope.window, from: null } };
    }

    async overview(scope: OpsScope): Promise<OpsTile[]> {
        const { from, to, previous } = scope.window;
        return OPS_TILES.map((id) => ({
            id,
            value: this.tile(id, scope, from, to),
            previous: previous ? this.tile(id, scope, previous.from, previous.to) : null,
        }));
    }

    async series(scope: OpsScope, metric: OpsMetric): Promise<OpsPoint[]> {
        if (this.state !== 'ready') {
            return [];
        }
        const { from, to, bucket, timeZone } = scope.window;
        const status = await this.status();
        const start = from ?? status.earliest;
        if (start === null) {
            return [];
        }
        const starts = bucketStarts(start, to, bucket, timeZone);
        const counts = new Map(starts.map((at) => [at, 0]));
        const people = new Map(starts.map((at) => [at, new Set<string>()]));
        const key = (at: number) => bucketStart(at, bucket, timeZone);
        const count = (at: number, amount: number) => {
            const bucketAt = key(at);
            const current = counts.get(bucketAt);
            if (current !== undefined) {
                counts.set(bucketAt, current + amount);
            }
        };
        if (metric === 'people') {
            for (const message of this.messagesIn(scope, start, to)) {
                if (message.authorKind === 'person') {
                    people.get(key(message.at))?.add(message.authorId);
                }
            }
        }
        if (metric === 'messages') {
            for (const message of this.messagesIn(scope, start, to)) {
                if (message.authorKind === 'person') {
                    count(message.at, 1);
                }
            }
        }
        if (metric === 'turns' || metric === 'failed' || metric === 'tokens') {
            for (const turn of this.turnsIn(scope, start, to)) {
                if (metric !== 'failed' || turn.status === 'failed') {
                    count(turn.startedAt, metric === 'tokens' ? tokensOf(turn) : 1);
                }
            }
        }
        return starts.map((at) => ({
            at,
            value: metric === 'people' ? people.get(at)!.size : counts.get(at)!,
        }));
    }

    async turns(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsTurnRow>> {
        if (this.state !== 'ready') {
            return { items: [], next: null };
        }
        const rows = this.turnsIn(scope, scope.window.from, scope.window.to)
            .map((turn) => ({ turn, key: { key: turn.startedAt, id: turn.runId } }))
            .filter(({ key }) => afterCursor(key, page.cursor))
            .sort((a, b) => (b.key.key !== a.key.key ? b.key.key - a.key.key : b.key.id < a.key.id ? -1 : 1));
        const items = rows.slice(0, page.limit);
        return {
            items: items.map(({ turn }) => rowOf(turn)),
            next: rows.length > page.limit ? items.at(-1)!.key : null,
        };
    }

    async reliability(scope: OpsScope): Promise<OpsReliabilitySummary> {
        const { from, to, previous } = scope.window;
        if (this.state !== 'ready') {
            return noReliability();
        }
        const before = previous ? this.reliable.summary(this.turnsIn(scope, previous.from, previous.to)) : undefined;
        return {
            ...this.reliable.summary(this.turnsIn(scope, from, to)),
            previousTurns: before?.turns ?? null,
            previousFailures: before?.failures ?? null,
        };
    }

    async failureSeries(scope: OpsScope): Promise<OpsFailurePoint[]> {
        if (this.state !== 'ready') {
            return [];
        }
        const start = scope.window.from ?? (await this.status()).earliest;
        if (start === null) {
            return [];
        }
        return this.reliable.series(this.turnsIn(scope, start, scope.window.to), scope.window, start);
    }

    async failureBreakdown(scope: OpsScope, by: ReliabilityDimension): Promise<OpsBreakdownRow[]> {
        if (this.state !== 'ready') {
            return [];
        }
        return this.reliable.breakdown(this.turnsIn(scope, scope.window.from, scope.window.to), by);
    }

    async failures(scope: OpsScope, page: OpsPageRequest, filter?: OpsFailureFilter): Promise<OpsPage<OpsFailureRow>> {
        if (this.state !== 'ready') {
            return { items: [], next: null };
        }
        return this.reliable.failures(this.turnsIn(scope, scope.window.from, scope.window.to), page, filter);
    }

    async friction(scope: OpsScope): Promise<OpsFriction> {
        const from = frictionFrom(scope.window);
        if (this.state !== 'ready') {
            return { from, rows: [] };
        }
        return this.reliable.friction(this.turnsIn(scope, from, scope.window.to), from);
    }

    async issueVelocity(scope: OpsScope): Promise<OpsIssueVelocity> {
        if (this.state !== 'ready') {
            return noIssueVelocity();
        }
        return issueVelocity(this.issueFacts, scope, this.reports());
    }

    /** Failed turns people filed items about from Runs (CB-194). */
    private reports() {
        const issues = new Map(
            this.issueFacts
                .filter((issue) => issue.id !== undefined && issue.deletedAt == null)
                .map((issue) => [issue.id!, issue]),
        );
        const turns = new Map(this.turnFacts.map((turn) => [turn.runId, turn]));
        return this.issueRuns.flatMap((link) => {
            const issue = issues.get(link.issueId);
            const turn = turns.get(link.runId);
            return link.via === 'report' && issue && turn?.status === 'failed' && turn.finishedAt != null
                ? [
                      {
                          reporterId: issue.reporterId,
                          failedAt: turn.finishedAt,
                          reportedAt: issue.createdAt,
                      },
                  ]
                : [];
        });
    }

    // Health (CB-192).
    async health(scope: OpsScope) {
        return this.state === 'ready' ? this.healthFacts.health(scope) : null;
    }

    async healthSeries(scope: OpsScope, metric: HealthMetric) {
        if (this.state !== 'ready') {
            return [];
        }
        return this.healthFacts.series(scope, metric, (await this.status()).earliest);
    }

    async healthSchedules(scope: OpsScope, page: OpsPageRequest) {
        if (this.state !== 'ready') {
            return { items: [], next: null };
        }
        return this.healthFacts.schedules(scope, page);
    }

    async healthRuns(scope: OpsScope, page: OpsPageRequest) {
        if (this.state !== 'ready') {
            return { items: [], next: null };
        }
        return this.healthFacts.runs(scope, page);
    }

    async healthLongRuns(scope: OpsScope, page: OpsPageRequest) {
        if (this.state !== 'ready') {
            return { items: [], next: null };
        }
        return this.healthFacts.longRuns(scope, page);
    }

    // Cost (CB-195, CB-196).
    async cost(scope: OpsScope): Promise<OpsCost | null> {
        if (this.state !== 'ready') {
            return null;
        }
        const { from, to, previous } = scope.window;
        return memoryCost({
            scope,
            turns: this.turnsIn(scope, from, to),
            previous: previous ? this.turnsIn(scope, previous.from, previous.to) : null,
            poolHours: this.poolHours,
            earliest: this.earliest(),
            cycles: this.cycleFacts,
            personName: (id) => this.personNames.get(id) ?? null,
            roomTitle: (id) => this.roomTitles.get(id) ?? null,
        });
    }

    async costModels(): Promise<string[]> {
        if (this.state !== 'ready') {
            return [];
        }
        return [...new Set(this.turnFacts.flatMap((turn) => (turn.model ? [turn.model] : [])))].sort();
    }

    // Knowledge, storage and capabilities (CB-191).
    async knowledge(scope: OpsScope): Promise<OpsKnowledge | null> {
        return this.state === 'ready' ? this.knowledgeFacts.knowledge(scope) : null;
    }

    async pages(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsPageRow>> {
        return this.state === 'ready' ? this.knowledgeFacts.pages(scope, page) : { items: [], next: null };
    }

    async datasets(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsDatasetRow>> {
        return this.state === 'ready' ? this.knowledgeFacts.datasets(scope, page) : { items: [], next: null };
    }

    async storage(scope: OpsScope): Promise<OpsStorage | null> {
        return this.state === 'ready' ? this.knowledgeFacts.storage(scope) : null;
    }

    async toolUse(scope: OpsScope): Promise<OpsToolUse[]> {
        return this.state === 'ready' ? this.knowledgeFacts.toolUse(scope) : [];
    }

    async requests(page: OpsPageRequest): Promise<OpsPage<OpsRequestRow>> {
        return this.state === 'ready' ? this.knowledgeFacts.requests(page) : { items: [], next: null };
    }

    // Grounding (CB-194).
    async grounding(scope: OpsScope): Promise<OpsGrounding | null> {
        return this.state === 'ready' ? this.grounded.grounding(scope) : null;
    }

    async chatGrounding(threadId: string): Promise<OpsChatGrounding | null> {
        return this.state === 'ready' ? this.grounded.chatGrounding(threadId) : null;
    }

    private tile(id: OpsTileId, scope: OpsScope, from: number | null, to: number): number | null {
        if (this.state !== 'ready') {
            return null;
        }
        const turns = this.turnsIn(scope, from, to);
        const messages = this.messagesIn(scope, from, to).filter((message) => message.authorKind === 'person');
        switch (id) {
            case 'turns':
                return turns.length;
            case 'failed':
                return turns.filter((turn) => turn.status === 'failed').length;
            case 'people':
                return new Set(messages.map((message) => message.authorId)).size;
            case 'messages':
                return messages.length;
            case 'chats':
                return new Set([...turns.map((turn) => turn.threadId), ...messages.map((message) => message.threadId)])
                    .size;
            case 'tokens':
                return turns.reduce((sum, turn) => sum + tokensOf(turn), 0);
        }
    }

    private turnsIn({ filters }: OpsScope, from: number | null, to: number) {
        return this.turnFacts.filter(
            (turn) =>
                inRange(turn.startedAt, from, to) &&
                (!filters.socio || turn.socioId === filters.socio) &&
                (!filters.space || turn.spaceId === filters.space) &&
                (!filters.source || turn.source === filters.source) &&
                (!filters.person || turn.personId === filters.person),
        );
    }

    private messagesIn({ filters }: OpsScope, from: number | null, to: number) {
        return this.messageFacts.filter(
            (message) =>
                inRange(message.at, from, to) &&
                (!filters.socio || message.socioId === filters.socio) &&
                (!filters.space || message.spaceId === filters.space) &&
                (!filters.source || message.source === filters.source) &&
                (!filters.person || (message.authorKind === 'person' && message.authorId === filters.person)),
        );
    }
}

const tokensOf = (turn: TurnFact) => (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0);

const rowOf = (turn: TurnFact): OpsTurnRow => ({
    runId: turn.runId,
    threadId: turn.threadId,
    socioId: turn.socioId,
    socioName: turn.socioName ?? null,
    source: turn.source,
    status: turn.status,
    startedAt: turn.startedAt,
    finishedAt: turn.finishedAt ?? null,
    tokens: tokensOf(turn),
    toolCalls: turn.toolCalls ?? 0,
    toolErrors: turn.toolErrors ?? 0,
});
