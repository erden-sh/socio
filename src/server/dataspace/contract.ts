/**
 * What other features may know of the data space: its tags, the slices of
 * `DataSpace` and `DataTokens` they and the composition call, and plain types
 * and constants. It imports only `effect`, `@socio/*` and other contracts,
 * and holds no logic.
 *
 * The types and constants here moved from the files that defined them
 * (`space.ts`, `limits.ts`, `obo.ts`, `domain/repositories.ts`), which
 * re-export them, so every importer keeps compiling until that importer
 * switches to the contract. The pure code other features call moved to
 * packages: `DataError` to `@socio/foundation/dataspace/data-error` (still a
 * plain `Error`: a tagged error would change its `name`, `String()` and
 * JSON), `normalizePath` to `@socio/foundation/dataspace/paths`, and the
 * data API's operations table
 * (`operationTier`, `dataApprovalParams`, `DATA_ACTION_PREFIX`, ...) to
 * `@socio/shared/dataspace/operations`.
 */
import type { Buffer } from 'node:buffer';

import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { Context } from 'effect';

import type { ObjectStore, StorageDriver } from '@socio/data/object-store';
import type { DataTokenScope } from '@socio/foundation/http/app-env';
import type { SealState } from '@socio/foundation/keys/secret-box';
import type { ComputerExecEnv, DotTurn } from '@socio/foundation/turns/turn';
import type { OwnedList, TransferParties, TransferTally } from '@socio/shared/auth';
import type {
    CellValue,
    ColumnType,
    DataAuditEntry,
    DataFileView,
    DataSpaceState,
    DataUsageView,
    DatasetDetail,
    DatasetView,
    GrantAccess,
    GrantView,
    PluginDataBudget,
    QueryResult,
    SharedAreaView,
    TableInfo,
} from '@socio/shared/data-types';
import type { DataLimits } from '@socio/shared/dataspace/limits';
import type {
    PluginBindingChoice,
    PluginBindingChoices,
    PluginBindingPlan,
    PluginNeedPlan,
    PluginTokenNeed,
} from '@socio/shared/plugins/bindings';
import type { PluginDatasetAccess, PluginDatasetTable } from '@socio/shared/plugins/plugins';
import type { PrivateItemsResponse, SpaceDatasetItem } from '@socio/shared/spaces/space-items';
import type { User } from '@socio/shared/types';

import type { ApprovalOutcome } from '../approvals/contract.js';
import type { LocalMigrationResult, ResealResult } from '../storage/contract.js';

// ── Limits and settings ──────────────────────────────────────────────────

export { DEFAULT_DATA_LIMITS, type DataLimits } from '@socio/shared/dataspace/limits';

/** The data space's settings, from the environment (index.ts). */
export interface DataSettings {
    /** `USER_DATA_DIR`: `/data/userdata` in the image (next to DATABASE_PATH). */
    userDataDir?: string;
    /**
     * `DATA_API_URL`: the app as the computers reach it (`http://app:4310` on
     * the computers network). Unset, computers get no data token.
     */
    apiUrl?: string;
    /** `DATA_TOKEN_TTL_MINUTES` (60): the longest a computer command's token lives. */
    tokenTtlMs?: number;
    limits?: Partial<DataLimits>;
    /**
     * `DATA_ANALYTICS_MODE` (CB-369): `child` (the default) forks the
     * analytics process the first time an analytical table is used; `off`
     * refuses analytical tables, and existing ones show as unavailable.
     */
    analyticsMode?: 'child' | 'off';
}

// ── Actors ───────────────────────────────────────────────────────────────

/**
 * Who is acting on the data space: the signed-in user (the app), one of
 * their Dots in a turn (tools), or code holding a scoped token (a computer,
 * a job). Dots and tokens act for `userId` and see only that user's data:
 * the Dot's scratch dataset plus what the user granted it.
 */
export type DataActor =
    | { kind: 'user'; userId: string }
    | {
          kind: 'dot';
          userId: string;
          dotId: string;
          threadId?: string;
          /** A copy into a company socio's shared folder (`copyFile`). */
          reach?: 'socio';
      }
    | {
          kind: 'token';
          /**
           * `plugin`: a service plugin's own work (`userId` is its owner id
           * `plugin:<id>`, `dotId` empty): the datasets it declares, nothing else.
           */
          purpose?: 'computer' | 'job' | 'app' | 'plugin' | 'api';
          userId: string;
          dotId: string;
          datasetIds?: readonly string[];
          /**
           * An admin's data API token (`purpose: 'api'`, `userId` the
           * workspace owner, `dotId` empty): its id, maker, scopes and budget.
           */
          apiToken?: DataTokenScope['apiToken'];
          /** A promoted mini app: its own grants instead of the Dot's. */
          appId?: string;
          /**
           * A command on a company socio's computer (`DataTokenScope.reach`):
           * the socio's shared area, and Space-shared datasets to read.
           */
          reach?: 'socio';
          /** A plugin's token (`purpose: 'plugin'`): the plugin. */
          pluginId?: string;
      };
export type AgentActor = Exclude<DataActor, { kind: 'user' }>;

// ── Rows ─────────────────────────────────────────────────────────────────

/** Who deleted a row, when, and what it went with (CB-64). */
export interface DeletedStamp {
    at: number;
    by: string;
    with: string | null;
}

/** A dataset's metadata (`data_datasets`); its rows are in its own file. */
export interface Dataset {
    id: string;
    ownerUserId: string;
    name: string;
    description: string;
    createdByDotId: string | null;
    /** The Dot whose scratch dataset this is, in its owner's space. */
    scratchForDotId: string | null;
    /** Set when that Dot was deleted; the dataset stays. */
    dotDeletedAt: number | null;
    sharedSpaceId: string | null;
    retentionDays: number | null;
    /** What counts against the quota: the file without its row history. */
    sizeBytes: number;
    /** The file's row history (data schema v6). */
    historyBytes: number;
    /**
     * Days kept rows are kept (CB-369 Phase H, data schema v11); null or
     * absent: all of them. The nightly prune deletes older ones.
     */
    historyDays?: number | null;
    /** When its owner asked to compact the file; the nightly run does it. */
    compactRequestedAt?: number | null;
    /** Its live analytical parts' bytes (CB-369, data schema v12). */
    analyticalBytes?: number;
    tableCount: number;
    createdAt: number;
    updatedAt: number;
    /** CB-64: set once deleted; the row and its SQLite file are kept. */
    deletedAt?: number | null;
    deletedBy?: string | null;
    deletedWith?: string | null;
    /**
     * Its place in `sharedSpaceId` (CB-451; data schema v14):
     * under that live page, or at the root (null); at a stored key among its
     * siblings, or (null) in the order it joined the Space (`spaceAddedAt`).
     */
    spaceParentId?: string | null;
    spacePosition?: string | null;
    spaceAddedAt?: number | null;
}

/** A file's metadata (`data_files`); its sealed bytes are in the object store. */
export interface DataFile {
    id: string;
    ownerUserId: string;
    path: string;
    size: number;
    storedSize: number;
    mediaType: string;
    createdByDotId: string | null;
    createdAt: number;
    updatedAt: number;
    /** Which store holds the sealed bytes (data schema v2). */
    storage: StorageDriver;
    /** The original display name; null: the path's last segment. */
    name: string | null;
    /** The data key's id that sealed it, or `legacy` (data schema v4, CB-62). */
    sealKey: string;
    /** CB-64: set once deleted; the row and its sealed bytes are kept. */
    deletedAt?: number | null;
    deletedBy?: string | null;
    deletedWith?: string | null;
}

/** New bytes for a file, sealed and stored. */
export type FileContent = Pick<DataFile, 'size' | 'storedSize' | 'mediaType' | 'storage' | 'sealKey'>;

/** File metadata. Reads leave deleted files out unless named `withDeleted`. */
export interface FileRepository {
    /** The live file at a path. */
    at(ownerUserId: string, path: string): Promise<DataFile | undefined>;
    byId(id: string): Promise<DataFile | undefined>;
    /** Deleted or not, with its stamp. */
    withDeleted(id: string): Promise<DataFile | undefined>;
    /** The live files in `folder` and under it, by path. */
    under(ownerUserId: string, folder: string): Promise<Array<Pick<DataFile, 'id' | 'path'>>>;
    /** A file, or a version an overwrite kept (born deleted). */
    insert(file: DataFile): Promise<void>;
    /**
     * New bytes for a file; `name`, when given, replaces its display name
     * (null keeps it).
     */
    replaceContent(id: string, content: FileContent, name: string | null, at: number): Promise<void>;
    /** The same bytes written again: only its type, name and time change. */
    retype(id: string, mediaType: string, name: string | null, at: number): Promise<void>;
    /** A file renamed or moved; `dropName` forgets its display name. */
    move(id: string, path: string, at: number, dropName: boolean): Promise<void>;
    /** Live files moved with their folder, in one write. */
    moveLive(moves: ReadonlyArray<{ id: string; path: string }>, at: number): Promise<void>;
    /** Hides a live file (CB-64); a deleted one keeps its stamp. */
    markDeleted(id: string, stamp: DeletedStamp): Promise<void>;
    /**
     * A file whose sealed bytes the one-time move put in `to` (CB-54): only
     * while it is still marked `local`, deleted or not.
     */
    markMoved(id: string, to: StorageDriver): Promise<void>;
    /** A file sealed again (CB-62): the key and the size of its new bytes. */
    recordSeal(id: string, sealKey: string, storedSize: number): Promise<void>;
}

// ── Files and datasets ───────────────────────────────────────────────────

/** Who deleted a file or dataset, and what it went with (CB-64). */
export interface DeleteStamp {
    /** A user id, `system`, or `dot:<id>`; the acting user by default. */
    by?: string;
    /** `<kind>:<id>` of the parent it went with (`folder:…`, `job:…`). */
    with?: string;
}

/** A dataset an agent actor sees, and how (`DataSpace.visible`). */
export interface VisibleDataset {
    row: Dataset;
    access: GrantAccess;
    scratch: boolean;
    /** A promoted app's name for it (its manifest's id, e.g. `scratch`). */
    ref?: string;
}

/** Told when a file is deleted: who did it and when, for its attachments. */
export type FileDeletedListener = (
    userId: string,
    fileId: string,
    stamp: { at: number; by: string },
) => void | Promise<void>;

/** A file's metadata with its id and display name; never its bytes. */
export interface DataFileRecord extends DataFileView {
    id: string;
    name: string;
}

/** What setup reports about file storage: never endpoints or keys. */
export type StorageStatus = 'local' | 's3' | 's3_unreachable';

// ── App delegation ───────────────────────────────────────────────────────

/**
 * What an app's manifest says about its data, when its current version
 * declares `delegation.contract`. Datasets are named by id or by the
 * manifest's own ref.
 */
export interface DataContractTerms {
    /**
     * `delegation.background`: datasets the app's own work (jobs, scheduled
     * refreshes) may write without `x-cb-obo`. `write` tier only, never
     * consequential.
     */
    background: readonly string[];
    /** `background.read`: reads without `x-cb-obo` (default true). */
    backgroundRead: boolean;
    /**
     * What a person with `space` access may do per dataset through the app;
     * `read` where unset.
     */
    spaceAccess?: Readonly<Record<string, 'read' | 'write'>>;
}

/**
 * What the apps module tells the data API (registered with
 * `DataSpace.useAppDelegation`, as it does `useAppGrants`).
 */
export interface AppDataDelegation {
    /** The app's terms when its live version declares the contract. */
    terms(appId: string): DataContractTerms | undefined;
    /** The person's access to the app now (`AppsService.access`). */
    personAccess(appId: string, userId: string): 'owner' | 'space' | undefined;
    /**
     * A person's app session by the hash a `cbob_` names (`app_sessions`):
     * live, for this app, and its person may still open the app.
     */
    session(
        appId: string,
        sessionHash: string,
    ): { userId: string } | undefined | Promise<{ userId: string } | undefined>;
}

// ── Tags ─────────────────────────────────────────────────────────────────

/** The scoped data tokens' calls other features and the server make (`DataTokens`). */
export interface DataTokensShape {
    issue(scope: Omit<DataTokenScope, 'expiresAt'>, ttlMs?: number): string;
    /** The token's scope, if it is live. */
    resolve(token: string | undefined): DataTokenScope | undefined;
    /** Ends a session or run: every token issued for it, on every runtime. */
    revokeSession(session: string): void;
    /** The Dot's computer stopped, or the Dot is gone: all of its tokens. */
    revokeDot(dotId: string, purposes?: readonly DataTokenScope['purpose'][]): void;
    /** The live command tokens on a Dot's computer, to redact from what it sends back. */
    commandTokens(dotId: string): string[];
    /**
     * The data API refused this token (unknown, expired or revoked): told to
     * whoever listens (`onRefused`), so a mini app holding a dead token
     * recovers by itself (CB-291).
     */
    refused?(token: string): void;
    /** Hears refused tokens; returns how to stop. */
    onRefused?(listener: (token: string) => void): () => void;
}

/** Who a data space change is recorded as, when no person or agent made it. */
export type DataSystemActor = { kind: 'system'; userId: string };

/** What `describe` tells an agent about a dataset it sees. */
export interface DatasetDescription {
    id: string;
    name: string;
    kind: string;
    access: GrantAccess;
    sharedWithSpace: boolean;
    sizeBytes: number;
    maxBytes: number;
    tables: TableInfo[];
}

/** A column a write adds or a new table has (`columnInput` in `engine.ts`, as it accepts it). */
export interface DataColumnInput {
    name: string;
    type?: ColumnType;
    notNull?: boolean;
    primaryKey?: boolean;
    unique?: boolean;
    default?: string | number | boolean | null;
}

/** A new table (`createTableInput` in `engine.ts`, as it accepts it). */
export interface DataTableInput {
    table: string;
    columns: DataColumnInput[];
    ifNotExists?: boolean;
    /** `false`: no row history (CB-369). */
    history?: boolean;
}

/** A declared secondary index (`indexInput` in `engine.ts`, as it accepts it; CB-355). */
export interface DataIndexInput {
    name: string;
    columns: string[];
    unique?: boolean;
    ifNotExists?: boolean;
}

/** One change `write` makes to a dataset; checked by the engine. */
export type DataWriteOp =
    | { op: 'create_table'; input: DataTableInput }
    | { op: 'add_column'; table: string; column: DataColumnInput }
    | { op: 'create_index'; table: string; index: DataIndexInput }
    | { op: 'drop_index'; table: string; name: string }
    /** Refreshes the planner's statistics (SQLite ANALYZE): one table, or all of them (CB-355). */
    | { op: 'analyze'; table?: string }
    | { op: 'insert'; table: string; rows: unknown }
    | { op: 'upsert'; table: string; rows: unknown; key: string[] };

/**
 * One statement of a batch (`DataSpace.batch`, `POST …/batch`): SQL that
 * changes rows (INSERT, UPDATE, REPLACE, and DELETE for a plugin's own
 * datasets; `INSERT … SELECT` with json_extract included) with bound
 * params, or rows to insert or upsert, as the single write routes take
 * them. Never DDL: tables, columns and indexes have their own routes.
 */
export type DataBatchStatement = (
    | { sql: string; params?: Array<string | number | boolean | null> }
    | { op: 'insert'; table: string; rows: unknown }
    | { op: 'upsert'; table: string; rows: unknown; key: string[] }
) & {
    /**
     * The changes it must make (CB-475): any other count rolls the whole
     * batch back (`409`, naming the statement's index).
     */
    expectChanges?: number;
};

/** One write statement's outcome (CB-475): D1's `meta.changes` and `meta.last_row_id`, and `RETURNING` rows. */
export interface DataBatchStatementResult {
    changes: number;
    /** SQLite's `last_insert_rowid()` after it (a string past 2^53); meaningful after an INSERT. */
    lastInsertRowid: number | string | null;
    /** With a `RETURNING` clause: its columns and rows, as a query returns them. */
    columns?: string[];
    rows?: CellValue[][];
}

/** What a batch did: each statement's changed rows, in order, and each one's outcome. */
export interface DataBatchResult {
    statements: number;
    changes: number[];
    totalChanges: number;
    results: DataBatchStatementResult[];
}

/** One SELECT of a read batch (CB-474, `POST …/read-batch`). */
export interface DataReadBatchStatement {
    sql: string;
    params?: Array<string | number | boolean | null>;
}

/** A read batch's results, in order, all read from one snapshot (CB-474). */
export interface DataReadBatchResult {
    dataset: string;
    datasetId: string;
    statements: number;
    results: QueryResult[];
    ms: number;
}

/**
 * What the plugins tell the data space about a plugin's declared datasets
 * (`DataSpace.usePluginDatasets`, wired by the composition): the names its
 * installed manifest declares and its name, while it is installed.
 */
/** One need of a plugin's manifest, as the data space binds it (CB-451). */
export type DeclaredNeed = {
    name: string;
    description?: string;
    access?: PluginDatasetAccess;
    tables?: readonly PluginDatasetTable[];
};

export interface PluginDatasetSource {
    /** The installed plugin's declared needs; undefined when it is not installed. */
    declared(pluginId: string): ReadonlyArray<DeclaredNeed> | undefined;
    /** The plugin's name, for the Data page. */
    name(pluginId: string): string | undefined;
}

/** What a write did, or the approval it waits for. */
/** The chat's notice that data went to a socio's shared dataset (CB-337). */
export interface SharedWriteNotice {
    kind: 'shared_dataset';
    text: string;
    /** The dataset in the app. */
    href: string;
}
export type WriteResult =
    | {
          status: 'done';
          dataset: string;
          result: Record<string, unknown>;
          /**
           * A chat's first write to a company socio's shared dataset (CB-337):
           * what the chat tells the person, once per conversation.
           */
          notice?: SharedWriteNotice;
      }
    | Extract<ApprovalOutcome, { status: 'pending_approval' | 'denied' }>;

/**
 * The slice of `DataSpace` (`LegacyData`) that other features, the
 * composition and the server entry call. `DataSpace` implements it.
 */
export interface DataSpaceShape {
    /** Revokes every live data API token a person made; their names. */
    revokeApiTokensMadeBy(userId: string, by: string, why?: string): string[];
    /** Revokes every live data API token whose maker is no longer an active admin. */
    revokeApiTokensOfFormerAdmins(): string[];
    /** USER_DATA_DIR: one directory per user under it. */
    readonly dir: string;
    /** Where new files' sealed bytes go: S3 when configured, else the local disk. */
    readonly objects: ObjectStore;
    readonly tokens: DataTokensShape;
    /** The limits in force: the defaults, the environment's, then Settings'. */
    readonly limits: DataLimits;

    // Datasets
    datasetsFor(userId: string): DatasetView[];
    detailFor(userId: string, id: string): DatasetDetail;
    viewable(
        viewer: string,
        id: string,
        spaceId: string,
    ): {
        id: string;
        name: string;
        owned: boolean;
        sharedHere: boolean;
        /** A company socio's shared dataset (CB-337). */
        socioShared: boolean;
        updatedAt: number;
    };
    visible(actor: AgentActor, createScratch?: boolean): VisibleDataset[];
    scratch(userId: string, dotId: string, create?: boolean): Dataset | undefined;
    describe(actor: AgentActor, ref?: string): DatasetDescription;
    query(
        actor: DataActor,
        ref: string | undefined,
        sql: string,
        params?: Array<string | number | boolean | null>,
        maxRows?: number,
    ): Promise<QueryResult & { dataset: string; datasetId: string }>;
    /**
     * Changes a dataset the actor may write; a write to a Space-shared one
     * waits for its user's approval unless `approved`.
     */
    write(actor: AgentActor, ref: string | undefined, write: DataWriteOp, approved?: boolean): Promise<WriteResult>;
    updateDataset(
        userId: string,
        id: string,
        patch: {
            name?: string;
            description?: string;
            retentionDays?: number | null;
            sharedSpaceId?: string | null;
            historyDays?: number | null;
            /** Its parent page in its Space, or null for the root (CB-451). */
            spaceParentId?: string | null;
            /** Its key among its siblings, or null for the order it joined (CB-451). */
            spacePosition?: string | null;
        },
    ): DatasetView;
    /** "New dataset" in a Space: the person's, placed there, by its editors only (CB-451). */
    createInSpace(
        userId: string,
        input: { name: string; description?: string; sharedSpaceId: string; spaceParentId?: string | null },
    ): DatasetView;
    /** The datasets placed in a Space, for one of its readers (CB-451). */
    spaceDatasetItems(viewer: string, spaceId: string): SpaceDatasetItem[];
    /** The person's datasets in no Space: the "Private" group (CB-451). */
    privateItems(userId: string): PrivateItemsResponse;
    /** Moves the datasets under pages that left a Space to `parentId` (CB-451); how many. */
    reparentSpaceItems(spaceId: string, pageIds: readonly string[], parentId: string | null): number;
    /** How a dataset's parent page is checked: the pages' answer (CB-451). */
    usePlacementPages(livePage: (spaceId: string, pageId: string) => boolean): void;
    moveToNewDataset(
        userId: string,
        sourceId: string,
        input: {
            name: string;
            description?: string;
            createdByDotId?: string | null;
            tables?: readonly string[];
        },
    ): DatasetView;
    /** Whether a person may see and clean up a company socio's shared area (CB-229). */
    canSeeShared(userId: string, dotId: string): boolean;
    /** A company socio's shared dataset, for a person who may see its shared area (CB-354). */
    sharedDatasetFor(userId: string, dotId: string): Dataset | undefined;
    /**
     * Moves tables of a company socio's shared dataset into a new workspace
     * dataset in its area, no person's (CB-354).
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
    ): DatasetView;
    /**
     * Asks the person to let a company socio write to a workspace dataset in
     * its area (CB-354): a `grant.change` approval, always their own card.
     */
    requestWorkspaceAccess(userId: string, dotId: string, datasetId: string, reason: string): Promise<ApprovalOutcome>;
    deleteDataset(userId: string, id: string, actor?: DataActor | DataSystemActor, stamp?: DeleteStamp): void;
    /** Whether a dataset (deleted or not) is a workspace dataset in `dotId`'s area (CB-354). */
    isWorkspaceDataset(dotId: string, id: string): boolean;
    /** Deletes a workspace dataset in a company socio's area, as a person who may see it (CB-354); its name. */
    deleteWorkspaceDataset(userId: string, dotId: string, id: string, stamp?: DeleteStamp): string;

    // Grants
    grants(userId: string): GrantView[];
    setGrant(
        userId: string,
        input: {
            dotId: string;
            datasetId?: string | null;
            folder?: string | null;
            access: GrantAccess;
        },
        createdBy?: string,
    ): GrantView;
    endFolderGrants(userId: string, rawFolder: string): Promise<number>;
    sharedAreas(userId: string): SharedAreaView[];

    // Files
    listFiles(actor: DataActor, prefix?: string): DataFileView[];
    getFile(actor: DataActor, rawPath: string): Promise<{ file: DataFileView; data: Buffer }>;
    getFileById(actor: DataActor, fileId: string): Promise<{ file: DataFileView; data: Buffer }>;
    putFile(
        actor: DataActor,
        rawPath: string,
        data: Uint8Array,
        mediaType?: string,
        options?: { name?: string; create?: boolean },
    ): Promise<DataFileView>;
    moveFile(userId: string, rawFrom: string, rawTo: string): Promise<DataFileView>;
    moveFolder(userId: string, rawFrom: string, rawTo: string, also?: () => void | Promise<void>): Promise<number>;
    deleteFile(userId: string, rawPath: string, stamp?: DeleteStamp, as?: DataActor | DataSystemActor): Promise<void>;
    fileAt(userId: string, rawPath: string): DataFileRecord | undefined;
    fileRecord(userId: string, fileId: string): DataFileRecord | undefined;
    fileRecords(userId: string): DataFileRecord[];
    onFileDeleted(listener: FileDeletedListener): void;

    // Usage and audit
    usage(userId: string): DataUsageView;
    usageAll(): DataUsageView[];
    audit(
        actor: DataActor | DataSystemActor,
        action: string,
        outcome: DataAuditEntry['outcome'],
        fields?: {
            datasetId?: string | null;
            target?: string | null;
            detail?: string | null;
            area?: string | null;
        },
    ): void;

    // What other features register
    useAppGrants(grants: (appId: string) => Array<{ datasetId: string; access: GrantAccess; ref: string }>): void;
    useAppDelegation(delegation: AppDataDelegation): void;
    useConversationReads(check: (userId: string, path: string, threadId: string) => Promise<boolean>): void;
    usePluginDatasets(source: PluginDatasetSource): void;

    // Plugin datasets: workspace datasets bound to plugins' needs (CB-451)
    /**
     * Binds a plugin's needs (install, enable, update): the admin's
     * `choices`, else each live binding kept, a new dataset for an unbound
     * `write` need, an unbound `read` need left so. Makes a writer's
     * declared tables. Never deletes a dataset. Returns the bound needs.
     */
    ensurePluginDatasets(
        pluginId: string,
        datasets: ReadonlyArray<DeclaredNeed>,
        options?: { choices?: PluginBindingChoices; by?: string; staged?: boolean },
    ): PluginTokenNeed[];
    /** Records declared analytical tables' retention once their manifest is adopted (CB-387). */
    adoptPluginRetention(pluginId: string, datasets: ReadonlyArray<DeclaredNeed>): void;
    /** Throws when `ensurePluginDatasets` would refuse them; changes nothing (CB-387, CB-451). */
    checkPluginDatasets(pluginId: string, datasets: ReadonlyArray<DeclaredNeed>, choices?: PluginBindingChoices): void;
    /** Ends every live binding of a plugin (uninstall); its datasets stay the workspace's. */
    unbindPlugin(pluginId: string, by?: string): void;
    /** An admin rebinds or unbinds one need of an installed plugin. */
    bindPluginNeed(
        pluginId: string,
        datasets: ReadonlyArray<DeclaredNeed>,
        need: string,
        choice: PluginBindingChoice,
        by: string,
    ): PluginNeedPlan;
    /** Each need with its binding, the previous one, and the workspace datasets it could bind to. */
    pluginBindingPlan(pluginId: string, datasets: ReadonlyArray<DeclaredNeed>, installed: boolean): PluginBindingPlan;
    /**
     * The boot step (repeated hourly) that binds `plugin:<id>` datasets to
     * their plugins, then moves them to the workspace once no runtime of
     * the previous release runs; how many it bound and moved.
     */
    adoptPluginOwnedDatasets(): { bound: number; moved: number };
    /** The plugin's bound needs, and its declared needs left unbound. */
    pluginDatasets(pluginId: string): {
        bound: PluginTokenNeed[];
        unbound: Array<{ name: string; access: PluginDatasetAccess }>;
        bindings: Array<PluginTokenNeed & { binding: string }>;
    };
    /**
     * A short-lived data token (`purpose: 'plugin'`) for the plugin's own
     * work, no person present, over every dataset bound to it with its
     * binding's access (`names` narrows them by need), bound to the identity
     * version it was exchanged for; no token when no need is bound.
     */
    issuePluginToken(
        pluginId: string,
        identityVersion: number,
        names?: readonly string[],
        ttlMs?: number,
    ): {
        token?: string;
        expiresAt?: number;
        datasets?: PluginTokenNeed[];
        unbound: Array<{ name: string; access: PluginDatasetAccess }>;
    };
    /** Ends every data token the plugin holds, on every runtime. */
    revokePluginTokens(pluginId: string): void;
    /** Runs up to `batchMaxStatements` statements in one transaction: all or nothing. */
    batch(actor: AgentActor, ref: string | undefined, statements: DataBatchStatement[]): Promise<WriteResult>;
    /** Up to `batchMaxStatements` SELECTs read from one snapshot, one operation (CB-474). */
    readBatch(
        actor: DataActor,
        ref: string | undefined,
        statements: DataReadBatchStatement[],
        maxRows?: number,
    ): Promise<DataReadBatchResult>;
    /** A plugin's data operation budget (CB-473); admins only. */
    pluginBudget(userId: string, pluginId: string): PluginDataBudget;
    /** Sets an installed plugin's budget, or clears it (`null`) back to the default; admins only. */
    setPluginBudget(userId: string, pluginId: string, statementsPerMinute: number | null): PluginDataBudget;

    // The composition
    computerEnv(
        dotId: string,
        userId: string | undefined,
        apiUrl: string | undefined,
        runMs: number,
    ): ComputerExecEnv | undefined;
    forgetDot(dotId: string): { marked: number; grantsFrom: number };
    resealDue(): boolean;
    sealStates(): Record<SealState, number>;
    /** The one-time move of local files' sealed bytes into S3 (CB-54); one run at a time. */
    migrateToObjectStore(): Promise<LocalMigrationResult>;
    /** Seals files again under the current data key (CB-62); one run at a time. */
    resealFiles(): Promise<ResealResult>;
    sealedObject(row: { id: string; ownerUserId: string; storage: string }): Promise<Uint8Array | undefined>;

    // Ownership (CB-360)
    /** A person's datasets (private scratch areas too) and files, deleted ones too. */
    ownedData(userId: string): OwnedList;
    /**
     * Starts moving a person's data space to another person (CB-360's
     * transfer): holds both people's file locks and copies every file's
     * sealed bytes to the new owner's keys. Then `commit` inside the
     * caller's transaction, and `finish` after it commits, or `abort`
     * after it rolls back. Nothing is lost on a failure or a crash at any
     * step: until the commit the rows name the old copies; after it, the
     * new ones.
     */
    prepareTransfer(parties: TransferParties): Promise<DataTransferShape>;
}

/** A data space move in progress (`DataSpaceShape.prepareTransfer`). */
export interface DataTransferShape {
    /**
     * Links the dataset files to the new owner's directory and moves the
     * rows (datasets, files, grants), inside the caller's transaction.
     * Throws when a file changed since its bytes were copied.
     */
    commit(): TransferTally;
    /** After the commit: removes the old copies and lets the locks go; what couldn't be removed. */
    finish(): Promise<string[]>;
    /** After a rollback, or when `commit` threw: removes the new copies and lets the locks go. */
    abort(): Promise<void>;
}

export class Data extends Context.Service<Data, DataSpaceShape>()('socio/dataspace/Data') {}

/**
 * `insert_dataset_view`, a page tool the module offers with the data
 * tools: pages' `PageTools.datasetViews`, by the slice the module calls
 * (pages is above the data space in the folder order, so the port is
 * declared here and the composition provides it from `PageTools`).
 */
export interface DatasetViewToolsShape {
    readonly datasetViews: (data: DataSpaceShape, turn: DotTurn) => ToolDefinition[];
}

export class DatasetViewTools extends Context.Service<DatasetViewTools, DatasetViewToolsShape>()(
    'socio/dataspace/DatasetViewTools',
) {}

/**
 * Whether a page exists, for the routes' embedded dataset views: pages'
 * `PageStore.get`, by the slice they call (pages is above the data space
 * in the folder order, so the port is declared here and the composition
 * provides it from `PageStore`). Throws for a page that isn't there.
 */
export interface DataViewPagesShape {
    get(spaceId: string, id: string): unknown;
}

export class DataViewPages extends Context.Service<DataViewPages, DataViewPagesShape>()(
    'socio/dataspace/DataViewPages',
) {}

/**
 * The change counters the data routes' conditional answers read (CB-451:
 * `private-data:<userId>` for the Private group), as live's `Counters`
 * offers them; the composition provides it.
 */
export interface DataCountersShape {
    read(keys: readonly string[]): string;
}

export class DataCounters extends Context.Service<DataCounters, DataCountersShape>()('socio/dataspace/DataCounters') {}

/**
 * The `PlatformConfig` field the data space is built from (`DataSettings`,
 * from `dataSettingsFromEnv`). `PlatformConfig` has it with this type, so
 * the composition root can provide the tag from it. Where files' bytes go
 * (`storage`) is `storage/`'s config.
 */
export interface DataConfigShape {
    readonly data?: DataSettings;
}

export class DataConfig extends Context.Service<DataConfig, DataConfigShape>()('socio/dataspace/DataConfig') {}

/**
 * The data views the live state and the web reads serve (`GET /api/data`
 * and one dataset's detail), over the data space (moved from
 * `live/views/dataspace.ts`). `data-views.ts` implements it.
 */
export interface DataspaceViewsShape {
    /**
     * This user's datasets (their own and those shared with their Spaces),
     * their grants and usage; admins also get everyone's usage.
     * `files: false` leaves the file list out (`?files=false`).
     */
    dataView(user: User, options?: { files?: boolean }): DataSpaceState;
    /** One dataset this user may see; else null. */
    datasetView(userId: string, id: string): DatasetDetail | null;
}

export class DataspaceViews extends Context.Service<DataspaceViews, DataspaceViewsShape>()(
    'socio/dataspace/DataspaceViews',
) {}
