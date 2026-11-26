import { type BarcodeScanningResult, CameraView } from 'expo-camera';
import { StyleSheet } from 'react-native';

import { codeTarget, QR_ONLY, type QrCameraProps } from './qr-camera-props';

// The QR scanner's camera on iOS (CB-566): expo-camera's CameraView, whose QR codes come from
// AVFoundation's metadata output (expo-camera's ZXing pod, for other formats, isn't built: the
// barcode scanner setting is off for Android's sake). Android's is qr-camera.tsx.

export function QrCamera({ torch, reading, onCode, onMountError, testID }: QrCameraProps) {
    const target = codeTarget(reading, onCode);
    return (
        <CameraView
            testID={testID}
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: [...QR_ONLY] }}
            enableTorch={torch}
            onBarcodeScanned={target === undefined ? undefined : (result: BarcodeScanningResult) => target(result.data)}
            onMountError={() => onMountError()}
        />
    );
}
