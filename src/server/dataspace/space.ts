import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { StorageUnavailableError, type ObjectStore, type StorageDriver } from '@socio/data/object-store';
import { sqliteData, transaction, transactionSync } from '@socio/data/open';
import { LIVE, SYSTEM, byDot, deletedWith } from '@socio/data/soft-delete';
import { objectKey, userDirName } from '@socio/data/storage/keys';
import { DataError } from '@socio/foundation/dataspace/data-error';
import { normalizePath } from '@socio/foundation/dataspace/paths';
import type { DataTokenScope } from '@socio/foundation/http/app-env';
import { LEGACY_KEY, SecretBox, type DataKeyring, type SealState } from '@socio/foundation/keys/secret-box';
import type { ComputerExecEnv } from '@socio/foundation/turns/turn';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import { ownedList, type TransferParties } from '@socio/shared/auth';
import { COMPUTER_RUN_DIR, LEGACY_COMPUTER_ENV_FILE } from '@socio/shared/computers/paths';
import type {
    DataAuditEntry,
    DataFileView,
    DataUsageView,
    DatasetDetail,
    DatasetView,
    GrantAccess,
    GrantView,
    QueryResult,
    RowsPage,
    SharedAreaView,
    SharedOrigin,
    TableInfo,
} from '@socio/shared/data-types';
import {
    SOCIO_OWNER_PREFIX,
    WORKSPACE_OWNER_ID,
    isCompanyOwner,
    isPluginOwner,
    isWorkspaceOwner,
    nonPersonOwnerId,
    pluginOfOwner,
    pluginOwnerId,
    reservedUserId,
    sharedAreaLabel,
    type PluginDataBudget,
} from '@socio/shared/data-types';
import type { FieldSetting } from '@socio/shared/dataset-query/kinds';
import { specPath } from '@socio/shared/dataset-query/spec';
import { VIEW_NO_ACCESS } from '@socio/shared/dataset-view';
import {
    VIEW_WRITE_CODES,
    fieldSettingsRequest,
    type FieldConflict,
    type FieldSettingsResponse,
    type FieldSettingsSaved,
    type InvalidWrite,
    type OptionsInUse,
    type WriteRefusal,
} from '@socio/shared/dataset-views/contract';
import {
    checkFieldSetting,
    fieldSettingEntry,
    missingFieldEntry,
    specFieldSetting,
    type FieldColumn,
    type StoredFieldSetting,
} from '@socio/shared/dataset-views/field-settings';
import { DATASET_VIEWS_SCHEMA } from '@socio/shared/dataset-views/schema';
import {
    ANALYTICAL_RETAIN_DAYS_MAX,
    type AnalyticalRetention,
    type AnalyticalRetentionPreview,
    type AnalyticalTableStats,
} from '@socio/shared/dataspace/analytics';
import { dataApiTokenActor, type DataApiScope } from '@socio/shared/dataspace/api-tokens';
import { LIMIT_SPECS } from '@socio/shared/limits';
import type {
    PluginBindingChoice,
    PluginBindingChoices,
    PluginBindingPlan,
    PluginNeedPlan,
    PluginTokenNeed,
} from '@socio/shared/plugins/bindings';
import {
    pluginNeedAccess,
    type PluginDatasetAccess,
    type PluginDatasetColumn,
    type PluginDatasetTable,
} from '@socio/shared/plugins/plugins';
import { isAdmin } from '@socio/shared/roles';
import {
    SPACE_ITEMS_SCHEMA,
    SPACE_PLACE_REFUSED,
    SPACE_POSITION,
    spaceItemKey,
    spaceItemVersion,
    type PrivateItemsResponse,
    type SpaceDatasetItem,
} from '@socio/shared/spaces/space-items';
import type { DatasetFilesStatus, Dot, Space, User } from '@socio/shared/types';

import type { ApprovalsShape } from '../approvals/contract.js';
import type { RuntimeOwnershipShape } from '../runtime/contract.js';
import type { FileMovesShape, LocalMigrationResult, LocalObjectStoreShape, ResealResult } from '../storage/contract.js';

import { partsDir, STAGING_DIR, stagedPath, type AnalyticalTable } from './analytics/declare.js';
import type { StageAnswer, WorkerJob } from './analytics/ipc.js';
import { DatasetAnalytics } from './analytics/process.js';
import { DataApiTokens, type DataApiTokenAuditLine } from './api-tokens.js';
import type {
    AgentActor,
    AppDataDelegation,
    DataActor,
    DataBatchResult,
    DataBatchStatement,
    DataColumnInput,
    DataReadBatchResult,
    DataReadBatchStatement,
    DataFileRecord,
    DataSpaceShape,
    DataTableInput,
    DataWriteOp,
    DeleteStamp,
    FileDeletedListener,
    PluginDatasetSource,
    SharedWriteNotice,
    StorageStatus,
    VisibleDataset,
    WriteResult,
    DataFile,
    Dataset,
} from './contract.js';
import { DEFAULT_DATA_LIMITS, type DataLimits } from './contract.js';
import { readProblems, tablesAfter } from './domain/plugin-needs.js';
import type { DataSpaceRepositories, DatasetSettings, FieldSettingRow, PluginBinding } from './domain/repositories.js';
import type { DatasetSizeDays } from './domain/size-days.js';
import { DatasetEngine, MAX_COLUMNS, batchRuns, type DatasetSizes } from './engine.js';
import { sqliteDataSpaceRepositories } from './infra/sqlite/index.js';
import { ownedDataItems } from './infra/sqlite/ownership.js';
import { SqliteDatasetSizeDays } from './infra/sqlite/size-days.js';
import { QueryRunner } from './query-runner.js';
import { DataTokens } from './tokens.js';
import { prepareDataTransfer } from './transfer.js';

/**
 * A company socio's shared area (CB-224): the dataset and folder its
 * computer's commands reach, owned by no person. Everyone who uses the
 * socio can see it through the computer. Never a user id.
 */
export const sharedOwner = (dotId: string) => `${SOCIO_OWNER_PREFIX}${dotId}`;
/** Where a company socio's Dot copies a file for its computer (`copyFile`). */
export const SHARED_FOLDER = 'shared/';
/**
 * What a command on a company socio's computer is told for any dataset out
 * of its reach, private or missing alike (CB-224): the same 404 either way.
 */
export const sharedComputerNoDataset = (name: string) =>
    `No dataset "${name}" is available to this socio’s shared computer. It reaches only the socio’s shared dataset ("scratch") and, to read, datasets shared with a Space. Use the data tools in the chat, or a personal socio, for anything else (CB-227).`;
/** A company socio's computer writing to a Space-shared dataset (CB-224). */
export const SHARED_COMPUTER_READ_ONLY =
    'Datasets shared with a Space are read-only from a shared socio’s computer. Write to the socio’s shared dataset ("scratch"), or use the data tools in the chat.';
/**
 * A company socio's computer command, or a chat's copy into its shared
 * folder: the socio's shared area, never the user's own data.
 */
const socioReach = (actor: DataActor) => actor.kind !== 'user' && actor.reach === 'socio';
/** The same actor with the user's reach: what it would see on their own socio. */
const asPerson = (actor: AgentActor): AgentActor => ({
    ...actor,
    reach: undefined,
});
/** A service plugin's own token (`purpose: 'plugin'`): its declared datasets only. */
const pluginToken = (actor: DataActor): actor is Extract<AgentActor, { kind: 'token' }> & { pluginId: string } =>
    actor.kind === 'token' && actor.purpose === 'plugin' && !!actor.pluginId;
/**
 * An admin's data API token (`purpose: 'api'`): the company's datasets no
 * plugin is bound to, within its scopes; never a person's, a socio's or a
 * plugin's. Its writes are `token:<id>`, attributed to its maker.
 */
export const apiToken = (
    actor: DataActor,
): actor is Extract<AgentActor, { kind: 'token' }> & { apiToken: NonNullable<DataTokenScope['apiToken']> } =>
    actor.kind === 'token' && actor.purpose === 'api' && !!actor.apiToken && actor.userId === WORKSPACE_OWNER_ID;
/** Whether an API token's scopes give it write access (rows, or schema and settings). */
const apiWrites = (actor: DataActor) =>
    apiToken(actor) && actor.apiToken.scopes.some((scope) => scope === 'data:write' || scope === 'data:admin');
/**
 * The entry with the most access among visible entries of one dataset (a
 * plugin may see a dataset through a read need and a write need, CB-451):
 * a write op by id or name is the write entry's. Undefined for none.
 */
const widest = (entries: Visible[]) => entries.find((item) => item.access === 'write') ?? entries[0];
/** A plugin token's entry naming a binding it covers and its access (CB-451): `binding:<id>:<access>`. */
const TOKEN_BINDING = 'binding:';
const tokenBinding = (entry: string): { id: string; access: GrantAccess } | undefined => {
    if (!entry.startsWith(TOKEN_BINDING)) {
        return undefined;
    }
    const at = entry.lastIndexOf(':');
    const access = entry.slice(at + 1);
    return access === 'read' || access === 'write' ? { id: entry.slice(TOKEN_BINDING.length, at), access } : undefined;
};
/** The session every token of a plugin is issued under, so one call revokes them all. */
export const pluginTokenSession = (pluginId: string) => `plugin:${pluginId}`;
/** The most an admin may raise one plugin's data budget to (CB-473): the Settings limit's ceiling. */
const PLUGIN_BUDGET_MAX = LIMIT_SPECS.dataPluginStatementsPerMinute.max;
/** What one read batch's results may come to over all its statements (CB-474). */
const READ_BATCH_MAX_BYTES = 8 * 1024 * 1024;
/** How long a plugin's data token lives; it exchanges its identity for another. */
export const PLUGIN_TOKEN_TTL_MS = 15 * 60_000;
/** Who a write is in row history: a user id, `plugin:<id>` or `dot:<id>`. */
const writerOf = (actor: DataActor) =>
    actor.kind === 'user'
        ? actor.userId
        : pluginToken(actor)
          ? actor.userId
          : apiToken(actor)
            ? dataApiTokenActor(actor.apiToken.id)
            : byDot(actor.dotId);
/** Whose datasets and files an actor's scratch and folder are. */
export const dataOwner = (actor: DataActor) =>
    socioReach(actor) ? sharedOwner((actor as AgentActor).dotId) : actor.userId;

/** A manifest's column as the engine takes it: without its field setting (CB-451), which the data space keeps. */
const engineColumn = ({ field: _, ...column }: PluginDatasetColumn) => column as DataColumnInput;
const engineColumns = (columns: readonly PluginDatasetColumn[]) => columns.map(engineColumn);
/** A stored field setting as the shared helpers read it. */
const storedField = (row: FieldSettingRow): StoredFieldSetting => ({
    column: row.columnName,
    kind: row.kind,
    label: row.label,
    settings: row.settings ?? {},
    version: row.version,
    declaredBy: row.declaredBy,
});
/** What saving a field setting answered (CB-451): the saved field, or a refusal with its status. */
export type FieldSaveOutcome =
    | { ok: true; saved: FieldSettingsSaved }
    | { ok: false; status: 400 | 403 | 409; refusal: WriteRefusal };

/** A manifest's analytical table as `POST …/tables` takes it (CB-387). */
function declaredAnalyticalInput(declared: PluginDatasetTable) {
    return {
        table: declared.table,
        kind: 'analytical' as const,
        columns: declared.columns.map((column) => ({
            name: column.name,
            type: column.type ?? 'TEXT',
            ...(column.notNull ? { notNull: true } : {}),
        })),
        partitionBy: declared.partitionBy,
        ...(declared.retainDays ? { retainDays: declared.retainDays } : {}),
    };
}
type DeclaredPluginDataset = {
    name: string;
    description?: string;
    access?: PluginDatasetAccess;
    tables?: readonly PluginDatasetTable[];
};

/** A dataset's row (`data_datasets`), as the repositories type it. */
type DatasetRow = Dataset;
/** A file's row (`data_files`), as the repositories type it. */
type FileRow = DataFile;

type Visible = VisibleDataset;
type WriteOp = DataWriteOp;
type DataIndexWriteOp = Extract<WriteOp, { op: 'create_index' | 'drop_index' | 'analyze' }>;
interface WriteSharedPayload {
    datasetId: string;
    write: WriteOp;
}
interface CreateDatasetPayload {
    name: string;
    description: string;
}
interface GrantPayload {
    datasetId?: string;
    folder?: string;
    access: GrantAccess;
}

export interface DataSpaceOptions {
    /** USER_DATA_DIR: one directory per user under it. */
    dir: string;
    limits?: Partial<DataLimits>;
    /** What an admin saved in Settings (CB-108), over `limits`, read on every use. */
    overrides?: () => Partial<DataLimits>;
    /**
     * The keys files are sealed with (CB-62): DATA_ENCRYPTION_KEY, the
     * previous one, and SESSION_SECRET (or the process's own) for the legacy
     * key; a string is SESSION_SECRET alone.
     */
    secret: string | DataKeyring;
    approvals: ApprovalsShape;
    workspace: {
        dot(id: string): Dot | undefined;
        dots(): Dot[];
        users(): User[];
        spaces(): Space[];
        /**
         * Whether a person may read a Space now (CB-181, the one Space access
         * rule): a dataset shared with it is theirs to read only then. Unset:
         * every live Space (tests' stand-ins).
         */
        readsSpace?(userId: string, spaceId: string): boolean;
        /**
         * Whether a person may edit a Space now (`SpaceAccess.canEdit`: an
         * admin, or a member with the editor role): only they place datasets
         * in it (CB-451). Unset: as `readsSpace` (stand-ins).
         */
        editsSpace?(userId: string, spaceId: string): boolean;
        /** A chat with the Dot, or an action on its computer, for this person (CB-229). */
        usedDot?(userId: string, dotId: string): boolean;
        /** Whether a person is deactivated (their data API tokens stop). Unset: nobody is. */
        deactivated?(userId: string): boolean;
        /** The workspace audit (`workspace_audit`): data API tokens' lines. Unset: not recorded. */
        audit?(line: DataApiTokenAuditLine): void;
    };
    tokenTtlMs?: number;
    /**
     * `DATA_ANALYTICS_MODE` (CB-369): `child` runs analytical tables in a
     * process forked when first used; `off` (the default here, for
     * stand-ins) refuses them. `makeDataSpace` passes the environment's.
     */
    analyticsMode?: 'child' | 'off';
    /**
     * This runtime on `db` (CB-108): data tokens are kept there, so every
     * runtime on the database accepts them while this one lives. Unset: in
     * this process's memory only.
     */
    runtime?: RuntimeOwnershipShape;
    /**
     * Where new files' sealed bytes go (CB-54): S3 when configured, else the
     * local disk under `dir` (the default).
     */
    objects?: ObjectStore;
    /**
     * The local disk under `dir` (`ObjectStores.local(dir)`), for rows still
     * marked `local`, and where new files go without `objects`.
     */
    legacy: LocalObjectStoreShape;
    /** The runs over files' bytes: the move into S3 and the re-seal (`FileMoves`). */
    moves: FileMovesShape;
    /** `TENANT_ID`: the object keys' first level in S3. */
    tenantId?: string;
}

const DAY = 86_400_000;
/** The cross-runtime contract analytical tables need (CB-369). */
export const ANALYTICS_CONTRACT = 'dataset-analytics';
export const ANALYTICS_CONTRACT_VERSION = 1;
/**
 * The cross-runtime contract of workspace-owned plugin datasets (CB-451):
 * a runtime that records it finds a plugin's datasets by its bindings, not
 * by a `plugin:<id>` owner, so they may move to the workspace's owner.
 */
export const WORKSPACE_DATASETS_CONTRACT = 'workspace-datasets';
export const WORKSPACE_DATASETS_CONTRACT_VERSION = 1;
/** How long one append may take to stage in the analytics process. */
const APPEND_TIMEOUT_MS = 5 * 60_000;
/** Staged files and unlisted parts older than this are swept. */
const SWEEP_AFTER_MS = 60 * 60_000;
/**
 * How long retired parts stay on disk and in the catalog
 * (`retiredKeepHours`): longer than any query and at least one daily backup.
 */
const RETIRED_KEEP_MS = 48 * 60 * 60_000;
/** How long one Compact file (`VACUUM`) may run before it is stopped. */
const COMPACT_TIMEOUT_MS = 10 * 60_000;
/** The nightly row-history work's hours, the server's local time. */
const NIGHT_FROM_HOUR = 2;
const NIGHT_TO_HOUR = 6;
/** Shared areas' owner ids, `socio:…`, as an index range (`;` follows `:`). */
const SHARED_OWNERS = "ownerUserId >= 'socio:' AND ownerUserId < 'socio;'";
/**
 * The company's datasets' owner ids: the workspace's (CB-451) and service
 * plugins' from before it (`plugin:…`, the same way).
 */
const COMPANY_OWNERS =
    "((ownerUserId >= 'ws:' AND ownerUserId < 'ws;') OR (ownerUserId >= 'plugin:' AND ownerUserId < 'plugin;'))";
/** How an audit row's actor put something in a shared area (CB-229). */
const VIA: Record<string, SharedOrigin['via']> = {
    token: 'computer',
    dot: 'chat',
    user: 'app',
    system: 'system',
};
/** Writes to a shared dataset with more rows than this always need the user. */
export const AUTO_MAX_SHARED_ROWS = 50;
// oxlint-disable-next-line no-control-regex -- names never hold control characters
const NAME = /^[^\u0000-\u001f]{1,80}$/;
export const ownFolder = (dotId: string) => `dots/${dotId}/`;

/**
 * The user's data space (`LegacyData`): datasets (one SQLite file each,
 * in the user's directory, never the app's database), files (sealed with
 * the data key, or legacy ones with a key from SESSION_SECRET), grants, audit, quotas, retention, and
 * the scoped tokens computers use. Every operation by a Dot or a token is
 * rate-limited, size-checked and audited, bypass policies included.
 */
export class DataSpace implements DataSpaceShape {
    /** The limits in force: an admin's, over the environment's, over the defaults. */
    get limits(): DataLimits {
        return {
            ...DEFAULT_DATA_LIMITS,
            ...this.options.limits,
            ...this.options.overrides?.(),
        };
    }
    readonly tokens: DataTokens;
    /** Admins' data API tokens: made in Settings, resolved on the data tokens' path. */
    readonly apiTokens: DataApiTokens;
    readonly engine: DatasetEngine;
    /** The analytics process for analytical tables (CB-369). */
    readonly analytics: DatasetAnalytics;
    /** One analytical commit per owner at a time, so the budget check holds. */
    private analyticalLocks = new Map<string, Promise<unknown>>();
    private runner = new QueryRunner();
    private box: SecretBox;
    private rate = new Map<string, number[]>();
    private appGrants?: (appId: string) => Array<{ datasetId: string; access: GrantAccess; ref: string }>;
    private appDelegation?: AppDataDelegation;
    private conversationReads?: (userId: string, path: string, threadId: string) => Promise<boolean>;
    /**
     * Room batches in flight may still take, by dataset: a person's batch
     * runs in another process, so until it commits its growth is held here,
     * and nothing else of that person's (another batch, a write) may count
     * on the same free space. A person's batch holds their lock, as their
     * file writes do, so one of either runs at a time.
     */
    private batchHolds = new Map<string, { owner: string; bytes: number }>();
    /** What the plugins declare (the composition wires it); none: no plugin datasets reach a token. */
    private pluginSource?: PluginDatasetSource;
    private deletedListeners: FileDeletedListener[] = [];
    /** Where new files go, and the local disk older rows may still name. */
    readonly objects: ObjectStore;
    readonly legacy: LocalObjectStoreShape;
    readonly tenantId: string;
    private storageReachable = true;
    private locks = new Map<string, Promise<void>>();
    private migration?: Promise<LocalMigrationResult>;
    private resealing?: Promise<ResealResult>;
    private swept = false;
    private closed = false;
    /** When this runtime last ran the nightly row-history work (`maintainHistory`). */
    private historyRunAt = 0;
    private sizeDays: DatasetSizeDays;
    /** Its writes to its own tables (CB-110). */
    private repos: DataSpaceRepositories;
    constructor(
        private db: DatabaseSync,
        private options: DataSpaceOptions,
    ) {
        this.repos = sqliteDataSpaceRepositories(sqliteData(db));
        this.sizeDays = new SqliteDatasetSizeDays(db);
        this.tokens = new DataTokens(options.tokenTtlMs, options.runtime && { ownership: options.runtime });
        this.apiTokens = new DataApiTokens(this.repos.apiTokens, {
            activeAdmin: (userId) => {
                // The sign-in provider's people (effective role, deactivated
                // left out) when wired; else the workspace's record.
                const active = this.activeUsers?.();
                if (active) {
                    const user = active.find((entry) => entry.id === userId);
                    return !!user && isAdmin(user);
                }
                return this.isAdminId(userId) && !options.workspace.deactivated?.(userId);
            },
            deactivatedSince: (userId, at) => this.deactivatedSince(userId, at),
            userName: (userId) => options.workspace.users().find((user) => user.id === userId)?.name ?? null,
            audit: (line) => options.workspace.audit?.(line),
            budgetMax: PLUGIN_BUDGET_MAX,
        });
        this.tokens.useApiTokens(this.apiTokens);
        // A deactivated person's socios' tokens open nothing (CB-528).
        this.tokens.useDeactivated((userId) => !!options.workspace.deactivated?.(userId));
        this.engine = new DatasetEngine(this.runner);
        this.analytics = new DatasetAnalytics(options.analyticsMode ?? 'off', { log: (line) => console.log(line) });
        // Analytical tables wait, during a deploy, until every runtime knows
        // their catalog (CB-369): an older one would show it as tables.
        options.runtime?.recordContract(ANALYTICS_CONTRACT, ANALYTICS_CONTRACT_VERSION);
        // Plugin datasets move to the workspace owner only once no runtime
        // of the previous release, which finds them by `plugin:<id>`, runs (CB-451).
        options.runtime?.recordContract(WORKSPACE_DATASETS_CONTRACT, WORKSPACE_DATASETS_CONTRACT_VERSION);
        this.box = new SecretBox(options.secret, 'data-files');
        this.legacy = options.legacy;
        this.objects = options.objects ?? this.legacy;
        this.tenantId = options.tenantId ?? 'main';
        this.registerApprovals();
    }
    get dir() {
        return this.options.dir;
    }
    /** Who may sign in now, with their effective role (the auth provider's `users`). */
    private activeUsers?: () => readonly User[];
    useActiveUsers(users: () => readonly User[]) {
        this.activeUsers = users;
    }
    /** A `deactivate` line about this person in the workspace audit at or after `at`. */
    private deactivatedSince(userId: string, at: number) {
        try {
            return !!this.db
                .prepare(
                    "SELECT 1 FROM workspace_audit WHERE targetKind='user' AND targetId=? AND action='deactivate' AND createdAt>=? LIMIT 1",
                )
                .get(userId, at);
        } catch {
            // No workspace audit on this connection (a stand-in): the role check stands alone.
            return false;
        }
    }
    /** Revokes every live data API token a person made (deactivated, or no longer an admin). */
    revokeApiTokensMadeBy(userId: string, by: string, why = 'its maker was deactivated'): string[] {
        return this.apiTokens.revokeMadeBy(userId, by, why);
    }
    /** Revokes every live data API token whose maker is no longer an active admin; their names. */
    revokeApiTokensOfFormerAdmins(): string[] {
        return this.apiTokens.revokeWhereMakerInactive();
    }
    /** A data API token's usage read: its company's usage, counted against its budget. */
    tokenUsage(actor: AgentActor): DataUsageView {
        if (apiToken(actor)) {
            this.limitRate(actor);
        }
        return this.usage(dataOwner(actor));
    }
    close() {
        this.closed = true;
        try {
            this.apiTokens.flush();
        } catch {
            // The connection may be gone already: the counts stay in the rows.
        }
        this.runner.close();
        void this.analytics.close();
    }

    // ---- paths and rows -------------------------------------------------
    userDir(userId: string) {
        return join(this.options.dir, userDirName(userId));
    }
    datasetPath(row: Pick<DatasetRow, 'id' | 'ownerUserId'>) {
        return join(this.userDir(row.ownerUserId), 'datasets', `${row.id}.sqlite`);
    }
    /** A live dataset; a deleted one is missing (CB-64). */
    private row(id: string) {
        return this.db.prepare(`SELECT * FROM data_datasets WHERE id=? AND ${LIVE}`).get(id) as DatasetRow | undefined;
    }
    /** A dataset, deleted or not, with its stamp (admin, tests). */
    withDeletedDataset(id: string) {
        return this.db.prepare('SELECT * FROM data_datasets WHERE id=?').get(id) as DatasetRow | undefined;
    }
    /**
     * The rows writes replaced in one of a dataset's tables, oldest first, with
     * who replaced them: for the admin view, which isn't built; only tests call
     * it. Deleted datasets too.
     */
    withHistoryRows(datasetId: string, table: string) {
        const row = this.withDeletedDataset(datasetId);
        if (!row) {
            throw new DataError('Dataset not found.', 404);
        }
        return this.engine.withHistoryOf(this.datasetPath(row), table);
    }
    private ownRows(userId: string) {
        return this.db
            .prepare(
                `SELECT * FROM data_datasets WHERE ownerUserId=? AND ${LIVE} ORDER BY scratchForDotId IS NULL, name, createdAt`,
            )
            .all(userId) as unknown as DatasetRow[];
    }
    private dotName(dotId: string | null) {
        return dotId ? (this.options.workspace.dot(dotId)?.name ?? null) : null;
    }
    private view(row: DatasetRow, viewer: string): DatasetView {
        // An admin manages the company's datasets as their owner (`manages`).
        const owner = this.manages(viewer, row);
        // The plugin that writes it (CB-451), or a `plugin:<id>` owner not moved yet.
        const company = isCompanyOwner(row.ownerUserId);
        const bindings = company ? this.repos.bindings.liveForDataset(row.id) : [];
        const writer = bindings.find((binding) => binding.access === 'write')?.pluginId;
        const was = company && !writer ? this.repos.bindings.lastWriters([row.id]).get(row.id)?.pluginId : undefined;
        // A `plugin:<id>` dataset not bound yet (before the boot step) is still its plugin's.
        const plugin = writer ?? (was ? undefined : pluginOfOwner(row.ownerUserId));
        const readers = owner ? [...new Set(bindings.filter((b) => b.access === 'read').map((b) => b.pluginId))] : [];
        // A company socio's shared dataset (CB-229): no person's. A workspace
        // dataset in its area (CB-354) is no person's either, but only read
        // here: the shared area's clean-up acts on its shared dataset alone.
        const shared = reservedUserId(row.ownerUserId) && !!row.scratchForDotId;
        const workspace = reservedUserId(row.ownerUserId) && !row.scratchForDotId;
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            kind: row.scratchForDotId ? 'scratch' : 'dataset',
            ownerUserId: row.ownerUserId,
            ...(owner || shared
                ? {}
                : {
                      ownerName: plugin
                          ? `the ${this.pluginName(plugin)} plugin`
                          : workspace || isWorkspaceOwner(row.ownerUserId)
                            ? 'the workspace'
                            : (this.options.workspace.users().find((user) => user.id === row.ownerUserId)?.name ??
                              'Another user'),
                  }),
            createdByDotId: row.createdByDotId,
            scratchForDotId: row.scratchForDotId,
            dotName: this.dotName(row.scratchForDotId ?? row.createdByDotId),
            fromDeletedDot: !!row.dotDeletedAt,
            sharedSpaceId: row.sharedSpaceId,
            ...(row.sharedSpaceId ? { spaceParentId: row.spaceParentId ?? null } : {}),
            retentionDays: row.retentionDays,
            sizeBytes: row.sizeBytes,
            ...(owner
                ? {
                      historyBytes: row.historyBytes,
                      ...(row.analyticalBytes ? { analyticalBytes: row.analyticalBytes } : {}),
                      historyDays: row.historyDays ?? null,
                      compactRequestedAt: row.compactRequestedAt ?? null,
                  }
                : {}),
            tableCount: row.tableCount,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            access: owner ? 'owner' : shared ? 'shared' : 'read',
            ...(plugin ? { plugin: { id: plugin, name: this.pluginName(plugin) } } : {}),
            ...(was ? { wasWrittenBy: { id: was, name: this.pluginName(was) } } : {}),
            ...(readers.length ? { readers: readers.map((id) => ({ id, name: this.pluginName(id) })) } : {}),
        };
    }
    /** A plugin's name while it is installed, else its id. */
    private pluginName(pluginId: string) {
        return this.pluginSource?.name(pluginId) ?? pluginId;
    }
    /** Whether a user id is an admin's now. */
    private isAdminId(userId: string) {
        const user = this.options.workspace.users().find((entry) => entry.id === userId);
        return !!user && isAdmin(user);
    }
    /**
     * Whether a person manages a dataset as its owner: their own, or, for an
     * admin, a service plugin's (`plugin:<id>`), which is the company's.
     */
    private manages(userId: string, row: Pick<DatasetRow, 'ownerUserId'>) {
        return row.ownerUserId === userId || (isCompanyOwner(row.ownerUserId) && this.isAdminId(userId));
    }
    /** A live dataset the person manages (`manages`), or the same 404 as a missing one. */
    private managedRow(userId: string, id: string) {
        const row = this.row(id);
        if (!row || !this.manages(userId, row)) {
            throw new DataError('Dataset not found.', 404);
        }
        return row;
    }
    /**
     * Records a dataset's sizes after the engine's own maintenance (a prune,
     * a compaction, CB-369): not a change, so `updatedAt`, which retention
     * reads, stays as the last write left it.
     */
    private remeasure(row: DatasetRow) {
        const path = this.datasetPath(row);
        const { sizeBytes, historyBytes } = this.engine.sizes(path, row);
        const tableCount = this.engine.tableCount(path);
        this.repos.datasets.recordSizesNow(row.id, { sizeBytes, historyBytes, tableCount });
        this.sizeDays.record({ datasetId: row.id, sizeBytes, historyBytes, tableCount, measuredAt: Date.now() });
    }
    /** Records a dataset's sizes (as a write measured them) and its change. */
    private touch(row: DatasetRow, sizes?: DatasetSizes) {
        const path = this.datasetPath(row);
        const { sizeBytes, historyBytes } = sizes ?? this.engine.sizes(path, row);
        const tableCount = this.engine.tableCount(path);
        const now = Date.now();
        // Queued behind another chain's unit of work, if one is open (CB-110).
        this.repos.datasets.recordSizes(row.id, { sizeBytes, historyBytes, tableCount }, now);
        // The day's sizes, for Operations over time (CB-191).
        this.sizeDays.record({
            datasetId: row.id,
            sizeBytes,
            historyBytes,
            tableCount,
            measuredAt: now,
        });
    }

    // ---- audit, rate, quota ---------------------------------------------
    /**
     * Records what an actor did. `area`: the company socio's shared area the
     * row is about (CB-229), whoever acted; by default the one a shared
     * computer or a copy into it reaches, or the area that is the owner.
     */
    audit(
        actor: DataActor | { kind: 'system'; userId: string },
        action: string,
        outcome: DataAuditEntry['outcome'],
        fields: {
            datasetId?: string | null;
            target?: string | null;
            detail?: string | null;
            area?: string | null;
        } = {},
    ) {
        const now = Date.now();
        const area =
            fields.area !== undefined
                ? fields.area
                : actor.kind !== 'system' && socioReach(actor)
                  ? sharedOwner((actor as AgentActor).dotId)
                  : nonPersonOwnerId(actor.userId)
                    ? actor.userId
                    : null;
        // A plugin's own work is the plugin's, with no socio behind it.
        const plugin = actor.kind !== 'system' && pluginToken(actor) ? actor.pluginId : undefined;
        // A data API token's is the token's, attributed to its maker.
        const api = actor.kind !== 'system' && apiToken(actor) ? actor.apiToken : undefined;
        // Queued behind another chain's unit of work, if one is open (CB-110).
        this.repos.audit.record({
            id: randomUUID(),
            ownerUserId: actor.userId,
            actorKind: plugin ? 'plugin' : actor.kind,
            actorId:
                plugin ??
                (api
                    ? dataApiTokenActor(api.id)
                    : actor.kind === 'user'
                      ? actor.userId
                      : actor.kind === 'system'
                        ? null
                        : actor.dotId),
            dotId: !plugin && !api && (actor.kind === 'dot' || actor.kind === 'token') ? actor.dotId : null,
            byUserId: api?.createdBy ?? null,
            datasetId: fields.datasetId ?? null,
            target: fields.target?.slice(0, 200) ?? null,
            action,
            outcome,
            detail: fields.detail?.slice(0, 300) ?? null,
            createdAt: now,
            area,
            // The chat a socio's tool acted in (CB-194).
            threadId: actor.kind === 'dot' ? (actor.threadId ?? null) : null,
        });
    }
    auditFor(userId: string, filter: { datasetId?: string; limit?: number } = {}): DataAuditEntry[] {
        const limit = Math.min(filter.limit ?? 200, 1000);
        // A plugin's dataset, for an admin who manages it: everything
        // recorded about it, the plugin's own writes and every admin's.
        const plugin = filter.datasetId ? this.row(filter.datasetId) : undefined;
        const all = !!plugin && isCompanyOwner(plugin.ownerUserId) && this.manages(userId, plugin);
        const rows = (all
            ? this.db
                  .prepare('SELECT * FROM data_audit WHERE datasetId=? ORDER BY createdAt DESC, rowid DESC LIMIT ?')
                  .all(plugin.id, limit)
            : this.db
                  .prepare(
                      `SELECT * FROM data_audit WHERE ownerUserId=?${filter.datasetId ? ' AND datasetId=?' : ''} ORDER BY createdAt DESC, rowid DESC LIMIT ?`,
                  )
                  .all(
                      ...(filter.datasetId ? [userId, filter.datasetId, limit] : [userId, limit]),
                  )) as unknown as Array<DataAuditEntry & { ownerUserId: string; area: string | null }>;
        return rows.map(({ ownerUserId: _owner, area: _area, ...entry }) => ({
            ...entry,
            dotName: this.dotName(entry.dotId),
        }));
    }
    /**
     * Where promoted mini apps' grants come from (the apps module): a
     * token with an `appId` sees exactly these of its user's datasets.
     */
    useAppGrants(grants: (appId: string) => Array<{ datasetId: string; access: GrantAccess; ref: string }>) {
        this.appGrants = grants;
    }
    /**
     * What the apps module says about an app's delegation contract and its
     * people (CB-232), for the data API's on-behalf-of check
     * (`obo.ts`). Unset, no app declares the contract and no `x-cb-obo` is
     * accepted: the check fails closed.
     */
    useAppDelegation(delegation: AppDataDelegation) {
        this.appDelegation = delegation;
    }
    get delegation(): AppDataDelegation | undefined {
        return this.appDelegation;
    }

    // ---- plugin datasets: workspace datasets bound to plugin needs (CB-451) ----
    /**
     * What the plugins declare (the composition wires it, `plugin-datasets.ts`):
     * which datasets a plugin's installed manifest needs, and its name.
     */
    usePluginDatasets(source: PluginDatasetSource) {
        this.pluginSource = source;
    }
    /** The actor a plugin's own work runs as: its token's, with no socio behind it. */
    private pluginActor(pluginId: string): AgentActor {
        return { kind: 'token', purpose: 'plugin', userId: pluginOwnerId(pluginId), dotId: '', pluginId };
    }
    /** The installed manifest's need of that name (any case). */
    private declaredNeed(pluginId: string, need: string) {
        return (this.pluginSource?.declared(pluginId) as ReadonlyArray<DeclaredPluginDataset> | undefined)?.find(
            (item) => item.name.toLowerCase() === need.toLowerCase(),
        );
    }
    /** A dataset's live `write` binding: the one plugin that writes it. */
    private liveWriter(datasetId: string) {
        return this.repos.bindings.liveForDataset(datasetId).find((binding) => binding.access === 'write');
    }
    /**
     * The live company datasets a need may bind to, by name: the
     * workspace's, and `plugin:<id>` ones not moved to it yet (CB-451).
     */
    private workspaceRows() {
        return this.db
            .prepare(`SELECT * FROM data_datasets WHERE ${COMPANY_OWNERS} AND ${LIVE} ORDER BY name, createdAt`)
            .all() as unknown as DatasetRow[];
    }
    /**
     * Whether a runtime of the previous release still runs (a deploy): it
     * finds a plugin's datasets by their `plugin:<id>` owner and name, so
     * until it stops they keep that owner, new ones included (CB-451).
     */
    private workspaceDatasetsBehind() {
        return !!this.options.runtime?.contractBehind(WORKSPACE_DATASETS_CONTRACT, WORKSPACE_DATASETS_CONTRACT_VERSION);
    }
    /**
     * Why a dataset can't serve a plugin's need now; undefined when it can.
     * A `write` need: no other plugin writes it, today's additive rule takes
     * its declared tables, and every plugin bound to read it keeps what it
     * expects. A `read` need: every expected table and column is there, of a
     * type that reads as the one expected.
     */
    private needProblem(pluginId: string, declared: DeclaredPluginDataset, row: DatasetRow): string | undefined {
        if (pluginNeedAccess(declared) === 'read') {
            const problems = readProblems(declared.tables, this.tablesOf(row));
            return problems.length
                ? `“${row.name}” doesn’t have what the need expects: ${problems.join('; ')}.`
                : undefined;
        }
        const writer = this.liveWriter(row.id);
        if (writer && writer.pluginId !== pluginId) {
            return `“${row.name}” is written by ${this.pluginName(writer.pluginId)}, and a dataset has one writer.`;
        }
        const broken = this.readersBroken(row, declared.tables, pluginId);
        if (broken) {
            return broken;
        }
        try {
            if (declared.tables?.length) {
                this.ensureDeclaredTables(this.pluginActor(pluginId), row, declared.tables, false);
            }
        } catch (error) {
            return error instanceof Error ? error.message : 'Its tables don’t fit the need.';
        }
        return undefined;
    }
    /**
     * Whether a writer's declared tables would break a plugin bound to read
     * the dataset (dropping or retyping a column it expects; additive
     * changes never do): the refusal naming that reader, or undefined.
     */
    private readersBroken(
        row: DatasetRow,
        declared: readonly PluginDatasetTable[] | undefined,
        writerPluginId: string,
    ): string | undefined {
        const readers = this.repos.bindings
            .liveForDataset(row.id)
            .filter((binding) => binding.access === 'read' && binding.pluginId !== writerPluginId);
        if (!readers.length || !declared?.length) {
            return undefined;
        }
        const after = tablesAfter(this.tablesOf(row), declared);
        for (const reader of readers) {
            const problems = readProblems(this.declaredNeed(reader.pluginId, reader.need)?.tables, after);
            if (problems.length) {
                return `This change to “${row.name}” would break ${this.pluginName(reader.pluginId)}, which reads it (its need “${reader.need}”): ${problems.join('; ')}. An admin unbinds that reader first.`;
            }
        }
        return undefined;
    }
    /**
     * Refuses a write to a dataset a plugin writes, by anyone but that
     * plugin (one writer per dataset): people, socios and apps
     * read it through grants and Space sharing. Admins still delete or unbind.
     */
    private refuseNonWriter(actor: DataActor, row: DatasetRow, action: string) {
        const writer = this.liveWriter(row.id);
        if (!writer || (pluginToken(actor) && actor.pluginId === writer.pluginId)) {
            return;
        }
        const name = this.pluginName(writer.pluginId);
        this.audit(actor, action, 'denied', {
            area: row.ownerUserId,
            datasetId: row.id,
            target: row.name,
            detail: `written by ${name}`,
        });
        throw new DataError(
            `Written by ${name}: only that plugin writes “${row.name}”. Read it through grants and Space sharing.`,
            403,
        );
    }
    /** Ends a binding (rebind, unbind, uninstall, the dataset deleted), audited; the plugin's tokens end with it. */
    private endBinding(binding: PluginBinding, by: string, why: string) {
        if (!this.repos.bindings.unbindNow(binding.id, Date.now())) {
            return;
        }
        const row = this.withDeletedDataset(binding.datasetId);
        this.audit({ kind: 'system', userId: WORKSPACE_OWNER_ID }, 'plugin_unbind', 'ok', {
            area: WORKSPACE_OWNER_ID,
            datasetId: binding.datasetId,
            target: row?.name ?? binding.datasetId,
            detail: `${this.pluginName(binding.pluginId)} “${binding.need}” (${binding.access}) unbound by ${by}: ${why}`,
        });
        this.revokePluginTokens(binding.pluginId);
    }
    /**
     * Binds one need to a new workspace dataset (`write` needs only) or an
     * existing one it fits (`needProblem`), audited. The unique indexes
     * refuse a second writer or a second binding of the need, whatever ran
     * meanwhile.
     */
    private bindNeed(
        pluginId: string,
        declared: DeclaredPluginDataset,
        choice: Exclude<PluginBindingChoice, null>,
        by: string,
    ): PluginBinding {
        const access = pluginNeedAccess(declared);
        let row: DatasetRow;
        if (choice === 'new') {
            if (access === 'read') {
                throw new DataError(
                    `“${declared.name}” is a read need: bind it to an existing dataset, or leave it unbound.`,
                    409,
                );
            }
            // The workspace's; its plugin's own while the previous release
            // still runs, so that release finds it too (moved later).
            const made = this.createDataset(
                this.workspaceDatasetsBehind() ? pluginOwnerId(pluginId) : WORKSPACE_OWNER_ID,
                { name: declared.name, description: declared.description ?? '' },
                this.pluginActor(pluginId),
            );
            row = this.row(made.id)!;
        } else {
            const found = this.row(choice.datasetId);
            if (!found || !isCompanyOwner(found.ownerUserId)) {
                throw new DataError('No workspace dataset with that id.', 404);
            }
            const problem = this.needProblem(pluginId, declared, found);
            if (problem) {
                throw new DataError(problem, 409);
            }
            row = found;
        }
        const binding: PluginBinding = {
            id: randomUUID(),
            pluginId,
            need: declared.name,
            datasetId: row.id,
            access,
            boundBy: by,
            boundAt: Date.now(),
            unboundAt: null,
        };
        try {
            this.repos.bindings.bindNow(binding);
        } catch (error) {
            if (error instanceof Error && /UNIQUE/i.test(error.message)) {
                const writer = this.liveWriter(row.id);
                throw new DataError(
                    writer && writer.pluginId !== pluginId
                        ? `“${row.name}” is written by ${this.pluginName(writer.pluginId)}, and a dataset has one writer.`
                        : `The need “${declared.name}” is bound already.`,
                    409,
                );
            }
            throw error;
        }
        this.audit({ kind: 'system', userId: WORKSPACE_OWNER_ID }, 'plugin_bind', 'ok', {
            area: WORKSPACE_OWNER_ID,
            datasetId: row.id,
            target: row.name,
            detail: `${this.pluginName(pluginId)} “${declared.name}” (${access}) bound by ${by}${choice === 'new' ? ', new dataset' : ''}`,
        });
        return binding;
    }
    /** Whether a choice keeps a need's live binding as it is. */
    private keeps(live: PluginBinding | undefined, choice: PluginBindingChoice) {
        return choice === null ? !live : choice !== 'new' && live?.datasetId === choice.datasetId;
    }
    /**
     * Binds what a plugin's manifest needs (CB-451): install, enable and
     * update. `choices` are the admin's, at install or on the plugin's
     * page; without one, a need keeps its live binding, an unbound `write`
     * need gets a new dataset (every need without `access`, as before), and
     * an unbound `read` need stays unbound. A `write` need's declared tables
     * are made additively. Bindings of needs the manifest no longer declares
     * end. Never deletes a dataset. Checked whole first (`checkPluginDatasets`),
     * so a refusal changes nothing. Returns the bound needs.
     *
     * `staged`: a manifest not adopted yet (an update before its service
     * runs): only what it adds is bound (new needs, tables); removals and
     * access changes wait for its adoption, which calls this again without
     * it, and a failed update calls it with the installed manifest. Until
     * then the installed manifest's access is the ceiling (`pluginRows`).
     */
    ensurePluginDatasets(
        pluginId: string,
        datasets: ReadonlyArray<DeclaredPluginDataset>,
        options: { choices?: PluginBindingChoices; by?: string; staged?: boolean } = {},
    ) {
        this.checkPluginDatasets(pluginId, datasets, options.choices);
        const by = options.by ?? 'system';
        const actor = this.pluginActor(pluginId);
        const deferred: Array<() => void> = [];
        const declaredNames = new Set(datasets.map((item) => item.name.toLowerCase()));
        for (const binding of options.staged ? [] : this.repos.bindings.liveForPlugin(pluginId)) {
            if (!declaredNames.has(binding.need.toLowerCase())) {
                this.endBinding(binding, by, 'the manifest no longer declares it');
            }
        }
        const out: PluginTokenNeed[] = [];
        for (const declared of datasets) {
            const access = pluginNeedAccess(declared);
            let live = this.repos.bindings
                .liveForPlugin(pluginId)
                .find((binding) => binding.need.toLowerCase() === declared.name.toLowerCase());
            if (live && live.access !== access && !options.staged) {
                // The manifest changed the need's access: the same dataset if it
                // still fits, else as a new need.
                const datasetId = live.datasetId;
                this.endBinding(live, by, `the manifest now declares ${access} access`);
                live = undefined;
                const row = this.row(datasetId);
                if (row && isCompanyOwner(row.ownerUserId) && !this.needProblem(pluginId, declared, row)) {
                    live = this.bindNeed(pluginId, declared, { datasetId }, by);
                }
            }
            const choice =
                options.choices && Object.hasOwn(options.choices, declared.name)
                    ? options.choices[declared.name]
                    : undefined;
            let binding = live;
            if (choice !== undefined && !this.keeps(live, choice)) {
                if (live) {
                    this.endBinding(live, by, 'rebound');
                }
                binding = choice === null ? undefined : this.bindNeed(pluginId, declared, choice, by);
            } else if (!live && access === 'write') {
                binding = this.bindNeed(pluginId, declared, 'new', by);
            }
            const row = binding && this.row(binding.datasetId);
            if (!binding || !row) {
                continue;
            }
            if (binding.access === 'write' && access === 'write' && declared.tables?.length) {
                this.ensureDeclaredTables(actor, row, declared.tables, true, deferred);
                this.ensureDeclaredFields(actor, this.row(row.id) ?? row, declared.tables);
            }
            out.push({
                name: declared.name,
                access: binding.access === 'write' && access === 'write' ? 'write' : 'read',
                id: row.id,
                datasetName: row.name,
                description: row.description,
            });
        }
        // What may lose data later (a shorter retention, history off) only
        // once every table and column is made (CB-387).
        for (const change of deferred) {
            change();
        }
        return out;
    }
    /**
     * Checks what `ensurePluginDatasets` would do with a manifest's needs
     * and the admin's choices, changing nothing (CB-387, CB-451): each
     * chosen dataset fits its need, each bound `write` need's declared
     * tables pass the additive rule and break no reader, each bound `read`
     * need still finds what it expects, and a new dataset's declared tables
     * are ones the engine makes. Run before any change, and on its own for
     * a disabled plugin's update.
     */
    checkPluginDatasets(
        pluginId: string,
        datasets: ReadonlyArray<DeclaredPluginDataset>,
        choices?: PluginBindingChoices,
    ) {
        const live = new Map(
            this.repos.bindings.liveForPlugin(pluginId).map((binding) => [binding.need.toLowerCase(), binding]),
        );
        const writing = new Set<string>();
        for (const declared of datasets) {
            const access = pluginNeedAccess(declared);
            const current = live.get(declared.name.toLowerCase());
            const choice = choices && Object.hasOwn(choices, declared.name) ? choices[declared.name] : undefined;
            const named = `The need “${declared.name}”`;
            let target: DatasetRow | 'new' | undefined;
            if (choice !== undefined && !this.keeps(current, choice)) {
                if (choice === null) {
                    if (access === 'write') {
                        throw new DataError(
                            `${named} writes: bind it to a new dataset or an existing one; only a read need may stay unbound.`,
                            409,
                        );
                    }
                } else if (choice === 'new') {
                    if (access === 'read') {
                        throw new DataError(
                            `${named} reads: bind it to an existing dataset, or leave it unbound.`,
                            409,
                        );
                    }
                    target = 'new';
                } else {
                    const row = this.row(choice.datasetId);
                    if (!row || !isCompanyOwner(row.ownerUserId)) {
                        throw new DataError(`${named}: no workspace dataset with that id.`, 404);
                    }
                    const problem = this.needProblem(pluginId, declared, row);
                    if (problem) {
                        throw new DataError(`${named}: ${problem}`, 409);
                    }
                    target = row;
                }
            } else if (current) {
                const row = this.row(current.datasetId);
                if (row) {
                    if (access === 'read') {
                        // The reader's own manifest update: it must still fit.
                        const problems = readProblems(declared.tables, this.tablesOf(row));
                        if (problems.length) {
                            throw new DataError(
                                `${named} would no longer fit “${row.name}”, which it is bound to: ${problems.join('; ')}.`,
                                409,
                            );
                        }
                    } else {
                        const broken = this.readersBroken(row, declared.tables, pluginId);
                        if (broken) {
                            throw new DataError(broken, 409);
                        }
                        target = row;
                    }
                }
            } else if (access === 'write') {
                target = 'new';
            }
            if (access !== 'write' || !target) {
                continue;
            }
            if (target !== 'new') {
                if (writing.has(target.id)) {
                    throw new DataError(
                        `Two of the plugin’s write needs name “${target.name}”; a dataset has one writer.`,
                        409,
                    );
                }
                writing.add(target.id);
                if (declared.tables?.length) {
                    this.ensureDeclaredTables(this.pluginActor(pluginId), target, declared.tables, false);
                }
            } else if (declared.tables?.length) {
                // A new dataset's tables, as the engine will check them.
                for (const table of declared.tables) {
                    if (table.kind === 'analytical') {
                        this.engine.checkAnalyticalDeclaration(declaredAnalyticalInput(table));
                    } else {
                        this.engine.checkCreateTable({
                            table: table.table,
                            columns: engineColumns(table.columns),
                        });
                    }
                }
                if (declared.tables.some((table) => table.kind === 'analytical')) {
                    this.analyticalTablesAvailable();
                }
            }
        }
    }
    /**
     * Ends every live binding of a plugin (uninstall, or an install that
     * failed after binding): its datasets stay, the workspace's, bindable to
     * another plugin; reinstalling offers them again (`pluginBindingPlan`).
     */
    unbindPlugin(pluginId: string, by = 'system') {
        for (const binding of this.repos.bindings.liveForPlugin(pluginId)) {
            this.endBinding(binding, by, 'uninstalled');
        }
        this.revokePluginTokens(pluginId);
    }
    /**
     * Rebinds or unbinds one need of an installed plugin, an admin's act on
     * its page: `new` or a dataset id, or null to unbind a `read` need.
     */
    bindPluginNeed(
        pluginId: string,
        datasets: ReadonlyArray<DeclaredPluginDataset>,
        need: string,
        choice: PluginBindingChoice,
        by: string,
    ) {
        const declared = datasets.find((item) => item.name.toLowerCase() === need.toLowerCase());
        if (!declared) {
            throw new DataError(`This plugin declares no need named “${need}”.`, 404);
        }
        this.ensurePluginDatasets(pluginId, datasets, { choices: { [declared.name]: choice }, by });
        return this.pluginBindingPlan(pluginId, datasets, true).needs.find((item) => item.need === declared.name)!;
    }
    /**
     * Each need of a plugin's manifest with its binding now, the one it had
     * before (offered preselected on reinstall; nothing is taken back
     * silently), and every live workspace dataset it could bind to, each
     * with why it doesn't fit when it doesn't. For the install screen and
     * the plugin's page.
     */
    pluginBindingPlan(
        pluginId: string,
        datasets: ReadonlyArray<DeclaredPluginDataset>,
        installed: boolean,
    ): PluginBindingPlan {
        const live = this.repos.bindings.liveForPlugin(pluginId);
        const ended = this.repos.bindings.endedForPlugin(pluginId);
        const rows = this.workspaceRows().filter((row) => existsSync(this.datasetPath(row)));
        const needs = datasets.map((declared): PluginNeedPlan => {
            const access = pluginNeedAccess(declared);
            const same = (binding: PluginBinding) => binding.need.toLowerCase() === declared.name.toLowerCase();
            const current = live.find(same);
            const boundRow = current && this.row(current.datasetId);
            const candidates = rows
                .filter((row) => row.id !== boundRow?.id)
                .map((row) => {
                    const writer = this.liveWriter(row.id);
                    const problem = this.needProblem(pluginId, declared, row);
                    return {
                        id: row.id,
                        name: row.name,
                        description: row.description,
                        ...(writer ? { writer: { id: writer.pluginId, name: this.pluginName(writer.pluginId) } } : {}),
                        ...(problem ? { problem } : {}),
                    };
                });
            const before = current
                ? undefined
                : ended.filter(same).find((binding) => rows.some((row) => row.id === binding.datasetId));
            const previousRow = before && rows.find((row) => row.id === before.datasetId);
            const previousFits = !!previousRow && !candidates.find((item) => item.id === previousRow.id)?.problem;
            return {
                need: declared.name,
                access,
                implicit: !declared.access,
                description: declared.description ?? '',
                tables: (declared.tables ?? []).map((table) => ({
                    table: table.table,
                    columns: table.columns.map((column) => ({
                        name: column.name,
                        type: (column.type ?? 'TEXT').toUpperCase(),
                    })),
                })),
                ...(current && boundRow
                    ? {
                          bound: {
                              datasetId: boundRow.id,
                              datasetName: boundRow.name,
                              boundBy: current.boundBy,
                              boundAt: current.boundAt,
                          },
                      }
                    : {}),
                ...(previousRow ? { previous: { datasetId: previousRow.id, datasetName: previousRow.name } } : {}),
                candidates,
                preselected:
                    current && boundRow
                        ? { datasetId: boundRow.id }
                        : previousRow && previousFits
                          ? { datasetId: previousRow.id }
                          : access === 'write'
                            ? 'new'
                            : null,
            };
        });
        return { pluginId, installed, needs };
    }
    /**
     * CB-451's migration of `plugin:<id>` datasets, a boot step that the
     * hourly run repeats, in two steps a rolling upgrade can take: first each
     * one its installed plugin declares by name is bound `write` to it,
     * keeping its owner and file, which a runtime of the previous release
     * finds it by; then, once no such runtime runs (the
     * `workspace-datasets` contract), each moves to the workspace owner,
     * keeping its id, grants, Space share, retention, history and audit,
     * its file (and analytical parts) moving as a transfer moves them.
     * Datasets of plugins no longer installed stay unbound. Idempotent and
     * safe to repeat after a crash part way. Audited per dataset.
     */
    adoptPluginOwnedDatasets() {
        const legacy = () =>
            this.db
                .prepare(
                    `SELECT * FROM data_datasets WHERE ownerUserId >= 'plugin:' AND ownerUserId < 'plugin;' AND ${LIVE} ORDER BY createdAt, id`,
                )
                .all() as unknown as DatasetRow[];
        // 1. Bind: a dataset no binding ever named, which its installed plugin
        // declares by name, is bound `write` to it. Its owner and file stay,
        // so a runtime of the previous release still finds it.
        let bound = 0;
        for (const row of legacy()) {
            const pluginId = pluginOfOwner(row.ownerUserId)!;
            const declared = this.declaredNeed(pluginId, row.name);
            if (!declared || pluginNeedAccess(declared) !== 'write' || this.repos.bindings.everBound(row.id)) {
                continue;
            }
            const taken = this.repos.bindings
                .liveForPlugin(pluginId)
                .some((binding) => binding.need.toLowerCase() === declared.name.toLowerCase());
            if (taken) {
                continue;
            }
            try {
                this.repos.bindings.bindNow({
                    id: randomUUID(),
                    pluginId,
                    need: declared.name,
                    datasetId: row.id,
                    access: 'write',
                    boundBy: 'system',
                    boundAt: Date.now(),
                });
            } catch {
                // Another runtime bound it meanwhile.
                continue;
            }
            bound++;
            this.audit({ kind: 'system', userId: WORKSPACE_OWNER_ID }, 'plugin_bind', 'ok', {
                area: WORKSPACE_OWNER_ID,
                datasetId: row.id,
                target: row.name,
                detail: `${this.pluginName(pluginId)} “${declared.name}” (write) bound by system: its dataset from before CB-451`,
            });
        }
        // 2. Move, once no runtime of the previous release runs: the owner
        // becomes the workspace's and the file moves to its directory.
        let moved = 0;
        if (this.workspaceDatasetsBehind()) {
            return { bound, moved };
        }
        if (this.options.workspace.users().some((user) => nonPersonOwnerId(user.id))) {
            console.warn(
                'Data space: a user id is a reserved owner id; plugin datasets stay where they are until it is renamed.',
            );
            return { bound, moved };
        }
        for (const row of legacy()) {
            const source = this.datasetPath(row);
            const target = this.datasetPath({ id: row.id, ownerUserId: WORKSPACE_OWNER_ID });
            let done = false;
            try {
                // A dataset with no file moves its row only (the health check reports it).
                const move = () => {
                    mkdirSync(dirname(target), { recursive: true });
                    for (const suffix of ['', '-journal', '-wal', '-shm']) {
                        if (existsSync(`${source}${suffix}`)) {
                            renameSync(`${source}${suffix}`, `${target}${suffix}`);
                        }
                    }
                    if (existsSync(partsDir(source))) {
                        renameSync(partsDir(source), partsDir(target));
                    }
                    // The row moves before the lock goes: a write waiting for
                    // it, on any runtime, reads the new path, and one that read
                    // the old row finds no file there and is refused, never
                    // written somewhere else.
                    return transactionSync(this.db, 'adopt plugin dataset', () => {
                        if (!this.repos.datasets.moveOwnerNow(row.id, row.ownerUserId, WORKSPACE_OWNER_ID)) {
                            return false;
                        }
                        this.repos.grants.moveDatasetOwnerNow(row.id, WORKSPACE_OWNER_ID);
                        return true;
                    });
                };
                // Under the file's write lock: no write is in flight while it moves (CB-451).
                done = existsSync(source) ? this.engine.whileLocked(source, move) : move();
            } catch (error) {
                console.warn(
                    `Data space: moving plugin dataset ${row.id} to the workspace failed (${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}); trying again at the next run.`,
                );
                continue;
            }
            if (!done) {
                continue;
            }
            moved++;
            this.audit({ kind: 'system', userId: WORKSPACE_OWNER_ID }, 'adopt_plugin_dataset', 'ok', {
                area: WORKSPACE_OWNER_ID,
                datasetId: row.id,
                target: row.name,
                detail: `moved from ${row.ownerUserId} to the workspace`,
            });
        }
        return { bound, moved };
    }
    /**
     * A plugin's declared tables (CB-369), additively: each missing table
     * is made, each missing declared column added, and a table declared
     * `history: false` loses its history triggers. An existing column of
     * another type refuses the install, naming it. Nothing is ever dropped.
     */
    private ensureDeclaredTables(
        actor: AgentActor,
        row: DatasetRow,
        tables: readonly PluginDatasetTable[],
        apply = true,
        deferred: Array<() => void> = [],
    ) {
        const path = this.datasetPath(row);
        const existing = new Map(this.engine.tables(path).map((table) => [table.name.toLowerCase(), table]));
        const analytical = new Map(
            this.engine.analyticalTables(path).map((table) => [table.name.toLowerCase(), table] as const),
        );
        for (const declared of tables) {
            if (declared.kind === 'analytical') {
                if (existing.has(declared.table.toLowerCase())) {
                    throw new DataError(
                        `Dataset "${row.name}", table "${declared.table}": it is a transactional table, the manifest declares an analytical one. A table's kind never changes.`,
                        409,
                    );
                }
                this.ensureDeclaredAnalytical(
                    actor,
                    row,
                    declared,
                    analytical.get(declared.table.toLowerCase()),
                    apply,
                );
                continue;
            }
            if (analytical.has(declared.table.toLowerCase())) {
                throw new DataError(
                    `Dataset "${row.name}", table "${declared.table}": it is an analytical table, the manifest declares a transactional one. A table's kind never changes.`,
                    409,
                );
            }
            const table = existing.get(declared.table.toLowerCase());
            if (!apply) {
                // What the engine would refuse, checked before anything changes.
                if (!table) {
                    this.engine.checkCreateTable({
                        table: declared.table,
                        columns: engineColumns(declared.columns),
                    });
                    continue;
                }
                let count = table.columns.length;
                for (const column of declared.columns) {
                    const have = table.columns.find((item) => item.name.toLowerCase() === column.name.toLowerCase());
                    const type = (column.type ?? 'TEXT').toUpperCase();
                    if (have && have.type.toUpperCase() !== type) {
                        throw new DataError(
                            `Dataset "${row.name}", table "${table.name}": column "${have.name}" is ${have.type || 'untyped'}, the manifest declares ${type}. Columns are never retyped.`,
                            409,
                        );
                    }
                    if (!have) {
                        try {
                            this.engine.checkAddColumn(engineColumn(column), count++);
                        } catch (error) {
                            throw new DataError(
                                `Dataset "${row.name}", table "${table.name}", column "${column.name}": ${error instanceof Error ? error.message : 'refused'}`,
                                409,
                            );
                        }
                    }
                }
                continue;
            }
            if (!table) {
                this.applyWrite(actor, this.row(row.id)!, {
                    op: 'create_table',
                    input: {
                        table: declared.table,
                        columns: engineColumns(declared.columns),
                        ...(declared.history === false ? { history: false } : {}),
                    },
                });
                continue;
            }
            for (const column of declared.columns) {
                const have = table.columns.find((item) => item.name.toLowerCase() === column.name.toLowerCase());
                const type = (column.type ?? 'TEXT').toUpperCase();
                if (have && have.type.toUpperCase() !== type) {
                    throw new DataError(
                        `Dataset "${row.name}", table "${table.name}": column "${have.name}" is ${have.type || 'untyped'}, the manifest declares ${type}. Columns are never retyped.`,
                        409,
                    );
                }
                if (!have) {
                    this.applyWrite(actor, this.row(row.id)!, {
                        op: 'add_column',
                        table: table.name,
                        column: engineColumn(column),
                    });
                }
            }
            if (declared.history === false && table.history !== false) {
                deferred.push(() => {
                    this.engine.setHistory(path, table.name, false, { writer: writerOf(actor) });
                    this.audit(actor, 'table_history', 'ok', {
                        area: row.ownerUserId,
                        datasetId: row.id,
                        target: `${row.name}.${table.name}`,
                        detail: 'row history off, as the manifest declares',
                    });
                });
            }
        }
    }
    /**
     * The field settings a plugin's manifest declares on the columns of a
     * dataset it writes (CB-451), applied like its columns: added
     * when the column has none, never overwriting one, so an admin's
     * change stays. A setting the column's type doesn't take is skipped
     * (the manifest's own check refuses it against the declared type).
     */
    private ensureDeclaredFields(actor: AgentActor, row: DatasetRow, tables: readonly PluginDatasetTable[]) {
        const pluginId = pluginToken(actor) ? actor.pluginId : undefined;
        if (!pluginId || !tables.some((table) => table.columns.some((column) => column.field))) {
            return;
        }
        const live = new Map(this.tablesOf(row).map((table) => [table.name.toLowerCase(), table]));
        for (const declared of tables) {
            const table = live.get(declared.table.toLowerCase());
            if (!table) {
                continue;
            }
            for (const { name, field } of declared.columns) {
                const column = field && table.columns.find((item) => item.name.toLowerCase() === name.toLowerCase());
                if (!field || !column || this.repos.fields.get(row.id, table.name, column.name)) {
                    continue;
                }
                const { kind, label, ...settings } = field;
                const check = checkFieldSetting(column, { kind, label, settings });
                if (!check.ok) {
                    continue;
                }
                const saved = this.repos.fields.saveNow(
                    {
                        datasetId: row.id,
                        tableName: table.name,
                        columnName: column.name,
                        kind: check.kind,
                        label: check.label,
                        settings: check.settings,
                        declaredBy: pluginId,
                        updatedBy: pluginOwnerId(pluginId),
                        updatedAt: Date.now(),
                    },
                    0,
                );
                if (saved) {
                    this.audit(actor, 'field_settings', 'ok', {
                        area: row.ownerUserId,
                        datasetId: row.id,
                        target: `${row.name}.${table.name}.${column.name}`,
                        detail: `${check.kind}, as the manifest declares`,
                    });
                }
            }
        }
    }
    /**
     * One declared analytical table (CB-387), additively: made when
     * missing; otherwise each missing declared column is added (nullable,
     * as older parts read it as null), and its retention follows the
     * manifest. A different partitioning, or a column of another type or
     * nullability, refuses the install, naming it. Nothing is dropped.
     */
    private ensureDeclaredAnalytical(
        actor: AgentActor,
        row: DatasetRow,
        declared: PluginDatasetTable,
        table: AnalyticalTable | undefined,
        apply = true,
    ) {
        const input = declaredAnalyticalInput(declared);
        // The same checks the API's declaration takes (types, the partition column).
        const want = this.engine.checkAnalyticalDeclaration(input);
        if (!table) {
            if (!apply) {
                this.analyticalTablesAvailable();
            } else {
                this.applyWrite(actor, this.row(row.id)!, {
                    op: 'create_table',
                    input: input as unknown as DataTableInput,
                });
            }
            return;
        }
        const named = `Dataset "${row.name}", analytical table "${table.name}"`;
        if (JSON.stringify(want.partitionBy) !== JSON.stringify(table.partitionBy)) {
            throw new DataError(
                `${named}: it is partitioned by ${table.partitionBy.column} (${table.partitionBy.grain}), the manifest declares ${want.partitionBy.column} (${want.partitionBy.grain}). Partitioning never changes.`,
                409,
            );
        }
        for (const column of want.columns) {
            const have = table.columns.find((item) => item.name.toLowerCase() === column.name.toLowerCase());
            if (have && (have.type !== column.type || !!have.notNull !== !!column.notNull)) {
                throw new DataError(
                    `${named}: column "${have.name}" is ${have.type}${have.notNull ? ' NOT NULL' : ''}, the manifest declares ${column.type}${column.notNull ? ' NOT NULL' : ''}. Columns are never retyped.`,
                    409,
                );
            }
            if (!have && column.notNull) {
                throw new DataError(
                    `${named}: a column added to an existing analytical table may be null; the manifest declares "${column.name}" NOT NULL.`,
                    409,
                );
            }
        }
        const adding = want.columns.filter(
            (column) => !table.columns.some((item) => item.name.toLowerCase() === column.name.toLowerCase()),
        ).length;
        if (table.columns.length + adding > MAX_COLUMNS) {
            throw new DataError(`${named}: a table holds at most ${MAX_COLUMNS} columns.`, 413);
        }
        if (!apply) {
            return;
        }
        for (const column of want.columns) {
            if (!table.columns.some((item) => item.name.toLowerCase() === column.name.toLowerCase())) {
                this.applyWrite(actor, this.row(row.id)!, {
                    op: 'add_column',
                    table: table.name,
                    column: { name: column.name, type: column.type } as DataColumnInput,
                });
            }
        }
        // Its retention isn't written here: the nightly run reads it from
        // the manifest the plugin has adopted (`declaredRetention`), so an
        // install or update that fails after this changes no retention.
    }
    /**
     * Records the retention of each analytical table a plugin's manifest
     * declares, once that manifest is adopted (CB-387): the catalog then
     * keeps the last adopted value when the manifest stops declaring the
     * table, or the plugin is uninstalled. Audited per change.
     */
    adoptPluginRetention(pluginId: string, datasets: ReadonlyArray<DeclaredPluginDataset>) {
        const actor = this.pluginActor(pluginId);
        // The datasets it writes: a reader's declaration sets no retention.
        const bindings = this.repos.bindings.liveForPlugin(pluginId).filter((binding) => binding.access === 'write');
        for (const declared of datasets) {
            const binding = bindings.find((item) => item.need.toLowerCase() === declared.name.toLowerCase());
            const row = binding && this.row(binding.datasetId);
            const path = row && this.datasetPath(row);
            if (!row || !path || !existsSync(path)) {
                continue;
            }
            for (const table of declared.tables ?? []) {
                if (table.kind !== 'analytical') {
                    continue;
                }
                const days = table.retainDays ?? null;
                try {
                    if (this.engine.setAnalyticalRetention(path, table.table, days)) {
                        // An admin's override wins until cleared (the owner's decision, CB-387).
                        const overridden = this.engine.analyticalTable(path, table.table)?.retainOverride !== undefined;
                        this.audit(actor, 'table_retention', 'ok', {
                            area: row.ownerUserId,
                            datasetId: row.id,
                            target: `${row.name}.${table.table}`,
                            detail: `${
                                days
                                    ? `partitions kept ${days} days, as the manifest declares`
                                    : 'no retention declared in the manifest'
                            }${overridden ? '; the admin’s override still applies' : ''}`,
                        });
                    }
                } catch (error) {
                    // The nightly run reads the adopted manifest anyway; this
                    // record matters only once the manifest stops declaring it.
                    console.warn(
                        `Data space: recording a declared retention failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
                    );
                }
            }
        }
    }
    /**
     * A plugin's analytical table's retention as its adopted manifest
     * declares it (CB-387): days, null to keep everything, or undefined
     * when the manifest doesn't declare that table (the catalog's own
     * `retainDays`, from the API, holds then).
     */
    private declaredRetention(row: Pick<DatasetRow, 'id' | 'ownerUserId' | 'name'>, table: string) {
        // Its writer's need (CB-451), or a `plugin:<id>` dataset not moved yet, by its name.
        const writer = this.liveWriter(row.id);
        const plugin = writer?.pluginId ?? pluginOfOwner(row.ownerUserId);
        const need = plugin ? this.declaredNeed(plugin, writer?.need ?? row.name) : undefined;
        const declared = need?.tables?.find(
            (item) => item.kind === 'analytical' && item.table.toLowerCase() === table.toLowerCase(),
        );
        return declared ? (declared.retainDays ?? null) : undefined;
    }
    /**
     * An analytical table's retention as the nightly run applies it (CB-387):
     * an admin's override, which wins over any manifest until cleared
     * (the owner's decision, 2026-11-17); else the plugin's value (its
     * adopted manifest, or the table's own `retainDays`); else the workspace
     * default (Settings over `DATA_ANALYTICS_RETAIN_DAYS`). 0 and null keep
     * everything.
     */
    private retentionOf(
        row: Pick<DatasetRow, 'id' | 'ownerUserId' | 'name'>,
        table: AnalyticalTable,
    ): AnalyticalRetention {
        const said = this.declaredRetention(row, table.name);
        const declared = (said === undefined ? table.retainDays : said) || null;
        const workspaceDefault = this.limits.analyticalRetainDays || null;
        if (table.retainOverride !== undefined) {
            const override = table.retainOverride || null;
            return { days: override, source: 'override', override, declared, workspaceDefault };
        }
        if (declared) {
            return { days: declared, source: 'manifest', declared, workspaceDefault };
        }
        return { days: workspaceDefault, source: 'default', declared, workspaceDefault };
    }
    /** An analytical table of a dataset the person manages, or a 404. */
    private managedAnalyticalTable(userId: string, id: string, table: string) {
        const row = this.managedRow(userId, id);
        const path = this.datasetPath(row);
        const found = existsSync(path) ? this.engine.analyticalTable(path, table) : undefined;
        if (!found) {
            throw new DataError(`No analytical table "${table}" in this dataset.`, 404);
        }
        return { row, path, table: found };
    }
    /** Days for a retention change or preview: 1 to the most, or null to keep everything. */
    private retentionDays(days: unknown): number | null {
        if (days === null) {
            return null;
        }
        if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > ANALYTICAL_RETAIN_DAYS_MAX) {
            throw new DataError(
                `Retention is a whole number of days from 1 to ${ANALYTICAL_RETAIN_DAYS_MAX}, or null to keep everything.`,
            );
        }
        return days;
    }
    /**
     * An admin's retention override on an analytical table (CB-387): days,
     * null to keep everything, or `clear` to go back to the plugin's value
     * (or the workspace default). It wins over manifest updates until
     * cleared, and the nightly run applies it. Audited as
     * `table_retention_override` with the retention before and after.
     */
    setTableRetention(
        userId: string,
        id: string,
        table: string,
        change: { days: number | null } | { clear: true },
    ): AnalyticalRetention {
        const found = this.managedAnalyticalTable(userId, id, table);
        const before = this.retentionOf(found.row, found.table);
        const override = 'clear' in change ? null : (this.retentionDays(change.days) ?? 0);
        const actor = { kind: 'user' as const, userId };
        const target = `${found.row.name}.${found.table.name}`;
        const area = nonPersonOwnerId(found.row.ownerUserId) ? found.row.ownerUserId : undefined;
        try {
            this.engine.setAnalyticalRetentionOverride(found.path, found.table.name, override);
        } catch (error) {
            this.audit(actor, 'table_retention_override', 'error', {
                area,
                datasetId: found.row.id,
                target,
                detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
            });
            throw error;
        }
        const after = this.retentionOf(found.row, this.engine.analyticalTable(found.path, found.table.name)!);
        if (before.source !== after.source || before.days !== after.days) {
            this.audit(actor, 'table_retention_override', 'ok', {
                area,
                datasetId: found.row.id,
                target,
                detail: `${'clear' in change ? 'override cleared' : 'override set'}: ${describeRetention(before)} → ${describeRetention(after)}`,
            });
        }
        return after;
    }
    /**
     * What a retention of `days` would drop from an analytical table if the
     * nightly run used it now (CB-387): partitions, parts, rows, bytes and
     * their date range. For the Data page, before an admin saves a lower one.
     */
    previewTableRetention(userId: string, id: string, table: string, days: unknown): AnalyticalRetentionPreview {
        const found = this.managedAnalyticalTable(userId, id, table);
        return this.engine.retentionPreview(found.path, found.table.name, this.retentionDays(days));
    }
    /**
     * Records an admin's change of the workspace default retention of
     * analytical tables (CB-387) in the data audit, beside the overrides.
     */
    auditRetentionDefault(userId: string, before: number, after: number) {
        if (before === after) {
            return;
        }
        const said = (days: number) => (days ? `${days} days` : 'keep everything');
        this.audit({ kind: 'user', userId }, 'analytics_retention_default', 'ok', {
            target: 'workspace',
            detail: `${said(before)} → ${said(after)}`,
        });
    }
    /** The plugin's bound needs (`pluginRows`), for its token exchange, and its declared needs left unbound. */
    pluginDatasets(pluginId: string): {
        bound: PluginTokenNeed[];
        unbound: Array<{ name: string; access: PluginDatasetAccess }>;
        bindings: Array<PluginTokenNeed & { binding: string }>;
    } {
        const bound = this.pluginRows(pluginId).map(({ row, binding, access }) => ({
            name: binding.need,
            access,
            id: row.id,
            datasetName: row.name,
            description: row.description,
            binding: binding.id,
        }));
        const declared = (this.pluginSource?.declared(pluginId) ?? []) as ReadonlyArray<DeclaredPluginDataset>;
        const unbound = declared
            .filter((need) => !bound.some((item) => item.name.toLowerCase() === need.name.toLowerCase()))
            .map((need) => ({ name: need.name, access: pluginNeedAccess(need) }));
        return { bound: bound.map(({ binding: _binding, ...need }) => need), unbound, bindings: bound };
    }
    /**
     * A short-lived data token for a plugin's own work (`purpose: 'plugin'`),
     * with no person present (a scheduled read): every dataset bound to it,
     * each with its binding's access, `names` narrowing them by need. Bound
     * to the identity version it was exchanged for; refused the moment a
     * binding ends, as `visible` reads the bindings live. Undefined when no
     * need is bound (or none of `names`); `unbound` lists the needs that aren't.
     */
    issuePluginToken(
        pluginId: string,
        identityVersion: number,
        names?: readonly string[],
        ttlMs = PLUGIN_TOKEN_TTL_MS,
    ) {
        const listed = this.pluginDatasets(pluginId);
        let { bound: datasets, unbound } = listed;
        if (names?.length) {
            const wanted = new Set(names.map((name) => name.toLowerCase()));
            const unknown = names.filter(
                (name) => !datasets.some((item) => item.name.toLowerCase() === name.toLowerCase()),
            );
            if (unknown.length) {
                throw new DataError(`This plugin has no bound need named ${unknown.join(', ')}.`, 404);
            }
            datasets = datasets.filter((item) => wanted.has(item.name.toLowerCase()));
            unbound = [];
        }
        if (!datasets.length) {
            return { unbound };
        }
        const ttl = Math.min(ttlMs, this.options.tokenTtlMs ?? ttlMs);
        const token = this.tokens.issue(
            {
                userId: pluginOwnerId(pluginId),
                dotId: '',
                purpose: 'plugin',
                session: pluginTokenSession(pluginId),
                // The bindings it covers, each with the access it was issued
                // at (CB-451), and their datasets' ids, which a runtime of the
                // previous release reads during a deploy.
                datasetIds: [
                    ...new Set(datasets.map((item) => item.id)),
                    ...listed.bindings
                        .filter((item) => datasets.some((need) => need.name === item.name))
                        .map((item) => `${TOKEN_BINDING}${item.binding}:${item.access}`),
                ],
                pluginId,
                identityVersion,
            },
            ttl,
        );
        return { token, expiresAt: Date.now() + ttl, datasets, unbound };
    }
    /** Ends every data token the plugin holds, on every runtime (disable, uninstall). */
    revokePluginTokens(pluginId: string) {
        this.tokens.revokeSession(pluginTokenSession(pluginId));
    }
    /**
     * A plugin's data operation budget (CB-473): an admin's override for it,
     * else the workspace's plugin default (Settings over
     * `DATA_PLUGIN_STATEMENTS_PER_MINUTE`), read on every operation so a
     * change applies at once.
     */
    private pluginStatementBudget(pluginId: string): PluginDataBudget {
        const workspaceDefault = this.limits.pluginStatementsPerMinute;
        const override = this.repos.budgets.get(pluginId);
        return {
            pluginId,
            statementsPerMinute: override?.statementsPerMinute ?? workspaceDefault,
            override: override?.statementsPerMinute ?? null,
            workspaceDefault,
            max: PLUGIN_BUDGET_MAX,
            ...(override ? { setBy: override.setBy, setAt: override.setAt } : {}),
        };
    }
    /** A plugin's budget, for its page: admins only (CB-473). */
    pluginBudget(userId: string, pluginId: string): PluginDataBudget {
        if (!this.isAdminId(userId)) {
            throw new DataError('Only an admin sees a plugin’s data budget.', 403);
        }
        return this.pluginStatementBudget(pluginId);
    }
    /**
     * Sets an installed plugin's budget (operations a minute, at most
     * `PLUGIN_BUDGET_MAX`), or clears it (`null`) back to the workspace's
     * plugin default (CB-473). Admins only; audited.
     */
    setPluginBudget(userId: string, pluginId: string, statementsPerMinute: number | null): PluginDataBudget {
        if (!this.isAdminId(userId)) {
            throw new DataError('Only an admin changes a plugin’s data budget.', 403);
        }
        if (this.pluginSource?.declared(pluginId) === undefined) {
            throw new DataError('That plugin isn’t installed.', 404);
        }
        if (
            statementsPerMinute !== null &&
            (!Number.isInteger(statementsPerMinute) ||
                statementsPerMinute < 1 ||
                statementsPerMinute > PLUGIN_BUDGET_MAX)
        ) {
            throw new DataError(
                `A plugin’s budget is a whole number of operations a minute, 1 to ${PLUGIN_BUDGET_MAX}.`,
            );
        }
        const before = this.pluginStatementBudget(pluginId);
        if (statementsPerMinute === null) {
            this.repos.budgets.clear(pluginId);
        } else {
            this.repos.budgets.set({ pluginId, statementsPerMinute, setBy: userId, setAt: Date.now() });
        }
        const after = this.pluginStatementBudget(pluginId);
        if (before.override !== after.override) {
            this.audit({ kind: 'user', userId }, 'plugin_budget', 'ok', {
                target: pluginId,
                detail: `${before.override ?? `default ${before.workspaceDefault}`} → ${after.override ?? `default ${after.workspaceDefault}`} a minute`,
            });
        }
        return after;
    }
    /**
     * Operations a minute per (user, Dot), for Dots and tokens; an app has
     * its own. A plugin's token has its plugin's budget (CB-473): an admin's
     * override for it, else `pluginStatementsPerMinute`.
     */
    private limitRate(actor: AgentActor, statements = 1) {
        const plugin = pluginToken(actor) ? actor.pluginId : undefined;
        // A data API token has its own budget, set when it was made.
        const api = apiToken(actor) ? actor.apiToken : undefined;
        const key = plugin
            ? `plugin\u0000${plugin}`
            : api
              ? `api\u0000${api.id}`
              : `${actor.userId}\u0000${actor.dotId}${actor.kind === 'token' && actor.appId ? `\u0000${actor.appId}` : ''}`;
        const budget = plugin
            ? this.pluginStatementBudget(plugin).statementsPerMinute
            : api
              ? Math.min(api.statementsPerMinute, PLUGIN_BUDGET_MAX)
              : this.limits.statementsPerMinute;
        const now = Date.now();
        const recent = (this.rate.get(key) ?? []).filter((at) => at > now - 60_000);
        // A write batch counts as its statements; a read batch as one.
        if (recent.length + statements > budget) {
            this.rate.set(key, recent);
            throw new DataError(
                plugin
                    ? `Too many data operations: this plugin may make ${budget} a minute (an admin raises it on the plugin’s page). Send reads as one read batch, or wait a minute.`
                    : api
                      ? `Too many data operations: this data API token may make ${budget} a minute. Send rows in batches, reads as one read batch, or wait a minute.`
                      : `Too many data operations: at most ${budget} a minute. Batch rows into one data_insert, or wait a minute.`,
                429,
            );
        }
        for (let i = 0; i < statements; i++) {
            recent.push(now);
        }
        this.rate.set(key, recent);
    }
    /** What counts against the quota: live datasets and files only (CB-64). */
    usage(userId: string): DataUsageView {
        const datasets = this.db
            .prepare(
                `SELECT count(*) AS n, COALESCE(sum(sizeBytes), 0) AS bytes FROM data_datasets WHERE ownerUserId=? AND ${LIVE}`,
            )
            .get(userId) as { n: number; bytes: number };
        const files = this.db
            .prepare(
                `SELECT count(*) AS n, COALESCE(sum(storedSize), 0) AS bytes FROM data_files WHERE ownerUserId=? AND ${LIVE}`,
            )
            .get(userId) as { n: number; bytes: number };
        return {
            userId,
            datasets: Number(datasets.n),
            datasetBytes: Number(datasets.bytes),
            files: Number(files.n),
            fileBytes: Number(files.bytes),
            totalBytes: Number(datasets.bytes) + Number(files.bytes),
        };
    }
    /**
     * Every user's usage, with what they deleted, the earlier versions of
     * files they replaced and their datasets' row history (all kept, none
     * counted). One scan of each table: a query per user read every row once
     * per user, and versions (17.2) add rows.
     */
    usageAll(): DataUsageView[] {
        type Sums = { n: number; bytes: number; dn: number; dbytes: number };
        const sums = (table: 'data_datasets' | 'data_files', column: string) =>
            new Map(
                (
                    this.db
                        .prepare(
                            `SELECT ownerUserId AS id, sum(deletedAt IS NULL) AS n, COALESCE(sum(CASE WHEN deletedAt IS NULL THEN ${column} END), 0) AS bytes, sum(deletedAt IS NOT NULL) AS dn, COALESCE(sum(CASE WHEN deletedAt IS NOT NULL THEN ${column} END), 0) AS dbytes FROM ${table} GROUP BY ownerUserId`,
                        )
                        .all() as Array<Sums & { id: string }>
                ).map(({ id, ...row }) => [String(id), row] as const),
            );
        const datasets = sums('data_datasets', 'sizeBytes');
        const files = sums('data_files', 'storedSize');
        // Row history of every dataset, live or deleted.
        const history = new Map(
            (
                this.db
                    .prepare(
                        'SELECT ownerUserId AS id, COALESCE(sum(historyBytes), 0) AS bytes FROM data_datasets GROUP BY ownerUserId',
                    )
                    .all() as Array<{ id: string; bytes: number }>
            ).map((row) => [String(row.id), Number(row.bytes)] as const),
        );
        const users = this.options.workspace.users();
        const ids = new Set([...users.map((user) => user.id), ...datasets.keys(), ...files.keys()]);
        const names = new Map(users.map((user) => [user.id, user.name]));
        const none: Sums = { n: 0, bytes: 0, dn: 0, dbytes: 0 };
        return [...ids].map((id) => {
            const d = datasets.get(id) ?? none;
            const f = files.get(id) ?? none;
            return {
                userId: id,
                datasets: Number(d.n),
                datasetBytes: Number(d.bytes),
                files: Number(f.n),
                fileBytes: Number(f.bytes),
                totalBytes: Number(d.bytes) + Number(f.bytes),
                deletedDatasets: Number(d.dn),
                deletedFiles: Number(f.dn),
                deletedBytes: Number(d.dbytes) + Number(f.dbytes),
                historyBytes: history.get(id) ?? 0,
                userName:
                    names.get(id) ??
                    (reservedUserId(id)
                        ? sharedAreaLabel(this.dotName(id.slice(SOCIO_OWNER_PREFIX.length)))
                        : isWorkspaceOwner(id)
                          ? 'The workspace (plugin datasets)'
                          : isPluginOwner(id)
                            ? `${this.pluginName(pluginOfOwner(id)!)} (plugin)`
                            : id),
            };
        });
    }
    /** Bytes the dataset may grow to: its quota, within what the user has left. */
    private room(row: DatasetRow) {
        // A plugin's dataset has its own quota and counts against no person's.
        if (isCompanyOwner(row.ownerUserId)) {
            return this.limits.pluginDatasetMaxBytes;
        }
        const used = this.usage(row.ownerUserId).totalBytes;
        // Room a batch running on another of the owner's datasets may still take.
        let held = 0;
        for (const [datasetId, hold] of this.batchHolds) {
            if (hold.owner === row.ownerUserId && datasetId !== row.id) {
                held += hold.bytes;
            }
        }
        const left = this.limits.userMaxBytes - (used - row.sizeBytes) - held;
        if (left <= row.sizeBytes) {
            throw new DataError(
                `Your data space is full (${Math.round(this.limits.userMaxBytes / 1048576)} MB). Delete datasets or files in the app's Data page.`,
                413,
            );
        }
        return Math.min(this.limits.datasetMaxBytes, left);
    }

    // ---- datasets ---------------------------------------------------------
    private requireDot(dotId: string) {
        const dot = this.options.workspace.dot(dotId);
        if (!dot) {
            throw new DataError('Socio not found.', 404);
        }
        return dot;
    }
    /** Datasets beyond the scratch ones, which `maxDatasets` limits. */
    private countFor(userId: string) {
        return Number(
            (
                this.db
                    .prepare(
                        `SELECT count(*) AS n FROM data_datasets WHERE ownerUserId=? AND scratchForDotId IS NULL AND ${LIVE}`,
                    )
                    .get(userId) as { n: number }
            ).n,
        );
    }
    /** The Dot's scratch dataset in the user's space, created on first need. */
    scratch(userId: string, dotId: string, create = true): DatasetRow | undefined {
        const existing = this.db
            .prepare(`SELECT * FROM data_datasets WHERE ownerUserId=? AND scratchForDotId=? AND ${LIVE}`)
            .get(userId, dotId) as DatasetRow | undefined;
        if (existing || !create) {
            return existing;
        }
        const dot = this.requireDot(dotId);
        const now = Date.now();
        const id = randomUUID();
        // Synchronous: `visible` makes it on first sight, for callers that
        // don't wait (CB-110). A live one made meanwhile wins.
        this.repos.datasets.insertScratchNow({
            id,
            ownerUserId: userId,
            ...(reservedUserId(userId)
                ? {
                      name: `${dot.name} shared`,
                      description: `Shared by everyone who uses ${dot.name}, through its computer.`,
                  }
                : {
                      name: `${dot.name} scratch`,
                      description: `${dot.name}'s working data.`,
                  }),
            createdByDotId: dotId,
            scratchForDotId: dotId,
            createdAt: now,
            updatedAt: now,
        });
        const row = this.scratch(userId, dotId, false)!;
        if (row.id === id) {
            this.engine.create(this.datasetPath(row));
            this.touch(row);
            this.audit({ kind: 'dot', userId, dotId }, 'create_scratch', 'ok', {
                datasetId: id,
                target: row.name,
            });
        }
        return this.row(row.id)!;
    }
    createDataset(
        userId: string,
        input: {
            name: string;
            description?: string;
            createdByDotId?: string | null;
        },
        actor: DataActor = { kind: 'user', userId },
    ): DatasetView {
        const name = input.name.trim();
        if (!NAME.test(name)) {
            throw new DataError('Name the dataset (1 to 80 characters).');
        }
        // A plugin declares at most PLUGIN_DATASETS_MAX in its manifest.
        if (!isCompanyOwner(userId) && this.countFor(userId) >= this.limits.maxDatasets) {
            throw new DataError(
                `You have the most datasets allowed (${this.limits.maxDatasets}). Delete one first.`,
                413,
            );
        }
        const now = Date.now();
        const id = randomUUID();
        this.repos.datasets.insertNow({
            id,
            ownerUserId: userId,
            name,
            description: (input.description ?? '').trim().slice(0, 500),
            createdByDotId: input.createdByDotId ?? null,
            scratchForDotId: null,
            createdAt: now,
            updatedAt: now,
        });
        const row = this.row(id)!;
        this.engine.create(this.datasetPath(row));
        this.touch(row);
        this.audit(actor, 'create_dataset', 'ok', {
            datasetId: id,
            target: name,
            // A workspace dataset in a socio's area (CB-354), or a plugin's: in its record.
            ...(nonPersonOwnerId(userId) ? { area: userId } : {}),
        });
        return this.view(this.row(id)!, userId);
    }
    /**
     * Moves tables of one of the user's datasets into a new dataset of theirs
     * (a mini app's promotion): a consistent copy, then the moved tables
     * are dropped from the source. All of them unless `tables` names some.
     * The user's own action (or their approval), audited as theirs.
     */
    moveToNewDataset(
        userId: string,
        sourceId: string,
        input: {
            name: string;
            description?: string;
            createdByDotId?: string | null;
            tables?: readonly string[];
        },
    ): DatasetView {
        return this.moveTables(userId, this.ownedRow(userId, sourceId), input);
    }
    /**
     * A company socio's shared dataset (CB-224, CB-337), for a person who may
     * see its shared area (CB-229); undefined when it has none yet, or for a
     * personal socio.
     */
    sharedDatasetFor(userId: string, dotId: string): DatasetRow | undefined {
        if (!this.canSeeShared(userId, dotId)) {
            return undefined;
        }
        return this.scratch(sharedOwner(dotId), dotId, false);
    }
    /**
     * Moves tables of a company socio's shared dataset into a new workspace
     * dataset (CB-354: an app built on the shared data is promoted). It is
     * the company's, not the promoting person's: it lives in the socio's
     * area (`socio:<id>`, CB-224), outside any person's data space, so a
     * transfer never moves it (CB-360) and shared-area retention never
     * deletes it. The same consistent copy, then the moved tables leave the
     * shared dataset, audited in the area as the person's. Only a person who
     * may see the area; the socio reaches it only through a grant, which a
     * person approves (`requestWorkspaceAccess`).
     */
    moveSharedToWorkspaceDataset(
        userId: string,
        dotId: string,
        input: {
            name: string;
            description?: string;
            tables?: readonly string[];
            sharedSpaceId?: string | null;
        },
    ): DatasetView {
        const owner = this.requireShared(userId, dotId);
        // Only into a Space the person may edit (CB-451), before anything moves.
        if (input.sharedSpaceId) {
            this.requirePlacing(userId, input.sharedSpaceId);
        }
        return this.moveTables(userId, this.sharedDataset(dotId), { ...input, createdByDotId: dotId }, owner);
    }
    private moveTables(
        userId: string,
        source: DatasetRow,
        input: {
            name: string;
            description?: string;
            createdByDotId?: string | null;
            tables?: readonly string[];
            sharedSpaceId?: string | null;
        },
        targetOwner = userId,
    ): DatasetView {
        const all = this.engine.tables(this.datasetPath(source)).map((table) => table.name);
        const missing = (input.tables ?? []).filter((name) => !all.includes(name));
        if (missing.length) {
            throw new DataError(`“${source.name}” has no table ${missing.join(', ')}.`, 404);
        }
        const moving = input.tables?.length ? [...input.tables] : all;
        const workspace = reservedUserId(targetOwner);
        if (this.usage(targetOwner).totalBytes + source.sizeBytes > this.limits.userMaxBytes) {
            throw new DataError(
                workspace
                    ? 'The socio’s data space is too full to move this data; delete its datasets or files first.'
                    : 'Your data space is too full to move this data; delete datasets or files first.',
                413,
            );
        }
        const created = this.createDataset(
            targetOwner,
            {
                name: input.name,
                description: input.description,
                createdByDotId: input.createdByDotId,
            },
            { kind: 'user', userId },
        );
        const target = this.row(created.id)!;
        try {
            // The whole file: the moved tables' indexes come with it (CB-355).
            this.engine.copy(this.datasetPath(source), this.datasetPath(target));
            this.engine.dropTables(
                this.datasetPath(target),
                all.filter((name) => !moving.includes(name)),
            );
        } catch (error) {
            this.discardDataset(target);
            throw error;
        }
        // Only once the copy is whole: the source loses what moved.
        this.engine.dropTables(this.datasetPath(source), moving);
        if (input.sharedSpaceId) {
            this.repos.datasets.updateNow(target.id, {
                name: target.name,
                description: target.description,
                retentionDays: target.retentionDays,
                sharedSpaceId: input.sharedSpaceId,
                spaceParentId: null,
                spacePosition: null,
                spaceAddedAt: Date.now(),
            });
        }
        this.touch(target);
        this.touch(source);
        const tables = moving.length ? `: ${moving.join(', ')}` : '';
        this.audit({ kind: 'user', userId }, 'move_tables', 'ok', {
            datasetId: target.id,
            target: target.name,
            detail: `${moving.length} table(s) from ${source.name}${tables}`,
            ...(workspace ? { area: targetOwner } : {}),
        });
        if (reservedUserId(source.ownerUserId)) {
            // The shared area's own record of what left it, and for whom.
            this.audit({ kind: 'user', userId }, 'move_tables', 'ok', {
                datasetId: source.id,
                target: source.name,
                detail: `${moving.length} table(s) moved into ${workspace ? `the workspace dataset “${target.name}”` : "a dataset of a person's"}${tables}`,
                area: source.ownerUserId,
            });
        }
        return this.view(this.row(target.id)!, userId);
    }
    private ownedRow(userId: string, id: string) {
        const row = this.row(id);
        if (!row || row.ownerUserId !== userId) {
            throw new DataError('Dataset not found.', 404);
        }
        return row;
    }
    updateDataset(
        userId: string,
        id: string,
        patch: {
            name?: string;
            description?: string;
            retentionDays?: number | null;
            sharedSpaceId?: string | null;
            historyDays?: number | null;
            spaceParentId?: string | null;
            spacePosition?: string | null;
        },
        actor: DataActor = { kind: 'user', userId },
    ): DatasetView {
        const row = this.managedRow(userId, id);
        const name = patch.name?.trim() ?? row.name;
        if (!NAME.test(name)) {
            throw new DataError('Name the dataset (1 to 80 characters).');
        }
        // A `plugin:<id>` dataset not moved to the workspace yet is found by
        // its name; a workspace dataset by its binding (CB-451), so it may be renamed.
        if (isPluginOwner(row.ownerUserId) && name !== row.name) {
            throw new DataError('A plugin’s dataset keeps the name its plugin declares.', 409);
        }
        const placement = this.placement(userId, row, patch);
        if (
            patch.retentionDays !== undefined &&
            patch.retentionDays !== null &&
            (!Number.isInteger(patch.retentionDays) || patch.retentionDays < 1 || patch.retentionDays > 3650)
        ) {
            throw new DataError('Retention is 1 to 3,650 days, or none.');
        }
        if (
            patch.historyDays !== undefined &&
            patch.historyDays !== null &&
            (!Number.isInteger(patch.historyDays) || patch.historyDays < 1 || patch.historyDays > 3650)
        ) {
            throw new DataError('Row history is kept 1 to 3,650 days, or always.');
        }
        const next = {
            name,
            description: patch.description?.trim().slice(0, 500) ?? row.description,
            retentionDays: patch.retentionDays === undefined ? row.retentionDays : patch.retentionDays,
            sharedSpaceId: patch.sharedSpaceId === undefined ? row.sharedSpaceId : patch.sharedSpaceId,
            historyDays: patch.historyDays === undefined ? (row.historyDays ?? null) : patch.historyDays,
            ...placement,
        };
        this.repos.datasets.updateNow(id, next);
        const changes = [
            next.name !== row.name && `name → ${next.name}`,
            next.retentionDays !== row.retentionDays &&
                `retention → ${next.retentionDays ? `${next.retentionDays} days` : 'keep'}`,
            next.historyDays !== (row.historyDays ?? null) &&
                `row history → ${next.historyDays ? `${next.historyDays} days` : 'keep all'}`,
            next.sharedSpaceId !== row.sharedSpaceId &&
                (next.sharedSpaceId
                    ? `shared with ${this.options.workspace.spaces().find((space) => space.id === next.sharedSpaceId)?.name ?? 'a Space'}`
                    : 'no longer shared'),
            next.sharedSpaceId && next.sharedSpaceId === row.sharedSpaceId && placement && 'moved within its Space',
        ].filter(Boolean);
        if (changes.length || next.description !== row.description) {
            this.audit(actor, 'update', 'ok', {
                datasetId: id,
                target: row.name,
                detail: changes.join('; ') || 'description',
                ...(isCompanyOwner(row.ownerUserId) ? { area: row.ownerUserId } : {}),
            });
        }
        return this.view(this.row(id)!, userId);
    }
    /**
     * Deletes a dataset (CB-64): it is hidden and kept, with its SQLite file;
     * its grants end, each audited with what it allowed. Retention deletes
     * as the system.
     */
    deleteDataset(
        userId: string,
        id: string,
        actor: DataActor | { kind: 'system'; userId: string } = {
            kind: 'user',
            userId,
        },
        stamp: DeleteStamp = {},
    ) {
        // An admin deletes a plugin's dataset (`manages`); the plugin never does.
        const row = this.managedRow(userId, id);
        const area = isCompanyOwner(row.ownerUserId) ? { area: row.ownerUserId } : {};
        const by =
            stamp.by ?? (actor.kind === 'system' ? SYSTEM : actor.kind === 'user' ? actor.userId : byDot(actor.dotId));
        this.repos.datasets.markDeletedNow(id, {
            at: Date.now(),
            by,
            with: stamp.with ?? null,
        });
        const grants = this.repos.grants.removeForDatasetNow(id);
        this.audit(actor, actor.kind === 'system' ? 'retention_delete' : 'delete', 'ok', {
            datasetId: id,
            target: row.name,
            ...(stamp.with ? { detail: `with ${stamp.with}` } : {}),
            ...area,
        });
        for (const grant of grants) {
            this.audit(actor, 'revoke', 'ok', {
                datasetId: id,
                target: row.name,
                detail: `${this.dotName(grant.dotId) ?? grant.dotId}: ${grant.access}; the dataset was deleted`,
                ...area,
            });
        }
        // Its plugin bindings end with it (CB-451): a writer's next enable
        // binds a new dataset; a reader is left unbound.
        for (const binding of this.repos.bindings.liveForDataset(id)) {
            this.endBinding(binding, by, 'the dataset was deleted');
        }
    }
    /**
     * Removes a dataset a failed move half made (`moveToNewDataset`): it
     * never held anything that isn't still in its source, so it goes.
     */
    private discardDataset(row: DatasetRow) {
        this.engine.remove(this.datasetPath(row));
        this.repos.grants.removeForDatasetNow(row.id);
        this.repos.datasets.removeNow(row.id);
        this.audit({ kind: 'user', userId: row.ownerUserId }, 'delete', 'ok', {
            datasetId: row.id,
            target: row.name,
            detail: 'the move into it failed',
        });
    }
    /** Whether `userId` may edit `spaceId`, and so place datasets in it (CB-451). */
    private editsSpace(userId: string, spaceId: string) {
        const { workspace } = this.options;
        return workspace.editsSpace ? workspace.editsSpace(userId, spaceId) : this.readsSpace(userId, spaceId);
    }
    /**
     * Only a Space's editors place datasets in it or move them there
     * (CB-451): a 404 for a Space the person can't read, as
     * before, and a 403 for one they only read.
     */
    private requirePlacing(userId: string, spaceId: string) {
        if (!this.readsSpace(userId, spaceId)) {
            throw new DataError('Space not found.', 404);
        }
        if (!this.editsSpace(userId, spaceId)) {
            throw new DataError(SPACE_PLACE_REFUSED, 403);
        }
    }
    /** Whether a page is a live page of a Space: the pages' own answer, wired by the composition. */
    private livePage: (spaceId: string, pageId: string) => boolean = () => false;
    /** How a dataset's parent page is checked (the pages, CB-451). */
    usePlacementPages(livePage: (spaceId: string, pageId: string) => boolean) {
        this.livePage = livePage;
    }
    /**
     * A change's new place for a dataset its person manages (CB-451),
     * or undefined when it stays where it is. Placing it in a
     * Space, moving it to another and moving it within one need the
     * Space's editor role; taking it out needs only managing it. A parent
     * is a live page of that Space: never a dataset.
     */
    private placement(
        userId: string,
        row: DatasetRow,
        patch: { sharedSpaceId?: string | null; spaceParentId?: string | null; spacePosition?: string | null },
    ): Partial<DatasetSettings> | undefined {
        const space = patch.sharedSpaceId === undefined ? row.sharedSpaceId : patch.sharedSpaceId;
        if (!space) {
            if (patch.spaceParentId || patch.spacePosition) {
                throw new DataError('Put the dataset in a Space first.');
            }
            return patch.sharedSpaceId === null && row.sharedSpaceId
                ? { spaceParentId: null, spacePosition: null, spaceAddedAt: null }
                : undefined;
        }
        if (patch.spacePosition != null && !SPACE_POSITION.test(patch.spacePosition)) {
            throw new DataError('Invalid position.');
        }
        const joins = space !== row.sharedSpaceId;
        const parent =
            patch.spaceParentId === undefined ? (joins ? null : (row.spaceParentId ?? null)) : patch.spaceParentId;
        const position =
            patch.spacePosition === undefined ? (joins ? null : (row.spacePosition ?? null)) : patch.spacePosition;
        if (!joins && parent === (row.spaceParentId ?? null) && position === (row.spacePosition ?? null)) {
            return undefined;
        }
        this.requirePlacing(userId, space);
        if (parent !== null && !this.livePage(space, parent)) {
            throw new DataError('That page isn’t in this Space.', 404);
        }
        return {
            spaceParentId: parent,
            spacePosition: position,
            spaceAddedAt: joins ? Date.now() : (row.spaceAddedAt ?? row.updatedAt),
        };
    }
    /**
     * "New dataset" in a Space (CB-451): one of the person's,
     * placed there at once, only by the Space's editors, checked before it
     * is made.
     */
    createInSpace(
        userId: string,
        input: { name: string; description?: string; sharedSpaceId: string; spaceParentId?: string | null },
    ): DatasetView {
        this.requirePlacing(userId, input.sharedSpaceId);
        const parent = input.spaceParentId ?? null;
        if (parent !== null && !this.livePage(input.sharedSpaceId, parent)) {
            throw new DataError('That page isn’t in this Space.', 404);
        }
        const made = this.createDataset(userId, { name: input.name, description: input.description });
        const row = this.row(made.id)!;
        this.repos.datasets.updateNow(row.id, {
            name: row.name,
            description: row.description,
            retentionDays: row.retentionDays,
            historyDays: row.historyDays ?? null,
            sharedSpaceId: input.sharedSpaceId,
            spaceParentId: parent,
            spacePosition: null,
            spaceAddedAt: Date.now(),
        });
        return this.view(this.row(row.id)!, userId);
    }
    /**
     * The datasets placed in a Space, as its items list shows them (CB-451):
     * each only for a viewer `viewable` lets in, which every
     * reader of the Space is today; the check stays per item so a later
     * rule can't leak a title.
     */
    spaceDatasetItems(viewer: string, spaceId: string): SpaceDatasetItem[] {
        const rows = this.db
            .prepare(`SELECT * FROM data_datasets WHERE sharedSpaceId=? AND ${LIVE}`)
            .all(spaceId) as unknown as DatasetRow[];
        return rows
            .filter((row) => {
                try {
                    this.viewable(viewer, row.id, spaceId);
                    return true;
                } catch (error) {
                    if (error instanceof DataError) {
                        return false;
                    }
                    throw error;
                }
            })
            .map((row) =>
                this.datasetItem(
                    row,
                    row.spaceParentId ?? null,
                    row.spacePosition ?? spaceItemKey(row.spaceAddedAt ?? row.updatedAt, row.id),
                ),
            );
    }
    /**
     * `GET /api/data/private-items` (CB-451): the person's own
     * datasets that no Space holds, a socio's scratch datasets included,
     * oldest first. Workspace and socio datasets are no one's: an admin
     * finds them on the Data page.
     */
    privateItems(userId: string): PrivateItemsResponse {
        this.reconcileDots();
        const rows = this.db
            .prepare(`SELECT * FROM data_datasets WHERE ownerUserId=? AND sharedSpaceId IS NULL AND ${LIVE}`)
            .all(userId) as unknown as DatasetRow[];
        const items = rows
            .filter((row) => !nonPersonOwnerId(row.ownerUserId))
            .map((row) => this.datasetItem(row, null, spaceItemKey(row.createdAt, row.id)))
            .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
        return { schema: SPACE_ITEMS_SCHEMA, scope: 'private', items };
    }
    /**
     * Pages that left a Space, deleted or moved to another (CB-451): the
     * datasets under any of them go to `parentId` (the nearest surviving
     * ancestor, or the root), in the pages' own transaction.
     */
    reparentSpaceItems(spaceId: string, pageIds: readonly string[], parentId: string | null) {
        return this.repos.datasets.reparentNow(spaceId, pageIds, parentId);
    }
    private datasetItem(row: DatasetRow, parentId: string | null, position: string): SpaceDatasetItem {
        let tables: TableInfo[] = [];
        try {
            tables = this.tablesOf(row);
        } catch {
            // A file that can't be read lists no tables; the item still shows.
        }
        const company = isCompanyOwner(row.ownerUserId);
        const writer = company
            ? this.repos.bindings.liveForDataset(row.id).find((binding) => binding.access === 'write')?.pluginId
            : undefined;
        const plugin = writer ?? pluginOfOwner(row.ownerUserId);
        const item: Omit<SpaceDatasetItem, 'version'> = {
            kind: 'dataset',
            id: row.id,
            parentId,
            title: row.name,
            position,
            owner: reservedUserId(row.ownerUserId) ? 'socio' : company ? 'workspace' : 'person',
            tables: tables.map((table) => ({
                name: table.name,
                title: table.name,
                rows: Number.isFinite(table.rowCount) ? table.rowCount : null,
                analytical: table.kind === 'analytical',
            })),
            ...(row.scratchForDotId
                ? { socio: { id: row.scratchForDotId, name: this.dotName(row.scratchForDotId) } }
                : {}),
            ...(plugin ? { plugin: { id: plugin, name: this.pluginName(plugin) } } : {}),
        };
        return { ...item, version: spaceItemVersion(item) };
    }
    /** Whether `userId` may read `spaceId`, and so what is shared with it (CB-181). */
    private readsSpace(userId: string, spaceId: string) {
        const { workspace } = this.options;
        return workspace.readsSpace
            ? workspace.readsSpace(userId, spaceId)
            : workspace.spaces().some((space) => space.id === spaceId);
    }
    /**
     * The datasets a user sees in the app: their own, then others' shared
     * with a Space they may read (CB-181), then the workspace datasets of
     * company socios whose shared area they may see (CB-354).
     */
    datasetsFor(userId: string): DatasetView[] {
        this.reconcileDots();
        const shared = (
            this.db
                .prepare(
                    `SELECT * FROM data_datasets WHERE ownerUserId<>? AND sharedSpaceId IS NOT NULL AND ${LIVE} ORDER BY name`,
                )
                .all(userId) as unknown as DatasetRow[]
        ).filter((row) => this.readsSpace(userId, row.sharedSpaceId!));
        // Workspace datasets (CB-354) of company socios whose area they may see.
        const workspace = (
            this.db
                .prepare(
                    `SELECT * FROM data_datasets WHERE ${SHARED_OWNERS} AND scratchForDotId IS NULL AND ${LIVE} ORDER BY name`,
                )
                .all() as unknown as DatasetRow[]
        ).filter(
            (row) =>
                !shared.some((item) => item.id === row.id) &&
                this.canSeeShared(userId, row.ownerUserId.slice(SOCIO_OWNER_PREFIX.length)),
        );
        // Service plugins' datasets (`plugin:<id>`): admins manage them.
        const plugins = this.isAdminId(userId)
            ? (
                  this.db
                      .prepare(
                          `SELECT * FROM data_datasets WHERE ${COMPANY_OWNERS} AND ${LIVE} ORDER BY ownerUserId, name`,
                      )
                      .all() as unknown as DatasetRow[]
              ).filter((row) => !shared.some((item) => item.id === row.id))
            : [];
        return [...this.ownRows(userId), ...plugins, ...shared, ...workspace].map((row) => this.view(row, userId));
    }
    /**
     * A dataset the user may read in the app: their own, one shared with a
     * Space they may read (CB-181), or the shared dataset of a company socio
     * whose area they may see (CB-229).
     */
    private readable(userId: string, id: string) {
        const row = this.row(id);
        if (
            !row ||
            (!this.manages(userId, row) &&
                !(row.sharedSpaceId && this.readsSpace(userId, row.sharedSpaceId)) &&
                !(
                    reservedUserId(row.ownerUserId) &&
                    this.canSeeShared(userId, row.ownerUserId.slice(SOCIO_OWNER_PREFIX.length))
                ))
        ) {
            throw new DataError('Dataset not found.', 404);
        }
        return row;
    }
    /**
     * An embedded view's dataset for a viewer of a page in `spaceId`:
     * one they own, one its owner shared with that Space, or a company
     * socio's shared dataset when they may see its shared area (CB-337,
     * `canSeeShared`, as in the app). Anything else (shared with another
     * Space, not shared, deleted, unknown) is the same refusal, so a view
     * never tells a viewer what exists. Not audited: the viewer's audit
     * would name another user's dataset.
     */
    viewable(viewer: string, id: string, spaceId: string) {
        const row = this.row(id);
        const socioShared = !!row && reservedUserId(row.ownerUserId);
        if (
            !row ||
            (!this.manages(viewer, row) &&
                (row.sharedSpaceId !== spaceId || !this.readsSpace(viewer, spaceId)) &&
                !(socioShared && this.canSeeShared(viewer, row.ownerUserId.slice(SOCIO_OWNER_PREFIX.length))))
        ) {
            throw new DataError(VIEW_NO_ACCESS, 403);
        }
        return {
            id: row.id,
            name: row.name,
            owned: row.ownerUserId === viewer,
            sharedHere: row.sharedSpaceId === spaceId,
            socioShared,
            updatedAt: row.updatedAt,
        };
    }
    /** A dataset's version for a person who may read it (the query spec cache, CB-451). */
    datasetVersion(userId: string, id: string): number {
        return this.readable(userId, id).updatedAt;
    }
    /** The workspace's people by name, to sort and name person fields (CB-451). */
    specPeople(): Array<{ id: string; name: string }> {
        return this.options.workspace.users().map((user) => ({ id: user.id, name: user.name }));
    }
    detailFor(userId: string, id: string): DatasetDetail {
        const row = this.readable(userId, id);
        return {
            dataset: this.view(row, userId),
            tables: this.tablesOf(row),
        };
    }
    rowsFor(userId: string, id: string, table: string, offset: number, limit: number): RowsPage {
        const row = this.readable(userId, id);
        // A socio's shared dataset: with rowids, to delete rows by (CB-229).
        return this.engine.rows(this.datasetPath(row), table, offset, limit, {
            rowids: reservedUserId(row.ownerUserId) && !!row.scratchForDotId,
        });
    }
    /**
     * A table's rows changed since a sync token (CB-451), for a
     * person who may read the dataset: the native clients' offline caches.
     */
    changesFor(userId: string, id: string, table: string, since: string, cursor?: string) {
        const row = this.readable(userId, id);
        return this.engine.changes(this.datasetPath(row), table, since, cursor === undefined ? {} : { cursor });
    }
    /**
     * A table's field settings as the query spec checks them (CB-451):
     * the validator's hook. Its caller has checked the person's
     * read access (`detailFor`).
     */
    fieldSettings(datasetId: string, table: string): FieldSetting[] {
        return this.repos.fields
            .forTable(datasetId, table)
            .map((row) => specFieldSetting(storedField(row)))
            .filter((setting): setting is FieldSetting => !!setting);
    }
    /** A live table of a dataset, by its exact name, or a 404 naming it. */
    private tableOf(row: DatasetRow, table: string) {
        const info = this.tablesOf(row).find((item) => item.name === table);
        if (!info) {
            throw new DataError(`Dataset "${row.name}" has no table "${table.slice(0, 80)}".`, 404);
        }
        return info;
    }
    /**
     * `GET …/tables/:table/fields` (CB-451): every field of
     * the table with its kind, settings, type, the kinds it takes and its
     * setting's version, for whoever may read the dataset; settings whose
     * column is gone, for those who may change them. Changing them is for
     * people who may write the dataset (`manages`: its owner, an admin for
     * workspace and plugin datasets), a plugin's writing included.
     */
    fieldSettingsFor(userId: string, id: string, table: string): FieldSettingsResponse {
        const row = this.readable(userId, id);
        const info = this.tableOf(row, table);
        const canEdit = this.manages(userId, row);
        return {
            schema: DATASET_VIEWS_SCHEMA,
            canEdit,
            fields: this.fieldEntries(row, info, canEdit, canEdit),
        };
    }
    /**
     * A table's field settings for a data API token (`data:read`, or
     * `data:admin`, which may edit them) on a company dataset it reaches.
     */
    fieldSettingsForToken(actor: AgentActor, id: string, table: string): FieldSettingsResponse {
        const row = this.apiDataset(actor, id, 'read');
        const info = this.tableOf(row, table);
        const canEdit = apiToken(actor) && actor.apiToken.scopes.includes('data:admin');
        return { schema: DATASET_VIEWS_SCHEMA, canEdit, fields: this.fieldEntries(row, info, canEdit, canEdit) };
    }
    /** A company dataset a data API token reaches with `need`, counted against its budget. */
    private apiDataset(actor: AgentActor, ref: string, need: GrantAccess) {
        if (!apiToken(actor)) {
            throw new DataError('Only a data API token does this outside the app.', 403);
        }
        this.limitRate(actor);
        return this.resolve(actor, ref, need).row;
    }
    /** Whether a data API token has a scope (the routes check it first; this holds it here too). */
    private requireApiScope(actor: AgentActor, scope: DataApiScope) {
        if (!apiToken(actor) || !actor.apiToken.scopes.includes(scope)) {
            throw new DataError(`This needs a data API token with ${scope}.`, 403);
        }
        return actor.apiToken;
    }
    /**
     * A company dataset (owner `ws:workspace`) made by a data API token
     * with `data:admin`: no person's, so it counts against no person's
     * quota; at most `maxDatasets` of the workspace's own unbound ones.
     * In a Space when asked, which its maker must be able to edit, under a
     * live page of it or at its root.
     */
    createCompanyDataset(
        actor: AgentActor,
        input: { name: string; description?: string; sharedSpaceId?: string; spaceParentId?: string | null },
    ): DatasetView {
        const token = this.requireApiScope(actor, 'data:admin');
        this.limitRate(actor);
        const parent = input.spaceParentId ?? null;
        if (input.sharedSpaceId) {
            this.requirePlacing(token.createdBy, input.sharedSpaceId);
            if (parent !== null && !this.livePage(input.sharedSpaceId, parent)) {
                throw new DataError('That page isn’t in this Space.', 404);
            }
        } else if (parent !== null) {
            throw new DataError('Put the dataset in a Space first.');
        }
        if (this.companyRows().length >= this.limits.maxDatasets) {
            throw new DataError(
                `The workspace has the most company datasets a data API token may make (${this.limits.maxDatasets}). Delete one in the app first.`,
                413,
            );
        }
        const made = this.createDataset(
            WORKSPACE_OWNER_ID,
            { name: input.name, description: input.description },
            actor,
        );
        if (input.sharedSpaceId) {
            const row = this.row(made.id)!;
            this.repos.datasets.updateNow(row.id, {
                name: row.name,
                description: row.description,
                retentionDays: row.retentionDays,
                historyDays: row.historyDays ?? null,
                sharedSpaceId: input.sharedSpaceId,
                spaceParentId: parent,
                spacePosition: null,
                spaceAddedAt: Date.now(),
            });
        }
        return this.view(this.row(made.id)!, token.createdBy);
    }
    /**
     * Changes a company dataset a data API token with `data:admin`
     * reaches: its name, description, retention, history, and its place
     * in a Space, as its maker may (`requirePlacing`); audited as the token.
     */
    updateCompanyDataset(actor: AgentActor, id: string, patch: Parameters<DataSpace['updateDataset']>[2]): DatasetView {
        const token = this.requireApiScope(actor, 'data:admin');
        const row = this.apiDataset(actor, id, 'write');
        return this.updateDataset(token.createdBy, row.id, patch, actor);
    }
    private fieldEntries(row: DatasetRow, info: TableInfo, write: boolean, withMissing: boolean) {
        const stored = new Map(
            this.repos.fields.forTable(row.id, info.name).map((item) => [item.columnName.toLowerCase(), item]),
        );
        const options = { write: write && !this.liveWriter(row.id), analytical: info.kind === 'analytical' };
        const entries = info.columns.map((column) => {
            const setting = stored.get(column.name.toLowerCase());
            stored.delete(column.name.toLowerCase());
            return fieldSettingEntry(column, setting && storedField(setting), options);
        });
        if (withMissing) {
            entries.push(...[...stored.values()].map((setting) => missingFieldEntry(storedField(setting))));
        }
        return entries;
    }
    /**
     * `PUT …/tables/:table/fields/:field` (CB-451): one field's
     * kind, label and settings, by a person who may write the dataset,
     * saved only while the stored setting is still at `baseVersion` (0
     * for one never saved). A kind or setting the column's type doesn't
     * take is a 400 naming the type. Removing options that rows still use
     * is a 409 with each one's count, until it is confirmed; the rows keep
     * their raw values. A setting whose column is gone can't be saved.
     */
    saveFieldSetting(
        userId: string,
        id: string,
        table: string,
        field: string,
        body: unknown,
        /** A data API token with `data:admin` (the route checked it), on a dataset it reaches. */
        as?: AgentActor,
    ): FieldSaveOutcome {
        if (as && !apiToken(as)) {
            throw new DataError('Only a data API token saves field settings outside the app.', 403);
        }
        const actor: DataActor = as ?? { kind: 'user', userId };
        const row = as ? this.apiDataset(as, id, 'write') : this.readable(userId, id);
        const info = this.tableOf(row, table);
        const target = `${row.name}.${info.name}.${field.slice(0, 80)}`;
        const area = isCompanyOwner(row.ownerUserId) ? { area: row.ownerUserId } : {};
        // Every refusal is audited with its code, as a save is.
        const refuse = (status: 400 | 403 | 409, refusal: WriteRefusal): FieldSaveOutcome => {
            this.audit(actor, 'field_settings', 'denied', { datasetId: row.id, target, detail: refusal.code, ...area });
            return { ok: false, status, refusal };
        };
        if (!as && !this.manages(userId, row)) {
            return refuse(403, {
                error: `Only people who may write “${row.name}” change its fields.`,
                code: VIEW_WRITE_CODES.readOnly,
            });
        }
        const parsed = fieldSettingsRequest.safeParse(body);
        if (!parsed.success) {
            const problems = parsed.error.issues.map((issue) => ({
                path: specPath(issue.path),
                message: issue.message,
            }));
            const refusal: InvalidWrite = {
                error: problems[0]?.message ?? 'Invalid request.',
                code: 'invalid',
                problems,
            };
            return refuse(400, refusal);
        }
        const request = parsed.data;
        const column: FieldColumn | undefined = info.columns.find(
            (item) => item.name.toLowerCase() === field.toLowerCase(),
        );
        if (!column) {
            throw new DataError(`Table "${info.name}" has no column "${field.slice(0, 80)}".`, 404);
        }
        const current = () => this.fieldEntries(row, info, true, false).find((entry) => entry.field === column.name)!;
        const conflict = (): FieldSaveOutcome => {
            const now = current();
            const refusal: FieldConflict = {
                error: `Someone changed “${now.label}” since you opened it. Here is the field as it is now.`,
                code: 'field_conflict',
                current: now,
            };
            return refuse(409, refusal);
        };
        const check = checkFieldSetting(column, request);
        if (!check.ok) {
            const refusal: InvalidWrite = {
                error: check.problems[0]!.message,
                code: 'invalid',
                problems: check.problems,
            };
            return refuse(400, refusal);
        }
        const stored = this.repos.fields.get(row.id, info.name, column.name);
        if ((stored?.version ?? 0) !== request.baseVersion) {
            return conflict();
        }
        // Options taken away that rows still hold: asked about first.
        const before = stored ? (storedField(stored).settings.options ?? []) : [];
        const kept = new Set((check.settings.options ?? []).map((option) => option.id));
        const removed =
            check.kind === 'select' || check.kind === 'multi_select'
                ? before.filter((option) => !kept.has(option.id))
                : [];
        if (removed.length && !request.confirmRemovedOptions && info.kind !== 'analytical') {
            const counts = this.engine.optionUse(
                this.datasetPath(row),
                info.name,
                column.name,
                removed.map((option) => option.id),
            );
            const inUse = removed
                .filter((option) => counts.has(option.id))
                .map((option) => ({ id: option.id, label: option.label, rows: counts.get(option.id)! }));
            if (inUse.length) {
                const rows = inUse.reduce((sum, option) => sum + option.rows, 0);
                const refusal: OptionsInUse = {
                    error: `${rows === 1 ? '1 row still uses' : `${rows} rows still use`} ${inUse.length === 1 ? 'an option' : 'options'} you removed. Confirm to remove ${inUse.length === 1 ? 'it' : 'them'}: those rows keep their values, shown as “Unknown option”.`,
                    code: 'options_in_use',
                    inUse,
                };
                return refuse(409, refusal);
            }
        }
        const saved = this.repos.fields.saveNow(
            {
                datasetId: row.id,
                tableName: info.name,
                columnName: column.name,
                kind: check.kind,
                label: check.label,
                settings: check.settings,
                // A person's save makes the setting theirs, not the manifest's.
                declaredBy: null,
                updatedBy: writerOf(actor),
                updatedAt: Date.now(),
            },
            request.baseVersion,
        );
        if (!saved) {
            return conflict();
        }
        this.audit(actor, 'field_settings', 'ok', {
            datasetId: row.id,
            target,
            detail: `${check.kind}${removed.length ? `; ${removed.length} option${removed.length === 1 ? '' : 's'} removed` : ''}`,
            ...area,
        });
        return { ok: true, saved: { schema: DATASET_VIEWS_SCHEMA, field: current() } };
    }
    csvFor(userId: string, id: string, table: string) {
        const row = this.readable(userId, id);
        const csv = this.engine.csv(this.datasetPath(row), table);
        this.audit({ kind: 'user', userId }, 'export_csv', 'ok', {
            datasetId: id,
            target: table,
        });
        return { name: row.name, csv };
    }
    /** A consistent copy of the dataset file, read into memory (exports). */
    sqliteFor(userId: string, id: string) {
        const row = this.readable(userId, id);
        const target = join(this.userDir(userId), 'tmp', `${randomUUID()}.sqlite`);
        try {
            // The dataset's tables, without the row history the engine keeps.
            this.engine.exportCopy(this.datasetPath(row), target);
            const bytes = readFileSync(target);
            this.audit({ kind: 'user', userId }, 'export_sqlite', 'ok', {
                datasetId: id,
                target: row.name,
            });
            return { name: row.name, bytes };
        } finally {
            rmSync(target, { force: true });
        }
    }

    // ---- what a Dot (or token) sees ----------------------------------------
    private grantRows(userId: string, dotId: string) {
        return this.db
            .prepare('SELECT * FROM data_grants WHERE ownerUserId=? AND dotId=?')
            .all(userId, dotId) as unknown as Array<{
            id: string;
            datasetId: string | null;
            folder: string | null;
            access: GrantAccess;
        }>;
    }
    /**
     * Whose dataset an actor's "scratch" is (CB-337). A company socio's is
     * its shared dataset everywhere: on its computer, in its jobs, and in
     * its chats, so a chat sees what the socio's jobs wrote. In a chat, only
     * for a person who may see that shared area (`canSeeShared`); anyone else
     * keeps their own scratch, as before. A personal socio's scratch is
     * always the user's own.
     */
    private scratchOwner(actor: AgentActor) {
        if (socioReach(actor)) {
            return sharedOwner(actor.dotId);
        }
        return actor.kind === 'dot' &&
            this.options.workspace.dot(actor.dotId)?.ownerId === null &&
            this.canSeeShared(actor.userId, actor.dotId)
            ? sharedOwner(actor.dotId)
            : actor.userId;
    }
    /** The Dot's scratch dataset (created now) and the datasets granted to it. */
    visible(actor: AgentActor, createScratch = true): Visible[] {
        if (actor.kind === 'token' && actor.purpose === 'api') {
            return apiToken(actor) ? this.apiRows(actor) : [];
        }
        if (actor.kind === 'token' && actor.purpose === 'plugin') {
            // A plugin's own token: the live datasets its installed manifest
            // declares, owned by it, within the token's ids. Nothing else: no
            // scratch, no grants, no other owner's data.
            if (!pluginToken(actor) || actor.userId !== pluginOwnerId(actor.pluginId)) {
                return [];
            }
            // The bindings the token was issued for, each at most at the
            // access it was issued with (CB-451); a token from the previous
            // release names dataset ids only.
            const issued = new Map(
                (actor.datasetIds ?? []).flatMap((entry) => {
                    const found = tokenBinding(entry);
                    return found ? [[found.id, found.access] as const] : [];
                }),
            );
            return (
                this.pluginRows(actor.pluginId)
                    .flatMap(({ row, binding, access }) => {
                        if (issued.size) {
                            const most = issued.get(binding.id);
                            return most ? [{ row, binding, access: most === 'read' ? ('read' as const) : access }] : [];
                        }
                        return !actor.datasetIds || actor.datasetIds.includes(row.id) ? [{ row, binding, access }] : [];
                    })
                    // By its need's name first, so a need named "scratch" is that one.
                    .map(({ row, binding, access }) => ({ row, access, scratch: false, ref: binding.need }))
            );
        }
        if (actor.kind === 'token' && actor.appId) {
            // A promoted app: its own grants on its user's datasets, nothing else.
            const list: Visible[] = [];
            for (const grant of this.appGrants?.(actor.appId) ?? []) {
                const row = this.row(grant.datasetId);
                // Its user's datasets, or its socio's area's: the shared one,
                // kept there at promotion, or the workspace dataset its data
                // moved into (CB-354).
                const reachable =
                    row && (row.ownerUserId === actor.userId || row.ownerUserId === sharedOwner(actor.dotId));
                if (row && reachable && (!actor.datasetIds || actor.datasetIds.includes(row.id))) {
                    list.push({
                        row,
                        access: grant.access,
                        scratch: !!row.scratchForDotId,
                        ref: grant.ref,
                    });
                }
            }
            return list;
        }
        const allowed = (id: string, scratch: boolean) =>
            actor.kind !== 'token' ||
            !actor.datasetIds ||
            actor.datasetIds.includes(id) ||
            (scratch && actor.datasetIds.includes('scratch'));
        const list: Visible[] = [];
        // A company socio's scratch is its shared dataset (CB-224, CB-337).
        const scratchOwner = this.scratchOwner(actor);
        const scratch = this.scratch(scratchOwner, actor.dotId, createScratch);
        if (scratch && allowed(scratch.id, true)) {
            list.push({ row: scratch, access: 'write', scratch: true });
        }
        // A company socio working in its shared area: the workspace datasets
        // a person approved it for (CB-354), with the access approved.
        const area = reservedUserId(scratchOwner) ? scratchOwner : undefined;
        for (const grant of area ? this.grantRows(area, actor.dotId) : []) {
            const row = grant.datasetId ? this.row(grant.datasetId) : undefined;
            if (row && row.ownerUserId === area && !row.scratchForDotId && allowed(row.id, false)) {
                list.push({ row, access: grant.access, scratch: false });
            }
        }
        // Service plugins' datasets an admin granted this socio (company data,
        // as a workspace dataset is): a company socio's for everyone who uses
        // it, an admin's own socio's while they are an admin.
        for (const { row, access } of this.pluginGrants(actor.dotId)) {
            if (row.id !== scratch?.id && allowed(row.id, false)) {
                list.push({ row, access, scratch: false });
            }
        }
        for (const grant of this.grantRows(actor.userId, actor.dotId)) {
            if (!grant.datasetId) {
                continue;
            }
            const row = this.row(grant.datasetId);
            if (!row || row.ownerUserId !== actor.userId || row.id === scratch?.id) {
                continue;
            }
            // A shared computer: only what the user shared with a Space, to read;
            // a share with a deleted Space (CB-277) is no share while it is.
            if (
                socioReach(actor) &&
                !(row.sharedSpaceId && this.options.workspace.spaces().some((space) => space.id === row.sharedSpaceId))
            ) {
                continue;
            }
            if (allowed(row.id, false)) {
                list.push({
                    row,
                    access: socioReach(actor) ? 'read' : grant.access,
                    scratch: false,
                });
            }
        }
        return list;
    }
    /**
     * What a data API token reaches: the workspace's own datasets (owner
     * `ws:workspace`), live, no socio's scratch, none with a live plugin
     * binding; written with `data:write` or `data:admin`, else read. Never
     * a person's dataset, a socio's area or a `plugin:<id>` one.
     */
    private apiRows(actor: AgentActor): Visible[] {
        const access: GrantAccess = apiWrites(actor) ? 'write' : 'read';
        return this.companyRows().map((row) => ({ row, access, scratch: false }));
    }
    /** The workspace's datasets no plugin is bound to: what data API tokens reach. */
    private companyRows(): DatasetRow[] {
        const rows = this.db
            .prepare(
                `SELECT * FROM data_datasets WHERE ownerUserId=? AND scratchForDotId IS NULL AND ${LIVE} ORDER BY name, createdAt`,
            )
            .all(WORKSPACE_OWNER_ID) as unknown as DatasetRow[];
        return rows.filter((row) => !this.repos.bindings.liveForDataset(row.id).length);
    }
    /**
     * Grants on plugins' datasets (owned by `plugin:<id>`) for a socio: a
     * company socio's, or a personal socio's whose owner is an admin now.
     */
    private pluginGrants(dotId: string): Array<{ row: DatasetRow; access: GrantAccess }> {
        const grants = this.db
            .prepare(`SELECT * FROM data_grants WHERE dotId=? AND datasetId IS NOT NULL AND ${COMPANY_OWNERS}`)
            .all(dotId) as unknown as Array<{ ownerUserId: string; datasetId: string; access: GrantAccess }>;
        if (!grants.length) {
            return [];
        }
        const dot = this.options.workspace.dot(dotId);
        if (!dot || dot.archivedAt || (dot.ownerId && !this.isAdminId(dot.ownerId))) {
            return [];
        }
        return grants.flatMap((grant) => {
            const row = this.row(grant.datasetId);
            return row && row.ownerUserId === grant.ownerUserId ? [{ row, access: grant.access }] : [];
        });
    }
    /**
     * The datasets bound to a plugin's needs (CB-451) that its installed
     * manifest still declares, live, with their bindings: what its token
     * reaches, each with its binding's access.
     */
    private pluginRows(pluginId: string): Array<{ row: DatasetRow; binding: PluginBinding; access: GrantAccess }> {
        const declared = (this.pluginSource?.declared(pluginId) ?? []) as ReadonlyArray<DeclaredPluginDataset>;
        return this.repos.bindings.liveForPlugin(pluginId).flatMap((binding) => {
            const need = declared.find((item) => item.name.toLowerCase() === binding.need.toLowerCase());
            // A binding the installed manifest doesn't declare (one an update
            // not adopted yet made, a need it dropped) reaches nothing.
            if (!need) {
                return [];
            }
            const row = this.row(binding.datasetId);
            // The installed manifest's access is the ceiling: a binding an
            // update not adopted yet made never writes (CB-451).
            const access: GrantAccess =
                binding.access === 'write' && pluginNeedAccess(need) === 'write' ? 'write' : 'read';
            return row ? [{ row, binding, access }] : [];
        });
    }
    /** The visible dataset a reference (a promoted app's ref, id, name, or none for scratch) names. */
    private pick(visible: Visible[], wanted: string | undefined) {
        // A promoted app names datasets as its manifest did, wherever they went.
        const byRef = visible.find(
            (item) => item.ref !== undefined && item.ref.toLowerCase() === (wanted || 'scratch').toLowerCase(),
        );
        if (byRef) {
            return byRef;
        }
        if (!wanted || wanted.toLowerCase() === 'scratch') {
            return visible.find((item) => item.scratch);
        }
        const byId = widest(visible.filter((item) => item.row.id === wanted));
        if (byId) {
            return byId;
        }
        // One dataset may be visible twice (a plugin's read and write needs
        // on it, CB-451): several entries of one dataset are that dataset.
        const named = visible.filter((item) => item.row.name.toLowerCase() === wanted.toLowerCase());
        if (new Set(named.map((item) => item.row.id)).size > 1) {
            throw new DataError(`Several datasets are named "${wanted}"; use the id from data_list.`);
        }
        return widest(named);
    }
    /**
     * The dataset a token's reference names, its id and (a promoted app's)
     * manifest ref, without creating, auditing or refusing anything: what the
     * data API's on-behalf-of check (CB-232, `obo.ts`) authorizes against.
     * Undefined when it names nothing visible, or several.
     */
    datasetFor(actor: AgentActor, ref: string | undefined): { id: string; ref?: string } | undefined {
        try {
            const match = this.pick(this.visible(actor, false), ref?.trim());
            return match && { id: match.row.id, ref: match.ref };
        } catch {
            return undefined;
        }
    }
    /** Resolves a dataset reference (id, name, or none for scratch) for a Dot. */
    private resolve(actor: AgentActor, ref: string | undefined, need: GrantAccess): Visible {
        const visible = this.visible(actor);
        const wanted = ref?.trim();
        const match = this.pick(visible, wanted);
        // A shared computer: private or missing, the same answer; the audit
        // keeps which (CB-224).
        if (!match && socioReach(actor)) {
            const target = wanted ?? 'scratch';
            const own = this.visible(asPerson(actor), false).some(
                (item) => item.row.id === target || item.row.name.toLowerCase() === target.toLowerCase(),
            );
            this.audit(actor, 'access', 'denied', {
                target,
                detail: own ? `${need} of the user's own data from a shared computer` : `${need} without a grant`,
            });
            throw new DataError(sharedComputerNoDataset(target), 404);
        }
        if (!match && apiToken(actor)) {
            this.audit(actor, 'access', 'denied', {
                target: wanted ?? 'scratch',
                detail: `${need} of a dataset out of a data API token’s reach`,
            });
            throw new DataError(
                `No company dataset "${wanted ?? ''}" is available to this token. A data API token reaches the workspace’s own datasets no plugin is bound to (GET /api/data/datasets lists them), never a person’s, a socio’s or a plugin’s.`,
                404,
            );
        }
        if (!match && pluginToken(actor)) {
            this.audit(actor, 'access', 'denied', {
                target: wanted ?? 'scratch',
                detail: `${need} of a dataset not bound to the plugin`,
            });
            throw new DataError(
                `No dataset "${wanted ?? 'scratch'}" is bound to this plugin. Its token reaches only the datasets an admin bound to its manifest's needs (GET /api/data/datasets lists them).`,
                404,
            );
        }
        if (!match) {
            this.audit(actor, 'access', 'denied', {
                target: wanted ?? 'scratch',
                detail: `${need} without a grant`,
            });
            throw new DataError(
                `No dataset "${wanted}" is available to this socio. data_list shows yours; request a grant with data_request_access, which shows the user an approval card.`,
                404,
            );
        }
        if (need === 'write' && match.access !== 'write') {
            this.audit(actor, 'access', 'denied', {
                datasetId: match.row.id,
                target: match.row.name,
                detail: socioReach(actor)
                    ? 'write to a Space-shared dataset from a shared computer'
                    : pluginToken(actor)
                      ? 'write on a read binding'
                      : apiToken(actor)
                        ? 'write with a read-only data API token'
                        : 'write on a read grant',
            });
            if (apiToken(actor)) {
                throw new DataError('This data API token only reads: it has neither data:write nor data:admin.', 403);
            }
            if (socioReach(actor)) {
                throw new DataError(SHARED_COMPUTER_READ_ONLY, 403);
            }
            if (pluginToken(actor)) {
                throw new DataError(
                    `This plugin reads "${match.ref ?? match.row.name}" (a read need): its token may query it, never write it.`,
                    403,
                );
            }
            throw new DataError(
                `This socio may only read "${match.row.name}". Ask for write access with data_request_access.`,
                403,
            );
        }
        return match;
    }
    list(actor: AgentActor) {
        this.limitRate(actor);
        return this.visible(actor).map(({ row, access, scratch }) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            kind: scratch ? 'scratch' : 'dataset',
            access,
            sharedWithSpace: !!row.sharedSpaceId,
            tables: row.tableCount,
            sizeBytes: row.sizeBytes,
            updatedAt: new Date(row.updatedAt).toISOString(),
        }));
    }
    describe(actor: AgentActor, ref?: string) {
        this.limitRate(actor);
        const { row, access, scratch } = this.resolve(actor, ref, 'read');
        // A plugin sees its analytical tables too; socios and apps don't
        // reach them yet (CB-369 Phase 1).
        const tables = pluginToken(actor) ? this.tablesOf(row) : this.engine.tables(this.datasetPath(row));
        this.audit(actor, 'describe', 'ok', {
            datasetId: row.id,
            target: row.name,
        });
        return {
            id: row.id,
            name: row.name,
            kind: scratch ? 'scratch' : 'dataset',
            access,
            sharedWithSpace: !!row.sharedSpaceId,
            sizeBytes: row.sizeBytes,
            maxBytes: isCompanyOwner(row.ownerUserId) ? this.limits.pluginDatasetMaxBytes : this.limits.datasetMaxBytes,
            tables,
        };
    }
    async query(
        actor: DataActor,
        ref: string | undefined,
        sql: string,
        params: Array<string | number | boolean | null> = [],
        maxRows?: number,
    ): Promise<QueryResult & { dataset: string; datasetId: string }> {
        let row: DatasetRow;
        if (actor.kind === 'user') {
            if (!ref) {
                throw new DataError('Choose a dataset.');
            }
            row = this.readable(actor.userId, ref);
        } else {
            this.limitRate(actor);
            row = this.resolve(actor, ref, 'read').row;
        }
        try {
            const caps = this.queryCaps(row);
            const result = await this.engine.query(this.datasetPath(row), sql, params, {
                maxRows: Math.min(maxRows ?? caps.maxRows, caps.maxRows),
                maxBytes: caps.maxBytes,
                timeoutMs: this.limits.queryTimeoutMs,
            });
            this.audit(actor, 'query', 'ok', {
                datasetId: row.id,
                target: row.name,
                detail: `${result.rows.length} row(s)${result.truncated ? ', truncated' : ''}: ${sql.replace(/\s+/g, ' ').slice(0, 200)}`,
            });
            return { dataset: row.name, datasetId: row.id, ...result };
        } catch (raw) {
            // An analytical table's name (CB-369): it has a query route of its own.
            const missing =
                raw instanceof DataError ? /no such table: (?:main\.)?"?([A-Za-z0-9_]+)"?/i.exec(raw.message) : null;
            const error =
                missing && this.engine.analyticalTable(this.datasetPath(row), missing[1]!)
                    ? new DataError(
                          `"${missing[1]}" is an analytical table: query it with POST /api/data/datasets/:id/analytics/query (DuckDB SQL), which reads both kinds of table.`,
                      )
                    : raw;
            this.audit(actor, 'query', error instanceof DataError && error.status === 403 ? 'denied' : 'error', {
                datasetId: row.id,
                target: row.name,
                detail: `${error instanceof Error ? error.message.slice(0, 120) : 'failed'}: ${sql.replace(/\s+/g, ' ').slice(0, 150)}`,
            });
            throw error;
        }
    }
    /**
     * What one query may return. A plugin's dataset has its own row limit,
     * which an admin may raise; its byte cap grows with it (up to 8 MB), so
     * a raised row limit isn't cut short by the bytes.
     */
    private queryCaps(row: DatasetRow) {
        const { queryMaxRows, queryMaxBytes, pluginQueryMaxRows } = this.limits;
        if (!isCompanyOwner(row.ownerUserId)) {
            return { maxRows: queryMaxRows, maxBytes: queryMaxBytes };
        }
        const scaled = Math.ceil((queryMaxBytes * pluginQueryMaxRows) / Math.max(queryMaxRows, 1));
        return { maxRows: pluginQueryMaxRows, maxBytes: Math.max(queryMaxBytes, Math.min(scaled, 8 * 1024 * 1024)) };
    }
    /**
     * A read batch (CB-474): up to `batchMaxStatements` SELECTs, each
     * checked and capped as `query` checks and caps one, read from one
     * snapshot (one read transaction), and counted as one operation. Each
     * statement has the query time limit; the batch, the batch time limit.
     */
    async readBatch(
        actor: DataActor,
        ref: string | undefined,
        statements: DataReadBatchStatement[],
        maxRows?: number,
    ): Promise<DataReadBatchResult> {
        const max = this.limits.batchMaxStatements;
        if (!Array.isArray(statements) || !statements.length || statements.length > max) {
            throw new DataError(`A read batch has 1 to ${max} statements.`, statements?.length > max ? 413 : 400);
        }
        let row: DatasetRow;
        if (actor.kind === 'user') {
            if (!ref) {
                throw new DataError('Choose a dataset.');
            }
            row = this.readable(actor.userId, ref);
        } else {
            this.limitRate(actor);
            row = this.resolve(actor, ref, 'read').row;
        }
        const started = performance.now();
        try {
            const caps = this.queryCaps(row);
            const results = await this.engine.readBatch(this.datasetPath(row), statements, {
                maxRows: Math.min(maxRows ?? caps.maxRows, caps.maxRows),
                maxBytes: caps.maxBytes,
                maxTotalBytes: Math.max(caps.maxBytes, READ_BATCH_MAX_BYTES),
                timeoutMs: this.limits.queryTimeoutMs,
                totalTimeoutMs: this.limits.batchTimeoutMs,
            });
            const rows = results.reduce((sum, result) => sum + result.rows.length, 0);
            this.audit(actor, 'read_batch', 'ok', {
                datasetId: row.id,
                target: row.name,
                detail: `${statements.length} statement(s), ${rows} row(s)${results.some((result) => result.truncated) ? ', truncated' : ''}`,
            });
            return {
                dataset: row.name,
                datasetId: row.id,
                statements: results.length,
                results,
                ms: Math.round(performance.now() - started),
            };
        } catch (error) {
            this.audit(actor, 'read_batch', error instanceof DataError && error.status === 403 ? 'denied' : 'error', {
                datasetId: row.id,
                target: row.name,
                detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
            });
            throw error;
        }
    }
    /**
     * A schema or row change by a Dot or token. Space-shared datasets need
     * the user's approval (`data.write_shared`): the change is stored and runs
     * when they approve, unless their policy for this Dot is bypass.
     */
    async write(actor: AgentActor, ref: string | undefined, write: WriteOp, approved = false): Promise<WriteResult> {
        this.limitRate(actor);
        const { row } = this.resolve(actor, ref, 'write');
        // A promoted app's write grant was approved with its promotion;
        // a plugin writes its own datasets, shared with a Space or not.
        const promotedApp = actor.kind === 'token' && !!actor.appId;
        // ANALYZE changes no row or column anyone sees, only the planner's
        // statistics: it needs no approval (CB-355).
        // An admin's data API token writes the company's own datasets as the admin would.
        if (
            row.sharedSpaceId &&
            !approved &&
            !promotedApp &&
            !pluginToken(actor) &&
            !apiToken(actor) &&
            write.op !== 'analyze'
        ) {
            const dot = this.requireDot(actor.dotId);
            const outcome = await this.options.approvals.request<WriteSharedPayload>({
                userId: actor.userId,
                dotId: actor.dotId,
                capability: APPROVAL_CAPABILITIES.writeShared,
                summary: `${dot.name} wants to ${describeWrite(write)} in “${row.name}”, which is shared with a Space`,
                details: writeDetails(write),
                payload: { datasetId: row.id, write },
                threadId: actor.kind === 'dot' ? actor.threadId : undefined,
            });
            if (outcome.status === 'pending_approval') {
                this.audit(actor, write.op, 'pending', {
                    datasetId: row.id,
                    target: row.name,
                    detail: `approval ${outcome.id}`,
                });
                return outcome;
            }
            if (outcome.status === 'denied') {
                return outcome;
            }
            return {
                status: 'done',
                dataset: row.name,
                result: { approved: outcome.via, outcome: outcome.outcome },
            };
        }
        // Asked before the write is audited: is this the chat's first one here?
        const notice = write.op === 'analyze' ? undefined : this.sharedWriteNotice(actor, row);
        return {
            status: 'done',
            dataset: row.name,
            result: this.applyWrite(actor, row, write),
            ...(notice ? { notice } : {}),
        };
    }
    /**
     * The owner's own index change or ANALYZE on one of their datasets
     * (CB-355), from the data API with their session: no approval, as theirs.
     */
    ownerIndexWrite(userId: string, id: string, write: DataIndexWriteOp) {
        const row = this.managedRow(userId, id);
        return {
            status: 'done' as const,
            dataset: row.name,
            result: this.applyWrite({ kind: 'user', userId }, row, write),
        };
    }
    /**
     * Switches a table's row history on or off (CB-369 Phase H): the
     * dataset's owner (an admin, for a plugin's) in the app, or a plugin
     * with its own token on its own dataset. Never another token: a
     * socio's or app's history is its owner's record of what it changed.
     * Off drops the table's triggers; what it kept goes at the next
     * nightly prune.
     */
    setTableHistory(actor: DataActor, ref: string, table: string, on: boolean) {
        let row: DatasetRow;
        if (actor.kind === 'user') {
            row = this.managedRow(actor.userId, ref);
        } else {
            if (!pluginToken(actor)) {
                this.audit(actor, 'table_history', 'denied', { target: `${ref}.${table}` });
                throw new DataError(
                    'Only the dataset’s owner, or a plugin on its own dataset, switches row history.',
                    403,
                );
            }
            this.limitRate(actor);
            // Write access within its token: only on a dataset it writes (CB-451).
            row = this.resolve(actor, ref, 'write').row;
        }
        const area = nonPersonOwnerId(row.ownerUserId) ? row.ownerUserId : undefined;
        try {
            const result = this.engine.setHistory(this.datasetPath(row), table, on, { writer: writerOf(actor) });
            if (result.changed) {
                this.touch(row);
                this.audit(actor, 'table_history', 'ok', {
                    area,
                    datasetId: row.id,
                    target: `${row.name}.${table}`,
                    detail: on ? 'row history on' : 'row history off; kept rows go at the next prune',
                });
            }
            return { status: 'done' as const, dataset: row.name, result };
        } catch (error) {
            this.audit(actor, 'table_history', 'error', {
                area,
                datasetId: row.id,
                target: `${row.name}.${table}`,
                detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
            });
            throw error;
        }
    }
    /**
     * Asks to compact a dataset's file at the next nightly run (CB-369
     * Phase H): `VACUUM` gives back the pages a prune freed. Its owner (an
     * admin, for a plugin's) asks, or takes the request back.
     */
    requestCompact(userId: string, id: string, cancel = false): DatasetView {
        const row = this.managedRow(userId, id);
        const at = cancel ? null : (row.compactRequestedAt ?? Date.now());
        if (at !== (row.compactRequestedAt ?? null)) {
            this.repos.datasets.requestCompactNow(id, at);
            this.audit({ kind: 'user', userId }, 'compact_request', 'ok', {
                datasetId: id,
                target: row.name,
                detail: cancel ? 'cancelled' : 'at the next nightly run',
                ...(isCompanyOwner(row.ownerUserId) ? { area: row.ownerUserId } : {}),
            });
        }
        return this.view(this.row(id)!, userId);
    }
    /**
     * The nightly row-history work (CB-369 Phase H), as the system, one
     * dataset at a time: deletes what each live dataset's tables without
     * history still keep and, with `historyDays`, every kept row replaced
     * before then (`DatasetEngine.pruneHistory`), audited as
     * `history_prune`; then compacts each file its owner asked for
     * (`compact`). A missing or unreadable file is skipped (and named in
     * the count), never fatal. `historyMaintenanceDue`: once a night, in
     * the server's off-hours (02:00 to 06:00 its local time), on the
     * runtime that leads (the module's hourly tick).
     */
    historyMaintenanceDue(now = Date.now()) {
        const hour = new Date(now).getHours();
        return hour >= NIGHT_FROM_HOUR && hour < NIGHT_TO_HOUR && now - this.historyRunAt > 20 * 3_600_000;
    }
    async maintainHistory(now = Date.now()) {
        this.historyRunAt = now;
        const rows = this.db
            .prepare(`SELECT * FROM data_datasets WHERE ${LIVE} ORDER BY id`)
            .all() as unknown as DatasetRow[];
        const done = { pruned: 0, rows: 0, compacted: 0, failed: 0 };
        for (const row of rows) {
            if (this.closed) {
                break;
            }
            const path = this.datasetPath(row);
            if (!existsSync(path)) {
                continue;
            }
            const system = { kind: 'system' as const, userId: row.ownerUserId };
            const area = nonPersonOwnerId(row.ownerUserId) ? row.ownerUserId : undefined;
            try {
                const before = row.historyDays ? now - row.historyDays * DAY : null;
                const pruned = await this.engine.pruneHistory(path, before, {
                    now,
                    // Row stamps' tombstones (CB-451): changes reads older than this reconcile.
                    tombstonesBefore: now - this.limits.stampTombstoneDays * DAY,
                });
                if (pruned.rows || pruned.writes || pruned.tombstones) {
                    this.remeasure(row);
                    done.pruned++;
                    done.rows += pruned.rows;
                    this.audit(system, 'history_prune', 'ok', {
                        area,
                        datasetId: row.id,
                        target: row.name,
                        detail: `${pruned.rows} kept row(s), ${pruned.writes} write record(s)${pruned.tombstones ? `, ${pruned.tombstones} deleted row stamp(s)` : ''}${row.historyDays ? `; keeps ${row.historyDays} days` : ''}`,
                    });
                }
            } catch (error) {
                done.failed++;
                this.audit(system, 'history_prune', 'error', {
                    area,
                    datasetId: row.id,
                    target: row.name,
                    detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
                });
            }
            // As it is now: the owner may have taken the request back meanwhile.
            const asked = this.row(row.id)?.compactRequestedAt;
            if (!asked) {
                continue;
            }
            try {
                const before = this.engine.size(path);
                await this.engine.vacuum(path, COMPACT_TIMEOUT_MS);
                this.remeasure(row);
                // Only the request this run did: a new one stays for tomorrow.
                this.repos.datasets.clearCompactNow(row.id, asked);
                done.compacted++;
                this.audit(system, 'compact', 'ok', {
                    area,
                    datasetId: row.id,
                    target: row.name,
                    detail: `${before} → ${this.engine.size(path)} bytes`,
                });
            } catch (error) {
                done.failed++;
                this.audit(system, 'compact', 'error', {
                    area,
                    datasetId: row.id,
                    target: row.name,
                    detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
                });
            }
        }
        return done;
    }
    /**
     * Partition retention (CB-387), with the nightly history run: each
     * analytical table with `retainDays` retires the partitions that ended
     * longer ago. Queries stop reading them at once; the sweep deletes their
     * files `RETIRED_KEEP_MS` later. Audited per table as the system.
     */
    applyAnalyticalRetention(now = Date.now()) {
        const rows = this.db
            .prepare(`SELECT * FROM data_datasets WHERE ${COMPANY_OWNERS} AND ${LIVE} ORDER BY id`)
            .all() as unknown as DatasetRow[];
        const done = { partitions: 0, rows: 0, failed: 0 };
        for (const row of rows) {
            if (this.closed) {
                break;
            }
            const path = this.datasetPath(row);
            if (!existsSync(path)) {
                continue;
            }
            const system = { kind: 'system' as const, userId: row.ownerUserId };
            try {
                const retired = this.engine.retirePastRetention(
                    path,
                    now,
                    (table) => this.retentionOf(row, table).days,
                );
                if (!retired.length) {
                    continue;
                }
                this.recordAnalytical(row);
                const byTable = new Map<string, typeof retired>();
                for (const item of retired) {
                    byTable.set(item.table, [...(byTable.get(item.table) ?? []), item]);
                }
                for (const [table, items] of byTable) {
                    const rowsDropped = items.reduce((sum, item) => sum + item.rows, 0);
                    done.partitions += items.length;
                    done.rows += rowsDropped;
                    this.audit(system, 'retention_drop_partition', 'ok', {
                        area: row.ownerUserId,
                        datasetId: row.id,
                        target: `${row.name}.${table}`,
                        detail: `${items.length} partition(s) (${items[0]!.partition} to ${items.at(-1)!.partition}), ${rowsDropped} row(s), ${items.reduce((sum, item) => sum + item.bytes, 0)} bytes`,
                    });
                }
            } catch (error) {
                done.failed++;
                this.audit(system, 'retention_drop_partition', 'error', {
                    area: row.ownerUserId,
                    datasetId: row.id,
                    target: row.name,
                    detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
                });
            }
        }
        return done;
    }
    // ---- analytical tables (CB-369 Phase 1) ---------------------------------
    /** A dataset's tables for the Data page and a plugin: both kinds, transactional first. */
    private tablesOf(row: DatasetRow): TableInfo[] {
        const path = this.datasetPath(row);
        const tables = this.engine.tables(path);
        const analytical = this.engine.analyticalTables(path).map((table) => ({
            name: table.name,
            columns: table.columns.map((column) => ({
                name: column.name,
                type: column.type,
                notNull: !!column.notNull,
                primaryKey: false,
                defaultValue: null,
            })),
            rowCount: table.rowCount,
            kind: 'analytical' as const,
            analytical: this.withRetention(row, table, table.stats),
        }));
        return [...tables, ...analytical];
    }
    /** A table's stats with the retention that applies to it (`retentionOf`) and where it comes from. */
    private withRetention(row: DatasetRow, table: AnalyticalTable, stats: AnalyticalTableStats): AnalyticalTableStats {
        const retention = this.retentionOf(row, table);
        const { retainDays: _, ...rest } = stats;
        return { ...rest, ...(retention.days ? { retainDays: retention.days } : {}), retention };
    }
    /**
     * CB-369 Phase 1's reach: analytical tables live in service plugins' own
     * datasets only, written by the plugin's own token, and read by it or by
     * an admin who manages the dataset. Throws for anything else.
     */
    private analyticalReach(actor: DataActor, row: DatasetRow, need: 'write' | 'read') {
        if (!this.analytics.enabled) {
            throw new DataError('Analytical tables are off on this server (DATA_ANALYTICS_MODE=off).', 503);
        }
        // Bound to the plugin within its token (CB-451): a reader reads, only its writer writes.
        // Install and update work as the plugin with no token (no ids): by
        // its live bindings, before its installed manifest names them.
        const own =
            pluginToken(actor) &&
            (actor.datasetIds
                ? this.visible(actor, false).some(
                      (item) => item.row.id === row.id && (need === 'read' || item.access === 'write'),
                  )
                : this.repos.bindings
                      .liveForDataset(row.id)
                      .some(
                          (binding) =>
                              binding.pluginId === actor.pluginId && (need === 'read' || binding.access === 'write'),
                      ));
        const admin = need === 'read' && actor.kind === 'user' && this.manages(actor.userId, row);
        if (!isCompanyOwner(row.ownerUserId) || !(own || admin)) {
            throw new DataError(
                'Analytical tables are only in datasets bound to service plugins for now: the plugin that writes one writes them, plugins bound to read it and admins read them.',
                403,
            );
        }
    }
    /** Throws unless this server makes analytical tables now (the mode, a deploy under way). */
    private analyticalTablesAvailable() {
        if (!this.analytics.enabled) {
            throw new DataError('Analytical tables are off on this server (DATA_ANALYTICS_MODE=off).', 503);
        }
        this.analyticsContractKept();
    }
    /** Waits while an older runtime that doesn't know analytical tables still runs (a deploy). */
    private analyticsContractKept() {
        if (this.options.runtime?.contractBehind(ANALYTICS_CONTRACT, ANALYTICS_CONTRACT_VERSION)) {
            throw new DataError(
                'A deploy is under way and the previous release doesn’t know analytical tables yet: try again in a few minutes.',
                409,
            );
        }
    }
    /** One analytical commit of `owner`'s at a time (its budget check holds across appends). */
    private async ownerAnalyticalLock<T>(owner: string, work: () => Promise<T> | T): Promise<T> {
        const before = this.analyticalLocks.get(owner) ?? Promise.resolve();
        const run = before.then(work, work);
        const settled = run.then(
            () => undefined,
            () => undefined,
        );
        this.analyticalLocks.set(owner, settled);
        try {
            return await run;
        } finally {
            if (this.analyticalLocks.get(owner) === settled) {
                this.analyticalLocks.delete(owner);
            }
        }
    }
    /** Bytes `owner`'s analytical tables may still add (their own budget). */
    private analyticalRoom(owner: string) {
        // From the catalogs themselves, the source of truth: the recorded
        // `analyticalBytes` may lag one append behind after a crash.
        const rows = this.db
            .prepare(`SELECT id, ownerUserId FROM data_datasets WHERE ownerUserId=? AND ${LIVE}`)
            .all(owner) as Array<Pick<DatasetRow, 'id' | 'ownerUserId'>>;
        let used = 0;
        for (const row of rows) {
            const path = this.datasetPath(row);
            if (existsSync(path)) {
                used += this.engine.analyticalBytes(path);
            }
        }
        return this.limits.analyticalMaxBytes - used;
    }
    /** The DuckDB caps every job of the analytics process runs with. */
    private duckCaps(row: DatasetRow) {
        const limits = this.limits;
        return {
            memoryMb: limits.analyticsQueryMemoryMb,
            threads: limits.analyticsThreads,
            tempMb: limits.analyticsQueryTempMb,
            tempDir: join(partsDir(this.datasetPath(row)), STAGING_DIR, `tmp-${randomUUID()}`),
        };
    }
    /** Where an append's body is streamed before the analytics process reads it. */
    appendBodyPath(actor: AgentActor, ref: string) {
        // The append's one statement against the per-minute budget, and its
        // checks, before a byte of the body is written anywhere.
        this.limitRate(actor);
        const { row } = this.resolve(actor, ref, 'write');
        this.refuseNonWriter(actor, row, 'append');
        this.analyticalReach(actor, row, 'write');
        this.analyticsContractKept();
        return join(partsDir(this.datasetPath(row)), STAGING_DIR, `${randomUUID()}.body`);
    }
    /**
     * Appends rows to an analytical table: the plugin's own token,
     * one statement against the per-minute budget. The analytics process
     * checks every row against the declaration and stages one Parquet file
     * per partition; the app commits them in one transaction, inside the
     * owner's analytical budget. With `appendId`, an id already committed
     * for the table adds nothing and answers its first counts
     * (`duplicate`), so a retry never doubles rows.
     */
    async append(
        actor: AgentActor,
        ref: string,
        tableName: string,
        source:
            | { kind: 'body'; file: string; format: 'ndjson' | 'json' }
            | {
                  kind: 'sqlite';
                  table: string;
                  where?: { column: string; from?: string | number; to?: string | number };
              },
        appendId: string | null,
    ) {
        const action = source.kind === 'body' ? 'append' : 'append_from';
        // A body's append counted when its body was taken (`appendBodyPath`).
        if (source.kind !== 'body') {
            this.limitRate(actor);
        }
        const { row } = this.resolve(actor, ref, 'write');
        this.refuseNonWriter(actor, row, action);
        const path = this.datasetPath(row);
        const area = nonPersonOwnerId(row.ownerUserId) ? row.ownerUserId : undefined;
        const audit = (outcome: 'ok' | 'error' | 'denied', detail: string) =>
            this.audit(actor, action, outcome, {
                area,
                datasetId: row.id,
                target: `${row.name}.${tableName}`,
                detail,
            });
        try {
            this.analyticalReach(actor, row, 'write');
            this.analyticsContractKept();
            if (appendId !== null && !/^[\x21-\x7e]{1,200}$/.test(appendId)) {
                throw new DataError('An append id is 1 to 200 visible ASCII characters.');
            }
            const table = this.engine.analyticalTable(path, tableName);
            if (!table) {
                throw new DataError(`No analytical table "${tableName}" in this dataset.`, 404);
            }
            const duplicate = (before: Array<{ rows: number; bytes: number }>) => ({
                status: 'done' as const,
                table: table.name,
                rows: before.reduce((sum, part) => sum + Number(part.rows), 0),
                parts: before.length,
                bytes: before.reduce((sum, part) => sum + Number(part.bytes), 0),
                duplicate: true,
            });
            if (appendId) {
                const before = this.engine.appendedParts(path, table.id, appendId);
                if (before.length) {
                    // A retry after a crash: the record catches up with the catalog.
                    this.recordAnalytical(row);
                    audit('ok', `duplicate of append ${appendId}: nothing added`);
                    return duplicate(before);
                }
            }
            const job: WorkerJob = {
                kind: 'stage',
                datasetPath: path,
                table,
                source,
                maxRows: this.limits.appendMaxRows,
                ...this.duckCaps(row),
            };
            const staged = await this.analytics.run<StageAnswer>(job, {
                timeoutMs: APPEND_TIMEOUT_MS,
                concurrency: this.limits.analyticsQueryConcurrency,
            });
            // The owner's budget is checked and spent inside one write
            // transaction (BEGIN IMMEDIATE) on the app's database, which every
            // runtime shares: two appends of one owner, on any runtimes,
            // commit one at a time.
            const outcome = await this.ownerAnalyticalLock(row.ownerUserId, () =>
                transaction(this.db, 'analytical commit', () => {
                    // Checked again under the lock: the dataset may have been
                    // deleted, or the reach taken away, while the parts staged.
                    try {
                        const now = this.resolve(actor, row.id, 'write').row;
                        if (now.id !== row.id || now.ownerUserId !== row.ownerUserId) {
                            throw new DataError('The dataset changed while the rows were staged: append again.', 409);
                        }
                        this.analyticalReach(actor, now, 'write');
                    } catch (error) {
                        for (const part of staged.parts) {
                            rmSync(stagedPath(path, part.id), { force: true });
                        }
                        throw error;
                    }
                    const committed = this.engine.commitParts(path, table, staged.parts, {
                        appendId,
                        writer: writerOf(actor),
                        room: () => this.analyticalRoom(row.ownerUserId),
                    });
                    if (!committed.duplicate) {
                        this.recordAnalytical(row);
                    }
                    return committed;
                }),
            );
            if (outcome.duplicate) {
                this.recordAnalytical(row);
                audit('ok', `duplicate of append ${appendId}: nothing added`);
                return duplicate(outcome.before);
            }
            const bytes = staged.parts.reduce((sum, part) => sum + part.bytes, 0);
            audit(
                'ok',
                `${staged.rows} row(s), ${staged.parts.length} part(s), ${bytes} bytes${appendId ? `, append ${appendId}` : ''}${source.kind === 'sqlite' ? ` from ${source.table}` : ''}`,
            );
            return { status: 'done' as const, table: table.name, rows: staged.rows, parts: staged.parts.length, bytes };
        } catch (error) {
            audit(
                error instanceof DataError && error.status === 403 ? 'denied' : 'error',
                error instanceof Error ? error.message.slice(0, 200) : 'failed',
            );
            throw error;
        } finally {
            if (source.kind === 'body') {
                rmSync(source.file, { force: true });
            }
        }
    }
    /** A dataset's analytical bytes as its catalog sums them now, and its change. */
    private recordAnalytical(row: DatasetRow) {
        try {
            this.repos.datasets.recordAnalyticalBytesNow(
                row.id,
                this.engine.analyticalBytes(this.datasetPath(row)),
                Date.now(),
            );
        } catch (error) {
            // The budget reads the catalogs, never this record; the next
            // append records it again.
            console.warn(
                `Data space: recording a dataset's analytical bytes failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
            );
        }
    }
    /**
     * An analytical query: one DuckDB SELECT over the dataset's tables,
     * both kinds, read-only, in the analytics process, under the analytical
     * limits. The plugin's own token (one statement against the per-minute
     * budget), or an admin who manages the dataset, in the app.
     */
    async analyticsQuery(
        actor: DataActor,
        ref: string,
        sql: string,
        params: Array<string | number | boolean | null> = [],
        maxRows?: number,
    ): Promise<QueryResult & { dataset: string; datasetId: string }> {
        let row: DatasetRow;
        if (actor.kind === 'user') {
            row = this.readable(actor.userId, ref);
        } else {
            this.limitRate(actor);
            row = this.resolve(actor, ref, 'read').row;
        }
        const area = nonPersonOwnerId(row.ownerUserId) ? row.ownerUserId : undefined;
        const text = sql.replace(/\s+/g, ' ');
        try {
            this.analyticalReach(actor, row, 'read');
            const limits = this.limits;
            const result = await this.analytics.run<QueryResult>(
                {
                    kind: 'query',
                    datasetPath: this.datasetPath(row),
                    sql,
                    params,
                    maxRows: Math.min(maxRows ?? limits.analyticsQueryMaxRows, limits.analyticsQueryMaxRows),
                    maxBytes: limits.analyticsQueryMaxBytes,
                    joinMaxRows: limits.analyticsJoinMaxRows,
                    joinMaxBytes: limits.analyticsJoinMaxBytes,
                    timeoutMs: limits.analyticsQueryTimeoutMs,
                    ...this.duckCaps(row),
                },
                // DuckDB's own interrupt first; the process is killed 5 s later.
                { timeoutMs: limits.analyticsQueryTimeoutMs + 5_000, concurrency: limits.analyticsQueryConcurrency },
            );
            this.audit(actor, 'analytics_query', 'ok', {
                area,
                datasetId: row.id,
                target: row.name,
                detail: `${result.rows.length} row(s)${result.truncated ? ', truncated' : ''} in ${result.ms} ms: ${text.slice(0, 200)}`,
            });
            return { dataset: row.name, datasetId: row.id, ...result };
        } catch (error) {
            this.audit(
                actor,
                'analytics_query',
                error instanceof DataError && error.status === 403 ? 'denied' : 'error',
                {
                    area,
                    datasetId: row.id,
                    target: row.name,
                    detail: `${error instanceof Error ? error.message.slice(0, 120) : 'failed'}: ${text.slice(0, 150)}`,
                },
            );
            throw error;
        }
    }
    /**
     * Clears what an interrupted append left: staged files and
     * request bodies, and part files no catalog lists (moved, then the
     * commit failed or the process died), once they are an hour old. Never
     * a listed part. Counts, for the log.
     */
    sweepAnalytical(now = Date.now()) {
        let removed = 0;
        const rows = this.db
            .prepare(`SELECT id, ownerUserId FROM data_datasets WHERE ${COMPANY_OWNERS}`)
            .all() as Array<Pick<DatasetRow, 'id' | 'ownerUserId'>>;
        // Parts retired past `RETIRED_KEEP_MS` (retention, CB-387): their
        // catalog rows first, then their files.
        for (const row of rows) {
            const path = this.datasetPath(row);
            if (!existsSync(path)) {
                continue;
            }
            try {
                for (const file of this.engine.forgetRetired(path, now - RETIRED_KEEP_MS)) {
                    rmSync(file, { force: true });
                    removed++;
                }
            } catch {
                // A busy or unreadable catalog: the next sweep tries again.
            }
        }
        const old = (file: string) => {
            try {
                return now - statSync(file).mtimeMs > SWEEP_AFTER_MS;
            } catch {
                return false;
            }
        };
        for (const row of rows) {
            const path = this.datasetPath(row);
            const dir = partsDir(path);
            if (!existsSync(dir) || !existsSync(path)) {
                continue;
            }
            try {
                const listed = new Set(this.engine.listedParts(path).map((part) => part.file));
                for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
                    const file = join(entry.parentPath, entry.name);
                    const staged =
                        entry.parentPath === join(dir, STAGING_DIR) ||
                        entry.parentPath.startsWith(join(dir, STAGING_DIR, 'tmp-'));
                    if (!entry.isFile() || listed.has(file) || !old(file)) {
                        continue;
                    }
                    if (staged || file.endsWith('.parquet')) {
                        rmSync(file, { force: true });
                        removed++;
                    }
                }
            } catch {
                // An unreadable catalog: nothing is swept until it reads again.
            }
        }
        return removed;
    }
    /**
     * A batch (CB: plugin datasets): up to `batchMaxStatements` statements
     * that change rows, in one SQLite transaction, all or nothing, in the
     * query runner's process with a time limit. Each is checked as a single
     * write is (one statement, no DDL, the write authorizer's rules) and
     * keeps its per-statement limits; the per-minute budget counts each.
     * DELETE only in a plugin's own datasets. A dataset shared with a Space
     * is refused unless the writer owns its changes there (a plugin, a
     * promoted app), since each change there otherwise needs approval.
     */
    async batch(actor: AgentActor, ref: string | undefined, statements: DataBatchStatement[]): Promise<WriteResult> {
        const max = this.limits.batchMaxStatements;
        if (!Array.isArray(statements) || !statements.length || statements.length > max) {
            throw new DataError(`A batch has 1 to ${max} statements.`, statements?.length > max ? 413 : 400);
        }
        this.limitRate(actor, statements.length);
        const selected = this.resolve(actor, ref, 'write');
        let { row } = selected;
        const plugin = pluginToken(actor);
        const promotedApp = actor.kind === 'token' && !!actor.appId;
        const api = apiToken(actor);
        const refuseShared = (target: DatasetRow) => {
            if (target.sharedSpaceId && !plugin && !promotedApp && !api) {
                this.audit(actor, 'batch', 'denied', {
                    datasetId: target.id,
                    target: target.name,
                    detail: 'a batch on a dataset shared with a Space',
                });
                throw new DataError(
                    `“${target.name}” is shared with a Space, where each change needs its owner’s approval: send single writes instead of a batch.`,
                    409,
                );
            }
        };
        refuseShared(row);
        this.refuseNonWriter(actor, row, 'batch');
        const owner = row.ownerUserId;
        // DELETE: a plugin on a dataset it writes (CB-451).
        // `resolve` gave it write access within its token: it is the dataset's writer.
        // A data API token with data:write on a company dataset it reaches, too.
        const allowDelete = pluginToken(actor) || api;
        const area = nonPersonOwnerId(row.ownerUserId) ? row.ownerUserId : undefined;
        const failed = (error: unknown): never => {
            this.audit(actor, 'batch', error instanceof DataError && error.status === 403 ? 'denied' : 'error', {
                area,
                datasetId: row.id,
                target: row.name,
                detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
            });
            if (error instanceof DataError) {
                throw error;
            }
            throw new DataError(
                error instanceof Error && 'issues' in error
                    ? `Invalid input: ${JSON.stringify((error as { issues: unknown[] }).issues[0]).slice(0, 200)}`
                    : 'The batch failed; nothing in it was kept.',
            );
        };
        let runs;
        try {
            runs = statements.map((statement, index) => {
                try {
                    const expected = statement.expectChanges;
                    if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) {
                        throw new DataError('expectChanges is a whole number of changes, 0 or more.');
                    }
                    return batchRuns(statement, { allowDelete, insertMaxRows: this.limits.insertMaxRows });
                } catch (error) {
                    if (error instanceof DataError) {
                        throw new DataError(`Statement ${index + 1}: ${error.message}`, error.status);
                    }
                    throw error;
                }
            });
        } catch (error) {
            return failed(error);
        }
        try {
            const run = () => {
                // As it is now, checked again: while this batch waited for the
                // lock, a batch before it may have grown the dataset, its grant
                // may have ended, it may have been shared with a Space, or a
                // transfer may have given it to someone else.
                // The entry first resolved (its need, for a plugin, CB-451),
                // with the access it has now within the token.
                const current = widest(
                    this.visible(actor, false).filter((item) => item.row.id === row.id && item.ref === selected.ref),
                );
                // A plugin dataset moving to the workspace owner (CB-451) is
                // the same dataset; any other change of owner is a transfer.
                const sameOwner =
                    current &&
                    (current.row.ownerUserId === owner ||
                        (isCompanyOwner(owner) && isCompanyOwner(current.row.ownerUserId)));
                if (!current || current.access !== 'write' || !sameOwner) {
                    throw new DataError('This dataset is no longer one this token may write.', 403);
                }
                refuseShared(current.row);
                row = current.row;
                const room = this.room(row);
                // A plugin's datasets share no quota: only a person's needs the hold.
                const hold = !isCompanyOwner(row.ownerUserId);
                if (hold) {
                    this.batchHolds.set(row.id, { owner: row.ownerUserId, bytes: Math.max(0, room - row.sizeBytes) });
                }
                const caps = this.queryCaps(row);
                return this.engine
                    .batch(this.datasetPath(row), runs, room, {
                        writer: writerOf(actor),
                        allowDelete,
                        timeoutMs: this.limits.batchTimeoutMs,
                        expectChanges: statements.map((statement) => statement.expectChanges),
                        returning: { maxRows: caps.maxRows, maxBytes: caps.maxBytes },
                    })
                    .finally(() => {
                        // Measured again, before its room is let go, whatever the
                        // outcome: a single write that waited for the batch's lock
                        // may have committed since, and a batch stopped at its time
                        // limit may have committed as it was stopped.
                        try {
                            this.touch(row);
                        } catch {
                            // The next write measures it; the batch's own outcome stands.
                        } finally {
                            if (hold) {
                                this.batchHolds.delete(row.id);
                            }
                        }
                    });
            };
            const outcome = isCompanyOwner(row.ownerUserId)
                ? await run()
                : // The owner's lock, which file writes take too: one batch or
                  // upload of a person's at a time, each seeing the other's bytes.
                  await this.exclusive(row.ownerUserId, run);
            const totalChanges = outcome.changes.reduce((sum, n) => sum + n, 0);
            this.audit(actor, 'batch', 'ok', {
                area,
                datasetId: row.id,
                target: row.name,
                detail: `${statements.length} statement(s), ${totalChanges} change(s)`,
            });
            const result: DataBatchResult = {
                statements: statements.length,
                changes: outcome.changes,
                totalChanges,
                results: outcome.results,
            };
            return { status: 'done', dataset: row.name, result: { ...result } };
        } catch (error) {
            return failed(error);
        }
    }
    /**
     * A chat's first write to a company socio's shared dataset (CB-337): the
     * notice that tells the person others can see it. Once per conversation:
     * none once the chat has written there before.
     */
    private sharedWriteNotice(actor: AgentActor, row: DatasetRow): SharedWriteNotice | undefined {
        if (actor.kind !== 'dot' || !actor.threadId || !reservedUserId(row.ownerUserId) || !row.scratchForDotId) {
            return undefined;
        }
        const before = this.db
            .prepare(
                `SELECT 1 FROM data_audit WHERE area=? AND threadId=? AND datasetId=? AND outcome='ok' AND action IN ('create_table', 'add_column', 'insert', 'upsert') LIMIT 1`,
            )
            .get(row.ownerUserId, actor.threadId, row.id);
        if (before) {
            return undefined;
        }
        const socio = this.options.workspace.dot(actor.dotId)?.name ?? 'this socio';
        return {
            kind: 'shared_dataset',
            text: `Saved to “${row.name}”, ${socio}’s shared dataset. Admins and other people who use ${socio} can see it.`,
            href: `/data/datasets/${row.id}`,
        };
    }
    private applyWrite(actor: DataActor, row: DatasetRow, write: WriteOp): Record<string, unknown> {
        // One writer per dataset (CB-451): a plugin's dataset is its alone.
        this.refuseNonWriter(actor, row, write.op);
        const path = this.datasetPath(row);
        const target = write.op === 'create_table' ? write.input.table : (write.table ?? '*');
        // A write to a company socio's shared dataset is in its shared area,
        // from a chat too (CB-337); otherwise the actor's default.
        const area = nonPersonOwnerId(row.ownerUserId) ? row.ownerUserId : undefined;
        try {
            // Dropping an index only frees room: it needs none.
            const room = write.op === 'drop_index' ? 0 : this.room(row);
            // Who replaced a row, in its history, and the sizes the write keeps
            // up to date.
            const options = {
                writer: writerOf(actor),
                sizes: { sizeBytes: row.sizeBytes, historyBytes: row.historyBytes },
            };
            let result: Record<string, unknown>;
            if (write.op === 'create_table' && (write.input as { kind?: string }).kind === 'analytical') {
                // CB-369 Phase 1: a plugin's own dataset only, once every runtime knows them.
                this.analyticalReach(actor, row, 'write');
                this.analyticsContractKept();
                result = this.engine.createAnalyticalTable(path, write.input, options);
            } else if (write.op === 'create_table') {
                result = this.engine.createTable(path, write.input, room, options);
            } else if (write.op === 'add_column' && this.engine.analyticalTable(path, write.table)) {
                this.analyticalReach(actor, row, 'write');
                result = this.engine.addAnalyticalColumn(
                    path,
                    write.table,
                    write.column as unknown as { name: string; type?: string; notNull?: boolean },
                    options,
                );
            } else if (write.op === 'add_column') {
                result = this.engine.addColumn(path, write.table, write.column, room, options);
            } else if (write.op === 'create_index') {
                result = this.engine.createIndex(path, write.table, write.index, room, options);
            } else if (write.op === 'drop_index') {
                result = this.engine.dropIndex(path, write.table, write.name, options);
            } else if (write.op === 'analyze') {
                result = this.engine.analyze(path, write.table, room, options);
            } else {
                const rows = Array.isArray(write.rows) ? write.rows : [];
                if (rows.length > this.limits.insertMaxRows) {
                    throw new DataError(`Send at most ${this.limits.insertMaxRows} rows per call.`, 413);
                }
                result = this.engine.insert(
                    path,
                    write.table,
                    write.rows,
                    room,
                    write.op === 'upsert' ? write.key : undefined,
                    options,
                );
            }
            this.touch(row, options.sizes);
            this.audit(actor, write.op, 'ok', {
                area,
                datasetId: row.id,
                target: `${row.name}.${target}`,
                detail:
                    'changes' in result
                        ? `${String(result.rows)} row(s), ${String(result.changes)} change(s)`
                        : write.op === 'create_index' || write.op === 'drop_index' || write.op === 'analyze'
                          ? describeWrite(write)
                          : null,
            });
            return result;
        } catch (error) {
            this.audit(actor, write.op, 'error', {
                area,
                datasetId: row.id,
                target: `${row.name}.${target}`,
                detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
            });
            if (error instanceof DataError) {
                throw error;
            }
            // Zod: a malformed column, row or value.
            throw new DataError(
                error instanceof Error && 'issues' in error
                    ? `Invalid input: ${JSON.stringify((error as { issues: unknown[] }).issues[0]).slice(0, 200)}`
                    : 'The change failed.',
            );
        }
    }
    /** A Dot asks for a new dataset: `data.create_dataset` approval. */
    async requestDataset(actor: Extract<DataActor, { kind: 'dot' }>, input: CreateDatasetPayload) {
        this.limitRate(actor);
        const dot = this.requireDot(actor.dotId);
        const name = input.name.trim();
        if (!NAME.test(name)) {
            throw new DataError('Name the dataset (1 to 80 characters).');
        }
        if (this.countFor(actor.userId) >= this.limits.maxDatasets) {
            throw new DataError(`The user has the most datasets allowed (${this.limits.maxDatasets}).`, 413);
        }
        return this.options.approvals.request<CreateDatasetPayload>({
            userId: actor.userId,
            dotId: actor.dotId,
            capability: APPROVAL_CAPABILITIES.createDataset,
            summary: `${dot.name} wants to create a dataset “${name}”`,
            details: input.description ? [input.description.slice(0, 300)] : [],
            payload: { name, description: input.description.slice(0, 500) },
            threadId: actor.threadId,
        });
    }
    /** A Dot asks for access to one of the user's datasets or folders: `grant.change`. */
    async requestAccess(
        actor: Extract<DataActor, { kind: 'dot' }>,
        input: {
            dataset?: string;
            folder?: string;
            access: GrantAccess;
            reason: string;
        },
    ) {
        this.limitRate(actor);
        const dot = this.requireDot(actor.dotId);
        let payload: GrantPayload;
        let target: string;
        if (input.dataset) {
            const wanted = input.dataset.trim().toLowerCase();
            // An admin decides for plugins' datasets as well as their own.
            const plugins = this.isAdminId(actor.userId)
                ? (this.db
                      .prepare(`SELECT * FROM data_datasets WHERE ${COMPANY_OWNERS} AND ${LIVE}`)
                      .all() as unknown as DatasetRow[])
                : [];
            const rows = [...this.ownRows(actor.userId), ...plugins].filter(
                (row) => row.id === input.dataset || row.name.toLowerCase() === wanted,
            );
            if (rows.length !== 1) {
                throw new DataError(
                    rows.length
                        ? 'Several datasets have that name; ask the user which one.'
                        : 'The user has no dataset by that name or id.',
                    404,
                );
            }
            payload = { datasetId: rows[0].id, access: input.access };
            target = `dataset “${rows[0].name}”`;
        } else if (input.folder) {
            payload = {
                folder: normalizePath(input.folder, true),
                access: input.access,
            };
            target = `folder ${payload.folder}`;
        } else {
            throw new DataError('Name a dataset or a folder.');
        }
        return this.options.approvals.request<GrantPayload>({
            userId: actor.userId,
            dotId: actor.dotId,
            capability: APPROVAL_CAPABILITIES.grantChange,
            summary: `${dot.name} asks for ${input.access} access to ${target}`,
            details: input.reason ? [`Why: ${input.reason.slice(0, 280)}`] : [],
            payload,
            threadId: actor.threadId,
        });
    }

    // ---- grants -------------------------------------------------------------
    grants(userId: string): GrantView[] {
        // An admin's list holds the grants on plugins' datasets too, which they manage.
        const rows = (this.isAdminId(userId)
            ? this.db
                  .prepare(`SELECT * FROM data_grants WHERE ownerUserId=? OR (${COMPANY_OWNERS}) ORDER BY createdAt`)
                  .all(userId)
            : this.db
                  .prepare('SELECT * FROM data_grants WHERE ownerUserId=? ORDER BY createdAt')
                  .all(userId)) as unknown as Array<Omit<GrantView, 'dotName' | 'datasetName'>>;
        return rows.map((grant) => ({
            ...grant,
            dotName: this.dotName(grant.dotId) ?? 'A deleted socio',
            datasetName: grant.datasetId ? (this.row(grant.datasetId)?.name ?? null) : null,
        }));
    }
    setGrant(
        userId: string,
        input: {
            dotId: string;
            datasetId?: string | null;
            folder?: string | null;
            access: GrantAccess;
        },
        createdBy = userId,
    ): GrantView {
        const dot = this.requireDot(input.dotId);
        // Another person's own Dot works only for them: no data of yours for it.
        if (dot.ownerId && dot.ownerId !== userId) {
            throw new DataError('Socio not found.', 404);
        }
        if (dot.archivedAt) {
            throw new DataError('This socio is archived.', 409);
        }
        if (!!input.datasetId === !!input.folder) {
            throw new DataError('Grant a dataset or a folder.');
        }
        let datasetId: string | null = null;
        let folder: string | null = null;
        // The grant is the dataset's owner's: a plugin's, when an admin grants its dataset.
        let owner = userId;
        if (input.datasetId) {
            const row = this.managedRow(userId, input.datasetId);
            if (row.scratchForDotId === input.dotId) {
                throw new DataError('A socio always has its own scratch dataset.');
            }
            datasetId = row.id;
            owner = row.ownerUserId;
        } else {
            folder = normalizePath(input.folder!, true);
            if (!folder) {
                throw new DataError('Name a folder, e.g. reports/.');
            }
        }
        // Synchronous: mini app promotion grants without waiting (CB-110).
        const id = this.repos.grants.setNow({
            id: randomUUID(),
            ownerUserId: owner,
            dotId: input.dotId,
            datasetId,
            folder,
            access: input.access,
            createdBy,
            createdAt: Date.now(),
        });
        this.audit({ kind: 'user', userId }, 'grant', 'ok', {
            datasetId,
            target: folder ?? this.row(datasetId!)?.name ?? null,
            detail: `${this.dotName(input.dotId)}: ${input.access}${createdBy === userId ? '' : ` (${createdBy})`}`,
            ...(owner === userId ? {} : { area: owner }),
        });
        return this.grants(userId).find((grant) => grant.id === id)!;
    }
    async revokeGrant(userId: string, grantId: string) {
        // An admin removes a grant on a plugin's dataset as its owner's.
        const owner = this.db.prepare('SELECT ownerUserId FROM data_grants WHERE id=?').get(grantId) as
            | { ownerUserId: string }
            | undefined;
        const as = owner && isCompanyOwner(owner.ownerUserId) && this.isAdminId(userId) ? owner.ownerUserId : userId;
        const grant = await this.repos.grants.remove(as, grantId);
        if (!grant) {
            throw new DataError('Grant not found.', 404);
        }
        this.audit({ kind: 'user', userId }, 'revoke', 'ok', {
            datasetId: grant.datasetId,
            target: grant.folder ?? (grant.datasetId ? this.row(grant.datasetId)?.name : null) ?? null,
            detail: this.dotName(grant.dotId) ?? grant.dotId,
            ...(as === userId ? {} : { area: as }),
        });
    }
    /**
     * Deletes (hides, CB-64) a workspace dataset in a company socio's area
     * (CB-354), as a person who may see the area: a promoted app's owner
     * deleting the data its promotion moved there. Its grants end, the
     * socio's too; the area's audit records it.
     */
    deleteWorkspaceDataset(userId: string, dotId: string, id: string, stamp: DeleteStamp = {}) {
        const owner = this.requireShared(userId, dotId);
        const row = this.workspaceDataset(dotId, id);
        if (!row) {
            throw new DataError('Dataset not found.', 404);
        }
        this.deleteDataset(owner, row.id, { kind: 'user', userId }, stamp);
        this.audit({ kind: 'user', userId }, 'delete', 'ok', {
            datasetId: row.id,
            target: row.name,
            detail: 'workspace dataset',
            area: owner,
        });
        return row.name;
    }
    isWorkspaceDataset(dotId: string, id: string) {
        const row = this.withDeletedDataset(id);
        return !!row && row.ownerUserId === sharedOwner(dotId) && !row.scratchForDotId;
    }
    /** A workspace dataset (CB-354) in `dotId`'s area: never its shared one. */
    private workspaceDataset(dotId: string, id: string | null | undefined) {
        const row = id ? this.row(id) : undefined;
        return row && row.ownerUserId === sharedOwner(dotId) && !row.scratchForDotId ? row : undefined;
    }
    /**
     * Gives a company socio access to a workspace dataset in its area
     * (CB-354): the grant is the area's, so it is no person's and stays
     * through a transfer (CB-360). Only through a person's approval
     * (`requestWorkspaceAccess`), by someone who may see the area.
     */
    private setWorkspaceGrant(userId: string, dotId: string, row: DatasetRow, access: GrantAccess): GrantView {
        this.requireShared(userId, dotId);
        const dot = this.requireDot(dotId);
        if (dot.archivedAt) {
            throw new DataError('This socio is archived.', 409);
        }
        const id = this.repos.grants.setNow({
            id: randomUUID(),
            ownerUserId: row.ownerUserId,
            dotId,
            datasetId: row.id,
            folder: null,
            access,
            createdBy: 'approval',
            createdAt: Date.now(),
        });
        this.audit({ kind: 'user', userId }, 'grant', 'ok', {
            datasetId: row.id,
            target: row.name,
            detail: `${dot.name}: ${access} (approval)`,
            area: row.ownerUserId,
        });
        return this.grants(row.ownerUserId).find((grant) => grant.id === id)!;
    }
    /**
     * Asks the person to let a company socio write to a workspace dataset
     * in its area (CB-354), so it can keep shipping to the data of an app it
     * built after the app's promotion. Always their own card: no bypass, no
     * auto review. The grant is the area's, not theirs.
     */
    async requestWorkspaceAccess(userId: string, dotId: string, datasetId: string, reason: string) {
        const dot = this.requireDot(dotId);
        this.requireShared(userId, dotId);
        const row = this.workspaceDataset(dotId, datasetId);
        if (!row) {
            throw new DataError('Dataset not found.', 404);
        }
        return this.options.approvals.request<GrantPayload>({
            userId,
            dotId,
            capability: APPROVAL_CAPABILITIES.grantChange,
            summary: `${dot.name} asks for write access to the workspace dataset “${row.name}”`,
            details: [
                reason.slice(0, 280),
                `“${row.name}” is the workspace’s, not yours: admins and everyone who uses ${dot.name} can see it.`,
            ],
            payload: { datasetId: row.id, access: 'write' },
            alwaysAsk: true,
        });
    }
    /**
     * A folder was renamed or moved (CB-65): grants on it and on its
     * subfolders follow it, so the Dots keep their access and a new folder
     * at the old path gets none. A grant that lands where the Dot already
     * has one is merged into that one, which keeps its access: a move never
     * widens what a Dot may do with files already there. Each is audited.
     * The grants move in one unit of work (`moveFolder`'s, when it calls).
     */
    async moveFolderGrants(userId: string, rawFrom: string, rawTo: string) {
        const from = normalizePath(rawFrom, true);
        const to = normalizePath(rawTo, true);
        if (!from || !to || from === to) {
            return 0;
        }
        const moved = await this.repos.grants.moveFolders(userId, from, to);
        for (const grant of moved) {
            this.audit({ kind: 'user', userId }, 'grant_move', 'ok', {
                target: grant.to,
                detail: `${this.dotName(grant.dotId) ?? grant.dotId}: ${grant.access}, from ${grant.folder}${grant.mergedInto ? `; merged into its ${grant.mergedInto} grant there` : ''}`,
            });
        }
        return moved.length;
    }
    /**
     * A folder was deleted (CB-65): grants on it and on its subfolders end,
     * so a new folder with the same name starts with none. Each is audited
     * with what it allowed.
     */
    async endFolderGrants(userId: string, rawFolder: string) {
        const folder = normalizePath(rawFolder, true);
        if (!folder) {
            return 0;
        }
        const ending = await this.repos.grants.removeUnder(userId, folder);
        for (const grant of ending) {
            this.audit({ kind: 'user', userId }, 'revoke', 'ok', {
                target: grant.folder,
                detail: `${this.dotName(grant.dotId) ?? grant.dotId}: ${grant.access}; the folder was deleted`,
            });
        }
        return ending.length;
    }

    // ---- files ----------------------------------------------------------------
    /** The live file at a path; deleted ones are missing (CB-64). */
    private fileRow(userId: string, path: string) {
        return this.db
            .prepare(`SELECT * FROM data_files WHERE ownerUserId=? AND path=? AND ${LIVE}`)
            .get(userId, path) as FileRow | undefined;
    }
    private fileRowById(id: string) {
        return this.db.prepare(`SELECT * FROM data_files WHERE id=? AND ${LIVE}`).get(id) as FileRow | undefined;
    }
    /** A file row, deleted or not, with its stamp (admin, tests). */
    withDeletedFile(id: string) {
        return this.db.prepare('SELECT * FROM data_files WHERE id=?').get(id) as FileRow | undefined;
    }
    /** A file's plaintext, deleted or not (admin, tests). */
    async withDeletedContent(id: string) {
        const row = this.withDeletedFile(id);
        if (!row) {
            throw new DataError('No such file.', 404);
        }
        return this.open(row);
    }
    /** The store a row names; S3 rows can't be reached once S3 is unset. */
    private store(driver: StorageDriver) {
        if (driver === this.objects.driver) {
            return this.objects;
        }
        if (driver === 'local') {
            return this.legacy;
        }
        throw new DataError('This file is in object storage, which isn’t configured here (S3_ENDPOINT).', 503);
    }
    private key(driver: StorageDriver, userId: string, fileId: string) {
        return objectKey(driver, this.tenantId, userId, fileId);
    }
    /**
     * One user's file writes, deletes and moves run one at a time: the row
     * and its object change together, and the quota check sees every write
     * before it (the bytes are written between the check and the row).
     */
    private async exclusive<T>(userId: string, work: () => Promise<T>) {
        const previous = this.locks.get(userId) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((resolve) => (release = resolve));
        const tail = previous.then(() => mine);
        this.locks.set(userId, tail);
        await previous;
        try {
            return await work();
        } finally {
            release();
            if (this.locks.get(userId) === tail) {
                this.locks.delete(userId);
            }
        }
    }
    /** Takes a user's lock (`exclusive`) and holds it until the returned release is called. */
    private hold(userId: string): Promise<() => void> {
        return new Promise((held) => {
            void this.exclusive(userId, () => new Promise<void>((release) => held(release)));
        });
    }

    // ---- ownership (CB-360) ---------------------------------------------------
    ownedData(userId: string) {
        return ownedList(ownedDataItems(this.db, userId));
    }
    prepareTransfer(parties: TransferParties) {
        return prepareDataTransfer(
            {
                db: this.db,
                store: (driver) => this.store(driver),
                key: (driver, userId, fileId) => this.key(driver, userId, fileId),
                datasetPath: (row) => this.datasetPath(row),
                hold: (userId) => this.hold(userId),
                reseal: (sealed, from, to, fileId) => {
                    const plain = this.box.openBytes(sealed, `${from}/${fileId}`);
                    try {
                        return { bytes: this.box.sealBytes(plain, `${to}/${fileId}`), sealKey: this.box.currentKey };
                    } finally {
                        plain.fill(0);
                    }
                },
            },
            parties,
        );
    }

    /** A store call; an unreachable store is the user's 503, and setup says so. */
    private async stored<T>(driver: StorageDriver, work: () => Promise<T>) {
        try {
            const result = await work();
            if (driver === 's3') {
                this.storageReachable = true;
            }
            return result;
        } catch (error) {
            if (!(error instanceof StorageUnavailableError)) {
                throw error;
            }
            if (driver === 's3') {
                this.storageReachable = false;
            }
            throw new DataError('File storage is unavailable; try again.', 503);
        }
    }
    private folders(actor: AgentActor) {
        // Promoted apps keep their state in datasets, and a plugin's token
        // reaches its declared datasets only: no folders.
        if (actor.kind === 'token' && (actor.appId || actor.purpose === 'plugin')) {
            return [];
        }
        const folders: Array<{ folder: string; access: GrantAccess }> = [
            { folder: ownFolder(actor.dotId), access: 'write' },
        ];
        // A shared computer: its own folder is the socio's shared one, and
        // folder grants are the user's own files (CB-224).
        if (socioReach(actor)) {
            return folders;
        }
        for (const grant of this.grantRows(actor.userId, actor.dotId)) {
            if (grant.folder) {
                folders.push({ folder: grant.folder, access: grant.access });
            }
        }
        return folders;
    }
    /**
     * Where the attachments module says a file was shown to a Dot in a
     * conversation (CB-54 step 2): readable by that Dot in that thread, for
     * that user, without a grant. Data tokens never get this.
     */
    useConversationReads(check: (userId: string, path: string, threadId: string) => Promise<boolean>) {
        this.conversationReads = check;
    }
    /** A file shown to this Dot in this conversation (an attachment): no grant needed. */
    private async shownInConversation(actor: AgentActor, path: string) {
        return (
            actor.kind === 'dot' &&
            !!actor.threadId &&
            !!(await this.conversationReads?.(actor.userId, path, actor.threadId))
        );
    }
    /**
     * A Dot's path: as given under its folders, else inside its own folder.
     * A read of a file shown in the conversation is checked before (getFile).
     */
    private dotPath(
        actor: AgentActor,
        raw: string,
        need: GrantAccess,
        action = need === 'read' ? 'files_get' : 'files_put',
    ) {
        const path = normalizePath(raw);
        const folders = this.folders(actor);
        // A shared computer naming a folder the user granted: noted, then read
        // in the socio's shared folder like any other name (CB-224).
        if (
            socioReach(actor) &&
            !path.startsWith(ownFolder(actor.dotId)) &&
            this.folders(asPerson(actor)).some((entry) => path.startsWith(entry.folder))
        ) {
            this.audit(actor, action, 'denied', {
                target: path,
                detail: "the user's own folder from a shared computer",
            });
        }
        // `dots/…` and granted folders are full paths; anything else is in the
        // Dot's own folder.
        const full =
            path.startsWith('dots/') || folders.some((entry) => path.startsWith(entry.folder))
                ? path
                : `${ownFolder(actor.dotId)}${path}`;
        const access = folders
            .filter((entry) => full.startsWith(entry.folder))
            .some((entry) => need === 'read' || entry.access === 'write');
        if (!access) {
            this.audit(actor, action, 'denied', { target: full });
            throw new DataError(
                need === 'write'
                    ? `This socio may not write ${full}. Its own folder is ${ownFolder(actor.dotId)}; ask for a folder grant with data_request_access.`
                    : `This socio may not read ${full}.`,
                403,
            );
        }
        return full;
    }
    /**
     * Saves a file, sealed, to the active store (replacing one at the same
     * path, under its id). `name` is the original display name, when the
     * path's last segment had to be cleaned. With `create`, a file at the
     * path is a 409 instead (uploads pick a free path this way).
     *
     * An overwrite keeps the previous bytes:
     * they are sealed again under a new file row, soft-deleted at once by
     * the writer with `deletedWith file:<id>`, so nothing is lost and the
     * live file keeps its id (attachments point at it). A write of the same
     * bytes keeps no version. Versions are deleted rows: they don't count
     * against the quota, and admins see them in `usageAll`.
     */
    async putFile(
        actor: DataActor,
        rawPath: string,
        data: Uint8Array,
        mediaType = 'application/octet-stream',
        options: { name?: string; create?: boolean } = {},
    ): Promise<DataFileView> {
        let path: string;
        if (actor.kind === 'user') {
            path = normalizePath(rawPath);
        } else {
            this.limitRate(actor);
            path = this.dotPath(actor, rawPath, 'write');
        }
        if (data.length > this.limits.fileMaxBytes) {
            throw new DataError(`Files can be at most ${Math.round(this.limits.fileMaxBytes / 1048576)} MB.`, 413);
        }
        // A shared computer's files are the socio's shared area (CB-224).
        const userId = dataOwner(actor);
        return this.exclusive(userId, async () => {
            const existing = await this.repos.files.at(userId, path);
            if (existing && options.create) {
                throw new DataError(`There is a file at ${path} already.`, 409);
            }
            const used = this.usage(userId).totalBytes - (existing?.storedSize ?? 0);
            if (used + data.length + 32 > this.limits.userMaxBytes) {
                throw new DataError('The data space is full. Delete datasets or files in the app.', 413);
            }
            const driver = this.objects.driver;
            const previous = existing && (await this.previousBytes(existing));
            const unchanged = !!previous && previous.equals(data);
            // The previous bytes, sealed for the version's own id: a seal is
            // bound to its file's id, so the old object can't be copied as is.
            let version: { id: string; sealed: Buffer } | undefined;
            if (previous && !unchanged) {
                const versionId = randomUUID();
                const versionSealed = this.box.sealBytes(previous, `${userId}/${versionId}`);
                version = { id: versionId, sealed: versionSealed };
                await this.stored(driver, () => this.objects.put(this.key(driver, userId, versionId), versionSealed));
            }
            const id = existing?.id ?? randomUUID();
            // The same bytes, already sealed under the current key in this store:
            // nothing to write but the row.
            const rewrite = !(unchanged && existing?.storage === driver && existing.sealKey === this.box.currentKey);
            const sealed = rewrite ? this.box.sealBytes(data, `${userId}/${id}`) : undefined;
            if (sealed) {
                try {
                    await this.stored(driver, () => this.objects.put(this.key(driver, userId, id), sealed));
                } catch (error) {
                    // The old object is still in place: its copy refers to nothing.
                    if (version) {
                        await this.objects.delete(this.key(driver, userId, version.id)).catch(() => undefined);
                    }
                    throw error;
                }
            }
            const name = options.name?.slice(0, 200) ?? null;
            const now = Date.now();
            const dotId = actor.kind === 'user' ? null : actor.dotId;
            // One unit of work (a savepoint of an open one): the version and
            // the file change together (CB-110). The bytes are stored already.
            await sqliteData(this.db).uow.run(
                async () => {
                    if (existing && version) {
                        await this.repos.files.insert({
                            id: version.id,
                            ownerUserId: userId,
                            path: existing.path,
                            size: existing.size,
                            storedSize: version.sealed.length,
                            mediaType: existing.mediaType,
                            createdByDotId: existing.createdByDotId,
                            createdAt: existing.createdAt,
                            updatedAt: existing.updatedAt,
                            storage: driver,
                            name: existing.name,
                            sealKey: this.box.currentKey,
                            deletedAt: now,
                            deletedBy: actor.kind === 'user' ? userId : byDot(actor.dotId),
                            deletedWith: deletedWith('file', id),
                        });
                    }
                    if (existing && !sealed) {
                        await this.repos.files.retype(id, mediaType, name, now);
                    } else if (existing) {
                        await this.repos.files.replaceContent(
                            id,
                            {
                                size: data.length,
                                storedSize: sealed!.length,
                                mediaType,
                                storage: driver,
                                sealKey: this.box.currentKey,
                            },
                            name,
                            now,
                        );
                    } else {
                        await this.repos.files.insert({
                            id,
                            ownerUserId: userId,
                            path,
                            size: data.length,
                            storedSize: sealed!.length,
                            mediaType,
                            createdByDotId: dotId,
                            createdAt: now,
                            updatedAt: now,
                            storage: driver,
                            name,
                            sealKey: this.box.currentKey,
                        });
                    }
                },
                { label: 'save file', savepoint: true },
            );
            // Replaced in the other store: its old copy goes (the version keeps
            // its bytes). Best effort: an unreachable store keeps a sealed copy
            // nothing refers to.
            if (existing && sealed && existing.storage !== driver) {
                try {
                    await this.store(existing.storage).delete(this.key(existing.storage, userId, id));
                } catch {
                    // Left behind.
                }
            }
            this.audit(actor, 'files_put', 'ok', {
                target: path,
                detail: `${data.length} bytes${version ? '; the previous version is kept' : ''}`,
            });
            return this.fileView((await this.repos.files.at(userId, path))!);
        });
    }
    /**
     * An overwritten file's current bytes, to keep as its version; undefined
     * when its object is gone (nothing to keep). Bytes this server can't open
     * (another data key, a damaged object) refuse the overwrite: it would
     * lose them. A store that can't be reached is the usual 503.
     */
    private async previousBytes(row: FileRow) {
        try {
            return await this.open(row);
        } catch (error) {
            if (error instanceof DataError) {
                if (error.status === 404) {
                    return undefined;
                }
                throw error;
            }
            throw new DataError(
                `${row.path} can't be read here, so replacing it would lose it. Save under another path, or delete it first (it is kept).`,
                409,
            );
        }
    }
    /**
     * The versions an overwrite kept of a file, oldest first:
     * soft-deleted rows `deletedWith file:<id>` (admin, tests). Their bytes
     * are `withDeletedContent(version.id)`.
     */
    withDeletedVersions(fileId: string) {
        return this.db
            .prepare('SELECT * FROM data_files WHERE deletedWith=? ORDER BY updatedAt, deletedAt')
            .all(deletedWith('file', fileId)) as unknown as FileRow[];
    }
    /** The plaintext of a row, from whichever store it names. */
    private async open(row: FileRow): Promise<Buffer> {
        let current = row;
        for (let attempt = 0; ; attempt++) {
            const driver = current.storage;
            const { id, ownerUserId } = current;
            const sealed = await this.stored(driver, () => this.store(driver).get(this.key(driver, ownerUserId, id)));
            if (sealed) {
                return this.box.openBytes(sealed, `${ownerUserId}/${id}`);
            }
            // Moved to S3 while this read waited: read it from there.
            const again = await this.repos.files.withDeleted(id);
            if (attempt || !again || again.storage === driver) {
                throw new DataError(`The contents of ${row.path} are missing.`, 404);
            }
            current = again;
        }
    }
    async getFile(actor: DataActor, rawPath: string) {
        let path: string;
        let shown = false;
        if (actor.kind === 'user') {
            path = normalizePath(rawPath);
        } else {
            this.limitRate(actor);
            const wanted = normalizePath(rawPath);
            shown = await this.shownInConversation(actor, wanted);
            path = shown ? wanted : this.dotPath(actor, rawPath, 'read');
            if (!shown && path !== wanted) {
                shown = await this.shownInConversation(actor, path);
            }
        }
        const row = await this.repos.files.at(dataOwner(actor), path);
        if (!row) {
            // files_copy names a company socio's shared folder `shared/<name>`;
            // its computer's token names the same file `<name>` (CB-361).
            const wanted = normalizePath(rawPath);
            throw new DataError(
                socioReach(actor) && wanted.startsWith(SHARED_FOLDER)
                    ? `No file ${path}. A file files_copy put at ${wanted} is path ${wanted.slice(SHARED_FOLDER.length)} here, without ${SHARED_FOLDER}.`
                    : `No file ${path}.`,
                404,
            );
        }
        const data = await this.open(row);
        if (actor.kind !== 'user') {
            this.audit(actor, 'files_get', 'ok', {
                target: path,
                ...(shown ? { detail: 'conversation attachment' } : {}),
            });
        }
        return { file: this.fileView(row), data };
    }
    /** A file by its id (attachments refer to ids), with the same checks as by path. */
    async getFileById(actor: DataActor, fileId: string) {
        const row = await this.repos.files.byId(fileId);
        if (!row || row.ownerUserId !== actor.userId) {
            throw new DataError('No such file.', 404);
        }
        return this.getFile(actor, row.path);
    }
    /** A file's metadata by id, with its id and display name (attachments, Media). */
    fileRecord(userId: string, fileId: string): DataFileRecord | undefined {
        const row = this.fileRowById(fileId);
        return row && row.ownerUserId === userId ? this.record(row) : undefined;
    }
    /** A file's metadata by path, or undefined when there is none. */
    fileAt(userId: string, rawPath: string): DataFileRecord | undefined {
        const row = this.fileRow(userId, normalizePath(rawPath));
        return row && this.record(row);
    }
    private record(row: FileRow): DataFileRecord {
        return {
            ...this.fileView(row),
            id: row.id,
            name: row.name ?? row.path.split('/').pop()!,
        };
    }
    /** Every file of the user's, with ids and names, by path (the Media page). */
    fileRecords(userId: string): DataFileRecord[] {
        const rows = this.db
            .prepare(`SELECT * FROM data_files WHERE ownerUserId=? AND ${LIVE} ORDER BY path`)
            .all(userId) as unknown as FileRow[];
        return rows.map((row) => this.record(row));
    }
    /** Called after a file is deleted (its attachments go with it). */
    onFileDeleted(listener: FileDeletedListener) {
        this.deletedListeners.push(listener);
    }
    listFiles(actor: DataActor, prefix?: string): DataFileView[] {
        const rows = this.db
            .prepare(`SELECT * FROM data_files WHERE ownerUserId=? AND ${LIVE} ORDER BY path`)
            .all(dataOwner(actor)) as unknown as FileRow[];
        const wanted = prefix ? normalizePath(prefix, true) : '';
        let visible = rows;
        if (actor.kind !== 'user') {
            this.limitRate(actor);
            const folders = this.folders(actor).map((entry) => entry.folder);
            visible = rows.filter((row) => folders.some((folder) => row.path.startsWith(folder)));
        }
        // A Dot's prefix may be relative to its own folder, like its paths.
        const prefixes = !wanted
            ? ['']
            : actor.kind === 'user'
              ? [wanted]
              : [wanted, `${ownFolder(actor.dotId)}${wanted}`];
        return visible
            .filter((row) => prefixes.some((start) => row.path.startsWith(start)))
            .map((row) => this.fileView(row));
    }
    /**
     * Deletes a file (CB-64): the row is hidden and kept, and its sealed
     * object stays in the store the row names, so nothing is lost. The path
     * is free for a new file. `userId` owns it (a company socio's shared
     * area too, CB-229); `as` is who is audited for it, the owner by default.
     */
    async deleteFile(
        userId: string,
        rawPath: string,
        stamp: DeleteStamp = {},
        as: DataActor | { kind: 'system'; userId: string } = {
            kind: 'user',
            userId,
        },
    ) {
        const path = normalizePath(rawPath);
        const at = Date.now();
        const by = stamp.by ?? userId;
        const fileId = await this.exclusive(userId, async () => {
            const row = await this.repos.files.at(userId, path);
            if (!row) {
                throw new DataError(`No file ${path}.`, 404);
            }
            await this.repos.files.markDeleted(row.id, {
                at,
                by,
                with: stamp.with ?? null,
            });
            // The other store can hold a copy too: a local one the move to S3
            // left for the sweep, or an S3 one from a move whose check failed.
            // It is only a duplicate of the kept object, so it goes. Best effort.
            const other =
                row.storage === 'local' ? (this.objects.driver === 'local' ? undefined : this.objects) : this.legacy;
            if (other) {
                await other.delete(this.key(other.driver, userId, row.id)).catch(() => undefined);
            }
            return row.id;
        });
        for (const listener of this.deletedListeners) {
            await listener(userId, fileId, { at, by });
        }
        this.audit(as, as.kind === 'system' ? 'retention_delete' : 'files_delete', 'ok', {
            target: path,
            // A shared area's file: that area's, whoever deleted it (CB-229).
            area: reservedUserId(userId) ? userId : null,
            ...(stamp.with ? { detail: `with ${stamp.with}` } : {}),
        });
    }
    /**
     * A data token deletes a file (CB-229): only a command on a company
     * socio's computer, and only in the socio's shared folder, so it can
     * clean up what it or anyone else put there. Audited as the command; the
     * file is kept, like any deleted file.
     */
    async deleteFileAs(actor: AgentActor, rawPath: string) {
        if (actor.kind !== 'token' || actor.purpose !== 'computer' || !socioReach(actor) || actor.appId) {
            throw new DataError('A data token can’t do this; the user does it in the app.', 403);
        }
        this.limitRate(actor);
        const path = this.dotPath(actor, rawPath, 'write', 'files_delete');
        await this.deleteFile(sharedOwner(actor.dotId), path, { by: byDot(actor.dotId) }, actor);
    }
    /**
     * Moves or renames a file: metadata only, since objects are keyed by id.
     * A rename drops the original upload name, which no longer describes it.
     */
    async moveFile(userId: string, rawFrom: string, rawTo: string) {
        const from = normalizePath(rawFrom);
        const to = normalizePath(rawTo);
        const moved = await this.exclusive(userId, async () => {
            const row = await this.repos.files.at(userId, from);
            if (!row) {
                throw new DataError(`No file ${from}.`, 404);
            }
            if (from === to) {
                return row;
            }
            if (await this.repos.files.at(userId, to)) {
                throw new DataError(`There is a file at ${to} already.`, 409);
            }
            const renamed = from.split('/').pop() !== to.split('/').pop();
            await this.repos.files.move(row.id, to, Date.now(), renamed);
            return (await this.repos.files.byId(row.id))!;
        });
        this.audit({ kind: 'user', userId }, 'files_move', 'ok', {
            target: to,
            detail: `from ${from}`,
        });
        return this.fileView(moved);
    }
    /**
     * Moves a folder with every live file in it (follow-up 16.3c): the
     * files' rows (objects are keyed by id, so a move is rows only), what
     * `also` moves (Media's empty-folder markers) and the Dots' grants on it
     * and its subfolders (CB-65, `moveFolderGrants`), in one transaction
     * under the user's lock. It moves whole or not at all: a failure at any
     * step leaves every file, marker and grant where it was. A file already
     * at a target is a 409 before anything moves.
     */
    async moveFolder(userId: string, rawFrom: string, rawTo: string, also?: () => void | Promise<void>) {
        const from = normalizePath(rawFrom, true);
        const to = normalizePath(rawTo, true);
        if (!from || !to) {
            throw new DataError('Name the folder, e.g. reports/.');
        }
        if (from === to) {
            return 0;
        }
        if (to.startsWith(from)) {
            throw new DataError('A folder can’t move into itself.');
        }
        const target = (path: string) => `${to}${path.slice(from.length)}`;
        const moved = await this.exclusive(userId, async () => {
            const rows = await this.repos.files.under(userId, from);
            // Any live file at a target, a moving one too: refused before
            // anything moves, so the move never stops on a clash.
            let clash: { path: string } | undefined;
            for (const row of rows) {
                if (await this.repos.files.at(userId, target(row.path))) {
                    clash = row;
                    break;
                }
            }
            if (clash) {
                throw new DataError(`There is a file at ${target(clash.path)} already.`, 409);
            }
            const now = Date.now();
            // One unit of work (CB-110), as `also` writes through Media's
            // repositories: a savepoint of a unit already open here.
            await sqliteData(this.db).uow.run(
                async () => {
                    await this.repos.files.moveLive(
                        rows.map((row) => ({ id: row.id, path: target(row.path) })),
                        now,
                    );
                    await also?.();
                    await this.moveFolderGrants(userId, from, to);
                },
                { label: 'move folder', savepoint: true },
            );
            return rows;
        });
        for (const row of moved) {
            this.audit({ kind: 'user', userId }, 'files_move', 'ok', {
                target: target(row.path),
                detail: `from ${row.path}`,
            });
        }
        return moved.length;
    }
    /**
     * Copies a readable file to a writable path, sealed again under the new
     * file's id; replaces a file there, like putFile.
     */
    /**
     * Copies a file. On a company socio, a Dot's copy to `shared/…` goes to
     * the socio's shared folder (CB-224), which its computer reaches and
     * everyone who uses the socio can see.
     */
    async copyFile(actor: DataActor, rawFrom: string, rawTo: string) {
        const { file, data } = await this.getFile(actor, rawFrom);
        const name = (await this.repos.files.at(dataOwner(actor), file.path))?.name;
        const to = normalizePath(rawTo);
        // `${SHARED_FOLDER}<name>` is a company socio's shared computer folder
        // (CB-224): only a company socio (no owner) has one. A personal socio's
        // computer already reaches its own folder, so `shared/` is not a special
        // destination for it — say so clearly instead of silently writing a
        // literal `shared/` subfolder into its own folder (CB-268).
        if (to.startsWith(SHARED_FOLDER)) {
            if (actor.kind !== 'dot' || this.options.workspace.dot(actor.dotId)?.ownerId) {
                throw new DataError(
                    actor.kind === 'dot'
                        ? `The ${SHARED_FOLDER} destination is only a company socio's shared computer folder; this socio doesn't have one. Its computer already reaches its own folder (dots/${actor.dotId}/), so copy to a plain path like "${to.slice(SHARED_FOLDER.length)}" instead.`
                        : `The ${SHARED_FOLDER} destination is only a company socio's shared computer folder.`,
                    400,
                );
            }
            return this.putFile(
                { ...actor, reach: 'socio' },
                to.slice(SHARED_FOLDER.length),
                data,
                file.mediaType,
                name ? { name } : {},
            );
        }
        return this.putFile(actor, rawTo, data, file.mediaType, name ? { name } : {});
    }

    // ---- object storage -------------------------------------------------------
    /** For setup and /healthz: the driver, and whether S3 answered last time. */
    storageStatus(): StorageStatus {
        if (this.objects.driver === 'local') {
            return 'local';
        }
        return this.storageReachable ? 's3' : 's3_unreachable';
    }
    /**
     * Registered datasets (a `data_datasets` row, deleted ones too: they can
     * be restored) whose file isn't on disk (CB-340), for `AppStatus`.
     */
    missingDatasetFiles(): DatasetFilesStatus {
        const rows = this.db.prepare('SELECT id, ownerUserId FROM data_datasets ORDER BY id').all() as Array<
            Pick<DatasetRow, 'id' | 'ownerUserId'>
        >;
        const ids = rows.filter((row) => !existsSync(this.datasetPath(row))).map((row) => row.id);
        // Analytical parts a catalog lists and the disk lacks (CB-369).
        let missingParts = 0;
        const partDatasetIds: string[] = [];
        for (const row of rows) {
            const path = this.datasetPath(row);
            // Every dataset that may have analytical tables (a plugin's, in
            // CB-369 Phase 1), with or without its parts directory: a file restored
            // without it lists parts the disk lacks.
            if (!isCompanyOwner(row.ownerUserId) || !existsSync(path)) {
                continue;
            }
            try {
                const lacking = this.engine.listedParts(path).filter((part) => !existsSync(part.file)).length;
                if (lacking) {
                    missingParts += lacking;
                    partDatasetIds.push(row.id);
                }
            } catch {
                // Read again at the next check.
            }
        }
        const warnings = [
            ids.length &&
                `${ids.length} registered dataset file(s) missing under USER_DATA_DIR; reads and writes of them fail until the files are restored.`,
            missingParts &&
                `${missingParts} analytical part(s) of ${partDatasetIds.length} dataset(s) missing under USER_DATA_DIR; queries of those tables fail until they are restored.`,
        ].filter(Boolean);
        const analytics = this.analytics.status();
        return {
            missing: ids.length,
            ids,
            ...(missingParts ? { missingParts, partDatasetIds } : {}),
            // Only while it runs (or is restarting): an install that doesn't use
            // analytical tables reports as before.
            ...(analytics.state === 'running' || analytics.state === 'restarting'
                ? {
                      analytics: {
                          mode: analytics.mode,
                          state: analytics.state,
                          running: analytics.running,
                          queued: analytics.queued,
                      },
                  }
                : {}),
            ...(warnings.length ? { warning: warnings.join(' ') } : {}),
        };
    }
    /** Checks the store (creating the bucket if missing); false when unreachable. */
    async probeStorage() {
        try {
            await this.objects.ensureReady();
            if (this.objects.driver === 's3') {
                this.storageReachable = true;
            }
            return true;
        } catch (error) {
            if (!(error instanceof StorageUnavailableError)) {
                throw error;
            }
            if (this.objects.driver === 's3') {
                this.storageReachable = false;
            }
            return false;
        }
    }
    /** Rows whose bytes are still on the local disk while S3 is the store. */
    pendingLocalFiles() {
        if (this.objects.driver === 'local') {
            return 0;
        }
        return Number(
            (this.db.prepare("SELECT count(*) AS n FROM data_files WHERE storage='local'").get() as { n: number }).n,
        );
    }
    /** Whether a migration run has work: files left, or no sweep yet. */
    migrationDue() {
        return this.objects.driver === 's3' && (!this.swept || this.pendingLocalFiles() > 0);
    }
    /**
     * The one-time move of local files into S3 (`migrate-local.ts`); one run
     * at a time, nothing to do on the local driver. Until one completes in
     * this process, runs also sweep local copies an earlier one left behind.
     */
    migrateToObjectStore(): Promise<LocalMigrationResult> {
        if (this.migration) {
            return this.migration;
        }
        if (this.objects.driver === 'local') {
            return Promise.resolve({
                moved: 0,
                missing: 0,
                mismatched: 0,
                cleaned: 0,
                unavailable: false,
            });
        }
        const sweep = !this.swept;
        this.migration = this.options.moves
            .migrateLocalFiles({
                db: this.db,
                files: this.repos.files,
                from: this.legacy,
                to: this.objects,
                key: (driver, userId, fileId) => this.key(driver, userId, fileId),
                exclusive: (userId, work) => this.exclusive(userId, work),
                stopped: () => this.closed,
                sweep,
            })
            .then((result) => {
                this.storageReachable = !result.unavailable;
                if (sweep && !result.unavailable) {
                    this.swept = true;
                }
                return result;
            })
            .finally(() => {
                this.migration = undefined;
            });
        return this.migration;
    }
    /** How many files each key state seals (CB-62), from the rows. */
    sealStates(): Record<SealState, number> {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        for (const { sealKey, n } of this.db
            .prepare('SELECT sealKey, count(*) AS n FROM data_files GROUP BY sealKey')
            .all() as Array<{ sealKey: string; n: number }>) {
            counts[this.box.state(sealKey)] += Number(n);
        }
        return counts;
    }
    /**
     * A file's object as stored, still sealed (CB-322): what a recovery key
     * check opens, for a row of a restored copy. Undefined when the object
     * is gone or its store isn't configured here.
     */
    async sealedObject(row: { id: string; ownerUserId: string; storage: string }): Promise<Uint8Array | undefined> {
        try {
            const driver = row.storage as StorageDriver;
            return (await this.store(driver).get(this.key(driver, row.ownerUserId, row.id))) ?? undefined;
        } catch {
            return undefined;
        }
    }
    /** Whether a re-seal has work: files under the legacy or previous key. */
    resealDue() {
        if (this.box.currentKey === LEGACY_KEY) {
            return false;
        }
        const states = this.sealStates();
        return states.legacy + states.previous > 0;
    }
    /**
     * Seals files again under the current data key (`reseal.ts`, CB-62); one
     * run at a time, nothing to do without a data key.
     */
    resealFiles(): Promise<ResealResult> {
        if (this.resealing) {
            return this.resealing;
        }
        this.resealing = this.options.moves
            .resealFiles({
                db: this.db,
                files: this.repos.files,
                box: this.box,
                store: (driver) => this.store(driver),
                key: (driver, userId, fileId) => this.key(driver, userId, fileId),
                exclusive: (userId, work) => this.exclusive(userId, work),
                stopped: () => this.closed,
            })
            .finally(() => {
                this.resealing = undefined;
            });
        return this.resealing;
    }
    private fileView(row: FileRow): DataFileView {
        return {
            path: row.path,
            size: row.size,
            mediaType: row.mediaType,
            createdByDotId: row.createdByDotId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
    /** What a Dot's capabilities say about its data, without creating anything. */
    summary(userId: string, dotId: string) {
        // The scratch its data tools reach: a company socio's shared one (CB-337).
        const scratch = this.scratch(this.scratchOwner({ kind: 'dot', userId, dotId }), dotId, false);
        const grants = this.grantRows(userId, dotId);
        return {
            scratch: scratch
                ? {
                      id: scratch.id,
                      name: scratch.name,
                      tables: scratch.tableCount,
                      sizeBytes: scratch.sizeBytes,
                  }
                : 'created on first use',
            ownFolder: ownFolder(dotId),
            grantedDatasets: grants
                .filter((grant) => grant.datasetId)
                .map((grant) => ({
                    name: this.row(grant.datasetId!)?.name ?? 'deleted',
                    access: grant.access,
                })),
            grantedFolders: grants
                .filter((grant) => grant.folder)
                .map((grant) => ({ folder: grant.folder, access: grant.access })),
            usage: this.usage(userId),
        };
    }

    /**
     * What a computer exec gets (ComputerService): a token for this command
     * alone (CB-224), revoked when it returns, so it is no use to anything
     * that reads it after that. On a company socio's computer, which other
     * commands and processes share while it runs, it reaches only the
     * socio's shared area (its shared dataset and folder, owned by no
     * person) and, to read, datasets shared with a Space (`reach`). The platform writes it to a file
     * of its own under `.socio/run/` (the computer API has no environment
     * option) that the command's prefix sources and deletes before anything
     * else runs; the command sees CB_DATA_URL and CB_DATA_TOKEN without the
     * token ever being in the command, the audit or a log. The prefix also
     * deletes `.socio/data.env`, where computers before CB-224 kept a token.
     * Nothing without DATA_API_URL.
     */
    computerEnv(
        dotId: string,
        userId: string | undefined,
        apiUrl: string | undefined,
        runMs: number,
    ): ComputerExecEnv | undefined {
        if (!apiUrl || !userId || !this.options.workspace.dot(dotId)) {
            return undefined;
        }
        // A company socio's computer is shared: its token reaches only what
        // the socio itself may, never the user's private data.
        const { token, session } = this.tokens.forCommand(
            userId,
            dotId,
            runMs,
            this.options.workspace.dot(dotId)!.ownerId ? 'person' : 'socio',
        );
        const file = `${COMPUTER_RUN_DIR}/${randomUUID()}.env`;
        return {
            file: {
                path: file,
                contents: `CB_DATA_URL='${apiUrl.replace(/'/g, '')}/api/data'\nCB_DATA_TOKEN='${token}'\n`,
            },
            prefix: `chmod 600 ${file} 2>/dev/null; set -a; [ -r ${file} ] && . ./${file}; set +a; rm -f ${file}; [ ! -L .socio ] && rm -f ${LEGACY_COMPUTER_ENV_FILE}\n`,
            secrets: [token],
            release: () => this.tokens.revokeSession(session),
        };
    }

    // ---- company socios' shared areas (CB-229) ------------------------------
    /**
     * Whether a person may see and clean up a company socio's shared area:
     * admins always; anyone else once they have used the socio (a chat with
     * it, archived or deleted ones too, or anything its tools or computer did
     * for them). Every member may use a company socio, so "the people who use
     * it" would otherwise be everyone, including people it never worked for.
     * A personal socio has no shared area.
     */
    canSeeShared(userId: string, dotId: string) {
        if (this.options.workspace.dot(dotId)?.ownerId) {
            return false;
        }
        const user = this.options.workspace.users().find((entry) => entry.id === userId);
        if (!user) {
            return false;
        }
        if (isAdmin(user)) {
            return true;
        }
        return (
            !!this.options.workspace.usedDot?.(userId, dotId) ||
            !!this.db.prepare('SELECT 1 FROM data_audit WHERE ownerUserId=? AND dotId=? LIMIT 1').get(userId, dotId)
        );
    }
    /** The shared area, or the same 404 as a socio that doesn't exist. */
    private requireShared(userId: string, dotId: string) {
        if (!this.canSeeShared(userId, dotId)) {
            throw new DataError('Socio not found.', 404);
        }
        return sharedOwner(dotId);
    }
    private sharedDataset(dotId: string) {
        const row = this.scratch(sharedOwner(dotId), dotId, false);
        if (!row) {
            throw new DataError('This socio has no shared dataset.', 404);
        }
        return row;
    }
    /**
     * The shared areas a person may see that hold anything, by socio name:
     * each one's dataset and tables, its files, their sizes, and who put
     * each there and when, from the data audit.
     */
    sharedAreas(userId: string): SharedAreaView[] {
        const owners = this.db
            .prepare(
                `SELECT ownerUserId AS id FROM data_datasets WHERE ${SHARED_OWNERS} AND ${LIVE} UNION SELECT ownerUserId FROM data_files WHERE ${SHARED_OWNERS} AND ${LIVE}`,
            )
            .all()
            .map((row) => String(row.id));
        return owners
            .map((owner) => owner.slice(SOCIO_OWNER_PREFIX.length))
            .filter((dotId) => this.canSeeShared(userId, dotId))
            .map((dotId) => this.sharedArea(dotId))
            .filter((area) => area.files.length || area.dataset?.tables.length)
            .sort((a, b) => (a.dotName ?? '\uffff').localeCompare(b.dotName ?? '\uffff'));
    }
    private sharedArea(dotId: string): SharedAreaView {
        const owner = sharedOwner(dotId);
        const dot = this.options.workspace.dot(dotId);
        const names = new Map(this.options.workspace.users().map((user) => [user.id, user.name]));
        type Row = { ownerUserId: string; actorKind: string; at: number | null };
        const origin = (row: Row | undefined): SharedOrigin | null =>
            row && row.at !== null
                ? {
                      by: reservedUserId(row.ownerUserId) ? null : (names.get(row.ownerUserId) ?? null),
                      via: VIA[row.actorKind] ?? 'system',
                      at: Number(row.at),
                  }
                : null;
        let dataset: SharedAreaView['dataset'] = null;
        const row = this.scratch(owner, dotId, false);
        if (row) {
            const path = this.datasetPath(row);
            const sizes = this.engine.tableSizes(path);
            // The latest of each action on each table (`<dataset>.<table>`).
            const latest = this.db
                .prepare(
                    "SELECT target, action, ownerUserId, actorKind, max(createdAt) AS at FROM data_audit WHERE area=? AND datasetId=? AND outcome='ok' AND action IN ('create_table', 'add_column', 'insert', 'upsert', 'delete_rows', 'delete_table') GROUP BY target, action",
                )
                .all(owner, row.id) as Array<Row & { target: string; action: string }>;
            const created = this.db.prepare(
                "SELECT ownerUserId, actorKind, min(createdAt) AS at FROM data_audit WHERE area=? AND datasetId=? AND target=? AND action='create_table' AND outcome='ok' AND createdAt>=?",
            );
            dataset = {
                id: row.id,
                name: row.name,
                sizeBytes: row.sizeBytes,
                updatedAt: row.updatedAt,
                tables: this.engine.tables(path).map((table) => {
                    const target = `${row.name}.${table.name}`;
                    const of = latest.filter((entry) => entry.target === target);
                    // A table deleted before and made again: since then.
                    const since = of.find((entry) => entry.action === 'delete_table')?.at ?? 0;
                    const changed = of
                        .filter((entry) => entry.action !== 'delete_table')
                        .sort((a, b) => Number(b.at) - Number(a.at))[0];
                    return {
                        name: table.name,
                        rowCount: table.rowCount,
                        sizeBytes: sizes.get(table.name) ?? 0,
                        created: origin(created.get(owner, row.id, target, since) as Row | undefined),
                        changed: origin(changed),
                    };
                }),
            };
        }
        const puts = new Map(
            (
                this.db
                    .prepare(
                        "SELECT target, ownerUserId, actorKind, max(createdAt) AS at FROM data_audit WHERE area=? AND action='files_put' AND outcome='ok' GROUP BY target",
                    )
                    .all(owner) as Array<Row & { target: string }>
            ).map((entry) => [entry.target, entry]),
        );
        const folder = ownFolder(dotId);
        const files = (
            this.db
                .prepare(`SELECT * FROM data_files WHERE ownerUserId=? AND ${LIVE} ORDER BY path`)
                .all(owner) as unknown as FileRow[]
        ).map((file) => ({
            path: file.path.startsWith(folder) ? file.path.slice(folder.length) : file.path,
            size: file.size,
            mediaType: file.mediaType,
            updatedAt: file.updatedAt,
            added: origin(puts.get(file.path)),
        }));
        return {
            dotId,
            dotName: dot?.name ?? null,
            archived: !!dot?.archivedAt,
            dataset,
            files,
            totalBytes: this.usage(owner).totalBytes,
            retentionDays: this.limits.sharedRetentionDays,
        };
    }
    /** A path in a shared area: as the view gives it, or in full. */
    private sharedPath(dotId: string, raw: string) {
        const path = normalizePath(raw);
        return path.startsWith(ownFolder(dotId)) ? path : `${ownFolder(dotId)}${path}`;
    }
    /** Download a shared file after checking the signed-in person's access. */
    async getSharedFile(userId: string, dotId: string, rawPath: string) {
        const owner = this.requireShared(userId, dotId);
        return this.getFile({ kind: 'user', userId: owner }, this.sharedPath(dotId, rawPath));
    }
    /** A person deletes a file in a shared area they may see; it is kept. */
    async deleteSharedFile(userId: string, dotId: string, rawPath: string) {
        const owner = this.requireShared(userId, dotId);
        await this.deleteFile(
            owner,
            this.sharedPath(dotId, rawPath),
            { by: userId },
            {
                kind: 'user',
                userId,
            },
        );
    }
    /**
     * A person deletes a table of a shared dataset: renamed and kept in the
     * file (`DatasetEngine.deleteTable`), audited as theirs.
     */
    deleteSharedTable(userId: string, dotId: string, table: string) {
        this.requireShared(userId, dotId);
        const row = this.sharedDataset(dotId);
        const sizes = { sizeBytes: row.sizeBytes, historyBytes: row.historyBytes };
        const result = this.engine.deleteTable(this.datasetPath(row), table, Date.now(), { writer: userId, sizes });
        this.touch(row, sizes);
        this.audit({ kind: 'user', userId }, 'delete_table', 'ok', {
            datasetId: row.id,
            target: `${row.name}.${table}`,
            detail: `kept as ${result.table}`,
            area: row.ownerUserId,
        });
    }
    /**
     * A person deletes rows of a shared dataset's table by rowid: each is
     * kept in the table's history, with who deleted it.
     */
    deleteSharedRows(userId: string, dotId: string, table: string, rowids: readonly number[]) {
        this.requireShared(userId, dotId);
        const row = this.sharedDataset(dotId);
        const sizes = { sizeBytes: row.sizeBytes, historyBytes: row.historyBytes };
        const result = this.engine.deleteRows(this.datasetPath(row), table, rowids, { writer: userId, sizes });
        this.touch(row, sizes);
        this.audit({ kind: 'user', userId }, 'delete_rows', 'ok', {
            datasetId: row.id,
            target: `${row.name}.${table}`,
            detail: `${result.deleted} row(s); kept in the table's history`,
            area: row.ownerUserId,
        });
        return result;
    }

    // ---- lifecycle ----------------------------------------------------------
    /**
     * A Dot was deleted: its scratch datasets stay with each user, marked
     * "from a deleted Dot"; its grants and tokens go; its pending approvals
     * expire and its policies are removed.
     */
    forgetDot(dotId: string) {
        const now = Date.now();
        // Synchronous: `datasetsFor` reconciles on its way (CB-110).
        const marked = this.repos.datasets.markDotDeletedNow(dotId, now);
        const grants = this.repos.grants.removeForDotNow(dotId);
        for (const userId of grants) {
            this.audit({ kind: 'system', userId }, 'revoke', 'ok', {
                detail: 'The socio was deleted; its grants were removed.',
            });
        }
        this.tokens.revokeDot(dotId);
        // Queued behind any open unit of work (CB-110); a failure is logged.
        void this.options.approvals
            .forgetDot(dotId)
            .catch((error: unknown) =>
                console.error(
                    `Approvals: forgetting a deleted socio failed: ${error instanceof Error ? error.name : 'unknown'}`,
                ),
            );
        return { marked, grantsFrom: grants.length };
    }
    /** Applies `forgetDot` to Dots that are gone (deleted outside this service). */
    reconcileDots() {
        const known = new Set(this.options.workspace.dots().map((dot) => dot.id));
        const orphaned = this.db
            .prepare(
                'SELECT DISTINCT scratchForDotId AS id FROM data_datasets WHERE scratchForDotId IS NOT NULL AND dotDeletedAt IS NULL UNION SELECT DISTINCT dotId FROM data_grants',
            )
            .all()
            .map((row) => String(row.id))
            .filter((id) => !known.has(id));
        for (const id of orphaned) {
            this.forgetDot(id);
        }
        return orphaned.length;
    }
    /**
     * Deletes (hides, CB-64) datasets not changed within their retention, as
     * the system; returns how many.
     */
    applyRetention(now = Date.now()) {
        const rows = this.db
            .prepare(
                `SELECT * FROM data_datasets WHERE retentionDays IS NOT NULL AND updatedAt + retentionDays * ? < ? AND ${LIVE}`,
            )
            .all(DAY, now) as unknown as DatasetRow[];
        for (const row of rows) {
            this.deleteDataset(row.ownerUserId, row.id, {
                kind: 'system',
                userId: row.ownerUserId,
            });
        }
        return rows.length;
    }
    /**
     * Deletes (hides) what nobody changed in a company socio's shared area
     * for `sharedRetentionDays` (CB-229): its files, and its shared dataset,
     * which the next command starts again. Never a workspace dataset there
     * (CB-354): a promoted app's data is kept like any dataset. As the system, in the area's
     * audit; returns how many. 0 days keeps everything.
     */
    async applySharedRetention(now = Date.now()) {
        const days = this.limits.sharedRetentionDays;
        if (!days) {
            return 0;
        }
        const before = now - days * DAY;
        const datasets = this.db
            .prepare(
                `SELECT id, ownerUserId FROM data_datasets WHERE ${SHARED_OWNERS} AND scratchForDotId IS NOT NULL AND updatedAt < ? AND ${LIVE}`,
            )
            .all(before) as Array<{ id: string; ownerUserId: string }>;
        await transaction(this.db, 'shared area retention', () => {
            for (const row of datasets) {
                this.deleteDataset(row.ownerUserId, row.id, {
                    kind: 'system',
                    userId: row.ownerUserId,
                });
            }
        });
        const files = this.db
            .prepare(`SELECT ownerUserId, path FROM data_files WHERE ${SHARED_OWNERS} AND updatedAt < ? AND ${LIVE}`)
            .all(before) as Array<{ ownerUserId: string; path: string }>;
        let deleted = datasets.length;
        for (const file of files) {
            try {
                await this.deleteFile(
                    file.ownerUserId,
                    file.path,
                    { by: SYSTEM },
                    { kind: 'system', userId: file.ownerUserId },
                );
                deleted++;
            } catch (error) {
                // Deleted meanwhile.
                if (!(error instanceof DataError && error.status === 404)) {
                    throw error;
                }
            }
        }
        return deleted;
    }

    // ---- approvals ------------------------------------------------------------
    private registerApprovals() {
        const { approvals } = this.options;
        approvals.register<CreateDatasetPayload>({
            capability: APPROVAL_CAPABILITIES.createDataset,
            label: 'Create datasets',
            description:
                'A dataset in your data space beyond the socio’s scratch dataset. The socio gets write access to it.',
            auto: {
                maxRiskForAuto: 'medium',
                riskNotes:
                    'A new, empty dataset private to the user, counted against their quota. Low risk unless its name or purpose falls outside the socio’s role.',
            },
            execute: ({ userId, dotId, payload }) =>
                transaction(this.db, 'create dataset', () => {
                    const dot = this.requireDot(dotId);
                    const dataset = this.createDataset(
                        userId,
                        {
                            name: payload.name,
                            description: payload.description,
                            createdByDotId: dotId,
                        },
                        { kind: 'dot', userId, dotId },
                    );
                    this.setGrant(userId, { dotId, datasetId: dataset.id, access: 'write' }, 'approval');
                    return {
                        outcome: `Created dataset “${dataset.name}” (${dataset.id}); ${dot.name} can write to it.`,
                        undoData: { datasetId: dataset.id },
                    };
                }),
            // Undo deletes (hides) the dataset, with whatever the Dot wrote since.
            undo: ({ userId, undoData }) =>
                transaction(this.db, 'undo dataset creation', () => {
                    const { datasetId } = (undoData ?? {}) as { datasetId?: string };
                    const row = datasetId ? this.row(datasetId) : undefined;
                    if (!row || row.ownerUserId !== userId) {
                        return 'The dataset was already deleted.';
                    }
                    this.deleteDataset(userId, row.id);
                    return `Deleted dataset “${row.name}”.`;
                }),
        });
        approvals.register<WriteSharedPayload>({
            capability: APPROVAL_CAPABILITIES.writeShared,
            label: 'Write shared datasets',
            description: 'Changes to a dataset you shared with a Space (new tables, columns, rows).',
            auto: {
                maxRiskForAuto: 'low',
                riskNotes: 'Everyone in the Space sees the change, and rows written can’t be taken back automatically.',
                rules: [
                    {
                        description: `More than ${AUTO_MAX_SHARED_ROWS} rows at once always need you`,
                        check: ({ payload }) =>
                            (payload.write.op === 'insert' || payload.write.op === 'upsert') &&
                            Array.isArray(payload.write.rows) &&
                            payload.write.rows.length > AUTO_MAX_SHARED_ROWS
                                ? `It writes ${payload.write.rows.length} rows to a shared dataset; more than ${AUTO_MAX_SHARED_ROWS} at once always need you.`
                                : false,
                    },
                ],
                describe: (payload) => ({
                    datasetId: payload.datasetId,
                    op: payload.write.op,
                    ...(payload.write.op === 'insert' || payload.write.op === 'upsert'
                        ? {
                              table: payload.write.table,
                              rowCount: Array.isArray(payload.write.rows) ? payload.write.rows.length : 0,
                              sampleRows: Array.isArray(payload.write.rows) ? payload.write.rows.slice(0, 3) : [],
                          }
                        : { change: payload.write }),
                }),
            },
            execute: ({ userId, dotId, payload }) =>
                transaction(this.db, 'write shared dataset', () => {
                    const actor: AgentActor = { kind: 'dot', userId, dotId };
                    const visible = widest(this.visible(actor).filter((item) => item.row.id === payload.datasetId));
                    if (!visible || visible.access !== 'write') {
                        throw new DataError('The socio no longer has write access to this dataset.', 403);
                    }
                    const result = this.applyWrite(actor, visible.row, payload.write);
                    return `Done in “${visible.row.name}”: ${describeWrite(payload.write)}${'changes' in result ? ` (${String(result.changes)} change(s))` : ''}.`;
                }),
        });
        approvals.register<GrantPayload>({
            capability: APPROVAL_CAPABILITIES.grantChange,
            label: 'Change grants',
            description: 'A socio asking for access to one of your datasets or folders.',
            auto: {
                maxRiskForAuto: 'low',
                riskNotes:
                    'The socio can then read (or write) that data in every later turn for this user. Write access and access to data shared with a Space are riskier.',
                rules: [
                    {
                        description: 'Write access to a dataset shared with a Space always needs you',
                        check: ({ userId, payload }) => {
                            if (payload.access !== 'write' || !payload.datasetId) {
                                return false;
                            }
                            const row = this.row(payload.datasetId);
                            return row && this.manages(userId, row) && row.sharedSpaceId
                                ? 'It asks for write access to a dataset shared with a Space, which always needs you.'
                                : false;
                        },
                    },
                    {
                        description: 'Access to a plugin’s dataset always needs you',
                        check: ({ payload }) => {
                            const row = payload.datasetId ? this.row(payload.datasetId) : undefined;
                            return row && isCompanyOwner(row.ownerUserId)
                                ? 'It asks for access to a plugin’s dataset, which is the company’s: that always needs an admin.'
                                : false;
                        },
                    },
                    {
                        description: 'Write access to a folder always needs you',
                        check: ({ payload }) =>
                            payload.folder !== undefined && payload.access === 'write'
                                ? 'It asks for write access to a folder of your files, which always needs you.'
                                : false,
                    },
                ],
            },
            execute: ({ userId, dotId, payload }) =>
                transaction(this.db, 'change grant', () => {
                    // A workspace dataset in the socio's area (CB-354): the area's grant.
                    const workspace = this.workspaceDataset(dotId, payload.datasetId);
                    if (workspace) {
                        const before = this.grantRows(workspace.ownerUserId, dotId).find(
                            (grant) => grant.datasetId === workspace.id,
                        );
                        const grant = this.setWorkspaceGrant(userId, dotId, workspace, payload.access);
                        return {
                            outcome: `${grant.dotName} now has ${grant.access} access to the workspace dataset “${workspace.name}”.`,
                            // Never auto-approved (`alwaysAsk`), so never undone here.
                            undoData: { grantId: grant.id, previous: before?.access ?? null },
                        };
                    }
                    const before = this.grantRows(userId, dotId).find((grant) =>
                        payload.datasetId
                            ? grant.datasetId === payload.datasetId
                            : grant.folder === normalizePath(payload.folder ?? '', true),
                    );
                    const grant = this.setGrant(userId, { dotId, ...payload }, 'approval');
                    return {
                        outcome: `${grant.dotName} now has ${grant.access} access to ${grant.datasetName ? `“${grant.datasetName}”` : grant.folder}.`,
                        undoData: { grantId: grant.id, previous: before?.access ?? null },
                    };
                }),
            // Undo puts the grant back as it was: the previous access, or none.
            // One unit of work, as revoking writes through the repositories.
            undo: ({ userId, dotId, undoData }) =>
                sqliteData(this.db).uow.run(
                    async () => {
                        const { grantId, previous } = (undoData ?? {}) as {
                            grantId?: string;
                            previous?: GrantAccess | null;
                        };
                        const grant = this.grants(userId).find((item) => item.id === grantId);
                        if (!grant) {
                            return 'The grant was already removed.';
                        }
                        if (previous) {
                            this.setGrant(
                                userId,
                                {
                                    dotId,
                                    datasetId: grant.datasetId,
                                    folder: grant.folder,
                                    access: previous,
                                },
                                'approval',
                            );
                            return `${grant.dotName} has ${previous} access again.`;
                        }
                        await this.revokeGrant(userId, grant.id);
                        return `Removed ${grant.dotName}’s access to ${grant.datasetName ? `“${grant.datasetName}”` : grant.folder}.`;
                    },
                    { label: 'undo grant change', savepoint: true },
                ),
        });
    }
}

function describeWrite(write: WriteOp) {
    switch (write.op) {
        case 'create_table':
            return `create table ${write.input.table}`;
        case 'add_column':
            return `add column ${write.column.name} to ${write.table}`;
        case 'create_index':
            return `index ${write.table} on ${write.index.columns.join(', ')}`;
        case 'drop_index':
            return `drop index ${write.name} from ${write.table}`;
        case 'analyze':
            return write.table ? `analyze ${write.table}` : 'analyze every table';
        case 'insert':
            return `insert ${Array.isArray(write.rows) ? write.rows.length : 0} row(s) into ${write.table}`;
        case 'upsert':
            return `upsert ${Array.isArray(write.rows) ? write.rows.length : 0} row(s) into ${write.table}`;
    }
}
function writeDetails(write: WriteOp): string[] {
    if (write.op === 'create_table') {
        return [
            `Columns: ${write.input.columns.map((column) => `${column.name} ${column.type ?? 'TEXT'}`).join(', ')}`,
        ];
    }
    if (write.op === 'add_column') {
        return [`Column: ${write.column.name} ${write.column.type ?? 'TEXT'}`];
    }
    if (write.op === 'create_index') {
        return [
            `Index: ${write.index.name}${write.index.unique ? ' (unique)' : ''} on ${write.index.columns.join(', ')}`,
        ];
    }
    if (write.op === 'drop_index') {
        return [`Index: ${write.name}`];
    }
    if (write.op === 'analyze') {
        return [];
    }
    const rows = Array.isArray(write.rows) ? write.rows : [];
    return rows.slice(0, 3).map((row) => JSON.stringify(row).slice(0, 200));
}

/** A retention for the audit: its days and where they come from (CB-387). */
function describeRetention(retention: AnalyticalRetention) {
    const days = retention.days ? `${retention.days} days` : 'keep everything';
    const from = { override: 'admin override', manifest: 'the plugin', default: 'workspace default' }[retention.source];
    return `${days} (${from})`;
}
