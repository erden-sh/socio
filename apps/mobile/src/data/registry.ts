import type { SqlConnection, SqlDriver } from './driver';
import { isWorkspaceId, registryFile } from './layout';
import { latestVersion, migrateUserDb, userVersion } from './migrate';
import { openEncrypted } from './open';
import type { Migration } from './schema';

// The app-level registry: `socio/registry.db`, beside the workspace
// directories, so Clear cache never reaches it and it is read before any
// workspace's files are opened. It holds the workspaces on the phone, the
// active one, the "wiping" mark that makes a wipe safe to kill (wipe.ts), the
// lock and lease state (`endedAt` from an Ended 401, src/sync/session.ts;
// `leaseLockedAt` and the lease's wipe, lease.ts; a same-person sign-in clears
// both), and the server's versions and the minimum-version gate (migration 2),
// and the phone's own settings (migration 5; Appearance in migration 9) with
// the build it last ran (migration 6), and each workspace's push subscription
// with the device's push settings (migration 7), and when the person last said
// Not now to the notification ask and when its system prompt showed (migration
// 8), and what each workspace's manifest said at sign-in: its id and its lease
// policy (migration 10). The root gate reads it before the first frame.
//
// It is SQLCipher with a key of its own (`socio.registry`, keys.ts), opened
// fail-closed by open.ts, with `secure_delete = ON`, so a deleted row's bytes
// are overwritten, not left in free pages, and foreign keys on. In WAL mode
// that isn't enough: the log's earlier frames still hold the row as it was,
// under the same key, until they are checkpointed and the log truncated. So
// `remove` truncates the log, and so does every open, for a kill in between
// (the app keeps the registry open, so nothing else would). Its schema
// grows by additive, versioned migrations, run as user.db's are (migrate.ts):
// all at once in one transaction, so a failure leaves the file as it was.
// Unlike user.db, a file a newer build wrote stays writable: the migrations
// only add, so the columns this build knows keep their meaning, and over the
// air a new column's meaning ships only once every build that could launch
// reads it. A failed migration is reported (RegistryError): the app
// can't use a registry its queries don't fit.

/** Where a workspace is in its life on the phone. */
export type WorkspaceState =
    /** Being added: a sign-in that hasn't committed. Launch wipes one left by a kill. */
    | 'pending'
    /** On the phone and usable. */
    | 'ready'
    /** Marked for a wipe that hasn't finished. Launch finishes it before the first frame (wipe.ts). */
    | 'wiping';

/** Why a workspace is wiped. */
export type WipeReason =
    /** The person signed out. */
    | 'sign-out'
    /** Another person signed in to the same workspace. */
    | 'other-person'
    /** A sign-in answered BANNED_USER, or a 401 said `deactivated`. */
    | 'deactivated'
    /** A 401 said `device_revoked`: "Sign out and erase" on the web. */
    | 'device-revoked'
    /** The lease ran out. */
    | 'lease'
    /** The registry names it but its directory is gone. */
    | 'files-missing'
    /** Its files are there but a database key isn't: after a restore ("files without their key"). */
    | 'keys-missing'
    /** A sign-in a kill left pending. */
    | 'unfinished';

/** One workspace on the phone, as the registry holds it. Times are milliseconds since the epoch. */
export interface WorkspaceRow {
    /** The directory id (layout.ts): hex SHA-256 of the origin, a newline and the app user id. */
    readonly id: string;
    /** The workspace's exact origin. */
    readonly origin: string;
    /** The app user id that owns the data. */
    readonly appUserId: string;
    /** A WorkspaceState, or a newer build's state this one doesn't know. */
    readonly state: string;
    /** Why it is being wiped: a WipeReason, or a newer build's; null unless `state` is 'wiping'. */
    readonly wipeReason: string | null;
    /** The workspace's name, for the switcher: `branding.name` at sign-in, then the server's settings (setSummary). */
    readonly name: string;
    /** The logo's file name in the workspace's directory, or null for the bundled mascot. */
    readonly logo: string | null;
    /** The person's name and email, for the account sheet. */
    readonly personName: string | null;
    readonly personEmail: string | null;
    readonly createdAt: number;
    /** When it was last made active. */
    readonly lastUsed: number;
    // The session, lease and lock state: lastContact, endedAt and leaseLockedAt.
    /** Reserved for the session's last known expiry; nothing writes it yet: Expired is read from the open scope's jar (src/sync/session.ts). */
    readonly sessionExpiresAt: number | null;
    /** The last 2xx or 304 from an authenticated `/api` route, server time (src/sync/contact.ts): the lease counts from it. */
    readonly lastContact: number | null;
    /** When a 401 before the expiry ended the session (Ended: locked, content hidden). */
    readonly endedAt: number | null;
    /** When the lease locked it (30 days without contact); it is wiped 30 days after. */
    readonly leaseLockedAt: number | null;
    /** Its unread count when its scope was last open, for the switcher; null until then. */
    readonly unread: number | null;
    /** Its outbox's rows when its scope was last open: "Waiting to send" in the drawer; null until then. */
    readonly waiting: number | null;
    // What the workspace's manifest (`/.well-known/socio/workspace`) said at sign-in (migration 10).
    // Optional so a row a test makes by hand needn't name them; the registry always reads all three.
    /** The workspace's own id, which never changes; null when its server had no manifest. */
    readonly serverWorkspaceId?: string | null;
    /** Days without contact before the copy locks (its policy's `leaseDays`); null: the app's 30. */
    readonly leaseDays?: number | null;
    /** Days after that lock before the copy is wiped (`wipeDays`); null: the app's 30. */
    readonly wipeDays?: number | null;
    /**
     * When this build's commit wrote the row's install id (migration 10);
     * null before, and on a row an older build added, whose `.install` key may be
     * one an older wipe left: the scope sends the header only with this set.
     */
    readonly installSetAt?: number | null;
}

/** What a workspace's manifest gave the registry (migration 10): its id and its lease policy. */
export interface WorkspaceManifestRow {
    readonly serverWorkspaceId: string | null;
    readonly leaseDays: number | null;
    readonly wipeDays: number | null;
}

/**
 * A workspace's server versions and minimum-version gate
 * (src/sync/versions.ts), as stored: out of Clear cache's reach, and read
 * before the first frame, so a closed gate's banner shows at cold start.
 */
export interface ServerVersionRow {
    /** The highest version `/api/state` reported: the build the cached rows are keyed by. */
    readonly serverVersion: string | null;
    /** A version below it that has answered since `lowerSince` (the server's clock): a rollback once that lasts. */
    readonly lowerVersion: string | null;
    readonly lowerSince: number | null;
    /** The release version the last answer reported, or null when it reported none it could read: for the banner. */
    readonly lastVersion: string | null;
    /** 'open' or 'closed' (or a newer build's value); null until two verdicts in a row first agree. */
    readonly versionGate: string | null;
    /** The last verdict while it disagrees with the gate: one more like it moves the gate. */
    readonly versionGateVote: string | null;
}

/** A workspace's lock and lease state, which a same-person sign-in clears and its rollback puts back. */
export type SessionRow = Pick<WorkspaceRow, 'lastContact' | 'endedAt' | 'leaseLockedAt'>;

/** The switcher's summary of a workspace, from its open scope. */
export interface WorkspaceSummary {
    readonly name?: string;
    readonly unread?: number;
    /** Its outbox's rows (src/sync/outbox.ts), which wait while another workspace is open. */
    readonly waiting?: number;
}

/**
 * The phone's own settings (migration 5): the same for every
 * workspace, kept out of Clear cache's reach and read before the first frame.
 */
export interface DeviceSettings {
    /** Advanced mode, for software engineers: shows technical detail, never changes what the person may do. Off by default. */
    readonly advanced: boolean;
    /** Haptic feedback. On by default. */
    readonly haptics: boolean;
    /** Light, Dark or the system's scheme (migration 9). The system's by default. */
    readonly appearance: Appearance;
}

/** The app's color scheme as the person chose it: Light, Dark, or the system's. */
export type Appearance = 'system' | 'light' | 'dark';

/** Every Appearance, in Settings' order. */
export const APPEARANCES: readonly Appearance[] = ['light', 'dark', 'system'];

/** The settings of a phone that has never changed one, and of a file before migration 5. */
export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { advanced: false, haptics: true, appearance: 'system' };

/**
 * A workspace's push subscription as the app last made it (migration 7;
 * src/push/subscription.ts): each field is written once its step has an answer,
 * in order (the relay's registration, then the server's subscription), so a
 * kill leaves the next run what to redo. The relay's secret is a key
 * (`socio.<id>.relay`, keys.ts), never here.
 */
export interface PushRow {
    /** The relay registration the relay answered for (the push's `s`), or null before it answered. */
    readonly registrationId: string | null;
    /** The server's VAPID public key the registration is bound to (`pushKey` of `/api/notifications/channels`). */
    readonly pushKey: string | null;
    /** The native token (APNs, FCM) the relay last took for it. */
    readonly nativeToken: string | null;
    /** The server's subscription id, once `POST /api/notifications/push/subscriptions` answered. */
    readonly subscriptionId: string | null;
}

/** A workspace with no push subscription. */
export const NO_PUSH: PushRow = { registrationId: null, pushKey: null, nativeToken: null, subscriptionId: null };

/** The device's push settings (migration 7), the same for every workspace. */
export interface PushDevice {
    /** "Show message text in notifications" (on until set); the extension and the service read it natively. */
    readonly showText: boolean;
    /** When every registration was last refreshed at the relay (the daily `PUT`), device clock; null before. */
    readonly refreshedAt: number | null;
    /** When the person last said Not now to the notification ask (migration 8), device clock; null before. */
    readonly askDeclinedAt: number | null;
    /**
     * When the app last showed the system's notification prompt (migration 8), device clock; null
     * before. Android answers "denied" before any prompt, so this tells a phone never asked from one denied.
     */
    readonly askPromptedAt: number | null;
}

/** What a sign-in knows when it adds a workspace. */
export interface NewWorkspace {
    readonly id: string;
    readonly origin: string;
    readonly appUserId: string;
    readonly name: string;
    readonly logo?: string | null;
    readonly personName?: string | null;
    readonly personEmail?: string | null;
    /** What its manifest said (migration 10); none when its server has no manifest. */
    readonly manifest?: WorkspaceManifestRow | null;
}

/** The registry's migrations, in order. Each after the first only adds. */
export const REGISTRY_MIGRATIONS: readonly Migration[] = [
    {
        version: 1,
        statements: [
            // One row per workspace and person. `state` and `wipeReason` are
            // checked in TypeScript, not by a CHECK, so a later state needs no
            // table rebuild. The last four columns are the session, lease and
            // lock state, which Clear cache must not reach.
            `CREATE TABLE workspaces (
                id TEXT PRIMARY KEY NOT NULL,
                origin TEXT NOT NULL,
                appUserId TEXT NOT NULL,
                state TEXT NOT NULL,
                wipeReason TEXT,
                name TEXT NOT NULL,
                logo TEXT,
                personName TEXT,
                personEmail TEXT,
                createdAt INTEGER NOT NULL,
                lastUsed INTEGER NOT NULL,
                sessionExpiresAt INTEGER,
                lastContact INTEGER,
                endedAt INTEGER,
                leaseLockedAt INTEGER,
                UNIQUE (origin, appUserId)
            ) STRICT`,
            // The active workspace: one row at most. Deleting its workspace deletes it.
            `CREATE TABLE active (
                slot INTEGER PRIMARY KEY NOT NULL CHECK (slot = 1),
                id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE
            ) STRICT`,
        ],
    },
    {
        version: 2,
        // The server's versions and the minimum-version gate: ServerVersionRow.
        statements: [
            'ALTER TABLE workspaces ADD COLUMN serverVersion TEXT',
            'ALTER TABLE workspaces ADD COLUMN lowerVersion TEXT',
            'ALTER TABLE workspaces ADD COLUMN lowerSince INTEGER',
            'ALTER TABLE workspaces ADD COLUMN lastVersion TEXT',
            'ALTER TABLE workspaces ADD COLUMN versionGate TEXT',
            'ALTER TABLE workspaces ADD COLUMN versionGateVote TEXT',
        ],
    },
    {
        version: 3,
        // The switcher's summary of a workspace that isn't open: WorkspaceRow.unread.
        statements: ['ALTER TABLE workspaces ADD COLUMN unread INTEGER'],
    },
    {
        version: 4,
        // The outbox's rows of a workspace that isn't open: WorkspaceRow.waiting.
        statements: ['ALTER TABLE workspaces ADD COLUMN waiting INTEGER'],
    },
    {
        version: 5,
        // The phone's own settings: DeviceSettings, one row. A later
        // setting is a later column with its default, so a file an older build
        // reads keeps the columns it knows.
        statements: [
            `CREATE TABLE settings (
                slot INTEGER PRIMARY KEY NOT NULL CHECK (slot = 1),
                advanced INTEGER NOT NULL DEFAULT 0,
                haptics INTEGER NOT NULL DEFAULT 1
            ) STRICT`,
            'INSERT INTO settings (slot) VALUES (1)',
        ],
    },
    {
        version: 6,
        // The build the app last ran on this phone (CFBundleVersion, versionCode), for the "Updated to
        // build N" notice (src/shell/build-info.ts). Null until a build of this version runs.
        statements: ['ALTER TABLE settings ADD COLUMN lastBuild INTEGER'],
    },
    {
        version: 7,
        // Push: each workspace's subscription (PushRow), and the device's push settings
        // (PushDevice). No badge summary: the badge is the open workspace's, set on each pull.
        statements: [
            'ALTER TABLE workspaces ADD COLUMN pushRegistrationId TEXT',
            'ALTER TABLE workspaces ADD COLUMN pushKey TEXT',
            'ALTER TABLE workspaces ADD COLUMN pushToken TEXT',
            'ALTER TABLE workspaces ADD COLUMN pushSubscriptionId TEXT',
            'ALTER TABLE settings ADD COLUMN showText INTEGER NOT NULL DEFAULT 1',
            'ALTER TABLE settings ADD COLUMN pushRefreshedAt INTEGER',
        ],
    },
    {
        version: 8,
        // The notification ask (src/push/permission-ask.ts): when the person last said Not
        // now, so the ask waits before showing again, and when the system prompt last showed. Null
        // until then.
        statements: [
            'ALTER TABLE settings ADD COLUMN askDeclinedAt INTEGER',
            'ALTER TABLE settings ADD COLUMN askPromptedAt INTEGER',
        ],
    },
    {
        version: 9,
        // Appearance: Light, Dark or System, the system's until the person picks one. A value
        // this build doesn't know reads as System.
        statements: ["ALTER TABLE settings ADD COLUMN appearance TEXT NOT NULL DEFAULT 'system'"],
    },
    {
        version: 10,
        // The workspace's manifest at sign-in: its id, so a saved origin that now answers
        // as another workspace is refused, and its lease policy's days. Null on a server with no
        // manifest, and on every row an older build adds, which then keeps the app's 30 and 30 days.
        statements: [
            'ALTER TABLE workspaces ADD COLUMN serverWorkspaceId TEXT',
            'ALTER TABLE workspaces ADD COLUMN leaseDays INTEGER',
            'ALTER TABLE workspaces ADD COLUMN wipeDays INTEGER',
            // When this build's commit wrote the row's install id: an older build's wipe leaves the key
            // behind, and its re-add makes a row with the same id but none of this.
            'ALTER TABLE workspaces ADD COLUMN installSetAt INTEGER',
        ],
    },
];

/** The migration that adds Appearance's column. */
const APPEARANCE_VERSION = 9;
/** The migration that adds the manifest's columns. */
const MANIFEST_VERSION = 10;

/** The registry couldn't be used: a pragma didn't take, or a migration failed. */
export class RegistryError extends Error {
    override readonly name = 'RegistryError';

    constructor(message: string, cause?: unknown) {
        super(`registry.db: ${message}`);
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

export interface Registry {
    /** The schema version the file is at. Above this build's when a newer build wrote it. */
    readonly version: number;
    /** Every workspace, oldest first. */
    list(): Promise<WorkspaceRow[]>;
    get(id: string): Promise<WorkspaceRow | null>;
    /** The workspaces on the phone for `origin`, one per person. */
    byOrigin(origin: string): Promise<WorkspaceRow[]>;
    /** Adds a workspace in state 'pending'. Throws when its id or its origin and person are there already. */
    add(workspace: NewWorkspace): Promise<void>;
    /** A pending workspace becomes 'ready'. */
    markReady(id: string): Promise<void>;
    /** The active workspace's id, or null. */
    active(): Promise<string | null>;
    /**
     * Makes a ready workspace active and records when; null leaves none active.
     * `signedIn` is a sign-in's commit (the same person again): in the
     * same transaction the copy unlocks (`endedAt` and `leaseLockedAt` cleared)
     * and the sign-in counts as contact, so the lease starts over.
     */
    setActive(id: string | null, options?: { readonly signedIn?: boolean }): Promise<void>;
    /**
     * Undoes setActive for a sign-in that rolled back (commit.ts), in one
     * transaction, so the switcher's order is as it was: `id` is active again
     * (null: none) without counting as a use, and each row in `lastUsed` gets
     * that time back. It writes only what differs, and skips a row that is
     * gone. Throws RegistryError when `id` isn't a ready workspace.
     */
    restoreActive(id: string | null, lastUsed?: ReadonlyMap<string, number>): Promise<void>;
    /**
     * The wipe's step 1: the workspace is marked 'wiping', with why, and stops
     * being active, in one transaction. A second mark keeps the first reason.
     * Nothing happens when there's no such row.
     */
    markWiping(id: string, reason: WipeReason): Promise<void>;
    /**
     * Deletes the row, and the active mark with it, then checkpoints and
     * truncates the write-ahead log, so no copy of the row is left in it.
     * Throws RegistryError when another connection keeps the log from going.
     */
    remove(id: string): Promise<void>;
    /** The workspace's server versions and gate, or null when there's no such row. */
    serverVersions(id: string): Promise<ServerVersionRow | null>;
    /** Stores them whole. Throws RegistryError when there's no such row. */
    setServerVersions(id: string, versions: ServerVersionRow): Promise<void>;
    /**
     * Stores the last contact (src/sync/contact.ts, server time). Throws
     * RegistryError when there's no such row.
     */
    setLastContact(id: string, at: number): Promise<void>;
    /**
     * Ended: a 401 before the stored expiry locked the copy at `at`. A
     * second call keeps the first time. Nothing happens when there's no such row.
     */
    setEnded(id: string, at: number): Promise<void>;
    /**
     * The lease locked the copy at `at` (src/data/lease.ts). A second call
     * keeps the first time. Nothing happens when there's no such row.
     */
    setLeaseLocked(id: string, at: number): Promise<void>;
    /** The session and lease state as `session` returns it, written whole: a commit's rollback puts it back. */
    restoreSession(id: string, session: SessionRow): Promise<void>;
    /** The workspace's session and lease state, or null when there's no such row. */
    session(id: string): Promise<SessionRow | null>;
    /**
     * Stores what the open scope shows of the workspace, for the switcher: its
     * name (the server's settings, after sign-in's branding), its unread and its outbox's rows.
     * A field left out stays. Nothing happens when there's no such row.
     */
    setSummary(id: string, summary: WorkspaceSummary): Promise<void>;
    /** The phone's own settings; the defaults when the row is missing. */
    settings(): Promise<DeviceSettings>;
    /** Stores the settings given; one left out stays. Resolves with all of them as stored. */
    setSettings(change: Partial<DeviceSettings>): Promise<DeviceSettings>;
    /** The build number the app last ran on this phone (migration 6), or null when none was kept. */
    lastBuild(): Promise<number | null>;
    /** Keeps the build number the app runs now. */
    setLastBuild(build: number): Promise<void>;
    /** The workspace's push subscription (migration 7), or null when there's no such row. */
    push(id: string): Promise<PushRow | null>;
    /** Stores the fields given; one left out stays. Nothing happens when there's no such row. */
    setPush(id: string, change: Partial<PushRow>): Promise<void>;
    /** The device's push settings; the defaults when the row is missing. */
    pushDevice(): Promise<PushDevice>;
    /** Stores the settings given; one left out stays. */
    setPushDevice(change: Partial<PushDevice>): Promise<void>;
    /**
     * Stores what the workspace's manifest said at a sign-in (migration 10),
     * whole. Nothing happens when there's no such row.
     */
    setManifest(id: string, manifest: WorkspaceManifestRow): Promise<void>;
    /** Records when the commit wrote the row's install id (migration 10); null clears it (a rollback). */
    setInstallSet(id: string, at: number | null): Promise<void>;
    close(): Promise<void>;
}

/** Turns `pragma` on, reading it back as 1. */
async function turnOn(db: SqlConnection, pragma: string): Promise<void> {
    await db.exec(`PRAGMA ${pragma} = ON`);
    const row = await db.get<Record<string, unknown>>(`PRAGMA ${pragma}`);
    if (Number(row?.[pragma]) !== 1) {
        throw new RegistryError(`PRAGMA ${pragma} did not turn on.`);
    }
}

/**
 * Checkpoints the write-ahead log into the file and truncates it to nothing,
 * so the frames that held a deleted row are gone (the header). Resolves
 * whether it could: false when another connection's read kept it from
 * finishing.
 */
async function truncateLog(db: SqlConnection): Promise<boolean> {
    const row = await db.get<{ busy: unknown }>('PRAGMA wal_checkpoint(TRUNCATE)');
    return row !== null && Number(row.busy) === 0;
}

const BASE_COLUMNS =
    'id, origin, appUserId, state, wipeReason, name, logo, personName, personEmail, createdAt, lastUsed, ' +
    'sessionExpiresAt, lastContact, endedAt, leaseLockedAt, unread, waiting';
const MANIFEST_COLUMNS = 'serverWorkspaceId, leaseDays, wipeDays, installSetAt';
/** A file still before migration 10 (a test's older build) has no manifest columns: they read as null. */
const NO_MANIFEST_COLUMNS = 'NULL AS serverWorkspaceId, NULL AS leaseDays, NULL AS wipeDays, NULL AS installSetAt';
const VERSION_COLUMNS = 'serverVersion, lowerVersion, lowerSince, lastVersion, versionGate, versionGateVote';

/**
 * Opens `socio/registry.db` under `root` with `key`, or makes it, and brings
 * it to the last migration. Failures of the open itself are open.ts's
 * StoreOpenError: a wrong key ('wrong-key') is reported to the caller, never
 * answered by deleting the file. `now` is for tests; `migrations` too.
 */
export async function openRegistry(
    driver: SqlDriver,
    root: string,
    key: string,
    now: () => number = Date.now,
    migrations: readonly Migration[] = REGISTRY_MIGRATIONS,
): Promise<Registry> {
    const { db } = await openEncrypted(driver, registryFile(root), key);
    let version: number;
    try {
        await turnOn(db, 'secure_delete');
        await turnOn(db, 'foreign_keys');
        version = await userVersion(db);
        if (version <= latestVersion(migrations)) {
            const state = await migrateUserDb(db, migrations);
            if (!state.writable) {
                throw new RegistryError(`migration to version ${latestVersion(migrations)} failed.`, state);
            }
            version = state.version;
        }
        // A kill between a row's deletion and its truncation left the row in the log. Busy is no reason to stop launch.
        await truncateLog(db);
    } catch (error) {
        await db.close().catch(() => {});
        throw error;
    }
    return registryOn(db, version, now);
}

/** A stored time (device clock), or null when there is none or it isn't a number. */
function readTime(value: unknown): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    const at = Number(value);
    return Number.isFinite(at) ? at : null;
}

type SettingsRow = { advanced: unknown; haptics: unknown; appearance: unknown };

/** The settings row as stored, read as DeviceSettings: anything but 0 is on; an Appearance it doesn't know is System. */
function readSettings(row: SettingsRow | null): DeviceSettings {
    return row === null
        ? DEFAULT_DEVICE_SETTINGS
        : {
              advanced: Number(row.advanced) !== 0,
              haptics: Number(row.haptics) !== 0,
              appearance: APPEARANCES.find((item) => item === row.appearance) ?? 'system',
          };
}

const PUSH_COLUMNS: Readonly<Record<keyof PushRow, string>> = {
    registrationId: 'pushRegistrationId',
    pushKey: 'pushKey',
    nativeToken: 'pushToken',
    subscriptionId: 'pushSubscriptionId',
};

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const flag = (value: boolean | undefined) => (value === undefined ? null : value ? 1 : 0);

function registryOn(db: SqlConnection, version: number, now: () => number): Registry {
    // Appearance is migration 9's: a file still before it (a test's older build) has no such column.
    const settings = async () =>
        readSettings(
            await db.get<SettingsRow>(
                version >= APPEARANCE_VERSION
                    ? 'SELECT advanced, haptics, appearance FROM settings'
                    : "SELECT advanced, haptics, 'system' AS appearance FROM settings",
            ),
        );
    const COLUMNS = `${BASE_COLUMNS}, ${version >= MANIFEST_VERSION ? MANIFEST_COLUMNS : NO_MANIFEST_COLUMNS}`;
    const get = (id: string) => db.get<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE id = ?`, [id]);
    return {
        version,
        list: () => db.all<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces ORDER BY createdAt, rowid`),
        get,
        byOrigin: (origin) =>
            db.all<WorkspaceRow>(`SELECT ${COLUMNS} FROM workspaces WHERE origin = ? ORDER BY createdAt, rowid`, [
                origin,
            ]),
        add: async (workspace) => {
            if (!isWorkspaceId(workspace.id)) {
                throw new TypeError(`A workspace id is 64 lowercase hex characters, not "${workspace.id}".`);
            }
            const at = now();
            const { manifest } = workspace;
            await db.run(
                `INSERT INTO workspaces (id, origin, appUserId, state, name, logo, personName, personEmail, createdAt, lastUsed)
                 VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
                [
                    workspace.id,
                    workspace.origin,
                    workspace.appUserId,
                    workspace.name,
                    workspace.logo ?? null,
                    workspace.personName ?? null,
                    workspace.personEmail ?? null,
                    at,
                    at,
                ],
            );
            if (manifest) {
                await writeManifest(db, workspace.id, manifest);
            }
        },
        markReady: async (id) => {
            const { changes } = await db.run(
                "UPDATE workspaces SET state = 'ready' WHERE id = ? AND state = 'pending'",
                [id],
            );
            if (changes !== 1) {
                throw new RegistryError(`no pending workspace ${id} to make ready.`);
            }
        },
        active: async () => (await db.get<{ id: string }>('SELECT id FROM active WHERE slot = 1'))?.id ?? null,
        setActive: async (id, { signedIn = false } = {}) => {
            if (id === null) {
                await db.run('DELETE FROM active');
                return;
            }
            await db.transaction(async (tx) => {
                const at = now();
                const { changes } = await tx.run(
                    signedIn
                        ? `UPDATE workspaces SET lastUsed = ?, endedAt = NULL, leaseLockedAt = NULL,
                           lastContact = max(coalesce(lastContact, 0), ?) WHERE id = ? AND state = 'ready'`
                        : "UPDATE workspaces SET lastUsed = ? WHERE id = ? AND state = 'ready'",
                    signedIn ? [at, at, id] : [at, id],
                );
                if (changes !== 1) {
                    throw new RegistryError(`no ready workspace ${id} to make active.`);
                }
                await tx.run(
                    'INSERT INTO active (slot, id) VALUES (1, ?) ON CONFLICT (slot) DO UPDATE SET id = excluded.id',
                    [id],
                );
            });
        },
        restoreActive: async (id, lastUsed = new Map()) => {
            await db.transaction(async (tx) => {
                for (const [row, at] of lastUsed) {
                    await tx.run('UPDATE workspaces SET lastUsed = ? WHERE id = ? AND lastUsed IS NOT ?', [
                        at,
                        row,
                        at,
                    ]);
                }
                const current = (await tx.get<{ id: string }>('SELECT id FROM active WHERE slot = 1'))?.id ?? null;
                if (current === id) {
                    return;
                }
                if (id === null) {
                    await tx.run('DELETE FROM active');
                    return;
                }
                if (
                    (await tx.get("SELECT 1 AS ready FROM workspaces WHERE id = ? AND state = 'ready'", [id])) === null
                ) {
                    throw new RegistryError(`no ready workspace ${id} to make active again.`);
                }
                await tx.run(
                    'INSERT INTO active (slot, id) VALUES (1, ?) ON CONFLICT (slot) DO UPDATE SET id = excluded.id',
                    [id],
                );
            });
        },
        markWiping: async (id, reason) => {
            await db.transaction(async (tx) => {
                await tx.run(
                    `UPDATE workspaces SET wipeReason = CASE WHEN state = 'wiping' THEN wipeReason ELSE ? END,
                     state = 'wiping' WHERE id = ?`,
                    [reason, id],
                );
                await tx.run('DELETE FROM active WHERE id = ?', [id]);
            });
        },
        remove: async (id) => {
            await db.run('DELETE FROM workspaces WHERE id = ?', [id]);
            if (!(await truncateLog(db))) {
                throw new RegistryError(
                    `the write-ahead log still holds workspace ${id}: another connection is reading.`,
                );
            }
        },
        serverVersions: async (id) => {
            const row = await db.get<ServerVersionRow>(`SELECT ${VERSION_COLUMNS} FROM workspaces WHERE id = ?`, [id]);
            return row === null
                ? null
                : { ...row, lowerSince: row.lowerSince === null ? null : Number(row.lowerSince) };
        },
        setServerVersions: async (id, versions) => {
            const { changes } = await db.run(
                `UPDATE workspaces SET serverVersion = ?, lowerVersion = ?, lowerSince = ?, lastVersion = ?,
                 versionGate = ?, versionGateVote = ? WHERE id = ?`,
                [
                    versions.serverVersion,
                    versions.lowerVersion,
                    versions.lowerSince,
                    versions.lastVersion,
                    versions.versionGate,
                    versions.versionGateVote,
                    id,
                ],
            );
            if (changes !== 1) {
                throw new RegistryError(`no workspace ${id} to keep server versions for.`);
            }
        },
        setLastContact: async (id, at) => {
            const { changes } = await db.run('UPDATE workspaces SET lastContact = ? WHERE id = ?', [at, id]);
            if (changes !== 1) {
                throw new RegistryError(`no workspace ${id} to keep the last contact for.`);
            }
        },
        setEnded: async (id, at) => {
            await db.run('UPDATE workspaces SET endedAt = coalesce(endedAt, ?) WHERE id = ?', [at, id]);
        },
        setLeaseLocked: async (id, at) => {
            await db.run('UPDATE workspaces SET leaseLockedAt = coalesce(leaseLockedAt, ?) WHERE id = ?', [at, id]);
        },
        restoreSession: async (id, session) => {
            await db.run('UPDATE workspaces SET lastContact = ?, endedAt = ?, leaseLockedAt = ? WHERE id = ?', [
                session.lastContact,
                session.endedAt,
                session.leaseLockedAt,
                id,
            ]);
        },
        session: async (id) =>
            db.get<SessionRow>('SELECT lastContact, endedAt, leaseLockedAt FROM workspaces WHERE id = ?', [id]),
        setSummary: async (id, { name = null, unread = null, waiting = null }) => {
            await db.run(
                'UPDATE workspaces SET name = coalesce(?, name), unread = coalesce(?, unread), waiting = coalesce(?, waiting) WHERE id = ?',
                [name, unread, waiting, id],
            );
        },
        settings,
        setSettings: async ({ advanced, haptics, appearance }) => {
            if (appearance !== undefined && !APPEARANCES.includes(appearance)) {
                throw new TypeError(`Not an appearance: ${String(appearance)}`);
            }
            await db.run(
                `INSERT INTO settings (slot, advanced, haptics) VALUES (1, coalesce(?, 0), coalesce(?, 1))
                 ON CONFLICT (slot) DO UPDATE SET advanced = coalesce(?, advanced), haptics = coalesce(?, haptics)`,
                [flag(advanced), flag(haptics), flag(advanced), flag(haptics)],
            );
            if (appearance !== undefined) {
                await db.run('UPDATE settings SET appearance = ?', [appearance]);
            }
            return settings();
        },
        lastBuild: async () => {
            const row = await db.get<{ lastBuild: unknown }>('SELECT lastBuild FROM settings');
            const build = row?.lastBuild === null || row?.lastBuild === undefined ? Number.NaN : Number(row.lastBuild);
            return Number.isSafeInteger(build) && build > 0 ? build : null;
        },
        setLastBuild: async (build) => {
            if (!Number.isSafeInteger(build) || build <= 0) {
                throw new TypeError(`A build number is a positive whole number, not ${build}.`);
            }
            await db.run(
                `INSERT INTO settings (slot, lastBuild) VALUES (1, ?)
                 ON CONFLICT (slot) DO UPDATE SET lastBuild = excluded.lastBuild`,
                [build],
            );
        },
        push: async (id) => {
            const row = await db.get<Record<string, unknown>>(
                'SELECT pushRegistrationId, pushKey, pushToken, pushSubscriptionId FROM workspaces WHERE id = ?',
                [id],
            );
            return row === null
                ? null
                : {
                      registrationId: text(row.pushRegistrationId),
                      pushKey: text(row.pushKey),
                      nativeToken: text(row.pushToken),
                      subscriptionId: text(row.pushSubscriptionId),
                  };
        },
        setPush: async (id, change) => {
            const fields = (Object.keys(PUSH_COLUMNS) as (keyof PushRow)[]).filter((key) => key in change);
            if (fields.length === 0) {
                return;
            }
            await db.run(
                `UPDATE workspaces SET ${fields.map((key) => `${PUSH_COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`,
                [...fields.map((key) => change[key] ?? null), id],
            );
        },
        pushDevice: async () => {
            const row = await db.get<{
                showText: unknown;
                pushRefreshedAt: unknown;
                askDeclinedAt: unknown;
                askPromptedAt: unknown;
            }>('SELECT showText, pushRefreshedAt, askDeclinedAt, askPromptedAt FROM settings');
            return {
                showText: row === null ? true : Number(row.showText) !== 0,
                refreshedAt: readTime(row?.pushRefreshedAt),
                askDeclinedAt: readTime(row?.askDeclinedAt),
                askPromptedAt: readTime(row?.askPromptedAt),
            };
        },
        setPushDevice: async (change) => {
            await db.run('INSERT INTO settings (slot) VALUES (1) ON CONFLICT (slot) DO NOTHING');
            if (change.showText !== undefined) {
                await db.run('UPDATE settings SET showText = ?', [change.showText ? 1 : 0]);
            }
            if (change.refreshedAt !== undefined) {
                await db.run('UPDATE settings SET pushRefreshedAt = ?', [change.refreshedAt]);
            }
            if (change.askDeclinedAt !== undefined) {
                await db.run('UPDATE settings SET askDeclinedAt = ?', [change.askDeclinedAt]);
            }
            if (change.askPromptedAt !== undefined) {
                await db.run('UPDATE settings SET askPromptedAt = ?', [change.askPromptedAt]);
            }
        },
        setManifest: (id, manifest) => writeManifest(db, id, manifest),
        setInstallSet: async (id, at) => {
            await db.run('UPDATE workspaces SET installSetAt = ? WHERE id = ?', [at, id]);
        },
        close: () => db.close(),
    };
}

/** Writes a row's manifest columns whole (migration 10). */
async function writeManifest(db: SqlConnection, id: string, manifest: WorkspaceManifestRow): Promise<void> {
    await db.run('UPDATE workspaces SET serverWorkspaceId = ?, leaseDays = ?, wipeDays = ? WHERE id = ?', [
        manifest.serverWorkspaceId,
        manifest.leaseDays,
        manifest.wipeDays,
        id,
    ]);
}
