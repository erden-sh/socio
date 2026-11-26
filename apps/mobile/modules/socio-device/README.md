# socio-device

Socio's own native module: the few device calls the app needs that no Expo package has. It is a local
Expo module (`expo-module.config.json`, Swift in `ios/`, Kotlin in `android/`, TypeScript in `src/`).
Expo autolinking finds it in `apps/mobile/modules`, its default folder for local modules, so it has no
`package.json` and the app's `package.json` doesn't list it. The native side registers as `SocioDevice`;
the TypeScript side loads it with `requireNativeModule` from `expo` on first use, not at import.

Import it from `modules/socio-device` (its `index.ts`). Paths are absolute paths or `file://` URIs, such as
expo-file-system's `uri`; anything else throws before the native side sees it. The calls that touch a file
need it to exist, on both platforms, so a call that would fail on iOS fails on Android too.

## What each call does

| Call                                            | iOS                                                                                                                                                                                                                                                      | Android                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `excludeFromBackup(path)`                       | Sets `NSURLIsExcludedFromBackupKey` on the item. On a directory it covers everything under it.                                                                                                                                                           | **No-op:** checks the item exists, changes nothing.                                                                                                                                                                                                                             |
| `isExcludedFromBackup(path)`                    | Reads `NSURLIsExcludedFromBackupKey` back.                                                                                                                                                                                                               | **`null`:** Android has no such file attribute.                                                                                                                                                                                                                                 |
| `setFileProtection(path, level)`                | Sets the item's `NSFileProtection*` class: `complete`, `completeUnlessOpen`, `completeUntilFirstUserAuthentication` or `none`. On a directory, it is also the class new files in it get.                                                                 | **No-op:** checks the item exists and the level is one of the four, changes nothing.                                                                                                                                                                                            |
| `getFileProtection(path)`                       | The item's class, or `null` if it has none.                                                                                                                                                                                                              | **`null`.**                                                                                                                                                                                                                                                                     |
| `isProtectedDataAvailable()`                    | `UIApplication.isProtectedDataAvailable`.                                                                                                                                                                                                                | `UserManager.isUserUnlocked()`: always `true` once the app runs, since it isn't direct-boot aware.                                                                                                                                                                              |
| `addProtectedDataListener(listener)`            | `true` on `protectedDataDidBecomeAvailable`, `false` on `protectedDataWillBecomeUnavailable`.                                                                                                                                                            | **Never called.** The event is declared, so subscribing works the same.                                                                                                                                                                                                         |
| `whenProtectedDataAvailable()`                  | Resolves when the app is active, iOS reports protected data, or the app becomes active (below).                                                                                                                                                          | Resolves at once: the native check is `true`.                                                                                                                                                                                                                                   |
| `holdBackgroundGrace(hold)`                     | While `true`, holds a background task once the app isn't active, for the outbox's request in flight; `false` or becoming active ends it (below).                                                                                                         | **No-op.**                                                                                                                                                                                                                                                                      |
| `addBackgroundGraceListener(l)`                 | Once per grace, about 5 s before iOS's background time runs out (or as it does), with the seconds left.                                                                                                                                                  | **Never called.** The event is declared, so subscribing works the same.                                                                                                                                                                                                         |
| `processStartTime()`                            | When the process started, from the kernel (`sysctl`, `kinfo_proc`'s `p_starttime`).                                                                                                                                                                      | Android 13+: `Process.getStartRequestedElapsedRealtime()`; before: `getStartElapsedRealtime()` (below).                                                                                                                                                                         |
| `wasPrewarmed()`                                | Whether iOS prewarmed the process (`ActivePrewarm` in its environment), so its start is earlier than the launch.                                                                                                                                         | **`false`:** Android doesn't prewarm.                                                                                                                                                                                                                                           |
| `appBuild()`                                    | The installed app's `CFBundleShortVersionString` and `CFBundleVersion` (Info.plist), as `{ version, build }`.                                                                                                                                            | `PackageInfo`'s `versionName` and `longVersionCode`.                                                                                                                                                                                                                            |
| `reportFullyDrawn()`                            | **No-op**, returns `false`: iOS has no counterpart.                                                                                                                                                                                                      | `Activity.reportFullyDrawn()` on the current activity, returns `true` (`false` with no activity).                                                                                                                                                                               |
| `clearWebViewData()`                            | Removes every website data type of the default `WKWebsiteDataStore` (sign-out); returns `true`.                                                                                                                                                          | `WebStorage.deleteAllData()`, a throwaway WebView's `clearCache(true)`, `clearFormData()` and `clearHistory()`, then every cookie; returns `true` (`false` with no context).                                                                                                    |
| `deleteAppSnapshots()`                          | Deletes everything under `Library/SplashBoard/Snapshots` and `Library/Caches/Snapshots`, the app switcher's snapshots of the app (sign-out and every wipe, CB-356); returns how many files went, and throws, once every item was tried, naming any left. | **No-op:** returns `0`; the recents thumbnail isn't a file of the app's, and `src/platform/app-snapshots.ts` never calls it there.                                                                                                                                              |
| `openAuthTab(url, host, path)`                  | **`unavailable`** (`reason: 'ios'`): iOS's sign-in sheet is expo-web-browser's `ASWebAuthenticationSession` with its https callback.                                                                                                                     | Chrome's Auth Tab with an https redirect (`AuthTab.kt`, androidx.browser 1.9, Chrome 137+), not ephemeral: `success` with the URL, `cancel`, `verification-failed`, `verification-timed-out`, or `unavailable` when the default browser has no Auth Tab (`isAuthTabSupported`). |
| `previewFile(path, mimeType, name, contentUri)` | Quick Look (`QLPreviewController`) over the app, for a file the Media file page downloaded (CB-558); `shown` once it closes, `no-app` for a type iOS can't preview.                                                                                      | `ACTION_VIEW` on `contentUri` (the app's FileProvider URI, read through a one-time grant) with the file's type, else its extension's; `shown` as the other app opens, `no-app` when none takes it.                                                                              |
| `saveFile(path, mimeType, name)`                | The system's export panel (`UIDocumentPickerViewController(forExporting:asCopy:)`): `saved` or `cancelled`.                                                                                                                                              | `ACTION_CREATE_DOCUMENT` (no storage permission), then the bytes copied to the place picked: `saved`, `cancelled` or `failed`.                                                                                                                                                  |

As the app starts, before any JavaScript runs, the module also clears iOS's shared URL cache
(`Library/Caches/<bundle id>/Cache.db`) and replaces `URLCache.shared` with one that keeps nothing in
memory or on disk, so no workspace answer is kept there (CB-356): that cache keeps answers even to requests
that ask for no-store, and expo/fetch's session takes it. On Android the requests' `Cache-Control: no-store`
(`src/platform/fetch.ts`) keeps answers out of OkHttp's cache, so the module does nothing there.

What the Android no-ops mean:

- **Backups.** Android backs up by the manifest's backup rules (`dataExtractionRules` for cloud backup and
  device transfer, `fullBackupContent` before Android 12), not by a file attribute. The app's rules (a
  config plugin in `apps/mobile/plugins/`) exclude `files/socio/`, which holds every workspace directory
  and the registry, and secure-store's preferences. Anything outside those rules is backed up, whatever
  `excludeFromBackup` was told.
- **File protection.** Android's file-based encryption keeps the app's files in credential-encrypted
  storage, unreadable until the user first unlocks after a restart: the same as iOS's
  `completeUntilFirstUserAuthentication`. Nothing on Android matches `complete`, which iOS locks again at
  every lock.
- **Protected data.** Since the app never runs before that first unlock, the check is always true and the
  state never changes while the app runs.
- **App-switcher snapshots.** Android's recents thumbnail is the system's, not a file in the app's
  container, so `deleteAppSnapshots()` deletes nothing and returns `0`. It is exported, like
  `holdBackgroundGrace`, so every call the TypeScript side declares exists on both platforms
  (`tests/socio-device/parity.test.ts`).

### The sign-in sheet's Auth Tab

`openAuthTab` is the Android half of the app's system sign-in sheet (`src/platform/auth-sheet.ts`).
Chrome 137 and later advertise the Auth Tab; on anything else (an older Chrome, another default
browser, no browser) it answers `unavailable` and the app opens expo-web-browser's Custom Tab instead,
whose callback comes back as the variant's verified App Link (`plugins/app-links.ts`). It never launches
on a browser that doesn't advertise one.

- `androidx.browser:browser:1.9.0` is in this module's `android/build.gradle`, non-transitive, with a
  `compileOnly` `androidx.activity`: a native dependency, not the lockfile. expo-web-browser already
  brings browser 1.6.0, which Gradle raises to 1.9.0.
- A process killed while the tab shows loses the activity result. The callback is also the variant's
  App Link, so it reaches the app after a restart through Linking.
- **The https callback needs a build signed with the Ingenio team** (iOS `webcredentials`, Android the
  key in the link host's assetlinks.json). A Personal Team build has no associated domains: in
  development its sheet uses the custom-scheme callback `socio-dev://auth-callback`, and in preview or
  production it has no sheet (the sign-in falls back to the password form or a code).

### Process start time

`processStartTime()` is in milliseconds since the epoch, so it compares with `Date.now()` and with the
app's own marks: `Date.now() - processStartTime()` is the time since the point below. It stays the same
for the whole process, and each point comes before any of the app's code ran:

- **iOS:** when the kernel created the process (`kinfo_proc`'s `p_starttime`).
- **Android 13 and later:** when the system asked for the process, before zygote forked it
  (`Process.getStartRequestedElapsedRealtime()`). That is the nearest match to iOS, and the Android 13 test
  device has it. The system's `Start proc` log line comes once the fork is done, a little
  later.
- **Android 12 and earlier:** when the forked process bound to the app (`Process.getStartElapsedRealtime()`),
  so it leaves the fork out: it came 0.36 s after `Start proc` on the Android 16 emulator.

Two kinds of launch start the process before the launch itself, and a cold-start measurement throws
them out rather than timing from the process start:

- **Prewarming (iOS 15 and later).** iOS may create the process and run it up to `UIApplicationMain`
  before anyone opens the app, seconds or hours earlier, and `processStartTime()` is then that early.
  `wasPrewarmed()` says so, from the `ActivePrewarm` variable iOS sets in the process's environment.
  Android has no such thing: `false`.
- **A process already running** (Android, for a broadcast or a service, say) makes the launch a warm one.
  Force-stopping the app before each run avoids it.

### Fully drawn

On Android, `reportFullyDrawn()` makes the system log `Fully drawn <package>/<activity>: +<time>` under
`ActivityTaskManager`, measured from the launch, once per launch. It only counts for a launch the system
tracked (the launcher, or `adb shell am start`). Read it with `adb logcat -d | grep -i "fully drawn"`.

### Background grace

iOS suspends an app seconds after it leaves the screen, which would cut off a message sent just before the
person locks the phone. `holdBackgroundGrace` is based on T3 Code's `T3BackgroundGraceSubscriber` (the note in
`ios/SocioDeviceModule.swift`; `THIRD_PARTY_NOTICES` lists it), which begins a background task whenever the app
resigns active. Socio's holds it only while JavaScript says the outbox has a request in flight
(`src/sync/background-grace.ts` follows the open scope's outbox):

- **Begins** as the app resigns active while held, or at once when held while it already isn't active.
- **Ends** when JavaScript lets go (the lanes are idle) or the app is active again.
- **Running out:** once a second in the background it reads `backgroundTimeRemaining`, and at 5 s or less
  sends `onBackgroundGraceExpiring`, once. The outbox then marks the rows in flight `unknown`, on disk, stops
  their requests and pauses (`interrupt({ pause: true })`) until the app is active again, so nothing is
  checked or sent in the background while an aborted request may still be landing, and lets go. iOS's expiry handler is the backstop: it sends the event if
  that hadn't happened and ends the task at once. After either, no new grace begins until the app is
  active again, so a request started later is cut off and checked on resume.
- It listens for `UIApplication`'s notifications rather than an app delegate subscriber, so scenes don't
  change it, and a module going away (a reload) ends its task.

Android holds nothing in v1: it doesn't suspend an app that soon. The kill-mid-send runs
(`perf/kill-send.mjs`) say whether that holds.

### Waiting for protected data

`whenProtectedDataAvailable()` is based on T3 Code's `protectedData.ts` (the note in
`src/protected-data.ts`; the repository's `THIRD_PARTY_NOTICES` lists it and its test). Call it after a keychain read fails because the phone hasn't been unlocked since
it restarted, then read again. Don't call it first: iOS's check reports the `complete` class, which is
unavailable whenever a phone with a passcode is locked, even after that first unlock, when the store's
keys (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) can be read. The answer is kept for the launch, since those
keys stay readable until the phone restarts. It never rejects: without the native module it waits for the
app to become active.

## Tests

`tests/socio-device/` runs the TypeScript side under Vitest (Node) against a fake native module and a
fake `AppState`. The native code is checked on devices: on the Android emulator, a process start time
between the launch's `START u0` line and the `Start proc` line, and the `Fully drawn` line; on the iOS
simulator, a directory that reads back as excluded from backup. From the Mac, `xattr -l` on that directory
shows `com.apple.metadata:com_apple_backup_excludeItem`.

The background grace is checked in the simulator from Diagnostics' "Hold the grace": leave the app, and
about 25 s later the `[grace] Ran out` line comes with the seconds left. On Android the build boots and
the call does nothing.

The simulator has no data protection and no lock: `getFileProtection` reads `null` there even after
`setFileProtection`, `isProtectedDataAvailable` is always true, and the protected-data event never comes.
Those need a phone with a passcode. A prewarm can't be staged either: launching with `ActivePrewarm=1` set
by hand (`SIMCTL_CHILD_ActivePrewarm=1`) leaves the app on a black screen before any JavaScript runs.

## Building on iOS

The Swift half builds on a Mac with Xcode, as the rest of the iOS app does. What the build Mac needs, and
the commands, for a development client in the simulator:

1. **Tools:** Node 26.13.0, pnpm 10.15, a current Ruby with CocoaPods, Xcode (as the active developer
   directory, its license accepted) and an iOS simulator runtime. Turn CocoaPods' statistics off with
   `COCOAPODS_DISABLE_STATS=true` in the shell's environment, so `pod install` reports nothing.
2. **Install,** from the repository root:

    ```sh
    pnpm install --frozen-lockfile --filter '@socio/mobile...'
    ```

    A plain `pnpm install --frozen-lockfile` does the same and more.

3. **Generate the iOS project** in `apps/mobile`. Prebuild runs `pod install`, which picks this module up
   from `../modules/socio-device/ios` (`ios/Podfile.lock` lists `SocioDevice`):

    ```sh
    EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 DO_NOT_TRACK=1 COCOAPODS_DISABLE_STATS=true npx expo prebuild -p ios --clean
    ```

4. **Build for the simulator,** signed ad hoc (no team, no certificate):

    ```sh
    cd ios
    xcodebuild -workspace SocioDev.xcworkspace -scheme SocioDev -configuration Debug \
      -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath build-sim CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES \
      CODE_SIGNING_REQUIRED=NO DEVELOPMENT_TEAM= build
    ```

    A build with `CODE_SIGNING_ALLOWED=NO` launches, but the simulator refuses it the keychain, so the
    store's key reads fail and the app shows "Socio couldn't open" (nothing is deleted).

    The app is `build-sim/Build/Products/Debug-iphonesimulator/SocioDev.app`. The scheme and the `.app`
    are named after the variant (`SocioDev`, `SocioPreview` or `Socio`).

5. **Run it.** Start Metro in `apps/mobile` on a free port, then boot a simulator, install and launch:

    ```sh
    EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 DO_NOT_TRACK=1 npx expo start --dev-client --port 8090
    xcrun simctl boot 'iPhone 18 Pro'
    xcrun simctl install booted ios/build-sim/Build/Products/Debug-iphonesimulator/SocioDev.app
    xcrun simctl launch booted com.ingenioventures.socio.dev --initialUrl http://localhost:8090 \
      -EXDevMenuIsOnboardingFinished YES -EXDevMenuShowsAtLaunch NO
    ```

    The launch arguments open the bundle directly and keep the dev menu's onboarding and launch sheet
    away, which matters when no one is at the screen. Opening the app's URL with `xcrun simctl openurl`
    instead stops at an "Open in?" prompt. The simulator shares the Mac's loopback, so `localhost` is the
    Mac. `xcrun simctl get_app_container booted com.ingenioventures.socio.dev data` gives the app's data
    folder, to look at what it wrote.

    `pnpm run ios` does steps 4 and 5 in one go, with Metro on 8081.

6. **Clean up:** stop Metro and `xcrun simctl shutdown booted`.

A build for a phone needs signing: Ingenio Ventures' team, or a Personal Team for contributors.
