import { type ConfigPlugin, withGradleProperties } from 'expo/config-plugins';

// expo-camera (CB-566: the add-workspace QR scanner) builds Google's ML Kit document scanner into
// the Android app unless a Gradle property turns it off, and its config plugin has no option for
// it. The app scans QR codes only (expo-camera's barcode scanner, which stays on), so the document
// scanner is off. Set once, so a rerun of prebuild leaves one line.

export const DOCUMENT_SCANNER_PROPERTY = 'expo.camera.document-scanner-enabled';

const camera: ConfigPlugin = (config) =>
    withGradleProperties(config, (mod) => {
        mod.modResults = [
            ...mod.modResults.filter((item) => !(item.type === 'property' && item.key === DOCUMENT_SCANNER_PROPERTY)),
            { type: 'property', key: DOCUMENT_SCANNER_PROPERTY, value: 'false' },
        ];
        return mod;
    });

export default camera;
