import type { ServerModule } from '../modules/contract.js';
import { Audit } from '../workspace/contract.js';

import { Updates } from './contract.js';
import { updateRoutes } from './routes.js';

/**
 * Updates (CB-259): the operator routes under `/api/updates` and the
 * scheduled check of the release feed (`platform.updates`). Its UI is the
 * "Updates" card on the Platform page (the operator client module). It has
 * no tables: its settings live in Settings and its token in the core
 * store's secret settings, so an older build can still open the database.
 *
 * Its hooks read the service as `Updates` and the audit as `Audit`, from
 * the app's services at the moment of use, so a test that offers its
 * own `Updates` before the routes are built gets it.
 */
export const updatesModule: ServerModule = {
    id: 'updates',
    routes: ({ services }) => {
        const audit = services.get(Audit);
        return updateRoutes(services.get(Updates), (entry) => audit.audit(entry));
    },
    // Checks once a minute whether a scheduled check is due; the first comes
    // a minute after start, not during boot.
    tick: {
        everyMs: 60_000,
        run: ({ services }) => {
            const updates = services.get(Updates);
            return updates.due() ? updates.check() : undefined;
        },
    },
};
