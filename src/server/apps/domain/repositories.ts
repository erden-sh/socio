import type { BundleEntry } from '@socio/foundation/apps/bundle';
import type { AppLogRetention } from '@socio/shared/apps/app-log-retention';
import type { AppManifest } from '@socio/shared/apps/app-manifest';
import type { AppAttemptSummary, AppAttemptView, AppStatus } from '@socio/shared/apps/app-types';
import type { RuntimeAttempt } from '@socio/shared/apps/apps-runtime-types';

/**
 * Mini apps' repositories (CB-110): one per aggregate, async,
 * taking and returning plain domain types. Only `apps/infra` implements
 * them. Every write works inside or outside a unit of work: outside one it
 * opens its own. The registry's synchronous reads (`AppsService.get`,
 * `all`, versions and grants for views) stay raw SQL on the same
 * connection until their callers can wait.
 */

/** A registration: a new app, or new details for one at its id. */
export interface AppRegistration {
    id: string;
    slug: string;
    name: string;
    description: string;
    dotId: string;
    ownerUserId: string;
    port: number;
    datasets: string[];
    startCommand: string | null;
    createdAt: number;
    updatedAt: number;
}

/** The soft-delete stamp of a deleted app (CB-64). */
export interface AppDeletion {
    at: number;
    by: string;
    /** What it was deleted with (`dot:<id>`), or null when on its own. */
    with: string | null;
}

/** The registered apps (`apps`). Writes name an app by id, deleted or not. */
export interface AppRepository {
    /**
     * Another live app of the Dot on `port` that its computer serves
     * (ephemeral or packaged), by id; `exceptId` is not counted.
     */
    portHolder(dotId: string, port: number, exceptId: string): Promise<string | undefined>;
    /**
     * Adds the app, ephemeral and private; an app already at the id gets the
     * new name, description, port, datasets and start command, and keeps
     * the rest (its creation, status, sharing and versions).
     */
    register(app: AppRegistration): Promise<void>;
    setStatus(id: string, status: AppStatus, now: number): Promise<void>;
    /** Shares it with a Space, or with none. */
    share(id: string, spaceId: string | null, now: number): Promise<void>;
    /** Promoted: `version` is live, none before it, with the owner's settings. */
    promote(id: string, promotion: { version: number; config: Record<string, string> }, now: number): Promise<void>;
    /** The live version and the one kept for a rollback. */
    setVersions(id: string, live: number, previous: number | null, now: number): Promise<void>;
    /**
     * Hides a live app and keeps it under `as` (CB-64), its old id as its
     * deleted label, so a new app can take the address. Nothing when it is
     * deleted already.
     */
    retire(id: string, as: string, stamp: AppDeletion): Promise<void>;
}

/** A session on an app's own origin, by its cookie value's hash. */
export interface AppOriginSession {
    hash: string;
    appId: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
}

export interface AppSessionRepository {
    /** Expired or not; the caller checks. */
    byHash(hash: string): Promise<AppOriginSession | undefined>;
    /** An app's sessions that are live at `now`. */
    countLive(appId: string, now: number): Promise<number>;
    /** Keeps a new session, and forgets every one expired at `now`. */
    add(session: AppOriginSession, now: number): Promise<void>;
    remove(hash: string): Promise<void>;
    /** Everyone's on the app. */
    removeForApp(appId: string): Promise<void>;
    /** Everyone's on the app but `userId`'s (it stopped being shared). */
    removeForAppExcept(appId: string, userId: string): Promise<void>;
    /** A person's on every app; the apps they had sessions on, and how many ended. */
    removeOf(userId: string): Promise<{ apps: string[]; ended: number }>;
    /** How many sessions a person has on every app, expired ones not yet forgotten included. */
    countOf(userId: string): Promise<number>;
}

/** One packaged version of an app; its bundle is a file in the owner's data space. */
export interface AppVersion {
    appId: string;
    version: number;
    manifest: AppManifest;
    bundlePath: string;
    sha256: string;
    sizeBytes: number;
    files: number;
    fileList: BundleEntry[];
    createdByDotId: string | null;
    createdAt: number;
}

export interface AppVersionRepository {
    /** Oldest first. */
    forApp(appId: string): Promise<AppVersion[]>;
    add(version: AppVersion): Promise<void>;
    /**
     * A deleted app's versions go to the id it is kept under (CB-64), each
     * with its bundle's path there; versions not listed stay.
     */
    rekey(from: string, to: string, bundles: Array<{ version: number; bundlePath: string }>): Promise<void>;
}

/** A dataset a promoted app's token may use. */
export interface AppGrant {
    appId: string;
    datasetId: string;
    /** How the manifest names it. */
    ref: string;
    access: 'read' | 'write';
    /** The promotion made the dataset (moved data): deleted with the app if asked. */
    createdByPromotion: boolean;
    createdAt: number;
}

export interface AppGrantRepository {
    /** By when they were made, then by ref. */
    forApp(appId: string): Promise<AppGrant[]>;
    /**
     * The app's grants become these, made `now`; a later one for the same
     * dataset wins.
     */
    replace(appId: string, grants: Array<Omit<AppGrant, 'appId' | 'createdAt'>>, now: number): Promise<void>;
    /** A deleted app's grants go to the id it is kept under. */
    rekey(from: string, to: string): Promise<void>;
}

/**
 * The build and start attempts of promoted apps (CB-146). The runtime
 * keeps attempts in memory only; the app copies what it reports here so
 * they outlive a runtime restart, bounded: each log to its last
 * `ATTEMPT_LOG_LINES` lines and `ATTEMPT_LOG_BYTES` bytes, and by the
 * retention setting (CB-175: an attempt stays for `days` or while it is
 * one of the app's last `attempts`, whichever keeps more) applied by
 * `prune`, with `ATTEMPTS_PER_APP` as the most (`domain/attempts.ts`).
 * Logs come in redacted.
 */
export interface AppAttemptRepository {
    /**
     * Records what the runtime reports (oldest first) in its run `boot`:
     * new attempts get the app's next numbers, known ones are brought up to
     * date, and running ones it no longer lists are `lost` (it restarted, or
     * it dropped them as old). Then the oldest past the ceiling go.
     */
    sync(appId: string, boot: string, reported: RuntimeAttempt[], now?: number): Promise<void>;
    /**
     * Drops every app's attempts that are older than `retention.days` and
     * not among its newest `retention.attempts`. An attempt that is still
     * running is never dropped. Returns how many went.
     */
    prune(retention: AppLogRetention, now?: number): Promise<number>;
    /** The attempt numbered so, else the newest of the version, else the newest. */
    find(appId: string, query?: { version?: number; attempt?: number }): Promise<AppAttemptView | undefined>;
    /** Newest first. */
    list(appId: string, limit?: number): Promise<AppAttemptSummary[]>;
    /** Retained OOM attempts in the period, attributed without reading app logs. */
    oomsByDot(from: number, to: number): Promise<Array<{ dotId: string; count: number; lastAt: number }>>;
    /** A deleted app's attempts go with it to the id it is kept under. */
    rekey(from: string, to: string): Promise<void>;
}

export interface AppRepositories {
    apps: AppRepository;
    sessions: AppSessionRepository;
    versions: AppVersionRepository;
    grants: AppGrantRepository;
    attempts: AppAttemptRepository;
}
