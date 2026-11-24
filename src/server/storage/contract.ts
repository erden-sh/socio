/**
 * What other features may know of file storage (CB-54): its tags, the
 * slices of the object stores and file moves other features call, and
 * plain types. It imports only `effect`, `@socio/*` and, type-only,
 * `node:*`, and holds no logic.
 *
 * Moved here; the re-exports at their old paths are gone:
 * - `S3StoreOptions` (`s3-store.ts`).
 * - `LocalMigration` and `LocalMigrationResult` (`migrate-local.ts`),
 *   `ResealRun` and `ResealResult` (`reseal.ts`). Their `files` is typed by
 *   the one method each run calls instead of a `Pick` of the data space's
 *   `FileRepository`, so this contract imports no other feature's and the
 *   data space's contract can import it (`DataSpaceShape`'s
 *   `migrateToObjectStore` and `resealFiles`).
 *
 * Moved into a package (importers name it directly):
 * - `objectKey`, `userDirName` and `tenantPrefix`:
 *   `@socio/data/storage/keys` (`keys.ts`).
 * - `S3Settings`, `StorageSettings`, `parseS3Credentials`,
 *   `s3SettingsFromEnv` and `storageSettingsFromEnv`:
 *   `@socio/data/storage/settings` (`settings.ts`, `s3-store.ts`). The
 *   two settings types are re-exported here too.
 *
 * Not here, on purpose:
 * - `LocalObjectStore` and `S3ObjectStore`: the composition builds them;
 *   other features get the `ObjectStores` tag below.
 * - `migrateLocalFiles` and `resealFiles`: behind the `FileMoves` tag.
 * - `sigv4.ts`: only `s3-store.ts` and its tests use it.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context } from 'effect';

import type { ObjectStore, StorageDriver } from '@socio/data/object-store';
import type { S3Settings, StorageSettings } from '@socio/data/storage/settings';
import type { SecretBox } from '@socio/foundation/keys/secret-box';

export type { S3Settings, StorageSettings } from '@socio/data/storage/settings';

// ── Object stores ────────────────────────────────────────────────────────

export interface S3StoreOptions {
    /** Per request; 30 s. */
    timeoutMs?: number;
    /** Extra attempts after a network error or a 5xx; 2. */
    retries?: number;
    /** The first retry's wait, doubled for the next; 250 ms. */
    backoffMs?: number;
    fetch?: typeof fetch;
}

/** Objects as files under `root` (USER_DATA_DIR): `LocalObjectStore`. */
export interface LocalObjectStoreShape extends ObjectStore {
    readonly driver: 'local';
    readonly root: string;
}

/** Objects in a bucket of an S3-compatible store: `S3ObjectStore`. */
export interface S3ObjectStoreShape extends ObjectStore {
    readonly driver: 's3';
}

/**
 * The object stores other features open: the data space's legacy local
 * store and the backup's off-site copy. Each call is `new LocalObjectStore`
 * or `new S3ObjectStore` with the same arguments.
 */
export interface ObjectStoresShape {
    local(root: string): LocalObjectStoreShape;
    s3(settings: S3Settings, options?: S3StoreOptions): S3ObjectStoreShape;
}

export class ObjectStores extends Context.Service<ObjectStores, ObjectStoresShape>()('socio/storage/ObjectStores') {}

// ── File moves ───────────────────────────────────────────────────────────

export interface LocalMigration {
    db: DatabaseSync;
    /** The data space's files: where a moved file's row is marked (CB-110). */
    files: { markMoved(id: string, to: StorageDriver): Promise<void> };
    /** The local disk, where rows marked `local` have their bytes. */
    from: ObjectStore;
    /** The S3 store new files go to. */
    to: ObjectStore;
    key: (driver: StorageDriver, userId: string, fileId: string) => string;
    /** The data space's per-user lock: no write races a file's move. */
    exclusive: <T>(userId: string, work: () => Promise<T>) => Promise<T>;
    /** True once the data space closes: the run stops between files. */
    stopped?: () => boolean;
    /** Also remove local copies of rows already moved (a crash after the update). */
    sweep?: boolean;
    batch?: number;
}

/** Counts only: logs never name users' files. */
export interface LocalMigrationResult {
    moved: number;
    /** Rows whose local file is gone: left as they are. */
    missing: number;
    /** Uploads whose size didn't check out: retried next time. */
    mismatched: number;
    /** Local copies of moved files removed by the sweep. */
    cleaned: number;
    /** A store failed (S3 unreachable, most likely): the run stopped early. */
    unavailable: boolean;
}

export interface ResealRun {
    db: DatabaseSync;
    /** The data space's files: where a file's new seal is recorded (CB-110). */
    files: { recordSeal(id: string, sealKey: string, storedSize: number): Promise<void> };
    /** The data space's box: its current key is where files go. */
    box: SecretBox;
    /** The store a row names; throws when it isn't configured here. */
    store: (driver: StorageDriver) => ObjectStore;
    key: (driver: StorageDriver, userId: string, fileId: string) => string;
    /** The data space's per-user lock: no write races a file's re-seal. */
    exclusive: <T>(userId: string, work: () => Promise<T>) => Promise<T>;
    /** True once the data space closes: the run stops between files. */
    stopped?: () => boolean;
    batch?: number;
}

/** Counts only: logs never name users' files. */
export interface ResealResult {
    resealed: number;
    /** Already under the current key (a run cut off after the write): the row is fixed. */
    fixed: number;
    /** Rows whose object is gone: left as they are. */
    missing: number;
    /** Sealed under a key this server doesn't have: left as they are. */
    unreadable: number;
    /** Writes whose size didn't check out: retried next time. */
    mismatched: number;
    /** In a store not configured here (S3 rows without S3_ENDPOINT): left. */
    skipped: number;
    /** A store failed (S3 unreachable, most likely): the run stopped early. */
    unavailable: boolean;
}

/**
 * The data space's runs over its files' bytes: the one-time move of local
 * files into S3 (CB-54) and the re-seal under the current data key
 * (CB-62). `migrateLocalFiles` and `resealFiles` as they are.
 */
export interface FileMovesShape {
    migrateLocalFiles(options: LocalMigration): Promise<LocalMigrationResult>;
    resealFiles(run: ResealRun): Promise<ResealResult>;
}

export class FileMoves extends Context.Service<FileMoves, FileMovesShape>()('socio/storage/FileMoves') {}

// ── StorageConfig ────────────────────────────────────────────────────────

/**
 * What storage is given of the platform's configuration: `config.storage`
 * (`STORAGE_DRIVER`, `TENANT_ID`, `S3_*`), unset when the entry didn't
 * read it (tests), which means the local disk.
 */
export interface StorageConfigShape {
    readonly settings?: StorageSettings;
}

export class StorageConfig extends Context.Service<StorageConfig, StorageConfigShape>()(
    'socio/storage/StorageConfig',
) {}
