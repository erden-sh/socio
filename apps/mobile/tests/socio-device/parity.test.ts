import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Every call the TypeScript side declares (`SocioDeviceNative`) is exported by
// both native sides, an iOS-only one as a no-op on Android, so a call
// that slips past a platform check answers rather than throwing "not a function".
const module = join(import.meta.dirname, '../../modules/socio-device');
const read = (path: string) => readFileSync(join(module, path), 'utf8');

/** The method names of `SocioDeviceNative` in modules/socio-device/src/native.ts. */
function declaredCalls(): string[] {
    const source = read('src/native.ts');
    const body = /export interface SocioDeviceNative[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    return [...body.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1] as string);
}

const exported = (source: string) => [...source.matchAll(/\b(?:Async)?Function\("(\w+)"/g)].map((match) => match[1]);

describe('the native sides of socio-device', () => {
    const calls = declaredCalls();
    const swift = exported(read('ios/SocioDeviceModule.swift'));
    const kotlin = exported(read('android/src/main/java/expo/modules/sociodevice/SocioDeviceModule.kt'));
    const readme = read('README.md');

    it('finds the declared calls', () => {
        expect(calls).toContain('holdBackgroundGrace');
        expect(calls).toContain('deleteAppSnapshots');
    });

    it.each(['ios', 'android'])('exports every declared call on %s', (platform) => {
        const names = platform === 'ios' ? swift : kotlin;
        expect(calls.filter((call) => !names.includes(call))).toEqual([]);
    });

    it('lists every call in the README’s table', () => {
        for (const call of calls) {
            expect(readme).toMatch(new RegExp(`^\\| \`${call}\\(`, 'm'));
        }
    });

    // The sign-in sheet's Auth Tab is Android's; iOS signs in through expo-web-browser.
    it('answers unavailable for openAuthTab on iOS, whose sheet is expo-web-browser', () => {
        expect(calls).toContain('openAuthTab');
        const source = read('ios/SocioDeviceModule.swift');
        expect(source).toMatch(
            /AsyncFunction\("openAuthTab"\) \{ \(_: String, _: String, _: String\) -> \[String: String\] in\s*\["type": "unavailable", "reason": "ios"\]\s*\}/,
        );
        expect(readme).toMatch(/^\| `openAuthTab\(url, host, path\)`.*\| \*\*`unavailable`\*\*/m);
    });

    it("opens Android's Auth Tab only where the browser has one, not ephemeral, with browser 1.9 in the module", () => {
        const kotlin = read('android/src/main/java/expo/modules/sociodevice/SocioDeviceModule.kt');
        expect(kotlin).toMatch(
            /AsyncFunction\("openAuthTab"\) \{ url: String, host: String, path: String, promise: Promise ->/,
        );
        const tab = read('android/src/main/java/expo/modules/sociodevice/AuthTab.kt');
        expect(tab).toContain('if (!CustomTabsClient.isAuthTabSupported(activity, browser)) {');
        expect(tab).toContain('"type" to "unavailable", "reason" to "no-auth-tab"');
        expect(tab).toContain('setEphemeralBrowsingEnabled(false)');
        expect(tab).toContain('intent.launch(registered, Uri.parse(url), host, path)');
        for (const type of ['success', 'cancel', 'verification-failed', 'verification-timed-out', 'unknown']) {
            expect(tab).toContain(`"type" to "${type}"`);
        }
        expect(read('android/build.gradle')).toContain('implementation("androidx.browser:browser:1.9.0")');
    });

    it('answers 0 for deleteAppSnapshots on Android, removing nothing', () => {
        const source = read('android/src/main/java/expo/modules/sociodevice/SocioDeviceModule.kt');
        expect(source).toMatch(/AsyncFunction\("deleteAppSnapshots"\) \{\s*0\s*\}/);
        expect(readme).toMatch(/^\| `deleteAppSnapshots\(\)`.*\| \*\*No-op:\*\* returns `0`/m);
    });
});
