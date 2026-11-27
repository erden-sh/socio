import { type ConfigPlugin, withEntitlementsPlist, withInfoPlist } from 'expo/config-plugins';

import type { VariantName } from '../variant.ts';

// Google and Apple sign-in's native config (CB-570):
//
// - **Google on iOS** needs the build's iOS OAuth client id, to configure Google's SDK
//   (modules/socio-google-signin) and to register its reversed form as a URL scheme. It is never
//   committed: it comes at prebuild from SOCIO_GOOGLE_IOS_CLIENT_ID (production) or
//   SOCIO_GOOGLE_IOS_PREVIEW_CLIENT_ID (preview), goes into `extra.googleIosClientId` and the
//   Info.plist's URL types, and `ios/.xcode.env` keeps it for the config Xcode embeds
//   (plugins/build-env.ts). Development has none, so Google is off on its iOS builds, and an unset
//   variable leaves the iOS button out. Android's Credential Manager needs only the server client
//   id, which the server's start gives.
// - **Sign in with Apple** (`com.apple.developer.applesignin`) is in production and preview only:
//   the development App ID lacks the capability, so its builds must not carry the entitlement.
//   expo-apple-authentication's plugin adds it whenever the package is installed (Expo applies it by
//   itself), so `withoutAppleSignIn`, listed first in app.config.ts, takes it out of development
//   builds after every other plugin. `extra.appleSignIn` says whether the build has it.

/** The variable each variant reads its iOS Google client id from; development reads none. */
export const GOOGLE_IOS_CLIENT_ID_VARIABLES: Readonly<Record<VariantName, string | null>> = {
    production: 'SOCIO_GOOGLE_IOS_CLIENT_ID',
    preview: 'SOCIO_GOOGLE_IOS_PREVIEW_CLIENT_ID',
    development: null,
};

const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
const CLIENT_ID = /^[0-9]{4,32}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/;
/** The reversed client id's scheme prefix, as Google's console shows it. */
export const GOOGLE_SCHEME_PREFIX = 'com.googleusercontent.apps.';

/**
 * The iOS Google client id `variant`'s variable holds, or null when it is unset (or the variant
 * reads none). Throws on a value that isn't one, without saying it.
 */
export function googleIosClientId(env: Record<string, string | undefined>, variant: VariantName): string | null {
    const name = GOOGLE_IOS_CLIENT_ID_VARIABLES[variant];
    const value = name === null ? '' : (env[name]?.trim() ?? '');
    if (name === null || value === '') {
        return null;
    }
    if (!CLIENT_ID.test(value)) {
        throw new Error(`${name} is not an iOS OAuth client id (<number>-<id>${CLIENT_ID_SUFFIX}).`);
    }
    return value;
}

/** The URL scheme Google's SDK needs for `clientId`: its parts reversed. */
export function reversedClientId(clientId: string): string {
    return `${GOOGLE_SCHEME_PREFIX}${clientId.slice(0, -CLIENT_ID_SUFFIX.length)}`;
}

/** Whether a build of `variant` carries Sign in with Apple. A Personal Team build never does. */
export const appleSignIn = (variant: VariantName, personalTeam: boolean) => variant !== 'development' && !personalTeam;

/** The Sign in with Apple entitlement's key. */
export const APPLE_SIGN_IN_ENTITLEMENT = 'com.apple.developer.applesignin';

type UrlType = { CFBundleURLSchemes?: string[] } & Record<string, unknown>;

/** `types` with the reversed client id's scheme alone among Google's, or none of Google's without one. */
export function googleUrlTypes(types: readonly UrlType[], clientId: string | null): UrlType[] {
    const others = types.filter(
        (type) => !(type.CFBundleURLSchemes ?? []).some((scheme) => scheme.startsWith(GOOGLE_SCHEME_PREFIX)),
    );
    return clientId === null ? others : [...others, { CFBundleURLSchemes: [reversedClientId(clientId)] }];
}

/** The iOS Google client id's URL scheme in the Info.plist. */
export const withGoogleSignIn: ConfigPlugin<{ clientId: string | null }> = (config, { clientId }) =>
    withInfoPlist(config, (next) => {
        const types = (next.modResults.CFBundleURLTypes ?? []) as UrlType[];
        next.modResults.CFBundleURLTypes = googleUrlTypes(types, clientId) as typeof next.modResults.CFBundleURLTypes;
        return next;
    });

/** Development drops the entitlement; it must run after expo-apple-authentication's mod. */
export const withoutAppleSignIn: ConfigPlugin = (config) =>
    withEntitlementsPlist(config, (next) => {
        delete next.modResults[APPLE_SIGN_IN_ENTITLEMENT];
        return next;
    });

/**
 * Both, as app.config.ts lists it: first, so its entitlements mod runs after every other plugin's
 * (Expo runs the plugins listed later first, for each mod).
 */
const withSocialSignIn: ConfigPlugin<{ variant: VariantName; clientId: string | null }> = (
    config,
    { variant, clientId },
) => {
    const next = withGoogleSignIn(config, { clientId });
    return variant === 'development' ? withoutAppleSignIn(next) : next;
};

export default withSocialSignIn;
