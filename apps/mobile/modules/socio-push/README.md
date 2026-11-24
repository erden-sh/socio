# socio-push

Socio's push module: each workspace's Web Push keys, made and kept
natively, the RFC 8291 decryptor, the flags the iOS notification service extension reads, and the
extension's per-push inbox files. It is a local Expo module like `modules/socio-device` (its README covers
building on a Mac): Swift in `ios/`, Kotlin in `android/` (Keystore-wrapped keys in no-backup
storage, javax.crypto, the same API), TypeScript in `src/`, found by autolinking with no `package.json`.
The native side registers as `SocioPush` on both platforms and loads on first use.

## Calls

| Call                                             | What it does                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `createKeys(workspace)`                          | Makes a P-256 pair and a 16-byte auth secret, keeps them, replacing any, and returns `{ p256dh, auth }` (base64url). Nothing else.   |
| `getKeys(workspace)`                             | The same pair's public half and auth secret, or `null`.                                                                              |
| `deleteKeys(workspace)`                          | Deletes the keys, the workspace's flags and lease deadline, and every registration that points at it.                                |
| `setRegistration(registration, workspace, name)` | Indexes a relay registration (the push's `s`) by workspace, with its name for the subtitle (cut to 200 characters).                  |
| `deleteRegistration(registration)`               | Drops one index entry.                                                                                                               |
| `setLocked(workspace, locked)`                   | The copy is locked (Ended, or the lease): the extension shows generic text.                                                          |
| `setLeaseLockAt(workspace, ms \| null)`          | When the lease locks the copy (`src/data/lease.ts`); past it, by the device clock, the extension shows generic text.                 |
| `setShowText(show)`                              | "Show message text in notifications", for the device (on until set).                                                                 |
| `getState(workspace)`                            | `{ locked, leaseLockAt, showText }` as stored.                                                                                       |
| `decrypt(workspace, body)`                       | An aes128gcm body (base64url) decrypted with the workspace's keys, as text. One record only.                                         |
| `readInbox()`, `deleteInbox(ids)`                | The extension's files, parsed (`{ id, workspaceId, link, tag, receivedAt }`, oldest first, plus ids that don't parse), and deleting. |
| `pushStorage()`                                  | `{ keychainGroup, shared, inbox }`: where this build keeps the items.                                                                |

Workspace and registration ids are 1 to 128 of `A-Z a-z 0-9 - _`; the wrapper refuses anything else before
the native side makes a keychain account or a file name of it.

## iOS

- **Keychain.** Generic passwords of service `socio.push`, `AfterFirstUnlockThisDeviceOnly`, each written
  and read with an explicit access group: `key.<workspace>` (the raw private key and the auth secret),
  `workspace.<workspace>` (`locked`, `leaseLockAt`), `registration.<id>` (`workspaceId`, `name`) and
  `device` (`showText`). Nothing else goes in the shared group.
- **Groups.** `plugins/push.ts` writes two Info.plist keys: `SocioPushKeychainGroupSuffix` (`.shared`) and
  `SocioPushAppGroup` (`group.<bundle id>`). The module finds the app's own group by writing, reading back
  and deleting a probe item with no group (the keychain fills in the entitlement's first group, the app's
  own), then adds the suffix: `<team>.<bundle id>.shared`, the entitlement's second group. A Personal Team
  build strips both keys (`plugins/personal-team.ts`), so its items go to the app's own group and it has no
  inbox. The app group's container exists only once the build has the app group entitlement (added with
  the extension); until then `inbox` is false and the inbox reads empty, on the simulator too.
- **Decryptor.** `ios/Shared/WebPushDecryptor.swift`: RFC 8291 3.3-3.4 and RFC 8188 2 in CryptoKit
  (`P256.KeyAgreement`, `HMAC<SHA256>` as one-block HKDF, `AES.GCM`), ported step by step from a TypeScript
  prototype, not from Mastodon's GPL code. It refuses a body with more than one record, a key id that isn't
  a 65-byte P-256 key, a record size under 18, a changed byte and padding without the last-record delimiter.
- **Shared code.** `ios/Shared/` is plain Swift with no Expo in it (the decryptor, the keychain, the inbox),
  so the notification service extension compiles the same files and reads the keys the same way.
  `ios/Module/` binds it for JavaScript.
- **Inbox.** `inbox/<uuid>.json` in the app group's container, written under a hidden temporary name and
  renamed (`PushInbox.write`, the extension's), holding the workspace id, the link, the tag and the time,
  never a title or body. No SQLite in the shared container (0xdead10cc).

## Tests

- `tests/socio-push/` runs the wrapper under Vitest against a fake native module, and checks
  `vectors.json`.
- `ios/Package.swift` makes `ios/Shared` a Swift package for its XCTest (`ios/Tests`), which reads
  `vectors.json`: RFC 8291 Appendix A with every intermediate value, a web-push 3.6.7 body, and a
  two-record body web-push made for a 4200-byte plaintext, all with test keys only. On a Mac, in `ios/`:

    ```sh
    swift test
    xcodebuild test -scheme SocioPushShared -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
    ```

    CocoaPods leaves `Package.swift` and `Tests/` out (`SocioPush.podspec` lists `Module/` and `Shared/`).

- **On the simulator:** Diagnostics' Push keys check makes a scratch key for the made-up id `diagnostics`
  on its first run and reads it back on later ones ("Kept from before", across a relaunch), shows the
  keychain group, and decrypts `Documents/diagnostics-push.txt` (then deletes it). To make that file, encrypt
  with web-push to the `p256dh` and `auth` it shows (or logs as `[diagnostics-push]`), the way
  `src/server/notifications/push.ts` calls it, and write the base64url body into
  `$(xcrun simctl get_app_container booted <app id> data)/Documents/diagnostics-push.txt`. The simulator's
  keychain is `~/Library/Developer/CoreSimulator/Devices/<udid>/data/Library/Keychains/keychain-2-debug.db`:
  `select agrp, pdmn from genp` shows each item's group and accessibility (`cku`).
