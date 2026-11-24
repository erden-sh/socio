import type { Context, Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { FAILURE_CATEGORIES } from '@socio/shared/failure-taxonomy';
import { OPS_PAGE_LIMIT, type CursorPage, type OpsStatus } from '@socio/shared/operations/operations';
import {
    RELIABILITY_DIMENSIONS,
    type OpsFailureFilter,
    type OpsFailureRow,
    type OpsReliability,
    type OpsReliabilityBreakdown,
    type OpsReliabilityFriction,
    type OpsReliabilityIssues,
    type OpsReliabilitySeries,
    type ReliabilityDimension,
} from '@socio/shared/operations/operations-reliability';

import type { AuditedList } from './access-log.js';
import { encodeCursor, type OpsCursor } from './domain/cursor.js';
import type { OpsReader, OpsScope } from './domain/reader.js';

/** How `operationsRoutes` reads a request's scope (or refuses it). */
type ScopeOf = (
    c: Context<AppEnv>,
) => Promise<{ refused: Response } | { status: OpsStatus; scope: OpsScope; refused?: undefined }>;
type PageOf = (
    cursor: string | undefined,
    limit: string | undefined,
) => { cursor?: OpsCursor; limit: number } | undefined;

const TOOL = /^[\w.:@+-]{1,120}$/;

/**
 * Operations → Reliability's API (CB-189), on the module's admin-only
 * app: each answer takes the page's range and filters, as Overview's do.
 * The failures list is cursor-paged and narrows by `category` and `tool`;
 * its turns are person-level rows, so it is on the access log (CB-188).
 */
export function reliabilityRoutes(
    app: Hono<AppEnv>,
    {
        reader,
        scopeOf,
        pageOf,
        auditedList,
    }: {
        reader: OpsReader;
        scopeOf: ScopeOf;
        pageOf: PageOf;
        auditedList: AuditedList;
    },
) {
    app.get('/operations/reliability', async (c) => {
        const read = await scopeOf(c);
        if (read.refused) {
            return read.refused;
        }
        return c.json<OpsReliability>({
            status: read.status,
            window: read.scope.window,
            summary: await reader.reliability(read.scope),
        });
    });

    app.get('/operations/reliability/series', async (c) => {
        const read = await scopeOf(c);
        if (read.refused) {
            return read.refused;
        }
        return c.json<OpsReliabilitySeries>({
            status: read.status,
            window: read.scope.window,
            points: await reader.failureSeries(read.scope),
        });
    });

    app.get('/operations/reliability/breakdown/:by', async (c) => {
        const by = c.req.param('by');
        if (!(RELIABILITY_DIMENSIONS as readonly string[]).includes(by)) {
            return c.json({ error: 'There is no such breakdown.' }, 404);
        }
        const read = await scopeOf(c);
        if (read.refused) {
            return read.refused;
        }
        return c.json<OpsReliabilityBreakdown>({
            status: read.status,
            window: read.scope.window,
            by: by as ReliabilityDimension,
            rows: await reader.failureBreakdown(read.scope, by as ReliabilityDimension),
        });
    });

    app.get('/operations/reliability/failures', auditedList('failures', ['category', 'tool']), async (c) => {
        const read = await scopeOf(c);
        if (read.refused) {
            return read.refused;
        }
        const page = pageOf(c.req.query('cursor'), c.req.query('limit'));
        const category = c.req.query('category') || undefined;
        const tool = c.req.query('tool') || undefined;
        if (
            !page ||
            (category && !(FAILURE_CATEGORIES as readonly string[]).includes(category)) ||
            (tool && !TOOL.test(tool))
        ) {
            return c.json(
                {
                    error: `Send cursor as a list gave it, limit from 1 to ${OPS_PAGE_LIMIT.max}, a failure category and a tool name.`,
                },
                400,
            );
        }
        const filter: OpsFailureFilter = {
            ...(category ? { category: category as OpsFailureFilter['category'] } : {}),
            ...(tool ? { tool } : {}),
        };
        const answer = await reader.failures(read.scope, page, filter);
        return c.json<CursorPage<OpsFailureRow>>({
            items: answer.items,
            next: answer.next && encodeCursor(answer.next),
        });
    });

    app.get('/operations/reliability/friction', async (c) => {
        const read = await scopeOf(c);
        if (read.refused) {
            return read.refused;
        }
        return c.json<OpsReliabilityFriction>({
            status: read.status,
            window: read.scope.window,
            ...(await reader.friction(read.scope)),
        });
    });

    app.get('/operations/reliability/issues', async (c) => {
        const read = await scopeOf(c);
        if (read.refused) {
            return read.refused;
        }
        return c.json<OpsReliabilityIssues>({
            status: read.status,
            window: read.scope.window,
            issues: await reader.issueVelocity(read.scope),
        });
    });
}
