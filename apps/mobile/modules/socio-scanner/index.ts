// socio-scanner: the add-workspace QR scanner's camera on Android (README.md). Autolinking finds it
// in apps/mobile/modules; it has no iOS side, so only Android code imports it
// (src/screens/qr-camera.tsx; iOS's is qr-camera.ios.tsx).
export { SocioScannerView } from './src/view';
export type { SocioScannerCodeEvent, SocioScannerErrorEvent, SocioScannerViewProps } from './src/view';
