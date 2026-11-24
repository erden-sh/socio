import type { Context, Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { OPS_PAGE_LIMIT, type CursorPage, type OpsStatus } from '@socio/shared/operations/operations';
import {
    HEALTH_METRICS,
    type HealthLive,
    type HealthLongRunRow,
    type HealthMetric,
    type HealthRunRow,
    type HealthScheduleRow,
    type OpsHealth,
    type OpsHealthSeries,
} from '@socio/shared/operations/operations-health';

import type { AuditedList } from './access-log.js';
import { encodeCursor } from './domain/cursor.js';
import type { OpsPage, OpsPageRequest, OpsReader, OpsScope } from './domain/reader.js';

/** What the app knows live (backups, the store's process). */
export type HealthLiveSource = () => Promise<HealthLive>;

export const NO_LIVE_HEALTH: HealthLive = {
    analytics: null,
    staleAfterMs: 5 * 60_000,
    backup: null,
};

type ScopeOf = (
    c: Context<AppEnv>,
) => Promise<{ readonly refused: Response } | { readonly status: OpsStatus; readonly scope: OpsScope }>;
type PageOf = (cursor: string | undefined, limit: string | undefined) => OpsPageRequest | undefined;

/**
 * Operations → Health's API (CB-192), on the module's routes: the
 * numbers (`/operations/health`), a metric's p95 per bucket, and three
 * cursor-paged lists. The store's numbers come through the `OpsReader`;
 * backups and the analytics process's own state are read live in the
 * app (cheap reads: files), not from the
 * store, so they show even while it is down. The numbers (tokens by
 * person) and the schedules and long runs lists (each a person's) are
 * person-level rows: on the access log (CB-188).
 */
export function healthRoutes(
    app: Hono<AppEnv>,
    {
        reader,
        live = async () => NO_LIVE_HEALTH,
        scopeOf,
        pageOf,
        auditedList,
    }: {
        reader: OpsReader;
        live?: HealthLiveSource;
        scopeOf: ScopeOf;
        pageOf: PageOf;
        auditedList: AuditedList;
    },
) {
    app.get('/operations/health', auditedList('health'), async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        const [facts, now] = await Promise.all([reader.health(read.scope), live().catch(() => NO_LIVE_HEALTH)]);
        return c.json<OpsHealth>({
            status: read.status,
            window: read.scope.window,
            facts,
            live: now,
        });
    });

    app.get('/operations/health/series/:metric', async (c) => {
        const metric = c.req.param('metric');
        if (!(HEALTH_METRICS as readonly string[]).includes(metric)) {
            return c.json({ error: 'There is no such metric.' }, 404);
        }
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        return c.json<OpsHealthSeries>({
            status: read.status,
            window: read.scope.window,
            metric: metric as HealthMetric,
            points: await reader.healthSeries(read.scope, metric as HealthMetric),
        });
    });

    const list = <T>(
        path: string,
        surface: string | null,
        read: (scope: OpsScope, page: OpsPageRequest) => Promise<OpsPage<T>>,
    ) =>
        app.get(path, surface ? auditedList(surface) : (_c, next) => next(), async (c) => {
            const scoped = await scopeOf(c);
            if ('refused' in scoped) {
                return scoped.refused;
            }
            const page = pageOf(c.req.query('cursor'), c.req.query('limit'));
            if (!page) {
                return c.json(
                    {
                        error: `Send cursor as a list gave it and limit from 1 to ${OPS_PAGE_LIMIT.max}.`,
                    },
                    400,
                );
            }
            const answer = await read(scoped.scope, page);
            return c.json<CursorPage<T>>({
                items: answer.items,
                next: answer.next && encodeCursor(answer.next),
            });
        });
    list<HealthScheduleRow>('/operations/health/schedules', 'health-schedules', (scope, page) =>
        reader.healthSchedules(scope, page),
    );
    // Scheduled runs: a task's title and times, no one's id.
    list<HealthRunRow>('/operations/health/runs', null, (scope, page) => reader.healthRuns(scope, page));
    list<HealthLongRunRow>('/operations/health/long-runs', 'health-long-runs', (scope, page) =>
        reader.healthLongRuns(scope, page),
    );
}
