import { z } from 'zod';

import {
    OPS_BUCKETS,
    OPS_METRICS,
    OPS_PAGE_LIMIT,
    OPS_TILES,
    type OpsMetric,
    type OpsPoint,
    type OpsStatus,
    type OpsTile,
    type OpsTurnRow,
} from '@socio/shared/operations/operations';
import type {
    OpsActivityFacts,
    OpsChatRow,
    OpsPersonRow,
    OpsSessionRow,
    OpsSocioRow,
    OpsValueFacts,
} from '@socio/shared/operations/operations-activity';
import type { OpsCost } from '@socio/shared/operations/operations-cost';
import type {
    HealthFacts,
    HealthLongRunRow,
    HealthMetric,
    HealthPoint,
    HealthRunRow,
    HealthScheduleRow,
} from '@socio/shared/operations/operations-health';
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
import { ianaTimeZone } from '@socio/shared/time-zone';

import { themesQueries } from '../themes/queries.js';

import { activityQueries } from './activity-queries.js';
import { costQueries } from './cost-queries.js';
import { groundingQueries } from './grounding-queries.js';
import { healthQueries } from './health-queries.js';
import { knowledgeQueries } from './knowledge-queries.js';
import { reliabilityQueries } from './reliability-queries.js';
import type { OpsPage, OpsPageRequest, OpsScope, OpsSessionOptions } from './scope.js';

// Ids and source keys: printable, no spaces, not too long (as CB-184's).
const filterValue = z.string().regex(/^[\w.:@+-]{1,128}$/);
const ms = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** `OpsScope` (CB-184): a window cut in the reporting time zone, and filters. */
const scope = {
    window: z
        .object({
            from: ms.nullable(),
            to: ms,
            bucket: z.enum(OPS_BUCKETS),
            buckets: z.array(z.enum(OPS_BUCKETS)),
            previous: z.object({ from: ms, to: ms }).strict().nullable(),
            timeZone: z.string().refine((zone) => ianaTimeZone(zone) !== undefined, 'Not a time zone.'),
        })
        .strict(),
    filters: z
        .object({
            socio: filterValue.optional(),
            person: filterValue.optional(),
            space: filterValue.optional(),
            source: filterValue.optional(),
        })
        .strict(),
};
const cursor = z
    .object({
        key: z.union([z.number().finite(), z.string().max(256)]),
        id: z.string().max(256),
    })
    .strict();
const status = z.enum(['unavailable', 'starting', 'rebuilding', 'ready']);
const runStatus = z.enum(['running', 'finished', 'stopped', 'failed', 'interrupted']);

/**
 * The dashboard's questions to the analytics store (CB-164): each has
 * zod-typed params and answer, checked on both sides of the process
 * boundary. A section adds its queries here and implements them in
 * `infra/duckdb/ops-queries.ts`; the type below makes it implement all.
 *
 * `status`, `overview`, `series` and `turns` are CB-184's `OpsReader`
 * methods, one query each (CB-187): the params are the method's scope,
 * with `series`' metric and `turns`' page beside it, and the answer is
 * exactly what the method returns, so its adapter passes them through.
 */
export const OPS_QUERIES = {
    /** "Data as of": where the ETL got to, per source and overall. */
    freshness: {
        params: z.object({}).strict(),
        answer: z.object({
            /** When every source last caught up with SQLite (ms), if ever. */
            asOf: z.number().nullable(),
            sources: z.array(
                z.object({
                    source: z.string(),
                    watermark: z.string().nullable(),
                    at: z.number(),
                }),
            ),
        }),
    },
    /** `OpsReader.status()`: the store's state, "Data as of", the oldest fact. */
    status: {
        params: z.object({}).strict(),
        answer: z
            .object({
                state: status,
                asOf: z.number().nullable(),
                earliest: z.number().nullable(),
                progress: z.number().min(0).max(100).optional(),
            })
            .strict(),
    },
    /** `OpsReader.overview(scope)`: the tiles, in `OPS_TILES` order. */
    overview: {
        params: z.object(scope).strict(),
        answer: z.array(
            z
                .object({
                    id: z.enum(OPS_TILES),
                    value: z.number().nullable(),
                    previous: z.number().nullable(),
                })
                .strict(),
        ),
    },
    /** `OpsReader.series(scope, metric)`: every bucket of the window. */
    series: {
        params: z.object({ ...scope, metric: z.enum(OPS_METRICS) }).strict(),
        answer: z.array(z.object({ at: z.number(), value: z.number() }).strict()),
    },
    /** `OpsReader.turns(scope, page)`: newest first, keyset-paged. */
    turns: {
        params: z
            .object({
                ...scope,
                cursor: cursor.optional(),
                limit: z.number().int().min(1).max(OPS_PAGE_LIMIT.max),
            })
            .strict(),
        answer: z
            .object({
                items: z.array(
                    z
                        .object({
                            runId: z.string(),
                            threadId: z.string(),
                            socioId: z.string(),
                            socioName: z.string().nullable(),
                            source: z.string(),
                            status: runStatus,
                            startedAt: z.number(),
                            finishedAt: z.number().nullable(),
                            tokens: z.number(),
                            toolCalls: z.number(),
                            toolErrors: z.number(),
                        })
                        .strict(),
                ),
                next: cursor.nullable(),
            })
            .strict(),
    },
    /** Reliability's (CB-189): `reliability-queries.ts`. */
    ...reliabilityQueries({ scope, cursor, runStatus }),
    // Health (CB-192).
    ...healthQueries(scope, cursor),
    // Activity and Value (CB-190).
    ...activityQueries(scope, cursor),
    // Knowledge, storage and capabilities (CB-191).
    ...knowledgeQueries({ scope, cursor }),
    // Grounding and report links (CB-194).
    ...groundingQueries({ scope }),
    // Cost (CB-195, CB-196).
    ...costQueries(scope),
    // Themes (CB-199).
    ...themesQueries(scope),
} as const;

export type OpsQueryName = keyof typeof OPS_QUERIES;
export type OpsQueryParams<N extends OpsQueryName> = z.infer<(typeof OPS_QUERIES)[N]['params']>;
export type OpsQueryAnswer<N extends OpsQueryName> = z.infer<(typeof OPS_QUERIES)[N]['answer']>;

/** The port the analytics process answers through; DuckDB implements it. */
export type OpsQueries = {
    [N in OpsQueryName]: (params: OpsQueryParams<N>) => Promise<OpsQueryAnswer<N>>;
};

export const OPS_QUERY_NAMES = Object.keys(OPS_QUERIES) as [OpsQueryName, ...OpsQueryName[]];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
/**
 * The reader's queries ask and answer exactly what `OpsReader` does
 * (CB-184): typecheck fails here when either side changes alone.
 */
export type OpsReaderQueries = [
    Holds<Same<OpsQueryAnswer<'status'>, OpsStatus>>,
    Holds<Same<OpsQueryParams<'overview'>, OpsScope>>,
    Holds<Same<OpsQueryAnswer<'overview'>, OpsTile[]>>,
    Holds<Same<OpsQueryParams<'series'>, OpsScope & { metric: OpsMetric }>>,
    Holds<Same<OpsQueryAnswer<'series'>, OpsPoint[]>>,
    Holds<Same<OpsQueryParams<'turns'>, OpsScope & OpsPageRequest>>,
    Holds<Same<OpsQueryAnswer<'turns'>, OpsPage<OpsTurnRow>>>,
    Holds<Same<OpsQueryParams<'health'>, OpsScope>>,
    Holds<Same<OpsQueryAnswer<'health'>, HealthFacts | null>>,
    Holds<Same<OpsQueryParams<'healthSeries'>, OpsScope & { metric: HealthMetric }>>,
    Holds<Same<OpsQueryAnswer<'healthSeries'>, HealthPoint[]>>,
    Holds<Same<OpsQueryParams<'healthSchedules'>, OpsScope & OpsPageRequest>>,
    Holds<Same<OpsQueryAnswer<'healthSchedules'>, OpsPage<HealthScheduleRow>>>,
    Holds<Same<OpsQueryAnswer<'healthRuns'>, OpsPage<HealthRunRow>>>,
    Holds<Same<OpsQueryAnswer<'healthLongRuns'>, OpsPage<HealthLongRunRow>>>,
    // Activity and Value (CB-190).
    Holds<Same<OpsQueryAnswer<'activity'>, OpsActivityFacts>>,
    Holds<Same<OpsQueryAnswer<'value'>, OpsValueFacts>>,
    Holds<Same<OpsQueryAnswer<'activityPeople'>, OpsPage<OpsPersonRow>>>,
    Holds<Same<OpsQueryAnswer<'activitySocios'>, OpsPage<OpsSocioRow>>>,
    Holds<Same<OpsQueryAnswer<'activityChats'>, OpsPage<OpsChatRow>>>,
    Holds<Same<OpsQueryAnswer<'activitySessions'>, OpsPage<OpsSessionRow>>>,
    Holds<Same<OpsQueryParams<'activitySessions'>, OpsScope & OpsPageRequest & OpsSessionOptions>>,
    Holds<Same<OpsQueryAnswer<'themes'>, OpsThemesFacts>>,
    Holds<Same<OpsQueryParams<'themes'>, OpsScope & OpsSessionOptions>>,
    Holds<Same<OpsQueryParams<'knowledge'>, OpsScope>>,
    Holds<Same<OpsQueryAnswer<'knowledge'>, OpsKnowledge>>,
    Holds<Same<OpsQueryParams<'pages'>, OpsScope & OpsPageRequest>>,
    Holds<Same<OpsQueryAnswer<'pages'>, OpsPage<OpsPageRow>>>,
    Holds<Same<OpsQueryParams<'datasets'>, OpsScope & OpsPageRequest>>,
    Holds<Same<OpsQueryAnswer<'datasets'>, OpsPage<OpsDatasetRow>>>,
    Holds<Same<OpsQueryAnswer<'storage'>, OpsStorage>>,
    Holds<Same<OpsQueryAnswer<'toolUse'>, OpsToolUse[]>>,
    Holds<Same<OpsQueryParams<'requests'>, OpsPageRequest>>,
    Holds<Same<OpsQueryAnswer<'requests'>, OpsPage<OpsRequestRow>>>,
    Holds<Same<OpsQueryParams<'grounding'>, OpsScope>>,
    Holds<Same<OpsQueryParams<'cost'>, OpsScope>>,
    Holds<Same<OpsQueryAnswer<'cost'>, OpsCost>>,
];
/**
 * Reliability's queries (`reliability-queries.ts`) ask and answer exactly
 * what the `OpsReader` methods do; kept here, next to the registry they
 * are checked against, so that file doesn't import this one back.
 */
export type ReliabilityReaderQueries = [
    Holds<Same<OpsQueryParams<'reliability'>, OpsScope>>,
    Holds<Same<OpsQueryAnswer<'reliability'>, OpsReliabilitySummary>>,
    Holds<Same<OpsQueryAnswer<'failureSeries'>, OpsFailurePoint[]>>,
    Holds<Same<OpsQueryParams<'failureBreakdown'>, OpsScope & { by: ReliabilityDimension }>>,
    Holds<Same<OpsQueryAnswer<'failureBreakdown'>, OpsBreakdownRow[]>>,
    Holds<Same<OpsQueryParams<'failures'>, OpsScope & OpsPageRequest & OpsFailureFilter>>,
    Holds<Same<OpsQueryAnswer<'failures'>, OpsPage<OpsFailureRow>>>,
    Holds<Same<OpsQueryAnswer<'friction'>, OpsFriction>>,
    Holds<Same<OpsQueryAnswer<'issueVelocity'>, OpsIssueVelocity>>,
];
