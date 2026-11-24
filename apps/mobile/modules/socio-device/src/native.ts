import { requireNativeModule } from 'expo';
import type { EventEmitter } from 'expo';

/** iOS data protection classes (NSFileProtection*), by their Swift case names. */
export type FileProtection = 'complete' | 'completeUnlessOpen' | 'completeUntilFirstUserAuthentication' | 'none';

/** The installed binary's version and build number, as strings ('' when the binary has none). */
export interface AppBuild {
    /** iOS CFBundleShortVersionString, Android versionName. */
    version: string;
    /** iOS CFBundleVersion, Android versionCode. */
    build: string;
}

export type SocioDeviceEvents = {
    /** iOS: UIApplication's protectedDataDidBecomeAvailable (true) and protectedDataWillBecomeUnavailable (false). */
    onProtectedDataChange: (event: { available: boolean }) => void;
    /** iOS: the outbox's background grace is about to run out, with the seconds left (README.md). */
    onBackgroundGraceExpiring: (event: { secondsLeft: number }) => void;
};

/**
 * What the Swift and Kotlin modules export as `SocioDevice`. Paths are plain
 * absolute paths: the wrapper (`device.ts`) turns file:// URIs into them.
 * README.md says what each call does on each platform. A native module is an
 * EventEmitter; the instance side comes from it because the SDK's
 * `NativeModule` type is the class's constructor, not an instance.
 */
export interface SocioDeviceNative extends EventEmitter<SocioDeviceEvents> {
    excludeFromBackup(path: string): Promise<void>;
    isExcludedFromBackup(path: string): Promise<boolean | null>;
    setFileProtection(path: string, level: FileProtection): Promise<void>;
    getFileProtection(path: string): Promise<FileProtection | null>;
    isProtectedDataAvailable(): Promise<boolean>;
    holdBackgroundGrace(hold: boolean): Promise<void>;
    processStartTime(): number;
    wasPrewarmed(): boolean;
    reportFullyDrawn(): Promise<boolean>;
    clearWebViewData(): Promise<boolean>;
    /** iOS only: Android's is a no-op that answers 0. */
    deleteAppSnapshots(): Promise<number>;
    appBuild(): AppBuild;
    /**
     * Android: Chrome's Auth Tab, answering the https callback to `https://<host><path>` that the
     * browser verified against the app's assetlinks.json; `unavailable` where the default browser
     * has no Auth Tab. iOS: always `unavailable` (its sheet is expo-web-browser's).
     */
    openAuthTab(url: string, host: string, path: string): Promise<AuthTabResult>;
}

/** What `openAuthTab` answers, as AuthTab.kt maps Chrome's result codes. */
export type AuthTabResult =
    | { type: 'success'; url: string | null }
    | { type: 'cancel'; reason?: string }
    | { type: 'verification-failed' | 'verification-timed-out' }
    | { type: 'unavailable'; reason: string }
    | { type: 'unknown'; code: number };

let loaded: SocioDeviceNative | undefined;

/**
 * The native module, loaded on first use rather than at import, so a
 * development client built before the module existed fails at the call that
 * needs it, with Expo's "Cannot find native module" message, and not at launch.
 */
export function native(): SocioDeviceNative {
    loaded ??= requireNativeModule<SocioDeviceNative>('SocioDevice');
    return loaded;
}
