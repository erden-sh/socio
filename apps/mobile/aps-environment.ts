import type { VariantName } from './variant.ts';

// The APNs environment, a build constant: the `aps-environment` entitlement (expo-notifications'
// `mode`, app.config.ts) and `extra.apsEnvironment`, which src/platform/push.ts turns into the
// relay registration's `apnsEnv`, so the relay sends to the APNs host the device token is for.
//
// By default it follows the variant: development's builds use the sandbox, the others production.
// SOCIO_APS_ENVIRONMENT at prebuild (`development` or `production`) overrides that: a build signed
// for development (a preview sideloaded with a debugging export) gets sandbox tokens, so it must say
// `development`. Recorded for the native builds that read the config again (plugins/build-env.ts).
// Any other value throws, so a typo fails the build instead of shipping push to the wrong host.

export const APS_ENVIRONMENTS = ['development', 'production'] as const;

export type ApsEnvironment = (typeof APS_ENVIRONMENTS)[number];

const isApsEnvironment = (value: unknown): value is ApsEnvironment =>
    (APS_ENVIRONMENTS as readonly unknown[]).includes(value);

/** A variant's APNs environment when SOCIO_APS_ENVIRONMENT is unset. */
export function defaultApsEnvironment(variant: VariantName): ApsEnvironment {
    return variant === 'development' ? 'development' : 'production';
}

/** The APNs environment SOCIO_APS_ENVIRONMENT gives `variant`: its default when unset. Throws on any other value. */
export function apsEnvironment(value: string | undefined, variant: VariantName): ApsEnvironment {
    if (value === undefined || value === '') {
        return defaultApsEnvironment(variant);
    }
    if (!isApsEnvironment(value)) {
        throw new Error(
            `SOCIO_APS_ENVIRONMENT "${value}" isn't ${APS_ENVIRONMENTS.join(' or ')}: give the signing's APNs environment, or leave it unset for the variant's.`,
        );
    }
    return value;
}

/**
 * The relay registration's `apnsEnv` for the embedded `extra.apsEnvironment`: `sandbox` for
 * development, `production` for production. A missing or unknown value falls back to the variant's.
 */
export function apnsEnvironment(embedded: unknown, variant: VariantName): 'sandbox' | 'production' {
    const environment = isApsEnvironment(embedded) ? embedded : defaultApsEnvironment(variant);
    return environment === 'development' ? 'sandbox' : 'production';
}
