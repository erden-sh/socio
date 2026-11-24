import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCESSED_API_TYPES, IOS_ICON } from '../app.config';
import { EXPO_QUIET_ENV } from '../plugins/build-env';
import { VARIANTS } from '../variant';

// What App Store Connect checks when the production build is uploaded to TestFlight: the export
// compliance key, the privacy manifest, the bundle id and a 1024 px App Store icon with no alpha.
// It runs the real `expo prebuild` of the production variant on a scratch copy of the app (its
// node_modules linked), since the privacy manifest and the icons are written by mods that
// introspection skips, and reads the files Xcode would build from. A second prebuild, with a push
// relay, checks that only such a build declares the device token the relay keeps, linked.

const app = join(import.meta.dirname, '..');
const run = promisify(execFile);
const EXPO_CLI = realpathSync(createRequire(import.meta.url).resolve('expo/bin/cli'));
const plist = createRequire(createRequire(import.meta.url).resolve('expo/package.json'))('@expo/plist') as {
    default: { parse: (xml: string) => Record<string, unknown> };
};

// The parts of the app that prebuild never reads, left out of the copy.
const SKIPPED = new Set(['node_modules', 'ios', 'android', '.expo', 'dist', 'deps', 'tests', 'e2e', 'perf']);

// The variables a developer's shell may hold that change the build (native-config.test.ts).
const BUILD_VARIABLES =
    /^(?:APP_VARIANT|SOCIO_IOS_PERSONAL_TEAM\w*|SOCIO_BUILD_\w+|SOCIO_RELAY_ORIGIN|SOCIO_LINK_HOST|SOCIO_APS_ENVIRONMENT|GOOGLE_SERVICES_JSON)$/;
const baseEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const name of Object.keys(env).filter((key) => BUILD_VARIABLES.test(key))) {
        delete env[name];
    }
    return env;
};

/** A PNG's size, and whether it can hold transparency: an alpha channel or a tRNS chunk. */
function png(bytes: Buffer) {
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const colorType = bytes[25];
    let transparency = false;
    for (let at = 8; at < bytes.length;) {
        const length = bytes.readUInt32BE(at);
        if (bytes.toString('latin1', at + 4, at + 8) === 'tRNS') {
            transparency = true;
        }
        at += length + 12;
    }
    // Color types 4 (gray) and 6 (RGB) carry alpha.
    return { width, height, alpha: colorType === 4 || colorType === 6 || transparency };
}

/** A production prebuild on a scratch copy of the app under `root`, with `env` added; answers its ios directory. */
async function prebuild(root: string, env: Record<string, string> = {}): Promise<string> {
    const copy = join(root, 'mobile');
    cpSync(app, copy, {
        recursive: true,
        filter: (path) => !SKIPPED.has(relative(app, path).split(/[\\/]/)[0]),
    });
    symlinkSync(join(app, 'node_modules'), join(copy, 'node_modules'), 'dir');
    // Expo's CLI by its real path, run with this Node: the copy's node_modules is a link, and
    // pnpm's .bin shims find the store relative to where they were called from, which from the
    // scratch copy is outside the workspace (CI's runner put it under /tmp/node_modules).
    await run(process.execPath, [EXPO_CLI, 'prebuild', '--platform', 'ios', '--no-install'], {
        cwd: copy,
        env: { ...baseEnv(), ...EXPO_QUIET_ENV, CI: '1', APP_VARIANT: 'production', ...env },
        maxBuffer: 16 * 1024 * 1024,
    });
    return join(copy, 'ios');
}

/** The generated PrivacyInfo.xcprivacy of the production target in `ios`. */
function readManifest(ios: string): Record<string, unknown> {
    return plist.default.parse(readFileSync(join(ios, VARIANTS.production.name, 'PrivacyInfo.xcprivacy'), 'utf8'));
}

/** The collected data types of a manifest, by type. */
function collected(manifest: Record<string, unknown>): Record<string, unknown> {
    const types = manifest.NSPrivacyCollectedDataTypes as { NSPrivacyCollectedDataType: string }[];
    return Object.fromEntries(
        types.map(({ NSPrivacyCollectedDataType, ...rest }) => [NSPrivacyCollectedDataType, rest]),
    );
}

const LINKED = {
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
};
// What the app sends to the workspace server, in every build (app.config.ts).
const ACCOUNT_DATA = {
    NSPrivacyCollectedDataTypeEmailAddress: LINKED,
    NSPrivacyCollectedDataTypeName: LINKED,
    NSPrivacyCollectedDataTypeUserID: LINKED,
    NSPrivacyCollectedDataTypeEmailsOrTextMessages: LINKED,
    NSPrivacyCollectedDataTypePhotosorVideos: LINKED,
    NSPrivacyCollectedDataTypeCustomerSupport: LINKED,
    NSPrivacyCollectedDataTypeOtherUserContent: LINKED,
    NSPrivacyCollectedDataTypeSearchHistory: LINKED,
    NSPrivacyCollectedDataTypeProductInteraction: LINKED,
};

describe('the production build, for App Store Connect', () => {
    let root = '';
    let ios = '';

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'socio-app-store-'));
        ios = await prebuild(root);
    }, 180_000);

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const target = () => join(ios, VARIANTS.production.name);

    it('declares its encryption exempt, so no build waits on export compliance', () => {
        const info = plist.default.parse(readFileSync(join(target(), 'Info.plist'), 'utf8'));
        expect(info.ITSAppUsesNonExemptEncryption).toBe(false);
    });

    it("associates link.socio.sh for the sign-in sheet's callback and links, without developer mode", () => {
        const entitlements = plist.default.parse(
            readFileSync(join(target(), `${VARIANTS.production.name}.entitlements`), 'utf8'),
        );
        expect(entitlements['com.apple.developer.associated-domains']).toEqual([
            'webcredentials:link.socio.sh',
            'applinks:link.socio.sh',
        ]);
    });

    it('is com.ingenioventures.socio', () => {
        const project = readFileSync(join(ios, `${VARIANTS.production.name}.xcodeproj/project.pbxproj`), 'utf8');
        const ids = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map((match) => match[1]);
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids)).toEqual(new Set(['com.ingenioventures.socio']));
    });

    it('ships the privacy manifest: no tracking, the account data, no device ID without a relay, every required-reason category', () => {
        const manifest = readManifest(ios);
        expect(manifest.NSPrivacyTracking).toBe(false);
        expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
        expect(collected(manifest)).toEqual(ACCOUNT_DATA);
        const reasons = Object.fromEntries(
            (manifest.NSPrivacyAccessedAPITypes as typeof ACCESSED_API_TYPES).map((type) => [
                type.NSPrivacyAccessedAPIType,
                [...type.NSPrivacyAccessedAPITypeReasons].sort(),
            ]),
        );
        expect(reasons).toEqual({
            NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
            NSPrivacyAccessedAPICategoryFileTimestamp: ['0A2A.1', '3B52.1', 'C617.1'],
            NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1'],
            NSPrivacyAccessedAPICategoryDiskSpace: ['85F4.1', 'E174.1'],
        });
        // In the app target's resources, so it lands in the bundle.
        const project = readFileSync(join(ios, `${VARIANTS.production.name}.xcodeproj/project.pbxproj`), 'utf8');
        expect(project).toMatch(/PrivacyInfo\.xcprivacy in Resources/);
    });

    it('has a 1024 px App Store icon with no alpha, from a source of that size', () => {
        expect(png(readFileSync(join(app, IOS_ICON)))).toEqual({ width: 1024, height: 1024, alpha: false });
        const set = join(target(), 'Images.xcassets/AppIcon.appiconset');
        const icons = readdirSync(set).filter((name) => name.endsWith('.png'));
        expect(icons.length).toBeGreaterThan(0);
        const largest = icons.map((name) => png(readFileSync(join(set, name)))).find((icon) => icon.width === 1024);
        expect(largest).toEqual({ width: 1024, height: 1024, alpha: false });
    });
});

describe('the production build with a push relay', () => {
    let root = '';
    let ios = '';

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'socio-app-store-relay-'));
        ios = await prebuild(root, { SOCIO_RELAY_ORIGIN: 'https://relay.example.com' });
    }, 180_000);

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('declares the device token the relay keeps, linked to the person, beside the account data', () => {
        const manifest = readManifest(ios);
        expect(manifest.NSPrivacyTracking).toBe(false);
        expect(collected(manifest)).toEqual({
            ...ACCOUNT_DATA,
            NSPrivacyCollectedDataTypeDeviceID: LINKED,
        });
    });
});
