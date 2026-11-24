import type { OpsStatus, OpsMetric, OpsPoint, OpsTile, OpsTurnRow } from '@socio/shared/operations/operations';
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
import type {
    OpsDatasetRow,
    OpsKnowledge,
    OpsPageRow,
    OpsRequestRow,
    OpsStorage,
    OpsToolUse,
} from '@socio/shared/operations/operations-knowledge';
import type {
    OpsBreakdownRow,
    OpsFailureFilter,
    OpsFailurePoint,
    OpsFailureRow,
    OpsFriction,
    OpsIssueVelocity,
    OpsReliabilitySummary,
    ReliabilityDimension,
} from '@socio/shared/operations/operations-reliability';
import type { OpsThemesFacts } from '@socio/shared/operations/operations-themes';

import type { HealthReader } from './health-queries.js';
import type { OpsPage, OpsPageRequest, OpsScope, OpsSessionOptions } from './scope.js';

export type { OpsPage, OpsPageRequest, OpsScope, OpsSessionOptions } from './scope.js';

/**
 * What the Operations sections read (CB-164): the one port every
 * section's route asks through. Over the analytics store (CB-186) each
 * method is one query of its `OPS_QUERIES` registry (same name, the scope
 * as its params, zod-checked across the process boundary), sent with
 * `platform.analytics.query()` and answered by DuckDB in its own process,
 * so the app's event loop and its SQLite connection never run analytics
 * SQL; `status()` maps its `health()`. `MemoryOpsReader` answers from
 * facts in memory: for sections' tests, and until that adapter is wired.
 *
 * Rules every implementation keeps:
 * - Times are ms. A window's `from` is inclusive and `to` exclusive;
 *   buckets are cut in `window.timeZone`, weeks from Monday.
 * - Filters narrow by id; an id that matches nothing gives empty answers.
 * - Values are null when the store holds no data yet (`status().state`
 *   other than `ready`): never zeros it doesn't know.
 * - Lists are newest first, keyset-paged by `(sortKey, id)`.
 *
 * A section that needs a new question adds a method here and to each
 * implementation, with its test in `tests/operations-reader.test.ts`.
 */
export interface OpsReader extends HealthReader {
    status(): Promise<OpsStatus>;
    /** The Overview's tiles, in `OPS_TILES` order, each with the previous period's value. */
    overview(scope: OpsScope): Promise<OpsTile[]>;
    /** One metric per bucket over the window, every bucket present (0 when empty). */
    series(scope: OpsScope, metric: OpsMetric): Promise<OpsPoint[]>;
    /** Turns started in the window, newest first. */
    turns(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsTurnRow>>;

    // Reliability (CB-189), by the failure taxonomy.
    /** Totals, retries and fallbacks, and every category's failures. */
    reliability(scope: OpsScope): Promise<OpsReliabilitySummary>;
    /** Turns, failures and failures per category, every bucket present. */
    failureSeries(scope: OpsScope): Promise<OpsFailurePoint[]>;
    /** Failures grouped by tool, code, socio, model or source, the most first. */
    failureBreakdown(scope: OpsScope, by: ReliabilityDimension): Promise<OpsBreakdownRow[]>;
    /** Turns with a failure, newest first, by category or failed tool. */
    failures(scope: OpsScope, page: OpsPageRequest, filter?: OpsFailureFilter): Promise<OpsPage<OpsFailureRow>>;
    /** Recurring friction in the 7 days up to the window's end. */
    friction(scope: OpsScope): Promise<OpsFriction>;
    /** The board's reporting and resolution (person filter only). */
    issueVelocity(scope: OpsScope): Promise<OpsIssueVelocity>;

    /**
     * Activity (CB-190): tiles, chart, sources, participation, feature use
     * (tools grouped by `capabilities`, the app's registry) and Spaces.
     */
    activity(
        scope: OpsScope,
        options: OpsSessionOptions & { capabilities: OpsToolCapability[] },
    ): Promise<OpsActivityFacts>;
    /** Value (CB-190): sessions' outcomes, approvals and reactions. */
    value(scope: OpsScope, options: OpsSessionOptions): Promise<OpsValueFacts>;
    /** People active in the window, last active first. */
    activityPeople(scope: OpsScope, options: OpsSessionOptions, page: OpsPageRequest): Promise<OpsPage<OpsPersonRow>>;
    /** Socios people wrote to in the window, last active first. */
    activitySocios(scope: OpsScope, options: OpsSessionOptions, page: OpsPageRequest): Promise<OpsPage<OpsSocioRow>>;
    /** Chats people wrote in, last active first. */
    activityChats(scope: OpsScope, options: OpsSessionOptions, page: OpsPageRequest): Promise<OpsPage<OpsChatRow>>;
    /** People's sessions that started in the window, newest first. */
    activitySessions(
        scope: OpsScope,
        options: OpsSessionOptions,
        page: OpsPageRequest,
    ): Promise<OpsPage<OpsSessionRow>>;

    // Knowledge and Capabilities (CB-191). Pages and their counts follow
    // the `space` filter; edits also `socio` and `person` (who edited);
    // dataset access `socio` and `person` (whose data space); tool calls
    // all four, as turns do. Search timings are the whole workspace's.
    // Counts "now" are the store's latest snapshot; the range picks what
    // happened (created, edited, accessed) and staleness is measured at
    // its end. While the store can't answer, `knowledge` and `storage`
    // are null (never zeros), lists empty.

    /** Spaces' pages, search timings and dataset access over the window. */
    knowledge(scope: OpsScope): Promise<OpsKnowledge | null>;
    /** Live pages, least recently active first (stalest at the top). */
    pages(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsPageRow>>;
    /** Live datasets, largest first (with row history), with their access. */
    datasets(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsDatasetRow>>;
    /** Stored bytes by kind now, and at each bucket's end over the window. */
    storage(scope: OpsScope): Promise<OpsStorage | null>;
    /** Socio tool calls in the window, most first. */
    toolUse(scope: OpsScope): Promise<OpsToolUse[]>;
    /** Capability requests, the latest asked first, whatever the range. */
    requests(page: OpsPageRequest): Promise<OpsPage<OpsRequestRow>>;

    // Grounding (CB-194): what turns read, from `f_run_ref`. Spaces' reads
    // follow the `space` filter (the page's Space) and the turn's `socio`,
    // `person` and `source`, as turns do; recalls and datasets have no
    // Space and stay out of the heatmap. Null while the store can't answer.

    /** Spaces' reads per bucket, every kind's count and the pages read most. */
    grounding(scope: OpsScope): Promise<OpsGrounding | null>;
    /** Everything one chat's turns read, newest first; whatever the range. */
    chatGrounding(threadId: string): Promise<OpsChatGrounding | null>;
    // Cost (CB-195, CB-196): turns' `cost_usd` and pools' hours. Pools
    // are the workspace's whatever the filters; null while the store can't
    // answer.

    /** What turns cost over the window, and what pools cost and idled. */
    cost(scope: OpsScope): Promise<OpsCost | null>;
    /** The models turns used (for the price sync); empty while it can't answer. */
    costModels(): Promise<string[]>;
    /**
     * Themes (CB-199): people's sessions in the window by intent and by
     * theme, with outcomes and weeks; themes under `THEMES_MIN_PEOPLE`
     * people are counted, never named. Null while the store can't answer.
     */
    themes(scope: OpsScope, options: OpsSessionOptions): Promise<OpsThemesFacts | null>;
}
