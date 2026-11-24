import { MODULE_IDS } from '@socio/shared/modules';

import { ActorActions, Actors } from '../actors/contract.js';
import type { ServerModule } from '../modules/contract.js';
import { Audit } from '../workspace/contract.js';

import { PluginsInApps } from './contract.js';
import { pluginsSchema } from './migrations.js';
import { pluginRoutes } from './routes.js';
import { PluginServiceTag } from './tags.js';

/**
 * Plugins: an admin installs one on this instance, and only then does it
 * run. Managing them is admin-only (the routes guard it per path); using
 * one is for the people its install's audience names (CB-254), whose
 * socios get its tools: through a grant for `plugin:<id>` while
 * `socio-actor-access` is on for the person (CB-232).
 *
 * Its hooks read the service (`PluginServiceTag`, `tags.ts`) and socio
 * access's `ActorActions` from the app's services at the moment of use;
 * its `capabilities` wires socio access and the apps from the services
 * built before it.
 */
export const pluginsModule: ServerModule = {
    ...pluginsSchema,
    id: MODULE_IDS.plugins,
    routes: (ctx) =>
        pluginRoutes(ctx.services.get(PluginServiceTag), ctx.services.get(ActorActions), ctx.services.get(Audit)),
    dotTools: ({ services }, turn) => services.get(PluginServiceTag).dotTools(turn),
    // Once per platform, on every runtime (CB-232): the `plugin` audience
    // policy, so socios' grants for plugins are checked like apps', and the
    // internal apps listener can serve a socio's session on a plugin.
    // An enabled plugin service still on the shared token gets its own
    // identity, without an operator step; retried every ten minutes while
    // the runtime refuses. Not awaited at start.
    // Then each service gets what is stored (CB-370, CB-398 follow-up):
    // settings saved but not yet applied when a process stopped apply now.
    start: ({ services }) => {
        const plugins = services.get(PluginServiceTag);
        void plugins
            .migrateIdentities()
            .catch(() => undefined)
            .then(() => plugins.reconcileAll())
            .catch(() => undefined);
    },
    // Every minute: plugin networks re-attached to the infra services, which
    // a stack update (an upgrade) detaches. Every ten minutes the full
    // check, which re-attaches them too.
    tick: {
        everyMs: 60_000,
        run: async ({ services }) => {
            const plugins = services.get(PluginServiceTag);
            if (!plugins.reconcileDue()) {
                await plugins.repairNetworks();
                return;
            }
            await plugins.migrateIdentities();
            // CB-370: a service a race or a crash left off its installed revision.
            await plugins.reconcileAll();
        },
    },
    capabilities: (_ctx, built) => {
        built.get(PluginServiceTag).useActors(built.get(Actors));
        built.get(PluginsInApps).usePlugins();
        return [];
    },
};
