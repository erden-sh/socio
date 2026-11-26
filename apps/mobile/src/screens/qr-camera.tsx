import { StyleSheet } from 'react-native';

import { SocioScannerView } from '../../modules/socio-scanner';

import { codeTarget, type QrCameraProps } from './qr-camera-props';

// The QR scanner's camera on Android (CB-566): socio-scanner's CameraX preview with ZXing reading
// QR codes, so no Google library is in the app (the owner, 2026-11-26). iOS's is qr-camera.ios.tsx.
// The camera stays bound while a code is handed over; only its codes stop.

export function QrCamera({ torch, reading, onCode, onMountError, testID }: QrCameraProps) {
    const target = codeTarget(reading, onCode);
    return (
        <SocioScannerView
            testID={testID}
            style={StyleSheet.absoluteFill}
            torch={torch}
            active
            onCode={(event) => target?.(event.nativeEvent.data)}
            onMountError={() => onMountError()}
        />
    );
}
