/**
 * What other features may know of workspace plugins: their tags, the
 * slices of the plugin service they call, and plain types and constants.
 * It imports only `effect`, `@socio/*` and other contracts, and holds no
 * logic.
 *
 * The types and constants here moved from the files that defined them, which
 * re-export them (`InstalledPlugin`, `PluginRuntime`: `service.ts`;
 * `CatalogRef`: `catalog.ts`; `PluginCaller`: `actor.ts`; the header names:
 * `person.ts`), so every importer keeps compiling until that importer switches
 * to the contract. `PluginService` implements `PluginsShape`, `PluginActors`
 * implements `PluginActorsShape`.
 *
 * Not here, on purpose:
 * - `PluginService` itself and `PluginError` (a plain `Error`, thrown and
 *   caught only inside `plugins/`): the composition constructs the service;
 *   other features get the `Plugins` tag.
 * - `appsSettings`: its type, `AppsSettings`, is in
 *   `packages/foundation/src/apps/settings.ts`; `actors/approvals.ts` and
 *   `apps/proxy.ts` keep reading the value from the class.
 * - Wiring the composition does once (`useActiveUsers`, `useActors`,
 *   `migrateIdentities`), plugins' own routes (`composition/http/plugins.ts`:
 *   `feed`, `serviceCaller`, `acceptsServiceCall`, `workloadIdentity`,
 *   `staleIdentity`) and what only `plugins/` calls (`dotTools`, `install`,
 *   `configure`, ...).
 * - `catalogsFromEnv` and `deletePluginAccessOf`: the server entry and the
 *   auth CLI (entry files) call them. `pluginOAuthScopes` stays in
 *   `catalog.ts` too: it reads the bundled plugins, so it is feature logic;
 *   `auth/` gets it as the `PluginCatalog` tag below.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Context } from 'effect';

import type { AppsSettings } from '@socio/foundation/apps/settings';
import type { RuntimeRegistryGrant, RuntimeServiceStatus } from '@socio/shared/apps/apps-runtime-types';
import type { IdentityGrant } from '@socio/shared/identity-delivery';
import type {
    PluginBindingChoice,
    PluginBindingChoices,
    PluginBindingPlan,
    PluginNeedPlan,
} from '@socio/shared/plugins/bindings';
import type { PluginBackupHistoryEntry, PluginBackupStatus } from '@socio/shared/plugins/plugin-backup';
import type { PluginServiceSpec } from '@socio/shared/plugins/plugin-service';
import type {
    PluginAudience,
    PluginDataset,
    PluginLauncherEntry,
    PluginManifest,
    PluginMode,
} from '@socio/shared/plugins/plugins';
import type { User } from '@socio/shared/types';

import type { CheckResult, CredentialRecord, TrackedHandle } from '../actors/contract.js';

// ── Headers ──────────────────────────────────────────────────────────────

/**
 * Who is using a service plugin (CB-254), signed (`plugins/person.ts`), for
 * a plugin whose manifest asks for `person:read`.
 */
export const PLUGIN_PERSON_HEADER = 'x-cb-person';

/**
 * The person's IANA time zone (their profile's, else the workspace's), on
 * every request to every service plugin. Not personal enough to need the
 * permission; a plugin uses it instead of assuming one zone.
 */
export const PLUGIN_TIME_ZONE_HEADER = 'x-cb-time-zone';

// ── Catalog and runtime ──────────────────────────────────────────────────

/** One entry of `PLUGIN_CATALOGS`. */
export type CatalogRef = { kind: 'bundled'; id: string } | { kind: 'file'; path: string };

/** What Socio asks the apps runtime to do with a plugin service. */
export interface PluginRuntime {
    /**
     * Creates or updates the service. `identity` is the plugin's fresh
     * identity token, which the runtime delivers through its identity
     * delivery adapter before writing the service.
     * `registry` is the registry login its image pulls with, which Swarm
     * keeps with the service for every task start.
     */
    provisionService(
        id: string,
        spec: PluginServiceSpec,
        identity?: IdentityGrant,
        registry?: RuntimeRegistryGrant,
    ): Promise<RuntimeServiceStatus>;
    /**
     * Re-attaches the infra services (and the egress proxy, with `egress`)
     * to the plugin's network; a no-op for each one already attached.
     * Optional: a runtime without it (tests) is left as it is.
     */
    repairServiceNetworks?(id: string, egress: boolean): Promise<void>;
    scaleService(id: string, replicas: number): Promise<RuntimeServiceStatus>;
    removeService(id: string): Promise<void>;
    serviceStatus(id: string): Promise<RuntimeServiceStatus | undefined>;
}

/**
 * What the data space does for a service plugin's dataset needs
 * (`PluginManifest.datasets`, CB-451), as the composition wires it
 * (`PluginService.useDatasets`): bind them to workspace datasets on install
 * and enable, unbind them on uninstall, and end the plugin's data tokens
 * when it is disabled or uninstalled. The data is kept either way.
 */
export interface PluginDatasetsHost {
    ensure(
        pluginId: string,
        datasets: ReadonlyArray<PluginDataset>,
        options?: { choices?: PluginBindingChoices; by?: string },
    ): unknown;
    /** Throws when `ensure` would refuse these needs and choices; changes nothing (CB-387, CB-451). */
    check?(pluginId: string, datasets: ReadonlyArray<PluginDataset>, choices?: PluginBindingChoices): unknown;
    /** The manifest declaring these datasets is adopted (install, update): record what follows it (CB-387). */
    adopted?(pluginId: string, datasets: ReadonlyArray<PluginDataset>): void;
    revokeTokens(pluginId: string): void;
    /** Ends the plugin's bindings (uninstall, a failed install); the datasets stay. */
    unbind?(pluginId: string, by: string): void;
    /** Each need, its binding, the previous one and the datasets it could bind to. */
    plan?(pluginId: string, datasets: ReadonlyArray<PluginDataset>, installed: boolean): PluginBindingPlan;
    /** Rebinds or unbinds one need of an installed plugin. */
    bind?(
        pluginId: string,
        datasets: ReadonlyArray<PluginDataset>,
        need: string,
        choice: PluginBindingChoice,
        by: string,
    ): PluginNeedPlan;
}

/**
 * The backups' side of a plugin's own storage (CB-458, step 5), as the
 * plugin routes use it: its status and stored snapshots for its page,
 * **Back up now**, and the plugin's own request. The composition wires it
 * from the backups (`PluginService.useBackups`); until then the routes
 * answer from the manifest alone.
 */
export interface PluginBackupsHost {
    status(id: string): PluginBackupStatus | undefined;
    history(id: string): PluginBackupHistoryEntry[];
    /** Starts one now, in the background, or joins the one taken now. */
    backUpNow(id: string): { ok: true; coalesced: boolean } | { ok: false; status: 404 | 409; error: string };
    /** The plugin's own request: joined to one taken now, else at most one an hour and four a day. */
    request(
        id: string,
        reason: string,
    ):
        | { ok: true; coalesced: boolean }
        | { ok: false; status: 404 | 409; error: string }
        | { ok: false; status: 429; error: string; retryAfterSeconds: number };
}

// ── Installs ─────────────────────────────────────────────────────────────

export interface InstalledPlugin {
    id: string;
    version: string;
    enabled: boolean;
    display: 'tab' | 'embed';
    config: Record<string, string>;
    permissions: string[];
    manifest: PluginManifest;
    replicas: number;
    /** Who may use it; admins and operators always may. */
    audience: PluginAudience;
    /** `bundled` runs inside Socio; `service` on the app runtime. */
    mode: PluginMode;
    /**
     * Its install revision (CB-370): a SHA-256 of its manifest and settings,
     * which its service carries as `socio.plugin.revision`. A public webhook
     * request reaches only a service running exactly this one.
     */
    revision: string;
}

/** A plugin data call's caller, from the service's `x-cb-obo`. */
export type PluginCaller = { ok: true; user: User; grantId?: string } | { ok: false; status: 403; error: string };

/** A redeemed launch code: the session cookie's value, where to go, and its age. */
export interface RedeemedPluginSession {
    value: string;
    next: string;
    maxAgeSeconds: number;
}

/** A live plugin session from its cookie. */
export interface PluginSession {
    plugin: InstalledPlugin;
    userId: string;
    sessionHash: string;
}

/**
 * Where the apps proxy sends a service plugin: the runtime ingress (which
 * round-robins replicas), or why it can't.
 */
export type PluginTarget =
    | { state: 'not_configured' | 'stopped' | 'unavailable' }
    | {
          state: 'running';
          host: string;
          port: number;
          headers: Record<string, string>;
          /** The ingress signature over every identity header the proxy adds. */
          sign: (method: string, target: string, headers: Record<string, string>) => Record<string, string>;
      };

// ── Slices ───────────────────────────────────────────────────────────────

/**
 * Socio's own calls to a service plugin on the reserved `/__cb/` prefix
 * (CB-458): the host envelope and the task pin. Its own slice,
 * apart from `PluginsShape`, so the apps proxy (whose `AppsPlugins` is
 * `PluginsShape`) never has it. `plugins/service.ts`'s `PluginService`
 * implements it.
 */
export interface PluginHostShape {
    /** Where one host call goes and its headers; throws for a target off `/__cb/`. */
    hostTarget(
        id: string,
        request: { method: string; target: string; task?: string },
    ): Promise<
        | { state: 'not_configured' | 'stopped' | 'unavailable' }
        | { state: 'running'; host: string; port: number; headers: Record<string, string> }
    >;
    /** The plugin's running tasks' ids, as the runtime lists them. */
    hostTasks(id: string): Promise<string[]>;
}

/**
 * Socio-actor access for plugins (CB-232), as the apps proxy uses it
 * on a socio's session at a plugin's origin. `plugins/actor.ts`'s
 * `PluginActors` implements it.
 */
export interface PluginActorsShape {
    /** A socio session's check at the plugin's origin. */
    check(
        id: string,
        token: string,
        correlationId: string,
        bind: (credential: CredentialRecord) => boolean,
    ): Promise<CheckResult | { ok: false; status: 403 }>;
    /** A context's proof key. */
    contextKey(contextId: string): Buffer;
    /** The `x-cb-actor` value for one forwarded request; undefined without the runtime's secret. */
    envelope(
        row: InstalledPlugin,
        input: {
            personId: string;
            sessionRef: string;
            obo?: string;
            method: string;
            target: string;
            socio?: { socioId: string; grantId: string; scopes: readonly string[] };
        },
    ): string | undefined;
    /** A `cbob_` for one request to the plugin, for `plugin:<id>` only. */
    mintObo(id: string, actor: { grantId: string } | { sessionHash: string }, requestId: string, ttlMs: number): string;
    /** Holds a socio session's open response; returns its release. */
    track(grantId: string, handle: TrackedHandle): () => void;
}

/**
 * The plugin service, as other features and the composition call it: installs,
 * who may use them, their origins, sessions and the apps proxy's routing.
 * `plugins/service.ts`'s `PluginService` implements it.
 */
export interface PluginsShape {
    /** Socio-actor access, once the platform wired it (undefined until then). */
    readonly actors: PluginActorsShape | undefined;
    /** The workspace origin (`APP_ORIGIN`), or ''. */
    readonly parentOrigin: string;
    /** Installed plugins, copies. */
    list(): InstalledPlugin[];
    get(id: string): InstalledPlugin | undefined;
    /** One install as the database has it now, not this process's list (another runtime's change counts). */
    current(id: string): InstalledPlugin | undefined;
    /** A service plugin's origin, when the apps host is set. */
    origin(id: string): string | undefined;
    /** The plugin origin a document on the plugin's address (`/plugins/:id` and under it) may frame, when it embeds. */
    embedOrigin(path: string): string | undefined;
    /** Installed, enabled plugins `person` may open (their audience). */
    launcher(person: User): PluginLauncherEntry[];
    /** Whether `person` may use an installed plugin now. */
    mayUse(row: InstalledPlugin | undefined, person: User | undefined): boolean;
    /** The person behind `userId`, when they can sign in now. */
    activeUser(userId: string): User | undefined;
    /** A person's zone: their profile's, else the workspace's. */
    timeZoneOf(userId: string): Promise<string>;
    /** A person's stable, per-plugin id. */
    personId(id: string, userId: string): string;
    /** Headers about the person for a service plugin's request (CB-254). */
    personHeaders(
        id: string,
        userId: string,
        request?: { method: string; target: string; sessionHash: string },
    ): Promise<Record<string, string>>;
    /** Redeems a launch code for a session. */
    redeem(id: string, code: string | undefined): Promise<RedeemedPluginSession | undefined>;
    /** A live session from its cookie value. */
    session(id: string, value: string | undefined): Promise<PluginSession | undefined>;
    /** A live session by its hash, for that plugin (what a person's `cbob_` names). */
    sessionByHash(id: string, hash: string): Promise<{ userId: string } | undefined>;
    /** Ends one person's plugin sessions and launch codes; resolves to how many rows ended. */
    endAccessOf(userId: string): Promise<number>;
    /** How many rows `endAccessOf` would end now (CB-360's deactivation preview). */
    accessCountOf(userId: string): number;
    /** An open WebSocket to a service plugin, for `userId`; returns its release. */
    track(id: string, userId: string, socket: { destroy: () => void }): () => void;
    /** Where the apps proxy sends this plugin. */
    target(id: string): Promise<PluginTarget>;
    /** A plugin's current identity version and when it was issued. */
    identityIssue(pluginId: string): { version: number; issuedAt: number } | undefined;
    /** Tool name → the connected-agent scopes a call needs (any one of them). */
    toolScopes(): Map<string, string[]>;
    /**
     * Registers installed plugins' tools for a connected agent: only for a
     * person in the plugin's audience, only tools whose permission the
     * install granted, only those the connection's OAuth scopes allow, and
     * none whose name is in `taken`.
     */
    contributeMcp(
        server: McpServer,
        ctx: {
            readonly person: User;
            readonly origin: string;
            readonly scopes: readonly string[];
            /** "Claude Code for Ana": recorded as how a change was made. */
            readonly via?: string;
        },
        taken?: ReadonlySet<string>,
    ): void;
}

/**
 * The per-plugin connected-agent scopes this instance's catalog offers
 * (`plugins:<id>:read|write`), with plain words for the consent screen.
 * Fixed at boot, like the catalog. The composition provides it as
 * `pluginOAuthScopes(catalogs)` (`plugins/catalog.ts`).
 */
export interface PluginCatalogShape {
    oauthScopes(): { scopes: string[]; labels: Record<string, string> };
}

/**
 * What `plugins/` reads of the server's config: `PlatformConfig.plugins`,
 * and the apps' settings, the apps runtime's token and ingress, and the
 * workspace origin that the plugin service is built with. The composition
 * root builds it from the supplied startup configuration
 * (`composition/plugins.ts`).
 */
export interface PluginsConfigShape {
    catalogs: readonly CatalogRef[];
    /** `PLUGIN_SERVICE_TOKEN`, deprecated by per-plugin identity tokens. */
    serviceToken?: string;
    /** Set by tests; production uses the apps runtime. */
    runtime?: PluginRuntime;
    /** The apps' settings (`APPS_HOST`, ...), for service plugins' origins; none when unset. */
    apps?: AppsSettings;
    /** The apps runtime's token (`APPS_RUNTIME_TOKEN`), which keys plugin proofs and envelopes. */
    runtimeToken?: string;
    /** The apps runtime's ingress, where the apps proxy sends a service plugin. */
    ingress?: { host: string; port: number };
    /** The workspace origin (`APP_ORIGIN`), or ''. */
    parentOrigin: string;
}

// ── Tags ─────────────────────────────────────────────────────────────────

export class Plugins extends Context.Service<Plugins, PluginsShape>()('socio/plugins/Plugins') {}

export class PluginCatalog extends Context.Service<PluginCatalog, PluginCatalogShape>()(
    'socio/plugins/PluginCatalog',
) {}

export class PluginsConfig extends Context.Service<PluginsConfig, PluginsConfigShape>()(
    'socio/plugins/PluginsConfig',
) {}

/**
 * Binds the plugins to the mini apps (`AppsService.usePlugins`), so the
 * internal apps listener can serve a socio's session on a plugin: wiring
 * the module's `capabilities` hook does once, in its place, which the
 * composition provides (apps is above plugins in the folder order).
 */
export interface PluginsInAppsShape {
    readonly usePlugins: () => void;
}

export class PluginsInApps extends Context.Service<PluginsInApps, PluginsInAppsShape>()(
    'socio/plugins/PluginsInApps',
) {}
