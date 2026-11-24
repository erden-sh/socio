# @socio/app-sdk

The SDK for Socio mini apps that let socios use them for a person (CB-232). It verifies who each request is for, authorizes actions by the tier your manifest declares, asks the person to approve consequential actions, and calls Socio's data API on behalf of the request.

Socio access is off unless an admin turns on the `socio-actor-access` feature. Apps written with this SDK keep working for people either way.

The help page [Socio access for apps](../../content/docs/admin/socio-access-for-apps.md) explains the manifest side for app owners and admins. This file is the developer reference.

## Install

The package is private for now: it is not on a registry. Use it from this repository (`packages/app-sdk`, a workspace package) or copy the directory into your app. It needs Node 26 (it uses `node:crypto`, `node:fs`, `node:sqlite` for backups and, for the test kits, `node:http`), except `@socio/app-sdk/webhooks`, which runs anywhere Web Crypto does (below).

```ts
import { socioApp } from '@socio/app-sdk';

const socio = socioApp({
    actions: {
        'deals.list': 'read',
        'deal.update': 'write',
        'sms.send': 'consequential',
        'settings.update': 'admin',
    },
    publicPaths: ['/healthz', '/assets/'],
});
```

`actions` and `publicPaths` are copies of your manifest's `delegation.actions` and `delegation.public`. Everything else comes from the environment Socio starts your app with:

| Option                         | Default from the environment                           |
| ------------------------------ | ------------------------------------------------------ |
| `appId`                        | `CB_APP_ID`                                            |
| `key`                          | `CB_ACTOR_KEY`                                         |
| `previousKey`, `previousUntil` | `CB_ACTOR_KEY_PREVIOUS`, `CB_ACTOR_KEY_PREVIOUS_UNTIL` |
| `apiUrl`                       | `CB_DATA_URL` without its trailing `/data`             |
| `dataToken`                    | the file `CB_DATA_TOKEN_FILE`, else `CB_DATA_TOKEN`    |

You can also pass `replay` (a shared `jti` cache, below), `now` (a clock) and `fetch` (the function used to call Socio). Tests pass `apiUrl` and `fetch` to point the app at a fake Socio.

A service plugin uses the same SDK: see [Service plugins](#service-plugins).

## Verify every request

Every request through Socio's apps proxy carries an `x-cb-actor` envelope: a short claim set signed with your app's own key. It names the request's method and exact request-target, lives 60 seconds, and has a one-time `jti`. The SDK refuses a request with 401 when the envelope is missing, signed with another key, for another app, expired or issued in the future (5 seconds of clock skew), made for another method or request-target, or already seen.

**The reserved `/__cb/` prefix (service plugins, CB-458).** Socio itself calls a plugin on `/__cb/…` for its backups, with a host envelope: `sub` and `acc` are `host`, and it names no person, session, socio or token. On a path under `/__cb/`, in any spelling a router could decode or fold to it (`/__CB/`, `%5F%5Fcb`, dot segments), the SDK takes only a host envelope and refuses a person's or a socio's with 401, and `publicPaths` never makes one public. A host envelope opens nothing else, and its principal (`access: 'host'`) runs no declared action (`authorize` answers 403). The apps proxy never forwards `/__cb/` for a person, so this is defense in depth.

Pick an adapter:

```ts
// A fetch handler (Bun.serve, Deno, workers, Hono's app.fetch).
export default {
    fetch: socio.fetchHandler(async (request, principal) => {
        // principal is undefined only on a public path.
    }),
};

// Hono
const { requirePrincipal, authorize } = socio.hono();
app.use('*', requirePrincipal());
app.post('/deals/:id', authorize('deal.update'), (c) => {
    const actor = c.get('actor');
});

// Express: the raw target is `req.originalUrl`.
const mw = socio.express();
app.use(mw.requirePrincipal);
app.post('/deals/:id', mw.authorize('deal.update'), handler);

// Plain node:http
http.createServer(socio.node((req, res, principal) => {}));
```

The core is `socio.verify({ method, target, header, approval })`. `target` must be the request-target exactly as it came on the request line, path and query, before any framework decodes or normalizes it. The envelope's hash is over those bytes.

### What `Principal` holds

| Field       | Meaning                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| `person`    | The person's opaque id for your app (the same value as the legacy `x-cb-user`).   |
| `access`    | `owner` or `space`: the person owns the app, or reaches it through a Space.       |
| `socio`     | Set when a socio acts for the person: `{ id, grant, scopes }`, ids opaque to you. |
| `obo`       | The request's on-behalf-of token. Pass it back to Socio; `dataClient` does.       |
| `sessionId` | An opaque session id for your logs.                                               |
| `version`   | The app version Socio routed to; `null` for a development app.                    |
| `approval`  | The approval id a socio's repeated request names (`x-cb-approval`), socios only.  |

The envelope is identity for your own logic. It grants nothing at Socio: your app holds the key and could sign envelopes itself, so Socio's APIs take the `obo` token instead.

Rows belong to nobody yet. Every person who can open your app sees the same rows through it, and a socio acting for a person sees what that person would. If your app needs per-person rows, filter by `principal.person` yourself. (The manifest's `ownerColumn` is refused until row ownership ships.)

## Authorize by tier, never by method

```ts
const allowed = socio.authorize(principal, 'deal.update');
if (!allowed.ok) return new Response('Forbidden', { status: 403 });
```

`authorize` looks the action up in your `actions` and decides by its tier:

| Tier            | A person       | A socio                                                 |
| --------------- | -------------- | ------------------------------------------------------- |
| `read`          | yes            | with `app:read`                                         |
| `write`         | yes            | with `app:write`                                        |
| `consequential` | yes            | with `app:act`, and only with an approval for this call |
| `admin`         | the owner only | never                                                   |

An action that isn't declared is refused. Don't decide by HTTP method: a route that changes data must refuse a read-only socio whether it arrives as POST or GET. Name the action the route runs, and authorize that.

## Consequential actions: `requireApproval`

Anything that spends money, sends a message, deletes in bulk or reaches outside Socio is `consequential`. A person acting for themselves needs no approval. A socio needs the person to approve this exact call:

```ts
const params = await request.json();
const result = await socio.requireApproval(principal, 'sms.send', params, {
    summary: `Text ${params.to}`,
});
if (!result.ok) {
    if (result.status === 202) return Response.json({ approval: result.approval }, { status: 202 });
    return new Response('Refused', { status: result.status });
}
await sendSms(params, { idempotencyKey: result.approval });
```

The flow:

1. The socio's first request has no approval. The SDK computes the intent digest (SHA-256 of the RFC 8785 canonical JSON of `{ appId, action, params }`) and asks Socio. Answer the socio `202` with `{ approval }`.
2. Socio shows the person a card with your app, the action, its tier and the parameters themselves. Your `display` comes last, marked as the app's words.
3. When the person allows it, the socio repeats the request with `x-cb-approval`. The SDK consumes the approval at Socio for these exact parameters, once. Changed parameters give another digest, and Socio refuses (409).
4. Run the action. Use the approval id as its idempotency key.

A second consume fails. A denied or expired approval can't be consumed, and approvals die with the socio's grant. Never perform the action when `requireApproval` returns anything but `ok: true`.

## Calling the data API: `dataClient`

```ts
const data = socio.dataClient(principal);
const rows = await data.fetch('/datasets/deals/query', {
    method: 'POST',
    body: JSON.stringify({ sql: 'select * from deals' }),
    headers: { 'content-type': 'application/json' },
});
```

`dataClient` sends your app's data token and the request's `x-cb-obo`. Socio grants the intersection: what your app may do, and what the person (or the socio acting for them) may do. A read-only socio can't write by asking your app to write: the data API refuses it.

A query that filters or joins on columns other than a table's key can scan the whole table and hit the query time limit (a 504). Declare an index on those columns instead of rewriting SQL around it: `POST /datasets/<ref>/tables/<table>/indexes` with `{ "name": "deals_by_owner", "columns": ["owner_id", "closed_at"] }` (`unique` and `ifNotExists` are optional), and `DELETE /datasets/<ref>/tables/<table>/indexes/<name>` to drop one. Both are write-tier operations (`createIndex`, `dropIndex`); `GET /datasets/<ref>` lists each table's `indexes`. After a large load, `POST /datasets/<ref>/analyze` (or `/datasets/<ref>/tables/<table>/analyze`) with `{}` refreshes the planner's statistics (operation `analyze`, write tier; it counts toward the per-minute budget). See "Indexes on datasets" in `docs/SETUP.md`.

Without `x-cb-obo`, an app that declares the contract may write only to its `background` datasets (never a consequential operation), and may read unless `background.read` is `false`. Use those for scheduled jobs, not for requests.

### Destructive data operations

Row, table, dataset and file deletes through a socio need the person's approval bound to that exact data call. The data API consumes it, not your app:

```ts
const params = { path: 'exports/old.csv' };
const asked = await socio.requestDataApproval(principal, 'files.delete', params);
if (!asked.ok) {
    if (asked.status === 202) return Response.json({ approval: asked.approval }, { status: 202 });
    return new Response('Refused', { status: asked.status });
}
await socio.dataClient(principal).fetch(`/files?path=${encodeURIComponent(params.path)}`, {
    method: 'DELETE',
    approval: asked.approval,
});
```

- The approval's action is `data:<op>` (here `data:files.delete`). Its parameters are defined by the platform for each operation (`files.delete` takes `{ path }`, the exact `path` query value), so the data API can recompute the digest at the call.
- On the socio's first request, `requestDataApproval` answers `202` with the approval id; pass that to the socio as for any other approval. A person needs none (`{ ok: true }`).
- On the repeated request it returns `principal.approval` without consuming it. Pass it as `approval` to the data call, which sends `x-cb-approval`. Socio consumes it there, once.
- Don't consume it yourself, and don't reuse it for another path.
- Action names that start with `data:` are reserved. A manifest that declares one is refused.
- Today the data API serves none of these deletes to an app's token: row, table and dataset deletes are the person's own routes, and an app token's file delete is refused by the data layer (CB-229). An approved delete therefore uses up its approval and answers 403. The flow is in place for when those routes open to apps.

## Work that outlives the request: `continuation`

The request's `obo` lasts about as long as the request. For queued work, exchange it:

```ts
const obo = await socio.continuation(principal, 30); // minutes
await queue.add({ obo, person: principal.person });
```

A continuation never outlives the socio's grant (or 8 hours for a person). Revoking the grant stops the job at its next data call. A job can't ask for new approvals after the grant ended.

## Repository extractions: `extraction`

An app that packs or reads code, such as a Repomix app, can take read-only copies of a listed repository's paths at one commit. Declare it in the manifest:

```json
{ "delegation": { "contract": 1, "actions": {}, "accepts": ["repo-extract"] } }
```

A socio asks for an extraction for your app; the person approves the exact repository, commit, paths and app on a card (or a standing grant they made covers it). The socio then calls your app with the extraction's id. Read it during that request, with the request's principal:

```ts
const read = await socio.extraction(principal, id);
if (!read.ok) return new Response(read.error, { status: read.status });
for (const file of read.extraction.files) pack(file.path, file.content);
```

- Only a published (promoted) app can take extractions, and only the app the person approved; another app, another person, a socio other than the one that asked, or a request without its `obo` is refused.
- Reads work for 10 minutes after the first (retries), then never again. An extraction is kept 24 hours by default; after that it is gone.
- `files[].encoding` is `utf8` for text and `base64` for anything else. The contents come from the repository: treat them as untrusted input. Your app gets no GitHub access and can't push.
- Dropping `accepts` in a new version stops reads of extractions made before. Service plugins can't take extractions.

## Secrets: `secrets`

Socio Secrets give a **workspace app** (one promoted into the workspace app runtime) or a **service plugin** (phase 2) the third-party keys it needs, without putting them in code, env or data. Declare each one in the manifest (a plugin's top-level `secrets`, the same shape):

```json
"secrets": [
  { "name": "STRIPE_API_KEY", "required": true, "description": "Charges cards for bookings" },
  { "name": "SLACK_WEBHOOK", "required": false }
]
```

A workspace admin sets the values in Settings → Secrets and grants them to the app or plugin (or sets one that belongs to it alone). An app reads them at runtime with its own data token; a plugin with its own identity token and its proof (below):

```ts
await socio.secrets.require(['STRIPE_API_KEY', 'SLACK_WEBHOOK']); // at start: one error naming every missing secret
const key = await socio.secrets.get('STRIPE_API_KEY'); // a string
const stop = socio.secrets.onRotate('STRIPE_API_KEY', (value) => stripe.setApiKey(value));
```

- **Caching.** Each value is kept in memory until the `expiresAt` Socio sends with it (5 minutes at most), then read again. Concurrent `get`s share one request. `secrets.clear()` forgets everything and stops every rotation watch.
- **Rotation.** When an admin replaces a value, the old version stays readable for an overlap window (an hour by default). `onRotate` fetches the secret again when its cached value expires and calls you with each new version; it returns a function that stops it. An app that ignores rotation still gets the new value on its next `get` after the cache expires.
- **Errors.** A secret that isn't declared, set or granted rejects with a `SecretReadError` whose `names` and `status` (403) say which; errors never hold a value.
- **Nothing on disk.** The SDK never writes a value to disk or to the environment. Don't either, and don't log them: Socio redacts the values an app may read from its logs, but treat that as a safety net.
- **Who may read.** Promoted apps and service plugins. A development app on a socio's computer can't read secrets yet. A plugin needs its identity file (`SOCIO_IDENTITY_FILE`) and `CB_PLUGIN_PROOF`; the deprecated shared `PLUGIN_SERVICE_TOKEN` is refused for secret reads.

The routes underneath are `GET /api/workload/secrets/:name` and `GET /api/workload/secrets?names=A,B`, with `Authorization: Bearer <data token>` (a plugin: `Bearer <identity token>` and `x-cb-plugin-proof`); they answer `{ value, version, expiresAt }` (or `{ secrets: { NAME: … } }`) with `Cache-Control: no-store`, and reads are rate-limited per app or plugin.

## Service plugins

A service plugin that declares `delegation` in its manifest uses this SDK unchanged. Socio starts its tasks with `CB_APP_ID=plugin:<id>` and `CB_ACTOR_KEY`, so `socioApp()` verifies its envelopes (audience `plugin:<id>`, `version` always `null`) with no settings. When `appId` starts with `plugin:`, the SDK calls the plugin's own routes instead of an app's, with the plugin's identity token and the proof of its id instead of an app data token:

| Call                          | Goes to                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `requireApproval`             | `/api/plugins/<id>/actor/approvals` and `…/<id>/consume` |
| `continuation`                | `/api/plugins/<id>/actor/continuations`                  |
| `dataClient(principal).fetch` | `/api/plugins/<id>/data/…`, the plugin's own data routes |

| Option         | Default from the environment                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `apiUrl`       | `SOCIO_API_URL` (Socio's origin, e.g. `http://app:4310`) plus `/api`                                                                   |
| `serviceToken` | the file `SOCIO_IDENTITY_FILE` (its identity, read on every call); deprecated: the file `SOCIO_API_TOKEN_FILE`, else `SOCIO_API_TOKEN` |
| `pluginProof`  | `CB_PLUGIN_PROOF`, which the runtime puts in the plugin's tasks                                                                        |

`SOCIO_IDENTITY_FILE` and `CB_PLUGIN_PROOF` are the runtime's; `SOCIO_API_URL` is the plugin's own env, as the social planner sets it (docs/PLUGINS.md). The identity is rotated by replacing the file, which the SDK reads again on each call. Without the token or the proof, every call back throws "not configured". An app's `CB_DATA_TOKEN` is never sent for a plugin.

What differs from an app:

- The intent digest names `plugin:<id>` (`sdk.intentDigest` does it), so an app with the same id never shares an approval.
- `dataClient` reaches the plugin's data routes, which act for the person, or for the socio's grant at the call's tier (`GET` and `HEAD` read, anything else writes). They take no approvals: `requestDataApproval` and `dataClient(…).fetch(…, { approval })` throw for a plugin. Data operation approvals (`data:<op>`) are for mini apps.
- A continuation works on the plugin's data routes as the request's `obo` does, re-checked on every call.

## Backups: `socio.backup` (service plugins)

A service plugin whose manifest declares a volume that isn't `ephemeral` must declare `service.backup` (docs/PLUGINS.md, Manifest), and its image must answer the workspace's snapshot protocol on `/__cb/backup/*` and `/__cb/restore/*`. One call does it:

```ts
const socio = socioApp(); // CB_APP_ID=plugin:acme-notes
const backup = socio.backup.serve({
    volumes: { data: '/data' }, // each non-ephemeral volume of the manifest, by name
    schemaVersion: 4, // the data schema this build writes; at most the manifest's backup.schema
    pluginVersion: '1.4.0',
    exclude: ['cache/', '*.tmp'],
    stats: () => ({ notes: countNotes() }), // optional: the drill compares them after a restore
});

if (backup.restoreMode) {
    await backup.listenForRestore(); // /healthz and /__cb/restore/* only; exits 0 after the commit
} else {
    serveApp(socio.fetchHandler(handler)); // or socio.node, socio.express, socio.hono
}
```

The adapters route the host's calls (a host envelope, `acc: "host"`, on the SDK's routes) to the backup side before your handler sees them. A plugin that routes requests itself passes them to `backup.handle(request)`, which verifies the host envelope and answers, or returns undefined for any other path.

**The default handler.** Each snapshot walks every declared volume in a stable order without following symlinks. Every `*.sqlite` and `*.db` file with SQLite's header is copied through SQLite's online backup API into a standalone copy: the copy is set to `journal_mode=DELETE`, so it holds every page, and the database's `-wal`, `-shm` and `-journal` files are never listed (restoring them beside the copy would replay changes made after the snapshot). The item records the source's journal mode, which a restore sets back. Every other regular file is taken as it is, copied into the snapshot's work directory (a reflink where the file system has them), so a file written in place, replaced or deleted meanwhile is still the one listed. Symlinks, sockets, FIFOs and devices are skipped, and so are:

- `exclude`: paths relative to a volume's mount. `*` and `?` stay within a segment, `**` crosses them, a pattern without `/` matches a name at any depth, and one that names a directory takes its contents too;
- `*.key`, `*.pem` and `.env` (`DEFAULT_EXCLUDES`), unless `include` lists them. Never write a secret to a volume: the SDK keeps secrets in memory (`socio.secrets`);
- the SDK's own entries at a volume's root, every name starting with `.socio-` (`.socio-snapshots/`, `.socio-quiesce`, `.socio-restore`, `.socio-release`). Don't keep data under those names.

The copies need about the volume's used size free on it (each database's WAL included); a snapshot short of it fails with that reason. The SDK reads every item once to hash it, so the manifest it answers carries each item's size, SHA-256 and, for a database or anything over 64 MiB, its 4 MiB chunk hashes. It runs the workspace's own manifest check before answering, so a manifest the workspace would refuse fails the snapshot instead. Failure reasons never carry paths.

**A custom handler** replaces the walk, for a plugin with its own format:

```ts
socio.backup.serve({
    volumes: { data: '/data' },
    schemaVersion: 4,
    handler: {
        async begin(reason, { snapshotId, quiesce }) {
            await exportTo(`/data/.socio-snapshots/${snapshotId}`); // use the host's id for temporary files
            return { items: [{ volume: 'data', path: 'export.jsonl', kind: 'file' }], stats: { notes: 12 } };
        },
        openItem: (snapshotId, path, volume) => createReadStream(`/data/.socio-snapshots/${snapshotId}/${path}`),
        end: (snapshotId) => rm(`/data/.socio-snapshots/${snapshotId}`, { recursive: true, force: true }),
    },
});
```

`begin` runs in the background while the host polls. `openItem` streams the whole item (an async iterable, an iterable or a `ReadableStream`); the SDK hashes it and cuts chunks out of it. `end` runs when the host ends the snapshot, and when its lease runs out: an hour after the host's last request about it, so a host that crashed leaves nothing behind. The default handler also renews the lease on the volume (its work directory's time), so a replica that starts on a shared volume sweeps only work directories nobody has asked about for an hour. Sizes or hashes you give in `begin` are checked against the bytes.

**Quiesce: holding writes.** Before a pre-update or uninstall snapshot, the workspace holds writes on every task (`POST /__cb/backup/quiesce`). From then until the hold ends, the adapters answer any writing request `503` with `Retry-After: 5`; a hold waits up to 30 s for writes already in flight to finish before it answers. By default a request writes unless its method is `GET`, `HEAD` or `OPTIONS`; pass `writing: ({ method, path }) => …` to say which routes write. Pause your own writing jobs while `socio.backup.quiesced()` is true, or pass `quiesce: { hold(snapshotId), resume(snapshotId) }`. The hold is its own resource: the snapshot's `DELETE` leaves it in place, and only its own `DELETE`, the task stopping, or its lease ends it (10 minutes after the host's last renewal). A task that starts during a hold is held too: the SDK writes `.socio-quiesce` on the volume, which another replica on a shared volume reads, and it runs that task's `quiesce.hold` hook when it sees the marker (the host's own quiesce on that task waits for the hook, and fails if it throws) and `resume` when the marker goes. A retried quiesce answers only once the first one's writes drained, and a quiesced snapshot starts only then.

**Asking for a snapshot.** `await socio.backup.request({ reason: 'Imported 1,200 notes' })` asks the workspace for one (`POST /api/plugins/<id>/backup/request`, with the plugin's identity and proof). The workspace coalesces and rate-limits requests and shows the reason in the plugin's backup history. It answers `{ ok, status }`.

**Restore mode.** To restore, the workspace starts the plugin with `CB_RESTORE_SNAPSHOT=<snapshotId>` on a new, empty volume generation. Until the volume holds a `.socio-restore` marker for that snapshot, `backup.restoreMode` is true and the app must not start: `listenForRestore({ port })` (default `PORT`, else 8080) serves `GET /healthz` and the host's restore routes and answers 503 to everything else, and the adapters answer 503 too, public paths aside. The host pushes the manifest (`POST /__cb/restore/<id>`; the SDK runs the same check and refuses a second, different one), then each item (`PUT …/items/<index>`): the SDK writes it under a temporary name, checks every chunk's hash, the size and the whole item's hash, sets its file mode, and only then renames it into place, never through a symlink. `POST …/commit` refuses until every item arrived, sets each database's recorded `wal` mode back, syncs, writes the marker and exits with status 0. Swarm starts the task again, the SDK sees the marker and `restoreMode` is false: the app starts on the restored data and runs its migrations forward. A restore is never applied twice.

**After a restore: hold outward work.** `CB_RESTORE_HOLD=<snapshotId>` stays set after a restore, and `socio.backup.restored` is `{ snapshotId, snapshotAt, held }`. While `held` is true, keep serving people (and queue inbound webhooks if you like) but pause anything that acts outside: syncs to other systems, outgoing webhooks and calls, and scheduled jobs that reach out. Restored data is from the past, so resuming on its own could resend what outside systems already have or overwrite newer data there. Only an admin ends the hold (**Resume outward work**); the workspace then calls `POST /__cb/restore/release`, the SDK writes `.socio-release` on the volume, `held` turns false and your `onRelease` callbacks run, with no restart. Every replica on a shared volume runs its own callbacks once, whichever one the release reached; a process that starts after the release reads `held` as false and runs none. Before `serve`, with no volume to read, `restored` reads as held.

```ts
const resume = () => startSyncs();
if (!socio.backup.restored?.held) {
    resume();
}
socio.backup.onRelease(resume);
```

**Plugins not written in Node** implement the same HTTP routes and check them with the conformance kit below.

### Vendoring the backup side

The SDK isn't published, so a plugin in another repository copies its files. The backup side is self-contained for that: `backup.ts` imports only Node's built-ins (`node:sqlite` included, so Node 26) and `snapshot.ts`, and `snapshot.ts` imports nothing. `snapshot.ts` is a byte-identical copy of `packages/shared/src/plugins/plugin-snapshot.ts`, the workspace's own manifest check (tests/app-sdk-backup.test.ts checks), so a plugin checks manifests exactly as the workspace does.

- With the whole SDK: copy `index.ts`, `envelope.ts`, `jcs.ts`, `secrets.ts`, `data-api.ts`, `backup.ts` and `snapshot.ts` into one directory and use `socioApp().backup` as above.
- With the backup side alone: copy `backup.ts` and `snapshot.ts`, and build it with your own request check: `backupSide({ pluginId, verify, apiUrl, credentials, fetch, now: Date.now, env: process.env }).serve({ … })`, where `verify({ method, target, header })` opens the host envelope (the SDK's `socio.verify` does). Then route `/__cb/backup/*` and `/__cb/restore/*` to `server.handle(request)`.
- For CI, copy `backup-check.ts` with `envelope.ts` and `snapshot.ts`.

Copy them again when the SDK changes; keep the files' names, since they import each other by them.

### The backup conformance kit: `@socio/app-sdk/backup-check`

Run it in the plugin's CI against the plugin's fetch handler or any plugin URL (a plugin in any language, on loopback). It signs host envelopes with the plugin's test key and drives the protocol as the workspace will:

- the backup routes refuse no envelope, a person's, another plugin's, another key's and a replayed one, and a host envelope opens nothing off `/__cb/`;
- `begin` refuses a bad snapshot id or reason, and a quiesced begin with no hold;
- a snapshot becomes `ready`, its manifest passes the workspace's check, every item and chunk is the bytes its hashes name, out-of-range items answer 404, and `DELETE` ends it;
- quiesce holds the `write` route you give (503 with `Retry-After`) through the snapshot's `DELETE`, until the hold's own `DELETE`;
- `verify` answers `ok` with a schema version the manifest allows;
- with `restore`, an instance you start in restore mode refuses items before the manifest, a manifest for another snapshot, a second different manifest, a wrong item and an early commit, then takes every item from a real snapshot and commits.

```ts
import { assertBackup } from '@socio/app-sdk/backup-check';

test('keeps the backup protocol', async () => {
    await assertBackup({
        pluginId: 'acme-notes',
        key: process.env.CB_ACTOR_KEY!, // the plugin's test key
        app: 'http://127.0.0.1:8080', // or its fetch handler
        volumes: ['data'],
        schema: 4, // the manifest's backup.schema
        write: { method: 'POST', path: '/notes', body: '{"body":"Acme"}' },
        restore: async (snapshotId) => {
            const task = await startPlugin({ CB_RESTORE_SNAPSHOT: snapshotId, volume: emptyVolume() });
            return { app: task.url, committed: () => task.exitedWith(0), stop: () => task.stop() };
        },
    });
});
```

`checkBackup` returns every result (`name`, `ok`, `detail`) instead of throwing. `newSnapshotId()` makes a snapshot id as the host does.

## Public paths

Paths in `publicPaths` are served without an envelope: a path ending in `/` is a prefix, any other is exact. Every other path answers 401 without one, health checks included, unless you list them. A path with `.` or `..` segments, or with an encoded dot, slash or backslash (`%2e`, `%2f`, `%5c`), is never public, because a router that normalizes it could land on a path that isn't.

## Key rotation

Socio rotates your app's key when the app is published again or retired. The new key comes as `CB_ACTOR_KEY`; the old one stays valid as `CB_ACTOR_KEY_PREVIOUS` until `CB_ACTOR_KEY_PREVIOUS_UNTIL` (epoch milliseconds, 5 minutes later). The SDK accepts both until then. Both are secrets: never log them or send them anywhere.

## Replicas need a shared `jti` cache

The default replay cache is in process memory. If you run more than one replica, a captured envelope could be replayed once against each. Pass a cache every replica shares:

```ts
const socio = socioApp({
    replay: {
        // Record jti until `until` (epoch ms); true when it was already there.
        seen: (jti, until, now) => !shared.setIfAbsent(jti, until - now),
    },
});
```

`seen` is synchronous. Back it with something that answers synchronously (a shared-memory map, a local SQLite file on a shared volume), or keep one replica.

## Standard Webhooks: `@socio/app-sdk/webhooks`

Socio Forms delivers its webhooks as [Standard Webhooks](https://www.standardwebhooks.com) (spec v1). The receiver contract, with its test vector, is [docs/specs/FORMS-WEBHOOKS.md](../../docs/specs/FORMS-WEBHOOKS.md). This entry point signs and verifies that format, so you can write a receiver, or an **adapter** that takes another service's webhook (Typeform, Tally, a Google Form) and re-signs it so a Forms receiver accepts it (CB-479).

It is separate from the rest of the SDK: one file with no imports, using only Web Crypto, `TextEncoder`, `atob` and `btoa`. It runs in Cloudflare Workers, browsers, Deno, Node and Bun, and you can copy `src/webhooks.ts` alone into a project.

```ts
import {
    generateSecret,
    MemorySeenStore,
    parseSecrets,
    receiver,
    sign,
    verify,
    WEBHOOK_TOLERANCE_SECONDS,
    type SeenStore,
    type VerifyResult,
    type WebhookEvent,
} from '@socio/app-sdk/webhooks';
```

| Export                                     | What it does                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify(rawBody, headers, secrets, opts?)` | Resolves `{ ok: true, id, timestamp }` or `{ ok: false, reason }`. `rawBody` is the bytes as received (`Uint8Array`, `ArrayBuffer` or a string, as UTF-8); verify before you parse. `headers` is fetch `Headers` or a plain object such as Node's `req.headers`. `opts.now` is the clock in ms (`Date.now` by default), `opts.toleranceSeconds` the window (300). |
| `sign({ id, timestamp, body }, secrets)`   | Resolves `{ 'webhook-id', 'webhook-timestamp', 'webhook-signature' }`, with one `v1,` entry per secret. `timestamp` is Unix seconds or a `Date`. Send `body` exactly as signed.                                                                                                                                                                                   |
| `generateSecret()`                         | A new `whsec_` secret: the padded base64 of 32 random bytes.                                                                                                                                                                                                                                                                                                      |
| `parseSecrets(value)`                      | The one or two `whsec_` secrets in a Socio Secret's value, separated by whitespace or commas.                                                                                                                                                                                                                                                                     |
| `receiver({ secrets, seen, … })`           | A fetch-style receiver that verifies, dedupes on `webhook-id` and calls your handler (below).                                                                                                                                                                                                                                                                     |
| `MemorySeenStore`                          | An in-memory, bounded `SeenStore` for one process.                                                                                                                                                                                                                                                                                                                |

What `verify` checks, in order: the three headers are there once each (`missing_headers`, `malformed_headers`: a repeat, including a signature header joined with `, ` by `Headers` or Node, an id over 256 characters, a signature header over 4 KiB, a timestamp that isn't whole Unix seconds); the timestamp is at most 5 minutes from the clock, either way (`timestamp_too_old`, `timestamp_too_new`; exactly 300 seconds still passes); the header has a well-formed `v1,` entry (`no_signature`; other versions are ignored, at most 16 entries are read); and some entry matches some secret, compared in constant time (`bad_signature`). It never throws on what the request holds. It throws a `TypeError` only for your configuration: no secret, or one that isn't `whsec_` and the base64 of 24 to 64 bytes. Error messages never echo a secret.

**Rotation.** Pass every secret you hold. While a Forms destination has two secrets, each delivery carries two `v1,` entries and either one verifies. Keep both in one Socio Secret, separated by a space, and read it with `parseSecrets(await socio.secrets.get('FORMS_WEBHOOK_SECRET'))`; when the admin retires the old secret, drop it from the value.

### A receiver

```ts
import { parseSecrets, receiver, type SeenStore } from '@socio/app-sdk/webhooks';

// Shared across replicas: here a Workers KV namespace, kept for the contract's 7 days.
const seen = (kv: KVNamespace): SeenStore => ({
    has: async (id) => (await kv.get(`seen:${id}`)) !== null,
    add: (id, ttlSeconds) => kv.put(`seen:${id}`, '1', { expirationTtl: ttlSeconds }),
});

export default {
    async fetch(request: Request, env: Env) {
        const receive = receiver({ secrets: parseSecrets(env.FORMS_WEBHOOK_SECRET), seen: seen(env.SEEN) });
        return receive<FormsEvent>(request, async (event) => {
            if (event.payload.type === 'webhook.test') return; // answer 2xx, store nothing
            await saveSubmission(event.payload.data);
        });
    },
};
```

- Not `POST`: `405`. A body over `maxBodyBytes` (1 MiB): `413`, before any verification.
- A failed `verify`: `401` with `{ "error": "<reason>" }`. The handler isn't called and the store isn't touched.
- A verified `webhook-id` the store has: `200` `{ "duplicate": true }`, without calling the handler.
- A verified body that isn't UTF-8 JSON: `400`.
- Otherwise your handler gets `{ id, timestamp, body, payload }` (`body` the raw text, `payload` the parsed JSON). Its `Response` is the answer, `204` when it returns nothing. The id is stored for `seenTtlSeconds` (7 days) only on success: nothing returned or a `2xx`. A handler that throws (`500`) or returns any other status leaves it unstored, so the sender's retry runs it again.
- The store is asked `has` before and `add` after the handler: delivery is at least once. Two copies of one delivery arriving together can both run, so key your own writes on `data.submissionId` as well (the contract's advice for a receiver behind two destinations).

### An adapter: re-signing a Typeform delivery

Typeform signs its webhooks with `Typeform-Signature: sha256=<base64 HMAC-SHA256 of the raw body>` under the secret you set on the Typeform webhook. An adapter checks that, maps the answer to the Forms body if the receiver wants it, then signs with the destination's `whsec_` secret and forwards. Use Typeform's `event_id` in the `webhook-id`, so Typeform's retries dedupe downstream.

```ts
import { sign } from '@socio/app-sdk/webhooks';

const encoder = new TextEncoder();

async function typeformSignatureOk(raw: Uint8Array, header: string | null, secret: string) {
    if (!header?.startsWith('sha256=')) return false;
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'verify',
    ]);
    let given: Uint8Array;
    try {
        given = Uint8Array.from(atob(header.slice(7)), (c) => c.charCodeAt(0));
    } catch {
        return false;
    }
    return crypto.subtle.verify('HMAC', key, given, raw); // constant time
}

export default {
    async fetch(request: Request, env: Env) {
        const raw = new Uint8Array(await request.arrayBuffer());
        if (!(await typeformSignatureOk(raw, request.headers.get('typeform-signature'), env.TYPEFORM_SECRET))) {
            return new Response('bad signature', { status: 401 });
        }
        const delivery = JSON.parse(new TextDecoder().decode(raw));
        const body = JSON.stringify(toFormsBody(delivery)); // your mapping to { type, timestamp, data }
        const headers = await sign(
            { id: `msg_typeform_${delivery.event_id}`, timestamp: new Date(), body },
            [env.FORMS_WEBHOOK_SECRET], // or parseSecrets(…) while rotating
        );
        const answer = await fetch(env.DESTINATION_URL, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json', 'x-forms-event': 'form.submitted' },
            body,
        });
        // Pass the destination's verdict back, so Typeform retries what failed.
        return new Response(null, { status: answer.ok ? 200 : 502 });
    },
};
```

Sign each attempt with a fresh timestamp and the same id. Forward `body` as the exact string you signed.

### Google Apps Script

Apps Script has no Web Crypto (`crypto.subtle`), so the file above doesn't run there. Sign with `Utilities.computeHmacSha256Signature` instead, for example from a Google Form's on-submit trigger:

```js
function signStandardWebhook(id, body, secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Utilities.base64Decode(secret.replace(/^whsec_/, ''));
    const content = Utilities.newBlob(id + '.' + timestamp + '.' + body).getBytes(); // UTF-8
    const signature = 'v1,' + Utilities.base64Encode(Utilities.computeHmacSha256Signature(content, key));
    return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature };
}

function onFormSubmit(e) {
    const secret = PropertiesService.getScriptProperties().getProperty('FORMS_WEBHOOK_SECRET');
    const body = JSON.stringify(toFormsBody(e)); // your mapping
    const id = 'msg_gform_' + e.response.getId();
    UrlFetchApp.fetch(DESTINATION_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: signStandardWebhook(id, body, secret),
        payload: Utilities.newBlob(body).getBytes(), // the exact bytes signed
        followRedirects: false,
    });
}
```

For two secrets, compute one `v1,` entry per secret and join them with a space. Apps Script can sign but not receive: a web app's `doPost(e)` doesn't see the request's headers, so it can't verify a delivery. Receive in a Worker or a server instead.

## The contract test kit: `@socio/app-sdk/check`

Run it in your app's CI. It drives your app's fetch handler, or a loopback URL, with envelopes signed by the real codec, for the owner, a Space member and socios with `app:read`, `app:write` and `app:act`. It checks:

- No envelope, a forged one, one under another key, for another app, expired, from the future, for another method or request-target, or replayed: 401.
- Public paths are served without an envelope; their dot-segment and encoded-slash variants are not.
- A read-only socio on every `write` and `consequential` route, also when it sends GET: refused.
- Any socio, and a Space member, on an `admin` route: 403.
- A socio with `app:act` on a consequential route: 202 with an approval. Repeated while pending, with changed parameters or under another grant: refused, nothing run. Repeated after approval: runs once. Again: refused.
- Controls, so a refusal means something: the owner reaches every route, and socios reach routes within their scope.

The approval checks need your app to call a fake Socio. Build the app inside `start`, which gets the kit's fake:

```ts
import { assertContract } from '@socio/app-sdk/check';

import manifest from '../manifest.json' with { type: 'json' };
import { makeApp } from '../src/app.js';

test('keeps the Socio delegation contract', async () => {
    const sent: unknown[] = [];
    await assertContract({
        appId: 'tracker',
        key: process.env.CB_ACTOR_KEY!, // the app's test key
        delegation: manifest.delegation,
        routes: [
            { method: 'GET', path: '/deals?stage=won', action: 'deals.list' },
            {
                method: 'POST',
                path: '/deals/42',
                action: 'deal.update',
                body: { stage: 'won' },
            },
            {
                method: 'POST',
                path: '/sms',
                action: 'sms.send',
                body: { to: '+15550100', text: 'Shipped' },
                performed: () => sent.length,
            },
            {
                method: 'PUT',
                path: '/settings',
                action: 'settings.update',
                body: { theme: 'dark' },
            },
        ],
        start: (socio) => makeApp({ apiUrl: socio.apiUrl, fetch: socio.fetch, sent }).fetch,
    });
});
```

- `routes` is yours to write: the kit can't guess which action a route runs. Use concrete paths. Give a body the route accepts.
- For a consequential route, the kit changes the body's first string, number or boolean to test a changed digest; give `changedBody` when that isn't a change of parameters.
- `performed` (optional) returns how many times the action ran, so the kit can also check that refusals ran nothing.
- An app that runs as its own server: start `fakeSocio({ appId, actions })`, call `listen()`, start the app with `CB_DATA_URL` set to its `apiUrl` plus `/data`, and pass `app: 'http://127.0.0.1:<port>'` and `socio`. The kit then sends raw request-targets.
- `checkContract` returns every result (`name`, `ok`, `route`, `detail`) instead of throwing. `assertContract` throws with a readable list of failures.

For your own tests, `mintTestEnvelope({ appId, key, actor, method, target })` signs an envelope like Socio's proxy would. `actor` is `owner`, `space`, `app:read`, `app:write` or `app:act`.

A service plugin runs the same kit with `appId: 'plugin:<id>'`. The envelopes are for that audience, and the fake Socio answers the plugin's routes (`/api/plugins/<id>/actor/approvals`, `…/consume`): it wants a bearer and `x-cb-plugin-proof` (exactly `pluginProof` when you give it to `fakeSocio`, as Socio would; 401 otherwise) and refuses a `data:` action. Build the plugin inside `start` with `serviceToken` and `pluginProof` set, or pass `socio: fakeSocio({ appId: 'plugin:<id>', actions, pluginProof })` beside `start`. `approvalsPath(appId)` names the route the fake serves.

`fakeSocio` fakes approvals only. For a plugin's dataset work, pass `data`: Socio's real data API from the data test harness (CB-476, [docs/DATA-TEST-HARNESS.md](../../docs/DATA-TEST-HARNESS.md)). Use its in-process `handle` in this repository, or `harnessData(origin)` for a harness running as a process or container.
