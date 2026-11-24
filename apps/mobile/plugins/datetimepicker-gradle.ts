import { type ConfigPlugin, withProjectBuildGradle } from 'expo/config-plugins';

// @react-native-community/datetimepicker (CB-469's date picker) compiles against Material
// Components 1.12.0 and androidx.core 1.13.1, while react-native-screens, already in the app,
// takes Material 1.13.0 and newer AndroidX. The app's own classpath resolves them all to
// react-native-screens' versions, but the library's compile classpath resolves its own (and
// Material's older pins, such as androidx.transition 1.5.0), which Gradle would fetch, and the app
// builds offline (README). This block gives the library the versions the app ships, which Gradle
// already holds. A marked block, so a rerun of prebuild replaces it.

export const DATETIMEPICKER_GRADLE_MARK = '// socio: the date picker on the app’s Material Components';

/** The Gradle project autolinking names the library by. */
export const DATETIMEPICKER_GRADLE_PROJECT = 'react-native-community_datetimepicker';

/**
 * The versions the app resolves (react-native-screens' own, which tests/native-config.test.ts
 * reads), by `group:name`; a name of `*` takes the whole group (`transition` and `transition-ktx`).
 */
export const APP_ANDROID_VERSIONS: Readonly<Record<string, string>> = {
    'com.google.android.material:material': '1.13.0',
    'androidx.transition:*': '1.7.0',
    'androidx.core:core': '1.17.0',
    'androidx.core:core-ktx': '1.17.0',
    'androidx.appcompat:*': '1.7.1',
    'androidx.fragment:*': '1.8.9',
    'androidx.coordinatorlayout:coordinatorlayout': '1.2.0',
};

const versionLines = Object.entries(APP_ANDROID_VERSIONS)
    .map(([module, version]) => `  '${module}': '${version}',`)
    .join('\n');

export const DATETIMEPICKER_GRADLE_BLOCK = `${DATETIMEPICKER_GRADLE_MARK}
def socioAppVersions = [
${versionLines}
]
subprojects { sub ->
  if (sub.name == '${DATETIMEPICKER_GRADLE_PROJECT}') {
    sub.configurations.configureEach {
      resolutionStrategy.eachDependency { d ->
        def v = socioAppVersions["\${d.requested.group}:\${d.requested.name}"] ?: socioAppVersions["\${d.requested.group}:*"]
        if (v != null) {
          d.useVersion(v)
        }
      }
    }
  }
}
${DATETIMEPICKER_GRADLE_MARK} (end)
`;

/** The root build.gradle with the block, once, at its end. */
export function withDatetimepickerBlock(contents: string): string {
    const start = contents.indexOf(DATETIMEPICKER_GRADLE_MARK);
    const endMark = `${DATETIMEPICKER_GRADLE_MARK} (end)\n`;
    const end = contents.indexOf(endMark);
    const kept =
        start === -1 || end === -1 ? contents : contents.slice(0, start) + contents.slice(end + endMark.length);
    return `${kept.trimEnd()}\n\n${DATETIMEPICKER_GRADLE_BLOCK}`;
}

const datetimepickerGradle: ConfigPlugin = (config) =>
    withProjectBuildGradle(config, (mod) => {
        if (mod.modResults.language !== 'groovy') {
            throw new Error('plugins/datetimepicker-gradle.ts: the root build.gradle is not Groovy');
        }
        mod.modResults.contents = withDatetimepickerBlock(mod.modResults.contents);
        return mod;
    });

export default datetimepickerGradle;
