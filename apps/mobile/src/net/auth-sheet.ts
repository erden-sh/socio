import { parseAppLink, VARIANT_LINK_PATHS } from '@socio/shared/device-sign-in';

import { isVariantName, VARIANTS, type VariantName } from '../../variant';

// The system sign-in sheet: which callback
// this build's sheet waits for, and what each platform's answer means. No React Native here, so
// `tests/net/auth-sheet.test.ts` runs it under Node; `src/platform/auth-sheet.ts` binds the sheet.
//
// - The callback comes from the build's embedded config only (`extra.authCallback`, made from
//   `extra.linkHost` and the variant in app.config.ts, plugins/app-links.ts), never from a server
//   or a link. It is checked again here, failing closed: an https callback must be exactly
//   `https://<linkHost>/<variant path>/cb`, with the path from @socio/shared's VARIANT_LINK_PATHS
//   (the server's own table), and the custom scheme is taken only by a development build.
// - A callback URL is taken only when it is this variant's: @socio/shared's `parseAppLink` must read
//   it as a `cb` link of this variant on the link host, so another variant's callback, a query or a
//   missing field is refused. The URL, which holds the code in its fragment, is never put in a
//   result's `detail`, a log or a problem.
// - A config failure is told apart from the person cancelling: iOS refuses at once a build without
//   `webcredentials` for the link host (or before the AASA is fetched), and expo-web-browser hands
//   that back as `cancel` with an error string. That is `failed` with reason `config`, never
//   `cancelled`. The person's own cancel comes as `cancel` with an error string too, the
//   `canceledLogin` error's (ASWebAuthenticationSessionError code 1), which expo-web-browser passes
//   only as its localized description: "The operation couldn’t be completed.
//   (com.apple.AuthenticationServices.WebAuthenticationSession error 1.)" on the iOS 27.2 simulator.
//   The parenthesis names the domain and code whatever the language, so that is `cancelled`.

/** The custom-scheme callback a development Personal Team build uses (plugins/app-links.ts). */
export const DEV_SCHEME_CALLBACK = `${VARIANTS.development.scheme}://auth-callback`;

/** The slice of the embedded Expo config (expo-constants' `expoConfig`) the sheet reads. */
export interface SheetConfigSource {
    readonly extra?: { readonly [key: string]: unknown } | null;
}

/** The callback this build's sheet waits for. */
export type SheetCallback =
    | { readonly kind: 'https'; readonly url: string; readonly host: string; readonly path: string }
    | { readonly kind: 'scheme'; readonly url: string };

export interface SheetConfig {
    readonly variant: VariantName;
    readonly linkHost: string;
    readonly callback: SheetCallback;
}

/**
 * The sheet's config from the build's embedded config, or null when this build has no sheet (a
 * preview or production Personal Team build) or the config doesn't hold together. A variant that
 * isn't one is production's, as `variantFromConfig` reads it.
 */
export function sheetConfig(config: SheetConfigSource | null | undefined): SheetConfig | null {
    const extra = config?.extra ?? {};
    const named = extra.variant;
    const variant: VariantName = typeof named === 'string' && isVariantName(named) ? named : 'production';
    const linkHost = extra.linkHost;
    const callback = extra.authCallback;
    if (typeof linkHost !== 'string' || linkHost === '' || typeof callback !== 'string') {
        return null;
    }
    if (callback === DEV_SCHEME_CALLBACK) {
        return variant === 'development' ? { variant, linkHost, callback: { kind: 'scheme', url: callback } } : null;
    }
    const path = callbackPath(variant);
    if (callback !== `https://${linkHost}${path}`) {
        return null;
    }
    return { variant, linkHost, callback: { kind: 'https', url: callback, host: linkHost, path } };
}

/** The path of `variant`'s https callback on the link host: `/dev/cb`. */
export const callbackPath = (variant: VariantName) => `/${VARIANT_LINK_PATHS[variant]}/cb`;

/** Whether `url` is the callback this build's sheet waits for, and only this variant's. */
export function isSheetCallback(url: string, config: SheetConfig): boolean {
    const { callback } = config;
    if (callback.kind === 'scheme') {
        return url === callback.url || url.startsWith(`${callback.url}#`);
    }
    const link = parseAppLink(url, callback.host);
    return link !== null && link.kind === 'cb' && link.variant === config.variant;
}

/** What opening the sheet ended in. */
export type SheetResult =
    /** The sheet came back to this variant's callback; `url` holds the code in its fragment. */
    | { readonly type: 'callback'; readonly url: string }
    /** The person closed the sheet. */
    | { readonly type: 'cancelled' }
    /** This build has no sheet (a preview or production Personal Team build). */
    | { readonly type: 'unavailable'; readonly reason: 'no-sheet' }
    /**
     * The sheet couldn't start or come back: `config` (iOS refused the https callback: no
     * `webcredentials`, or the AASA not fetched yet), `verification` (Android's Auth Tab couldn't
     * verify the app against the link host), `wrong-callback` (a URL that isn't this variant's
     * callback), `error` (anything else). `detail` is the platform's words, never the URL.
     */
    | {
          readonly type: 'failed';
          readonly reason: 'config' | 'verification' | 'wrong-callback' | 'error';
          readonly detail?: string;
      };

/** The `canceledLogin` error's description, as NSError words it: its domain and code (above). */
const CANCELED_LOGIN = /\(com\.apple\.AuthenticationServices\.WebAuthenticationSession error 1\.\)/;

/** expo-web-browser's `openAuthSessionAsync` answer, as both platforms give it (iOS adds `error`). */
export interface BrowserSessionAnswer {
    readonly type: string;
    readonly url?: string | null;
    readonly error?: string | null;
}

const callbackResult = (url: string | null | undefined, config: SheetConfig): SheetResult =>
    typeof url === 'string' && isSheetCallback(url, config)
        ? { type: 'callback', url }
        : { type: 'failed', reason: 'wrong-callback' };

/** What expo-web-browser's answer means. */
export function classifyBrowserSession(answer: BrowserSessionAnswer, config: SheetConfig): SheetResult {
    if (answer.type === 'success') {
        return callbackResult(answer.url, config);
    }
    if (answer.type === 'cancel' || answer.type === 'dismiss') {
        const error = typeof answer.error === 'string' ? answer.error.trim() : '';
        return error === '' || CANCELED_LOGIN.test(error)
            ? { type: 'cancelled' }
            : { type: 'failed', reason: 'config', detail: error };
    }
    return { type: 'failed', reason: 'error', detail: `The sheet answered ${answer.type}.` };
}

/** socio-device's `openAuthTab` answer (modules/socio-device's AuthTabResult). */
export type AuthTabAnswer =
    | { readonly type: 'success'; readonly url: string | null }
    | { readonly type: 'cancel'; readonly reason?: string }
    | { readonly type: 'verification-failed' | 'verification-timed-out' }
    | { readonly type: 'unavailable'; readonly reason: string }
    | { readonly type: 'unknown'; readonly code: number };

/** What the Auth Tab's answer means, or `fallback` when there is no Auth Tab and the Custom Tab should open. */
export function classifyAuthTab(answer: AuthTabAnswer, config: SheetConfig): SheetResult | 'fallback' {
    switch (answer.type) {
        case 'unavailable':
            return 'fallback';
        case 'success':
            return callbackResult(answer.url, config);
        case 'cancel':
            return { type: 'cancelled' };
        case 'verification-failed':
        case 'verification-timed-out':
            return { type: 'failed', reason: 'verification', detail: answer.type };
        case 'unknown':
            return { type: 'failed', reason: 'error', detail: `The Auth Tab answered ${answer.code}.` };
    }
}

/** What the platform hands the sheet. */
export interface SheetPlatform {
    readonly os: 'ios' | 'android';
    /** expo-web-browser's `openAuthSessionAsync`: iOS's ASWebAuthenticationSession, Android's Custom Tab. */
    readonly openAuthSession: (
        url: string,
        callback: string,
        options: { readonly preferUniversalLinks: boolean; readonly preferEphemeralSession: boolean },
    ) => Promise<BrowserSessionAnswer>;
    /** socio-device's `openAuthTab` (Android). */
    readonly openAuthTab: (url: string, host: string, path: string) => Promise<AuthTabAnswer>;
}

const thrown = (error: unknown): SheetResult => ({
    type: 'failed',
    reason: 'error',
    detail: error instanceof Error ? error.message : String(error),
});

/**
 * Opens `url` (the workspace's device start page) in the system sign-in sheet and waits for this
 * build's callback. Not ephemeral, so the browser's passkeys and SSO sessions are there.
 * - iOS: expo-web-browser with `preferUniversalLinks`, which uses `.https(host:path:)` on 17.4 and
 *   later, the app's minimum.
 * - Android: the Auth Tab where the default browser has one, else expo-web-browser's Custom Tab,
 *   whose callback comes back as this variant's verified App Link.
 * - A scheme callback (development Personal Team builds) goes through expo-web-browser on both.
 * Never throws: a sheet that fails to start is `failed`.
 */
export async function openSheet(
    url: string,
    config: SheetConfig | null,
    platform: SheetPlatform,
): Promise<SheetResult> {
    if (config === null) {
        return { type: 'unavailable', reason: 'no-sheet' };
    }
    const { callback } = config;
    const session = async () =>
        classifyBrowserSession(
            await platform.openAuthSession(url, callback.url, {
                preferUniversalLinks: callback.kind === 'https',
                preferEphemeralSession: false,
            }),
            config,
        );
    try {
        if (platform.os === 'android' && callback.kind === 'https') {
            const tab = classifyAuthTab(await platform.openAuthTab(url, callback.host, callback.path), config);
            if (tab !== 'fallback') {
                return tab;
            }
        }
        return await session();
    } catch (error) {
        return thrown(error);
    }
}
