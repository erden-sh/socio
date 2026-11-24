import type { ServerModule } from '../modules/contract.js';

import { SecretsAdmin } from './contract.js';
import { workspaceSecretsSchema } from './migrations.js';
import { workspaceSecretRoutes } from './routes.js';

/**
 * Socio Secrets: the service lives on the platform
 * (`platform.workspaceSecrets`), which the data key's counts and re-seal
 * and the apps' redaction use; the module owns the tables, admins'
 * `/api/workspace-secrets` and workloads' `/api/workload/secrets`, and the
 * tick that retires versions past their overlap window and removes what
 * belonged to removed apps, and runs the read-anomaly rules.
 *
 * Its hooks read the service as `SecretsAdmin` (`contract.ts`), from the
 * app's services at the moment of use.
 */
export const workspaceSecretsModule: ServerModule = {
    ...workspaceSecretsSchema,
    paths: ['workspace-secrets', 'workload'],
    routes: ({ services }) => workspaceSecretRoutes(services.get(SecretsAdmin)),
    start: ({ services }) => services.get(SecretsAdmin).sweep(),
    tick: {
        everyMs: 60_000,
        // The read-anomaly rules, every FLAG_EVALUATE_EVERY_MS.
        run: async ({ services }) => {
            const secrets = services.get(SecretsAdmin);
            await secrets.sweep();
            await secrets.evaluateFlagsIfDue();
        },
    },
};
