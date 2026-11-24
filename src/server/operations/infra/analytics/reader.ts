import {
    OPS_TILES,
    type OpsMetric,
    type OpsPoint,
    type OpsStatus,
    type OpsTile,
    type OpsTurnRow,
} from '@socio/shared/operations/operations';
import {
    OPS_ACTIVITY_TILES,
    OPS_VALUE_TILES,
    type OpsActivityFacts,
    type OpsToolCapability,
    type OpsValueFacts,
} from '@socio/shared/operations/operations-activity';
import type { OpsCost } from '@socio/shared/operations/operations-cost';
import type { OpsChatGrounding, OpsGrounding } from '@socio/shared/operations/operations-grounding';
import type { HealthFacts, HealthMetric, HealthPoint } from '@socio/shared/operations/operations-health';
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

import { AnalyticsError, type AnalyticsClient } from '../../analytics/client.js';
import type { OpsQueryName } from '../../domain/ops-queries.js';
import type { OpsPage, OpsPageRequest, OpsReader, OpsScope, OpsSessionOptions } from '../../domain/reader.js';

/**
 * `OpsReader` over the analytics store (CB-187): each method is the
 * `OPS_QUERIES` entry of the same name, with the scope as its params,
 * answered by DuckDB in the analytics process, so the app's event loop
 * never runs analytics SQL. While the store can't answer (starting, its
 * first build, down or off) the port's rule holds: its status from the
 * client's health, null values and empty lists, never zeros.
 */
export class AnalyticsOpsReader implements OpsReader {
    constructor(private analytics: Pick<AnalyticsClient, 'query' | 'health'>) {}

    /**
     * The store has no file to answer from, or can't be reached; or a query
     * failed while it rebuilds (a backstop: an old file is never queried).
     */
    private notAnswering(error: unknown) {
        return (
            error instanceof AnalyticsError &&
            (error.code === 'not_ready' ||
                error.code === 'unavailable' ||
                (error.code === 'failed' && this.analytics.health().state === 'rebuilding'))
        );
    }

    async status(): Promise<OpsStatus> {
        try {
            return await this.analytics.query('status', {});
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            const health = this.analytics.health();
            return {
                state: health.state,
                asOf: health.asOf ?? null,
                earliest: null,
                ...(health.state === 'rebuilding' && health.progress !== undefined
                    ? { progress: health.progress }
                    : {}),
            };
        }
    }

    async overview(scope: OpsScope): Promise<OpsTile[]> {
        try {
            return await this.analytics.query('overview', scope);
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return OPS_TILES.map((id) => ({ id, value: null, previous: null }));
        }
    }

    async series(scope: OpsScope, metric: OpsMetric): Promise<OpsPoint[]> {
        try {
            return await this.analytics.query('series', { ...scope, metric });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return [];
        }
    }

    async turns(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsTurnRow>> {
        try {
            return await this.analytics.query('turns', { ...scope, ...page });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return { items: [], next: null };
        }
    }

    // Knowledge, storage and capabilities (CB-191).

    knowledge(scope: OpsScope): Promise<OpsKnowledge | null> {
        return this.ask(() => this.analytics.query('knowledge', scope), null);
    }

    pages(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsPageRow>> {
        return this.ask(() => this.analytics.query('pages', { ...scope, ...page }), {
            items: [],
            next: null,
        });
    }

    datasets(scope: OpsScope, page: OpsPageRequest): Promise<OpsPage<OpsDatasetRow>> {
        return this.ask(() => this.analytics.query('datasets', { ...scope, ...page }), { items: [], next: null });
    }

    storage(scope: OpsScope): Promise<OpsStorage | null> {
        return this.ask(() => this.analytics.query('storage', scope), null);
    }

    toolUse(scope: OpsScope): Promise<OpsToolUse[]> {
        return this.ask(() => this.analytics.query('toolUse', scope), []);
    }

    requests(page: OpsPageRequest): Promise<OpsPage<OpsRequestRow>> {
        return this.ask(() => this.analytics.query('requests', page), {
            items: [],
            next: null,
        });
    }

    // Grounding (CB-194).

    grounding(scope: OpsScope): Promise<OpsGrounding | null> {
        return this.ask(() => this.analytics.query('grounding', scope), null);
    }

    chatGrounding(threadId: string): Promise<OpsChatGrounding | null> {
        return this.ask(() => this.analytics.query('chatGrounding', { threadId }), null);
    }

    // Cost (CB-195, CB-196).

    cost(scope: OpsScope): Promise<OpsCost | null> {
        return this.ask(() => this.analytics.query('cost', scope), null);
    }

    costModels(): Promise<string[]> {
        return this.ask(() => this.analytics.query('costModels', {}), []);
    }

    /** The store's answer, or `fallback` while it can't answer. */
    private async ask<T>(query: () => Promise<T>, fallback: T): Promise<T> {
        try {
            return await query();
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return fallback;
        }
    }

    async activity(
        scope: OpsScope,
        options: OpsSessionOptions & { capabilities: OpsToolCapability[] },
    ): Promise<OpsActivityFacts> {
        try {
            return await this.analytics.query('activity', {
                ...scope,
                sessionGapMinutes: options.sessionGapMinutes,
                capabilities: options.capabilities,
            });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return {
                tiles: OPS_ACTIVITY_TILES.map((id) => ({
                    id,
                    value: null,
                    previous: null,
                })),
                points: [],
                sources: [],
                participation: {
                    chats: 0,
                    withSeveralPeople: 0,
                    withSeveralSocios: 0,
                    collaboration: 0,
                },
                features: [],
                spaces: [],
            };
        }
    }

    async value(scope: OpsScope, options: OpsSessionOptions): Promise<OpsValueFacts> {
        try {
            return await this.analytics.query('value', {
                ...scope,
                sessionGapMinutes: options.sessionGapMinutes,
            });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return {
                tiles: OPS_VALUE_TILES.map((id) => ({
                    id,
                    value: null,
                    previous: null,
                })),
                points: [],
                approvals: [],
                reactions: {
                    socioMessages: 0,
                    reacted: 0,
                    up: 0,
                    down: 0,
                    retry: 0,
                    needsWork: 0,
                },
                intents: [],
            };
        }
    }

    async themes(scope: OpsScope, options: OpsSessionOptions): Promise<OpsThemesFacts | null> {
        try {
            return await this.analytics.query('themes', {
                ...scope,
                sessionGapMinutes: options.sessionGapMinutes,
            });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return null;
        }
    }

    activityPeople(scope: OpsScope, options: OpsSessionOptions, page: OpsPageRequest) {
        return this.list('activityPeople', scope, options, page);
    }
    activitySocios(scope: OpsScope, options: OpsSessionOptions, page: OpsPageRequest) {
        return this.list('activitySocios', scope, options, page);
    }
    activityChats(scope: OpsScope, options: OpsSessionOptions, page: OpsPageRequest) {
        return this.list('activityChats', scope, options, page);
    }
    activitySessions(scope: OpsScope, options: OpsSessionOptions, page: OpsPageRequest) {
        return this.list('activitySessions', scope, options, page, options.outcome ? { outcome: options.outcome } : {});
    }

    private async list<
        N extends Extract<OpsQueryName, 'activityPeople' | 'activitySocios' | 'activityChats' | 'activitySessions'>,
    >(
        name: N,
        scope: OpsScope,
        options: OpsSessionOptions,
        page: OpsPageRequest,
        extra: object = {},
    ): Promise<Awaited<ReturnType<OpsReader[N]>>> {
        try {
            return (await this.analytics.query(name, {
                ...scope,
                ...page,
                sessionGapMinutes: options.sessionGapMinutes,
                ...extra,
            } as never)) as Awaited<ReturnType<OpsReader[N]>>;
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return { items: [], next: null } as Awaited<ReturnType<OpsReader[N]>>;
        }
    }

    // Health (CB-192).

    async health(scope: OpsScope): Promise<HealthFacts | null> {
        try {
            return await this.analytics.query('health', scope);
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return null;
        }
    }

    async healthSeries(scope: OpsScope, metric: HealthMetric): Promise<HealthPoint[]> {
        try {
            return await this.analytics.query('healthSeries', { ...scope, metric });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return [];
        }
    }

    async healthSchedules(scope: OpsScope, page: OpsPageRequest) {
        try {
            return await this.analytics.query('healthSchedules', {
                ...scope,
                ...page,
            });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return { items: [], next: null };
        }
    }

    async healthRuns(scope: OpsScope, page: OpsPageRequest) {
        try {
            return await this.analytics.query('healthRuns', { ...scope, ...page });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return { items: [], next: null };
        }
    }

    async healthLongRuns(scope: OpsScope, page: OpsPageRequest) {
        try {
            return await this.analytics.query('healthLongRuns', {
                ...scope,
                ...page,
            });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return { items: [], next: null };
        }
    }

    async reliability(scope: OpsScope): Promise<OpsReliabilitySummary> {
        try {
            return await this.analytics.query('reliability', scope);
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return noReliability();
        }
    }

    async failureSeries(scope: OpsScope): Promise<OpsFailurePoint[]> {
        try {
            return await this.analytics.query('failureSeries', scope);
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return [];
        }
    }

    async failureBreakdown(scope: OpsScope, by: ReliabilityDimension): Promise<OpsBreakdownRow[]> {
        try {
            return await this.analytics.query('failureBreakdown', { ...scope, by });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return [];
        }
    }

    async failures(
        scope: OpsScope,
        page: OpsPageRequest,
        filter: OpsFailureFilter = {},
    ): Promise<OpsPage<OpsFailureRow>> {
        try {
            return await this.analytics.query('failures', {
                ...scope,
                ...page,
                ...filter,
            });
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return { items: [], next: null };
        }
    }

    async friction(scope: OpsScope): Promise<OpsFriction> {
        try {
            return await this.analytics.query('friction', scope);
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return { from: frictionFrom(scope.window), rows: [] };
        }
    }

    async issueVelocity(scope: OpsScope): Promise<OpsIssueVelocity> {
        try {
            return await this.analytics.query('issueVelocity', scope);
        } catch (error) {
            if (!this.notAnswering(error)) {
                throw error;
            }
            return noIssueVelocity();
        }
    }
}
