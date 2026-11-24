# socio-push on Android

The Kotlin side of `modules/socio-push`: the same calls as iOS's (the module's README, Calls), registered
as `SocioPush`, and the messaging service. `SocioPushModule.kt` only binds `PushStore.kt` and
`PushNotifier.kt` for JavaScript; the service runs in the app's process and uses the same `PushStore`
and `WebPushCrypto`.

## Storage

Everything is in no-backup storage, `Context.getNoBackupFilesDir()/socio-push/`, which neither cloud backup
nor device-to-device transfer copies, whatever the manifest's backup rules say:

- **`keys/<workspace>.key`:** a format byte, the public key (65 bytes), the private scalar (32) and the auth
  secret (16), sealed with AES-256-GCM (a 12-byte IV, then the ciphertext and tag) under the Keystore key
  `socio.push.wrap`, with the workspace id as associated data, so one workspace's file can't stand in for
  another's. The Keystore key is made on the first `createKeys`, never leaves the Keystore (hardware-backed
  where the phone has it) and needs no unlock, so the service decrypts while the phone is locked. The app
  isn't direct-boot aware, so nothing runs before the first unlock after a restart: the push waits until
  then. The P-256 pair itself is made in software, since Keystore EC keys can't do ECDH before API 31 and
  the app runs from API 24. A file that no longer unwraps (the Keystore key gone) reads as no keys.
- **`state.json`:** the device's `showText`, each workspace's `locked` and `leaseLockAt`, the
  registrations (relay registration id → workspace id and name), and the service's memory: the last 64
  push ids (`seen`) and the last 64 notifications' tap targets by token (`taps`). No key. A file that doesn't read starts
  over empty: the app writes all of it again.
- **`inbox/<uuid>.json`:** one per push, `{workspaceId, link, tag, receivedAt}`, never a title or body,
  the shape iOS's extension writes. `PushStore.writeInbox` is the service's.

Every write goes to a hidden temporary name, is synced, then renamed. One `PushStore` per process, each call
under its lock. `storage()` answers `{keychainGroup: null, shared: true, inbox: true}`: Android has no groups,
and the service always shares the app's storage.

## Decryptor

`WebPushCrypto.kt` is RFC 8291 3.3-3.4 and RFC 8188 2 with plain `java.security` and `javax.crypto` (ECDH on
P-256, HMAC-SHA256 as one-block HKDF, AES-128-GCM), ported step by step from a TypeScript prototype. It
refuses a body whose record is longer than its record size (a second record), a key id that isn't 65 bytes,
a sender key that isn't a point on P-256 (checked before the key agreement), a changed byte and padding
without the last-record delimiter. It has no Android class, so it runs the same in the JVM test.

## Messaging service

After T3 Code's `t3-agent-notifications` (`vendor/t3code/SYNC.md`, Ported). Firebase delivers the relay's
data messages, `{s, p}` (the registration id and the aes128gcm body, base64url) or `{s, g: "1"}` (the
relay's generic alert, for a push too large for FCM), with no JavaScript running:

- **`SocioMessagingService`** extends expo-notifications' `ExpoFirebaseMessagingService`, which this
  module's manifest removes (`tools:node="remove"`), so `onNewToken` still reaches expo-notifications. A
  message with `s` and `p` or `g` goes to `PushNotifier`; any other to Expo's handling.
- **What shows** is `PushMessages.kt`'s, the iOS extension's rules (`PushContentMapper`): the payload's
  title and body; our generic text ("Socio", "New message") with show-text off (still decrypted, for the
  tap and the inbox file); a locked workspace, or the device clock past its `leaseLockAt`, decrypts
  nothing, shows the generic text and opens the workspace's `/`; no ciphertext, an unknown registration,
  no keys, a body that doesn't decrypt or a plaintext that isn't the server's payload shows the relay's
  text ("Socio", "Open the app") and only opens the app. `icon` and `image` are never read.
- **`PushNotifier.kt`** posts it. A push's id is the ciphertext's salt (its first 16 bytes, new for each
  push the server encrypts), else FCM's message id; the last 64 drop retries. While notifications are
  off nothing is consumed. Each message gets its own id, grouped per `<workspace>:<tag>` with a summary,
  so a second mention never replaces the first; the workspace's name is the sub-text when more than one
  workspace has a registration; the public version says "New message in <workspace>". The channels,
  `socio.messages` ("Mentions and room activity", high) and `socio.reports` ("Reports from socios",
  default, for a later `kind: "report"`), are made as the app starts (`SocioPushPackage`), before any
  prompt. The badge is never set.
- **The chat on screen** isn't shown while the app is resumed (`ProcessLifecycleOwner`): JavaScript
  reports it with `setScreen(workspaceId, path)`, matched against the push's workspace and link. Its
  inbox file is still written.
- **A tap** opens the launcher activity by an explicit intent whose only extra is a random token
  (`expo.modules.sociopush.TAP`); `PushStore` keeps the target under it (workspace id, link, tag). The
  module takes it once: `takeLaunchTap()` for the tap that started the app, the `onTap` event for one while
  it runs (`addTapListener`). A tap that comes on a new intent before JavaScript listens to `onTap`
  (`OnStartObserving`) is held, not taken, and `takeLaunchTap()` hands it over (`TapRelay.kt`). Another app can start the launcher with any extra, but a token it makes up
  names nothing, so only Socio's notifications can switch workspaces. Never a VIEW URL.
- **One inbox file per decrypted push** (Storage, above), never for a locked workspace or the relay's text.
- **Firebase's auto-init stays off** (`plugins/push.ts`). `getDevicePushTokenAsync` asks for the token
  itself; whether it needs auto-init is checked with the owner's `google-services.json`.

## Debug hook

Debug builds only (`src/debug`): `DebugPushReceiver`, exported but behind `android.permission.DUMP`, which
only the shell holds, so only adb can call it. `SEED` makes a workspace's keys and registration and answers
`{p256dh, auth}`; `PUSH` hands the service the relay's data as FCM would. `e2e/debug-push.mjs` drives both
(the app's README, The flows): it encrypts the server's payload with web-push, the server's library.

## Tests

`src/test` runs `PushMessages` on the plain JVM (real keys, `TestPushes.kt` encrypting as web-push does),
`PushNotifier` under Robolectric 4.16.1 at SDK 24 and 34 (the newest it runs on JDK 17), after T3 Code's
`AgentNotificationsTest`: decryption, retries and the 64-id history, the chat on screen, grouping, the
flags and the lease, the relay's text, the tap token and notifications turned off; and `PushStore`'s
seen ids and taps under Robolectric, and `TapRelay` (a tap before the listener) on the plain JVM. Robolectric fetches its Android runtime from Maven Central on its
first run. It also runs `WebPushCrypto` against `../vectors.json`, the file iOS's XCTest reads: RFC 8291 Appendix A,
the web-push 3.6.7 body and web-push's two-record body, a flipped byte, a record size below the record, the
wrong keys or auth secret, a sender key off the curve and a short body. It also runs `PushInbox`, which
lists the inbox oldest first (by modification time, then name, as iOS does), skipping files that aren't
entries. It needs a prebuilt Android project:

```sh
cd apps/mobile
EXPO_NO_TELEMETRY=1 npx expo prebuild --clean -p android
cd android && ./gradlew :socio-push:testDebugUnitTest
```
