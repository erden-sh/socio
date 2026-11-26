import { requireNativeView } from 'expo';
import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

/** A QR code's text, as the Kotlin view sends it (`onCode`). */
export type SocioScannerCodeEvent = NativeSyntheticEvent<{ data: string }>;
/** Why the camera didn't start (`onMountError`): no activity, no back camera, or CameraX's own refusal. */
export type SocioScannerErrorEvent = NativeSyntheticEvent<{ message: string }>;

/** What the Kotlin view takes (SocioScannerModule.kt). */
export interface SocioScannerViewProps extends ViewProps {
    /** The camera's torch (its flash unit), when it has one. */
    readonly torch?: boolean;
    /** False unbinds the camera; true binds it again. True by default. */
    readonly active?: boolean;
    readonly onCode?: (event: SocioScannerCodeEvent) => void;
    readonly onMountError?: (event: SocioScannerErrorEvent) => void;
}

/** CameraX's preview with ZXing reading QR codes from it (README.md). Android only. */
export const SocioScannerView: ComponentType<SocioScannerViewProps> = requireNativeView('SocioScanner');
