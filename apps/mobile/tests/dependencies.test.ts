import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The app's dependency pins: exact versions,
// and a package Expo SDK 58 bundles at the version Expo picked for it. It also
// holds the two pieces the Slack-style shell builds on: React
// Navigation's native bottom tabs (`@react-navigation/bottom-tabs/unstable`,
// on react-native-screens' Tabs: UITabBarController on iOS, so iOS 26 draws
// its glass and the search tab, and Material bottom navigation on Android)
// and expo-glass-effect's GlassView for the app's own glass surfaces.

const app = join(import.meta.dirname, '..');
const require = createRequire(join(app, 'package.json'));

interface Manifest {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    exports?: Record<string, unknown>;
    version?: string;
    expo?: { install?: { exclude?: string[] } };
}

const read = (file: string): Manifest => JSON.parse(readFileSync(file, 'utf8'));

const manifest = read(join(app, 'package.json'));
const pins = { ...manifest.dependencies, ...manifest.devDependencies };
const bundled: Record<string, string> = JSON.parse(
    readFileSync(require.resolve('expo/bundledNativeModules.json'), 'utf8'),
);

const EXACT = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
// A fork, as a tarball in deps/ (deps/README.md).
const TARBALL = /^file:deps\/[\w.-]+\.tgz$/;
// Patched or forked on purpose, at the version the patch was made for (vendor/t3code/SYNC.md), so
// `expo install` leaves them alone.
const excluded = manifest.expo?.install?.exclude ?? [];

/** Whether exact `version` is in Expo's `~x.y.z`, `^x.y.z` or `x.y.z` range. */
function inRange(version: string, range: string): boolean {
    const [major, minor, patch] = version.split(/[.-]/).map(Number);
    const match = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/.exec(range);
    if (match === null) {
        return false;
    }
    const [, op, wantMajor, wantMinor, wantPatch] = match;
    const want = [Number(wantMajor), Number(wantMinor), Number(wantPatch)];
    if (op === '') {
        return major === want[0] && minor === want[1] && patch === want[2];
    }
    if (major !== want[0] || (op === '~' && minor !== want[1])) {
        return false;
    }
    return minor > want[1] || (minor === want[1] && patch >= want[2]);
}

describe('dependency pins', () => {
    it.each(Object.entries(pins).filter(([, spec]) => !spec.startsWith('workspace:') && !spec.startsWith('file:')))(
        '%s is pinned to an exact version',
        (_name, spec) => {
            expect(spec).toMatch(EXACT);
        },
    );

    it.each(Object.entries(pins).filter(([, spec]) => spec.startsWith('file:')))(
        '%s is a tarball in deps/ named after its exact version',
        (name, spec) => {
            expect(spec).toMatch(TARBALL);
            const installed = read(require.resolve(`${name}/package.json`)).version ?? '';
            expect(installed).toMatch(EXACT);
            expect(spec).toContain(`${name}-${installed}-`);
            expect(excluded).toContain(name);
        },
    );

    it.each(Object.entries(pins).filter(([name]) => name in bundled && !excluded.includes(name)))(
        "%s is at Expo SDK 58's version",
        (name, spec) => {
            expect(inRange(spec, bundled[name] ?? ''), `${name} ${spec} is outside Expo's ${bundled[name]}`).toBe(true);
        },
    );
});

describe("the shell's native pieces", () => {
    it("React Navigation's bottom tabs ship the native tab navigator", () => {
        const tabs = read(require.resolve('@react-navigation/bottom-tabs/package.json'));
        expect(tabs.exports).toHaveProperty(['./unstable']);
    });

    it('expo-glass-effect is a dependency', () => {
        expect(manifest.dependencies).toHaveProperty(['expo-glass-effect']);
    });
});
