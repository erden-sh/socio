import { isVariantName, VARIANTS, type VariantName } from '../../variant';

// Which links the app opens. Each
// variant opens only by its own scheme, as only it registers that scheme with
// the OS: socio-dev://, socio-preview:// or socio://. The path after the
// scheme is the web's path, which the route table (routes.ts) maps to a
// screen. No React Native here, so the Node tests run it as the app does.

/** The slice of the embedded Expo config (expo-constants' `expoConfig`) the variant is read from. */
export interface EmbeddedConfig {
    readonly extra?: { readonly [key: string]: unknown } | null;
    readonly scheme?: string | readonly string[];
}

/**
 * The variant this build is, from its embedded config: `extra.variant` (set
 * from APP_VARIANT at build time). A value that names no variant means
 * production, the strictest, as the address rules treat an unknown variant.
 * Until every build sets `extra.variant`, a config without one falls back to
 * the variant whose scheme it registers, else production; that fallback can
 * go once they all do.
 */
export function variantFromConfig(config: EmbeddedConfig | null | undefined): VariantName {
    const named = config?.extra?.variant;
    if (named !== undefined) {
        return typeof named === 'string' && isVariantName(named) ? named : 'production';
    }
    const schemes = typeof config?.scheme === 'string' ? [config.scheme] : (config?.scheme ?? []);
    const byScheme = (Object.keys(VARIANTS) as VariantName[]).find((name) => schemes.includes(VARIANTS[name].scheme));
    return byScheme ?? 'production';
}

/** The prefix React Navigation strips from this variant's links. */
export const linkPrefix = (variant: VariantName) => `${VARIANTS[variant].scheme}://`;

/**
 * The app path a URL opens (`/chats/abc`, with its query), or null when it
 * opens nothing:
 * - another scheme, another variant's included;
 * - the bare scheme (`socio://`), which opens the app as it is;
 * - the development client's launcher URL (`<scheme>://expo-development-client/?url=…`),
 *   which addresses the launcher, not a screen (as T3 Code's appLinking.ts filters it);
 * - the sign-in sheet's custom-scheme callback (`<scheme>://auth-callback#…`, development
 *   Personal Team builds; src/net/auth-sheet.ts), which the sheet takes, not a screen.
 *
 * The fragment is dropped (`withoutFragment`).
 */
export function pathFromUrl(url: string, variant: VariantName): string | null {
    const scheme = `${VARIANTS[variant].scheme}:`;
    if (url.slice(0, scheme.length).toLowerCase() !== scheme) {
        return null;
    }
    const rest = withoutFragment(url.slice(scheme.length));
    const cut = rest.indexOf('?');
    const route = (cut === -1 ? rest : rest.slice(0, cut)).replace(/\/+/g, '/').replace(/^\//, '');
    const first = route.split('/')[0];
    if (route === '' || first === 'expo-development-client' || first === 'auth-callback') {
        return null;
    }
    return `/${route}${cut === -1 ? '' : rest.slice(cut)}`;
}

/**
 * A path or URL without its fragment. React Navigation strips only the query,
 * so it would fold `#message-9` into the last param (`/chats/abc#message-9`
 * gives the chat `abc#message-9`), and the server's links carry such anchors.
 * A screen that wants the anchor (scroll to a message) gets it as a param of
 * its own when it lands.
 */
export function withoutFragment(path: string): string {
    const hash = path.indexOf('#');
    return hash === -1 ? path : path.slice(0, hash);
}
