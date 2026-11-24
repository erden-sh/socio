import type { AppManifest } from './app-manifest.js';
import type { RuntimeExitReason } from './apps-runtime-types.js';

/**
 * Mini apps: a Bun server a Dot runs in its computer and
 * registers, served by the platform on its own origin behind platform
 * sign-in. Ephemeral: an app lives as long as the computer runs it.
 * Promotion packages it into versioned bundles and runs it in the
 * workspace app runtime instead, at the same address.
 */

/**
 * `ephemeral`: registered, served from the Dot's computer. `packaged`: the
 * same, with at least one bundle. `promoted`: served from the workspace
 * app runtime. `unpublished`: promoted once, stopped; its data stays.
 */
export const APP_STATUSES = ['ephemeral', 'packaged', 'promoted', 'unpublished'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

/** Approval capabilities of promotion, next to `app.register`. */
export const APP_APPROVALS = {
    promote: 'app.promote',
    update: 'app.update',
} as const;

/** What happens to one dataset when an app is promoted. */
export type DatasetChoice = 'move' | 'share' | 'keep';

/** Whether the Dot's computer runs, as the proxy sees it. */
export type AppComputerState = 'running' | 'stopped' | 'disabled' | 'not_configured' | 'unreachable' | 'unavailable';

export interface AppView {
    /** The host label, `<slug>--<dot slug>`; also the app's id. */
    id: string;
    name: string;
    description: string;
    dotId: string;
    dotName: string;
    /** Whether the signed-in user owns it (owners share and unregister). */
    owner: boolean;
    /** The owner's name, for apps shared with the viewer. */
    ownerName?: string;
    port: number;
    /** Dataset ids the app's data token may use (`scratch` included). */
    datasets: string[];
    datasetNames: string[];
    sharedSpaceId: string | null;
    sharedSpaceName?: string | null;
    /** The command the platform runs to start it, if the Dot gave one. */
    startCommand: string | null;
    status: AppStatus;
    /** The app's own origin. */
    url: string;
    createdAt: number;
    updatedAt: number;
    computer?: AppComputerState;
    /** Whether its port answered just now (null: the computer isn't running). */
    answering?: boolean | null;
    /** Packaged versions, newest first (owners only). */
    versions?: AppVersionView[];
    /** The version the runtime serves, and the one a rollback returns to. */
    liveVersion?: number | null;
    previousVersion?: number | null;
    /** The runtime's state for a promoted app. */
    runtime?: AppRuntimeState;
    /** Whether the viewer may read its logs: its owner and workspace admins (CB-175). */
    canReadLogs?: boolean;
    /** A promoted app's newest build or start attempt (who may read its logs, CB-146, CB-175). */
    lastAttempt?: AppAttemptSummary | null;
    promotedAt?: number | null;
    /**
     * Required Socio Secrets it lacks (names only), for its owner and admins:
     * a workspace admin sets them in Settings → Secrets.
     */
    needsSetup?: string[];
    /** Self-healing (CB-291), for its owner and admins: its state and last recovery. */
    health?: AppHealth;
}

/**
 * How an app's self-healing sees it (CB-291). `healthy`: nothing to do.
 * `recovering`: the platform renewed its data token or replaced its
 * process and is waiting to see it hold. `degraded`: a repair failed; it
 * tries again after `nextAttemptAt`. `failed`: automatic repair gave up
 * after `maxAttempts`; admins were told, and its owner's Start (or a new
 * version) tries again. Its data is kept throughout.
 */
export const APP_HEALTH_STATES = ['healthy', 'recovering', 'degraded', 'failed'] as const;
export type AppHealthState = (typeof APP_HEALTH_STATES)[number];

export interface AppHealth {
    state: AppHealthState;
    /** Why it is in this state (one line); null when healthy. */
    reason: string | null;
    /** Repairs tried since it was last healthy. */
    attempts: number;
    maxAttempts: number;
    /** When the next repair may run (degraded), else null. */
    nextAttemptAt: number | null;
    /** The last repair that held, and what it did. */
    lastRecoveryAt: number | null;
    lastRecoveryReason: string | null;
    /** The last repair's error, while it isn't healthy. */
    lastError: string | null;
    /** When admins were told that automatic repair gave up. */
    escalatedAt: number | null;
    updatedAt: number | null;
}

/** An app that isn't healthy, as Operations → Health lists it (CB-291). */
export interface AppHealthEntry extends AppHealth {
    appId: string;
    name: string;
    /** `ephemeral` and `packaged` run in their socio's computer; `promoted` in the runtime. */
    status: AppStatus;
}

/** Self-healing as Operations → Health shows it (CB-291). */
export interface AppsHealthSummary {
    /** Apps it watches: running in a computer with a start command, or promoted. */
    watched: number;
    /** The ones not healthy, worst first. */
    unhealthy: AppHealthEntry[];
    /** Apps that recovered by themselves in the last day. */
    recoveredLastDay: number;
    /** The once-a-minute check of promoted apps (CB-291: its failures show). */
    check: { lastRunAt: number | null; lastOkAt: number | null; lastError: string | null; failingSince: number | null };
}

/**
 * How a build or start attempt ended (CB-146): the runtime's reasons, or
 * `lost` when the runtime restarted before it said.
 */
export type AppAttemptReason = RuntimeExitReason | 'lost';

/** One build or start attempt of a promoted app's version (CB-146). */
export interface AppAttemptSummary {
    /** Counts per app: 1, 2, … */
    attempt: number;
    version: number;
    kind: 'build' | 'start';
    state: 'running' | 'succeeded' | 'failed' | 'stopped';
    reason: AppAttemptReason | null;
    exitCode: number | null;
    signal: string | null;
    /** How it ended, in a line. */
    message: string | null;
    startedAt: number;
    /** A start: when it answered on its socket. */
    upAt: number | null;
    endedAt: number | null;
}
/** An attempt with its last lines, redacted. */
export interface AppAttemptView extends AppAttemptSummary {
    lines: string[];
    /** Earlier lines not kept. */
    dropped: number;
}
/** `GET /api/apps/:id/attempts?version=&attempt=`: diagnostics for the owner and admins. */
export interface AppAttemptsState {
    /** Newest first. */
    attempts: AppAttemptSummary[];
    /** The attempt asked for (the newest by default), or null with `note`. */
    attempt: AppAttemptView | null;
    note?: string;
    /** A runtime from before attempts: its one log, every version mixed. */
    runtimeLog?: string[];
}

/** One packaged version of an app. */
export interface AppVersionView {
    version: number;
    manifest: AppManifest;
    files: number;
    sizeBytes: number;
    sha256: string;
    createdAt: number;
    createdByDotName: string | null;
    /** Lines describing what changed since the version before it. */
    changes: string[];
}

/** A promoted app's process in the runtime, as the runtime reports it. */
export type AppRuntimeState =
    | 'running'
    | 'starting'
    | 'stopped'
    | 'failed'
    | 'not_deployed'
    | 'unavailable'
    | 'not_configured';

/** One dataset as the promotion wizard shows it. */
export interface PromotionDataset {
    /** The manifest's id (`scratch` or a dataset id). */
    ref: string;
    access: 'read' | 'write';
    tables?: string[];
    /** The dataset it names now, if it still exists. */
    datasetId: string | null;
    name: string;
    /** `workspace`: a workspace dataset in a company socio's area (CB-354), kept where it is. */
    kind: 'scratch' | 'dataset' | 'workspace' | 'missing';
    sizeBytes: number;
    tableNames: string[];
    sharedSpaceId: string | null;
    /**
     * A company socio's scratch: its shared dataset (CB-354), which everyone
     * who uses the socio sees. A move or share takes the tables out of it
     * into a new workspace dataset, no person's, which the socio may write
     * to once a person approves its request.
     */
    sharedArea?: boolean;
    /** What the user may choose for it (move only from a scratch dataset). */
    choices: DatasetChoice[];
}

/** `GET /api/apps/:id/promotion`: what the wizard needs. */
export interface PromotionPlan {
    appId: string;
    name: string;
    dotName: string;
    version: AppVersionView;
    /** Files in the bundle (path and size), for review. */
    files: Array<{ path: string; size: number }>;
    datasets: PromotionDataset[];
    /** The runtime is configured (APPS_RUNTIME_URL). */
    runtime: boolean;
    /** Whether the app is promoted already (then this is an update). */
    promoted: boolean;
}

/** The user's choice for one dataset. */
export interface PromotionChoice {
    ref: string;
    choice: DatasetChoice;
    /** `share`: the Space it is shared with. */
    spaceId?: string;
    /** `move`: the new dataset's name. */
    name?: string;
    /** `move`: whether the Dot keeps read access to the moved data. */
    dotReads?: boolean;
}

/** A promoted app in the launcher and sidebar (from `/api/workspace`). */
export interface WorkspaceAppEntry {
    id: string;
    name: string;
    description: string;
    url: string;
    dotName: string;
    sharedSpaceName: string | null;
    owner: boolean;
}

/**
 * One app on a socio's home page (CB-260), from the registry alone: no
 * computer or runtime state, so listing never probes, wakes or starts it.
 */
export interface DotAppEntry {
    id: string;
    name: string;
    description: string;
    /** `promoted` is published; `ephemeral` and `packaged` are in development. */
    status: AppStatus;
    /** Whether the signed-in user owns it. */
    owner: boolean;
    /** The owner's name, for apps shared with the viewer. */
    ownerName?: string;
    sharedSpaceName: string | null;
    /** The version a published app serves. */
    liveVersion: number | null;
    updatedAt: number;
}

/** `GET /api/apps/dots/:dotId`: a socio's apps the signed-in user may open. */
export interface DotAppsState {
    /** Mini apps are configured (APPS_HOST, APP_ORIGIN). */
    enabled: boolean;
    /** Newest change first. */
    apps: DotAppEntry[];
}

export interface AppsState {
    /** Mini apps are configured (APPS_HOST, APP_ORIGIN). */
    enabled: boolean;
    /** `apps.brain.example`, for the setup hint. */
    host?: string;
    apps: AppView[];
    /**
     * Admins only (CB-442): the live apps the admin can't open,
     * by name and owner and nothing more. Opening one stays with its owner
     * and the people of the Space it is shared with.
     */
    others?: AppDirectoryEntry[];
}

/** An app an admin can't open, as admin lists show it: name and owner only. */
export interface AppDirectoryEntry {
    id: string;
    name: string;
    ownerName: string;
}

/** Ports a mini app may listen on. */
export const APP_PORT_RANGE = { min: 3000, max: 3999 } as const;
