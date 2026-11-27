# socio-scanner

The add-workspace QR scanner's camera on Android (CB-566), with no Google library: the owner's
decision (2026-11-26) keeps ML Kit, Play services and Google's data transport out of the app.
iOS reads QR codes with AVFoundation through expo-camera's `CameraView`, so this module is
Android only (`expo-module.config.json`'s `platforms`).

- **The camera** is CameraX (`androidx.camera` 1.6.0, the version expo-camera 58.0.14 uses, so
  Gradle keeps one copy): the back camera's `Preview` in a `PreviewView` (`COMPATIBLE`, a
  TextureView, so it sits in React Native's view tree like any view; `FILL_CENTER`) and an
  `ImageAnalysis` at about 1280x720 with `STRATEGY_KEEP_ONLY_LATEST`, on one analyzer thread.
- **The reader** is ZXing's core (`com.google.zxing:core` 3.5.4, Apache-2.0, plain Java with no
  Android or network code; the `com.google` group name is historical). Each frame's Y plane goes to
  `QrDecoder`: a `PlanarYUVLuminanceSource` cropped to the centered 75% of the shorter side (the
  on-screen frame and a margin), every third frame the whole frame and then each half of it (with
  two codes in view the reader can mix their finder patterns and read neither), through a
  `HybridBinarizer` and a `QRCodeReader` with `QR_CODE` only and `TRY_HARDER`, then once more on the
  inverted image. Never ZXing's multi-code reader: its time grows past seconds with many codes in
  view, which would stall the analyzer.
- **Lifecycle:** bound to the activity's lifecycle, so CameraX stops the camera in the background and
  starts it on return. The view unbinds its own use cases (never another camera user's) when it
  leaves the window, when `active` goes false and when React Native destroys it, which also ends the
  analyzer thread.
- **Props and events:** `torch` (`CameraControl.enableTorch`, when the camera has a flash unit),
  `active` (true by default); `onCode` (`{ data }`, the QR code's text, the same code again only after
  1.5 s or another code between) and `onMountError` (`{ message }`). Events come on the main thread.
- **The screen** (`src/screens/scan-qr.tsx`) draws it through `QrCamera` (`src/screens/qr-camera.tsx`;
  iOS's `qr-camera.ios.tsx` is expo-camera's `CameraView`). The camera permission is expo-camera's
  `useCameraPermissions` on both platforms.

expo-camera stays in the app for the permission and iOS, with its Android barcode scanner off
(`expo.camera.barcode-scanner-enabled=false`, from `app.config.ts`'s `barcodeScannerEnabled: false`)
and its document scanner off (`plugins/camera.ts`): its ML Kit and Play services dependencies are then
compile-only, and the release build carries none of them. Only a source build of expo-camera reads
those properties (Expo's prebuilt AAR lists them whatever they say), so `package.json`'s
`expo.autolinking.buildFromSource` lists it. Check with Gradle after a prebuild:

```sh
cd apps/mobile/android
./gradlew --no-daemon --offline :app:dependencies --configuration releaseRuntimeClasspath \
  | grep -E 'com\.google\.mlkit|play-services-code-scanner|camera-mlkit-vision|com\.google\.android\.datatransport'
```

Only the FCM pieces expo-notifications brings (firebase-messaging and what it depends on) may match.
