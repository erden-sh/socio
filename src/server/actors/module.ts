import { MODULE_IDS } from '@socio/shared/modules';
import { SOCIO_ACCESS_CAPABILITIES, SOCIO_ACCESS_PENDING } from '@socio/shared/socio-access';

import { Approvals } from '../approvals/contract.js';
import { Flags } from '../flags/contract.js';
import type { ModuleServicesAccess, ServerModule } from '../modules/contract.js';

import { registerSocioAccessApprovals } from './approvals.js';
import { Actors, ActorServices } from './contract.js';
import { actorsSchema } from './infra/sqlite/tables.js';
import { actorRoutes } from './routes.js';
import { ACTOR_TOOL_NAMES, actorTools, type ActorToolServices } from './tools.js';

/**
 * What the routes and tools read: socio access's services (`ActorServices`)
 * and the flags (`Flags`), from the app's services at the moment of use.
 */
const toolServices = (services: ModuleServicesAccess): ActorToolServices => ({
    ...services.get(ActorServices),
    flags: services.get(Flags),
});

/**
 * Socio-actor access (CB-232): its tables, `/api/actors` and the socio
 * tools that ask for and end access (`routes.ts` and `tools.ts`), the
 * approval capabilities those use (`approvals.ts`), and the leader's
 * minute sweep that ends grants that expired, went idle or no longer pass
 * their check (the feature switched off, a conversation now a room, a
 * socio archived). The service is
 * `platform.actors`; every runtime runs its own revocation watch from the
 * server entry, not here (a module's tick runs on the leader only).
 */
export const actorsModule: ServerModule = {
    ...actorsSchema,
    id: MODULE_IDS.actors,
    routes: ({ services }) => actorRoutes(toolServices(services)),
    dotTools: ({ services }, turn) => actorTools(toolServices(services), turn),
    // Called once when the platform is built, on every runtime: the
    // approval capabilities of socio access register here (CB-232),
    // where the approvals and socio access exist already (`built`).
    capabilities: ({ services }, built) => {
        registerSocioAccessApprovals({ actors: built.get(Actors), approvals: built.get(Approvals) });
        return [
            {
                id: 'app_access',
                label: 'Use apps for the person',
                description:
                    'Ask the person you act for to let you use one of their mini apps or plugins for them (request_app_access), for one task, then end it (end_app_access). They decide on a card; write and act always wait for them.',
                tools: ACTOR_TOOL_NAMES,
                approvals: Object.values(SOCIO_ACCESS_CAPABILITIES),
                status: (turn) => {
                    const on = services.get(Flags).enabled('socio-actor-access', turn.userId);
                    // Plugins take part too (CB-232): a bundled one needs no apps host.
                    const { apps, plugins } = services.get(ActorServices);
                    const any = apps.enabled || plugins.list().some((row) => row.enabled);
                    return {
                        enabled: on && any,
                        ...(on
                            ? any
                                ? {}
                                : { note: 'Mini apps are not set up on this server.' }
                            : { note: 'Not available to this person yet.' }),
                        limits: { pendingRequests: SOCIO_ACCESS_PENDING.perSocio },
                    };
                },
            },
        ];
    },
    tick: {
        everyMs: 60_000,
        run: ({ services, log }) =>
            services
                .get(Actors)
                .sweep()
                .catch(() => log('Socio access: the sweep of grants failed.')),
    },
};
