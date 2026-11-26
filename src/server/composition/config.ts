/**
 * The process's configuration (`PlatformConfig`) and the env readers that
 * fill it: the entry (`index.ts`) reads the environment once with them, and
 * each feature's `composition/<x>.ts` builds its `XConfig` tag from the
 * config it is given, never from the environment. Moved here from
 * `src/server/platform-config.ts`.
 */
import type { AppsSettings } from '@socio/foundation/apps/settings';
import type { DataKeys } from '@socio/foundation/keys/data-keys';
import type { OtlpSettings } from '@socio/foundation/observability/otel-export';
import { renamedSetting } from '@socio/foundation/settings/renamed-setting';
import { callsSetup } from '@socio/foundation/voice/speech-provider';
import { dictationSetup, transcriptionProvider } from '@socio/foundation/voice/transcription-provider';
import type { AppLogRetention } from '@socio/shared/apps/app-log-retention';
import type { ClassifySettings } from '@socio/shared/classify';
import type { ContextSettings } from '@socio/shared/context-settings';
import type { AppPolicy } from '@socio/shared/device-sign-in';
import { LIMIT_SPECS, validLimit, type LimitKey } from '@socio/shared/limits';
import { DEFAULT_NOTIFICATION_LIMITS, type NotificationDailyLimits } from '@socio/shared/notifications';
import type { OperationsSettings } from '@socio/shared/operations/operations';
import type { AppEnvironment } from '@socio/shared/operator';
import type { RoomsSettings } from '@socio/shared/rooms/rooms';
import type { AutoTriageSettings, SetupStatus } from '@socio/shared/types';
import type { DictationAllowed } from '@socio/shared/voice/dictation';

import type { AppsRuntimeSettings } from '../apps/contract.js';
import type { CloudEnvironment } from '../cloud/contract.js';
import type { DataSettings } from '../dataspace/contract.js';
import type { DomainsSetup } from '../domains/contract.js';
import type { DeploymentKind, FlagEnvDefaults } from '../flags/contract.js';
import type { GitHubAppEnv, GitHubOptions } from '../github/contract.js';
import type { DotRequestLimits } from '../issues/contract.js';
import type { MediaSettings } from '../media/contract.js';
import { DEFAULT_PUSH_HOSTS, type PushSettings } from '../notifications/contract.js';
import type { AnalyticsConfig } from '../operations/contract.js';
import type { CatalogRef, PluginRuntime } from '../plugins/contract.js';
import type { JobSettings, ScheduleSettings } from '../schedules/contract.js';
import type { SearchWebConfig } from '../search/contract.js';
import type { StorageSettings } from '../storage/contract.js';
import type { RetryPolicy } from '../turns/contract.js';
import type { UpdatesEnvironment } from '../updates/contract.js';
import type { TranscriptionEnv, VoiceCallsEnv } from '../voice/contract.js';
import type { WebSettings } from '../web/contract.js';

/**
 * Chat Completions settings for any OpenAI-compatible server. There is no
 * default endpoint: an unset OPENAI_BASE_URL is reported as missing setup
 * rather than silently sending prompts to a hosted provider. They only seed
 * the first inference backend, once (`InferenceService.seed`); after that
 * the database is the source of truth.
 */
export function modelSettingsFromEnv(env: Record<string, string | undefined>): {
    apiKey?: string;
    model?: string;
    baseUrl: string;
    maxCompletionTokens?: number;
    titleModelOptions?: Record<string, unknown>;
    acceptsImages: boolean;
    maxImages?: number;
    contextWindow?: number;
} {
    const cap = env.MODEL_MAX_COMPLETION_TOKENS?.trim();
    const maxCompletionTokens = cap ? Number(cap) : undefined;
    if (maxCompletionTokens !== undefined && (!Number.isInteger(maxCompletionTokens) || maxCompletionTokens < 1)) {
        throw new Error('MODEL_MAX_COMPLETION_TOKENS must be a positive integer.');
    }
    const imageCap = env.MODEL_MAX_IMAGES?.trim();
    const maxImages = imageCap ? Number(imageCap) : undefined;
    if (maxImages !== undefined && (!Number.isInteger(maxImages) || maxImages < 1)) {
        throw new Error('MODEL_MAX_IMAGES must be a positive integer.');
    }
    const windowSize = env.MODEL_CONTEXT_WINDOW?.trim();
    const contextWindow = windowSize ? Number(windowSize) : undefined;
    if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow < 1_024)) {
        throw new Error('MODEL_CONTEXT_WINDOW must be a whole number of tokens, at least 1024.');
    }
    const options = env.TITLE_MODEL_OPTIONS?.trim();
    let titleModelOptions: Record<string, unknown> | undefined;
    if (options) {
        try {
            titleModelOptions = JSON.parse(options);
        } catch {
            titleModelOptions = undefined;
        }
        if (!titleModelOptions || typeof titleModelOptions !== 'object' || Array.isArray(titleModelOptions)) {
            throw new Error('TITLE_MODEL_OPTIONS must be a JSON object.');
        }
    }
    return {
        apiKey: env.OPENAI_API_KEY?.trim() || undefined,
        model: env.OPENAI_MODEL?.trim() || undefined,
        baseUrl: env.OPENAI_BASE_URL?.trim() ?? '',
        maxCompletionTokens,
        titleModelOptions,
        acceptsImages: env.MODEL_ACCEPTS_IMAGES?.trim().toLowerCase() === 'true',
        ...(maxImages ? { maxImages } : {}),
        ...(contextWindow ? { contextWindow } : {}),
    };
}

export interface PlatformConfig extends SearchWebConfig {
    model?: string;
    apiKey?: string;
    baseUrl: string;
    /** Includes reasoning tokens on reasoning models. Defaults to 2200. */
    maxCompletionTokens?: number;
    /** Extra Chat Completions fields for title requests, e.g. to skip thinking. */
    titleModelOptions?: Record<string, unknown>;
    /** Whether the model takes image input; otherwise images become text notes. */
    acceptsImages?: boolean;
    /** Most recent images a request keeps; older ones become notes. Default 4. */
    maxImages?: number;
    /** The model's context window in tokens (CB-129); 32,768 when unset. */
    contextWindow?: number;
    computerSupervisorUrl?: string;
    computerSupervisorToken?: string;
    computerToken?: string;
    computerNamespace?: string;
    /**
     * The read-only disk usage proxy (CB-197), e.g.
     * `http://company-brain-disk-usage:4301`. It takes the supervisor token.
     * Empty: computers' disk usage shows as not set up.
     */
    computerDiskUsageUrl?: string;
    voiceKey?: string;
    voiceModel?: string;
    voiceName: string;
    /**
     * `VOICE_TRANSCRIBE_*` (`transcriptionFromEnv`): server dictation's
     * default transcription server, under an admin's; OpenAI's when unset.
     */
    transcription?: TranscriptionEnv;
    /**
     * `VOICE_BACKEND` and `VOICE_SPEECH_*` (`voiceCallsFromEnv`, CB-265):
     * calls' default backend and self-hosted speech server, under an admin's.
     */
    voiceCalls?: VoiceCallsEnv;
    /** `DICTATION_METHODS`: the ways to dictate, under an admin's (CB-101); both when unset. */
    dictationMethods?: DictationAllowed;
    runtimeUrl: string;
    /**
     * SESSION_SECRET: sign-ins, and the legacy key for files and stored
     * credentials sealed before DATA_ENCRYPTION_KEY. A per-process secret
     * when unset.
     */
    sessionSecret?: string;
    /**
     * DATA_ENCRYPTION_KEY and DATA_ENCRYPTION_KEY_PREVIOUS (CB-62): files and
     * stored credentials are sealed with the first; unset, with the key from
     * SESSION_SECRET.
     */
    dataKeys?: DataKeys;
    /** `DOT_MAX_MODEL_ROUNDS`: model rounds per Dot turn (CB-127); 30 when unset. */
    dotModelRounds?: number;
    /** `TURN_TIME_LIMIT_SECONDS`: how long one turn may run (CB-123); 300 when unset. */
    turnTimeLimitSeconds?: number;
    /** `STEERING_MAX_QUEUED`: messages one person may queue in a chat (CB-170); 5 when unset. */
    steeringMaxQueued?: number;
    /**
     * A message's work cycle bounds (CB-211): `ROOM_CYCLE_TOKENS` (2,000,000),
     * `ROOM_MESSAGES_PER_MINUTE` (20 a chat), `ROOM_HANDOFFS_PER_CYCLE` (4)
     * and `ROOM_CYCLE_SPEND_USD` (0: no spend cap) when unset.
     */
    roomCycleTokens?: number;
    roomMessagesPerMinute?: number;
    roomHandoffsPerCycle?: number;
    roomCycleSpendUsd?: number;
    /**
     * The continuous copy's alerts (CB-315): `LITESTREAM_LAG_WARN_MINUTES`
     * (5), `LITESTREAM_LAG_CRITICAL_MINUTES` (30), `LITESTREAM_WAL_WARN_MB`
     * (256) and `LITESTREAM_WAL_CRITICAL_MB` (1024) when unset.
     */
    copyLagWarnMinutes?: number;
    copyLagCriticalMinutes?: number;
    walWarnMb?: number;
    walCriticalMb?: number;
    /** `PLUGIN_BACKUP_MAX_GB`: the most one plugin's snapshot may hold (CB-458); 20 when unset. */
    pluginBackupMaxGb?: number;
    /**
     * `TURN_RECALL_TOKENS`: about how much recalled context a turn's note
     * carries (CB-173); 1,000 when unset.
     */
    turnRecallTokens?: number;
    /**
     * `EPISODE_RETENTION_DAYS`: how long an episode is kept after it last
     * came up (CB-180); 180 when unset.
     */
    episodeRetentionDays?: number;
    /**
     * `SPACE_MEMORY_RETENTION_DAYS`: how long Space memory out of use is
     * kept (CB-181); 365 when unset.
     */
    spaceMemoryRetentionDays?: number;
    /**
     * How a busy model's requests are retried within a turn (CB-140), over
     * the built-in policy; no variable sets it (tests shorten the waits).
     */
    modelRetry?: Partial<RetryPolicy>;
    /**
     * `CODE_USERS` (`DISPATCH_CODE_USERS` before CB-325), deprecated (CB-376):
     * who could run code before groups; read only to seed the "Code" group.
     */
    codeUsers?: readonly string[];
    /** `GITHUB_*` (CB-32, CB-325): the GitHub App's environment defaults, under Settings. */
    github?: GitHubAppEnv;
    /** Where GitHub is and how it is reached (CB-32); no variable sets it (tests do). */
    githubAccess?: GitHubOptions;
    /** `APP_ENV`; production when unset. Development enables the force stop. */
    environment?: AppEnvironment;
    /** `DOT_REQUESTS_PER_*_DAILY`: `request_capability` limits; 5 per Dot, 10 per user. */
    dotRequestLimits?: DotRequestLimits;
    /** `AUTO_TRIAGE` and `AUTO_TRIAGE_DAILY` (CB-30): off, 100 a day, until an admin sets them in Settings. */
    autoTriage?: AutoTriageSettings;
    /** `ROOMS_ENABLED` (CB-207): Rooms off until an admin turns them on in Settings; `ROOMS_BUDGET_VISIBLE` (CB-218): members see their room’s use and limits. */
    rooms?: Partial<RoomsSettings>;
    /** `AUTH_APP_INVITE_LINKS` (CB-352): invites open the Socio app, until an admin says otherwise in Settings. */
    appInviteLinks?: boolean;
    /** `AUTH_APP_LEASE_DAYS`, `AUTH_APP_WIPE_DAYS`, `AUTH_APP_LOCK`, `AUTH_APP_NOTIFICATION_TEXT` (CB-379): the app's policy, under an admin's in Settings. */
    appPolicy?: AppPolicy;
    /** `CLASSIFY_FAILURES*` (CB-198): the seam's uses, off until an admin or the env turns one on. */
    classify?: ClassifySettings;
    /** `NOTIFY_PER_*_DAILY`: `notify_user` limits (CB-114); 20 per Dot, 40 per person. */
    notificationLimits?: NotificationDailyLimits;
    /** `PUSH_ENDPOINT_HOSTS`: the push services subscriptions may use (CB-114). */
    push?: PushSettings;
    /** Web reads (`http_get`/`http_json`): `webSettingsFromEnv`; its defaults when unset. */
    web?: WebSettings;
    /** The app's public origin (the first of APP_ORIGIN), for links in messages. */
    appOrigin?: string;
    /** USER_DATA_DIR, DATA_API_URL, DATA_* limits (`dataSettingsFromEnv`). */
    data?: DataSettings;
    /**
     * Where the data space's files go (`storageSettingsFromEnv`, CB-54): S3
     * with `s3`, else the local disk under USER_DATA_DIR.
     */
    storage?: StorageSettings;
    /** MEDIA_IMAGE_MODEL_MAX_MB (`mediaSettingsFromEnv`): chat attachments' model limit. */
    media?: MediaSettings;
    /** Mini apps' origin and limits (`appsSettingsFromEnv`); off when unset. */
    apps?: AppsSettings;
    /** SCHEDULE_MIN_INTERVAL_MINUTES, SCHEDULES_PER_USER (`scheduleSettingsFromEnv`). */
    schedules?: Partial<ScheduleSettings>;
    /** JOB_* limits (`jobSettingsFromEnv`). */
    jobs?: Partial<JobSettings>;

    /** The workspace app runtime for promoted apps (`APPS_RUNTIME_URL`). */
    appsRuntime?: AppsRuntimeSettings;
    /**
     * Workspace plugins. The catalog is empty unless `PLUGIN_CATALOGS` lists
     * something. `runtime` is set by tests; production uses the apps runtime.
     */
    plugins?: {
        catalogs: readonly CatalogRef[];
        serviceToken?: string;
        runtime?: PluginRuntime;
        /**
         * `PLUGIN_REGISTRY_AUTH` (`_FILE`): the registry login plugin images
         * pull with, as JSON; the workspace secret of the same name wins.
         */
        registryAuth?: string;
    };
    /** Hostnames through NPM and Cloudflare (`domainsSettingsFromEnv`); off when unset. */
    domains?: DomainsSetup;
    /** UPDATES_* and UPDATER_* (`updatesFromEnv`, CB-259): the release feed and the updater; none when unset. */
    updates?: UpdatesEnvironment;
    /** SOCIO_CLOUD* (`cloudFromEnv`): the cloud connection; off when unset (a platform built without the entry). */
    cloud?: CloudEnvironment;
    /**
     * `FEATURE_FLAGS` (`flagDefaultsFromEnv`, CB-169): this instance's
     * default for some flags, under an operator's rule in Settings.
     */
    featureFlags?: FlagEnvDefaults;
    /**
     * `SOCIO_DEPLOYMENT_KIND` (`deploymentKindFromEnv`, CB-503): `internal`
     * lets flags in development be listed and switched on; a customer
     * deployment (the default) never has them on.
     */
    deploymentKind?: DeploymentKind;
    /** `OTEL_EXPORTER_OTLP_*` (`otlpFromEnv`, CB-128): where turn traces go; no export when unset. */
    otlp?: OtlpSettings;
    /**
     * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`: exported spans
     * carry content, until an admin sets it in Settings; off when unset.
     */
    traceContent?: boolean;
    /**
     * `CONTEXT_SUMMARY_MODEL` and `CONTEXT_SELECTION` (CB-137, CB-134): long
     * chats' notes, until an admin sets them in Settings; the built-in
     * defaults when unset.
     */
    context?: Partial<ContextSettings>;
    /**
     * `APPS_LOG_DAYS` and `APPS_LOG_ATTEMPTS` (CB-175): how long mini apps'
     * logs are kept, until an admin sets it in Settings; 14 days or 50
     * attempts when unset.
     */
    appLogs?: Partial<AppLogRetention>;
    /**
     * `OPS_TIME_ZONE` (CB-164): the Operations dashboard's reporting time
     * zone, until an admin sets it in Operations → Settings; UTC when unset.
     */
    operations?: OperationsSettings;
    /**
     * `OPS_PRICE_SYNC_URL` (CB-195): an origin every price list is read
     * from instead of its own (a loopback fake, an offline mirror).
     */
    priceSyncUrl?: string;
    /**
     * The Operations analytics store (CB-186, `OPS_ANALYTICS_*`): a child
     * process or the stack's `socio-analytics` service; none when unset.
     */
    analytics?: AnalyticsConfig;
}
export function setupStatus(config: PlatformConfig): SetupStatus {
    const missing = [
        !config.baseUrl && 'OPENAI_BASE_URL',
        !config.apiKey && 'OPENAI_API_KEY',
        !config.model && 'OPENAI_MODEL',
    ].filter((item): item is string => !!item);
    return {
        model: !missing.length,
        ...callsSetup({
            cloud: !!(config.voiceKey && config.voiceModel && !missing.length),
            model: !missing.length,
            env: config.voiceCalls,
            settings: {},
            transcription: transcriptionProvider(config),
        }),
        ...dictationSetup(transcriptionProvider(config)),
        telegram: 'not_configured',
        missing,
    };
}

// ── The feature folders' env readers ──────────────────────────────────────
//
// Moved here from the folders that held them, unchanged: only the entry
// (`index.ts`) and tests call them.

// From `gateway/code-users.ts`.
/**
 * `CODE_USERS`: comma-separated app user ids that could run code before
 * CB-376. Deprecated: who may run code is now the `code:run` permission
 * (admins, and groups under Settings → People → Groups). It is read for
 * this release only, to seed the "Code" group once at boot, with a
 * deprecation warning when it is set. `DISPATCH_CODE_USERS`, its name
 * before CB-325, is still read when it is unset, with its own warning.
 */
export const CODE_USERS_DEPRECATED =
    'CODE_USERS is deprecated (CB-376): who may run code is now a permission, under Settings → People → Groups. Admins have it; on the first boot with groups, the other people CODE_USERS lists (as narrowed under Settings → Access) were put in a "Code" group. Remove CODE_USERS from the stack: a later release stops reading it.';

export function codeUsersFromEnv(
    env: Record<string, string | undefined>,
    warn: (line: string) => void = (line) => console.warn(line),
): string[] {
    const raw = renamedSetting(env, 'CODE_USERS', 'DISPATCH_CODE_USERS', warn) ?? '';
    const ids = [
        ...new Set(
            raw
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean),
        ),
    ];
    if (ids.length) {
        warn(CODE_USERS_DEPRECATED);
    }
    return ids;
}

// From `turns/agent-loop.ts`.
/** `DOT_MAX_MODEL_ROUNDS`, the cap's starting value; undefined when unset. */
export function dotModelRoundsFromEnv(env: Record<string, string | undefined>) {
    const raw = env.DOT_MAX_MODEL_ROUNDS?.trim();
    if (!raw) {
        return undefined;
    }
    const rounds = Number(raw);
    if (!validLimit('dotModelRounds', rounds)) {
        const { min, max } = LIMIT_SPECS.dotModelRounds;
        throw new Error(`DOT_MAX_MODEL_ROUNDS must be a whole number from ${min} to ${max}.`);
    }
    return rounds;
}

// From `memory/turn.ts`.
/** `TURN_RECALL_TOKENS`, the budget's starting value; undefined when unset. */
export function turnRecallTokensFromEnv(env: Record<string, string | undefined>) {
    const raw = env.TURN_RECALL_TOKENS?.trim();
    if (!raw) {
        return undefined;
    }
    const tokens = Number(raw);
    if (!validLimit('turnRecallTokens', tokens)) {
        const { min, max } = LIMIT_SPECS.turnRecallTokens;
        throw new Error(`TURN_RECALL_TOKENS must be a whole number from ${min} to ${max}.`);
    }
    return tokens;
}

/** `EPISODE_RETENTION_DAYS`, the retention's starting value; undefined when unset. */
export function episodeRetentionDaysFromEnv(env: Record<string, string | undefined>) {
    const raw = env.EPISODE_RETENTION_DAYS?.trim();
    if (!raw) {
        return undefined;
    }
    const days = Number(raw);
    if (!validLimit('episodeRetentionDays', days)) {
        const { min, max } = LIMIT_SPECS.episodeRetentionDays;
        throw new Error(`EPISODE_RETENTION_DAYS must be a whole number of days from ${min} to ${max}.`);
    }
    return days;
}

/** `SPACE_MEMORY_RETENTION_DAYS`, the retention's starting value; undefined when unset. */
export function spaceMemoryRetentionDaysFromEnv(env: Record<string, string | undefined>) {
    const raw = env.SPACE_MEMORY_RETENTION_DAYS?.trim();
    if (!raw) {
        return undefined;
    }
    const days = Number(raw);
    if (!validLimit('spaceMemoryRetentionDays', days)) {
        const { min, max } = LIMIT_SPECS.spaceMemoryRetentionDays;
        throw new Error(`SPACE_MEMORY_RETENTION_DAYS must be a whole number of days from ${min} to ${max}.`);
    }
    return days;
}

// From `context/steering-routes.ts`.
/** `STEERING_MAX_QUEUED`, the queue limit's starting value (CB-170); undefined when unset. */
export function steeringMaxQueuedFromEnv(env: Record<string, string | undefined>) {
    const raw = env.STEERING_MAX_QUEUED?.trim();
    if (!raw) {
        return undefined;
    }
    const limit = Number(raw);
    if (!validLimit('steeringMaxQueued', limit)) {
        const { min, max } = LIMIT_SPECS.steeringMaxQueued;
        throw new Error(`STEERING_MAX_QUEUED must be a whole number from ${min} to ${max}.`);
    }
    return limit;
}

// From `cycles/config.ts`.
type CycleLimitKey = Extract<
    LimitKey,
    'roomCycleTokens' | 'roomMessagesPerMinute' | 'roomHandoffsPerCycle' | 'roomCycleSpendUsd'
>;
/** The cycle limits the environment set, by key (`PlatformConfig`'s fields of the same names). */
export type CycleLimitsFromEnv = Partial<Record<CycleLimitKey, number>>;

const KEYS: CycleLimitKey[] = ['roomCycleTokens', 'roomMessagesPerMinute', 'roomHandoffsPerCycle', 'roomCycleSpendUsd'];

/**
 * The work cycle limits' starting values (CB-211) from the environment:
 * `ROOM_CYCLE_TOKENS`, `ROOM_MESSAGES_PER_MINUTE`, `ROOM_HANDOFFS_PER_CYCLE`
 * and `ROOM_CYCLE_SPEND_USD`, each in its Settings range; unset ones are
 * left out (the built-in defaults apply). A value out of range refuses to
 * start, as the other limits' do.
 */
export function cycleLimitsFromEnv(env: Record<string, string | undefined>): CycleLimitsFromEnv {
    return limitsFromEnv(env, KEYS);
}

type CopyAlertKey = Extract<LimitKey, 'copyLagWarnMinutes' | 'copyLagCriticalMinutes' | 'walWarnMb' | 'walCriticalMb'>;

/**
 * The continuous copy's alert thresholds (CB-315) from the environment:
 * `LITESTREAM_LAG_WARN_MINUTES`, `LITESTREAM_LAG_CRITICAL_MINUTES`,
 * `LITESTREAM_WAL_WARN_MB` and `LITESTREAM_WAL_CRITICAL_MB`, each in its
 * Settings range; unset ones are left out.
 */
export function copyAlertLimitsFromEnv(env: Record<string, string | undefined>): Partial<Record<CopyAlertKey, number>> {
    return limitsFromEnv(env, ['copyLagWarnMinutes', 'copyLagCriticalMinutes', 'walWarnMb', 'walCriticalMb']);
}

/**
 * The per-plugin snapshot cap (CB-458, decision 6) from the environment:
 * `PLUGIN_BACKUP_MAX_GB`, in its Settings range; left out when unset.
 */
export function pluginBackupLimitsFromEnv(
    env: Record<string, string | undefined>,
): Partial<Record<Extract<LimitKey, 'pluginBackupMaxGb'>, number>> {
    return limitsFromEnv(env, ['pluginBackupMaxGb']);
}

/** The limits of `keys` the environment set; a value out of range refuses to start. */
function limitsFromEnv<K extends LimitKey>(env: Record<string, string | undefined>, keys: K[]) {
    const out: Partial<Record<K, number>> = {};
    for (const key of keys) {
        const spec = LIMIT_SPECS[key];
        const raw = env[spec.env]?.trim();
        if (!raw) {
            continue;
        }
        const value = Number(raw);
        if (!validLimit(key, value)) {
            throw new Error(
                `${spec.env} must be ${'cents' in spec && spec.cents ? 'an amount in dollars and cents' : 'a whole number'} from ${spec.min} to ${spec.max}.`,
            );
        }
        out[key] = value;
    }
    return out;
}

// From `runtime/force-stop.ts`.
/**
 * `APP_ENV`: `production` unless set to `development`. Development (e.g.
 * brain.example.test) enables an operator's force stop and
 * `SHUTDOWN_FORCE`; production-like environments always drain.
 */
export function appEnvironmentFromEnv(env: Record<string, string | undefined>): AppEnvironment {
    const raw = env.APP_ENV?.trim().toLowerCase() || 'production';
    if (raw !== 'development' && raw !== 'production') {
        throw new Error('APP_ENV must be development or production.');
    }
    return raw;
}

/**
 * `SHUTDOWN_FORCE=true` (development only): SIGTERM stops running work at
 * once instead of draining. Off by default; ignored, with a warning, outside
 * development.
 */
export function shutdownForceFromEnv(
    env: Record<string, string | undefined>,
    environment: AppEnvironment,
    warn: (line: string) => void = () => {},
) {
    const on = env.SHUTDOWN_FORCE?.trim().toLowerCase() === 'true';
    if (on && environment !== 'development') {
        warn('Shutdown: SHUTDOWN_FORCE is ignored outside APP_ENV=development; SIGTERM drains.');
        return false;
    }
    return on;
}

// From `media/service.ts`.
const MB = 1048576;

export function mediaSettingsFromEnv(env: Record<string, string | undefined>): MediaSettings {
    const raw = env.MEDIA_IMAGE_MODEL_MAX_MB?.trim();
    if (!raw) {
        return {};
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error('MEDIA_IMAGE_MODEL_MAX_MB must be a positive number.');
    }
    return { imageModelMaxBytes: Math.floor(value * MB) };
}

// From `notifications/limits.ts` and `notifications/push.ts`.
/** `NOTIFY_PER_DOT_DAILY` (20) and `NOTIFY_PER_USER_DAILY` (40). */
export function notificationLimitsFromEnv(env: Record<string, string | undefined>): NotificationDailyLimits {
    const read = (name: string, fallback: number) => {
        const raw = env[name]?.trim();
        if (!raw) {
            return fallback;
        }
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
            throw new Error(`${name} must be a whole number, 0 or more.`);
        }
        return value;
    };
    return {
        perDot: read('NOTIFY_PER_DOT_DAILY', DEFAULT_NOTIFICATION_LIMITS.perDot),
        perUser: read('NOTIFY_PER_USER_DAILY', DEFAULT_NOTIFICATION_LIMITS.perUser),
    };
}

/** `PUSH_ENDPOINT_HOSTS` (comma-separated): the default list when unset. */
export function pushSettingsFromEnv(env: Record<string, string | undefined>): PushSettings {
    const hosts = env.PUSH_ENDPOINT_HOSTS?.split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
    return { hosts: hosts?.length ? hosts : DEFAULT_PUSH_HOSTS };
}

// From `operations/analytics/client.ts`.
/** The settings the child gets from the app's environment, nothing else. */
const CHILD_ENV = [
    'OPS_ANALYTICS_MEMORY_MB',
    'OPS_ANALYTICS_THREADS',
    'OPS_ETL_EVERY_SECONDS',
    'OPS_FACT_DAYS',
    'OPS_HOURLY_DAYS',
    'OPS_TIME_ZONE',
    'OPS_ANALYTICS_LOCK_RETRY_MS',
];

/**
 * `OPS_ANALYTICS_MODE`: `child` (the default: development and
 * single-container installs), `service` (the stack's `socio-analytics`),
 * or `off`.
 */
export function analyticsFromEnv(
    env: Record<string, string | undefined>,
    databasePath: string,
    dir: string,
): AnalyticsConfig | undefined {
    const mode = env.OPS_ANALYTICS_MODE?.trim() || 'child';
    if (mode === 'off') {
        return undefined;
    }
    if (mode === 'child') {
        return {
            mode,
            dir: env.OPS_ANALYTICS_DIR?.trim() || dir,
            databasePath,
            env: Object.fromEntries(
                CHILD_ENV.flatMap((name) => {
                    const value = env[name]?.trim();
                    return value ? [[name, value]] : [];
                }),
            ),
        };
    }
    if (mode !== 'service') {
        throw new Error('OPS_ANALYTICS_MODE must be child, service or off.');
    }
    const raw = env.OPS_ANALYTICS_URL?.trim();
    if (!raw || !/^https?:\/\/[^/?#@]+\/?$/.test(raw)) {
        throw new Error(
            'OPS_ANALYTICS_URL must be an http(s) origin with OPS_ANALYTICS_MODE=service, e.g. http://socio-analytics:4340.',
        );
    }
    const secret = env.OPS_ANALYTICS_SECRET?.trim();
    if (!secret || secret.length < 24) {
        throw new Error(
            'OPS_ANALYTICS_SECRET (or _FILE) must be set, at least 24 characters, with OPS_ANALYTICS_MODE=service.',
        );
    }
    return { mode, url: new URL(raw).origin, secret };
}
