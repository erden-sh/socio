# Plugins

A plugin is a feature an admin installs on one Socio instance. It runs in one of two modes:

- **Service.** Its own Docker service on the workspace app runtime (the same runtime that runs promoted mini apps). People open it through the apps proxy, on its own origin. This needs the apps host, the runtime and the socket-proxy overlay.
- **Bundled** (CB-254). Code that ships in this build and runs inside Socio's own process. Its page renders in the workspace shell, its data lives in Socio's database, and its tools are registered in-process. It needs no service, no apps host, no runtime and no Docker socket, so installing it from **Plugins** is the whole setup. Only a plugin this build ships can be bundled; a catalog file always names a service.

Nothing is installed by default. An instance offers what its catalog lists (below), and an admin installs from that.

The plugins are the social planner (`social-strategy`, a service; it plans X posts and never posts them) and the calendar (`calendar`, bundled; see [Calendar](#calendar)).

## What already existed

Promoted mini apps are processes inside the `apps` service: one uid, one unix socket, started by the runtime's supervisor. Plugins do not add a second runtime. When `APPS_RUNTIME_DOCKER=on`, that same process creates one Swarm service per installed plugin. It does not open the Docker socket. The optional overlay runs `docker-socket-proxy`, the only container that mounts `/var/run/docker.sock`, and the runtime talks to it at `tcp://docker-socket-proxy:2375` on an internal network with no published ports. The default stack leaves this off.

The apps proxy still owns the apps host (`<APPS_LABEL_PREFIX><id>.<APPS_HOST>`). That host is a different origin from Socio. A host that is not a mini app is checked against installed plugins. Sign-in, `frame-ancestors`, and the hop to the runtime ingress are the proxy's. The plugin process never sees Socio's session cookie.

## Manifest

A catalog entry is a `PluginManifest`:

```ts
interface PluginManifest {
    id: string; // plugin id, also the apps-host label; no `--` (mini apps' ids have one)
    name: string;
    version: string;
    author: string;
    description: string;
    icon?: string; // not loaded; the launcher uses a generic icon
    entry?: { path: string }; // path on the plugin's own origin, default /
    display: 'tab' | 'embed';
    permissions: string[]; // granted in full on install
    mcp?: { tools: { name: string; description: string; scope: string }[] };
    config?: Record<string, PluginConfigField>; // the install's settings, see Settings below
    audience?: 'admins' | 'members'; // who may use it once installed; default admins
    bridge?: { open?: string[]; openAnyHttps?: boolean; routes?: boolean }; // links the embed may open, deep links
    service?: PluginServiceSpec; // absent only for a bundled plugin
    datasets?: { name: string; access?: 'read' | 'write'; description?: string; tables?: unknown[] }[]; // dataset needs, service plugins only (CB-451)
    releaseNotes?: { version: string; date: string; title?: string; notes: string }[]; // newest first, see Release notes below (CB-527)
    delegation?: {
        // socio access (CB-232), service plugins only
        contract: 1;
        actions: Record<string, 'read' | 'write' | 'admin'>;
        public?: string[]; // paths served without an envelope
        alwaysAsk?: boolean; // every access request shows the person's card
    };
}

interface PluginConfigField {
    description: string;
    default?: string; // always a string, as every value is stored
    type?: 'string' | 'boolean' | 'number' | 'integer' | 'enum' | 'cron' | 'url'; // default 'string'
    options?: string[]; // enum only: the choices, in order
    required?: boolean; // an empty value is refused on save, unless there is a default
    min?: number; // number and integer only
    max?: number;
    pattern?: string; // string only: a regular expression the whole value must match
}

interface PluginServiceSpec {
    image?: string; // exactly one of image and build
    build?: { context: string; dockerfile?: string; target?: string };
    port: number;
    env?: Record<string, string>;
    secrets?: { name: string; target: string }[];
    healthcheck?: {
        path?: string; // default /healthz, no ingress proof
        intervalSeconds?: number;
        timeoutSeconds?: number;
        command?: string[];
    };
    resources?: { cpus?: number; memoryMb?: number };
    replicas?: number; // default 1; disable scales to 0
    volumes?: {
        name: string;
        mount: string;
        shared?: boolean;
        driver?: string;
        ephemeral?: boolean; // a cache: never backed up, empty after a restore
    }[];
    backup?: { protocol: 1; schema: number }; // required with any volume not ephemeral (CB-458)
    egress?: (string | { fromConfig: string })[]; // host or host:port, or a url setting's host; absent means no outbound network
}
```

`image` is a prebuilt reference. A reference with no tag gets `:latest`, or `APPS_RUNTIME_IMAGE_TAG` when that is set. A digest (`name@sha256:…`) is left as it is. The runtime refuses an image that does not start with a prefix in `APPS_RUNTIME_IMAGE_ALLOW`. That list is the runtime's, not the manifest's, so a catalog file cannot widen it.

A `file:` catalog must pin `image` as `name@sha256:<64 hex>`. A tag is refused, and `build` is refused. The bundled planner keeps a repository name in source; the operator pins the digest in `APPS_RUNTIME_IMAGE_PINS` and `SOCKET_PROXY_IMAGE_PINS` (the same value). When the runtime's Docker host is `tcp://` (the proxy), a service whose image is not that pin is not created. **Moving a plugin to another registry:** change the catalog's `image`, both pins and `APPS_RUNTIME_IMAGE_ALLOW` to the new location at the same digest, and redeploy, so Socio restarts with the new catalog (it reads the catalog only at start). An installed plugin then follows the catalog by itself on its next provision or the plugins check (within ten minutes of the restart): only its image changes, since the bits are the same. A new digest, or any other change to the manifest, still waits for an admin's **Update**.

**Volumes and backups (CB-458).** Keep a plugin's data in workspace [datasets](#datasets) and files first: they are in every scheduled backup, and nothing below applies to them. A plugin's own named volumes are backed up only when its manifest declares `service.backup` and its image answers the snapshot protocol. Every volume is the plugin's state unless it sets `ephemeral: true`, which marks a cache: never backed up (once plugin restores exist, a restore will start it empty; nothing restores plugin volumes yet). A manifest with any volume that isn't ephemeral must declare `service.backup`: `protocol` is the snapshot protocol version the image speaks (`1`), and `schema` is the highest data schema version the image opens, a whole number from 0 that the plugin raises when its on-disk format changes. The workspace snapshots such a plugin over `/__cb/backup/…`, a prefix the apps proxy never forwards for a person, signed with a host envelope (`acc: "host"`) that the SDK takes there and nowhere else, and pinned to one task with the runtime's `x-cb-runtime-task` header, and it will refuse to restore a snapshot from a newer schema. The image's side is ready: in Node, `socio.backup.serve({ volumes: { data: '/data' }, schemaVersion })` from `@socio/app-sdk` answers the snapshot and restore routes, copies SQLite databases standalone (no `-wal`, `-shm` or `-journal` files), holds writes while the workspace asks, restores in restore mode (`CB_RESTORE_SNAPSHOT`) and holds outward work after a restore (`CB_RESTORE_HOLD`) until an admin releases it; in any language, implement the same routes and run the conformance kit, `@socio/app-sdk/backup-check`, in the plugin's CI. A plugin in another repository vendors those files (packages/app-sdk/README.md, Backups).

**What the workspace does with it (CB-458 step 5).**

- **Every scheduled backup** takes a snapshot of each enabled plugin that declares `backup`, one plugin at a time, under the run's lock and stamp, after the database and the data spaces. Each has 30 minutes for preparing and fetching; a plugin that hangs, answers `failed`, lies about a hash, goes over its size cap or runs short of space fails alone, with its reason (never a path), and the workspace's own backup and off-site copy go on. A disabled plugin isn't started for it: its snapshots stay, and its status says since when. The host fetches only the chunks its store lacks, seals them on the backup volume under the data key (so plugin snapshots need `DATA_ENCRYPTION_KEY`), then re-reads every chunk of the new snapshot and checks each database's integrity (the level 1 drill); one that fails the check isn't kept.
- **Space.** The SDK's default handler copies every file of a volume into its work directory first, so a plugin's volume needs about its own size free; short, the SDK answers `failed` with "There isn't enough free space on volume …", and that is the reason admins see. On the host, `BACKUP_DIR` must hold the new chunks plus 10%, checked before anything is fetched.
- **Size.** One plugin's snapshot holds at most 20 GiB by default (`PLUGIN_BACKUP_MAX_GB`), which an admin raises in **Settings → General → Plugin backups**.
- **Back up now** on the plugin's page (admins, audited as `backup`) takes one at once, in the background; a second click while it runs joins it. The page lists the snapshots the workspace keeps, with their reason, size and version.
- **`socio.backup.request({ reason })`** from the plugin (`POST /api/plugins/<id>/backup/request`, with the plugin's own identity token and proof; the shared token and a person's session are refused) asks for one. A request while one is being taken joins it; otherwise at most one an hour and four a day are taken (429 with `Retry-After` beyond). The reason, up to 200 characters, shows in the plugin's backup history.
- **Status and notices.** The Plugins page, the plugin's page and Service setup show each plugin's state: **Not backed up** (no `backup` declared, or none taken yet), backed up (`ok`, with the last time and size), **Backup out of date** (`stale`, no good snapshot for two backup intervals), **Backup failing** (`failing`, with the reason, since the first failure in a row) or `disabled`. Admins get a notice (`plugin_backup`) on the first failure, when a plugin's backup goes out of date, at most once a day while either lasts, and when it works again. A plugin backup failure never fails the workspace's backup or blocks a workspace upgrade.
- **Retention.** Run snapshots go with their run (`BACKUP_KEEP`), and snapshots outside a run keep the newest 3 per reason. An installed plugin's newest good snapshot also stays past those until a newer one succeeds, so a plugin whose snapshots keep failing is never left with none.
- **Off-site**, the scheduled run and `pnpm run backup` alike send the run's plugin snapshots inside the run, `snapshots/<stamp>/plugins/<id>/<snapshotId>.json.sealed`, before its `complete`; the others to `plugin-snapshots/<id>/<stamp>-<snapshotId>/snapshot.json.sealed`; and each chunk once to `plugin-chunks/<id>/<name>.sealed`, named by an HMAC of its hash (docs/SETUP.md, Off-site copy).

Restores, the pre-update and pre-uninstall snapshots come in later steps. Meanwhile:

- At catalog load, an entry with a volume that isn't ephemeral and no `service.backup` logs "Not backed up: this release is the last that installs it", and the catalog shows the same warning on the entry before install. The next minor release refuses the entry, and install and **Update** refuse the plugin.
- Any entry with a volume that isn't ephemeral, with `backup` or without, also logs and shows "Keeps data in private storage; plugins should use workspace datasets and files", for as long as it declares one.
- An installed service plugin with a volume that isn't ephemeral whose entry declares no `backup` shows **Not backed up** on the Plugins page and its own page, and Service setup lists it under **Plugin data**. It keeps running, shown in red; admins get a notice (`plugin_backup`) when it is first flagged and a reminder each week until the installed version declares `backup`: status reads the installed manifest, so after the catalog entry is fixed an admin applies the plugin's **Update**. A notice that couldn't be delivered is sent again with the next check. When each plugin was flagged is kept in `BACKUP_DIR/plugin-backups.json`.

`build` is a context relative to `APPS_RUNTIME_BUILD_ROOT`. The socket proxy does not allow the build API, so a deployment that uses the overlay cannot build. The planner does not use this: its image is the `plugin-social-strategy` stage.

`env` keys match `[A-Z_][A-Z0-9_]*`. The manifest must not set `CB_*`, `PORT` or `SOCIO_IDENTITY_FILE`. The runtime injects `CB_PLUGIN_ID`, `CB_PLUGIN_PROOF`, `CB_ACTOR_KEY` and `CB_APP_ID=plugin:<id>` (the actor envelope's key and audience, for `@socio/app-sdk`; see [Socios](#socios-acting-for-a-person)), `PORT`, and `SOCIO_IDENTITY_FILE` (the plugin's identity, see [Calling back into Socio](#calling-back-into-socio)). Other `SOCIO_*` names are the plugin's. Per-install config is merged as `PLUGIN_CONFIG` (JSON) when the admin set any.

**Secrets a plugin reads (Socio Secrets phase 2).** A manifest declares them at the top level, as an app's does: `"secrets": [{ "name": "STRIPE_API_KEY", "required": true, "description": "Charges cards" }]` (names `UPPER_CASE`, at most 50, `required` true unless false, a one-line description, and a name can't also be a `service.env` key). An admin grants a workspace secret or sets the plugin's own on **Settings → Secrets**, and the plugin reads them with `socio.secrets.get` / `require` / `onRotate` from `@socio/app-sdk`, through its identity. A plugin whose required secrets aren't all set shows **Needs setup** there; it still starts. See [SETUP.md, Secrets for workspace apps and plugins](SETUP.md#secrets-for-workspace-apps-and-plugins).

**`service.secrets` is deprecated** (Socio Secrets phase 2): a Swarm secret in a manifest is a platform detail and a hand-made secret. It still loads and mounts for one release, with a warning at catalog load naming the plugin; then it is refused. Move each one to a declared secret above. What it does until then:

`secrets` name Swarm secrets. The value never appears in the manifest. `target` is `/run/secrets/<file>`. The runtime mounts the file at mode `0400` for uid `1000` (the image's `node` user). The container runs as `1000:1000` with a read-only root, `cap_drop: ALL`, and `no-new-privileges`, so a secret mounted for uid 0 would be unreadable. Swarm rejects a reference that has a name and no id (`malformed secret reference`). Before create, the runtime resolves each name to an id with `GET /v1.44/secrets?filters={"names":{"<name>":true}}` (`names` is an exact match; `name` is a prefix and is refused) and sends `SecretID` with `SecretName`. The proxy checks that `SecretID` is the id of that exact name. That call is allowed only for names listed in both `APPS_RUNTIME_SECRET_NAMES` and `SOCKET_PROXY_SECRET_NAMES` (the same list; empty by default now). The bundled planner mounts none since phase 2, and `PLUGIN_SERVICE_TOKEN_SECRET` is no longer read.

**Names on a shared swarm (CB-327).** Swarm object names are global per swarm. Every plugin service, network and volume the runtime creates starts with `PLUGIN_NAME_PREFIX` (`socio-plugin` by default): `<prefix>-<id>`, `<prefix>-net-<id>` and `<prefix>-<id>-<volume>`. Plugin identity secrets carry it too: `<prefix>-wl-<id>-v<n>`. Set the same value on `apps` and `docker-socket-proxy`; the proxy refuses any other prefix. A second deployment on the same swarm sets its own prefix (for example `example-plugin`). Swarm secret names are at most 64 characters, so the prefix and the plugin id together leave room for `-wl-` and `-v<n>`; a longer pair is refused at install.

`egress` is a list of hostnames (`api.example.com` or `api.example.com:443`). No wildcards and no IP addresses. Absent or empty means the plugin has no path off its network. When it is set, the runtime refuses to install unless `APPS_RUNTIME_EGRESS_PROXY` and `APPS_RUNTIME_EGRESS_SERVICE` are set. It then puts a signed proxy URL in `HTTP_PROXY` and `HTTPS_PROXY` for those hostnames only, and attaches the egress service to that plugin's network. The network stays internal, so the container still cannot route to the internet itself.

**A host from a setting (CB-441).** An entry may be `{ "fromConfig": "<FIELD>" }` instead of a hostname, for a host only the admin knows, such as the domain of a Cloudflare Worker the plugin calls: `"egress": ["api.example.com", { "fromConfig": "WORKER_URL" }]`. `FIELD` must name a field the manifest declares in `config` with `"type": "url"`; the catalog refuses the manifest otherwise (an undeclared field, another type, or an object with any other key), naming the plugin and the field. Socio resolves each such entry at every provision, so the runtime only ever receives hostnames (it refuses an unresolved entry): it takes the field's installed value, or its `default` when that is empty, and adds the URL's host (with its port when one is written, so `https://forms.example.com:8443/x` allows `forms.example.com:8443`). The value must be `https`, and the host passes the same rules as a hostname in the manifest: no IP addresses, no single-label names, no `localhost` and no `.local`, `.internal`, `.lan`, `.home` or `.arpa` names. An empty or unusable value adds nothing; the plugin still installs, and a plugin whose only egress is that entry gets no egress proxy at all. Saving the setting changes the install revision, so the service is provisioned again once the settings apply, and the allow list follows the setting. The plugin's page lists, under **Outbound network**, the hosts its service may reach (the setting's host marked as such) and, for a setting that added none, why. The catalog's update check (CB-370) compares the manifest as written, entries included, so a changed `fromConfig` entry is an update like any other change. When a plugin's resolved egress becomes empty (the setting cleared, or an update dropped every host), its provision and the network repair detach the egress proxy from its network, so nothing it kept can leave. **Known limit:** egress credentials are stateless (the proxy checks a MAC over the plugin id and its allow list), so credentials for an earlier host stay valid while the plugin still has some egress; a plugin that saved its old `HTTPS_PROXY` could still reach the old host. This is how every egress allow list has worked (a catalog update that drops a host is the same); revoking superseded credentials needs a key epoch in the egress proxy.

`healthcheck.path` is fetched on the container's own port and must answer without the ingress proof. Other paths on the plugin must require `x-cb-plugin-proof`.

`resources.cpus` is 0.1–8. `resources.memoryMb` is 16–8192. A manifest that omits one gets 0.5 CPU and 256 MB. Every service is created with both limits.

A manifest is rejected if it sets `privileged`, a host network, devices, extra capabilities, bind mounts, or any field the catalog does not list. `checkServiceSpec` rejects the same keys if they arrive on the runtime's API.

**Settings** (`config`; typed since CB-395). Each key is a setting an admin changes on the plugin's page, and the plugin reads all of them as `PLUGIN_CONFIG` (JSON). Values are always stored and delivered as strings, whatever the type: `"true"`, `"25"`, `"0 9 * * 1-5"`. A field without a `type` is a free-text string, exactly as before, so older manifests keep working unchanged. The type decides the input and the check:

| `type`             | Input             | A value must be                                                                                                                                                      |
| ------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `string` (default) | text field        | anything; with `pattern`, a full match of it                                                                                                                         |
| `boolean`          | switch            | `true` or `false`                                                                                                                                                    |
| `number`           | number field      | a finite number, between `min` and `max` when set                                                                                                                    |
| `integer`          | number field      | a whole number, between `min` and `max` when set                                                                                                                     |
| `enum`             | list of `options` | one of `options` (1 to 100 distinct, non-empty strings)                                                                                                              |
| `cron`             | text field        | five fields (minute hour day-of-month month day-of-week), six with seconds first, or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`, `@annually`, `@midnight` |
| `url`              | text field        | an absolute `http` or `https` URL                                                                                                                                    |

An empty value means "not set": it is left out of `PLUGIN_CONFIG`, so the plugin uses its own default. `required: true` refuses an empty value when there is no `default`. The settings form and the server run the same check (`packages/shared/src/plugins/plugin-config.ts`): the form shows the error under the field and does not send the save, and `PUT /api/plugins/<id>/config` refuses a value that doesn't fit with a 400 that names the setting. A required setting may be empty at install; the admin fills it in on the plugin's page.

**Saving (CB-398).** The plugin's page saves settings as they change, with no Save button: a switch or a list at once, typing once it rests for a moment, or when the field is left or Enter is pressed. Only values that pass their check are sent; a field with an error shows it and keeps its saved value while the others save. The page says "Saving…" and "Saved", and shows a refused save's reason. **Undo** and **Redo** (and Ctrl+Z or ⌘Z, Ctrl+Shift+Z, ⌘⇧Z or Ctrl+Y) step back and forth through the saves made since the page opened, saving each step; a new change drops the steps ahead of it. Inside a text field with nothing new to save, the field's own undo applies. Saving and applying are apart for a service plugin, whose service restarts (a provision, with a new identity version) to take new settings. Each save is stored at once (`PUT /api/plugins/<id>/config` answers `applyInMs`), and the service gets the stored settings once saves stop for `PLUGIN_SETTINGS_APPLY_DELAY_MS` (10 seconds, `src/server/plugins/service.ts`); each save starts the wait again, so a burst of edits restarts the plugin once. The page says the plugin restarts with them in a few seconds, then "Applied", and offers **Apply now**; leaving the page, or closing the tab, applies them at once (`POST /api/plugins/<id>/apply`, which answers once the service was given them). Each Socio process runs one apply at a time per plugin; saves made during one get exactly one more after it, and an apply for settings the service already runs restarts nothing. Until it applies, the service runs its previous settings and, as for any service not on its installed revision, its webhook paths answer `502`. Settings are never lost to a crash before they apply: the boot's check and the plugins tick provision what is stored. A disabled plugin's saved settings are what **Enable** provisions. Because a save carries the whole set, the server checks what it changes: a value kept as it was saved is accepted even if a newer manifest typed it differently, and a required setting that was never set may stay unset while others save, but a new value that doesn't fit, or clearing a set required setting, is refused. When an update adopts a manifest that types a kept setting differently, the value stays and its page shows the error until an admin fixes it. A catalog refuses a manifest whose field is malformed: an unknown key or type, `options` on anything but an enum, `min` or `max` on anything but a number, `pattern` on anything but a string or one that doesn't compile, `min` above `max`, or a `default` that doesn't fit its own type. Types are for usability, not secrecy: a credential is never a setting; declare it under `secrets`.

```json
"config": {
    "SYNC_ENABLED": { "description": "Sync with the CRM.", "type": "boolean", "default": "false" },
    "AUTH_MODE": { "description": "How it signs in to the CRM.", "type": "enum", "options": ["pit", "oauth"], "default": "pit" },
    "SYNC_CRON": { "description": "When it syncs.", "type": "cron", "default": "*/15 * * * *" },
    "EDGE_URL": { "description": "The edge link.", "type": "url", "required": true },
    "PAGE_SIZE": { "description": "Rows per call.", "type": "integer", "min": 1, "max": 500, "default": "100" }
}
```

`audience` is the install's starting audience; an admin changes it on the plugin's page (see [Who may use a plugin](#who-may-use-a-plugin)).

`bridge.open` lists https URLs (host and path; no port, credentials, query or fragment) that the embed may ask the host to open in a new tab. A path ending in `/` allows the paths below it; any other path must match exactly. Absent or empty, the host opens nothing for that plugin. The planner lists `https://x.com/intent/post` and `https://twitter.com/intent/post`.

`bridge.openAnyHttps: true` lets an embed ask the host to open **any** https link in a new tab: a website, a stored file, a PDF. A link `bridge.open` lists still opens at once; any other opens only after the person confirms it in a dialog the workspace draws, outside the frame: "Open docs.example.com in a new tab?", with the plugin's name and the whole link, and **Open** / **Cancel** (Cancel has the focus, and **Open** stays off for half a second after the dialog appears, so a click meant for the plugin can't land on it). Only `https:` with a dotted host and no credentials; any port, path, query or fragment. `http:`, `javascript:`, `data:`, `blob:`, `file:` and every other scheme are refused, with no dialog. The tab opens with `noopener,noreferrer`. It is a **sensitive scope**: the plugin's install page, its own page under Settings → Plugins, and an update that adds it show it with a "Sensitive scope" warning, and such an update lists it in its review before **Update** adopts it. The server enforces it: `POST /api/plugins/:id/install` for a manifest that declares it must send `{ "acknowledged": ["bridge.openAnyHttps"] }`, or it answers 409 and changes nothing, so a page loaded before the catalog changed can't grant it unseen (the page reloads and shows the warning). An update that adds it is one addition of its review, acknowledged like the rest (see **Update** under [Install, enable, disable, uninstall](#install-enable-disable-uninstall)). An update of a plugin that already has it needs no acknowledgment for it. A boolean; only for an embed (a tab plugin opens its own links). Absent or `false`, only `bridge.open` links open, as before.

`bridge.routes: true` turns on deep links for an embed (CB-446, below). Absent or `false`, the plugin's address is `/plugins/<id>` alone, as before.

`datasets` names the workspace datasets a service plugin needs (see [Datasets](#datasets)): at most 16, each a `name` of 1 to 63 letters, digits, `_`, `-` or `.` starting with a letter or digit (unique without regard to case; it is how the plugin names the need in the data API), an optional `access` (`read` or `write`; absent means `write`), optional `tables`, and an optional one-line `description` (at most 500 characters). Any other key is refused.

`permissions` may include `person:read` (see [Who the plugin sees](#who-the-plugin-sees)).

`delegation` is a service plugin's socio-access contract (see [Socios](#socios-acting-for-a-person)). Its actions are named by the plugin and given a tier: `read`, `write`, `consequential` (each call approved by the person, once) or `admin` (never a socio's). Names starting with `data:` are reserved for Socio's data operations and refused, as are any other keys (no scopes of its own, no `ownerColumn`). A bundled plugin needs none: its tools are its actions, which keep their read and write tiers.

### Release notes

`releaseNotes` gives the workspace the plugin's notes for its versions (CB-527). Socio reads them from the catalog's manifest when an admin installs or updates the plugin (a bundled plugin's when a new Socio build brings a new version), never live from anywhere else, and keeps each plugin's history across updates: the newest 50 versions. A version listed again takes the new manifest's text. Uninstalling removes them.

- A list of 1 to 20 entries, newest first, each version once. The first entry's `version` is the manifest's `version`.
- `version` is SemVer without a `v` (`1.4.0`, `2.0.0-rc.1`); `date` is the day it shipped, `YYYY-MM-DD`; `title` is optional, one line of at most 120 characters; `notes` is Markdown, at most 8 KB (UTF-8 bytes).
- All entries together are at most 64 KB. Any other key is refused, and so is the whole catalog entry when one of these rules is broken.
- The workspace renders `notes` sanitized: raw HTML is dropped, images and anything else that would load are dropped, and links open as any outside link does (an http(s) or mailto link in a new tab, with no referrer; anything else is plain text). Headings, lists, emphasis, code, quotes and tables render.

```json
{
    "id": "bookings",
    "name": "Reference bookings",
    "version": "1.4.0",
    "releaseNotes": [
        {
            "version": "1.4.0",
            "date": "2026-11-20",
            "title": "Waitlists",
            "notes": "- A full slot takes a **waitlist**; the first person on it gets the slot when one frees up.\n- Reminders go out 24 hours before, not 12. See [the guide](https://bookings.example.com/guide)."
        },
        {
            "version": "1.3.1",
            "date": "2026-11-02",
            "notes": "Fixed: a booking made across midnight showed on the wrong day."
        }
    ]
}
```

**Who sees them.** Exactly who may open the plugin now (see [Who may use a plugin](#who-may-use-a-plugin)), checked on the server on every request, for an enabled plugin. In the header's **What's new** and on **Release notes**, each such plugin with notes gets a card: the versions since the person last looked, then the older ones folded away. Opening What's new marks them seen. The first time a person opens the app after the workspace or one of those plugins moved to a newer version, a **What's new** dialog sums it up: the workspace's highlights and a section per updated plugin, with **See everything** opening What's new. Closing it records what it showed as seen on the server, per person, so it shows once per change, on every device. An install shows no dialog. Someone who gains access to a plugin later gets its card, with its stored history, and no dialog for updates from before; someone who loses access stops getting its card, and starts over if they regain it. A disabled plugin is no one's.

**The API** (version 1, the shapes in `packages/shared/src/updates/whats-new.ts`, for the web app and Socio Mobile; signed-in people only):

- `GET /api/v1/release-notes/plugins` answers `{ apiVersion: 1, plugins: [{ id, name, icon?, version, lastSeen, releases: [{ version, date, title?, notes }] }] }`.
- `GET /api/v1/whats-new` answers `{ apiVersion: 1, show, workspace: { from, to, releases, count } | null, plugins: [{ id, name, icon?, from, to, releases, count }] }`, at most 3 releases per part.
- `POST /api/v1/whats-new/seen` with `{ workspace?: "0.53.0", plugins?: { "bookings": "1.4.0" } }` records them as seen (only forward, only to a version that exists, only for plugins the person may open) and answers the `GET /api/v1/whats-new` shape.

## Install, enable, disable, uninstall

**Plugins** in the sidebar is admin-only. It lists the catalog and, under **Installed**, an overview of the installed plugins. Each installed plugin has its own page, `/settings/plugins/<id>` (CB-393; `/plugins/<id>/manage` until CB-446, which still leads there for a plugin without deep links): whether it is enabled, who can use it, its settings, and **Uninstall** apart at the foot, in a danger zone that asks for the plugin's name typed exactly (CB-397).

- **Install** binds the dataset needs its manifest declares to workspace datasets, as the admin chose on the install screen (see [Datasets](#datasets)), mints the plugin's identity, creates the Swarm service with it, then records the install and runs the plugin's schema. If the service or the record fails, the service is removed, the identity revoked and the bindings ended; the datasets stay.
- **Disable** scales the service to 0. The service remains; its identity is refused while it is disabled, and its data tokens end. Its datasets stay.
- **Enable** keeps its bindings, and binds a new dataset to a `write` need that has none (a dataset an admin deleted comes back new and empty), then provisions it at the stored replica count, with a new identity version.
- **Update** (`POST /api/plugins/<id>/update`, admins; CB-370) adopts the catalog's current manifest for an installed service plugin in place, when it differs from the installed one (a new version, image, permissions, datasets or `webhooks`); `GET /api/plugins` marks such a plugin with `update.version`, and its card shows **Update to** with the new version. An installed plugin runs the manifest it was installed or last updated with: a restart, a redeploy or a new catalog file changes nothing it serves until an admin updates it. Update keeps the plugin's data, datasets, config (the settings the new manifest still declares), audience, replicas and sessions. An enabled plugin's service is updated to the new spec first, with a new identity version; when the runtime refuses, nothing else changes (datasets the new version declares are created just before, so it finds them when it starts, and they stay, as when an install's record fails). What the proxy serves on a webhook path is read from the install as the database has it, so an update or a disable on one runtime of a deploy applies on the others at once. Then its sockets close (on the other runtimes of a deploy within 5 seconds, when their socket check sees the changed install), its data tokens end and socios' grants are checked again. Each update is a workspace audit line (`update` on `plugin`, with both versions, the webhook paths before and after, the additions acknowledged and the new manifest's revision). A bundled plugin updates with Socio and is refused here.
- **What an update adds is acknowledged (CB-531).** `GET /api/plugins` gives an installed plugin's `update` as a review: `version`; `from` and `to`, SHA-256 revisions of the installed and the catalog's manifest; `additions`, each with a stable `key` and a `kind`; and `removedSettings`, the settings with a stored value the new manifest doesn't declare, whose values the update deletes. An addition is a host its service may now reach (`egress:<host>`, after `fromConfig` resolves against the stored settings; `host` and `host:443` are one host) or a new `fromConfig` entry (`egress-setting:<field>`); a permission (`permission:<p>`); a `bridge.open` URL, `bridge.openAnyHttps` or `bridge.routes`; a Socio Secret in `secrets`, required or optional (`secret:<name>`), or a runtime secret mounted from `service.secrets` (`service-secret:<name>`), kept apart even under one name; a new dataset need (`dataset:<name>`) or a read need that now writes (`dataset-write:<name>`); a webhook path (`webhook:<METHOD> <path>`) or a raised body or rate limit on one (`webhook-limit:…`); a `delegation.public` path (`public-path:<path>`); a socio action new or at another tier, higher or lower (`action:<name>:<tier>`), or `delegation.alwaysAsk` dropped (`delegation.alwaysAsk`); turning a tab into an embed (`display:embed`); more CPUs or memory than the installed version requests (`cpus:<n>`, `memory:<mb>`, defaults counted); or a new or changed volume (`volume:<name>`). Removals, and a new image, version or plain `env`, add nothing. **Update** opens the review, in plain words, and on confirm sends `{ "acknowledged": { "from", "to", "additions": [<every key>] } }`. When the update adds anything, the server recomputes the review and adopts the manifest only when the acknowledgment names both revisions and exactly its keys; otherwise it answers 409 with `update`, the review as it is now, and changes nothing (the page shows it again). The manifest is written only over the one reviewed (or this same update, committed by another runtime of a deploy): when another update committed meanwhile, or a settings save meanwhile changes what it adds (a `fromConfig` host), it answers 409, the service goes back to what is installed and nothing else changes. An update that adds nothing needs no acknowledgment. The shapes, the diff and its labels are in `@socio/shared/plugins/plugin-update` (`pluginUpdateDiff`, `pluginUpdateAdditionLabel`, `pluginUpdateAck`).
- Every one of these changes starts from the install as the database has it, not the runtime's own copy, so one runtime of a deploy never provisions an older image or an old setting over another's update, disable or settings. Each runtime also reads its list of installs again whenever the table changed (`PRAGMA data_version` on each read, so writes in the same millisecond are seen too), so what it enforces (permissions such as `person:read` and the signed `x-cb-person`, the audience, webhook paths) follows another runtime's update at its next request. Changes on two runtimes at once are not locked against each other. Instead, after each change provisions the service, Socio compares the install as the database has it with the revision the runtime reports for the service (its `socio.plugin.revision`) and, when another runtime's update, settings or disable landed meanwhile in either order, provisions what the database has (or scales it to 0, or back to its replica count), so the service converges on the installed revision, its replicas and its newest identity version (of two provisions, the one with the older identity may land last). The plugins tick (every ten minutes) does the same for every installed service plugin, for what a crash or a race left. A service provisioned before install revisions existed carries none and is left as it is until its next change; until a service carries the installed revision, its webhook paths fail closed.
- **Rotate identity** (`POST /api/plugins/<id>/identity`, admins): a new identity version now (see [Calling back into Socio](#calling-back-into-socio)).
- **Replicas** are the operator's, not an admin's (CB-396): the install takes `service.replicas` from the manifest (1 to 20; the runtime's cap is `APPS_RUNTIME_SERVICE_MAX_REPLICAS`, at most 20), and no page or admin API changes it. Provisioning scales the service itself (to 0 on disable, back to the stored count on enable), changing only `Mode.Replicated.Replicas` on the service's current spec, at the current `Version.Index`. Secrets, healthchecks, resource limits, and networks stay.
- **Uninstall** deletes the Swarm service, the volumes it created and every identity secret, revokes its identity, and deletes the install row, launch codes, and plugin sessions. Its own (workload) Socio Secrets are soft-deleted and its grants end, and so do its data tokens. Rows the plugin stored in Socio stay (`dataKept`), and so do its datasets: its bindings end, the datasets stay the workspace's, and only an admin deletes one, on the Data page; installing it again offers them, preselected. The social planner's posts, replies, and voice notes stay so a later install sees them.

Install by id only, from a catalog this instance configured. Pasting a manifest does not install it and does not run in-process code. A `file:` catalog cannot replace a bundled manifest.

A bundled plugin skips everything that concerns a service. Install records the row and runs its schema; enable and disable flip the row; settings are saved without a redeploy; it has no replicas; uninstall deletes the install row and keeps its data. No runtime, apps host or identity is needed, and `GET /api/plugins` reports it as running while it is enabled.

## Who may use a plugin

Each install has an audience: `admins` (admins and operators) or `members` (everyone who can sign in). An admin sets it on the plugin's page (**Who can use it**, `PUT /api/plugins/:id/audience`); a new install starts with the manifest's `audience`, else `admins`. Every install from before CB-254 is `admins`.

The audience applies to all of a plugin's doors: the sidebar and `GET /api/workspace` launcher entries, `/plugins/:id`, launch codes and plugin sessions (a service plugin's session is checked against it on every request), the data routes `/api/plugins/:id/data/*`, connected agents' tools, in-app socios' tools, socios' grants for the plugin (below), and a bundled plugin's feeds. Narrowing it to admins takes all of those from members at their next request or tool call, including a turn that already had the tools, and ends members' socio grants for the plugin at once. Managing plugins (the catalog, install, settings, audience, uninstall) stays admin-only.

### Socios acting for a person

Socio access (CB-232, behind the **Socios use apps for you** flag, `socio-actor-access`, in development and off) treats a plugin like an app, with the audience `plugin:<id>`, and adds no permission system of its own. Three things decide what a socio may do in a plugin for a person, and each is the one the rest of this page describes:

- **Who may use the plugin** is the install's audience. It is the `plugin:<id>` audience policy's `personMay`, read from the database on every check, so a change on the other runtime of a deploy counts at once.
- **What the plugin does** is its action set: a bundled plugin's tools (only those whose permission the install granted), or a service plugin's `delegation.actions`. A tool's tier comes from its permission by the same rule as a connected agent's per-plugin scope: `<area>:read` reads, anything else writes. So `app:read` on `plugin:calendar` covers exactly what `plugins:calendar:read` covers. The action set's hash is the policy version: a build or manifest that changes it suspends older grants until the person approves again.
- **What the person allowed** is the socio's grant: `request_app_access` names a plugin by name or as `plugin:<id>`, and the person decides on the same card as for an app ("Calendar, installed in your workspace"). Read may skip the card only by the person's own opt-in for that socio; write always waits for them.

With the flag on for a person, a socio's call of a bundled plugin's tool needs a live grant of that person, that socio and that conversation for the plugin that covers the tool's tier; the grant comes from the turn, never from the model. Every refusal is recorded in Socio access's audit. With the flag off, socios use plugin tools as the person, as before. A service plugin is opened by a socio only through the app browser, and only when its manifest declares `delegation` (it verifies the envelope with `@socio/app-sdk`, `appId: plugin:<id>`); a bundled plugin has nothing on the apps host, so a socio uses its tools instead.

A grant for a plugin ends when the person or an admin ends it, when the plugin is disabled or uninstalled, when the person leaves the plugin's audience, and in every other case listed for apps. Its open responses on the plugin's origin close with it.

#### Consequential actions and continuations

A service plugin's `consequential` actions take the same consume-once approvals as an app's, and its queued work the same continuations. Its service calls, with the service token, `x-cb-plugin-proof` and the request's `x-cb-obo` (the envelope's `obo`):

- `POST /api/plugins/<id>/actor/approvals` with `{ action, params, display?, digest? }`: `202 { approval, status, expiresAt, digest }`. The digest is SHA-256 of the RFC 8785 JSON of `{ appId: "plugin:<id>", action, params }`, so an app with the same id never shares one. Socio checks the action is declared `consequential`, the socio's grant for `plugin:<id>` has `app:act`, the 64 KB limit and the cap of three waiting cards. The person's card names the plugin, where it opens and "your workspace (an installed plugin)", then the parameters themselves.
- `POST /api/plugins/<id>/actor/approvals/<approval>/consume` with `{ digest }`: 200 once, for that grant, plugin and digest, else 409. An approval made for one plugin is never used by another plugin or by an app, nor theirs by it.
- `POST /api/plugins/<id>/actor/continuations` with `{ minutes }`: a socio's continuation is a reference token its grant holds, never past the grant; a person's is a sealed `cbob_` naming their plugin session, at most 8 hours. The plugin's data routes take either in `x-cb-obo`, and check the grant (or session and audience) again on every call, so revoking the grant stops the job at its next call. A continuation asks for no approvals.

The audience is the plugin the proof names, and the grant comes from `x-cb-obo`, never from the body. Without the token and that plugin's proof the answer is 401; a person's session never reaches these routes. A person's own `cbob_` gets no approval (400): a person acts for themselves. Refusals say only what is about the plugin's own request (`not_consequential`, `params_too_large`, `params_invalid`, `limit_reached`, `request_malformed`); which check of the grant, person or socio failed stays in Socio access's audit. `data:<op>` approvals are for mini apps (400): a plugin's data routes are its own and take none. While a server of an older release is live, these routes refuse every call, as an app's do. `@socio/app-sdk` with `CB_APP_ID=plugin:<id>` calls them for you (its README, "Service plugins").

## Routing and embedding

The public origin is always the apps host, `appOrigin(settings, id)`, path `entry.path`. The iframe never loads an arbitrary URL.

`display: "tab"` keeps Socio's existing pattern: **Open** uses `/plugins/:id` (it was `/plugins/:id/open` until CB-446; that address still leads there), which asks for a one-time launch URL and opens it in a new tab. That page does not navigate itself to the apps host.

`display: "embed"` renders `/plugins/:id` inside the workspace shell. The frame's `sandbox` is:

```
allow-scripts allow-forms allow-same-origin allow-downloads
```

`allow-downloads` lets a plugin save a file it makes, such as the Events plugin's CSV export (often a blob download). There is no `allow-top-navigation` and no `allow-popups`. `allow-same-origin` applies to the plugin's own origin (the apps host), which is a different origin from Socio, so the frame cannot read Socio's cookies. **Open in a new tab** is a button in the workspace page. **Open in X** posts `open` to the host, which calls `window.open`. A browser may ignore that call when the click's user activation does not cross `postMessage`.

The parent `POST`s `/api/plugins/:id/launch`. The iframe `src` is `<plugin-origin>/__cb/auth?code=…`. The code is one row in `plugin_codes`, single-use, and lives at most 60 seconds (`min(codeTtlMs, 60_000)`). Redeeming it deletes the row and sets a host-only session cookie on the plugin origin (`cb_app`, or `__Host-cb_app` on https). The cookie is `HttpOnly`, `SameSite=Strict`, `Secure` on https, and has no `Domain`, so it is not sent to Socio or to another plugin. Socio's session cookie is `cb_session` on the workspace host (`SameSite=Strict`, no `Domain`). The apps host is a different host, and the proxy drops `Cookie` on the way to the plugin anyway. The session hash is a row in `plugin_sessions`. The proxy then forwards to the runtime ingress with `x-cb-user` (an opaque HMAC) and `x-cb-access`, and strips the cookie and any client-supplied `x-cb-*` headers. The plugin process holds no session.

For an embed, the proxied HTML gets a second CSP of `frame-ancestors <workspace origin>`. A tab plugin gets `frame-ancestors 'none'`. If the plugin sent no CSP, the proxy also sets `default-src 'none'; script-src 'self'; …`. HTML from a plugin gets `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: cross-origin`, and `Referrer-Policy: same-origin`. CORP is `cross-origin` because the workspace origin frames the plugin; `same-origin` would refuse that load. `X-Frame-Options` from the plugin is dropped so it cannot override `frame-ancestors`. The workspace page's `frame-src` allows that plugin origin on the plugin's address, `/plugins/:id` and everything under it, matched as the router matches `plugins/:pluginId/*` (`pluginAddress`: `plugins` in any case, the id percent-decoded once), while the plugin is installed, enabled, and `display` is `embed`. **Open** on an embed is a full document navigation (`reloadDocument` on that link), so the browser applies that route's policy. A client-side navigation would keep the previous document's CSP, which has no `frame-src` for the plugin, and the iframe would be blocked. Plugin origins are not added on any other route. The default Content-Security-Policy string of the workspace is unchanged.

**WebSockets** (CB-239). A service plugin can take WebSocket upgrades on its origin, through the proxy and the runtime ingress, with the same checks as its HTTP requests and as a mini app's sockets: the `Origin` must be the plugin's own; a person needs their plugin session (the same CB-254 headers and, with socio access on for them, the envelope); a socio needs its credential and the context proof over the upgrade's exact request-target, and gets the envelope only, never `x-cb-user`, `x-cb-access` or `x-cb-person`. Every identity header is signed for the ingress, and the handshake's answer loses `Set-Cookie`. A socket closes when the plugin is disabled or uninstalled, when its audience no longer includes the person, when the person is deactivated, within 5 seconds of their plugin session ending on any runtime, when a socio's grant is revoked (CB-232), and after `APPS_IDLE_SECONDS` of silence.

### Public webhooks

A service plugin that integrates a SaaS can take its webhooks, and one OAuth install callback, on its own origin, through the same public edge as its pages (CB-370). It declares each path:

```json
"webhooks": [
    { "path": "/webhooks/crm", "maxBodyBytes": 131072 },
    { "path": "/oauth/crm/callback", "method": "GET" }
]
```

- `path` is matched exactly against the request's path (the query is passed on, never matched): 1 to 8 segments of letters, digits, `_`, `-`, `~` and `.`, none starting with `.`, no trailing `/`, not under `/__cb/`, and not the plugin's `entry.path`. At most 10 paths.
- `method` is `POST` (the default) or `GET`. Only one path may be `GET`, for an OAuth callback, and it takes no body.
- `maxBodyBytes` (POST only) is from 1 to 1 MiB, default 256 KiB, and never more than `APPS_MAX_REQUEST_MB`.
- `perMinute` is from 1 to 600, default 120: a fixed one-minute window per plugin and path, in each Socio process (not per sender: behind the edge every sender can look alike). Over it is `429` with `Retry-After: 60`.

The proxy serves a declared path before it looks for a session or a credential, and asks for neither. Another method on it is `405` with `Allow`; a body over the limit (by `Content-Length`, or once a chunked body passes it) is `413`; a disabled or stopped plugin is `503`. These are short plain-text answers and nothing reaches the plugin. Otherwise the body is read whole, the path is checked again against the install as the database has it (an update or a disable while it uploaded refuses it), and the body is passed on byte for byte, so a signature over the raw bytes (a CRM's Ed25519 webhook signature, Stripe's `Stripe-Signature`) still verifies. The sender's headers pass as for any request, except cookies, forwarding headers (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`), every `x-cb-*` header, and an `Authorization` that carries a socio's `cbsa_` credential. No identity header is added: no `x-cb-user`, `x-cb-access`, `x-cb-person`, `x-cb-time-zone` or envelope. The runtime ingress adds `x-cb-plugin-proof`, as for every request it carries. The proxy also names the install revision the database has (`x-cb-runtime-current`: a SHA-256 of the installed manifest and settings, which Socio gives the service as the label `socio.plugin.revision` whenever it provisions it). The ingress reads the plugin service and its tasks fresh and sends the request only while the service runs exactly that revision, and only to a running task whose container (image, environment, secrets and mounts, compared as the socket proxy's digest `SocioRevision`) is the service's current one. So a path is answered only by the code of the manifest that declared it: while an update rolls out, while the database and the service disagree during an update or after a stale change on another runtime, or before a new task runs, the path answers `502` instead. An apps runtime older than this release ignores that header, so run the runtime and socket proxy of the same release. The plugin's answer comes back with the same rules as its pages (no `Set-Cookie`, `nosniff`, `frame-ancestors 'none'` on HTML).

**The plugin authenticates the sender.** A request on a webhook path is anyone on the internet until the plugin checks it: a signature over the raw body with the sender's published key or a shared secret (kept in Socio Secrets), and a timestamp or event id against replays. The OAuth callback must check the `state` it issued before it redeems the `code`. The path set is the installed manifest's: the operator's catalog, adopted by an admin's install or **Update** (see [Install, enable, disable, uninstall](#install-enable-disable-uninstall)); a restart or a changed catalog alone never adds a path. A path that isn't declared still needs a session, as before.

**Standard Webhooks (CB-479).** For a receiver of Socio Forms deliveries, or an adapter that re-signs another service's webhook (Typeform, a Google Form) into the Forms format, use `@socio/app-sdk/webhooks`: `verify`, `sign`, `generateSecret`, `parseSecrets` and a `receiver` that dedupes on `webhook-id`. It is one dependency-free file on Web Crypto, so it runs in Workers, browsers, Node and Bun. See the SDK README, "Standard Webhooks", for the rules it checks, a Typeform adapter and the Apps Script snippet; the wire format is [docs/specs/FORMS-WEBHOOKS.md](specs/FORMS-WEBHOOKS.md).

The edge in front of the apps host must let these requests through. Where the apps host sits behind an access gate (Cloudflare Access, for example), that gate must bypass the plugin's webhook paths, or the whole plugin origin, for the sender; that is the operator's edge configuration, not Socio's. The internal apps listener (socio sessions only) never serves webhooks.

A navigation that has no session and arrives as an iframe (`Sec-Fetch-Dest: iframe`) returns a small page that posts `embed-refused`. It does not redirect into Socio's shell. Any other unsigned request is 401, "Open from Socio".

**Deep links** (CB-446). The whole address `/plugins/:id` is the plugin's: one route, `plugins/:pluginId/*` (id `plugins:frame`), and the platform keeps no page under it (a plugin's settings are `/settings/plugins/:id`; a tab plugin opens from `/plugins/:id` itself). So the router, the page's `frame-src` and the bridge can't disagree about which addresses are the plugin's. For an embed whose manifest has `bridge.routes: true`, the splat, the whole query string and the fragment are the app's own route, exactly: `/plugins/events/events/42?tab=a#b` is the app's `/events/42?tab=a#b`, the app's `/` is `/plugins/events`, and a hash-router app works as `/plugins/events#/events/42`. The app answers any path at its origin (the CB-445 template does).

- **Cold link.** The frame opens once, on mount, at the address's route (the launch's `next`); at `/plugins/:id` with no query or fragment, at `entry.path`. A route the bridge would refuse (`/__cb/…`, `//`, a `.` or `..` segment) opens `entry.path` too. The iframe's `src` is never bound afterwards, and the frame is keyed on the plugin id only. The server renders the frame route for any deep path; with lazy route discovery a tab that has not seen the route gets it from `/__manifest`.
- **Mirror.** `@socio/plugin-ui`'s `installPluginBridge` reports `route` `{ path, query, hash }` (the app's `location`) when it starts and after every location change (`pushState`, `replaceState`, `popstate`, `hashchange`). The host replaces its address through the router (`navigate(…, { replace: true, defaultShouldRevalidate: false })`), never pushing: the app's own history entries are already in the browser's joint session history, so Back steps through them. The route module's `shouldRevalidate` returns `false` when only the splat, query or fragment change, so the route never loads again, and the frame is never reloaded.
- **Go to.** When the workspace's address moves and the app didn't (a workspace link into the open plugin, or Back or Forward across the workspace's own entries), the host posts `go-to` with the route. The SDK's default replaces the frame's URL and dispatches `popstate` so the app's router follows (`installPluginBridge({ onGoTo })` takes it over); the app's next `route` report confirms it.
- **Explicitly.** An app whose own URL doesn't change (a memory router) can send `navigate` with `navigateInHost(path, { replace })`; `replace: false` adds a workspace history entry.

The host acts on `route` and `navigate` only for a plugin with `bridge.routes`; for any other plugin a subpath leads to `/plugins/:id` (`/plugins/:id/manage` to `/settings/plugins/:id`), and its reports change nothing. Every new deep path costs one `/__manifest` request (lazy route discovery; cached per path and per build) and appears in the workspace server's logs. A mirror that is still waiting on discovery is superseded by any newer report, even one back at the committed address, so a late answer never wins. If discovery fails for a mirror (a network error or an error status), that mirror is skipped: the address stays, the frame stays mounted, and the next report tries again (`mirror-discovery.ts`). Any other failed navigation shows the shell's error page as before.

If the frame does not post `ready` within about 8 seconds, or posts `embed-refused`, the page offers **Open in a new tab**.

### Bridge

Messages are `{ v: 1, source, type, … }`.

| Direction     | `source`       | `type`          |                                                                                                                                                       |
| ------------- | -------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin → host | `socio-plugin` | `ready`         | The frame painted.                                                                                                                                    |
| Plugin → host | `socio-plugin` | `resize`        | `height` in pixels.                                                                                                                                   |
| Plugin → host | `socio-plugin` | `open`          | `url` is one the plugin's `bridge.open` allows (opened in a new tab), or with `bridge.openAnyHttps` any https URL (opened after the person confirms). |
| Plugin → host | `socio-plugin` | `embed-refused` | The host shows the new-tab fallback.                                                                                                                  |
| Plugin → host | `socio-plugin` | `route`         | `path`, `query`, `hash`: where the app is. The address follows (replace).                                                                             |
| Plugin → host | `socio-plugin` | `navigate`      | `path` (`/path?query#hash`) and `replace`. The address becomes that route.                                                                            |
| Host → plugin | `socio-host`   | `theme`         | `theme` is `light` or `dark`.                                                                                                                         |
| Host → plugin | `socio-host`   | `go-to`         | `path`, `query`, `hash`. The workspace's address moved; the app goes there.                                                                           |

The host accepts a message only when `event.origin` is the plugin origin, `event.source` is that iframe's window, and `parsePluginToHost` accepts the body: `v` is `1`, `source` is `socio-plugin`, `type` is one of the rows above, and there are no extra fields. `open` must match the plugin's own `bridge.open` (`parsePluginToHost(data, openAllow)`; the launcher entry carries the list): an https URL on a listed host, with no port or credentials, on a listed path (a query string is allowed; another host, another port, another path, `http:`, or `javascript:` is refused). With `bridge.openAnyHttps` (`parsePluginToHost(data, openAllow, openAnyHttps)`; the launcher entry carries `openAnyHttps`, true only for an enabled service embed that declares it), any other https URL is accepted too (`anyHttpsUrl`: `https:`, a dotted host, no credentials), and `bridgeOpenMode` tells the host which it is: `direct` for a `bridge.open` match, opened at once, or `confirm`, opened only after the person presses **Open** in the host's own dialog. One dialog at a time: any `open` that arrives while one is showing is dropped, a `bridge.open` link included. The plugin can't draw or press that dialog (it is the workspace's page, another origin, and the sandbox has no `allow-popups` or `allow-top-navigation`), and it learns nothing back. A plugin with neither cannot open anything. For the planner that is `https://x.com/intent/post` and `https://twitter.com/intent/post`. `route`, `navigate` and `go-to` (CB-446) carry route text, which is untrusted (`pluginRoute`): the path starts with `/`; it has no `//` (so no host), no `.` or `..` segment (`%2e` included), no control character, space or backslash, and is already as a URL parser writes it (percent-encoded), so the workspace address can't resolve outside `/plugins/<id>`; it is not under `/__cb/`. The query is empty or starts with `?`, the fragment empty or starts with `#`, and the three together are at most 2000 characters (`PLUGIN_ROUTE_MAX`), the same limit the launch's `next` keeps (`safeNext`), so any route the address mirrors opens again on a reload, a shared link or a new tab. `navigate`'s `replace` is a boolean. The plugin accepts a message only when `event.origin` is the parent origin, `event.source` is `window.parent`, and `parseHostToPlugin` accepts it (`theme` is `light` or `dark`, `pluginId` is a plugin id; a `go-to` has exactly `path`, `query` and `hash`, under the same rules). `postMessage` is called with that exact origin. `*` is not a target. The proxy sends the workspace origin as `x-cb-parent-origin`. The planner copies it into `<meta name="socio-parent">` and uses it as the `postMessage` target.

## Who the plugin sees

A service plugin gets `x-cb-user`, an opaque id per person and plugin, on every request. It also gets:

- `x-cb-time-zone`: the person's IANA time zone (their profile's, else the workspace's from Operations, else `UTC`). A plugin uses it instead of assuming one zone. (The planner still schedules in New York; it predates this header.)
- `x-cb-person`, only when the install granted `person:read`: the person's Socio user id, name, role and time zone, for "created by" and per-person permissions. It is `<base64url JSON>.<base64url HMAC-SHA256>` over `socio-plugin-person\0<base64url JSON>`, keyed with the plugin's ingress proof (`CB_PLUGIN_PROOF`). It names the plugin and expires five minutes after it is signed. Check it with `verifyPluginPerson(proof, pluginId, header)` (`src/server/plugins/person.ts`). No email address is sent.

The proxy strips every client `x-cb-*` header before it adds these, and signs every one it adds for the runtime ingress (`x-cb-runtime-sig`, CB-232). The ingress passes a plugin no `x-cb-*` header the signature doesn't cover: unlike a mini app, a plugin never gets the unsigned legacy headers an older proxy sent, so during a deploy's overlap a plugin reached through the older app gets no identity headers at all. A bundled plugin gets the real person in-process instead (`PluginContext`, `PluginToolCall`).

While socio access is on for the person (CB-232), every request also carries the actor envelope `x-cb-actor` (`aud: plugin:<id>`, `sub` equal to `x-cb-user`, `acc` `owner` for admins and `space` for members), signed with `CB_ACTOR_KEY`, valid for one minute and for that request only, with an on-behalf-of token `obo` bound to the person's plugin session. A socio's session carries the envelope with `act` and `scp` (its grant's scopes) and `x-cb-time-zone`, and never `x-cb-user`, `x-cb-access`, `x-cb-person`, a cookie or its own credential.

## Replicas

The service is Swarm mode `Replicated`, endpoint mode `dnsrr`. No host port is published. The task joins one internal overlay, `socio-plugin-net-<id>`, and no other network. The runtime attaches the apps service and the app service to that network so the ingress can reach the tasks and the plugin can reach `http://app:4310`. A stack update (an upgrade) rewrites those services' networks from the stack file, which doesn't know the plugins, so Socio joins them (and the egress proxy, for a plugin that declares egress) to every enabled plugin's network again at start and every minute, through the runtime's `POST /v1/services/:id/networks` (`{ egress }`). Each attach is a no-op when the service is already there.

**Private images.** A plugin image on a private registry pulls with the `PLUGIN_REGISTRY_AUTH` login: an admin's workspace secret of that name on Settings → Secrets (granted to nothing; Socio reads it itself, audited as `system:plugins`), else the deployment's `PLUGIN_REGISTRY_AUTH(_FILE)`. Its value is JSON, `{"registry": "ghcr.io", "username": "…", "password": "…"}`; for GHCR, use a classic token with only `read:packages`, from an account meant for it. Socio sends it with every plugin service create and update, as Docker's `X-Registry-Auth`, only when the image is on that registry; Swarm keeps it with the service and uses it on every task start, on any node, and an update without it keeps the one the service has. The service's `socio.registry` label is the login's fingerprint (an HMAC keyed with the apps runtime's token, 32 hex digits); the plugins check provisions again any service whose label isn't the current login's, so a new or rotated login reaches every plugin within ten minutes, including a service provisioned before install revisions (no revision label), once per login. Another plugin is not on that network, and the services do not forward between networks. The runtime ingress looks up task addresses and round-robins them. A connection that fails before the body is sent is tried on another task. There is no session affinity.

A plugin with `replicas` above 1 must be stateless, or every volume must set `shared: true` and a driver other than `local`. A local volume is one task's disk. The planner ships with `replicas: 1` and no volumes. Its posts, replies, and voice notes live in Socio's database, and its sign-in lives in `plugin_sessions`, so any replica can render the next request. The operator sets `replicas` in the manifest before install (there is no admin control for it):

```yaml
service:
    replicas: 2
```

Two tasks of `company-brain-plugin-social-strategy` then share `SOCIO_API_URL` and the same identity secret. Do not put a session, a launch code, or a SQLite file on the plugin's disk.

`/healthz` stays open inside the container so Swarm can probe it. The ingress adds `x-cb-plugin-proof` on the way in (HMAC of the runtime token and the plugin id) and strips any proof the client sent. The planner rejects every other path without that proof.

## Calling back into Socio

A plugin that sets `SOCIO_API_URL` calls `POST/GET /api/plugins/<id>/data/…` with:

- `Authorization: Bearer <its identity token>`: the contents of the file `SOCIO_IDENTITY_FILE` names, read again on each call
- `x-cb-plugin-proof`, the same proof the ingress injected (the planner reads `CB_PLUGIN_PROOF`)

**The identity (Socio Secrets phase 2).** Each plugin service has its own identity token (`cbpi_…`, 32 random bytes), which Socio stores hashed and binds to that one plugin, so a call or a secret read is attributed to and authorized for exactly that plugin. Socio mints a new version on every provision (install, enable, a config change, **Rotate identity**) and the apps runtime delivers it through its identity delivery adapter: on Swarm, a Docker secret `<PLUGIN_NAME_PREFIX>-wl-<id>-v<n>` labelled `socio.managed=plugin` and `socio.plugin=<id>`, created through the socket proxy and mounted at `/run/secrets/socio_identity` (0400, uid 1000); the service is updated to it and the older versions' secrets are deleted (the proxy creates and deletes only secrets of that shape, and a service may mount only its own). The previous version is still accepted for 15 minutes while old tasks drain. A plugin installed before phase 2 gets its identity when Socio starts (retried every 10 minutes), with no operator step. In development, `APPS_RUNTIME_IDENTITY_DELIVERY=local` writes the token to a 0400 file under `APPS_RUNTIME_IDENTITY_DIR` instead (refused behind the socket proxy).

**Deprecated: `PLUGIN_SERVICE_TOKEN`.** The shared token from before phase 2 is still accepted with the proof for one release, with a warning per plugin in the log, so a plugin not yet given its identity keeps working; it is never accepted for secret reads. The request skips the browser host check only when the token and the proof match and the plugin is installed and enabled. Browser admins can also call those routes with their session.

Whom the call acts as (CB-232):

- With `x-cb-obo` (the envelope's `obo`, passed back for the request it serves): that person, through their live plugin session and the plugin's audience; or, for a socio, the person its grant acts for, for a read (`GET`, `HEAD`) or a write (anything else) that the grant must cover. A token that doesn't open for this plugin, or whose session or grant ended, is refused (403); it never falls back to the service's own reach.
- Without it: the service's own background work, as an operator if there is one, otherwise the first admin. A plugin that declares `delegation` may only read that way; a write for a person must say whose it is.

The planner's env is `SOCIO_API_URL=http://app:4310` (the `app` service on the `apps` overlay network); its token is `SOCIO_IDENTITY_FILE` (`SOCIO_API_TOKEN_FILE` only until its first provision with an identity).

## Datasets

Plugin datasets are workspace-allocated (CB-451). The data belongs to the workspace: a service plugin's manifest declares the datasets it **needs**, and an admin allocates them. For example, a sync that pulls a payment provider into raw tables and rebuilds marts on its own timers writes two datasets, and a dashboards plugin reads what an events plugin writes:

```json
"datasets": [
    { "name": "payments", "access": "write", "description": "Charges and payouts, normalized" },
    { "name": "marts", "description": "Daily revenue, rebuilt every 15 minutes" },
    { "name": "bookings", "access": "read",
      "tables": [ { "table": "events", "columns": [
          { "name": "id", "type": "TEXT" }, { "name": "event_day", "type": "TEXT" },
          { "name": "stated_total", "type": "INTEGER" }, { "name": "as_of", "type": "DATETIME" } ] } ] }
]
```

**Needs.** `name` is the plugin's own handle for the need, what its token and data API calls use, not the dataset's name. `access` is `write` (the plugin writes the dataset, and nobody else does) or `read` (it reads a dataset another plugin writes, or one an admin keeps). `tables` lists what the need expects: for `write`, the tables it will create or keep; for `read`, the tables and columns it needs to find. **A need without `access` means what it always did:** `write`, a new dataset, bound at install with no question to the admin, so plugins written before CB-451 work unchanged.

**Binding.** Each need is bound to one workspace dataset (`data_plugin_bindings`). At install, the admin chooses per need on the install screen (`GET /api/plugins/<id>/bindings` lists the needs and the candidates; `POST /api/plugins/<id>/install` takes `{ "bindings": { "<need>": "new" | { "datasetId": "…" } | null } }`):

- A `write` need: **New dataset** (the default) or an existing workspace dataset that has no writer and takes its declared tables by the additive rule below.
- A `read` need: an existing workspace dataset whose tables fit, or **Not now**, which installs the plugin with the need unbound: its token doesn't cover it, and the token exchange's answer lists it in `unbound`. A read need never makes a new dataset.
- The screen asks only when a need declares `access` or a dataset was bound to it before; otherwise the plugin installs as it always did. On the plugin's page, **Datasets** shows each binding and rebinds it (`PUT /api/plugins/<id>/bindings/<need>` with `{ "choice": … }`); a read need can be unbound there, a write need only rebound.

**One writer per dataset.** A dataset has at most one live `write` binding, held by a unique index. While a plugin writes it, it is the only writer: people, socios and apps read it through the usual grants and Space sharing, and their writes (rows, tables, indexes, batches, appends) are refused with "Written by <plugin>". Admins still delete or unbind. Any number of plugins may be bound to read it.

**Updates.** An update binds only what its manifest adds (a new need, a missing table) before its service runs; ended needs and access changes apply once the manifest is adopted, for an enabled or a disabled plugin alike, and an update that declares no datasets at all ends the bindings it had. If the update fails, its bindings are put back as the installed manifest has them. Whatever a binding says, the installed manifest's access is the ceiling: a need it declares `read` never writes.

**Compatibility.** Checked when binding, and again whenever the dataset's schema could change:

- A `read` need fits when every expected table exists and every expected column exists with the same type, or one that reads as it: an integer where a decimal (`REAL`, `NUMERIC`, `DECIMAL`) is expected, a date or time where `TEXT` is. Extra tables and columns are fine.
- A `write` need on an existing dataset follows the additive rule for its declared tables (missing tables and nullable columns are added; a column of another type refuses, naming it).
- A writer's manifest update that would break a live reader (retyping or no longer providing a column it expects) is refused, naming the plugin that reads it, until an admin unbinds that reader. Additive changes never are. The data API offers no operation that drops or retypes a column, so the manifest update is where this can happen today. A reader's own update that would no longer fit its bound dataset is refused too.

**Owner.** Bound datasets are owned by the reserved owner `ws:workspace` (beside `socio:<id>` and `plugin:<id>`): the company's, outside every person's data space. A transfer of a person's work (CB-360) and a person's purge never touch them, and they count against no person's quota. Their limits are the plugin dataset limits below. A user id is lowercase letters, digits, `_` and `-`, and every place that takes one (accounts, `AUTH_LINK_USERS`, linking at sign-in, renames) refuses a `ws:`, `plugin:` or `socio:` owner id, so no person can own them. While a runtime of the previous release still runs (a start-first deploy), a new dataset is made with its plugin's `plugin:<id>` owner instead, and moves with the rest (below).

**Uninstall unbinds.** Uninstalling ends the plugin's bindings and its tokens. Its datasets stay, owned by the workspace, shown to admins on the Data page with a "Was written by <plugin>" badge, and bindable to another plugin. Reinstalling offers the previous bindings preselected; nothing is taken back without the admin's choice (an install through the API without `bindings` gets new datasets). Deleting a dataset is an admin's act, never a side effect; it ends the dataset's bindings.

**Migration, with no gap during a deploy.** At start, and every hour after, two steps run. First, each live `plugin:<id>` dataset its installed plugin declares by name, and that no binding ever named, is bound `write` to it under that name; its owner and file stay as they are, which is where a runtime of the previous release looks for it, so both releases' tokens reach it during a start-first deploy (this release's tokens also carry the dataset ids the previous release checks). Then, once no runtime of the previous release runs (the `workspace-datasets` runtime contract), each `plugin:<id>` dataset moves to the workspace owner, keeping its id, grants, Space share, retention, row history and audit; its file and analytical parts move from the plugin's directory to the workspace's, under the file's write lock: a write in flight on any runtime finishes first, the next waits, and one that read the old row is refused rather than written elsewhere (a transfer links a person's datasets under the same lock). Datasets of plugins no longer installed become unbound workspace datasets. The data audit records each binding (`plugin_bind`) and move (`adopt_plugin_dataset`). Take the usual pre-upgrade backup first.

**Tables (CB-369).** A declared need may list its tables, in the shape `POST …/tables` takes, at most 32:

```json
{
    "name": "marts",
    "tables": [
        {
            "table": "daily_revenue",
            "columns": [
                { "name": "day", "type": "TEXT", "primaryKey": true },
                { "name": "total", "type": "INTEGER" }
            ],
            "history": false
        }
    ]
}
```

Install and enable make each one that is missing and add declared columns that are missing (an added column follows the API's rules: nullable, or `NOT NULL` with a default). An existing column of another type refuses the install, naming it; columns are never retyped. `"history": false` makes the table without row history, and turns an existing table's off. Nothing is dropped because the manifest no longer lists it. A plugin may still make its tables through the API instead.

**Field settings (CB-451).** A column of a table the plugin writes may say what it means to a person, so install shows it and every view of the data starts right: `"field": { "kind": "select", "label": "Status", "options": [{ "id": "open", "label": "Open", "color": "blue" }] }`. `kind` is a field kind (`text`, `number`, `currency`, `select`, `person`, …), and the other keys are the settings of that kind: `options` (select, multi-select), `currency` (ISO 4217) and `minorUnits` (currency stored as integer cents), `decimals`, `unit`, `dateFormat`, `allowSocios`. The manifest is refused when a kind doesn't fit the declared type (a `currency` on `TEXT`, cents on `REAL`), and a `person` or `people` field needs the `person:read` permission. Install, enable and update add a column's setting when it has none and never overwrite one: once an admin changes a field in the dataset's Fields panel, it stays theirs. A `read` need's `field` is ignored: the writer's settings apply.

**Analytical tables (CB-369).** The datasets a plugin writes may also hold append-only history as analytical tables: Parquet files queried with DuckDB, joined with the dataset's transactional tables in one query. Make one with `POST …/tables` and `"kind": "analytical"` plus `partitionBy`, append its daily batch in one call (`POST …/tables/:table/append`, NDJSON, with an `x-cb-append-id` so a retry adds nothing), move an existing SQLite table across with `append-from`, and read with `POST …/analytics/query`. See [SETUP.md, Analytical tables](SETUP.md#analytical-tables).

A manifest may declare them too (CB-387), with `"kind": "analytical"`, the analytical column types, `partitionBy` and an optional `retainDays` (1 to 36,500):

```json
{
    "table": "occupancy",
    "kind": "analytical",
    "columns": [
        { "name": "event_day", "type": "DATE", "notNull": true },
        { "name": "space_id", "type": "TEXT", "notNull": true },
        { "name": "people", "type": "INTEGER" }
    ],
    "partitionBy": { "column": "event_day", "grain": "day" },
    "retainDays": 400
}
```

Install, enable and **Update to <version>** make it when it is missing and add declared columns that are missing (nullable: older files read them as null). They refuse, naming the table and the difference, a table that exists with the other kind, another partitioning, or a column of another type or nullability; nothing else of that install or update changes, and a disabled plugin's update is checked the same way. `retainDays` is the installed manifest's (an update that fails changes nothing), unless an admin overrode the table's retention on the Data page: the override wins over every update until the admin clears it. The nightly run retires every partition that ended longer ago than the retention in force, queries stop reading it at once, and its files are deleted 48 hours later (older backups keep them until they are pruned). Without `retainDays` or an override, the workspace default applies (`DATA_ANALYTICS_RETAIN_DAYS`, which keeps everything unless an admin sets it). Analytical tables take no `history`, keys, uniques or defaults.

**Lifecycle.** Install binds each need as the admin chose; enable keeps the bindings and binds a new dataset to a `write` need left without one. Disable keeps them; uninstall ends them and keeps the datasets. Only an admin deletes one; the next enable makes a new, empty one in its place. An admin may rename a workspace dataset: the plugin finds it by its need's name.

**People and socios.** Admins see the datasets on the Data page with a **Written by <plugin>** badge and manage them as an owner does: browse, export, set retention, share with a Space, grant a socio access, delete. Members read one only once an admin shares it with a Space they read. A socio reaches one through the usual dataset grants: an admin grants it on the Data page, or approves when the socio asks (`data_request_access`, never auto-approved). A company socio's grant serves everyone who uses that socio, as its workspace datasets do; a personal socio's grant works only while its owner is an admin.

**The token exchange.** The plugin presents its identity and proof (as for its secrets) and gets a data token for every dataset bound to its needs, each with its binding's access. This is how it works with no person present, on its own schedule:

```http
POST /api/workload/data-token
Authorization: Bearer <contents of SOCIO_IDENTITY_FILE>
x-cb-plugin-proof: <CB_PLUGIN_PROOF>
Content-Type: application/json

{}                                  # or { "datasets": ["marts"] } to narrow it to some needs
```

```json
{
    "token": "cbdt_…",
    "expiresAt": 1789000000000,
    "dataUrl": "/api/data",
    "datasets": [
        {
            "name": "payments",
            "access": "write",
            "id": "…",
            "datasetName": "payments",
            "description": "Charges and payouts, normalized"
        },
        {
            "name": "marts",
            "access": "write",
            "id": "…",
            "datasetName": "marts",
            "description": "Daily revenue, rebuilt every 15 minutes"
        }
    ],
    "unbound": [{ "name": "bookings", "access": "read" }]
}
```

- Only the plugin's own identity token with its proof, for an installed, enabled service plugin: the shared `PLUGIN_SERVICE_TOKEN`, another plugin's proof, a person's session or a data token is refused (`401`, `403` for a data token). At most 30 exchanges a minute per plugin (`429`). `404` when no need is bound (it declares none, an admin deleted them, or left them unbound: the answer's `unbound` says which), or when `datasets` names a need it has no binding for.
- The token (`cbdt_`, purpose `plugin`) lives 15 minutes (at most `DATA_TOKEN_TTL_MINUTES`); exchange again on expiry or on a `401`. Each request checks that the plugin is still installed and enabled and that the identity version it was exchanged for is still accepted, so disabling or uninstalling the plugin ends its tokens at once on every runtime, and rotating its identity ends them when the old version's 15-minute window does. With shared runtimes (CB-108) a token also ends with the runtime that issued it.
- It reaches `/api/data/*` only, and there only the datasets bound to the plugin, by need name or id. The token names the bindings it was issued for, each with its access, so a token narrowed to a read need reads even a dataset another of the plugin's needs writes. A `write` binding allows today's plugin operations; a `read` binding only the read tier (`query`, which read batches are too, `read`, `analyticsQuery` in `DATA_OPERATION_TIERS`): every write to it is `403`. A token is refused the moment a binding ends (`401` once its tokens are revoked, `404` for a newer token). The routes: `GET /api/data/datasets`, `GET /api/data/datasets/:name`, `POST …/query`, `POST …/read-batch`, `POST …/tables`, `POST …/tables/:table/columns`, `POST …/tables/:table/rows` (insert, or upsert with `key`), `POST …/tables/:table/indexes` and `DELETE …/indexes/:name`, `POST …/batch`, and `GET /api/data/usage`. Any other dataset, a person's, a socio's, or a workspace dataset not bound to it, is the same `404` as one that doesn't exist; files are `403`; the user-only routes (delete, grants, exports) are `403`.
- It works as the plugin itself: no `x-cb-obo` (one is refused with `400`). The audit records `plugin` and the plugin's id; row history names `plugin:<id>` as the writer. Writes to its datasets need no approval, even when an admin shared one with a Space.
- **Batches.** `POST /api/data/datasets/:name/batch` runs up to 32 statements in one transaction, all or nothing, including `DELETE` and `INSERT … SELECT` with `json_extract` in the datasets it writes, under the same write guard as single writes. See [SETUP.md, Batches](SETUP.md#batches). A mart rebuilt with `DELETE` then `INSERT … SELECT` in one batch is never seen half built. Rows a rebuild deletes go to the dataset's row history, which is kept and not counted toward its quota, unless the table keeps none: declare a mart with `"history": false`, or switch it off with `PATCH /api/data/datasets/:name/tables/:table` (CB-369). An admin may also keep a dataset's history for a number of days and compact its file ([SETUP.md, Row history](SETUP.md#row-history)).
- **Limits.** Each dataset is held to `DATA_PLUGIN_DATASET_MAX_MB` (100) and each query to `DATA_PLUGIN_QUERY_MAX_ROWS` (500) rows; an admin raises them in **Settings → General → Plugin datasets**. The plugin's token has a statement budget of its own (below).

**A D1-style driver (CB-473, CB-474, CB-475).** A plugin that keeps its records in a dataset (the Events plugin was the first) can run a `prepare(sql).bind(...).all() / first() / run()` driver with an atomic `batch()` over these routes. The wire types are in `@socio/app-sdk` (`DataQueryResult`, `DataReadBatchRequest`, `DataReadBatchResponse`, `DataBatchStatement`, `DataBatchResponse`, `DataBatchExpectationError`, `DataPluginBudget`).

- `all()` and `first()`: `POST …/query` with `{ "sql", "params" }`, answering `{ "columns", "rows", "truncated", "ms" }`; rows are arrays in column order.
- Several reads at once: `POST /api/data/datasets/:name/read-batch` with `{ "statements": [{ "sql", "params"? }], "maxRows"? }` runs up to `batchMaxStatements` (32) SELECTs in one read transaction, so every one reads the same snapshot, and answers `{ "dataset", "datasetId", "statements", "results": [ <a query's answer>, … ], "ms" }` in the order sent. Each statement has the single query's checks (one SELECT, the dataset's own tables, no engine tables, PRAGMA or denied functions), its time limit (`DATA_QUERY_TIMEOUT_MS`, restarted for each) and its row and byte caps; the whole batch stops at `DATA_BATCH_TIMEOUT_MS` (30 s) and its answer at 8 MB (`413`). A refusal names the statement (`"Statement 2: …"`). It is the read tier (operation `query`), so a `read` binding may send one, and it counts as **one** operation against the budget. The snapshot is the file's read lock, held for the batch: a write waits for it to finish (up to 2 s), so keep read batches to reads that answer quickly.
- `run()` and `batch()`: `POST …/batch`. Each statement may carry `"expectChanges": n`: if it changes any other number of rows, the whole batch rolls back and answers `409` with `{ "error": "Statement 3 (index 2) expected 1 change(s) and made 0. Nothing in the batch was kept.", "code": "expect_changes", "index": 2, "expected": 1, "actual": 0 }` (`index` from 0). It is how an optimistic update (`UPDATE … WHERE id = ? AND version = ?`, `expectChanges: 1`) or an insert that must not conflict asserts what it did. The answer's `result.results` has each statement's outcome, as D1's `meta`: `{ "changes", "lastInsertRowid" }` (SQLite's `last_insert_rowid()` after it, a string past 2^53, meaningful after an INSERT), plus `"columns"` and `"rows"` when the statement has a `RETURNING` clause. `result.changes` and `totalChanges` stay as they were.
- **RETURNING.** `INSERT`, `UPDATE`, `REPLACE` and `DELETE` (where the plugin may delete) may end in `RETURNING`. It runs under the same write guard as the statement: it reads only the dataset's own tables (a subquery in it that names an engine table is `403`, as a read of one anywhere is), and the denied functions stay denied. Its rows are all returned or the batch fails: past the query row cap for one statement, or the query byte cap over the batch, it rolls back with `413` naming the statement, because a write's rows can't be cut short without the caller losing what changed.
- **The budget.** A plugin's token has its own budget of data operations a minute, apart from socios' and people's `DATA_STATEMENTS_PER_MINUTE` (120): `DATA_PLUGIN_STATEMENTS_PER_MINUTE`, **600** by default, enough for a plugin page that several people use at once. A query, a read batch, a describe or a single write is one operation; a write batch is one per statement. Past it, `429` says "this plugin may make N a minute". An admin changes the default for every plugin in **Settings → General → Plugin datasets**, and raises (or lowers) one plugin's own on its page under **Datasets** (`GET` and `PUT /api/data/plugins/:pluginId/budget` with `{ "statementsPerMinute": n }`, 1 to 100,000, or `null` to use the default again; admins only, audited as `plugin_budget`). A change applies to the next operation.

### Data API tokens for admins' scripts

A plugin's token is the plugin's alone. A script a workspace admin runs themselves, such as an import, uses a **data API token** instead, made in **Settings → Data API** with the scopes `data:read`, `data:write` and `data:admin`, an expiry (7 days by default, 30 at most) and its own budget (600 a minute by default). It goes through the same data token path (`Authorization: Bearer cbdt_api_…`, purpose `api`) and the same routes, each of which names the scope it needs; a route that names none (deletes, files, exports, grants, settings) refuses it. It reaches the workspace's own datasets that no plugin is bound to, never a plugin's bound dataset, a person's or a socio's: binding a plugin to one of its datasets takes it out of the token's reach. Its writes are `token:<id>`, attributed to the admin who made it. Setup and the audit are in [SETUP.md](SETUP.md#data-api-tokens).

### Testing against the data API

A plugin's tests run against the real data API rules through the data test harness (CB-476): Socio's own app over a temporary data space, with the plugin installed from its manifest. In-process use, the container command for another repository and the distribution notes are in [DATA-TEST-HARNESS.md](DATA-TEST-HARNESS.md).

## MCP tools

Tools are registered on `/mcp` only when the plugin is installed and enabled, the person is in its audience, the install granted the tool's permission, and the connection's OAuth grant has a matching scope. Each plugin has its own scopes: a `<area>:read` permission needs `plugins:<id>:read` and any other `plugins:<id>:write` (`pluginScope`), so a person can consent to one plugin's tools without every plugin's. The legacy `plugins:read` and `plugins:write` (v0.22.0) cover only the plugins that existed when they shipped, `LEGACY_SCOPE_PLUGINS` (the social planner), so grants from then keep working for it; they never cover a plugin added since. Every other plugin, the calendar included, needs its own scopes. A read-only connection gets only the list tools. `/mcp` refuses a `tools/call` outside the granted scopes with `403 insufficient_scope` (naming the plugin's own scope) before any tool runs, as it does for the built-in tools.

The authorization server offers the per-plugin scopes of this instance's catalog (fixed at boot), lists them in `scopes_supported`, and the consent screen names them after the plugin ("Add and change data in the Calendar plugin, if you may use it"). Existing connections do not gain them; the client asks for them and the person approves them on the consent screen.

A plugin tool cannot take a built-in tool's name. Each call checks the install and the audience again, so a grant outlives neither an uninstall nor a narrowed audience.

### In-app socios

The same tools are given to a socio's turns (`pluginsModule.dotTools`), acting for the turn's person: plugins in their audience, every permission the install granted, and no OAuth consent. The plugin applies the person's own permissions. While socio access is on for the person (CB-232), each call also needs their grant for the plugin from this conversation, covering the tool's tier (see [Socios](#socios-acting-for-a-person)). A change a socio makes records the socio's name as how it was made, as a connected agent records "<agent> for <person>".

Only bundled plugins have in-process tools. A bundled plugin declares them once (`BundledPlugin.tools`, a name, description, permission, zod input and `run`), and Socio registers them on `/mcp` and gives them to socios. A service plugin's manifest may list tools, but they have no handler unless its id is bundled.

The planner contributes, and none of them post to X:

| Tool                  | Permission     |
| --------------------- | -------------- |
| `list_planned_posts`  | `social:read`  |
| `create_planned_post` | `social:write` |
| `update_planned_post` | `social:write` |
| `list_reply_queue`    | `social:read`  |
| `create_reply_item`   | `social:write` |
| `update_reply_item`   | `social:write` |

Install grants the whole `permissions` list. There is no partial grant in this version.

The calendar contributes `list_events` (`calendar:read`), `create_event`, `update_event` and `delete_event` (`calendar:write`); see [Calendar](#calendar).

## Catalogs

An instance offers exactly what `PLUGIN_CATALOGS` lists, and nothing else (CB-371). No plugin is offered just because this build ships it: the bundled plugins, the calendar included, are catalog entries like any other. Unset, empty or `off`, the catalog is empty. Offering is not installing; nothing runs until an admin installs it. Entries, comma-separated:

- `bundled:<id>` — a plugin shipped in this build. Unknown ids refuse to boot.
- `file:<path>` — a JSON file `{ "plugins": [ PluginManifest, … ] }` on the server. No URL is fetched.
- `-bundled:<id>` — accepted for compatibility: it stopped the calendar's default offer before CB-371. Since nothing is offered unless listed, it now takes nothing away; drop it from your settings when convenient. Unknown ids still refuse to boot, and listing an id as both `bundled:<id>` and `-bundled:<id>` still refuses to boot, since it is contradictory.

The bundled ids today are `calendar` and `social-strategy`. For example, `PLUGIN_CATALOGS=bundled:calendar,file:/run/catalog.json` offers the calendar and the file's plugins.

**Upgrading from a release that offered the calendar by default (v0.39.0 and earlier).** The calendar used to be offered on every instance without `PLUGIN_CATALOGS`. To keep offering it, add `bundled:calendar` to the instance's `PLUGIN_CATALOGS` (`PLUGIN_CATALOGS=bundled:calendar` if it was unset). An installed calendar keeps working either way: see below.

An exclusion only stops the offer; it never uninstalls anything or deletes data. A plugin already installed when its offer is removed (by `-bundled:<id>`, `off`, or a file entry taken out) stays installed and keeps working, in the state it was in: enabled or disabled, with its audience, settings, tools and data. **Plugins → Installed** shows it marked "no longer in the catalog", and an admin can still disable it or uninstall it there. Uninstall keeps its data, as always. Once uninstalled, it cannot be installed again until the catalog offers it again. Connected-agent scopes come from the catalog at boot, so while a plugin is not offered a new connection cannot be granted its scopes; socios keep its tools. The calendar is the exception: every instance offered it before CB-371, so an installed copy may run anywhere without `bundled:calendar`, and its scopes (`plugins:calendar:read`, `plugins:calendar:write`) stay listed on every instance. On an instance without it installed they grant nothing.

Two operator settings say where a catalog set in `PLUGIN_CATALOGS` may be used (`bundled:calendar` is a catalog too; an exclusion adds nothing, so a `PLUGIN_CATALOGS` of only `-bundled:` entries is allowed on any host). `PLUGIN_CATALOG_HOSTS` lists the public hosts (from `APP_ORIGIN`, or `HOST`) that may offer one; unset, it is this instance's own host, so it adds no restriction. `PLUGIN_CATALOG_DENY_HOSTS` lists hosts that never may. When `PLUGIN_CATALOGS` is set on a host outside the first list or inside the second, Socio refuses to boot rather than offer plugins there. Pin `PLUGIN_CATALOG_HOSTS` to the instance a catalog is for, so a copy of that environment on another instance fails closed; put other instances' hosts in `PLUGIN_CATALOG_DENY_HOSTS` on their stacks as well. These are boot-time environment settings, not admin settings: an admin of the instance they protect must not be able to turn them off.

## Enable the planner on one instance

1. Build the image (it is not pulled). From a checkout:

    ```bash
    docker build --target plugin-social-strategy -t company-brain-plugin-social-strategy:latest .
    ```

    `scripts/build-images.mjs` builds the same target as `plugin-social-strategy` when Portainer is how you build. The tag must match `APPS_RUNTIME_IMAGE_ALLOW` (default prefix `company-brain-plugin-`).

2. No secret to create: the planner gets its own identity at install (Socio Secrets phase 2). The overlay still wires the deprecated `PLUGIN_SERVICE_TOKEN_FILE` on `app` for one release, for deployments whose IaC adapter renders it.

3. Deploy the app's stack with the plugin overlay, on that instance only. The overlay ships with the self-hosting guide, which is coming.

    Set `PLUGIN_CATALOGS=bundled:social-strategy` and `PLUGIN_CATALOG_HOSTS=<this instance's public host>` for that stack. The overlay turns on `APPS_RUNTIME_DOCKER`, the image allow list, and `APPS_RUNTIME_DOCKER_HOST=tcp://docker-socket-proxy:2375`. It does not mount the socket on `apps`.

    After the image exists in the registry the Swarm nodes pull from, pin it. A tag is not accepted once the proxy is in front:

    ```bash
    docker buildx imagetools inspect company-brain-plugin-social-strategy:latest
    ```

    Set both of these to `social-strategy=company-brain-plugin-social-strategy@sha256:<digest>`:

    - `APPS_RUNTIME_IMAGE_PINS` on the apps service
    - `SOCKET_PROXY_IMAGE_PINS` on `docker-socket-proxy`

    They are the same string. The proxy does not ask the runtime what the pin is. A local image with no `RepoDigests` entry has to be pushed first; the image id from `docker image inspect` is not the manifest digest Swarm pulls.

    On a Swarm with more than one node, pin where plugins run. Without a constraint Swarm may start a plugin task on any node: an image built for one architecture fails on the others, and a plugin's named volume (such as `data` at `/data`) exists only on the node that created it, so a task rescheduled elsewhere comes up with an empty volume and no error. **Plugins with volumes must be pinned on multi-node Swarm.** Set both of these to the same comma-separated list of Swarm placement constraints, for example `node.hostname == node-1`:

    - `APPS_RUNTIME_PLUGIN_CONSTRAINTS` on the apps service: set as `TaskTemplate.Placement.Constraints` on every plugin service the runtime creates or updates
    - `SOCKET_PROXY_PLUGIN_CONSTRAINTS` on `docker-socket-proxy`: a plugin service body must carry exactly these constraints (any order) and no other `Placement` field

    Each entry is `<key> == <value>` or `<key> != <value>`, with key `node.id`, `node.hostname`, `node.role`, `node.platform.os`, `node.platform.arch`, `node.labels.<name>`, or `engine.labels.<name>`. A malformed entry stops the runtime or the proxy at startup and names the entry. Empty or unset (the default) keeps today's behavior: no placement, and the proxy refuses any `Placement`. If only one side is set, plugin installs and updates are refused until both match. A service that already exists picks the constraints up on its next install or update; a scale keeps the service's current placement.

    The secret allowlists (`APPS_RUNTIME_SECRET_NAMES`, `SOCKET_PROXY_SECRET_NAMES`) stay empty: they are only for a deprecated `service.secrets`. The proxy forwards `GET /v1.44/secrets` filtered to exactly one name (`filters.names`), an allowlisted one or a plugin identity secret, and returns only its id; it creates and deletes only plugin identity secrets (a delete checked against the engine's copy, by full id). It does not forward an unfiltered list, a prefix filter, any other create or delete, or inspect by id.

4. Mini apps must already be on (`APPS_HOST`, and `APPS_RUNTIME_URL` / `APPS_RUNTIME_TOKEN` as for promoted apps). Plugins are served on the apps host.

5. Sign in as an admin, open **Plugins**, and install **Social strategy**. It appears in the sidebar and opens embedded. The planner UI is the Socio client bundle the plugin service serves (`pnpm planner:ui`, also part of `pnpm build`), so it uses the same components and tokens and follows the workspace theme over the embed bridge. Shared calendar, editor, preview, catalog cards, the page shell, and the bridge client live in `@socio/plugin-ui` (`packages/plugin-ui`). A new plugin imports that package. Its README says how. **Open in X** builds `https://x.com/intent/post?…`. The person publishes the post themselves.

To run more than one replica, the operator sets `service.replicas` in the manifest (1–20) before install; there is no admin control for it (CB-396). The service stays stateless: shared posts in Socio, shared sessions in `plugin_sessions`, no sticky routing.

## Confirm it stays off elsewhere

On an instance that does not set `PLUGIN_CATALOGS` (any other tenant's instance, a checkout with the variable unset), **Plugins** offers nothing, the calendar included. For the planner:

- **Plugins** does not list it. Install of `social-strategy` answers 404.
- The sidebar has no Social strategy entry. `GET /api/workspace` has no plugin launcher entries.
- `/mcp` does not advertise the planner tools.
- `GET /api/plugins/social-strategy/data/state` answers 404.
- The planner tables (`planned_posts`, `reply_queue`, `planner_voice`) are not created. They are migrated when that plugin is installed, not at boot.
- The apps runtime is not given `APPS_RUNTIME_DOCKER=on` and does not mount the Docker socket, and the socket proxy is not deployed, so nothing can create a `socio-plugin-social-strategy` service.

The Plugins nav item is visible to every admin even when the catalog is empty. That is the marketplace page. The planner itself is absent until that instance's catalog lists it and an admin installs it. The calendar is offered only where the catalog lists `bundled:calendar`.

## Calendar

A shared calendar (`calendar`, CB-254), bundled: it runs inside Socio and is offered where `PLUGIN_CATALOGS` lists `bundled:calendar` (CB-371; before that it was offered on every instance). It was built for a venue whose agent copies bookings from Notion, but nothing in it is specific to venues.

**Enable it.** The operator adds `bundled:calendar` to `PLUGIN_CATALOGS`; then an admin opens **Plugins** and installs **Calendar**. That is all: no image, secret, overlay or apps host. Its audience starts as `members`; switch it to admins on its page if only admins should see it. Optional settings on its page:

| Setting    | Values                                                    | Default                                    |
| ---------- | --------------------------------------------------------- | ------------------------------------------ |
| `timeZone` | an IANA zone, such as `America/New_York`                  | empty: the workspace's (Operations), `UTC` |
| `writers`  | `everyone` (everyone in the audience) or `admins`         | `everyone`                                 |
| `editing`  | `own` (its creator and admins) or `everyone` (any writer) | `own`                                      |

**Events.** Title, start and end, all-day, the IANA zone the times are in, location, description, status (`confirmed`, `tentative` for a hold, `cancelled`), visibility (`workspace`: everyone who can open the calendar; `private`: its creator only, admins included), source and source id, a link to the original, who created it and through what (the connected agent or socio), and who changed it last. Times are stored as UTC instants plus the wall-clock times and zone they were given, so 9:00 in New York stays 9:00 there across a clock change. A wall-clock time that a clock change skips is read with the offset before the change (an hour later); one that happens twice is the first.

**Permissions.** Seeing: shared events, and your own private ones. Adding: the audience, or admins when `writers=admins`. Changing and deleting: the creator, admins (shared events only), or every writer when `editing=everyone`. Only an event's creator makes it private.

**Dedupe.** An event created with `source` and `sourceId` (such as `notion` and the Notion page id) is unique on that pair. Creating it again updates the existing event with what the call sends (`outcome: updated`, or `unchanged`) when the person may change it, and is refused with 409 otherwise, without saying whose it is. A Notion page id is the same with or without dashes, in either case, or as its page URL. Two syncs racing on one page make one event (the unique index, in one write).

**Tools.** `list_events` (a range, default today and the next six days, at most 400 days; filters by location, status, source and source id, text, or only your own), `create_event`, `update_event` (by id, or by source and source id; a new start without an end keeps the length; a new zone keeps the wall clock) and `delete_event`. Times are `YYYY-MM-DDTHH:mm` in `timeZone` (default: the calendar's zone, which every answer names), or ISO times with `Z` or an offset; all-day events take dates and their end is the last day. Connected agents need `plugins:calendar:read` / `plugins:calendar:write`; the legacy `plugins:read` / `plugins:write` do not cover the calendar. Socios need nothing more than their person's audience, and, once socio access is on for the person, their grant for the calendar (read for `list_events`, write for the rest).

**Page.** `/plugins/calendar` in the workspace: week, month and agenda views from `@socio/plugin-ui`, a location filter, canceled events hidden unless shown, an event dialog, and drag to move. Times show in the calendar's zone.

**Subscription feed.** Each person can make a private link (`/plugin-feeds/calendar/<token>.ics`) that a calendar app subscribes to. It shows the events that person can see, from 90 days back to 400 days ahead, timed events in UTC and all-day events as dates. Only the token's hash is stored; making a new link ends the old one, and the link stops answering when its person is deactivated, leaves the audience, or the plugin is disabled. Anyone with the link can read what it shows.

**Data routes.** `GET /api/plugins/calendar/data/state?from=<ms>&to=<ms>`, `POST /events`, `PATCH /events/:id`, `DELETE /events/:id`, `POST /feed` and `DELETE /feed`, for the signed-in person, with the same rules as the tools.

Its tables (`calendar_events`, `calendar_feeds`) are created on install, not at boot, and stay on uninstall.

Not in this version: reminders, schedule hooks (a plugin cannot run work on a timer yet), recurring events, and a list of rooms as calendars (use `location`).

## Writing another plugin

A plugin that can be first-party code in this build can be bundled: add it to `src/server/plugins/bundled.ts` with a manifest without `service`, its `migrate`, `data`, `tools` and optional `feed`, and its page in `packages/client/src/plugins/bundled.tsx`. It is trusted code in Socio's process, so it needs review like any other part of Socio.

For a service, ship an image that listens on `PORT`, answers `GET /healthz` with no proof, and checks `x-cb-plugin-proof` on every other path. It runs as uid 1000, with a read-only root and a tmpfs at `/tmp` (`HOME=/tmp`). Keep sessions out of the process. Store durable data through Socio: its own [datasets](#datasets) and files are the simplest, and the workspace backs them up. Use a named volume only with `service.backup` (see [Volumes and backups](#manifest)), mark caches `ephemeral: true`, and give every volume `shared: true` and a non-local driver if you will run more than one replica. Do not write a bind mount, a host path, or a volume driver option: the socket proxy rejects them.

Put the manifest in a `file:` catalog, or add a bundled id next to `social-strategy` in `src/server/plugins/bundled.ts` if it should be able to contribute MCP tools and `/data` routes. A third-party file-catalog plugin is provisioned as a service and can embed or open in a tab. It does not get in-process data routes or MCP tools unless its id is bundled. It can ask for `person:read` to be told who is using it, and read `x-cb-time-zone`. Its iframe origin is still the apps host, not a host the manifest chooses. Its image must be the digest in `SOCKET_PROXY_IMAGE_PINS` for that plugin id. Unknown manifest fields are refused.

## Threat model

A plugin image, including the planner once it is running, is treated as untrusted. So is its page in the browser. The socket proxy and the operator who sets the image pins are trusted. Swarm managers are trusted. The apps runtime is not: it is the client of the proxy, and a bug or a compromise there must not become root on the host.

What that is protecting:

- The host, via the Docker socket. One `POST /services/create` with a bind of `/` or of the socket, `Privileged`, `CapAdd`, or the host network is root, even when the URL is on an allow list.
- Other plugins, and the Socio process.
- Socio's session cookie and the workspace origin.

The socket proxy (`src/apps-runtime/socket-proxy.ts`) allows only Docker API v1.44, and only these routes:

| Method | Path                                      | What is checked                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/_ping`, `/v1.44/version`                | Nothing. Health and version.                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/v1.44/services`, `/v1.44/services/{id}` | `Env`, `Secrets` and `Configs` are removed from the response, in `Spec` and in `PreviousSpec`, and replaced by `SocioRevision`, a SHA-256 digest of the container's image, environment, secrets, configs and mounts (CB-370), which an infra update may carry back and is never forwarded. A scale reads the spec on the proxy and does not return it to the client. |
| POST   | `/v1.44/services/create`                  | The top-level object, below. `.Spec` is not unwrapped. The forwarded body is `JSON.stringify` of the object that passed.                                                                                                                                                                                                                                             |
| POST   | `/v1.44/services/{id}/update`             | A scale is only `{ Mode: { Replicated: { Replicas } } }`. The proxy loads the service and changes that count. Any other plugin update is the checked body, re-serialized. An infra update may only add or remove a plugin network. Query key `version` only (`rollback` is refused).                                                                                 |
| DELETE | `/v1.44/services/{id}`                    | The current name is `socio-plugin-<id>` and the label says Socio manages it.                                                                                                                                                                                                                                                                                         |
| GET    | `/v1.44/tasks`                            | Each task's `Env`, `Secrets` and `Configs` are removed (a task carries its service's container spec, Socio's included), with the same `SocioRevision` digest in their place. Replica addresses.                                                                                                                                                                      |
| GET    | `/v1.44/secrets`                          | `filters` is exactly `{"names":{"<one allowlisted name>":true}}`. No other query. The response is that one id and name, not secret data and not a prefix match.                                                                                                                                                                                                      |
| GET    | `/v1.44/networks`, `/v1.44/networks/{id}` | Nothing.                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/v1.44/networks/create`                  | Internal overlay named `socio-plugin-net-<id>`.                                                                                                                                                                                                                                                                                                                      |
| DELETE | `/v1.44/networks/{id}`                    | The current name is `socio-plugin-net-<id>`, and its labels, if any, name that plugin.                                                                                                                                                                                                                                                                               |
| POST   | `/v1.44/images/create`                    | `fromImage` is a pinned `name@sha256:…`. No body, no tag, no tar load.                                                                                                                                                                                                                                                                                               |
| DELETE | `/v1.44/volumes/{name}`                   | The name is exactly `socio-plugin-<id>-<volume>` and no service mounts it.                                                                                                                                                                                                                                                                                           |

Refused, with no forward: `/containers`, `/exec`, `/build`, `/swarm`, an unfiltered `/secrets` list, secret create, delete, and inspect by id, `/configs`, `/nodes`, `/plugins`, `/system`, `/events`, `/commit`, `/volumes/create`, image push, and any other API version. A path with `..` or a second encoding is refused before the route is matched.

A plugin service body must be exactly the shape `swarmServiceBody` sends. In particular:

- `Image` is `name@sha256:<64 hex>` and equals `SOCKET_PROXY_IMAGE_PINS` for the plugin id in the labels. Another digest is refused.
- User `1000:1000`, `ReadOnly: true`, `CapabilityDrop: ["ALL"]`, no `CapabilityAdd`.
- `Privileges` is `{ NoNewPrivileges: true }` and nothing else (no credential spec, no unconfined seccomp).
- Mounts are a tmpfs at `/tmp` (and optionally `/var/tmp`) or a named volume `socio-plugin-<id>-<name>`. The name must be exactly that, `<name>` a manifest volume name, and not another plugin's: volume names may contain dashes, so plugin `foo`'s `bar-data` and plugin `foo-bar`'s `data` are the same Swarm name. The proxy reads every service's mounts from the engine and refuses a volume another service mounts, or one in the namespace of an installed plugin whose id extends this one's with `-` (`socio-plugin-foo-bar-…` while `foo-bar` is installed; `foo` installed reserves nothing for `foo-bar`). Service creates, updates and volume deletes go through the proxy one at a time, each until the engine answers, so two concurrent creates cannot both pass the check. Type `bind`, a source that contains `/`, `BindOptions`, and volume driver `Options` (the local driver's `device`/`o=bind` host-path trick) are refused.
- `Placement` is absent when `SOCKET_PROXY_PLUGIN_CONSTRAINTS` is empty, and exactly `{ Constraints: <that list> }` when it is set. Preferences, `MaxReplicas`, and `Platforms` are refused.
- Exactly one network, and it must inspect as the internal overlay `socio-plugin-net-<id>`. The host network, `bridge`, and any other network are refused.
- Endpoint mode `dnsrr` and no published ports. Replicas from 0 to 20. CPU, memory and process (`Limits.Pids`, 1 to 4096; the runtime sets 256) limits are required, so a task cannot fork until the host's process table is full.
- Each secret reference has `SecretID` and `SecretName`. `SecretName` is in `SOCKET_PROXY_SECRET_NAMES`, and `SecretID` is the id the engine returned for that exact name. The file is mode `0400`, uid `1000`, gid `1000`. A reference without `SecretID` is a malformed secret reference and is refused. A scale does not send a client spec: the proxy copies the inspected spec and changes only `Mode.Replicated.Replicas`.
- The healthcheck `Test` is the runtime's fixed `["CMD","node","-e", <fetch of the health path>]`. A shell, `sh -c`, or any other argv is refused.
- No `Command`, `Args`, devices, host PID or IPC, sysctls, extra hosts, a custom runtime, or any other ContainerSpec field. Unknown fields are refused. A key that only differs from a known field by ASCII case (`volumeoptions`, `name`) is a collision and is refused, because the engine's JSON decoder matches fields case-insensitively. The proxy forwards the re-serialized object, never the raw bytes, so a dropped key cannot be revived by that decoder.
- `NODE_OPTIONS` is refused. `HOME` is allowed only as the exact value `HOME=/tmp`.
- Socio refuses to boot with `PLUGIN_CATALOGS` adding a catalog (any entry but `-bundled:<id>`) when the public host is outside `PLUGIN_CATALOG_HOSTS` or in `PLUGIN_CATALOG_DENY_HOSTS` (operator settings; Socio names no instance).

The proxy listens on `SOCKET_PROXY_LISTEN` (`host:port`, `0.0.0.0:2375` by default) and forwards to `SOCKET_PROXY_SOCKET` (the engine's socket path, `/var/run/docker.sock` by default, or `http://host:port`); a malformed value stops it at start. The apps runtime names the same infra services in `APPS_RUNTIME_INFRA_SERVICES` (comma-separated; empty by default): it joins each to a plugin's network when it installs or reconciles the plugin, and detaches them before it removes that network. Set both lists to the same names.

An update of `company-brain_apps` or `company-brain_app` (the names in `SOCKET_PROXY_INFRA_SERVICES`) is compared with the spec the engine just returned. Every field but the network list must match. A network may be added or removed only when it inspects as an internal `socio-plugin-net-*` overlay. The service's other networks stay, each attachment exactly as the engine returned it: an alias added on a stack network would take another service's DNS name. A new plugin-network attachment is `{ Target, Aliases }`, and its aliases may only repeat ones the service already has (the stack's short name, such as `app`), so the plugin resolves `http://app:4310` and the egress proxy's host on its own network. That is how the ingress and the app join the plugin network without the proxy being willing to rewrite those services.

`NoNewPrivileges` on the service spec is Docker Engine API 1.41 (Docker 20.10) and later, in `ContainerSpec.Privileges`. This client calls API 1.44, which has the field. Set it on every Swarm node as well, in `/etc/docker/daemon.json`, so a worker that ignores the service field still applies it, and so a daemon that rejects the field can be covered without dropping the runtime's copy of it:

```json
{ "no-new-privileges": true }
```

Restart dockerd on each node after that change. Do not strip `Privileges.NoNewPrivileges` from the service body to satisfy an older daemon; the proxy requires the field.

The proxy container is root because the socket is `root:docker` on the host, and `connect(2)` needs write access to that inode, so the mount is not `:ro`. It has `cap_drop: ALL`, `no-new-privileges`, a read-only root, a tmpfs at `/tmp`, no published port, and it sits on the internal `socket-proxy` network. Plugin tasks are not on that network. The proxy logs the method, the path, and the refusal. It does not log the body (the body holds the ingress proof).

What this does not close:

- The proxy is root-equivalent on the host if its own code is replaced. The image is the apps image you built.
- Attaching the whole `app` service to a plugin network lets that plugin open TCP to every port the app listens on. Routes other than the plugin data API still require a Socio session, which the plugin does not have. The proof on the data API is per plugin id.
- A named volume that already existed under `socio-plugin-<id>-<name>` before this proxy (which denies volume create) could be mounted. The proxy cannot see how that volume was created.
- Volume ownership is read from the services Swarm runs now. A volume left behind by an uninstalled plugin with a longer id (`foo-bar`) is not claimed by anything, so plugin `foo` declaring `bar-<name>` could mount it. Uninstall deletes a plugin's volumes, but only on the node the proxy talks to.
- A digest in the pin list is started even if it is not the digest you just built. The pin is the operator's.
- `window.open` from the host, in answer to a plugin `open` message, can be blocked when the browser does not treat the iframe click as a user activation. The workspace's own **Open in a new tab** button is a click in the parent.
- COOP `same-origin` on a document that is iframed from another origin depends on the browser. `frame-ancestors` is what allows the workspace to frame the plugin. If a browser refuses the framed load, the page offers the new tab.
- A webhook path (`webhooks`, CB-370) is public: anyone can send it requests within its rate and size limits, and the rate limit is shared by every sender, so a flood can make a real sender wait and retry. The plugin must verify each request itself; the proxy only strips identity and bounds what reaches it.
- These checks were run against a fake engine in `tests/socket-proxy.test.ts`. They were not run against a live Swarm.

## Decisions still open

- Where a public catalog would be hosted, and who reviews a third-party image before it is allow-listed.
- Whether a plugin may ever be framed from an origin outside the apps proxy. This version does not.
- Who is allowed to deploy the overlay. It is the only stack file that mounts the Docker socket, and only on `docker-socket-proxy`.
- Which image prefixes belong on `APPS_RUNTIME_IMAGE_ALLOW` beyond `company-brain-plugin-`, and who publishes the digests in `SOCKET_PROXY_IMAGE_PINS`.
- The infra service names (`company-brain_apps` and `company-brain_app` on a stack named `company-brain`). Each plugin gets its own internal network `socio-plugin-net-<id>`.
- Whether uninstall should also delete the planner's rows. This version keeps them.
- ~~One `PLUGIN_SERVICE_TOKEN` per instance, rather than a token per plugin.~~ Decided by Socio Secrets phase 2: each plugin has its own identity token; the shared one is deprecated.
- Tools for service plugins: a service plugin's MCP tools still need its id bundled. Proxying `tools/call` to the plugin's service, with the signed person, would remove that.
- Reminders and schedule hooks for plugins (a timer a plugin registers, run on the leader).
- The replica count. The planner defaults to 1. Scale up only when the plugin is stateless or uses shared storage, which the planner is.
