import { useNavigation } from '@react-navigation/native';
import { useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { openScannedLink } from '../navigation/scanned-link';
import { cameraStep, SCAN_COPY, scanCode, SCANNING, type ScanHandOff, type ScanState } from '../net/qr-scan';
import { appState } from '../platform/app-state';
import { SCAN_LINKS } from '../platform/qr-scan';
import { AppSymbol, Button, Text } from '../ui';

import { QrCamera } from './qr-camera';

// Add workspace's QR scanner (CB-566): the camera full screen (the `modal` preset), opened only by a
// tap on the first screen's QR row, which is when the camera permission is asked (expo-camera's, on
// both platforms). The camera is `QrCamera` (qr-camera.tsx: CameraX and ZXing on Android, nothing of
// Google's; qr-camera.ios.tsx: expo-camera on iOS). It reads QR codes only; Socio's own (net/qr-scan.ts: Add a device, Get the app, an invite, this build's link host and
// variant) closes the scanner and opens as the same link from outside would (scanned-link.ts); any
// other code says so under the frame with Try again, and the camera keeps reading. Refused, it says
// so with Open Settings (and Allow the camera while Android may still ask), and reads the permission
// again as the app comes back to the front. Cancel (and Android's Back) goes back to Add a workspace.
// The light is the camera's torch. The bar, the hint and the frame have dark backings, so they read
// over a bright scene (a white page) as well as a dark one.

const FRAME = 248;

export function ScanQrScreen() {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const [permission, requestPermission, getPermission] = useCameraPermissions();
    const [asked, setAsked] = useState(false);
    const [scan, setScan] = useState<ScanState>(SCANNING);
    const [light, setLight] = useState(false);
    const [cameraFailed, setCameraFailed] = useState(false);
    // The camera reports a code many times a second, faster than a render: the latest state, so one
    // code is handed over once.
    const latest = useRef<ScanState>(SCANNING);
    const requested = useRef(false);
    const camera = cameraStep(permission, asked);

    useEffect(() => {
        if (camera.step !== 'asking' || requested.current) {
            return;
        }
        requested.current = true;
        requestPermission()
            .catch((error: unknown) => console.warn('[scan-qr] the camera permission ask failed', error))
            .finally(() => setAsked(true));
    }, [camera.step, requestPermission]);

    useEffect(
        // Back from the phone's Settings: read the permission again.
        () =>
            appState.subscribe((state) => {
                if (state === 'active') {
                    void getPermission();
                }
            }),
        [getPermission],
    );

    const close = () => navigation.goBack();
    const handOff: ScanHandOff = { close, open: (url) => void openScannedLink(url) };
    const onCode = (data: string) => {
        const next = scanCode(latest.current, data, SCAN_LINKS, handOff);
        if (next !== latest.current) {
            latest.current = next;
            setScan(next);
        }
    };
    const tryAgain = () => {
        latest.current = SCANNING;
        setScan(SCANNING);
    };
    const ask = () => {
        requestPermission().catch((error: unknown) =>
            console.warn('[scan-qr] the camera permission ask failed', error),
        );
    };

    const running = camera.step === 'ready' && !cameraFailed;

    return (
        <View testID="scan-qr-screen" className="flex-1 bg-black">
            {running ? (
                <QrCamera
                    testID="scan-qr-camera"
                    torch={light}
                    reading={scan.step !== 'opening'}
                    onCode={onCode}
                    onMountError={() => setCameraFailed(true)}
                />
            ) : null}
            <View
                className="absolute top-0 right-0 left-0 flex-row items-center gap-3 bg-black/55 px-4 pb-3"
                style={{ paddingTop: insets.top + 8 }}
            >
                <Pressable
                    testID="scan-qr-cancel"
                    accessibilityRole="button"
                    accessibilityLabel={SCAN_COPY.cancel}
                    onPress={close}
                    hitSlop={4}
                    className="min-h-11 justify-center rounded-full bg-white/20 px-4 active:bg-white/30"
                >
                    <Text weight="medium" className="text-white">
                        {SCAN_COPY.cancel}
                    </Text>
                </Pressable>
                <Text
                    accessibilityRole="header"
                    weight="medium"
                    numberOfLines={1}
                    className="flex-1 text-center text-white"
                >
                    {SCAN_COPY.title}
                </Text>
                {running ? (
                    <Pressable
                        testID="scan-qr-light"
                        accessibilityRole="switch"
                        accessibilityLabel={light ? SCAN_COPY.lightOff : SCAN_COPY.lightOn}
                        accessibilityState={{ checked: light }}
                        onPress={() => setLight((on) => !on)}
                        hitSlop={4}
                        className="size-11 items-center justify-center rounded-full bg-white/20 active:bg-white/30"
                    >
                        <AppSymbol name={light ? 'flashlight' : 'flashlight-off'} size={20} color="white" />
                    </Pressable>
                ) : (
                    <View className="size-11" />
                )}
            </View>
            <View className="flex-1 items-center justify-center gap-6 px-6" pointerEvents="box-none">
                {camera.step === 'checking' || camera.step === 'asking' ? (
                    <ActivityIndicator color="#ffffff" testID="scan-qr-checking" />
                ) : camera.step === 'denied' ? (
                    <Denied canAsk={camera.canAsk} onAsk={ask} />
                ) : cameraFailed ? (
                    <Text testID="scan-qr-no-camera" className="text-center text-white">
                        {SCAN_COPY.noCamera}
                    </Text>
                ) : (
                    <>
                        {/* A dark ring around the white frame, so it shows on a bright scene too. */}
                        <View className="rounded-[28px] border-2 border-black/50">
                            <View
                                testID="scan-qr-frame"
                                accessible={false}
                                className="rounded-3xl border-4 border-white"
                                style={{ width: FRAME, height: FRAME }}
                            />
                        </View>
                        <View className="rounded-2xl bg-black/60 px-4 py-2">
                            <Text testID="scan-qr-hint" className="text-center text-white">
                                {scan.step === 'opening' ? SCAN_COPY.opening : SCAN_COPY.hint}
                            </Text>
                        </View>
                    </>
                )}
            </View>
            {scan.step === 'refused' ? (
                <View
                    testID="scan-qr-refused"
                    accessibilityLiveRegion="polite"
                    className="absolute right-4 left-4 items-center gap-3 rounded-2xl bg-black/75 p-4"
                    style={{ bottom: insets.bottom + 24 }}
                >
                    <Text testID="scan-qr-refused-line" weight="medium" className="text-center text-white">
                        {scan.line}
                    </Text>
                    <Button label={SCAN_COPY.tryAgain} onPress={tryAgain} testID="scan-qr-try-again" />
                </View>
            ) : null}
            {__DEV__ ? <DevScan onScan={onCode} bottom={insets.bottom} /> : null}
        </View>
    );
}

function Denied({ canAsk, onAsk }: { canAsk: boolean; onAsk: () => void }) {
    return (
        <View testID="scan-qr-denied" accessibilityLiveRegion="polite" className="items-center gap-3">
            <AppSymbol name="camera" size={32} color="white" />
            <Text accessibilityRole="header" weight="semibold" className="text-center text-white">
                {SCAN_COPY.deniedTitle}
            </Text>
            <Text className="text-center text-white/80">{SCAN_COPY.deniedDetail}</Text>
            <Button
                label={SCAN_COPY.openSettings}
                onPress={() => void Linking.openSettings()}
                testID="scan-qr-open-settings"
            />
            {canAsk ? (
                <Button variant="secondary" label={SCAN_COPY.allow} onPress={onAsk} testID="scan-qr-allow" />
            ) : null}
        </View>
    );
}

/**
 * Development only (`__DEV__`, never in a release bundle): a field whose text goes to the scanner as
 * a code the camera read, for simulators and emulators, which have no camera to point at a QR code.
 */
function DevScan({ onScan, bottom }: { onScan: (data: string) => void; bottom: number }) {
    const [text, setText] = useState('');
    return (
        <View className="absolute right-4 left-4" style={{ bottom: bottom + 4 }}>
            <TextInput
                testID="scan-qr-dev-input"
                value={text}
                onChangeText={setText}
                onSubmitEditing={() => onScan(text)}
                placeholder="Dev: paste a scanned value"
                placeholderTextColor="#ffffff80"
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded-lg bg-white/15 px-3 py-2 text-white"
            />
        </View>
    );
}
