import type { ServerModule } from '../modules/contract.js';

import { FlagAdmin, FlagsWorkspace } from './contract.js';
import { flagRoutes } from './routes.js';
import { flagsSchema } from './service.js';

/**
 * Feature flags (CB-169, CB-182, CB-503): their tables, `/api/flags`
 * (Settings → Optional features, Early access and, in an internal
 * deployment, In development) and, at start, a line for the FEATURE_FLAGS
 * a customer deployment ignores and for each flag past its removal date. The evaluation itself is `LegacyFlags`, which
 * the shell's `/api/workspace`, routes (`requireFlag`) and every socio
 * turn's tools (`DotExtensions.toolsOff`) read.
 *
 * Its hooks read the service as `FlagAdmin` (`contract.ts`), from the app's
 * services at the moment of use, so a test that offers its own
 * `FlagAdmin` before the routes are built gets it.
 */
export const flagsModule: ServerModule = {
    ...flagsSchema,
    // The people and the audit are the workspace's, as flags names them
    // (`FlagsWorkspace`), read from the app's services when the routes are
    // built.
    routes: ({ db, services }) =>
        flagRoutes({ flags: services.get(FlagAdmin), db, workspace: services.get(FlagsWorkspace) }),
    start: ({ services, log }) => {
        const flags = services.get(FlagAdmin);
        // CB-503: a customer deployment never has a `dev` flag on.
        const ignored = flags.ignoredEnv();
        if (ignored.length) {
            log(
                `FEATURE_FLAGS: ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} in development and ignored: this is a customer deployment (set SOCIO_DEPLOYMENT_KIND=internal for an internal one).`,
            );
        }
        for (const flag of flags.overdue()) {
            log(`Feature flag ${flag.key} was due to be removed by ${flag.removeBy} (${flag.owner}).`);
        }
    },
};
