# Agent instructions for Socio

Socio is a team workspace with AI socios: Node 26.13.0, Hono, React Router 8 (SSR), SQLite (`node:sqlite`), Effect 4.1.5, React 19, Tailwind v4, pnpm 10.15 workspaces, Vitest and TypeScript 7.1.

## Map

- `src/server/<feature>/`: server features, wired by `src/server/composition/`; the entry is `main.ts`.
- `packages/`: `client` (the web client), `shared` (code for server and clients), `foundation` and `data` (the server's base layer and SQLite layer), `plugin-ui` and `app-sdk` (for plugin and mini apps).
- `apps/`: `mobile` (Expo; its own `AGENTS.md` adds rules), and Cloudflare Workers `site` (socio.sh), `link` and `push-relay`.
- `tests/` (server), `tests/integration/` (tests that reach the client), `packages/client/tests`.
- `deployment/`, `Dockerfile`, `.docker/` (compose: `docker compose --env-file .env -f .docker/compose.yml ...`).
- `vendor/`: vendored upstream code and the no-op telemetry stand-ins.
- `docs/`: `SETUP.md` (every setting), `TOOLING.md`, `DATA-LAYER.md`, `RELEASING.md`.

## Run, check, test

```sh
pnpm install --frozen-lockfile
cp .env.example .env              # set OPENAI_BASE_URL and OPENAI_MODEL
pnpm run dev                      # http://127.0.0.1:4310, sign in as alice or bob
pnpm run check                    # oxfmt --check, oxlint, tsc for every project
pnpm test                         # Vitest: the server, mixed and client projects
pnpm exec vitest run <file>...    # some test files
pnpm --filter @socio/mobile test  # an app's tests (also @socio/site, link, push-relay)
pnpm run build                    # the production build
```

`check:cached`, `test:cached` and `build:cached` run the same through Turborepo and skip what a change can't affect; `test:cached` includes the apps' tests. Run Turborepo only through `node scripts/turbo.mjs`, which keeps its telemetry off. `pnpm run format` fixes formatting. Before you push, run `check` and the full suite.

## Enforced conventions

- **Lint:** oxfmt and oxlint, with custom rules in `scripts/lint/`. Silence a rule with `// oxlint-disable-next-line <rule> -- <reason>`.
- **Test buckets:** a test that imports or reads `packages/client` or `@socio/plugin-ui` goes in `tests/integration` (`scripts/check-test-buckets.mjs`). A test that reads a file under `docs/` or `marketing/` needs it removed from the exclusions in `turbo.json`.
- **Data:** only `packages/data` and a feature's `infra/` import Drizzle. Async writes go through `transaction()`, `writeSoon()` or a repository in `uow.run`, never a bare `.prepare('INSERT ...').run()` (`docs/DATA-LAYER.md`).
- **Migrations** live in each feature's `migrations.ts`. Two releases share a schema during a deploy, so migrations only add; removals are a later `phase: 'contract'` migration with `readersFrom`. Never change a released migration (`src/server/modules/released-migrations.json`): add one.
- **Effect 4.1.5:** services are `class X extends Context.Service<X, XShape>()('socio/<feature>/X') {}`, errors `Data.TaggedError`, layers `Layer.succeed`, `Layer.sync` or `Layer.effect` (`Context.Tag`, `Effect.Service` and `Layer.scoped` don't exist). `Effect.run*` only in `composition/`, `main.ts`, `index.ts` and process entries.
- **Feature boundaries:** a feature imports another only through its `contract.ts`. `scripts/check-feature-boundaries.mjs` (run by the tests) fails a new crossing; its baseline only shrinks and is rewritten with `--write`, never by hand.
- **Locale:** in the client and `packages/shared`, sort and format text with `packages/shared/src/locale.ts` (lint rule `socio/locale`).

## Rules

- Tests never reach the network: everything but loopback is blocked (`tests/setup/egress-guard.ts`).
- No real secrets or personal data in code, tests, fixtures or logs. Fixtures use generic names (Ada, Alice, Bob) and `example.com` or `.test` hosts.
- No vendor telemetry: nothing that phones home (`tests/integration/telemetry.test.ts`).
- Platform secrets arrive as Docker secrets (`*_FILE`); workload secrets are stored by Socio.
- Say in the pull request when a change alters what a deployment runs.
