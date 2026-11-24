import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { compileModsAsync, type ConfigPlugin, withEntitlementsPlist, withPlugins, XML } from 'expo/config-plugins';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LINK_HOST, LINK_STAGING_HOST, VARIANT_LINK_PATHS } from '@socio/shared/device-sign-in';

import { BLOCKED_PERMISSIONS, CAMERA_PURPOSE, NOTIFICATION_COLOR, NOTIFICATION_ICON } from '../app.config';
import { apsEnvironment } from '../aps-environment';
import packageJson from '../package.json';
import * as appLinks from '../plugins/app-links';
import { linkHost } from '../plugins/app-links';
import { BACKUP_EXCLUDES, dataExtractionRulesXml, fullBackupContentXml } from '../plugins/backup-rules';
import {
    type BuildEnvOptions,
    EXPO_QUIET_ENV,
    GRADLE_APS_ENVIRONMENT_PROPERTY,
    GRADLE_LINK_HOST_PROPERTY,
    GRADLE_RELAY_PROPERTY,
    GRADLE_STAMP_PROPERTIES,
    GRADLE_VARIANT_PROPERTY,
    quietPodfile,
    quietXcodeEnv,
    stampCheckGradle,
    variantCheckGradle,
    variantXcodeEnv,
} from '../plugins/build-env';
import withNetworkSecurityConfig, {
    CLEARTEXT_HOSTS,
    DEBUG_SOURCE_SETS,
    debugNetworkSecurityConfigXml,
    networkSecurityConfigXml,
} from '../plugins/network-security';
import withoutPersonalTeamKeychainGroups, { iosPersonalTeam } from '../plugins/personal-team';
import withPush, {
    appGroup,
    FIREBASE_META_DATA,
    googleServicesFile,
    keychainGroups,
    NO_FCM_WARNING,
    PUSH_INFO_PLIST_KEYS,
    pushInfoPlist,
    SHARED_KEYCHAIN_SUFFIX,
} from '../plugins/push';
import { elementPath, lucideNode, TAB_ICONS, tabIconResource, vectorDrawable } from '../plugins/tab-icons';
import { appTransportSecurity } from '../plugins/transport-security';
import { tabDrawable, TAB_LUCIDE_ICONS } from '../src/navigation/tabs';
import { VARIANTS, type VariantName } from '../variant';

// The native build config. The XML files are
// written by dangerous mods, which `expo config --type introspect` doesn't run, so their builders
// are tested here directly, the network plugin's mod also runs through `compileModsAsync` into a
// scratch project, and the built APK is checked by hand (README). Everything else the plugins set is
// read back from introspection, per variant.

const app = join(import.meta.dirname, '..');
const variants = Object.keys(VARIANTS) as VariantName[];
const require = createRequire(import.meta.url);
const run = promisify(execFile);

// The variant, Personal Team, build stamp and Firebase variables a developer's shell may hold (README): every child
// process here gets only the ones its run sets.
const BUILD_VARIABLES =
    /^(?:APP_VARIANT|SOCIO_IOS_PERSONAL_TEAM\w*|SOCIO_BUILD_\w+|SOCIO_LINK_HOST|SOCIO_APS_ENVIRONMENT|GOOGLE_SERVICES_JSON)$/;
const baseEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const name of Object.keys(env).filter((key) => BUILD_VARIABLES.test(key))) {
        delete env[name];
    }
    return env;
};

type Node = Record<string, unknown> & { $?: Record<string, string>; _?: string };
const parse = async (xml: string) => (await XML.parseXMLAsync(xml)) as unknown as Record<string, Node>;
const children = (node: Node | undefined, name: string) => (node?.[name] ?? []) as Node[];
const attrs = (nodes: Node[]) => nodes.map((node) => node.$);

describe("release builds' network security config", () => {
    it.each([
        ['production', ['system']],
        ['preview', ['system', 'user']],
        ['development', ['system', 'user']],
    ] as const)('in %s, keeps cleartext off and trusts %j CAs', async (variant, anchors) => {
        const config = (await parse(networkSecurityConfigXml({ variant, vendorDomains: [] })))[
            'network-security-config'
        ];
        const [base, ...others] = children(config, 'base-config');
        expect(others).toEqual([]);
        expect(base.$).toEqual({ cleartextTrafficPermitted: 'false' });
        const certificates = children(children(base, 'trust-anchors')[0], 'certificates');
        expect(attrs(certificates)).toEqual(anchors.map((src) => ({ src })));
    });

    it('allows cleartext only in development, and only to the loopback names and the emulator host', async () => {
        for (const variant of ['production', 'preview'] as const) {
            const config = (await parse(networkSecurityConfigXml({ variant, vendorDomains: [] })))[
                'network-security-config'
            ];
            expect(children(config, 'domain-config'), variant).toEqual([]);
        }
        const config = (await parse(networkSecurityConfigXml({ variant: 'development', vendorDomains: [] })))[
            'network-security-config'
        ];
        const [cleartext, ...others] = children(config, 'domain-config');
        expect(others).toEqual([]);
        expect(cleartext.$).toEqual({ cleartextTrafficPermitted: 'true' });
        expect(children(cleartext, 'domain').map((domain) => [domain._, domain.$])).toEqual(
            CLEARTEXT_HOSTS.map((host) => [host, { includeSubdomains: 'false' }]),
        );
        // The loopback names (local test servers through adb reverse) and the emulator's address
        // for the host. Debug builds, which load from Metro, allow every host (below).
        expect(CLEARTEXT_HOSTS).toEqual(['localhost', '127.0.0.1', '10.0.2.2']);
        // It inherits the base trust anchors, so it opens nothing else.
        expect(children(cleartext, 'trust-anchors')).toEqual([]);
    });

    it.each(variants)('in %s, trusts only system CAs for the vendor domains, with no pins', async (variant) => {
        const vendorDomains = ['directory.example.com', 'relay.example.com'];
        const config = (await parse(networkSecurityConfigXml({ variant, vendorDomains })))['network-security-config'];
        const vendor = children(config, 'domain-config').at(-1);
        expect(vendor?.$).toEqual({ cleartextTrafficPermitted: 'false' });
        expect(children(vendor, 'domain').map((domain) => [domain._, domain.$])).toEqual(
            vendorDomains.map((domain) => [domain, { includeSubdomains: 'true' }]),
        );
        expect(attrs(children(children(vendor, 'trust-anchors')[0], 'certificates'))).toEqual([{ src: 'system' }]);
        expect(children(vendor, 'pin-set')).toEqual([]);
    });

    it('refuses a vendor domain that is not a plain lowercase name', () => {
        for (const bad of ['https://example.com', 'Example.com', 'example', '<x>.com', 'a.com"/>', '']) {
            for (const build of [networkSecurityConfigXml, debugNetworkSecurityConfigXml]) {
                expect(() => build({ variant: 'production', vendorDomains: [bad] }), bad).toThrow(/domain name/);
            }
        }
    });
});

// A debug build loads its JavaScript from Metro at whatever address Expo CLI hands it: localhost
// through adb reverse, or the machine's LAN or tailnet address for a phone on Wi-Fi.
describe("the debug build types' network security config", () => {
    it.each([
        ['production', ['system']],
        ['preview', ['system', 'user']],
        ['development', ['system', 'user']],
    ] as const)('in %s, allows cleartext to every host and still trusts %j CAs', async (variant, anchors) => {
        const config = (await parse(debugNetworkSecurityConfigXml({ variant, vendorDomains: [] })))[
            'network-security-config'
        ];
        const [base, ...others] = children(config, 'base-config');
        expect(others).toEqual([]);
        expect(base.$).toEqual({ cleartextTrafficPermitted: 'true' });
        const certificates = children(children(base, 'trust-anchors')[0], 'certificates');
        expect(attrs(certificates)).toEqual(anchors.map((src) => ({ src })));
        // The base config already covers the release build's loopback hosts.
        expect(children(config, 'domain-config')).toEqual([]);
        expect(children(config, 'debug-overrides')).toEqual([]);
    });

    it.each(variants)(
        'in %s, still refuses cleartext and user CAs for the vendor domains, with no pins',
        async (variant) => {
            const vendorDomains = ['directory.example.com', 'relay.example.com'];
            const config = (await parse(debugNetworkSecurityConfigXml({ variant, vendorDomains })))[
                'network-security-config'
            ];
            const [vendor, ...others] = children(config, 'domain-config');
            expect(others).toEqual([]);
            expect(vendor.$).toEqual({ cleartextTrafficPermitted: 'false' });
            expect(children(vendor, 'domain').map((domain) => [domain._, domain.$])).toEqual(
                vendorDomains.map((domain) => [domain, { includeSubdomains: 'true' }]),
            );
            expect(attrs(children(children(vendor, 'trust-anchors')[0], 'certificates'))).toEqual([{ src: 'system' }]);
            expect(children(vendor, 'pin-set')).toEqual([]);
        },
    );

    it("differs from the release build's only in allowing cleartext to every host", () => {
        for (const variant of variants) {
            const release = networkSecurityConfigXml({ variant, vendorDomains: ['relay.example.com'] });
            const debug = debugNetworkSecurityConfigXml({ variant, vendorDomains: ['relay.example.com'] });
            const loopback =
                /\n {2}<domain-config cleartextTrafficPermitted="true">\n(?: {4}<domain .*\n)+ {2}<\/domain-config>/;
            expect(debug, variant).toBe(
                release
                    .replace(
                        '<base-config cleartextTrafficPermitted="false">',
                        '<base-config cleartextTrafficPermitted="true">',
                    )
                    .replace(loopback, ''),
            );
        }
    });

    // The plugin's dangerous mod, run as prebuild runs it, into a scratch android/ project.
    describe('as prebuild writes it', () => {
        let root = '';

        beforeAll(() => {
            root = mkdtempSync(join(tmpdir(), 'socio-network-security-'));
        });

        afterAll(() => {
            rmSync(root, { recursive: true, force: true });
        });

        const prebuild = async (variant: VariantName) => {
            const projectRoot = join(root, variant);
            const manifest = join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
            mkdirSync(dirname(manifest), { recursive: true });
            writeFileSync(
                manifest,
                '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <application android:name=".MainApplication"/>\n</manifest>\n',
            );
            const options = { variant, vendorDomains: [] };
            // Twice, as a prebuild without --clean does over an earlier one.
            for (let pass = 0; pass < 2; pass++) {
                const config = withNetworkSecurityConfig(
                    { name: 'Socio', slug: 'socio', _internal: { projectRoot } },
                    options,
                );
                await compileModsAsync(config, { projectRoot, platforms: ['android'], introspect: false });
            }
            const xml = (sourceSet: string) =>
                readFileSync(
                    join(projectRoot, `android/app/src/${sourceSet}/res/xml/network_security_config.xml`),
                    'utf8',
                );
            return { options, manifest: readFileSync(manifest, 'utf8'), xml };
        };

        it.each(variants)(
            "in %s, puts the release rules in main and the debug ones in each debug build type's own source set",
            async (variant) => {
                const { options, manifest, xml } = await prebuild(variant);
                expect(manifest).toContain('android:networkSecurityConfig="@xml/network_security_config"');
                expect(xml('main')).toBe(networkSecurityConfigXml(options));
                expect(DEBUG_SOURCE_SETS).toEqual(['debug', 'debugOptimized']);
                for (const sourceSet of DEBUG_SOURCE_SETS) {
                    expect(xml(sourceSet), sourceSet).toBe(debugNetworkSecurityConfigXml(options));
                }
            },
        );
    });
});

describe('the Android backup rules', () => {
    const expected = BACKUP_EXCLUDES.map(({ domain, path }) => ({ domain, path }));

    it('leave the device store and the secure-store prefs out', () => {
        expect(expected).toEqual([
            { domain: 'file', path: 'socio/' },
            { domain: 'sharedpref', path: 'SecureStore.xml' },
        ]);
    });

    it('exclude both from Auto Backup on Android 11 and earlier, and include nothing', async () => {
        const rules = (await parse(fullBackupContentXml()))['full-backup-content'];
        expect(attrs(children(rules, 'exclude'))).toEqual(expected);
        expect(children(rules, 'include')).toEqual([]);
    });

    it('exclude both from cloud backup and device transfer on Android 12 and later', async () => {
        const rules = (await parse(dataExtractionRulesXml()))['data-extraction-rules'];
        for (const kind of ['cloud-backup', 'device-transfer']) {
            const [section, ...others] = children(rules, kind);
            expect(others, kind).toEqual([]);
            expect(attrs(children(section, 'exclude')), kind).toEqual(expected);
            expect(children(section, 'include'), kind).toEqual([]);
        }
    });
});

describe('App Transport Security', () => {
    it.each(variants)('never allows arbitrary loads in %s', (variant) => {
        expect(appTransportSecurity(variant).NSAllowsArbitraryLoads).toBe(false);
    });

    it('allows local networking in development only', () => {
        expect(appTransportSecurity('development')).toEqual({
            NSAllowsArbitraryLoads: false,
            NSAllowsLocalNetworking: true,
        });
        expect(appTransportSecurity('preview')).toEqual({ NSAllowsArbitraryLoads: false });
        expect(appTransportSecurity('production')).toEqual({ NSAllowsArbitraryLoads: false });
    });
});

describe('quiet native builds', () => {
    const template = 'export NODE_BINARY=$(command -v node)\n';
    const exports = ['export EXPO_NO_TELEMETRY=1', 'export EXPO_OFFLINE=1', 'export DO_NOT_TRACK=1'];

    it('export the three switches from ios/.xcode.env, once, however often prebuild runs', () => {
        expect(EXPO_QUIET_ENV).toEqual({ EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', DO_NOT_TRACK: '1' });
        const once = quietXcodeEnv(template);
        expect(once.startsWith(template)).toBe(true);
        for (const line of exports) {
            expect(
                once.split('\n').filter((at) => at === line),
                line,
            ).toHaveLength(1);
        }
        expect(quietXcodeEnv(once)).toBe(once);
    });

    it('replace an older block instead of adding a second', () => {
        const stale = `${template}\n# @socio begin expo-quiet\nexport EXPO_NO_TELEMETRY=1\n# @socio end expo-quiet\n`;
        expect(quietXcodeEnv(stale)).toBe(quietXcodeEnv(template));
    });

    it("turn CocoaPods' stats off at the top of the Podfile, once", () => {
        const podfile = "require 'json'\nplatform :ios, '17.4'\n";
        const once = quietPodfile(podfile);
        expect(once.split('\n').find((line) => !line.startsWith('#'))).toBe("ENV['COCOAPODS_DISABLE_STATS'] = 'true'");
        expect(once.endsWith(podfile)).toBe(true);
        expect(quietPodfile(once)).toBe(once);
    });
});

describe("builds read app.config.ts again, with the prebuild's variant", () => {
    const template = 'export NODE_BINARY=$(command -v node)\n';
    const lines = (contents: string) => contents.split('\n');
    const personalTeam = { bundleIdentifier: 'com.example.socio' };

    it.each(variants)('%s: ios/.xcode.env exports its APP_VARIANT, once, and no Personal Team', (variant) => {
        const once = variantXcodeEnv(quietXcodeEnv(template), { variant });
        expect(lines(once).filter((line) => line.includes('APP_VARIANT'))).toEqual([`export APP_VARIANT=${variant}`]);
        expect(lines(once)).toContain('unset SOCIO_IOS_PERSONAL_TEAM SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID');
        expect(once).not.toMatch(/^export SOCIO_IOS/m);
        expect(variantXcodeEnv(quietXcodeEnv(once), { variant })).toBe(once);
    });

    it('ios/.xcode.env takes the variant of the latest prebuild', () => {
        const preview = variantXcodeEnv(template, { variant: 'preview' });
        expect(variantXcodeEnv(preview, { variant: 'production' })).toBe(
            variantXcodeEnv(template, { variant: 'production' }),
        );
    });

    it("ios/.xcode.env exports a Personal Team build's variables", () => {
        const env = variantXcodeEnv(template, { variant: 'development', personalTeam });
        expect(lines(env)).toEqual(
            expect.arrayContaining([
                'export APP_VARIANT=development',
                'export SOCIO_IOS_PERSONAL_TEAM=1',
                'export SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.socio',
            ]),
        );
        expect(env).not.toMatch(/^unset SOCIO_IOS/m);
    });

    it('ios/.xcode.env exports the build stamp the prebuild saw, and unsets what it didn’t', () => {
        const unstamped = lines(variantXcodeEnv(template, { variant: 'preview' }));
        expect(unstamped).toEqual(
            expect.arrayContaining([
                'export SOCIO_BUILD_NUMBER=1',
                'unset SOCIO_BUILD_COMMIT',
                'unset SOCIO_BUILD_DATE',
            ]),
        );
        const stamp = { buildNumber: 2829, commit: 'be466eab8', date: '2026-11-09' };
        const once = variantXcodeEnv(template, { variant: 'preview', stamp });
        expect(lines(once)).toEqual(
            expect.arrayContaining([
                'export SOCIO_BUILD_NUMBER=2829',
                'export SOCIO_BUILD_COMMIT=be466eab8',
                'export SOCIO_BUILD_DATE=2026-11-09',
            ]),
        );
        expect(variantXcodeEnv(once, { variant: 'preview', stamp })).toBe(once);
        expect(lines(variantXcodeEnv(once, { variant: 'preview' }))).toContain('export SOCIO_BUILD_NUMBER=1');
    });

    it('ios/.xcode.env exports the relay origin the prebuild saw, and unsets it when it saw none', () => {
        expect(lines(variantXcodeEnv(template, { variant: 'preview' }))).toContain('unset SOCIO_RELAY_ORIGIN');
        const relayed = variantXcodeEnv(template, { variant: 'preview', relayOrigin: 'https://relay.example.test' });
        expect(lines(relayed)).toContain('export SOCIO_RELAY_ORIGIN=https://relay.example.test');
        expect(lines(variantXcodeEnv(relayed, { variant: 'preview' }))).toContain('unset SOCIO_RELAY_ORIGIN');
    });

    it('ios/.xcode.env exports a development SOCIO_LINK_HOST, and unsets the variable for the default host', () => {
        const tunnel = 'quiet-fox-1234.trycloudflare.com';
        const exported = variantXcodeEnv(template, { variant: 'development', linkHost: tunnel });
        expect(lines(exported)).toContain(`export SOCIO_LINK_HOST=${tunnel}`);
        for (const variant of variants) {
            const host = variant === 'development' ? LINK_STAGING_HOST : LINK_HOST;
            expect(lines(variantXcodeEnv(exported, { variant, linkHost: host }))).toContain('unset SOCIO_LINK_HOST');
        }
    });

    it("ios/.xcode.env exports SOCIO_APS_ENVIRONMENT when it isn't the variant's default, and unsets it otherwise", () => {
        expect(lines(variantXcodeEnv(template, { variant: 'preview' }))).toContain('unset SOCIO_APS_ENVIRONMENT');
        const sandboxed = variantXcodeEnv(template, { variant: 'preview', apsEnvironment: 'development' });
        expect(lines(sandboxed)).toContain('export SOCIO_APS_ENVIRONMENT=development');
        expect(lines(variantXcodeEnv(sandboxed, { variant: 'preview', apsEnvironment: 'production' }))).toContain(
            'unset SOCIO_APS_ENVIRONMENT',
        );
        expect(lines(variantXcodeEnv(template, { variant: 'development', apsEnvironment: 'production' }))).toContain(
            'export SOCIO_APS_ENVIRONMENT=production',
        );
        expect(lines(variantXcodeEnv(template, { variant: 'development', apsEnvironment: 'development' }))).toContain(
            'unset SOCIO_APS_ENVIRONMENT',
        );
    });

    it("android/app/build.gradle fails a build whose build stamp isn't the project's", () => {
        const gradle = 'apply plugin: "com.android.application"\n';
        const once = stampCheckGradle(variantCheckGradle(gradle));
        expect(once.startsWith(variantCheckGradle(gradle))).toBe(true);
        for (const [name, property] of Object.entries(GRADLE_STAMP_PROPERTIES)) {
            expect(once).toContain(`'${name}': '${property}',`);
        }
        expect(once).toContain(`'SOCIO_RELAY_ORIGIN': '${GRADLE_RELAY_PROPERTY}',`);
        expect(once).toContain(`'SOCIO_LINK_HOST': '${GRADLE_LINK_HOST_PROPERTY}',`);
        expect(once).toContain(`'SOCIO_APS_ENVIRONMENT': '${GRADLE_APS_ENVIRONMENT_PROPERTY}',`);
        expect(once).toContain("System.getenv(socioName) ?: (socioName == 'SOCIO_BUILD_NUMBER' ? '1' : '')");
        expect(once).toContain('throw new GradleException(');
        expect(lines(once).filter((line) => line.startsWith('#'))).toEqual([]);
        expect(stampCheckGradle(once)).toBe(once);
    });

    it("android/app/build.gradle fails a build whose APP_VARIANT isn't the project's", () => {
        const gradle = 'apply plugin: "com.android.application"\n';
        const once = variantCheckGradle(gradle);
        expect(once.startsWith(gradle)).toBe(true);
        expect(once).toContain(`def socioProjectVariant = findProperty('${GRADLE_VARIANT_PROPERTY}')`);
        expect(once).toContain("def socioBuildVariant = System.getenv('APP_VARIANT') ?: 'development'");
        expect(once).toContain('if (socioBuildVariant != socioProjectVariant) {');
        expect(once).toContain('throw new GradleException(');
        // Groovy comments, not the shell's.
        expect(lines(once).filter((line) => line.startsWith('#'))).toEqual([]);
        expect(variantCheckGradle(once)).toBe(once);
    });

    // What Xcode runs: EXConstants' script phase calls getAppConfig.js through with-node.sh, which
    // sources ios/.xcode.env first, and the app reads the config it writes. Xcode started from the
    // Dock passes no APP_VARIANT; a shell may pass another variant or a Personal Team.
    describe('the config an Xcode build embeds', () => {
        type Embedded = {
            scheme?: string;
            ios?: { bundleIdentifier?: string; buildNumber?: string };
            extra?: {
                variant?: string;
                buildCommit?: string;
                buildDate?: string;
                linkHost?: string;
                apsEnvironment?: string;
            };
        };
        const constants = dirname(require.resolve('expo-constants/package.json'));
        const embedded = new Map<string, Embedded>();
        const roots: string[] = [];

        const embed = async (options: BuildEnvOptions, caller: Record<string, string>): Promise<Embedded> => {
            const root = mkdtempSync(join(tmpdir(), 'socio-xcode-env-'));
            roots.push(root);
            mkdirSync(join(root, 'ios', 'Pods'), { recursive: true });
            writeFileSync(join(root, 'ios', '.xcode.env'), variantXcodeEnv(quietXcodeEnv(template), options));
            const script = join(constants, 'scripts');
            await run(
                'bash',
                [
                    join(script, 'with-node.sh'),
                    join(script, 'getAppConfig.js'),
                    app,
                    root,
                    'ios',
                    'false',
                    'production',
                ],
                { cwd: app, env: { ...baseEnv(), PODS_ROOT: join(root, 'ios', 'Pods'), ...caller } },
            );
            return JSON.parse(readFileSync(join(root, 'app.config'), 'utf8')) as Embedded;
        };

        const shell = {
            APP_VARIANT: 'development',
            SOCIO_LINK_HOST: 'quiet-fox-1234.trycloudflare.com',
            SOCIO_IOS_PERSONAL_TEAM: '1',
            SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID: 'com.example.mine',
        };
        const runs: [string, BuildEnvOptions, Record<string, string>][] = [
            ...variants.map((variant): [string, BuildEnvOptions, Record<string, string>] => [variant, { variant }, {}]),
            ['production, from a shell with other variables', { variant: 'production' }, shell],
            ['personal-team', { variant: 'development', personalTeam }, {}],
            ['tunnel', { variant: 'development', linkHost: 'quiet-fox-1234.trycloudflare.com' }, {}],
            [
                'development-signed preview, from a shell with another APNs environment',
                { variant: 'preview', apsEnvironment: 'development' },
                { SOCIO_APS_ENVIRONMENT: 'production' },
            ],
            [
                'stamped, from a shell with another stamp',
                { variant: 'preview', stamp: { buildNumber: 2829, commit: 'be466eab8', date: '2026-11-09' } },
                { SOCIO_BUILD_NUMBER: '7', SOCIO_BUILD_COMMIT: 'abcdef1' },
            ],
        ];

        beforeAll(async () => {
            const results = await Promise.all(runs.map(([, options, caller]) => embed(options, caller)));
            runs.forEach(([key], index) => embedded.set(key, results[index]));
        }, 120_000);

        afterAll(() => {
            for (const root of roots) {
                rmSync(root, { recursive: true, force: true });
            }
        });

        it.each([...variants, 'production, from a shell with other variables'])(
            '%s: is the variant the project was generated for',
            (key) => {
                const variant = runs.find(([at]) => at === key)?.[1].variant ?? 'development';
                expect(embedded.get(key)).toMatchObject({
                    scheme: VARIANTS[variant].scheme,
                    ios: { bundleIdentifier: VARIANTS[variant].id },
                    extra: { variant },
                });
            },
        );

        it('a Personal Team build: under its own bundle id', () => {
            expect(embedded.get('personal-team')).toMatchObject({
                ios: { bundleIdentifier: 'com.example.socio' },
                extra: { variant: 'development' },
            });
        });

        it("the prebuild's link host, whatever the shell holds", () => {
            expect(embedded.get('tunnel')?.extra?.linkHost).toBe('quiet-fox-1234.trycloudflare.com');
            expect(embedded.get('production, from a shell with other variables')?.extra?.linkHost).toBe(LINK_HOST);
            expect(embedded.get('development')?.extra?.linkHost).toBe(LINK_STAGING_HOST);
        });

        it("the prebuild's APNs environment, whatever the shell holds", () => {
            expect(
                embedded.get('development-signed preview, from a shell with another APNs environment')?.extra
                    ?.apsEnvironment,
            ).toBe('development');
            expect(embedded.get('production, from a shell with other variables')?.extra?.apsEnvironment).toBe(
                'production',
            );
            expect(embedded.get('development')?.extra?.apsEnvironment).toBe('development');
            expect(embedded.get('preview')?.extra?.apsEnvironment).toBe('production');
        });

        it("the prebuild's build stamp, whatever the shell holds", () => {
            expect(embedded.get('stamped, from a shell with another stamp')).toMatchObject({
                ios: { buildNumber: '2829' },
                extra: { variant: 'preview', buildCommit: 'be466eab8', buildDate: '2026-11-09' },
            });
            const production = embedded.get('production');
            expect(production).toMatchObject({ ios: { buildNumber: '1' } });
            expect(production?.extra).not.toHaveProperty('buildCommit');
            expect(production?.extra).not.toHaveProperty('buildDate');
        });
    });
});

describe('Personal Team builds', () => {
    it('are off unless asked for', () => {
        expect(iosPersonalTeam({})).toBeUndefined();
        expect(iosPersonalTeam({ SOCIO_IOS_PERSONAL_TEAM: '' })).toBeUndefined();
        expect(iosPersonalTeam({ SOCIO_IOS_PERSONAL_TEAM: '0' })).toBeUndefined();
    });

    it('take the bundle id the contributor controls', () => {
        expect(
            iosPersonalTeam({ SOCIO_IOS_PERSONAL_TEAM: '1', SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID: ' com.example.socio ' }),
        ).toEqual({ bundleIdentifier: 'com.example.socio' });
    });

    it('fail on a missing or malformed id, or a flag that is not 1', () => {
        expect(() => iosPersonalTeam({ SOCIO_IOS_PERSONAL_TEAM: '1' })).toThrow(/BUNDLE_ID/);
        expect(() =>
            iosPersonalTeam({ SOCIO_IOS_PERSONAL_TEAM: '1', SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID: 'socio' }),
        ).toThrow(/BUNDLE_ID/);
        expect(() => iosPersonalTeam({ SOCIO_IOS_PERSONAL_TEAM: 'true' })).toThrow(/use 1/);
    });

    // app.config.ts lists the strip first (checked in the introspection below), because Expo runs
    // the plugins listed later first: an entitlement added by any plugin after it is gone, and one
    // added by a plugin before it would stay.
    describe('strip the entitlements of the plugins listed after the strip, and only those', () => {
        const STRIPPED = [
            'aps-environment',
            'com.apple.developer.applesignin',
            'com.apple.security.application-groups',
            'keychain-access-groups',
        ];
        const vendored = require('../vendor/t3code/plugins/withoutIosPersonalTeamCapabilities.cjs') as ConfigPlugin;
        // The vendored strip and ours (plugins/personal-team.ts), as app.config.ts lists them.
        const strip: ConfigPlugin = (config) => withoutPersonalTeamKeychainGroups(vendored(config));
        const addAll: ConfigPlugin = (config) =>
            withEntitlementsPlist(config, (next) => {
                next.modResults['aps-environment'] = 'development';
                next.modResults['com.apple.developer.applesignin'] = ['Default'];
                next.modResults['com.apple.security.application-groups'] = ['group.com.example.socio'];
                next.modResults['keychain-access-groups'] = keychainGroups('com.example.socio');
                return next;
            });
        let root = '';

        beforeAll(() => {
            root = mkdtempSync(join(tmpdir(), 'socio-entitlements-'));
        });

        afterAll(() => {
            rmSync(root, { recursive: true, force: true });
        });

        const entitlements = async (plugins: ConfigPlugin[]) => {
            const config = withPlugins(
                {
                    name: 'Socio Dev',
                    slug: 'socio',
                    ios: { bundleIdentifier: 'com.example.socio' },
                    _internal: { projectRoot: root },
                },
                plugins,
            );
            const compiled = await compileModsAsync(config, {
                projectRoot: root,
                platforms: ['ios'],
                introspect: true,
                assertMissingModProviders: false,
            });
            return (compiled._internal?.modResults?.ios?.entitlements ?? {}) as Record<string, unknown>;
        };

        it('listed after it, as in app.config.ts: all four are gone', async () => {
            const after = await entitlements([strip, addAll]);
            for (const key of STRIPPED) {
                expect(after, key).not.toHaveProperty(key);
            }
        });

        it('listed before it: all four stay, so the strip has to come first', async () => {
            expect(Object.keys(await entitlements([addAll, strip])).sort()).toEqual([...STRIPPED].sort());
        });
    });
});

describe("T3 Code's alert dialog plugin, vendored", () => {
    it('loads without T3 Code’s generated theme, and needs both palettes', () => {
        const plugin = require('../vendor/t3code/plugins/withAndroidModernAlertDialog.cjs') as (
            config: object,
            props?: object,
        ) => object;
        const palette = { background: '#FFFFFF', text: '#000000', secondaryText: '#333333', buttonText: '#38766D' };
        expect(() => plugin({ name: 'x', slug: 'x' })).toThrow(/props\.light\.background/);
        expect(() => plugin({ name: 'x', slug: 'x' }, { light: palette, night: { ...palette, text: 'red' } })).toThrow(
            /props\.night\.text/,
        );
        expect(() => plugin({ name: 'x', slug: 'x' }, { light: palette, night: palette })).not.toThrow();
    });

    it('point every font at the system font', () => {
        for (const file of ['withAndroidModernAlertDialog.cjs', 'withAndroidModernPopupMenu.cjs']) {
            const source = readFileSync(join(app, 'vendor/t3code/plugins', file), 'utf8');
            expect(source, file).not.toMatch(/@font\/|generated-uniwind/);
        }
    });
});

describe('package.json', () => {
    // apple-targets ships an Expo module (ExtensionStorage) the app doesn't use. Autolinking leaves it
    // out; its config plugin loads by its own path either way.
    it('keeps apple-targets out of autolinking, and its config plugin still loads', () => {
        const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
        expect(pkg.devDependencies['@bacons/apple-targets']).toBe('5.0.0');
        expect(pkg.expo.autolinking.exclude).toEqual(['@bacons/apple-targets']);
        expect(typeof require('@bacons/apple-targets/app.plugin')).toBe('function');
    });

    it('builds expo-sqlite from source, since a prebuilt one has no cipher', () => {
        const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
        expect(pkg.expo.autolinking.buildFromSource).toContain('expo-sqlite');
    });

    // The root's pnpm settings (pnpm-workspace.yaml), read with the root's YAML parser.
    const rootPnpmSettings = () => {
        const { parse } = createRequire(join(app, '../../package.json'))('yaml') as {
            parse: (text: string) => unknown;
        };
        return parse(readFileSync(join(app, '../../pnpm-workspace.yaml'), 'utf8')) as {
            patchedDependencies: Record<string, string>;
            onlyBuiltDependencies: string[];
            ignoredBuiltDependencies: string[];
            overrides: Record<string, string>;
        };
    };

    // A patch (patchedDependencies in the root's pnpm-workspace.yaml) applies to the copy in
    // node_modules: iOS would link Expo's prebuilt module instead, and `expo install` would move the
    // version off the one the patch was made for.
    it('builds every patched native package from source, and keeps expo install off the patched and forked ones', () => {
        const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
        const root = rootPnpmSettings();
        const patched = Object.keys(root.patchedDependencies).map((key) => key.slice(0, key.lastIndexOf('@')));
        const appPatched = patched.filter((name) => name in pkg.dependencies);
        expect(appPatched.sort()).toEqual(['@legendapp/list', 'react-native-keyboard-controller']);
        // Each patch is keyed to the exact version the app pins.
        for (const name of appPatched) {
            expect(Object.keys(root.patchedDependencies)).toContain(`${name}@${pkg.dependencies[name]}`);
        }
        // @legendapp/list is plain JavaScript: nothing to build.
        expect(pkg.expo.autolinking.buildFromSource).toContain('react-native-keyboard-controller');
        expect(pkg.expo.install.exclude.sort()).toEqual([...appPatched, 'react-native-enriched-markdown'].sort());
    });

    // The fork's tarball carries its tree-sitter grammars (apps/mobile/deps/README.md), so its
    // postinstall, which would download them, never runs, and its math (RaTeX, a katex peer) is off.
    // So is its video player: a reply's `<video>` block would load its source.
    it('turns code highlighting on and math and video off for enriched-markdown, whose install script never runs', () => {
        const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
        const root = rootPnpmSettings();
        expect(pkg['enriched-markdown']).toEqual({ enableCodeHighlight: true, enableMath: false, enableVideo: false });
        expect(root.onlyBuiltDependencies).not.toContain('react-native-enriched-markdown');
        expect(root.ignoredBuiltDependencies).toContain('react-native-enriched-markdown');
        expect(root.overrides['react-native-enriched-markdown>katex']).toBe('-');
    });
});

// What `expo config --type introspect` reports, for the fields the tests read.
interface Introspected {
    version?: string;
    extra?: Record<string, unknown>;
    updates?: Record<string, unknown>;
    ios: { bundleIdentifier: string; usesIcloudStorage?: boolean };
    android?: { googleServicesFile?: string };
    plugins: (string | [string, unknown])[];
    _internal: {
        modResults: {
            android: {
                manifest: {
                    manifest: { application: { $: Record<string, string> }[]; 'uses-permission'?: Node[] };
                };
                gradleProperties: { type: string; key?: string; value?: string }[];
                colors: { resources: { color?: Node[] } };
                colorsNight: { resources: { color?: Node[] } };
                styles: { resources: { style: (Node & { item?: Node[] })[] } };
            };
            ios: {
                infoPlist: Record<string, unknown>;
                podfileProperties: Record<string, string>;
                entitlements: Record<string, unknown>;
            };
        };
    };
}

// Expo CLI runs with its telemetry and network off, as every expo call must.
const introspect = async (env: Record<string, string>): Promise<Introspected> => {
    const { stdout } = await run(join(app, 'node_modules/.bin/expo'), ['config', '--type', 'introspect', '--json'], {
        cwd: app,
        env: { ...baseEnv(), ...EXPO_QUIET_ENV, ...env },
        maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as Introspected;
};

const TUNNEL = 'quiet-fox-1234.trycloudflare.com';

type IntentFilter = Node & { action?: Node[]; category?: Node[]; data?: Node[] };
/** The main activity's intent filters, as the merged manifest has them. */
const intentFilters = (config: Introspected): IntentFilter[] => {
    const application = config._internal.modResults.android.manifest.manifest.application[0] as {
        activity?: (Node & { 'intent-filter'?: IntentFilter[] })[];
    };
    return application.activity?.[0]?.['intent-filter'] ?? [];
};
const dataOf = (filters: IntentFilter[]) => filters.flatMap((filter) => attrs(filter.data ?? []));

describe('the link host', () => {
    it("repeats @socio/shared's link host and variant paths exactly, the server's table", () => {
        expect(appLinks.LINK_HOST).toBe(LINK_HOST);
        expect(appLinks.LINK_STAGING_HOST).toBe(LINK_STAGING_HOST);
        expect(appLinks.VARIANT_LINK_PATHS).toEqual(VARIANT_LINK_PATHS);
    });

    it('loads at prebuild without the workspace: it imports nothing outside the app', () => {
        const source = readFileSync(join(app, 'plugins/app-links.ts'), 'utf8');
        expect([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])).toEqual(['../variant.ts']);
    });

    it('is link.socio.sh for production and preview, and link-staging for development by default', () => {
        expect(linkHost({}, 'production')).toBe(LINK_HOST);
        expect(linkHost({}, 'preview')).toBe(LINK_HOST);
        expect(linkHost({}, 'development')).toBe(LINK_STAGING_HOST);
        expect(linkHost({ SOCIO_LINK_HOST: '' }, 'preview')).toBe(LINK_HOST);
        expect(linkHost({ SOCIO_LINK_HOST: TUNNEL }, 'development')).toBe(TUNNEL);
    });

    it('takes SOCIO_LINK_HOST in development only, and only a plain host name', () => {
        for (const variant of ['preview', 'production'] as const) {
            expect(() => linkHost({ SOCIO_LINK_HOST: TUNNEL }, variant)).toThrow(/development builds only/);
        }
        for (const bad of ['https://x.example', 'x.example:8443', 'x.example/dev', 'X.Example', 'localhost', 'a..b']) {
            expect(() => linkHost({ SOCIO_LINK_HOST: bad }, 'development'), bad).toThrow(/not a host name/);
        }
    });
});

describe('the introspected Expo config', () => {
    const configs = new Map<string, Introspected>();

    beforeAll(async () => {
        const runs = [
            ...variants.map((variant) => [variant, { APP_VARIANT: variant }] as const),
            [
                'personal-team',
                {
                    APP_VARIANT: 'development',
                    SOCIO_IOS_PERSONAL_TEAM: '1',
                    SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID: 'com.example.socio',
                },
            ] as const,
            ['tunnel', { APP_VARIANT: 'development', SOCIO_LINK_HOST: TUNNEL }] as const,
            ['preview, aps development', { APP_VARIANT: 'preview', SOCIO_APS_ENVIRONMENT: 'development' }] as const,
            [
                'production, aps development',
                { APP_VARIANT: 'production', SOCIO_APS_ENVIRONMENT: 'development' },
            ] as const,
            [
                'development, aps production',
                { APP_VARIANT: 'development', SOCIO_APS_ENVIRONMENT: 'production' },
            ] as const,
            [
                'stamped',
                {
                    APP_VARIANT: 'preview',
                    SOCIO_BUILD_NUMBER: '2829',
                    SOCIO_BUILD_COMMIT: 'be466eab8',
                    SOCIO_BUILD_DATE: '2026-11-09',
                },
            ] as const,
        ];
        const results = await Promise.all(runs.map(([, env]) => introspect(env)));
        runs.forEach(([key], index) => configs.set(key, results[index]));
    }, 120_000);

    const of = (key: string) => {
        const config = configs.get(key);
        if (!config) {
            throw new Error(`no introspection for ${key}`);
        }
        return config;
    };

    it.each(variants)('%s: points the manifest at our network and backup rules', (variant) => {
        const application = of(variant)._internal.modResults.android.manifest.manifest.application[0].$;
        expect(application).toMatchObject({
            'android:networkSecurityConfig': '@xml/network_security_config',
            'android:fullBackupContent': '@xml/backup_rules',
            'android:dataExtractionRules': '@xml/data_extraction_rules',
            'android:allowBackup': 'true',
            // Predictive back, with T3 Code's compat callback for Android 13 to 15.
            'android:enableOnBackInvokedCallback': 'true',
        });
    });

    it.each(variants)('%s: turns SQLCipher and FTS on for both platforms', (variant) => {
        const { android, ios } = of(variant)._internal.modResults;
        const gradle = Object.fromEntries(
            android.gradleProperties.filter((line) => line.type === 'property').map((line) => [line.key, line.value]),
        );
        expect(gradle).toMatchObject({ 'expo.sqlite.useSQLCipher': 'true', 'expo.sqlite.enableFTS': 'true' });
        expect(ios.podfileProperties).toMatchObject({
            'expo.sqlite.useSQLCipher': 'true',
            'expo.sqlite.enableFTS': 'true',
        });
        // A third-party SQLite pod would link plain sqlite3 beside SQLCipher.
        expect(of(variant).updates?.useThirdPartySQLitePod).toBeUndefined();
        expect(Object.keys(ios.podfileProperties).filter((key) => /ThirdPartySQLite/i.test(key))).toEqual([]);
    });

    it.each(variants)('%s: records its variant in gradle.properties, for the build to check', (variant) => {
        const recorded = of(variant)._internal.modResults.android.gradleProperties.filter(
            (line) => line.key === GRADLE_VARIANT_PROPERTY,
        );
        expect(recorded.map((line) => line.value)).toEqual([variant]);
    });

    it.each([
        ['preview', '1', { buildNumber: '1', buildCommit: '', buildDate: '' }],
        ['stamped', '2829', { buildNumber: '2829', buildCommit: 'be466eab8', buildDate: '2026-11-09' }],
    ] as const)('%s: CFBundleVersion %s, and the stamp in gradle.properties and extra', (key, build, recorded) => {
        const config = of(key);
        expect(config._internal.modResults.ios.infoPlist.CFBundleVersion).toBe(build);
        const gradle = Object.fromEntries(
            config._internal.modResults.android.gradleProperties
                .filter((line) => line.type === 'property')
                .map((line) => [line.key, line.value]),
        );
        expect(gradle).toMatchObject({
            [GRADLE_STAMP_PROPERTIES.SOCIO_BUILD_NUMBER]: recorded.buildNumber,
            [GRADLE_STAMP_PROPERTIES.SOCIO_BUILD_COMMIT]: recorded.buildCommit,
            [GRADLE_STAMP_PROPERTIES.SOCIO_BUILD_DATE]: recorded.buildDate,
        });
        // Left out when unset (Expo's serializer would turn a null into {}).
        expect(config.extra?.buildCommit).toBe(recorded.buildCommit === '' ? undefined : recorded.buildCommit);
        expect(config.extra?.buildDate).toBe(recorded.buildDate === '' ? undefined : recorded.buildDate);
    });

    it.each(variants)("%s: takes its version from package.json, iOS's CFBundleShortVersionString", (variant) => {
        const config = of(variant);
        expect(config.version).toBe(packageJson.version);
        expect(config._internal.modResults.ios.infoPlist.CFBundleShortVersionString).toBe(packageJson.version);
    });

    it('fails the config on a bad SOCIO_BUILD_NUMBER', async () => {
        await expect(introspect({ SOCIO_BUILD_NUMBER: 'abc' })).rejects.toThrow(/SOCIO_BUILD_NUMBER "abc"/);
    }, 60_000);

    it.each(variants)('%s: gives Gradle a 4 GB heap', (variant) => {
        const jvmargs = of(variant)._internal.modResults.android.gradleProperties.filter(
            (line) => line.key === 'org.gradle.jvmargs',
        );
        expect(jvmargs.map((line) => line.value)).toEqual(['-Xmx4096m -XX:MaxMetaspaceSize=1024m']);
    });

    it.each(variants)('%s: sets App Transport Security for its variant', (variant) => {
        expect(of(variant)._internal.modResults.ios.infoPlist.NSAppTransportSecurity).toEqual(
            appTransportSecurity(variant),
        );
    });

    it.each(variants)('%s: the pickers ask for the camera only, with its purpose string', (variant) => {
        const { android, ios } = of(variant)._internal.modResults;
        const usage = Object.keys(ios.infoPlist).filter((key) => /^NS(Camera|Microphone|PhotoLibrary)/.test(key));
        expect(usage).toEqual(['NSCameraUsageDescription']);
        expect(ios.infoPlist.NSCameraUsageDescription).toBe(CAMERA_PURPOSE);
        // No iCloud container for the document picker.
        expect(of(variant).ios.usesIcloudStorage).toBeFalsy();
        expect(Object.keys(ios.entitlements).filter((key) => /icloud|ubiquity/i.test(key))).toEqual([]);

        const permissions = attrs(android.manifest.manifest['uses-permission'] ?? []);
        const removed = permissions.filter((at) => at?.['tools:node'] === 'remove').map((at) => at?.['android:name']);
        expect(new Set(removed)).toEqual(new Set(BLOCKED_PERMISSIONS));
        for (const name of ['RECORD_AUDIO', 'READ_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO']) {
            expect(removed).toContain(`android.permission.${name}`);
        }
        const held = permissions.filter((at) => at?.['tools:node'] !== 'remove').map((at) => at?.['android:name']);
        expect(held.filter((name) => /RECORD_AUDIO|READ_MEDIA_|EXTERNAL_STORAGE/.test(name ?? ''))).toEqual([]);
    });

    it.each(variants)('%s: push: its APNs environment, the keychain groups in order, no background mode', (variant) => {
        const { ios } = of(variant)._internal.modResults;
        const id = VARIANTS[variant].id;
        expect(ios.entitlements['aps-environment']).toBe(variant === 'development' ? 'development' : 'production');
        expect(apsEnvironment(undefined, variant)).toBe(ios.entitlements['aps-environment']);
        expect(of(variant).extra?.apsEnvironment).toBe(ios.entitlements['aps-environment']);
        // The app's own group first: expo-secure-store writes there, where an earlier build's items are.
        expect(ios.entitlements['keychain-access-groups']).toEqual([
            `$(AppIdentifierPrefix)${id}`,
            `$(AppIdentifierPrefix)${id}${SHARED_KEYCHAIN_SUFFIX}`,
        ]);
        expect(ios.infoPlist.UIBackgroundModes ?? []).not.toContain('remote-notification');
        // modules/socio-push reads where its items go from these (its README, Groups).
        expect(ios.infoPlist).toMatchObject({
            SocioPushKeychainGroupSuffix: SHARED_KEYCHAIN_SUFFIX,
            SocioPushAppGroup: `group.${id}`,
        });
        expect(pushInfoPlist(id)).toEqual({
            SocioPushKeychainGroupSuffix: SHARED_KEYCHAIN_SUFFIX,
            SocioPushAppGroup: appGroup(id),
        });
        const plugin = of(variant).plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-notifications');
        expect(plugin?.[1]).toEqual({
            icon: NOTIFICATION_ICON,
            color: NOTIFICATION_COLOR,
            mode: apsEnvironment(undefined, variant),
            enableBackgroundRemoteNotifications: false,
        });
        // Unset, nothing is recorded for the native builds to check.
        const gradle = of(variant)._internal.modResults.android.gradleProperties.filter(
            (line) => line.key === GRADLE_APS_ENVIRONMENT_PROPERTY,
        );
        expect(gradle.map((line) => line.value)).toEqual(['']);
    });

    it.each([
        ['preview, aps development', 'development'],
        ['production, aps development', 'development'],
        ['development, aps production', 'production'],
    ] as const)('%s: SOCIO_APS_ENVIRONMENT sets the entitlement, extra and gradle.properties', (key, aps) => {
        const config = of(key);
        expect(config._internal.modResults.ios.entitlements['aps-environment']).toBe(aps);
        expect(config.extra?.apsEnvironment).toBe(aps);
        const plugin = config.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-notifications');
        expect((plugin?.[1] as { mode?: string } | undefined)?.mode).toBe(aps);
        const gradle = config._internal.modResults.android.gradleProperties.filter(
            (line) => line.key === GRADLE_APS_ENVIRONMENT_PROPERTY,
        );
        expect(gradle.map((line) => line.value)).toEqual([aps]);
    });

    it('fails the config on a bad SOCIO_APS_ENVIRONMENT', async () => {
        await expect(introspect({ APP_VARIANT: 'preview', SOCIO_APS_ENVIRONMENT: 'sandbox' })).rejects.toThrow(
            /SOCIO_APS_ENVIRONMENT "sandbox"/,
        );
    }, 60_000);

    it.each(variants)('%s: push: Firebase sends nothing on its own, and nothing restarts after a reboot', (variant) => {
        const { android } = of(variant)._internal.modResults;
        const application = android.manifest.manifest.application[0] as { 'meta-data'?: Node[] };
        const meta = Object.fromEntries(
            attrs(application['meta-data'] ?? []).map((at) => [at?.['android:name'], at?.['android:value']]),
        );
        expect(meta).toMatchObject(FIREBASE_META_DATA);
        expect(FIREBASE_META_DATA).toEqual({
            firebase_messaging_auto_init_enabled: 'false',
            firebase_analytics_collection_deactivated: 'true',
            delivery_metrics_exported_to_big_query_enabled: 'false',
        });
        const permissions = attrs(android.manifest.manifest['uses-permission'] ?? []);
        expect(permissions).toContainEqual({
            'android:name': 'android.permission.RECEIVE_BOOT_COMPLETED',
            'tools:node': 'remove',
        });
        // No google-services.json named here: the build has no FCM (plugins/push.ts says so).
        expect(of(variant).android?.googleServicesFile).toBeUndefined();
    });

    it.each(variants)('%s: names its variant in extra', (variant) => {
        expect(of(variant).extra?.variant).toBe(variant);
    });

    it.each(variants)('%s: themes the alert dialog and popup menu in both schemes', (variant) => {
        const { colors, colorsNight, styles } = of(variant)._internal.modResults.android;
        const names = (resources: { color?: Node[] }) => (resources.color ?? []).map((color) => color.$?.name);
        for (const resources of [colors.resources, colorsNight.resources]) {
            expect(names(resources)).toEqual(
                expect.arrayContaining([
                    'alert_dialog_background',
                    'alert_dialog_text',
                    'alert_dialog_secondary_text',
                    'alert_dialog_button_text',
                    'popup_menu_background',
                    'popup_menu_item_text',
                ]),
            );
        }
        const theme = styles.resources.style.find((style) => style.$?.name === 'AppTheme');
        const items = Object.fromEntries((theme?.item ?? []).map((item) => [item.$?.name, item._]));
        expect(items).toMatchObject({
            alertDialogTheme: '@style/AppAlertDialog',
            'android:alertDialogTheme': '@style/AppAlertDialog',
            popupMenuStyle: '@style/AppPopupMenu',
        });
    });

    it.each(variants)('%s: keeps its own bundle id and no Personal Team changes', (variant) => {
        expect(of(variant).ios.bundleIdentifier).toBe(VARIANTS[variant].id);
        const plugins = of(variant).plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
        expect(plugins.filter((plugin) => plugin.includes('PersonalTeam'))).toEqual([]);
        expect(plugins).not.toContain('./plugins/personal-team.ts');
        expect(plugins).toEqual(expect.arrayContaining(['expo-sqlite', 'expo-secure-store', 'expo-system-ui']));
    });

    const hostOf = (variant: VariantName) => (variant === 'development' ? LINK_STAGING_HOST : LINK_HOST);
    const ownPrefix = (variant: VariantName) => `/${VARIANT_LINK_PATHS[variant]}/`;

    it.each(variants)('%s: iOS associates both services with the link host, and nothing else', (variant) => {
        const mode = variant === 'development' ? '?mode=developer' : '';
        expect(of(variant)._internal.modResults.ios.entitlements['com.apple.developer.associated-domains']).toEqual([
            `webcredentials:${hostOf(variant)}${mode}`,
            `applinks:${hostOf(variant)}${mode}`,
        ]);
    });

    it.each(variants)('%s: Android verifies its own path on the link host, and claims no other', (variant) => {
        const filters = intentFilters(of(variant));
        const https = filters.filter((filter) =>
            attrs(filter.data ?? []).some((at) => at?.['android:scheme'] === 'https'),
        );
        expect(https).toHaveLength(1);
        expect(https[0].$).toMatchObject({ 'android:autoVerify': 'true' });
        expect(attrs(https[0].data ?? [])).toEqual([
            { 'android:scheme': 'https', 'android:host': hostOf(variant), 'android:pathPrefix': ownPrefix(variant) },
        ]);
        expect(attrs(https[0].action ?? [])).toEqual([{ 'android:name': 'android.intent.action.VIEW' }]);
        expect(new Set(attrs(https[0].category ?? []).map((at) => at?.['android:name']))).toEqual(
            new Set(['android.intent.category.BROWSABLE', 'android.intent.category.DEFAULT']),
        );
        // No other variant's prefix, no path pattern or bare host that would cover it.
        const claimed = dataOf(filters).filter((at) => at?.['android:host'] !== undefined);
        for (const at of claimed) {
            expect(at?.['android:pathPrefix'], JSON.stringify(at)).toBe(ownPrefix(variant));
            expect(at).not.toHaveProperty('android:pathPattern');
            expect(at).not.toHaveProperty('android:path');
        }
    });

    it.each(variants)("%s: names its link host and its sheet's callback in extra", (variant) => {
        expect(of(variant).extra).toMatchObject({
            linkHost: hostOf(variant),
            authCallback: `https://${hostOf(variant)}/${VARIANT_LINK_PATHS[variant]}/cb`,
        });
    });

    it.each(['preview', 'production'] as const)(
        "%s: never registers development's custom scheme or its sheet callback",
        (variant) => {
            const config = of(variant);
            const types = (config._internal.modResults.ios.infoPlist.CFBundleURLTypes ?? []) as {
                CFBundleURLSchemes?: string[];
            }[];
            const iosSchemes = types.flatMap((type) => type.CFBundleURLSchemes ?? []);
            const androidSchemes = dataOf(intentFilters(config)).map((at) => at?.['android:scheme']);
            for (const schemes of [iosSchemes, androidSchemes]) {
                expect(schemes).toContain(VARIANTS[variant].scheme);
                expect(schemes).not.toContain(VARIANTS.development.scheme);
            }
            expect(JSON.stringify(config.extra)).not.toContain('auth-callback');
            expect(JSON.stringify(config._internal.modResults)).not.toContain('socio-dev');
        },
    );

    it('development on a quick tunnel: its host everywhere, in developer mode, and recorded for Gradle', () => {
        const config = of('tunnel');
        expect(config._internal.modResults.ios.entitlements['com.apple.developer.associated-domains']).toEqual([
            `webcredentials:${TUNNEL}?mode=developer`,
            `applinks:${TUNNEL}?mode=developer`,
        ]);
        expect(dataOf(intentFilters(config))).toContainEqual({
            'android:scheme': 'https',
            'android:host': TUNNEL,
            'android:pathPrefix': '/dev/',
        });
        expect(config.extra).toMatchObject({ linkHost: TUNNEL, authCallback: `https://${TUNNEL}/dev/cb` });
        const gradle = config._internal.modResults.android.gradleProperties.filter(
            (line) => line.key === GRADLE_LINK_HOST_PROPERTY,
        );
        expect(gradle.map((line) => line.value)).toEqual([TUNNEL]);
        expect(
            of('development')
                ._internal.modResults.android.gradleProperties.filter((line) => line.key === GRADLE_LINK_HOST_PROPERTY)
                .map((line) => line.value),
        ).toEqual(['']);
    });

    it('fails the config on SOCIO_LINK_HOST outside development', async () => {
        await expect(introspect({ APP_VARIANT: 'preview', SOCIO_LINK_HOST: TUNNEL })).rejects.toThrow(
            /SOCIO_LINK_HOST is for development builds only/,
        );
    }, 60_000);

    it("a development Personal Team build: no associated domains, and the sheet's custom-scheme callback", () => {
        const config = of('personal-team');
        expect(config._internal.modResults.ios.entitlements).not.toHaveProperty(
            'com.apple.developer.associated-domains',
        );
        expect(config.extra).toMatchObject({ linkHost: LINK_STAGING_HOST, authCallback: 'socio-dev://auth-callback' });
    });

    it('builds a Personal Team build under the given bundle id, stripping after every other plugin', () => {
        const config = of('personal-team');
        expect(config.ios.bundleIdentifier).toBe('com.example.socio');
        const plugins = config.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
        // First, so its mod runs last (the Personal Team tests above).
        expect(plugins[0]).toBe('./vendor/t3code/plugins/withoutIosPersonalTeamCapabilities.cjs');
        expect(plugins[1]).toBe('./plugins/personal-team.ts');
        expect(plugins.filter((plugin) => plugin.includes('PersonalTeam'))).toHaveLength(1);
        // No push, no keychain groups: the items stay in the app's default group.
        expect(Object.keys(config._internal.modResults.ios.entitlements)).toEqual([]);
        // Nor socio-push's keys: its keys stay in the app's own group, and there is no inbox.
        for (const key of PUSH_INFO_PLIST_KEYS) {
            expect(config._internal.modResults.ios.infoPlist).not.toHaveProperty(key);
        }
    });
});

describe("the Android tab bar's icons", () => {
    it('are the tab table’s lucide icons, each a drawable named as the table names it', () => {
        expect([...TAB_ICONS]).toEqual(TAB_LUCIDE_ICONS);
        for (const icon of TAB_ICONS) {
            expect(tabIconResource(icon)).toBe(tabDrawable(icon));
        }
    });

    it('draws each as lucide’s outline: white strokes, 2 wide, round, on a 24 viewport', async () => {
        for (const icon of TAB_ICONS) {
            const xml = vectorDrawable(lucideNode(app, icon));
            const vector = (await parse(xml)).vector!;
            expect(vector.$).toMatchObject({ 'android:viewportWidth': '24', 'android:viewportHeight': '24' });
            const paths = attrs(children(vector, 'path'));
            expect(paths.length, icon).toBeGreaterThan(0);
            for (const path of paths) {
                expect(path).toMatchObject({
                    'android:strokeColor': '#FFFFFFFF',
                    'android:strokeWidth': '2',
                    'android:strokeLineCap': 'round',
                    'android:fillColor': '#00000000',
                });
                expect(path?.['android:pathData'], icon).toMatch(/^[Mm]/);
            }
        }
    });

    it('turns lucide’s shapes into path data', () => {
        expect(elementPath('circle', { cx: 12, cy: 12, r: 3 })).toBe('M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0');
        expect(elementPath('line', { x1: 1, y1: 2, x2: 3, y2: 4 })).toBe('M1 2L3 4');
        expect(elementPath('polyline', { points: '1 2 3 4 5 6' })).toBe('M1 2L3 4L5 6');
        expect(elementPath('rect', { x: 2, y: 2, width: 4, height: 4 })).toBe('M2 2h4v4h-4z');
        expect(elementPath('rect', { x: 0, y: 0, width: 10, height: 6, rx: 2 })).toMatch(/^M2 0h6a2 2 0 0 1 2 2v2/);
        expect(() => elementPath('text', {})).toThrow(/can't draw/);
    });

    it('writes them at prebuild, listed in app.config.ts', () => {
        expect(readFileSync(join(app, 'app.config.ts'), 'utf8')).toContain("'./plugins/tab-icons.ts',");
    });
});

describe('google-services.json', () => {
    let root = '';

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'socio-google-services-'));
        writeFileSync(join(root, 'google-services.json'), '{}\n');
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('is read from the path GOOGLE_SERVICES_JSON names, relative to the app or absolute', () => {
        expect(googleServicesFile({}, root)).toBeUndefined();
        expect(googleServicesFile({ GOOGLE_SERVICES_JSON: ' ' }, root)).toBeUndefined();
        expect(googleServicesFile({ GOOGLE_SERVICES_JSON: 'google-services.json' }, root)).toBe(
            join(root, 'google-services.json'),
        );
        expect(googleServicesFile({ GOOGLE_SERVICES_JSON: join(root, 'google-services.json') }, '/')).toBe(
            join(root, 'google-services.json'),
        );
    });

    it('fails on a path with no file, so a typo never builds an app without push', () => {
        expect(() => googleServicesFile({ GOOGLE_SERVICES_JSON: 'missing.json' }, root)).toThrow(/no file/);
    });

    // CI's copy has no .git, so this reads the rule rather than asking git.
    it('is never committed', () => {
        expect(readFileSync(join(app, '.gitignore'), 'utf8').split('\n')).toContain('google-services.json');
    });

    // The warning lives in the Android mod: `expo config` and an iOS-only prebuild stay quiet.
    describe("missing, it's reported only by a prebuild that makes the Android project", () => {
        const warnings = async (platform: 'ios' | 'android', file?: string) => {
            const projectRoot = mkdtempSync(join(root, `${platform}-`));
            const manifest = join(projectRoot, 'android/app/src/main/AndroidManifest.xml');
            mkdirSync(dirname(manifest), { recursive: true });
            writeFileSync(
                manifest,
                '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <application android:name=".MainApplication"/>\n</manifest>\n',
            );
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            try {
                const config = withPush({
                    name: 'Socio',
                    slug: 'socio',
                    ios: { bundleIdentifier: 'com.example.socio' },
                    android: { package: 'com.example.socio', googleServicesFile: file },
                    _internal: { projectRoot },
                });
                const applied = warn.mock.calls.length;
                await compileModsAsync(config, {
                    projectRoot,
                    platforms: [platform],
                    introspect: platform === 'ios',
                    assertMissingModProviders: false,
                });
                const fcm = warn.mock.calls.filter((call) => String(call[0]).includes(NO_FCM_WARNING));
                return { applied, fcm: fcm.length };
            } finally {
                warn.mockRestore();
            }
        };

        it('not when the plugin is applied, nor by an iOS prebuild', async () => {
            expect(await warnings('ios')).toEqual({ applied: 0, fcm: 0 });
        });

        it('by an Android prebuild, once', async () => {
            expect(await warnings('android')).toEqual({ applied: 0, fcm: 1 });
        });

        it('not when GOOGLE_SERVICES_JSON names the file', async () => {
            expect(await warnings('android', join(root, 'google-services.json'))).toEqual({ applied: 0, fcm: 0 });
        });
    });
});

describe("the native menus' Gradle block (CB-421)", () => {
    it("builds @react-native-menu/menu on the root's Android Gradle and Kotlin plugins, once per prebuild", async () => {
        const { MENU_GRADLE_BLOCK, MENU_GRADLE_PROJECT, withMenuBlock } = await import('../plugins/menu-gradle');
        const root = 'buildscript {\n}\n\napply plugin: "expo-root-project"\n';
        const once = withMenuBlock(root);
        expect(once.startsWith(root.trimEnd())).toBe(true);
        expect(once.endsWith(MENU_GRADLE_BLOCK)).toBe(true);
        expect(withMenuBlock(once)).toBe(once);
        expect(MENU_GRADLE_BLOCK).toContain(`sub.name == '${MENU_GRADLE_PROJECT}'`);
        expect(MENU_GRADLE_BLOCK).toContain(
            "d.requested.group == 'com.android.tools.build' && d.requested.name == 'gradle'",
        );
        expect(MENU_GRADLE_BLOCK).toContain("d.requested.name == 'kotlin-gradle-plugin'");
        // The library's own buildscript is what it overrides.
        const library = readFileSync(
            createRequire(import.meta.url).resolve('@react-native-menu/menu/android/build.gradle'),
            'utf8',
        );
        expect(library).toContain('classpath "com.android.tools.build:gradle:');
        expect(readFileSync(join(import.meta.dirname, '../app.config.ts'), 'utf8')).toContain(
            "'./plugins/menu-gradle.ts',",
        );
    });
});

describe("the date picker's Gradle block (CB-469)", () => {
    it('builds @react-native-community/datetimepicker on the Material Components the app ships, once per prebuild', async () => {
        const {
            APP_ANDROID_VERSIONS,
            DATETIMEPICKER_GRADLE_BLOCK,
            DATETIMEPICKER_GRADLE_PROJECT,
            withDatetimepickerBlock,
        } = await import('../plugins/datetimepicker-gradle');
        const root = 'buildscript {\n}\n\napply plugin: "expo-root-project"\n';
        const once = withDatetimepickerBlock(root);
        expect(once.endsWith(DATETIMEPICKER_GRADLE_BLOCK)).toBe(true);
        expect(withDatetimepickerBlock(once)).toBe(once);
        expect(DATETIMEPICKER_GRADLE_BLOCK).toContain(`sub.name == '${DATETIMEPICKER_GRADLE_PROJECT}'`);
        const require = createRequire(import.meta.url);
        // The library asks for its own Material Components; react-native-screens' is the app's.
        expect(
            readFileSync(require.resolve('@react-native-community/datetimepicker/android/build.gradle'), 'utf8'),
        ).toMatch(/com\.google\.android\.material:material:/);
        const screens = readFileSync(require.resolve('react-native-screens/android/build.gradle'), 'utf8');
        for (const [module, version] of Object.entries(APP_ANDROID_VERSIONS)) {
            const [group, name] = module.split(':');
            // A module the app takes through its -ktx twin (androidx.core:core) counts by the twin.
            const asked = new RegExp(
                `${group!.replace(/\./g, '\\.')}:${name === '*' ? '[a-z-]+' : `${name}(-ktx)?`}:${version.replace(/\./g, '\\.')}`,
            );
            expect(screens, module).toMatch(asked);
            expect(DATETIMEPICKER_GRADLE_BLOCK).toContain(`'${module}': '${version}'`);
        }
        expect(readFileSync(join(import.meta.dirname, '../app.config.ts'), 'utf8')).toContain(
            "'./plugins/datetimepicker-gradle.ts',",
        );
    });
});
