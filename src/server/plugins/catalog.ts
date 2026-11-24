import { readFileSync } from 'node:fs';

import { COLUMN_TYPES } from '@socio/shared/data-types';
import { checkFieldSetting } from '@socio/shared/dataset-views/field-settings';
import {
    ANALYTICAL_COLUMN_TYPES,
    ANALYTICAL_DECIMAL,
    ANALYTICAL_RETAIN_DAYS_MAX,
} from '@socio/shared/dataspace/analytics';
import { pluginStorageWarnings } from '@socio/shared/plugins/plugin-backup';
import { pluginConfigFieldError, type PluginConfigField } from '@socio/shared/plugins/plugin-config';
import { parsePluginReleaseNotes } from '@socio/shared/plugins/plugin-release-notes';
import {
    PINNED_IMAGE,
    PLUGIN_ID,
    checkServiceSpec,
    statefulVolumes,
    type PluginServiceSpec,
} from '@socio/shared/plugins/plugin-service';
import {
    PLUGIN_AUDIENCES,
    PLUGIN_DATASET_MAX_TABLES,
    PLUGIN_DATASETS_MAX,
    PLUGIN_DATASET_NAME,
    PLUGIN_PERSON_PERMISSION,
    PLUGIN_TOOL_NAME,
    PLUGIN_WEBHOOKS_MAX,
    PLUGIN_WEBHOOK_BODY_MAX,
    PLUGIN_WEBHOOK_PER_MINUTE_MAX,
    bridgeOpenRule,
    pluginPermissionAccess,
    pluginScope,
    pluginScopeLabel,
    type PluginAudience,
    type PluginDataset,
    type PluginDatasetColumn,
    type PluginDatasetField,
    type PluginDatasetTable,
    type PluginDelegation,
    type PluginBridgeSpec,
    type PluginManifest,
    type PluginWebhook,
    pluginEntryPathname,
    pluginWebhookPath,
} from '@socio/shared/plugins/plugins';
import { SECRET_NAME, SECRET_NAME_HINT, type AppManifestSecret } from '@socio/shared/workspace-secrets';

import { bundledPlugins } from './bundled.js';
import type { CatalogRef } from './contract.js';

export type { CatalogRef };

/** Public host from the first `APP_ORIGIN`, otherwise `HOST`. */
export function catalogPublicHost(env: Record<string, string | undefined>) {
    const origin = env.APP_ORIGIN?.split(',')[0]?.trim();
    if (origin) {
        try {
            return new URL(origin).hostname.toLowerCase();
        } catch {
            /* HOST below. */
        }
    }
    return (env.HOST ?? '').trim().toLowerCase();
}

function hostList(raw: string | undefined) {
    const hosts = new Set<string>();
    for (const item of (raw ?? '').split(',')) {
        const host = item.trim().toLowerCase();
        if (host) {
            hosts.add(host);
        }
    }
    return hosts;
}

/**
 * Where this instance's catalog may be used, from the operator's settings:
 * `PLUGIN_CATALOG_HOSTS` lists the public hosts that may offer it (unset:
 * this instance's own host, so no extra restriction), and
 * `PLUGIN_CATALOG_DENY_HOSTS` hosts that never may. Pin
 * `PLUGIN_CATALOG_HOSTS` to the instance a catalog is meant for, and a
 * copy of that environment on another instance refuses to boot instead of
 * offering its plugins there. Socio names no instance itself.
 */
export function catalogHostPolicy(env: Record<string, string | undefined>) {
    const host = catalogPublicHost(env);
    const allowed = hostList(env.PLUGIN_CATALOG_HOSTS);
    return {
        host,
        /** Undefined: the default, this instance's own host, whatever it is. */
        allowed: allowed.size ? allowed : undefined,
        denied: hostList(env.PLUGIN_CATALOG_DENY_HOSTS),
    };
}

/**
 * `PLUGIN_CATALOGS` is everything this instance offers (CB-371): no
 * plugin is offered just because this build ships it. Unset, or `off`,
 * offers nothing. `bundled:<id>` is a plugin shipped in this build (the
 * calendar is `bundled:calendar`). `file:<path>` is a JSON document
 * `{ plugins: PluginManifest[] }` on the server. There is no fetch of an
 * arbitrary URL. `-bundled:<id>` is still accepted, from when the calendar
 * was offered by default (CB-254), and now takes nothing away, since no
 * plugin is offered unless listed. An unknown bundled id refuses to boot,
 * so a typo cannot silently offer nothing, and so does an id both listed
 * and excluded. A catalog on a host outside `PLUGIN_CATALOG_HOSTS`, or in
 * `PLUGIN_CATALOG_DENY_HOSTS`, refuses to boot (`catalogHostPolicy`); an
 * exclusion adds nothing, so those lists do not apply to a value of only
 * exclusions. Offering is not installing: nothing runs until an admin
 * installs it, and a plugin no longer offered stays installed.
 */
export function catalogsFromEnv(env: Record<string, string | undefined>): CatalogRef[] {
    const raw = env.PLUGIN_CATALOGS?.trim();
    if (!raw || raw === 'off') {
        return [];
    }
    const excluded = new Set<string>();
    const listed: CatalogRef[] = [];
    for (const item of raw.split(',')) {
        const value = item.trim();
        if (value.startsWith('-bundled:')) {
            const id = value.slice('-bundled:'.length).trim();
            if (!bundledPlugins[id]) {
                throw new Error(
                    `Unknown bundled plugin "${id}" in -bundled:${id}. PLUGIN_CATALOGS only excludes plugins this build ships.`,
                );
            }
            excluded.add(id);
            continue;
        }
        if (value.startsWith('bundled:')) {
            const id = value.slice('bundled:'.length);
            if (!bundledPlugins[id]) {
                throw new Error(`Unknown bundled plugin "${id}". PLUGIN_CATALOGS only lists plugins this build ships.`);
            }
            listed.push({ kind: 'bundled', id });
            continue;
        }
        if (value.startsWith('file:')) {
            const path = value.slice('file:'.length).trim();
            if (!path) {
                throw new Error('PLUGIN_CATALOGS file: entry needs a path.');
            }
            listed.push({ kind: 'file', path });
            continue;
        }
        throw new Error(`PLUGIN_CATALOGS entry "${value}" must be bundled:<id>, -bundled:<id> or file:<path>.`);
    }
    const named = new Set(listed.flatMap((ref) => (ref.kind === 'bundled' ? [ref.id] : [])));
    const both = [...excluded].filter((id) => named.has(id));
    if (both.length) {
        throw new Error(
            `PLUGIN_CATALOGS both lists and excludes ${both.map((id) => `"${id}"`).join(', ')}. Keep bundled:<id> or -bundled:<id>, not both.`,
        );
    }
    if (listed.length) {
        const { host, allowed, denied } = catalogHostPolicy(env);
        if (denied.has(host) || (allowed && !allowed.has(host))) {
            throw new Error(
                `PLUGIN_CATALOGS is refused on ${host || 'this host'}: it is ${denied.has(host) ? 'in PLUGIN_CATALOG_DENY_HOSTS' : 'not in PLUGIN_CATALOG_HOSTS'}. Unset PLUGIN_CATALOGS on this instance, or change those lists.`,
            );
        }
    }
    return listed;
}

const MANIFEST_KEYS = [
    'id',
    'name',
    'version',
    'author',
    'description',
    'icon',
    'entry',
    'display',
    'permissions',
    'mcp',
    'config',
    'audience',
    'bridge',
    'service',
    'delegation',
    'secrets',
    'datasets',
    'webhooks',
    'releaseNotes',
] as const;
const SERVICE_KEYS = [
    'image',
    'port',
    'env',
    'secrets',
    'healthcheck',
    'resources',
    'replicas',
    'volumes',
    'backup',
    'egress',
];
const BANNED_KEY = new Set([
    'privileged',
    'capadd',
    'capabilityadd',
    'capabilities',
    'devices',
    'devicerequests',
    'hostnetwork',
    'networkmode',
    'pidmode',
    'ipcmode',
    'binds',
    'sysctls',
    'securityopt',
    'mounts',
    'bind',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A checked manifest's `bridge`, copied. */
const bridgeSpec = (bridge: PluginBridgeSpec): PluginBridgeSpec => ({
    ...(bridge.open ? { open: [...bridge.open] } : {}),
    ...(bridge.openAnyHttps !== undefined ? { openAnyHttps: bridge.openAnyHttps } : {}),
    ...(bridge.routes !== undefined ? { routes: bridge.routes } : {}),
});

function rejectUnknown(row: Record<string, unknown>, allowed: readonly string[], where: string) {
    for (const key of Object.keys(row)) {
        if (!allowed.includes(key)) {
            throw new Error(`${where} field ${key} is not allowed.`);
        }
    }
}

function rejectBanned(value: unknown, where: string) {
    if (!value || typeof value !== 'object') {
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            rejectBanned(item, where);
        }
        return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (BANNED_KEY.has(key.toLowerCase())) {
            throw new Error(
                `${where} must not set ${key}. Privileged, host network, devices, mounts and extra capabilities are refused.`,
            );
        }
        rejectBanned(child, where);
    }
}

/**
 * A manifest's `secrets`: names, required (true by default) and a one-line
 * description, as an app manifest's. A name can't also be a plain env
 * setting of the service.
 */
export function parseManifestSecrets(
    value: unknown,
    from: string,
    env: Record<string, string> = {},
): AppManifestSecret[] {
    if (!Array.isArray(value) || value.length > 50) {
        throw new Error(`${from} secrets must be a list of at most 50.`);
    }
    const seen = new Set<string>();
    return value.map((item) => {
        if (!isRecord(item)) {
            throw new Error(`${from} secret is not an object.`);
        }
        rejectUnknown(item, ['name', 'required', 'description'], `${from} secret`);
        const name = item.name;
        if (typeof name !== 'string' || !SECRET_NAME.test(name)) {
            throw new Error(`${from} secret ${String(name).slice(0, 64)}: names are ${SECRET_NAME_HINT}.`);
        }
        if (seen.has(name)) {
            throw new Error(`${from} secrets: ${name} is listed twice.`);
        }
        seen.add(name);
        if (Object.hasOwn(env, name)) {
            throw new Error(
                `${from} secrets: ${name} is also a service env setting; a secret is read through Socio Secrets.`,
            );
        }
        if (item.required !== undefined && typeof item.required !== 'boolean') {
            throw new Error(`${from} secret ${name}: required is true or false.`);
        }
        const access = item.access;
        if (access !== undefined && access !== 'read' && access !== 'write') {
            throw new Error(`${from} dataset ${name}: access is read or write.`);
        }
        const description = item.description;
        if (
            description !== undefined &&
            (typeof description !== 'string' || description.length > 300 || /[\r\n]/.test(description))
        ) {
            throw new Error(`${from} secret ${name}: the description is one line of at most 300 characters.`);
        }
        return {
            name,
            required: item.required !== false,
            ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
        };
    });
}

/**
 * A service plugin's `datasets`: the datasets it needs (CB-451), each a
 * name it uses in the data API (letters, digits, `_`, `-` and `.`, unique
 * without regard to case), `read` or `write` access (absent: `write`), and
 * an optional one-line description; at most `PLUGIN_DATASETS_MAX`.
 */
export function parseManifestDatasets(
    value: unknown,
    from: string,
    permissions: readonly string[] = [],
): PluginDataset[] {
    if (!Array.isArray(value) || value.length > PLUGIN_DATASETS_MAX) {
        throw new Error(`${from} datasets must be a list of at most ${PLUGIN_DATASETS_MAX}.`);
    }
    const seen = new Set<string>();
    return value.map((item) => {
        if (!isRecord(item)) {
            throw new Error(`${from} dataset is not an object.`);
        }
        rejectUnknown(item, ['name', 'description', 'access', 'tables'], `${from} dataset`);
        const name = item.name;
        if (typeof name !== 'string' || !PLUGIN_DATASET_NAME.test(name)) {
            throw new Error(
                `${from} dataset ${String(name).slice(0, 64)}: a name is 1 to 63 letters, digits, _, - or ., starting with a letter or digit.`,
            );
        }
        if (seen.has(name.toLowerCase())) {
            throw new Error(`${from} datasets: ${name} is listed twice.`);
        }
        seen.add(name.toLowerCase());
        const access = item.access;
        if (access !== undefined && access !== 'read' && access !== 'write') {
            throw new Error(`${from} dataset ${name}: access is read or write.`);
        }
        const description = item.description;
        if (
            description !== undefined &&
            (typeof description !== 'string' || description.length > 500 || /[\r\n]/.test(description))
        ) {
            throw new Error(`${from} dataset ${name}: the description is one line of at most 500 characters.`);
        }
        return {
            name,
            ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
            ...(access ? { access } : {}),
            ...(item.tables === undefined
                ? {}
                : { tables: parseDatasetTables(item.tables, `${from} dataset ${name}`, permissions) }),
        };
    });
}

/**
 * A declared column's field setting (CB-451): `{ kind, label?,
 * ...settings }`, checked against the declared type as a person's save
 * is, so install shows it and every view of the data starts right. A
 * `person` or `people` field names users, which a plugin only sees with
 * `person:read`.
 */
function parseColumnField(
    value: unknown,
    column: { name: string; type: string; primaryKey: boolean },
    from: string,
    permissions: readonly string[],
): PluginDatasetField {
    if (!isRecord(value)) {
        throw new Error(`${from}: field is an object with a kind.`);
    }
    rejectUnknown(
        value,
        ['kind', 'label', 'options', 'currency', 'minorUnits', 'decimals', 'unit', 'dateFormat', 'allowSocios'],
        `${from} field:`,
    );
    const { kind, label, ...settings } = value;
    const check = checkFieldSetting(column, { kind, label, settings });
    if (!check.ok) {
        const problem = check.problems[0]!;
        throw new Error(`${from} field ${problem.path.replace(/^\$\.?/, '') || 'kind'}: ${problem.message}`);
    }
    if ((check.kind === 'person' || check.kind === 'people') && !permissions.includes(PLUGIN_PERSON_PERMISSION)) {
        throw new Error(
            `${from}: a ${check.kind} field holds people's ids, which needs the ${PLUGIN_PERSON_PERMISSION} permission.`,
        );
    }
    return {
        kind: check.kind,
        ...(check.label ? { label: check.label } : {}),
        ...check.settings,
    } as PluginDatasetField;
}

/** A dataset table or column name, as the data API takes it. */
const DATASET_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * A declared dataset's `tables` (CB-369): their shape, so a bad manifest is
 * refused when it is read. The data space checks them again (reserved
 * names, keys) when install or enable makes them. An analytical table
 * (CB-387) declares `kind`, `partitionBy` and optionally `retainDays`, with
 * analytical column types and no keys, uniques, defaults or `history`.
 */
function parseDatasetTables(value: unknown, from: string, permissions: readonly string[]): PluginDatasetTable[] {
    if (!Array.isArray(value) || value.length > PLUGIN_DATASET_MAX_TABLES) {
        throw new Error(`${from} tables must be a list of at most ${PLUGIN_DATASET_MAX_TABLES}.`);
    }
    const seen = new Set<string>();
    return value.map((item) => {
        if (!isRecord(item)) {
            throw new Error(`${from} table is not an object.`);
        }
        const table = item.table;
        if (typeof table !== 'string' || !DATASET_IDENTIFIER.test(table) || /^sqlite_/i.test(table)) {
            throw new Error(`${from} table ${String(table).slice(0, 64)}: use letters, digits and _ (up to 63).`);
        }
        if (item.kind !== undefined && item.kind !== 'transactional' && item.kind !== 'analytical') {
            throw new Error(`${from} table ${table}: kind is transactional or analytical.`);
        }
        const analytical = item.kind === 'analytical';
        rejectUnknown(
            item,
            analytical
                ? ['table', 'kind', 'columns', 'partitionBy', 'retainDays']
                : ['table', 'kind', 'columns', 'history'],
            `${from} table`,
        );
        if (seen.has(table.toLowerCase())) {
            throw new Error(`${from} tables: ${table} is listed twice.`);
        }
        seen.add(table.toLowerCase());
        if (item.history !== undefined && typeof item.history !== 'boolean') {
            throw new Error(`${from} table ${table}: history is true or false.`);
        }
        if (!Array.isArray(item.columns) || !item.columns.length || item.columns.length > 100) {
            throw new Error(`${from} table ${table}: columns must be a list of 1 to 100.`);
        }
        const names = new Set<string>();
        const columns = item.columns.map((column): PluginDatasetColumn => {
            if (!isRecord(column)) {
                throw new Error(`${from} table ${table}: a column is not an object.`);
            }
            rejectUnknown(
                column,
                analytical
                    ? ['name', 'type', 'notNull', 'field']
                    : ['name', 'type', 'notNull', 'primaryKey', 'unique', 'default', 'field'],
                `${from} table ${table} column`,
            );
            if (typeof column.name !== 'string' || !DATASET_IDENTIFIER.test(column.name)) {
                throw new Error(
                    `${from} table ${table}: column ${String(column.name).slice(0, 64)} needs a name of letters, digits and _.`,
                );
            }
            if (analytical) {
                if (names.has(column.name.toLowerCase())) {
                    throw new Error(`${from} table ${table}: column ${column.name} is listed twice.`);
                }
                names.add(column.name.toLowerCase());
                if (column.name.startsWith('__')) {
                    throw new Error(`${from} table ${table}: column ${column.name} can't start with __.`);
                }
                if (column.type !== undefined && !analyticalColumnType(column.type)) {
                    throw new Error(
                        `${from} table ${table} column ${column.name}: the type is one of ${ANALYTICAL_COLUMN_TYPES.join(', ')} or DECIMAL(p,s).`,
                    );
                }
            } else if (
                column.type !== undefined &&
                (typeof column.type !== 'string' || !(COLUMN_TYPES as readonly string[]).includes(column.type))
            ) {
                throw new Error(
                    `${from} table ${table} column ${column.name}: the type is one of ${COLUMN_TYPES.join(', ')}.`,
                );
            }
            for (const flag of ['notNull', 'primaryKey', 'unique'] as const) {
                if (column[flag] !== undefined && typeof column[flag] !== 'boolean') {
                    throw new Error(`${from} table ${table} column ${column.name}: ${flag} is true or false.`);
                }
            }
            const fallback = column.default;
            if (
                fallback !== undefined &&
                fallback !== null &&
                typeof fallback !== 'boolean' &&
                typeof fallback !== 'number' &&
                !(typeof fallback === 'string' && fallback.length <= 1000)
            ) {
                throw new Error(
                    `${from} table ${table} column ${column.name}: a default is a string, number, boolean or null.`,
                );
            }
            if (column.field !== undefined) {
                column.field = parseColumnField(
                    column.field,
                    {
                        name: column.name,
                        type: typeof column.type === 'string' ? column.type : 'TEXT',
                        primaryKey: column.primaryKey === true,
                    },
                    `${from} table ${table} column ${column.name}`,
                    permissions,
                );
            }
            return column as unknown as PluginDatasetColumn;
        });
        if (!analytical) {
            return {
                table,
                ...(item.kind === undefined ? {} : { kind: 'transactional' as const }),
                columns,
                ...(item.history === undefined ? {} : { history: item.history }),
            };
        }
        const partitionBy = item.partitionBy;
        if (!isRecord(partitionBy)) {
            throw new Error(`${from} table ${table}: an analytical table needs partitionBy { column, grain }.`);
        }
        rejectUnknown(partitionBy, ['column', 'grain'], `${from} table ${table} partitionBy`);
        const partition = columns.find(
            (column) =>
                typeof partitionBy.column === 'string' &&
                column.name.toLowerCase() === partitionBy.column.toLowerCase(),
        );
        const partitionType = typeof partition?.type === 'string' ? partition.type.trim().toUpperCase() : 'TEXT';
        if (!partition || !['DATE', 'TIMESTAMP'].includes(partitionType) || partition.notNull !== true) {
            throw new Error(
                `${from} table ${table}: partitionBy.column must be a NOT NULL DATE or TIMESTAMP column of the table.`,
            );
        }
        if (partitionBy.grain !== 'day' && partitionBy.grain !== 'month') {
            throw new Error(`${from} table ${table}: partitionBy.grain is day or month.`);
        }
        const retainDays = item.retainDays;
        if (
            retainDays !== undefined &&
            (!Number.isInteger(retainDays) ||
                (retainDays as number) < 1 ||
                (retainDays as number) > ANALYTICAL_RETAIN_DAYS_MAX)
        ) {
            throw new Error(
                `${from} table ${table}: retainDays is a whole number of days from 1 to ${ANALYTICAL_RETAIN_DAYS_MAX}.`,
            );
        }
        return {
            table,
            kind: 'analytical' as const,
            columns,
            partitionBy: { column: partition.name, grain: partitionBy.grain },
            ...(retainDays === undefined ? {} : { retainDays: retainDays as number }),
        };
    });
}

/** Whether a manifest's analytical column type is one the data space takes. */
function analyticalColumnType(raw: unknown) {
    if (typeof raw !== 'string') {
        return false;
    }
    const type = raw.trim().toUpperCase().replace(/\s+/g, '');
    if ((ANALYTICAL_COLUMN_TYPES as readonly string[]).includes(type)) {
        return true;
    }
    const decimal = ANALYTICAL_DECIMAL.exec(type);
    return !!decimal && Number(decimal[1]) >= 1 && Number(decimal[1]) <= 38 && Number(decimal[2]) <= Number(decimal[1]);
}

/**
 * A service plugin's `webhooks` (CB-370): public paths on its origin, each
 * an exact path (`PLUGIN_WEBHOOK_PATH`, listed once), `POST` by default or
 * `GET` for one OAuth callback at most, with an optional body limit (POST
 * only, up to `PLUGIN_WEBHOOK_BODY_MAX`) and rate (up to
 * `PLUGIN_WEBHOOK_PER_MINUTE_MAX`); at most `PLUGIN_WEBHOOKS_MAX`. A path
 * the plugin's entry also uses is refused: a page that needs a session
 * can't also be public.
 */
export function parseManifestWebhooks(value: unknown, from: string, entryPath = '/'): PluginWebhook[] {
    if (!Array.isArray(value) || value.length > PLUGIN_WEBHOOKS_MAX) {
        throw new Error(`${from} webhooks must be a list of at most ${PLUGIN_WEBHOOKS_MAX}.`);
    }
    const seen = new Set<string>();
    let gets = 0;
    return value.map((item) => {
        if (!isRecord(item)) {
            throw new Error(`${from} webhook is not an object.`);
        }
        rejectUnknown(item, ['path', 'method', 'maxBodyBytes', 'perMinute'], `${from} webhook`);
        const path = item.path;
        if (!pluginWebhookPath(path)) {
            throw new Error(
                `${from} webhook ${String(path).slice(0, 80)}: a path is 1 to 8 segments of letters, digits, _, -, ~ or ., none starting with ., with no trailing / and not under /__cb/.`,
            );
        }
        if (seen.has(path)) {
            throw new Error(`${from} webhooks: ${path} is listed twice.`);
        }
        seen.add(path);
        if (path === pluginEntryPathname(entryPath)) {
            throw new Error(`${from} webhook ${path} is the plugin's entry, which needs a session.`);
        }
        const method = item.method ?? 'POST';
        if (method !== 'POST' && method !== 'GET') {
            throw new Error(`${from} webhook ${path}: method must be POST or GET.`);
        }
        if (method === 'GET' && ++gets > 1) {
            throw new Error(`${from} webhooks: only one GET path (an OAuth callback) is allowed.`);
        }
        const maxBodyBytes = item.maxBodyBytes;
        if (maxBodyBytes !== undefined) {
            if (method === 'GET') {
                throw new Error(`${from} webhook ${path}: a GET path takes no body, so it has no maxBodyBytes.`);
            }
            if (
                typeof maxBodyBytes !== 'number' ||
                !Number.isInteger(maxBodyBytes) ||
                maxBodyBytes < 1 ||
                maxBodyBytes > PLUGIN_WEBHOOK_BODY_MAX
            ) {
                throw new Error(
                    `${from} webhook ${path}: maxBodyBytes is a whole number from 1 to ${PLUGIN_WEBHOOK_BODY_MAX}.`,
                );
            }
        }
        const perMinute = item.perMinute;
        if (
            perMinute !== undefined &&
            (typeof perMinute !== 'number' ||
                !Number.isInteger(perMinute) ||
                perMinute < 1 ||
                perMinute > PLUGIN_WEBHOOK_PER_MINUTE_MAX)
        ) {
            throw new Error(
                `${from} webhook ${path}: perMinute is a whole number from 1 to ${PLUGIN_WEBHOOK_PER_MINUTE_MAX}.`,
            );
        }
        return {
            path,
            method,
            ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
            ...(perMinute !== undefined ? { perMinute } : {}),
        };
    });
}

/**
 * Checks a catalog manifest. `warn` hears deprecations that still load:
 * `service.secrets` (Swarm secrets in a manifest) is read for one release
 * after Socio Secrets, then refused.
 */
export function parseManifest(
    value: unknown,
    from: string,
    warn: (line: string) => void = (line) => console.warn(line),
): PluginManifest {
    if (!isRecord(value)) {
        throw new Error(`${from} is not a plugin manifest.`);
    }
    rejectUnknown(value, MANIFEST_KEYS, from);
    rejectBanned(value, from);
    const row = value as unknown as Partial<PluginManifest> & {
        service?: Record<string, unknown>;
    };
    if (!row.id || !PLUGIN_ID.test(row.id)) {
        throw new Error(`${from} has a plugin id Socio cannot route.`);
    }
    for (const key of ['name', 'version', 'author', 'description'] as const) {
        if (typeof row[key] !== 'string' || !row[key]) {
            throw new Error(`${from} needs a ${key}.`);
        }
    }
    if (row.display !== 'tab' && row.display !== 'embed') {
        throw new Error(`${from} display must be tab or embed.`);
    }
    if (!Array.isArray(row.permissions) || row.permissions.some((item) => typeof item !== 'string')) {
        throw new Error(`${from} permissions must be a list of strings.`);
    }
    if (row.entry !== undefined) {
        if (!isRecord(row.entry)) {
            throw new Error(`${from} entry must be an object.`);
        }
        rejectUnknown(row.entry, ['path'], `${from} entry`);
    }
    const path = row.entry?.path ?? '/';
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw new Error(`${from} entry path must start with /.`);
    }
    if (row.icon !== undefined && (typeof row.icon !== 'string' || row.icon.length > 64)) {
        throw new Error(`${from} icon must be a short name, not a URL.`);
    }
    if (row.mcp !== undefined) {
        if (!isRecord(row.mcp)) {
            throw new Error(`${from} mcp must be an object.`);
        }
        rejectUnknown(row.mcp, ['tools'], `${from} mcp`);
        if (!Array.isArray(row.mcp.tools)) {
            throw new Error(`${from} mcp.tools must be a list.`);
        }
        for (const tool of row.mcp.tools) {
            if (!isRecord(tool)) {
                throw new Error(`${from} tool is not an object.`);
            }
            rejectUnknown(tool, ['name', 'description', 'scope'], `${from} tool`);
            if (typeof tool.name !== 'string' || !PLUGIN_TOOL_NAME.test(tool.name)) {
                throw new Error(`${from} tool ${String(tool.name)} has a bad name.`);
            }
            if (typeof tool.description !== 'string' || !tool.description) {
                throw new Error(`${from} tool ${tool.name} needs a description.`);
            }
            if (typeof tool.scope !== 'string' || !row.permissions.includes(tool.scope)) {
                throw new Error(
                    `${from} tool ${tool.name} asks for ${String(tool.scope)}, which the plugin does not request.`,
                );
            }
        }
    }
    if (row.audience !== undefined && !(PLUGIN_AUDIENCES as readonly unknown[]).includes(row.audience)) {
        throw new Error(`${from} audience must be admins or members.`);
    }
    if (row.bridge !== undefined) {
        if (!isRecord(row.bridge)) {
            throw new Error(`${from} bridge must be an object.`);
        }
        rejectUnknown(row.bridge, ['open', 'openAnyHttps', 'routes'], `${from} bridge`);
        const { open, openAnyHttps, routes } = row.bridge as {
            open?: unknown;
            openAnyHttps?: unknown;
            routes?: unknown;
        };
        if (open !== undefined) {
            if (!Array.isArray(open) || open.length > 20) {
                throw new Error(`${from} bridge.open must be a list of at most 20 URLs.`);
            }
            for (const entry of open) {
                if (!bridgeOpenRule(entry)) {
                    throw new Error(
                        `${from} bridge.open entry ${String(entry)} must be an https URL with a host and a path, and no port, query or fragment.`,
                    );
                }
            }
        }
        if (openAnyHttps !== undefined && typeof openAnyHttps !== 'boolean') {
            throw new Error(`${from} bridge.openAnyHttps must be true or false.`);
        }
        if (openAnyHttps === true && row.display !== 'embed') {
            throw new Error(`${from} bridge.openAnyHttps is for an embed; a tab plugin opens its own links.`);
        }
        if (routes !== undefined && typeof routes !== 'boolean') {
            throw new Error(`${from} bridge.routes must be true or false.`);
        }
    }
    // Only a plugin this build ships may run inside Socio (bundled mode).
    if (!isRecord(row.service)) {
        throw new Error(`${from} needs a service.`);
    }
    rejectUnknown(row.service, SERVICE_KEYS, `${from} service`);
    if (row.service.build !== undefined) {
        throw new Error(`${from} cannot ask for a Docker build. Pin a prebuilt image digest.`);
    }
    if (typeof row.service.image !== 'string' || !PINNED_IMAGE.test(row.service.image)) {
        throw new Error(`${from} image must be name@sha256:<64 hex digits>. A tag is not a pin.`);
    }
    if (row.service.volumes !== undefined) {
        if (!Array.isArray(row.service.volumes)) {
            throw new Error(`${from} volumes must be a list.`);
        }
        for (const volume of row.service.volumes) {
            if (!isRecord(volume)) {
                throw new Error(`${from} volume is not an object.`);
            }
            rejectUnknown(volume, ['name', 'mount', 'shared', 'driver', 'ephemeral'], `${from} volume`);
            if (volume.type !== undefined || volume.source !== undefined) {
                throw new Error(`${from} volumes are named volumes. Bind mounts and host paths are refused.`);
            }
        }
    }
    if (row.service.backup !== undefined) {
        if (!isRecord(row.service.backup)) {
            throw new Error(`${from} service.backup must be { protocol, schema }.`);
        }
        rejectUnknown(row.service.backup, ['protocol', 'schema'], `${from} service.backup`);
    }
    if (row.config !== undefined) {
        if (!isRecord(row.config)) {
            throw new Error(`${from} config must be an object.`);
        }
        for (const [key, field] of Object.entries(row.config)) {
            if (!isRecord(field)) {
                throw new Error(`${from} config ${key} is not an object.`);
            }
            rejectUnknown(
                field,
                ['description', 'default', 'type', 'options', 'required', 'min', 'max', 'pattern'],
                `${from} config ${key}`,
            );
            const problem = pluginConfigFieldError(field);
            if (problem) {
                throw new Error(`${from} config ${key}: ${problem}`);
            }
        }
    }
    const delegation = row.delegation === undefined ? undefined : parseDelegation(row.delegation, from);
    const service = row.service as unknown as PluginServiceSpec;
    // A `fromConfig` egress entry names one of these url settings (CB-441).
    checkServiceSpec(service, { config: (row.config ?? {}) as Record<string, PluginConfigField> });
    const secrets = row.secrets === undefined ? undefined : parseManifestSecrets(row.secrets, from, service.env ?? {});
    const datasets =
        row.datasets === undefined ? undefined : parseManifestDatasets(row.datasets, from, row.permissions);
    const webhooks = row.webhooks === undefined ? undefined : parseManifestWebhooks(row.webhooks, from, path);
    // CB-527: read at install and update, never fetched; rendered sanitized.
    const releaseNotes =
        row.releaseNotes === undefined ? undefined : parsePluginReleaseNotes(row.releaseNotes, from, row.version!);
    if (service.secrets?.length) {
        warn(
            `${from}: plugin ${row.id} sets service.secrets, which is deprecated: declare secrets and read them with socio.secrets (Socio Secrets). Swarm secrets in a manifest are mounted for one more release.`,
        );
    }
    // CB-458: state on a plugin's own volumes. Warned for one minor release,
    // then refused; private storage is warned while declared.
    const stateful = statefulVolumes(service).map((volume) => volume.name);
    for (const warning of pluginStorageWarnings(service)) {
        warn(
            warning.kind === 'not_backed_up'
                ? `${from}: plugin ${row.id} keeps data on volume(s) ${stateful.join(', ')} without service.backup. ${warning.message}: declare service.backup, or mark a cache volume ephemeral.`
                : `${from}: plugin ${row.id} keeps data on volume(s) ${stateful.join(', ')}. ${warning.message}.`,
        );
    }
    return {
        id: row.id,
        name: row.name!,
        version: row.version!,
        author: row.author!,
        description: row.description!,
        ...(row.icon ? { icon: row.icon } : {}),
        entry: { path },
        display: row.display,
        permissions: row.permissions,
        ...(row.mcp ? { mcp: { tools: row.mcp.tools } } : {}),
        ...(row.config ? { config: row.config } : {}),
        ...(row.audience ? { audience: row.audience as PluginAudience } : {}),
        ...(row.bridge ? { bridge: bridgeSpec(row.bridge as PluginBridgeSpec) } : {}),
        service,
        ...(delegation ? { delegation } : {}),
        ...(secrets?.length ? { secrets } : {}),
        ...(datasets?.length ? { datasets } : {}),
        ...(webhooks?.length ? { webhooks } : {}),
        ...(releaseNotes ? { releaseNotes } : {}),
    };
}

const DELEGATION_ACTION = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const DELEGATION_TIERS = ['read', 'write', 'consequential', 'admin'] as const;

/**
 * A service plugin's socio-access contract (CB-232). Closed: no
 * scopes of its own and no `ownerColumn`. A `consequential` action is
 * taken: the plugin asks for its approval at
 * `/api/plugins/<id>/actor/approvals`, as an app does. `data:` names are
 * Socio's data operations, never a plugin's. `admin` stays the admins' own
 * (`admin_tier`: never a socio's).
 */
function parseDelegation(value: unknown, from: string): PluginDelegation {
    if (!isRecord(value)) {
        throw new Error(`${from} delegation must be an object.`);
    }
    rejectUnknown(value, ['contract', 'actions', 'public', 'alwaysAsk'], `${from} delegation`);
    if (value.contract !== 1) {
        throw new Error(`${from} delegation.contract must be 1.`);
    }
    if (!isRecord(value.actions)) {
        throw new Error(`${from} delegation.actions must be an object.`);
    }
    const actions: PluginDelegation['actions'] = {};
    const entries = Object.entries(value.actions);
    if (entries.length > 200) {
        throw new Error(`${from} delegation lists more than 200 actions.`);
    }
    for (const [name, tier] of entries) {
        if (!DELEGATION_ACTION.test(name)) {
            throw new Error(`${from} delegation action ${name} has a bad name.`);
        }
        if (name.startsWith('data:')) {
            throw new Error(
                `${from} delegation action ${name}: names starting with data: are reserved for Socio’s data operations.`,
            );
        }
        if (!(DELEGATION_TIERS as readonly unknown[]).includes(tier)) {
            throw new Error(`${from} delegation action ${name} must be read, write, consequential or admin.`);
        }
        actions[name] = tier as PluginDelegation['actions'][string];
    }
    const publicPaths = value.public;
    if (
        publicPaths !== undefined &&
        (!Array.isArray(publicPaths) ||
            publicPaths.length > 20 ||
            publicPaths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path.length > 200))
    ) {
        throw new Error(`${from} delegation.public must be at most 20 paths starting with /.`);
    }
    if (value.alwaysAsk !== undefined && typeof value.alwaysAsk !== 'boolean') {
        throw new Error(`${from} delegation.alwaysAsk must be true or false.`);
    }
    return {
        contract: 1,
        actions,
        ...(publicPaths ? { public: [...(publicPaths as string[])] } : {}),
        ...(value.alwaysAsk === true ? { alwaysAsk: true } : {}),
    };
}

/** Manifests this instance may install. Bundled ids always use the built-in manifest. */
export function loadCatalog(refs: readonly CatalogRef[]) {
    const offers = new Map<string, PluginManifest>();
    for (const ref of refs) {
        if (ref.kind === 'bundled') {
            const plugin = bundledPlugins[ref.id];
            if (plugin) {
                offers.set(ref.id, plugin.manifest);
            }
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(ref.path, 'utf8')) as unknown;
        } catch {
            throw new Error(`Could not read the plugin catalog ${ref.path}.`);
        }
        const plugins = (parsed as { plugins?: unknown }).plugins;
        if (!Array.isArray(plugins)) {
            throw new Error(`${ref.path} must be { plugins: [...] }.`);
        }
        for (const item of plugins) {
            const manifest = parseManifest(item, ref.path);
            if (bundledPlugins[manifest.id]) {
                throw new Error(
                    `${ref.path} lists ${manifest.id}, which this build already ships. Use bundled:${manifest.id}.`,
                );
            }
            offers.set(manifest.id, manifest);
        }
    }
    return offers;
}

/**
 * Bundled plugins every instance offered before CB-371, when no
 * `PLUGIN_CATALOGS` was needed for them. Any instance may have one
 * installed, which keeps running after the upgrade whether or not its
 * catalog lists it, so its connected-agent scopes stay grantable
 * (`scopedManifests`). Never add to this list: a new plugin is offered,
 * and its scopes listed, only where `PLUGIN_CATALOGS` names it.
 */
export const FORMER_DEFAULT_OFFERS: readonly string[] = ['calendar'];

/**
 * The manifests whose connected-agent scopes this instance lists: its
 * catalog's, and those of the former default offers even when they are no
 * longer offered (`FORMER_DEFAULT_OFFERS`). A scope of a plugin that is
 * not installed grants nothing.
 */
export function scopedManifests(catalog: ReadonlyMap<string, PluginManifest>) {
    const manifests = new Map(catalog);
    for (const id of FORMER_DEFAULT_OFFERS) {
        const plugin = bundledPlugins[id];
        if (plugin && !manifests.has(id)) {
            manifests.set(id, plugin.manifest);
        }
    }
    return [...manifests.values()];
}

/**
 * The per-plugin connected-agent scopes this instance may grant
 * (`plugins:<id>:read|write`, one per kind of tool), with plain words for
 * the consent screen: its catalog's and the former default offers'
 * (`scopedManifests`). Fixed at boot, like the catalog.
 */
export function pluginOAuthScopes(refs: readonly CatalogRef[]) {
    const scopes: string[] = [];
    const labels: Record<string, string> = {};
    for (const manifest of scopedManifests(loadCatalog(refs))) {
        for (const tool of manifest.mcp?.tools ?? []) {
            const scope = pluginScope(manifest.id, tool.scope);
            if (labels[scope]) {
                continue;
            }
            scopes.push(scope);
            labels[scope] = pluginScopeLabel(manifest.name, pluginPermissionAccess(tool.scope));
        }
    }
    return { scopes: scopes.sort(), labels };
}
