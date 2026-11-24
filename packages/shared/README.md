# @socio/shared

Code and types shared by Socio's server, client and services. It imports nothing from the app, and only the third-party packages its `package.json` declares (`scripts/check-package-boundary.mjs`, run by `tests/integration/shared-package.test.ts`).

Import it by subpath, with no extension: `@socio/shared/rooms/rooms`. Inside the package, use relative imports with `.js` extensions; its `tsconfig.json` is `NodeNext`, so a missing one fails `pnpm run check`.

## How `@socio/shared/...` resolves

The same goes for every package that builds to `dist` (`@socio/foundation`, `@socio/data`), with `<name>` for `shared` below.

| Who                                                   | Through                                                                                    | Gets                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `pnpm run check`, editors                             | `paths` in the root `tsconfig.json`                                                        | source                                                      |
| tsx (`pnpm run dev`, scripts, tests' child processes) | the same `paths`, which tsx reads                                                          | source                                                      |
| esbuild (the browser-check scripts)                   | the same `paths`, which esbuild reads                                                      | source                                                      |
| Vite and Vitest                                       | `resolve.alias` in `vite.config.ts`, `vitest.shared.ts` and `scripts/build-planner-ui.mjs` | source, bundled into the client and SSR builds              |
| `tsc -p tsconfig.server.json`                         | the workspace link and `exports` (`paths` is emptied there)                                | `dist/*.d.ts`; the specifier stays as written in the output |
| `node dist/server/...`                                | `dist/server/node_modules/@socio/<name>` and `exports`                                     | `dist/*.js`, no TypeScript loader                           |
| plain `node scripts/...`                              | the workspace link and `exports`                                                           | `packages/<name>/dist/*.js`, after a build                  |

`pnpm run build` writes both built copies (`scripts/build-packages.mjs`, lowest package first). Dev and tests need no build. The copy under `dist/server` means every image stage that copies `dist/server` has the package, with no line of its own; that includes `coding-git` and `coding-egress`, which ship no dependencies.

A package with a lower workspace dependency has two configs: `tsconfig.json` reads that dependency's source through `paths`, so `pnpm run typecheck` needs no build, and `tsconfig.build.json` empties `paths` and reads its `dist`, as the server's build does. Both are `NodeNext`.

A third-party import in a built package walks up from `dist/server/node_modules/@socio/<name>` to `/app/node_modules`, which holds what the root manifest installs. So what a package loads at run time must be in the root's `dependencies` at the same range (`scripts/check-package-boundary.mjs`).
