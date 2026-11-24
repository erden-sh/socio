import type { Context, Hono, MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { OPS_PAGE_LIMIT, type CursorPage, type OpsStatus } from '@socio/shared/operations/operations';
import {
    OPS_OUTCOMES,
    type OpsActivity,
    type OpsChatRow,
    type OpsFeatureUse,
    type OpsOutcome,
    type OpsPersonRow,
    type OpsSessionRow,
    type OpsSocioRow,
    type OpsToolCapability,
    type OpsValue,
} from '@socio/shared/operations/operations-activity';

import type { AuditedList } from './access-log.js';
import { encodeCursor } from './domain/cursor.js';
import type { OpsPage, OpsPageRequest, OpsReader, OpsScope } from './domain/reader.js';

/** The capabilities the app's modules registered, and the tools each brings. */
export interface CapabilityList {
    list(): readonly { id: string; label: string; tools?: readonly string[] }[];
}

type Scoped = { refused: Response } | { status: OpsStatus; scope: OpsScope };

export interface ActivityRouteDeps {
    reader: OpsReader;
    scopeOf: (c: Context<AppEnv>) => Promise<Scoped>;
    pageOf: (cursor: string | undefined, limit: string | undefined) => OpsPageRequest | undefined;
    /** The session gap in force (Operations → Settings). */
    sessionGapMinutes: () => number;
    capabilities?: CapabilityList;
    /** The access log's wrapper for person-level lists (CB-188). */
    auditedList: AuditedList;
}

/**
 * Activity and Value (CB-190): `GET /operations/activity` and
 * `/operations/value` answer the section's tiles, chart and breakdowns
 * (workspace aggregates, not logged unless narrowed to a person); the
 * drill-downs are cursor-paged lists of people, socios, chats and
 * sessions, each behind the access log's wrapper.
 */
export function mountActivityRoutes(
    app: Hono<AppEnv>,
    { reader, scopeOf, pageOf, sessionGapMinutes, capabilities, auditedList }: ActivityRouteDeps,
) {
    const tools = (): OpsToolCapability[] =>
        (capabilities?.list() ?? []).flatMap((capability) =>
            (capability.tools ?? []).map((tool) => ({
                tool,
                capability: capability.id,
            })),
        );
    const labels = () => new Map((capabilities?.list() ?? []).map((capability) => [capability.id, capability.label]));

    /** Logged only when narrowed to one person: then it is their activity. */
    const personal =
        (surface: string): MiddlewareHandler<AppEnv> =>
        async (c, next) =>
            c.req.query('person') ? auditedList(surface)(c, next) : next();

    app.get('/operations/activity', personal('activity'), async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        const gap = sessionGapMinutes();
        const facts = await reader.activity(read.scope, {
            sessionGapMinutes: gap,
            capabilities: tools(),
        });
        const named = labels();
        return c.json<OpsActivity>({
            status: read.status,
            window: read.scope.window,
            sessionGapMinutes: gap,
            ...facts,
            features: facts.features.map((feature): OpsFeatureUse => ({
                ...feature,
                label: named.get(feature.id) ?? (feature.id.startsWith('tool:') ? feature.id.slice(5) : feature.id),
            })),
        });
    });

    app.get('/operations/value', personal('value'), async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        const gap = sessionGapMinutes();
        return c.json<OpsValue>({
            status: read.status,
            window: read.scope.window,
            sessionGapMinutes: gap,
            ...(await reader.value(read.scope, { sessionGapMinutes: gap })),
        });
    });

    /** A cursor-paged drill-down over one reader list. */
    const list = <T>(
        path: string,
        surface: string,
        read: (
            scope: OpsScope,
            options: { sessionGapMinutes: number; outcome?: OpsOutcome },
            page: OpsPageRequest,
        ) => Promise<OpsPage<T>>,
    ) =>
        app.get(path, auditedList(surface, ['outcome']), async (c) => {
            const scoped = await scopeOf(c);
            if ('refused' in scoped) {
                return scoped.refused;
            }
            const page = pageOf(c.req.query('cursor'), c.req.query('limit'));
            const outcome = c.req.query('outcome');
            if (!page || (outcome !== undefined && !(OPS_OUTCOMES as readonly string[]).includes(outcome))) {
                return c.json(
                    {
                        error: `Send cursor as a list gave it, limit from 1 to ${OPS_PAGE_LIMIT.max}, and outcome as one of ${OPS_OUTCOMES.join(', ')}.`,
                    },
                    400,
                );
            }
            const answer = await read(
                scoped.scope,
                {
                    sessionGapMinutes: sessionGapMinutes(),
                    ...(outcome ? { outcome: outcome as OpsOutcome } : {}),
                },
                page,
            );
            return c.json<CursorPage<T>>({
                items: answer.items,
                next: answer.next && encodeCursor(answer.next),
            });
        });

    list<OpsPersonRow>('/operations/activity/people', 'activity-people', (scope, options, page) =>
        reader.activityPeople(scope, options, page),
    );
    list<OpsSocioRow>('/operations/activity/socios', 'activity-socios', (scope, options, page) =>
        reader.activitySocios(scope, options, page),
    );
    list<OpsChatRow>('/operations/activity/chats', 'activity-chats', (scope, options, page) =>
        reader.activityChats(scope, options, page),
    );
    list<OpsSessionRow>('/operations/value/sessions', 'value-sessions', (scope, options, page) =>
        reader.activitySessions(scope, options, page),
    );
}
