// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { sqliteData } from '@socio/data/open';
import { personSeedOf } from '@socio/data/person-seed';
import { ACTOR_ENVELOPE_HEADER } from '@socio/foundation/apps/envelope';
import { redactAppLog } from '@socio/foundation/apps/log-redact';
import { appOrigin, type AppsSettings } from '@socio/foundation/apps/settings';
import { toolError } from '@socio/foundation/http/tool-error';
import type { DotTurn } from '@socio/foundation/turns/turn';
import {
    RUNTIME_HEADER_SIG,
    RUNTIME_HEADER_TASK,
    type RuntimeRegistryGrant,
    type RuntimeServiceStatus,
} from '@socio/shared/apps/apps-runtime-types';
import type { PluginBindingChoice, PluginBindingChoices, PluginBindingPlan } from '@socio/shared/plugins/bindings';
import { configValueError, PLUGIN_CONFIG_VALUE_MAX } from '@socio/shared/plugins/plugin-config';
import {
    checkServiceSpec,
    PLUGIN_ID,
    resolvePluginEgress,
    type PluginServiceSpec,
} from '@socio/shared/plugins/plugin-service';
import {
    pluginUpdateAcknowledged,
    pluginUpdateDiff,
    type PluginUpdateAck,
    type PluginUpdateAddition,
    type PluginUpdateReview,
} from '@socio/shared/plugins/plugin-update';
import {
    OPEN_ANY_HTTPS_SCOPE,
    PLUGIN_PERSON_PERMISSION,
    pluginToolScopes,
    pluginMode,
    pluginScope,
    pluginScopeLabel,
    parsePluginScope,
    pluginAddress,
    PLUGIN_ROUTE_MAX,
    type PluginAudience,
    type PluginLauncherEntry,
    type PluginManifest,
} from '@socio/shared/plugins/plugins';
import type { RegistryCredential } from '@socio/shared/plugins/registry-auth';
import { isAdmin } from '@socio/shared/roles';
import { DEFAULT_TIME_ZONE, ianaTimeZone } from '@socio/shared/time-zone';
import type { User } from '@socio/shared/types';

import { identitySignature, ingressKey, pluginProof } from '../../apps-runtime/keys.js';
import type { ActorsShape } from '../actors/contract.js';

import { PluginActors } from './actor.js';
import { bundledPlugins, type PluginContext, type PluginToolCall, type PluginToolDefinition } from './bundled.js';
import { loadCatalog, scopedManifests } from './catalog.js';
import {
    PLUGIN_PERSON_HEADER,
    PLUGIN_TIME_ZONE_HEADER,
    type CatalogRef,
    type InstalledPlugin,
    type PluginBackupsHost,
    type PluginDatasetsHost,
    type PluginHostShape,
    type PluginRuntime,
    type PluginsShape,
} from './contract.js';
import { PluginToolError } from './errors.js';
import { signHostEnvelope } from './host-envelope.js';
import { PluginIdentities } from './identity.js';
import {
    SqlitePlugins,
    adoptPluginManifest,
    countPluginAccessOf,
    deletePluginAccessOf,
    pluginHash,
    relocatePluginImage,
    savePluginConfig,
} from './infra/repository.js';
import { signPluginPerson } from './person.js';
import { migrateBundledPlugin } from './plugin-schemas.js';
import { PluginReleaseNotes } from './release-notes.js';

/**
 * Refuses (409) unless `acknowledged` names `bridge.openAnyHttps`: the
 * request must say the admin reviewed that sensitive scope. The page that
 * gets this reloads and shows the warning.
 */
function requireAcknowledged(acknowledged: readonly string[] | undefined, what: string, lead: string) {
    if (!acknowledged?.includes(OPEN_ANY_HTTPS_SCOPE)) {
        throw new PluginError(
            `${lead} the sensitive scope ${OPEN_ANY_HTTPS_SCOPE} (${what}): it may open any https link after the person confirms it. Review it and confirm again.`,
            409,
        );
    }
}

export class PluginError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 502 | 503 = 400,
        /** Answered beside the message: an update's review, when the update needs an acknowledgment (CB-531). */
        readonly detail?: { update: PluginUpdateReview },
    ) {
        super(message);
    }
}

/** A stored manifest, normalized as `JSON.stringify` writes it, or '' when it doesn't parse. */
const storedManifest = (stored: string) => {
    try {
        return JSON.stringify(JSON.parse(stored));
    } catch {
        return '';
    }
};

/** A manifest's revision for an update's acknowledgment (CB-531): a SHA-256 of it as stored. */
export const manifestRevision = (manifest: unknown) =>
    createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

interface RawInstall {
    id: string;
    version: string;
    enabled: number | boolean;
    display: 'tab' | 'embed';
    config: string | Record<string, string>;
    permissions: string | string[];
    manifest: string | PluginManifest;
    replicas: number;
    audience?: PluginAudience | null;
}

const json = <T>(value: string | T, fallback: T): T => {
    if (typeof value !== 'string') {
        return value;
    }
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
};

/**
 * A path on the plugin's own origin, or `/`. At most `PLUGIN_ROUTE_MAX`
 * characters, the bridge's own limit (CB-446): any route the workspace
 * address mirrors must open again on a reload, a shared link or a new tab.
 * Browsers drop tabs and line
 * breaks from a URL before parsing it, so `/<tab>/evil.example` would
 * become `//evil.example`: any control character, space or backslash is
 * refused, and the result must resolve on the same origin.
 */
export const safeNext = (next: string) => {
    if (
        typeof next !== 'string' ||
        next.length > PLUGIN_ROUTE_MAX ||
        !next.startsWith('/') ||
        next.startsWith('//') ||
        [...next].some((ch) => ch <= ' ' || ch === '\u007f' || ch === '\\')
    ) {
        return '/';
    }
    try {
        const base = 'https://plugin.invalid';
        const url = new URL(next, base);
        return url.origin === base ? next : '/';
    } catch {
        return '/';
    }
};

/** JSON with every object's keys sorted, so equal values give equal text. */
function stableJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * An install revision (CB-370): a SHA-256 of the manifest and settings a
 * plugin's service is provisioned from (`PluginServiceSpec.revision`).
 */
export function installRevision(manifest: PluginManifest, config: Record<string, string>) {
    return createHash('sha256').update(stableJson({ manifest, config })).digest('hex');
}

/**
 * How long a service plugin's saved settings wait before its service is
 * provisioned with them (CB-398 follow-up): each save starts the wait again,
 * so an admin editing several fields restarts the plugin once, after the
 * edits settle. Leaving the page or **Apply now** applies them at once.
 */
export const PLUGIN_SETTINGS_APPLY_DELAY_MS = 10_000;

/**
 * Install, route and sign in plugins on this instance. Codes and sessions
 * are rows, so whichever Socio process handles the next request can redeem
 * them, and the plugin's own replicas never see a session.
 */
export class PluginService implements PluginsShape, PluginHostShape {
    private repo: SqlitePlugins;
    private catalog: Map<string, PluginManifest>;
    private installed: InstalledPlugin[] = [];
    /** The database's `data_version` when `installed` was read (see `installs`). */
    private installedStamp = '';
    private actorAccess?: PluginActors;
    /**
     * Open WebSockets to service plugins on this runtime (CB-239), by
     * plugin, with whose they are. A cache of what this process holds: a
     * person's socket also re-reads its session every 5 s (apps/proxy.ts),
     * a socio's is tracked under its grant (CB-232).
     */
    private sockets = new Map<string, Set<{ userId: string; destroy: () => void }>>();
    /** Each plugin's own identity token. */
    readonly identities: PluginIdentities;
    /** Plugins' release notes and who saw them (CB-527). */
    readonly releaseNotes: PluginReleaseNotes;
    /** Plugins already warned about calling with the shared token, this process. */
    private sharedTokenWarned = new Set<string>();
    /** The data space's side of plugins' declared datasets, once the composition wires it. */
    private datasets?: PluginDatasetsHost;
    /**
     * The registry login plugin images pull with (`PLUGIN_REGISTRY_AUTH`:
     * the workspace secret over the environment's), once the composition
     * wires it; its grant is kept while the login stays the same.
     */
    private registrySource?: () => RegistryCredential | undefined;
    private registryCache?: { key: string; grant: RuntimeRegistryGrant };
    private registryWarned = false;
    /**
     * The registry login each service without a revision label was last
     * provisioned with here (by fingerprint, `''` for none): a runtime that
     * keeps no labels is given each login once, not on every tick.
     */
    private unlabeledRegistry = new Map<string, string>();
    /**
     * The installed image each service without a revision label was last
     * provisioned with here because it ran the same digest elsewhere: a
     * runtime that runs another location of the pin is asked once, not on
     * every tick.
     */
    private unlabeledImage = new Map<string, string>();
    /** When `reconcileAll` last ran here: the plugins tick runs it every ten minutes. */
    private reconciledAt = 0;
    /**
     * Each service plugin's settings apply on this process (CB-398 follow-up):
     * the wait after the last save, the apply in flight (never two at once),
     * whether a save asked for another after it, and whether a save since the
     * last apply left settings the service may not run yet.
     */
    private applies = new Map<
        string,
        { timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; again: boolean; dirty: boolean }
    >();

    constructor(
        private db: DatabaseSync,
        private options: {
            catalogs: readonly CatalogRef[];
            settings?: AppsSettings;
            runtimeToken?: string;
            ingress?: { host: string; port: number };
            /**
             * `PLUGIN_SERVICE_TOKEN`, deprecated by per-plugin identity
             * tokens: still accepted (with the proof) for one release, with a
             * warning per plugin, while plugins move to their own identity.
             */
            serviceToken?: string;
            runtime?: PluginRuntime;
            parentOrigin: string;
            users: () => User[];
            /** Operations' time zone (CB-254); UTC when unset. */
            workspaceTimeZone?: () => string;
            /** A person's own zone from their profile, when they set one. */
            personTimeZone?: (userId: string) => Promise<string | undefined>;
            sync?: () => void;
            log?: (line: string) => void;
            /** `PLUGIN_SETTINGS_APPLY_DELAY_MS` unless set (tests). */
            applyDelayMs?: number;
        },
    ) {
        options.sync?.();
        this.repo = new SqlitePlugins(sqliteData(db));
        this.identities = new PluginIdentities(db);
        this.releaseNotes = new PluginReleaseNotes(db, {
            installs: () => this.installs(),
            mayUse: (row, person) => this.mayUse(row, person),
            users: () => this.options.users(),
            log: (line) => this.options.log?.(line),
        });
        this.catalog = loadCatalog(options.catalogs);
        this.refresh();
        options.sync?.();
    }

    private readInstalled(id?: string): InstalledPlugin[] {
        const table = this.db
            .prepare("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='plugin_installs'")
            .get() as { n: number } | undefined;
        if (!table) {
            return [];
        }
        const rows = (id === undefined
            ? this.db.prepare('SELECT * FROM plugin_installs').all()
            : this.db.prepare('SELECT * FROM plugin_installs WHERE id=?').all(id)) as unknown as RawInstall[];
        return rows.map((row) => {
            const stored = json(row.manifest, {} as PluginManifest);
            // A bundled plugin always runs the manifest this build ships.
            const manifest = bundledPlugins[row.id]?.manifest ?? stored;
            return {
                id: row.id,
                version: row.version,
                enabled: row.enabled === true || row.enabled === 1,
                display: row.display,
                config: json(row.config, {}),
                permissions: json(row.permissions, []),
                manifest,
                replicas: row.replicas,
                audience: row.audience === 'members' ? 'members' : 'admins',
                mode: pluginMode(manifest),
                revision: installRevision(manifest, json(row.config, {})),
            };
        });
    }

    /**
     * SQLite's `data_version` on this connection: it changes whenever another
     * connection (another runtime of the deploy) commits to the database, and
     * never for this connection's own writes, which refresh the list themselves.
     */
    private stamp() {
        const row = this.db.prepare('PRAGMA data_version').get() as { data_version: number } | undefined;
        return String(row?.data_version ?? '');
    }

    private refresh() {
        this.installedStamp = this.stamp();
        this.installed = this.readInstalled();
    }

    /**
     * This process's list of installs, read again whenever another
     * connection committed since (CB-370): an update, a disable, new settings
     * or a narrowed audience on another runtime of a deploy reaches this
     * one's next read, permissions and the signed `x-cb-person` included,
     * never a stale copy, however close together the writes were.
     */
    private installs() {
        if (this.stamp() !== this.installedStamp) {
            this.refresh();
        }
        return this.installed;
    }

    /**
     * An install as the database has it, with this process's list read again
     * first: what every change starts from (CB-370), so a disable, a new
     * config or an update on another runtime of a deploy is never undone
     * here from a stale copy (an older image provisioned again, say).
     */
    private fresh(id: string) {
        this.refresh();
        return this.get(id);
    }

    /**
     * One install as the database has it now, not this process's list: what
     * socio access decides on (CB-232), so a plugin disabled or narrowed
     * on the other runtime of a deploy counts here too.
     */
    current(id: string) {
        return this.readInstalled(id)[0];
    }

    /** The app wires the auth provider's current accounts, never workspace history. */
    useActiveUsers(users: () => User[]) {
        this.options.users = users;
    }

    /**
     * Socio-actor access (CB-232), once per platform from the plugins
     * module: registers the `plugin` audience policy, whose `personMay` is
     * this install's audience and whose actions are the plugin's tools (or
     * a service plugin's declared contract). Until it is called (a plugin
     * service without a platform, in tests), socios use bundled tools as the
     * person (CB-254), and service plugins get no envelope.
     */
    useActors(actors: ActorsShape) {
        if (this.actorAccess) {
            return;
        }
        this.actorAccess = new PluginActors(
            {
                get: (id) => this.current(id),
                mayUse: (row, person) => this.mayUse(row, person),
                activeUser: (userId) => this.activeUser(userId),
                personId: (id, userId) => this.personId(id, userId),
                runtimeToken: this.options.runtimeToken,
            },
            actors,
        );
        actors.audiences.register('plugin', this.actorAccess.policy());
    }

    /**
     * The data space's side of plugins' declared datasets (the composition,
     * `plugin-datasets.ts`): until it is wired, a manifest's `datasets` makes
     * nothing and no plugin gets a data token.
     */
    useDatasets(host: PluginDatasetsHost) {
        this.datasets = host;
    }

    private backupsHost?: PluginBackupsHost;
    /**
     * The backups' side of plugins' own storage (CB-458 step 5, the
     * composition's `lifecycle/backup.ts`): until it is wired, a plugin's
     * backup status is its manifest's, and Back up now isn't offered.
     */
    useBackups(host: PluginBackupsHost) {
        this.backupsHost = host;
    }
    get backups(): PluginBackupsHost | undefined {
        return this.backupsHost;
    }

    /**
     * The registry login plugin services pull their images with (the
     * composition: the `PLUGIN_REGISTRY_AUTH` workspace secret over the
     * environment's). Every provision sends it; the reconcile provisions
     * again a service whose `socio.registry` fingerprint isn't the current
     * login's, so a new or rotated login reaches every service.
     */
    useRegistryCredential(source: () => RegistryCredential | undefined) {
        this.registrySource = source;
        this.registryCache = undefined;
    }

    /** The current registry login and its fingerprint; undefined when none (or it can't be read). */
    private registryGrant(): RuntimeRegistryGrant | undefined {
        let credential: RegistryCredential | undefined;
        try {
            credential = this.registrySource?.();
        } catch (error) {
            if (!this.registryWarned) {
                this.registryWarned = true;
                this.options.log?.(
                    `Plugins: the registry login can't be used (${error instanceof Error ? error.message : 'unreadable'}); plugin images pull without it.`,
                );
            }
            return undefined;
        }
        this.registryWarned = false;
        if (!credential) {
            return undefined;
        }
        const key = `${credential.registry}\0${credential.username}\0${credential.password}`;
        if (this.registryCache?.key !== key) {
            this.registryCache = {
                key,
                grant: { ...credential, fingerprint: registryFingerprint(key, this.options.runtimeToken) },
            };
        }
        return this.registryCache.grant;
    }

    /** One provision call, with the registry login when there is one. */
    private provisionCall(
        runtime: PluginRuntime,
        id: string,
        spec: PluginServiceSpec,
        identity: Parameters<PluginRuntime['provisionService']>[2],
    ) {
        const registry = this.registryGrant();
        return registry
            ? runtime.provisionService(id, spec, identity, registry)
            : runtime.provisionService(id, spec, identity);
    }

    /**
     * Binds a service plugin's dataset needs to workspace datasets (install,
     * enable, update; CB-451), with the admin's choices at install, before
     * its service starts, so a refusal changes nothing else.
     */
    private ensureDatasets(
        id: string,
        manifest: PluginManifest,
        choices?: PluginBindingChoices,
        by?: string,
        staged?: boolean,
    ) {
        // A manifest that declares none still runs it: its bindings from an
        // earlier version end (CB-451).
        if (pluginMode(manifest) !== 'service' || !this.datasets) {
            return;
        }
        this.datasets.ensure(id, manifest.datasets ?? [], {
            ...(choices ? { choices } : {}),
            ...(by ? { by } : {}),
            ...(staged ? { staged } : {}),
        });
    }

    /**
     * Puts a plugin's bindings back as its installed manifest has them, after
     * an update that bound for a manifest it then didn't adopt (CB-451).
     * The installed manifest's access is the ceiling meanwhile anyway.
     */
    private restoreDatasets(id: string, manifest: PluginManifest, by: string) {
        try {
            this.ensureDatasets(id, manifest, undefined, by);
        } catch {
            this.options.log?.(
                `Plugins: putting ${id}’s dataset bindings back failed; its installed manifest still limits them.`,
            );
        }
    }

    /** Ends a plugin's dataset bindings (uninstall, an install that failed); its data stays the workspace's. */
    private unbindDatasets(id: string, by: string) {
        try {
            this.datasets?.unbind?.(id, by);
        } catch {
            this.options.log?.(`Plugins: ending ${id}’s dataset bindings failed.`);
        }
    }

    /**
     * Each dataset need of a plugin, installed or in the catalog (CB-451):
     * its binding, the one it had before (preselected on reinstall), and the
     * workspace datasets it could bind to. For the install screen and the
     * plugin's page.
     */
    bindingPlan(id: string): PluginBindingPlan {
        const row = this.fresh(id);
        const manifest = row?.manifest ?? this.catalog.get(id);
        if (!manifest) {
            throw new PluginError('That plugin is not in this instance’s catalog.', 404);
        }
        if (pluginMode(manifest) !== 'service' || !manifest.datasets?.length || !this.datasets?.plan) {
            return { pluginId: id, installed: !!row, needs: [] };
        }
        return this.datasets.plan(id, manifest.datasets, !!row);
    }

    /** An admin rebinds (`new`, a dataset) or unbinds (null, read needs) one need of an installed plugin. */
    bindNeed(id: string, need: string, choice: PluginBindingChoice, by: string) {
        const row = this.fresh(id);
        if (!row) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        if (row.mode !== 'service' || !row.manifest.datasets?.length || !this.datasets?.bind) {
            throw new PluginError('This plugin declares no datasets.', 404);
        }
        return this.datasets.bind(id, row.manifest.datasets, need, choice, by);
    }

    /** Tells the data space a manifest is adopted (CB-387); a failure there never undoes it. */
    private datasetsAdopted(id: string, manifest: PluginManifest, by = 'system') {
        if (pluginMode(manifest) !== 'service') {
            return;
        }
        // The adopted manifest's bindings, whole (CB-451): needs it no longer
        // declares end, access changes apply, enabled or not. An update's
        // binding before its service ran added only what is new.
        try {
            this.ensureDatasets(id, manifest, undefined, by);
        } catch (error) {
            this.options.log?.(
                `Plugins: reconciling ${id}’s dataset bindings failed (${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}).`,
            );
        }
        if (!manifest.datasets?.length) {
            return;
        }
        try {
            this.datasets?.adopted?.(id, manifest.datasets);
        } catch {
            this.options.log?.(`Plugins: recording ${id}’s dataset retention failed.`);
        }
    }

    /** Ends the plugin's data tokens on every runtime (disable, uninstall); its data stays. */
    private revokeDataTokens(id: string) {
        try {
            this.datasets?.revokeTokens(id);
        } catch {
            this.options.log?.(`Plugins: ending ${id}'s data tokens failed; each is refused at its next request.`);
        }
    }

    /**
     * Whether a plugin's data token (`purpose: 'plugin'`) still opens: the
     * plugin is installed, enabled and a service, as the database has it now,
     * and the identity version it was exchanged for is still accepted.
     */
    dataTokenLive(id: string, identityVersion: number) {
        const row = this.current(id);
        return !!row?.enabled && row.mode === 'service' && this.identities.accepts(id, identityVersion);
    }

    /** Socio-actor access for plugins, once the platform wired it. */
    get actors() {
        return this.actorAccess;
    }

    get appsSettings() {
        return this.options.settings;
    }

    get parentOrigin() {
        return this.options.parentOrigin;
    }

    list() {
        return this.installs().map((row) => ({ ...row }));
    }

    get(id: string) {
        return this.installs().find((row) => row.id === id);
    }

    catalogEntries() {
        return [...this.catalog.values()];
    }

    /**
     * The catalog's manifest for an installed service plugin when it differs
     * from the one installed (a new version, image or declaration such as
     * `webhooks`): what **Update** would adopt. Undefined when it is the
     * same, gone from the catalog, or the plugin is bundled (a bundled
     * plugin always runs the manifest this build ships).
     */
    catalogUpdate(id: string) {
        const row = this.current(id);
        const next = this.catalog.get(id);
        if (!row || row.mode !== 'service' || !next || pluginMode(next) !== 'service') {
            return undefined;
        }
        return JSON.stringify(next) === JSON.stringify(row.manifest) ? undefined : next;
    }

    /**
     * What **Update** would adopt, for the admin to review (CB-531): what the
     * catalog's manifest adds over the installed one, the stored settings it
     * deletes, and the two revisions an acknowledgment is bound to.
     * Undefined when there is no update.
     */
    updateReview(id: string): PluginUpdateReview | undefined {
        const row = this.current(id);
        const next = this.catalogUpdate(id);
        return row && next ? this.reviewOf(row, next) : undefined;
    }

    private reviewOf(row: Pick<InstalledPlugin, 'manifest' | 'config'>, next: PluginManifest): PluginUpdateReview {
        const { additions, removedSettings } = pluginUpdateDiff(row.manifest, next, row.config);
        const openAnyHttps = next.bridge?.openAnyHttps === true;
        return {
            version: next.version,
            from: manifestRevision(row.manifest),
            to: manifestRevision(next),
            additions,
            removedSettings,
            openAnyHttps,
            addsOpenAnyHttps: additions.some((addition) => addition.kind === 'bridge-open-any-https'),
        };
    }

    /**
     * Adopts the catalog's current manifest for an installed service plugin,
     * in place (CB-370): its version, image, permissions, datasets, webhooks
     * and every other declaration become the catalog's, and its data, config
     * (the settings the new manifest still has), audience, replicas, identity
     * and sessions stay. An enabled plugin's service is updated to the new
     * spec first; when the runtime refuses, nothing else changes: only the
     * datasets the new version declares, created (or adopted) just before
     * so it finds them when it starts, stay, as they do when an install's
     * record fails. Then its
     * sockets close, its data tokens end (its datasets may differ) and
     * socios' grants are checked again (its delegation may differ). What the
     * proxy serves, webhook paths included, is always the installed
     * manifest's, so it widens only here, by an admin. Answers the versions
     * before and after; `changed` is false when there was nothing to adopt.
     */
    async updateFromCatalog(id: string, by = 'system', options: { acknowledged?: PluginUpdateAck } = {}) {
        const row = this.fresh(id);
        if (!row) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        if (row.mode !== 'service') {
            throw new PluginError('This plugin runs inside Socio and updates with it.', 400);
        }
        const next = this.catalog.get(id);
        if (!next) {
            throw new PluginError('That plugin is no longer in this instance’s catalog.', 404);
        }
        if (pluginMode(next) !== 'service') {
            throw new PluginError('The catalog no longer lists this plugin as a service.', 409);
        }
        const from = { version: row.version, manifest: row.manifest };
        if (!this.catalogUpdate(id)) {
            return { changed: false, from: from.version, to: row.version, manifest: row.manifest };
        }
        // CB-531: anything the new version adds (a host it reaches, a scope,
        // a secret, a dataset or write access, a public path, more resources)
        // is adopted only with an acknowledgment of exactly this diff, bound
        // to both revisions: the catalog, the installed manifest or its
        // settings may have changed since the admin's page listed it.
        const review = this.reviewOf(row, next);
        if (review.additions.length && !pluginUpdateAcknowledged(review, options.acknowledged)) {
            throw new PluginError(
                `This update adds what ${row.manifest.name} ${row.version} doesn’t have (${next.name} ${next.version}). Review it and confirm again.`,
                409,
                { update: review },
            );
        }
        const acknowledged: PluginUpdateAddition[] = review.additions;
        const fields = next.config ?? {};
        const config = Object.fromEntries(Object.entries(row.config).filter(([key]) => Object.hasOwn(fields, key)));
        // Kept as they are: a value the new version types differently is
        // shown with its error on the plugin's page, not a refused update.
        this.checkConfig(next, config, 'adopt');
        const spec = this.specFor(next, config, row.replicas || next.service?.replicas || 1);
        if (row.enabled) {
            // Staged (CB-451): only what it adds, until the manifest is adopted.
            this.ensureDatasets(id, next, undefined, by, true);
            try {
                await this.provision(this.requireRuntime(), id, spec);
            } catch (error) {
                this.restoreDatasets(id, row.manifest, by);
                throw error;
            }
        } else if (next.datasets?.length && this.datasets?.check) {
            // Disabled: its datasets change at the next enable, but a
            // manifest that enable would refuse isn't adopted (CB-387).
            this.datasets.check(id, next.datasets);
        }
        // The settings in the row now, not the ones read above: another
        // runtime's settings change meanwhile stays.
        const kept = (current: Record<string, string>) =>
            Object.fromEntries(Object.entries(current).filter(([key]) => Object.hasOwn(fields, key)));
        let adopted;
        try {
            adopted = await adoptPluginManifest(
                this.db,
                id,
                {
                    version: next.version,
                    display: next.display,
                    permissions: next.permissions,
                    manifest: next,
                    updatedAt: Date.now(),
                },
                kept,
                // Only over the manifest the review was of (or this same update,
                // another runtime's), and only while the stored settings still
                // give the reviewed additions (a `fromConfig` host): an update or
                // a settings save committed meanwhile is reviewed again.
                (stored, settings) => {
                    const now = storedManifest(stored);
                    if (now !== JSON.stringify(row.manifest) && now !== JSON.stringify(next)) {
                        return false;
                    }
                    const keys = pluginUpdateDiff(row.manifest, next, settings).additions.map((a) => a.key);
                    const reviewed = new Set(review.additions.map((addition) => addition.key));
                    return keys.length === reviewed.size && keys.every((key) => reviewed.has(key));
                },
            );
        } catch (error) {
            this.restoreDatasets(id, row.manifest, by);
            throw error;
        }
        if (adopted === 'changed') {
            this.refresh();
            const now = this.get(id);
            if (now) {
                this.restoreDatasets(id, now.manifest, by);
            }
            // Its service goes back to what is installed now.
            await this.settle(id);
            const again = now && this.catalogUpdate(id);
            throw new PluginError(
                'This plugin changed while it was updating. Review the update again.',
                409,
                now && again ? { update: this.reviewOf(now, again) } : undefined,
            );
        }
        if (!adopted) {
            this.refresh();
            throw new PluginError('That plugin is not installed.', 404);
        }
        this.refresh();
        this.datasetsAdopted(id, next, by);
        // CB-527: the new version's notes, new to whoever may open it now.
        await this.releaseNotes.record(id, next, from.version);
        // The update is in: settling the service (another runtime's change,
        // a runtime that didn't answer) never undoes the rest of it.
        await this.settle(id);
        this.revokeDataTokens(id);
        this.closeSockets(id);
        await this.actorAccess
            ?.recheck(id, by)
            .catch(() => this.options.log?.(`Plugins: re-checking socios’ access to ${id} failed.`));
        this.options.log?.(`Plugins: updated ${id} from ${from.version} to ${next.version} from the catalog.`);
        return {
            changed: true,
            from: from.version,
            to: next.version,
            previous: from.manifest,
            manifest: next,
            acknowledged,
            revision: review.to,
        };
    }

    origin(id: string) {
        const settings = this.options.settings;
        if (!settings) {
            return undefined;
        }
        return appOrigin(settings, id);
    }

    /**
     * The plugin origin a workspace document may frame, when it embeds: on
     * the plugin's address, `/plugins/:id` and everything under it (its deep
     * links, CB-446), matched as the router matches `plugins/:pluginId/*`
     * (`pluginAddress`). The platform keeps no page under that address, so
     * no host page gets the plugin's `frame-src`.
     */
    embedOrigin(path: string) {
        const address = pluginAddress(path);
        if (!address || !PLUGIN_ID.test(address.pluginId)) {
            return undefined;
        }
        const row = this.get(address.pluginId);
        if (!row?.enabled || row.display !== 'embed' || row.mode !== 'service') {
            return undefined;
        }
        return this.origin(row.id);
    }

    /** Installed, enabled plugins `person` may open (their audience). */
    launcher(person: User): PluginLauncherEntry[] {
        return this.installs()
            .filter((row) => this.mayUse(row, person))
            .flatMap((row) => {
                const origin = row.mode === 'bundled' ? '' : this.origin(row.id);
                if (origin === undefined) {
                    return [];
                }
                return [
                    {
                        id: row.id,
                        name: row.manifest.name,
                        description: row.manifest.description,
                        display: row.display,
                        mode: row.mode,
                        origin,
                        entryPath: row.manifest.entry?.path ?? '/',
                        openAllow: [...(row.manifest.bridge?.open ?? [])],
                        openAnyHttps:
                            row.mode === 'service' &&
                            row.display === 'embed' &&
                            row.manifest.bridge?.openAnyHttps === true,
                        routes:
                            row.mode === 'service' && row.display === 'embed' && row.manifest.bridge?.routes === true,
                    },
                ];
            });
    }

    /**
     * Whether `person` may use an installed plugin now: it is enabled, and
     * they are an admin, or its audience is `members`.
     */
    mayUse(row: InstalledPlugin | undefined, person: User | undefined) {
        if (!row?.enabled || !person) {
            return false;
        }
        return isAdmin(person) || row.audience === 'members';
    }

    /** The person behind `userId`, when they can sign in now. */
    activeUser(userId: string) {
        return this.options.users().find((user) => user.id === userId);
    }

    /** The workspace's zone (Operations), UTC unless an admin set one. */
    workspaceTimeZone() {
        return ianaTimeZone(this.options.workspaceTimeZone?.()) ?? DEFAULT_TIME_ZONE;
    }

    /** A person's zone: their profile's, else the workspace's. */
    async timeZoneOf(userId: string) {
        const own = ianaTimeZone(await this.options.personTimeZone?.(userId).catch(() => undefined));
        return own ?? this.workspaceTimeZone();
    }

    /** What a bundled plugin's routes, tools and feeds get. */
    context(id: string): PluginContext {
        return {
            db: this.db,
            id,
            config: () => ({ ...this.get(id)?.config }),
            users: () => this.options.users(),
            mayUse: (person) => this.mayUse(this.get(id), person),
            workspaceTimeZone: () => this.workspaceTimeZone(),
            personTimeZone: async (userId) =>
                ianaTimeZone(await this.options.personTimeZone?.(userId).catch(() => undefined)),
            origin: this.options.parentOrigin,
            log: (line) => this.options.log?.(line),
        };
    }

    private requireRuntime() {
        if (!this.options.runtime) {
            throw new PluginError(
                'The workspace app runtime is not set up, so a plugin service cannot be created.',
                503,
            );
        }
        if (!this.options.settings) {
            throw new PluginError(
                'Mini apps are not set up (APPS_HOST and APP_ORIGIN), so a plugin has no origin.',
                503,
            );
        }
        return this.options.runtime;
    }

    private specFor(manifest: PluginManifest, config: Record<string, string>, replicas: number) {
        if (!manifest.service) {
            throw new PluginError('This plugin runs inside Socio.', 400);
        }
        // `fromConfig` entries become the hosts of their settings now (CB-441):
        // a settings change changes the revision, so it provisions again.
        const { hosts } = resolvePluginEgress(manifest.service.egress, manifest.config, config);
        const spec: PluginServiceSpec = {
            ...manifest.service,
            egress: hosts,
            // What the service runs, as Socio installed it (CB-370).
            revision: installRevision(manifest, config),
            replicas,
            env: {
                ...manifest.service.env,
                ...(Object.keys(config).length ? { PLUGIN_CONFIG: JSON.stringify(config) } : {}),
            },
        };
        if (manifest.service.egress === undefined) {
            delete spec.egress;
        }
        checkServiceSpec(spec);
        return spec;
    }

    /**
     * Writes a plugin's service with a fresh identity: every provision
     * rotates it, since only its hash is kept. When the runtime refuses, the
     * new version is abandoned and the running service's stays current.
     */
    private async provision(runtime: PluginRuntime, id: string, spec: PluginServiceSpec) {
        const identity = await this.identities.issue(id);
        try {
            return await this.provisionCall(runtime, id, spec, identity);
        } catch (error) {
            if (identity) {
                await this.identities.abandon(id, identity.version).catch(() => undefined);
            }
            throw error;
        }
    }

    /**
     * The catalog's image for an installed service plugin when it is the
     * installed image's digest at another location (the operator moved the
     * plugin to another registry, its pins with it): the same bits, so the
     * install follows it without an admin's **Update**, which still adopts
     * any other change the catalog made. Undefined otherwise.
     */
    private catalogRelocation(row: InstalledPlugin) {
        if (row.mode !== 'service' || bundledPlugins[row.id]) {
            return undefined;
        }
        const from = row.manifest.service?.image;
        const to = this.catalog.get(row.id)?.service?.image;
        const digest = from && imageDigest(from);
        return from && to && from !== to && digest && digest === imageDigest(to) ? { from, to } : undefined;
    }

    /**
     * Moves an install to the catalog's image when that is the same digest
     * elsewhere (`catalogRelocation`); a runtime that pins or allows only the
     * new location refuses the old one, so every provision from the install
     * starts here. Answers whether the install moved now. A service the move
     * didn't reach (a refusal, a restart) is found by the reconcile, which
     * compares the image it runs.
     */
    private async relocate(id: string) {
        const row = this.fresh(id);
        const move = row && this.catalogRelocation(row);
        if (!move) {
            return false;
        }
        const moved = await relocatePluginImage(this.db, id, move.from, move.to, Date.now());
        this.refresh();
        if (moved) {
            this.options.log?.(
                `Plugins: ${id}'s image moved to ${move.to} in the catalog, at the same digest; its install follows it.`,
            );
        }
        return moved;
    }

    /**
     * Rotates an installed service plugin's identity now (an admin's
     * "rotate"): a new token, a service update, the old version accepted
     * while old tasks drain, then retired.
     */
    async rotateIdentity(id: string) {
        await this.relocate(id);
        const row = this.fresh(id);
        if (!row) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        if (row.mode !== 'service' || !row.enabled) {
            throw new PluginError('Only an enabled plugin service has an identity to rotate.', 400);
        }
        const runtime = this.requireRuntime();
        await this.provision(runtime, id, this.specFor(row.manifest, row.config, row.replicas));
        await this.settle(id);
        this.options.log?.(`Plugins: rotated ${id}'s identity (version ${this.identities.current(id)}).`);
        return { version: this.identities.current(id) };
    }

    /**
     * Gives every enabled service plugin that has no identity yet its own
     * (a plugin installed before per-plugin identities runs on the shared
     * token): no operator step. Only one Socio process issues each, and a
     * refusal is retried at the next call. Returns how many were given one.
     */
    async migrateIdentities() {
        const runtime = this.options.runtime;
        if (!runtime || !this.options.settings) {
            return 0;
        }
        let given = 0;
        for (const listed of this.readInstalled()) {
            if (listed.mode !== 'service' || !listed.enabled || this.identities.current(listed.id) !== undefined) {
                continue;
            }
            const row = (await this.relocate(listed.id)) ? (this.current(listed.id) ?? listed) : listed;
            const identity = await this.identities.issue(row.id, { onlyIfMissing: true });
            if (!identity) {
                continue;
            }
            try {
                await this.provisionCall(
                    runtime,
                    row.id,
                    this.specFor(row.manifest, row.config, row.replicas),
                    identity,
                );
                given++;
                this.options.log?.(`Plugins: ${row.id} has its own identity now (Socio Secrets).`);
            } catch {
                await this.identities.abandon(row.id, identity.version).catch(() => undefined);
                this.options.log?.(`Plugins: giving ${row.id} its identity failed; trying again later.`);
            }
        }
        return given;
    }

    async install(
        id: string,
        given: Record<string, string> = {},
        options: { bindings?: PluginBindingChoices; by?: string; acknowledged?: readonly string[] } = {},
    ) {
        const config = storedPluginConfig(given);
        if (this.fresh(id)) {
            throw new PluginError('That plugin is already installed.', 409);
        }
        const manifest = this.catalog.get(id);
        if (!manifest) {
            throw new PluginError('That plugin is not in this instance’s catalog.', 404);
        }
        if (manifest.bridge?.openAnyHttps === true) {
            requireAcknowledged(options.acknowledged, `${manifest.name} ${manifest.version}`, 'This plugin asks for');
        }
        // Required settings are filled in on the plugin's page after install.
        this.checkConfig(manifest, config, 'install');
        // Bundled: no service, no runtime, no apps host. It runs in this process.
        const bundled = pluginMode(manifest) === 'bundled';
        if (bundled && !bundledPlugins[id]) {
            throw new PluginError('Only a plugin this build ships runs inside Socio.');
        }
        const runtime = bundled ? undefined : this.requireRuntime();
        const spec = bundled ? undefined : this.specFor(manifest, config, manifest.service?.replicas ?? 1);
        // Its datasets first: bound (CB-451) before it runs, as the admin chose.
        this.ensureDatasets(id, manifest, options.bindings, options.by);
        try {
            if (runtime && spec) {
                await this.provision(runtime, id, spec);
            }
        } catch (error) {
            // Not installed: its bindings end, the datasets stay for the next try.
            this.unbindDatasets(id, options.by ?? 'system');
            throw error;
        }
        const now = Date.now();
        try {
            await this.repo.insert({
                id,
                version: manifest.version,
                enabled: true,
                display: manifest.display,
                config,
                permissions: manifest.permissions,
                manifest,
                replicas: spec?.replicas ?? 1,
                audience: manifest.audience ?? 'admins',
                installedAt: now,
                updatedAt: now,
            });
            migrateBundledPlugin(this.db, id);
            this.options.sync?.();
            this.refresh();
        } catch (error) {
            await runtime?.removeService(id).catch(() => {});
            await this.identities.revoke(id).catch(() => {});
            this.unbindDatasets(id, options.by ?? 'system');
            throw error;
        }
        this.datasetsAdopted(id, manifest);
        await this.releaseNotes.record(id, manifest, undefined);
        this.options.log?.(`Plugins: installed ${id}.`);
        return this.get(id)!;
    }

    async uninstall(id: string, by = 'system') {
        const row = this.fresh(id);
        if (!row) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        // Settings waiting to apply have no service to go to; one applying
        // now finishes first, so it can't provision the service again after it.
        const applying = this.applies.get(id);
        clearTimeout(applying?.timer);
        this.applies.delete(id);
        await applying?.running?.catch(() => undefined);
        if (row.mode === 'service' && this.options.runtime) {
            await this.options.runtime.removeService(id);
        }
        await this.repo.delete(id);
        // Its identity ends with it (the runtime removed the delivered secrets),
        // and so do its data tokens and bindings (CB-451); its datasets stay,
        // the workspace's, bindable to another plugin or to it again.
        await this.identities.revoke(id);
        this.revokeDataTokens(id);
        this.unbindDatasets(id, by);
        this.refresh();
        await this.releaseNotes.forget(id);
        this.closeSockets(id);
        await this.endGrants(id, by);
        this.options.log?.(`Plugins: uninstalled ${id}. Its data was kept.`);
    }

    /**
     * Socios' grants for a plugin that is gone or off end now, with their
     * open streams (CB-232): every runtime's 5-s re-check would end
     * them anyway, as the policy no longer answers a version.
     */
    private async endGrants(id: string, by: string) {
        await this.actorAccess
            ?.ended(id, by, 'audience_unavailable')
            .catch(() => this.options.log?.(`Plugins: ending socios’ access to ${id} failed.`));
    }

    async setEnabled(id: string, enabled: boolean, by = 'system') {
        if (enabled) {
            await this.relocate(id);
        }
        const row = this.fresh(id);
        if (!row) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        if (row.mode === 'bundled') {
            await this.repo.update(id, { enabled, updatedAt: Date.now() });
            this.refresh();
            if (!enabled) {
                await this.releaseNotes.accessChanged(id);
                await this.endGrants(id, by);
            }
            return;
        }
        const runtime = this.requireRuntime();
        const replicas = enabled ? row.replicas || row.manifest.service?.replicas || 1 : 0;
        if (enabled) {
            this.ensureDatasets(id, row.manifest);
            await this.provision(runtime, id, this.specFor(row.manifest, row.config, replicas));
        } else {
            await runtime.scaleService(id, 0);
        }
        await this.repo.update(id, { enabled, updatedAt: Date.now() });
        this.refresh();
        if (enabled) {
            await this.settle(id);
        }
        if (!enabled) {
            await this.releaseNotes.accessChanged(id);
            this.revokeDataTokens(id);
            this.closeSockets(id);
            await this.endGrants(id, by);
        }
    }

    /**
     * The hosts a service plugin's service may reach, as its stored settings
     * give them (CB-441): the manifest's hostnames and each `fromConfig`
     * setting's host, with why a setting added none. What the next
     * provision sends, and what the running service has once the settings
     * apply.
     */
    egress(row: Pick<InstalledPlugin, 'manifest' | 'config'>) {
        return resolvePluginEgress(row.manifest.service?.egress, row.manifest.config, row.config);
    }

    async scale(id: string, replicas: number) {
        const row = this.fresh(id);
        if (!row) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        if (row.mode === 'bundled' || !row.manifest.service) {
            throw new PluginError('This plugin runs inside Socio; it has no replicas to scale.', 400);
        }
        if (!Number.isInteger(replicas) || replicas < 1 || replicas > 20) {
            throw new PluginError('Replicas must be from 1 to 20.', 400);
        }
        checkServiceSpec({ ...row.manifest.service, replicas }, { config: row.manifest.config ?? {} });
        const runtime = this.requireRuntime();
        await runtime.scaleService(id, replicas);
        await this.repo.update(id, { replicas, updatedAt: Date.now() });
        this.refresh();
    }

    /**
     * Saves a plugin's settings. They are stored at once, so a crash never
     * loses them and the plugins tick (or the next boot) provisions what is
     * stored. A service plugin's service gets them through `applySettings`
     * (CB-398 follow-up): `now` waits for it (and throws what it throws);
     * `later`, what the settings page sends as it saves, applies them once
     * `PLUGIN_SETTINGS_APPLY_DELAY_MS` passes with no further save, and
     * answers with that wait.
     */
    async configure(id: string, given: Record<string, string>, options: { apply?: 'now' | 'later' } = {}) {
        const config = storedPluginConfig(given);
        const row = this.fresh(id);
        if (!row) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        this.checkConfig(row.manifest, config, 'save', row.config);
        if (row.mode !== 'service') {
            // A bundled plugin runs the manifest this build ships, checked above.
            await this.repo.update(id, { config, updatedAt: Date.now() });
            this.refresh();
            return;
        }
        // What the service would be given is checked before it is stored.
        this.requireRuntime();
        this.specFor(row.manifest, config, row.replicas);
        // Only the settings the manifest in the row now declares (CB-370).
        const saved = await savePluginConfig(this.db, id, config, Date.now());
        this.refresh();
        if (!saved) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        if (options.apply === 'later') {
            // The hosts these settings give, for the plugin's page, when a
            // setting decides one (CB-441).
            const fromConfig = (row.manifest.service?.egress ?? []).some((entry) => typeof entry !== 'string');
            const egress = fromConfig ? { egress: this.egress({ manifest: row.manifest, config }) } : {};
            if (!row.enabled) {
                // Enabling provisions what is stored.
                return { ok: true, ...egress };
            }
            this.applyState(id).dirty = true;
            const applyInMs = this.scheduleApply(id);
            return { ok: true, applyInMs, ...egress };
        }
        this.applyState(id).dirty = true;
        await this.applySettings(id);
    }

    private applyState(id: string) {
        let state = this.applies.get(id);
        if (!state) {
            state = { again: false, dirty: false };
            this.applies.set(id, state);
        }
        return state;
    }

    /** Applies a plugin's stored settings once the wait passes with no further save; returns the wait. */
    private scheduleApply(id: string) {
        const state = this.applyState(id);
        clearTimeout(state.timer);
        const delay = this.options.applyDelayMs ?? PLUGIN_SETTINGS_APPLY_DELAY_MS;
        state.timer = setTimeout(() => {
            state.timer = undefined;
            this.applySettings(id).catch(() =>
                this.options.log?.(`Plugins: applying ${id}'s settings failed; the plugins tick tries again.`),
            );
        }, delay);
        state.timer.unref?.();
        return delay;
    }

    /**
     * Gives a service plugin's service its stored settings now (CB-398
     * follow-up): what the wait after a save does, leaving the settings page
     * and **Apply now**. One apply runs at a time per plugin; a call while one
     * runs waits for it and one more after it, which picks up every save
     * made meanwhile. An apply provisions the service only when it doesn't
     * run what is stored, so a second call for the same saves restarts
     * nothing. Resolves once the service was given them.
     */
    async applySettings(id: string): Promise<void> {
        const state = this.applyState(id);
        clearTimeout(state.timer);
        state.timer = undefined;
        if (state.running) {
            state.again = true;
            return state.running;
        }
        const run = async () => {
            let failure: { error: unknown } | undefined;
            do {
                state.again = false;
                failure = undefined;
                try {
                    await this.applyStored(id, state);
                } catch (error) {
                    failure = { error };
                }
            } while (state.again);
            if (failure) {
                throw failure.error;
            }
        };
        const running = run().finally(() => {
            state.running = undefined;
            if (!state.timer && !state.dirty && this.applies.get(id) === state) {
                this.applies.delete(id);
            }
        });
        state.running = running;
        return running;
    }

    private async applyStored(id: string, state: { dirty: boolean; again: boolean; timer?: unknown }) {
        // A save made meanwhile has its own wait (or the next round of this
        // apply): checking the service against the install now would apply it
        // early, so that check is left to it.
        const settle = async () => {
            if (!state.timer && !state.again) {
                await this.settle(id);
            }
        };
        const dirty = state.dirty;
        state.dirty = false;
        try {
            const relocated = await this.relocate(id);
            const row = this.fresh(id);
            if (!row) {
                throw new PluginError('That plugin is not installed.', 404);
            }
            if (row.mode !== 'service') {
                return;
            }
            if (!row.enabled) {
                // A disabled service is provisioned from what is stored when it
                // is enabled; it is only kept at 0 replicas.
                await settle();
                return;
            }
            const runtime = this.options.runtime ?? this.requireRuntime();
            const status = await runtime.serviceStatus(id);
            const identity = this.identities.current(id);
            const runsStored =
                status !== undefined &&
                status.revision === row.revision &&
                (status.identity === undefined || identity === undefined || status.identity === identity);
            // A service without a revision label (an older runtime) can't
            // say what it runs: a save since the last apply provisions it.
            const unknown = status === undefined || status.revision === undefined;
            if (!relocated && (runsStored || (unknown && !dirty))) {
                // Only the replica count may need fixing.
                await settle();
                return;
            }
            await this.provision(runtime, id, this.specFor(row.manifest, row.config, row.replicas));
            await settle();
        } catch (error) {
            // Not applied: the next apply tries again.
            state.dirty ||= dirty;
            throw error;
        }
    }

    /**
     * After a change provisioned the service, the install as the database has
     * it and the service as the runtime has it decide (CB-370): when another
     * runtime's update, settings or disable landed meanwhile, in either order,
     * the service is provisioned again from the database (or scaled to 0), so
     * it never stays on a stale manifest. Until then public webhook paths fail
     * closed, as the service's revision label isn't the installed one. A few
     * rounds here; the ten-minute tick (`reconcileAll`) catches what is left.
     */
    /** `reconcile`, its failure logged and left to the tick: a change already recorded stays recorded. */
    private async settle(id: string) {
        try {
            await this.reconcile(id);
        } catch (error) {
            this.options.log?.(
                `Plugins: checking ${id}'s service against its install failed (${failure(error)}); the plugins tick tries again.`,
            );
        }
    }

    private async reconcile(id: string) {
        const runtime = this.options.runtime;
        for (let round = 0; runtime && round < 3; round++) {
            const relocated = await this.relocate(id);
            const row = this.fresh(id);
            if (!row || row.mode !== 'service') {
                return;
            }
            const status = await runtime.serviceStatus(id);
            if (!status) {
                return;
            }
            if (!row.enabled) {
                if (status.replicas > 0) {
                    await runtime.scaleService(id, 0);
                }
                return;
            }
            // No label: a service provisioned before install revisions (its next
            // change labels it; no restart nobody asked for), or an older
            // runtime that doesn't keep one, which provisioning again can't fix.
            // Public webhooks wait for a label either way. A new registry login or
            // a moved image (`relocate`) still reaches it, below.
            // The same revision with an older identity: of two provisions, the
            // one with the older identity landed last, and the plugin would lose
            // its access to Socio once the older version retires.
            const identity = this.identities.current(id);
            const staleIdentity =
                status.revision === row.revision &&
                status.identity !== undefined &&
                identity !== undefined &&
                status.identity !== identity;
            // A registry login set, rotated or removed since the service was
            // written: Swarm pulls with the login the service was given, so
            // the service gets the current one (its `socio.registry` label).
            // A service without a revision label gets it too, once per login
            // here (a runtime that keeps no labels can't settle): it may be
            // one whose image can't be pulled without it.
            const fingerprint = this.registryGrant()?.fingerprint;
            const unlabeled = status.revision === undefined;
            // A service without a label that runs the installed digest at
            // another location: an install moved (`relocate`) whose provision
            // was refused or cut short by a restart. Once per installed image
            // here, as a runtime may run another location of its pin.
            const installedImage = row.manifest.service?.image;
            const strayImage =
                unlabeled &&
                installedImage !== undefined &&
                status.image !== installedImage &&
                imageDigest(installedImage) !== undefined &&
                imageDigest(status.image) === imageDigest(installedImage) &&
                this.unlabeledImage.get(id) !== installedImage;
            const staleRegistry =
                (status.revision === row.revision ||
                    (unlabeled && this.unlabeledRegistry.get(id) !== (fingerprint ?? ''))) &&
                status.registry !== fingerprint;
            if (
                !relocated &&
                !strayImage &&
                (status.revision === row.revision || unlabeled) &&
                !staleIdentity &&
                !staleRegistry
            ) {
                // Only the replica count may have drifted (a scale that a
                // slower provision then overwrote).
                const replicas = row.replicas || row.manifest.service?.replicas || 1;
                if (status.revision === row.revision && status.replicas !== replicas) {
                    await runtime.scaleService(id, replicas);
                }
                return;
            }
            this.options.log?.(
                staleRegistry && !relocated && !strayImage
                    ? `Plugins: ${id}'s service doesn't have the current registry login; provisioning it.`
                    : `Plugins: ${id}'s service doesn't run its installed revision; provisioning it.`,
            );
            await this.provision(
                runtime,
                id,
                this.specFor(row.manifest, row.config, row.replicas || row.manifest.service?.replicas || 1),
            );
            if (unlabeled) {
                this.unlabeledRegistry.set(id, fingerprint ?? '');
                if (installedImage !== undefined) {
                    this.unlabeledImage.set(id, installedImage);
                }
            }
        }
    }

    /**
     * Every installed service plugin's service checked against its install
     * (CB-370), on the plugins tick: what a crash between a provision and its
     * record, or a race `reconcile` couldn't settle, left behind. A service
     * provisioned before install revisions existed has none and is left as
     * it is: its next change (an update, settings, enable) labels it.
     */
    async reconcileAll() {
        if (!this.options.runtime) {
            return;
        }
        for (const row of this.list()) {
            if (row.mode === 'service') {
                // Through the plugin's apply queue (CB-398 follow-up), so it never
                // provisions beside an apply in flight; settings still in their
                // wait apply when it ends.
                if (this.applies.get(row.id)?.timer) {
                    continue;
                }
                await this.applySettings(row.id).catch((error) =>
                    this.options.log?.(
                        `Plugins: checking ${row.id}'s service against its install failed (${failure(error)}); trying again later.`,
                    ),
                );
            }
        }
        this.reconciledAt = Date.now();
        await this.repairNetworks();
    }

    /**
     * Whether the plugins tick (every minute) runs the full check
     * (`migrateIdentities`, `reconcileAll`) now: every ten minutes. The
     * other minutes only re-attach networks (`repairNetworks`). A true
     * answer claims the slot, so a failed check waits its ten minutes too.
     */
    reconcileDue(now = Date.now()) {
        if (now - this.reconciledAt < RECONCILE_EVERY_MS) {
            return false;
        }
        this.reconciledAt = now;
        return true;
    }

    /**
     * Every enabled service plugin's network joined again to the apps
     * ingress and the app, and to the egress proxy when the plugin declares
     * egress. A stack update (an upgrade) rewrites those services' networks
     * from the stack file, which doesn't know the plugins: without this,
     * the ingress can't reach a plugin and a plugin can't reach Socio or
     * the egress proxy until its next provision. The runtime changes only
     * a service that lost an attachment, so this is cheap to repeat: at
     * start, on every tick and after every full reconcile.
     */
    async repairNetworks() {
        const runtime = this.options.runtime;
        if (!runtime?.repairServiceNetworks) {
            return;
        }
        for (const row of this.list()) {
            // An apply in flight attaches them itself; an infra update beside
            // its own would only race it for the service's version. Settings
            // saved and not yet applied are left to their apply too (CB-441):
            // the egress they give isn't what the running service uses, so a
            // repair from them could take the egress proxy away from it early.
            const apply = this.applies.get(row.id);
            if (row.mode !== 'service' || !row.enabled || apply?.running || apply?.timer || apply?.dirty) {
                continue;
            }
            const egress = this.egress(row).hosts.length > 0;
            await runtime
                .repairServiceNetworks(row.id, egress)
                .catch(() =>
                    this.options.log?.(`Plugins: re-attaching ${row.id}'s network failed; trying again in a minute.`),
                );
        }
    }

    /**
     * Who may use an installed plugin (CB-254). Narrowing it to admins ends
     * members' sign-ins to a service plugin at their next request (the
     * session check reads the audience) and drops its tools from their
     * agents and socios at their next call.
     */
    async setAudience(id: string, audience: PluginAudience, by = 'system') {
        const row = this.fresh(id);
        if (!row) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        if (audience !== 'admins' && audience !== 'members') {
            throw new PluginError('Audience is admins or members.', 400);
        }
        await this.repo.update(id, { audience, updatedAt: Date.now() });
        this.refresh();
        // Sockets of people now outside it close here; elsewhere within 5 s.
        const now = this.get(id);
        this.closeSockets(id, (userId) => !this.mayUse(now, this.activeUser(userId)));
        // CB-527: people now outside it forget what they saw of its notes.
        await this.releaseNotes.accessChanged(id);
        // The same audience is the `plugin:<id>` policy's `personMay`
        // (CB-232): socios' grants for people now outside it end at once.
        await this.actorAccess
            ?.recheck(id, by)
            .catch(() => this.options.log?.(`Plugins: re-checking socios’ access to ${id} failed.`));
        this.options.log?.(`Plugins: ${id} is for ${audience} now.`);
    }

    /**
     * The settings against the manifest's `config` (CB-395): known keys and
     * short strings always; on a save and an install, each value fits its
     * field's type; on a save, every required setting without a default is
     * set. The message is the one the settings form shows for the field.
     *
     * A save checks what it changes (CB-398): settings save as an admin
     * changes them, one or a few at a time, so a value kept as `saved` has it
     * (one a newer version typed differently, until an admin fixes it), and a
     * required setting that wasn't set yet may stay unset while others save.
     * Clearing a required setting, or a new value that doesn't fit, is refused.
     */
    private checkConfig(
        manifest: PluginManifest,
        config: Record<string, string>,
        mode: 'save' | 'install' | 'adopt',
        saved: Record<string, string> = {},
    ) {
        const fields = manifest.config ?? {};
        const kept = (key: string, value: string) => Object.hasOwn(saved, key) && saved[key] === value;
        for (const [key, value] of Object.entries(config)) {
            const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
            if (!field) {
                throw new PluginError(`Unknown setting ${key}.`, 400);
            }
            if (typeof value !== 'string' || value.length > PLUGIN_CONFIG_VALUE_MAX) {
                throw new PluginError(`${key} must be a short string.`, 400);
            }
            const problem =
                mode === 'adopt' || (mode === 'save' && kept(key, value))
                    ? undefined
                    : configValueError({ ...field, required: false }, value);
            if (problem) {
                throw new PluginError(`${key}: ${problem}`, 400);
            }
        }
        if (mode !== 'save') {
            return;
        }
        for (const [key, field] of Object.entries(fields)) {
            const unset = (Object.hasOwn(config, key) ? config[key] : '') === '';
            const wasSet = Object.hasOwn(saved, key) && saved[key] !== '';
            if (unset && wasSet) {
                const problem = configValueError(field, '');
                if (problem) {
                    throw new PluginError(`${key}: ${problem}`, 400);
                }
            }
        }
    }

    async status(id: string): Promise<RuntimeServiceStatus | undefined> {
        const row = this.get(id);
        if (row?.mode === 'bundled') {
            return {
                id,
                service: 'socio',
                image: 'bundled',
                replicas: 1,
                running: row.enabled ? 1 : 0,
                state: row.enabled ? 'running' : 'stopped',
            };
        }
        return this.options.runtime?.serviceStatus(id);
    }

    /**
     * Who a plugin service's call back into its data routes acts as
     * (CB-232). With `x-cb-obo`: the person the request it serves was for
     * (their plugin session, or a socio's grant at the call's tier), never
     * wider; a token that doesn't open, or whose session or grant ended, is
     * refused. Without it, the service's own background work: an operator,
     * else the first admin, as before; a plugin that declares the socio
     * contract may only read that way.
     */
    async serviceCaller(id: string, obo: string | undefined, method: string) {
        const row = this.get(id)!;
        const actors = this.actorAccess;
        if (obo) {
            if (!actors) {
                return {
                    ok: false as const,
                    status: 403 as const,
                    error: 'This access was revoked.',
                };
            }
            return actors.caller(row, obo, method, (hash) => this.sessionByHash(id, hash));
        }
        if (actors?.backgroundRefused(row, method)) {
            return {
                ok: false as const,
                status: 403 as const,
                error: 'A change for a person needs their x-cb-obo.',
            };
        }
        try {
            return { ok: true as const, user: this.serviceUser() };
        } catch (error) {
            return {
                ok: false as const,
                status: 503 as const,
                error: error instanceof Error ? error.message : 'No admin is available.',
            };
        }
    }

    /** An admin the plugin's service calls act as: the earliest active admin. */
    serviceUser() {
        const found = this.options.users().find((user) => isAdmin(user));
        if (!found) {
            throw new PluginError('No admin is available for plugin services.', 503);
        }
        return found;
    }

    /**
     * The plugin service's bearer plus the proof of its own id. The bearer
     * is its own identity token, which names exactly one plugin; or, for one
     * release, the deprecated shared `PLUGIN_SERVICE_TOKEN`, which only the
     * proof binds to a plugin.
     */
    acceptsServiceCall(id: string, token: string | undefined, proof: string | undefined) {
        const secret = this.options.runtimeToken;
        if (!secret || !token || !proof) {
            return false;
        }
        const row = this.get(id);
        // A bundled plugin has no service to call back.
        if (!row?.enabled || row.mode !== 'service' || !same(proof, pluginProof(secret, id))) {
            return false;
        }
        const identity = this.identities.verify(token);
        if (identity) {
            return identity.pluginId === id;
        }
        const shared = this.options.serviceToken;
        if (!shared || !same(token, shared)) {
            return false;
        }
        if (!this.sharedTokenWarned.has(id)) {
            this.sharedTokenWarned.add(id);
            this.options.log?.(
                `Plugins: ${id} called with PLUGIN_SERVICE_TOKEN, which is deprecated: it reads its own identity (SOCIO_IDENTITY_FILE) after its next provision. The shared token is accepted for one more release.`,
            );
        }
        return true;
    }

    /**
     * The plugin a workload call is from (Socio Secrets reads): its own
     * identity token and its proof, for an installed, enabled service plugin.
     * The shared token is never enough here: secrets are per plugin.
     */
    workloadPlugin(token: string | undefined, proof: string | undefined) {
        return this.workloadIdentity(token, proof)?.pluginId;
    }
    /** The same, with the identity version the token is (to note a stale one). */
    workloadIdentity(token: string | undefined, proof: string | undefined) {
        const secret = this.options.runtimeToken;
        const identity = this.identities.verify(token);
        if (!secret || !identity || !proof || !same(proof, pluginProof(secret, identity.pluginId))) {
            return undefined;
        }
        const row = this.get(identity.pluginId);
        return row?.enabled && row.mode === 'service' ? identity : undefined;
    }
    /**
     * A refused workload call that carries a plugin's own identity, no longer
     * accepted (retired, or past its window), with the plugin's valid proof:
     * an old task still running, or a copied token. It is audited as a
     * stale identity's use. Anything else: undefined.
     */
    staleIdentity(token: string | undefined, proof: string | undefined) {
        const secret = this.options.runtimeToken;
        const found = this.identities.lookup(token);
        if (!secret || !found || !proof || !same(proof, pluginProof(secret, found.pluginId))) {
            return undefined;
        }
        if (this.identities.verify(token)) {
            return undefined;
        }
        const row = this.get(found.pluginId);
        if (row?.mode !== 'service') {
            return undefined;
        }
        return { pluginId: found.pluginId, version: found.version };
    }
    /** A plugin's current identity version and when it was issued. */
    identityIssue(pluginId: string) {
        return this.identities.currentIssue(pluginId);
    }

    async launch(id: string, userId: string, next = '/') {
        const settings = this.options.settings;
        const row = this.get(id);
        if (row?.enabled && row.mode === 'bundled') {
            throw new PluginError('This plugin opens inside Socio; it has no launch link.', 400);
        }
        if (!settings || !row?.enabled) {
            throw new PluginError('That plugin is not installed.', 404);
        }
        if (!this.mayUse(row, this.activeUser(userId))) {
            throw new PluginError('You can’t open this plugin.', 403);
        }
        const code = randomBytes(24).toString('base64url');
        const now = Date.now();
        await this.repo.putCode({
            hash: pluginHash(code),
            pluginId: id,
            userId,
            next: safeNext(next),
            createdAt: now,
            expiresAt: now + Math.min(settings.codeTtlMs, 60_000),
        });
        const origin = appOrigin(settings, id);
        return `${origin}/__cb/auth?code=${encodeURIComponent(code)}`;
    }

    async redeem(id: string, code: string | undefined) {
        const settings = this.options.settings;
        if (!settings || !code) {
            return undefined;
        }
        const value = randomBytes(32).toString('base64url');
        const now = Date.now();
        const redeemed = await this.repo.redeemSession({
            codeHash: pluginHash(code),
            pluginId: id,
            now,
            accept: (row) => this.get(id)?.mode === 'service' && this.mayUse(this.get(id), this.activeUser(row.userId)),
            session: {
                hash: pluginHash(value),
                createdAt: now,
                expiresAt: now + settings.sessionTtlMs,
            },
        });
        if (!redeemed) {
            return undefined;
        }
        return {
            value,
            next: redeemed.next,
            maxAgeSeconds: settings.sessionTtlMs / 1000,
        };
    }

    async session(id: string, value: string | undefined) {
        if (!value) {
            return undefined;
        }
        const found = await this.repo.sessionState(pluginHash(value));
        if (
            !found ||
            found.row.pluginId !== id ||
            found.row.expiresAt <= Date.now() ||
            found.row.generation !== found.generation
        ) {
            return undefined;
        }
        const plugin = this.get(id);
        if (!plugin?.enabled || plugin.mode !== 'service') {
            return undefined;
        }
        // Listed by the auth provider (deactivated people are omitted) and
        // still in the audience: a demotion, or narrowing the audience to
        // admins, fails this on the next request.
        if (!this.mayUse(plugin, this.activeUser(found.row.userId))) {
            return undefined;
        }
        return { plugin, userId: found.row.userId, sessionHash: pluginHash(value) };
    }

    /**
     * A live plugin session by its hash, for that plugin: what a person's
     * `cbob_` names (CB-232). The same checks as `session`.
     */
    async sessionByHash(id: string, hash: string) {
        const found = await this.repo.sessionState(hash);
        if (
            !found ||
            found.row.pluginId !== id ||
            found.row.expiresAt <= Date.now() ||
            found.row.generation !== found.generation
        ) {
            return undefined;
        }
        const plugin = this.get(id);
        if (!plugin?.enabled || plugin.mode !== 'service') {
            return undefined;
        }
        if (!this.mayUse(plugin, this.activeUser(found.row.userId))) {
            return undefined;
        }
        return { userId: found.row.userId };
    }

    /**
     * Ends plugin sessions and unused launch codes for one person
     * (deactivation and demotion). Returns how many rows ended.
     */
    endAccessOf(userId: string) {
        for (const id of [...this.sockets.keys()]) {
            this.closeSockets(id, (owner) => owner === userId);
        }
        return deletePluginAccessOf(this.db, userId);
    }

    /** How many rows `endAccessOf` would end now (a deactivation preview). */
    accessCountOf(userId: string) {
        return countPluginAccessOf(this.db, userId);
    }

    /** An open WebSocket to a service plugin, for `userId` (CB-239). */
    track(id: string, userId: string, socket: { destroy: () => void }) {
        const set = this.sockets.get(id) ?? new Set();
        const entry = { userId, destroy: () => socket.destroy() };
        set.add(entry);
        this.sockets.set(id, set);
        return () => {
            set.delete(entry);
            if (!set.size && this.sockets.get(id) === set) {
                this.sockets.delete(id);
            }
        };
    }

    /** Closes a plugin's open sockets (those `which` picks; all by default). */
    closeSockets(id: string, which: (userId: string) => boolean = () => true) {
        const set = this.sockets.get(id);
        if (!set) {
            return;
        }
        for (const entry of [...set]) {
            if (which(entry.userId)) {
                set.delete(entry);
                entry.destroy();
            }
        }
        if (!set.size) {
            this.sockets.delete(id);
        }
    }

    /** How many sockets this runtime holds open to a plugin (tests). */
    socketCount(id: string) {
        return this.sockets.get(id)?.size ?? 0;
    }

    async endSession(value: string | undefined) {
        if (value) {
            await this.repo.deleteSession(pluginHash(value));
        }
    }

    personId(id: string, userId: string) {
        const secret = this.options.runtimeToken || 'plugin-person';
        return createHmac('sha256', secret)
            .update(`company-brain-plugin-user\u0000${id}\u0000${personSeedOf(this.db, userId)}`)
            .digest('base64url')
            .slice(0, 22);
    }

    /**
     * Headers about the person for a service plugin's request (CB-254):
     * their time zone always, and when the install granted `person:read`,
     * who they are, signed with the plugin's proof (`person.ts`). While
     * `socio-actor-access` is on for them (CB-232), also the actor
     * envelope (`x-cb-actor`, `aud: plugin:<id>`) with an on-behalf-of token
     * bound to their plugin session, for `request` only.
     */
    async personHeaders(id: string, userId: string, request?: { method: string; target: string; sessionHash: string }) {
        const row = this.get(id);
        const person = this.activeUser(userId);
        const headers: Record<string, string> = {};
        if (!row || !person) {
            return headers;
        }
        const timeZone = await this.timeZoneOf(userId);
        headers[PLUGIN_TIME_ZONE_HEADER] = timeZone;
        const actors = this.actorAccess;
        if (request && actors?.featureOn(userId)) {
            const envelope = actors.envelope(row, {
                personId: userId,
                sessionRef: request.sessionHash,
                obo: actors.mintObo(
                    id,
                    { sessionHash: request.sessionHash },
                    randomBytes(16).toString('base64url'),
                    this.options.settings?.timeoutMs ?? 60_000,
                ),
                method: request.method,
                target: request.target,
            });
            if (envelope) {
                headers[ACTOR_ENVELOPE_HEADER] = envelope;
            }
        }
        const secret = this.options.runtimeToken;
        if (secret && row.permissions.includes(PLUGIN_PERSON_PERMISSION)) {
            headers[PLUGIN_PERSON_HEADER] = signPluginPerson(pluginProof(secret, id), {
                // Stable: for a renamed person, the id they had first (CB-338).
                id: personSeedOf(this.db, person.id),
                name: person.name,
                role: person.role,
                timeZone,
                plugin: id,
            });
        }
        return headers;
    }

    /**
     * Where the apps proxy sends this plugin: the runtime ingress, which
     * round-robins replicas. The proxy does not pin a person to a task.
     */
    async target(id: string) {
        const ingress = this.options.ingress;
        const runtime = this.options.runtime;
        if (!ingress || !runtime || !this.options.runtimeToken) {
            return { state: 'not_configured' as const };
        }
        const status = await runtime.serviceStatus(id);
        if (!status || status.replicas === 0) {
            return { state: 'stopped' as const };
        }
        if (status.running < 1) {
            return { state: 'unavailable' as const };
        }
        const secret = this.options.runtimeToken;
        return {
            state: 'running' as const,
            host: ingress.host,
            port: ingress.port,
            headers: {
                'x-cb-runtime-app': id,
                'x-cb-runtime-key': ingressKey(secret),
            },
            /**
             * The ingress signature over every identity header the proxy adds
             * (CB-232): the ingress passes a plugin no `x-cb-*` header
             * it doesn't cover.
             */
            sign: (method: string, target: string, headers: Record<string, string>) => ({
                [RUNTIME_HEADER_SIG]: identitySignature(secret, id, method, target, headers),
            }),
        };
    }

    /**
     * One call from Socio itself to a service plugin (CB-458):
     * the ingress's key, a host envelope for exactly this method and
     * `/__cb/` request-target, the ingress signature over it, and, with
     * `task` (one of `hostTasks`), the pin that sends it to that task alone
     * or answers 502. Never the apps proxy's: a person's request gets
     * `target` and a person's envelope. Throws for a target off `/__cb/`.
     */
    async hostTarget(id: string, request: { method: string; target: string; task?: string }) {
        const secret = this.options.runtimeToken;
        const target = await this.target(id);
        if (target.state !== 'running' || !secret) {
            return target.state === 'running' ? { state: 'not_configured' as const } : target;
        }
        const headers: Record<string, string> = {
            ...target.headers,
            [ACTOR_ENVELOPE_HEADER]: signHostEnvelope(secret, id, request),
        };
        if (request.task !== undefined) {
            headers[RUNTIME_HEADER_TASK] = request.task;
        }
        Object.assign(
            headers,
            target.sign(request.method, request.target, { [ACTOR_ENVELOPE_HEADER]: headers[ACTOR_ENVELOPE_HEADER] }),
        );
        return {
            state: 'running' as const,
            host: target.host,
            port: target.port,
            headers,
        };
    }

    /** The plugin's running tasks (CB-458), to pin a snapshot's requests to one. */
    async hostTasks(id: string) {
        const status = await this.options.runtime?.serviceStatus(id);
        return status?.tasks ?? [];
    }

    /**
     * The install permissions a connected agent's grant lets it use: each
     * needs the plugin's own scope (`plugins:<id>:read|write`), or the legacy
     * `plugins:read|write` for a plugin those cover (`LEGACY_SCOPE_PLUGINS`:
     * the planner only, never a plugin added since).
     */
    private grantedPermissions(row: InstalledPlugin, scopes: readonly string[]) {
        return row.permissions.filter((permission) =>
            pluginToolScopes(row.id, permission).some((scope) => scopes.includes(scope)),
        );
    }

    /**
     * Registers installed plugins' tools for a connected agent: only for a
     * person in the plugin's audience, only tools whose permission the
     * install granted, and only those the connection's OAuth scopes allow.
     */
    contributeMcp(
        server: McpServer,
        ctx: {
            person: User;
            origin: string;
            scopes: readonly string[];
            /** "Claude Code for Ana": recorded as how a change was made. */
            via?: string;
        },
        taken: ReadonlySet<string> = new Set(),
    ) {
        for (const row of this.installs()) {
            if (!this.mayUse(row, ctx.person)) {
                continue;
            }
            const permissions = this.grantedPermissions(row, ctx.scopes);
            const bundled = bundledPlugins[row.id];
            bundled?.contributeMcp?.(server, {
                person: ctx.person,
                origin: ctx.origin,
                db: this.db,
                permissions,
            });
            for (const tool of bundled?.tools ?? []) {
                if (!permissions.includes(tool.permission) || taken.has(tool.name)) {
                    continue;
                }
                const call: PluginToolCall = {
                    person: ctx.person,
                    via: ctx.via ?? '',
                    permissions,
                };
                server.registerTool(
                    tool.name,
                    {
                        description: tool.description,
                        inputSchema: tool.input,
                        annotations: tool.annotations,
                    },
                    (async (args: Record<string, unknown>) => {
                        try {
                            const value = await this.runTool(row.id, tool, args, call);
                            return {
                                content: [{ type: 'text' as const, text: JSON.stringify(value) }],
                                structuredContent: value,
                            };
                        } catch (error) {
                            return {
                                isError: true,
                                content: [{ type: 'text' as const, text: toolMessage(error) }],
                            };
                        }
                    }) as never,
                );
            }
        }
    }

    /**
     * Runs one tool after checking again that the plugin is still installed
     * and enabled, the person still in its audience, and the tool's
     * permission still the caller's: a grant or a turn outlives an
     * uninstall or an audience change. A socio's call, while
     * `socio-actor-access` is on for its person, also needs a live grant
     * for `plugin:<id>` from this conversation that covers the tool's tier
     * (CB-232): the same `authorizeActor` an app's socio session goes
     * through, with the person's own audience as one of its terms.
     */
    private async runTool(id: string, tool: PluginToolDefinition, args: Record<string, unknown>, call: PluginToolCall) {
        const row = this.get(id);
        const person = this.activeUser(call.person.id);
        if (!row || !this.mayUse(row, person)) {
            throw new PluginToolError('That plugin is not available to you.', 403);
        }
        if (!call.permissions.includes(tool.permission)) {
            throw new PluginToolError('That tool is not available to you.', 403);
        }
        let permissions = call.permissions;
        const actors = this.actorAccess;
        if (call.socio && actors?.featureOn(person!.id)) {
            const decision = await actors.toolUse(
                row,
                tool,
                {
                    id: call.socio.id,
                    personId: person!.id,
                    conversationId: call.socio.conversationId,
                },
                call.permissions,
            );
            if (!decision.ok) {
                throw new PluginToolError(decision.message, 403);
            }
            permissions = decision.permissions;
            if (!permissions.includes(tool.permission)) {
                throw new PluginToolError('That tool is not available to you.', 403);
            }
        }
        return tool.run(args, { ...call, person: person!, permissions }, this.context(id));
    }

    /**
     * Tools installed plugins give an in-app socio's turn (CB-254), acting
     * for the turn's person: only plugins in their audience, every
     * permission the install granted (the person's own socio needs no OAuth
     * consent; the plugin applies the person's own permissions).
     */
    dotTools(turn: DotTurn, taken: ReadonlySet<string> = new Set()) {
        const person = this.activeUser(turn.userId);
        if (!person) {
            return [];
        }
        // Which conversation a socio's grant must come from (CB-232): a
        // scheduled run's is its schedule.
        const conversationId = turn.cause?.kind === 'schedule' ? `schedule:${turn.cause.id}` : turn.threadId;
        const tools: ToolDefinition[] = [];
        for (const row of this.installs()) {
            if (!this.mayUse(row, person)) {
                continue;
            }
            for (const tool of bundledPlugins[row.id]?.tools ?? []) {
                if (!row.permissions.includes(tool.permission) || taken.has(tool.name)) {
                    continue;
                }
                const call: PluginToolCall = {
                    person,
                    via: turn.dot.name,
                    permissions: row.permissions,
                    socio: { id: turn.dot.id, conversationId },
                };
                tools.push(
                    defineTool({
                        name: tool.name,
                        description: `${tool.description} (${row.manifest.name} plugin.)`,
                        parameters: z.object(tool.input),
                        execute: async (args: Record<string, unknown>) => {
                            turn.check();
                            try {
                                return await this.runTool(row.id, tool, args, call);
                            } catch (error) {
                                return toolError({
                                    message: toolMessage(error),
                                    status: error instanceof PluginToolError ? error.status : 400,
                                });
                            }
                        },
                    }),
                );
            }
        }
        return tools;
    }

    /**
     * Tool name → the connected-agent scopes a call needs (any one of them),
     * for the tools installed and enabled plugins declare. `/mcp` refuses a
     * call outside the connection's scopes before any tool runs.
     */
    toolScopes(): Map<string, string[]> {
        const scopes = new Map<string, string[]>();
        for (const row of this.installs()) {
            if (!row.enabled) {
                continue;
            }
            for (const tool of row.manifest.mcp?.tools ?? []) {
                scopes.set(tool.name, pluginToolScopes(row.id, tool.scope));
            }
        }
        return scopes;
    }

    /**
     * Every per-plugin scope this instance may grant: one read and one write
     * scope for each plugin with tools in the catalog or among the former
     * default offers (`scopedManifests`).
     * Fixed at boot, like the catalog, so the authorization server can list
     * them.
     */
    oauthScopes() {
        const scopes = new Set<string>();
        for (const manifest of scopedManifests(this.catalog)) {
            for (const tool of manifest.mcp?.tools ?? []) {
                scopes.add(pluginScope(manifest.id, tool.scope));
            }
        }
        return [...scopes].sort();
    }

    /** Plain words for per-plugin scopes, named after their plugin. */
    scopeLabels(scopes: readonly string[]) {
        const labels: Record<string, string> = {};
        for (const scope of scopes) {
            const parsed = parsePluginScope(scope);
            if (!parsed) {
                continue;
            }
            const name =
                this.catalog.get(parsed.id)?.name ??
                this.get(parsed.id)?.manifest.name ??
                bundledPlugins[parsed.id]?.manifest.name ??
                parsed.id;
            labels[scope] = pluginScopeLabel(name, parsed.access);
        }
        return labels;
    }

    /** The data routes of an installed, enabled bundled plugin. */
    dataApp(id: string) {
        const row = this.get(id);
        if (!row?.enabled) {
            return undefined;
        }
        return bundledPlugins[id]?.data?.(this.context(id));
    }

    /**
     * A bundled plugin's token-authenticated feed (a calendar subscription):
     * no session, so the plugin checks the token and its person.
     */
    async feed(id: string, token: string) {
        const row = this.get(id);
        const feed = bundledPlugins[id]?.feed;
        if (!row?.enabled || !feed) {
            return undefined;
        }
        return feed(this.context(id), token);
    }
}

/** Why a plugin step failed, for the log: the error's own message (a runtime's refusal, say), redacted, then cut short. */
function failure(error: unknown) {
    return error instanceof Error && error.message ? redactAppLog(error.message).slice(0, 300) : 'unknown error';
}

/** The `sha256:…` digest an image ref pins, if it pins one. */
function imageDigest(image: string) {
    return /@(sha256:[a-f0-9]{64})$/.exec(image.trim())?.[1];
}

function toolMessage(error: unknown) {
    return error instanceof Error ? error.message : 'Could not do that.';
}

function same(supplied: string, expected: string) {
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Settings as they are stored (CB-395), as the settings form sends them:
 * each value trimmed, and an empty one left out, so the plugin uses its
 * default. A value that isn't a string is left for `checkConfig` to refuse.
 */
export function storedPluginConfig(config: Record<string, string>): Record<string, string> {
    const stored: Record<string, string> = {};
    for (const [key, value] of Object.entries(config ?? {})) {
        if (typeof value !== 'string') {
            stored[key] = value;
            continue;
        }
        const trimmed = value.trim();
        if (trimmed !== '') {
            stored[key] = trimmed;
        }
    }
    return stored;
}

/** How often the plugins tick runs the full reconcile (`reconcileAll`). */
const RECONCILE_EVERY_MS = 10 * 60_000;

/**
 * A registry login's fingerprint, the service's `socio.registry` label:
 * keyed with the apps runtime's token when there is one, so the label (which
 * anyone who can inspect the service reads) can't be used to guess the
 * password. 32 hex digits.
 */
function registryFingerprint(key: string, runtimeToken: string | undefined) {
    return createHmac('sha256', `socio-plugin-registry:${runtimeToken ?? ''}`)
        .update(key)
        .digest('hex')
        .slice(0, 32);
}
