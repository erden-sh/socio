import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { appBuild } from '../../modules/socio-device';
import { type BuildInfo, createBuildNotice, installedBuildNumber, readBuildInfo } from '../shell/build-info';

import { BUILD_VARIANT } from './variant';

// This build, as installed (src/shell/build-info.ts): the version and build number from the binary
// (socio-device's appBuild: Info.plist, PackageInfo), the commit and date from the embedded config
// (build-stamp.ts). A development client built before appBuild existed falls back to the embedded
// config's numbers for the footer, but the notice compares only the binary's (INSTALLED_BUILD), so it
// stays quiet there rather than keep a number Metro's config made up. `buildNotice` is the one "Updated to build N" notice of this run, checked by
// launch (device-store.ts) once the registry is open.

function nativeBuild(): { version: string; build: string } | null {
    try {
        return appBuild();
    } catch (error) {
        console.warn('[build] could not read the installed build', error);
        return null;
    }
}

const NATIVE_BUILD = nativeBuild();

export const BUILD_INFO: BuildInfo = readBuildInfo(
    NATIVE_BUILD,
    Constants.expoConfig,
    BUILD_VARIANT,
    Platform.OS === 'ios' ? 'ios' : 'android',
);

/** The build number the install notice compares: the binary's own, or null (no notice). */
export const INSTALLED_BUILD: number | null = installedBuildNumber(NATIVE_BUILD);

export const buildNotice = createBuildNotice((error) => console.warn('[build] could not keep the build number', error));
