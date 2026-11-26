import {
    APP_VARIANTS,
    type AppVariant,
    LINK_HOST,
    LINK_STAGING_HOST,
    VARIANT_LINK_PATHS,
} from '@socio/shared/device-sign-in';

// The app's three builds as the link domain names them: each one's bundle id
// (the iOS bundle identifier and the Android application id, apps/mobile/variant.ts) and the
// signing key Android checks. tests/apps.test.ts fails when the ids drift from the app's.
//
// Placeholders, until the owner fills them (they are public once served, but come from accounts
// this repository never names): the Play app signing key's SHA-256 (Play
// Console, "App signing") and the preview keystore's (the secrets store). A placeholder never
// matches a real app or key, so its variant's links just don't verify; tests/apps.test.ts pins
// each one, so filling one in is a reviewed change to that test too.

/** The Apple team id that signs every variant (the AASA's app ids are `<team>.<bundle id>`). */
export const APPLE_TEAM_ID = '6DDJ59773H';

/** A SHA-256 fingerprint nobody's certificate has: the shape Android expects, never a match. */
export const PLACEHOLDER_SHA256 = Array.from({ length: 32 }, () => '00').join(':');

/**
 * The React Native template's debug keystore (`android/app/debug.keystore`, which every
 * `expo prebuild` writes): public, the same on every machine, and what development builds are
 * signed with. Its alias is `androiddebugkey`, store password `android`.
 */
export const DEBUG_KEYSTORE_SHA256 =
    'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C';

export interface LinkApp {
    variant: AppVariant;
    bundleId: string;
    /** The path this variant claims on the link host, with both slashes: `/app/`. */
    prefix: string;
    /** The SHA-256 fingerprints of the certificates Android may find this variant signed with. */
    androidCertSha256: readonly string[];
    /** The variant's URL scheme (apps/mobile/variant.ts): only ever a bare `<scheme>://`, never a credential. */
    scheme: string;
}

const BUNDLE_IDS: Readonly<Record<AppVariant, string>> = {
    production: 'com.ingenioventures.socio',
    preview: 'com.ingenioventures.socio.preview',
    development: 'com.ingenioventures.socio.dev',
};

const SCHEMES: Readonly<Record<AppVariant, string>> = {
    production: 'socio',
    preview: 'socio-preview',
    development: 'socio-dev',
};

const ANDROID_CERTS: Readonly<Record<AppVariant, readonly string[]>> = {
    // Placeholder: the Play app signing key's SHA-256 (Play re-signs what the store ships).
    production: [PLACEHOLDER_SHA256],
    // Socio Preview's Play app signing keys (Play re-signs what it ships), as Play Console's
    // Deep links page lists them. Never the upload key, never the debug key: sideloaded preview
    // APKs are debug-signed and don't verify on this host, by design.
    preview: [
        'B8:9E:1A:3A:97:22:F9:23:CE:9C:17:B5:BF:8C:FE:2F:72:A9:D7:EA:C0:89:C0:81:95:DB:8A:15:6A:3F:92:83',
        'DD:05:AB:DF:E1:01:21:E2:94:70:CD:84:02:1D:E5:1C:E4:DF:F7:15:43:D2:F4:81:57:C7:ED:F3:FD:47:D5:E8',
        '44:5C:18:03:69:6D:A6:DC:AD:34:62:64:5A:99:78:4E:91:18:DB:15:84:9C:17:5D:CD:A0:FF:C5:5E:50:E3:C4',
    ],
    development: [DEBUG_KEYSTORE_SHA256],
};

export const LINK_APPS: readonly LinkApp[] = APP_VARIANTS.map((variant) => ({
    variant,
    bundleId: BUNDLE_IDS[variant],
    prefix: `/${VARIANT_LINK_PATHS[variant]}/`,
    androidCertSha256: ANDROID_CERTS[variant],
    scheme: SCHEMES[variant],
}));

/**
 * The variants each link host serves, as the app's builds pick their host (apps/mobile
 * plugins/app-links.ts): production and preview use `link.socio.sh`, development
 * `link-staging.socio.sh` (or a bench's tunnel). Keeping development off the production host
 * keeps its public debug key out of the production association: anyone can sign an APK with that
 * key and the development package, and the APK picks its own `pathPrefix`, so on a shared host it
 * could take production links. Each host's AASA, assetlinks.json and pages name
 * only its own variants; any other host gets a 404.
 */
export const HOST_VARIANTS: Readonly<Record<string, readonly AppVariant[]>> = {
    [LINK_HOST]: ['production', 'preview'],
    [LINK_STAGING_HOST]: ['development'],
};

/**
 * The variants `host` (a request's `URL.host`) serves, or null for a host the link domain doesn't
 * answer. `devHost` is the bench's tunnel host (`--var DEV_LINK_HOST:<host>` on `wrangler dev`,
 * never in wrangler.toml), served as development; it can never make a known host development's.
 */
export function variantsForHost(host: string, devHost?: string): readonly AppVariant[] | null {
    const name = host.toLowerCase();
    const known = HOST_VARIANTS[name];
    if (known) {
        return known;
    }
    const bench = devHost?.trim().toLowerCase();
    return bench && name === bench ? ['development'] : null;
}

/** The apps a host serves, in APP_VARIANTS order. */
export const appsFor = (variants: readonly AppVariant[]) => LINK_APPS.filter((app) => variants.includes(app.variant));
