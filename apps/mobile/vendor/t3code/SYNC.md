# T3 Code files in the native app

This folder holds files taken from **T3 Code** (https://github.com/pingdotgg/t3code), the MIT-licensed
app by T3 Tools Inc. Its Expo app is the native app's engineering reference.
`LICENSE` here is T3 Code's license, and the repository's
`THIRD_PARTY_NOTICES` names this folder. The root's `vendor/t3code` is the coding host's, pinned on its own.

## Source

- **Upstream:** `pingdotgg/t3code`.
- **Commit:** `240446e2d9`, the version this copy follows.
- **Licence:** MIT, copyright © 2026 T3 Tools Inc. See `LICENSE`.

## Files

| Here                         | Upstream                                        |
| ---------------------------- | ----------------------------------------------- |
| `LICENSE`                    | `LICENSE`, unchanged                            |
| `dependency-graph.ts`        | `apps/mobile/src/dependency-graph.test.ts`      |
| `react-compiler-coverage.ts` | `apps/mobile/src/reactCompilerCoverage.test.ts` |
| `thread-feed-live-follow.ts` | `apps/mobile/src/features/threads/thread-feed-live-follow.ts` |
| `plugins/withAndroidGradleHeap.cjs`              | `apps/mobile/plugins/withAndroidGradleHeap.cjs`              |
| `plugins/withAndroidPredictiveBackCompat.cjs`    | `apps/mobile/plugins/withAndroidPredictiveBackCompat.cjs`    |
| `plugins/withAndroidModernAlertDialog.cjs`       | `apps/mobile/plugins/withAndroidModernAlertDialog.cjs`       |
| `plugins/withAndroidModernPopupMenu.cjs`         | `apps/mobile/plugins/withAndroidModernPopupMenu.cjs`         |
| `plugins/withoutIosPersonalTeamCapabilities.cjs` | `apps/mobile/plugins/withoutIosPersonalTeamCapabilities.cjs` |

The two code files keep T3 Code's formatting, so they diff cleanly against upstream: oxfmt and oxlint skip
`apps/*/vendor`, and the app's typecheck covers them. Nothing here may use Effect
(`apps/mobile/AGENTS.md`); `apps/mobile/tests/no-effect.test.ts` reads this folder too.

### `dependency-graph.ts`

- A module instead of a test. Its `describe` block moved to `apps/mobile/tests/dependency-graph.test.ts`,
  which also checks that `src/data`, `src/sync` and `src/net` load no React Native or Expo package, and
  runs both checks on fixtures. Like upstream, the graph reads only `.ts` and `.tsx` files, so the test
  also fails on any other script in `src/` (`.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`), which Metro
  would bundle unseen. Upstream's floor of 500 files went (the app is small); the test checks that
  the three folders are in the graph instead.
- The source root is a parameter of `buildPlatformGraph` and `resolveRelative` instead of `__dirname`, so
  fixtures go through the same code, and the graph carries it for `findCycles`. The helpers the test uses
  are exported.
- Upstream's layer edges (`layerOf`, `crossLayerEdges`, over T3's `state`, `lib`, `components`, `native`
  and `features`) are left out: upstream computes them but checks nothing, and the app's folders differ.
- **`resolveRelative` finds a name written in full.** Upstream always appends an extension, so
  `'./screens/home.tsx'` resolved to nothing and its edge was dropped: a Node-only folder could load Expo
  through `'../platform/sqlite.ts'`, and a cycle written with full names passed. It now tries the name as
  written, then each of the platform's extensions, then the folder's `index` with each: Metro's order
  (metro-resolver's `resolveModulePath`). Upstream tried `name.ext` and `name/index.ext` together for each
  extension, so `name/index.native.ts` won over `name.ts`; Metro takes the file. A `.js` name also finds
  its `.ts` or `.tsx` file (NodeNext style, as shared's source writes them). That step is TypeScript's and
  Vite's, not Metro's: Metro does it only for shared's source, through `metro.config.js`, and fails on such
  a name in `src/`. Following it there errs on the safe side, an edge the app's Vitest tests do load.
- **`PLATFORM_EXTENSION_ORDER` is Metro's.** Upstream puts the platform first (`.android.ts`,
  `.android.tsx`, `.native.ts`, `.native.tsx`, `.ts`, `.tsx`). metro-resolver's `resolveSourceFile`, with
  the `preferNativePlatform` Metro sets, takes each source extension in turn (the app's `sourceExts` start
  `ts`, `tsx`), and inside it the platform's file, the native one, then the plain one: `.android.ts`,
  `.native.ts`, `.ts`, `.android.tsx`, `.native.tsx`, `.tsx`. With upstream's order, `foo.ts` next to
  `foo.native.tsx` sent the graph to the `.tsx` file while Metro and Vite load `foo.ts`, so the imports and
  cycles through `foo.ts` went unseen.
- **`parseImports` reads Babel's syntax tree, not regular expressions.** Upstream matches `import`,
  `export ... from` and `import(...)` in the source text, so it counts imports that load nothing: one
  written in a comment or a string; `import type` and `export type ... from` (two files that use each
  other's types fail the cycle check); and TypeScript's `import("x").T` and `typeof import("x")` types
  (`export type Driver = import("expo-sqlite").SQLiteDatabase;` in `src/data` failed the native-package
  check). Socio's first fix stripped type-only clauses with more expressions; the type expressions showed
  that matching text can't keep up with the syntax. It now parses each file with the app's `@babel/core`
  as Metro's transformer does (Expo's preset, from `react-compiler-coverage.ts`, whose TypeScript plugin
  turns JSX on for `.tsx` files only; Metro's caller; `sourceType: 'unambiguous'`), and walks the tree
  with Babel's `traverse` (which `@babel/core` re-exports), whose scopes `evaluate()` needs. A file Metro
  can't parse fails the test.
    - **Runtime edges:** static for value imports, clauses that mix `type` names with a value,
      side-effect imports, `export * from`, `export { ... } from`, `import x = require("…")` and
      `require("…")` calls (at the top, one runs while the module initializes, as an import does);
      dynamic for `import("…")`. A call to a `require` the file declares loads nothing, as in Metro.
    - **Module names, as Metro reads them.** Metro (`@expo/metro-config`'s `collect-dependencies`,
      `getModuleNameFromCallArgs`) takes an `import()` or `require()` name from Babel's `evaluate()`
      and bundles any name it computes: `const SQLITE = 'expo-sqlite'; import(SQLITE)`,
      `import('expo-' + 'sqlite')`. In the app's code it rejects one it can't (`dynamicRequires:
      'reject'`). `parseImports` evaluates the same way, so those are edges, and throws on a name it can't
      compute (`import(name)`, or a `const` behind `as const`, which Metro reads after stripping the
      types): the graph can't follow it.
    - **Type-only syntax, skipped:** `import type`, `export type ... from`, an `import { ... }` or
      `export { ... } from` whose every name is `type X` (one value name, a default or a namespace keeps
      the clause), `import type x = require("…")`, and everything in type positions: anything under a
      `TS*` node but the few that hold code that runs (`as`, `satisfies`, `!`, enums, namespaces,
      `export =`, `import =`, parameter properties), so `import("x").T` and `typeof import("x")`
      (TSImportType nodes), annotations, type arguments, type aliases and interfaces load nothing. Nor
      does ambient code (`declare const`, `declare module`).
    - TypeScript, Babel in Metro (babel-preset-expo) and Vite erase all of it, so nothing loads. The
      test's native-package check reads imports through the same function, so it parses nothing itself.
- **`moduleNames`, Socio's.** Every module a file names from the same walk, type-only syntax and ambient
  code included, for `apps/mobile/tests/no-effect.test.ts`, whose ban covers types too. That test read
  imports with regular expressions, which a quote or a semicolon in a comment inside a clause stopped.

### `thread-feed-live-follow.ts`

The chat screen's follow machine: `resolveThreadFeedLiveFollow` and its event type, unchanged, and
`resolveThreadFeedSubmissionAnchor`, unchanged, which the composer's send asks (`src/chat/composer.ts`, `submissionAnchor`). `src/chat/follow-session.ts` drives it
with T3's scroll session (ThreadFeed.tsx: a drag through its momentum, closed 160 ms after release
unless momentum starts). Changed:

- Left out: the tool-group scroll helpers (`resolveThreadWorkGroupInitialScroll`,
  `shouldFollowThreadWorkGroupAppend`, `ThreadWorkGroupScrollPosition`) and the width-reflow anchors
  (`resolveThreadFeedReflow*`), with their import of `@t3tools/client-runtime/work-log/scroll-anchor`:
  the app has no tool groups yet and no tablet reflow. They come back with what needs them.
- A two-line header comment naming the source.

Its tests are upstream's `thread-feed-live-follow.test.ts` cases for the two functions taken, in
`apps/mobile/tests/chat/follow-machine.test.ts` (Vitest instead of `vite-plus/test`).

### `react-compiler-coverage.ts`

- A module instead of a test. Its `describe` block and `KNOWN_BAILOUTS` (empty here) moved to
  `apps/mobile/tests/react-compiler.test.ts`. Upstream's three caching checks name T3 Code's screens and
  are left out; the test checks a fixture with `compilerCachedCalls` instead, and one the compiler gives up
  on.
- **No `babel.config.js`.** With no Babel config file, Metro's transformer runs Expo's default preset,
  `expo/internal/babel-preset`, a re-export of babel-preset-expo (58.0.24, the app's own copy). So
  `compileLikeMetro` loads that preset, resolved from Metro's transformer as the transformer does, where
  upstream read `babel.config.js`; the logger still rides on the preset's `react-compiler` option.
  `babelConfigFileIn` runs Expo's own lookup, so the test can check that the app still has no config file,
  and that the preset is the app's babel-preset-expo.
- Upstream's first test is `transformWithMetro`, run on `src/screens/home.tsx`.
- **PipelineError counts as a bailout.** Upstream's `compilerBailouts` keeps only `CompileError` and
  `CompileSkip`. babel-plugin-react-compiler 1.0.0 logs any other exception inside the compiler as a
  `PipelineError` (`data` holding its stack), and with babel-preset-expo's release `panicThreshold: 'NONE'`
  that function ships uncompiled, silently. The filter, now `bailoutsIn` (exported, so the test feeds it an
  event), keeps it too, with the stack's first line as the reason and `fnLoc` for the line.
- `vite-plus/test` is gone (the test imports Vitest), `__dirname` is `import.meta.dirname`, the app's
  `metro.config.js` is synchronous, and files resolve with `NodePath.resolve`, so a fixture outside `src/`
  compiles too.
- Upstream's `// @effect-diagnostics nodeBuiltinImport:off` comment is dropped: no Effect here.
- `sourceFiles` still takes only `.ts` and `.tsx` files, as upstream does;
  `apps/mobile/tests/dependency-graph.test.ts` fails on any other script in `src/`.

### `plugins/`: Expo config plugins (native build config)

From `apps/mobile/plugins/` upstream. They import `expo/config-plugins`, as the app's own plugins
do, and `app.config.ts` loads them by path. Each starts with one added line, an oxlint directive
for the `require()` calls a CommonJS config plugin needs.

| File                                             | Upstream changes                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/withAndroidGradleHeap.cjs`              | None. Gradle gets a 4 GB heap: Expo's 2 GB runs out at dex merging.                                                                                                                                                                                                                                                                                               |
| `plugins/withAndroidPredictiveBackCompat.cjs`    | None. Routes back gestures to JavaScript on Android 13 to 15, with `android.predictiveBackGestureEnabled` on.                                                                                                                                                                                                                                                      |
| `plugins/withAndroidModernAlertDialog.cjs`       | Takes its colors as props, `{ light, night }`, each with `background`, `text`, `secondaryText` and `buttonText` as `#RRGGBB`, and throws without them, instead of reading T3's generated uniwind theme (`generated-uniwind-default-theme-variables.json`), which the app doesn't have. Its DM Sans fonts became the system's: `sans-serif` and `sans-serif-medium`. |
| `plugins/withAndroidModernPopupMenu.cjs`         | Its DM Sans font (`@font/xml_dm_sans_regular`) became the system's `sans-serif`. Its colors are upstream's.                                                                                                                                                                                                                                                       |
| `plugins/withoutIosPersonalTeamCapabilities.cjs` | None. Strips push, Sign in with Apple and app group entitlements from Personal Team builds (`SOCIO_IOS_PERSONAL_TEAM=1`, `plugins/personal-team.ts`).                                                                                                                                                                                                             |

Left out on purpose:

- `withAndroidNetworkSecurityConfig.cjs` trusts user CAs and allows cleartext to every host in
  every build. The app writes its own, per variant (`apps/mobile/plugins/network-security.ts`).
- `withAndroidInputBackground.cjs`, `withAndroidTabletOrientation.cjs`, `withIosCocoaPodsUuidCache.cjs`,
  `withShareExtensionDisplayName.cjs`, `withWidgetLogoAsset.cjs` and `lib/` serve features or
  layouts the app doesn't have.

## Patches

T3 Code's patches for two third-party packages, taken unchanged from upstream's `patches/` at the
commit above. They live in the repository's root `patches/` (pnpm reads every listed patch on each
install, the server's and the images' included, and `apps` is outside the Docker context), listed in
the root `package.json`'s `pnpm.patchedDependencies`, each keyed to the exact version the app pins.
The app's `package.json` lists the patched packages in `expo.install.exclude`, and the native one in
`expo.autolinking.buildFromSource`, so iOS never links a prebuilt copy without the patch
(`tests/native-config.test.ts`).

| Root file                                         | Upstream                                          | Changes |
| ------------------------------------------------- | ------------------------------------------------- | ------- |
| `patches/@legendapp__list@3.3.5.patch`            | `patches/@legendapp__list@3.3.5.patch`            | None.   |
| `patches/react-native-keyboard-controller@1.22.8.patch` | `patches/react-native-keyboard-controller@1.22.8.patch` | None.   |

- `@legendapp/list` 3.3.5: the chat list's fixes for keeping the end in view, its keyboard entry
  (`@legendapp/list/keyboard`) and Reanimated integration. Plain JavaScript, so nothing to build.
- `react-native-keyboard-controller` 1.22.8 (Expo's set has 1.22.7): `KeyboardChatScrollView`'s and
  `useKeyboardState`'s fixes, and the iOS keyboard movement observer's lifecycle.

Left out on purpose:

- `react-native-reanimated@4.7.1.patch` teaches Reanimated's layout animations the names of
  react-native-screens' newer screens (`RNSTabsScreenIOS`, `RNSTabsScreenAndroid`, `RNSStackScreen`,
  `RNSSplitScreen`), which the shell's native tabs use. It goes in only once a layout animation
  misbehaves under the tabs without it; the app has no layout animation yet.
- T3 Code's Expo-core patches (`@expo/fingerprint`, `@expo/metro-config`, `expo-modules-core`) were
  made for Expo 58.0.14; each is re-cut at 58.0.23 or dropped in its own PR.
- The rest serve packages the app doesn't have.

The enriched-markdown fork is a tarball in `apps/mobile/deps/`, not a patch: its README.

## Ported, not vendored

- `scripts/lint/socio-rules.mjs`, rule `socio/hermes`: T3 Code's
  `oxlint-plugin-t3code/rules/no-hermes-unsupported-apis.ts`, in JavaScript, with `crypto.randomUUID`,
  `Intl.supportedValuesOf`, `structuredClone` and `Array.fromAsync` added. It reports a global API only
  when its first name (`crypto`, `Intl`, `globalThis`) resolves to the global through oxlint's scope
  analysis: an import, a parameter, a declaration or a catch parameter of that name in any enclosing
  scope is another implementation (expo-crypto's `crypto`). A declaration that emits nothing doesn't
  count (`declare const crypto`, `declare function structuredClone`, `import type`), and a local copied
  from the global is the global (`const { structuredClone } = globalThis`, `const crypto =
  globalThis.crypto`, under any name), unless it has a fallback or is assigned again. The method checks
  (`toSorted`, ...) look at any receiver, as upstream's do.
- `apps/mobile/tests/lint-rules.test.ts`: the cases of upstream's `no-hermes-unsupported-apis.test.ts`,
  run through the root's oxlint config. Upstream's harness runs on Effect, so it isn't taken.
- `apps/mobile/src/chat/stream-haptics.ts`: `shouldTickStreamHaptic` of
  `apps/mobile/src/features/threads/threadStreamHaptics.ts`, unchanged but for formatting, and
  `createStreamHaptics`, its `streamHapticsFamily` atom without Effect or expo-haptics (the first
  observation only seeds; the caller fires the haptic). `tests/chat/stream-haptics.test.ts` has
  upstream's cases.

- `apps/mobile/modules/socio-push/android`: the Android push receiver of
  `apps/mobile/modules/t3-agent-notifications` (`AgentNotifications.kt`, its manifest and `build.gradle`),
  rewritten for Socio's pushes rather than copied: the service subclasses `ExpoFirebaseMessagingService`
  with Expo's removed from the manifest, as upstream's does; the 64 seen ids, the screen check through
  `ProcessLifecycleOwner` (here only the chat on screen, as JavaScript reports it, not every alert), the
  high-importance channel, `BigTextStyle`, auto-cancel, a private visibility and the launcher's content
  intent come from upstream. Socio's own: decryption (`PushMessages.kt`), each message under its own id
  grouped per conversation with a summary, the flags and lease, a public version, a second channel for
  reports, an explicit intent carrying only a token in place of upstream's `scheme://` VIEW URL, inbox
  files, channels at app start, and no ongoing card (no Live Updates). `PushNotifierTest.kt` keeps
  upstream's Robolectric setup and its retry, foreground and permission cases; it runs SDK 24 and 34, since
  the app builds on JDK 17 (upstream runs 36 on 21).

## Re-syncing

From a read-only T3 Code checkout at the new commit, diff each upstream file above against its copy here,
apply what applies, and update the commit. Keep the changes listed above, or update the list. For the config plugins, also run `expo prebuild --clean` for both platforms and a debug and a
release Android build.
