import type { ServerModule } from '../modules/contract.js';

import { Cloud } from './contract.js';
import { cloudRoutes } from './routes.js';

/**
 * The cloud connection (docs/specs/CLOUD-SERVICES-PROTOCOL.md §3.1): the
 * deployment's identity at the cloud services' issuer. It has no tables: the
 * identity is one sealed secret setting, so an older build can still open
 * the database. Its one route, `GET /api/cloud` (admins), is the Cloud
 * connection card's view on the Platform page.
 *
 * Its tick, on the leader only, enrolls with provisioning's token when one
 * is set and syncs once a day. The first run comes a minute after start,
 * not during boot, so the issuer never holds startup up. With no token and
 * no identity, or with `SOCIO_CLOUD=off`, a run sends nothing.
 */
export const cloudModule: ServerModule = {
    id: 'cloud',
    routes: ({ services }) => cloudRoutes(services.get(Cloud)),
    start: ({ services }) => services.get(Cloud).resume(),
    tick: {
        everyMs: 60_000,
        run: ({ services }) => services.get(Cloud).work(),
    },
    // Drained, not cut off: an enrollment in flight has spent its token, and
    // only its answer, stored, keeps the identity.
    release: ({ services }) => services.get(Cloud).drain(),
    stop: ({ services }) => services.get(Cloud).drain(),
};
