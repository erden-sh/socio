// The tests' view of the app's runtime: the members and methods `Platform`
// had, with the same names and the same instances, read from the services the
// graph built. The server has no such object: it reads the tags.
// `makeTestRuntime().platform` is one, so the tests that read
// `platform.<member>` or spy on its services didn't change when `Platform`
// went.
import type { CopilotHonoApp } from '@copilotkit/runtime/v2';
import { Context } from 'effect';

import type { OtlpExporter } from '@socio/foundation/observability/otel-export';
import type { TranscriptionSources } from '@socio/foundation/voice/transcription-provider';
import type { ModelChoice } from '@socio/shared/inference';
import type {
    AgentRunSource,
    ConversationDeletion,
    DataKeyStatus,
    RecoveryKeyCheck,
    SetupStatus,
} from '@socio/shared/types';

import type { ActorAccess } from '../../src/server/actors/service.js';
import { AgentTokens, type AgentDocsCatalog, type AgentTokenResolver } from '../../src/server/agents/contract.js';
import type { AgentGrants } from '../../src/server/agents/grants.js';
import type { ApprovalContinuations } from '../../src/server/approvals/continue.js';
import type { ApprovalService } from '../../src/server/approvals/service.js';
import { AppExtractionDelivery } from '../../src/server/apps/contract.js';
import type { AppsService } from '../../src/server/apps/service.js';
import type { BackupService } from '../../src/server/backup/backup-service.js';
import type { CapabilityRegistry } from '../../src/server/capabilities/registry.js';
import { SuggestionsRepo, type ChatNameSuggestionRepository } from '../../src/server/chat-name-suggestions/contract.js';
import type { ChatNameSuggestions } from '../../src/server/chat-name-suggestions/service.js';
import type { ThreadTitler } from '../../src/server/chat-name-suggestions/thread-titles.js';
import { LegacyActors } from '../../src/server/composition/actors.js';
import { LegacyAgentGrants } from '../../src/server/composition/agents.js';
import {
    ConversationAdmin,
    runSourceOf,
    type ConversationAdminShape,
} from '../../src/server/composition/app/conversations.js';
import { DataKeyAdmin, type ResealOutcome } from '../../src/server/composition/app/data-keys.js';
import { AdminNotices } from '../../src/server/composition/app/notices.js';
import { RoomWork } from '../../src/server/composition/app/room-work.js';
import { AppStatus } from '../../src/server/composition/app/status.js';
import { AppTurns } from '../../src/server/composition/app/turns.js';
import { LeaderWork } from '../../src/server/composition/app/work.js';
import { LegacyApprovals, LegacyContinuations } from '../../src/server/composition/approvals.js';
import { LegacyApps } from '../../src/server/composition/apps.js';
import {
    LegacyConfig,
    LegacyModuleContext,
    LegacyRunner,
    LegacyStore,
    LegacyWorkspace,
    ModuleHost,
    type PlatformNotice,
} from '../../src/server/composition/base.js';
import { LegacyCapabilities } from '../../src/server/composition/capabilities.js';
import { LegacyChatNames, LegacyThreadTitles } from '../../src/server/composition/chat-name-suggestions.js';
import { LegacyComputers } from '../../src/server/composition/computers.js';
import type { PlatformConfig } from '../../src/server/composition/config.js';
import { LegacySteering } from '../../src/server/composition/context.js';
import { LegacyCycles } from '../../src/server/composition/cycles.js';
import { LegacyData } from '../../src/server/composition/dataspace.js';
import { LegacyDomains } from '../../src/server/composition/domains.js';
import { LegacyDotExtensions, LegacyRuntimeHandler } from '../../src/server/composition/dots.js';
import { LegacyFlags } from '../../src/server/composition/flags.js';
import type { GatewayAdopted } from '../../src/server/composition/gateway.js';
import { LegacyGitHub } from '../../src/server/composition/github.js';
import { LegacyInference } from '../../src/server/composition/inference.js';
import { LegacyAutoTriage } from '../../src/server/composition/issues.js';
import { LegacyLearning } from '../../src/server/composition/learning.js';
import { LegacyMcpConnections, LegacyMcpOAuth, LegacyMcpRuntime } from '../../src/server/composition/mcp.js';
import { LegacyMedia } from '../../src/server/composition/media.js';
import { LegacyNotifications } from '../../src/server/composition/notifications.js';
import { LegacyAnalytics } from '../../src/server/composition/operations.js';
import { LegacyPages } from '../../src/server/composition/pages.js';
import { LegacyPlugins } from '../../src/server/composition/plugins.js';
import { Ports, type PlatformPorts } from '../../src/server/composition/ports.js';
import {
    LegacyOrchestrator,
    LegacyRoomNotices,
    LegacyRooms,
    LegacyRoomStreams,
    LegacyRoomTopics,
} from '../../src/server/composition/rooms.js';
import {
    LegacyGoals,
    LegacyJobs,
    LegacyLongRunReports,
    LegacyLongRuns,
    LegacySchedules,
} from '../../src/server/composition/schedules.js';
import { LegacyServiceAccounts } from '../../src/server/composition/service-accounts.js';
import { LegacySpaceCreation } from '../../src/server/composition/spaces.js';
import { LegacyTraceExporter } from '../../src/server/composition/turns.js';
import { LegacyUpdates } from '../../src/server/composition/updates.js';
import { LegacyTranscriptionKeys } from '../../src/server/composition/voice.js';
import type { AppWorkspace as WorkspaceStore } from '../../src/server/composition/workspace-parts.js';
import { LegacyWorkspaceSecrets } from '../../src/server/composition/workspace-secrets.js';
import type { ComputerService } from '../../src/server/computers/computer-service.js';
import type { SteeringTurns } from '../../src/server/context/steering-turns.js';
import type { WorkCycles } from '../../src/server/cycles/service.js';
import type { DataSpace } from '../../src/server/dataspace/space.js';
import type { DomainsService } from '../../src/server/domains/service.js';
import type { DotExtensions } from '../../src/server/dots/contract.js';
import type { FlagService } from '../../src/server/flags/service.js';
import { HostedGateway } from '../../src/server/gateway/adopted.js';
import type { GitHubAppSettings } from '../../src/server/github/settings.js';
import type { InferenceService } from '../../src/server/inference/service.js';
import type { AutoTriage } from '../../src/server/issues/auto-triage.js';
import { Leadership, type IssuesLeadership } from '../../src/server/issues/contract.js';
import { SqliteBoardService } from '../../src/server/issues/layer.js';
import type { SqliteBoard } from '../../src/server/issues/services.js';
import type { LearningAnalysis } from '../../src/server/learning/analysis.js';
import { startAppRuntime, type AppBoot, type AppServices } from '../../src/server/main.js';
import type { McpConnections } from '../../src/server/mcp/connections.js';
import type { McpOAuth } from '../../src/server/mcp/oauth.js';
import type { McpRuntime } from '../../src/server/mcp/runtime.js';
import type { MediaService } from '../../src/server/media/service.js';
import type { ModuleContext, ServerModule } from '../../src/server/modules/contract.js';
import type { NotificationService } from '../../src/server/notifications/service.js';
import type { AnalyticsClient } from '../../src/server/operations/analytics/client.js';
import { PageMoves, type PageMovesShape } from '../../src/server/pages/contract.js';
import type { PageService } from '../../src/server/pages/page-service.js';
import type { PluginService } from '../../src/server/plugins/service.js';
import type { RoomMembership } from '../../src/server/rooms/membership.js';
import type { RoomNotices } from '../../src/server/rooms/notices.js';
import type { RoomOrchestrator } from '../../src/server/rooms/orchestrator.js';
import type { RoomStreams } from '../../src/server/rooms/streams.js';
import type { RoomTopics } from '../../src/server/rooms/telegram-topics.js';
import type { GoalService } from '../../src/server/schedules/goals.js';
import type { JobService } from '../../src/server/schedules/jobs.js';
import { SchedulesHost } from '../../src/server/schedules/layer.js';
import type { LongRunReports } from '../../src/server/schedules/long-run-reports.js';
import type { LongRunService } from '../../src/server/schedules/long-runs.js';
import type { ScheduleService } from '../../src/server/schedules/service.js';
import type { SchedulesStore } from '../../src/server/schedules/slices.js';
import type { ServiceAccounts } from '../../src/server/service-accounts/service-accounts.js';
import type { SpaceCreation } from '../../src/server/spaces/create.js';
import type { TelegramChannel } from '../../src/server/telegram/telegram-channel.js';
import type { PlatformTurnOptions, TurnOutcome } from '../../src/server/turns/contract.js';
import type { LocalAgentRunner } from '../../src/server/turns/local-runner.js';
import type { UpdateService } from '../../src/server/updates/service.js';
import { Dictation, type DictationShape } from '../../src/server/voice/contract.js';
import type { TranscriptionKeys } from '../../src/server/voice/transcription.js';
import type { WorkspaceSecrets } from '../../src/server/workspace-secrets/service.js';

import type { Store } from './stores.js';

/**
 * The app's services as `Platform` held them, read once from the context
 * the server's graph built (before a test's fakes): each member is the
 * graph's own instance, so a spy on it sees the graph's calls. The members
 * are plain fields a test may replace on this view (that changes nothing
 * the graph reads). `telegram`, `backups` and `draining` read and write
 * the graph's ports; `docs` reads its port. The methods delegate to the
 * services that hold the code now (`composition/app/`), each returning the
 * service's own promise, as `Platform`'s did (`handle`, `turn` and
 * `turnOutcome` were `async` there, and stay so).
 */
export class TestPlatform {
    readonly store: Store;
    readonly workspace: WorkspaceStore;
    readonly config: PlatformConfig;
    readonly runner: LocalAgentRunner;
    readonly modules: readonly ServerModule[];
    readonly context: ModuleContext;
    readonly board: SqliteBoard;
    readonly pageMoves: PageMovesShape;
    readonly issuesLeadership: IssuesLeadership;
    readonly cycles: WorkCycles;
    readonly flags: FlagService;
    readonly mcpConnections: McpConnections;
    readonly mcpOAuth: McpOAuth;
    readonly mcpRuntime: McpRuntime;
    readonly actors: ActorAccess;
    readonly inference: InferenceService;
    readonly approvals: ApprovalService;
    readonly spaceCreation: SpaceCreation;
    readonly serviceAccounts: ServiceAccounts;
    readonly roomStreams: RoomStreams;
    readonly rooms: RoomMembership;
    readonly roomTopics: RoomTopics;
    readonly orchestrator: RoomOrchestrator;
    readonly agentGrants: AgentGrants;
    readonly agentTokens?: AgentTokenResolver;
    readonly data: DataSpace;
    readonly media: MediaService;
    readonly notifications: NotificationService;
    readonly apps: AppsService;
    readonly workspaceSecrets: WorkspaceSecrets;
    readonly plugins: PluginService;
    readonly analytics?: AnalyticsClient;
    readonly domains: DomainsService;
    readonly updates: UpdateService;
    readonly capabilities: CapabilityRegistry;
    readonly dotExtensions: DotExtensions;
    readonly continuations: ApprovalContinuations;
    readonly steering: SteeringTurns;
    readonly roomNotices: RoomNotices;
    readonly titles: ThreadTitler;
    readonly chatNamesRepo: ChatNameSuggestionRepository;
    readonly chatNames: ChatNameSuggestions;
    readonly learning: LearningAnalysis;
    readonly autoTriage: AutoTriage;
    readonly traceExporter?: OtlpExporter;
    readonly transcriptionKeys: TranscriptionKeys;
    readonly github: GitHubAppSettings;
    readonly computers: ComputerService;
    readonly jobs: JobService;
    readonly longRuns: LongRunService;
    readonly longRunReports: LongRunReports;
    readonly schedules: ScheduleService;
    /** The view of the core store the schedules layers were handed (`SchedulesHost.store`). */
    readonly scheduleStore: SchedulesStore;
    readonly goals: GoalService;
    readonly pages: PageService;
    readonly handler: CopilotHonoApp;
    readonly gatewayAdopted: GatewayAdopted;
    readonly dictationStreams: DictationShape;
    private readonly ports: PlatformPorts;

    constructor(private readonly built: Context.Context<AppServices>) {
        const get = <I, S>(tag: Context.Key<I, S>) => Context.getUnsafe(built as Context.Context<never>, tag);
        const maybe = <I, S>(tag: Context.Key<I, S>) => Context.getOrUndefined(built as Context.Context<never>, tag);
        this.ports = get(Ports);
        // The tests' runtime hands the root the tests' `Store` (`stores.ts`).
        this.store = get(LegacyStore) as Store;
        this.workspace = get(LegacyWorkspace);
        this.config = get(LegacyConfig);
        this.runner = get(LegacyRunner);
        this.modules = get(ModuleHost).use((modules) => modules);
        this.context = get(LegacyModuleContext);
        this.board = get(SqliteBoardService);
        this.pageMoves = get(PageMoves);
        this.issuesLeadership = get(Leadership);
        this.cycles = get(LegacyCycles);
        this.flags = get(LegacyFlags);
        this.mcpConnections = get(LegacyMcpConnections);
        this.mcpOAuth = get(LegacyMcpOAuth);
        this.mcpRuntime = get(LegacyMcpRuntime);
        this.actors = get(LegacyActors);
        this.inference = get(LegacyInference);
        this.approvals = get(LegacyApprovals);
        this.spaceCreation = get(LegacySpaceCreation);
        this.serviceAccounts = get(LegacyServiceAccounts);
        this.roomStreams = get(LegacyRoomStreams);
        this.rooms = get(LegacyRooms);
        this.roomTopics = get(LegacyRoomTopics);
        this.orchestrator = get(LegacyOrchestrator);
        this.agentGrants = get(LegacyAgentGrants);
        this.agentTokens = maybe(AgentTokens);
        this.data = get(LegacyData);
        this.media = get(LegacyMedia);
        this.notifications = get(LegacyNotifications);
        this.apps = get(LegacyApps);
        this.workspaceSecrets = get(LegacyWorkspaceSecrets);
        this.plugins = get(LegacyPlugins);
        this.analytics = maybe(LegacyAnalytics);
        this.domains = get(LegacyDomains);
        this.updates = get(LegacyUpdates);
        this.capabilities = get(LegacyCapabilities);
        this.dotExtensions = get(LegacyDotExtensions);
        this.continuations = get(LegacyContinuations);
        this.steering = get(LegacySteering);
        this.roomNotices = get(LegacyRoomNotices);
        this.titles = get(LegacyThreadTitles);
        this.chatNamesRepo = get(SuggestionsRepo);
        this.chatNames = get(LegacyChatNames);
        this.learning = get(LegacyLearning);
        this.autoTriage = get(LegacyAutoTriage);
        this.traceExporter = maybe(LegacyTraceExporter);
        this.transcriptionKeys = get(LegacyTranscriptionKeys);
        this.github = get(LegacyGitHub);
        this.computers = get(LegacyComputers);
        this.jobs = get(LegacyJobs);
        this.longRuns = get(LegacyLongRuns);
        this.longRunReports = get(LegacyLongRunReports);
        this.schedules = get(LegacySchedules);
        this.scheduleStore = get(SchedulesHost).store;
        this.goals = get(LegacyGoals);
        this.pages = get(LegacyPages);
        this.handler = get(LegacyRuntimeHandler);
        this.gatewayAdopted = { gateway: get(HostedGateway), extractions: get(AppExtractionDelivery) };
        this.dictationStreams = get(Dictation);
    }
    /** A service the graph built. */
    private service<I, S>(tag: Context.Key<I, S>): S {
        return Context.getUnsafe(this.built as Context.Context<never>, tag);
    }
    /** The docs catalog, once boot phase 4 (or a test) filled its port. */
    get docs(): AgentDocsCatalog | undefined {
        return this.ports.docs.peek();
    }
    /** The Telegram channel's port. */
    get telegram(): TelegramChannel | undefined {
        return this.ports.telegram.peek();
    }
    set telegram(channel: TelegramChannel | undefined) {
        this.ports.telegram.fill(channel);
    }
    /** The draining port (CB-37). */
    get draining(): boolean {
        return this.ports.draining.get();
    }
    set draining(draining: boolean) {
        this.ports.draining.fill(draining);
    }
    /** Scheduled backups' port (CB-63). */
    get backups(): BackupService | undefined {
        return this.ports.backups.peek();
    }
    set backups(service: BackupService | undefined) {
        this.ports.backups.fill(service);
    }
    useTelegram(channel: TelegramChannel): void {
        this.service(LeaderWork).useTelegram(channel);
    }
    useBackups(service: BackupService): void {
        this.service(LeaderWork).useBackups(service);
    }
    drain(): void {
        this.service(LeaderWork).drain();
    }
    inProgress(): number {
        return this.service(LeaderWork).inProgress();
    }
    awaitListening(): void {
        this.service(LeaderWork).awaitListening();
    }
    markListening(): void {
        this.service(LeaderWork).markListening();
    }
    start(): Promise<void> {
        return this.service(LeaderWork).start();
    }
    lead(): Promise<void> {
        return this.service(LeaderWork).lead();
    }
    succeed(): Promise<void> {
        return this.service(LeaderWork).succeed();
    }
    stopBackground(): Promise<void> {
        return this.service(LeaderWork).stopBackground();
    }
    stop(): Promise<void> {
        return this.service(LeaderWork).stop();
    }
    health() {
        return this.service(AppStatus).health();
    }
    statusEpoch(): number {
        return this.service(AppStatus).statusEpoch();
    }
    adminSetup(): Promise<Pick<SetupStatus, 'dataKey' | 'backup' | 'datasetFiles'>> {
        return this.service(AppStatus).adminSetup();
    }
    transcriptionSources(): TranscriptionSources {
        return this.service(AppStatus).transcriptionSources();
    }
    setup(userId?: string): Promise<SetupStatus> {
        return this.service(AppStatus).setup(userId);
    }
    requireReady(): Promise<void> {
        return this.service(AppStatus).requireReady();
    }
    notifyAdmins(notice: PlatformNotice): Promise<void> {
        return this.service(AdminNotices).notifyAdmins(notice);
    }
    notifyOperators(notice: PlatformNotice): Promise<void> {
        return this.service(AdminNotices).notifyOperators(notice);
    }
    dataKeyStatus(): Promise<DataKeyStatus> {
        return this.service(DataKeyAdmin).status();
    }
    resealData(): Promise<ResealOutcome | undefined> {
        return this.service(DataKeyAdmin).reseal();
    }
    resealNow(actor: string): Promise<void> {
        return this.service(DataKeyAdmin).resealNow(actor);
    }
    verifyRecoveryKey(key: Buffer, actor: string): Promise<RecoveryKeyCheck> {
        return this.service(DataKeyAdmin).verifyRecoveryKey(key, actor);
    }
    runSource(threadId: string, recorded?: AgentRunSource | null): Promise<AgentRunSource> {
        return runSourceOf(this.workspace)(threadId, recorded);
    }
    archiveDot(id: string, actor: string): ReturnType<ConversationAdminShape['archiveDot']> {
        return this.service(ConversationAdmin).archiveDot(id, actor);
    }
    forgetDot(dotId: string) {
        return this.service(ConversationAdmin).forgetDot(dotId);
    }
    createConversation(
        dotId: string,
        title: string,
        userId: string,
        inference: ModelChoice | null = null,
    ): ReturnType<ConversationAdminShape['create']> {
        return this.service(ConversationAdmin).create(dotId, title, userId, inference);
    }
    deleteConversation(id: string, userId: string, now = Date.now()): Promise<void> {
        return this.service(ConversationAdmin).delete(id, userId, now);
    }
    deletion(id: string, userId: string): Promise<ConversationDeletion> {
        return this.service(ConversationAdmin).deletion(id, userId);
    }
    history(threadId: string): Promise<string> {
        return this.service(ConversationAdmin).history(threadId);
    }
    revokeRoomWork(roomId: string, userId?: string): Promise<void> {
        return this.service(RoomWork).revoke(roomId, userId);
    }
    roomsSwitched(before: boolean, after: boolean): Promise<void> {
        return this.service(RoomWork).switched(before, after);
    }
    async handle(request: Request, userId: string): Promise<Response> {
        return this.service(AppTurns).handle(request, userId);
    }
    async turn(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        metadata?: Record<string, unknown>,
        source?: AgentRunSource,
    ): Promise<string> {
        return this.service(AppTurns).turn(threadId, prompt, signal, metadata, source);
    }
    async turnOutcome(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        options: PlatformTurnOptions = {},
    ): Promise<TurnOutcome> {
        return this.service(AppTurns).turnOutcome(threadId, prompt, signal, options);
    }
}

/**
 * `startAppRuntime` (main.ts), as the server calls it, with the tests'
 * view of the services it built beside them.
 */
export async function startWithTestPlatform(boot: AppBoot) {
    const started = await startAppRuntime(boot);
    return { ...started, platform: new TestPlatform(started.services) };
}
