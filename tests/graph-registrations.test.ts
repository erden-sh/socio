// What the app's graph builds, pinned as literals, for the PRs that delete
// `Platform` to keep unchanged: the listeners and hooks it registers, in
// order; the tags its context offers; and how many times the services with
// side effects at construction are built.
import { afterEach, expect, it, vi } from 'vitest';

import { recordRegistrations } from './helpers/registrations.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

/** How many of each were constructed (or, for `ChannelServices`, built) since the last reset. */
const built = vi.hoisted(() => {
    const counts = { CodingSessions: 0, ApprovalService: 0, VoiceService: 0, ChannelServices: 0 };
    /** `Base`, counting each construction under `name`; its name stays the same. */
    const counted = <C extends abstract new (...args: never[]) => object>(Base: C, name: keyof typeof counts): C => {
        const Counted = class extends (Base as unknown as new (...args: unknown[]) => object) {
            constructor(...args: unknown[]) {
                super(...args);
                counts[name]++;
            }
        };
        Object.defineProperty(Counted, 'name', { value: Base.name });
        return Counted as unknown as C;
    };
    return { counts, counted };
});

vi.mock('../src/server/coding/sessions.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/server/coding/sessions.js')>();
    return { ...actual, CodingSessions: built.counted(actual.CodingSessions, 'CodingSessions') };
});
vi.mock('../src/server/approvals/service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/server/approvals/service.js')>();
    return { ...actual, ApprovalService: built.counted(actual.ApprovalService, 'ApprovalService') };
});
vi.mock('../src/server/voice/voice.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/server/voice/voice.js')>();
    return { ...actual, VoiceService: built.counted(actual.VoiceService, 'VoiceService') };
});
vi.mock('../src/server/telegram/layer.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/server/telegram/layer.js')>();
    const { Effect } = await import('effect');
    return {
        ...actual,
        ChannelServicesLive: ((workspace: Parameters<typeof actual.ChannelServicesLive>[0]) =>
            actual.ChannelServicesLive(
                Effect.tap(workspace, () =>
                    Effect.sync(() => {
                        built.counts.ChannelServices++;
                    }),
                ),
            )) as typeof actual.ChannelServicesLive,
    };
});

/**
 * Every tag the built context offered on `main` at 0c02ab99, sorted, less
 * Effect's own memo map and the scaffolding those PRs delete
 * (`socio/LegacyPlatform`, `socio/composition/PlatformSelf`,
 * `socio/composition/Assembly`). A PR that removes one on purpose deletes
 * it here and says why.
 */
const TAGS = [
    'socio/actors/ActorAccess',
    'socio/actors/ActorActions',
    'socio/actors/ActorServices',
    'socio/actors/Actors',
    'socio/actors/ActorsConfig',
    'socio/actors/AppActors',
    'socio/agents/AgentGrantsService',
    'socio/agents/AgentTokens',
    'socio/agents/GrantAdmin',
    'socio/agents/Grants',
    'socio/approvals/ApprovalContinuations',
    'socio/approvals/ApprovalService',
    'socio/approvals/Approvals',
    'socio/approvals/ApprovalsConfig',
    'socio/approvals/ApprovalsViews',
    'socio/approvals/ApprovalsWorkspace',
    'socio/approvals/Continuations',
    'socio/apps/AppExtractionDelivery',
    'socio/apps/Apps',
    'socio/apps/AppsConfig',
    'socio/apps/AppsService',
    'socio/apps/AppsTelegram',
    'socio/ask/Ask',
    'socio/auth/AccessPolicyReader',
    'socio/auth/Auth',
    'socio/auth/AuthConfig',
    'socio/auth/AuthViews',
    'socio/auth/RequestUsers',
    'socio/capabilities/Capabilities',
    'socio/capabilities/CapabilitiesConfig',
    'socio/chat-name-suggestions/ChatNames',
    'socio/chat-name-suggestions/SuggestionsRepo',
    'socio/chat-name-suggestions/ThreadTitles',
    'socio/classify/ClassifyConfig',
    'socio/classify/ClassifyHost',
    'socio/classify/Labels',
    'socio/classify/Seam',
    'socio/coding/CodingConfig',
    'socio/coding/CodingGateway',
    'socio/coding/CodingSessions',
    'socio/coding/GatewayExchanges',
    'socio/coding/Sessions',
    'socio/coding/Tools',
    'socio/composition/Config',
    'socio/composition/ModuleContext',
    'socio/composition/ModuleHost',
    'socio/composition/Ports',
    'socio/composition/Runner',
    'socio/composition/Store',
    'socio/composition/Workspace',
    'socio/composition/capabilities/CapabilityRegistry',
    'socio/composition/chat-name-suggestions/ChatNameSuggestions',
    'socio/composition/chat-name-suggestions/ThreadTitler',
    'socio/composition/computers/ComputerService',
    'socio/composition/context/SteeringTurns',
    'socio/composition/cycles/WorkCycles',
    'socio/composition/domains/DomainsService',
    'socio/composition/dots/DotExtensions',
    'socio/composition/dots/RequestSenders',
    'socio/composition/dots/RuntimeHandler',
    'socio/composition/flags/FlagService',
    'socio/composition/github/GitHubAppSettings',
    'socio/composition/inference/SharedBackend',
    'socio/composition/keys/PlatformKeys',
    'socio/composition/operations/ResourcePolicy',
    'socio/composition/pages/PageService',
    'socio/composition/spaces/SpaceCreation',
    'socio/composition/updates/UpdateService',
    'socio/composition/voice/TranscriptionKeys',
    'socio/composition/voice/VoiceService',
    'socio/composition/workspace-secrets/WorkspaceSecrets',
    'socio/computers/ComputerRecords',
    'socio/computers/ComputerWork',
    'socio/computers/Computers',
    'socio/computers/ComputersConfig',
    'socio/computers/Screenshots',
    'socio/context/ChatNotes',
    'socio/context/ContextConfig',
    'socio/context/ContextFitting',
    'socio/context/DotReplies',
    'socio/context/Reactions',
    'socio/context/SharedChats',
    'socio/context/Steering',
    'socio/context/TimeMarkers',
    'socio/context/WaitingTurns',
    'socio/cycles/CycleUpkeep',
    'socio/cycles/Cycles',
    'socio/dataspace/Data',
    'socio/dataspace/DataConfig',
    'socio/dataspace/DataSpaceInstance',
    'socio/dataspace/DataViewPages',
    'socio/dataspace/DatasetViewTools',
    'socio/dataspace/DataspaceViews',
    'socio/docs/Docs',
    'socio/domains/Domains',
    'socio/domains/DomainsConfig',
    'socio/dots/DotAgents',
    'socio/dots/DotsConfig',
    'socio/dots/TurnExtensions',
    'socio/flags/FlagAdmin',
    'socio/flags/Flags',
    'socio/flags/FlagsConfig',
    'socio/flags/FlagsWorkspace',
    'socio/gateway/Gateway',
    'socio/gateway/GatewayConfig',
    'socio/gateway/GatewaySources',
    'socio/gateway/HostedGateway',
    'socio/github/GitHubAdmin',
    'socio/github/GitHubClients',
    'socio/github/GitHubConfig',
    'socio/github/GitHubSettings',
    'socio/inference/Inference',
    'socio/inference/InferenceConfig',
    'socio/inference/InferenceRegistry',
    'socio/inference/InferenceViews',
    'socio/inference/SettingsInference',
    'socio/integrations/ComputerAuditRepo',
    'socio/integrations/ComputerPermissionsRepo',
    'socio/integrations/DomainHostsRepo',
    'socio/integrations/DomainOpsRepo',
    'socio/integrations/TelegramConversationsRepo',
    'socio/integrations/TelegramLinksRepo',
    'socio/integrations/TelegramRepliesRepo',
    'socio/integrations/TelegramRoomCodesRepo',
    'socio/integrations/TelegramTopicSendersRepo',
    'socio/integrations/WebAuditRepo',
    'socio/integrations/WebIdentitiesRepo',
    'socio/issues/AgentRunner',
    'socio/issues/AutoTriageControl',
    'socio/issues/AutoTriageInstance',
    'socio/issues/Board',
    'socio/issues/Deliveries',
    'socio/issues/Goals',
    'socio/issues/IssueBoard',
    'socio/issues/IssueRunTraces',
    'socio/issues/IssuesBackground',
    'socio/issues/IssuesConfig',
    'socio/issues/IssuesViews',
    'socio/issues/Leadership',
    'socio/issues/MediaFiles',
    'socio/issues/SqliteBoardService',
    'socio/issues/TelegramDirect',
    'socio/learning/Evidence',
    'socio/learning/Learning',
    'socio/learning/LearningAnalysis',
    'socio/learning/LearningViews',
    'socio/learning/SkillDelivery',
    'socio/learning/Skills',
    'socio/live/Counters',
    'socio/mcp/Connections',
    'socio/mcp/McpConfig',
    'socio/mcp/McpConnectionsService',
    'socio/mcp/McpOAuthService',
    'socio/mcp/McpRuntimeService',
    'socio/mcp/Tools',
    'socio/media/Media',
    'socio/media/MediaConfig',
    'socio/media/MediaService',
    'socio/media/MediaViews',
    'socio/memory/Episodes',
    'socio/memory/MemoriesView',
    'socio/memory/MemoryConfig',
    'socio/memory/MemoryItems',
    'socio/memory/MemorySpaces',
    'socio/memory/MemoryTelegram',
    'socio/memory/Profiles',
    'socio/memory/SpaceMemories',
    'socio/memory/SpaceMemory',
    'socio/memory/TimeZoneNotes',
    'socio/memory/TimeZones',
    'socio/memory/TurnMemory',
    'socio/notifications/AppDeliveries',
    'socio/notifications/InAppNotices',
    'socio/notifications/NotificationChannels',
    'socio/notifications/NotificationGoals',
    'socio/notifications/NotificationsConfig',
    'socio/notifications/NotificationsService',
    'socio/notifications/Notifier',
    'socio/notifications/PushKeys',
    'socio/notifications/UserPresence',
    'socio/operations/AccessAudit',
    'socio/operations/Analytics',
    'socio/operations/AnalyticsStore',
    'socio/operations/CoverageModules',
    'socio/operations/OperationsBackups',
    'socio/operations/OperationsConfig',
    'socio/operations/Resources',
    'socio/operations/RunSource',
    'socio/pages/PageConversations',
    'socio/pages/PageMoves',
    'socio/pages/PageStore',
    'socio/pages/PageTools',
    'socio/pages/PagesViews',
    'socio/plugins/PluginCatalog',
    'socio/plugins/PluginService',
    'socio/plugins/Plugins',
    'socio/plugins/PluginsConfig',
    'socio/plugins/PluginsInApps',
    'socio/replay/EventReplay',
    'socio/replay/Replayer',
    'socio/rooms/Access',
    'socio/rooms/Notices',
    'socio/rooms/Orchestrator',
    'socio/rooms/ReaderEvents',
    'socio/rooms/Reads',
    'socio/rooms/RoomEvents',
    'socio/rooms/RoomMembership',
    'socio/rooms/RoomNotices',
    'socio/rooms/RoomOrchestrator',
    'socio/rooms/RoomPinRoutes',
    'socio/rooms/RoomStreams',
    'socio/rooms/RoomTopics',
    'socio/rooms/Rooms',
    'socio/rooms/RoomsAccessAudit',
    'socio/rooms/RoomsConfig',
    'socio/rooms/RoomsSwitch',
    'socio/rooms/RoomsTelegram',
    'socio/rooms/RoomsWorkspace',
    'socio/rooms/Streams',
    'socio/rooms/Topics',
    'socio/runs/RunRefs',
    'socio/runs/RunsViews',
    'socio/runtime/Lifecycle',
    'socio/runtime/RuntimeConfig',
    'socio/runtime/RuntimeIdentity',
    'socio/schedules/GoalService',
    'socio/schedules/Goals',
    'socio/schedules/JobService',
    'socio/schedules/Jobs',
    'socio/schedules/LongRunReporting',
    'socio/schedules/LongRunReports',
    'socio/schedules/LongRunService',
    'socio/schedules/LongRuns',
    'socio/schedules/ScheduleBoard',
    'socio/schedules/ScheduleData',
    'socio/schedules/ScheduleDetails',
    'socio/schedules/ScheduleService',
    'socio/schedules/ScheduleStore',
    'socio/schedules/Schedules',
    'socio/schedules/SchedulesConfig',
    'socio/schedules/SchedulesHost',
    'socio/schedules/SchedulesViews',
    'socio/schedules/TaskClaims',
    'socio/schedules/Tasks',
    'socio/search/SearchConfig',
    'socio/search/WebSearch',
    'socio/service-accounts/Accounts',
    'socio/service-accounts/ServiceAccountsService',
    'socio/settings/Limits',
    'socio/settings/SecretSettings',
    'socio/settings/SettingsConfig',
    'socio/settings/WorkspaceSettings',
    'socio/skills/Compact',
    'socio/skills/SkillRegistry',
    'socio/skills/SkillSessions',
    'socio/skills/UnfurlTools',
    'socio/skills/WorkspaceSkills',
    'socio/souls/SoulTools',
    'socio/souls/Souls',
    'socio/spaces/Access',
    'socio/spaces/Creation',
    'socio/spaces/SpacePages',
    'socio/storage/FileMoves',
    'socio/storage/ObjectStores',
    'socio/storage/StorageConfig',
    'socio/telegram/ChannelServices',
    'socio/telegram/Links',
    'socio/telegram/TelegramConfig',
    'socio/telegram/TelegramHost',
    'socio/turns/Runner',
    'socio/turns/TraceExporter',
    'socio/updates/Releases',
    'socio/updates/Updates',
    'socio/updates/UpdatesConfig',
    'socio/voice/Dictation',
    'socio/voice/Transcription',
    'socio/voice/TranscriptionSecrets',
    'socio/voice/Voice',
    'socio/voice/VoiceConfig',
    'socio/web/WebCapabilities',
    'socio/web/WebConfig',
    'socio/web/WebDatabase',
    'socio/web/WebIdentities',
    'socio/web/WebReader',
    'socio/workspace-secrets/Secrets',
    'socio/workspace-secrets/SecretsAdmin',
    'socio/workspace/Audit',
    'socio/workspace/ChatHistory',
    'socio/workspace/Conversations',
    'socio/workspace/People',
    'socio/workspace/PeopleSync',
    'socio/workspace/Socios',
    'socio/workspace/Spaces',
    'socio/workspace/WorkspaceViews',
];

afterEach(() => {
    vi.restoreAllMocks();
    for (const name of Object.keys(built.counts) as Array<keyof typeof built.counts>) {
        built.counts[name] = 0;
    }
});

it('registers its listeners and hooks in this order', async () => {
    const calls = recordRegistrations({ by: 'site' });
    const { dispose } = await makeTestRuntime({ app: {} });
    try {
        expect(calls).toMatchInlineSnapshot(`
          [
            "setCycleGate <- (src/server/composition/cycles.ts)",
            "onAccessChange <- makeActors (src/server/actors/layer.ts)",
            "onSettled <- workspaceApprovals (src/server/approvals/services.ts)",
            "useRooms <- roomsSwitch (src/server/rooms/layer.ts)",
            "onAccessChange <- roomStreams (src/server/rooms/layer.ts)",
            "onRunFinished <- new RoomOrchestrator (src/server/rooms/orchestrator.ts)",
            "onSpaceAccessChange <- makeApps (src/server/apps/layer.ts)",
            "onPending <- approvalNotices (src/server/approvals/notices.ts)",
            "onSettled <- new ApprovalContinuations (src/server/approvals/continue.ts)",
            "onRunFinished <- new ApprovalContinuations (src/server/approvals/continue.ts)",
            "onRunFinished <- new SteeringTurns (src/server/context/steering-turns.ts)",
            "onRunFinished <- roomNotices (src/server/rooms/layer.ts)",
            "onRunFinished <- ThreadTitler.attach (src/server/chat-name-suggestions/thread-titles.ts)",
            "onRunFinished <- ChatNameSuggestions.attach (src/server/chat-name-suggestions/service.ts)",
            "onRunFinished <- recordEvidence (src/server/learning/layer.ts)",
            "onRunFinished <- logFinishedTurns (src/server/turns/finished-turns.ts)",
            "onRunFinished <- new LongRunReports (src/server/schedules/long-run-reports.ts)",
            "onPending <- new VoiceService (src/server/voice/voice.ts)",
          ]
        `);
    } finally {
        await dispose();
    }
});

it('offers every tag it offered before Platform was deleted', async () => {
    const { runtime, dispose } = await makeTestRuntime({ app: {} });
    try {
        const keys = new Set((await runtime.context()).mapUnsafe.keys());
        // Each tag is a service other code reads: none may go missing. New
        // tags (the services `Platform`'s own code moves into) are fine.
        expect(TAGS.filter((key) => !keys.has(key))).toEqual([]);
    } finally {
        await dispose();
    }
});

it('builds each service with side effects at construction once', async () => {
    const { dispose } = await makeTestRuntime({ app: {} });
    try {
        expect(built.counts).toEqual({ CodingSessions: 1, ApprovalService: 1, VoiceService: 1, ChannelServices: 1 });
    } finally {
        await dispose();
    }
});
