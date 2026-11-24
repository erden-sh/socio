import { type ConfigPlugin, withProjectBuildGradle } from 'expo/config-plugins';

// @react-native-menu/menu (CB-421's native menus) has a buildscript of its own that asks for the
// Android Gradle plugin 7.2.1 and Kotlin's 1.7.0. Gradle would fetch both just to configure it,
// though the build runs on the root's, and the app builds offline (README). This block makes that
// buildscript take the root's own versions, which Gradle already holds. A marked block, so a rerun
// of prebuild replaces it.

export const MENU_GRADLE_MARK = '// socio: @react-native-menu/menu on the root build plugins';

/** The Gradle project autolinking names the library by. */
export const MENU_GRADLE_PROJECT = 'react-native-menu_menu';

export const MENU_GRADLE_BLOCK = `${MENU_GRADLE_MARK}
def socioRootPlugin = { String group, String name ->
  rootProject.buildscript.configurations.classpath.resolvedConfiguration.resolvedArtifacts.find {
    it.moduleVersion.id.group == group && it.moduleVersion.id.name == name
  }?.moduleVersion?.id?.version
}
subprojects { sub ->
  if (sub.name == '${MENU_GRADLE_PROJECT}') {
    sub.buildscript.configurations.configureEach {
      resolutionStrategy.eachDependency { d ->
        if (d.requested.group == 'com.android.tools.build' && d.requested.name == 'gradle') {
          d.useVersion(socioRootPlugin('com.android.tools.build', 'gradle'))
        }
        if (d.requested.group == 'org.jetbrains.kotlin' && d.requested.name == 'kotlin-gradle-plugin') {
          d.useVersion(socioRootPlugin('org.jetbrains.kotlin', 'kotlin-gradle-plugin'))
        }
      }
    }
  }
}
${MENU_GRADLE_MARK} (end)
`;

/** The root build.gradle with the block, once, at its end. */
export function withMenuBlock(contents: string): string {
    const start = contents.indexOf(MENU_GRADLE_MARK);
    const endMark = `${MENU_GRADLE_MARK} (end)\n`;
    const end = contents.indexOf(endMark);
    const kept =
        start === -1 || end === -1 ? contents : contents.slice(0, start) + contents.slice(end + endMark.length);
    return `${kept.trimEnd()}\n\n${MENU_GRADLE_BLOCK}`;
}

const menuGradle: ConfigPlugin = (config) =>
    withProjectBuildGradle(config, (mod) => {
        if (mod.modResults.language !== 'groovy') {
            throw new Error('plugins/menu-gradle.ts: the root build.gradle is not Groovy');
        }
        mod.modResults.contents = withMenuBlock(mod.modResults.contents);
        return mod;
    });

export default menuGradle;
