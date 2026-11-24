/**
 * The services the modules' hooks may read (`ModuleContext.services`).
 *
 * `ModuleHookServices` lists them: `main.ts` binds it as the modules'
 * `ModuleRuntimeServices`, and checks that the app's runtime builds each.
 * A hook that moves onto a tag adds it here. The services come from the
 * layer graph (`main.ts`), so the modules' hooks always read the app's runtime.
 */

import type { ActorActions, Actors, ActorServices } from '../actors/contract.js';
import type { Approvals, ApprovalsWorkspace } from '../approvals/contract.js';
import type { Apps, AppExtractionDelivery, AppsConfig, AppsTelegram } from '../apps/contract.js';
import type { AppsServiceTag } from '../apps/tags.js';
import type { Ask } from '../ask/contract.js';
import type { Capabilities } from '../capabilities/contract.js';
import type { ClassifyConfig } from '../classify/contract.js';
import type { ClassifyHost } from '../classify/tags.js';
import type { ComputerRecords, Computers } from '../computers/contract.js';
import type { ContextConfig, ChatNotes, SharedChats } from '../context/contract.js';
import type { CycleUpkeep } from '../cycles/contract.js';
import type { Data, DataCounters, DatasetViewTools, DataViewPages } from '../dataspace/contract.js';
import type { DataSpaceInstance } from '../dataspace/tags.js';
import type { Domains } from '../domains/contract.js';
import type { FlagAdmin, Flags, FlagsWorkspace } from '../flags/contract.js';
import type { HostedGateway } from '../gateway/adopted.js';
import type { GitHubAdmin, GitHubConfig } from '../github/contract.js';
import type { Inference } from '../inference/contract.js';
import type {
    Deliveries,
    Goals as IssueGoals,
    IssuesConfig,
    Leadership,
    MediaFiles,
    IssueRunTraces,
} from '../issues/contract.js';
import type { AutoTriageInstance, SqliteBoardService } from '../issues/tags.js';
import type { LearningJob } from '../learning/tags.js';
import type { Counters } from '../live/contract.js';
import type { Tools } from '../mcp/contract.js';
import type { McpConnectionsService, McpOAuthService } from '../mcp/tags.js';
import type { Media } from '../media/contract.js';
import type { MediaServiceTag } from '../media/tags.js';
import type {
    Episodes,
    MemoryConfig,
    MemoryItems,
    SpaceMemories,
    SpaceMemory,
    TurnMemory,
    MemorySpaces,
    MemoryTelegram,
} from '../memory/contract.js';
import type { NotificationChannels, NotificationGoals } from '../notifications/contract.js';
import type { NotificationsService } from '../notifications/tags.js';
import type { AccessAudit, OperationsBackups, OperationsConfig, RunSource } from '../operations/contract.js';
import type { CoverageModules } from '../operations/queries/coverage.js';
import type { PageTools } from '../pages/contract.js';
import type { Plugins, PluginsInApps } from '../plugins/contract.js';
import type { PluginServiceTag } from '../plugins/tags.js';
import type { RoomPinRoutes, Rooms, RoomsAccessAudit, RoomsTelegram } from '../rooms/contract.js';
import type {
    LegacyOrchestrator,
    LegacyRoomNotices,
    LegacyRooms,
    LegacyRoomTopics,
    RoomsWorkspace,
} from '../rooms/tags.js';
import type { RunsViews } from '../runs/contract.js';
import type { Jobs, LongRuns, ScheduleBoard, Tasks } from '../schedules/contract.js';
import type {
    FullGoals,
    FullJobs,
    FullLongRunReports,
    FullLongRuns,
    FullSchedules,
    ScheduleStore,
} from '../schedules/tags.js';
import type { Limits, WorkspaceSettings } from '../settings/contract.js';
import type { UnfurlTools } from '../skills/contract.js';
import type { Souls } from '../souls/contract.js';
import type { Access as SpaceAccess, SpacePages } from '../spaces/contract.js';
import type { Links } from '../telegram/contract.js';
import type { TelegramHost } from '../telegram/tags.js';
import type { Runner } from '../turns/contract.js';
import type { Updates } from '../updates/contract.js';
import type { WebConfig } from '../web/contract.js';
import type { SecretsAdmin } from '../workspace-secrets/contract.js';
import type { Conversations, Socios, Audit, ChatHistory, People, Spaces } from '../workspace/contract.js';

/**
 * The app's services the modules' hooks may read: memory's tools
 * `ChatNotes`, `SpaceMemory` and its tick `MemoryConfig`; the runs'
 * routes `AccessAudit`; the classification seam `AccessAudit` and
 * `RunSource`; the spaces' routes `SpaceMemory`;
 * the context's tools `Runner` and `ContextConfig`; the Operations routes
 * `Limits` and `ChatHistory`; the web's tools `UnfurlTools`; the apps',
 * the plugins' and the data space's routes `ActorActions`; the "Ask a
 * socio" panel's routes and turn notes `Ask`. `PageTools`, `TurnMemory`,
 * `RunsViews` and `Links`, which the modules now read through the ports
 * below, stay listed for the callers outside them (tests).
 *
 * What the modules' context no longer carries: the workspace's settings
 * `WorkspaceSettings`; its slices `People`, `Socios`,
 * `Conversations`, `Audit`, `Spaces`, the Spaces' `Access`, the Telegram
 * `Links` and the `ComputerRecords`, and the flag routes' view of the
 * people and the audit (`FlagsWorkspace`); memory's stores `MemoryItems`,
 * `Episodes` and `SpaceMemories`; and the configuration of GitHub, issues,
 * the web, Operations and classification (`GitHubConfig`, `IssuesConfig`,
 * `WebConfig`, `OperationsConfig`, `ClassifyConfig`).
 *
 * The ports lower modules declare over services above them in the folder
 * order: the context's tools' `SharedChats` (memory's `TurnMemory`),
 * the data space's `DatasetViewTools` and the Spaces' `SpacePages`
 * (pages' `PageTools`), the issue routes' `IssueRunTraces` (`RunsViews`),
 * memory's tools' `MemoryTelegram` and `MemorySpaces` (telegram's `Links`,
 * the Spaces' `Access`), notifications' `NotificationGoals` (schedules'
 * `Goals`), and the rooms' routes' `RoomsAccessAudit` (`AccessAudit`) and
 * `RoomPinRoutes` (the context's pin routes).
 */
export type ModuleHookServices =
    | ChatNotes
    | AccessAudit
    | RunSource
    | PageTools
    | SpaceMemory
    | MemoryConfig
    | TurnMemory
    | Runner
    | ContextConfig
    | Limits
    | ChatHistory
    | UnfurlTools
    | RunsViews
    | ActorActions
    | Ask
    | WorkspaceSettings
    | People
    | Socios
    | Conversations
    | Audit
    | Spaces
    | SpaceAccess
    | Links
    | ComputerRecords
    | MemoryItems
    | Episodes
    | SpaceMemories
    | GitHubConfig
    | IssuesConfig
    | WebConfig
    | OperationsConfig
    | ClassifyConfig
    | FlagsWorkspace
    | SharedChats
    | DatasetViewTools
    | SpacePages
    | IssueRunTraces
    | MemoryTelegram
    | MemorySpaces
    | NotificationGoals
    | RoomsAccessAudit
    | RoomPinRoutes
    | Approvals
    | ApprovalsWorkspace
    | Flags
    | FlagAdmin
    | Media
    | MediaServiceTag
    | GitHubAdmin
    | Souls
    | CycleUpkeep
    | Domains
    | Updates
    | SecretsAdmin
    | Tools
    | McpConnectionsService
    | McpOAuthService
    | LearningJob
    | Computers
    | Data
    | DataSpaceInstance
    | DataViewPages
    | DataCounters
    | Actors
    | ActorServices
    | Jobs
    | LongRuns
    | FullJobs
    | FullLongRuns
    | FullLongRunReports
    | FullSchedules
    | FullGoals
    | ScheduleStore
    | Tasks
    | ScheduleBoard
    | NotificationChannels
    | NotificationsService
    | Plugins
    | PluginServiceTag
    | PluginsInApps
    | Apps
    | AppsServiceTag
    | AppsConfig
    | AppsTelegram
    | AppExtractionDelivery
    | HostedGateway
    | TelegramHost
    | Rooms
    | RoomsWorkspace
    | RoomsTelegram
    | LegacyRooms
    | LegacyRoomTopics
    | LegacyRoomNotices
    | LegacyOrchestrator
    | SqliteBoardService
    | AutoTriageInstance
    | Leadership
    | IssueGoals
    | MediaFiles
    | Deliveries
    | Counters
    | Inference
    | Capabilities
    | OperationsBackups
    | CoverageModules
    | ClassifyHost;
