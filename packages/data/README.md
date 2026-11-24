# @socio/data

Socio's SQLite layer: everything a store needs below its own repositories, and nothing about what any store holds.

| Subpath                                  | What                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `open`, `sqlite-pragmas`                 | Opening the database, and the pragmas each connection gets                           |
| `uow`, `mutex`, `events`                 | The unit of work and its lock, and events delivered after a commit                   |
| `columns.sqlite`, `soft-delete`, `drift` | Drizzle column helpers, soft-delete filters, schema drift checks                     |
| `migrate`, `contract`                    | The migration runner and the contract baseline (`modules/boot.ts` runs it)           |
| `backup`                                 | SQLite backups: the migration runner takes one before it changes anything            |
| `object-store`                           | The object store's interface, which a backup can include                             |
| `infra/sqlite/*`                         | Tables the two above use: the migration ledger, and the runtime rows a backup copies |

`docs/DATA-LAYER.md` has the rules for using it.

## Rules

- It imports itself, Node built-ins and what its `package.json` declares (`scripts/check-package-boundary.mjs`, run by `tests/integration/package-boundaries.test.ts`). Nothing from `src/` or from another workspace package.
- It uses `node:sqlite`, and Drizzle only as the lint rule allows: `packages/data/**` and a context's `infra/` folder.
- `drizzle-orm` stays in the root `dependencies` at the same range, because images install only the root manifest (the guard checks this).
- There's no barrel: import a subpath, with no extension, such as `@socio/data/open`. Inside the package, use relative imports with `.js` extensions.
- A migration runs only in the boot step: `tests/migration-boundary.test.ts` walks this package as well.

`packages/shared/README.md` explains how `@socio/...` resolves in each place.
