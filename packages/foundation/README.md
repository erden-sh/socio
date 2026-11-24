# @socio/foundation

The server's lowest layer with no database. It is here so that the separate services (`updater`, `apps-runtime`, `coding-git`, `coding-egress`, `app-browser`) need nothing from `src/server`, and so that a change above it doesn't invalidate its checks.

| Subpath                          | What                                                                             | Used by                                                  |
| -------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `no-vendor-telemetry`            | The telemetry opt-out. Must stay the first import wherever it is imported        | the server, `updater`, `apps-runtime`                    |
| `keys/secret-files`              | Reads `*_FILE` settings, with no dependencies                                    | the server and the services                              |
| `keys/load-secret-files`         | The same as a side-effect import, early in an entry                              | the server's entries                                     |
| `keys/data-keys`, `key-input`    | Data keys and reading one from stdin                                             | the server and its CLIs                                  |
| `keys/secret-box`                | Sealing and opening with those keys                                              | the server                                               |
| `actors/keys`, `actors/redact`   | Socio's token and actor keys, and redaction by token shape                       | the server, `coding-git`, `coding-egress`, `app-browser` |
| `apps/bundle`, `apps/log-redact` | App bundles, and redacting an app's log lines                                    | the server, `apps-runtime`                               |
| `http/*`                         | Middleware and trust rules that don't know the app: headers, compression, hosts  | the server                                               |
| `http/app-env`                   | Types only: the Hono environment of API routes and the scopes it carries         | the server                                               |
| `observability/*`                | Failure text and kinds, the OTLP exporter, the stall monitor                     | the server                                               |
| `turns/*`                        | The turn vocabulary: `DotTurn` and its types, and messages as a model reads them | the server                                               |

## Rules

- It imports itself, Node built-ins, `@socio/shared` and what its `package.json` declares (`scripts/check-package-boundary.mjs`, run by `tests/integration/package-boundaries.test.ts`). Nothing from `src/` or from another package above it.
- There's no barrel: import a subpath, with no extension, such as `@socio/foundation/keys/secret-files`. Inside the package, use relative imports with `.js` extensions.
- `coding-git` and `coding-egress` ship no `node_modules`, so what they reach can't load a third-party module. The guard walks their run-time imports and fails if it does. `hono` and `@ag-ui/core` are here for `http/` and `observability/`, which those services don't import. `@ag-ui/client`, `@copilotkit/runtime` and `@tanstack/ai` are dev dependencies: only types are imported from them (`import type`), so nothing loads them at run time.
- A third-party package it loads at run time stays in the root `dependencies` at the same range, because images install only the root manifest (`dist/server/node_modules/@socio/foundation` resolves upward to `/app/node_modules`). The guard checks this too.

`packages/shared/README.md` explains how `@socio/...` resolves in each place.
