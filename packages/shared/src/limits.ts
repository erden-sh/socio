/**
 * Limits an admin tunes in Settings → General instead of the environment
 * (CB-108): a stored number over the server's, which the matching variable
 * (or its built-in default) sets. One table drives the settings route's
 * validation and the Settings cards; the server applies a value where the
 * limit is enforced (`server/settings/limits.ts`).
 */
export interface LimitSpec {
    /** The variable whose value is the starting one. */
    env: string;
    label: string;
    /** Where it is entered: "minutes", "MB"… */
    unit: string;
    help: string;
    min: number;
    max: number;
    /** Cents, not just whole numbers. */
    cents?: boolean;
}

const spec = (value: LimitSpec) => value;

export const LIMIT_SPECS = {
    scheduleMinIntervalMinutes: spec({
        env: 'SCHEDULE_MIN_INTERVAL_MINUTES',
        label: 'Shortest gap between runs',
        unit: 'minutes',
        help: 'A schedule never runs sooner than this after its last run, and socios can’t set a faster one.',
        min: 1,
        max: 10_080,
    }),
    schedulesPerUser: spec({
        env: 'SCHEDULES_PER_USER',
        label: 'Active schedules per person',
        unit: 'schedules',
        help: 'How many schedules the socios of one person may have running.',
        min: 1,
        max: 1000,
    }),
    jobMaxTimeoutSeconds: spec({
        env: 'JOB_MAX_TIMEOUT_SECONDS',
        label: 'Longest job timeout',
        unit: 'seconds',
        help: 'The most time a job may ask for, starting its computer included. A job that runs until done asks for this much per batch.',
        min: 10,
        max: 21_600,
    }),
    jobConcurrency: spec({
        env: 'JOB_CONCURRENCY',
        label: 'Jobs running at once',
        unit: 'jobs',
        help: 'Across the whole workspace; more wait their turn.',
        min: 1,
        max: 32,
    }),
    jobsPerUser: spec({
        env: 'JOBS_PER_USER',
        label: 'Saved jobs per person',
        unit: 'jobs',
        help: 'How many jobs the socios of one person may keep.',
        min: 1,
        max: 1000,
    }),
    jobItemAttempts: spec({
        env: 'JOB_ITEM_ATTEMPTS',
        label: 'Tries per item',
        unit: 'tries',
        help: 'How many times a job that runs until done tries one item before it sets it aside as failed and goes on with the rest.',
        min: 1,
        max: 20,
    }),
    jobBatchRetries: spec({
        env: 'JOB_BATCH_RETRIES',
        label: 'Retries in a row',
        unit: 'batches',
        help: 'How many batches in a row may fail, make no progress or be refused by a source before a job that runs until done stops as failed. Each retry waits longer.',
        min: 0,
        max: 50,
    }),
    jobMaxBatches: spec({
        env: 'JOB_MAX_BATCHES',
        label: 'Batches per run',
        unit: 'batches',
        help: 'The most batches one run of a job that runs until done may take.',
        min: 1,
        max: 10_000,
    }),
    dataFileMaxMb: spec({
        env: 'DATA_FILE_MAX_MB',
        label: 'Largest file',
        unit: 'MB',
        help: 'For files in the data space and for chat attachments.',
        min: 1,
        // Files travel as base64 inside JSON, which breaks well before 1 GB.
        max: 250,
    }),
    dataDatasetMaxMb: spec({
        env: 'DATA_DATASET_MAX_MB',
        label: 'Largest dataset',
        unit: 'MB',
        help: 'What one dataset may grow to.',
        min: 1,
        max: 102_400,
    }),
    dataUserMaxMb: spec({
        env: 'DATA_USER_MAX_MB',
        label: 'Data per person',
        unit: 'MB',
        help: 'Datasets and files together, for each person.',
        min: 1,
        max: 1_048_576,
    }),
    dataMaxDatasets: spec({
        env: 'DATA_MAX_DATASETS',
        label: 'Datasets per person',
        unit: 'datasets',
        help: 'How many datasets one person may have.',
        min: 1,
        max: 10_000,
    }),
    // A company socio's shared area (CB-229): its computer's shared dataset
    // and files, which everyone who uses the socio reaches.
    dataSharedRetentionDays: spec({
        env: 'DATA_SHARED_RETENTION_DAYS',
        label: 'Keep shared items for',
        unit: 'days',
        help: 'A file in a company socio’s shared area, or its shared dataset, that nobody changed for this long is deleted (and kept, like anything deleted). 0 keeps them until someone deletes them.',
        min: 0,
        max: 3650,
    }),
    // Row stamps (CB-451): how long a deleted row's stamp is kept,
    // so an offline cache learns of the delete instead of reconciling.
    dataStampTombstoneDays: spec({
        env: 'DATA_STAMP_TOMBSTONE_DAYS',
        label: 'Remember deleted rows for',
        unit: 'days',
        help: 'How long the server remembers which dataset rows were deleted, for apps that keep a copy offline. A copy last synced longer ago than this checks every row it holds instead of only the changes.',
        min: 1,
        max: 3650,
    }),
    // A service plugin's own datasets (`plugin:<id>`, its manifest's
    // `datasets`): company data a plugin syncs, which no person's quota counts.
    dataPluginDatasetMaxMb: spec({
        env: 'DATA_PLUGIN_DATASET_MAX_MB',
        label: 'Largest plugin dataset',
        unit: 'MB',
        help: 'What one dataset a plugin owns may grow to. It counts against no person’s data.',
        min: 1,
        max: 102_400,
    }),
    dataPluginQueryMaxRows: spec({
        env: 'DATA_PLUGIN_QUERY_MAX_ROWS',
        label: 'Rows per query of a plugin dataset',
        unit: 'rows',
        help: 'The most rows one query of a plugin’s dataset returns, for the plugin, socios and people alike.',
        min: 1,
        max: 100_000,
    }),
    // CB-473: each plugin's data token has its own budget, apart from socios'.
    dataPluginStatementsPerMinute: spec({
        env: 'DATA_PLUGIN_STATEMENTS_PER_MINUTE',
        label: 'Data operations a minute per plugin',
        unit: 'operations',
        help: 'How many data operations one plugin’s token makes a minute: a query or a read batch is one, a write batch one per statement. A plugin’s page raises it for that plugin. Socios and people keep their own limit.',
        min: 1,
        max: 100_000,
    }),
    // Analytical tables (CB-369): append-only history in Parquet, queried
    // with DuckDB in the analytics process. Their bytes have a budget of
    // their own, apart from a person's data.
    dataAnalyticalMaxMb: spec({
        env: 'DATA_ANALYTICS_MAX_MB',
        label: 'Analytical data per owner',
        unit: 'MB',
        help: 'What the analytical tables of one owner (a person, a socio’s shared area or a plugin) may hold on disk, apart from that person’s data.',
        min: 1,
        max: 1_048_576,
    }),
    dataAnalyticsQueryTimeoutSeconds: spec({
        env: 'DATA_ANALYTICS_QUERY_TIMEOUT_SECONDS',
        label: 'Longest analytical query',
        unit: 'seconds',
        help: 'An analytical query that runs longer is stopped.',
        min: 1,
        max: 600,
    }),
    dataAnalyticsQueryMaxRows: spec({
        env: 'DATA_ANALYTICS_QUERY_MAX_ROWS',
        label: 'Rows per analytical query',
        unit: 'rows',
        help: 'The most rows one analytical query returns; the answer says when more were left out.',
        min: 1,
        max: 1_000_000,
    }),
    dataAppendMaxRows: spec({
        env: 'DATA_ANALYTICS_APPEND_MAX_ROWS',
        label: 'Rows per append',
        unit: 'rows',
        help: 'The most rows one append to an analytical table takes.',
        min: 1,
        max: 2_000_000,
    }),
    dataAnalyticsQueryMemoryMb: spec({
        env: 'DATA_ANALYTICS_QUERY_MEMORY_MB',
        label: 'Memory per analytical query',
        unit: 'MB',
        help: 'What one analytical query may use before it spills to disk. The analytics process needs this times the queries at once, plus about 256 MB.',
        min: 64,
        max: 65_536,
    }),
    dataAnalyticsQueryConcurrency: spec({
        env: 'DATA_ANALYTICS_QUERY_CONCURRENCY',
        label: 'Analytical queries at once',
        unit: 'queries',
        help: 'More wait their turn, up to 16; past that a query is refused until one finishes.',
        min: 1,
        max: 16,
    }),
    // CB-387: the retention of analytical tables whose plugin declares
    // none and that no admin overrode on the Data page.
    dataAnalyticsRetainDays: spec({
        env: 'DATA_ANALYTICS_RETAIN_DAYS',
        label: 'Keep analytical partitions for',
        unit: 'days',
        help: 'Partitions older than this are dropped each night from analytical tables whose plugin sets no retention and that no admin changed on the Data page. Backups still hold them for a while. 0 keeps everything.',
        min: 0,
        max: 36_500,
    }),
    dotModelRounds: spec({
        env: 'DOT_MAX_MODEL_ROUNDS',
        label: 'Model rounds per turn',
        unit: 'rounds',
        help: 'How many times a socio may call its model in one reply, tool rounds included. The last round has no tools: the socio says what it did and what is left. The turn time limit still applies.',
        min: 2,
        max: 200,
    }),
    // The deploy drain is this plus 20 s (`drainMsFromEnv`), under the stack's
    // 330 s `stop_grace_period`: 300 s is the most that fits, unless
    // SHUTDOWN_DRAIN_MS is set explicitly.
    turnTimeLimitSeconds: spec({
        env: 'TURN_TIME_LIMIT_SECONDS',
        label: 'Turn time limit',
        unit: 'seconds',
        help: 'How long one reply may run before it is stopped. Deploys wait up to this long for running replies to finish, so the most is 300 seconds. A reply already running keeps the limit it started with.',
        min: 30,
        max: 300,
    }),
    // The turn's note only (CB-173): never the system prompt, which stays the
    // same, byte for byte, whatever the value.
    turnRecallTokens: spec({
        env: 'TURN_RECALL_TOKENS',
        label: 'Recalled context per reply',
        unit: 'tokens',
        help: 'About how much of the person’s memories (and, in their own chats, episodes of their earlier chats) goes with each message they send. The pinned facts of a long chat that match the message grow and shrink in step. More helps socios recall; less keeps replies quicker and cheaper.',
        min: 250,
        max: 8_000,
    }),
    // Episodes (CB-180): what happened in each person's own chats, kept this
    // long after each last came up; the leader deletes older ones.
    episodeRetentionDays: spec({
        env: 'EPISODE_RETENTION_DAYS',
        label: 'Keep episodes for',
        unit: 'days',
        help: 'What socios remember of each person’s earlier chats (decisions, results, what a chat was about) is deleted once it hasn’t come up for this long. People can delete theirs sooner on the Memories page.',
        min: 1,
        max: 3650,
    }),
    // Space memory (CB-181): what is out of use (superseded, rejected,
    // withdrawn, retired) is kept this long; the leader deletes it after.
    spaceMemoryRetentionDays: spec({
        env: 'SPACE_MEMORY_RETENTION_DAYS',
        label: 'Keep retired Space memory for',
        unit: 'days',
        help: 'Earlier versions of each Space’s shared memory, proposals turned down or taken back, and entries its editors retired are deleted after this long. Entries in use are kept until an editor retires them; editors can delete a retired one sooner.',
        min: 1,
        max: 3650,
    }),
    // The person's messages waiting for a socio's next step (CB-151, CB-170).
    steeringMaxQueued: spec({
        env: 'STEERING_MAX_QUEUED',
        label: 'Queued messages per chat',
        unit: 'messages',
        help: 'How many messages one person may queue in a chat while the socio works. More stay in the message box until it has read some.',
        min: 1,
        max: 20,
    }),
    // Work cycles (CB-211): what one message
    // may lead to, in every chat and Telegram topic, and in rooms once they
    // come (a room admin may only lower these). Time is the turn time limit
    // and the queue the queued-message limit, above.
    roomCycleTokens: spec({
        env: 'ROOM_CYCLE_TOKENS',
        label: 'Tokens per message',
        unit: 'tokens',
        help: 'The most model tokens (in and out, retries and notes included) one message and the work it starts may use before the socio stops and says so. Each model request reserves its share first, so a request that would pass it is not sent.',
        min: 10_000,
        max: 20_000_000,
    }),
    roomMessagesPerMinute: spec({
        env: 'ROOM_MESSAGES_PER_MINUTE',
        label: 'Messages a minute per chat',
        unit: 'messages',
        help: 'How many messages a chat or Telegram topic takes in any minute, from everyone in it, queued ones included. More are turned away with a note to wait a moment.',
        min: 1,
        max: 600,
    }),
    // Counted from CB-211 on; socios hand work to each other in rooms
    // (CB-206): a socio's handoff and each further socio a message names.
    roomHandoffsPerCycle: spec({
        env: 'ROOM_HANDOFFS_PER_CYCLE',
        label: 'Handoffs per message',
        unit: 'handoffs',
        help: 'In a room with several socios: how many times one message’s work may pass from one socio to another, by a socio handing it on or by the message naming more than one socio. A socio never hands the same work to the same socio twice. 0 turns handoffs off. Room admins may lower it for their room.',
        min: 0,
        max: 20,
    }),
    roomCycleSpendUsd: spec({
        env: 'ROOM_CYCLE_SPEND_USD',
        label: 'Spend per message',
        unit: 'USD',
        help: 'The most one message’s model use may cost, where the model reports its cost; where it does not, tokens and time still bound it. 0 sets no spend cap.',
        min: 0,
        max: 1000,
        cents: true,
    }),
    // The continuous copy's alerts (CB-315): with Litestream on, the app
    // leaves checkpoints to it, so while it is down the WAL only grows and
    // writes go uncopied. Admins hear when either passes a threshold.
    copyLagWarnMinutes: spec({
        env: 'LITESTREAM_LAG_WARN_MINUTES',
        label: 'Copy behind: warning',
        unit: 'minutes',
        help: 'Admins are warned when the newest write is this much newer than the newest continuous copy.',
        min: 1,
        max: 1440,
    }),
    copyLagCriticalMinutes: spec({
        env: 'LITESTREAM_LAG_CRITICAL_MINUTES',
        label: 'Copy behind: critical',
        unit: 'minutes',
        help: 'Critical from this much behind: admins are reminded every hour until the copy catches up.',
        min: 1,
        max: 10_080,
    }),
    walWarnMb: spec({
        env: 'LITESTREAM_WAL_WARN_MB',
        label: 'Write-ahead log: warning',
        unit: 'MB',
        help: 'Admins are warned when the database’s write-ahead log grows to this size.',
        min: 16,
        max: 102_400,
    }),
    walCriticalMb: spec({
        env: 'LITESTREAM_WAL_CRITICAL_MB',
        label: 'Write-ahead log: critical',
        unit: 'MB',
        help: 'Critical from this size: admins are reminded every hour. If the copy has also been critically behind, the app checkpoints the log itself so the disk doesn’t fill.',
        min: 16,
        max: 102_400,
    }),
    // Plugin backups (CB-458): the most one plugin's snapshot may
    // hold. A snapshot over it fails, and admins hear why.
    pluginBackupMaxGb: spec({
        env: 'PLUGIN_BACKUP_MAX_GB',
        label: 'Largest snapshot per plugin',
        unit: 'GiB',
        help: 'The most one plugin’s backup may hold: the data on its own storage. A plugin over it isn’t backed up, and admins are told. Raise it for a plugin that keeps more.',
        min: 1,
        max: 10_240,
    }),
} as const satisfies Record<string, LimitSpec>;

export type LimitKey = keyof typeof LIMIT_SPECS;
export type LimitValues = Record<LimitKey, number>;
export const LIMIT_KEYS = Object.keys(LIMIT_SPECS) as LimitKey[];

/** The cards in Settings → General: a title, a line of help and the limits in it. */
export const LIMIT_GROUPS: {
    id: string;
    title: string;
    intro: string;
    keys: LimitKey[];
}[] = [
    {
        id: 'schedules-jobs',
        title: 'Schedules and jobs',
        intro: 'How often and how much socios may run on their own. Changes apply to the next run or request.',
        keys: [
            'scheduleMinIntervalMinutes',
            'schedulesPerUser',
            'jobMaxTimeoutSeconds',
            'jobConcurrency',
            'jobsPerUser',
            'jobItemAttempts',
            'jobBatchRetries',
            'jobMaxBatches',
        ],
    },
    {
        id: 'data-space',
        title: 'Data space',
        intro: 'How much each person may keep in datasets and files. Lowering a limit never deletes anything: it stops new data going over it.',
        keys: ['dataFileMaxMb', 'dataDatasetMaxMb', 'dataUserMaxMb', 'dataMaxDatasets', 'dataStampTombstoneDays'],
    },
    {
        id: 'shared-areas',
        title: 'Socios’ shared areas',
        intro: 'What a company socio’s computer keeps for everyone who uses the socio. People who use it, and admins, see and delete it under Data → Shared with socios.',
        keys: ['dataSharedRetentionDays'],
    },
    {
        id: 'plugin-datasets',
        title: 'Plugin datasets',
        intro: 'Datasets a plugin owns and fills, such as synced bookings or sales. Admins see and delete them on the Data page; disabling or uninstalling a plugin keeps them.',
        keys: ['dataPluginDatasetMaxMb', 'dataPluginQueryMaxRows', 'dataPluginStatementsPerMinute'],
    },
    {
        id: 'analytical-tables',
        title: 'Analytical tables',
        intro: 'Append-only history a plugin keeps in its datasets, such as daily occupancy or bookings, stored compressed beside the dataset and queried with DuckDB. Lowering a limit never deletes anything, except the retention, which drops older partitions at the next nightly run.',
        keys: [
            'dataAnalyticalMaxMb',
            'dataAnalyticsQueryTimeoutSeconds',
            'dataAnalyticsQueryMaxRows',
            'dataAppendMaxRows',
            'dataAnalyticsQueryMemoryMb',
            'dataAnalyticsQueryConcurrency',
            'dataAnalyticsRetainDays',
        ],
    },
    {
        id: 'dot-turns',
        title: 'Socio replies',
        intro: 'How much work a socio may do for one message before it reports back. Changes apply to the next reply.',
        keys: ['dotModelRounds', 'turnTimeLimitSeconds', 'turnRecallTokens', 'steeringMaxQueued'],
    },
    {
        id: 'memory',
        title: 'Memory',
        intro: 'What socios keep of each person’s own chats to recall in their other chats (never used in chats with other people in them), and how long each Space’s shared memory keeps what is out of use.',
        keys: ['episodeRetentionDays', 'spaceMemoryRetentionDays'],
    },
    {
        // The "Rooms" group: the bounds of each message's work.
        id: 'rooms',
        title: 'Work per message',
        intro: 'The most one message, and everything it starts, may use: in every chat and Telegram topic. The turn time limit above bounds its time, and the queued-message limit its queue. A socio that reaches one stops and says which. Changes apply to the next message.',
        keys: ['roomCycleTokens', 'roomMessagesPerMinute', 'roomCycleSpendUsd', 'roomHandoffsPerCycle'],
    },
    {
        id: 'continuous-copy',
        title: 'Continuous copy alerts',
        intro: 'When the server keeps a continuous copy of its database (Litestream), admins are notified once the copy falls behind or the write-ahead log grows past these, again when it gets worse, and once it recovers. Changes apply to the next check, within a minute.',
        keys: ['copyLagWarnMinutes', 'copyLagCriticalMinutes', 'walWarnMb', 'walCriticalMb'],
    },
    {
        id: 'plugin-backups',
        title: 'Plugin backups',
        intro: 'Plugins that keep data on their own storage are backed up with every scheduled backup. Changes apply to the next snapshot.',
        keys: ['pluginBackupMaxGb'],
    },
];

/** Whether `value` is allowed for the limit. */
export function validLimit(key: LimitKey, value: unknown): value is number {
    const { min, max, cents }: LimitSpec = LIMIT_SPECS[key];
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        (cents ? Math.round(value * 100) / 100 === value : Number.isInteger(value))
    );
}
