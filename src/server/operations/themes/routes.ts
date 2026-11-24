import type { Context, Hono, MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { OpsStatus } from '@socio/shared/operations/operations';
import type { OpsThemes } from '@socio/shared/operations/operations-themes';

import type { AuditedList } from '../access-log.js';
import type { OpsReader, OpsScope } from '../domain/reader.js';

type Scoped = { refused: Response } | { status: OpsStatus; scope: OpsScope };

export interface ThemesRouteDeps {
    reader: OpsReader;
    scopeOf: (c: Context<AppEnv>) => Promise<Scoped>;
    /** The session gap in force (Operations → Settings). */
    sessionGapMinutes: () => number;
    /** The access log's wrapper (CB-188). */
    auditedList: AuditedList;
}

/**
 * Themes (CB-199): `GET /operations/themes` answers people's sessions by
 * intent and by theme over the range and filters: workspace aggregates,
 * with themes under the privacy floor counted and never named. Narrowed
 * to one person, it is their activity, so it goes on the access log as
 * Value does.
 */
export function mountThemesRoutes(
    app: Hono<AppEnv>,
    { reader, scopeOf, sessionGapMinutes, auditedList }: ThemesRouteDeps,
) {
    const personal: MiddlewareHandler<AppEnv> = async (c, next) =>
        c.req.query('person') ? auditedList('themes')(c, next) : next();

    app.get('/operations/themes', personal, async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        const gap = sessionGapMinutes();
        return c.json<OpsThemes>({
            status: read.status,
            window: read.scope.window,
            sessionGapMinutes: gap,
            facts: await reader.themes(read.scope, { sessionGapMinutes: gap }),
        });
    });
}
