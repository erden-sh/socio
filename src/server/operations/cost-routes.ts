import type { Context, Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { OpsStatus } from '@socio/shared/operations/operations';
import type { OpsCostView } from '@socio/shared/operations/operations-cost';

import type { AuditedList } from './access-log.js';
import type { OpsReader, OpsScope } from './domain/reader.js';

/**
 * Cost's route (CB-195, CB-196) on the Operations app: what turns cost
 * over the range and filters, by model, socio, person and backend, and
 * what cost pools cost and idled. It lists people's spend, so each view
 * is written to the access log, as Health's tokens by person are.
 */
export function costRoutes(
    app: Hono<AppEnv>,
    {
        reader,
        scopeOf,
        auditedList,
    }: {
        reader: OpsReader;
        scopeOf: (
            c: Context<AppEnv>,
        ) => Promise<{ readonly refused: Response } | { readonly status: OpsStatus; readonly scope: OpsScope }>;
        auditedList: AuditedList;
    },
) {
    app.get('/operations/cost', auditedList('cost'), async (c) => {
        const read = await scopeOf(c);
        if ('refused' in read) {
            return read.refused;
        }
        return c.json<OpsCostView>({
            status: read.status,
            window: read.scope.window,
            cost: await reader.cost(read.scope),
        });
    });
}
