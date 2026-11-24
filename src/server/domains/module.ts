import type { ServerModule } from '../modules/contract.js';

import { Domains } from './contract.js';
import { domainRoutes } from './routes.js';

/**
 * Domains: hostnames provisioned on demand through Nginx Proxy Manager and
 * Cloudflare DNS. The module owns `domain_hosts` and `domain_ops` and the
 * operator routes under `/api/domains`; its UI is the "Domains" card on the
 * Platform page (the operator client module).
 *
 * Its hooks read the service as `Domains` (`contract.ts`), from the app's
 * services at the moment of use; the composition builds it
 * (`composition/domains.ts`, over `layer.ts`).
 *
 * For later: a promoted app that wants a custom domain calls
 * `platform.domains.provision(hostname, { actor: 'app:<id>' })` once its
 * owner and an operator agree (there is no UI or tool for it yet). It
 * refuses hostnames outside DOMAINS_ZONE and those the wildcard covers.
 */
export const domainsModule: Omit<ServerModule, 'id' | 'migrations'> = {
    routes: (ctx) => domainRoutes(ctx.services.get(Domains)),
    // Operations still marked running were a dead process's (CB-108).
    succeed: async (ctx) => {
        const interrupted = await ctx.services.get(Domains).recover();
        if (interrupted) {
            ctx.log(`Domains: ${interrupted} operation(s) interrupted by the restart.`);
        }
    },
};
