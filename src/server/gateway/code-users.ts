import { gatewaySourcesOf, type GatewayHolder } from './adopted.js';
import type { GatewaySources } from './sources.js';

/**
 * Whether a person may run code (CB-376): the `code:run` permission of
 * Better Auth's organization plugin (`hasPermission`, auth/better-auth.ts),
 * which admins have and others get from a group admins give it to. Read on
 * every use, so removing someone from a group, or deleting the group,
 * applies at once. Coding sessions and the gateways need it (CB-239).
 */
export function codeAccess(sources: Pick<GatewaySources, 'codeAccess'>, personId: string): Promise<boolean> {
    return sources.codeAccess.mayRunCode(personId);
}

/** `codeAccess` for the gateways of `holder`'s runtime (`adopted.ts`), for tests. */
export function mayRunCode(holder: GatewayHolder, personId: string): Promise<boolean> {
    return codeAccess(gatewaySourcesOf(holder), personId);
}
