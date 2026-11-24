import { VARIANTS, type VariantName } from '../variant.ts';

// The link domain: each variant's
// verified links and the system sign-in sheet's callback, all on one host that app.config.ts picks
// once (`linkHost`) and hands to everything below and to `extra.linkHost`.
//
// - Production and preview use `link.socio.sh`. Development uses SOCIO_LINK_HOST at prebuild
//   (`link-staging.socio.sh` when unset; a quick tunnel on the test bench). Set for another variant,
//   it fails the build, so a release can't ship pointing at a tunnel.
// - Each variant claims only its own path on the host (`/app/`, `/preview/`, `/dev/`). Android: one `autoVerify` intent
//   filter with that `pathPrefix`. iOS: `applinks` (every link kind) and `webcredentials` (the
//   sheet's https callback needs it). `webcredentials` covers the whole host, so what keeps
//   another variant's callback out is the path the sheet names (`sheetCallback`).
// - Development entries carry `?mode=developer`, so the simulator and a developer-mode device fetch
//   the AASA from the host itself rather than Apple's CDN.
// - The custom-scheme callback (`DEV_SCHEME_CALLBACK`) is for development Personal Team builds only,
//   which have no associated domains. A custom scheme isn't verified (another app could register
//   it), so preview and production never get one.

// @socio/shared's device-sign-in table (LINK_HOST, LINK_STAGING_HOST, VARIANT_LINK_PATHS), the
// server's own: Expo loads this file with Node at prebuild, from a copy of the app that may not
// have the workspace's packages, so the values are repeated here and tests/native-config.test.ts
// fails when they differ from shared's. The app's own code reads shared directly.
export const LINK_HOST = 'link.socio.sh';
export const LINK_STAGING_HOST = 'link-staging.socio.sh';
export const VARIANT_LINK_PATHS: Readonly<Record<VariantName, string>> = {
    production: 'app',
    preview: 'preview',
    development: 'dev',
};

/** The custom-scheme sheet callback a development Personal Team build uses instead of the https one. */
export const DEV_SCHEME_CALLBACK = `${VARIANTS.development.scheme}://auth-callback`;

/** A DNS name as SOCIO_LINK_HOST takes it: lower case, at least two labels, no port, scheme or path. */
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The link host of `variant`'s build. Throws on a malformed SOCIO_LINK_HOST, or one set outside development. */
export function linkHost(env: Record<string, string | undefined>, variant: VariantName): string {
    const value = env.SOCIO_LINK_HOST;
    if (value === undefined || value === '') {
        return variant === 'development' ? LINK_STAGING_HOST : LINK_HOST;
    }
    if (variant !== 'development') {
        throw new Error(`SOCIO_LINK_HOST is for development builds only: unset it for ${variant}.`);
    }
    if (!HOST_NAME.test(value)) {
        throw new Error(`SOCIO_LINK_HOST "${value}" is not a host name (lower case, no scheme, port or path).`);
    }
    return value;
}

/** The path prefix `variant` claims on the link host, with both slashes: `/dev/`. */
export const variantLinkPrefix = (variant: VariantName) => `/${VARIANT_LINK_PATHS[variant]}/`;

/** iOS `associatedDomains` for `variant`, or none for a Personal Team build (it can't sign them). */
export function associatedDomains(variant: VariantName, host: string, personalTeam: boolean): string[] {
    if (personalTeam) {
        return [];
    }
    const mode = variant === 'development' ? '?mode=developer' : '';
    return [`webcredentials:${host}${mode}`, `applinks:${host}${mode}`];
}

/** The Android intent filter that opens `variant`'s verified links: its own path prefix on `host` only. */
export function appLinkIntentFilters(variant: VariantName, host: string) {
    return [
        {
            action: 'VIEW',
            autoVerify: true,
            data: [{ scheme: 'https', host, pathPrefix: variantLinkPrefix(variant) }],
            category: ['BROWSABLE', 'DEFAULT'],
        },
    ];
}

/**
 * The callback `variant`'s sign-in sheet waits for: `https://<host>/<variant path>/cb`, the one the
 * server's Continue page sends to. A development Personal Team build gets the custom-scheme
 * one; a preview or production Personal Team build gets none, since it has no associated domains
 * and may not use a custom scheme, so its sheet is unavailable.
 */
export function sheetCallback(variant: VariantName, host: string, personalTeam: boolean): string | null {
    if (personalTeam) {
        return variant === 'development' ? DEV_SCHEME_CALLBACK : null;
    }
    return `https://${host}${variantLinkPrefix(variant)}cb`;
}
