import { Flags } from '../flags/contract.js';
import type { ServerModule } from '../modules/contract.js';

import { Approvals, ApprovalsWorkspace } from './contract.js';
import { approvalsSchema } from './migrations.js';
import { approvalRoutes } from './routes.js';

/**
 * Approvals: the service lives on the platform (`platform.approvals`), where
 * modules register their handlers; the module owns the tables, the routes
 * and the expiry tick.
 */
export const approvalsModule: ServerModule = {
    ...approvalsSchema,
    // The service is `Approvals`, the socios approvals' `ApprovalsWorkspace`
    // and the flags `Flags`, from the app's services.
    routes: ({ services }) =>
        approvalRoutes({
            approvals: services.get(Approvals),
            workspace: services.get(ApprovalsWorkspace).socios,
            flags: services.get(Flags),
        }),
    tick: { everyMs: 60_000, run: ({ services }) => services.get(Approvals).expire() },
};
