import type { Context, Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { OpsStatus } from '@socio/shared/operations/operations';
import type { OpsGroundingView } from '@socio/shared/operations/operations-grounding';

import type { OpsReader, OpsScope } from './domain/reader.js';

/** How `operationsRoutes` reads a request's scope (or refuses it). */
type ScopeOf = (
    c: Context<AppEnv>,
) => Promise<{ refused: Response } | { status: OpsStatus; scope: OpsScope; refused?: undefined }>;

/**
 * Operations → Knowledge's grounding (CB-194), on the module's admin-only
 * app: Spaces' reads by bucket and the pages that grounded the most chats,
 * for the page's range and filters. Counts, Space names and page titles
 * only, as Knowledge's pages list: no person-level rows, so not on the
 * access log. One chat's grounding is the transcript's (`transcripts.ts`).
 */
export function groundingRoutes(app: Hono<AppEnv>, { reader, scopeOf }: { reader: OpsReader; scopeOf: ScopeOf }) {
    app.get('/operations/knowledge/grounding', async (c) => {
        const read = await scopeOf(c);
        if (read.refused) {
            return read.refused;
        }
        return c.json<OpsGroundingView>({
            status: read.status,
            window: read.scope.window,
            grounding: await reader.grounding(read.scope),
        });
    });
}
