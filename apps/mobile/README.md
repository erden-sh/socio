# Socio for iOS and Android

Socio's native app, built with Expo (React Native). It is a skeleton for now. Agents read
`AGENTS.md`.

## Setup

Install from the repository root, which installs the app too (one pnpm workspace):

```sh
pnpm install
```

## Variants

`APP_VARIANT` picks the build. Each installs side by side with the others.

| `APP_VARIANT`        | Name          | Bundle id and package               | Scheme          |
| -------------------- | ------------- | ----------------------------------- | --------------- |
| unset, `development` | Socio Dev     | `com.ingenioventures.socio.dev`     | `socio-dev`     |
| `preview`            | Socio Preview | `com.ingenioventures.socio.preview` | `socio-preview` |
| `production`         | Socio         | `com.ingenioventures.socio`         | `socio`         |

`APP_VARIANT=preview EXPO_NO_TELEMETRY=1 npx expo config --type public` shows the resolved config.

## Running it

The app runs in a development client: a debug build of the app itself, with Expo's dev tools in it.
Expo Go isn't used.

1. Generate the native projects (they are never committed):

    ```sh
    EXPO_NO_TELEMETRY=1 npx expo prebuild --clean -p android   # or -p ios, on a Mac
    ```

2. Build the development client, install it, start Metro and open the app, all in one go:
    - **Android**, on Linux or macOS with the Android SDK and JDK 17, with an emulator running or a
      phone connected over USB:

        ```sh
        REACT_NATIVE_PACKAGER_HOSTNAME=localhost pnpm run android
        ```

        The app then loads from Metro at `localhost`, through the `adb reverse` Expo CLI sets up.
        Plain `pnpm run android` works too, at the machine's LAN address (below).

    - **iOS**, on a Mac with Xcode: `pnpm run ios`. The deployment target is iOS 17.4.

    Metro keeps running in that terminal, and JavaScript changes reload from it. Rebuild the client
    only when native code or config changes.

3. In a later session, or after building with Gradle yourself (`cd android && ./gradlew assembleDebug`,
   then `adb install app/build/outputs/apk/debug/app-debug.apk`), start Metro alone and press `a` (or
   `i`) to open the installed app:

    ```sh
    pnpm start
    ```

    `REACT_NATIVE_PACKAGER_HOSTNAME=localhost pnpm start` keeps an emulator or a USB phone on
    `localhost`. A phone on Wi-Fi opens the app at the LAN address: enter it in the development
    client, or scan the QR code Metro prints. The QR code carries the app's scheme only once this
    checkout has an `android/` or `ios/` project, generated for the installed variant; without one it
    carries `exp+socio`, which the app doesn't register.

Run every Expo command with `EXPO_NO_TELEMETRY=1`, and anything that starts Metro with `EXPO_OFFLINE=1`
too, so Expo CLI sends Expo neither telemetry nor dev-session reports. The package scripts (`pnpm start`,
`pnpm run android`, `pnpm run ios`, `pnpm run build`) set both. Builds never go through EAS.

A debug build, the development client, loads its JavaScript from Metro over plain http. On Android a
debug build may reach any host that way, through its own network security config (below). Expo CLI
gives the app the machine's LAN address unless `REACT_NATIVE_PACKAGER_HOSTNAME` names another, and
runs `adb reverse` for Metro's port before it opens the app on an emulator or a USB phone. So:

- an emulator or a phone on USB reaches Metro at `localhost` (`REACT_NATIVE_PACKAGER_HOSTNAME=localhost`),
  or at the LAN address, which the emulator reaches through its NAT;
- a phone on Wi-Fi alone reaches it at the LAN address, or at the machine's tailnet address with
  `REACT_NATIVE_PACKAGER_HOSTNAME` set to that.

Release builds carry their bundle, and allow no plain http except a development build's to
`localhost`, `127.0.0.1` and `10.0.2.2`. On iOS the development variant, debug or release, may reach
IP addresses, unqualified names and `.local` names over http (ATS's local networking exception), so an
iPhone on Wi-Fi reaches Metro at the LAN or tailnet address; preview and production may not.

### On a Mac

iOS builds need Node 26.13.0, pnpm 10.15, a current Ruby with CocoaPods, Xcode and a simulator runtime.
Export `COCOAPODS_DISABLE_STATS=true` too, so `pod install` (which prebuild runs) sends CocoaPods no
statistics. A simulator build needs no signing; `modules/socio-device/README.md` has the commands for a
headless one. A phone needs Ingenio Ventures' signing or a Personal Team.

## Release builds

A release build carries its JavaScript bundle, which Gradle and Xcode make with Expo CLI
(`expo export:embed`), so the same switches apply. Every build also reads `app.config.ts` again, for
the config the app sees at runtime (`extra.variant` included), so it needs the `APP_VARIANT` the
native project was generated for. On Android, set them all for Gradle: the project records its
variant in `gradle.properties` (`socio.appVariant`), and the build fails when `APP_VARIANT` differs
(unset means development, as for prebuild).

```sh
cd android && APP_VARIANT=preview EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 DO_NOT_TRACK=1 ./gradlew assembleRelease
```

On iOS, Xcode's script phases read the switches and the variant from `ios/.xcode.env`, which the
config writes (with a Personal Team build's variables, below), so an Xcode or `xcodebuild` build needs
no environment of its own. The generated Podfile sets `COCOAPODS_DISABLE_STATS`, so `pod install`
sends CocoaPods no stats.

### Build numbers

Every build has a build number (iOS's `CFBundleVersion`, Android's `versionCode`), set at prebuild
from `SOCIO_BUILD_NUMBER` (`build-stamp.ts`): a positive whole number, at most 2100000000 (Google
Play's ceiling). Unset is 1, for local development builds; anything else fails the config. iOS
installs a build over the one on the phone, keeping its data, and the number tells them apart. The
preview and release builders pass the commit count of the main they build, so it rises with main,
with the short sha and the build date, which Settings shows:

```sh
SOCIO_BUILD_NUMBER=$(git rev-list --count HEAD) \
SOCIO_BUILD_COMMIT=$(git rev-parse --short HEAD) \
SOCIO_BUILD_DATE=$(date -u +%Y-%m-%d) \
APP_VARIANT=preview EXPO_NO_TELEMETRY=1 npx expo prebuild --clean
```

`ios/.xcode.env` keeps the three as the prebuild saw them, for the config Xcode embeds. Gradle has
no such file: `gradle.properties` records them (`socio.buildNumber`, `socio.buildCommit`,
`socio.buildDate`), and the build fails when Gradle's environment differs, so give Gradle the same
three (unset `SOCIO_BUILD_NUMBER` means 1). The app reads the version and build number from the
installed binary (socio-device's `appBuild`) and shows them at the bottom of Settings ("Version
0.1.0 (2829) · Preview", with the commit and date under it; a tap copies them) and at the top of
Diagnostics. After an install over another build it says once "Updated to build 2829 (was 2790)",
or "Older build installed: 2790 (was 2829)" (`src/shell/build-info.ts`).

A development client loads its config from Metro, not from the binary: its version and build number
still come from the binary, but the commit and date are whatever Metro's environment says, so start
Metro with the same `SOCIO_BUILD_*` to see them.

## Native build config

`app.config.ts` and its config plugins make the native projects. Our own are in `plugins/`; the ones
from T3 Code are in `vendor/t3code/plugins/` (`vendor/t3code/SYNC.md`).

- **Network** (Android, `plugins/network-security.ts`). Production trusts system CAs only. Preview and
  development also trust CAs the user installed, for test workspaces on a private CA. No release build
  allows plain http, except development's to `localhost`, `127.0.0.1` and `10.0.2.2`. Debug builds
  allow it to every host, for Metro, and keep their variant's CAs: their own file of the same name, in
  the `debug` and `debugOptimized` source sets, replaces main's.
- **App Transport Security** (iOS, `plugins/transport-security.ts`) is on in every build. Only
  development keeps the local networking exception.
- **Backups** (Android, `plugins/backup-rules.ts`). Neither cloud backup nor a device transfer takes
  `files/socio/` (every workspace's files and the registry) or expo-secure-store's
  `SecureStore.xml`. iOS has no build-time rules: there the app excludes the store from backup
  itself.
- **The device store**: SQLCipher and FTS5 (`expo-sqlite`'s plugin options), with `expo-sqlite` built
  from source (`package.json`), since a prebuilt one has no cipher.
- **The build environment** (`plugins/build-env.ts`): Expo's three switches and the prebuild's
  variant in `ios/.xcode.env`, the variant check in `android/app/build.gradle` (Release builds,
  above), and no CocoaPods stats.
- **Push** (`expo-notifications`' plugin and `plugins/push.ts`): Android's notification icon (the
  mascot's silhouette, `assets/notification-icon.png`) and tint (the web's primary); iOS's
  `aps-environment`, `development` for the development variant and `production` for the others unless
  `SOCIO_APS_ENVIRONMENT` says otherwise (below), and no background remote notifications. The keychain groups are `$(AppIdentifierPrefix)<id>` first, so
  expo-secure-store keeps writing to the app's own group, then `$(AppIdentifierPrefix)<id>.shared`, the
  one the notification extension will share. On Android, Firebase takes no token at first launch and
  sends no Analytics or delivery metrics, and `RECEIVE_BOOT_COMPLETED` is removed (the app schedules no
  notifications). `getExpoPushTokenAsync` is banned by the lint (it would hand the token to Expo's push
  service); import `expo-notifications` by name.
- **FCM**: `google-services.json` is never committed. Prebuild reads it from the path in
  `GOOGLE_SERVICES_JSON` (absolute, or relative to `apps/mobile`); a path with no file fails. Without
  it, Android builds with no FCM, receives no push, and prebuild warns.
- **The push relay**: `SOCIO_RELAY_ORIGIN` at prebuild (`relay-origin.ts`) is the relay the build
  registers with (`apps/push-relay`), embedded as `extra.relayOrigin`: an origin alone, over https, or
  plain http to `localhost`, `127.0.0.1` or `10.0.2.2` in development (`wrangler dev` behind `adb
  reverse`); anything else fails the config. Unset, the build registers nothing, and Technical details
  says "Off: this build has no push relay". `ios/.xcode.env` keeps it, and `gradle.properties` records
  it (`socio.relayOrigin`) with the build stamp, so give Gradle and Metro the same value.
- **The APNs environment**: `SOCIO_APS_ENVIRONMENT` at prebuild (`aps-environment.ts`, `development` or
  `production`) overrides the variant's for both the `aps-environment` entitlement and
  `extra.apsEnvironment`, from which the app registers with the relay as `sandbox` or `production`;
  anything else fails the config. Unset, development is `development` and preview and production are
  `production`. A development-signed build (a preview exported with `method: debugging`) gets sandbox
  tokens, so it must set `SOCIO_APS_ENVIRONMENT=development`. `ios/.xcode.env` keeps it, and
  `gradle.properties` records it (`socio.apsEnvironment`, '' for the variant's default), checked like
  the stamp.
- **The link domain** (`plugins/app-links.ts`): production and preview use `link.socio.sh`;
  development uses `SOCIO_LINK_HOST` at prebuild (a plain host name, such as the bench's quick tunnel),
  `link-staging.socio.sh` when unset. Set for preview or production, it fails the config. Each variant's
  associated domains (`webcredentials` and `applinks`, `?mode=developer` in development) and Android
  App Link filter (its own `pathPrefix` only) are on it, embedded as `extra.linkHost`. `ios/.xcode.env`
  keeps it, and `gradle.properties` records it (`socio.linkHost`), checked like the stamp. The sheet's
  https callback works only in builds signed by the Ingenio team: a Personal Team build has no
  associated domains (development falls back to `socio-dev://auth-callback`).
- **Google and Apple sign-in** (CB-570, `plugins/social-sign-in.ts`): Google on iOS needs the build's
  iOS OAuth client id, which is never committed. Prebuild reads it from `SOCIO_GOOGLE_IOS_CLIENT_ID` for
  production and `SOCIO_GOOGLE_IOS_PREVIEW_CLIENT_ID` for preview (`<number>-<id>.apps.googleusercontent.com`;
  anything else fails the config without echoing it) into `extra.googleIosClientId`, and registers its
  reversed form (`com.googleusercontent.apps.<…>`) as a URL scheme. Development reads neither, so its
  iOS builds have no Google; unset, the iOS Google button doesn't show. `ios/.xcode.env` keeps the
  variant's variable for the config Xcode embeds (a generated file, never committed); Android needs
  neither (Credential Manager takes the server's client id from the server), so Gradle records nothing.
  The preview and release builders pass it to prebuild without printing it. On the build box the ids
  sit in a mode-600 file under their own names (`GOOGLE_IOS_CLIENT_ID`, `GOOGLE_IOS_PREVIEW_CLIENT_ID`),
  so a builder sources it and hands the variant's id on under the name prebuild reads:

    ```sh
    set -a; . ~/.config/socio-google/ids.env; set +a   # never echo it
    SOCIO_GOOGLE_IOS_PREVIEW_CLIENT_ID="$GOOGLE_IOS_PREVIEW_CLIENT_ID" \
      APP_VARIANT=preview EXPO_NO_TELEMETRY=1 npx expo prebuild --clean -p ios
    # production: SOCIO_GOOGLE_IOS_CLIENT_ID="$GOOGLE_IOS_CLIENT_ID" ... APP_VARIANT=production
    ```

    Sign in with Apple's entitlement (`com.apple.developer.applesignin`) is in production and preview
    only: expo-apple-authentication's plugin adds it whenever the package is installed, and the
    development variant (whose App ID lacks the capability) and Personal Team builds take it out
    (`extra.appleSignIn` false). Neither the server nor the repository holds a Google or Apple client id
    or secret: the server gives Google's `serverClientId` from its start.

- **App Store Connect** (iOS): `ITSAppUsesNonExemptEncryption` is false (HTTPS and SQLCipher's AES
  through CommonCrypto are exempt, the owner's 2026-11-10 decision), so no TestFlight build waits on
  export compliance; the privacy manifest (`privacyManifest`, `ios.privacyManifests`) declares no
  tracking, the data the app sends to the workspace server (TestFlight testers use servers Ingenio
  runs, so it counts as collected), the push token when the build has a relay, and the
  required-reason APIs of the app and its native modules, with `pod install` adding the pods' own;
  the App Store icon is `assets/icon-ios-1024.png`, 1024 px and opaque, rendered by
  `scripts/locals/app-icon.mjs`. `tests/app-store.test.ts` runs a production prebuild on a scratch
  copy, without and with `SOCIO_RELAY_ORIGIN`, and checks all three and the bundle id. App Store
  Connect's App Privacy answers, to match the manifest:
    - Do you or your third-party partners collect data from this app? **Yes.**
    - **Email Address** (Contact Info): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **Name** (Contact Info): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **User ID** (Identifiers): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **Emails or Text Messages** (User Content): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **Photos or Videos** (User Content): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **Customer Support** (User Content): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **Other User Content** (User Content): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **Search History** (Search History): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **Product Interaction** (Usage Data): collected; linked: yes; tracking: no; purposes: App Functionality only.
    - **Device ID** (Identifiers), only for a build with `SOCIO_RELAY_ORIGIN` (every build that ships
      push): collected; linked: yes (the workspace server keeps the relay registration id with the
      account, and Ingenio runs both); tracking: no; purposes: App Functionality only.
    - Every other type (Phone Number, Physical Address, Other Contact Info, Health, Fitness,
      Financial Info, Location, Sensitive Info, Contacts, Audio Data, Gameplay Content, Browsing
      History, Purchases, Advertising Data, Other Usage Data, Crash Data, Performance Data, Other
      Diagnostic Data, Environment Scanning, Hands, Head, Other Data Types): not collected.
    - The link domain (`apps/link`, `link.socio.sh`) adds no type here or in Play's Data safety
      form: the app sends it nothing (a verified link opens the app without a request), and only a
      browser that opened a link without the app, or Apple's and Google's verifiers, fetch from it.
      What it sees, a path naming the workspace's host and never a code or token, and that it keeps
      and logs nothing, is SECURITY.md's "Link domain (the mobile app)"; the store privacy
      disclosures say the same.
- **From T3 Code**: Gradle's heap, predictive back on Android 13 to 15, Android's alert dialog and
  popup menu in the app's colors and the system font, and Personal Team builds.

`expo config --type introspect` shows most of what the plugins set, for each `APP_VARIANT`, and
`tests/native-config.test.ts` checks it. It doesn't run the plugins that write files (the `res/xml`
rules, `ios/.xcode.env`, `android/app/build.gradle`), so check those in the generated projects, or in
a built APK with `aapt2 dump xmltree`.

### Personal Team builds

Without a paid Apple team, an Xcode account has only a Personal Team, which can't sign our bundle
ids, push, Sign in with Apple, app groups or our keychain groups. Build for your own iPhone under a bundle id you control,
without those capabilities:

```sh
SOCIO_IOS_PERSONAL_TEAM=1 SOCIO_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.socio.dev \
  EXPO_NO_TELEMETRY=1 npx expo prebuild --clean -p ios
```

`ios/.xcode.env` keeps both variables for the build, and a normal prebuild clears them there.

## Native modules

Native code of the app's own lives in local Expo modules under `modules/`, which Expo autolinking finds by
itself: no `package.json` entry, and prebuild links them like any package. Each has its README.

- `modules/socio-device`: backup exclusion and file protection on iOS, protected-data state, the process's
  start time, and Android's `reportFullyDrawn()`.
- `modules/socio-push`: the Web Push keys, made and kept natively, the RFC 8291 decryptor and the
  inbox files the notification extension (iOS) or the messaging service (Android) writes.
- `modules/socio-google-signin`: the phone's own Google sign-in for one ID token (Google's GoogleSignIn
  SDK on iOS, Credential Manager on Android), CB-570.

## End-to-end tests

Maestro flows live in `e2e/flows/`. They run by hand: no package script runs them, and CI doesn't.
`tests/e2e-harness.test.ts` covers the seed plan and both scripts' arguments.

Install Maestro 2.12.1 (with JDK 17) from the release's `maestro.zip` into `~/.maestro`, checking it
against the release's `checksums_sha256.txt`. `e2e/run.mjs` runs it with `MAESTRO_CLI_NO_ANALYTICS=1`,
both notices off, and `MAESTRO_API_URL=http://127.0.0.1:1`: whatever the other switches say, 2.12.1 asks
its API for its latest version at every start (with an install id) and posts error reports there. Never
pass `--analyze`.

### Local servers

```sh
pnpm run build                                  # at the repository root, once per server change
node apps/mobile/e2e/servers.mjs --count 3      # Ctrl-C stops everything
```

It starts the fake model (`tests/fixtures/serve-fake-model.ts`) on 4550 and one to three servers from the
build on 4351, 4352 and 4353 (`--ports` and `--model-port` pick others). Each server gets every setting
from the script and nothing from the shell or a `.env`: PATH, its own database and backup folder in a
temporary directory, Better Auth with `APP_ORIGIN=http://localhost:<port>`, and the fake model as its only
provider. Each has `ada@example.test` (admin), `ben@example.test` (member), `cy@example.test`
(deactivated) and `opal@example.test` (operator), and is seeded through the API as Ada with the name
"Workspace A" (B, C; Opal sets it as the branding's name too, which the app shows), the Space
"A only", the chat "A: kickoff" with one turn ("A: smoke long", which gets the fake model's long answer)
and the archived chat "A: archived". Rooms are on (`ROOMS_ENABLED=true`) unless `--no-rooms` leaves them off and the room out. For the room screens each gets the room
"A: launch room", made by Ada with Sebas as its lead and Manny, a second company socio she makes; Ben is
invited and joins. Its history: Ada's opening, whose turn calls tools (Ben's copy has their results
withheld); "@Sebas @Manny …", which Sebas answers and then hands to Manny (a handoff note); and Ben's
message, sent under a one-token limit so its turn fails, after which the limit goes. The room is seeded only
where it is missing, so a second run over the same server adds nothing. `--capture <dir>` writes the first
workspace's room `history` and `transcript`, as Ada and as Ben (`room-<page>-<ada|ben>.json`): the app's
`tests/fixtures/room-*.json` came from it. The fake model's existing phrases cover approvals ("smoke
approvals", "smoke data"). For the issue, memory and schedule screens each also gets, through the API:
one issue in each status (Ben files the triage one; Ben votes and comments on the open one; the one in
progress has a picture), two memories and a profile for Ada, and a repeating task ("A: weekly digest of the board",
every week, in its own chat "A: digest"; it runs once when seeded, and the script fails unless that run finishes and the chat reads "A: digest" again). Goals and jobs have no HTTP create,
so they stay in the Node tests' fake server. The script checks that every seed is there before it
reports ready, and the credentials file lists them, with the issues' numbers and the room's id, its socios' ids and Ada's and Ben's. The password is new each run, in
the credentials file the script prints (mode 600). It adds `adb reverse tcp:<port> tcp:<port>` for
each (`--device` or `ANDROID_SERIAL` picks the device, `--no-adb` skips it) and removes those rules at the end. `--once` seeds and stops. The children run under
`scripts/egress-log.mjs`, and the script exits 3 if the log shows a connection off the machine.
Loopback HTTP on `--control` (4549) restarts every workspace on its own database, a new process with the
sessions and data kept and nothing seeded again: `POST /restart`, or `POST /restart?ahead=8` with the servers' clock eight days on
(`e2e/clock-ahead.mjs`), past the week a session lasts, so the app's next request gets the 401 of an
expired session; `?ahead=0` puts the real clock back. Flows send it through `common/servers.yaml`.
A restart also takes the app versions the servers serve (CB-553): `?minimum=0.99.0` and `?recommended=0.99.0`
(`APP_MINIMUM_VERSION`, `APP_RECOMMENDED_VERSION`: Update Socio, the banner) for every workspace, or `?minimum=B:0.99.0`
for B alone, and `?version=B:0.53.0`, the
server version workspace B reports (`e2e/server-version.mjs`), so only B shows "needs a server update";
repeat each for more. A restart names everything it wants: a plain `POST /restart` is back to the
defaults. Flows send it through `common/compat.yaml` (`QUERY`).

Sign-in is limited to 30 a minute per address, and the script, the emulator and Maestro all arrive from
127.0.0.1, so space out reruns: the script signs in three times per server (Ada, Opal and Ben), so a
`--count 3` start takes nine. A Mac's simulator reaches the Linux host's servers through an SSH tunnel on the
same ports, which keeps the host `localhost` (The flows, below).

The contract tests (`tests/contract/`) run the app's request code against such a server under Node.
They skip unless `SOCIO_CONTRACT_CREDENTIALS` names the credentials file:

```sh
node apps/mobile/e2e/servers.mjs --ports 4381 --model-port 4581 --no-adb
cd apps/mobile && SOCIO_CONTRACT_CREDENTIALS=<credentials file> pnpm exec vitest run tests/contract
```

### Someone else in the room

`e2e/act-as.mjs` acts as Ben through the API of a workspace in the credentials file (`--workspace A`, the
default), for flows and push tests that need another person:

```sh
node apps/mobile/e2e/act-as.mjs --credentials <file> message [--text <text>] [--no-wait]
node apps/mobile/e2e/act-as.mjs --credentials <file> invite
node apps/mobile/e2e/act-as.mjs --credentials <file> cancel
node apps/mobile/e2e/act-as.mjs --credentials <file> read [--text <text>]
node apps/mobile/e2e/act-as.mjs --credentials <file> issues --text <title>
node apps/mobile/e2e/act-as.mjs --credentials <file> comments --issue <title> --text <comment>
node apps/mobile/e2e/act-as.mjs --credentials <file> web-file --text <title> [--count <n>]
node apps/mobile/e2e/act-as.mjs --credentials <file> web-retitle --text <title> --to <title>
node apps/mobile/e2e/act-as.mjs --credentials <file> web-delete --text <title>
node apps/mobile/e2e/act-as.mjs --credentials <file> web-sign-out
node apps/mobile/e2e/act-as.mjs --credentials <file> web-invite [--link-host <host>]
```

`message` sends Ben's message to the seeded room with a mention of Ada (`@Ada` in the text and her id in
`mentions`, as the web's people picker does), then waits until the history holds it and the socio's turn
has ended: a mention is pushed only after that, and only while Ada has no tab or app in use (otherwise she
gets an in-app notice). `invite` makes Ben's own room ("A: Ben's room", once) and invites Ada; `cancel`
takes the invite back. `read` finds Ada's newest message in the room's transcript (holding `--text` when
given) and fails unless the server checked a mention of Ben on it (`room-send.yaml`'s second half). `issues`
counts the board's issues titled exactly `--text` and lists their attachments (name, type, size), and fails
unless there is exactly one (`file-issue-offline.yaml`'s count). `comments` counts the comments saying
exactly `--text` on the one issue titled `--issue`, and fails unless there is exactly one (the chaos
flows' comments go once, with no second copy). The `web-` commands are Ada, the
admin, on the web in a sign-in of her own, for the issue chaos flows (Chaos below): `web-file`
files an issue titled `--text` (with `--count`, n of them titled `<text> 1` to `<text> n`: the Board tour
fills the Board to about the live board's 330 rows), `web-retitle` gives the one titled `--text` the title `--to`, `web-delete`
deletes it, and `web-sign-out` signs her out everywhere (the web's `/api/auth/revoke-sessions`), so the
app's next answer is a 401 before its session's expiry. `web-invite` adds a made-up member
(`invitee-<random>@example.test`) as People's Add person does and prints their email and the invite as
the development build's link (`https://link-staging.socio.sh/dev/i/<host>#t=<token>`, or `--link-host`'s,
built with shared's `appLink`): the server makes link-domain invites only for https workspaces. Each
prints one JSON line of ids. `tests/contract/rooms-seed.test.ts` runs the seed
a second time (nothing is added) and all three commands against such a server.

### A push without FCM (Android)

Until a build has `google-services.json`, `e2e/debug-push.mjs` hands an Android debug build's messaging
service a push through its debug-only receiver (`modules/socio-push/android/README.md`, Debug hook): it
makes new keys for a made-up workspace and registration on the phone, encrypts the server's payload to
them with web-push, and sends the relay's FCM data. No server, relay or network is involved.

```sh
node apps/mobile/e2e/debug-push.mjs [--serial emulator-5554] [--count 2] [--tag room-1] [--generic]
```

`--title`, `--body` and `--link` set the payload; `--workspace`, `--registration` and `--name` the ids and
the workspace's name; `--package` another variant's id. `--credentials <file>` (servers.mjs's, with `--letter`, A by default)
aims it at Ada's copy of that workspace's seeded room: the app's id for the workspace (the
SHA-256 of the origin, a newline and Ada's app user id), its name, and a mention linking to the room, so
tapping it opens the room. Grant the notification permission first
(`adb shell pm grant <id> android.permission.POST_NOTIFICATIONS`).

### Running flows

Install a development build (Running it, above), start Metro on loopback
(`EXPO_UNSTABLE_BONJOUR=0 pnpm start --port 8098 --localhost`), then:

```sh
node apps/mobile/e2e/run.mjs --metro 8098 [--device emulator-5554] [flow.yaml ...]
```

It runs `flows/launch.yaml` (or the flows named) with `APP_ID`, the variant's id, and `DEV_CLIENT_URL`, the
development client's link to Metro (empty without `--metro`), so a flow starts with `appId: ${APP_ID}`.
On Android, `--metro` adds `adb reverse` for Metro's port and removes it at the end. `--variant preview`
or `production` runs a build that carries its bundle, `--platform ios` the booted simulator, and `--out`
keeps the output in a folder of your choice. Flows reach chaos-proxy.mjs's and servers.mjs's control ports as
`PROXY_CONTROL` and `SERVERS_CONTROL` (`common/proxy.js`, `common/servers.js`): 4459 and 4549, unless
`--proxy-control` and `--servers-control` name a second set's, started beside another run's with
`servers.mjs --ports --model-port --control` and `chaos-proxy.mjs --port --listen --control`. After each flow it lists the app's whole container from the
host: on Android `adb shell run-as <id> find .` (a debuggable build) and the external folder, on iOS a
`find` of `xcrun simctl get_app_container booted <id> data`.

### The flows

| Flow                             | Servers | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch.yaml`                    | none    | A cleared app (on iOS the simulator's keychain too) opens on Add workspace. Every other flow starts with it.                                                                                                                                                                                                                                                                                                                        |
| `store-encrypted.yaml`           | none    | Diagnostics' scratch store: both files read back `cipher_status 1` and a header that isn't SQLite's.                                                                                                                                                                                                                                                                                                                                |
| `sign-in.yaml`                   | 1       | A wrong password and the deactivated Cy each keep the sign-in screen with their own words; Ada lands on Home with "A: kickoff".                                                                                                                                                                                                                                                                                                     |
| `sign-out.yaml`                  | 1       | Files planted through Diagnostics show in its listing; sign-out from More's Account ends on Add workspace; on iOS, after a trip to the background, no app-switcher snapshot is left.                                                                                                                                                                                                                                                |
| `leave-workspace.yaml`           | 1       | Leave workspace (CB-383) in More's Account: off for Ada (A's only admin) with the server's reason; for Ben the row, the question, Cancel keeps all; `--env LEAVE=true` leaves and lands on Add workspace (Ben can leave once per servers.mjs run). Android.                                                                                                                                                                         |
| `switch-three.yaml`              | 3       | A, then B and C added from the drawer, then switches to A and B: each time only the open workspace's marker chat shows.                                                                                                                                                                                                                                                                                                             |
| `switch-three-offline.yaml`      | stopped | After `switch-three.yaml`: a cold relaunch with every server stopped opens B alone.                                                                                                                                                                                                                                                                                                                                                 |
| `client-compat.yaml`             | 1       | After `sign-in.yaml`: a minimum above the build shows Update Socio over A (Check again, Add a workspace; Open TestFlight on iOS); lowered, the return to the foreground brings A back; a recommended version above the build shows the banner, and Not now keeps it away.                                                                                                                                                           |
| `chat-open.yaml`                 | 1       | Ada opens A's marker chat from Home: its seeded turn shows from the end.                                                                                                                                                                                                                                                                                                                                                            |
| `chat-open-offline.yaml`         | stopped | After `chat-open.yaml`: a cold relaunch opens on the chat from the phone's copy; Back, then its row, opens it again offline.                                                                                                                                                                                                                                                                                                        |
| `room-open.yaml`                 | 1       | Ada opens A's room from Home: who wrote each message, the handoff and the failed turn as lines, the header's status; its socios open Members.                                                                                                                                                                                                                                                                                       |
| `room-open-offline.yaml`         | stopped | After `room-open.yaml`: a cold relaunch opens on the room from the phone's copy, header included; Back, then its row, opens it again offline.                                                                                                                                                                                                                                                                                       |
| `room-send.yaml`                 | 1       | After `room-open.yaml`: `@be` lists Ben and the socios over the box, Ben is picked, `@Manny` makes the line say who answers, and the message sends; then `act-as.mjs read --text "RM3a from the app"` checks Ben was mentioned.                                                                                                                                                                                                     |
| `room-invite.yaml`               | 1       | After `act-as.mjs invite`: Ben's invite shows above Home's Rooms (with New room) and at the top of Chats; its sheet shows what joining shares, Join opens the room; its menu sets the notification level to Muted.                                                                                                                                                                                                                  |
| `room-create.yaml`               | 1       | Ada's compose menu in Chats (New chat / New room) opens New room; Sebas leads, Manny and Ben and Opal are picked in their sheets with search; Create opens the room in Chats, and her message goes. Home's New room opens the same form (CB-470).                                                                                                                                                                                   |
| `space-open.yaml`                | 1       | Ada opens A's Space from Home's Spaces tile: Recent lists its handbook and subpage; All pages shows the handbook, which expands to its subpage.                                                                                                                                                                                                                                                                                     |
| `space-open-offline.yaml`        | stopped | After `space-open.yaml`: a cold relaunch opens on the Space from the phone's copy, the tree too; Back leads to Home.                                                                                                                                                                                                                                                                                                                |
| `space-menus.yaml`               | 1       | After a seeded photo (attach-photo.yaml's header): New page shows "Field notes" at once; the subpage's cover set from the photo picker, removed and put back with Undo; Move's picker; the new page deleted after the web's confirm.                                                                                                                                                                                                |
| `board-open.yaml`                | 1       | Ada opens the Board from Home's tile ("6 open"): Triage holds Ben's filing, Open the voted issue; High priority narrows it and is kept, won't fix shows on request.                                                                                                                                                                                                                                                                 |
| `board-open-offline.yaml`        | stopped | After `board-open.yaml`: a cold relaunch opens on the Board from the phone's copy, on its kept column and filter; Clear, then a search over what it holds; Back leads to Home.                                                                                                                                                                                                                                                      |
| `board-swipe.yaml`               | 1       | A swipe left on the Board's cards turns from Triage to Open, then Ready, each chip chosen in turn; a swipe right goes back; a vertical drag keeps the column; a chip still chooses; on iOS a swipe from the left edge is still Back (CB-468).                                                                                                                                                                                       |
| `issue-detail.yaml`              | 1+proxy | After `board-open.yaml`: Ada opens the open issue (Ben's vote and comment); with the server away a vote and a comment show at once, waiting to send, then go once each when it is back; a cold relaunch opens on the issue.                                                                                                                                                                                                         |
| `send-and-stream.yaml`           | 1       | After opening the chat: a send streams the fake model's slow reply under the pill, a message typed meanwhile queues, Stop ends it.                                                                                                                                                                                                                                                                                                  |
| `send-offline.yaml`              | stopped | After `chat-open.yaml`: a message sent offline shows at once as waiting to send, and is still there after a cold relaunch.                                                                                                                                                                                                                                                                                                          |
| `attach-photo.yaml`              | 1       | After a seeded photo (the flow's header): the system photo picker's photo shows in the tray, then sends with a line and shows as a thumbnail.                                                                                                                                                                                                                                                                                       |
| `chaos-offline.yaml`             | 1+proxy | After `chat-open.yaml`: with the server away a message waits, survives a kill and a relaunch still offline, then sends once when it is back.                                                                                                                                                                                                                                                                                        |
| `chaos-stream.yaml`              | 1+proxy | After `chat-open.yaml`: a slow reply's follow stream drops, then the server goes away mid-turn; the reply goes on once it is back.                                                                                                                                                                                                                                                                                                  |
| `chat-tour.yaml`                 | 1+proxy | The chat tour, on servers.mjs `--no-rooms`: a reaction, a page review saved and one skipped, every chat archived, the first run, the offline new chat, traces, Settings, Technical details, Diagnostics, then the Expired banner after a 401 past the session's expiry and its Sign in.                                                                                                                                             |
| `link-cold-room.yaml`            | 1       | Android, after `chat-open.yaml`, with the app's process killed and `debug-push.mjs --credentials` posting a mention: the shade's notification opens the room on a cold start in the Chats tab, in place of the kept chat; Back leads to the chat list (not the real tap through FCM).                                                                                                                                               |
| `tab-stacks.yaml`                | 1       | With `--env ROOM_ID=<id>` (the credentials file's room): a chat opened from Chats keeps the tab bar under it, Chats keeps it while Home shows, a re-tap of Chats and Back each pop to the list, and the room's link from Home opens it in the Chats tab over the list; then the Spaces tab's list, a Space and a page inside it, and a re-tap back (CB-459); and Search's field.                                                    |
| `spaces-attention.yaml`          | 1       | One phone behind `chaos-proxy.mjs`, after `page-two-offline.yaml` and the web's `act-as.mjs web-page-write` on the same line: the proxy back, the save meets the change and the page leads the Spaces list under "Pages changed elsewhere" (the Spaces badge counts it); its row opens the page under the conflict banner; Chats no longer shows it (the owner, 2026-11-20).                                                        |
| `notifications.yaml`             | 1       | Settings → Notifications: Settings' row and the test notification's link open it; push's content saved and set back, the show-text switch, "Hide my presence in rooms" on and off, and the test's answer.                                                                                                                                                                                                                           |
| `approve.yaml`                   | 1       | After opening the chat: "smoke approvals" makes two cards and the bar ("1 of 2"); one approved from the bar, one on its card, then the socio carries on.                                                                                                                                                                                                                                                                            |
| `approve-offline.yaml`           | 1       | The same two requests, then airplane mode: the bar and the cards say "Needs a connection", Approve and Deny do nothing; back online both still wait and Approve works.                                                                                                                                                                                                                                                              |
| `approvals-chats.yaml`           | 1       | After opening the chat: two requests wait; Chats shows them first, over the chats, See all lists them, one approved on the list and one on its page; a link to a request that isn't there says so.                                                                                                                                                                                                                                  |
| `issue-admin.yaml`               | 1+proxy | After `board-open.yaml`: Ada (an admin) opens the open issue's fields; the assignee sheet lists the people; with the server away a status change shows at once, waiting to send, and the assignee sheet shows the last list with "Needs a connection"; it goes when the server is back, and a cold relaunch shows it.                                                                                                               |
| `file-issue-photo.yaml`          | 1       | After `board-open.yaml` and a seeded photo: New issue opens on Bug and Medium; a title, High and the photo from the picker; File lands on the issue as CB-?, which gets its number and the photo; the Board's Triage lists it.                                                                                                                                                                                                      |
| `file-issue-offline.yaml`        | 1+proxy | After `board-open.yaml` and a seeded photo, the server away: an issue filed with a photo waits as CB-?, through a force-stop and a cold relaunch; back online it gets its number and the photo; then `act-as.mjs issues --text "FI: Filed while the server was away"` finds exactly one, with one file.                                                                                                                             |
| `chaos-issues-queue.yaml`        | 1+proxy | After `board-open.yaml` and `act-as.mjs web-file` for three issues: with the server away, a comment and title edits on them and a comment on the open issue wait; a force-stop, a relaunch still offline, Clear cache and a cold reopen leave exactly those five waiting.                                                                                                                                                           |
| `chaos-issues-settle.yaml`       | 1+proxy | After the web deletes one, retitles two and signs Ada out everywhere: back online, the 401 locks the copy; signed in again, the comment goes, the deleted issue's two writes go to Unsent, and Keep mine and Keep theirs settle the two conflicts.                                                                                                                                                                                  |
| `chaos-issues-expired.yaml`      | 1+proxy | After `chaos-issues-settle.yaml`: a comment waits while the server's clock moves past the session's expiry; the Expired banner holds it, and it goes once after Sign in.                                                                                                                                                                                                                                                            |
| `a3-tour.yaml`                   | 1+proxy | The Board tour, after `board-open.yaml` and `act-as.mjs web-file --text "XB3: Deleted on the web"`: `issue-detail.yaml`, `issue-admin.yaml` and `file-issue-offline.yaml`; Memories (the seeded proposal remembered, a memory edited and forgotten); Schedules (pause, resume, Run now refused offline); Runs and a trace; Learning; Search for `CB-2` and a page; a comment queued offline on the web's issue (Board tour, below). |
| `a3-tour-unsent.yaml`            | 1+proxy | After `a3-tour.yaml` and `act-as.mjs web-delete --text "XB3: Deleted on the web"`: back online the comment goes to the Unsent list ("You no longer have access"), Diagnostics' Outbox line counts it.                                                                                                                                                                                                                               |
| `a3-large-text.yaml`             | 1       | After the tour, with the system's text at its largest: the Board, the issue and its comments, New issue and Memories, screenshotted.                                                                                                                                                                                                                                                                                                |
| `page-two-offline.yaml`          | 1+proxy | One phone's half of two devices on one page (Two devices, below): the page shows the web's new base (`--env BASE`), the server goes away, `TEXT` typed on `LINE` (a new paragraph with `ENTER=true`) waits to send, also in the reader after Back.                                                                                                                                                                                  |
| `page-two-settle.yaml`           | 1+proxy | That phone back: a cold reopen sends the save; `RESULT` saved, merged (the toast) or conflict (the banner, Unsent 1, then `RESOLVE` mine or theirs after its confirm); the page shows `EXPECT` and the Outbox line reads `OUTBOX`.                                                                                                                                                                                                  |
| `page-offline-typing.yaml`       | 1+proxy | Two minutes of offline typing in one paragraph (24 bursts 5 s apart); back online the editor says Saved and the proxy counted one or two page saves and no page read, so no merge.                                                                                                                                                                                                                                                  |
| `page-kill-save.yaml`            | 1+proxy | A kill mid-save: the proxy holds the answers (`stall`), so the save reaches the server unheard; killed on "Saving…", reopened online: the text shows once, no banner, nothing left but sent rows.                                                                                                                                                                                                                                   |
| `page-clear-cache.yaml`          | 1+proxy | After `page-two-offline.yaml`, still offline: Settings' Clear cache keeps the queued save, also after a cold reopen.                                                                                                                                                                                                                                                                                                                |
| `page-gone.yaml`                 | 1+proxy | After `page-two-offline.yaml` and `act-as.mjs web-page-delete`: back online the save goes to Unsent ("This page was deleted").                                                                                                                                                                                                                                                                                                      |
| `pages-tour.yaml`                | 1+proxy | The pages tour: the Spaces, the library, the tree, Keep offline, the page, the editor; offline (Android's airplane mode, the server away on iOS) the kept Space's pages read from the phone; a "smoke review" edited in the editor and saved with the edits.                                                                                                                                                                        |
| `pages-large-text.yaml`          | 1+proxy | With the system's text at its largest, after a same-line conflict was set up: the library, the page, the editor and the conflict banner, screenshotted; Keep theirs settles it.                                                                                                                                                                                                                                                     |
| `getting-in-invite.yaml`         | 1 codes | After `act-as.mjs web-invite` (`--env INVITE_EMAIL= --env INVITE_LINK=`): the invite starts the cleared app cold; Join, the set-password form, then A's marker chat.                                                                                                                                                                                                                                                                |
| `getting-in-workspace-link.yaml` | 1 codes | The workspace QR code's `w` link opens Confirm with A filled in; SignIn offers the sheet, the code and the password; Ada's password lands on A.                                                                                                                                                                                                                                                                                     |
| `getting-in-sheet.yaml`          | 1 codes | The `w` link, then SignIn's Continue: the workspace's web sign-in in the sheet (Chrome's tab on Android), Ada's password and the Continue page, back through the verified callback to Home.                                                                                                                                                                                                                                         |
| `getting-in-email.yaml`          | 1 codes | "Email me a code" on A: the code the SMTP sink got, typed in, lands on A.                                                                                                                                                                                                                                                                                                                                                           |
| `getting-in-telegram.yaml`       | 2 codes | "Send a code to my Telegram" on B: the code the fake Telegram got, typed in, lands on B.                                                                                                                                                                                                                                                                                                                                            |
| `add-device.yaml`                | 1 codes | Add a device: the web's QR link, Continue, the 6 digits typed on the web (never in its polls), then A's marker chat.                                                                                                                                                                                                                                                                                                                |
| `device-erased.yaml`             | 1 codes | After `add-device.yaml`: Sign out and erase on the web; the app's next request wipes the copy in silence, Add workspace shows.                                                                                                                                                                                                                                                                                                      |
| `add-device-race.yaml`           | 1 codes | Another device claims the QR code first: its redeem stays not allowed and the web never sees its digits; this device's Continue says the code was already used.                                                                                                                                                                                                                                                                     |
| `add-device-wrong-digits.yaml`   | 1 codes | Three wrong digits on the web: two tries left, one, then denied; the device stops with the words for it, and the right digits do nothing after.                                                                                                                                                                                                                                                                                     |

The flows that sign in need `--credentials <file>`, servers.mjs's credentials file. It hands them
`PASSWORD` and, per workspace letter, `ORIGIN_A`, `HOST_A`, `WORKSPACE_A`, `CHAT_A`, and `SPACE_A`, `PAGE_A` and `SUBPAGE_A`. Run `sign-out.yaml`
with `--no-workspace-left`: the flow fails if the host's listing still holds a `socio/<id>/` folder or an
answer in the system's HTTP cache (Android's `cache/http-cache/` entries; on iOS, rows of
`Library/Caches/<app id>/Cache.db` for a credentials origin, which run.mjs reads with `sqlite3`), a
WebView's stored data, an iOS app-switcher snapshot (any file under `Library/SplashBoard/Snapshots/` or
`Library/Caches/Snapshots/`: on iOS the flow sends the app to the background on Home first), or if
the listing failed (a command's error, or no `socio/registry.db` in it). Run `switch-three-offline.yaml` with
`--servers-down`: nothing runs while an origin from the credentials answers (from the Mac, that covers the
tunnel) or, on Android, while `adb reverse --list` still carries an origin's port.

```sh
node apps/mobile/e2e/servers.mjs --count 3 --device emulator-5554
install -m 600 <credentials file> /tmp/e2e-creds.json   # servers.mjs deletes its copy at Ctrl-C
F=apps/mobile/e2e/flows
node apps/mobile/e2e/run.mjs --metro 8104 --device emulator-5554 --credentials /tmp/e2e-creds.json \
  --no-workspace-left $F/sign-out.yaml
node apps/mobile/e2e/run.mjs --metro 8104 --device emulator-5554 --credentials /tmp/e2e-creds.json \
  $F/launch.yaml $F/store-encrypted.yaml $F/sign-in.yaml $F/switch-three.yaml
# Ctrl-C servers.mjs (it removes its adb reverse rules; on a Mac, close the tunnel too), then:
node apps/mobile/e2e/run.mjs --metro 8104 --device emulator-5554 --credentials /tmp/e2e-creds.json \
  --servers-down $F/switch-three-offline.yaml
```

Run `switch-three-offline.yaml` right after `switch-three.yaml`: it relaunches whatever the last flow left.

### Getting in

`servers.mjs --dev-links --codes` (two workspaces: `--count 2`) is the bench for the app's ways in, with a
development build (its link host `link-staging.socio.sh`, which serves only the development variant). With
`--codes` each workspace gets an SMTP sink and a fake Telegram (the repository's
`tests/fixtures/fake-telegram.ts`, `TELEGRAM_API_ROOT`) in servers.mjs's own process (`e2e/web-side.mjs`),
Ada's Telegram linked through it (`/start <code>`), and on A Opal saves "Sign-in links by email" on (a
password step-up), so A sends codes by email and B by Telegram. The control port then plays Ada on the web
(`/web/…`, JSON): `GET /web/outbox` (what each channel got, with the code in it), `POST /web/pair` (an Add
a device QR code, polled every 2 s as the page does, since a claim dies after 15 s without a poll), `POST
/web/confirm?digits=` (the page's confirm), `POST /web/other` (another device claims the QR code first),
`GET /web/pair?digits=` (the states the page saw, and whether any poll held those digits) and `POST
/web/erase` (Sign out and erase on every device of Ada's); each takes `?letter=`. Flows reach it through
`common/web.js` and `common/code.js`.

```sh
node apps/mobile/e2e/servers.mjs --count 2 --dev-links --codes --device emulator-5554
node apps/mobile/e2e/act-as.mjs --credentials /tmp/e2e-creds.json web-invite   # {"email", "link"}
node apps/mobile/e2e/run.mjs --metro 8104 --device emulator-5554 --credentials /tmp/e2e-creds.json \
  --env INVITE_EMAIL=<email> --env INVITE_LINK=<link> \
  $F/getting-in-invite.yaml $F/getting-in-workspace-link.yaml $F/getting-in-email.yaml \
  $F/getting-in-telegram.yaml $F/add-device.yaml $F/device-erased.yaml $F/add-device-race.yaml \
  $F/add-device-wrong-digits.yaml
```

An API 36 emulator verifies `link-staging.socio.sh` by itself (`pm get-app-links
com.ingenioventures.socio.dev` says `verified`); where it can't, approve it with `adb shell pm
set-app-links --package com.ingenioventures.socio.dev 2 link-staging.socio.sh`. An iOS simulator build
signed ad hoc (`CODE_SIGN_IDENTITY=-`, modules/socio-device's README) opens the host's universal links as
well. A development client started by a link shows its launcher first; `common/cold-link.yaml` picks the
Metro it last loaded, and the app then starts with the link. `getting-in-sheet.yaml` drives the
sheet (SignIn's Continue): the workspace's web sign-in in Chrome's tab on Android (Ada's password, then the
Continue page), back through the verified callback link to Home.

**Google and Apple** (CB-570): `servers.mjs --social` starts a fake of Socio's cloud services
(`e2e/fake-cloud.mjs`, on `--cloud-port`, 4548 by default) that every workspace enrolls with over
loopback, so the manifests offer Google and Apple. It verifies only a development build's test accounts:
SignIn and Settings → Account's Sign-in methods show a "Test account (development)" field under the
buttons, and a name typed there stands in for the phone's own Google or Apple sign-in (an unsigned token
with the server's nonce, Apple's hashed, `src/net/social-test-token.ts`); left empty, the real sheet
opens. `refuse-invalid`, `refuse-nonce`, `refuse-many` and `refuse-unavailable` get the service's
refusals (`invalid_token`, `nonce_invalid`, `too_many`, `provider_unavailable`), an account nobody
linked gets `not_linked`, and `cy-test` is linked to Cy, who is deactivated (`deactivated`). `POST
/web/social?google=off` (or `apple=`, `on` again) has Opal turn a provider off in the access policy
(`method_off`). Link `ada-test` in Settings as Ada first, sign out, then Continue with Google with the
same account. Nothing reaches Google, Apple or the real cloud. With the test account empty an iOS
development build shows neither button (no client id, no entitlement); Android keeps Google.

`flows/social-sign-in.yaml` runs that whole path on a development build (`--env PROVIDER=google`): the
buttons, `not_linked`, `provider_unavailable` and `deactivated` in the app's words, Ada's link in
Settings, a fresh install signing in as `ada-test`, then Unlink (after its question), which locks the
copy as Ended. It unlinks a link an earlier run left first, so it runs again against the same servers.
Maestro's element taps don't reach Apple's native button (an `ASAuthorizationAppleIDButton`): only a
tap at its point does, so the flow takes Google on both platforms.

```sh
node apps/mobile/e2e/servers.mjs --social --device emulator-5554
node apps/mobile/e2e/run.mjs --credentials <file> --env PROVIDER=google apps/mobile/e2e/flows/social-sign-in.yaml
```

### Chaos

`e2e/chaos-proxy.mjs` sits between the app and one workspace, so a flow (or a person) can break the
connection without touching the server: it points the device's `adb reverse tcp:4351` at itself (4451)
and puts servers.mjs's rule back when it stops. Keys or loopback HTTP on 4459 (`POST /drop`, `/down`,
`/up`, `GET /status`) drop the chat's follow streams, or play the server going away (every connection
reset, new ones refused) and coming back. The `1+proxy` flows tell it through `common/proxy.yaml`.

```sh
node apps/mobile/e2e/servers.mjs --device emulator-5554 --no-rooms   # chat-tour.yaml needs --no-rooms
node apps/mobile/e2e/chaos-proxy.mjs --device emulator-5554      # after servers.mjs is ready
node apps/mobile/e2e/run.mjs --metro 8104 --device emulator-5554 --credentials /tmp/e2e-creds.json \
  $F/chat-open.yaml $F/chaos-offline.yaml $F/chaos-stream.yaml
node apps/mobile/e2e/run.mjs --metro 8104 --device emulator-5554 --credentials /tmp/e2e-creds.json $F/chat-tour.yaml
```

From a Mac, tunnel the proxy rather than the server, and both control ports:
`ssh -N -R 4351:127.0.0.1:4451 -R 4459:127.0.0.1:4459 -R 4549:127.0.0.1:4549 <mac>`, with `--no-adb` on the proxy.

By hand: `curl -X POST localhost:4549/restart` is a real server restart behind the proxy (the app
reconnects and its follow stream asks steering again). The NetInfo path is `adb shell svc wifi disable`
and `svc data disable` with the proxy down: a message waits, and goes within a few seconds of `enable`
(the network back wakes the outbox's back-off).

**Kill mid-send** is `perf/kill-send.mjs`, with the app signed in to workspace A (`chat-open.yaml`). It
makes a chat ("Kill-send …"), opens it from Chats, then each round types a unique message, taps Send
and, a random 0 to 2 s later (spread evenly over every phase of the send), force-stops the app (or locks
the screen: `KEYCODE_SLEEP`, `--mode lock|mixed`, on an emulator only) and opens it again. A message the kill beat to the
outbox is back in the box, and is sent again. At the end it reads the chat's stored runs from the server
and counts, per message, its stored copies and the runs that hold them (a run stores the messages its
`RUN_STARTED` was given), sweeps the screen for bubbles still pending, and opens Diagnostics
(`<scheme>://diagnostics`, so a development or preview build) to read its Outbox line: every row by state,
not just the bubbles the virtualized transcript has on screen. It passes on exactly once, nothing lost or
doubled, and no `queued`, `inflight`, `unknown` or `held` row and no refused write left (only `sent` rows
waiting for the store may stay):

```sh
node apps/mobile/perf/kill-send.mjs --device emulator-5554 --metro 8104 --credentials /tmp/e2e-creds.json \
  --rounds 30 --out /tmp/kill-send.json
# A phone on USB with a preview build: --device <serial> --variant preview --rounds 100 (kill only)
# Lock rounds run only on an emulator: nothing can unlock a phone with a PIN over adb, and test
# phones may be reached remotely. Keep the phones awake on power (`adb shell settings put global
# stay_on_while_plugged_in 7`) so they never lock themselves between runs.
# An iPhone (it can't be driven remotely): --platform ios --device <udid>; the script says what to send
# and when to kill or lock, and asks what showed, then for Diagnostics' Outbox line.
```

**Kill mid-filing** is `perf/kill-file.mjs`, with the app signed in to workspace A on the Board
(`board-open.yaml`), a photo seeded (`attach-photo.yaml`'s header) and the proxy running. Each round opens
New issue, types a unique title (`kf-<tag>-<round>`), picks the photo, taps File and, a random 0 to 2 s
later (spread evenly, over the draft's commit, the create in flight, the create answered and the
attachment in flight), force-stops the app and opens it again; every other round files with the server
away (the proxy's `down`) and comes back at the relaunch. A filing the kill beat to the outbox is still
New issue's draft: the next round files it again first, as it is, as the person would. The draft's text
and its tray commit together, so a kept title whose photo is gone is a lost attachment: the script never
re-attaches, records the round (`restoredWithoutFile`) and counts it (`draftsLostFile`). At the end it
counts, per title, the server's issues (`/api/issues`, the exact title) and each one's attachments, sweeps
the Board for `CB-?`, "Waiting to send" and "Couldn’t confirm", and reads Diagnostics' Outbox line. It
passes on one issue with one attachment per title, no draft that lost its photo, and no row left but `sent`:

```sh
node apps/mobile/perf/kill-file.mjs --device emulator-5554 --metro 8104 --credentials /tmp/e2e-creds.json \
  --rounds 50 --out /tmp/kill-file.json
```

**The issue chaos flows** run in order behind the proxy, with Ada's changes on the web between
them (`act-as.mjs web-*`, in a sign-in of her own, straight to the server):

```sh
A="node apps/mobile/e2e/act-as.mjs --credentials /tmp/e2e-creds.json"
R="node apps/mobile/e2e/run.mjs --metro 8104 --device emulator-5554 --credentials /tmp/e2e-creds.json"
$R $F/board-open.yaml
$A web-file --text "XB2: Gone on the web"; $A web-file --text "XB2: Keep mine"; $A web-file --text "XB2: Keep theirs"
$R $F/chaos-issues-queue.yaml
$A web-delete --text "XB2: Gone on the web"
$A web-retitle --text "XB2: Keep mine" --to "XB2: Mine, changed on the web"
$A web-retitle --text "XB2: Keep theirs" --to "XB2: Theirs, changed on the web"
$A web-sign-out
$R $F/chaos-issues-settle.yaml $F/chaos-issues-expired.yaml
$A issues --text "XB2: Mine, from the phone"; $A issues --text "XB2: Theirs, changed on the web"
$A comments --issue "A: Export the board as CSV" --text "XB2: waits through a 401"
$A comments --issue "A: Export the board as CSV" --text "XB2: waits through an expiry"
```

The other chaos cases are by hand: airplane mode (on an emulator, or a phone on USB, it doesn't cut `adb reverse`:
take the server away with the proxy instead), force-stop then Clear cache (Settings) then reopen, a
401 before the stored expiry (revoke the session from another sign-in, `/api/auth/revoke-other-sessions`),
and a chat deleted on the web while a message waits for it ("You no longer have access", the Unsent list).

**The Board tour** runs behind the proxy on a fresh set of servers (servers.mjs seeds a socio's
memory proposal for Ada straight into the server's database, since only a turn's tool call makes one),
with a photo seeded (`attach-photo.yaml`'s header). The web's issue is filed only after `board-open.yaml`
has counted the Board's six open issues:

```sh
$R $F/board-open.yaml
$A web-file --text "XB3: Deleted on the web"
$R $F/a3-tour.yaml
$A web-delete --text "XB3: Deleted on the web"
$R $F/a3-tour-unsent.yaml
adb -s emulator-5554 shell settings put system font_scale 2.0       # iOS: xcrun simctl ui booted content_size accessibility-extra-extra-extra-large
$R $F/a3-large-text.yaml
adb -s emulator-5554 shell settings put system font_scale 1.0       # iOS: content_size large
```

Run now is refused offline on NetInfo's word: on Android the flow turns airplane mode on ("Needs a
connection"); the iOS simulator can't go offline, so there it goes with the server away and says "No
answer from the workspace". Then the cold start with a full cache of issues, memories, schedules, runs
and learning (Cold start, AGENTS.md): about 330 issues (`$A web-file --text "XB3: row" --count 320`),
every corresponding screen opened once (the tour does), the servers stopped, and `perf/cold-start-android.mjs --variant development --no-fill` (adb on PATH; the
release build installed and signed in first)
onto the Board and onto Home.

**Two devices** are the Android emulator and the iOS simulator signed in to one workspace as Ada,
each behind its own chaos-proxy.mjs, so each goes offline alone; the proxy also counts the requests it carries
(`GET /requests` by method and path, ids as `:id`; `POST /reset`), and `stall` holds answers for the kill
mid-save. `act-as.mjs web-page*` reads, writes, deletes and moves the page as Ada on the web, and
`web-page --expect` fails unless each line typed on a phone is in the server's copy exactly once.
`run.mjs --env NAME=value` hands a flow its line and text. Each round writes a new base, edits offline on
both, then reconnects one and then the other; run it for different lines and the same line, in both orders:

```sh
node apps/mobile/e2e/servers.mjs --ports 4391 --model-port 4591 --control 4589 --device emulator-5600
node apps/mobile/e2e/chaos-proxy.mjs --port 4391 --listen 4491 --control 4499 --device emulator-5600
node apps/mobile/e2e/chaos-proxy.mjs --port 4391 --listen 4492 --control 4498 --no-adb   # the simulator's
ssh -N -R 4391:127.0.0.1:4492 -R 4498:127.0.0.1:4498 -R 4589:127.0.0.1:4589 <mac>
RA="node apps/mobile/e2e/run.mjs --metro 8131 --device emulator-5600 --credentials /tmp/e2e-creds.json --proxy-control 4499 --servers-control 4589"
RI="node apps/mobile/e2e/run.mjs --platform ios --device <udid> --metro 8131 --credentials <copy> --proxy-control 4498 --servers-control 4589"   # on the Mac
$A web-page-write --page "A: first week" --text $'Round two base.\n\nLine one.\n\nLine two.\n\nLine three.'
$RA --env 'BASE=Round two base' --env 'LINE=Line two\.' --env 'TEXT=plus Android' --env ENTER=false --env SHOT=same-android $F/page-two-offline.yaml
$RI --env 'BASE=Round two base' --env 'LINE=Line two\.' --env 'TEXT=plus iPhone' --env ENTER=false --env SHOT=same-ios $F/page-two-offline.yaml
OK='Outbox: queued 0 · inflight 0 · unknown 0 · held 0 · sent \d+ · unsent 0'
$RI --env 'EXPECT=plus iPhone' --env 'WAIT_FOR=plus iPhone' --env RESULT=saved --env RESOLVE=none --env "OUTBOX=$OK" --env SHOT=same-ios $F/page-two-settle.yaml
$RA --env 'EXPECT=plus Android' --env 'WAIT_FOR=plus iPhone' --env RESULT=conflict --env RESOLVE=mine --env "OUTBOX=$OK" --env SHOT=same-android $F/page-two-settle.yaml
$A web-page --page "A: first week" --expect 'plus Android'
```

The flows wait for the editor's save line and two seconds before tapping a line: a tap before the WebView's
document is up types nowhere. On iOS Maestro taps the middle of a line's text, so the words land inside it
(`Line plus iPhonetwo.`): still the same line, and Enter there splits it. `hideKeyboard` runs only on
Android, and only after typing. The pages' chaos rounds use the same pieces: `page-kill-save.yaml`;
`page-two-offline.yaml` then `page-clear-cache.yaml` then `page-two-settle.yaml`; `page-two-offline.yaml`,
`$A web-page-delete`, `page-gone.yaml`; `page-two-offline.yaml`, `$A web-page-move --to Elsewhere`,
`page-two-settle.yaml` (`RESULT=merged`). The results are in AGENTS.md (The page editor's screen, Device checks).

**Board parity on live data** is `e2e/board-parity.mjs`, under Node with no device: it signs in
once to a live workspace with a smoke account (read-only: `/api/issues` and `/api/issues/search` for a fixed
list of queries, then logout, with a generic User-Agent), then lays the board out as the app does (the raw
body through the issues kind's snapshot source into a real cache.db, the scope's collection and `boardView`)
and as the web's IssuesPage does (the server's order and the shared functions), over every facet value, every
pair of facets with rows, the "Socio requests" lane, the queries with the server's matches and offline, "Most
votes" and won't fix, and compares the columns, their order and counts, the toolbar's and the header's.
It prints counts only; the capture and the report (with the titles of any issue that differs) go into
`--out`, which stays in `.local/`, never in a PR. `--capture` reruns the cases on a capture with no request:

```sh
( set -a; . ~/.config/socio-smoke/<workspace>.env; set +a
  node apps/mobile/e2e/board-parity.mjs --out .local/board-parity )
```

Things the flows work around:

- **The dev client's menu.** A development client opened after a clear shows its dev menu once the bundle
  loads (`common/dev-menu.yaml` closes it), and its floating Tools button sits over Home's avatar, so
  `sign-out.yaml` opens Account from More.
- **The tab bar is the system's.** React Navigation's native tabs don't pass a tab's `testID` to it, so
  flows tap a tab's label (`More`).
- **iOS asks twice before the link opens the app** ("Open in …?"), the second time once the bundle has
  loaded: `common/open.yaml` taps Open, then Cancel.
- **iOS offers to save the password** after each submit, in a sheet Maestro can't see (the app's
  hierarchy reads empty while it is up). `common/sign-in.yaml` taps Not Now by its position when neither
  the sign-in screen nor Home shows. The keyboard's Go submits, since `hideKeyboard` isn't reliable on iOS.

On a Mac, run the same commands with `--platform ios --device <udid> --metro <port>` from a copy of the
repository (`git archive`) with a development build in the simulator (`modules/socio-device/README.md`),
Metro on the Mac, and the Linux host's servers started with `--no-adb` and reached through a tunnel opened
from that host, so the origins stay `http://localhost:<port>`:

```sh
ssh -N -R 4351:127.0.0.1:4351 -R 4352:127.0.0.1:4352 -R 4353:127.0.0.1:4353 <mac>
```

## Checks

`pnpm run typecheck`, `pnpm run lint`, `pnpm test`, and `pnpm run build` (an offline JavaScript
bundle for both platforms, into `dist/`).
