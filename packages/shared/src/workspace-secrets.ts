/**
 * Socio Secrets: secrets workspace
 * apps read at runtime with their data token (phase 1), and service
 * plugins with their own identity token (phase 2). People write them and
 * never read them back: nothing here carries a value.
 */

/** A secret's name: it maps directly to an environment variable. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const SECRET_NAME_HINT = 'UPPER_CASE letters, digits and _, starting with a letter (at most 64)';

/**
 * Where a secret lives. Phase 1 has two: `workspace`, managed
 * by workspace admins and readable only by the apps it's granted to; and
 * `workload`, owned by one app and implicitly granted to it. No Space scope yet.
 */
export const SECRET_SCOPES = ['workspace', 'workload'] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

/** A version's state: one `current`; `previous` until `retireAt`; `retired` is never served. */
export type SecretVersionState = 'current' | 'previous' | 'retired';

/** The most a value may hold, in UTF-8 bytes. */
export const SECRET_VALUE_MAX_BYTES = 16 * 1024;
/** How long a replaced version stays readable by default, and at most. */
export const SECRET_OVERLAP_DEFAULT_MINUTES = 60;
export const SECRET_OVERLAP_MAX_MINUTES = 7 * 24 * 60;
/** How long a workload may cache a value it read (`expiresAt`). */
export const SECRET_CACHE_MS = 5 * 60_000;
/** Secrets a workload may read per minute (each name counts). */
export const SECRET_READS_PER_MINUTE = 120;
/** Names one `?names=` read may ask for. */
export const SECRET_NAMES_PER_READ = 20;
/** Secrets a workspace may hold (live ones). */
export const SECRET_LIMIT = 500;

/**
 * A workload as the admin API names it: a workspace app by its id, a
 * plugin as `plugin:<id>` (app ids never hold a `:`). Audit lines name a
 * plugin reader the same way, and an app reader `app:<id>`.
 */
export type WorkloadKind = 'app' | 'plugin';
export const PLUGIN_WORKLOAD_PREFIX = 'plugin:';
export const pluginWorkloadKey = (pluginId: string) => `${PLUGIN_WORKLOAD_PREFIX}${pluginId}`;
export const workloadKey = (kind: WorkloadKind, id: string) => (kind === 'plugin' ? pluginWorkloadKey(id) : id);
export function parseWorkloadKey(key: string): { kind: WorkloadKind; id: string } {
    return key.startsWith(PLUGIN_WORKLOAD_PREFIX)
        ? { kind: 'plugin', id: key.slice(PLUGIN_WORKLOAD_PREFIX.length) }
        : { kind: 'app', id: key };
}

/** A manifest's `secrets` entry, for apps and plugins alike. */
export interface AppManifestSecret {
    name: string;
    /** Missing required secrets mark the app as needing setup. */
    required: boolean;
    description?: string;
}

export interface SecretVersionView {
    version: number;
    state: SecretVersionState;
    setAt: number;
    setBy: string;
    setByName: string;
    /** `previous`: readable until then. */
    retireAt: number | null;
    lastReadAt: number | null;
}

export interface SecretGrantView {
    /** The workload's key: an app id, or `plugin:<id>`. */
    appId: string;
    kind: WorkloadKind;
    appName: string;
    grantedAt: number;
    grantedByName: string;
}

/** One secret as admins see it: never its value. */
export interface WorkspaceSecretView {
    id: string;
    name: string;
    scope: SecretScope;
    /** `workload`: the app (its id) or plugin (`plugin:<id>`) that owns it. */
    appId: string | null;
    appName: string | null;
    description: string;
    createdAt: number;
    createdByName: string;
    updatedAt: number;
    /** Newest first. */
    versions: SecretVersionView[];
    /** `workspace` only; a workload secret's own app is implicit. */
    grants: SecretGrantView[];
    lastReadAt: number | null;
    lastReadByName: string | null;
}

/** A workspace app's or an installed service plugin's declared secrets and how each is met. */
export interface AppSecretNeeds {
    /** The workload's key: an app id, or `plugin:<id>`. */
    appId: string;
    kind: WorkloadKind;
    name: string;
    status: string;
    declared: Array<{
        name: string;
        required: boolean;
        description: string;
        /** The secret that serves it: its own (workload), a granted workspace one, or none. */
        servedBy: { id: string; scope: SecretScope } | null;
    }>;
    /** Required names nothing serves: the app needs setup. */
    needsSetup: string[];
}

/** `GET /api/workspace-secrets`. */
export interface WorkspaceSecretsState {
    secrets: WorkspaceSecretView[];
    apps: AppSecretNeeds[];
    overlapDefaultMinutes: number;
    /** Open read flags (phase 4), newest first. */
    flags: SecretReadFlagView[];
}

/** `GET /api/workload/secrets/:name`: the one place a value travels. */
export interface WorkloadSecret {
    value: string;
    version: number;
    /** Cache it until then (ms); read it again after. */
    expiresAt: number;
}

// ---- Phase 4: a secret's history and read flags ---------------------------

/** Events a history page holds at most (`?limit=`), and by default. */
export const SECRET_HISTORY_PAGE_MAX = 100;
export const SECRET_HISTORY_PAGE_DEFAULT = 50;

/**
 * Read-anomaly rules. Conservative on purpose: each names the numbers it
 * fired on, and none ever holds a value.
 *
 * - `read-spike`: a workload read far more in the last hour than its own
 *   hourly average over the week before.
 * - `read-after-revoke`: a workload kept trying to read a secret after an
 *   admin revoked its grant (refused attempts).
 * - `stale-identity`: a plugin read (or tried to) with an identity version
 *   older than its current one, after its rolling update should be over.
 */
export const SECRET_FLAG_RULES = ['read-spike', 'read-after-revoke', 'stale-identity'] as const;
export type SecretFlagRule = (typeof SECRET_FLAG_RULES)[number];

/** How often the rules run (on the leader, from the module's tick). */
export const FLAG_EVALUATE_EVERY_MS = 5 * 60_000;
/** `read-spike`: the recent window, and the baseline window before it. */
export const SPIKE_RECENT_MS = 60 * 60_000;
export const SPIKE_BASELINE_MS = 7 * 24 * 60 * 60_000;
/** `read-spike`: at least this many reads in the recent window… */
export const SPIKE_MIN_READS = 100;
/** …and at least this many times the baseline's hourly average. */
export const SPIKE_FACTOR = 10;
/** `read-spike`: the workload's first read is at least this old before the recent window, so it has a baseline. */
export const SPIKE_MIN_HISTORY_MS = 24 * 60 * 60_000;
/** `read-after-revoke` and `stale-identity` look back this far. */
export const FLAG_LOOKBACK_MS = 24 * 60 * 60_000;
/** `read-after-revoke`: refused attempts after a revoke that flag it… */
export const REVOKED_READS_MIN = 5;
/** …counted only once a value read before the revoke has left the SDK's cache. */
export const REVOKE_GRACE_MS = SECRET_CACHE_MS;
/** `stale-identity`: how long after a new identity version an older one's use counts (a rolling update's drain). */
export const STALE_IDENTITY_GRACE_MS = 10 * 60_000;
/** `stale-identity`: uses of a stale identity that flag it. */
export const STALE_IDENTITY_MIN = 1;

/** A workload's reads of one secret, from the audit lines. */
export interface SecretReadSummary {
    /** The workload's key: an app id, or `plugin:<id>`. */
    workload: string;
    kind: WorkloadKind;
    workloadName: string;
    firstReadAt: number | null;
    lastReadAt: number | null;
    reads: number;
    /** Refused attempts (403 and 404). */
    refused: number;
    lastRefusedAt: number | null;
}

export type SecretHistoryEventKind =
    | 'created'
    | 'replaced'
    | 'described'
    | 'deleted'
    | 'granted'
    | 'revoked'
    | 'first-read';

/** One line of a secret's history: names and versions, never a value. */
export interface SecretHistoryEvent {
    /** The audit line's id; `?before=` pages by it. */
    id: number;
    at: number;
    kind: SecretHistoryEventKind;
    actorName: string;
    workload: string | null;
    workloadName: string | null;
    version: number | null;
    /** What happened, in the audit line's words (never a value). */
    detail: string;
}

/** A read flag, as admins see it. */
export interface SecretReadFlagView {
    id: string;
    rule: SecretFlagRule;
    workload: string;
    kind: WorkloadKind;
    workloadName: string;
    secretId: string | null;
    secretName: string | null;
    /** Why it fired, with its numbers. */
    explanation: string;
    firstSeenAt: number;
    lastSeenAt: number;
    dismissedAt: number | null;
    dismissedByName: string | null;
}

/** `GET /api/workspace-secrets/:id/history`. */
export interface SecretHistory {
    secret: { id: string; name: string; scope: SecretScope; appName: string | null; deletedAt: number | null };
    versions: SecretVersionView[];
    reads: SecretReadSummary[];
    /** Newest first; `nextBefore` fetches the next (older) page. */
    events: SecretHistoryEvent[];
    nextBefore: number | null;
    /** This secret's flags, open and dismissed. */
    flags: SecretReadFlagView[];
}
