import { AndroidConfig, type ConfigPlugin, withAndroidManifest, withGradleProperties } from 'expo/config-plugins';

// expo-camera on Android without anything of Google's (CB-566; the owner, 2026-11-26: no ML Kit, Play
// services or Google data transport in the app). The add-workspace QR scanner reads codes with
// modules/socio-scanner (CameraX and ZXing) instead; expo-camera stays for the camera permission and
// iOS.
// - Its barcode scanner is off through its own plugin (app.config.ts: `barcodeScannerEnabled: false`,
//   which writes `expo.camera.barcode-scanner-enabled=false`), and its document scanner here, as its
//   plugin has no option for it: with both off, expo-camera's ML Kit and Play services dependencies
//   are compile-only. Only a source build reads those properties, so package.json's
//   `expo.autolinking.buildFromSource` lists expo-camera: Expo's prebuilt AAR always brings them.
// - Its library manifest still asks Play services to download ML Kit's barcode model at install
//   (`com.google.mlkit.vision.DEPENDENCIES`): that entry is removed from the merged manifest.
// Each is set once, so a rerun of prebuild leaves one of each.

export const DOCUMENT_SCANNER_PROPERTY = 'expo.camera.document-scanner-enabled';
export const MLKIT_DEPENDENCIES = 'com.google.mlkit.vision.DEPENDENCIES';

const camera: ConfigPlugin = (config) => {
    const withProperty = withGradleProperties(config, (mod) => {
        mod.modResults = [
            ...mod.modResults.filter((item) => !(item.type === 'property' && item.key === DOCUMENT_SCANNER_PROPERTY)),
            { type: 'property', key: DOCUMENT_SCANNER_PROPERTY, value: 'false' },
        ];
        return mod;
    });
    return withAndroidManifest(withProperty, (mod) => {
        mod.modResults.manifest.$['xmlns:tools'] ??= 'http://schemas.android.com/tools';
        const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
        const kept = (application['meta-data'] ?? []).filter((item) => item.$['android:name'] !== MLKIT_DEPENDENCIES);
        application['meta-data'] = [
            ...kept,
            { $: { 'android:name': MLKIT_DEPENDENCIES, 'tools:node': 'remove' } as never },
        ];
        return mod;
    });
};

export default camera;
