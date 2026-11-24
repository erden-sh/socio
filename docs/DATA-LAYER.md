# Data layer (CB-110)

The app's own tables share one `node:sqlite` connection: the core store, the workspace and the repositories (`packages/data/src/open.ts`). Writes on it go through one unit of work (`packages/data/src/uow.ts`): a FIFO lock, `BEGIN IMMEDIATE`, the work, `COMMIT` or `ROLLBACK`, then the `afterCommit` effects. New code uses Drizzle repositories inside `uow.run` (the Board, `src/server/issues/infra/`); older code runs raw SQL on the same connection.

A unit's body awaits, so other async work ready in the same turn of the event loop (parallel tool calls in one model step, a `Promise.all`, work started with `void`) runs while it is open, on the same connection. A plain write from that work would land inside the unit and commit or roll back with it. In tests a connection guard makes such a write fail; in production it joins the unit and is reported if the unit rolls back.

## The rule for new code

On the shared connection, every write from an async path (a route, a tool, a listener, a timer, a background run) goes through one of:

- **`transaction(db, label, work)`**: the writes as one transaction, at once when the connection is free, else queued behind the open unit. Await it. Use it whenever the caller reads the result back, or the writes must stay together (read, check, write).
- **`writeSoon(db, label, work)`**: for a record nothing reads back at once (an audit row, a usage stamp, an outcome). It runs at once when it can, else queues in order without making the caller wait; a queued one that fails is logged.
- **a repository inside `uow.run`**, for code on the new data layer.

Never a bare `.prepare('INSERT …').run()` (or `UPDATE`, `DELETE`) on an async path. `transactionSync` is for callers that can't wait; it throws while another chain's unit is open instead of joining it.

Prepare statements inside the callback: the guard checks a statement when it is prepared, so one prepared before a unit opened and run during it is not seen.

## Listeners and background work

A listener or `afterCommit` effect that starts work of its own (one the publisher doesn't await: auto-triage, a cancel, a follow-up notice) waits for `nextTurn()` (`packages/data/src/events.ts`) before opening a unit, so the unit never opens in the turn that carries on with the publisher's caller, such as the model step's next tool call.

## Two app versions on one database (CB-108)

A deploy runs the new release beside the old one for a while (start-first): two processes, on one host, on one database file. SQLite's file lock lets one write transaction run at a time across both (each waits up to `busy_timeout`, 5 s), so they can't corrupt the file. What keeps them from stepping on each other's work is ownership, in the `runtime` tables (`packages/data/src/runtime-ownership.ts`):

- Each process is a runtime with a heartbeat (`runtime_instances`). Work that must have one owner (a turn, a job run, the leader's singleton work) is claimed as a lease with an epoch that only grows (`runtime_leases`, `runtime_work`), in the same transaction as the row it creates. The owner's writes to it are fenced: `guarded()` checks the lease inside the writer transaction, so a process that lost it writes nothing.
- Recovery that treats work left running as a dead process's (closing open turns, job runs, continuations) touches only work whose owner is released or expired, or waits until no other runtime is alive (`Platform.succeed()`).
- Anything a request on one process hands to a later request, which may reach the other process, lives in the database, not in process memory: sessions, data tokens (by hash, bound to the issuing runtime), launch codes, stop requests (`runtime_signals`), socio grants and their credentials (by hash, bound to the work that holds them, not to the issuing runtime, CB-232). Process memory is a cache only.
- A check that only some releases enforce is a contract (`runtime_contracts`): each runtime records the version it enforces, and work that relies on every runtime enforcing it waits while a live one records an older version or none (`RuntimeOwnership.contractBehind`: CB-232's actor access; CB-181's `space-privacy`, without which no Space is made private).

### One boot step migrates

`bootDatabase` (`src/server/modules/boot.ts`) migrates the app's database before anything opens it, in every process that writes to it: the server and the auth CLI. Constructors take a database that is already migrated and never migrate one themselves, so a process that skipped boot fails at once with `no such table` rather than half-migrating. `tests/migration-boundary.test.ts` fails on a `migrate(` anywhere else.

The registry's sets (`modules/index.ts`) always run. Bundled plugins' sets are conditional: boot runs those of the plugins this database has installed, and installing one runs its set at that moment (`plugins/plugin-schemas.ts`), the one migration that happens after boot. Other processes read the database (analytics, the restore drill, the classify eval) and don't migrate it.

Tests start from a template: Vitest's global setup runs the real migrations once per run, and `testDatabase()` / `testDatabaseFile(path)` (`tests/helpers/test-database.ts`) copy the result. Restart watch mode after editing a migration. Tests of the migrations themselves still run them, from nothing and from an older ledger (`tests/test-database.test.ts`, `tests/migrations.test.ts`).

### Migrations both versions run on

The old release keeps running on the schema the new one migrated, until it exits. So each migration is one of:

- **expand** (the default): it only adds. New tables; new columns that are nullable or have a default; indexes that aren't unique on existing data; backfills. Code of the same release must cope with rows the previous release still writes without the new column. Keep each one short on production data: it holds the write lock while the old release serves.
- **contract** (`phase: 'contract'`): it removes or tightens: a DROP or RENAME, deleting rows, a unique index or a refusing trigger on existing data. It ships at least one release after the code stopped using what it removes, and names `readersFrom`, the oldest version of its module a build must know to run on the result (recorded in `schema_readers`; an older build refuses to start). A release with one deploys stop-first when the running release is older than that: say so under Upgrading in its notes.

To rename a column, then: release N adds the new column and writes both (expand), release N+1 reads only the new one, release N+2 drops the old one (contract, `readersFrom` N+1's version).

An older build boots on a newer schema when every migration it doesn't know is above `CONTRACT_BASELINE` (`packages/data/src/contract.ts`, the migrations from before this rule) and `schema_readers` allows it; builds from before this rule refuse any newer schema. The change counters' triggers follow the newest build that booted: removing a watched key is a contract change too.

## Checks

- **`tests/tool-interleaving-sweep.test.ts`** runs every socio tool that writes alongside a Board write, at several microtask offsets, both ways round, in strict and production mode, and with a Board unit that throws. A new socio tool gets registered there: as a writer if it writes, or in `NOT_SWEPT` with the reason. The sweep fails on a registered tool that is in neither. Each Board writer is its own test (listed by name in `BOARD`), on a fresh platform made from a copy of a once-migrated database, so a new tool lengthens every test a little instead of one test a lot.
- **`tests/migration-contract.test.ts`** checks every migration above `CONTRACT_BASELINE`: an expand one may not DROP, RENAME, DELETE FROM, add a unique index or a RAISE trigger (unless it says why it is `compatible`), and a contract one must name `readersFrom`. It also checks that an older build runs on an expanded schema and refuses a contracted one.
- **`tests/integration/plain-writes.test.ts`** counts `.prepare(` calls with `INSERT`, `UPDATE`, `DELETE` or `REPLACE` per file, outside the `infra/` repositories. A new one fails it until the file's count is raised, so a reviewer sees it: route it through `transaction()` or `writeSoon` first. Lower a count when writes go.
