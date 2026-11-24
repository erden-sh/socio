import type { ServerModule } from '../modules/contract.js';
import { AccessAudit } from '../operations/contract.js';

import { RunsViews } from './contract.js';
import { runsSchema } from './migrations.js';
import { runRoutes } from './run-routes.js';

/**
 * Runs: recent agent turns and their traces; admins see everyone's, and
 * each trace they open from another person's chat is on Operations'
 * access log (CB-188).
 * Its routes read the run views (`RunsViews`) and Operations' access log
 * (`AccessAudit`) from the app's services when they are mounted.
 */
export const runsModule: ServerModule = {
    ...runsSchema,
    routes: ({ services }) => runRoutes(services.get(RunsViews), { audit: services.get(AccessAudit).audit }),
};
