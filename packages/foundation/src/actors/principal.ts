import { createHmac } from 'node:crypto';

import { canonicalJson } from '@socio/shared/jcs';

import { sha256Hex } from './keys.js';

/**
 * The ids socio-actor access hands to apps (CB-232): stateless,
 * from a secret every runtime holds, so any runtime computes the same.
 * Moved from `src/server/actors/principal.ts`, which re-exports them.
 */

/**
 * Opaque per-app identifiers: two apps can't correlate a person, a
 * socio or a grant by id. `sub` is the value apps already get as
 * `x-cb-user` (`AppsService.personId`), under the same secret and label.
 */
export function opaqueActorIds(
    secret: string,
    appId: string,
    actor: { personId: string; socioId?: string; grantId?: string },
) {
    const id = (label: string, value: string) =>
        createHmac('sha256', secret).update(`${label}\u0000${appId}\u0000${value}`).digest('base64url').slice(0, 22);
    return {
        sub: id('company-brain-app-user', actor.personId),
        ...(actor.socioId ? { socio: id('socio-app-actor', actor.socioId) } : {}),
        ...(actor.grantId ? { grant: id('socio-app-grant', actor.grantId) } : {}),
    };
}

/**
 * The intent digest an action approval is bound to:
 * `SHA-256(JCS({appId, action, params}))`, hex. The SDK computes the same.
 */
export function intentDigest(appId: string, action: string, params: unknown) {
    return sha256Hex(canonicalJson({ appId, action, params }));
}
