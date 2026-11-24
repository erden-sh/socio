import fs from 'node:fs';
import path from 'node:path';

import type { ExpoConfig } from 'expo/config';
import { withDangerousMod } from 'expo/config-plugins';

/**
 * The Android source sets a resource can go to: `main` for every build, or a debuggable build
 * type's own, whose file of the same name replaces main's in that build only. React Native's
 * Gradle plugin makes two debuggable build types, `debug` and `debugOptimized`, and both load
 * their JavaScript from Metro.
 */
export type SourceSet = 'main' | 'debug' | 'debugOptimized';

/**
 * Writes `android/app/src/<sourceSet>/res/xml/<name>.xml` at prebuild, for the manifest to point at
 * as `@xml/<name>`. A dangerous mod, so `expo config --type introspect` never runs it: the tests call
 * each file's builder, and run the network plugin's mod through `compileModsAsync` into a scratch
 * project; the built APK is checked with `aapt2 dump xmltree`.
 */
export function withResXml(
    config: ExpoConfig,
    name: string,
    contents: string,
    sourceSet: SourceSet = 'main',
): ExpoConfig {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        throw new Error(`"${name}" isn't a valid Android resource name.`);
    }
    return withDangerousMod(config, [
        'android',
        (next) => {
            const dir = path.join(next.modRequest.platformProjectRoot, 'app', 'src', sourceSet, 'res', 'xml');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${name}.xml`), contents);
            return next;
        },
    ]);
}
