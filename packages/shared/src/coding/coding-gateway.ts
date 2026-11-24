/**
 * The coding gateway's model settings (CB-239): what
 * Settings → Coding shows and saves, shared by the server and the client.
 * The models a coding session may use, which repositories may send code to
 * an outside provider, and the limits, each
 * admin-editable over an environment default.
 */

/** A gateway model name: what OpenCode sends as `model`. */
export const CODING_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * A GitHub repository as `owner/name` (CB-239): the owner as GitHub
 * allows it, the name without `..`. Compared in lowercase, as GitHub does.
 */
export const REPOSITORY_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export function normalRepository(value: string): string | undefined {
    const trimmed = value.trim();
    if (!REPOSITORY_NAME.test(trimmed) || trimmed.includes('..')) {
        return undefined;
    }
    return trimmed.toLowerCase();
}

/** The limits of Settings → Coding, each over an env default. */
export const CODING_LIMIT_KEYS = [
    'sessionTokens',
    'personDailyTokens',
    'socioDailyTokens',
    'sessionsPerPerson',
    'sessionsPerSocio',
    'sessionsPerInstance',
    'requestsPerMinute',
    'inFlightPerSession',
    'inFlightPerPerson',
    'inFlightPerInstance',
] as const;
export type CodingLimitKey = (typeof CODING_LIMIT_KEYS)[number];
export type CodingLimits = Record<CodingLimitKey, number>;

export interface CodingLimitSpec {
    label: string;
    help: string;
    /** The environment variable that sets the default. */
    env: string;
    default: number;
    min: number;
    max: number;
}

/**
 * The defaults. There is no instance-wide token budget: the per-session,
 * per-person and per-socio budgets, times the concurrency caps, bound the
 * total.
 */
export const CODING_LIMITS: Record<CodingLimitKey, CodingLimitSpec> = {
    sessionTokens: {
        label: 'Tokens per session',
        help: 'Prompt and completion tokens one coding session may use in all.',
        env: 'CODING_SESSION_TOKENS',
        default: 2_000_000,
        min: 1_000,
        max: 1_000_000_000,
    },
    personDailyTokens: {
        label: 'Tokens per person, last 24 hours',
        help: 'Across all of a person’s coding sessions, over a rolling 24 hours.',
        env: 'CODING_PERSON_DAILY_TOKENS',
        default: 5_000_000,
        min: 1_000,
        max: 1_000_000_000,
    },
    socioDailyTokens: {
        label: 'Tokens per socio, last 24 hours',
        help: 'Across everyone’s coding sessions on one socio, over a rolling 24 hours.',
        env: 'CODING_SOCIO_DAILY_TOKENS',
        default: 10_000_000,
        min: 1_000,
        max: 1_000_000_000,
    },
    sessionsPerPerson: {
        label: 'Sessions at once per person',
        help: 'Coding sessions one person may have running.',
        env: 'CODING_SESSIONS_PER_PERSON',
        default: 2,
        min: 1,
        max: 50,
    },
    sessionsPerSocio: {
        label: 'Sessions at once per socio',
        help: 'Coding sessions running on one socio, for everyone.',
        env: 'CODING_SESSIONS_PER_SOCIO',
        default: 4,
        min: 1,
        max: 100,
    },
    sessionsPerInstance: {
        label: 'Sessions at once on this server',
        help: 'Coding sessions running on this server in all.',
        env: 'CODING_SESSIONS_PER_INSTANCE',
        default: 8,
        min: 1,
        max: 200,
    },
    requestsPerMinute: {
        label: 'Model requests a minute per session',
        help: 'Counted on each server process, so at most doubled while a deploy overlaps.',
        env: 'CODING_GATEWAY_REQUESTS_PER_MINUTE',
        default: 60,
        min: 1,
        max: 600,
    },
    inFlightPerSession: {
        label: 'Model requests in flight per session',
        help: 'Counted across server processes.',
        env: 'CODING_GATEWAY_IN_FLIGHT_PER_SESSION',
        default: 2,
        min: 1,
        max: 16,
    },
    inFlightPerPerson: {
        label: 'Model requests in flight per person',
        help: 'Counted across server processes.',
        env: 'CODING_GATEWAY_IN_FLIGHT_PER_PERSON',
        default: 4,
        min: 1,
        max: 64,
    },
    inFlightPerInstance: {
        label: 'Model requests in flight on this server',
        help: 'Counted across server processes.',
        env: 'CODING_GATEWAY_IN_FLIGHT_PER_INSTANCE',
        default: 16,
        min: 1,
        max: 512,
    },
};

export const validCodingLimit = (key: CodingLimitKey, value: unknown) =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CODING_LIMITS[key].min &&
    value <= CODING_LIMITS[key].max;

/** A model a coding session may use (Settings → Coding → Models). */
export interface CodingModelView {
    /** The gateway name OpenCode asks for. */
    id: string;
    /** For people: the card's "Model: …". */
    label: string;
    backendId: string;
    /** The backend's label; null when it was removed. */
    backendLabel: string | null;
    /** The backend is enabled and complete. */
    backendReady: boolean;
    /** Where the backend is, as a host name only (never a key or path). */
    backendHost: string | null;
    upstreamModel: string;
    maxOutputTokens: number;
    contextWindow: number | null;
    acceptsImages: boolean;
    /** As saved: true, false, or null to follow the backend's address. */
    outsideProviderSetting: boolean | null;
    /** In force: whether code sent to this model leaves the operator's servers. */
    outsideProvider: boolean;
    enabled: boolean;
    /**
     * Repositories an admin allowed this model for, lowercase. Only an
     * outside-provider model needs them; the others
     * are allowed everywhere.
     */
    repositories: string[];
    updatedAt: number;
}

/** A shared backend a model can be listed on. */
export interface CodingBackendOption {
    id: string;
    label: string;
    /** The backend's own model, offered as the upstream model. */
    model: string;
    host: string | null;
    /** Whether its address makes it an outside provider by default. */
    outsideByDefault: boolean;
    ready: boolean;
}

/** Tokens over the last 24 hours, by person, socio or model. */
export interface CodingUsageRow {
    id: string;
    label: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
}

export interface CodingSettingsState {
    models: CodingModelView[];
    backends: CodingBackendOption[];
    limits: CodingLimits;
    limitDefaults: CodingLimits;
    usage: {
        persons: CodingUsageRow[];
        socios: CodingUsageRow[];
        models: CodingUsageRow[];
    };
}

/** An admin's create or edit of a model (`PUT /api/gateway/coding/models/:id`). */
export interface CodingModelInput {
    label: string;
    backendId: string;
    upstreamModel: string;
    maxOutputTokens: number;
    contextWindow?: number | null;
    acceptsImages?: boolean;
    outsideProvider?: boolean | null;
    enabled?: boolean;
}

/**
 * Settings → Coding's switches over an environment default (CB-239):
 * whether people may run their own coding sessions on their own plan,
 * off by default (`CODING_PERSONAL_PLANS`).
 */
export interface CodingOptionsView {
    personalPlans: boolean;
    personalPlansDefault: boolean;
    /** An admin's value is in force (else the default). */
    personalPlansSaved: boolean;
}

/**
 * The gateway model name of a session on the person's own plan:
 * `personal-<kind>` without the `byo-` prefix. Admins can't list a model
 * whose name starts with `personal-`.
 */
export const PERSONAL_MODEL_PREFIX = 'personal-';
export const personalModelId = (kind: string) => `${PERSONAL_MODEL_PREFIX}${kind.replace(/^byo-/, '')}`;
