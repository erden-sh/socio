# @socio/client

Socio's React client: the pages React Router renders on the server, inside the Hono app, and hydrates in the browser. Nothing imports it as a package; the build takes it as React Router's `appDirectory`, and the server loads the result from `dist/web` (or, in development, through Vite).

It can't reach server code or the service directories, in source or tests, by any route: imports, mocks, globs, or paths in strings (`scripts/check-client-boundary.mjs`, run by `tests/integration/client-package.test.ts`). It talks to the server over HTTP.

## Working here

From the repository root, as ever: `pnpm run dev`, `pnpm run build`, `pnpm run check`, `pnpm test`. In this directory, `pnpm test` runs the client's tests alone and `pnpm run typecheck` checks it alone.

Tests that touch only the client go in `tests/` here. A test that also touches the server goes in the root's `tests/integration`, and can import this package's source and helpers by relative path (never the other way round). Read files by location (`join(import.meta.dirname, '../src/globals.css')`), since tests run from either directory.

## How `@/...` and the package resolve

| Who                                                                     | Through                                                                                               | Gets                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `react-router build`, `pnpm run dev` (Vite)                             | `appDirectory` in the root's `react-router.config.ts`; `resolve.alias` in the root's `vite.config.ts` | source, bundled to `dist/web`                      |
| Vitest, from the root or here                                           | `resolve.alias` in the root's `vitest.shared.ts`, which both `vitest.config.ts` files use             | source                                             |
| `tsc -p packages/client/tsconfig.json`                                  | `paths` here: `@/*` is `./src/*`; ESNext and Bundler resolution, since this code is bundled           | source and tests here, plus what they import       |
| `tsc -p tests/integration`, `tsc -p packages/plugin-ui`                 | `paths` in the root's `tsconfig.json`                                                                 | the client files they reach, not the whole package |
| the planner UI build                                                    | `resolve.alias` in `scripts/build-planner-ui.mjs`                                                     | source                                             |
| esbuild (the browser-check scripts)                                     | each script's `alias`                                                                                 | source                                             |
| `@copilotkit/web-inspector`, in all of the above that bundle CopilotKit | an alias to `src/no-web-inspector.ts`                                                                 | the stub; SECURITY.md, "Vendor telemetry"          |

Vite and React Router's config stay at the root. Vite's root is the repository: the server embeds Vite in development from its own working directory, `public/` and `dist/web` are there, and CopilotKit's bundled code resolves its own imports from the root's top level (`vite.config.ts`). The tooling has to be in the root's manifest anyway, for the reason below.

## Dependencies: declare them here and at the root

`package.json` declares what this package imports, because pnpm's layout enforces it. **Add every new one to the root's `package.json` too, at the same range.**

The root `Dockerfile`'s `build` and `prod-deps` stages install from the root manifest alone (they copy no `pnpm-workspace.yaml`), so in an image this directory has no `node_modules` and resolves from `/app/node_modules`:

- `dependencies` here must be root `dependencies`. The pages' server build loads packages at run time, and images hold production dependencies only.
- `devDependencies` here must be in the root's manifest, in either section, or the image's build can't find them.

The root's `dependencies` list more than this manifest: the server build also loads packages this source doesn't name, such as those of the bundled `@copilotkit/react-core`.

Three checks keep that true:

- `tests/integration/client-package.test.ts` compares the manifests, and the versions in `pnpm-lock.yaml` (one version of each package, or React contexts split in two).
- `scripts/check-ssr-deps.mjs`, in `pnpm run build`, reads what the built server chunks really import.
- The app image's build loads `dist/web/server/index.js`.
