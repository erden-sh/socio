import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// The QR scanner's camera (CB-566): socio-scanner (CameraX and ZXing) on Android, expo-camera's
// CameraView on iOS, behind one QrCamera with the same props; and nothing of Google's on Android
// (the owner, 2026-11-26). The native view is checked from its sources: Node has no camera.

// The names asked for as the module loads (the suite's mocks are reset before each test).
const mocks = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('expo', () => ({
    requireNativeView: (name: string) => {
        mocks.asked.push(name);
        return 'SocioScannerView';
    },
}));

import { SocioScannerView } from '../modules/socio-scanner';
import { codeTarget, QR_ONLY } from '../src/screens/qr-camera-props';

const app = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(app, path), 'utf8');
const scanner = 'modules/socio-scanner';
const kotlin = (file: string) => read(`${scanner}/android/src/main/java/expo/modules/socioscanner/${file}`);

/** Every .ts and .tsx file under `dir`, relative to the app. */
function sources(dir: string): string[] {
    return readdirSync(join(app, dir)).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(join(app, path)).isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(name) ? [relative(app, join(app, path))] : [];
    });
}

describe('QrCamera', () => {
    it('sends a code on while the screen reads, and nowhere while one is handed over', () => {
        const onCode = vi.fn();
        expect(codeTarget(true, onCode)).toBe(onCode);
        expect(codeTarget(false, onCode)).toBeUndefined();
        codeTarget(true, onCode)?.('https://example.test');
        expect(onCode).toHaveBeenCalledWith('https://example.test');
    });

    it('reads QR codes only, on both platforms', () => {
        expect(QR_ONLY).toEqual(['qr']);
        expect(read('src/screens/qr-camera.ios.tsx')).toContain('barcodeTypes: [...QR_ONLY]');
    });

    it('is socio-scanner on Android and expo-camera on iOS, with the same props', () => {
        const android = read('src/screens/qr-camera.tsx');
        const ios = read('src/screens/qr-camera.ios.tsx');
        expect(android).toContain("from '../../modules/socio-scanner'");
        expect(android).not.toContain('expo-camera');
        expect(ios).toContain("from 'expo-camera'");
        expect(ios).not.toContain('socio-scanner');
        const signature = 'export function QrCamera({ torch, reading, onCode, onMountError, testID }: QrCameraProps)';
        expect(android).toContain(signature);
        expect(ios).toContain(signature);
        // Android: the torch prop, and the code from the native event; iOS: expo-camera's torch.
        expect(android).toContain('torch={torch}');
        expect(android).toContain('target?.(event.nativeEvent.data)');
        expect(ios).toContain('enableTorch={torch}');
    });

    it('is the only camera the scanner draws, and the scanner keeps expo-camera for the permission', () => {
        const screen = read('src/screens/scan-qr.tsx');
        expect(screen).toContain("import { QrCamera } from './qr-camera';");
        expect(screen).toContain("import { useCameraPermissions } from 'expo-camera';");
        expect(screen).not.toContain('CameraView');
        expect(screen).toContain("reading={scan.step !== 'opening'}");
    });

    it('keeps CameraView to iOS and socio-scanner to Android', () => {
        const files = sources('src');
        expect(
            files.filter((file) => /\bCameraView\b/.test(read(file)) && /from 'expo-camera'/.test(read(file))),
        ).toEqual(['src/screens/qr-camera.ios.tsx']);
        expect(files.filter((file) => read(file).includes("from '../../modules/socio-scanner'"))).toEqual([
            'src/screens/qr-camera.tsx',
        ]);
    });
});

describe('socio-scanner', () => {
    it('is the SocioScanner native view', () => {
        expect(SocioScannerView).toBe('SocioScannerView');
        expect(mocks.asked).toEqual(['SocioScanner']);
    });

    it('is an Android-only module whose view takes torch and active and sends onCode and onMountError', () => {
        expect(JSON.parse(read(`${scanner}/expo-module.config.json`))).toEqual({
            platforms: ['android'],
            android: { modules: ['expo.modules.socioscanner.SocioScannerModule'] },
        });
        const module = kotlin('SocioScannerModule.kt');
        expect(module).toContain('Name("SocioScanner")');
        expect(module).toContain('Events("onCode", "onMountError")');
        expect([...module.matchAll(/Prop\("(\w+)"\)/g)].map((match) => match[1])).toEqual(['torch', 'active']);
        expect(module).toContain('OnViewDestroys');
        const props = read(`${scanner}/src/view.ts`);
        for (const name of ['torch', 'active', 'onCode', 'onMountError']) {
            expect(props).toMatch(new RegExp(`readonly ${name}\\?:`));
        }
    });

    it('depends on CameraX at expo-camera’s version and ZXing core, and nothing else', () => {
        const gradle = read(`${scanner}/android/build.gradle`);
        const deps = [...gradle.matchAll(/^\s*implementation "([^"]+)"/gm)].map((match) => match[1]);
        expect(deps).toEqual([
            'androidx.camera:camera-core:${camerax}',
            'androidx.camera:camera-camera2:${camerax}',
            'androidx.camera:camera-lifecycle:${camerax}',
            'androidx.camera:camera-view:${camerax}',
            'com.google.zxing:core:3.5.4',
        ]);
        const camerax = /def camerax = "([^"]+)"/.exec(gradle)?.[1];
        const expoCamera = read('node_modules/expo-camera/android/build.gradle');
        expect(/def camerax_version = "([^"]+)"/.exec(expoCamera)?.[1]).toBe(camerax);
        expect(gradle).not.toMatch(/mlkit|play-services|firebase|datatransport/);
    });

    it('reads QR codes alone with ZXing, harder, inverted too, from the frame’s middle and then all of it', () => {
        const decoder = kotlin('QrDecoder.kt');
        expect(decoder).toContain('DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)');
        expect(decoder).toContain('DecodeHintType.TRY_HARDER to true');
        expect(decoder).toContain('HybridBinarizer');
        expect(decoder).toContain('read(source) ?: read(source.invert())');
        const view = kotlin('SocioScannerView.kt');
        expect(view).toContain('ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST');
        expect(view).toContain('Size(1280, 720)');
        expect(view).toContain('decoder.decode(luma, image.width, image.height, CENTER_FRACTION)');
        expect(view).toContain('image.close()');
    });

    it('unbinds only its own use cases, never every camera user’s', () => {
        const view = kotlin('SocioScannerView.kt');
        expect(view).not.toContain('unbindAll');
        expect(view).toContain('cameraProvider.unbind(*ours.toTypedArray())');
        for (const call of ['override fun onDetachedFromWindow', 'fun setActive', 'fun release']) {
            const body = view.slice(view.indexOf(call), view.indexOf('\n  }', view.indexOf(call)));
            expect(body, call).toContain('stop()');
        }
    });

    it('imports nothing of Google’s but ZXing, and nothing of expo-camera', () => {
        for (const file of ['QrDecoder.kt', 'SocioScannerView.kt', 'SocioScannerModule.kt']) {
            const imports = [...kotlin(file).matchAll(/^import ([\w.]+)/gm)].map((match) => match[1] ?? '');
            expect(
                imports.filter((name) => name.startsWith('com.google.') && !name.startsWith('com.google.zxing.')),
            ).toEqual([]);
            expect(imports.filter((name) => name.startsWith('expo.modules.camera'))).toEqual([]);
        }
    });
});
