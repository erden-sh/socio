import {
    ENVELOPE_TTL_MS,
    isHostTarget,
    newJti,
    requestTargetHash,
    signEnvelope,
    type HostEnvelopeClaims,
} from '@socio/foundation/apps/envelope';
import { pluginAudience } from '@socio/shared/plugins/plugins';

import { pluginActorKey } from '../../apps-runtime/keys.js';

/**
 * The host envelope (CB-458): `x-cb-actor` for one call from Socio itself to a
 * service plugin, on the reserved `/__cb/` prefix only (backups and restores).
 * Signed with the plugin's actor key, as a person's envelope is, but with `sub`
 * and `acc` `host` and no session, person, socio or token. The apps proxy never
 * calls this: it signs people's and socios' envelopes (`PluginActors.envelope`)
 * and never forwards `/__cb/`. Throws for any other target, so a caller can't
 * sign a host envelope that would open a person's route.
 */
export function signHostEnvelope(
    runtimeToken: string,
    id: string,
    request: { method: string; target: string; now?: number },
) {
    if (!isHostTarget(request.target)) {
        throw new Error('A host envelope is for a /__cb/ request-target only.');
    }
    const now = request.now ?? Date.now();
    const claims: HostEnvelopeClaims = {
        aud: pluginAudience(id),
        sub: 'host',
        acc: 'host',
        req: { m: request.method.toUpperCase(), p: requestTargetHash(request.target) },
        iat: now,
        exp: now + ENVELOPE_TTL_MS,
        jti: newJti(),
    };
    return signEnvelope(Buffer.from(pluginActorKey(runtimeToken, id), 'base64url'), claims);
}
