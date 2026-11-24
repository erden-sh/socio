import { FLAGS, FLAG_KEY, type FlagDefinition } from '@socio/shared/flags';

import type { DeploymentKind, FlagEnvDefaults } from './contract.js';

const VALUES: Record<string, boolean> = {
    on: true,
    true: true,
    '1': true,
    off: false,
    false: false,
    '0': false,
};

/**
 * `SOCIO_DEPLOYMENT_KIND` (CB-503): `internal` marks a deployment for the
 * team that builds Socio, where flags in development may be listed and
 * switched on. Anything else, or unset, is a customer deployment: there a
 * `dev` flag is never listed nor on, whatever any layer says.
 */
export const deploymentKindFromEnv = (env: Record<string, string | undefined>): DeploymentKind =>
    env.SOCIO_DEPLOYMENT_KIND?.trim().toLowerCase() === 'internal' ? 'internal' : 'customer';

/**
 * Reads `FEATURE_FLAGS=web-reads=off,other=on` (also true/false, 1/0).
 * A malformed entry stops startup; a key this build doesn't know (an
 * older or newer flag) is reported and left out.
 */
export function flagDefaultsFromEnv(
    env: Record<string, string | undefined>,
    warn: (line: string) => void = () => {},
    registry: readonly FlagDefinition[] = FLAGS,
): FlagEnvDefaults {
    const defaults: FlagEnvDefaults = {};
    const text = env.FEATURE_FLAGS?.trim();
    if (!text) {
        return defaults;
    }
    for (const entry of text.split(',')) {
        const item = entry.trim();
        if (!item) {
            continue;
        }
        const [key, value, ...rest] = item.split('=').map((part) => part.trim());
        const parsed = value === undefined ? undefined : VALUES[value.toLowerCase()];
        if (!key || !FLAG_KEY.test(key) || parsed === undefined || rest.length) {
            throw new Error('FEATURE_FLAGS must be a comma-separated list of flag=on or flag=off, e.g. web-reads=off.');
        }
        if (!registry.some((flag) => flag.key === key)) {
            warn(`FEATURE_FLAGS: no flag "${key}" in this version; ignored.`);
            continue;
        }
        defaults[key] = parsed;
    }
    return defaults;
}
