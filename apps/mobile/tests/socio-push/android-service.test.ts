import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Android's messaging service as its files declare it. The Robolectric and JVM tests
// (modules/socio-push/android/README.md, Tests) run its behavior; these hold what a build must keep.
const android = join(import.meta.dirname, '../../modules/socio-push/android/src');
const read = (path: string) => readFileSync(join(android, path), 'utf8');
const kotlin = (folder: string) =>
    readdirSync(join(android, folder, 'java/expo/modules/sociopush'))
        .filter((name) => name.endsWith('.kt'))
        .map((name) => ({ name, text: read(`${folder}/java/expo/modules/sociopush/${name}`) }));

describe("the module's manifest", () => {
    const main = read('main/AndroidManifest.xml');

    it("removes Expo's FCM service and registers ours, not exported", () => {
        expect(main).toMatch(
            /<service android:name="expo\.modules\.notifications\.service\.ExpoFirebaseMessagingService" tools:node="remove" \/>/,
        );
        expect(main).toMatch(
            /<service android:name="expo\.modules\.sociopush\.SocioMessagingService" android:exported="false">\s*<intent-filter>\s*<action android:name="com\.google\.firebase\.MESSAGING_EVENT" \/>/,
        );
    });

    it('has no debug hook, which only debug builds get, behind the shell-only DUMP permission', () => {
        expect(main).not.toMatch(/DebugPushReceiver/);
        expect(kotlin('main').map(({ name }) => name)).not.toContain('DebugPushReceiver.kt');
        const debug = read('debug/AndroidManifest.xml');
        expect(debug).toMatch(/android:name="expo\.modules\.sociopush\.DebugPushReceiver"/);
        expect(debug).toMatch(/android:permission="android\.permission\.DUMP"/);
    });
});

describe("the service's code", () => {
    const sources = kotlin('main');

    it('fetches nothing: no icon, no image, no network at all', () => {
        for (const { name, text } of sources) {
            expect(text, name).not.toMatch(/HttpURLConnection|URL\(|OkHttp|openConnection|Socket\(/);
            expect(text, name).not.toMatch(/"icon"|"image"/);
        }
    });

    it('never touches the badge', () => {
        for (const { name, text } of sources) {
            expect(text, name).not.toMatch(/setNumber|setBadgeIconType|ShortcutBadger/);
        }
    });

    it('opens the app by an explicit intent carrying a token, never a VIEW URL', () => {
        const notifier = sources.find(({ name }) => name === 'PushNotifier.kt')!.text;
        expect(notifier).toMatch(/getLaunchIntentForPackage/);
        expect(notifier).not.toMatch(/ACTION_VIEW|Uri\.parse|setData\(/);
        expect(notifier).toMatch(/PendingIntent\.FLAG_IMMUTABLE/);
    });
});

// Expo 58 links expo-notifications as a prebuilt AAR from its local Maven repository, published at
// the package's own version. The module asks for that artifact by version, so an expo-notifications
// update that leaves the coordinate behind fails the Android build ("Could not find
// host.exp.exponent:expo.modules.notifications"), and the libraries the service shares with it would
// resolve twice.
describe("the module's Gradle dependencies", () => {
    const gradle = readFileSync(join(import.meta.dirname, '../../modules/socio-push/android/build.gradle'), 'utf8');
    const notifications = join(import.meta.dirname, '../../node_modules/expo-notifications');
    const installed: string = JSON.parse(readFileSync(join(notifications, 'package.json'), 'utf8')).version;
    const theirs = readFileSync(join(notifications, 'android/build.gradle'), 'utf8');
    const version = (text: string, artifact: string) =>
        new RegExp(`'${artifact.replaceAll('.', '\\.')}:([^']+)'`).exec(text)?.[1];

    it('asks for the prebuilt expo-notifications at the installed version', () => {
        expect(version(gradle, 'host.exp.exponent:expo.modules.notifications')).toBe(installed);
        expect(gradle).toContain(`expo-notifications ${installed} brings`);
    });

    it.each(['com.google.firebase:firebase-messaging', 'androidx.core:core', 'androidx.lifecycle:lifecycle-process'])(
        'uses %s at the version expo-notifications brings',
        (artifact) => {
            expect(version(gradle, artifact)).toBeDefined();
            expect(version(gradle, artifact)).toBe(version(theirs, artifact));
        },
    );
});
