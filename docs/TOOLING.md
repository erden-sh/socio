# Tooling: oxc and TypeScript 7

Socio lints with **oxlint**, formats with **oxfmt** and type-checks with
**TypeScript 7.1** (the native compiler, called tsgo during its preview).
ESLint and Prettier were removed in CB-311. `pnpm run check` runs all three
in parallel (`scripts/check.mjs`). CI runs the same work as cached tasks, below.

| Step       | Before                 | Now                                      |
| ---------- | ---------------------- | ---------------------------------------- |
| Lint       | ESLint, 37.5 s         | oxlint, about 2 s                        |
| Format     | Prettier, 47 s         | oxfmt, about 1.5 s                       |
| Type-check | TypeScript 6.0.3, 60 s | TypeScript 7.1, about 6 s cold, 1 s warm |
| `check`    | sequential, over 2 min | parallel, about 7 s                      |

Measured on node-1, a development workstation, 2026-10-31.

`pnpm run typecheck` (`scripts/typecheck.mjs`) runs one `tsc` per project at
once and prints each one's time: `root` (the server, services and server tests,
and no client file), `mixed` (`tests/integration` and the client files they
reach), `client` (`packages/client`, with its own `tsconfig.json`: ESNext and
Bundler, because it is bundled), `shared`, `foundation` and `data` (each
`packages/<name>`, NodeNext), `plugin-ui`, `app-sdk` and `mobile` (`apps/mobile`,
the native app, Bundler).

## The task graph (Turborepo)

`pnpm run check:cached`, `test:cached` and `build:cached` run the same work as
`check`, `test` and `build`, as separate tasks with declared inputs (`turbo.json`
and each package's). A task whose inputs haven't changed replays its result.

| On node-1, load 15-40, 2026-11-04 | Plain | Cached, cold | No change | Client edit | Server edit | Docs edit |
| --------------------------------- | ----- | ------------ | --------- | ----------- | ----------- | --------- |
| check                             | 15 s  | 15 s         | 0.2 s     | 6 s         | 6 s         | 1.3 s     |
| tests                             | 231 s | 278 s        | 0.2 s     | 115 s       | 233 s       | 0.2 s     |
| build                             | 33 s  | 22 s         | 0.5 s     | 22 s        | 13 s        | 0.7 s     |

A cold run of the tests is slower than `pnpm test`: the buckets run one at a time,
so a slow file in one can't share the machine with the next. It pays that once.

| Bucket   | Where                                                               | Reruns on                                                 |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| `server` | `tests/`, and `packages/foundation/tests` and `packages/data/tests` | the server, services, deployment files, the docs it reads |
| `mixed`  | `tests/integration`                                                 | anything the other two rerun on, and the built pages      |
| `client` | `packages/client/tests`                                             | the client, `public/`, and the opt-out its setup loads    |

Everything else in the graph is scoped the same way: oxlint per package, one
`tsc` per project, and the build as pages, the workspace packages
(`scripts/build-packages.mjs`), server and release data.
`tests/integration/turbo.test.ts` changes one file of each kind in a copy of the
repository and checks exactly which tasks move.

**A false hit is the worst thing that can happen here**: it turns a broken branch
green. So inputs are everything git tracks minus named exclusions, never a list
of what looks relevant, and what the excluded files are comes from tracing every
test's file reads with `strace`, not from reading the tests. Tests read a lot by
string: `docs/RELEASE-NOTES.md`, `deployment/`,
`compose*.yml`, the `Dockerfile`, `.github/`, `content/`, `public/` and `scripts/`
are all inputs. Tests that need something excluded are caught by
`scripts/check-test-buckets.mjs`.

**The native app is a workspace member, and the root's own tasks leave it out.** `apps/mobile`
is a member of the root pnpm workspace and shares its one lockfile. It has its own package tasks
(`apps/mobile/turbo.json`: typecheck, lint, test, and build as an offline `expo export`), which
`check`, `test` and `build` run as they run each package's. `pnpm run lint` and
`pnpm run typecheck` name it as they name the packages; `lint:root` and `typecheck:root` don't.
Turbo would hash a member's files into a root task's `$TURBO_DEFAULT$` like any other file, so
every root task but `//#check-format` still excludes `apps/mobile`, `apps/push-relay`,
`apps/link` (the link domain's Worker) and `apps/site` (the public site at socio.sh) by name.
A change to the app's source reruns the format check and the app's own tasks, and a change to
`packages/shared/src` reaches the app's typecheck, test and build. An app nobody listed is hashed
like any other file: that costs a rerun, never a stale green. The app's `package.json` and
`turbo.json` are global dependencies, because `tests/integration/apps-isolation.test.ts` reads them.

An app dependency change rewrites `pnpm-lock.yaml`, a global dependency, so it reruns every cached
task. pnpm links an optional peer whenever any project in the workspace has it, so five `"-"`
overrides in `package.json` keep the app's and the push relay's packages out of the server's
install:

- `vite>terser`: Metro brings terser.
- `@vitejs/plugin-react>babel-plugin-react-compiler`: Expo's Babel preset brings the compiler.
- `drizzle-orm>expo-sqlite`: for when the app adds `expo-sqlite`.
- `@react-router/dev>wrangler` and `drizzle-orm>@cloudflare/workers-types`: `apps/push-relay` has
  wrangler and the Workers types, both optional peers of server packages. Without these two, the
  server's install would link the relay's wrangler and its workerd (about 152 MB) as optional peers.
  `apps/link` and `apps/site` pin the same two versions, so each adds no package to the lockfile,
  only its importer. `apps/site` builds with the root's Vite, Tailwind and lucide-react.
  They only change those two server packages' peer metadata in the lockfile, so don't drop them as
  unused.

A sixth, `react-native-enriched-markdown>katex`, works the other way: it keeps the workspace's
`katex` out of the app (`apps/mobile/deps/README.md`).

The overrides change how pnpm resolves, and a fresh resolution gives `packages/foundation`'s
`@tanstack/ai` and `@copilotkit/runtime` the zod 3.25.76 peer instead of main's 4.6.5 (main's
lockfile with the overrides alone does it too). So foundation declares `zod` as a dev dependency at
the root's range, which holds 4.6.5; it imports no zod itself, so don't drop it as unused. With
these, every other importer resolves as it did before the app joined, and the images install the
same packages.

`tests/integration/apps-isolation.test.ts` checks the lockfile three ways. It fails when the server's
install (every importer outside `apps/`) reaches a package only through an optional peer and the
app's own tree holds that package, whatever its name; when the server reaches React Native, Expo,
Metro, Hermes or React Navigation by any route; and when a peer resolved in an importer outside
`apps/` has another version than the root's own dependency on that package. A new app dependency
that is an optional peer of a server package needs a `"-"` override like these; the first check
fails until it has one.

The root suite never runs the apps' tests, no image holds them (`.dockerignore`), and a test that
names a file under them is caught like one that names an excluded doc
(`scripts/check-test-buckets.mjs`). The push relay doesn't exist yet: it joins the workspace when
it does. The apps format with the root's `.oxfmtrc.json`. The root's `format` and `check-format`
run with `--disable-nested-config`, because oxfmt would otherwise read an app's own config instead,
and drop the root's ignores there. Their release tags carry a prefix (`mobile-v*`,
`push-relay-v*`), because a bare `v*` tag publishes the server's images.

Things that also rerun everything: the lockfile, any manifest, any `tsconfig` but the app's,
Vitest, Vite and oxlint config, `tests/setup/`, `.github/ci/`, the Node version,
and `@socio/shared`, `@socio/foundation`, `@socio/data` or `@socio/plugin-ui`. Turbo puts the files of the root's
workspace dependencies in its global hash, and there is no setting for it.

- **`scripts/turbo.mjs` is the only way in.** It sets `TURBO_TELEMETRY_DISABLED=1`,
  `DO_NOT_TRACK=1` and the update opt-outs, drops every other `TURBO_*` variable,
  and passes `--cache=local:rw`. `turbo.json` can't turn telemetry off. `envMode:
  strict` hides everything else from tasks, API keys included. There is no
  daemon: 2.x doesn't start one for `turbo run`, and its setting is deprecated.
- **The local cache** is `~/.cache/socio/turbo`, shared by worktrees.
- **In CI** a push to `main` writes the cache and never reads it; a pull request
  reads it and never saves (`.github/ci/turbo.sh`, SECURITY.md).
- **What isn't in the graph:** the UI smoke always runs for real. `releases.json`
  holds the commit, so that one step is never cached. A cached result doesn't
  rerun a flaky or date-dependent test: `pnpm test` does.

## TypeScript 7.1 evaluation (CB-311)

The question was whether the 7.1 beta can replace 6.0.3 now. Reporting
different issues than 6 was acceptable, as long as each one could be
handled. The beta was adopted (`typescript@7.1.0-beta`).

- **Emit:** the server build (`tsc -p tsconfig.server.json`) is byte-identical
  to 6.0.3's across all 958 emitted files. The output that ships is the same.
- **Diagnostics:** one difference, in `packages/client/src/modules/rooms/PeopleMentions.tsx`.
  7.1 inferred a narrower element type for a merged candidate list and
  rejected a later push. An explicit `MentionCandidate[]` annotation fixed it.
  The annotation is correct under both versions. No other new errors, and
  nothing 6 reported was lost.
- **Speed:** a cold check takes about 6 s instead of 60 s. Incremental checks
  (`--incremental`, with `node_modules/.cache/tsc`) take about 1 s.
- **Editors:** the editor's TypeScript can stay on its bundled version. The
  repo only needs `tsc` from `node_modules`.
- **Risk and rollback:** it's a beta, pinned exactly. To go back, set
  `"typescript": "6.0.3"` in `package.json` and run `pnpm install`. Nothing
  else in the repo depends on 7.x. Revisit when 7.1 is stable.

## oxlint

The config is `.oxlintrc.json`:

- The correctness category is an error.
- It turns on the TypeScript-recommended rules ESLint ran.
- It keeps the client/server and Drizzle import boundaries (type imports
  allowed).
- `react/rules-of-hooks` and `react/exhaustive-deps` are errors. The 22
  exhaustive-deps findings were triaged in 6d42ae6c. Each deliberate
  trigger-only effect carries an `oxlint-disable-next-line` comment that says
  why.
- Socio's locale and Hermes rules run as a JS plugin (`scripts/lint/socio-rules.mjs`).
- The native app's rules sit in overrides. `socio/hermes` (APIs Hermes lacks) covers `apps/mobile/**`
  and `packages/shared/src/**`, so shared's own lint task enforces it. In `apps/mobile/src/**`, the
  global `fetch` and `expo/fetch` are banned outside `src/platform/fetch.ts`, though a type may come
  from `expo/fetch`. `apps/mobile/**` may import no Effect. `apps/*/vendor/**` isn't linted.
  `apps/mobile/tests/lint-rules.test.ts` runs these rules on fixtures.
- React Compiler rules are off. Only the native app compiles with the compiler, and its coverage
  test (`apps/mobile/tests/react-compiler.test.ts`) guards that.
- `unicorn/no-useless-spread` is off, because copying a collection before
  mutating it is deliberate here.

## oxfmt

The config is `.oxfmtrc.json`, in the Erden style since formatting stage 1 (`dba87556`, 2026-11-01):

- 4 spaces, 120 columns, single quotes, semicolons, trailing commas, LF line endings.
- **Imports are sorted into groups**, with a blank line between groups: Node builtins, external packages, the workspace's own `@socio/**` packages, parent paths, then siblings and index, then anything unknown. Side-effect imports keep their place. The groups make imports easy to scan in the human reviews that matter. A `@socio/**` import has no extension, even inside `src/`, and a side-effect import that must stay first (`@socio/foundation/no-vendor-telemetry`) keeps its place.
- **YAML stays at 2 spaces** (an override). Tests read the stack files as text, and YAML gains nothing from wider indentation.
- `marketing/` and `.vscode/` aren't formatted, nor are `apps/*/vendor`, the native app's generated `ios/`, `android/`, `.expo/` and `deps/`, and the push relay's `worker-configuration.d.ts`.
- Tests that format code use oxfmt's API through `tests/support/format.ts`, which applies the config's overrides itself, because the API ignores them.

**Blame:** the stage 1 commit is listed in `.git-blame-ignore-revs`. Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once per clone. List any future mechanical reformat there too.

**Two lint rules came with stage 1,** both autofixed by `oxlint --fix`:

- `curly: all`: braces on every `if`, `else`, `for` and `while` body.
- `import/newline-after-import`: at least one blank line after the imports.
    - It runs with `considerComments` and `exactCount` **off**. oxfmt 0.75's import sorting removes the blank line between the last import and a doc comment right after it. With either option on, the formatter and the rule undo each other.
    - The formatter already caps blank lines at one, so "at least one" is enough.
