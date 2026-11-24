# Data API test harness (CB-476)

A service plugin's store tests should meet the data API's real rules: the query runner and its authorizer, the write guard, the limits and caps, write batches with `expectChanges` and `RETURNING`, read batches, and the plugin's own statement budget (CB-473 to CB-475). The SDK's `fakeSocio` fakes approvals only, so the harness serves the data API itself.

The harness is Socio's own app booted over a temporary database and data space, with one plugin installed from your manifest. It doesn't copy anything: requests go through the app `createApp` builds over the graph `startAppRuntime` builds, the same code and middleware the server runs. Only the parts a plugin's tests can't reach are left out. No apps runtime starts the plugin's service, nobody can sign in, and no background work runs.

It serves two things:

- `/api/data/*`, the plugin-facing data API, with the plugin's `cbdt_` data token;
- `POST /api/workload/data-token`, the identity exchange, for code that renews its own token.

Anything else answers 404.

## In this repository: `startDataHarness`

```ts
import { startDataHarness } from '../src/data-harness/harness.js';

const harness = await startDataHarness({
    manifest: { id: 'acme-events', datasets: [{ name: 'events' }] },
    limits: { pluginQueryMaxRows: 1000, pluginStatementsPerMinute: 600 },
});
const response = await harness.fetch(`${harness.apiUrl}/data/datasets/events/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${harness.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT 1' }),
});
await harness.close();
```

The handle offers the following:

| Member                           | What it does                                                                |
| -------------------------------- | --------------------------------------------------------------------------- |
| `fetch`, `handle`                | Serves the routes in process. `apiUrl` is the in-process base.              |
| `token`, `expiresAt`, `datasets` | The current data token, as the exchange answered it.                        |
| `identity`, `proof`              | The plugin's identity token and proof, for code that exchanges them itself. |
| `renew(datasets?)`               | A new token, optionally narrowed to some needs by name.                     |
| `setBudget(n \| null)`           | The plugin's budget, set as an admin sets it on the plugin's page.          |
| `reset()`                        | A fresh, empty data space with a new token. Read `token` again afterward.   |
| `listen({ host, port })`         | Serves the same routes over HTTP on loopback.                               |
| `close()`                        | Stops the harness and deletes its files.                                    |

**Read needs.** In a workspace, a `read` need reads a dataset another plugin writes. The harness does the same. For each read need, it installs a source plugin that writes a dataset with the need's tables, then binds the need to that dataset. Your plugin's token reads it and can't write it. `sources[<need>]` is the source's write token: use it with the same routes to put in the rows your plugin reads. `renew()` renews these tokens too.

**Sensitive scopes.** A manifest that asks for `bridge.openAnyHttps` is acknowledged on install, as an admin would acknowledge it. The harness never starts the plugin, so the scope opens nothing.

`limits` takes the same keys `DATA_*` sets in production (`dataSettingsFromEnv`, `src/server/dataspace/limits.ts`).

The first harness in a process migrates a database once, in about a second. Each further boot takes a few hundred milliseconds. Start one per test file and call `reset()` between tests that need an empty space.

With `fakeSocio`, pass `data: harness.handle`: approvals stay fake, and data calls get the real data API.

## From another repository

Socio's packages aren't published, so a plugin in another repository can't import the harness. It runs the harness as a process instead and talks to it over HTTP.

The harness's entry, `dist/server/data-harness/main.js`, is compiled by the server build (`tsconfig.server.json`). That puts it in every release image of the app (`ghcr.io/erden-sh/company-brain:vX.Y.Z`), next to the server it tests against, byte for byte. Run the image of the version your workspace runs, with the command overridden:

```sh
docker run --rm -p 127.0.0.1:4390:4390 \
    -e HOST=0.0.0.0 -e PORT=4390 \
    -e SOCIO_HARNESS_MANIFEST=/plugin/manifest.json \
    -e DATA_PLUGIN_STATEMENTS_PER_MINUTE=600 \
    -v "$PWD/manifest.json:/plugin/manifest.json:ro" \
    ghcr.io/erden-sh/company-brain:vX.Y.Z \
    node dist/server/data-harness/main.js
```

Without registry access, build the same image from a checkout at the release tag (`docker build --target app -t socio-app .`), or run the entry from the checkout's own build (`pnpm install && pnpm run build:packages && pnpm run build:server`, then `node dist/server/data-harness/main.js`) on Node 26.

Once it listens, it prints one JSON line on stdout. Its log lines go to stderr.

```json
{
    "origin": "http://127.0.0.1:4390",
    "apiUrl": "http://127.0.0.1:4390/api",
    "dataUrl": "http://127.0.0.1:4390/api/data",
    "pluginId": "acme-events",
    "token": "cbdt_…",
    "expiresAt": 1795315812952,
    "datasets": [{ "id": "…", "name": "events", "access": "write" }],
    "sources": {},
    "identity": "cbpi_…",
    "proof": "…"
}
```

### Settings

| Setting                  | Default                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `SOCIO_HARNESS_MANIFEST` | Required. The plugin's manifest file, as JSON.                  |
| `HOST`, `PORT`           | `127.0.0.1` and `4390`. Port `0` picks a free port.             |
| `DATA_*`                 | The data space's limits, read exactly as the server reads them. |
| `DATA_TOKEN_TTL_MINUTES` | The token lifetime. A plugin's token lasts at most 15 minutes.  |

The manifest needs `id` and the `datasets` your tests use. The other fields get placeholders, and `service` is never started.

### Control routes

These routes don't need a token:

- `GET /__harness/info` prints the JSON line again.
- `POST /__harness/reset` gives a fresh data space and a new token.
- `POST /__harness/renew` with `{ "datasets"?: [...] }` gives a new token.
- `PUT /__harness/budget` with `{ "statementsPerMinute": n | null }` sets the plugin's budget.

Because these routes hand a token to anyone who asks, serve the harness on loopback or on a test network only. In a container, `HOST=0.0.0.0` stays inside it, and the example above publishes the port on the host's loopback only (`-p 127.0.0.1:4390:4390`).

`GET /healthz` answers 200 once the harness listens. The app image's own healthcheck (`healthcheck.js`, on `PORT`) uses it, so a CI service container goes healthy without a replacement check.

### With the SDK's test kit

If your repository vendors `@socio/app-sdk`, `harnessData(origin)` from `@socio/app-sdk/check` forwards `fakeSocio`'s data calls to a running harness:

```ts
const socio = fakeSocio({ appId: 'plugin:acme-events', data: harnessData(process.env.SOCIO_HARNESS_ORIGIN!) });
```

A driver that takes a base URL and a token (a D1-style `prepare/bind/all/run` with `batch`) can point at `dataUrl` with `token` and needs nothing from the SDK.

## What it proves

`tests/data-harness.test.ts` runs one plugin script against the server the plugin tests use (`tests/helpers/plugin-world.ts`) and against the harness, and requires identical answers. The script covers schema, `expectChanges`, `RETURNING`, read batches and caps, the write guard, and the statement-count limit. Further tests cover the budget, the token checks, `reset`, HTTP serving, and `fakeSocio` in process and by URL.
