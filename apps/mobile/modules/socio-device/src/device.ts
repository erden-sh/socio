import type { EventSubscription } from 'expo';

import { type AppBuild, type AuthTabResult, native, type FileProtection } from './native';

const FILE_SCHEME = 'file://';

/**
 * The absolute path of a plain path or a file:// URI, such as expo-file-system's
 * `uri` (`file:///var/mobile/.../Documents/socio/`). Anything else throws here,
 * before the native side sees it.
 */
export function toFilePath(pathOrUri: string): string {
    let path = pathOrUri;
    if (pathOrUri.startsWith(FILE_SCHEME)) {
        const rest = pathOrUri.slice(FILE_SCHEME.length);
        path = decodeURIComponent(rest.startsWith('localhost/') ? rest.slice('localhost'.length) : rest);
    }
    if (!path.startsWith('/')) {
        throw new TypeError(`socio-device needs an absolute path or a file:// URI, not "${pathOrUri}".`);
    }
    return path;
}

/**
 * Keeps a file or directory, and so everything under a directory, out of
 * iCloud and computer backups (iOS: NSURLIsExcludedFromBackupKey). The item
 * must exist. Android: checks that it exists and changes nothing, because the
 * manifest's backup rules decide what Android backs up.
 */
export async function excludeFromBackup(pathOrUri: string): Promise<void> {
    const path = toFilePath(pathOrUri);
    return native().excludeFromBackup(path);
}

/** iOS: whether the item is excluded from backups. Android: null, as the backup rules decide, not the file. */
export async function isExcludedFromBackup(pathOrUri: string): Promise<boolean | null> {
    const path = toFilePath(pathOrUri);
    return native().isExcludedFromBackup(path);
}

/**
 * Sets an item's iOS data protection class. On a directory it is also the
 * class new files in it get. Android: checks that it exists and changes
 * nothing, because file-based encryption already covers the app's files.
 */
export async function setFileProtection(pathOrUri: string, level: FileProtection): Promise<void> {
    const path = toFilePath(pathOrUri);
    return native().setFileProtection(path, level);
}

/** iOS: the item's data protection class, or null if it has none. Android: null. */
export async function getFileProtection(pathOrUri: string): Promise<FileProtection | null> {
    const path = toFilePath(pathOrUri);
    return native().getFileProtection(path);
}

/**
 * iOS: UIApplication.isProtectedDataAvailable, false whenever a device with a
 * passcode is locked, even after its first unlock. Android: whether the user's
 * credential-encrypted storage is unlocked, which is always true once the app
 * runs, as it isn't direct-boot aware.
 */
export async function isProtectedDataAvailable(): Promise<boolean> {
    return native().isProtectedDataAvailable();
}

/** Calls `listener` as protected data comes (true) and goes (false). iOS only: Android never calls it. */
export function addProtectedDataListener(listener: (available: boolean) => void): EventSubscription {
    return native().addListener('onProtectedDataChange', ({ available }) => listener(available));
}

/**
 * iOS: whether the outbox has a request in flight. While it does, a
 * background task keeps the app running for iOS's short grace after it leaves
 * the screen, begun as it resigns active (or at once if it already isn't
 * active) and ended when this says false or the app is active again. Android:
 * does nothing, as it doesn't suspend an app that soon.
 */
export async function holdBackgroundGrace(hold: boolean): Promise<void> {
    return native().holdBackgroundGrace(hold);
}

/**
 * Calls `listener` once per grace, a few seconds before iOS's background time
 * runs out (or as it does), with the seconds left: the moment to mark the rows
 * in flight unknown and stop their requests. No new grace begins until the app
 * is active again. iOS only: Android never calls it.
 */
export function addBackgroundGraceListener(listener: (secondsLeft: number) => void): EventSubscription {
    return native().addListener('onBackgroundGraceExpiring', ({ secondsLeft }) => listener(secondsLeft));
}

/**
 * When this process started, in milliseconds since the epoch on the wall
 * clock, so it compares with `Date.now()`. iOS: the kernel's start time for the
 * process (sysctl, kinfo_proc's p_starttime), which after a prewarm is the
 * prewarm's start (`wasPrewarmed`). Android 13 and later: when the system asked
 * for the process, before zygote forked it (Process.getStartRequestedElapsedRealtime);
 * earlier: when the forked process bound to the app (Process.getStartElapsedRealtime).
 * Both moved onto the wall clock.
 */
export function processStartTime(): number {
    return native().processStartTime();
}

/**
 * iOS: whether the system prewarmed this process (the ActivePrewarm environment
 * variable): created it and ran it up to UIApplicationMain before the launch,
 * so `processStartTime()` is earlier than the launch, by seconds or hours.
 * Android: false.
 */
export function wasPrewarmed(): boolean {
    return native().wasPrewarmed();
}

/**
 * Android: Activity.reportFullyDrawn() on the current activity, which logs
 * "Fully drawn" with the time since launch, for the cold-start cross-check;
 * true if there was an activity to report it. iOS: does nothing, false.
 */
export async function reportFullyDrawn(): Promise<boolean> {
    return native().reportFullyDrawn();
}

/**
 * Sign-out: clears what any WebView kept. iOS: every website data type
 * of the default WKWebsiteDataStore. Android: Web Storage, the HTTP cache, form
 * data and every cookie. True once done (false on Android with no context).
 */
export async function clearWebViewData(): Promise<boolean> {
    return native().clearWebViewData();
}

/**
 * iOS: deletes the app switcher's snapshots of the app (CB-356), everything
 * under Library/SplashBoard/Snapshots and Library/Caches/Snapshots, and resolves
 * how many files went; rejects, once every item was tried, when any is left.
 * Android: a no-op that resolves 0, since its recents thumbnail isn't a file
 * of the app's.
 */
export async function deleteAppSnapshots(): Promise<number> {
    return native().deleteAppSnapshots();
}

/**
 * The installed binary's version and build number: iOS's CFBundleShortVersionString and
 * CFBundleVersion, Android's versionName and versionCode. What is installed, never the config a
 * development client happened to load.
 */
export function appBuild(): AppBuild {
    return native().appBuild();
}

/**
 * Android: opens `url` in Chrome's Auth Tab and answers the callback to
 * `https://<host><path>`, which Chrome verifies against the app's
 * assetlinks.json; `unavailable` where the default browser has no Auth Tab.
 * iOS answers `unavailable`. `src/platform/auth-sheet.ts` is the only caller.
 */
export function openAuthTab(url: string, host: string, path: string): Promise<AuthTabResult> {
    return native().openAuthTab(url, host, path);
}
