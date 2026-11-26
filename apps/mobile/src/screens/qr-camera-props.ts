// The QR scanner's camera, the same on both platforms (CB-566): qr-camera.tsx on Android
// (modules/socio-scanner: CameraX and ZXing, nothing of Google's), qr-camera.ios.tsx on iOS
// (expo-camera's CameraView, AVFoundation's QR reader). The screen (scan-qr.tsx) draws it the same
// way on both and reads the permission through expo-camera on both. No React Native here.

export interface QrCameraProps {
    /** The camera's light. */
    readonly torch: boolean;
    /** Whether a code read now goes to `onCode`: false while a code is being handed over. */
    readonly reading: boolean;
    /** A QR code's text, each time the camera reads one (the screen passes over repeats). */
    readonly onCode: (data: string) => void;
    /** The camera didn't start (no camera, or the system refused it). */
    readonly onMountError: () => void;
    readonly testID?: string;
}

/** What the camera reads: QR codes only, on both platforms. */
export const QR_ONLY = ['qr'] as const;

/**
 * Where a code the camera read goes: to `onCode` while the screen is reading, nowhere while a code is
 * being handed over (the camera stays on; only its codes stop). Both platforms' QrCamera use it.
 */
export function codeTarget(reading: boolean, onCode: (data: string) => void): ((data: string) => void) | undefined {
    return reading ? onCode : undefined;
}
