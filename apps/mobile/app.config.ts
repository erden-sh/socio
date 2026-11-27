import type { ConfigContext, ExpoConfig } from 'expo/config';

import { apsEnvironment } from './aps-environment.ts';
import { buildStamp } from './build-stamp.ts';
import packageJson from './package.json';
import { appLinkIntentFilters, associatedDomains, linkHost, sheetCallback } from './plugins/app-links.ts';
import { iosPersonalTeam } from './plugins/personal-team.ts';
import { googleServicesFile } from './plugins/push.ts';
import { relayOrigin } from './relay-origin.ts';
import theme from './src/theme/generated/theme.json';
import { appVariant } from './variant.ts';

// The icons are the web app's own (public/icons), placeholders until the
// design pass gives the app its own, one per variant. iOS gets an opaque,
// full-bleed 1024 px one, framed as the web's Apple touch icon
// (scripts/locals/app-icon.mjs renders both): App Store Connect refuses an
// App Store icon that is smaller or has an alpha channel. On Android's circle masks the
// adaptive foreground loses the tips of the artwork, which reaches 80% of the
// image's width where only about 61% is sure to show: accepted until then.
const CREAM = '#F5EBD6';

// The native parts drawn before or outside React, in the web's tokens
// (src/theme/generated/theme.json, generated from packages/client/src/globals.css),
// light and dark, so none flashes the other scheme:
// - Android's alert dialogs (T3 Code's modern alert dialog plugin): card,
//   foreground, muted-foreground and primary.
const light = theme.light.colors;
const dark = theme.dark.colors;
const ALERT_DIALOG_COLORS = {
    light: {
        background: light.card,
        text: light.foreground,
        secondaryText: light['muted-foreground'],
        buttonText: light.primary,
    },
    night: {
        background: dark.card,
        text: dark.foreground,
        secondaryText: dark['muted-foreground'],
        buttonText: dark.primary,
    },
};
// - The splash, on the screen color of the scheme the phone is in, so it hands
//   over to the first screen without a change of color.
const SPLASH = {
    image: './assets/icon-512.png',
    imageWidth: 200,
    backgroundColor: light.screen,
    dark: { image: './assets/icon-512.png', backgroundColor: dark.screen },
};
// - The root view's background (expo-system-ui), behind every screen: one
//   color in the native config, light's; src/theme/system-bars.tsx sets the
//   scheme's as soon as the app runs, and again when the scheme changes.
const ROOT_BACKGROUND = light.screen;

// The vendor's directory, relay and link domains, which Android trusts with
// system CAs only in every variant (plugins/network-security.ts). None yet.
const VENDOR_DOMAINS: string[] = [];

const T3 = './vendor/t3code/plugins';

// The camera's purpose string, the only one the app asks for: the add-workspace QR scanner
// (expo-camera, CB-566) and the pickers' camera (expo-image-picker) share iOS's one
// NSCameraUsageDescription, so it names both. expo-document-picker needs none, and
// `ios.usesIcloudStorage` stays unset, so it adds no iCloud entitlement.
export const CAMERA_PURPOSE =
    'Socio uses the camera to scan the QR code from Socio on a computer, and when you take a photo to attach.';

// Permissions the app never holds, blocked even when a library's manifest asks
// (expo-image-picker's asks for storage up to Android 12).
export const BLOCKED_PERMISSIONS = [
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
    // expo-notifications asks for it to restore scheduled notifications after a reboot; the app
    // schedules none.
    'android.permission.RECEIVE_BOOT_COMPLETED',
];

// The Android notification icon: the mascot's silhouette, white on clear (Android tints it), a
// placeholder until the design pass. Its tint is the web's primary.
export const NOTIFICATION_ICON = './assets/notification-icon.png';
export const NOTIFICATION_COLOR = light.primary;

// The iOS privacy manifest (PrivacyInfo.xcprivacy), which App Store Connect checks on upload. Prebuild
// merges it into the template's, and `pod install` adds the manifests the pods ship (React Native's
// privacy aggregation), so the app's file declares at least this. The required-reason APIs are those
// the app's native code and its native modules call (found by grepping their iOS sources), with
// Apple's reason codes, as React Native's and Expo's modules declare them:
// - UserDefaults, CA92.1 (the app's own defaults): React Native's settings, I18n and dev settings;
//   expo-constants' installation id; expo-system-ui; expo-notifications' registration; the dev client.
// - File timestamps, C617.1 (files in the app's container): React Native's loaders; expo-application's
//   install date; socio-push's inbox files; enriched-markdown's icon cache; SQLite's fstat. 0A2A.1 (a
//   third-party SDK's wrapper) and 3B52.1 (files the person picked): expo-file-system, and
//   expo-document-picker's modified date.
// - System boot time, 35F9.1 (time between events in the app): React Native's timing (mach_absolute_time).
// - Disk space, E174.1 (checking there is room before writing) and 85F4.1 (showing it): expo-file-system's
//   free and total space; SQLite's statfs.
// No tracking and no tracking domains.
//
// Collected data types: Apple counts data the app sends off the phone that the developer or its
// partners keep longer than it takes to answer the request. The TestFlight testers sign in to
// workspace servers Ingenio runs, so what the app sends there counts, and it is linked to the
// person's account; decided conservatively, every variant declares it. None of it is for tracking,
// and all of it is for App Functionality:
// - Email address: the sign-in's `{email, password}` (src/net/sign-in.ts, `SIGN_IN_PATH`).
// - Name: a mention sends the mentioned person's label, their name, with their id
//   (src/sync/room-send.ts, `mentions`).
// - User ID: mentions send `{userId, label}` (src/sync/room-send.ts) and issue edits an `assigneeId`
//   (src/sync/issue-edit.ts); every request carries the session that names the account.
// - Emails or text messages: room and chat messages, which are instant messages
//   (src/sync/room-send.ts, src/sync/chat-send.ts).
// - Photos: camera and library photos, images only and without EXIF (src/platform/pickers.ts), go up
//   as chat and issue attachments (src/sync/attachments.ts, src/sync/issue-attachments.ts) and page
//   covers and images in the person's Files (src/sync/upload-file.ts, `UPLOAD_PATH`).
// - Customer support: issues filed and commented on the workspace's Improvements board, the testers'
//   way to report problems (src/sync/issue-create.ts, src/sync/issue-comments.ts).
// - Other user content: page edits and reviews (src/sync/page-save.ts, src/sync/page-review.ts),
//   issues and comments (src/sync/issue-create.ts, src/sync/issue-edit.ts, src/sync/issue-comments.ts),
//   memories, schedules, and documents picked as attachments (expo-document-picker).
// - Search history: Search's queries go in the URL (`/api/spaces/search?q=`, `/api/issues/search?q=`,
//   src/sync/server-search.ts); the server keeps none, but a proxy's access log may, so declared.
// - Product interaction: every request reports the tab and the screen in view (src/sync/presence.ts),
//   and the server records the person's presence with each notification it sends.
// Not declared, since the app never sends them: contacts, location, audio, health, financial info,
// browsing history, purchases, advertising data, and diagnostics (no analytics or crash SDK).
// With a push relay (SOCIO_RELAY_ORIGIN), a device ID too: push registration sends the native APNs
// token to our relay (src/push/relay-client.ts), which keeps it in D1 for up to 60 days without a
// refresh (apps/push-relay/src/registrations.ts). Linked, though the relay itself knows no account
// (only a random registration id and secret per workspace) and the review suggested not linked: the
// workspace server keeps the relay endpoint, which carries that registration id, with the person's
// user id (src/server/notifications/migrations.ts, `notification_push_subscriptions`), and for these
// builds Ingenio runs both, so it can join the token to the account. Without a relay nothing is sent
// and it is left out (`privacyManifest`).
const LINKED_FOR_APP_FUNCTIONALITY = {
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
};
export const ACCOUNT_DATA_TYPES = [
    'NSPrivacyCollectedDataTypeEmailAddress',
    'NSPrivacyCollectedDataTypeName',
    'NSPrivacyCollectedDataTypeUserID',
    'NSPrivacyCollectedDataTypeEmailsOrTextMessages',
    'NSPrivacyCollectedDataTypePhotosorVideos',
    'NSPrivacyCollectedDataTypeCustomerSupport',
    'NSPrivacyCollectedDataTypeOtherUserContent',
    'NSPrivacyCollectedDataTypeSearchHistory',
    'NSPrivacyCollectedDataTypeProductInteraction',
].map((type) => ({ NSPrivacyCollectedDataType: type, ...LINKED_FOR_APP_FUNCTIONALITY }));
export const PUSH_TOKEN_DATA_TYPE = {
    NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
    ...LINKED_FOR_APP_FUNCTIONALITY,
};
export const ACCESSED_API_TYPES = [
    {
        NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
        NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
    },
    {
        NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
        NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'],
    },
    {
        NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
        NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
    },
    {
        NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
        NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'],
    },
];

/** The privacy manifest of a build: with a push relay (`relay`, its origin), it declares the device token too. */
export function privacyManifest(relay: string | null) {
    return {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyCollectedDataTypes:
            relay === null ? ACCOUNT_DATA_TYPES : [...ACCOUNT_DATA_TYPES, PUSH_TOKEN_DATA_TYPE],
        NSPrivacyAccessedAPITypes: ACCESSED_API_TYPES,
    };
}

// The App Store icon (above): 1024 px and opaque.
export const IOS_ICON = './assets/icon-ios-1024.png';

export default ({ config }: ConfigContext): ExpoConfig => {
    const { variant, name, id, scheme } = appVariant(process.env.APP_VARIANT);
    const personalTeam = iosPersonalTeam(process.env);
    // SOCIO_BUILD_NUMBER, SOCIO_BUILD_COMMIT and SOCIO_BUILD_DATE (build-stamp.ts): a bad value throws here.
    const stamp = buildStamp(process.env);
    // SOCIO_RELAY_ORIGIN (relay-origin.ts): the push relay this build registers with; unset, none.
    const relay = relayOrigin(process.env.SOCIO_RELAY_ORIGIN, variant);
    // SOCIO_APS_ENVIRONMENT (aps-environment.ts): the APNs environment of the build's signing; unset,
    // the variant's. The entitlement and extra.apsEnvironment both take it.
    const aps = apsEnvironment(process.env.SOCIO_APS_ENVIRONMENT, variant);
    // Read at prebuild from GOOGLE_SERVICES_JSON, never committed; unset builds without FCM (plugins/push.ts).
    const googleServices = googleServicesFile(process.env, __dirname);
    // The link domain, picked once here (SOCIO_LINK_HOST for development; plugins/app-links.ts): the
    // associated domains, the App Link intent filter, the sheet's callback and extra.linkHost all
    // take it from this one value.
    const links = linkHost(process.env, variant);
    const callback = sheetCallback(variant, links, personalTeam !== undefined);
    const domains = associatedDomains(variant, links, personalTeam !== undefined);
    return {
        ...config,
        name,
        slug: 'socio',
        // The marketing version, iOS's CFBundleShortVersionString and Android's versionName: the one
        // in package.json, the only place it's set. A patch per TestFlight build, a minor per
        // milestone (AGENTS.md, Versions); the build number is the stamp's.
        version: packageJson.version,
        scheme,
        // No web build: the web app is Socio itself.
        platforms: ['ios', 'android'],
        orientation: 'portrait',
        userInterfaceStyle: 'automatic',
        backgroundColor: ROOT_BACKGROUND,
        icon: './assets/icon-512.png',
        ios: {
            bundleIdentifier: personalTeam?.bundleIdentifier ?? id,
            // CFBundleVersion: rises with main, so iOS installs a later build over this one.
            buildNumber: String(stamp.buildNumber),
            icon: IOS_ICON,
            infoPlist: {
                // Export compliance (the owner's 2026-11-10 decision): the app uses only standard,
                // exempt encryption, HTTPS through the system and SQLCipher's AES through Apple's
                // CommonCrypto for the device store, so App Store Connect asks nothing per build.
                ITSAppUsesNonExemptEncryption: false,
            },
            privacyManifests: privacyManifest(relay),
            ...(domains.length > 0 ? { associatedDomains: domains } : {}),
        },
        android: {
            package: id,
            versionCode: stamp.buildNumber,
            adaptiveIcon: {
                foregroundImage: './assets/icon-maskable-512.png',
                backgroundColor: CREAM,
            },
            // Back gestures reach JavaScript through React Native's own callback on
            // Android 16 and T3 Code's compat callback on 13 to 15 (below).
            predictiveBackGestureEnabled: true,
            // Photos come through the system photo picker, which needs no access to the
            // library, and the app records no audio:
            // these are removed from the merged manifest, whichever library asks for them.
            blockedPermissions: BLOCKED_PERMISSIONS,
            ...(googleServices ? { googleServicesFile: googleServices } : {}),
            intentFilters: appLinkIntentFilters(variant, links),
        },
        plugins: [
            // First on purpose: for each mod, Expo runs the plugins listed later before the ones
            // listed earlier, so the strip runs after every other plugin here has added its
            // entitlements (push, Sign in with Apple, app groups). Keep it first.
            ...(personalTeam ? [`${T3}/withoutIosPersonalTeamCapabilities.cjs`, './plugins/personal-team.ts'] : []),
            // The dev client would also register exp+<slug>, the same `exp+socio` in
            // every variant, and prefer it for its links: off, so each variant opens
            // by its own scheme.
            ['expo-dev-client', { addGeneratedScheme: false }],
            // iOS 17.4 is the first with the https sign-in callback sign-in needs.
            ['expo-build-properties', { ios: { deploymentTarget: '17.4' } }],
            ['expo-splash-screen', SPLASH],
            // SQLCipher and FTS5 for the device store.
            // package.json builds expo-sqlite from source, since a prebuilt one has no
            // cipher; `updates.useThirdPartySQLitePod` must never be set, as it links a
            // plain sqlite3.
            ['expo-sqlite', { useSQLCipher: true, enableFTS: true }],
            // Its own Android backup rules are off: plugins/backup-rules.ts covers its prefs.
            ['expo-secure-store', { configureAndroidBackup: false }],
            // Applies userInterfaceStyle on Android, and the root background on both.
            'expo-system-ui',
            // The camera only: the system photo picker asks for no library access, and
            // nothing records audio. `false` leaves the purpose string out on iOS and
            // blocks RECORD_AUDIO on Android.
            [
                'expo-image-picker',
                { cameraPermission: CAMERA_PURPOSE, photosPermission: false, microphonePermission: false },
            ],
            // The add-workspace QR scanner (CB-566): the same camera purpose string, no microphone
            // (no purpose string on iOS, RECORD_AUDIO not asked on Android, and blocked anyway), and
            // its barcode scanner off: on Android it is ML Kit, and the app holds nothing of Google's
            // (the owner, 2026-11-26), so modules/socio-scanner reads QR codes there; iOS reads them
            // through AVFoundation, which this setting doesn't touch. Its Android document scanner and
            // ML Kit's manifest entry go too (plugins/camera.ts).
            [
                'expo-camera',
                {
                    cameraPermission: CAMERA_PURPOSE,
                    microphonePermission: false,
                    recordAudioAndroid: false,
                    barcodeScannerEnabled: false,
                },
            ],
            './plugins/camera.ts',
            // Push: the Android icon and tint, and iOS's APNs environment (`aps`). No
            // background remote notifications: a push starts no sync in v1.
            [
                'expo-notifications',
                {
                    icon: NOTIFICATION_ICON,
                    color: NOTIFICATION_COLOR,
                    mode: aps,
                    enableBackgroundRemoteNotifications: false,
                },
            ],
            // The keychain groups, Firebase's switches and the FCM warning (plugins/push.ts).
            './plugins/push.ts',
            ['./plugins/network-security.ts', { variant, vendorDomains: VENDOR_DOMAINS }],
            './plugins/backup-rules.ts',
            ['./plugins/transport-security.ts', { variant }],
            [
                './plugins/build-env.ts',
                { variant, personalTeam, stamp, relayOrigin: relay, linkHost: links, apsEnvironment: aps },
            ],
            // The native tab bar's lucide icons on Android, as vector drawables.
            './plugins/tab-icons.ts',
            // The native menus' library builds on the root's Gradle plugins, offline (CB-421).
            './plugins/menu-gradle.ts',
            // The date picker's library builds on the app's Material Components, offline (CB-469).
            './plugins/datetimepicker-gradle.ts',
            // Vendored from T3 Code (vendor/t3code/SYNC.md).
            `${T3}/withAndroidGradleHeap.cjs`,
            `${T3}/withAndroidModernPopupMenu.cjs`,
            [`${T3}/withAndroidModernAlertDialog.cjs`, ALERT_DIALOG_COLORS],
            `${T3}/withAndroidPredictiveBackCompat.cjs`,
        ],
        extra: {
            ...config.extra,
            // What the app reads (expo-constants) to know its build. The version and build number
            // it reads from the installed binary (socio-device's appBuild); these only from here.
            variant,
            // Left out when unset: Expo's config serializer turns a null into {}.
            ...(stamp.commit === null ? {} : { buildCommit: stamp.commit }),
            ...(stamp.date === null ? {} : { buildDate: stamp.date }),
            ...(relay === null ? {} : { relayOrigin: relay }),
            // The relay registration's apnsEnv follows it (src/platform/push.ts).
            apsEnvironment: aps,
            linkHost: links,
            // The sign-in sheet's callback (src/net/auth-sheet.ts); none in a preview or production
            // Personal Team build, whose sheet is unavailable.
            ...(callback === null ? {} : { authCallback: callback }),
        },
        experiments: {
            // Expo CLI asks Metro for babel-preset-expo's React Compiler only when this is
            // set. Release builds compile with panicThreshold 'NONE', so a component the
            // compiler gives up on ships unmemoized without a word:
            // tests/react-compiler.test.ts fails on any bailout not listed there.
            reactCompiler: true,
        },
    };
};
