import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
    AndroidConfig,
    type ConfigPlugin,
    WarningAggregator,
    withAndroidManifest,
    withEntitlementsPlist,
    withInfoPlist,
} from 'expo/config-plugins';

// Push notifications' native setup. expo-notifications'
// own plugin sets the Android icon and color and iOS's `aps-environment` (app.config.ts, from
// aps-environment.ts); this one
// adds what it doesn't:
//
// - iOS `keychain-access-groups`: the app's own group first, then the group it will share with the
//   notification service extension. expo-secure-store writes a new item to the first group, so the
//   DB keys and the cookie jars stay where an earlier build put them, in the app's own group (its
//   default, `$(AppIdentifierPrefix)<bundle id>`). Only the push keys go to the shared group, written
//   with an explicit `accessGroup`. Personal Team builds strip both (personal-team.ts).
// - iOS Info.plist keys that tell modules/socio-push where its items go: the shared keychain group's
//   suffix (the module puts the app's own group, read from the keychain, before it) and the app group
//   whose container holds the extension's inbox files. Personal Team builds strip both too, so the
//   push keys stay in the app's own group there.
// - Android: Firebase sends nothing on its own. No token at first launch (auto-init off; the app asks
//   for one after the person allows notifications), no Analytics and no delivery metrics.
// - Android's `google-services.json`, which carries the Firebase project's ids, is read at prebuild
//   from the path in GOOGLE_SERVICES_JSON and never committed. Without it the build has no FCM, and
//   prebuild says so.

/** The suffix of the keychain group the app shares with its notification service extension. */
export const SHARED_KEYCHAIN_SUFFIX = '.shared';

/** The app's keychain groups, its own first: expo-secure-store writes to the first. */
export function keychainGroups(bundleIdentifier: string): string[] {
    const own = `$(AppIdentifierPrefix)${bundleIdentifier}`;
    return [own, `${own}${SHARED_KEYCHAIN_SUFFIX}`];
}

/** The `<meta-data>` that keep Firebase from acting on its own, by name, with their values. */
export const FIREBASE_META_DATA = {
    firebase_messaging_auto_init_enabled: 'false',
    firebase_analytics_collection_deactivated: 'true',
    delivery_metrics_exported_to_big_query_enabled: 'false',
} as const;

/**
 * The absolute path of `google-services.json` that GOOGLE_SERVICES_JSON names, or undefined when it
 * is unset. A path that names no file fails, so a typo doesn't build an app without push.
 */
export function googleServicesFile(env: Record<string, string | undefined>, projectRoot: string): string | undefined {
    const value = env.GOOGLE_SERVICES_JSON?.trim();
    if (!value) {
        return undefined;
    }
    const path = isAbsolute(value) ? value : resolve(projectRoot, value);
    if (!existsSync(path)) {
        throw new Error(`GOOGLE_SERVICES_JSON is "${value}", but there is no file at ${path}.`);
    }
    return path;
}

export const NO_FCM_WARNING =
    'GOOGLE_SERVICES_JSON is unset, so this Android build has no FCM and receives no push. Set it to the path of google-services.json (apps/mobile/README.md).';

/** The app group the app shares with its notification service extension: `group.<bundle id>`. */
export function appGroup(bundleIdentifier: string): string {
    return `group.${bundleIdentifier}`;
}

/** The Info.plist keys modules/socio-push reads (its README, Groups), by name, for a bundle id. */
export function pushInfoPlist(bundleIdentifier: string): Record<(typeof PUSH_INFO_PLIST_KEYS)[number], string> {
    return { SocioPushKeychainGroupSuffix: SHARED_KEYCHAIN_SUFFIX, SocioPushAppGroup: appGroup(bundleIdentifier) };
}

export const PUSH_INFO_PLIST_KEYS = ['SocioPushKeychainGroupSuffix', 'SocioPushAppGroup'] as const;

const withPush: ConfigPlugin = (config) => {
    const withGroups = withInfoPlist(config, (next) => {
        const id = next.ios?.bundleIdentifier;
        if (!id) {
            throw new Error('plugins/push.ts needs ios.bundleIdentifier.');
        }
        Object.assign(next.modResults, pushInfoPlist(id));
        return next;
    });
    const withKeychain = withEntitlementsPlist(withGroups, (next) => {
        const id = next.ios?.bundleIdentifier;
        if (!id) {
            throw new Error('plugins/push.ts needs ios.bundleIdentifier.');
        }
        next.modResults['keychain-access-groups'] = keychainGroups(id);
        return next;
    });
    // In the Android mod, so only a prebuild that makes the Android project warns.
    return withAndroidManifest(withKeychain, (next) => {
        if (!next.android?.googleServicesFile) {
            WarningAggregator.addWarningAndroid('push', NO_FCM_WARNING);
        }
        const application = AndroidConfig.Manifest.getMainApplicationOrThrow(next.modResults);
        for (const [name, value] of Object.entries(FIREBASE_META_DATA)) {
            AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, name, value);
        }
        return next;
    });
};

export default withPush;
