import type { Audience } from '../actor-scopes.js';
import type { FieldKind } from '../dataset-query/kinds.js';
import type { PartitionGrain, TableKind } from '../dataspace/analytics.js';
import type { AppManifestSecret } from '../workspace-secrets.js';

import type { PluginConfigField } from './plugin-config.js';
import type { PluginReleaseNote } from './plugin-release-notes.js';
import { PLUGIN_ID, type PluginServiceSpec } from './plugin-service.js';

/**
 * A workspace plugin: a feature an admin installs on this instance. It runs
 * as a service on the workspace app runtime and is opened on the apps host,
 * the same origin rules as a mini app. Nothing here is installed until an
 * admin does it, and a plugin is only offered when this instance's catalog
 * lists it.
 */

export interface PluginTool {
    name: string;
    description: string;
    /** Permission from `permissions` that grants this tool. */
    scope: string;
}

/** A setting a manifest declares under `config` (typed since CB-395; see plugin-config.ts). */
export type { PluginConfigField } from './plugin-config.js';

/** Who may open a plugin and use its tools. Admins and operators always may. */
export const PLUGIN_AUDIENCES = ['admins', 'members'] as const;
export type PluginAudience = (typeof PLUGIN_AUDIENCES)[number];

/**
 * How a plugin runs. `service`: its own Docker service on the workspace app
 * runtime, opened on the apps host. `bundled`: code shipped in this build
 * that runs inside Socio's process and renders in the workspace shell, so it
 * needs no runtime, no apps host and no Docker socket. Only a plugin this
 * build ships can be bundled; a catalog file always names a service.
 */
export type PluginMode = 'service' | 'bundled';

/**
 * The permission a service plugin asks for to be told who is using it:
 * the person's id, name, role and time zone, signed, on every request
 * (`x-cb-person`). Without it the plugin sees an opaque id only.
 */
export const PLUGIN_PERSON_PERMISSION = 'person:read';

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    /** Not loaded as a remote image. The launcher uses a generic icon. */
    icon?: string;
    /** Path on the plugin's own origin. Default `/`. */
    entry?: { path: string };
    /** `tab` opens a new tab. `embed` renders inside the workspace. */
    display: 'tab' | 'embed';
    permissions: string[];
    mcp?: { tools: PluginTool[] };
    config?: Record<string, PluginConfigField>;
    /**
     * Who may use it when installed, until an admin changes it on the
     * installed card. Default `admins`.
     */
    audience?: PluginAudience;
    /**
     * What the embed may ask of the host: `open`, https URLs it may open in
     * a new tab, matched by host and exact path (a path ending in `/`
     * matches below it; absent, the host opens nothing for this plugin);
     * `openAnyHttps`, any other https URL after the person confirms it in a
     * host dialog (a sensitive scope); and `routes`, deep links (CB-446).
     */
    bridge?: PluginBridgeSpec;
    /** Absent only for a bundled plugin, which runs inside Socio. */
    service?: PluginServiceSpec;
    /**
     * A service plugin's socio-access contract (CB-232): it
     * verifies the actor envelope (`x-cb-actor`) with the SDK and names its
     * actions and their tiers, so socios may open it for a person. Without
     * it a socio can't open the plugin, as for an app. A bundled
     * plugin needs none: its tools are its actions.
     */
    delegation?: PluginDelegation;
    /**
     * Socio Secrets it reads at runtime, by name: an admin grants a
     * workspace secret or sets the plugin's own on Settings → Secrets, and
     * the plugin reads it with `socio.secrets`. Platform-neutral; it replaces
     * `service.secrets`. Service plugins only.
     */
    secrets?: AppManifestSecret[];
    /**
     * The datasets the plugin needs (CB-451): each a need with
     * `read` or `write` access, which the admin binds at install to a new or
     * an existing workspace dataset (`data_plugin_bindings`). A need without
     * `access` is a `write` need bound to a new dataset with no question, as
     * before. Uninstalling unbinds; the data stays the workspace's. The
     * plugin reaches exactly its bound datasets, each with its access,
     * through a data token it exchanges its identity for
     * (`POST /api/workload/data-token`). Service plugins only.
     */
    datasets?: PluginDataset[];
    /**
     * Release notes for its versions, newest first, the first one this
     * `version` (CB-527): at most 20, each `notes` at most 8 KB of Markdown,
     * 64 KB in all (`parsePluginReleaseNotes`). Read when the plugin is
     * installed or updated; the workspace keeps its history.
     */
    releaseNotes?: PluginReleaseNote[];
    /**
     * Public inbound paths on the plugin's own origin (CB-370): a SaaS's
     * webhooks, and one OAuth install callback. The apps proxy serves each
     * declared path with no session, for its one method only, rate-limited
     * and size-limited, with the body passed byte for byte, the client's
     * `x-cb-*` headers stripped and no identity header added. The plugin
     * verifies the sender itself (a signature over the raw body, an OAuth
     * `state`). Service plugins only.
     */
    webhooks?: PluginWebhook[];
}

/** What a manifest's `bridge` lets the embed do. */
export interface PluginBridgeSpec {
    /** URLs the embed may ask the host to open. Absent: none. */
    open?: string[];
    /**
     * The embed may ask the host to open any https URL in a new tab. One not
     * in `open` opens only after the person confirms it in a dialog the
     * workspace draws, naming the destination host. A sensitive scope, shown
     * at install and when an update adds it. Absent or false: only `open`.
     */
    openAnyHttps?: boolean;
    /**
     * Deep links (CB-446): the app's own routes get workspace addresses,
     * `/plugins/<id>/<path>?<query>#<hash>`. The app answers any path at its
     * origin; `@socio/plugin-ui`'s bridge reports each location change and
     * follows the workspace's `go-to`. Absent or false: the plugin's
     * address is `/plugins/<id>` only, as before.
     */
    routes?: boolean;
}

/** One public inbound path a service plugin declares (`PluginManifest.webhooks`). */
export interface PluginWebhook {
    /** An exact path on the plugin's origin, such as `/webhooks/crm`. The query is passed on, never matched. */
    path: string;
    /** `POST` (the default) for a webhook; `GET` for an OAuth callback, at most one per plugin, with no body. */
    method?: 'POST' | 'GET';
    /** The largest body taken, in bytes (POST only). Default `PLUGIN_WEBHOOK_BODY_DEFAULT`. */
    maxBodyBytes?: number;
    /** Requests a minute this path takes on one Socio process. Default `PLUGIN_WEBHOOK_PER_MINUTE_DEFAULT`. */
    perMinute?: number;
}
/**
 * A webhook's path: 1 to 8 segments of letters, digits, `_`, `-`, `~` and
 * `.`, none starting with `.` (so no `.` or `..`), no trailing `/`, and
 * never under the proxy's own `/__cb/`.
 */
export const PLUGIN_WEBHOOK_PATH = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,63}){1,8}$/;
/** The most public paths one plugin may declare. */
export const PLUGIN_WEBHOOKS_MAX = 10;
/** A webhook body's default and highest limit, in bytes. */
export const PLUGIN_WEBHOOK_BODY_DEFAULT = 256 * 1024;
export const PLUGIN_WEBHOOK_BODY_MAX = 1024 * 1024;
/** A webhook's default and highest rate, in requests a minute per Socio process. */
export const PLUGIN_WEBHOOK_PER_MINUTE_DEFAULT = 120;
export const PLUGIN_WEBHOOK_PER_MINUTE_MAX = 600;

/** The pathname of a manifest's `entry.path` (which may carry a query or fragment), as a request matches it. */
export function pluginEntryPathname(entryPath: string | undefined) {
    try {
        return new URL(entryPath ?? '/', 'http://plugin.invalid').pathname;
    } catch {
        return '/';
    }
}

/** Whether `path` is one a webhook may declare (`PLUGIN_WEBHOOK_PATH`, and not `/__cb/…`). */
export const pluginWebhookPath = (path: unknown): path is string =>
    typeof path === 'string' && PLUGIN_WEBHOOK_PATH.test(path) && !/^\/__cb(?:\/|$)/i.test(path);

/** What a plugin's dataset need allows (CB-451): `read` the query tier only, `write` today's plugin operations. */
export type PluginDatasetAccess = 'read' | 'write';
export const PLUGIN_DATASET_ACCESS = ['read', 'write'] as const satisfies readonly PluginDatasetAccess[];

/** One dataset a service plugin needs (`PluginManifest.datasets`, CB-451). */
export interface PluginDataset {
    /**
     * The plugin's own handle for the need, what its token and data API calls
     * use; not the dataset's name: letters, digits, `_`, `-` and `.`.
     */
    name: string;
    description?: string;
    /**
     * `write`: the plugin writes the bound dataset, and nobody else does (one
     * writer per dataset). `read`: it reads a dataset someone else writes;
     * the admin may leave it unbound. Absent: `write`, bound to a new
     * dataset at install with no question (every plugin before CB-451).
     */
    access?: PluginDatasetAccess;
    /**
     * Tables the need expects (CB-369), the same shape as
     * `POST /api/data/datasets/:id/tables` takes. For `write`, install and
     * enable create each one that is missing and add declared columns that
     * are missing, and refuse an existing table that disagrees (a column's
     * type); never drops anything. For `read`, the tables and columns a bound
     * dataset must have. Optional: a writer may
     * make its tables through the API.
     */
    tables?: PluginDatasetTable[];
}

/** A need's access as the data space applies it: absent means `write` (CB-451). */
export const pluginNeedAccess = (need: Pick<PluginDataset, 'access'>): PluginDatasetAccess => need.access ?? 'write';
/** One table a plugin's dataset declares (`PluginDataset.tables`, CB-369). */
export interface PluginDatasetTable {
    table: string;
    /**
     * `analytical` (CB-387): append-only Parquet parts, with `partitionBy`
     * and optionally `retainDays`. `transactional` (the default) is a
     * SQLite table.
     */
    kind?: TableKind;
    columns: PluginDatasetColumn[];
    /** `false`: no row history, for derived tables rebuilt from others (marts). Transactional only. */
    history?: boolean;
    /** An analytical table's partition column (a NOT NULL DATE or TIMESTAMP) and grain. */
    partitionBy?: { column: string; grain: PartitionGrain };
    /**
     * An analytical table's retention in days: the nightly run retires each
     * partition that ended longer ago. Absent: kept until someone drops it.
     */
    retainDays?: number;
}
/** A declared table's column, as `POST …/tables` takes it. */
export interface PluginDatasetColumn {
    name: string;
    /** A dataset column type (`COLUMN_TYPES`); TEXT when absent. */
    type?: string;
    notNull?: boolean;
    primaryKey?: boolean;
    unique?: boolean;
    default?: string | number | boolean | null;
    /**
     * Its field setting (CB-451): kind, label and the settings of
     * that kind, as a person sets them in the dataset's Fields panel.
     * Applied at install and update like the column: added when the
     * column has none, never overwriting one an admin changed. Checked
     * against the column's type; a `person` or `people` kind needs the
     * plugin's `person:read` permission.
     */
    field?: PluginDatasetField;
}
/** A declared column's field setting (`PluginDatasetColumn.field`, CB-451). */
export interface PluginDatasetField {
    kind: FieldKind;
    label?: string;
    options?: Array<{ id: string; label: string; color: string }>;
    currency?: string;
    minorUnits?: boolean;
    decimals?: number;
    unit?: string;
    dateFormat?: 'date' | 'datetime';
    allowSocios?: boolean;
}
/** The most tables one declared dataset lists (`PluginDataset.tables`). */
export const PLUGIN_DATASET_MAX_TABLES = 32;
/** A declared dataset's name (`PluginDataset.name`). */
export const PLUGIN_DATASET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** The most datasets one plugin may declare. */
export const PLUGIN_DATASETS_MAX = 16;

/**
 * What a service plugin declares to take part in socio access. Tiers as an
 * app's; a `consequential` action's approval is asked for at
 * `/api/plugins/<id>/actor/approvals` and used once (CB-232).
 */
export interface PluginDelegation {
    contract: 1;
    actions: Record<string, 'read' | 'write' | 'consequential' | 'admin'>;
    /** Paths the plugin serves without an envelope (its SDK's `publicPaths`). */
    public?: string[];
    /** Every access request shows the person's card. */
    alwaysAsk?: boolean;
}

/** A plugin's socio-actor audience (CB-232): `plugin:<id>`. */
export const pluginAudience = (id: string): Audience => `plugin:${id}`;

/**
 * Read or write, for a plugin permission: `<area>:read` reads, anything
 * else writes. The one mapping behind a connected agent's per-plugin scope
 * (`plugins:<id>:read|write`) and a socio's grant (`app:read|write` on
 * `plugin:<id>`, CB-232), so the two can never disagree on what a tool
 * is.
 */
export const pluginPermissionAccess = (permission: string): 'read' | 'write' =>
    permission.endsWith(':read') ? 'read' : 'write';

/** How a manifest runs: a manifest without a service is bundled. */
export const pluginMode = (manifest: Pick<PluginManifest, 'service'>) =>
    manifest.service ? ('service' as const) : ('bundled' as const);

/** Messages across the embed bridge. `v` is 1. The host and the plugin share this list. */
export const PLUGIN_BRIDGE_VERSION = 1;

export type PluginToHostMessage =
    | { v: 1; source: 'socio-plugin'; type: 'ready' }
    | { v: 1; source: 'socio-plugin'; type: 'resize'; height: number }
    | { v: 1; source: 'socio-plugin'; type: 'open'; url: string }
    | { v: 1; source: 'socio-plugin'; type: 'embed-refused' }
    | ({ v: 1; source: 'socio-plugin'; type: 'route' } & PluginRoute)
    | { v: 1; source: 'socio-plugin'; type: 'navigate'; path: string; replace: boolean };

export type HostToPluginMessage =
    | {
          v: 1;
          source: 'socio-host';
          type: 'theme';
          theme: 'light' | 'dark';
          pluginId: string;
      }
    | ({ v: 1; source: 'socio-host'; type: 'go-to' } & PluginRoute);

export type PluginBridgeMessage = PluginToHostMessage | HostToPluginMessage;

const PLUGIN_TO_HOST_KEYS: Record<PluginToHostMessage['type'], readonly string[]> = {
    ready: ['v', 'source', 'type'],
    resize: ['v', 'source', 'type', 'height'],
    open: ['v', 'source', 'type', 'url'],
    'embed-refused': ['v', 'source', 'type'],
    route: ['v', 'source', 'type', 'path', 'query', 'hash'],
    navigate: ['v', 'source', 'type', 'path', 'replace'],
};

/** The longest app route (path, query and fragment together) the bridge carries (CB-446). */
export const PLUGIN_ROUTE_MAX = 2000;

/**
 * Where an embedded app is (CB-446): its own `location.pathname`, `search`
 * and `hash`, exactly. The workspace address is `/plugins/<id>` + these,
 * where the app's `/` is `/plugins/<id>` itself.
 */
export interface PluginRoute {
    /** Starts with `/`. */
    path: string;
    /** Empty, or starts with `?`. */
    query: string;
    /** Empty, or starts with `#`. */
    hash: string;
}

const ROUTE_BASE = 'https://plugin.invalid';

/** No control character, space, DEL or backslash. */
const plainText = (value: string) => ![...value].some((ch) => ch <= ' ' || ch === '\u007f' || ch === '\\');

/**
 * An app route's path, or undefined. Route text comes from the frame and
 * is untrusted: it starts with `/`; it has no `//` (so no host), no `.` or
 * `..` segment (`%2e` included), no control character, space or
 * backslash; it is already in the form a URL parser writes
 * (percent-encoded), so the workspace address can't resolve outside
 * `/plugins/<id>`; and it is never the proxy's own `/__cb/…`.
 */
export function pluginRoutePath(value: unknown): string | undefined {
    if (
        typeof value !== 'string' ||
        !value.startsWith('/') ||
        value.length > PLUGIN_ROUTE_MAX ||
        value.includes('//') ||
        value.includes('?') ||
        value.includes('#') ||
        !plainText(value) ||
        /^\/__cb(?:\/|$)/i.test(value)
    ) {
        return undefined;
    }
    try {
        const url = new URL(value, ROUTE_BASE);
        return url.origin === ROUTE_BASE && url.pathname === value ? value : undefined;
    } catch {
        return undefined;
    }
}

/** An app route from its three parts, or undefined (see `pluginRoutePath`; at most `PLUGIN_ROUTE_MAX` in all). */
export function pluginRoute(path: unknown, query: unknown, hash: unknown): PluginRoute | undefined {
    const clean = pluginRoutePath(path);
    if (
        clean === undefined ||
        typeof query !== 'string' ||
        typeof hash !== 'string' ||
        (query !== '' && (!query.startsWith('?') || query.includes('#'))) ||
        (hash !== '' && !hash.startsWith('#')) ||
        !plainText(query) ||
        !plainText(hash) ||
        clean.length + query.length + hash.length > PLUGIN_ROUTE_MAX
    ) {
        return undefined;
    }
    return { path: clean, query, hash };
}

/** An app route written as one string, `/path?query#hash`, or undefined. */
export function pluginRouteFromString(value: unknown): PluginRoute | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const [, path = '', query = '', hash = ''] = /^([^?#]*)(\?[^#]*)?(#.*)?$/s.exec(value) ?? [];
    return pluginRoute(path, query, hash);
}

/** `/path?query#hash`. */
export const pluginRouteString = (route: PluginRoute) => `${route.path}${route.query}${route.hash}`;

/** Whether two app routes name the same place (a browser may percent-encode a query differently). */
export function samePluginRoute(a: PluginRoute, b: PluginRoute) {
    try {
        return new URL(pluginRouteString(a), ROUTE_BASE).href === new URL(pluginRouteString(b), ROUTE_BASE).href;
    } catch {
        return pluginRouteString(a) === pluginRouteString(b);
    }
}

/**
 * The plugin a workspace pathname names, and the rest of it, exactly as
 * the router matches `plugins/:pluginId/*`: `plugins` in any case, one
 * non-empty segment (percent-decoded once, as the router decodes it), then
 * anything. Every such address is the plugin's: the platform keeps no page
 * under it (settings live at `/settings/plugins/<id>`), so the frame, the
 * page's `frame-src` and the bridge all agree on what is the plugin's.
 */
export function pluginAddress(pathname: string): { pluginId: string; rest: string } | undefined {
    const match = /^\/plugins\/([^/]+)(\/.*)?$/is.exec(pathname);
    if (!match) {
        return undefined;
    }
    try {
        return { pluginId: decodeURIComponent(match[1]!), rest: match[2] ?? '' };
    } catch {
        return undefined;
    }
}

/** The workspace address that mirrors an app route: `/plugins/<id>` + path + query + hash, the app's `/` being `/plugins/<id>`. */
export function pluginAddressFor(pluginId: string, route: PluginRoute) {
    return `/plugins/${encodeURIComponent(pluginId)}${route.path === '/' ? '' : route.path}${route.query}${route.hash}`;
}

/**
 * The app route a workspace location names (`pathname`, `search`, `hash`
 * as `location` gives them), the inverse of `pluginAddressFor`; undefined
 * when it isn't this plugin's address or the route would be refused.
 */
export function pluginRouteFromAddress(location: { pathname: string; search: string; hash: string }) {
    const address = pluginAddress(location.pathname);
    if (!address) {
        return undefined;
    }
    return pluginRoute(address.rest || '/', location.search, location.hash);
}

function bridgeRecord(data: unknown): Record<string, unknown> | undefined {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return undefined;
    }
    return data as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[]) {
    const keys = Object.keys(row);
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

/**
 * An entry of a manifest's `bridge.open`: an https URL with a host and a
 * path, and no port, credentials, query or fragment. Undefined otherwise.
 */
export function bridgeOpenRule(value: unknown) {
    if (typeof value !== 'string' || value.length > 300) {
        return undefined;
    }
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !url.hostname.includes('.') ||
            `${url.origin}${url.pathname}` !== value
        ) {
            return undefined;
        }
        return { host: url.hostname.toLowerCase(), path: url.pathname };
    } catch {
        return undefined;
    }
}

/** Whether `url` is one a plugin's `bridge.open` lets the host open. */
export function bridgeOpenAllowed(url: URL, allow: readonly string[]) {
    if (url.protocol !== 'https:' || url.port) {
        return false;
    }
    if (url.username || url.password || url.hash) {
        return false;
    }
    const host = url.hostname.toLowerCase();
    return allow.some((entry) => {
        const rule = bridgeOpenRule(entry);
        if (!rule || rule.host !== host) {
            return false;
        }
        return rule.path.endsWith('/') ? url.pathname.startsWith(rule.path) : url.pathname === rule.path;
    });
}

/**
 * Whether `url` is a link a plugin with `bridge.openAnyHttps` may ask the
 * host to open: `https:` only (never `http:`, `javascript:`, `data:`,
 * `blob:` or `file:`), with a host that has a dot, and no credentials (so
 * the host the dialog names is the host the tab goes to). Any port, path,
 * query or fragment.
 */
export function anyHttpsUrl(url: URL) {
    return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        url.hostname.includes('.') &&
        !url.hostname.endsWith('.')
    );
}

/**
 * How the host opens `url` for a plugin: `direct` for a link its
 * `bridge.open` lists (no prompt, as before), `confirm` for any other
 * https link when it declares `bridge.openAnyHttps` (the host asks the
 * person first), or undefined when it may not open it at all.
 */
export function bridgeOpenMode(
    url: URL,
    allow: readonly string[],
    openAnyHttps = false,
): 'direct' | 'confirm' | undefined {
    if (bridgeOpenAllowed(url, allow)) {
        return 'direct';
    }
    return openAnyHttps && anyHttpsUrl(url) ? 'confirm' : undefined;
}

/**
 * A plugin → host message, or undefined. The caller still checks
 * `event.origin` and `event.source`. `targetOrigin` is never `*`. An
 * `open` is accepted only for a URL the plugin's `bridge.open` lists
 * (`openAllow`), or, when its manifest has `bridge.openAnyHttps`
 * (`openAnyHttps`), for any plain https URL (`anyHttpsUrl`); otherwise no
 * `open` is. Which of the two it is, `bridgeOpenMode` says.
 */
export function parsePluginToHost(
    data: unknown,
    openAllow: readonly string[] = [],
    openAnyHttps = false,
): PluginToHostMessage | undefined {
    const row = bridgeRecord(data);
    if (!row || row.v !== PLUGIN_BRIDGE_VERSION || row.source !== 'socio-plugin') {
        return undefined;
    }
    const type = row.type;
    if (typeof type !== 'string' || !(type in PLUGIN_TO_HOST_KEYS)) {
        return undefined;
    }
    const allowed = PLUGIN_TO_HOST_KEYS[type as PluginToHostMessage['type']];
    if (!exactKeys(row, allowed)) {
        return undefined;
    }
    if (type === 'ready' || type === 'embed-refused') {
        return { v: 1, source: 'socio-plugin', type };
    }
    if (type === 'route') {
        const route = pluginRoute(row.path, row.query, row.hash);
        return route && { v: 1, source: 'socio-plugin', type: 'route', ...route };
    }
    if (type === 'navigate') {
        const route = pluginRouteFromString(row.path);
        if (!route || typeof row.replace !== 'boolean') {
            return undefined;
        }
        return { v: 1, source: 'socio-plugin', type: 'navigate', path: pluginRouteString(route), replace: row.replace };
    }
    if (type === 'resize') {
        const height = row.height;
        if (typeof height !== 'number' || !Number.isInteger(height) || height < 0 || height > 10000) {
            return undefined;
        }
        return { v: 1, source: 'socio-plugin', type: 'resize', height };
    }
    const url = row.url;
    if (typeof url !== 'string' || url.length > 2000) {
        return undefined;
    }
    try {
        const parsed = new URL(url);
        if (!bridgeOpenMode(parsed, openAllow, openAnyHttps)) {
            return undefined;
        }
        return {
            v: 1,
            source: 'socio-plugin',
            type: 'open',
            url: parsed.toString(),
        };
    } catch {
        return undefined;
    }
}

/** A host → plugin message, or undefined. The plugin still checks `event.origin`. */
export function parseHostToPlugin(data: unknown): HostToPluginMessage | undefined {
    const row = bridgeRecord(data);
    if (row?.v === PLUGIN_BRIDGE_VERSION && row.source === 'socio-host' && row.type === 'go-to') {
        const route = exactKeys(row, ['v', 'source', 'type', 'path', 'query', 'hash'])
            ? pluginRoute(row.path, row.query, row.hash)
            : undefined;
        return route && { v: 1, source: 'socio-host', type: 'go-to', ...route };
    }
    if (
        !row ||
        row.v !== PLUGIN_BRIDGE_VERSION ||
        row.source !== 'socio-host' ||
        row.type !== 'theme' ||
        !exactKeys(row, ['v', 'source', 'type', 'theme', 'pluginId'])
    ) {
        return undefined;
    }
    if (row.theme !== 'light' && row.theme !== 'dark') {
        return undefined;
    }
    if (typeof row.pluginId !== 'string' || !PLUGIN_ID.test(row.pluginId)) {
        return undefined;
    }
    return {
        v: 1,
        source: 'socio-host',
        type: 'theme',
        theme: row.theme,
        pluginId: row.pluginId,
    };
}

/**
 * An origin for `postMessage`, or undefined when it is `*` or not an origin.
 * The bridge never uses a wildcard target.
 */
export function bridgeOrigin(value: string | undefined) {
    if (!value || value === '*' || !/^https?:\/\/[^/\s]+$/.test(value)) {
        return undefined;
    }
    return value;
}

/**
 * The iframe is a different origin from Socio (the plugin's apps host).
 * `allow-same-origin` keeps that origin for the plugin's own cookie.
 * `allow-downloads` lets the plugin save a file it makes (a CSV export,
 * often a blob URL). There is no `allow-top-navigation` and no
 * `allow-popups`: a new tab is the host's button, or a bridge `open` the
 * host performs (after its own confirmation for a link outside
 * `bridge.open`, with `bridge.openAnyHttps`).
 */
export const PLUGIN_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-downloads';

/** The workspace origin, so the plugin's postMessage target is exact. */
export const PLUGIN_PARENT_HEADER = 'x-cb-parent-origin';

/**
 * What the launcher and the embed page know about an installed plugin the
 * person may use (its audience).
 */
export interface PluginLauncherEntry {
    id: string;
    name: string;
    description: string;
    display: 'tab' | 'embed';
    mode: PluginMode;
    /** The plugin's public origin (the apps host). Empty for a bundled plugin. */
    origin: string;
    entryPath: string;
    /** URLs the embed may ask the host to open (`bridge.open`). */
    openAllow: string[];
    /**
     * Any other https URL the embed asks for opens after the person
     * confirms it (`bridge.openAnyHttps`). False for a plugin without it.
     */
    openAnyHttps: boolean;
    /**
     * The embed's routes have workspace addresses (`bridge.routes`,
     * CB-446): `/plugins/<id>/<path>?<query>#<hash>` opens the frame there,
     * and the address follows the app's `route` reports.
     */
    routes: boolean;
}

export const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * The plugins the legacy `plugins:read` / `plugins:write` scopes cover:
 * only those that existed when the scopes shipped (v0.22.0). A person who
 * consented to them then consented to these plugins, not to whatever an
 * admin installs later, so every other plugin needs its own scopes.
 */
export const LEGACY_SCOPE_PLUGINS: readonly string[] = ['social-strategy'];

/**
 * The legacy connected-agent scope for a permission of a plugin in
 * `LEGACY_SCOPE_PLUGINS`: `<area>:read` is `plugins:read`, anything else
 * (a write) is `plugins:write`. A read-only connection gets no write tools.
 */
export function pluginAgentScope(permission: string): 'plugins:read' | 'plugins:write' {
    return `plugins:${pluginPermissionAccess(permission)}`;
}

/**
 * One plugin's own connected-agent scope for a permission:
 * `plugins:<id>:read` for a `<area>:read` permission, else
 * `plugins:<id>:write`. A person can consent to one plugin's tools
 * without consenting to every plugin's.
 */
export function pluginScope(id: string, permission: string) {
    return `plugins:${id}:${pluginPermissionAccess(permission)}`;
}

/**
 * The scopes, any one of which allows a plugin's tool with `permission`:
 * its own scope first, then the legacy one for a plugin the legacy scopes
 * cover.
 */
export function pluginToolScopes(id: string, permission: string): string[] {
    return LEGACY_SCOPE_PLUGINS.includes(id)
        ? [pluginScope(id, permission), pluginAgentScope(permission)]
        : [pluginScope(id, permission)];
}

/** `plugins:<id>:read` or `plugins:<id>:write`. */
export const PLUGIN_SCOPE = /^plugins:([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?):(read|write)$/;

/** The plugin id and access a per-plugin scope names, or undefined. */
export function parsePluginScope(scope: string) {
    const match = PLUGIN_SCOPE.exec(scope);
    if (!match || match[1]!.includes('--')) {
        return undefined;
    }
    return { id: match[1]!, access: match[2] as 'read' | 'write' };
}

/** A per-plugin scope in plain words, for the consent screen. */
export function pluginScopeLabel(name: string, access: 'read' | 'write') {
    return access === 'read'
        ? `Read data in the ${name} plugin, if you may use it`
        : `Add and change data in the ${name} plugin, if you may use it`;
}

/**
 * The name an install or an update request acknowledges the sensitive
 * `bridge.openAnyHttps` scope by (`acknowledged: ['bridge.openAnyHttps']`):
 * the server refuses to adopt a manifest that declares it, or an update
 * that adds it, without it, so a stale page can't grant it unseen.
 */
export const OPEN_ANY_HTTPS_SCOPE = 'bridge.openAnyHttps';

/** What `bridge.openAnyHttps` lets a plugin do, in plain words, wherever its scopes are reviewed. */
export const OPEN_ANY_HTTPS_LABEL =
    'Open any https link in a new tab, after you confirm each one. Links it lists in its manifest open without asking.';
