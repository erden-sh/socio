# Agent instructions for Socio's native app

`apps/mobile` is Socio's native app for iOS and Android: Expo SDK 58 (React Native 0.88, React 19.3,
Hermes, the New Architecture), with React Navigation 7's static API and a native-stack root. It is a
skeleton for now: the shell's frame and the root gate, with placeholder screens built from the
primitives. It will replace the PWA on phones.

`CLAUDE.md` is a symlink to this file. The root `AGENTS.md` still applies.

## Rules

- **No Effect** anywhere in the app, vendored code included. The root's lint bans the imports, and
  `tests/no-effect.test.ts` reads every file (`vendor/` too) and the app's packages in the lockfile.
- **No EAS and no Expo Go.** Android builds on a Linux box with the Android SDK (JDK 17), iOS on a Mac
  with Xcode. Nothing builds, updates or pushes through Expo's services.
- **Push goes through our relay** (`apps/push-relay`), never Expo's push service: only
  `getDevicePushTokenAsync`. The root lint bans `getExpoPushTokenAsync`, so import `expo-notifications`
  by name. Firebase acts only when asked (`plugins/push.ts`), and `google-services.json` is never
  committed (README, Native build config).
- **Expo's telemetry stays off.** Run every `expo` command with `EXPO_NO_TELEMETRY=1`, `npx expo install`,
  `config` and `prebuild` included. Anything that starts Metro (`expo start`, `run:android`, `run:ios`,
  `export`) also needs `EXPO_OFFLINE=1`: without it, Expo CLI reports each dev session to Expo's servers
  (the machine's hostname, the app's name and the device ids) and fetches dependency versions. The
  package scripts set both, with `DO_NOT_TRACK=1`; `tests/integration/apps-isolation.test.ts` checks
  every script that runs `expo`. Release builds run Expo CLI too (`expo export:embed`), and every
  native build reads `app.config.ts` again: give Gradle all three and the `APP_VARIANT` of the prebuild,
  or the build fails (README). Xcode reads all four from `ios/.xcode.env`, which the config writes.
- **The dev server doesn't announce itself.** `expo start`, `run:android` and `run:ios` advertise
  Metro over Bonjour (multicast DNS) on every network the machine is on, with the app's name, slug,
  ids and port, unless `EXPO_UNSTABLE_BONJOUR=0` is set; `EXPO_OFFLINE` doesn't stop it. The package
  scripts set it, and `tests/scripts.test.ts` fails on a dev-server script without it. Set it on a
  hand-typed `npx expo start` too.
- **Native folders are generated.** `android/` and `ios/` come from `app.config.ts` and config plugins
  through `expo prebuild`, and are never committed. Change native setup with a config plugin: ours are
  in `plugins/`, T3 Code's in `vendor/t3code/plugins/` (`vendor/t3code/SYNC.md`). Introspection
  (`expo config --type introspect`) skips the plugins that write files, so test their builders
  (`tests/native-config.test.ts`) and check the generated files.
- **Native code of our own** goes in a local Expo module under `modules/` (Swift, Kotlin and a typed
  TypeScript wrapper that imports `requireNativeModule` from `expo`), which autolinking finds with no
  `package.json` change. `modules/socio-device` is the first; its README covers building it on a Mac.
- **Build numbers** come from `SOCIO_BUILD_NUMBER` at prebuild (`build-stamp.ts`): `ios.buildNumber`
  and `android.versionCode`, a positive whole number up to 2100000000, 1 when unset, anything else a
  config error. The preview and release builders pass `git rev-list --count HEAD` of the main they
  build, so builds rise with main, plus `SOCIO_BUILD_COMMIT` (short sha) and `SOCIO_BUILD_DATE` (ISO
  date) into `extra.buildCommit` and `extra.buildDate`, left out when unset. `.xcode.env` and
  gradle.properties keep them as the prebuild saw them, like `APP_VARIANT` (README, Build numbers).
- **Versions** live in one place, `version` in this `package.json`: `app.config.ts` reads it for iOS's
  `CFBundleShortVersionString` and Android's `versionName` (`tests/native-config.test.ts` checks it).
  Bump the patch for each TestFlight build (0.2.1, 0.2.2, ...) and the minor for a milestone (0.3.0);
  the build number stays the commit count. Each upload gets an entry at the top of `RELEASE-NOTES.md`,
  `## <version> (build <number>, <YYYY-MM-DD>)` and a short **What to test** list in plain words for a
  non-technical tester (American English, agents are "socios"). The upload sets that entry as the
  build's "What to Test" in TestFlight.
- **Three variants,** chosen by `APP_VARIANT` (`variant.ts`): `development` (the default), `preview`
  and `production`. Any other value fails the build. Each has its own name, id and URL scheme, so they
  install side by side; the dev client's generated `exp+socio` scheme, the same in all three, is off
  (`app.config.ts`).
- **Plain http is for Metro.** On Android, the debug build types (`debug`, `debugOptimized`) get a
  network security config of their own that allows it to every host, so Metro works at `localhost`
  (`adb reverse`) and at the machine's LAN or tailnet address, for a phone on Wi-Fi. Every release
  build keeps main's file: no plain http, except development's to `localhost`, `127.0.0.1` and
  `10.0.2.2` (`plugins/network-security.ts`). On iOS only development has ATS's local networking
  exception (`plugins/transport-security.ts`).
- **Shared code** comes from `@socio/shared` source (`packages/shared/src`), mapped in `metro.config.js`,
  `tsconfig.json` and `vitest.config.mts`. Only React Native-safe code belongs there.
- **Hermes** lacks some APIs Node and browsers have (`toSorted`, `Intl.Segmenter`, `crypto.randomUUID`,
  `structuredClone`, ...). The root lint's `socio/hermes` rule (`scripts/lint/socio-rules.mjs`) flags
  them, here and in `packages/shared/src`. A call behind a `typeof` check takes an
  `oxlint-disable-next-line socio/hermes` comment.
- **One fetch.** In `src/`, only `src/platform/fetch.ts` may use the global `fetch` or import
  `expo/fetch`; everything else gets that wrapper (the root lint). Code that takes the
  fetch as a parameter types it with `import type` from `expo/fetch`, which the ban allows; `typeof fetch`
  names the global, which is banned, and isn't expo/fetch's signature.
- **`src/data`, `src/sync`, `src/net` and `src/push` run under Node** in their tests, so they load no React Native or
  Expo package, through another file either. `tests/dependency-graph.test.ts` checks that, and that
  `src/` has no import cycle.
- **`src/` holds only `.ts` and `.tsx` scripts.** The dependency graph and the React Compiler test read
  only those, so `tests/dependency-graph.test.ts` fails on a `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` or
  `.cts` file there.
- **The React Compiler is on** (`app.config.ts`). Every file in `src/` must compile:
  `tests/react-compiler.test.ts` fails on a bailout, and its list of known ones may only shrink. The app
  has no Babel config file; Metro uses Expo's default preset, which the test compiles with.
- **Files from T3 Code** go in `vendor/t3code/`, each listed with its changes in `vendor/t3code/SYNC.md`.

## Navigation

A root native stack, with a native stack per tab, in `src/navigation/`:

- **A screen is a row in the route table,** `routes.ts`: the gate states that show it, its link path
  (the web's path, after the scheme), its preset, the variants that have it when not all do (a
  build of another variant leaves it out), and `tab` for a page that lives in the tabs. Its component
  goes in `root-stack.tsx`, or `tab-screens.tsx` for a page with a `tab`; `src/app.tsx` never changes
  for a screen.
- **A stack per tab** (`tab-stack.tsx`):
  every tab is its own native stack, its root (`<Tab>Root`, `tabRootName`) and then every page with a
  `tab`, pushed in the tab the person is in with the tab bar still under it, as Music's, Mail's and
  the App Store's are. A chat or a room and New chat hide the tab bar instead (CB-491, as Messages
  and Slack do; `hidesTabBar` in `routes.ts`): each tab's options read its stack's focused page
  (`getFocusedRouteNameFromRoute`, a link's params too) and set `tabBarStyle: { display: 'none' }`,
  so Back (the bar's, iOS's swipe, Android's key) is the way out. Each tab keeps its page while another shows; tapping the shown tab again pops
  it to its root (native on iOS, the `tabPress` event on Android); Back pops the tab's stack first.
  Only the copy in the page's own `tab` has its link path (`staticTabScreens`; React Navigation
  refuses two screens with one pattern), and each tab's link config names its root
  (`tabLinking`), so a link opens over the tab's root: `/chats/abc` is Tabs › Chats ›
  [ChatsRoot, Chat], dispatched as `NAVIGATE Tabs` with `pop: true`, never a second Tabs. The root stack
  keeps the tabs, what shows over them (sheets, the compose page sheets, the page editors, the
  attachment viewer) and the gate's screens. An action from a root screen that names a tab's page (a
  sheet's Join, the Account sheet's rows, File an issue's replace) finds no navigator with it, so the
  container's `onUnhandledAction` hands it to `shell-actions.ts` (`tabPageRedirect`): the root stack
  back to the tabs (`handOffAction`, which a compose sheet's draft question lets pass: `isHandOff`),
  then the page pushed in the shown tab (a replace becomes a push). From inside a tab, dispatch as
  usual: the tab's own stack takes the page; a tab's name goes up to the tabs (`inTabAction` opens a
  page in another tab, over its root). A pushed page counts the tab bar in its bottom safe area
  (`TabPageInsets`: on iOS a safe area provider of its own, which UIKit measures with the tab bar; on
  Android `MATERIAL_NAVIGATION_BAR` on top of the window's), so a page's bottom edge clears the bar.
  The pages that hide it keep the window's, so a composer sits on the home indicator and the keyboard.
  `presencePath` reads the shown tab's stack. `tests/navigation/tab-stacks.test.ts` and
  `tests/linking.test.ts` (through `tests/helpers/route-tree.ts`) run them under Node; Maestro's
  `tab-stacks.yaml` on devices (`common/tab.yaml` taps a tab: neither system tab bar carries testIDs;
  `common/tab-bar-shows.yaml` and `common/tab-bar-hidden.yaml` check the bar).
- **A screen never sets its own presentation:** the table takes only a preset from `presets.ts`
  (`page`, `sheet`, `pageSheet`, `modal`, `immersive`). The root stack passes `Platform.OS` to
  `onPlatform`: react-native-screens lays an Android form sheet out at its largest detent, so there a
  sheet keeps only the one it opens at. On iOS a sheet's root is its ScrollView (the trace's, the page
  review's), and a sheet sized to its content holds no ScrollView at all: iOS takes the first one inside
  as the sheet's own and draws it wrong.
- **Pickers are native sheets, never a React Native `Modal`** (CB-421; the owner, 2026-11-18). A screen's
  picker (the Board's Filters, the batch bar's choices, an issue's fields, Move, a Space to save in, the
  memory forms, the diff) calls `useRouteSheet(content | null, onDismiss)` (`screens/route-sheet.tsx`) with
  its title, title-row buttons and body; `navigation/route-sheets.ts` hands that to the `Sheet` route (the
  medium detent alone, a short list) or `TallSheet` (medium, then large: `tall`), which draws it with the
  system's grabber and swipe down. The screen keeps its state; null closes the sheet, and a swipe calls
  `onDismiss`. A compose screen (File an issue, New Space, New room) is `pageSheet()`: iOS's page sheet, a modal
  on Android, its own bar padded by `pageSheetTopInset`; while it holds a draft, React Navigation's
  `usePreventRemove` makes Cancel, the swipe and Back ask first, and its own replace (File, Create) passes.
  A one-field prompt (rename, a title, a link) is `TextPrompt` (`screens/action-menu.tsx`, rules in
  `src/shell/text-prompt.ts`; the owner, 2026-11-19): iOS's own `Alert.prompt`, and on Android, which has
  none, a drawn Material 3 dialog (a headline, an outlined field, text buttons at the end), the only
  thing still drawn over a screen. Its `onSave` gives back why it refused (the app's check or the
  server's): Android says it under the field, iOS in an alert whose OK opens the prompt again with what
  was typed. iOS's Save can't be disabled, so text `canSave` refuses asks again. The testIDs
  (`<id>-input`, `<id>-save`) are Android's; the Maestro flows type and tap Save by text on iOS.
- **Menus are the system's** (CB-421): every ⋯, filter button and long-press is `ActionMenu`
  (`screens/action-menu.tsx`, @react-native-menu/menu's MenuView, T3 Code's choice): `trigger="press"` a
  UIMenu pull-down from the button on iOS (the menu is the button screen readers reach, with `label`;
  its child only draws, `MENU_TAKES_TAP`), `trigger="longPress"` a context menu with the row lifted as its
  preview (the row keeps its taps and its accessibility actions, its `onLongPress` `LONG_PRESS_TO_MENU`);
  Material's popup menu on Android. Items come from `MenuAction` (`nativeMenuItems`,
  `src/shell/native-menu.ts`): an SF Symbol by name (`MENU_SYMBOLS`) on iOS only, destructive red,
  disabled dimmed, `checked` for the choice that holds. `useActionMenu().open` is only for an ask with
  no button to hang from (a draft's Keep or Discard): the system's action sheet on iOS, an alert on
  Android. A native bar's button takes a `menu` (`BarMenu`, `bar-items.ts`): a UIMenu bar item on iOS
  (`type: 'menu'`), `ActionMenu` around the Material icon button on Android (the chat's ⋯). MenuView is
  native: a change to it needs a prebuild.
- **The root gate** (`root-gate.ts`) shows Add workspace with no workspace or while adding another
  (`rootState.setAdding`, the drawer's "Add a workspace"; Cancel or a sign-in ends it), the
  lock screen for a locked copy, and the shell otherwise. Each state opens on the first route of the
  table it shows. Its state names the active workspace, so a switch is a change too.
- **Links and taps from outside the app** go through `links.ts`, which holds each until the gate
  shows the screen it opens, never through React Navigation's own URL handling. Each variant opens only its own scheme,
  read from the build's config through expo-constants (`linking.ts`).
- **The shell's root is the native tabs** (the owner's 2026-11-08 choice, Slack's): the
  `Tabs` route is React Navigation's `createNativeBottomTabNavigator` from
  `@react-navigation/bottom-tabs/unstable` (`shell-tabs.tsx`), built from the tab table (`tabs.ts`:
  Home, Chats, Spaces (CB-459, the slot the Inbox freed: the Spaces list its root, at `/spaces` through
  `rootPath`), More and Search, each with its label, SF Symbol, lucide icon, link path and testID;
  and what More holds). There is no Inbox tab (CB-455, the owner, 2026-11-19): what it held is at the
  top of Chats (`screens/attention.tsx`), and the Chats tab's badge counts it (`TabBadge` in the tabs'
  layout sets the Chats route's `attention` param, which its options read: `tabBadge`; the Spaces tab's
  counts the pages changed elsewhere, `spacesAttention`, which lead the Spaces list); a kept
  `Inbox` last screen opens Chats (`TAB_REDIRECTS`, `lastScreen`). The system draws the tab bar: Liquid Glass on iOS 26, where Search
  (`tabBarRole: 'search'` with `tabBarSearchAutoFocus`, which iOS 27 needs to separate it; iOS only) is the separate glass button, and Material bottom navigation on
  Android, where Search is a fifth tab. iOS takes SF Symbols by name; Android takes images, so
  `plugins/tab-icons.ts` writes each tab's lucide icon as a vector drawable (`tab_<icon>`) at prebuild.
  Never draw a tab bar of our own. The tabs' titles are their bars' (below); the Board, Memories and
  the other modules are pages pushed in the tab they are opened from (Home's tiles, More, Search). `tests/navigation/tabs.test.ts` runs the table under Node.
- **The workspace drawer** wraps the tab navigator (`shell-drawer.tsx`, its `layout`,
  so it covers the tab bar), drawn by hand with gesture-handler and reanimated (`GestureHandlerRootView`
  is `src/app.tsx`'s root). It holds only the workspaces (`src/shell/workspaces.ts`,
  `screens/drawer-panel.tsx`): each one's logo, name, host and unread, the open one highlighted, then Add
  a workspace, Settings and Help (the web's `/docs` through `useOpenLink`, shown while a workspace is open). Choosing one switches through the active scope. Home's
  workspace button opens it (through `drawer-context.ts`), and on iOS a swipe from the left edge while
  Home shows (`drawerPanEnabled`: Android's gesture navigation takes the edge as back). The pan runs on
  the UI thread: its callbacks are worklets made in `drawer-gesture.ts`, a plain function the
  React Compiler leaves alone, named one by one in `usePanGesture` (the worklets plugin reads that object
  and refuses a spread); only the side it settles on goes back to React (`scheduleOnRN`). A release
  settles with the platform's spring from the finger's speed (`drawerSettle`, `src/ui/motion.ts`), the
  panel clamped between closed and open; with Reduce Motion it opens and closes at once (a drag still
  follows the finger). `tests/navigation/drawer.test.ts` runs the rows, the motion and the wiring under Node.
- **Motion** (`src/ui/motion.ts`): what the app moves itself (the drawer, a disclosure's chevron,
  the page editor's bar title) uses the platform's springs, never a timed curve: UIKit's smooth spring
  (no bounce, 0.4 s response, 0.3 s for small parts) on iOS, Material 3's motion scheme (0.9 damped spatial
  springs, critically damped effects) on Android; each jumps to the end under Reduce Motion. Pushes, sheets,
  menus and the tab bar keep the system's motion. No zoom transitions: react-native-screens 4.30 has no
  API for iOS's zoom from a tile into its page (T3 Code has none either).
- **Glass:** `GlassSurface` (`src/ui/glass.tsx`) is expo-glass-effect's GlassView on iOS 26 and later
  (`isLiquidGlassAvailable()`), and the token surface it is given (`fallbackClassName`) below iOS 26 and
  on Android. Use it only for what floats over a page (Home's tiles and header buttons); the native tab
  bar and native-stack draw their own glass.
- **Bars are the system's** (CB-420; the owner, 2026-11-18: the web's _brand_, its colors, module
  tones, Locals, words and content layout, in each platform's _own_ components; the app draws a
  component only when no native one exists). Every page's preset (`page`, `presets.ts`) gives
  native-stack's bar; the root stack has no `header` of its own, and its tint is the header's text color.
  On iOS it is a UINavigationBar, transparent over the page, which scrolls under it with iOS 26's
  scroll edge effect (no blur; before iOS 26 `onPlatform` gives it `systemChromeMaterial`), its buttons
  in Liquid Glass, Back the system's chevron with its swipe and long-press history. On Android it is a
  Material top app bar above the page (`onPlatform`, `nativeBarOverlays`). `page({ header: 'large' })`
  is a large title that collapses into the inline one as the page scrolls, for lists and module pages
  (the Board, the Spaces, a Space, Memories, Settings, Approvals, Runs, Schedules, Activity, Learning);
  `page()` an inline title, for detail pages (an issue, a page, a chat, a schedule); `page({ header:
  'native' })` the page editor's compact one over its WebView, with the material behind it (CB-417,
  `screens/page-editor-bar.tsx`); `page({ header: false })` none, only for the tabs, New chat (the first
  run's screen, its socio picker its heading, with `BackButton` from `header-bar.tsx`), Add workspace's
  first screen and the lock. A tab's root (`tab-stack.tsx`, `tabRoot`) has the tab's large title;
  Search's has the bar's search field on iOS (`useNativeBar`'s `search`, which iOS 26 puts at the
  bottom in the glass Search button's place) and draws `SearchField` on Android. Home's bar
  (CB-431) is one row, no large title (`tabRoot(title, { large: false })`): the workspace's logo, name and
  chevron lead it (`WorkspaceBarButton`, a `bare` custom `left` item, the name truncating), the account
  and ⋯ at its end, no Compose (the owner: each socio row starts a chat); its first run hides the bar
  (`hidden`) and keeps its own top.
- **A page fills its bar in with `useNativeBar`** (`native-bar.tsx`, over `bar-items.ts`): its title, a
  title view (the chat's socio), the buttons at its end, a search field and its module's tone. A button
  says its label, an SF Symbol for iOS (a UIBarButtonItem, `iosBarItem`: native-stack's `sfSymbol`
  icons) and the app's symbol name for Android (`icon`, drawn by `AppSymbol` in a 48 dp Material icon or
  text button, with its testID for Maestro; `tests/ui/symbols.test.ts` holds the two to the same thing); `custom` draws what the system has no item for (Keep offline, a room's socios).
  It sets every key each time (setOptions merges) and again only when what it shows changes
  (`barSignature`); the buttons call the latest handlers. A ⋯ opens `useActionMenu`. The search field is
  iOS's own (`headerSearchBarOptions`, `barSearch`); Android keeps the page's `SearchField`. A page never
  draws a title of its own: the web's line under its title stays as the first line (`PageIntro`). The
  module's tone goes where `MODULE_TONE_PLACE` says: `intro`, the owner's pick (2026-11-19), a
  small tone tile leading the first line with the bar neutral (`title`, the large title in the tone, and
  `tint`, Back and the buttons, stay as the other choices). Every module page has a first line for it:
  the Spaces the web's Spaces description (`SPACES_INTRO`), a Space with no description its pages
  counted (`spaceIntro`).
- **A page under the bar** has its scroll view first in its view chain (UIKit tracks the large title's
  scroll view, and react-native-screens finds the scroll edge effect's, by the first subviews), with
  `contentInsetAdjustmentBehavior="automatic"`. Its root View says `collapsable={false}`: a View with only
  a background forms no stacking context, so Fabric mounts its children beside it, after an empty
  background view, and the large title never collapses (`Screen`'s does it).
  UIKit insets it by the bar and the home indicator on iOS. `Screen` does it for a screen with no top
  edge (`uikitInsets`), and pads one that doesn't scroll by the bar (`useBarInset`, `bar-inset.ts`).
  A list that keeps its end in view (the transcript) pads by `useBarInset` instead, with its banners over
  it under the bar.
- Every screen has an error boundary (`screen-boundary.tsx`), each tab too. The table, the gate, the links and the
  presets have no React Native in them, so `tests/` runs them under Node.

## Store

The device store lives in `src/data/`, with no React Native, so `tests/data/` runs it
under Node on `node:sqlite` and a real temporary directory. The platform hands it a SQLite driver, a
file system, secure storage, SHA-256 and random bytes:

- **Launch opens it with `openStore`** (`store.ts`), before the first frame and after protected data
  is available: the reinstall and restore matrix (registry × keys × files), then the marked wipes
  (`resumeWipes`) and the sign-ins a kill left pending, then the reconcile. It never deletes on a read
  error or a wrong key: "files without their key" means the key is missing from secure storage. Its
  report says when to tell the person.
- **The platform's bindings are in `src/platform/`:** `sqlite.ts` (expo-sqlite: a connection per open,
  transactions on that connection behind a queue, never `withExclusiveTransactionAsync`; a delete
  closes the driver's connections to the file first; "Error code N" becomes a `SqlError`),
  `file-system.ts`, `secure-store.ts` (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`; a failed read throws a
  `KeyStoreReadError`, never null) and `crypto.ts` (expo-crypto's SHA-256; `crypto.getRandomValues`
  from react-native-get-random-values, which `index.ts` imports before anything else). Each takes its
  Expo module as a parameter, so `tests/platform/` runs it against a fake.
- **`src/app.tsx` starts the launch at import** (`device-store.ts`, `launch.ts`) and keeps the splash up
  until it settles: `socio/` is made and excluded from backups on every launch, before anything goes
  in it; on iOS, a key read that fails waits for protected data, then opens again (the wait never
  comes first: socio-device's README). The registry then feeds the root gate (`rootState`,
  `root-gate.ts`): call `rootState.refresh()` after anything that changes the active workspace or its
  lock. A store that doesn't open shows Try again and deletes nothing.
- **Diagnostics** (`screens/diagnostics.tsx`, `platform/diagnostics.ts`) is a route of development and
  preview builds only (`variants` in the route table), opened from the placeholders or
  `socio-dev://diagnostics`: every file's `cipher_status`, `cipher_version` and header, both open times
  from a scratch store in `socio/diagnostics/`, the container's listing, and Plant test files. At its top,
  the open workspace's outbox rows counted by state and the refused writes (`src/sync/outbox-tally.ts`, one
  line, `diagnostics-outbox`), which `perf/kill-send.mjs` and `perf/kill-file.mjs` read after a run.
  Production never mounts it; `tests/diagnostics.test.ts` holds that. It shows no row's content and no key.
- **The file system binding** (`FileSystem`, `layout.ts`) throws on a read it can't do, and its `exists`
  answers for files and directories in one call. Launch takes what is there from one listing and checks
  anything missing with `exists`; when they disagree it throws `FileSystemMismatchError` and deletes
  nothing. expo-file-system 58 doesn't hold to this by itself (Android's `list()` answers [] on an I/O
  error); a binding must pass `tests/helpers/file-system-contract.ts`. The app's (`src/platform/file-system.ts`)
  lists with the legacy `readDirectoryAsync`, which throws, and checks every "missing" against the parent's listing.
- **Every database is opened through `store.driver`,** which tracks connections, so a wipe closes them
  all before it deletes.
- **Paths come from `layout.ts`:** `socio/registry.db`, and `socio/<id>/` per workspace and person,
  where `<id>` is the hex SHA-256 of the exact origin, a newline and the app user id.
- **Secrets go through `store.keys`** (`keys.ts`), never secure storage directly: every name is indexed
  before its value is written, and leaves the index only once it has no value, so a reinstall finds it.
  A workspace's names are `socio.<id>.cache`, `.user`, `.jar`, `.relay` (its push relay registration's
  id and secret) and `.install` (its install id); no origin or user id goes into a name.
  The index is `{ v, keys }`: a later version may add fields but never take names out of `keys`, and an
  older build keeps the fields it doesn't know.
- **The registry** (`registry.ts`) holds the workspaces, the active one, the wipe mark, the session,
  lease and lock state, the server versions and minimum-version gate (migration 2), and the switcher's
  summary of each workspace, its name and unread, which the open scope keeps (`setSummary`, migration
  3), its outbox's rows (`waiting`, migration 4), and the phone's own settings, Advanced mode (off) and
  haptics (on) (`settings`, `setSettings`, migration 5), and the build the app last ran (`lastBuild`,
  `setLastBuild`, migration 6), and each workspace's push subscription with the device's push settings
  (`push`, `setPush`, `pushDevice`, `setPushDevice`, migration 7), and when the person last said Not now
  to the notification ask (`pushDevice().askDeclinedAt`, migration 8), and Appearance
  (`settings().appearance`: Light, Dark or System, System by default, migration 9; a value the build
  doesn't know reads as System), and what each workspace's manifest said at sign-in, its id and lease
  days (`serverWorkspaceId`, `leaseDays`, `wipeDays`, `setManifest`, migration 10; null on a server with
  none). Its schema grows only by additive migrations in `REGISTRY_MIGRATIONS`. Removing a row
  truncates the write-ahead log, so no copy of it is left there.
- **Wipe with `wipe()`** (`wipe.ts`): mark, revoke push, close, delete the directory, the keys and jar
  (then check both are gone), then the row and index entries, then verify. Revoking push (every
  reason) copies the workspace's relay registration to `socio.revoke-push.<32 hex>` (the registration
  id's bytes, `push-revocation.ts`: `{v, id, secret, origin}`, the relay origin it was made at, no
  workspace key, unread by older builds), then deletes its Web Push keys through `store.push`
  (socio-push's `deleteKeys`, which `StoreDeps.push` hands in; once push runs, the push manager's
  `forgetWorkspace`, which first waits for a push run still going, 10 s at most), then copies the record
  again, in case that run registered anew; a failure there fails the wipe, still marked. Launch's
  whole-store cleanup and reconcile never delete a push revocation record, and turn every relay
  registration they can still read into one first. Stop the workspace's scope and its cookie jar first,
  so nothing writes during the wipe. `resumeWipes` finishes only rows marked 'wiping'; a
  pending row is a sign-in being committed, and only launch wipes one. A new per-workspace secret a
  wipe must delete joins `WORKSPACE_KEYS`; one that must outlive it takes another name. Clear cache is
  `clearCache()`: cache.db and `images/` only. Settings runs it on the open workspace through
  `clearWorkspaceCache` (`src/sync/clear-cache.ts`): the scope is held closed, the cache goes, and the
  scope opens again, the outbox's overlays back from user.db; `cacheSize` measures the same paths.
- **Plain files keep their iOS protection class** (`workspace-files.ts`): `images/` is `complete`,
  `attachments/` the keys' unlock level (`completeUntilFirstUserAuthentication`), so the outbox can upload
  while the phone is locked. Whatever writes in one calls `prepareImagesFolder` or
  `prepareAttachmentsFolder` first (a folder's class is the one its new files get); every scope open does
  both too (`src/platform/active-scope.ts`), so Clear cache's reopen makes `images/` again with its class.

## Network

Requests live in `src/net/`, with no React Native, so `tests/net/` runs them under Node against a
fake fetch:

- **Every request to a workspace goes through `createAuthedFetch`:** only the workspace's exact origin
  (anything else is refused before sending), `credentials: 'omit'` with the jar's cookies sent by hand,
  `redirect: 'error'`, `Origin` on every request, and JSON writes. Hand code that talks to a workspace
  that function, never `appFetch`. It hands the answer back with its body unread. A request may carry
  its own `signal` beside the scope's (one run, stream or upload stops alone; the scope's still stops
  it, body included), `timeZone: true` for `X-Time-Zone` (shared's `browserTimeZone`, as the web sends
  on chat requests), and a raw body (`upload`: the bytes, `X-CB-Upload`, a URI-encoded `X-File-Name`,
  `X-File-Type`) only to `UPLOAD_PATH`, `/api/media/uploads`, and a dataset's files
  (`DATASET_FILES_PATH`, `/api/data/datasets/:id/files`, CB-469); anywhere else it is refused before sending.
  No server has that route yet, so dataset file uploads are off until CB-532 (`DATASET_FILE_UPLOADS`).
- **`createPublicFetch` is for the address probe and logos only:** no cookies, no Origin,
  `redirect: 'manual'`. Under 'manual', Android's expo/fetch sets `redirected` on the 3xx it hands back
  unfollowed (iOS's doesn't), so `redirected` means a followed redirect only on an answer that isn't a 3xx.
- **A workspace's address goes through `checkAddress`** (`address.ts`): https is assumed and only the
  origin is kept. Which origins a build accepts comes from its variant, never from a setting or a
  server: production any https host on the default port (owner, 2026-11-15: no list of allowed hosts),
  preview any https host on any port, development also plain http to the network config's local hosts
  (`LOCAL_HTTP_HOSTS`, held to `CLEARTEXT_HOSTS`). Any other value gets production's rules, and no
  variant takes a user name. Look-alikes are met by `WorkspaceHost` and the probe, not by a host list.
- **`probeWorkspace`** (`probe.ts`) first reads the manifest (`readManifest`,
  `/.well-known/socio/workspace`: no redirect, only one naming exactly that origin; no answer ends the
  probe, anything else is `manifest: null`, as on today's servers), then asks `GET /api/auth/session`
  through `createPublicFetch` (it still gives the methods the screens word), follows one redirect only to
  the same path over https and checks its target again (whose manifest it reads), and takes only a 200
  JSON sign-in view. With a manifest, a server below the minimum version is `server-outdated`, before
  any sign-in. Each request, body included, has its own `PROBE_TIMEOUT_MS` (10 s; OkHttp has none), past
  which it is `unreachable`. Every other outcome is a typed problem the screen words. It asks the
  registry about one exact origin at a time and never lists workspaces.
- **The add-workspace screens** (`screens/add-workspace.tsx`, `workspace-address.tsx`,
  `confirm-workspace.tsx`; bound in `platform/add-workspace.ts`) word each probe problem from
  `probe-copy.ts`, never the server's text, and test builds add the answer's status and origin under it.
  A workspace already on the device opens. The first screen (words and view model in
  `src/net/first-screen.ts`) says the ways in, in order: the invite link, the QR code from Socio on a
  computer (Get the app or Add a device; the system camera opens it, the app has no scanner), then
  "Enter your workspace address", its one button, to the address screen, and ends with the Privacy
  Policy link (Settings, Legal). It never lists workspaces. A
  Get the app link (`…/<variant path>/w/<host>`, `readWorkspaceLink` through `parseAppLink`, this build's
  link host and variant only) is held in memory (`src/navigation/workspace-link.ts`, bound in
  `src/platform/workspace-link.ts`) and opens the first screen through links.ts `openRoute`, a cold start
  included; its host is checked as a typed address (`addByLink`, `src/data/first-screen.ts`) and probed,
  then Confirm opens with the workspace filled in.
  Every such screen shows the host from the URL through `WorkspaceHost` (`hostParts`: the registrable
  domain emphasized, for now its last two labels), never from branding.
- **A logo is staged, never shown from the network** (`src/data/logo.ts`): the default `/favicon.svg`
  and anything the app can't take (another origin or type, over 256 KiB, a redirect) show the bundled
  mascot; a data URL or a same-origin PNG, JPEG or WebP (fetched through publicFetch, its bytes checked)
  goes to `socio/staging/` under a fresh name and shows as `file://` with expo-image's `cachePolicy:
  'memory'`. `commitLogo` moves it into the workspace's directory as `logo.<ext>` (the registry's
  `logo`); leaving Confirm, opening Add workspace and each new stage delete the staging directory.
- **One cookie jar per workspace** (`cookie-jar.ts`), for one origin, on a store it is given. It
  applies every response's Set-Cookie, whatever the status, keeps expiries in the server's clock, and
  is stored before the response comes back. The session's expiry moves only with a real slide (a day
  or more) or a new token: update-user sets the cookie again with a full week but doesn't extend the
  session (`session.ts`). The jar keeps that expiry after the server's clearing cookie, until
  `clear()`.
- **A 401 is classified (expired or ended) by what its request carried** (`jar.outgoing`), not by the
  jar when the answer comes. A 401 to a request the jar sent without a session cookie it judged
  expired is never ended; if its Date shows the cookie live, the request goes once more.
- **The install id:** 32 random bytes per workspace (`newInstallId`), in its `.install` slot, sent by
  authedFetch alone as `X-Socio-Install` (`installId`), so only to that origin, sign-in included;
  publicFetch and the relay's fetch never carry it. A sign-in stages one (the only copy on the origin's
  when the typed email is its person's and the row has `installSetAt`, else new: another person never
  gets someone else's) and the commit's `install` step moves it in and records `installSetAt`
  (migration 10). The scope sends it only for a row with that record, since an older build's wipe can
  leave the key. A copy from before install ids sends none until it signs in again. A 401 to a request
  that carried it is read for the server's `code` (from a clone, an `application/json` body only, at
  most its first `CODE_BODY_LIMIT` bytes, `sessionEndOf`): `session_expired` Expired, `session_ended`
  Ended ("Sign out this device"), `device_revoked` and `deactivated` a silent wipe, but only once one
  `GET /api/auth/devices` (behind the session check; the server answers `/api/auth/session` to anyone)
  with the install id answers the same code (else the 401 reads as if it had none); no code keeps the
  rules above. `signInAndCommit` refuses a saved origin whose manifest names another workspace id
  (`workspace-changed`) before sending anything.
- **Read bodies with `readText` or `readJson`** (`read-body.ts`): a body that breaks off is a
  `NetworkError`, so `serverAway` rides out a restart; expo/fetch's own body errors are plain Errors.
- **Read streams with `readSse`** (`read-sse.ts`, over `eventsource-parser`): frames as they arrive
  (AG-UI events, `cursor` with its `seq`, `closed` with its reason; unknown names skipped), 20 s with no
  byte (keep-alives come every 15 s) a `SilentStreamError`, a broken body a `NetworkError`, its signal an
  `AbortedError`. A device test showed expo/fetch's raw reader streams live on both platforms.
- **Runs go through `createRunClient`** (`run-client.ts`), our own AG-UI client over authedFetch
  and `readSse`; `@ag-ui/client` isn't used, and `@ag-ui/core` is a devDependency, imported for types
  only. A run's body is built only from the stored history and exactly one outbox row's message or tool
  result (`requestMessages`), never from overlays, with the page review tool and ids from `newId`
  (`randomId`, expo-crypto). Its events go into shared's `applyRoomEvent`. `connect` sends
  `x-cb-history-after`; `stop` is sent once, online only. What a failed run means for its row is
  `run-answer.ts`'s (statuses and `code`s, never the server's text): away is retry (`draining: true`
  for the server's own `draining` 503), a 409 `thread_running` (CB-357, by its `code`) is `busy`, a
  definite answer: the server took nothing; any other 5xx ambiguous (the chat send's busy-thread rule),
  429 waits, 400 re-uploads once with attachments, other refusals `unsent`, a readable non-draining 503 or a `no_inference` RUN_ERROR shows `NO_INFERENCE_MESSAGES`.
  Retry is only for no answer at all: once a run's 2xx stream is open, a break before RUN_STARTED is
  ambiguous, and a stop there is `stopped` with `accepted: true` (the server may hold the turn).
  `tests/contract/` runs it against a local server when `SOCIO_CONTRACT_CREDENTIALS` names servers.mjs's
  credentials file (README); CI skips it.
- **The platform binds the rest:** `src/platform/fetch.ts` (expo/fetch) and `src/platform/user-agent.ts`
  (`Socio/<version> (<device>; <OS> <major>)`, which says nothing about the person or the phone).

## Sign-in

Signing in is `src/net/sign-in.ts` and `sign-in-copy.ts`, then
`src/data/person-check.ts` and `commit.ts`, all under Node:

- **Nothing is stored until the commit.** `signInWithPassword` posts `{email, password}` and nothing
  else through `createAuthedFetch` on a fresh staging jar in memory, then takes the app user id from
  `GET /api/auth/session` (its `user.id`, the server's `appUserId`). The sign-in answer's body (`token`,
  Better Auth's own `user.id`) is never used. Every failure and every cancel discards the staging jar.
- **No session is left on the server that nobody holds.** A staging jar that holds a session and won't
  be committed is released: `POST /api/auth/logout` (best effort, at most `SIGN_OUT_TIMEOUT_MS`), then
  discarded. That covers a session check that fails after the server accepted the password, a commit
  that refuses or rolls back, and Cancel (`staged.cancel()`). A committed jar is discarded with no
  request, and a sign-in the person cancels with its signal stops at once.
- **The copy table maps codes, never the server's text:** a `SignInProblem` comes from the
  status and the JSON `code` alone, and a code the table doesn't know gets the generic line. A new code
  gets a kind, a line in plain words and a test.
- **The password goes into the request's body and nowhere else:** no error, problem, log, jar or stored
  value. `tests/net/sign-in.test.ts` and `tests/sign-in-flow.test.ts` search every one for it.
- **The person check decides before anything is written** (`decidePerson`, pure): the same person
  signs in again; another person needs the confirmation with their unsent count (null when it can't be
  counted, never 0); `BANNED_USER` wipes that email's copy silently; a row still pending or wiping
  blocks the commit.
- **`commitSignIn` runs in this order:** the pending row, the directory, the keys and both databases
  through `store.driver`, the jar through `keys.slot`, ready, then active. A failure at any step wipes
  it ('unfinished') and puts the active workspace back with `registry.restoreActive`, which doesn't
  count as a use, so every row's `lastUsed` (the switcher's order) is as it was. The same person's
  commit replaces only the jar and never wipes. It refuses while another person's copy is on the
  origin: wipe that first ('other-person'). Every refusal and failure is a `SignInCommitError`. A new
  step joins the plan with its rollback, and `tests/data/commit.test.ts` fails the commit after it and
  inside it, with a clock that moves on each read; that test fails while a step has no inside case.
- **`signInAndCommit`** (`src/data/sign-in-flow.ts`) runs the three for the SignIn screen: a refusal is
  its problem (BANNED_USER first wipes that email's copies); the same person or a new workspace commits
  at once; another person's copy returns `other-person`, where exactly one of `cancel()` (signs the new
  session out) and `confirm()` (signs the old session out with `signOutJar`, best effort, wipes it
  'other-person', then commits) may run; the person's own copy still pending or wiping is `unfinished`.
- **The SignIn screen** (`screens/sign-in.tsx`, bound in `platform/sign-in.ts`) comes after Confirm, which
  stays under it so the staged logo lives until the commit. It words every outcome from the copy table
  (test builds add the status and code), shows "Forgot password?" only with `methods.emailReset` (it opens
  the workspace's web page, which has the reset form), and offers no sign-up, whatever `methods.signUp` says:
  only the invite line (`signInFooter`, `net/sign-in-copy.ts`; owner decision 2026-11-16: accounts come only
  from an admin's invite, for Play's account-deletion rule; `tests/net/no-sign-up.test.ts`). It asks
  the another-person question in a system alert whose Cancel is the default. A new workspace's staged
  logo moves in after the commit (a failed move leaves the mascot), then `rootState.refresh()` shows the
  shell.
- **The system sign-in sheet** is `src/net/auth-sheet.ts` under Node, bound in
  `src/platform/auth-sheet.ts` (`openAuthSheet`); signing in through the sheet (below) uses it. The link host is picked once in
  `app.config.ts` (`plugins/app-links.ts`: `link.socio.sh`, or development's `SOCIO_LINK_HOST`, by default
  `link-staging.socio.sh`) and is `extra.linkHost`; each variant claims only its own path there
  (@socio/shared's `VARIANT_LINK_PATHS`): iOS `webcredentials` and `applinks`, an Android `autoVerify`
  filter with its `pathPrefix`, and the callback `https://<host>/<path>/cb` (`extra.authCallback`). iOS
  opens expo-web-browser with `preferUniversalLinks` (not ephemeral); Android socio-device's Auth Tab, else
  expo-web-browser's Custom Tab and the verified App Link. A callback is taken only when `parseAppLink`
  reads it as this variant's `cb`. `cancel` with an error string is `failed` (`config`), never
  `cancelled`, except iOS's `canceledLogin` (the person's Cancel, which comes with its words). Only a development Personal Team build uses the custom scheme (`socio-dev://auth-callback`);
  a preview or production one has no sheet. `tests/native-config.test.ts` holds each variant's config.
- **Signing in through the sheet:** SignIn offers the ways `signInWays` (`src/net/sheet-sign-in.ts`)
  gives by the manifest: Continue (the sheet) with `methods.sheet` in a build that has one, then the
  password form unless `methods.password` is false, with a sign-in code between them (Sign-in codes,
  below). Signing in again comes with no manifest, so SignIn reads it on mount (`signInManifest`; the
  password form until it comes, or when it can't be read). Continue makes a PKCE verifier (32 random
  bytes, base64url), its S256 challenge and a state, keeps the pending flow (verifier, state, origin,
  variant, start time, name) as `socio.sheet` through `store.keys` (`src/data/sheet-flow.ts`) for
  `SHEET_PENDING_MS` (15 minutes: the request's 10 plus the code's 5, then abandoned), and opens the
  server's `/api/auth/device/start`. A callback is taken once, only when it is this build's `cb` link
  (`readSheetCallback`) with the flow's state and host; anything else is refused with its kind
  (`SheetRefusal`) and the flow waits. `src/data/sheet-sign-ins.ts` (bound in
  `src/platform/sheet-sign-in.ts`) takes it from the sheet's answer or from a link (`root-navigation.ts` →
  `onLink` → links.ts `openRoute('SheetSignIn')`, over Add workspace): whichever comes first; the sheet's
  answer that nothing took says "didn't finish" (test builds add the kind), unless the link took that
  state. SheetSignIn redeems its own callback by its ticket, once; another screen gets nothing. Use,
  failure, iOS's Cancel and expiry delete the flow (launch sweeps an expired one); Android's Cancel doesn't,
  since the Custom Tab answers `dismiss` as the person comes back, which can come before the link's url
  event. The redeem (`redeemSheetCode`, `POST /api/auth/device/redeem` through a staging jar, the email
  from Better Auth's `get-session`, null when that fails) goes through `signInAndCommit`'s `stage`, which
  takes any method's staged sign-in with `email: null`: a fresh install id, and no BANNED_USER wipe by
  guess (the copy's own 401 `deactivated` wipes it). The redeem's codes are worded (`code-invalid`,
  `code-expired`, `wrong-variant`, `not-authorized`, `sheet-off`, and the server's 403 `denied`, `sheet-denied`).
  A same-person commit (any method) signs the replaced jar's session out in the background (`later`),
  with its old install id, never holding up or failing the commit. The verifier, state and code are in no
  log, problem or stored byte once the flow is done (`tests/sheet-sign-in.test.ts`,
  `tests/sheet-sign-ins.test.ts`).
  **A kill survives only on the Custom Tab path.** Android's Auth Tab hands its result to the activity
  that opened it, so it is lost if Android kills the app while the tab shows; the floor session
  checks it. The Custom Tab's callback comes back as a verified App Link, which a cold start takes.
- **Sign-in codes:** SignIn offers "Email me a code" or "Send a code to my Telegram" by the
  manifest's one channel (`codeChannel`, `src/net/sign-in-codes.ts`: email only while `methods.signInCodes`
  says so; none without a manifest), which opens `SignInCode`. It asks the email, then `POST
  /api/auth/device/code` with a fresh verifier and challenge per request (`requestSignInCode`, no cookie),
  and keeps the pending request (request id, verifier, origin, name, email, channel, variant, `sentAt`) as
  `socio.code` through `store.keys` (`src/data/code-flow.ts`) for 15 minutes; a refused Send again keeps
  the last. Its words never say whether the email has an account. The field takes the code with or
  without its dash, any case (`readCodeField`); Send again waits 60 s (`sendAgainSeconds`). The code's
  link (`…/<variant path>/c#code=…&ws=<host>`, `readCodeLink`) fills it in (`root-navigation.ts` →
  `src/platform/code-sign-in.ts`, opening SignInCode over the gate when it isn't showing) only when the
  pending request is that host's; otherwise it only shows the code in an alert. The redeem
  (`redeemSignInCode`) goes through `signInAndCommit` with the email (the install id kept for the same
  person, the person check, `BANNED_USER`'s wipe), worded by `codeRefusal`: a wrong code keeps the request
  (5 tries); `code_expired`, 429 `too_many` (`too-many-tries`, unlike the limiter's 429), `wrong_variant`,
  `not_authorized`, `method_off` and `BANNED_USER` delete it and start over at the email. A redeem the
  server took deletes it too. The code, verifier and request id are in no log, problem or stored byte
  but that entry (`tests/sign-in-codes.test.ts`).
- **Add a device, on the new device:** the QR code's link
  (`…/<variant path>/d/<host>#c=<pairing code>`, `readDeviceLink` in `src/net/add-device.ts`) is held in
  memory (`src/platform/add-device.ts`, `root-navigation.ts`) and opens `AddDevice` through links.ts
  `openRoute`, over the gate, a cold start included. Its host is checked as a typed address
  (`deviceLinkAddress`: `checkAddress`; a development build's local server is plain http) and probed (a
  manifest with `methods.addDevice: false` refuses). Opening it claims nothing: Continue claims (`POST
  /api/auth/device/pair/claim`, a fresh verifier and S256 challenge, `deviceLabel`, platform, variant;
  no cookie). Someone else's copy of the workspace on the device (by email, `otherAccounts`) asks "This
  device is signed in to Acme as <email>. Sign in as <other> instead?" first, Cancel the default; going
  on agrees to remove exactly those copies, so the commit's another-person question isn't asked again
  for them. Then "Sign in to Acme as <name> (<email>)?", the 6 digits, "Type this code on your computer to
  sign in" and the 2-minute countdown (this device's clock from the claim's answer). The redeem
  (`redeemPairing`, `POST …/pair/redeem`) is polled every `POLL_MS` (2 s; the server refuses more than one a
  second) inside `signInAndCommit`'s stage with the claim's email, so the install id, the person check
  and the commit are every sign-in's; `pollVerdict` keeps polling past `not_allowed_yet`, 429 and no
  answer ("Still trying"), and words `denied` (refused, 3 wrong tries, the page closed; run out once the
  countdown ended), `not_authorized`, `method_off` and `BANNED_USER`; a used QR code is `CODE_USED`.
  Polling pauses in the background (AppState through `src/platform/app-state.ts`) and goes on within the
  claim; leaving the screen (Cancel on the question or the digits, Back) stops it, after `cancelPairing`
  (`POST …/pair/cancel {claimId}`, one try, `CANCEL_TIMEOUT_MS`, never awaited, failures ignored) ends a
  claim still live, never one ended, run out or redeemed. The digits, claim id and verifier live in `src/data/add-device.ts`'s
  memory only, leave the view when the claim ends, and are in no log, problem or stored byte; a kill
  loses the claim (`tests/add-device.test.ts`).
- **Invites, when the app is installed first:** with the admin's "Invites open the Socio app" on, an
  invite or password link is `…/<variant path>/i/<host>#t=<token>` (`readInviteLink` in
  `src/net/invite.ts`, this build's link host and variant only). It is held in memory
  (`src/platform/invite.ts`, the first screen's `createWorkspaceLinkHold`) and opens `Invite` through
  links.ts `openRoute('Invite', 'popTo')`, over the gate, a cold start included; nothing of it goes into
  params or the navigation state. The host is checked as a typed address (`deviceLinkAddress`) and probed; a
  manifest with `methods.password: false` refuses. "Join Acme?" shows the host where the probe ended
  (`WorkspaceHost`; the screen reader says "Join Acme (acme.example.com)?") and warns when a workspace of
  that name is already on the device (`sameNameLine`: at another host, check the address). Join opens
  the web's set-password form (`SetPassword` in packages/client's `SignIn.tsx`): the email the invite went
  to, the password twice, `MIN_PASSWORD_LENGTH` (10, the server's `MIN_PASSWORD`; shared has no constant
  yet, so `tests/invite.test.ts` reads the server's and the web's) to `MAX_PASSWORD_LENGTH` (128). Then
  `POST /api/auth/reset-password {newPassword, token}` through a fresh cookie-less jar
  (`setPasswordFromInvite`), worded by code: `INVALID_TOKEN` (used or run out) and `USER_NOT_FOUND` end
  the invite, the length rules, 429 and no answer keep the form. Once set, the token is dropped and the
  password sign-in goes through `signInAndCommit` (the install id, the person check, the commit); a
  sign-in that doesn't take asks only the email again. The token and the password live in
  `src/data/invite.ts`'s memory only, leave when the screen goes, and are in no log, view, problem,
  navigation action or stored byte (`tests/invite.test.ts`).

## Sign-out

Signing out is `src/data/sign-out.ts` under Node, bound in `src/platform/sign-out.ts`:

- **The account sheet asks first only when the workspace has unsent items** (`signOutQuestion`, from
  `countUnsentItems`; a count that fails is never none). Then `signOutWorkspace` stops the scope
  (`holdScope` keeps it closed whatever the gate says), marks the row 'wiping', keeps a
  pending-revocation record, posts `/api/auth/logout` (Origin, `{}`, the session cookie alone, through
  `createAuthedFetch` on a jar in memory), wipes whatever the answer, deletes `socio/staging/` and
  clears expo-image's memory cache, then every WebView's data (socio-device's `clearWebViewData`:
  the default WKWebsiteDataStore's every type; Android's Web Storage, HTTP cache, form data and
  cookies). The wipe also deletes iOS's app-switcher snapshots (below). `tests/data/sign-out.test.ts` holds the order, nothing left, and a
  kill after every step.
- **The record is `socio.revoke.<random>`**, through `store.keys`: `{v, origin, name, value}`, nothing
  else. It is no workspace key, so the wipe and launch's reconcile leave it. Any HTTP answer drops it;
  no answer keeps it, and launch and each return to the foreground try it again (`retryRevocations`).
- **Push:** before logout, while the session lives, the workspace's push subscription is
  deleted once (`unsubscribePush`), never retried; the wipe keeps the relay registration's record, and
  `src/push/revocation.ts`'s `retryPushRevocations` sends the relay's `DELETE` (the secret alone) at
  once, at launch and on each return (`src/platform/push.ts`), dropping it only on the relay's own
  answers: 2xx, 410, and its 403 problem (`{"error": "secret"}`, `forbidden`); any other answer (a
  proxy's 403, another 4xx, a 5xx) or none keeps it. The relay's 410 then makes the server
  drop the subscription. Every other wipe (lease, `BANNED_USER`, another person, unfinished) revokes
  the same way.
- **The app navigates only after the wipe is verified:** while it runs, and when it fails (Try again;
  the next launch finishes the marked wipe too), `src/app.tsx` draws `screens/signing-out.tsx` in place
  of the root stack. Then the most recently used workspace left becomes active, or Add workspace shows.
- **Leave workspace** (CB-383; shared's `leave-workspace.ts`, the web's Settings → Account → Profile →
  Leave workspace) is `src/data/leave-workspace.ts` under Node, bound as `leave` in
  `src/platform/sign-out.ts`, a destructive row under Sign out (`screens/account.tsx`). The sheet asks
  `GET /api/account/leave` through the scope's authedFetch as it opens (`readLeaveCheck`): allowed;
  refused, the row off with the server's sentence under it; a 404 (an older server)
  hides the row; no answer, another status or a body it can't read is the row off with
  `LEAVE_CHECK_FAILED`. A system alert asks first (`leaveQuestion`: "Leave <workspace>?", what leaving
  does, the unsent items the phone would lose; Cancel the default, Leave workspace destructive), then
  `POST` `{ "confirm": "leave" }`. Only a 200 runs the sign-out above (`signOut`: the server has already
  ended every session and device, so its logout just meets a 401), the signing-out screen, then the
  most recently used workspace left or Add workspace. A 409 says the server's reason in an alert and
  turns the row off with it; no answer or any other answer says ours; neither touches the phone's copy.
  `tests/data/leave-workspace.test.ts`.
- **Nothing of the workspace outside its folder** (CB-356): every request asks for no-store
  (`noStore` in `src/platform/fetch.ts`), which keeps answers out of OkHttp's cache
  (`cache/http-cache/`). iOS's URL cache (`Library/Caches/<id>/Cache.db`) ignores that, so socio-device
  replaces `URLCache.shared` with one that keeps nothing as the app starts (its README). The app switcher
  shows the app as it was: the privacy cover that hid every screen while the app was inactive or in the
  background was removed at the owner's request (2026-11-10). Instead every wipe, sign-out's included,
  deletes iOS's snapshots of the app (`Library/SplashBoard/Snapshots`, `Library/Caches/Snapshots`):
  `wipe()` calls `store.wiped` once the files are gone, and `src/platform/app-snapshots.ts` runs
  socio-device's `deleteAppSnapshots`, best effort, logged, never awaited, never on Android (its recents
  thumbnail isn't a file of the app's). `e2e/run.mjs --no-workspace-left` fails on either cache, on an
  iOS snapshot left (`appSnapshots`; `sign-out.yaml` sends the app to the background on a workspace's
  screen first), and on anything a WebView kept (`webViewStorage`: stores under `app_webview/`,
  `Library/WebKit/` and `Library/Caches/<id>/WebKit/`; Chromium's empty bookkeeping isn't data).

## Sync

Sync lives in `src/sync/`, with no React Native either, so `tests/sync/` runs it under Node against a
fake server and a real `cache.db` (`node:sqlite`):

- **A source is `pull(scope, cursor)`**, which applies its answer and returns `{upserts, removes,
  cursor}`. The shell's two snapshot sources (`shell.ts`) ask exactly `/api/state` and
  `/api/workspace`, with no query (the ETag's version part hashes the path and query), through the
  workspace's `authedFetch`.
- **The ETag goes back exactly as received** (`W/` included) as If-None-Match; a null cursor is the
  full poll. A 304 is never parsed. A 200 is checked whole, then diffed against the scope's rows by
  `mergeSnapshot`'s rules (`merge.ts`, ported from the web's), so a pull in flight can't undo a
  write the server confirmed (`cache.confirm`). A confirmed change, or a confirmation holding a row
  against an answer, drops the source's ETag: its next pull is full, and a 304 never vouches for a
  body the device doesn't hold.
- **`/api/workspace` fills the shell, conversations, spaces and dots under one ETag.** Each source's
  meta row is keyed by its name. Notices stay on the device after the server's 24 h (at most 200).
- **The modules' kinds** (`kinds.ts`) are whole kinds beside the shell's: `issues`
  (`issues.ts`, `/api/issues`: summaries by number, versioned by `updatedAt`, the `users` map as one
  `issue-users` row, and the `components` label map as one `issue-components` row, null from a server
  before CB-442; format 2, so a format-1 copy's next pull is full). Before the first frame only the kept screen's kind is read from cache.db
  (`firstFrameSnapshots`: issues when the Board is kept); the rest as the scope starts (`cache.load`), or
  by the kind's first pull. Rows are kept by key, so the server's order isn't: a screen sorts. None is
  gated (no module's manifest has an `access` rule): a 403 or 404 is an error with back-off, never a
  wipe. Four more are pulled only while their screen is in view (`inView`), never with the shell:
  `memories` (`memories.ts`: memories and proposals by id, one `memory-profile` row), `schedules`
  (`schedules.ts`: schedules, goals with their comments and jobs by id, one `schedule-limits` row),
  `runs` (`runs.ts`, by run id) and `skills` (`skills.ts`, by container id). Scheduled tasks stay in
  the shell's `state.tasks`. `/api/learning/skills` sends no ETag: its definition's `hashBody` makes the
  source send no If-None-Match and keep a hash of each 200's body (`bodyTag`) as the ETag, so an
  unchanged body applies as a 304. Each screen pulls its own: Memories, Schedules, Runs and
  Learning; a kept `Memories`, `Schedules`, `Runs` or `Learning` reads its kind before the
  first frame.
- **Approvals:** the `approvals` kind (`approvals.ts`,
  `/api/approvals`, which sends no ETag, so `hashBody`) holds the person's requests waiting and recently
  decided by id, unversioned, at most the server's 100 most recent; pulled with the shell and every 60 s
  while an approvals screen or Chats is in view. Decisions are the scope's `approvals`
  (`approval-actions.ts`) and never go through the outbox: `decide`, `openDetails` and `undo`
  (`POST /api/approvals/:id/{decision,open,undo}`) are refused before any request offline, while the
  server is away or while `writeHold` holds (`blocked()`), and by shared's card rules (`approvalRule`:
  Approve waits for `mustOpenFirst`, a decided request takes none, details open only with a `review`,
  undo only for an automatic approval that can be); `openDetails` answers `{ kind: 'opened', full, view }`
  (the server's `{ full }`, and the request marked opened, else read again); one request at a time per request; one that breaks off (no answer, or a 5xx) leaves it
  `unconfirmed`, read again once online, never sent again; a 409 or 404 reads it again, by status alone
  (the 409s carry no `code`). Its listeners hear each change of state, of a view kept in memory and of
  the connection NetInfo reports. `watch(id)` reads a shown request every 5 s while it waits, every 2 s while
  its socio carries on (the web's rule), in the foreground and online only; a return from the background
  asks about each request still waiting, four at a time with a 10 s timeout. Every answer updates its
  row (`cache.confirm`) when the collection holds it or it waits, else `view(id)` keeps it in memory. A
  decision buzzes success or error (`approvalFeedback`, by the phone's setting).
- **Memory first, then `cache.db`** (`snapshot-cache.ts`): rows and the meta that describes them go
  in one transaction, through the write queue (`write-queue.ts`): 500 ms after changes settle, at
  most every 10 s, and at once on the flush trigger the platform injects (the app going to the
  background). A confirmation writes at once.
- **Contact** (`contact.ts`, for the lease): only 2xx or 304 answers, under `/api/` but never
  `/api/auth`, to requests that carried the session cookie, from `authedFetch`'s `onAnswer`.
- **The server's version** (`versions.ts`) is `/api/state`'s `version` (no header carries one): a 200's
  from its body, a 304's from the stored state row it vouches for. The cache hands each answer, with its
  Date header, to the workspace's `ServerVersions` in the order answers apply. The highest version seen
  is taken at once; a lower one only after answers below it have lasted over 6 minutes (`ROLLBACK_MS`)
  with none at the highest between, since a start-first deploy has two builds answering for about 5.5.
  That window runs on the server's clock (the answers' Date), never the device's, which can jump; a long
  gap between two lower answers counts, since a deploy's old build is gone by then. Each meta row is
  stamped with the highest as its answer applies, unless its pull began before that version was taken.
  A scope stamped otherwise is `stale()`, due one pull, which sends its ETag like any other: the tag's
  boot id makes a new build check the body hash.
- **The minimum-version gate** passes `MINIMUM_SERVER_VERSION` (0.32.0) and later, and '0.0.0' only in
  development and preview (the variant is injected). Each answer's verdict is the highest version's
  after it, not the answer's own, so a deploy's old build has no say however the answers are shared out,
  and the gate moves at most once per deploy; an answer with no readable version votes closed. It opens
  or closes only when two verdicts in a row agree. Its state and the versions are kept in the registry
  (`setServerVersions`), written only when they change; `lastVersion` keeps only a release version
  (SemVer, at most 64 characters), else null. While it is closed the shell shows the update banner
  (`StatusBanners`) and writes wait (`writeHold`).
- **Pull to refresh** is the scheduler's `refresh(collections, scope?)`: the jobs that fill those
  collections pull now, in view or not, and it resolves once none has a pull waiting or in flight (offline,
  away or in the background at once).
- **One scheduler per workspace** (`scheduler.ts`): one pull at a time per source and scope, and pokes
  within 100 ms of the first are one pull (a poke in flight runs it once more, except a screen's). Its
  triggers, in the foreground only ('inactive' counts): a return after 10 s or more in the background
  (a picker or share sheet is less) and `start` (in the background, it waits for the foreground), both
  full; a screen in view (`view`) whose data is older than 5 s; NetInfo's network back or type change;
  the shell every 15 s after each pull (`/api/state` every 5 s, its `pollMs`, for presence); a module's kind at its `visiblePoll` (15 s for issues and memories,
  10 s for schedules and runs, none for skills) after each
  pull while a screen showing it is in view (`view` returns the leave, which `useSyncOnFocus` calls on
  blur), doubling up to 5 minutes after each refusal; a higher server version (`stale`); a write confirmed while a
  pull is in flight (`confirmed`). A module's kind is `deferred`: it waits while a shell pull is in flight
  or about to go, so after a start it goes after the shell. An `inView` job is skipped by the triggers of every
  job (start, return, network, `stale`, a poke of all) unless a screen showing it is in view. A full poll sends no If-None-Match: on return, and when the last 200
  is 5 minutes old. While the server is away (`serverAway`) it waits with jitter, 1 s
  to 10 s, rising to 60 s past a deploy's window (6 minutes); a return or the network back starts over,
  and `status()` says "Reconnecting…" until the next answer. Everything runs on the timers' clock, so
  tests drive it with fake timers.
- **AppState and NetInfo are injected** (`triggers.ts`, after T3 Code's wakeups):
  `src/platform/app-state.ts` and `src/platform/network.ts` bind them, the only files of `src/` that may
  (`tests/platform-bindings.test.ts`).
- **`WorkspaceScope`** (`scope.ts`) holds everything of one open workspace: cache.db and user.db, the
  jar, authedFetch and its AbortController, the snapshot cache, the versions and gate, contact (the
  registry's `setLastContact`), the collections and the scheduler. `openWorkspaceScope` resolves with
  the collections already filled, before any request; `start()` begins sync (not for a locked copy).
  It reads cache.db's `kv` as it opens (`viewState`, `view-state.ts`: the last screen), and writes each
  change at once. `dispose()` stops the scheduler and listeners, aborts what's in flight, writes what's
  pending, then closes the jar, the collections and both files; it leaves no timer, listener or connection, and a wipe
  runs after it. The background and the network going write the cache, versions and contact at once.
- **The collections** (`collections.ts`) are TanStack DB collections: `shell`, `conversations`,
  `spaces`, `dots`, `notices`, `issues`, `issueUsers`, `memories`, `memoryProfile`, `schedules`, `goals`,
  `jobs`, `scheduleLimits`, `runs`, `skills`, `approvals`, `roomInvites` and `issueComponents` mirror the snapshot cache through a custom `sync` (filled as created,
  then every change the cache tells, `subscribe`), and `pending` is local-only, from user.db's outbox
  (`pending.ts`, payloads undecoded). Ids are `<scope id>/<name>`, and the scope id is unique per open
  scope, because TanStack DB keys live queries by collection id: two scopes never share a row or a query.
  `gcTime: 0`, since the scope owns them. Unchanged rows are never rewritten, so they keep their identity.
  Cleanup is final: TanStack DB restarts a cleaned-up collection for any late subscriber, so each sync
  run checks the scope's gate and, once closed, is ready with no rows; a closed snapshot cache gives no
  rows and keeps no listener either.
- **Chat histories** (`history.ts`, `history-disk.ts`; the scope's `histories`) port the web's CB-136
  store: one TanStack DB collection of finished runs per conversation (`<scope id>/history/<thread>`),
  read from cache.db (`rows`, collection `history`, shared's `historyScope`), then pulled from
  `/history?after|before`. Runs enter only when they chain; `more` or a gap re-pulls the newest page;
  a 404 or 410 drops the scope and calls `onGone` (the Unsent list's). Memory holds at most 8 chats
  and never one a screen `use`s; disk holds 100 chats and about 50 M characters, LRU through `scopes`,
  never a run over 4 MB, skipping shown and `pinned` chats. Nothing is written while a run streams
  (`streaming()` until RUN_FINISHED or RUN_ERROR). Opening drops only scopes of another
  `HISTORY_FORMAT`. A local id (`isLocal`) never reads the network. `preload` reads from disk alone,
  and the chat it hands out stays in memory until its first `use()` (or `HANDOFF_MS`); hold one from
  `history()` with `use()` in the same turn. A chat that left memory takes no answer and writes
  nothing more. `loadEarlier` waits for a pull in flight and ignores a page that comes after the runs
  were replaced or dropped. `pull()` resolves true once caught up (no `more`).
- **Bounded kinds** (`bounded-kind.ts`) are history-disk.ts's rules for single items: one item
  per key in cache.db's `rows` (collection `<name>`, scope `<name>:<format>:<key>`), LRU through
  `scopes`, a disk bound per kind (items and characters), never an item over 4 MB (its older copy is
  deleted), skipping shown, preloaded and `pinned` keys; memory holds at most 8, never one a screen
  `use`s; opening drops other formats. `use()` reads the server; `preload` reads disk alone and keeps
  the item until its first `use()`; `refreshKnown` reads only what memory or disk holds; `put` (a
  write's answer) drops reads begun before it; an item `refreshKnown` reads stays in memory until
  its read settles. A 404 or 410 (`isGone`) drops the item and calls `onGone`, even after it left
  memory; another failure keeps the copy with its age (`fetchedAt`). `memoryOnly` items never reach
  disk; a local key (`isLocal`) never reads the network. The first is `issueDetails`
  (`issue-details.ts`, the scope's): `GET /api/issues/:number`, 200 on disk, read on open, after a
  write that names it (`notesToPull`'s `issues`) and when the list's poll brings its row with a newer
  `updatedAt` or drops it (`followIssueList`), never while it is unchanged; its answer refreshes its
  `issues` row and the assignee's name (`confirm`); a gone issue's lanes (`issueLanes`: `issue:`,
  `issue-comments:`, `vote:`) go to `unsent` with `UNSENT_GONE` and pin it on disk while they hold
  writes; `pending-issue-…` keys (`isLocalIssue`) send nothing. The scope's `scheduleDetails`
  (`schedule-details.ts`) holds three: `task-details` (`GET /api/tasks/:id`), `schedule-details`
  (`GET /api/schedules/:id`) and `job-details` (`GET /api/schedules/jobs/:id`), 20 each on disk, read as
  their page uses them, again when the list's row changes (`scheduleSignature`, `jobSignature`, the
  shell's `updatedAt`) or after an action on them, never on a timer; older runs (`…/runs?before=`) and a
  job run's logs (`/schedules/runs/:id`) are read online only and never kept. The scope's `runTraces`
  (`run-traces.ts`) is `run-traces` (`GET /api/runs/:runId/trace`, 30 on
  disk), read only when a run's page opens, the person's tap: never by the Runs list, never preloaded from
  the network, never on a timer, since an admin's read of someone else's trace writes the access log
  (CB-188). Only the person's own (the `runs` row's `ownerId` is the scope's app user id, `isOwnRun`)
  reach disk; someone else's, or a run the phone can't place, are `memoryOnly`; a 404 is "isn't
  available". A kind's `fresh` lets `use()` skip the
  read while the copy held is current, and `dropPrefix` drops every key with a prefix, gone in memory
  and off disk in one transaction the caller may share (pages, below).
- **Pages** (`pages.ts`, `page-store.ts`; the scope's `pages`). Each Space's summaries are a
  scoped snapshot kind (`PAGES_SNAPSHOT`'s `scopedPath`, `GET /api/spaces/:id/pages`, cache scope = the
  Space's id, versioned by `revision`): the cache reads a scope as it is first asked (`load(defs,
  scope)`) and drops one whole (`dropScope`, with the caller's statements in its transaction). A
  Space's TanStack DB collection is `<scope id>/pages/<spaceId>` (`space(id)`, through
  `mirrorCollection`). Its job joins the scheduler as the Space is first shown (`add`: `inView`,
  `deferred`, 15 s while shown; `view(collections, scope)` counts only that scope), and `open()` pulls
  it before a page opens online. Bodies are the `page-body` bounded kind, keyed by
  `pageBodyKey(spaceId, pageId)`: 200 and about 20 M characters on disk, read on open only when missing
  or older than the summary (`fresh`), again when the poll brings a newer revision for one in memory;
  pinned while their page's lanes (`pageLanes`: `page:`, `cover:`) hold writes, or their Space is kept
  (`keptSpaces`). A poll that drops a page asks for a held body: a 404 reads
  `/api/pages/:id/location` and a move re-keys (the last screen `Page/<spaceId>/<pageId>`, `onMoved`);
  a 410, or a 404 with no location, drops it and refuses its lanes with `UNSENT_GONE`. A Space that
  leaves `/api/workspace` drops its summaries and bodies in one transaction and refuses its pages'
  lanes (one a kill left is dropped as the store opens). `preload(spaceId, pageId)` reads both from disk
  alone; a cold start onto a kept page runs it before the first frame (`preloadKeptPage`). Dataset views' last
  results (`dataset-views.ts`, the store's `views`) are a bounded kind whose every key
  is local, so nothing reads by itself: keyed by the page's body key and a hash of the spec's dataset,
  query and parameters, asked once as a view shows (`load`, `POST /api/data/views/query`, no timer) and
  `put`; the block follows its key (`itemAt`) and asks through `createViewAsk`, once a key per mount, since a
  denial replaces the item and an effect on the item would ask forever; `VIEW_NO_ACCESS_CODE` deletes the copy, one over 4 MB never reaches disk, and a lost Space drops
  them in its bodies' transaction.
  A Space's radar and memory (`space-sections.ts`, the store's `sections`) are one bounded kind
  keyed `<spaceId>/radar` and `<spaceId>/memory` (`spaceSectionKey`, under the Space's body prefix),
  `GET /api/spaces/:id/radar` and `…/memory`, read only as their tab holds them (`use()`, no poll), 100
  on disk; a 404 drops the copy, a lost Space drops them in its bodies' transaction, and the store's
  open sweeps a Space a kill left with only them on disk.
- **Spaces kept offline** (`kept-spaces.ts`, `keep-offline.ts`; the scope's `keptSpaces` and
  `keepOffline`). The choice is user.db's `prefs` (migration 3, `KEPT_SPACES_PREF`, a JSON list of Space
  ids), so Clear cache keeps it; a read-only user.db shows it and takes no change (`writable`). Builds from
  before kept Spaces open that user.db read-only and stop sending ("Update Socio to send these").
  A kept Space's bodies whose revision differs from the summary's are read one at a time, in one queue,
  into the bodies' disk with `put` (never memory): as it is kept, after a pull that changes its pages, as
  the workspace lists it (after Clear cache), and on `sync()` (the scope's start in the foreground, each
  return to it, the network back), which pulls its pages first. No answer ends the round; 404 and 410 are
  the list's to settle; a body over 4 MB isn't read again at that revision. A Space the workspace no
  longer lists is skipped. `sizes()` gives each kept Space's bodies and bytes on disk. Only the Space
  bar's `KeepOfflineToggle` (`src/screens/keep-offline-toggle.tsx`) turns keeping on, a custom
  item in the Space's bar; Settings only turns it off.
- **Steering snapshots** (`steering.ts`; the scope's `steering`) hold each chat's queued
  messages in memory, one TanStack DB collection per conversation (`<scope id>/steering/<thread>`),
  keyed by server id, from `GET /api/conversations/:id/steering`: as a chat opens (`use`), on the
  follow stream's frames (`refresh`) and from the view each steering write's answer carries
  (`writing()` as the write is sent, then its answer), which drops any GET that started before it; an
  answer that comes after a GET sent later was taken is not taken, and the snapshot is asked again.
  The view's `limit` is `maxQueued` (null until one comes). A 404 or 410 empties it; a local id never
  reads the network; memory holds at most 8 chats, never a shown one. `queuedBubbles` is the overlay rule: an outbox row's bubble hides once the snapshot lists
  its server id or the history holds it, and a queued message's once the history holds it.
- **Follow streams** (`follow.ts`; the scope's `follows`): while a screen `use`s a chat,
  `GET /api/conversations/:id/stream?after=` opens, only once the history's pull is caught up (no
  `more`), after the newest run held; reconnects catch up the same way and send `Last-Event-ID`.
  Frames go through shared's `applyRoomEvent` into `state.turn`. One source per run, decided at its
  RUN_STARTED: a run that starts while this device's POST lives (`ownRun()`; its end with `broken`
  reopens the stream, which replays the turn) is dropped whole, as is a run the history holds; a run
  already streaming when a POST opens is kept. Steering is asked again as runs start and end, on
  cursors, on `closed` and on a user TEXT_MESSAGE_START (a queued message delivered mid-run; the chat
  screen should also treat ids in `state.turn` as delivered). A `cursor` pulls the history, and the
  live turn goes the moment the history holds its run. `closed` with a reason ends it; an end with
  no reason, a drop or 20 s of silence reconnect with the scheduler's `awayDelay`; any other failure
  stops until `check()`. A reconnect asks steering again: a turn the server ended while the stream was
  down (a restart) sends no frame to say so. The scope checks every open stream on return from the
  background and wakes waiting ones when the network comes back. The history writes nothing while a streamed run runs.
- **Screens read the scope through `src/live`** (React, outside `src/sync`): `WorkspaceScopeProvider`
  (which remounts its subtree for a new scope), `useCollections`, react-db's `useLiveQuery` and the
  query operators, `useSyncOnFocus` (a screen in view), `useSyncStatus` ("Reconnecting…") and
  `useVersionGate`, `useSessionState` and `useWriteHold`, `useViewState` (the scope's `kv`) and `useHasWorkspaceScope`. `index.ts` loads `react-native-get-random-values` first, for TanStack DB's ids.
- **One scope is open at a time** (`active-scope.ts`): the shell gate's workspace's,
  opened before the first frame and following the gate (`src/platform/active-scope.ts`). A switch
  disposes the old scope before the next opens, and the last switch asked wins. `src/app.tsx` draws
  the root stack under `ActiveWorkspace` (`src/live/active-scope.tsx`): the open scope's provider, keyed
  per scope, so a switch mounts the tree again and opens on that workspace's last screen; nothing
  draws while a scope opens. A scope that doesn't open (its key is gone, a read fails) isn't
  "shown", so asking again (or `retry()`) opens it again; the app draws `screens/workspace-failed.tsx`
  in place of the root stack: Try again, the switcher and Add a workspace, so a person is never stuck.
  `tests/sync/active-scope.test.ts` switches through three fake servers.

## Push keys

`modules/socio-push` (its README) makes and keeps each workspace's Web Push keys
natively and decrypts pushes with them:

- **JavaScript gets only `p256dh` and `auth`** (`createKeys`, `getKeys`); the private key never leaves
  native code. `decrypt(workspace, body)` is RFC 8291 aes128gcm, one record only, in CryptoKit
  (`ios/Shared/WebPushDecryptor.swift`, which the notification extension compiles too), tested by XCTest
  against `vectors.json`; Android's Kotlin test reads the same file.
- **On iOS the items go to the keychain group shared with the extension,** written with an explicit
  access group, `AfterFirstUnlockThisDeviceOnly`: the keys, the registration index (`setRegistration`:
  relay registration id → workspace id and name), each workspace's locked flag and `leaseLockAt`, and the
  device's show-text setting. Nothing else goes there; the store's keys and jars stay in the app's own
  group (`plugins/push.ts` lists it first). The group comes from the Info.plist keys `plugins/push.ts`
  writes; Personal Team builds strip them, so their push items stay in the app's own group.
- **`deleteKeys(workspace)`** deletes the keys, the flags and the registrations that point at the
  workspace. `readInbox` and `deleteInbox` read and delete the extension's per-push files
  (`inbox/<uuid>.json` in the app group: workspace id, link, tag, time; never a title or body).
- Ids are checked in the wrapper before a keychain account or file name is made of them. Diagnostics'
  Push keys check uses a scratch key for the made-up id `diagnostics`, never a workspace's.

## Push subscriptions

Registering and keeping each workspace's push is `src/push/` under Node, with
expo-notifications, socio-push and the relay client handed in by `src/platform/push.ts`, which launch
starts after the first scope opens (`device-store.ts`):

- **The relay's origin is the build's** (`SOCIO_RELAY_ORIGIN`, `relay-origin.ts`, `extra.relayOrigin`;
  README). `src/net/relay-fetch.ts` sends there and nowhere else: `credentials: 'omit'`, no Origin,
  `redirect: 'error'`, no-store, JSON, the app's User-Agent, and a 15 s limit on each exchange, its
  body included (`RELAY_TIMEOUT_MS`: OkHttp on Android has none). `tests/dependency-graph.test.ts` keeps it
  out of `src/sync`. A build with no relay, or one that can't share push items with the extension
  (a Personal Team build: socio-push's `storage().shared` false), never registers.
- **The APNs environment is the build's** (`extra.apsEnvironment`, `aps-environment.ts`; README): it
  gives the registration's `apnsEnv` (`development` is `sandbox`). A development-signed build must set
  `SOCIO_APS_ENVIRONMENT=development` so its registration says `sandbox`.
- **Registering** (`ensure`, as each workspace's scope opens, then daily while open): the native token
  (`getDevicePushTokenAsync` only), `GET /api/notifications/channels` (`pushKey`, the push channel's
  targets), the relay's `POST /v1/registrations` with an id and secret chosen and kept first
  (`socio.<id>.relay`), then `POST /api/notifications/push/subscriptions` with `installed: true`. Each
  answer is kept as it comes (the registration, then the subscription id: migration 7), so a kill
  after any step ends with one of each. A 403 or 409 from the relay takes a new id once. A changed
  `pushKey`, or our subscription missing from the targets, makes a fresh registration and keys. A 400
  from the server is "the push hosts don't take the relay" in Technical details' Push section.
- **The device record:** the subscription's `POST` goes through the scope's authedFetch, so it carries
  `X-Socio-Install` (a row with `installSetAt`) and the server binds it to this device as it answers 201. The endpoint (`<relay origin>/v1/push/<registration id>`) changes only with a new registration,
  and `ensure` always `POST`s after one (a token change or the daily refresh `PUT`s the relay alone,
  same id), so the app never sends `PUT /api/auth/device/push`. `tests/push/subscription.test.ts`.
- **A new relay origin** (a build may ship with another `SOCIO_RELAY_ORIGIN`, or none, than the one
  phones registered with): `socio.<id>.relay` keeps the origin the registration was made for
  (`{v, id, secret, origin}`; an older record has none, is taken as the build's and gets it written).
  When the build's differs, or it has none, the workspace's `ensure` retires it before
  anything else, each step kept before the next: its revocation record (with that origin), the old
  subscription's `DELETE` at the server (no answer or a 5xx stops there: `failed` at `unsubscribe`),
  the registration forgotten here, then the record tried at the old relay at once (`relayAt`: only an
  origin the variant takes as `SOCIO_RELAY_ORIGIN`); then it registers afresh at the new relay and
  subscribes, or stops with `no-relay` (push off). Every revocation record goes to its own origin's
  relay (`retryPushRevocations`' `RevocationRelays`), so a wipe after the move still tells the old
  one. Until then the keepalive refreshes it at its own relay (its token change and the daily `PUT`;
  one this build can't reach waits), so a workspace nobody opens keeps its push and its secret never
  goes to the new relay. `tests/push/subscription.test.ts`
  moves between two fake relays, A then B then none, with a kill after each step.
- **The keepalive** (launch, each return, a token change while running): the native token against
  each registered one first; a change, and once a day (`pushDevice().refreshedAt`), `PUT`s every
  registration with its secret alone. A 410 or 403 forgets it here; the next `ensure` registers anew.
  Permission taken back in the phone's Settings: the open workspace's subscription is deleted once,
  then every registration at the relay (its 410 makes each server drop its subscription).
  The token event fires on every `getDevicePushTokenAsync` too (expo-notifications, both
  platforms), so its listener passes the event's token (`keepalive(open, { token })`) and the
  manager skips the token it last saw: never call `nativeToken()` from that listener.
- **The flags** (`syncFlags`): each registered workspace's locked flag and `leaseLockAt`, written when
  they change: after a lock or unlock (the root gate), and each kept contact (the scope's `onContact`).
  The device's show-text setting (migration 7, on until set) goes to the native side at launch and
  after each change on the Notifications screen (`src/push/show-text.ts`).
- **The badge** (`badgeCount`, `WorkspaceSummary`): the open workspace's approvals waiting plus its
  rooms' unread, set as each pull lands; 0 whenever no scope is open (`followBadge`: the last
  workspace removed, the lock screen). No badge summed across workspaces yet.
- **A wipe waits for push** (`forgetWorkspace`): it marks the workspace forgotten, waits for the runs
  queued before it for `FORGET_WAIT_MS` (10 s) at most, then the native keys, flags and index entries
  go, and once more after a run it gave up on ends. A run checks the mark before each write and stops
  there; `ensure` writes nothing for a row that isn't ready; so nothing comes back after the wipe, and a
  stalled relay can't hold a sign-out, a lease expiry or an unfinished add.
- **Every wipe revokes** (Store and Sign-out above): the registration's record outlives the
  workspace until the relay answers; the native keys go with the wipe.
- Nothing personal goes to the relay or the server. `tests/push/subscription.test.ts` runs it against
  a fake relay and fake servers: every keepalive branch, a kill after each step, three workspaces.
- **Asking for notifications** is `src/push/permission-ask.ts`, bound in
  `src/platform/notification-ask.ts`, which launch starts with the store. Never on the launch that made
  the store (`madeStore`: every launch cell but `opened`, an iOS reinstall included), never in the
  background, only while the phone can still prompt (`undetermined`; Android answers "denied" before
  any prompt, so a "denied" that can still ask on a phone the app never prompted, migration 8's
  `askPromptedAt`, counts as one), and never in a build that can't have notifications (socio-push's
  `canRegister` false: a Personal Team build). For now the triggers are a room's first message whose
  turn is still running and a room invite accepted (`askForNotifications('room-turn' | 'invite')`);
  Diagnostics has a button that asks as a room turn would. The explanation is the `NotificationAsk` sheet (no path),
  opened by `NotificationAskWatcher` in the shell's tabs: "Get told when someone mentions you, a socio
  replies in a room, or a socio sends a report.", Allow (then the system prompt) and Not now. Not now,
  or closing the sheet, is kept (migration 8) and holds every trigger for `NOT_NOW_MS` (30 days).
  Settings shows a Notifications row while they aren't on (`settingsRow`): "Turn on notifications"
  (straight to the system prompt), "Notifications are off" to the phone's Settings once denied (the
  top of Chats too), or "Notifications aren’t available in this build". A grant runs the push manager's
  check at once (`pushPermissionGranted`). The permission is read again on each return.

## Notification settings

Settings → Notifications is the `Notifications` route at `/settings/notifications` (`screens/notifications.tsx`, words and rows in
`src/shell/notification-settings.ts`), from Settings' Notifications row while a workspace is open, and
the test notification's link:

- **This phone:** the notification ask's permission row while notifications aren't on (`NotificationPermissionRow`,
  Settings' too), then "Show message text in notifications", the phone's own (`src/push/show-text.ts`,
  bound as `showText` in `src/platform/push.ts`: shown at once, kept in the registry, then
  `syncShowText`, tried twice more; a refusal goes back, and a hand-over that still fails keeps the
  change and says notifications follow it the next time Socio starts; a set a newer toggle has
  superseded stops and says nothing), and the label the workspace
  lists this phone by (its push channel's target with the registry's subscription id).
- **The workspace's** (the scope's `notificationSettings`, `src/sync/notification-settings.ts`), online
  only, never through the outbox: the channels from `GET /api/notifications/channels`, each on or off and
  what it shows (message or private), for every device on it; "Hide my presence in rooms"
  (`roomPresence`) while rooms are on; "Send a test notification" (`POST /api/notifications/test`, to every
  device and channel that's on), worded as the web words its answer (`testLine`). A change is
  `PATCH /api/preferences`, which replaces the whole map, so `mergedNotifications` builds it the web's
  way: the stored preferences (the shell's workspace row), then the listed channels, then the change; a
  channel the server didn't list keeps what was stored. Each answer (the whole preferences) goes into the
  shell's workspace row (`cache.confirm`). Refused before any request offline, away or while writes wait
  (`blocked()`: "Needs a connection"; the channels' read goes while writes wait), one request at a time
  (a change while one is in flight is `busy`; the channels' read waits for it to end, and a
  dispose wakes it with no answer and nothing sent); a change
  shows at once and goes back when refused. No quiet hours: the web has none.
- **Technical details' Push section** (Advanced mode) adds the relay registration's state, the last
  keepalive since the app started and its answer (the manager's `lastRefresh`, in memory) and the
  server's push key's first characters (`PUSH_KEY_SHOWN`).

## Notification taps and the inbox files

What a notification does once it is on the phone, `src/push/taps.ts` and `inbox.ts` under Node, bound
in `src/platform/push-taps.ts`, which launch starts after push:

- **A tap carries the workspace's id beside its web path, in-process, never as a URL:**
  iOS reads `userInfo.socio` (`{workspaceId, link, tag}`, the extension's) from expo-notifications'
  response (a remote notification's whole `userInfo` is the trigger's `payload`; `content.data` is only
  its `body`), Android socio-push's tap (`takeLaunchTap` at start and on each return to 'active',
  `followLaunchTaps`, for a tap that recreated the activity or came before the listener, which native
  holds rather than takes until JavaScript listens, socio-push's `TapRelay.kt`; then `onTap`).
  `parsePushTarget` checks it. The open workspace's tap opens the path through `externalLinks`
  (links.ts, so it waits for the gate); another ready workspace is switched to first (`switchTo`, which resolves once its scope has
  opened), then "Switched to Acme" shows over every screen (`TapNoticeLayer`, outside the workspace's
  tree in `src/app.tsx`) and the path opens; a workspace no longer on the phone opens nothing and says
  so; a tap with no target (the relay's generic text) pulls the shell. A public link never switches:
  there is no `/w/` path. The test notification's `/settings/notifications` opens the notification
  settings.
- **Once:** taps run one at a time, and one with a key (iOS's request id) is handled once per process;
  the launch response is cleared once taken (`clearLastNotificationResponse`), after T3 Code's
  notificationNavigation.ts. Android's token is taken once natively.
- **The foreground:** iOS's handler (set at import) hides a notification for the chat on screen
  (`chatOnScreen`, only `/chats/<id>`, compared without its fragment: `isOnScreen`) and shows the rest,
  never setting the badge; on Android the messaging service decides, told the chat on screen through
  `setScreen` on each screen or scope change.
- **The inbox files** (socio-push's `readInbox`) are read once launch opened the first scope, on each
  return, as another workspace's scope opens, and (iOS) as a notification comes in front. The open
  workspace's are handled and deleted (`inboxPulls`): a `tag` pulls that conversation's history (from disk
  first when memory doesn't hold it) and its steering while held, and the shell; a link of `/` the shell
  and the room invites; any other the shell. `approval:` topics are dropped for now. Another
  workspace's wait until it opens, only the newest per conversation (or per kind of link) and none older
  than `INBOX_MAX_AGE_MS` (7 days), so a workspace that never opens doesn't pile them up; a
  workspace no longer on the phone, and a file that doesn't parse, are deleted. `tests/push/taps.test.ts`
  and `inbox.test.ts`; Maestro's `link-cold-room.yaml` (Android).

## Presence and in-app notices

Whether the person is using the app (CB-114), since the server pushes a socio's notification only
while no tab or app of theirs is in use (`src/server/notifications/presence.ts`), under Node:

- **The header** (`src/sync/presence.ts`, the scope's `presence`): each scope is one tab (22 random
  base64url characters), and every `/api/state` pull carries `X-CB-Presence: <tab> <path>` while the app
  is `active` and was touched in the last `PRESENCE_INPUT_MS` (60 s), else `<tab> -`. The path is the
  topmost route's web path with one (`src/navigation/presence-path.ts`: `/chats/<id>` under a chat's
  sheets, `/settings`, else `/`), which the root container sets on each state change (`screenPath`).
  `/api/state` polls every `PRESENCE_POLL_MS` (5 s) in the foreground; the server counts a report 10 s.
- **Input** is any touch under `PresenceLayer` (`screens/notice-banner.tsx`, around the root stack in
  `src/app.tsx`), each screen change (the native tab bar's taps reach no view of ours) and each draft
  change (the keyboard's taps don't either).
- **Away:** going to the background, and `dispose()` (sent first, stopped with every other request), post
  `/api/notifications/away {tab}`, best effort, never queued, only after a report since the last.
- **In-app notices** (`src/sync/notices.ts`, the scope's `notices`): each new one in the `notices`
  collection shows once as a card at the top of every screen (GlassSurface), oldest first, only on a
  started scope: Open (its link through `externalLinks`) and Dismiss, one accessible element with both as
  actions, said once as it appears, gone after 15 s unless a screen reader is on. The ids shown are kept
  in `kv` (`notices.shown`); a scope with no such key counts what it holds as shown. Each is marked seen as
  it shows through the `notice-seen` outbox kind (lane `notice-seen`, a queued row takes up to 20 ids,
  safe to repeat, dropped when its newest notice is a day old or the server refuses it, never `unsent`).

## Rooms

A room's data, under Node. A room is a conversation: `/history`, `/steering` and
`/stream` serve it per reader as they serve a chat (`/transcript` only for why a run failed, below), through the same history,
steering and follow stores; what they lack is in `src/sync/rooms.ts`, `room-send.ts` and `run-failures.ts`:

- **The room's view** (`GET /api/rooms/:id`: people, socios, role, the switch) is a bounded kind
  (`room-view`, the scope's `roomViews`), kept in cache.db so a room opens offline with its header and
  current names; a 404 drops it and sends the room's message lanes to Unsent (`UNSENT_GONE`). While a
  screen shows a room (`scope.rooms.show(id)`), the view is read on open, every 10 s in the foreground,
  on each return and when its follow stream ends with a reason (`closed`); its presence
  (`GET …/presence`, `rooms.presence(id)`) every 5 s, in memory only, a 404 emptying it. `roomReadOnly`
  is shared's `readOnlyReason` over the shell's switch, the row and the view.
- **The follow streams know the person** (`me`, the workspace's `appUserId`), and
  every RUN_ERROR's `code` the streams and this device's runs see is kept by run id in cache.db's `kv`
  (`runFailures`, the newest 200). Never the server's text. `/history` carries a failed run's code as
  `failure` (CB-406), which wins. A failed run with neither (a server before CB-406, or a run this device
  didn't follow) has the room's `/transcript` read once (`readRoomFailures`, `useRoomFailures`), each
  problem's fixed text read back to its code (`turnFailureKind`) and kept here.
- **`room-message`**, lane `chat:<roomId>`: always steering (`POST …/steering {text, attachments,
  mentions}`, which starts a turn when none runs), with the private chat send's limits and its ask
  before a late send; over the length limit it is `unsent` (`too-large`). A 409 is `unsent` by its
  `code` (`archived`, `rooms_off`, …) or as `telegram` with none; 404/410 `gone`. Its check matches by
  text and files after the watermark and counts only messages whose `socioSender` is the reader. Its
  overlay is the chat message's shape, for `pendingBubbles`. `editQueuedMessage` and
  `cancelQueuedMessage` take its rows, an edit keeping only the mentions still in the text.
- **Invites:** the `room-invites` kind (`room-invites.ts`, `GET /api/rooms/invites`, no
  ETag, so `hashBody`), by room id, the scope's `roomInvites`, `inView` for Chats and Home (pulled as
  either comes into view, on a return or the network back meanwhile, every 60 s while it stays). The
  scope's `roomActions` (`room-actions.ts`) are online only, never queued: `accept` (`POST …/accept
  {disclosureVersion}`, the version the sheet showed), `decline`, and the reader's notification level
  (`GET`/`PUT …/notifications`; the GET still goes while writes wait). Each is refused before any request
  offline, away or held (`blocked()`), one request per room at a time (`busy`, an accept's `joined`
  wait included, so Decline can't follow a taken Join); a 404 or 410 is `gone`
  and reads the invites again, as does every accept and decline the server took. An accept waits until
  the chat list holds the room (`joined`: a shell pull, at most `JOIN_WAIT_MS`) so the room opens, not
  "This chat isn't here". Refusals by `code` or status only (`roomActionCopy`). The sheet calls the
  notification ask after an accept, and an inbox file linking to `/` pulls the kind (Notification taps).
- **New room** (CB-470; the owner's feedback reversed the web-only rule for making a room, the rest of
  room administration stays the web's): the scope's `roomCreate` (`room-create.ts`), online only, never
  queued: `people()` (`GET /api/rooms/people`, read as the form opens, in memory only; it still goes while
  writes wait) and `create()` (the web dialog's `POST /api/rooms {dotId, title, dotIds?, userIds?}`: the
  first socio leads, further ones start as requests a workspace admin lets in, each person gets an
  invite).
  Refused before any request offline, away or held (`blocked()`), one at a time (`busy`, the wait for
  the chat list included: `listed`, `whenListed(CONVERSATIONS)`); refusals by `code`, else status; no
  answer or a 5xx pulls the shell. The `NewRoom` page sheet (`screens/new-room.tsx`, view model and words
  `src/shell/new-room.ts`), from Chats' compose menu and Home's Rooms: Cancel, "New room", Create; the
  web dialog's line, Name, then Socios (company socios only, `roomEligibleSocio`, the default socio
  chosen as it opens, the first one "lead") and People, each a grouped section of chips (remove with
  their x) and an Add row that opens its picker as a `TallSheet` (`useRouteSheet`: `SearchField`, rows
  with a check, several at a time, Done), as Messages' new group adds people. Leaving with something
  chosen asks first (`newRoomAsks`). Create opens the room in the Chats tab in the sheet's place,
  whichever tab showed (`inOwnTabAction`: a REPLACE whose `tab` `tabPageRedirect` honors). Maestro's
  `room-create.yaml`.
- **`room-read`**, lane `room-read:<roomId>`: `POST /api/rooms/:id/read {seq}` through `markRoomRead`,
  collapsed to the newest, never backwards, safe to repeat, a refusal dropped; its overlay sets the
  room's `unread` to 0 in `useShownChats`, and the answer's count goes to cache.db's row (`handOff`).

## Session states

Expired, Ended and the lease, under Node except the bindings:

- **Expired** is read from the open scope's jar (`src/sync/session.ts`, `scope.session`): the
  session's stored expiry has passed by the server's clock. The watch reads the jar after every answer
  and when the expiry comes, so it shows on time offline. Everything stays readable and sync keeps
  running (a jar whose clock was wrong puts itself right). `writeHold` says why writes wait: 'sign-in'
  while Expired, 'update' while the minimum-version gate is closed; the outbox reads it.
- **Ended** is a 401 before the stored expiry (authedFetch's classifier), or a `session_ended` answer: the
  scope stops its scheduler and keeps `endedAt` in the registry (`setEnded`, the first time stays), then
  the app reads the root gate again (`src/platform/active-scope.ts`), which locks the copy and closes the
  scope. `device_revoked` and `deactivated` lock the same way, then `copyRevoked` has
  `src/platform/session.ts` wipe it in silence (`src/data/revoked.ts`'s `createRevokedWipes`: one per
  workspace, after any lease pass, the scope held; `wipeRevoked` reads the row again and wipes only one
  still ready and locked, so a sign-in meanwhile wins; memory caches; the most recently used workspace
  left opens). Scope holds are counted per workspace (`src/sync/scope-holds.ts`): `releaseScope(id)`.
- **The lease** (`src/data/lease.ts`, `enforceLeases`): the manifest's `leaseDays` and `wipeDays` when
  the registry has them (at most a year; at least 1 lease day and 7 wipe days, `MIN_WIPE_DAYS`,
  the app's guard against a policy erasing an outbox's unsent work cheaply, open to the owner's
  decision), else 30 and 30: 30 days after the last contact (else
  `createdAt`) the copy locks, with `leaseLockedAt` put at that 30th day; 30 days later it is wiped
  ('lease'), and the most recently used workspace left opens. An Ended copy keeps counting. It runs at
  launch before the gate reads the registry (so a lock comes first at cold start) and on each return to
  the foreground (`src/platform/session.ts`): locks first, then the gate, then each wipe with the scope
  held. The device clock decides.
- **Signing in again** (the Expired banner's and the lock screen's Sign in, `signInAgain`) opens Add
  workspace over the gate with SignIn for that workspace on top (`takeSignInAgain`; the mascot, no
  methods). The same person's commit makes it active with `setActive(id, { signedIn: true })`, which
  clears the lock and counts as contact in one transaction; a rollback puts that state back
  (`restoreSession`). No registry migration: the columns were in migration 1.
- **The screens:** `StatusBanners` (`screens/shell-parts.tsx`) over each tab: Expired with Sign in, the
  update banner, then "Reconnecting…" unless Expired. The lock screen (`screens/lock.tsx`) says "Sign in
  to see <workspace>" (`src/shell/session.ts`: the name, else the host), the lease's "Sign in by <date>
  or this phone’s copy is erased", then Sign in, the switcher and Add a workspace.

## Outbox

The outbox's core is `src/sync/outbox.ts` on user.db's `outbox`, under Node
(`tests/sync/outbox.test.ts`, `outbox-scope.test.ts`). Its rules are T3 Code's thread-outbox-manager,
ported (no Effect), its test's cases as specs:

- **Publish, then persist:** `enqueue` shows the row at once (the scope's `pending` follows `subscribe`),
  then inserts it in one transaction that may carry the caller's statements (the composer's draft); a
  failed write takes the row back out by reference. Every change to the table goes through one queue, and
  a row is sent only after its commit and a check that it is still the row queued: the fetch is never
  called before the commit.
- **Revisions and tombstones:** `update` and `remove` compare-and-set against `revisionOf`; a removal
  keeps its revision, so a stale writer never matches the id enqueued again. Rows in flight or unknown
  can't be edited.
- **Lanes:** one request in flight per lane, lanes in parallel, oldest first; a head that is held,
  unconfirmed, undecodable or waiting on its `dependsOn` row holds its lane. Back-off 1 s to 60 s with
  jitter, no limit, on the timers' clock. The network back or changed `wake()`s it: a plain back-off ends
  at once, a 429's window or a kind's own `delayMs` holds; the foreground only pokes.
- **States:** `queued`, `inflight` (written before the request), `unknown`, `held` (waiting on the person:
  `sendNow`). Rows in flight become `unknown` when the outbox opens, and on `dispose()` (a switch,
  `holdScope`) or `interrupt()` (iOS's grace expiry), on disk before their requests stop. An unknown row
  of a kind that is safe to repeat goes again; another kind's goes through its `check`, and with
  none, or one that can't tell, waits for the person.
- **A 401** holds every lane (`status().heldForSignIn`) until `resume()` or the next scope. Rows this build
  can't decode, and every row of a read-only user.db, are kept, never sent ("Update Socio to send these").
- **Kinds** (`OutboxKind`: decode, `send` returning an outcome, `check`, `creates`, `overlay`) come from
  the features, given to the scope as `outboxKinds`; each request goes through `context.fetch`, the scope's
  authedFetch with the row's own signal (`AuthedRequestInit.signal`).
- **Order** is `createdAt`, never below the last one given, so a clock stepped back can't reorder a lane.
  Only `interrupt({ pause: true })` (iOS's grace expiry, below) pauses the drain, until `unpause()`; no
  poke, write or back-off ends it. A server error that made a row unknown (an answer, not a request that broke off) waits for
  the back-off before it goes again.
- **Local ids and dependencies:** a create's `done` (or a check's `sent`) carries `serverId`,
  written to user.db's `ids` under its kind's `creates` in the transaction that settles it; payloads keep
  local ids, resolved as the row is sent (`context.resolve`). A `dependsOn` row waits, across lanes, until
  its parent has settled and wasn't refused.
- **Refusals:** an `unsent` outcome moves the row to user.db's `unsent` in one transaction. Its
  `payload` is an envelope (`encodeUnsent`: lane, dependency, the payload), since the table has no such
  columns; one a newer build wrote is kept, never sent from here. It holds its lane and dependents, shown
  with held and unconfirmed rows as groups (`holds()`), until `editUnsent`, `retryUnsent` (in its place,
  a fresh key) or `discardUnsent`. An `unsent` outcome (and a `rewrite`'s `exhausted`, past the cap) may
  name another `lane` and `payload` (`UnsentAs`), and `editUnsent` may move a write's lane.
- **Lost access wins over the outbox:** a chat's history that answers 404 or 410 calls
  `onGone`, and the scope moves the chat's message lanes (`chatLanes`) to `unsent` with `UNSENT_GONE`
  (`refuseLanes`, one transaction): held, unconfirmed and queued rows alike; a `sent` row goes; a row in
  flight settles by its own answer, which finds the chat gone too.
- **The Unsent list** is the account sheet's (`screens/unsent-list.tsx`, rows from
  `src/shell/unsent.ts`): every write in `unsent`, oldest first, with what it was, its chat, why in fixed
  words (`UNSENT_REASON_COPY`, never the server's text; "You no longer have access" for `gone`) and how
  many rows it holds back (`holds()`), then Copy (what the person wrote, expo-clipboard) and Discard (asks
  first, `discardUnsent`), and Edit for a refused filing (FileIssue on it). A row's screen-reader label
  says its text as one line of at most 200 characters (`labelExcerpt`), never a page's whole body. Page
  writes say the page and its Space ("Couldn’t save “Roadmap”" on Engineering, "New page “Plans”", "Move
  “Roadmap”", ...); a save whose page is gone (410, never created, lost access) offers Save as a new page
  (`saveMineAsNewPage` through `useSaveAsNewPage`, the conflict banner's Space picker), and a conflict
  Open page, where its banner settles it. The Account sheet shows the oldest `UNSENT_SHOWN` (2: five
  pushed See all and Sign out off the screen), since it can't scroll inside (above), then "See all N
  unsent", which closes the sheet and opens the `Unsent` page (a page, its root the Screen's ScrollView)
  with every row. `useUnsent()` (`src/live`, over `src/sync/unsent-store.ts`) reads it; its count badges
  the list, Home's account button and More's Account row (`unsentBadge`). Its store, like the chat's
  `outboxStateStore`, hears nothing while no screen subscribes, so each subscription compares the
  snapshot it handed out with the outbox and tells its listener when they differ.
- **Answers** are `outbox-answers.ts`: `readAnswer` (status, JSON `code`, `Retry-After` on the
  server's clock), `classify` (the kind's own rules first, then retry, back-off, the already-applied rule,
  unknown for a plain 5xx, unsent), and `outcomeOf`, where merge, relocate and re-upload are the kind's
  work (a `rewrite`) or `unsent`. Never match the server's text. A `rewrite` carries a fresh idempotency
  key (the old key's outcome was the refusal); the first goes at once, the next after the back-off, and one
  past `OUTBOX_REWRITE_MAX` (2) sends the row to `unsent` (`rewrite-limit`). The kind sees the count so
  far (`OutboxWrite.rewrites`), so one whose rewrite shows on screen first can settle the last one itself.
- **Amends:** a `done` (or a check's `sent`) may carry `amend`, which gives the
  lane's other rows that can still change (queued or held) new payloads in the transaction that settles
  it, bumping their revisions, so an `update` read before it fails its compare-and-set.
- **The hand-off:** `done.handOff` writes cache.db before the row's delete. `awaitStored` keeps a
  message's row `sent` (holding nothing, not counted as waiting or unsent) until `caughtUp(lane, stored)`
  finds its id, the `ids` one when there is one (`threadHasCaughtUpTo`).
- **Overlays** are `outbox-overlay.ts`'s `overlaysOf`: each kind's overlay of its rows and unsent writes,
  with its state for the screen's words; an added row the store already holds isn't laid over twice.
- **Only the open workspace's outbox runs.** The scope keeps its row count in the registry, and the drawer
  and the switcher say "Waiting to send" for every other workspace that has rows.
- **iOS's background grace** (`src/sync/background-grace.ts`, bound in
  `src/platform/background-grace.ts`): socio-device holds a background task only while the open scope's
  outbox has a request in flight, and just before it runs out `interrupt({ pause: true })` marks those rows
  `unknown`, stops them and pauses the outbox: nothing is sent or checked until AppState is `active`
  again (`unpause()`), since an aborted request may still be landing on the server and a check before
  it would send the message twice. Android holds none in v1.
- **Sending in a private chat** is `chat-send.ts`'s `chat-message` kind, one lane per chat
  (`chat:<threadId>`), given to the scope as `outboxKinds: (scope) => [...]` (the histories, the steering
  snapshots and `afterWrite`). The composer builds its row with `chatMessageWrite`, which keeps a
  watermark (the newest stored seq, the queued ids, whether a turn ran). Each send pulls `/steering`, then
  `/history`, then the page review's `prepare` hook (`reviewHold`: it waits while a page review is open):
  while a turn runs it goes as steering, else as a run, which settles at RUN_STARTED so the lane goes on
  while the turn streams (`onTurn`; the follow stream's `ownRun` holds while the POST lives). Steering's
  limits: over `STEERING_MAX_CHARS` it waits for the turn and goes as a run; never more than `maxQueued`
  ahead; a 429 holds the lane; a 409 goes to `unsent`; a 400 re-uploads once with files (`reupload`), else
  `unsent`; any 2xx is the server having it, under its own id in `ids` (`MESSAGE_IDS`; a run's id is its
  own). A run's 409 `thread_running` (CB-357) is `busy`, a definite answer, never `unknown`: stored is
  sent, absent while a turn runs is rewritten in place to go as steering after the exactly-once replay
  finds it isn't the running turn's own, and a failed pull or replay, or no turn, goes again after the
  back-off. A page review's tool result answered `busy` waits for the turn (`TURN_WAIT_MS`).
  `RunFailure`'s switches end in `unhandledRunFailure`, so a new action fails the typecheck. A run's other
  5xx is the busy-thread rule: stored is sent, absent while a turn runs is rewritten in place to go as
  steering, absent with none goes again after the back-off. A run with no answer at all, or a proxy's 502,
  504 or unreadable 503 (only a `draining` 503 is a plain retry), is `unknown`, never a plain retry. A
  gone chat (404/410) goes to `unsent` before anything else, in the send, the busy-thread rule and the
  check. The check pulls both: its id stored is sent; a steering send matches by exact text and files,
  newer than its watermark and no other write's (`context.claimed`): one is sent, two the person decides;
  none while a turn runs waits (`later`), none with no turn goes again. A queued message asks first
  (held, `CHAT_WAIT.ask`) after 3 hours, across a restart, or past turns someone else's messages started;
  `sendNow` (`OutboxWrite.approved`) sends it. `followStoredChats` and the history store's `onRuns`
  settle `sent` rows (`caughtUp`). The drain's triggers (`outbox-triggers.ts`): a return to the
  foreground and the network back or changed poke it; a write's `notesForWrite` topics are pulled.
- **A new chat** is `new-chat.ts`'s `new-chat` kind and `local-ids.ts`.
  A chat made on the phone has a local id (`local-<uuid>`, `isLocalChat`) until `POST /api/conversations`
  resolves; `enqueueNewChat` sends the socio's new-chat box as the create (its row id the local id, the
  web's title: the text's first 80 characters, else the first file's name) and the first message (same
  lane `chat:<local>`, `dependsOn` the create) in one transaction with the draft's clearing
  (`outbox.enqueueAll`; `enqueueFromDraft`'s `build` may return several writes). The histories, steering
  snapshots and follow streams never read the network for a local id. A message's send and check resolve
  its chat through `ids` (`conversation`); a chat never created sends it to `unsent` (`no-chat`). The
  create: 201's `id` is the server's; 400 and 404 go to `unsent`; a readable 503 goes again; a proxy's
  page, a plain 5xx or no answer is `unknown`, and the check reads `/api/workspace` for exactly one
  private chat with that socio and title, newer than the newest chat the phone held (`newestChat`, the
  server's clock) and no other write's. The scope's `chats` (`createLocalChats`) re-keys once a create
  resolves: the chat's draft and the last screen (`Chat/<id>`) move to the server id and `subscribe`
  tells the screen to swap its route param; it repeats the moves as the scope opens, for a kill between
  the settle and them. A link naming a local id opens `chats.resolve(id)`. A local lane keeps its rows
  after the create resolves: `chatLanes` settles them against the server id's runs, and a message
  written under the server id joins that lane while it still holds a write (`chatWriteRoute`).
- **Filing an issue** is `issue-create.ts`'s `issue-create` kind. An issue filed on the phone has a
  local key (`pending-issue-<uuid>`, `isLocalIssue`, never `local-`) until `POST /api/issues` resolves;
  routes carry that key, and `CB-?` is only what a screen shows. `fileIssue` sends FileIssue's box
  (`issue:new`, its fields as JSON, `issueDraftText`) as the create (row id the local key, lane
  `issue:<local>`, `creates` `issue`), with any rows `more` adds (the issue's attachments) and the box's
  clearing in one transaction. The title is trimmed, the body goes as typed; `area`, `components`
  (CB-442) and `runId` only when set. A row with components is payload version 2
  (`issueCreateVersion`), so an older build keeps it unsent rather than file it without them; a server
  before CB-442 has a strict schema and
  answers the field with 400 (`issue-invalid`, Edit keeps them), which is why the form offers the picker
  only once the list's label map says the server has components. A
  201's detail gives the number (`ids`) and goes to `issueDetails` in the hand-off; 400, 403 and a 404 with
  `runId` go to `unsent` (`ISSUE_REFUSALS`, worded by the Unsent list, which offers Edit: `unsentIssueFields`
  and `resendIssue`, `editUnsent` then `retryUnsent`, so the rows waiting on it follow); a readable 503
  goes again; a proxy's page, a plain 5xx or no answer is `unknown`. The check reads `/api/issues` fresh,
  takes numbers above the highest the phone held (`after`, `highestIssue`), changed at or after
  `serverSince(serverAt)` and no other write's, reads their details and matches the trimmed title, the
  body, the reporter (the payload's `reporterId`, the scope's app user id) and `createdAt`, each field as
  filed (the first edit event's `fromValue`, so a triage first doesn't hide it); kind, priority and area
  break a tie. One is sent; two are unconfirmed with their numbers for View (`nextIssueCandidate` opens
  each in turn); none goes again after a request with no answer, and waits for the person after an error
  answer (the server may still be filing it). The scope's `issues` (`createLocalIssues`) re-keys the
  comment draft (`issue-comments:<local>`) and the last screen (`Issue/<local>`) and tells the screen; it
  repeats the moves as the scope opens. The overlay is an `issues` row under the local key, which
  `src/shell/issue-filing.ts` turns into `CB-?` rows at the top of Triage, newest first, in fixed words.
- **Issue comments** are `issue-comments.ts`'s three kinds, in lane `issue-comments:<issue>` (never
  `issue:<issue>`, so a refused comment never holds a field edit; issue attachments share it). A comment
  on a `CB-?` issue waits for the create (`dependsOn` the local key) in the local key's lane, and one
  written under the number joins that lane while it holds a write (`commentRoute`). `commentOnIssue`
  sends the issue's comment box (`issue-comments:<key>`) trimmed (`commentBody`: 1 to 10,000 characters,
  the server's `commentInput`) as `issue-comment` (`POST /api/issues/:n/comments`), its id a local one
  (`pending-comment-<uuid>`, `isLocalComment`) until the server's goes to `ids` (`issue-comment`). Not
  safe to repeat: its check reads the detail and takes the person's comment (`authorId`) with the same
  trimmed body, created at or after `serverSince`, not in `seen` (`seenComments` of the held detail as
  it was sent; `[]` for a `CB-?` issue) and no other write's, only if it is the only one and the write
  had a bound (with neither `serverAt` nor `seen`, even one match waits for the person: it may be an
  older identical "+1"); none goes again after no answer, and waits for the person after an error
  answer (the issue create's `answeredWithError`). `comment-edit` (`PATCH …/comments/:id`, a queued one
  folds) and `comment-delete` (`DELETE`, 404 or 410 done; it drops the comment's queued and refused
  edits) are safe to repeat. `editComment` and `deleteComment` change or remove a comment's add in place
  while it is queued, held or `unsent`, as `editQueuedMessage` does; otherwise they go after the add
  settles, by its local id resolved through `ids`. 400 is `comment-invalid`, a 403 on an edit or delete
  `comment-not-yours`, 404 and 410 `UNSENT_GONE`; an issue never filed is `no-issue`, a comment never
  sent `no-comment`. Each answer's comment goes into the held detail (`issueDetails.put`) before the row
  goes, then `afterWrite` reads it again. Overlays are `issue-comments` rows (an add by its id, an edit
  or a delete a patch, `ISSUE_COMMENT_VIEWS`) for the issue screen; the Unsent list says "Comment",
  "Edited comment" or "Delete comment" on `CB-<n>` (`CB-?` until the create resolves, `issueNumber`).
- **Editing issues and voting** are `issue-edit.ts`'s two kinds, both safe to repeat.
  `issue-update` (`PATCH /api/issues/:n`) goes in lane `issue:<issue>`, the create's, and keeps only the
  changed fields, each with its value and its base (the server's value when first changed: the held
  detail's, never the overlay's); `editIssue` folds a later edit into the queued row keeping each first
  base, drops a field changed back, and behind a row already going takes that row's value as the base.
  `components` (CB-442, admins only) is a set like labels: at most 10 valid refs (`IssueEditError`), its
  base the detail's refs (`componentsOf`: none from a server that sent none), a row with it version 2.
  Title and resolution are trimmed and checked against `issueInput`'s limits (`IssueEditError`), the body
  goes as typed. Each send reads the detail fresh first: a field already at its value is dropped, one at
  its base goes, one changed to anything else sends the row to `unsent` as `issue-conflict` ("Couldn’t
  save"), its fresh detail handed to `issueDetails`; `keepMine` re-bases on the issue the screen shows and
  sends again in place (`editUnsent`, `retryUnsent`), `keepTheirs` discards (`isIssueConflict`). Title and
  description use the same two (no line merge yet). 400 is `issue-edit-invalid`, 403
  `issue-edit-refused` (Retry, Copy and Discard), 404 and 410 `UNSENT_GONE`, a `CB-?` issue never filed
  `no-issue`. `issue-vote` (`POST`/`DELETE …/vote`) goes in lane `vote:<issue>`; `voteOnIssue` folds the
  queued row to the newest intent (vote, unvote, vote is one POST) and keeps the first `voted`/`votes` for
  the overlay's count. Both route like comments (`issueRoute`: a `CB-?` issue's lane after its create),
  hand each answer's detail to `issueDetails` (which refreshes the board's row), then `afterWrite`.
  Overlays patch the issue's `issues` row with the pending fields or `voted`/`votes`
  (`ISSUE_EDIT_VIEWS`), so a pending
  priority re-sorts the board; the Unsent list says "Issue edit", "Vote" or "Remove vote" on `CB-<n>`.
- **Issue attachments** are `issue-attachments.ts`'s `issue-attachment` kind, one outbox row per file,
  `POST /api/issues/:n/attachments` with `{name, mediaType, data, commentId?}` (`mediaType` from the
  name's extension through shared's `ATTACHMENT_EXTENSIONS`, never the picker's MIME, which the server
  would answer 415 for a `.json` or `.csv`) in the comments' lane `issue-comments:<issue>`, waiting on the
  issue's create (`dependsOn` its local key) or on the comment it belongs to (its local id, resolved
  through `ids`). `fileIssueWithFiles`, `commentWithFiles` and `attachToIssue` take the box's tray
  (`attachments.forRows`): each file's SHA-256 (`digest`, expo-crypto over the processed bytes) and
  `cleanName`'d name go in its row's payload, and each file moves to its own row (`files.outboxId`) in
  the transaction that queues the create, the comment or the files, so the attachments' `sweep` keeps it
  until that row has left `outbox` and `unsent`, however the create settles. The body is joined as
  strings around the file's base64 (`attachmentBody`, authedFetch's `jsonText`), never `JSON.stringify`
  over it. Not safe to repeat: the check reads the detail and takes the person's attachment
  (`uploaderId`) with the same `sha256`, created at or after `serverSince`, not in `seen`
  (`seenAttachments`) and no other write's, only if it is the only one (with no bound, even one waits
  for the person); none goes again after no answer, and waits after an error
  answer. 413 is `issue-attachment-too-large` (too large or the issue already has 10: one status for
  both), 415 `-type`, 400 `-invalid`, 403 `refused`, 404 and 410 `UNSENT_GONE`, a copy gone `-missing`.
  Each answer's attachment goes into the held detail, then `afterWrite`. Overlays are
  `issue-attachments` rows (`ISSUE_ATTACHMENT_VIEWS`) for the issue screen; the Unsent list says
  `File “<name>”` on `CB-<n>`.
- **Chat management writes** are `chat-manage.ts`'s five kinds, all safe to repeat, given to the scope
  through `chatManageKinds(scope)`: rename and archive (`chat-update`,
  `PATCH /api/conversations/:id`, a title of 1 to 80 characters trimmed, `chatTitle`), delete
  (`chat-delete`), reactions (`reaction`, `PUT`/`DELETE …/messages/:id/reactions/:kind`) and a queued
  message's edit and cancel (`steering-edit`, `steering-cancel`, `…/steering/:id`). Lanes:
  `conversation:<chat>`, `reaction:<chat>/<message>`, `steering:<chat>`, never the chat's message lane; a
  new chat's write waits for its create and joins the local id's lane while that holds a write. Written
  through `renameChat`, `archiveChat`, `deleteChat`, `react`, `editQueuedMessage` and
  `cancelQueuedMessage`: a rename, archive or delete first discards its lane's refused ones (a reaction,
  its message's), a rename, archive or the same reaction folds into its lane's queued row, and a
  message still queued, held or `unsent` on the phone is edited or removed there with no request; one that
  may have reached the server is changed after its send settles (`dependsOn`), under the server id
  (`ids`). A confirmed rename, archive or delete is handed to cache.db's `conversations` (`confirm`, the
  scope's `cache`); a reaction's view goes to `onReactions`, a steering answer's into the snapshot.
  The already-applied rule reads `OutboxWrite.ambiguous`, which the outbox sets for a row that was
  `unknown` or whose request went and broke off (in memory: a kill after a later retry forgets it). A
  DELETE's 404 is done; a delete's codeless 409 reads `GET …/deletion` and waits while `running` or
  `call`, else `unsent` (`blocked-<why>`); a room's coded 409 is `unsent`. An edit's 409 `delivered` is
  kept as sent after an ambiguous attempt, else `unsent` (`delivered`, the edited text kept); a cancel's
  re-reads `/steering` and the history: stored or absent from both is done, still queued or a turn
  running looks again. A cancel that took (2xx, 404/410, absent from both) also removes the message's
  own `sent` row (`done.forgetSent`), which `caughtUp` never would.
- **Memories and profile writes** are `memory-writes.ts`'s eight kinds, given to
  the scope through `memoryWriteKinds(scope)`, written through `addMemory` (or `memoryAddWrite` for a
  draft), `editMemory`, `approveMemory`, `confirmMemory`, `deleteMemory`, `saveProfile`, `clearProfile`
  and `markTimeZoneNoteSeen`. Lanes `memory:<id>`, `profile`, `memory-note`. An added memory has a local
  id (`pending-memory-<uuid>`, `isLocalMemory`; never `local-`) until `POST /api/memories` resolves
  (`ids`, `memory`); its text is trimmed, and its check reads `/api/memories` for exactly one memory of
  the person's own (`source: 'person'`, no socio) with that text, newer than the newest the phone held
  (`newestMemory`) and at or after `serverSince(serverAt)`, and no other write's. Edits (`PUT
  /memories/:id`) and profile saves keep each field's first base (the stored value, or what the
  person's own unsettled write in the lane sets it to; '' after a clear) and fold only into the lane's
  newest row, when that is a queued row of their kind; a refused one's other fields join the next; at the start of `send` they read `/api/memories` again, and a field changed there
  to something else goes to `unsent` (`conflict`), with `keepMine` (re-based on what the server holds,
  sent again) and `keepTheirs` (discarded); one already as written is done. A save sends the whole
  profile (the fresh fields with its changes on top: `profiles.save` keeps exactly what it gets); a
  time zone goes through shared's `ianaTimeZone` before it is queued. Approve, "Still true", delete and
  clear are safe to repeat, a 404 done; an edit or delete of a memory whose add hasn't gone changes or
  removes its rows on the phone. The note's mark is dropped when `/api/memories` no longer names its
  zone, or refused. Episode deletes are never queued (online only). `MEMORY_WRITE_VIEWS` and
  `shownMemories` lay them over Memories' rows; the Unsent list says "Memories" or "Your profile".
- **Schedules, goals and tasks writes** are `schedule-writes.ts`'s two kinds, given to the scope
  through `scheduleWriteKinds(scope)`. A schedule's pause, resume and cancel (`schedule-action`,
  `actOnSchedule`, `POST /schedules/:id/actions`, lane `schedule:<id>`) are safe to repeat and fold into
  the lane's newest queued row (the newest intent), except that a pause or resume never folds over a
  queued cancel; a newer one discards the lane's refused ones. A 409 (cancelled, or its socio archived;
  only the server's text tells them apart) goes to `unsent`, a 404 too, except a cancel's, which is
  done. A goal comment (`goal-comment`,
  `commentOnGoal` or `goalCommentWrite` for the `goal:<id>` draft, lane `goal:<id>`) is trimmed to 1 to
  `GOAL_COMMENT_MAX`; its check reads `/api/schedules` for exactly one of the person's comments on that
  goal with that body, newer than the newest the phone held (`newestGoalComment`) and at or after
  `serverSince(serverAt)`, and no other write's (`ids`, `goal-comment`). **Online only, never queued
  or retried:** Run now (`runScheduleNow`, `runJobNow`, `actOnTask` `run`), a task's Pause and Cancel
  (`actOnTask`: the server aborts its running turn on every action but `run`) and Stop on a running job
  (`stopJob`, a 409 done), each through `OnlineContext` (the scope's authedFetch and NetInfo's
  `connected`): offline they send nothing ("Needs a connection"), and an answer that never came is
  `no-answer`, never sent again by itself. Run now is refused before sending by `runNowBlocked`
  (`state.settings.paused`, `researchAllowed`, a cancelled schedule); `onlineActionCopy` words each
  outcome. A job's code, versions and delete, and a task's repeat interval, open the web.
  `SCHEDULE_WRITE_VIEWS` and `shownSchedules` lay the rows over Schedules; the Unsent list says
  "Schedules".
- **Saving a page** is `page-save.ts`'s `page-save` kind, safe to repeat (the PATCH is a
  compare-and-set on `expectedRevision`), lane `page:<pageId>`, one coalesced row per page, given to the
  scope through `pageSaveKind` (`OutboxKindScope.pageBodies`, `pageSaved`). Its payload is
  `{ spaceId, pageId, base: { title, content, revision }, draft: { title, content }, ownRevisions, bases }`
  (the base's text null when the phone no longer held that revision; `bases` every base revision the row
  has been on, the editor's first, each 409 rebase and `amend` adding one); it never sends `parentId`.
  `createPageSaves` is the page draft's sink and `savePage`: a draft replaces the lane's newest row in
  place while it is queued; behind a row in flight or unknown it queues one row based on that row's
  draft, whose settle `amend`s its base and `ownRevisions`; a first row takes its base from the held body
  at the editor's revision (`baseOf`). A draft equal to its base is never queued or sent and a queued row
  whose edits go back to it is removed, titles trimmed first. Edits fold into a queued `page-create`
  (below; local `local-page-<uuid>`); one gone to the server makes the save `dependsOn` it, at revision
  1, its id resolved through `ids` (`page`). Answers: 200 hands the page to the body and the Space's list
  (`confirm`) and rebases the editor on any of `bases` to the page's revision and Space (`pageSaved`, the
  draft's `rebase`, called even when the body or list write failed), so the save after a move or a
  relocation isn't a false conflict; 409 GETs the page: our draft there is done (a lost success), the
  server at our base or at one of `ownRevisions` is a `rewrite` on it (someone's move, our earlier save),
  anything else is merged (below); 404 reads `/api/pages/:id/location` and rewrites to the new Space, or
  is `UNSENT_GONE`; 410 `page-deleted`, 403 `page-refused`, 400 `page-invalid`; 401 holds, a 5xx or no
  answer goes again. Its overlay patches the `pages` row's title (`PAGE_SAVE_VIEWS`); `pendingPageText`
  gives the body screen the newest draft.
- **Merges and the conflict banner** (v1's simple version: no names) are `page-save.ts`'s 409 path,
  `page-merge.ts` and `page-conflicts.ts`. The base, the draft and theirs go through shared's
  `mergeTitledText` (`mergePageText`, titles trimmed). Clean: theirs goes to the body and the list, and
  the row is a `rewrite` with the merge on theirs (`merged`; everything of ours already there is done);
  once the row has had `OUTBOX_REWRITE_MAX` rewrites (`write.rewrites`) it is a conflict instead, decided
  before the editor or the toast hears of a merge. Not clean, or with no base text: theirs goes to the
  body and the list, and ours to `unsent` as `conflict` in lane `page-conflict:<pageId>` with theirs
  beside it (`PageConflictPayload`, one transaction), so `page:<id>` stays free and new saves go on from
  theirs; its overlay lays nothing. Either way the kind's `onLanded` (the scope's `pageLanded`) calls the
  draft's `landed` and `pageLandings` (the screens' "Merged with changes made elsewhere",
  `usePageMerged`, with "See what changed": what the save sent against the merge, `mergeChangeLines`, in
  the same `DiffSheet` as Compare's (`whatChangedSheet`, `compareSheet`: one sheet with its title, legend
  and rows, the owner's choice; no inline comparison in the banner); `PageToasts` shows on the editor,
  above its toolbar, and on the reader only while it is focused, so a merge under the open editor is
  seen there). A queued save behind a merged one is merged again onto the answer as its base moves
  (`amend`), or, not clean, keeps its old base so its own 409 ends at the banner. `pageConflicts` lists a
  page's (oldest first, `usePageConflicts`); `takeMine` (Use mine: ours re-based on the body the phone
  holds, with edits made since merged on top, moved back to `page:<id>` and retried, the editor `landed`
  onto it; when those edits don't merge clean, ours stays on theirs as kept, so the server's 409 brings
  the banner back with the page as it is now), `keepTheirs` (discard), `saveMineAsNewPage` (`createPage`,
  below, in the chosen Space, then discard; once per conflict, null when it is gone) and
  `compareConflict` (shared's `lineChanges`). The Page screen draws the banner
  (`screens/page-conflict.tsx`, words in `src/shell/page-conflict.ts`): Compare, Keep theirs and Use mine
  (each asks first), Save mine as a new page (a Space picker, the page's own first); one action at a
  time, the others disabled while it goes.
  `tests/sync/page-conflicts.test.ts` runs two phones against one fake server and a no-loss fuzz test.
- **Creating, moving and deleting pages; covers** are `page-manage.ts`'s four kinds, given to the scope
  through `pageManageKinds` (`OutboxKindScope.pageMoved`, the pages store's `noteMoved`, `pullPages` and
  `holdsRow`).
  Every page write routes through `pageRoute` (`page-save.ts`, page saves too): a page made on the
  phone keeps its local lane while that holds a write, so writes under the server id join it, and a
  write to a page whose create hasn't resolved `dependsOn` it. `createPage` queues `page-create`
  (`POST /api/spaces/:id/pages`; row id and lane the local id `local-page-<uuid>`, `creates` `page`,
  "Untitled page" for a blank title, a child `dependsOn` its parent's create and sends its server id).
  Not safe to repeat: its check pulls the Space's list fresh and takes the person's page with the same
  trimmed title and parent, created at or after `serverSince(serverAt)`, absent from the ids the phone
  held (`known`) and no other write's, then reads each candidate's body for the same content. One is
  sent; two are unconfirmed with their ids; with no bound even one waits for the person; none goes again
  after no answer, and waits after an error answer. 400 `page-invalid`, 403 `page-refused`, 404
  `UNSENT_GONE`, 410 `page-parent-deleted`. `movePage` (`page-move`, `POST …/move`, behind the page's
  saves, safe to repeat, no `expectedRevision`): under a parent made on the phone it retries
  (`waiting-parent`) while the parent's create row is in the outbox (`holdsRow`), `no-parent-page` once
  that row is gone or refused; 409 goes again; 404 or 400 read the location (in the
  target is done, elsewhere a `rewrite` from there, gone `UNSENT_GONE`, still where it was
  `page-move-target` or `page-invalid`). Its answer drops the moved pages from the old Space's list, puts
  the page and its body in the new one, re-keys the last screen (`noteMoved`), rebases an editor on the
  revision before it only when the body held before the move has the answer's text (the move rewrites
  image fences to copies; otherwise the editor's next save meets a 409 and the page save's conflict
  path), and `amend`s the lane's queued saves (`movedSave`: the new Space, and the move's revision as
  base and own when their base is the text it moved). `deletePage` (`page-delete`) pulls the
  Space's list first: a subpage the confirm didn't name is `page-new-subpages` ("This page has new
  subpages"); `?subpages=true` only when the confirm named some; 410 and a 404 with no location are done,
  403 `page-delete-refused`, 409 `page-has-subpages`. A page made on the phone whose create is still
  `queued` is dropped instead, with its own lanes' writes (a cover's upload forgotten) and its editor draft
  (`page:<local>`), and `deletePage` gives null; not when another page's write waits on it (a subpage)
  or the create went. Covers go in lane `cover:<id>` (`setPageCover` after the Files upload's `prepare`
  and `resolve`, `PUT …/cover { fileId }`, then `forget`; `removePageCover`; `restorePageCover`, the Undo
  toast's `{ embedId: previous }`; each takes the scope's `uploads`): a newer change folds into a queued
  one (a replaced upload is `forget`-ed), an Undo of a removal still queued takes it out; 413
  `cover-too-large`, 415 `cover-type`, a 404 where the page still is `cover-gone`. `PAGE_MANAGE_VIEWS`
  lays them over the `pages` rows (an inserted summary, `{ spaceId, parentId }`,
  `{ pendingDelete: true }`, `{ cover }` or `{ coverUpload }`). The scope's `newPages`
  (`createLocalPages`) re-keys the editor draft (`page:<local>`) and the last screen
  once a create resolves, tells the screen (`subscribe`), and repeats the moves as the scope opens.
- **Exactly once.** A run's check, and the busy-thread rule before it moves a
  row to steering, ask shared's `recoverTurn` through `turn-recovery.ts`'s `recoverRun`: `connect`
  replays the runs after the newest one held and stops at the first run's start; the row's id in a
  run's input (RUN_STARTED's `input.messages`), or in the history (`stored(id)`), is sent, even while
  its turn streams. Where `recoverTurn` would send again it answers `absent`, and the outbox sends from
  the lane; `gaveUp` (stopped, or past `limit`) leaves the row `unknown`. After a restart an `unknown`
  row starts there. The watermarks of a message and a new chat keep `serverAt`, the newest Date header
  the scope's answers carried (`scope.serverClock`, `server-clock.ts`, in memory): a candidate is what
  the server stored at or after it less `SERVER_CLOCK_SLACK_MS` (`serverSince`; the Date may be a
  proxy's, ahead of the app server's, and a bound too early only adds candidates), by its own clock (a queued message's `createdAt`, a run's
  `finishedAt`, a chat's `createdAt`), so the device clock plays no part. Exactly one candidate after a
  fresh pull is the write (a row a restart forgot included); two are `unconfirmed` ("Couldn’t confirm
  this was sent"), and the hold keeps their server ids for View (`HoldGroup.root.candidates`) beside
  Send again (`sendNow`). The composer passes `serverClock.lastDate()` as `serverAt` to
  `chatMessageWrite` and `enqueueNewChat`; rows without it keep the private chat send's and the new
  chat's rules. On a device, `perf/kill-send.mjs` kills or locks the app 0 to 2 s after each Send and
  counts every message's stored copies and runs: exactly once, and no `queued`, `inflight`, `unknown` or
  `held` row or refused write left, read from Diagnostics' Outbox line (every row; the screen shows only
  the last bubbles) (README). `perf/kill-file.mjs` does the same for filing: an issue with one photo,
  killed 0 to 2 s after File, every other round offline, then one issue with one attachment per title
  on the server, no kept draft that came back without its photo (never re-attached: that is a lost
  file) and no row left but
  `sent`; the issue chaos flows (`chaos-issues-*.yaml`, with `act-as.mjs web-*` between them)
  cover Clear cache offline, a 401 before and after expiry, a deleted issue and Keep mine or theirs.

## Drafts

The composers' drafts are `src/sync/chat-drafts.ts` on user.db's `drafts`, the
scope's `drafts`, under Node (`tests/sync/chat-drafts.test.ts`). The rules are the web's chat-drafts.ts:

- **Scopes:** `chatDraft(id)`, `newChatDraft(dotId)` and `reviewDraft(threadId, toolCallId)` (an edited
  page review, the page editor's JSON as the text: `reviewDrafts`, Chat screen's Page reviews). At most
  `DRAFTS_KEPT` (50), the oldest dropped; `sending` up to `SENDS_KEPT` (5), kept for a send outside the
  outbox (none yet). Memories' Add box is `NEW_MEMORY_DRAFT` (`memory:new`), a goal's comment box
  `goalDraft(id)` (`goal:<id>`, sent as `goalCommentWrite`). `review:` and `page:` drafts are exempt from
  the bound (`unboundedDraft`): they neither count nor go.
- **Memory first:** read as the scope opens, each change shown at once (`subscribe`), then written
  through one queue, coalesced. The scope's `dispose()` closes the drafts before the outbox, so what was
  typed is written and a send already begun commits.
- **A send is `enqueueFromDraft(scope, build)`:** it sends what the box holds when its turn in the queue
  comes, clearing the draft in the outbox insert's transaction, so the text is never in
  both places nor in neither. The box clears after the commit and keeps anything typed meanwhile
  (`afterSend`); a failed insert leaves it as it was. The web's `sending` restore isn't used for outbox
  writes.
- **`rekey(from, to)`** moves a draft (a new chat's `new:<dotId>` to `chat:<local>` after the send, then
  `chat:<local>` to `chat:<server>`), joined after what `to` holds, in one write; `scopes()` lists them.
  A move from a scope with a send in the queue waits for that send, so the sent text never moves.
- **`payloadVersion`:** a newer build's draft is shown and never changed, sent or dropped (`DraftError`,
  "Update Socio to send these"); a `sending` entry this build can't read is dropped, as the web drops it,
  and never locks a draft of its own version. A read-only user.db keeps changes in memory only.
- **`close()`** refuses changes at once, but a send queued before it still commits, and what is dirty is
  written once more before it resolves.
- **The page editor's draft** is `src/sync/page-drafts.ts`, the scope's `pageDrafts`
  (`tests/sync/page-drafts.test.ts`): `open(pageId, start)` keeps the editor's latest text in memory and
  writes it at most every `PAGE_DRAFT_WRITE_MS` (1.5 s, the first change at once) to `drafts` scope
  `page:<pageId>` (`pageDraft`), as JSON with the Space and the base revision (`EditorDraft`,
  `parseEditorDraft`; `stored(pageId)` reads it back after a kill or a dead WebView). Offline (NetInfo
  says no network), a valid draft goes into the page's queued row in place instead (the page save's
  `PageDraftSink.updateQueued`) and the editor draft is cleared; with no row that can change, or when
  `updateQueued` rejects, it is written here. A write that failed (not a `DraftError`) is written again
  by the next change, flush or close. `AUTOSAVE_DEBOUNCE_MS` (800 ms) after the last change a valid draft
  is written and, when it went to `drafts` (not into the queued row), the sink's `save` queues it
  (`enqueueFromDraft`). An invalid draft (`pageDraftError`) stays here with `error()`'s words and never
  reaches the sink. `flush()` writes at once (Android Back); `close()` (leaving the editor) also saves a
  debounce still pending, so a `page:` draft is never stranded; the scope flushes every open editor on
  going to the background and the network going, and `dispose()` closes them (saving the same way)
  before the drafts. The scope's sink is `createPageSaves` (Outbox, "Saving a page"); after each save
  its `rebase(pageId, from, to)` moves an open editor on one of the revisions `from`, and the stored
  draft on one, to the server's revision and Space. After a 409 `landed(pageId, from, sent, to)` moves
  them onto the merge or theirs: a draft still holding `sent` takes `to`, one edited since takes it with
  its edits merged on top, one whose edits don't merge stays (its save then meets the banner). An editor
  whose text changed tells `onReplace`, which the editor screen wires to the editor bridge's `replace`. A
  kill at random points of two minutes of typing loses at most 2 s (the test).

## Attachments

Picked files and their uploads are `src/sync/attachments.ts` on user.db's `files` (migration 2:
`name`, `state`, `serverId`, `uploadedAt`, `draftScope`, `outboxId`, `error`, `createdAt`), the scope's
`attachments`, under Node (`tests/sync/attachments.test.ts`):

- **Copied, committed, then the picker's file goes:** the injected image processor (below), then
  `prepareAttachmentsFolder` and a copy into `attachments/`, the row, and only then the temporary files.
  A copy no row names (a kill before the commit) is deleted at the next open. The platform binds the copy
  and the upload body (`src/platform/attachment-files.ts`, expo-file-system's File, a Blob).
- **Uploaded at once** through authedFetch (`purpose=attachment`, `threadId` only for a chat the server
  has; `serverThread` says), `uploading` → `ready` (a `cbatt_` id, checked) or `failed` (413 `too-large`,
  415 `type`, other refusals, a bad answer). No answer, a 5xx, 429 or 401 stay `uploading` until the next
  `pump()` (the scope's start, the row's turn). Limits from `/api/media/limits`, 10 per tray.
- **Messages go by reference:** `enqueueWithAttachments` moves the tray's files to the outbox row in the
  draft's transaction (`enqueueFromDraft`'s `also`); the payload names them by local id, `resolve` gives
  the server's refs as the row is sent, and `prepare(rowId)` holds the row while they upload, uploads
  again one older than 23 h (`REUPLOAD_AFTER_MS`), and sends it to `unsent` when one failed for good
  or the payload names a local id with no file. An upload's answer writes only the upload columns, never
  where the file sits, and `rekey` moves only files still in a tray; until the send commits or fails
  (`committed`, `released`), its files can't be discarded, re-keyed or taken by another send.
  `reuploadHook` is the re-upload once after a 400. The private chat's kind takes the scope's `attachments`
  (`OutboxKindScope`) and does all three; the scope opens them before the outbox. A new chat's files
  go with its first message (`enqueueNewChat`'s `files`), upload pending until its create resolves, and
  its tray follows the draft to the server id (`rekey`). A row's files go once it has left `outbox` and
  `unsent` (`sweep`, on the outbox's removes). Discard deletes the server's pending upload (best effort),
  the copy and the row.
- **Picking and showing** (`src/chat/attachment-tray.ts` under Node, drawn by
  `screens/attachments.tsx`): the composer's "+" opens three choices in their tones over the box, the
  system photo picker (no library permission), the camera (its purpose string only) and the document
  picker (`src/platform/pickers.ts`); the tray is T3 Code's strip, 72 pt tiles with an indeterminate bar,
  Retry and remove (a failed tile's cover retries, or removes a file gone from the phone: `failedTileAction`). Every picker's file is its own temporary copy, deleted once ours is durable, and
  `clearPickerCache` then deletes the pickers' and expo-image-manipulator's cache folders. The image
  processor (`src/sync/image-processing.ts`, bound in `src/platform/image-processor.ts` as
  `attachments.processImage`) turns HEIC and other types a model can't read into JPEG and scales an
  image over 10 MB down; the model's types under it go as picked. The scope pumps uploads before the
  outbox when the network comes back. Both composers send the tray with the box (`sendChatMessage`'s
  `attachments`, `enqueueNewChat`'s `files`); a box with files and no text sends. A row waiting for
  its uploads says "Uploading files…".
- **Pasted images** (CB-358): the composer's box is wrapped in expo-paste-input's
  `TextInputWrapper`, which reads the pasteboard only inside the system's Paste (no "Allow Paste" alert on
  iOS) and hands over `file://` URIs alone. `pasteImages` (`attachment-tray.ts`) names, types and measures
  them through `pickedImages` (`pasted-<time>`) and adds them like picked photos, up to the tray's limit,
  then deletes every pasted file (`removePasted`: `clearPickerCache` doesn't reach the module's folders).
  Android re-encodes a pasted image as JPEG at quality 80 (PNG with alpha; GIF as is), and takes a
  keyboard's image (Gboard's clipboard) only on API 31 and later; the edit menu's Paste works on all.
  Pasted text is untouched. The page editor's paste is its own (The page editor's screen, below).
- **Pictures in a chat** come only by reference, through the app's own image cache
  (`src/sync/image-cache.ts`, bound per scope in `src/platform/image-cache.ts`): authedFetch into
  `images/` (iOS `complete`), keyed by attachment id and version (a page's cover by its media embed id,
  kind `embed`, `useEmbedPicture`), written as `<name>.part` and renamed
  once whole (a kill mid-write leaves a part file the next launch deletes), 500 MB with the oldest dropped first,
  shown as `file://` with expo-image's `cachePolicy: 'memory'`; only PNG, JPEG, GIF and WebP answers
  are kept. A pending bubble shows its row's copies. Other files are chips (CB-413, the web's FileChip:
  the size from `GET /api/media/attachments/:id`, asked once per scope, "Removed" on a 404; a tap
  downloads `…/content?download=1` through `useOpenLink`, so in the browser; `chat/attachment-info.ts`). A picture opens the
  `AttachmentViewer` route (immersive, no path). Maestro's `attach-photo.yaml` picks a seeded photo and
  sends it.
- **Issue files never upload to media:** a file picked into an issue's box (`issue:new`,
  `issue-comments:<key>`, `isIssueFileScope`) goes through the issue processor (`ISSUE_IMAGE_PROFILE`,
  bound as `attachments.processIssueImage`: the model's types under 5 MiB as picked, HEIC and larger
  ones a JPEG under it, a GIF never scaled), then shared's `acceptFiles` (with `add`'s `existing`, the
  issue's files already there), which refuses at pick time, in its own words (`AddProblem.message`), a
  GIF over 5 MiB, an unconverted HEIC, a type the server won't take and an eleventh file. It asks
  nothing of `/api/media`: kept `ready` with no server id, skipped by `upload` (the add path and
  `pump()` alike) by its tray or lane, and sent as its own outbox row's body (above). A filed issue's
  comment tray follows its number (`scope.ts`, with the issue create's re-keying). No migration.
- **Uploads to the person's Files** are `src/sync/upload-file.ts`, the scope's `uploads` (also
  `OutboxKindScope.uploads`), under Node (`tests/sync/upload-file.test.ts`): a page's cover and, later,
  a pasted image go up as `purpose=file`, which answers `{ item }`, a file kept in the person's Files,
  never an attachment. They share the attachments' copy-then-commit (`prepareAttachmentsFolder`, a copy
  in `attachments/`, a `files` row) under the lane `upload:<id>` (`FILE_UPLOAD_LANE`), which attachments
  never read, upload, discard or sweep, though their open still counts those copies as named; no
  migration. An older build would take such a row for an attachment (a pending upload the server drops
  in 24 h). The page image profile runs first (`PAGE_IMAGE_PROFILE`, bound as
  `attachments.processPageImage`: a cover's PNG, JPEG or WebP under `COVER_MAX_BYTES` as picked,
  anything else a JPEG under it), then
  `pageImageProblem` refuses what still isn't one before any row is written (`FILE_UPLOAD_COPY`'s
  words). Each upload has a unique name (`cover-<localId>.jpg`, `image-<localId>.webp`); its row is
  written `unknown` before the POST, and no answer, a 5xx or a kill leaves it so: the next `pump()`
  lists `GET /api/media?q=<name>` and takes exactly that name as uploaded, else uploads again, and
  waits while the listing can't say. 401, 408 and 429 upload again with no listing; 413 and 415 fail
  `too-large` and `type`. A write names the upload by local id: `prepare` holds it while it uploads
  and refuses it (`upload-failed`, `upload-missing`), `resolve` gives the file's id, `forget` drops the
  row and the copy once the write settled (the file stays in Files). `takeSavedNote()` gives "Saved to
  your Files" once per workspace (cache.db's view state, so Clear cache shows it again).

## Shell screens

Home, Chats, Spaces and the Account sheet, the Board, Inbox and More, and Search: Home, Chats, Spaces
(CB-459), More and Search are the native tabs (the Inbox is the top of Chats since CB-455); the Board
and More's pages (none left a placeholder: every More row has its screen) push inside the tabs, and the
Account sheet is a root stack route over them:

- **Their view models are `src/shell/`,** with no React Native: the live queries the screens run
  (`queries.ts`, each a whole collection) and the functions that order and shape the rows
  (`chat-list.ts`, `home.ts`, `spaces.ts`, `account.ts`, `search.ts`, `workspaces.ts`). `tests/shell/` runs the same queries on
  collections seeded from the fake server. The chat list follows the web: no archived chat, rooms only
  while they're on, `createdAt` DESC, a room's unread capped at `ROOM_UNREAD_CAP`; a socio is Paused
  while the workspace is, Working while one of its tasks runs (the web's `dotState`).
- **The chat list's marks** (`src/shell/chat-marks.ts`, drawn by `screens/chat-rows.tsx` on the
  Chats tab and Home's Rooms and Recent chats): "Needs your approval" (the Approvals amber, as the top of Chats),
  "Working" while one of its runs is `running`, and when it was last active (`listTime`: "Now", "5m",
  "3h", "Yesterday", "Mon", "Nov 4"), from the `runs` and `approvals` kinds, which both screens keep pulled
  (`CHAT_MARK_KINDS`). A request marks the chat it names (`threadId`; `null`, no chat
  asked, marks none); from a server older than that (no field) it marks the chat with that socio whose run
  was going when it was asked, and one asked outside the latest 200 runs marks none. A room is drawn as a room: the web's speech bubbles on the Chat tone and "Room", with
  "Admin" where the web shows the role. Every mark and the time are in the row's label.
- **The module table** (`src/shell/modules.ts`) is the web's modules' title, member title, nav label,
  icon and tone; `tests/shell/module-table.test.ts` reads each `packages/client/src/modules/*/module.ts*`
  as text and fails on any drift, or on an icon lucide-react-native lacks. A module's icon is mapped to
  the app's symbol of that name in `src/screens/module-icons.ts` (its SF Symbol on iOS).
- **Each screen keeps itself as the workspace's last screen** (`useRememberScreen`, the scope's `kv`; a
  private chat too; a page as `Page/<spaceId>/<pageId>`, `pageScreen`; a Space's library as
  `Space/<spaceId>`, `spaceScreen`; an issue as `Issue/<key>`, `issueScreen`), and Home opens the kept
  one over itself once per scope (`last-screen.ts`). They draw "Reconnecting…" while the server is away
  (with the session banners, `StatusBanners`), and a placeholder when no scope is open (no workspace, or
  one that didn't open).
- **The first run** (`src/shell/first-run.ts`): once both shell rows have come and the chat
  list is empty, Home is New chat with the default socio (the picked one, else the oldest not
  archived), a socio picker at the top, the privacy line and the composer, which sends the
  socio's new-chat box as a new chat (`enqueueNewChat`) and opens it under its local id; the screen is in
  keyboard-controller's `KeyboardAvoidingView` (`automaticOffset`), so the composer rides above the keyboard; the
  keyboard is dismissed before the new chat opens (pushed with it up, iOS left the chat's composer where it had been). No model is the web's `NO_INFERENCE_MESSAGES`, from the workspace row's `setup.inference`
  (`State.configured` is research's). Home calls `useFirstRun()` and draws `<FirstRun>` while its view
  isn't null (`src/screens/first-run.tsx`), with its workspace and account buttons and its tiles.
- **New chat at any time** (ChatGPT's and T3 Code's): the `NewChat` route at
  the web's `/dots/:socioId/new` (`screens/new-chat.tsx`, `newChatAction`) is the first run's screen
  (`newChatView`, with no condition on the chat list; the picker opens on the socio asked for), and the new
  chat replaces it (`StackActions.replace`), so Back goes where it was opened. The Chats tab has Compose in
  its bar (`square.and.pencil` on iOS, a Material top app bar action on Android; CB-431 took Home's teal
  pill away, and Home has no Compose), each socio row a new-chat button beside it ("New chat with Sebas":
  `SymbolButton`, `screens/platform-symbol.tsx`, a 26 pt SF Symbol in a 44 pt target on iOS, a 48 dp
  Material icon button on Android); Chats' opens on the default socio (`defaultSocioId`). While rooms are
  on, Chats' Compose is a native menu (`composeMenu`, `src/shell/new-room.ts`; a `BarMenu`): New chat and
  New room (CB-470).
- **A socio's page** (CB-431; the web's DotHome) is the `Socio` route at `/dots/:socioId`
  (`screens/socio.tsx`, view model `src/shell/socio.ts`), opened by the rest of a socio row on Home: its
  avatar, name, state in the system font with what it is doing, and description, then an inset grouped
  list with disclosure chevrons: Start a chat, Now (its tasks and turns running), Chats and Archived
  chats (three, then Show all), Scheduled (its goals and schedules with their next runs, All schedules)
  and Recent turns (All runs). The turns are the web's own `GET /api/dots/:id/runs`, read online as the
  page comes into view and never kept (`src/sync/socio-runs.ts`); the rest is what the phone holds.
- **Starter prompts** (CB-359): the web's three new-chat starters (`STARTERS`, the `starters` of
  packages/client's ChatViews.tsx, which tests/shell/first-run.test.ts reads) in a short list of outlined
  cards (the web's outline buttons: a border, no fill, small muted words) just above the composer, as the
  web lays them out on a phone. A tap fills the socio's new-chat box with the
  starter (`fillStarter`, the web's `setPrompt`), never sends; they're off while there's no model and hidden
  while the keyboard is up (the web's `keyboard:hidden`).
- **Home** (Slack's; `screens/home.tsx`, `home-parts.tsx`): the workspace button (logo and
  name, opens the drawer), the ⋯ menu (`homeMenu`: Report issue, and for admins Pause or Resume all socios,
  the web's `PATCH /api/settings`, online, Pause asking first) and the account button, a sideways row of tiles (`homeTiles`: the Board, the
  Spaces, Scheduled and Memories, with counts where the scope has the data; Scheduled counts every
  `state.tasks`, as the web's Home, in its words ("1 scheduled task"); the Board's open issues,
  Memories' proposals waiting, `waitingProposals`),
  then the collapsible sections (`homeSections`: Socios, Rooms while they're on, Recent chats up to
  `RECENT_LIMIT`). The room invites show above Rooms, and Rooms ends with New room, which opens
  the app's own New room (CB-470, below; no longer the web).
- **Search** (`src/shell/search.ts`) opens as the web's palette: Actions (New chat with the default
  socio, Add memory, which opens Memories with its Add sheet up (`addMemoryAction`, Memories' `add` param), and File an issue), Go to (the modules), then the socios and the
  recent chats and rooms (the chat list's rows, `ChatListRow`, a room as a room), in `SearchField` (no label). Once the person types, every row
  is ranked by the web palette's ranking (shared's `searchCommands`: an exact key or name first, at
  most `PALETTE_GROUP_LIMIT` per section, sections by their best row): the socios, the whole chat list, the
  Spaces, the issues by key, title and status (the `issues` kind; each opens its screen,
  `issueAction`) and the modules; `pages` is the hook for page titles held on the phone (not fed yet).
  From two characters (`PAGE_SEARCH_MIN_CHARS`) `src/sync/server-search.ts` asks `/api/spaces/search` and
  `/api/issues/search` together, 250 ms after the last keystroke, each keystroke aborting the last, the
  last 20 answers kept; their matches follow the local rows as the web's `mergeSearchResults` adds them
  (the issues the phone holds, pages in Spaces it lists, opening the page reader with `pageAction`).
  Offline
  (`reconnecting`, or no answer) it asks nothing and the local rows show with "Searching page text needs a
  connection". It isn't kept as the last screen.
- **A Space's library** is the `Space` route at `/spaces/:spaceId`
  (`screens/space.tsx`, view models `src/shell/space-library.ts`), pushed from the Spaces' rows, Search and
  links (`spaceAction`), read-only. Its pages come from `useSpacePages` (`src/live`: the Space's collection,
  `view()` while focused, so its pull and 15 s poll); a cold start onto it reads them before the first
  frame (`preloadKeptSpace`), Home opens it over itself (`restoreSpaceAction`) and it marks the first frame
  (`useFirstFrameWithData('Space', …)`). Recent is the web's "Recently edited" (newest change, then title;
  the excerpt or "An empty page, ready to write."; "Edited Nov 8" and the parents' trail; the cover as a
  44 pt squircle through the image cache, else the page tile in the Spaces tone). All pages is shared's
  `pageHierarchy` as a tree (`pageTree`): top level and siblings by title, a page whose parent the phone
  lacks at the top, and any page a cycle would hide too, so none is lost; a parent's row says its
  subpages, exposes `accessibilityState.expanded` and an expand or collapse action, and its chevron is
  hidden from screen readers. Its heading is the web's: the Space's name as the big title beside the
  Spaces-tone folder tile as the bar's large title (`useNativeBar`, CB-420), "Private" and the
  description under it (`PageIntro`); the bar holds New page and `KeepOfflineToggle`. On Pages, "Search
  pages" (the bar's search field on iOS, `SearchField` on Android) filters the pages the
  phone holds by title and excerpt (`librarySearch`, `pageMatches`, folded as the palette folds) and, from
  two characters online, adds the server's matches in the Space's page text the phone's missed ("In page
  text"; `createServerSearch({ space })`, `/api/spaces/search?space=`, never the issues); offline it says
  "Searching page text needs a connection". A row opens the
  page in the reader (`pageAction`), its body read from disk first (`preload`). A Space the person lost (the workspace has answered,
  `useWorkspaceListed`, and doesn't list it: `spaceUnavailable`) says "This Space isn't available", with
  no toggle, no `view()` and no last screen; page-store's `dropSpace` resets a kept `Space/<id>` of it,
  as a kept page of it, to the Spaces. A page with a conflict (`useAllPageConflicts`) gets the banner's
  warning as a badge on its Recent and tree rows, beside the page menus' "Waiting to send", and "Changed
  elsewhere" after its title in the row's label. Maestro's `space-open.yaml` and `space-open-offline.yaml`.
- **New page and page menus** (`screens/page-menus.tsx`, view models `src/shell/page-menus.ts`):
  the library's header has New page (+), a title prompt (`TextPrompt`) that queues `createPage`;
  a page made here shows at once and opens once its create resolves. Each row, Recent and All pages,
  has a long-press menu (`ActionMenu`) that is also its accessibility actions: Move (a native sheet,
  `useRouteSheet`: every other Space, then the top or one of its pages, whose list is pulled
  while the sheet shows), Set cover or Change cover (the photo picker, the Files upload's `add('cover')`,
  `setPageCover`, then `takeSavedNote` as a toast), Remove cover ("Cover removed" with Undo,
  `restorePageCover`) and Delete, offered by `deleteRule` (the web's `canDeletePage`: an admin or
  operator, or the page's creator, and a member only when every subpage is theirs too, the server's
  subtree rule; a member's rule until the shell says the role) after a native confirm in the web's
  words naming the subpages, whose ids go to `deletePage`. New page's `known` is the Space's synced pages (`knownPages`), pending
  writes or not. `usePageWrites` lays the page writes'
  overlays over the rows (`withPageWrites`: an inserted page, a move out, a delete gone, each with its subpages, a cover or
  its upload's copy at once, "Waiting to send" in the row) and lists the refused creates, moves, deletes
  and covers of the Space (`pagesNotSaved`) in `NotSavedNotice`: "Couldn’t delete “Roadmap”." with
  why, Retry, Copy (a new page's title and text only) and Discard; a delete that met new subpages asks
  again, naming them, and discards the refused one once confirmed. Maestro's `space-menus.yaml`.
- **A Space's radar and memory** (`screens/space-sections.tsx`, view models
  `src/shell/space-sections.ts`), read-only, are tabs under the library's heading like the web's
  `space-tabs.tsx`: Pages, Memory, Radar (Settings stays on the web), switched in place; the
  `SpaceMemory` and `SpaceRadar` routes (`/spaces/:spaceId/memory`, `/radar`) open the Space on theirs.
  New page shows on Pages only. Each tab holds its section (`useSpaceSection`): "Loading…", "Open it once
  you’re online" with no copy, "Updated …" over an older one. The radar is the web's three sections
  (Recent changes, Open decisions & experiments, Potentially stale) without its session-only
  dismissals, each row opening the page. The memory is who reads it, the proposals waiting (an
  editor's "Waiting for approval", a reader's "Your proposals") and the entries in use, with who
  proposed and approved each; no retired entries and no writes: "Open on the web" (`useOpenLink`).
- **A page** is the `Page` route at `/spaces/:spaceId/pages/:pageId`
  (`screens/page.tsx`, `page-blocks.tsx`; view models `src/shell/page-reader.ts`), pushed from its library,
  other pages' links and links from outside (`pageAction`), read-only: the cover (h-50, the image cache),
  the parents as 44 pt crumbs, the title and "Edited Nov 8", the body, then "Child pages". `usePageBody`
  (`src/live`) holds the body while it shows and runs page-store's `open()` (the list, then the body if its
  revision moved); `pageView` takes the newer of the summary and the body. Offline with no body it shows
  the excerpt and "Open it once you’re online"; a body the server says is gone, with no summary, is the
  web's "Page not found". It keeps itself as `Page/<spaceId>/<pageId>`, Home opens it over itself
  (`restorePageAction`), it marks the first frame (`useFirstFrameWithData('Page', …)`) and follows a move
  (`onMoved` → `setParams`). The body goes through `markdownParts` (`src/chat/markdown.ts`, the
  replies' rewrite, which `replyParts` now uses too) into the replies' `MarkdownBlock`, so no image a
  page names is fetched; top-level fences the web draws become blocks (`pageParts`): `dataset-view` (its
  last result with "Updated …", a table of 25 rows or the replies' `ReplyChart`, "Open the page online
  to load this view" with none, the server's words on a denial), `embed` (the link card's snapshot, its
  first image by embed id) and `image` (the editor's picture, read by `pagePicture` until a shared
  module takes it over), both through the image cache, and
  each top-level GFM table outside code becomes `table` (`PageTableBlock`: the page's full width in equal
  columns of at least 60, scrolling sideways past that, as editor.css's fixed-layout table; each cell
  its own `MarkdownBlock` with `cell`, the header row semibold), since the renderer's own table is only as
  wide as its text. A page's list items have `PROSE.page.listItemGap` between them (the renderer's
  `itemSpacing`); a chat's and an issue's have none, as the web's. Links to
  the workspace's pages and Spaces, path or old hash form (`pageLink`, the web's `resolveLink`), open in
  the app; the rest keep the replies' rules. Edit opens the page's editor (The page editor's screen,
  below). While a save of it waits as a conflict, the conflict banner shows above it, and a clean
  merge's toast at the bottom.
- **The Board** is the `Board` route at `/issues` (`screens/board.tsx`,
  view model `src/shell/board.ts`), pushed from Home's tile (which counts the open issues,
  `openIssueCount`) and Search; its bar has New issue (`FileIssue`, below), Select and iOS's search
  field. Its heading is the web's "Issues" as the bar's large title in the orange tone, the counts under
  it (`PageIntro`). The rules are shared's: `filterIssues` over the five facets and the "Socio requests"
  lane, "Most votes" (`byVotes`), the columns and the header's counts. One column at a time
  (CB-249): a sideways row of status chips that read as tabs (`tablist`, each label with its count, the
  selected state, each marked with the web's hollow status ring in its tone, `STATUS_RING`), and one
  vertical `LegendList` of the chosen column; a status filter picks the columns,
  won't fix shows on request otherwise. The rows are the `issues` collection with this device's field
  edits and votes laid over (`withIssueWrites`, `BOARD_VIEWS`; a refused write lays nothing), sorted with
  `compareBoardOrder` after, so a pending priority re-sorts, each marked "Waiting to send" (or "Couldn’t
  confirm this was sent") while it waits; pending `CB-?` filings sit at the top of Triage, each opening the
  issue's screen under `CB-?` with its buttons under it (`PENDING_ACTION_LABELS`): View (an unconfirmed
  filing's candidates in turn, `nextIssueCandidate`) and Send again (`sendNow`), or a refused one's Edit
  (FileIssue on it), Copy (`filingText`) and Discard (asks first). A screen reader
  hears the waiting count once as a mark appears (`pendingAnnouncement`, `shown: false`, so
  Android hears it too). Each row is the web's card:
  key, priority pill (`PRIORITY_TONE`, always its word), kind and area, labels (`dot-request` says
  "Socio request", `labelWords`), votes, demand, blocked and the assignee's initials in a squircle.
  Search is the app's field (`SearchField`: an icon, no label over it, "Search issues" for screen readers)
  over `filterIssues`, with `/api/issues/search` matches 250 ms after typing
  (`src/sync/issue-search.ts`, online only; offline it filters what it holds). The filter sheet's choices
  and the column are kept per workspace in the scope's `kv` (`BOARD_PREFS_KEY`; the search text isn't).
  A row `preload`s its detail from disk and opens the issue's screen (`issueAction`, below). It
  keeps itself as `Board`, marks the first frame (`useFirstFrameWithData('Board', …)`; Home doesn't when
  the Board is kept) and polls every 15 s while shown. `tests/shell/board.test.ts` holds the facets, the
  order, the overlays and the tones' contrast; Maestro's `board-open.yaml` and `board-open-offline.yaml`.
  `e2e/board-parity.mjs` (README) checks the board against the web's on a live workspace, through the
  app's sync path.
  The owner's 2026-11-18 request adds the web's other three: the board/list toggle (`BoardPrefs.view`,
  kept with the choices, as the web keeps `issues-view` per browser; the list is the web's IssueList:
  status sections, done and won't fix folded at first, rows with the priority's edge and the excerpt);
  Select for admins
  (`canTriage`), iOS Mail's way (Select in the header, round checks, Select all and Done, a bottom bar
  with the web BatchBar's Status, Priority and Labels, `screens/board-select.tsx`), each choice one
  `editIssue` per picked issue (`applyBatch`, `src/shell/board-select.ts`), said in the web's toast words;
  and the vote count on every row, "👍 0" too. `tests/shell/board-select.test.ts`.
  CB-442 adds the web's Component facet to the Filters sheet (`BoardView.componentFacet`: the refs on the
  listed issues and any chosen, named by the list's label map, exact match, `BoardPrefs.components`, kept
  with the rest) and the web's small chips on cards and list rows (`BoardIssueRow.components`, two then
  "+n", `screens/issue-components.tsx`), named from the kept `issue-components` row, so they read
  offline. The rules mirror the web's IssueComponents.tsx in `src/shell/issue-components.ts`: names only
  from the label map, the options or the wildcards; "off", "(uninstalled)", "(deleted)" as the web words
  them, a gone one muted and struck through. `tests/shell/issue-components.test.ts`.
  CB-468 (the owner's TestFlight note, 2026-11-21) swipes between the columns as a page view does
  (`src/shell/board-swipe.ts`, the pan's worklets in `screens/board-swipe-gesture.ts`, as the drawer's): a
  gesture-handler pan around the one vertical list (which stays the page's first scroll view, for the
  large title), taken by a sideways drag past `ACTIVE_OFFSET` and left to the list by a vertical one past
  `FAIL_OFFSET`, started only on the cards (`swipeStartsOnCards`: not the heading, whose chip row scrolls
  itself, and not iOS's left `BACK_EDGE`). The cards follow the finger (`SwipePage`, by `position`, the
  chosen index times the width at rest, `pageShift`), the neighbors' first `PEEK_ROWS` cards come in beside
  them (`BoardView.neighbors`, `ColumnPeek`, pictures that take no touch and screen readers skip), a release
  turns at most one page with the platform's spring (`settleColumn`, `swipeSettle`; at once under Reduce
  Motion) and chooses that column, the list scrolled so its first card is where its peek drew it
  (`peekTop`, `landingScroll`). The chosen chip scrolls into view; the chips still choose. On the board,
  iOS's back swipe keeps to the left edge (`gestureResponseDistance: backSwipeDistance`), since iOS 26
  takes a swipe right anywhere as back. `tests/shell/board-swipe.test.ts`.
- **Filing an issue** is the `FileIssue` route (`screens/file-issue.tsx`, view
  model `src/shell/file-issue.ts`), a `pageSheet` with no path, from the Board's New issue, a failed run's
  "File issue" (`runId`, Runs) and a refused filing's Edit (`edit`, its local key: the Board's `CB-?` row,
  the Unsent list and the issue's problem card). A ChatGPT-style compose screen: Cancel, the heading and
  File on top, then the web's ReportForm (title of 3 to 200 characters, description, kind (Bug), priority
  (Medium) and area (none) as radio chips, the lead "into triage", and "linked to the failed run" with
  one), "Plugins and apps" (CB-442: a row of the chosen chips that opens the picker, `componentSheet`, a
  tall native sheet grouped All, Plugins and Apps, multi-select, at most 10, its search past 8 options;
  shown only when the list's label map says the server has components; the refs go in the draft), then
  Files: the composer's three pickers, shared's `ATTACHMENT_HINT` and the tray, through the issue
  processor; an image pasted into either field joins the tray (CB-358). What is typed is the `issue:new`
  draft (`withIssueField`, back at the defaults it deletes itself), so Cancel and a kill keep it (with text
  in a field or a file in the tray, Cancel, the sheet's swipe down and Back first ask Keep draft or Discard
  (`usePreventRemove`, `useActionMenu().open`), `cancelIssue`; Discard deletes the draft and its tray's files, `discardIssueDraft`; Edit never asks); it links
  to the run it was opened for and to none from New issue (`forRun`); Runs' "File issue" fills it as the web's
  `runIssueDraft` does (`runIssueFields`, mirrored since it isn't in shared: "Run failed: …", the body, area
  Runs), keeping a title, description or area already typed (`openIssueFor`). File runs `fileIssueWithFiles`
  (the issue's create, its attachment rows, the box cleared, one transaction) and replaces the sheet
  with the issue's screen under `CB-?`, which says "Waiting to send" while the create waits. Edit opens
  on what was written (`editIssueFields`, in memory; a filing refused because its run is gone, a 404
  with `runId`, opens
  without the link and says so, as sending it with the link would be refused again), lists the files waiting on it (`heldFileNames`), and Send again queues any
  file still in its tray, then changes the row in place (`resendIssueWithFiles`), so they follow. A development client's floating Tools button sits over
  File: the flows drag it away first (`common/move-dev-tools.yaml`). `tests/shell/file-issue.test.ts`;
  Maestro's `file-issue-photo.yaml` and `file-issue-offline.yaml`.
- **An issue** is the `Issue` route at `/issues/:key` (`screens/issue.tsx`, view
  model `src/shell/issue-detail.ts`), pushed with `issueAction` (PUSH, so a linked issue's Back returns)
  from the Board, issue chips and another issue's links; its param is `CB-12` (`issueParam`,
  `issueOfParam`), or a filing's local key, which `issues.resolve` turns into its number and the screen
  swaps when the create resolves (`issues.subscribe` → `setParams`). `useIssueDetail` (`src/live`) holds
  the issue's detail while it shows; `useSyncOnFocus([ISSUES])` keeps the list's 15 s poll going, which
  is what reads a changed detail again (`followIssueList`). `issueDetailView` lays `ISSUE_DETAIL_VIEWS`
  (the filing, the edits and vote, comments and files) over the held detail in fixed words: a refused
  write lays nothing but a refused comment, which shows "Not sent"; this issue's `unsent` writes
  show in place ("Couldn't save") with Keep mine and Keep theirs for `issue-conflict`, Edit (FileIssue),
  Copy and Discard for a refused filing, else Retry, Copy
  and Discard. The web's IssueDetail on a phone: status and priority pills (always their words), the vote
  as the web's small chip in that meta line (`VoteChip`: the thumb, filled when the person voted, and the
  count, "0" too while nobody has voted; 28 pt to look at, a 44 pt target through its hit slop; its label says the key, the count and the
  person's vote), not a labelled button, the title and "Filed by … · updated …" (the web's meta line, once it changed after filing),
  then in the web's order (`ISSUE_SECTIONS`, the conversation first) the description and comments through
  the replies' `ReplyMarkdown` (issue text is untrusted), the web's Attachments section, shown even with
  none (`NO_FILES`), with Attach beside its title (`IssueAttachments`: the comment box's three choices into
  the tray `issueAttachTray(key)`, each pick at once `attachToIssue`'s rows, the issue's own files, no
  comment, queued offline; `existing` is the view's `fileCount`), its files (pictures as squircles through the image
  cache's `issue` kind, `/api/issue-attachments/<id>`, opening the viewer; other files open the web),
  the web's read-only fields, the links as rows, the comments (Edit and Delete by shared's `can*`) and
  the history (`eventText`; a `components` event in the web's words, `componentEventText`), the web's
  triage proposal read-only (`triage`, ISSUE_SECTIONS' `triage`: its tags, the suggested components the
  reader may see, the reason, who decided or what happens next) and the components as chips in the fields
  (CB-442, none from a server before them). The comment box is the chat's `Composer` on draft `issue-comments:<key>`
  with the attachment tray (`commentWithFiles`). A member edits the title and description of their own
  issue in triage (`canEditText`, `editIssue`). Admins (shared's `canTriage`; the server decides) get
  `AdminFields` in place of the read-only fields (`screens/issue-admin.tsx`; the view's `admin`):
  status, priority, kind, area, labels, components (the File an issue picker, each tap one folded
  `editIssue`) and assignee each open a sheet, the resolution is edited in place
  (a sheet would sit under Android's keyboard), and each change goes through `editIssue` on the server's values as its base, its row marked while it waits. The assignee
  sheet reads the scope's `issueAssignees` (`issue-assignees.ts`, a bounded kind of
  `GET /api/issues/assignees`, one item, read only while the sheet shows, never gone), and offline shows
  the last list with its age and "Needs a connection" (`assigneePicker`). The component options
  (`issue-component-options.ts`, CB-442) are the same: a bounded kind of `GET /api/issues/components`,
  one item, read only while the picker shows (`useIssueComponentOptions`), never gone. Triage proposals, links and
  delete open the issue on the web for now (they are planned to become native). Offline with no copy it says so; a
  404 or 410 is "This issue isn't available". It keeps itself as `Issue/<key>` (`issueScreen`), a cold
  start reads its detail before the first frame (`preloadKeptIssue`), Home opens it over itself
  (`restoreIssueAction`) and it marks the first frame (`useFirstFrameWithData('Issue', …)`).
  `useOpenLink` opens an issue chip (`linkTarget`'s `issue` kind) here and an issue's attachment
  (`issue-attachment`: only a root-relative `/api/issue-attachments/<id>`, no query or hash) in the
  viewer; `{ web: true }` sends either to the browser. `tests/shell/issue-detail.test.ts`; Maestro's
  `issue-detail.yaml`.
- **Memories** is the `Memories` route at `/memories` (`screens/memories.tsx`, view model
  `src/shell/memories.ts`), pushed from More (`moreItemAction`), Home's tile (the proposals waiting) and
  Search, in the module's violet, Add memory in its bar. Its rows are the `memories` kind with the
  memory writes laid over (`memoriesView` over `shownMemories`), in fixed words while one waits
  ("Couldn’t save" once refused): the proposals waiting first, newest first (Remember, Edit, Not now:
  a delete with no confirm, as the web's), then About you (the filled fields in order, the
  sharing and "Updated …", Edit profile, Clear after a native confirm), then Remembered (Still true, Edit,
  Forget after a native confirm, "Team chats too"), each with where it came from (`memoryOrigin`; the
  chat's name opens it). What the server refused on Memories or the profile shows at the top: Keep mine
  (`keepMine` with what the server holds, `MemoryProblem.current`) and Keep theirs for a `conflict`, else
  Retry, Copy and Discard. Add keeps its text in the `memory:new` draft (`enqueueFromDraft` with
  `memoryAddWrite`), Edit queues only what changed (`memoryChange`) on the stored row's base, and the
  profile sheet only the fields changed or cleared (`profileChange`), its time zone checked by shared's
  `ianaTimeZone` as it is typed (`timeZoneHint`) and again by `saveProfile`. The moved time zone's note
  shows while the screen does and is marked seen through the outbox. The episodes
  (`src/sync/memory-episodes.ts`) are read online only, searched 250 ms after typing, and deleted one or all after a native
  confirm, online only and never queued or sent again ("Needs a connection" offline or while
  "Reconnecting…"; a request with no answer says so). "An admin turned memory off" shows while
  `memoryAllowed` is off. It keeps itself as `Memories`, marks the first frame once `/api/memories` has
  answered (`useFirstFrameWithData('Memories', …)`; Home doesn't when it is kept) and polls every 15 s
  while shown. `tests/shell/memories.test.ts` (over `tests/sync/memory-fakes.ts`, the memory writes' fake
  server) and `tests/sync/memory-episodes.test.ts`; the device check is Maestro's `a3-tour.yaml`.
- **Scheduled & activity and Schedules** are the `Activity` route at `/activity` and `Schedules` at
  `/schedules` (`screens/activity.tsx`, `screens/schedules.tsx`, `schedule-parts.tsx`; view models
  `src/shell/schedules.ts`), pushed from More (`moreItemAction`), Home's Scheduled tile and Search, each
  with the bar's large title in the module's tone. Activity is the shell's `state.tasks`, searched over
  the prompt as the web's (`activityRows`); a row opens `Task` (no path), the
  `task-details` copy with the web's buttons (`taskButtons`: Pause while running or queued, Run again,
  Retry or Resume unless `runNowBlocked`, Pause schedule, Cancel), all online only through
  `actOnTask`, its last six events, "Details and past runs" (the task's `Schedule` page) and its repeat
  interval on the web. Schedules has two tabs (`tablist`): Schedules (goals newest first, each with its
  comments on request and a `goal:<id>` box while open; the schedules newest first, the limits line, the
  web's buttons per status, `scheduleButtons`) and Jobs (by `updatedAt`, Run now online only, "Running"
  while a long run goes). Its rows are the `schedules` kind with the schedule writes' overlays
  (`shownSchedules`), in fixed words while a write waits or was refused; it polls every 10 s while shown
  and is kept as `Schedules` (a kept one reads the kind before the first frame). `Schedule` at
  `/schedules/:scheduleId` (`scheduleAction`, PUSH) is the web's SchedulePage: purpose, goal progress
  and comments, "What it does"
  (`scheduleDetailView`; Pause, Resume and Cancel only on a repeating one), its runs with Open in chat and
  the board's issues, and Load more online. `Job` (no path, `jobAction`) shows its progress with Stop
  while it runs (online only, `useOnlineAction`) else Run now, its versions, its runs with Logs and Load
  more online; code, versions and delete open the web (`JOB_ON_WEB`). Offline every detail shows its
  held copy with "Saved …" (`detailAge`), or "This shows once you’re online". Nothing is created or
  edited on the phone. `tests/shell/schedules.test.ts` and `tests/sync/schedule-details.test.ts`; the
  device check is Maestro's `a3-tour.yaml`.
- **Learning and Runs** are the `Learning` route at `/learning` ("Skills"
  for members) and `Runs` at `/runs` (`screens/learning.tsx`, `screens/runs.tsx`; view models
  `src/shell/learning.ts`, `src/shell/runs.ts`), pushed from More (`moreItemAction`), Home and Search,
  each with the bar's large title in the module's tone and kept as the last screen. Learning lists the
  `skills` kind's published skills (by container, then name), read on view with no poll; admins get
  "Review what your socios are learning", which opens the web's `/learning` (`WebRow`, `useOpenLink`).
  Runs is the `runs` kind as the server answers it (a member's own turns, everyone's for an admin, who
  also sees whose each is), newest first, with the web's status filter over what the phone holds and
  "Showing the latest 200."; it polls every 10 s while shown and never asks for a trace. A row opens
  `Run` (no path, `runAction`, never kept, so nothing reopens a trace untapped): the row's facts, Open
  the chat when `readable`, and the trace from `useRunTrace` (`runTraces`' item, read as the page opens
  and again when the run's status or end changes while it shows, as the web's RunTimeline): the end
  reason, rounds, tokens, time and model, then the steps in shared's tool labels with how a failed one
  ended; with `useAdvanced()` on, the rounds, retries' codes, compactions, notes and reactions, each
  tool's own name and call id, and the traces' `runSection` rows. `runTimeline` is worked out once per
  trace answer and setting (a WeakMap), so polls and the age line re-render nothing new. Offline the
  person's own trace shows with "Saved …", anyone else's says it shows once online. The failed run's "File
  issue" opens FileIssue with `runId` (above). `tests/shell/runs.test.ts`,
  `tests/sync/run-traces.test.ts` and `tests/sync/scope.test.ts` (no `/trace` while Runs shows; a tap
  keeps only the person's own).
- **What needs attention, at the top of Chats** (CB-455: the Inbox tab until the owner dropped it;
  `src/shell/inbox.ts`, drawn by `screens/attention.tsx` in Chats' list header, nothing when it's empty)
  is built from what the scope holds, its parts in order (`sections`, an empty part left out): the
  approvals waiting (the newest `INBOX_APPROVALS_SHOWN`, each opening its request's page, with Deny and
  Approve under it as the web's cards have, through `approvals.decide` by the request page's rules
  (`inboxDecisionView`: none, and the row opens the request, when `approvalRule` says `open-first` or the
  card decides; online only, "Needs a connection" otherwise; `useChatApprovals` watches each and says
  what a tap came to), then See all with the count, opening the list), the last day's notices newest
  first (the server's mentions among them; `NOTICE_DAY_MS`, so the 200 the device keeps never hold the
  section open), the room invites (`inviteRows`, newest first, none while rooms are off; each opens the
  `RoomInvite` sheet), the rooms with unread from the chat list's rows (each opens its room), then the
  notifications-off row (`notificationsDenied`, to the phone's Settings) while the phone's permission is
  denied. Chats pulls `approvals`, `notices` and `room-invites` while in view
  (`ATTENTION_SYNCED`). The Chats tab's badge (`attentionCount`) counts each approval waiting, invite
  and room with unread: not the notices, which showed as banners, nor the notifications row, a setting.
- **What needs attention about Spaces, at the top of the Spaces tab's list** (the owner, 2026-11-20:
  what the Inbox held about Spaces belongs to Spaces, not Chats; `spacesAttentionView`, drawn by
  `SpacesAttention` in `screens/attention.tsx`, after the list's first line, in the attention section's
  style, nothing when it's empty): the pages changed elsewhere (`pageConflictRows` of
  `useAllPageConflicts`, one row per page with a conflict, titled as the page is now, its Space and how
  many versions of the person's wait, each opening the page under the conflict banner in the Spaces
  tab). The Spaces tab's badge (`spacesAttention`) counts those pages, and only there, so none counts on
  Chats too.
- **The switcher's order** (`switcherRows`) is every ready workspace from the registry, the open one
  first, then by `lastUsed`: name, host (`hostParts`), person, a state badge and unread. The drawer's rows
  are built on it (`drawerWorkspaces`). The account sheet (More's Account row, Home's account button)
  keeps the account's things, the web person menu's links (`ACCOUNT_LINKS`: Report issue, then Getting started &
  guides, Release notes and Account & security through `useOpenLink`), Sign out and Leave workspace (CB-383,
  Sign-out above); its workspace list moved to the drawer. `Switcher` (`screens/account.tsx`) still
  draws it with Add a workspace for a workspace that didn't open (its badge then says "Didn’t open").

## Chat screen

The chat is the `Chat` route at `/chats/:id`, pushed in the tab it is opened from (its link opens it in
Chats) by the chat list's, Home's and Search's rows (`useOpenChat`, `chatAction`) or opened by a link
(`screens/chat.tsx`):

- **What an id shows** is `src/chat/chat-view.ts`'s, under Node: a private chat's transcript; a room
  (its `kind`, or a `room:` owner) its room transcript (below); an id the workspace doesn't list once it
  has answered is gone; before its first answer the screen waits. A composer gets the id it sends to
  only from `sendableChatId`, which is null for a room: a room id never reaches the chat's send path.
- **A room** (`src/chat/room-transcript.ts` and `room-people.ts` under Node, drawn by
  `screens/room-parts.tsx`) is the same `Transcript` with `room`: `roomRows` lays who wrote each message
  over the chat's rows, from `/history`'s stamps or the live turn's (a socio's name with the web's
  "socio" badge; an empty room's line at the top, `EMPTY_ROOM`): a person's squircle avatar in their
  tone (shared's `personTones` into `PERSON_TONES`, the web's six hues from theme.json) and name
  (`personLabels` for same-named members, the view's current name, else the stamped one), on the left;
  the reader's own as "You" on the right; a reply's socio (`replySocio`). A handoff note is a line
  (`handoffLine`, names from the view), never a bubble; a failed or cut-off run is `problemText`'s line
  after its last message, worded from `runFailures`' code. The running turn is only `roomRunningNote`
  in the status pill (`runningNote`), never steps or reasoning.
  Another person's message that mentions the reader has the web's "@you" badge beside their name
  (CB-416, `mentionsYou` over the `mentions` `/history` carries; none from
  older servers), said as "mentions you". The header
  (`RoomHeader`, `roomHeader`): title, `roomStatus`, "Ben is here" (`presenceSaid`, avatars hidden from
  screen readers; the whole is one header label, never announced) and the socios' stacked marks; the
  name, as Slack's, and the marks open the `RoomMembers` sheet (no path): people, then socios, read-only, and "Manage on the web"
  through `useOpenLink` (`/chats/<id>`). The screen holds `rooms.show(id)` while it shows. Pending
  bubbles take `room-message` rows too, Edit filling the room's box as a chat's; a read-only room, with
  no box, offers Delete in its place (`roomBubbles`); a room admin sees everyone else's queued messages (`othersBubbles`, the steering
  snapshot's `others`, none the history or the live turn holds) with Cancel, `DELETE …/steering/:id`
  online only, never queued, and never in a read-only room (no Cancel there): a 409 is read by its
  `code` (only `delivered` says it went already; `archived` and `rooms_off` say the room's state), a
  403 says only admins can, a 5xx or other refusal says try again, and every answer reads the queue
  again (`cancelAnswer`); only no answer blames the connection. The screen reader's
  "replied" names the last reply's socio (`roomReplier`). The room is
  marked read (`markRoomRead`) while the list follows its end, the screen is focused and the app
  active (`shouldMarkRead`), each newer run again. A read-only room shows `readOnlyReason`'s line; a
  room the view says is gone, "You are no longer in this room". Rooms keep themselves as the last
  screen (`Chat/<id>`) and row presses preload them, as chats. Maestro's `room-open.yaml` and
  `room-open-offline.yaml`.
- **The room's composer** (`src/chat/room-composer.ts` under Node, drawn by `screens/room-composer.tsx`
  through the chat's `Composer`): "Message the room and Sebas…" (`fitName`; with several socios
  answering, "Message the room, or @ a socio…"), labelled "Message the room". Typing `@` opens the
  picker over the box (`mentionPicker`, shared's `mentionQuery` and `matchingPeople` over
  `roomMentionables`: the active people but the reader, then the answering socios): rows with the
  button role, 44 pt, the avatar hidden from screen readers, "Mention Ben" / "Mention Sebas, socio,
  lead", the count ("1 person and 2 socios to mention") announced once per change; a pick closes it for
  that `@` (`pickMention`). A person's pick is kept by id for the draft's send and goes in `mentions`
  only while their `@Name` is still in the text (`keptMentions`); a socio's routes by the text. Picks
  live in memory but the draft in user.db, so at send `sentMentions` adds the room's people the text
  names unambiguously (shared's `parseRoomMentions`): a draft reopened after the screen popped, the app
  was killed or a pending message was edited back still notifies them. No line
  under the box says who answers or that a message waits (CB-491, the owner: it read as noise; the
  web's RoomChat still has one): only the held or update line shows there; from 7,500 characters the length shows over the box, and past
  `STEERING_MAX_CHARS` Send is off (`lengthNotice`, `tooLong`). `sendRoomMessage` queues a
  `room-message` through `enqueueFromDraft` (the tray's files and pasted images with it, as a chat's), so
  it waits offline. Stop shows only for a room admin or the person whose message started the running
  turn (`mayStopRoom`, the server's `mayStop`), online only ("Needs a connection to stop the answer.");
  before RUN_STARTED, with no run known, only for an admin or a reader whose own message waits
  (`ownWaiting`), never the previous writer.
  A message sent from it calls the notification ask once its turn runs
  (`askForNotifications('room-turn')`).
  Maestro's `room-send.yaml`, then `act-as.mjs read` checks the mention as Ben.
- **Invites and the room's menu** (`src/shell/room-invites.ts` under Node): an invite's row
  (the top of Chats, Home) opens the `RoomInvite` sheet (`screens/room-invite.tsx`, no path): who asked, the role,
  how many are in it and until when, then the disclosure, then Decline and Join (`inviteDetail`), online
  only ("Needs a connection", disabled with that as their hint); Join goes back, opens the room and calls
  the notification ask (`askForNotifications('invite')`). The
  room header's menu button opens the `RoomMenu` sheet (`screens/room-menu.tsx`, no path): the reader's
  notification level as radios (shared's `ROOM_NOTIFY_CHOICES`, read as it opens, none marked until
  then; a failed read offers Try again, and one that met another request reads once it ends:
  `notifyReadRetry`, `whenRoomFree`, which checks again right after subscribing), Members (the `RoomMembers` sheet in its place) and "Open in your browser" through `useOpenLink`
  (`roomWebHref`). Maestro's `room-invite.yaml` (`act-as.mjs invite`).
- **The transcript** (`src/chat/transcript.ts`) is the stored runs (`histories.history(id)`), then the
  follow stream's live turn (`follows.follow(id).state.turn`), one store for React (`chat-source.ts`),
  both held with `use()` while the screen shows (`holdChat`). The person's messages are bubbles on the
  right, Markdown in the bubble's colors as on the web (CB-415, `screens/message-text.tsx`: the
  reply's `MarkdownBlock` over `safeMarkdown` with `surface` own, pending or another's,
  `chat/bubble-style.ts`; links plain, not issue chips; a bubble with a link isn't one accessible
  element, as a reply isn't), a chat skill they invoked (`/grill-me …`) a chip above the rest
  (`chat/chat-skills.ts`: the built-in ones, then `GET /api/chat-skills` once a minute at most, only
  for a name they don't have), the socio's replies Markdown at full width (below), each turn's work as
  its trace row (below), and the cards (below). A reply being written grows a few words at a time, as
  the web's grows with each delta (`paced-text.ts`, CB-365): at most every 50 ms, each release about a
  fifth of what waits, whole words only, so a burst drains at a steady pace; a line of list or heading
  markers alone, and a fence or table line, wait until they can't read as another block; a word still
  being written shows once the deltas pause (300 ms); a reply first seen with 400 characters or more
  shows them at once; the end of the run shows all. What shows is always a prefix of the text that
  came. The web does nothing for Reduce Motion here, so neither does the app. Screen readers hear
  "<socio> replied" once, as a turn ends with a reply. `deliveredInTurn` names the person's messages
  the live turn holds, which pending bubbles hide.
- **The list** is T3 Code's: one `KeyboardAwareLegendList` (`KeyboardProvider` is in `src/app.tsx`)
  that starts at the end, keeps it in view while following (`maintainScrollAtEnd`, not animated) and
  the reader's rows in place while not, and pages older runs in from the top (`loadEarlier`).
  Following is T3's state machine (`vendor/t3code/thread-feed-live-follow.ts`, driven by
  `src/chat/follow-session.ts`): only the person's drag, through its momentum, turns it off; it comes
  back when they let go exactly at the end, or on `reset()` (the composer's send and Jump to latest).
- **Content in the first frame:** a row press `preload`s the chat's history from disk before the push,
  and a chat or room keeps itself as the workspace's last screen (`Chat/<id>`, `last-screen.ts`), so a
  cold start reads it before the first frame (`preloadKeptChat`, in the active scope's open) and Home
  opens it over itself (`restoreChatAction`); the chat, not Home, marks the first frame with data, a
  chat with no runs once its history answered or failed (`transcriptDrawn`).
- **Replies are Markdown** (`screens/chat-markdown.tsx`): enriched-markdown's native renderer
  (GFM) styled from theme.json, over `src/chat/markdown.ts`'s text. Nothing in a reply may fetch: every
  image becomes a link before the renderer sees it (an empty alt reads "Image"), a line that starts an
  HTML block shows as text (as the web shows raw HTML), and where a line is or might be code a word
  joiner keeps `!` from `[` and `<` from `video`, so no image or video block survives however the
  renderer reads it. Behind that: image sources resolve to nothing, the iOS link preview and math are
  off, and the native video player isn't built (`"enableVideo": false`). `socio-chart` fences are
  drawn with react-native-svg (`src/chat/chart.ts`, the web's SeriesChart geometry), at most three.
  Taps follow `src/chat/markdown-links.ts`: only http(s) and mailto, workspace paths only when
  root-relative; a page of the workspace the app has a screen for opens it (CB-413, the web's AppLink:
  `MarkdownBlock` asks `useOpenLink` with `{ app: true }`, `appPathOf` takes the path without a query
  or fragment, and `openInApp`, links.ts's `openNow` over the route table, dispatches it only when the
  shell shows it, never waiting); any other opens in expo-web-browser after the one-time sign-in line
  (until a sign-in handoff exists; `useOpenLink`, which the cards reuse; its "Open in your browser"
  buttons leave `app` off), another site or a mailto through the system. Links to the workspace's issues
  are chips, which open the issue's screen; in a chat's reply a paragraph or list item of issue links
  only is a stack of the web's issue cards (`issueCardParts`, `screens/issue-card.tsx`): key, title,
  excerpt, status, priority, kind and area from the phone's `issues` kind (pulled while the chat
  shows); an issue it doesn't hold stays the chip.
  In a list that holds other items too, a card item keeps its bullet or number with its cards indented
  under it (`bullet`, `issueCardGroups`, the web's `li`); a list of issue links only has none, as on the
  web. A chip in running text has its status beside it, the web's "CB-3 [Ready]" (`withIssueStatuses`:
  a `socio-status:<status>/CB-3` link drawn as a pill in the status's tone by one fixed `linkVariants`
  pattern per status, which opens its issue as the web's badge is inside the link: `tappedLink`, CB-414;
  enriched-markdown can't put a view inside its text, and its `linkPillContent` can't either: it sets a
  pill's label, icon and icon tint but never its background, so one neutral "CB-3 · Ready" pill with a
  tinted dot would lose the web's toned badge). Code is never touched
  (`proseSegments`): fenced blocks, quoted or in a list too, indented code and code spans of any
  length. An ordered list's card markers count from its start and their place, as the web's `ol`; a
  loose list (blank lines between items) is read whole for both.
  A hostile reply was loaded and tapped against an egress canary on both platforms;
  `tests/chat/markdown.test.ts` holds the rewrite.
- **Cards** (`src/chat/cards.ts`, drawn by `screens/chat-cards.tsx`), matched as the web's renderers
  match them: an approval result as "Approval requested" until the chat has read the request (the
  stored result stays `pending_approval` after a decision), then the actionable approval card (below);
  "Approved/Denied automatically" for an auto review's; each opens `/approvals/<id>`; the `coding_*`
  tools as the session's repository, branch, state, pull request (GitHub https only), refusal or the
  private line (a light preview still gives its status); `computer_screenshot` as the page it showed
  and the picture its result names (`CardPicture` through the image cache), only the chat's last
  finished one (`lastScreenshotCall`); the shell's `calls` as voice receipts, after their anchor else
  first, waiting with calls older than the oldest run shown. Each web page opens through `useOpenLink`
  with the one-time sign-in line. The server's prompts for the socio (voice receipts, approval notes)
  are never bubbles (`isInternalNote`). Coding calls, like approvals and page reviews, are never trace
  steps (`cardCalls`, which turn-trace.ts uses).
- **Approvals in a chat**: `src/chat/approval-card.ts` under Node says what the card and the bar show,
  `screens/approval-card.tsx` draws them over the scope's `approvals`. `useChatApprovals` watches every
  approval card's request while the chat shows (`approvalCardIds`, `approvals.watch`) and redraws on
  each answer, row, connection (`approvals` tells its listeners when NetInfo changes), "Reconnecting…"
  and `writeHold`; the list's `extraData` carries its `version`. The card (once read) is the web's
  ApprovalCard and SocioAccessCardBody, natively: what is asked (`asksTo`), the status badge from the
  copy table (`STATUS_COPY`, status by `decidedVia`), the structured card's platform facts, parameters
  as inert wrapping text (shared's `inertText`, no fixed heights), the socio's or app's words quoted
  last, the auto review's reason, the decided line, then Open details (the `ApprovalDetails` sheet, no
  path: `openDetails` and the full text), Deny and Approve ("Allow", "Allow for this task"), Undo for an
  undoable automatic approval. The bar above the composer (GlassSurface) is the oldest request waiting
  among the chat's that the device has read (the server answers only the reader's, so a room's other
  members' never show), "1 of 2" in its label, Deny and Approve, or Deny and Show request (scrolls to
  the card) when `decidedOnCard` or its details must open first. Offline, away or held, Approve and
  Deny are disabled and say "Needs a connection" (or the sign-in's or update's words); every disabled
  button's reason is its `accessibilityHint`. Outcomes are worded by status (`outcomeNotice`), never
  the server's text. A chat's card ends with "Open in Approvals", the request's page in the app; the
  list and that page show no link, as the web's. Maestro's `approve.yaml` and `approve-offline.yaml`
  run it.
- **The approvals list and a request's page** (`src/shell/approvals.ts` under Node, drawn by
  `screens/approvals.tsx`): `Approvals` at `/approvals` (from the See all at the top of Chats and More's
  Approvals row, `moreItemAction`), the requests waiting newest first, then the recent decisions by
  when they were decided, at most the server's `RECENT_SHOWN` (50); `Approval` at `/approvals/:id`
  (a row at the top of Chats, a notice's or Telegram's link). Each card is the chat's
  (`ApprovalCardById` over `useChatApprovals`, so every shown request is watched); a request not held is
  read at once, and one the server answers 404 says "This request isn’t there any more." (the scope's
  `approvals.gone(id)`, which stops its reads until a screen shows it anew). Maestro's
  `approvals-chats.yaml` runs both.
- **Page reviews**: `review_space_page` is declared in every run (`RUN_TOOLS`). Its card
  (`src/chat/page-review.ts`, drawn by `ReviewCard`) says where it stands ("Ready for your review" with
  Review, "Saving…", "Skipping…", a refusal, saved with Open page, "Review ended") and opens the
  `PageReview` sheet (`screens/page-review.tsx`, no path): the draft through the replies' renderer, the
  receipt asked once (online only; a saved one is restored, Save then reads "Continue"; another draft's
  or a deleted page's leaves only Skip, as does a draft that doesn't read), then Save and Skip. Each is
  an outbox row (`src/sync/page-review.ts`, kind `page-review`, lane `review:<thread>`, id
  `review:<thread>:<call>`, through `decideReview`, which changes a refused one in place): shared's
  `decidePageReview` (receipt first, so a lost answer never saves twice), then the tool result as a run
  through chat-send's `startRun`, settled at RUN_STARTED under `PAGE_REVIEW_IDS` and kept `sent` until
  stored (`followStoredReviews`, the scope's `onRuns`). A result already stored sends nothing; a
  conflicting receipt, or any 4xx to the receipt but 401, 408 and 429 (a deleted page, a Space the
  socio no longer reads), refuses Save and lets Skip answer. While the newest stored run waits on a
  review with no decision sent (`openReviews`), the chat's messages wait ("Your message will send after
  you decide", `CHAT_WAIT.review`, looked at again every `REVIEW_WAIT_MS`), since a message would close
  it as skipped. A refused Skip (its row `unsent`) holds nothing: no message may wait on a row the
  person can't clear (`reviewHold(scope.unsent)`). `tests/sync/page-review.test.ts` runs Save, Skip, a
  lost answer and the hold against the fake server.
- **Editing a page review**: wherever the sheet offers Save it offers Edit, which closes the sheet and
  pushes `PageReviewEditor` (no path, `screens/page-review-editor.tsx`): the page editor (`Editor` with a
  `review` target) on the socio's draft, its Space fixed, title "Edit draft", the line "Your edits stay
  on this phone until you save the review." (`reviewEditLine`), no toasts or Advanced line. Its text is
  the page editor's draft on the scope's `reviewDrafts` (`src/sync/review-edits.ts`: `createPageDrafts`
  with `scopeOf` the review's own `review:<threadId>:<toolCallId>` scope and no sink, so nothing queues
  and no page lane is touched; exempt from the bound; a kill loses at most about 2 s), checked on the
  device by `reviewEditsError` (the page limits and some text, the review schema's `min(1)`). Leaving it
  (Back, Android's back) replaces it with the sheet again, which shows the person's version
  (`reviewDraftShown(args, edits)`) with Save, Skip (with edits it asks first, `skipConfirm`: a Skip
  clears them, and the web's review ends with nothing left over), Edit and Discard edits (asks first,
  `dropEdits`); over the limits Save waits with the web's words.
  Save's row carries the edits (`edits`, payload version 2; an unedited decision stays 1, so an older
  build still sends it, while a v2 row stays unsent there as "Update Socio to send these"); the kind
  passes them to shared's `decidePageReview` (a lost answer's receipt must hold them) and answers the
  socio with `pageReviewApproved(..., { edited: true })`; edits that don't validate go to `unsent` as
  `invalid-draft`. Once this phone's own result reaches the chat (its run started, or its result id
  stored), the kind's `reviewDecided` (the scope's) deletes the edits, but only for a Save that carried
  them or a Skip. A review decided elsewhere (stored result not ours, a conflicting receipt, a deleted
  page, or a receipt saved from the socio's draft or with no `reviewDraft`, whose Continue answers with
  that page without the edits: the view's `sendEdits` is false) keeps them: the sheet says so
  (`REVIEW_EDITS_KEPT`) and offers Copy (title and Markdown), "Save as a new page" (the conflict banner's
  Space picker, then `saveEditsAsNewPage`: the page create's `pageCreateWrite` through
  `enqueueFromDraft`, so the page is queued and the edits deleted in one transaction, once) and Discard
  edits. The lane hold is as before. `tests/sync/page-review.test.ts`, `tests/sync/review-edits.test.ts`,
  `tests/chat/page-review.test.ts`.
- **Long-press** (`src/chat/long-press.ts`, `screens/action-menu.tsx`): every menu is also
  accessibility actions. A message: Copy (expo-clipboard), Share (React Native's), and a stored reply's
  four reactions as toggles; the messages aren't selectable text, so the gesture is the menu's
  (ChatGPT's). Under every message (owner, 2026-11-18; the web's MessageActions) is its action row
  (`messageRowActions`, `MessageActionRow`): Copy (a check and "Copied" for 2 s), a stored reply's four
  reactions, then the time; the person's own messages Copy and the time; none while a reply streams or
  under a message with no words. No More button: Share is the long-press menu's. A reply is never one
  accessible element (on iOS that hides its links and issue chips from VoiceOver): its menu's actions
  are on its row's Copy button.
- **Message times**: each message row carries its time from the runs'
  `times.messages` (the web's CB-72), worded by `messageTime` as the web's action row ("10:01 AM" today,
  "Oct 15, 3:04 PM" before), last in the action row under every message, as on the web; every message's
  long-press menu has its whole date as its title (`messageFullTime`, the web's tooltip), and the
  person's bubble says its time to screen readers (`bubbleLabel`).
- A private chat's row in Chats: Rename (`TextPrompt`), Archive ("Chat archived" with Undo,
  `UndoToast` in GlassSurface) and Delete (a native confirm, the web's "Delete chat?"), through the chat
  management writes, from its long-press menu, its accessibility actions or a swipe toward the
  trailing edge (Delete, red, then Archive at the edge, the full swipe); a room with unread swipes
  toward the leading edge for Mark read, there and at the top of Chats (`markRoomReadFromList`: its
  history caught up, then the room's `room-read` up to its newest run); `useShownChats`
  (`withChatWrites`, `CHAT_MANAGE_VIEWS`) lays them over the rows of Chats, Home, Search and the chat.
  A refused one, and whatever waits behind it in its lane, lays nothing (`effectiveOverlays`); it shows
  as "Couldn’t rename “Plans”." (`notSaved`, `NotSavedNotice`) with Retry and Discard, on Chats for a
  chat's writes and above the composer for a reaction, and the next rename, archive or delete of that
  chat (reaction on that message) discards it first, so a newer intent never waits behind a refusal.
  The menu is the system's (`ActionMenu`, CB-421): a context menu with the row as its preview on iOS,
  Material's popup on Android.
- **Reactions** (`src/chat/reactions.ts`, `src/sync/reactions.ts`, the scope's `reactions`): each chat's
  `GET …/reactions` in memory, asked as the chat opens and as its stored runs change, taken from each
  reaction write's answer (`onReactions`; a GET sent before it is asked again), the outbox's reaction
  rows laid over in order (`reactionsShown`). The newest stored reply, and any with reactions, keep the
  row of four 44 pt toggles under them.
- **The name suggestion** (`src/chat/name-suggestion.ts`, CB-292): read as a server chat opens, shown
  above the composer with Accept, Not now and Customize, each sent at once, online only (a 404 means it
  was settled elsewhere), then a pull.
- **Traces** (`src/chat/turn-trace.ts`, the web's TurnTrace): each stored turn that did work
  (shared's `splitTurns` and `turnSteps`, times from each run's `times`) shows one row before its
  first message from the socio, "Thought for 12s" or "Worked for 34s · 5 steps" with how many failed;
  page reviews and approvals are cards, never steps. The row is a disclosure (CB-434,
  `screens/turn-disclosure.tsx`), folded until the person opens it: iOS's chevron turning a quarter,
  Material's expand chevron half over, at once under Reduce Motion; open, it shows the web's step lines
  (`stepLines`), or the reasoning alone, and a line opens the `TurnTrace` sheet at its step
  (`screens/turn-trace.tsx`, no path) over the chat: each step in shared's tool labels
  (`screens/trace-icons.ts` maps their icon names), reasoning opening to its text, a failure in the
  tool's words, a step whose result names a picture (shared's `toolImageOf`: a screenshot) opening to it
  through the image cache and the viewer, Advanced mode or not (CB-416, the web's ToolImageThumb). With `useAdvanced()` on, each tool step opens to its time, the server's codes, call id,
  input and result (`trace-values.ts`, the web's StepDetails rules; a preview's whole result through
  the history's `fullResult` as it opens), and each run's id, model, tokens, rounds, timings and end
  code come from `GET /api/runs/:runId/trace` (`run-trace.ts`; a 404 says it isn't available).
  Ids and values copy with expo-clipboard. The running turn's steps come from its AG-UI events
  (`src/chat/live-steps.ts`: `applyRunEvent` wraps shared's `applyRoomEvent` in the run client and the
  follow stream and keeps the steps beside the turn, so a LiveTurn stays the plain value), "Working ·
  3 steps", or the phase's "Thinking" or "Working" before any. A run's life beyond its stream (moved
  to the background after 2 minutes, its report back) goes through one adapter,
  `src/chat/run-lifecycle.ts` (the follow store's `lifecycle`, told every event): `LIFECYCLE_EVENTS`
  maps none until the server's names are settled, and the transcript ends with its `run-note` rows.
  `chatTurns` keeps its last few answers by run identity (runs are immutable), so a streaming frame
  parses no tool result again. `tests/chat/turn-trace.test.ts` runs it over
  `tests/fixtures/smoke-trace-*.json`, captured from servers.mjs's fake model, Advanced off and on.
- **The composer** (`src/chat/composer.ts` under Node, drawn by `screens/chat-composer.tsx`) is
  T3 Code's: a box that grows with one round button, Send in the chat module's mint tone, Stop
  (`createRunClient().stop`, online only) while a turn runs and the box is empty; text typed during a
  turn queues (steering). It floats over the keyboard (`KeyboardStickyView`, the list's
  `keyboardOffset`) in Liquid Glass on iOS 26 (`GlassSurface`), even padding on every side, with the held
  line ("Sign in again to send…") or "Update Socio to send these" under it, and a Telegram chat's or
  team topic's line (`readOnlyLine`) in its place. The box is the chat's draft (`useDraft`), sent with
  `sendChatMessage` (`enqueueFromDraft` + `chatMessageWrite` on `chatWriteRoute`'s lane, `serverAt`
  from `serverClock`); the haptics follow `useHaptics()` (a tap tick, `stream-haptics.ts`'s stream
  ticks). iOS keeps a multiline box at its last text's height once cleared, so an empty box is one
  line there (`composerInputHeight`).
  A chat's and a room's composer is `stacked`, the web's box (owner, 2026-11-18): the text on top at full
  width, then a toolbar with Attach (the paperclip, opening the same three choices) and the round send
  in the web's tone (the foreground's fill, primary-disabled while there is nothing to send). The web's
  link (a source page) and mic (dictation) buttons aren't in the app yet. Other composers (an issue's
  Comment, the first run) keep the one-line pill.
- **A run this device started** streams from its own POST, which its follow stream drops: chat-send's
  `onTurn` feeds the scope's `turns` (`src/sync/own-turns.ts`), and `chatLiveTurn` picks it over the follow
  stream's while it runs or holds what the history hasn't stored. A POST that breaks after RUN_STARTED hands
  its turn back (`NO_LIVE_TURN`): the follow stream replays it.
- **Pending bubbles** (`pendingBubbles`) come after the transcript: the outbox's rows for the chat
  (`overlaysOf` with `CHAT_MESSAGE_VIEW`) and the steering snapshot's queued messages, each once across
  the hand-off (`queuedBubbles`) and none the live turn holds (`deliveredInTurn`) or the history
  stores, in these words: Sending…, Waiting to send, "Sends when <socio> finishes", "Not sent" with
  Retry and Edit ("You no longer have access" for a lost chat), "Couldn’t confirm this was sent" with Send
  again, a message that asks first with its age, Send now, Edit and Delete; a queued one dashed with its
  age. Edit puts the text back in the box before the write goes, so a failure leaves it in both places.
- **The status pill** above the composer shows the running turn's phase (a shimmer, still under Reduce
  Motion) and "Jump to latest" while the list doesn't follow. Both are Liquid Glass on iOS 26 (CB-457); with
  Jump to latest the row floats over the transcript's end (`pillsFloat`, CB-460), since the footer lies
  under the list and glass over the screen's opaque background reads as a solid capsule. While the list
  follows, the phase alone stays in the flow; Android's tonal pills always do. One running-turn indicator at a time
  (`shownPill`, CB-493): while the transcript shows the running turn's own line ("Working · 3 steps",
  or the phase's word; the list's `onViewableItemsChanged` over `LIVE_TRACE_ID`, `liveLineInView`), the
  pills leave the phase out on both platforms, in the flow and floating, and with no Jump to latest there
  is no row. The phase shows only where nothing in view says it: a room, a reply being written, or the
  line scrolled out of view. A send and Jump to latest `reset()` the
  follow session and scroll to the end, animated only without Reduce Motion; a turn that ends while the list
  follows (Stop included) goes back to the end once it settles (`returnsToEndAfterTurn`). The list
  isn't aligned to its end: a chat or room shorter than the screen starts at the top, as on the web and
  in ChatGPT (owner, 2026-11-18), and a longer one opens at its end (`initialScrollAtEnd`).
- **The bar** of a private chat (the web's ChatHeader; CB-420, ChatGPT's iOS bar; `src/chat/chat-header.ts`,
  `model-picker.ts`, drawn by `screens/chat-header.tsx`): one system bar, the transcript scrolling under
  it. Its title (`ChatTitle`) is the socio's mascot and name with the model under it and a chevron
  ("Paused · " first while paused): the model picker. At its end the "…" (`useChatMenu`'s `open`: Save as
  page, a title prompt then `saveChatAsPage`, `src/sync/save-chat-page.ts`, `POST …/page` online only and
  never sent again, then the page opens; Schedule a task opens the chat on the web, since the app makes no
  tasks), which holds the web's two socio bar buttons; not the web's voice call: the app has no voice. A
  room's bar (`RoomBar`, `screens/room-parts.tsx`) is the same: its name and status (or who is here) as
  the title, which opens Members, then its menu and its socios' marks.
  The picker opens the `ChatModel` sheet (no path): the person's
  choices (`GET /api/me/inference/options`, kept in the scope's view state for offline) with the web's
  labels, a pick going through chat-manage's `setChatModel` (`chat-update` with `inference`, the web's
  PATCH), shown at once. The box says "Message Sebas…" (`chatPlaceholder`).
- **A new chat** shows under its local id from its outbox writes (`pendingChatOf`: private, "New chat")
  until the list has it, and swaps its route param to the server id when `chats` says it resolved.
- `tests/chat/` runs the view models, the follow machine (T3's cases) and the session; Maestro's
  `chat-open.yaml` and `chat-open-offline.yaml` open the seeded chat online, then cold with every server
  down.

## Settings

Settings is the `Settings` route at `/settings`, from More, the drawer, Home and Search
(`moreItemAction` sends the settings module there; every other module keeps its placeholder):

- **The phone's own settings** are in the registry (migrations 5 and 9), loaded by launch before the first
  frame (`src/shell/device-settings.ts`, bound in `src/platform/device-settings.ts`). A screen asks
  `useAdvanced()` before it shows technical detail (Advanced mode changes what is shown, never what the
  person may do) and `useHaptics()` before it buzzes. Appearance (Light, Dark or System, a radio group
  over Haptics) applies itself app-wide: `followAppearance` calls uniwind's `setTheme` at load and on each
  change (System only after another was applied), which sets React Native's Appearance too, so class
  names, the navigation theme, the system bars and SVG colors follow it.
- **The page** is iOS's Settings: an inset grouped list on the system's grouped colors (`Screen`'s
  `grouped`), Appearance a segmented control, each section's note its footer (Appearance's hint,
  Advanced's words, Account's, the cache's and the kept Spaces'), Legal's publisher under its rows.
  It has the web's title as the bar's large title in the settings tone and its line under it
  (`SETTINGS_HEADING`, `PageIntro`), the person's name read-only from the workspace's user, else what sign-in kept
  (`accountRow`, "Account"), and "Everything else", the workspace's `/settings` in the browser through
  `useOpenLink` (`WEB_SETTINGS_ROW`), both while a workspace is open.
- **Legal** (Google Play's in-app privacy-policy link), with or without a workspace open, above the
  build footer: Privacy Policy, Terms of Service, Delete your account and Help & support, then "Socio by
  Ingenio Ventures Inc." (`screens/legal-links.tsx`). The addresses are `src/net/legal-links.ts` alone
  (`LEGAL_LINKS`, `https://socio.sh/privacy`, `/terms`, `/cookies`, `/delete-account`, `/support`), opened
  by `openLegalPage` (`src/platform/legal-links.ts`) in expo-web-browser, and `openLegalLink` opens
  nothing but `https://socio.sh`. Before sign-in, the first screen and the SignIn screen end with a
  small Privacy Policy link (`PrivacyLink`). `tests/net/legal-links.test.ts`.
- **The local cache row** shows the open workspace's cache size and Clear cache, which asks first. The
  scope closes and opens again, so the app mounts again on Home.
- **Spaces kept offline** (`src/shell/keep-offline.ts`) list under it while one is kept: each by
  name with its pages and size (`keepOffline.sizes`), the row a switch that stops keeping it. The Space's
  header keeps one with `KeepOfflineToggle` (`screens/keep-offline-toggle.tsx`, a custom item in
  the Space's bar); `useKeptSpaces()` (`src/live`) reads the choice.
- **Which build is installed** (`src/shell/build-info.ts`, under Node; bound in
  `src/platform/build-info.ts`): the version and build number from the installed binary (socio-device's
  `appBuild`: Info.plist, PackageInfo; the embedded config only for a dev client built before it), the
  commit and date from `extra`. Settings ends with ChatGPT's footer, "Version 0.1.0 (2829) · Preview"
  (no variant in production) and "Commit 1a2b3c4 · Built Nov 9, 2026", then, while a workspace is open,
  its server (CB-501, `src/shell/server-version.ts`): "Server: Socio v0.51.0 (1a2b3c4)", the version the
  scope's version rules hold and the commit `GET /api/releases?limit=0` gives for that version (the web's
  footer asks the same), nothing until a version is known, "· last known" while Reconnecting…; a tap
  copies them all. Diagnostics
  shows the same at its top. Launch, after the registry opens and never awaited, compares the build
  with the registry's `lastBuild` and keeps the new one before saying anything: a higher one shows
  "Updated to build N (was M)", a lower one "Older build installed: N (was M)", once, in the in-app
  notice's card over every screen (`screens/build-notice.tsx`, mounted in `src/app.tsx`); the first run
  only keeps it. It touches no workspace.
- **Technical details** is the `TechnicalDetails` route (no path), from a Settings row
  that shows only while Advanced mode is on (`screens/technical-details.tsx`, rows from
  `src/shell/technical-details.ts`, under Node in `tests/shell/technical-details.test.ts`): the versions
  (this build's, the server's as `versions.state()` holds them, the minimum and the gate, user.db's),
  where the workspace's push stands (`pushRows`), each shell snapshot source's last pull, cursor, ETag,
  format and the rows it feeds (`cache.meta`), each outbox lane's rows by state, head, attempts, last
  error and refused codes (the `pending` collection and `useUnsent`), and "On the web" links
  (`useOpenLink`) only where the web lists them for the person: `/settings/coding` for admins with the
  `coding-sessions` flag, `/operations/health` (the socios' computers) for admins. Raw values, never a
  cookie, key or payload. It ticks once a second.

## Cold start

The cold-start timing measures from the process's start to the
first frame with data, from the cache alone:

- **The marks** are `src/perf/cold-start.ts` (pure, under Node) fed by `src/platform/cold-start.ts`:
  socio-device's `processStartTime()`, the store's open (`device-store.ts`), the first scope's key reads,
  cache.db and user.db opens and rows (`openWorkspaceScope`'s `onOpened`), and the first frame with
  data. A screen the shell can open on calls `useFirstFrameWithData(screen, hasData)` (the chat, the chat list
  and Home do); the first to draw its rows wins, once per process. Then Android gets
  `reportFullyDrawn()`, and development and preview builds log one `[cold-start] {json}` line and append
  it to `<documents>/perf/cold-start.jsonl` (timings, row counts and file sizes, nothing of the person).
  Production writes nothing.
- **`perf/`** runs it on the test phones: `cold-start-android.mjs` (fill, `adb reverse --remove-all`,
  airplane mode, one discarded launch and 10 or more timed ones, read from logcat) and
  `cold-start-ios.mjs` (airplane mode by hand, launches through `devicectl`, the marks file pulled).
  `cold-start-stats.mjs` aggregates (median, p90 against 700 ms on Android and 450 ms on iOS);
  `tests/perf/` runs it under Node.

## Theme

The app's colors and radius are the web's, generated rather than copied; its type is each
platform's own (Type, below):

- `scripts/generate-theme.mts` reads `packages/client/src/globals.css`, `shell/tones.ts` and Tailwind's
  palette in the app's own `tailwindcss/theme.css`. It writes `src/theme/generated/theme.css` (uniwind's
  `@variant light` and `@variant dark`) and `theme.json` (the same values, for native views). Never edit
  them: after a change to any of those, run `node apps/mobile/scripts/generate-theme.mts` and commit
  both. `tests/theme/generate.test.ts` runs its `--check`, which fails while they are stale.
- **Native parts read `theme.json`:** `app.config.ts` takes Android's alert dialog colors, the splash
  (light and dark, on each scheme's `screen`) and the root background from it, and
  `src/theme/navigation-theme.ts` builds React Navigation's light and dark themes from it (never its stock
  `DefaultTheme` or `DarkTheme`). `tests/theme/` checks each against the JSON.
- Each of the app's roles (screen, sheet, header, the drawer (the tab-bar roles), the pending bubble's words) is one web
  token (`ROLES` in the script). Only the selected row departs from the web, by T3 Code's correction,
  which the app ports. To change a color, change it on the web.
- `tests/theme/contrast.test.ts` checks every pair the app draws, each tone on each surface included. A
  pair under its bar today is listed with the ratio it measures, and may only get better.

## Styles and primitives

Screens are built from the primitives in `src/ui/`, styled with uniwind's class
names in the web's tokens:

- **uniwind** turns `className` into styles. `metro.config.js` wraps Expo's config and our resolver in
  `withUniwindConfig`, and `global.css` imports Tailwind, uniwind and the generated `theme.css`, so the
  web's class names (`bg-primary`, `text-muted-foreground`, `rounded-md`, `dark:`, `active:`) work on
  every React Native component. Write each class name in full: Tailwind finds them in the source.
  `tests/metro-config.test.ts` checks the composition.
- uniwind writes a declaration of its themes whenever Metro compiles `global.css`. It goes to
  `.expo/types/uniwind.d.ts`, ignored by git, oxfmt, turbo and the typecheck, so a build never dirties
  the tree. `uniwind-env.d.ts` gives the typecheck the `className` props (`uniwind/types`), and
  `uniwind-themes.d.ts` the theme names, so `Uniwind.setTheme` takes only those: a theme added to
  `metro.config.js` goes there too (`tests/metro-config.test.ts` compares them).
- **Every class name must compile.** uniwind skips a name it doesn't know, silently, so
  `tests/ui/class-names.test.ts` reads each one from `src/` (`className`, `*ClassName` props, `cx()`,
  and the maps the primitives keep their looks in) and looks it up in the stylesheet uniwind compiles.
  Write them out in full, in a string, a conditional, a const or such a map: it fails on one it can't
  read.
- **One scheme for everything:** `useScheme()` (`src/theme/scheme.ts`) is uniwind's, which follows the
  system's, or the person's Light or Dark (Settings' Appearance). The navigation theme, the status bar and the root background (`system-bars.tsx`) and the
  colors of SVG icons (`useColors()`) all follow it. uniwind's `setTheme` sets React Native's
  `Appearance` too, so iOS's system colors (below) follow the person's choice.
- **The system's neutrals on iOS** (`src/theme/system-colors.ts`, applied by
  `native-colors.ts`): the page (`screen`, `background`, `sheet`, `header`), its words (`foreground` and
  the other `*-foreground` neutrals), `muted-foreground` and `border` are UIKit's `systemBackground`,
  `label`, `secondaryLabel` and `separator`, through PlatformColor, so Dark, a sheet's elevated
  background and Increase Contrast follow the system as in Apple's apps. `applySystemColors()` points
  their CSS variables at them once, at import in `src/app.tsx`, so every class name in them follows; a
  prop that takes a value asks `useColorValue(token)`. uniwind mixes an opacity class (`/50`) only from a
  hex and keeps a system color whole, so a neutral takes one only where its system color is
  translucent itself (`SYSTEM_OPACITY_CLASSES`); `tests/theme/system-colors.test.ts` reads every class
  name for it. The brand's teal, red, the chat's links and every module tone stay the web's, and under
  Increase Contrast take the stronger variants the generator writes (`increasedContrast` in theme.json,
  7:1 on the page and a card, the same hue), through DynamicColorIOS: `useColorValue` for the accents,
  `useToneColor` for a tone (ToneTile, the tone pills), `Text`'s primary and destructive tones,
  Button's fill and words and AppSymbol's color. Android keeps the web's tokens (Material's surfaces).
- **The primitives** match the web's components (`packages/client/src/components/ui`): `Text` (each
  platform's type, below), `Button` (below), `Field`, `Screen`, `Banner` (info, warning, error),
  `AppSymbol` (below) and `ToneTile` (a module's tone from `theme.json`). Each departs from the web only
  for a phone: 44 pt targets, the pressed state in place of hover, and the keyboard.
- **Icons are SF Symbols on iOS, lucide's on Android** (the owner, 2026-11-18): `AppSymbol`
  (`src/ui/app-symbol.tsx` and `.ios.tsx`, T3 Code's pattern) takes the app's name for an icon
  (`SymbolName`, lucide's own file name: `chevron-right`, `square-pen`), and `src/ui/symbols.ts` says the
  SF Symbol iOS draws for it, through expo-symbols (a monochrome symbol in the box lucide's icon had, at
  the `weight` of the text beside it: semibold in a button and beside a row's Headline chevron,
  medium in a tone tile, regular by default), and `symbol-glyphs.ts` lucide's icon, which Android draws
  (and iOS for the few names SF Symbols 5 lacks, `sf: null`: a robot, H1 to H3, a failed picture). A
  bar's `symbol` and a menu's `MENU_SYMBOLS` name the same symbol for the same thing. Every prop that
  takes an icon (`Button`'s `icon`, `ToneTile`, `EmptyState`'s tile, a swipe action, a bar button)
  takes a `SymbolName`. Only `symbol-glyphs.ts` imports lucide, one module per icon (Metro bundles the
  whole package from its root), and only `app-symbol.ios.tsx` imports expo-symbols (its Android code
  would bundle a Material Symbols font); `tests/ui/symbols.test.ts` checks both, every SF name against
  SF Symbols 5 (iOS 17.4, the deployment target), menus, bars and tabs included, and every lucide file.
  A new icon gets a row in `symbols.ts` and `symbol-glyphs.ts`.
- **Buttons are each platform's own** (`src/ui/button.tsx`, the looks in `button-look.ts`), the
  brand's teal the tint: on iOS 26's capsules, `primary` filled for the main action, `tinted` (the tint
  at 10%), `secondary` gray (`tertiarySystemFill`, the words in the tint), `ghost` plain (the words in
  the tint), `destructive` filled red, dimmed as pressed; on Android Material 3's filled (`primary`,
  `destructive`), tonal (`tinted`), outlined (`secondary`) and text (`ghost`) buttons, with the ripple.
  All are fully rounded, at least 44 pt tall, the words in the `button` role with an SF Symbol at
  their weight. `tests/ui/button-look.test.ts` holds the looks and their contrast.
- **The keyboard on a scrolling screen** (CB-418): a downward swipe hides it (interactive on iOS, on
  drag on Android) and a plain tap in the content never does. Every vertical ScrollView or list of a
  screen with a text field spreads `keyboardScroll(Platform.OS)` (`src/ui/keyboard-scroll.ts`), the
  chat transcript too; `tests/ui/keyboard-scroll.test.ts` reads every screen for it. `Screen` scrolls
  the focused field above the keyboard: UIKit's insets on iOS, keyboard-controller's
  `KeyboardAwareScrollView` on Android, where nothing resizes; a screen under its own
  KeyboardAvoidingView (the first run) passes `keyboardAware={false}`. Only the focused screen follows
  the keyboard (`keyboardFollow`, `useScreenFocused` in `src/navigation/screen-focus.ts`; CB-461): a
  list under a pushed page took the page editor's keyboard too, UIKit shifted it by the keyboard's
  travel, and it came back scrolled under the bar. Focus can't cover a tab switch (CB-462): it is native
  first, and iOS shows Search's keyboard (`tabBarSearchAutoFocus`) about 40 ms before React Navigation's
  blur reaches the tab that was showing, so that tab's scroll view still follows, and React Native's
  `scrollTo` clamps its offset to `contentInset` (not UIKit's adjusted inset), under the bar. So the tab
  roots with no field (Home, Spaces, More) never follow (`TAB_ROOT_KEYBOARD`); Search follows its own. A
  page pushed in a tab that has a field (a Space's "Search pages") still meets it, until React Native's
  clamp is patched. Tapping Search's tab again
  while it shows focuses its field.
- **Segmented controls are the system's**: `SegmentedControl` (`src/ui/segmented-control.tsx`) is
  UISegmentedControl on iOS (@react-native-segmented-control/segmented-control) and Material 3's
  segmented button drawn to its spec on Android (an outlined 40 dp pill, a check on the chosen segment),
  for two to four choices (`SEGMENTED_MAX`): Settings' Appearance, the Board's Board and List, a Space's
  Recent and All pages and its Pages, Memory and Radar, Schedules and Jobs. iOS's segments carry no
  testID, so flows tap their labels. More choices are a menu (`ActionMenu` with `checked`: Runs' filter);
  the Board's status chips and the filter sheet's chips stay (a scrolling column picker with counts, and
  multi-select).
- **Lists**: `Section` (`screens/shell-parts.tsx`) is an inset grouped list: its rows in
  `GroupedCard` (`src/ui/grouped.tsx`) on the system's grouped colors on iOS (`IOS_GROUPED`, by
  `PlatformColor`, so Light, Dark and Increase Contrast follow) and Material's surfaces on Android
  (`ANDROID_GROUPED`), rounded, no border, a `footer` under them. A page that is a grouped list (Settings,
  the socio page, the Spaces, a Space, an issue) is `Screen` with `grouped` (or
  `GroupedRoot` around its own scroll view); a section on another page fills its rows with
  secondarySystemBackground instead. Rows are split by `RowSeparator`, the system's hairline from the
  text (`separatorInset`: 12 pt, past the leading item and its gap), never `border-t`. Chats is a flat
  list: full-width rows on the screen color, as Messages'.
- **Pull to refresh**: `usePullToRefresh(run)` (`src/ui/pull-to-refresh.tsx`) is the system's
  RefreshControl, its spinner up until `run` ends and at least `REFRESH_MIN_MS`; the list never waits for
  it. `useSyncRefresh(collections)` (`src/live`) is the scheduler's `refresh`: Chats (with what needs attention), the
  Board, the Spaces, Approvals, Memories and Activity (the shell) pull their kinds; a Space pulls its pages,
  or reads its tab's radar or memory again.
- **Swipe actions**: `SwipeRow` (`screens/swipe-row.tsx`, gesture-handler's
  ReanimatedSwipeable, as T3 Code's) draws a row's actions toward each edge, the primary nearest it:
  iOS 26's filled circles with the word under them on iOS, Material's full-bleed panes on Android
  (`swipePaneLook`: a 36 pt circle and a Caption 2 word, 54 pt, centered in a 64 pt chat row, CB-454); a
  swipe past `swipeLayout`'s `fullAt` arms the primary with a medium haptic (by the Haptics setting) and
  runs it on release. A drag swipes only past 12 pt sideways (`dragOffsetFromRight` is negative: a
  positive one made every move a swipe, CB-453). A list's rows are one group (`useSwipeGroup`,
  `swipeGroup`), Mail's: one open at a time, a scroll or a tap on another row closes it (the tap only
  closes), and no row swipes while the list scrolls. Only actions the app already has (`src/shell/swipe-actions.ts`):
  a private chat's Delete (red; its own confirm asks) and Archive, a room's Mark read. Board rows have
  none: a status has six targets and is an admin's. The panes are hidden from screen readers; the row's
  accessibility actions say the same actions.
- **A screen with nothing to show** draws `EmptyState` (`src/ui/empty-state.tsx`, the web's EmptyPage and
  LibraryEmpty): a Local (the web's default mascot at its largest drawn size), or a module's tile
  where the web draws an icon, a bold headline, a line, and one action: `useWayBack(route)` (Go back where
  the stack can, else "Back to your socios" to the gate's root) or a primary one (New page). A missing
  page, issue, Space and chat (`chat-missing`, "Conversation not found", the web's `NotFound`) and an
  empty Space use it; a new one does too, never a tile and a muted line of its own.
- **Screen readers:** a Field is one element, its input, named by its label. A message that must be
  said when it shows or changes (a Field's error, a Banner) sets React Native's live region, which only
  Android honors, and is announced on iOS with `useAnnouncement` (`src/ui/use-announcement.ts`).
  A message no view shows has no live region: pass `shown: false` and the hook says it on Android too.
- **Type is each platform's own** (the owner, 2026-11-18; `src/ui/type-scale.ts`): iOS's text
  styles in SF Pro (Large Title 34, Title 1 28, Title 2 22, Title 3 20, Headline 17 semibold, Body 17,
  Callout 16, Subheadline 15, Footnote 13, Caption 1 12, Caption 2 11, with Apple's line heights), and on
  Android the same roles on Material 3's scale (`ANDROID_TEXT_STYLES`: Body is bodyLarge 16, Headline
  titleMedium 16 medium, Subheadline bodyMedium 14, Footnote bodySmall 12, Large Title headlineMedium 28),
  with Material's tracking. iOS tracks SF Pro itself, so the app sets no letterSpacing there. A `Text`
  names a role, never a size (`variant`, the Body by default; there is no `size` or `tracking` prop):
  a text style, or one of the app's (`TEXT_ROLES`): `title` (a large title, 34 bold), `heading` (a
  heading in a screen's content, Title 1 bold), `document-title` (a page's, Title 1 bold), `section` (a
  grouped list's header: a muted Footnote in capitals on iOS, titleSmall on Android), `row-title` (a
  Headline), `chat-title` (the Body), `row-subtitle` (a muted Subheadline), `meta` (a muted Footnote with
  tabular figures, in the system font) and `button`. Rows: a Headline or Body title, a Subheadline or
  Footnote line; meta a Footnote; Menlo (`mono`) only for real code (a command, a diff, a code to type).
  Markdown takes `proseOf(kind, Platform.OS)`: a chat's and an issue's prose the Body at 17/23 (about
  1.35, Messages' and ChatGPT's line), a page's 17/24 with Notes' Title 1 and Title 2 headings;
  Material's bodyLarge on Android. Inputs take the Body (`textMetrics('body', fontScale, Platform.OS)`).
  `tests/ui/type-scale.test.ts` and `type-roles.test.ts` hold the numbers and the screens to them.
- **Dynamic Type:** text scales with the system's text size, never under 12 pt (`TEXT_FLOOR`; Caption 2
  lands on it). iOS's titles stop growing where UIKit stops them at AX5 (`MAX_SCALE`, their
  `maxFontSizeMultiplier`); the rest grow as the Body does. At a font scale of 1.5 or more, rows take a
  minimum height, never a fixed one (`rowMinHeight`).

## Dependencies

The app shares the root's `pnpm-lock.yaml`, which the Effect migration treats as an owned shared file.
So a dependency change is its own PR, coordinated with the migration while it lasts.

- Pick versions with `npx expo install <package>` (Expo's set for SDK 58). Versions are exact.
- Afterwards, `git diff pnpm-lock.yaml` must show no change outside the `apps/mobile` importer and the
  packages only it reaches.
- pnpm links an optional peer whenever any project in the workspace has it. If a new app dependency is
  an optional peer of a server package (as `expo-sqlite` is of `drizzle-orm`), it needs a `"-"`
  override in the root `package.json` (`"drizzle-orm>expo-sqlite": "-"`).
  `tests/integration/apps-isolation.test.ts` fails until it has one: it finds any package the
  server's install reaches only through an optional peer that the app's tree holds, whatever its name.
  `apps/push-relay` has two such overrides too: `@react-router/dev>wrangler` and
  `drizzle-orm>@cloudflare/workers-types` stop the server's install from linking the relay's wrangler
  or workerd (about 152 MB) as optional peers (`docs/TOOLING.md`).
- **The page editor's Tiptap is the web's**: tentap (`@10play/tentap-editor`, with
  `react-native-webview`) asks for `^3.11.0` of each Tiptap package, so the `overrides` in pnpm-workspace.yaml pin
  every one it names to `packages/client`'s version, scoped to tentap
  (`"@10play/tentap-editor>@tiptap/core": "3.31.3"`); a bare override would change the web's install.
  Bump them with the web's Tiptap. `tests/editor-dependencies.test.ts` fails on a Tiptap or ProseMirror
  package tentap reaches off the web's version, a second copy of one, or an unscoped or missing override.
  The editor's bundle (below) builds with the root's Vite and jsdom; no bundler is declared here.
- **Patches** live in the root's `patches/`, listed in the root `package.json`'s
  `patchedDependencies` (pnpm-workspace.yaml) at the exact version the app pins, and every Dockerfile stage that
  installs copies that folder (pnpm reads each patch on every install). A patched package goes in
  `expo.install.exclude`, and a native one in `expo.autolinking.buildFromSource` too, or iOS links
  Expo's prebuilt copy without the patch (`tests/native-config.test.ts`). `vendor/t3code/SYNC.md`
  lists each patch.
- **Forks** are tarballs in `deps/`, each explained in `deps/README.md`. A dependency's install script
  never runs: the root lists it in `pnpm.ignoredBuiltDependencies`, and whatever it would download is
  vendored instead (CI installs with no network).
- `packages/foundation` declares `zod` (the root's range) though it imports none: without it, the
  overrides' fresh resolution gives its `@tanstack/ai` and `@copilotkit/runtime` the zod 3.25.76
  peer instead of 4.6.5. Keep it; the same test fails if a peer outside `apps/` moves off the root's
  version (`docs/TOOLING.md`).

## The page editor's bundle

The page editor runs in a WebView: tentap's advanced setup with the web's own document, built into one
HTML document:

- **`editor/` is the WebView's code,** never Metro's: `index.ts` mounts tentap's `useTenTap` once
  the boot config has come (`boot().whenConfigured`), `extensions.ts` is the web's `documentExtensions()`
  (imported from `packages/client/src/modules/pages/editor/markdown.ts`, never copied) with
  `@tiptap/markdown` and the placeholder, the web's ARIA (`role=textbox`, `aria-multiline`, "Page
  content"), its paste rule (HTML holding `<img|iframe|script>` is refused whole) and `loadMarkdown`, the
  web's path in (`simpleHtmlToMarkdown`, then `setContent` as Markdown, no update, not in the undo
  history, then a fresh `EditorState` on the same plugins, so Undo and Redo start empty on each page
  loaded). `bridges.ts` takes tentap's web side from its source (`@10play/tentap-editor/src/….ts`),
  never `@10play/tentap-editor/web`, which carries a second Tiptap and ProseMirror, and strips
  CoreBridge's Document, Paragraph and Text. `pageEditorOptions` sets `content: ''` over tentap's
  `initialContent` (TipTap would read it as HTML): a page comes only through `socio-load`. The page is
  padded evenly, 16 px on every side. `jitless.ts` goes first (zod would otherwise try `new
  Function`). No bridge sets `extendCSS`. The bridge to native is below.
- **`scripts/build-editor.mts`** builds it with the root's Vite (no watchers) into
  `src/editor/generated/editor-html.ts`: `EDITOR_HTML` (one document, the script and one `<style>`
  inline: TipTap's stylesheet, read under jsdom, then `editor/styles.ts`; the editor runs with
  `injectCSS: false`), `EDITOR_CSP`, `EDITOR_PACKAGES` and `EDITOR_SCHEMA`. The CSP is the document's
  first element in `<head>`: `default-src 'none'`, the script by hash, `style-src` by three hashes (our
  `<style>`, tentap's `DYNAMIC_HEIGHT_CSS` and the empty `<style>` its native side injects), `img-src
  data:`, `base-uri` and `form-action` `'none'`. The build fails on a second copy of any Tiptap,
  ProseMirror or React package, and on tentap's prebuilt `@10play/tentap-editor/web` (its `lib-web/`,
  by name or path: Rollup counts its embedded copies as tentap's, so the copy check can't), and writes every `<` that HTML reads in a script (`</script`,
  `<script`, `<!--`) inside the bundle's literals as `\x3C`. After a change to `editor/`, the web's
  page editor, Tiptap or tentap, run `node apps/mobile/scripts/build-editor.mts` and commit the file;
  `tests/editor/bundle.test.ts` runs its `--check`.
- **Pass `EDITOR_HTML` as RichText's `source`** (`{ html: EDITOR_HTML }`), never `customSource`:
  tentap then injects its boot script from outside the page, where the CSP doesn't reach; a boot
  script inside the page would come before the CSP meta or be refused by it.
- `tests/editor/` holds the document (CSP, one copy, the web's Tiptap versions) and the drift (node and
  mark names, ARIA, paste rule) under Node, and the editor under jsdom (load, read back, edit, undo,
  the atoms' fences, the paste rule).
- **The bridge** is `src/editor/bridge.ts`, imported by both sides
  (zod and plain values only): every message is `{ type: 'socio-…', payload }` in tentap's envelope,
  checked with zod on arrival (`parseToWeb`, `parseToNative`; a bad one is answered `socio-refused`,
  tentap's own pass through) and before sending (`toWeb`). Native → web: `socio-load`, `socio-replace
  { markdown, ifVersion }`, `socio-command` (`EDITOR_COMMANDS`), `socio-link { href }` (the web's
  `LINK_HREF`, null unlinks), `socio-appearance { fontScale, tokens }` (`editorAppearance(scheme,
  fontScale)` in `src/editor/appearance.ts`, sent on open and on each change), `socio-images { id:
  dataURI }`, `socio-images-unavailable { ids }`, `socio-title { title }` (CB-417, after `loaded` and when the draft's title moved) and `socio-flush` (leaving, Android Back). Web → native: `socio-title-change { title }` and `socio-title-shown { shown }` (CB-417), `socio-loaded`, `socio-change`
  (own edits only, at most every `CHANGE_THROTTLE_MS`, 400 ms: the first at once, then the latest at
  the window's end), `socio-images-wanted { ids }` (at most `IMAGES_WANTED_MAX`), `socio-replaced { ifVersion, applied, markdown, version }`, `socio-state` (the
  toolbar's, posted only when it changes: no version, but `unsent` while the throttle holds an edit, which
  leaving waits for), `socio-paste-image { mimeType, dataUri }` (up to `PASTE_IMAGE_MAX_BYTES`; nothing is
  inserted until native answers `socio-insert-image`, shared's `pageImageSchema`, which puts the web's
  `pageImage` block at the selection as an own edit) and `socio-notice` (a refused paste).
- **Versions:** the WebView counts them; each own edit, load and applied replace adds one, and every
  message with Markdown says its version. A load or a replace is never a `change` (`BRIDGE_META` on its
  transaction), and both drop an edit not yet sent, since their answer carries the text.
- **`socio-replace`** (`editor/page-bridge.ts`, `minimalReplace`) applies a merge only while the document
  is still at `ifVersion` (else `applied: false` with the text now, and native merges again), waits
  while an input method composes (until `compositionend` and `view.composing` false; a newer replace
  supersedes the waiting one, and `socio-flush` answers it at once, not applied), and replaces only the changed runs of top-level blocks, each narrowed by
  `findDiffStart`/`findDiffEnd`, with `addToHistory` false: the selection maps through it and Undo
  takes back only the person's own steps. The result must equal a load of the same Markdown, else the
  whole content is replaced.
- **The look** comes through the CSSOM (`--socio-font-scale`, `--color-<token>` on the root; the page's
  `<style>` reads them with the light theme as fallback), which the CSP doesn't govern; the background
  stays transparent. **Pictures** of `image` blocks are drawn by a DOM node view (`page-images.ts`) from
  the data URIs native sends; the schema and the fence written back stay the web's. After each load the
  WebView asks for every picture it doesn't hold, then for each id a transaction brings in
  (`socio-images-wanted`, after `socio-loaded`); one native can't give says the reader's "… isn’t
  available here" (`data-unavailable`). Drawing is never a transaction.
- `tests/editor/bridge.test.ts` runs the WebView's session on a real editor under jsdom, every message
  through JSON and the other side's check. `socio-loaded` carries the web's `inspectMarkdown` verdict on
  what was loaded (`supported`, `reason`), run in the WebView.

## The Markdown round trip

The page editor writes back what the web writes:

- **The goldens are the web's output, never the input.** `tests/editor/web-path.ts` runs RichEditor's own
  path under jsdom (the web's `documentExtensions()`, `@tiptap/markdown`, `simpleHtmlToMarkdown`, then
  `getMarkdown()`; no React views or slash menu, which write nothing). TipTap re-pads tables and adds
  `\n\n` after a last block that isn't a paragraph (StarterKit's trailing node, appended at the first
  transaction) on the web too, so those are in the goldens.
- **The corpus** is `tests/fixtures/pages-corpus/` (every token `inspectMarkdown` allows, lists, tables,
  every fence kind and atom, simple HTML, CRLF, trailing spaces, Unicode, source-mode documents, and
  `*-canonical.md`, the web's own form of the rest). Its bytes are kept: `.gitattributes` marks it `-text`
  and oxfmt skips it. `tests/editor/roundtrip.test.ts` writes the web's answers for each into
  `src/editor/generated/editor-corpus.ts` (`toMatchFileSnapshot`: after a change to the corpus, the web's
  editor, Tiptap or tentap, run it with `-u` and commit), then runs `CorpusRunner` (`src/editor/corpus.ts`)
  on the WebView's session under jsdom: the same bytes and `inspectMarkdown` verdict, no `change` on
  opening, and the web's text after `CORPUS_EDIT_TEXT` is typed at the end (tentap's CoreBridge Focus
  'end' and InsertContent) and after its undo. A document `inspectMarkdown` refuses opens in Markdown
  source on the web and never reaches its rich editor, so the web's path (`tests/editor/web-path.ts`)
  doesn't run it either: its golden is the stored text, and the app is held to the same verdict and no
  `change` on opening, not to its WebView's read-back, which source mode never shows; the test also opens
  each such document in the app's native session (`src/editor/session.ts`) and checks it shows source mode
  with the web's reason and hands the draft no change. The rich editor can't hold these pages: a paragraph
  holding only an image (`source-image-alone.md`) makes TipTap's trailing-node plugin throw ("Called
  contentMatchAt on a node with invalid content"), and one holding only a linked image
  (`source-image-linked.md`) loses the picture, so both are synthetic documents and CI runs that path.
- **A throw is one page's failure, never the run's.** `CorpusRunner` records a document whose driving
  throws as step `threw` (no message) and goes on, as it does a `timeout`; only a runner with no editor
  throws. The browsers' run (`tests/editor/web-path-browser.ts`) and the live run record a throw in the
  web's path as the document's name and `webFailureKind` (`tests/editor/web-path.ts`: a known ProseMirror
  message's kind, else a plain error name, never the message), and the rest still run.
- **The `EditorCorpus` route** (`socio-dev://editor-corpus`, development and preview builds only;
  `screens/editor-corpus.tsx` requires `editor-corpus-run.tsx` lazily, as the editor's screen does) runs
  the same runner in the real WebView with the editor's document and lockdown, and logs one
  `[editor-corpus]` line (the summary and the failures).
- **In browsers:** `node apps/mobile/scripts/roundtrip-browsers.mts [--webkit]` builds the web's path with
  the root's Vite and runs the corpus in Playwright's Chromium (WebKit where the host has its libraries;
  some Linux hosts lack them), every other request aborted. Local only: CI has no browsers.
- **The live corpus** (the smoke account's pages; never committed, never in CI): with
  `SOCIO_PAGES_CORPUS` set to a folder outside the checkout, `scripts/pages-corpus.mts export` signs in
  with the smoke account (User-Agent `research-script/0.1`, nothing else of anyone's), writes each
  readable page as `<spaceId>/<pageId>.md` (0600, the folder 0700), skips and counts a page or Space that
  answers 403 or 404, and signs out in `finally` (a failure throws; the script never `process.exit`s, and its
  words never name the account's email); the round-trip test then runs it too and writes `device-corpus.json`
  (each name a hash of its path). It works out the web's answers page by page: a page `inspectMarkdown`
  refuses goes in as a source-mode document (golden the stored text, `edited` null; the device and the
  browsers check the verdict and no change, as for the synthetic ones), a page whose web path throws
  is recorded with its hash and a sanitized kind (`webFailureKind`), the rest go on into
  `device-corpus.json`, and the test fails at the end listing those
  pages, its summary saying how many the web path couldn't process (none processed writes no payload);
  `pages-corpus.mts push
  android|ios` copies that into the app's documents folder, which the route reads once and deletes before
  it runs; `pages-corpus.mts clean android|ios`, the sequence's last step whatever the run showed (`push`
  says so), deletes the corpus's files on the host and any copy left on the device. The folder
  (`scripts/corpus-folder.mts`) is never the checkout, inside it or above it, home or `/` (by real path);
  export marks it `.socio-pages-corpus` and replaces the last export each time (`scripts/corpus-export.mts`:
  the old pages and `device-corpus.json` go before it asks, and a failed export keeps nothing; the
  round-trip test refuses a folder with no pages and writes no payload), and `clean` refuses a folder without the mark and deletes only
  the pages and `device-corpus.json`, then the mark and the folder once empty, never recursively. On the
  phone only a missing file is "no live corpus": one that can't be read, isn't valid or won't delete fails
  the run (`liveError`, `src/editor/live-corpus.ts`'s words), and so does an unexpected error
  (`runCorpusSession`: its plain name and the documents not compared, never "All N documents match"). A live failure prints
  only the hash and a line number, never text; a synthetic one prints its file and both versions of the
  first differing line.

## The page editor's screen

The `PageEditor` route, no path, pushed from a page's Edit (`pageEditorAction`):
`screens/page-editor.tsx`, view models `src/editor/page-editor.ts`, the native session
`src/editor/session.ts` (both under Node, `tests/editor/`):

- **The screen** (CB-417: Apple Notes' layout): the system's bar (Navigation, above), with Back,
  Markdown source or Visual editor at its end, and in its middle the save line as a small status
  (`EditorBarTitle`), with the page's title on one line above it, clipped, fading in once the
  document's title has scrolled under the bar (`socio-title-shown`, the session's `titleShown`); on
  Android its color moves to `muted` then, as Material's on-scroll container. A save's detail, the
  advanced line and the notice sit under the bar (`UnderBar`). The title is the WebView document's
  own (`editor/page-title.ts`: a `<textarea>` above ProseMirror in one scroll, `.socio-scroll`; Return
  moves on to the text, line breaks fold to a space), so it scrolls away with the text; it travels on
  `socio-title` and `socio-title-change`, never in the Markdown. On iOS the document pads by the bar's
  height and the home indicator while the keyboard is down (`socio-appearance`'s `insets`, also
  ProseMirror's `scrollMargin`), so it starts below the bar and scrolls under it. In source mode the
  title is a native field (`PAGE_TITLE_MAX`, 160) over the source. The body: tentap's WebView
  (`screens/page-editor-webview.tsx`) or, when the web's `inspectMarkdown` says the rich editor can't keep
  the page (`socio-loaded`'s `supported`), Markdown source in a plain field with the web's reason; on
  request any page switches to source (after the WebView's last edit), and back only when the check
  passes, checked again each time Visual editor is asked (a page that opened in required source mode too; text typed in source while the check is out is checked again before the rich editor shows, `session.ts`). In keyboard-controller's `KeyboardAvoidingView`; tentap's own keyboard handling is off
  (`avoidIosKeyboard: false`, no CustomKeyboard, so its Android `stable` mode never applies).
- **Lazy:** only `page-editor-webview.tsx` imports tentap, react-native-webview and `EDITOR_HTML`, and
  only the route's screen reaches it, through a `require` inside `editorWebView()`, so none of it loads at
  launch (`tests/editor/editor-screen.test.ts`).
- **Lockdown** (`src/editor/lockdown.ts`, `EDITOR_LOCKDOWN` spread on RichText): `originWhitelist` only
  `about:blank`, `incognito`, `domStorageEnabled={false}`, no cache, no shared or third-party cookies, no
  file access, windows, geolocation or mixed content; `textZoom` 100, so Android doesn't scale the text
  on top of `socio-appearance`'s `fontScale`. `onShouldStartLoadWithRequest` (`editorRequest`)
  allows only our document; a top-frame web link goes to `useOpenLink`, anything else is refused.
  Sign-out clears every WebView's data (Sign-out, above).
- **Where it starts** (`editorStart`): the editor draft a kill or a dead WebView left (the draft's
  `stored`), else the page's newest queued save (its draft on its base), else a create made on the
  phone still queued (revision 1), else the body on the phone; with none, "Open it once you're online".
  Never on a refused save: the page shows theirs under the conflict banner.
- **The session** opens the page editor's draft on it. Each time tentap says the WebView is ready
  (`useBridgeState().isReady`) it sends the appearance and `socio-load` with the draft's text, and
  ignores everything until `socio-loaded`, so a WebView that came back empty never reaches the draft.
  Each `socio-change` goes to the draft with the title field's; the title field and source mode's
  field write the draft too. A merge's `landed` (the draft's `onReplace`) goes to the bridge's
  `socio-replace` at the version the WebView last told, one at a time (a merge landing while one is out
  waits for its answer, which then sends the draft's newest text: two answers at one version can't be
  told apart); while it is out, changes only update what the WebView holds; an answer not applied (the
  person typed since) is merged again (shared's line merge, from what native last saw) and sent again;
  when that isn't clean the merge wins on screen with a `socio-load` and the person is told
  (`MERGE_CLASHED`): a change made elsewhere is never replaced unseen.
- **Pasting a picture** (CB-358; `src/editor/paste-image.ts` under Node, `screens/page-editor-paste.ts`,
  bound in `src/platform/pasted-image.ts`): the WebView's own paste (`socio-paste-image`, the session's
  `onPasteImage`) and the toolbar's Paste image (ImagePlus, after Add link) both go to
  `addPastedImage`: online only (`PASTE_NEEDS_CONNECTION`, "Pasting images needs a connection"; nothing
  is written, and text keeps saving offline), the picture into a temporary file, the Files upload's
  `add(…, 'image')` (the page image profile; refusals in `FILE_UPLOAD_COPY`'s words), `prepare` (an
  upload with no answer tried at most twice more, each listing by its name first, then `PASTE_FAILED`),
  the server's `POST /api/spaces/:spaceId/images { fileId }` (403 `PASTE_CANT_EDIT`), the uploaded copy
  measured (expo-image-manipulator) for the fence's `width` and `height`, then `forget`. The session's
  `insertImage` sends the picture (`socio-images`) and `socio-insert-image`; the banner says "Adding the
  image…", then why not, or "Saved to your Files" the first time. One paste at a time. Paste image is
  on only while `hasImageAsync` says the clipboard holds an image (no iOS prompt, only the clip's
  description on Android), asked as the editor shows, on each return to `active` and on
  expo-clipboard's change event, never on a timer; `getImageAsync` (PNG) runs only on its tap. A page
  review's draft has no Space: its editor takes no paste (`PASTE_IMAGE_LATER`) and shows no Paste image.
  Android's clipboard image comes as MIME base64 in lines: `cleanDataUri` joins it, or the bridge
  refuses the picture. On the API 36 emulator the WebView's own long-press Paste hands the image to the
  DOM paste event, so no native paste menu is needed there, nor on the iOS 27.2 simulator. Maestro's
  `page-paste-image.yaml` (an image on the clipboard first).
- **A page's own pictures** (`src/editor/pictures.ts` under Node, bound in
  `src/platform/editor-pictures.ts`): the session answers `socio-images-wanted` from the image cache
  (`loadEmbedFile`, kind `embed`, authedFetch: never the WebView, whose CSP and lockdown stay), one
  picture per `socio-images` and one at a time; a kept PNG, JPEG, GIF or WebP within
  `EDITOR_PICTURE_MAX_SIDE` (1600) and 1 MB goes as kept, else expo-image-manipulator scales it to fit
  (PNG stays PNG, else JPEG at 0.8), and one still over `EDITOR_PICTURE_MAX_BYTES` (2 MB), or none
  offline, goes back as `socio-images-unavailable`, asked again when the app is back online
  (`retryPictures`). A new WebView starts it afresh. No change, draft write or undo step
  (`tests/editor/pictures-flow.test.ts`).
- **A dead content process** (`onRenderProcessGone`, `onContentProcessDidTerminate`): tentap's renderer
  recovery mounts a new WebView; the session hears `lost()` (and tentap's ready going false), and loads
  the draft into the new one once ready.
- **Durability:** leaving (Back, Android's back, the gesture: `beforeRemove`) and the background take
  the WebView's last edit first (`socio-flush`, waiting up to `FLUSH_WAIT_MS`), then write the draft
  (`flush`, or `close`, which saves a pending debounce). A replace still out is waited for too (the
  WebView answers one held for an input method at once on flush); if the wait ends first, or the
  WebView dies, the words typed meanwhile are merged into the draft natively (`fold`; a clash keeps
  the change made elsewhere and shows `MERGE_CLASHED`). While typing waits for the draft's debounce
  (`editing`), iOS holds the background grace (`holdEditorGrace`; the grace's one task is held while
  the outbox or the editor holds it).
- **The save line** (the bar's status; `saveLine`, from `outboxStateStore`, which already looks again on
  subscribe): "Couldn't save" for a refused save or conflict of the page, or a draft over the page
  limits (with the web's words); "Saving…" for a row in flight, or one waiting online; "Waiting to
  send" offline, or while writes wait for a sign-in or an update; "Saving…" while typing is in the
  debounce; else "Saved". Advanced mode adds the revision, the queued save's base and its lane
  (`advancedLine`).
- **The toolbar** (`screens/page-editor-toolbar.tsx`, view model `src/editor/toolbar.ts`) is the
  keyboard's accessory bar (CB-417): shown with the rich editor only while the keyboard is up
  (`useKeyboardState`), flush on it in keyboard-controller's `KeyboardStickyView`, the screen's width,
  thin, the system keyboard toolbar's look (`bg-muted`, a hairline above, no capsule or glass); the
  body's `KeyboardAvoidingView` takes the bar's height as `keyboardVerticalOffset`, so the caret never
  hides behind it, and with the keyboard down the page fills the screen. The buttons are the web toolbar's (Bold, Italic, the lists, Quote, Code block, Add link, Undo,
  Redo) with the slash menu's headings 1 to 3 and task list, in a row that scrolls sideways, Undo and
  Redo pinned at its end; each a 44 pt target with the web's label, a toggle's `checked` state and its
  on look from `socio-state` (`toolbarButtons`), a selection haptic (`useTapHaptic`), and the
  session's `command` (sent only while the rich editor holds the page: a command never waits across a
  load; the buttons are off while it doesn't, `EditorView.editable`). Add link opens `TextPrompt` (the URL keyboard; Remove link when the selection has one) with the
  web's rule (`linkInput`: `LINK_HREF`, any case; empty unlinks, so Save takes a blank field when the selection has a link,
  `linkSaveEnabled`; else the web's "Use a public http(s) URL
  or an internal page link."), and writes a link to one of the workspace's pages or Spaces, in any form
  the reader opens (`pageLink`), as `/#/spaces/…`. An image button is still to come.
- Maestro's `page-edit.yaml` (after `space-open.yaml`), `page-edit-offline.yaml` (with the server out of
  reach) and `page-edit-sign-out.yaml` (`--no-workspace-left`, after editing).
- **The reader shows a waiting save** (the page save's overlay): `pageView`'s `pending`, from
  `pendingPageText` over the outbox state store's snapshot (not the live outbox: the React Compiler
  memoizes a call whose inputs don't change, so the reader never saw the row). Words typed offline are in
  the reader after Back; a refused save leaves the server's under the banner.
- **Device checks (2026-11-15, the API 36 emulator and the iOS 27.2 simulator on one local
  server, each behind its own chaos-proxy.mjs; README, Two devices):** two devices on one page, different
  lines and the same line, each order: a clean merge (the toast) or the banner with Unsent 1, Use mine and
  Keep theirs after their confirms, every typed line in the server's copy once; two minutes of offline
  typing sends one save and no page read on each (1 PATCH, 0 GET; the proxy's count); the iOS WebContent
  process killed mid-typing: the editor comes back on its draft, nothing lost; a kill mid-save (the answer
  held) reopens with the text once and no banner, on both; Clear cache keeps a queued save through a cold
  reopen (an edit made while an offline retry has the first in flight is a second queued save: two);
  a hostile page (an image, an image tag, an iframe, a script, a style and links at a listener) opened in
  the reader and the editor on iOS: no request; a page deleted on the web while a save waits: Unsent,
  "This page was deleted"; the tour on Android (Keep offline, the kept Space read in airplane mode, a
  "smoke review" edited and saved; on iOS through the offline reads, the review not reached).
  On iOS, the WKWebView's own Paste (the edit menu, a second tap on a selection) hands the
  picture to the DOM paste event with no paste prompt; it uploads and lands as an `image` block, as on
  Android. Not settled: the toolbar's Paste image on iOS (the flow can't scroll the toolbar's row there).
  Not run: a page moved elsewhere with a queued save (`$A web-page-move`, then `page-two-settle.yaml`),
  `pages-large-text.yaml` (written), iOS's sign-out listing after editing (`page-edit-sign-out.yaml`
  stopped on its own typing before the sign-out; no listing before it showed a WebView's data), and a
  merge during Japanese IME composition (Maestro types past the input method; left for a hands-on
  session).
- **The Spaces list's attention section on devices** (2026-11-20, `spaces-attention.yaml` after
  `page-two-offline.yaml` and `$A web-page-write` on the same line, the API 36 emulator and the iOS 27.2
  simulator): the page leads the Spaces list under "Pages changed elsewhere", the Spaces tab's badge says 1,
  its row opens the page under the conflict banner in the Spaces tab, and Chats shows neither the section
  nor a badge. iOS's bar Edit carries no testID (CB-420), so `page-two-offline.yaml` taps it by its label
  there.

## Checks

From this folder, or from the root with `pnpm --filter @socio/mobile <script>`:

- `pnpm run typecheck`: TypeScript 7.1, the root's.
- `pnpm run lint`: oxlint, with the root's config.
- `pnpm test`: Vitest (`tests/`).
- `pnpm run build`: an offline `expo export` of the Android and iOS bundles into `dist/`, which checks
  that Metro can bundle the app.

The root's `pnpm run check` typechecks and lints the app with everything else, and
`node scripts/turbo.mjs check|test|build` (so CI too) runs all four as the `@socio/mobile` package
tasks (`turbo.json`). Format with the root's `pnpm run format`.
