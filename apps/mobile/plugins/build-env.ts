import fs from 'node:fs';
import path from 'node:path';

import {
    type ConfigPlugin,
    withAppBuildGradle,
    withDangerousMod,
    withGradleProperties,
    withPodfile,
} from 'expo/config-plugins';

import { type ApsEnvironment, defaultApsEnvironment } from '../aps-environment.ts';
import type { BuildStamp } from '../build-stamp.ts';
import type { VariantName } from '../variant.ts';

import { linkHost as pickLinkHost } from './app-links.ts';
import type { PersonalTeam } from './personal-team.ts';
import { GOOGLE_IOS_CLIENT_ID_VARIABLES } from './social-sign-in.ts';

const defaultLinkHost = (variant: VariantName) => pickLinkHost({}, variant);

// What native builds run Expo CLI and node with.
//
// - Release builds bundle the JavaScript with Expo CLI: Xcode's "Bundle React Native code and
//   images" phase sources `ios/.xcode.env` and runs `expo export:embed`. So `.xcode.env` exports
//   the same switches the package scripts set, and an Xcode build is quiet whoever starts it.
//   Gradle runs the same command with Gradle's environment: the README's build commands set them.
// - `pod install` sends usage stats to CocoaPods unless COCOAPODS_DISABLE_STATS is set. The Podfile
//   sets it, so `expo prebuild`, `expo run:ios` and a plain `pod install` all skip them.
// - Every build reads app.config.ts again: expo-constants embeds the config the app sees at runtime
//   (`extra.variant` included), and `expo export:embed` bundles with it. It has to see the
//   environment the prebuild saw, or a production project ships the development config. Xcode's
//   script phases get it from `.xcode.env` too: APP_VARIANT, and the Personal Team variables (or
//   their absence). Gradle has no such file, so the project records its variant in
//   gradle.properties (`socio.appVariant`) and the app's build.gradle fails when APP_VARIANT
//   differs.
// - The build stamp (build-stamp.ts) the same way: `.xcode.env` exports the prebuild's
//   SOCIO_BUILD_NUMBER, SOCIO_BUILD_COMMIT and SOCIO_BUILD_DATE, so the embedded config's
//   `extra.buildCommit` and `extra.buildDate` are the prebuild's; gradle.properties records them
//   (`socio.build*`) and the app's build.gradle fails when Gradle's environment differs.
// - The push relay's origin (relay-origin.ts, `extra.relayOrigin`) the same way: SOCIO_RELAY_ORIGIN
//   in `.xcode.env`, `socio.relayOrigin` in gradle.properties, checked with the stamp.
// - The link host (plugins/app-links.ts, `extra.linkHost`) the same way: a development prebuild's
//   SOCIO_LINK_HOST in `.xcode.env` and `socio.linkHost` in gradle.properties, checked with the
//   stamp, so the embedded config names the host the entitlements and intent filters were made for.
// - The APNs environment (aps-environment.ts, `extra.apsEnvironment`) the same way: a prebuild's
//   SOCIO_APS_ENVIRONMENT, when it isn't the variant's default, in `.xcode.env` and
//   `socio.apsEnvironment` in gradle.properties, checked with the stamp, so the embedded config
//   says the environment the `aps-environment` entitlement was made for.
// - The iOS Google client id (plugins/social-sign-in.ts, `extra.googleIosClientId`) the same way: the
//   variant's SOCIO_GOOGLE_IOS_CLIENT_ID or SOCIO_GOOGLE_IOS_PREVIEW_CLIENT_ID in `.xcode.env` (a
//   generated file, never committed), so the embedded config keeps the id the URL scheme was made
//   for. Android doesn't use it, so Gradle records nothing.
//
// Each change is a marked block that a rerun replaces, so prebuild stays idempotent.

/** What Expo CLI reads to send no telemetry, make no network requests and track nothing. */
export const EXPO_QUIET_ENV = { EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', DO_NOT_TRACK: '1' } as const;

/** The gradle.properties key that holds the variant the Android project was generated for. */
export const GRADLE_VARIANT_PROPERTY = 'socio.appVariant';

/** The gradle.properties keys that hold the build stamp the Android project was generated with. */
export const GRADLE_STAMP_PROPERTIES = {
    SOCIO_BUILD_NUMBER: 'socio.buildNumber',
    SOCIO_BUILD_COMMIT: 'socio.buildCommit',
    SOCIO_BUILD_DATE: 'socio.buildDate',
} as const;

/** The gradle.properties key that holds the relay origin the Android project was generated with. */
export const GRADLE_RELAY_PROPERTY = 'socio.relayOrigin';

/** The gradle.properties key that holds the SOCIO_LINK_HOST the Android project was generated with ('' when unset). */
export const GRADLE_LINK_HOST_PROPERTY = 'socio.linkHost';

/** The gradle.properties key that holds the SOCIO_APS_ENVIRONMENT the Android project was generated with ('' when unset). */
export const GRADLE_APS_ENVIRONMENT_PROPERTY = 'socio.apsEnvironment';

/** The variables build.gradle checks against gradle.properties: the stamp's, the relay origin, the link host and the APNs environment. */
const GRADLE_CHECKED_PROPERTIES = {
    ...GRADLE_STAMP_PROPERTIES,
    SOCIO_RELAY_ORIGIN: GRADLE_RELAY_PROPERTY,
    SOCIO_LINK_HOST: GRADLE_LINK_HOST_PROPERTY,
    SOCIO_APS_ENVIRONMENT: GRADLE_APS_ENVIRONMENT_PROPERTY,
} as const;

export interface BuildEnvOptions {
    variant: VariantName;
    /** The Personal Team build the prebuild made, if it made one. */
    personalTeam?: PersonalTeam;
    /** The build number, commit and date the prebuild saw; none means build 1 with neither. */
    stamp?: BuildStamp;
    /** The push relay's origin the prebuild saw (relay-origin.ts); none means unset. */
    relayOrigin?: string | null;
    /**
     * The link host the prebuild picked (plugins/app-links.ts). Recorded as SOCIO_LINK_HOST only when
     * it isn't the variant's default, which is what an unset SOCIO_LINK_HOST gives again.
     */
    linkHost?: string;
    /**
     * The APNs environment the prebuild resolved (aps-environment.ts). Recorded as
     * SOCIO_APS_ENVIRONMENT only when it isn't the variant's default, which an unset one gives again.
     */
    apsEnvironment?: ApsEnvironment;
    /** The iOS Google client id the prebuild read for the variant (plugins/social-sign-in.ts); none means unset. */
    googleIosClientId?: string | null;
}

/** `.xcode.env`'s lines for the iOS Google client id: both variables unset, then the variant's, when it has one. */
export function googleXcodeEnvLines(variant: VariantName, clientId: string | null | undefined): string[] {
    const name = GOOGLE_IOS_CLIENT_ID_VARIABLES[variant];
    const names = Object.values(GOOGLE_IOS_CLIENT_ID_VARIABLES).filter((value) => value !== null);
    return [`unset ${names.join(' ')}`, ...(name !== null && clientId ? [`export ${name}=${clientId}`] : [])];
}

/** The SOCIO_APS_ENVIRONMENT a build must see to resolve `aps` again: '' for the variant's default. */
export function apsEnvironmentVariable(variant: VariantName, aps: ApsEnvironment | undefined): string {
    return aps === undefined || aps === defaultApsEnvironment(variant) ? '' : aps;
}

/** The SOCIO_LINK_HOST a build must see to pick `linkHost` again: '' for the variant's default. */
export function linkHostVariable(variant: VariantName, linkHost: string | undefined): string {
    return linkHost === undefined || linkHost === defaultLinkHost(variant) ? '' : linkHost;
}

/** The stamp's variables as the prebuild saw them, normalized: unset ones are ''. */
export function stampVariables(stamp: BuildStamp | undefined): Record<keyof typeof GRADLE_STAMP_PROPERTIES, string> {
    return {
        SOCIO_BUILD_NUMBER: String(stamp?.buildNumber ?? 1),
        SOCIO_BUILD_COMMIT: stamp?.commit ?? '',
        SOCIO_BUILD_DATE: stamp?.date ?? '',
    };
}

/** `contents` with one marked block named `tag` holding `lines`: replaced where it exists, otherwise placed `at` the start or end. `comment` starts a comment line in the file's language. */
export function withBlock(
    contents: string,
    tag: string,
    lines: readonly string[],
    at: 'start' | 'end',
    comment = '#',
): string {
    const beginMarker = `${comment} @socio begin ${tag}`;
    const endMarker = `${comment} @socio end ${tag}`;
    const block = [beginMarker, ...lines, endMarker].join('\n');
    const begin = contents.indexOf(`${beginMarker}\n`);
    const end = begin === -1 ? -1 : contents.indexOf(endMarker, begin);
    if (begin !== -1 && end !== -1) {
        return contents.slice(0, begin) + block + contents.slice(end + endMarker.length);
    }
    if (at === 'start') {
        return `${block}\n\n${contents}`;
    }
    return `${contents.replace(/\n*$/, '\n')}\n${block}\n`;
}

/** `ios/.xcode.env` with Expo CLI's telemetry and network turned off for Xcode's script phases. */
export function quietXcodeEnv(contents: string): string {
    return withBlock(
        contents,
        'expo-quiet',
        [
            '# Release builds bundle with Expo CLI (expo export:embed): no telemetry, no network.',
            ...Object.entries(EXPO_QUIET_ENV).map(([name, value]) => `export ${name}=${value}`),
        ],
        'end',
    );
}

/** `ios/.xcode.env` with the environment app.config.ts saw at prebuild, for the script phases that read it again. */
export function variantXcodeEnv(
    contents: string,
    { variant, personalTeam, stamp, relayOrigin, linkHost, apsEnvironment, googleIosClientId }: BuildEnvOptions,
): string {
    const links = linkHostVariable(variant, linkHost);
    const aps = apsEnvironmentVariable(variant, apsEnvironment);
    const stampLines = Object.entries(stampVariables(stamp)).map(([name, value]) =>
        value === '' ? `unset ${name}` : `export ${name}=${value}`,
    );
    return withBlock(
        contents,
        'app-variant',
        [
            '# The build reads app.config.ts again (expo-constants, expo export:embed): the prebuild env.',
            `export APP_VARIANT=${variant}`,
            ...(personalTeam
                ? [
                      'export SOCIO_IOS_PERSONAL_TEAM=1',
                      `export SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID=${personalTeam.bundleIdentifier}`,
                  ]
                : ['unset SOCIO_IOS_PERSONAL_TEAM SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID']),
            ...stampLines,
            relayOrigin ? `export SOCIO_RELAY_ORIGIN=${relayOrigin}` : 'unset SOCIO_RELAY_ORIGIN',
            links ? `export SOCIO_LINK_HOST=${links}` : 'unset SOCIO_LINK_HOST',
            aps ? `export SOCIO_APS_ENVIRONMENT=${aps}` : 'unset SOCIO_APS_ENVIRONMENT',
            ...googleXcodeEnvLines(variant, googleIosClientId),
        ],
        'end',
    );
}

/** The Podfile with CocoaPods' usage stats turned off before anything installs. */
export function quietPodfile(contents: string): string {
    return withBlock(
        contents,
        'cocoapods-stats',
        ["# No usage stats to CocoaPods from any 'pod install'.", "ENV['COCOAPODS_DISABLE_STATS'] = 'true'"],
        'start',
    );
}

/** `android/app/build.gradle`, failing the build when APP_VARIANT isn't the one in gradle.properties. */
export function variantCheckGradle(contents: string): string {
    return withBlock(
        contents,
        'app-variant',
        [
            '// The build reads app.config.ts again (expo-constants, expo export:embed), so it needs the',
            '// APP_VARIANT this project was generated for. Unset means development, as in variant.ts.',
            `def socioProjectVariant = findProperty('${GRADLE_VARIANT_PROPERTY}')`,
            "def socioBuildVariant = System.getenv('APP_VARIANT') ?: 'development'",
            'if (socioBuildVariant != socioProjectVariant) {',
            '    throw new GradleException(',
            '        "android/ was generated for APP_VARIANT=${socioProjectVariant}, but this build has APP_VARIANT=${socioBuildVariant}. " +',
            '        "Build with APP_VARIANT=${socioProjectVariant}, or run expo prebuild again for ${socioBuildVariant}."',
            '    )',
            '}',
        ],
        'end',
        '//',
    );
}

/** `android/app/build.gradle`, failing the build when the build stamp's variables aren't the ones in gradle.properties. */
export function stampCheckGradle(contents: string): string {
    return withBlock(
        contents,
        'build-stamp',
        [
            '// The embedded config (expo-constants) reads SOCIO_BUILD_NUMBER, SOCIO_BUILD_COMMIT,',
            '// SOCIO_BUILD_DATE, SOCIO_RELAY_ORIGIN, SOCIO_LINK_HOST and SOCIO_APS_ENVIRONMENT again: they must be the',
            '// ones this project was generated with (build-stamp.ts, relay-origin.ts, plugins/app-links.ts,',
            '// aps-environment.ts). Unset SOCIO_BUILD_NUMBER means 1; the',
            '// others are compared as given, a commit in lowercase.',
            '[',
            ...Object.entries(GRADLE_CHECKED_PROPERTIES).map(([name, property]) => `    '${name}': '${property}',`),
            '].each { socioName, socioProperty ->',
            "    def socioProject = (findProperty(socioProperty) ?: '').toString()",
            "    def socioBuild = System.getenv(socioName) ?: (socioName == 'SOCIO_BUILD_NUMBER' ? '1' : '')",
            "    if (socioName == 'SOCIO_BUILD_COMMIT') { socioBuild = socioBuild.toLowerCase() }",
            '    if (socioBuild != socioProject) {',
            '        throw new GradleException(',
            '            "android/ was generated with ${socioName}=${socioProject}, but this build has ${socioName}=${socioBuild}. " +',
            '            "Build with the same value, or run expo prebuild again."',
            '        )',
            '    }',
            '}',
        ],
        'end',
        '//',
    );
}

const withNativeBuildEnv: ConfigPlugin<BuildEnvOptions> = (config, options) => {
    const withXcodeEnv = withDangerousMod(config, [
        'ios',
        (next) => {
            const file = path.join(next.modRequest.platformProjectRoot, '.xcode.env');
            const contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
            fs.writeFileSync(file, variantXcodeEnv(quietXcodeEnv(contents), options));
            return next;
        },
    ]);
    const withQuietPodfile = withPodfile(withXcodeEnv, (next) => {
        next.modResults.contents = quietPodfile(next.modResults.contents);
        return next;
    });
    const withVariantProperty = withGradleProperties(withQuietPodfile, (next) => {
        const others = next.modResults.filter(
            (item) => !(item.type === 'property' && item.key === GRADLE_VARIANT_PROPERTY),
        );
        const stampKeys = new Set<string>(Object.values(GRADLE_CHECKED_PROPERTIES));
        const variables = stampVariables(options.stamp);
        next.modResults = [
            ...others.filter((item) => !(item.type === 'property' && stampKeys.has(item.key))),
            { type: 'property', key: GRADLE_VARIANT_PROPERTY, value: options.variant },
            ...Object.entries(GRADLE_STAMP_PROPERTIES).map(([name, key]) => ({
                type: 'property' as const,
                key,
                value: variables[name as keyof typeof GRADLE_STAMP_PROPERTIES],
            })),
            { type: 'property', key: GRADLE_RELAY_PROPERTY, value: options.relayOrigin ?? '' },
            {
                type: 'property',
                key: GRADLE_LINK_HOST_PROPERTY,
                value: linkHostVariable(options.variant, options.linkHost),
            },
            {
                type: 'property',
                key: GRADLE_APS_ENVIRONMENT_PROPERTY,
                value: apsEnvironmentVariable(options.variant, options.apsEnvironment),
            },
        ];
        return next;
    });
    return withAppBuildGradle(withVariantProperty, (next) => {
        if (next.modResults.language !== 'groovy') {
            throw new Error(
                `android/app/build.gradle is ${next.modResults.language}: the APP_VARIANT check is Groovy.`,
            );
        }
        next.modResults.contents = stampCheckGradle(variantCheckGradle(next.modResults.contents));
        return next;
    });
};

export default withNativeBuildEnv;
