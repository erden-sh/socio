import type { AppLogRetention } from './apps/app-log-retention.js';
import type { WorkspaceAppEntry } from './apps/app-types.js';
import type { ContextSettings } from './context-settings.js';
import type { ClientFlags } from './flags.js';
import type { InferenceAvailability, ModelChoice } from './inference.js';
import type { LimitValues } from './limits.js';
import type { LocalId } from './mascot.js';
import type { InAppNotice, NotificationDailyLimits } from './notifications.js';
import type { AnalyticsHealth } from './operations/operations-analytics.js';
import type { OperationsSettings } from './operations/operations.js';
import type { PluginBackupStatus } from './plugins/plugin-backup.js';
import type { RoomNotifyLevel } from './rooms/room-notices.js';
import type { ConversationKind, RoomRole, RoomsSettings } from './rooms/rooms.js';
import type { RunTraceSummary } from './runs/run-trace.js';
import type { ThemeId } from './settings/appearance.js';
import type { SoulVersion } from './soul.js';
import type { SavedUpdateSettings } from './updates/updates.js';
import type { DictationAllowed, UserPreferences } from './voice/dictation.js';
import type { TranscriptionSettings, TranscriptionStreaming, TranscriptionView } from './voice/transcription.js';
import type { SpeechSettings, VoiceBackend, VoiceCallsView } from './voice/voice-call.js';

export type Status =
    | 'queued'
    | 'running'
    | 'paused'
    | 'scheduled'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'cancelled';
import type { Branding } from './branding.js';
import type { ClassifySettings } from './classify.js';

export interface Settings {
    branding?: Branding | null;
    defaultThemeId?: ThemeId | null;
    name: string;
    paused: boolean;
    researchAllowed: boolean;
    memoryAllowed: boolean;
    /**
     * How much a Dot may file a day (requests, board items, comments, votes):
     * an admin's choice from Settings, over the server's. `GET /api/state`
     * always fills it in with the limits in force.
     */
    dotDailyLimits?: DotDailyLimits;
    /**
     * Automatic triage of new issues (CB-30): an admin's switch and daily cap
     * from Settings, over `AUTO_TRIAGE` and `AUTO_TRIAGE_DAILY`. Off unless
     * turned on. `GET /api/state` always fills it in with what is in force.
     */
    autoTriage?: AutoTriageSettings;
    /**
     * Content-based name suggestions for rooms and chats (CB-292): an admin's
     * switch from Settings, off by default. When on, the workspace proposes a
     * concise name after the unnamed or drift trigger fires, and the inline
     * card asks for approval. No name is applied without it.
     */
    chatNameSuggestions?: boolean;
    /**
     * The classification seam's uses (CB-198): an admin's switch, threshold
     * and daily cap from Operations → Settings, over `CLASSIFY_*`. Off
     * unless turned on.
     */
    classify?: ClassifySettings;
    /** `notify_user` per day (CB-114): an admin's, over NOTIFY_PER_*_DAILY. */
    notificationDailyLimits?: NotificationDailyLimits;
    /**
     * Which ways to dictate the composer offers (CB-101): an admin's choice
     * from Settings, over `DICTATION_METHODS`. `GET /api/state` fills it in.
     */
    dictationMethods?: DictationAllowed;
    /**
     * Where server dictation transcribes (CB-101): an admin's base URL and
     * model from Settings, over `VOICE_TRANSCRIBE_URL` and
     * `VOICE_TRANSCRIBE_MODEL`; null or unset uses the environment's.
     * `GET /api/state` fills it in with the server in force and which key it
     * sends (never the key).
     */
    transcription?: (TranscriptionSettings & Partial<Omit<TranscriptionView, keyof TranscriptionSettings>>) | null;
    /**
     * Live text while dictating (CB-222): an admin's choice from Settings,
     * over `VOICE_TRANSCRIBE_STREAMING`; null or unset uses the
     * environment's. The one in force is `transcription.streaming`.
     */
    transcriptionStreaming?: TranscriptionStreaming | null;
    /**
     * Which backend voice calls use (CB-265): an admin's choice from
     * Settings, over `VOICE_BACKEND`; null or unset uses the environment's.
     * The one in force is `voiceCalls.backend`.
     */
    voiceBackend?: VoiceBackend | null;
    /**
     * Self-hosted calls' speech server (CB-265): an admin's URL, model and
     * voice from Settings, over `VOICE_SPEECH_*`; null or unset uses the
     * environment's. An empty URL: this device speaks the replies.
     */
    voiceSpeech?: SpeechSettings | null;
    /** In `GET /api/state` only: calls' backend and speech server in force. */
    voiceCalls?: VoiceCallsView;
    /**
     * Limits an admin tunes in Settings (CB-108, `shared/limits.ts`): what
     * they saved over the server's. Stored, only the ones changed; in
     * `GET /api/state` every limit in force, with the server's starting
     * values in `limitDefaults`.
     */
    limits?: Partial<LimitValues>;
    limitDefaults?: LimitValues;
    /**
     * How often the server backs up (CB-112): an admin's choice from
     * Settings, over `BACKUP_INTERVAL_HOURS` and `BACKUP_LTX_INTERVAL_SECONDS`.
     * `GET /api/state` fills it in with the schedule in force when the server
     * runs backups.
     */
    backupSchedule?: BackupSchedule;
    /**
     * Turn traces (CB-128): whether exported spans carry content, an
     * admin's choice over `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`
     * (off). `GET /api/state` fills it in, with whether export is on.
     */
    tracing?: TraceSettings;
    /**
     * Long chats' running notes (CB-137, CB-134): who writes them and which
     * pinned facts a prompt carries, an admin's choice over
     * `CONTEXT_SUMMARY_MODEL` and `CONTEXT_SELECTION`. `GET /api/state`
     * fills it in with what is in force.
     */
    context?: ContextSettings;
    /**
     * How long mini apps' build and start logs are kept (CB-175): an
     * admin's choice over `APPS_LOG_DAYS` and `APPS_LOG_ATTEMPTS`.
     * `GET /api/state` fills it in with what is in force.
     */
    appLogs?: AppLogRetention;
    /**
     * Operations settings (CB-164): an admin's, from Operations → Settings,
     * over `OPS_TIME_ZONE` and the `OPS_ANALYTICS_*` defaults (CB-186). Not
     * in `GET /api/state`; the dashboard reads `/api/operations/settings`.
     */
    operations?: OperationsSettings;
    /**
     * Whether a turn whose person's own model (a ChatGPT plan) stays busy
     * carries on with the shared model (CB-140): an admin's choice, on
     * unless turned off. `GET /api/state` always fills it in.
     */
    modelFallback?: boolean;
    /**
     * Invites and "Send me a link for the app" open the Socio app, on the
     * link domain (CB-352): an admin's switch over `AUTH_APP_INVITE_LINKS`,
     * off unless turned on. `GET /api/state` fills in what is in force.
     */
    appInviteLinks?: boolean;
    /**
     * The Socio app's lease and notification policy, which the workspace
     * manifest (`/.well-known/socio/workspace`) gives the app (CB-379): an
     * admin's choices, each over `AUTH_APP_LEASE_DAYS`, `AUTH_APP_WIPE_DAYS`,
     * `AUTH_APP_LOCK` and `AUTH_APP_NOTIFICATION_TEXT`. `GET /api/state`
     * fills in what is in force.
     */
    appPolicy?: {
        leaseDays?: number;
        wipeDays?: number;
        appLock?: boolean;
        notificationText?: boolean;
    };
    /**
     * Updates (CB-259): an operator's release feed, check interval and
     * automatic updates, over `UPDATES_*`, and the newest release operators
     * were told about. Not in `GET /api/state`; operators read
     * `/api/updates`. The feed's read token is a secret setting.
     */
    updates?: SavedUpdateSettings;
    /**
     * Settings → General → Rooms (CB-207): an
     * admin's switch over `ROOMS_ENABLED`, off unless turned on, and
     * whether members see their room's use and limits (CB-218) over
     * `ROOMS_BUDGET_VISIBLE`. Saved: only what an admin chose.
     * `GET /api/state` always fills both in with what is in force.
     */
    rooms?: Partial<RoomsSettings>;
    /**
     * Who may create Spaces besides admins (`spaces/create-permission.ts`):
     * an admin's choice in Settings → General → Permissions; unset is
     * everyone (CB-181).
     */
    spaceCreators?: import('./spaces/create-permission.js').SpaceCreators;
}
/** Turn traces' export settings. */
export interface TraceSettings {
    /** Prompts, answers and tool input and output in exported spans, cut short. */
    includeContent: boolean;
    /** In `GET /api/state`: an operator set an OTLP endpoint. */
    exporting?: boolean;
}
/** The backups' schedule; 0 turns an interval off. */
export interface BackupSchedule {
    /** Scheduled backups, every this many hours. */
    intervalHours: number;
    /** The continuous copy's new files go off-site every this many seconds. */
    ltxIntervalSeconds: number;
    /** The restore drill (CB-111), every this many days. */
    drillIntervalDays: number;
    /** Permanent removals' backups (CB-391) are removed after this many days. */
    purgeBackupDays: number;
}
/** Automatic triage of new issues: the switch, and the most proposals a day. */
export interface AutoTriageSettings {
    enabled: boolean;
    perDay: number;
}
/** Per day: what one Dot may file for all its users, and what may be filed for one person. */
export interface DotDailyLimits {
    perDot: number;
    perUser: number;
}
export interface Task {
    id: string;
    prompt: string;
    status: Status;
    intervalSeconds: number | null;
    nextRunAt: number | null;
    createdAt: number;
    updatedAt: number;
    error: string | null;
    lease: string | null;
    leaseUntil: number | null;
    /** The owner; null only for tasks from before user accounts. */
    userId?: string | null;
    /**
     * Schedules: a cadence (`every day at 09:00`, a cron) read in
     * `timezone`, instead of `intervalSeconds`. Status `scheduled` waits for
     * `nextRunAt`; each run, success or not, schedules the next.
     */
    title?: string | null;
    cadence?: string | null;
    timezone?: string | null;
    /** The Dot it runs with (a turn in its conversation, or a job). */
    dotId?: string | null;
    /** `turn` (null for older tasks) or `job` (runs `jobId`, no model). */
    kind?: 'turn' | 'job' | null;
    jobId?: string | null;
    /** `dot`: proposed by a Dot and approved; null for the user's own. */
    origin?: 'dot' | null;
    lastRunAt?: number | null;
}
export interface Source {
    title: string;
    url: string;
    excerpt: string;
}
export interface Result {
    text: string;
    sources: Source[];
    sample: boolean;
    screenshot?: string;
}
export interface Run {
    id: string;
    taskId: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    result: Result | null;
    error: string | null;
    /** When it came due (CB-185); null for runs from before. */
    dueAt?: number | null;
}
export interface TaskEvent {
    id: number;
    taskId: string;
    runId: string | null;
    text: string;
    createdAt: number;
}
export interface Memory {
    id: string;
    text: string;
    createdAt: number;
}
export interface Detail {
    task: Task;
    runs: Run[];
    events: TaskEvent[];
}
export interface State {
    /** The running server release, supplied by the state API and SSR. */
    version?: string;
    settings: Settings;
    tasks: Task[];
    memories: Memory[];
    mode: 'sample' | 'live';
    configured: boolean;
    /** Notifications shown in the app while the person uses it (CB-114). */
    notices?: InAppNotice[];
}
export type Action = 'run' | 'pause' | 'resume' | 'cancel';
export interface Space {
    id: string;
    name: string;
    description: string;
    createdAt: number;
    /**
     * Read by its people only (CB-181, `space_settings.membersOnly`): its
     * pages, chats, search, shared apps, datasets and files, and memory.
     * Set in views for the viewer; unset: open to the whole workspace.
     */
    private?: boolean;
    /** The viewer's level in it (views only): `editor` manages it. */
    access?: 'editor' | 'reader';
}
/**
 * A deleted Space as admins see it (CB-277, `GET /api/admin/spaces/deleted`):
 * kept, with everything in it, until an admin restores it.
 */
export interface DeletedSpace {
    id: string;
    name: string;
    description: string;
    createdAt: number;
    deletedAt: number;
    /** Who deleted it: a user id; its name when the workspace knows them. */
    deletedBy: string | null;
    deletedByName: string | null;
    /** It was private to its people, and is again once restored. */
    private: boolean;
    /** Its live pages, kept with it. */
    pages: number;
}
export interface Dot {
    id: string;
    /** Default destination for saved pages, not ownership. */
    spaceId: string;
    spaceIds: string[];
    name: string;
    /** Its Soul's standing instructions (CB-179): the version in use. */
    instructions: string;
    /** The Soul in use (CB-179); absent only on a made-up socio. */
    soul?: SoulVersion;
    researchAllowed: boolean;
    memoryAllowed: boolean;
    createdAt: number;
    learningContainerId?: string | null;
    skillDeliveryEnabled?: boolean;
    /** May file items on the Improvements board (CB-31); off by default. */
    issuesAllowed?: boolean;
    /**
     * The person whose own Dot this is (private to them, working only for
     * them); null: a company Dot, shared by the team and managed by admins.
     */
    ownerId?: string | null;
    /** Archived (never deleted): out of every list, no new chats or turns. */
    archivedAt?: number | null;
    archivedBy?: string | null;
    /** The model new chats with this Dot run on; null: automatic. */
    inference?: ModelChoice | null;
    /**
     * Its Local (CB-256): the one chosen for it, else its id's (mascot.ts).
     * Views always carry it; render it with `characterOf`.
     */
    character?: LocalId;
}
export interface Conversation {
    id: string;
    dotId: string;
    ownerId: string;
    title: string;
    createdAt: number;
    /**
     * A person's chat (or a legacy Telegram team topic), or a room
     * (CB-207): a room's `ownerId` is `room:<id>`, no person. Unset reads
     * as `private`; the store always sets it.
     */
    kind?: ConversationKind;
    /**
     * In a room: the reader's role there (CB-208), set by the chat lists and
     * `readableThread` for an active member. Unset in a private chat.
     */
    roomRole?: RoomRole;
    /**
     * In a room, in the chat lists: how many turns others started there
     * since the reader last looked (CB-215), at most `ROOM_UNREAD_CAP`.
     * Unset when none.
     */
    unread?: number;
    /**
     * In a room, in the chat lists: what of it reaches the reader as
     * notifications (CB-216), when they chose other than the default
     * (`mentions`). Unset: the default.
     */
    roomNotify?: RoomNotifyLevel;
    /** Frozen at creation; null means this conversation does not participate. */
    learningContainerId?: string | null;
    /** This conversation's own model, over its Dot's default; null: the Dot's. */
    inference?: ModelChoice | null;
    /** Set for conversations that happen in Telegram. */
    source?: 'telegram';
    telegram?: {
        kind: 'dm' | 'topic' | 'group';
        chatId: string;
        topicId: string | null;
    };
    /** A team conversation (a Telegram forum topic): visible to its members, read-only here. */
    team?: boolean;
    /** Its owner renamed it (CB-66): a generated title never replaces theirs. */
    renamed?: boolean;
    /**
     * When its owner archived it; unset while it isn't. Archived chats are
     * in `WorkspaceState.archived`, not the chat lists.
     */
    archivedAt?: number;
}
/** The longest chat title (CB-66): a rename, and the first message's start. */
export const MAX_CHAT_TITLE = 80;
/**
 * Why a conversation can't be deleted now (CB-66): a turn or one of its
 * scheduled tasks is running, a call is in progress, or it is a Telegram
 * or page conversation.
 */
export type DeleteBlocker = 'running' | 'call' | 'telegram' | 'page';
/** `GET /api/conversations/:id/deletion`: what deleting it would do. */
export interface ConversationDeletion {
    /** Scheduled tasks bound to it, deleted with it. */
    scheduledTasks: number;
    /** Set when it can't be deleted now. */
    blocked: DeleteBlocker | null;
}
/**
 * Who sent a person's message: the linked app user's id in Telegram
 * (CB-66), the signed-in person's in the web app (CB-225), in the stored
 * message's metadata under this key. Set by the server; never taken from
 * request input, never sent to the model.
 */
export const SENDER_METADATA = 'socioSender';
/** Telegram ingress identity, stamped only by the server, never a client. */
export const TELEGRAM_INGRESS_METADATA = 'socioTelegramIngress';
/**
 * The sender's name when the message came (CB-147), beside their id: what
 * the model is told when it names them, so a later rename doesn't change
 * the earlier messages it was sent.
 */
export const SENDER_NAME_METADATA = 'socioSenderName';
/**
 * Whose turn produced a stored tool result or approval's note (CB-210): the
 * person it acted for, '' when none; stamped by the runner before a turn
 * runs, never taken from request input, never sent to the model.
 */
export const TOOL_ACTOR_METADATA = 'socioToolActor';
/**
 * The socio that wrote a stored reply (CB-212): its id, on the message's
 * metadata, stamped by the runner as the reply starts (the socio the turn,
 * or a handoff's step, ran as). Replies stored before it have none.
 */
export const SOCIO_METADATA = 'socioDot';
/** A team transcript message's sender, for the reader: a name, and whether it is them. */
export interface MessageAuthor {
    name: string;
    you: boolean;
    /**
     * In a room (CB-212), the sender's id, which its members see beside their
     * names anyway: two people with one name stay two. Never in a legacy
     * team topic's transcript.
     */
    id?: string;
}
/**
 * A turn in a room that ended without its answer (CB-212): refused, failed
 * or cut off, with what it said, after the message it follows, so every
 * member sees why the socio said nothing.
 */
export interface TranscriptTurnProblem {
    runId: string;
    /** The last message shown before it; none when it comes first. */
    after?: string;
    /** What the turn's error said: the room-safe text the stream sends too. */
    message: string;
    /**
     * The reason for members other than its sender (CB-205): in the third
     * person, about the sender, never a provider's words. `message` speaks to
     * the sender. A server from before it sends none.
     */
    roomMessage?: string;
    /** Who sent the turn's message, when it was a person's. */
    author?: MessageAuthor;
    at?: number;
}
export type AgentRunStatus = 'running' | 'finished' | 'stopped' | 'failed' | 'interrupted';
/** Where a turn came from: the web app, Telegram, a scheduled task, or a voice call. */
export type AgentRunSource = 'web' | 'telegram' | 'scheduled' | 'voice';
/** One agent turn in the Runs view: metadata, the error text and the trace summary only. */
export interface AgentRunSummary {
    runId: string;
    threadId: string;
    status: AgentRunStatus;
    source: AgentRunSource;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    /** What the operator sees: the sanitized provider or exception text. */
    errorDetail: string | null;
    title: string | null;
    dotName: string | null;
    /**
     * Whose turn it is: the conversation's owner; in a room (CB-213), the
     * person whose message started its work cycle (null when unknown), never
     * the room's sentinel owner.
     */
    ownerId: string | null;
    ownerName: string | null;
    /** The turn is a room's (CB-213). */
    room?: boolean;
    /**
     * False when the viewer may list the turn but not open its trace: a
     * room admin's view of another member's turn (CB-213). Absent: as its
     * `trace` says.
     */
    canTrace?: boolean;
    /** The viewer can open this conversation. */
    readable: boolean;
    /** How the turn's loop ended, its rounds and tokens (CB-128); null before it ends, or for older turns. */
    trace?: RunTraceSummary | null;
}
/**
 * `GET /api/dots/:id/runs` (CB-89): one of the person's own latest turns
 * with a Dot, for its home page. Metadata only, as in the Runs view.
 */
export interface DotRun {
    runId: string;
    threadId: string;
    /** The conversation's title. */
    title: string;
    status: AgentRunStatus;
    source: AgentRunSource;
    startedAt: number;
    finishedAt: number | null;
}
export interface CallReceipt {
    anchorMessageId?: string | null;
    id: string;
    threadId: string;
    startedAt: number;
    endedAt: number | null;
    status: 'connecting' | 'active' | 'ended' | 'failed';
    transcript: string;
    error: string | null;
}
export type TelegramStatus = 'not_configured' | 'connecting' | 'online' | 'failed';
export interface SetupStatus {
    model: boolean;
    voice: boolean;
    /**
     * Server dictation works (CB-101): a transcription URL is set, and it
     * isn't OpenAI's or a key for it is.
     */
    transcription?: boolean;
    /**
     * And the composer streams it for live text (CB-222): the server's
     * realtime socket is tried; recording, then sending, when it fails.
     */
    transcriptionStreaming?: boolean;
    /**
     * The backend calls use (CB-265), and whether each could take a call:
     * `voice` is the one in force; `voiceCloud`, OpenAI's (VOICE_API_KEY and
     * VOICE_MODEL), offered when a self-hosted call can't connect; and
     * `voiceSpeech`, a speech server for self-hosted calls (else this
     * device speaks).
     */
    voiceBackend?: VoiceBackend;
    voiceCloud?: boolean;
    voiceSpeech?: boolean;
    /** Channel state only; never the token or chat IDs. */
    telegram: TelegramStatus;
    /** The bot's @username once connected, for t.me links. */
    telegramBot?: string;
    missing: string[];
    /** Whether the signed-in user's chats have a model, and which. */
    inference?: InferenceAvailability;
    /**
     * Where the data space's files are (CB-54): the local disk, S3, or S3
     * that didn't answer its last request. Never endpoints or keys.
     */
    storage?: 'local' | 's3' | 's3_unreachable';
    /** The data encryption key (CB-62): admins only. */
    dataKey?: DataKeyStatus;
    /** Scheduled backups (CB-63): admins only. */
    backup?: BackupStatus;
    /** Registered datasets whose files are missing (CB-340): admins only. */
    datasetFiles?: DatasetFilesStatus;
    /** The Operations analytics store (CB-186): its mode and state. */
    analytics?: AnalyticsHealth;
}
/**
 * Registered datasets (deleted ones too) whose file is missing on disk
 * (CB-340): the count, their ids, and a warning when there are any.
 */
export interface DatasetFilesStatus {
    missing: number;
    ids: string[];
    warning?: string;
    /**
     * Analytical parts (CB-369) a dataset's catalog lists that aren't on
     * disk, and the datasets they belong to. Absent from older servers.
     */
    missingParts?: number;
    partDatasetIds?: string[];
    /** The datasets' analytics process (`DATA_ANALYTICS_MODE`), while it runs or restarts. */
    analytics?: {
        mode: 'child' | 'off';
        state: 'off' | 'idle' | 'running' | 'restarting';
        running: number;
        queued: number;
    };
}
/**
 * Whether DATA_ENCRYPTION_KEY is set, and how many files and stored
 * credentials the re-seal still has to move to it. Counts only.
 */
export interface DataKeyStatus {
    configured: boolean;
    /**
     * Still under the key from SESSION_SECRET, every purpose (CB-322):
     * SESSION_SECRET stays in the recovery kit until this is zero. Without a
     * data key, everything sealed is.
     */
    legacy: number;
    /** Still under DATA_ENCRYPTION_KEY_PREVIOUS. */
    previous: number;
    /** Under a key this server doesn't have: unreadable until it is back. */
    unknown: number;
    /** The current data key's id (CB-322): its fingerprint, never the key. */
    keyId?: string;
    /** DATA_ENCRYPTION_KEY_PREVIOUS's id, during a rotation. */
    previousKeyId?: string;
    /** The legacy count per seal purpose that has any (CB-322). */
    legacyByPurpose?: Partial<Record<SealPurposeName, number>>;
    /** "Re-seal under the data key" (CB-322): running now, and the last run since start. */
    reseal?: DataKeyResealStatus;
}
/** What a seal is for (the server's `SealPurpose`). */
export type SealPurposeName =
    | 'inference-credentials'
    | 'data-files'
    | 'backups'
    | 'push-keys'
    | 'dispatch-credentials'
    | 'settings-secrets'
    | 'mcp-credentials'
    // Socio Secrets: workloads' secrets.
    | 'workspace-secrets'
    // CB-326 step 6: coding session gateway exchange bodies (request
    // as-forwarded, response as-received), sealed in the object store,
    // soft-deleted with the session.
    | 'gateway-log';
/** The admin's re-seal (CB-322). Counts only. */
export interface DataKeyResealStatus {
    running: boolean;
    last?: {
        startedAt: number;
        finishedAt: number;
        resealed: number;
        /** Under a key this server doesn't have: left as they are. */
        unreadable: number;
        /** Files left for the next run (storage unreachable, a write to retry). */
        left: number;
        error?: string;
    };
}
/** The last scheduled or manual backup run (CB-63). Never paths or keys. */
export interface BackupStatus {
    /** BACKUP_INTERVAL_HOURS or an admin's; 0: scheduled backups are off. */
    intervalHours: number;
    /** Whether an off-site copy is configured (BACKUP_S3_ENDPOINT). */
    offsite: boolean;
    running: boolean;
    lastSuccessAt?: number;
    /** Bytes of the last successful backup on the backup volume. */
    lastSizeBytes?: number;
    /** The last failed run's time and short reason; cleared by a success. */
    lastErrorAt?: number;
    lastError?: string;
    /** The last off-site copy, when configured. */
    offsiteSuccessAt?: number;
    offsiteError?: string;
    /** The continuous copy, when LITESTREAM_REPLICA_DIR is set (CB-109). */
    continuous?: ContinuousCopyStatus;
    /** Restores from the continuous copy, tried on a schedule (CB-111). */
    restoreDrill?: RestoreDrillStatus;
    /** Installed plugins that keep state on their own volumes, and whether it is backed up (CB-458). */
    plugins?: PluginBackupStatus[];
}
/** The restore drill (CB-111): when it runs, and how the last one went. */
export interface RestoreDrillStatus {
    /** Every this many days; 0: only when an admin runs it. */
    intervalDays: number;
    running: boolean;
    last?: RestoreDrillResult;
    /** "Verify a recovery key" (CB-322): running now, and the last check since start. */
    keyCheck?: { running: boolean; last?: RecoveryKeyCheck };
}
/**
 * A recovery key check (CB-322): a key from escrow opening a sample of what
 * the latest restore holds. Names the key by its id only.
 */
export interface RecoveryKeyCheck {
    startedAt: number;
    durationMs: number;
    /** Every purpose with something under the key opened, and nothing failed. */
    ok: boolean;
    /** The key's id, its fingerprint. */
    keyId: string;
    /** Which of the server's keys it is: escrow should hold both while they're in use. */
    matches: 'current' | 'previous' | 'neither';
    /** Why the check couldn't run (the restore failed, say); no path or key. */
    error?: string;
    purposes: RecoveryKeyPurpose[];
}
/** One seal purpose in a recovery key check. */
export interface RecoveryKeyPurpose {
    purpose: SealPurposeName;
    /** Seals under the key that were tried. */
    sampled: number;
    opened: number;
    /** Tried but didn't open: the key doesn't match, or the seal is damaged. */
    failed: number;
    /** In the restored copy (or off-site, for backups) under another data key. */
    otherKey: number;
    /** Under the legacy key from SESSION_SECRET, which no data key opens. */
    legacy: number;
    /** Files whose object wasn't there to try. */
    missing?: number;
    /** true: opened and none failed; false: one failed; null: nothing under the key to try. */
    ok: boolean | null;
}
/** One drill: its restores, checked, and the latest one's rows against live. */
export interface RestoreDrillResult {
    startedAt: number;
    durationMs: number;
    ok: boolean;
    /** Why it failed, in short; no path or key. */
    error?: string;
    restores: RestoreDrillRestore[];
    /** Tables in the latest local restore. */
    tables?: number;
    /**
     * Tables whose rows differ from live by more than writes during the drill
     * explain (at most 20); only a gross difference fails the drill.
     */
    differences?: { table: string; live: number; restored: number }[];
}
/** One restore into a scratch file, then `PRAGMA integrity_check`. */
export interface RestoreDrillRestore {
    /** The local replica, or its off-site copy (newest lineage). */
    source: 'local' | 'offsite';
    /** A point in time; none: the latest. */
    pointAt?: number;
    ok: boolean;
    durationMs: number;
    error?: string;
}
/** Litestream's copy of the database (CB-109). Times only, never paths. */
export interface ContinuousCopyStatus {
    /** The newest copy in the replica. */
    lastCopiedAt?: number;
    /** The database's last write. */
    lastWriteAt?: number;
    /** A write is over 5 minutes newer than the newest copy, or has none. */
    behind: boolean;
    /**
     * How long a write has waited for a copy (CB-315): with a write newer
     * than the newest copy, the time since that copy; 0 when the copy covers
     * the last write; with no copy at all, since the server started.
     */
    lagMs?: number;
    /** The database's write-ahead log on disk, in bytes (CB-315). */
    walBytes?: number;
    /** The lag and the log against the thresholds in Settings (CB-315). */
    level?: import('./continuous-copy.js').CopyAlertLevel;
    /** Its files sent off-site, when the off-site copy is set up (CB-112). */
    offsite?: ContinuousOffsiteStatus;
}
/** The continuous copy's files, sealed and sent off-site (CB-112). */
export interface ContinuousOffsiteStatus {
    /** Every this many seconds; 0: off. */
    intervalSeconds: number;
    /** Everything Litestream had then is off-site: when the last full send started. */
    lastSentAt?: number;
    /** How long the newest copy has waited to go off-site; 0 when it is there. */
    lagMs: number;
    /** Files the last send left for the next one. */
    waiting: number;
    /** Sends that failed in a row; the next one waits longer each time. */
    failures: number;
    lastErrorAt?: number;
    lastError?: string;
    /** Failing, or a copy or a file has waited over the interval and 5 minutes. */
    behind: boolean;
}
/** `admin` > `member`; see roles.ts. The `operator` role was retired (CB-390). */
export type Role = 'admin' | 'member';
export interface User {
    id: string;
    name: string;
    role: Role;
}
export interface WorkspaceState {
    user: User;
    spaces: Space[];
    dots: Dot[];
    conversations: Conversation[];
    /**
     * The user's archived chats, the last archived first: not in
     * `conversations` (the sidebar, the palette, Home), but a link still
     * opens one (`findChat`), and Account → Archived chats lists them.
     */
    archived?: Conversation[];
    setup: SetupStatus;
    calls: CallReceipt[];
    /** Promoted mini apps this user may open: launcher and sidebar entries. */
    workspaceApps?: WorkspaceAppEntry[];
    /** Installed plugins this person may open (each install's audience). */
    plugins?: import('./plugins/plugins.js').PluginLauncherEntry[];
    /** The person's own preferences (`/api/preferences`). */
    preferences?: UserPreferences;
    /**
     * Feature flags for this person (CB-169), as the server evaluated them:
     * for showing only, the server checks each flag itself.
     */
    flags?: ClientFlags;
    /**
     * What this person may do, as the server decides it from their role and
     * the workspace's settings: for showing only, the server checks each
     * itself. Missing (an older server): none.
     */
    permissions?: WorkspacePermissions;
    /**
     * Whether a thumbs-down may carry an AI reply report (CB-382,
     * docs/specs/REPLY-REPORTS.md §1): `null` when sharing is off or this
     * server can't share. Missing (an older server): the same as `null`.
     */
    replyReports?: import('./chat/reply-reports.js').ReplyReportsState;
}

/** `WorkspaceState.permissions`. */
export interface WorkspacePermissions {
    /** Create Spaces (`spaces/create-permission.ts`). */
    createSpaces: boolean;
}
