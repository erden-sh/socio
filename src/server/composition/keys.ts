/**
 * The keys the app's services seal with, offered as `PlatformKeys` and made in
 * the order the services were always made.
 */
import { randomBytes } from 'node:crypto';

import { Context, Effect, Layer } from 'effect';

import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import { LegacyConfig } from './base.js';
import type { PlatformConfig } from './config.js';

/** The session secret and the data keyring. */
export function platformKeys(config: PlatformConfig): { secret: string; keys: DataKeyring } {
    // Without SESSION_SECRET (loopback only), one secret for this process.
    const secret = config.sessionSecret || randomBytes(32).toString('base64url');
    // Files and stored credentials (CB-62): DATA_ENCRYPTION_KEY when set,
    // the key from SESSION_SECRET for what was sealed before it.
    const keys: DataKeyring = { ...config.dataKeys, legacy: secret };
    return { secret, keys };
}

/** The session secret and the data keyring the services seal with. */
export class PlatformKeys extends Context.Service<PlatformKeys, { secret: string; keys: DataKeyring }>()(
    'socio/composition/keys/PlatformKeys',
) {}

/** The keys' step of the graph: `platformKeys`, made once. */
export const keysLayers = {
    keys: Layer.effect(
        PlatformKeys,
        Effect.gen(function* () {
            return platformKeys(yield* LegacyConfig);
        }),
    ),
};
