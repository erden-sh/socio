import type { ServerModule } from '../modules/contract.js';

import { Cloud, ReplyReports } from './contract.js';
import { cloudSchema } from './migrations.js';
import { cloudRoutes } from './routes.js';

/**
 * The cloud connection (docs/specs/CLOUD-SERVICES-PROTOCOL.md §3.1): the
 * deployment's identity at the cloud services' issuer, and the AI reply
 * reports that use it (CB-382). The identity is one sealed secret setting;
 * the reports' outbox and the sharing setting are the module's own tables
 * (`migrations.ts`, expand-only, so an older build still opens the
 * database). Its routes are admins': `GET /api/cloud`, the Cloud
 * connection card's view on the Platform page, and
 * `GET`/`PUT /api/cloud/reply-reports`, the sharing setting.
 *
 * Its tick, on the leader only, enrolls with provisioning's token when one
 * is set and syncs once a day, then sends the reply reports that are due.
 * The first run comes a minute after start, not during boot, so the issuer
 * never holds startup up. With no token and no identity, or with
 * `SOCIO_CLOUD=off`, a run sends nothing.
 */
export const cloudModule: ServerModule = {
    ...cloudSchema,
    routes: ({ services }) => cloudRoutes(services.get(Cloud), services.get(ReplyReports)),
    start: ({ services }) => {
        services.get(Cloud).resume();
        services.get(ReplyReports).resume();
    },
    tick: {
        everyMs: 60_000,
        run: async ({ services }) => {
            await services.get(Cloud).work();
            await services.get(ReplyReports).send();
        },
    },
    // Drained, not cut off: an enrollment in flight has spent its token, and
    // only its answer, stored, keeps the identity; a report in flight is
    // written down as sent (or not) before the database closes.
    release: async ({ services }) => {
        await Promise.all([services.get(Cloud).drain(), services.get(ReplyReports).drain()]);
    },
    stop: async ({ services }) => {
        await Promise.all([services.get(Cloud).drain(), services.get(ReplyReports).drain()]);
    },
};
