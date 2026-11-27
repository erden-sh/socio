# socio-google-signin

The phone's own Google sign-in for Socio's Google sign-in (CB-570): one call that gives an OpenID
Connect ID token whose audience is the workspace server's Google client id (`serverClientId`, from
`POST /api/auth/device/social/start`) and which carries the server's nonce. It is a local Expo module
(`expo-module.config.json`, Swift in `ios/`, Kotlin in `android/`, TypeScript in `src/`), found by
autolinking in `apps/mobile/modules` with no `package.json`, like `modules/socio-device`. The native
side registers as `SocioGoogleSignIn`; `src/native.ts` loads it with `requireNativeModule` on first use.

Import `googleSignIn` from `modules/socio-google-signin`. Only `src/platform/social-sign-in.ts` calls
it, and the app's Node code (`src/data/social-sign-in.ts`) maps its answer (`googleToken`).

| Call                                      | iOS                                                                                                                                                                                                                                                                                            | Android                                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn(clientId, serverClientId, nonce)` | Google's GoogleSignIn SDK (CocoaPods `GoogleSignIn ~> 9.0`): `GIDConfiguration(clientID: clientId, serverClientID:)`, then `signIn(withPresenting:hint:additionalScopes:nonce:)`, then `signOut()` so the SDK keeps nothing of the account. `unavailable` (`no-client-id`) with no `clientId`. | Credential Manager's "Sign in with Google" (`GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce)`), `GoogleIdTokenCredential`'s `idToken`. `clientId` is ignored: Android needs only the server's client id. |

Answers, never a rejection from the wrapper (`googleSignIn`): `success` with the token; `cancel` (the
person's Cancel: iOS `GIDSignInError.canceled`, Android `GetCredentialCancellationException`);
`no-account` (Android's `NoCredentialException`: no Google account on the phone); `unavailable` with a
reason (no view controller or activity, no Google Play services provider, unsupported); `failed` with
a fixed reason (iOS `gid-<code>`, Android the exception's class name). No message, token or account
ever goes into a reason, and nothing here logs.

## The iOS client id

Google's SDK needs the build's iOS OAuth client id, and its reversed form (`com.googleusercontent.apps.<…>`)
registered as a URL scheme. Neither is committed: `app.config.ts` reads it at prebuild from
`SOCIO_GOOGLE_IOS_CLIENT_ID` (production) or `SOCIO_GOOGLE_IOS_PREVIEW_CLIENT_ID` (preview) into
`extra.googleIosClientId`, and `plugins/social-sign-in.ts` adds the scheme. Development reads neither,
so Google is off on its iOS builds; without the variable the iOS Google button doesn't show.
`SocioGoogleSignInAppDelegate` (an `ExpoAppDelegateSubscriber`) hands a URL opened in the app to
`GIDSignIn.handle`, for a sign-in that comes back through that scheme.

## What it adds to the build

No analytics or telemetry SDK. What each platform gains, checked when this module was added:

- **iOS** (CocoaPods): `GoogleSignIn` 9 and its dependencies `AppAuth`, `GTMAppAuth`,
  `GTMSessionFetcher/Core` and `AppCheckCore` (with `GoogleUtilities/Environment`,
  `GoogleUtilities/UserDefaults` and `PromisesObjC`). `AppCheckCore` is Google's App Check client, which
  GoogleSignIn uses only when the app configures App Check; Socio never does. None is Firebase or
  Analytics. The pods' privacy manifests join the app's at `pod install`. The SDK talks to Google only
  during a sign-in the person starts, with its own version in its requests.
- **Android** (Gradle, this module's `android/build.gradle`): `androidx.credentials:credentials` and
  `credentials-play-services-auth` 1.6.0 and `com.google.android.libraries.identity.googleid:googleid`
  1.1.1 (1.2 is built with Kotlin 2.4, past the app's 2.2). The release build's runtime classpath (`:app:dependencies --configuration
  releaseRuntimeClasspath`) gains, beside those three: `com.google.android.gms:play-services-auth`
  21.1.1, `-auth-api-phone` 18.0.2, `-auth-base` 18.0.10, `-auth-blockstore` 16.4.0, `-fido` 21.0.0
  and `-identity-credentials` 16.0.0-alpha08, and raises `play-services-base` (18.1.0 to 18.5.0),
  `-basement` (18.3.0 to 18.5.0), `-tasks` (18.1.0 to 18.2.0) and `androidx.loader` (1.0.0 to 1.1.0).
  Play services' base, basement and tasks, and Google's data transport, were already there through
  expo-notifications' FCM; nothing new of Firebase, data transport or Analytics comes with it. The
  Credential Manager provider is the one place the app calls into Google Play services itself (the
  owner, 2026-11-27: native Google sign-in, as the PaHoy app does); the QR scanner still holds none
  (`modules/socio-scanner`).

## Building and checking

As `modules/socio-device`'s README says for a Mac build. A simulator or emulator has no Google
account the app can use in tests, so development builds stand a made-up test account in for the
sheet (`src/net/social-test-token.ts`, `e2e/fake-cloud.mjs`); the module itself is checked on device
by opening the sheet. Check the Android classpath again after a dependency change:

```sh
cd apps/mobile/android
./gradlew --no-daemon :app:dependencies --configuration releaseRuntimeClasspath \
  | grep -E 'credentials|identity|play-services-(auth|fido)'
```

`tests/socio-google-signin.test.ts` holds both native sides to the TypeScript
declaration and to the nonce, the sign-out and the dependencies above.
