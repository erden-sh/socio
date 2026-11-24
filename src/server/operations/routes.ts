import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { operationsSettingsView } from '@socio/foundation/operations/settings-view';
import type { LimitValues } from '@socio/shared/limits';
import {
    OPS_METRICS,
    opsSearch,
    opsWindow,
    readOpsQuery,
    type CursorPage,
    type OperationsSettings,
    type OperationsSettingsView,
    type OpsMetric,
    type OpsOverview,
    type OpsSeries,
    type OpsTurnRow,
} from '@socio/shared/operations/operations';
import { OPS_SESSION_GAP } from '@socio/shared/operations/operations-activity';
import type {
    OpsCapabilitiesView,
    OpsDatasetRow,
    OpsKnowledgeView,
    OpsPageRow,
    OpsRequestRow,
    OpsStorageView,
} from '@socio/shared/operations/operations-knowledge';
import { ianaTimeZone } from '@socio/shared/time-zone';
import type { Settings } from '@socio/shared/types';

import type { AuditedList } from './access-log.js';
import { mountActivityRoutes, type CapabilityList } from './activity-routes.js';
import type { AuditOptions, AccessSubject } from './contract.js';
import { costRoutes } from './cost-routes.js';
import { encodeCursor, type OpsCursor } from './domain/cursor.js';
import type { OpsPageRequest, OpsReader, OpsScope } from './domain/reader.js';
import { groundingRoutes } from './grounding-routes.js';
import { healthRoutes, type HealthLiveSource } from './health-routes.js';
import { pageOf, PAGE_ERROR } from './paging.js';
import { capabilityCoverage, type CoverageSources } from './queries/coverage.js';
import { quotasOf } from './queries/storage.js';
import { reliabilityRoutes } from './reliability-routes.js';
import { savedOperationsSettings } from './settings.js';
import { mountThemesRoutes } from './themes/routes.js';

export interface OperationsDeps {
    /** The analytics store's answers (CB-186), or the in-memory stand-in. */
    reader: OpsReader;
    /** Where the workspace settings are kept (`WorkspaceSettings`). */
    settings: {
        settings(): Settings;
        updateSettings(patch: Partial<Settings>): Promise<Settings>;
    };
    /** The environment's values (`OPS_TIME_ZONE`). */
    env?: OperationsSettings;
    /**
     * The access log's route wrapper (`auditor`, CB-188), on every endpoint
     * that answers person-level rows or content. None: nothing is logged
     * (sections' tests).
     */
    audit?: (options: AuditOptions) => MiddlewareHandler<AppEnv>;
    /** What Health reads live in the app: backups, the store (CB-192). */
    health?: HealthLiveSource;
    /** The limits in force (`limitsInForce`), for the data space quotas. */
    limits?: () => LimitValues;
    /** The modules and capability registry, for the coverage matrix. */
    coverage?: CoverageSources;
    now?: () => number;
    /** The app's capability registry, for Activity's feature use (CB-190). */
    capabilities?: CapabilityList;
}

/**
 * What a turns list (person-level rows that link to chats) is about: its
 * narrowest filter, else the whole workspace's turns.
 */
const listSubject = (c: Context<AppEnv>): AccessSubject | undefined => {
    const { query, invalid } = readOpsQuery(new URL(c.req.url).searchParams);
    if (invalid.length) {
        return undefined;
    }
    const { person, socio, space } = query.filters;
    if (person) {
        return { kind: 'person', id: person };
    }
    if (socio) {
        return { kind: 'socio', id: socio };
    }
    if (space) {
        return { kind: 'space', id: space };
    }
    return { kind: 'workspace', id: null };
};
/** A list's range and filters, as its address has them (no cursor). */
const listFilters = (c: Context<AppEnv>) =>
    Object.fromEntries(new URLSearchParams(opsSearch(readOpsQuery(new URL(c.req.url).searchParams).query)));

const settingsInput = z
    .object({
        // null: the server's (`OPS_TIME_ZONE`, else UTC).
        timeZone: z
            .string()
            .max(64)
            .nullable()
            .transform((value, ctx) => {
                if (value === null) {
                    return null;
                }
                const zone = ianaTimeZone(value);
                if (!zone) {
                    ctx.addIssue({ code: 'custom' });
                }
                return zone ?? '';
            })
            .optional(),
        // null: the server's (`OPS_SESSION_GAP_MINUTES`, else 30).
        sessionGapMinutes: z.number().int().min(OPS_SESSION_GAP.min).max(OPS_SESSION_GAP.max).nullable().optional(),
    })
    .strict();

/**
 * The Operations dashboard's API (CB-164), admins only: the module's
 * `access: 'admin'` guards every path (operators pass). Each section's
 * answer takes the range and filters of the page's address
 * (`readOpsQuery`), is cut in the reporting time zone, and carries the
 * analytics store's status. Lists are cursor-paged: `?cursor=&limit=`
 * gives `{ items, next }`.
 */
export function operationsRoutes({
    reader,
    settings: store,
    env = {},
    audit,
    health,
    limits,
    coverage,
    now = Date.now,
    capabilities,
}: OperationsDeps) {
    const app = new Hono<AppEnv>();
    const view = () => operationsSettingsView(store.settings(), env);

    /** The scope of a request's address, or the answer that refuses it. */
    const scopeOf = async (c: Context<AppEnv>) => {
        const { query, invalid } = readOpsQuery(new URL(c.req.url).searchParams);
        if (invalid.length) {
            return {
                refused: c.json({ error: `Check the range and filters: ${invalid.join(', ')}.` }, 400),
            } as const;
        }
        const status = await reader.status();
        const window = opsWindow(query, {
            now: now(),
            timeZone: view().timeZone,
            earliest: status.earliest,
        });
        return { status, scope: { window, filters: query.filters } } as const;
    };

    app.get('/operations/status', async (c) => c.json(await reader.status()));

    app.get('/operations/settings', (c) => c.json<OperationsSettingsView>(view()));
    app.put('/operations/settings', async (c) => {
        const parsed = settingsInput.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json(
                {
                    error: `Send timeZone as a time zone name, such as Europe/Madrid, or sessionGapMinutes as whole minutes from ${OPS_SESSION_GAP.min} to ${OPS_SESSION_GAP.max}; null goes back to the server’s.`,
                },
                400,
            );
        }
        await store.updateSettings({
            operations: savedOperationsSettings(store.settings().operations, parsed.data),
        });
        return c.json<OperationsSettingsView>(view());
    });

    app.get('/operations/overview', async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        return c.json<OpsOverview>({
            status: read.status,
            window: read.scope.window,
            tiles: await reader.overview(read.scope),
        });
    });

    app.get('/operations/series/:metric', async (c) => {
        const metric = c.req.param('metric');
        if (!(OPS_METRICS as readonly string[]).includes(metric)) {
            return c.json({ error: 'There is no such metric.' }, 404);
        }
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        return c.json<OpsSeries>({
            status: read.status,
            window: read.scope.window,
            metric: metric as OpsMetric,
            points: await reader.series(read.scope, metric as OpsMetric),
        });
    });

    const audited = (options: AuditOptions): MiddlewareHandler<AppEnv> =>
        audit ? audit(options) : (_c, next) => next();
    const auditedList: AuditedList = (surface, params = []) =>
        audited({
            surface,
            subject: listSubject,
            content: false,
            filters: (c) => ({
                ...listFilters(c),
                ...Object.fromEntries(
                    params.flatMap((name) => {
                        const value = c.req.query(name);
                        return value ? [[name, value]] : [];
                    }),
                ),
            }),
            once: 'list',
        });

    app.get('/operations/turns', auditedList('turns'), async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        const page = pageOf(c.req.query('cursor'), c.req.query('limit'));
        if (!page) {
            return c.json({ error: PAGE_ERROR }, 400);
        }
        const answer = await reader.turns(read.scope, page);
        return c.json<CursorPage<OpsTurnRow>>({
            items: answer.items,
            next: answer.next && encodeCursor(answer.next),
        });
    });

    reliabilityRoutes(app, { reader, scopeOf, pageOf, auditedList });

    healthRoutes(app, { reader, live: health, scopeOf, pageOf, auditedList });

    costRoutes(app, { reader, scopeOf, auditedList });

    mountActivityRoutes(app, {
        reader,
        scopeOf,
        pageOf,
        sessionGapMinutes: () => view().sessionGapMinutes,
        capabilities,
        auditedList,
    });

    mountThemesRoutes(app, {
        reader,
        scopeOf,
        sessionGapMinutes: () => view().sessionGapMinutes,
        auditedList,
    });

    // Knowledge, storage and capabilities (CB-191).

    /** A cursor-paged list of the request's scope. */
    const list =
        <T>(read: (scope: OpsScope, page: OpsPageRequest) => Promise<{ items: T[]; next: OpsCursor | null }>) =>
        async (c: Context<AppEnv>) => {
            const scoped = await scopeOf(c);
            if ('refused' in scoped) {
                return scoped.refused;
            }
            const page = pageOf(c.req.query('cursor'), c.req.query('limit'));
            if (!page) {
                return c.json({ error: PAGE_ERROR }, 400);
            }
            const answer = await read(scoped.scope, page);
            return c.json<CursorPage<T>>({
                items: answer.items,
                next: answer.next && encodeCursor(answer.next),
            });
        };

    app.get('/operations/knowledge', async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        return c.json<OpsKnowledgeView>({
            status: read.status,
            window: read.scope.window,
            knowledge: await reader.knowledge(read.scope),
        });
    });
    app.get(
        '/operations/knowledge/pages',
        list<OpsPageRow>((scope, page) => reader.pages(scope, page)),
    );
    // People's datasets, by name (the access log, CB-188).
    app.get(
        '/operations/knowledge/datasets',
        auditedList('knowledge-datasets'),
        list<OpsDatasetRow>((scope, page) => reader.datasets(scope, page)),
    );
    app.get('/operations/storage', async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        const storage = await reader.storage(read.scope);
        return c.json<OpsStorageView>({
            status: read.status,
            window: read.scope.window,
            storage,
            quotas: limits ? quotasOf(limits(), storage) : [],
        });
    });
    app.get('/operations/capabilities', async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        const use = await reader.toolUse(read.scope);
        return c.json<OpsCapabilitiesView>({
            status: read.status,
            window: read.scope.window,
            coverage: coverage
                ? capabilityCoverage(coverage, use)
                : {
                      modules: [],
                      capabilities: [],
                      tools: [],
                      unregistered: [],
                      unoffered: [],
                  },
        });
    });
    // What grounded turns (CB-194).
    groundingRoutes(app, { reader, scopeOf });

    // Requests are listed whatever the range: demand builds up over time.
    app.get('/operations/capabilities/requests', async (c) => {
        const page = pageOf(c.req.query('cursor'), c.req.query('limit'));
        if (!page) {
            return c.json({ error: PAGE_ERROR }, 400);
        }
        const answer = await reader.requests(page);
        return c.json<CursorPage<OpsRequestRow>>({
            items: answer.items,
            next: answer.next && encodeCursor(answer.next),
        });
    });

    return app;
}
