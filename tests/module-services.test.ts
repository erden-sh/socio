// A module's hooks reach the app's services through
// `ModuleContext.services`, the ones the root's runtime built at boot (no
// second runtime). Every platform is the layer graph's.
import { Context, Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { ActorActions, Actors, ActorServices } from '../src/server/actors/contract.js';
import { Approvals, ApprovalsWorkspace } from '../src/server/approvals/contract.js';
import { AppExtractionDelivery, Apps, AppsConfig, AppsTelegram } from '../src/server/apps/contract.js';
import { AppsServiceTag } from '../src/server/apps/tags.js';
import { Ask } from '../src/server/ask/contract.js';
import { Capabilities } from '../src/server/capabilities/contract.js';
import { ClassifyConfig } from '../src/server/classify/contract.js';
import { ClassifyHost } from '../src/server/classify/tags.js';
import { Computers } from '../src/server/computers/contract.js';
import { ComputerRecords } from '../src/server/computers/contract.js';
import { ChatNotes, ContextConfig, SharedChats } from '../src/server/context/contract.js';
import { CycleUpkeep } from '../src/server/cycles/contract.js';
import { Data, DataViewPages } from '../src/server/dataspace/contract.js';
import { DatasetViewTools } from '../src/server/dataspace/contract.js';
import { DataSpaceInstance } from '../src/server/dataspace/tags.js';
import { Domains } from '../src/server/domains/contract.js';
import { FlagAdmin, Flags, FlagsWorkspace } from '../src/server/flags/contract.js';
import { HostedGateway } from '../src/server/gateway/adopted.js';
import { GitHubAdmin, GitHubConfig } from '../src/server/github/contract.js';
import { Inference } from '../src/server/inference/contract.js';
import { Deliveries, Goals as IssueGoals, Leadership, MediaFiles } from '../src/server/issues/contract.js';
import { IssueRunTraces, IssuesConfig } from '../src/server/issues/contract.js';
import { AutoTriageInstance, SqliteBoardService } from '../src/server/issues/tags.js';
import { LearningJob } from '../src/server/learning/tags.js';
import { Counters } from '../src/server/live/contract.js';
import type { AppBoot } from '../src/server/main.js';
import { Tools } from '../src/server/mcp/contract.js';
import { McpConnectionsService, McpOAuthService } from '../src/server/mcp/tags.js';
import { Media } from '../src/server/media/contract.js';
import { MediaServiceTag } from '../src/server/media/tags.js';
import {
    Episodes,
    MemoryConfig,
    MemoryItems,
    MemorySpaces,
    MemoryTelegram,
    SpaceMemories,
    SpaceMemory,
    TurnMemory,
} from '../src/server/memory/contract.js';
import { memoriesModule } from '../src/server/memory/module.js';
import type { ServerModule } from '../src/server/modules/contract.js';
import { serverModules } from '../src/server/modules/index.js';
import { NotificationChannels, NotificationGoals } from '../src/server/notifications/contract.js';
import { NotificationsService } from '../src/server/notifications/tags.js';
import { AccessAudit, OperationsBackups, OperationsConfig } from '../src/server/operations/contract.js';
import { CoverageModules } from '../src/server/operations/queries/coverage.js';
import { PageTools } from '../src/server/pages/contract.js';
import { Plugins, PluginsInApps } from '../src/server/plugins/contract.js';
import { PluginServiceTag } from '../src/server/plugins/tags.js';
import { RoomPinRoutes, Rooms, RoomsAccessAudit, RoomsTelegram } from '../src/server/rooms/contract.js';
import {
    LegacyOrchestrator,
    LegacyRoomNotices,
    LegacyRooms,
    LegacyRoomTopics,
    RoomsWorkspace,
} from '../src/server/rooms/tags.js';
import { RunsViews } from '../src/server/runs/contract.js';
import { Jobs, LongRuns, ScheduleBoard, Tasks } from '../src/server/schedules/contract.js';
import {
    FullGoals,
    FullJobs,
    FullLongRunReports,
    FullLongRuns,
    FullSchedules,
    ScheduleStore,
} from '../src/server/schedules/tags.js';
import { Limits, WorkspaceSettings } from '../src/server/settings/contract.js';
import { UnfurlTools } from '../src/server/skills/contract.js';
import { Souls } from '../src/server/souls/contract.js';
import { Access as SpaceAccess, SpacePages } from '../src/server/spaces/contract.js';
import { Links } from '../src/server/telegram/contract.js';
import { TelegramHost } from '../src/server/telegram/tags.js';
import { Runner } from '../src/server/turns/contract.js';
import { Updates } from '../src/server/updates/contract.js';
import { WebConfig } from '../src/server/web/contract.js';
import { SecretsAdmin } from '../src/server/workspace-secrets/contract.js';
import { Audit, ChatHistory, Conversations, People, Socios, Spaces } from '../src/server/workspace/contract.js';

import type { Store, WorkspaceStore } from './helpers/stores.js';
import type { TestPlatform } from './helpers/test-platform.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** Every tag `ModuleHookServices` lists (`composition/module-services.ts`). */
const HOOK_TAGS = [
    ChatNotes,
    AccessAudit,
    PageTools,
    SpaceMemory,
    MemoryConfig,
    TurnMemory,
    Runner,
    ContextConfig,
    Limits,
    ChatHistory,
    UnfurlTools,
    RunsViews,
    ActorActions,
    Ask,
    WorkspaceSettings,
    People,
    Socios,
    Conversations,
    Audit,
    Spaces,
    SpaceAccess,
    Links,
    ComputerRecords,
    MemoryItems,
    Episodes,
    SpaceMemories,
    GitHubConfig,
    IssuesConfig,
    WebConfig,
    OperationsConfig,
    ClassifyConfig,
    FlagsWorkspace,
    SharedChats,
    DatasetViewTools,
    SpacePages,
    IssueRunTraces,
    MemoryTelegram,
    MemorySpaces,
    NotificationGoals,
    RoomsAccessAudit,
    RoomPinRoutes,
    Approvals,
    ApprovalsWorkspace,
    Flags,
    FlagAdmin,
    Media,
    MediaServiceTag,
    GitHubAdmin,
    Souls,
    CycleUpkeep,
    Domains,
    Updates,
    SecretsAdmin,
    Tools,
    McpConnectionsService,
    McpOAuthService,
    LearningJob,
    Computers,
    Data,
    DataSpaceInstance,
    DataViewPages,
    Actors,
    ActorServices,
    Jobs,
    LongRuns,
    FullJobs,
    FullLongRuns,
    FullLongRunReports,
    FullSchedules,
    FullGoals,
    ScheduleStore,
    Tasks,
    ScheduleBoard,
    NotificationChannels,
    NotificationsService,
    Plugins,
    PluginServiceTag,
    PluginsInApps,
    Apps,
    AppsServiceTag,
    AppsConfig,
    AppsTelegram,
    AppExtractionDelivery,
    HostedGateway,
    TelegramHost,
    Rooms,
    RoomsWorkspace,
    RoomsTelegram,
    LegacyRooms,
    LegacyRoomTopics,
    LegacyRoomNotices,
    LegacyOrchestrator,
    SqliteBoardService,
    AutoTriageInstance,
    Leadership,
    IssueGoals,
    MediaFiles,
    Deliveries,
    Counters,
    Inference,
    Capabilities,
    OperationsBackups,
    CoverageModules,
    ClassifyHost,
] as const;

/**
 * The ports lower modules declare over a service above them that is the
 * very service: each is the object its tag holds.
 */
const SAME_AS = [
    [SharedChats, TurnMemory],
    [DatasetViewTools, PageTools],
    [IssueRunTraces, RunsViews],
    [MemoryTelegram, Links],
    [MemorySpaces, SpaceAccess],
    [RoomsAccessAudit, AccessAudit],
] as const;

/**
 * What the modules' context no longer carries in place of the platform:
 * each tag is the very member the platform holds, in the app's runtime.
 */
const MEMBERS = (platform: TestPlatform) =>
    [
        [Approvals, platform.approvals],
        [Actors, platform.actors],
        [Flags, platform.flags],
        [FlagAdmin, platform.flags],
        [Media, platform.media],
        [MediaServiceTag, platform.media],
        [GitHubAdmin, platform.github],
        [Souls, platform.workspace.souls],
        [CycleUpkeep, platform.cycles],
        [Domains, platform.domains],
        [Updates, platform.updates],
        [SecretsAdmin, platform.workspaceSecrets],
        [Tools, platform.mcpRuntime],
        [McpConnectionsService, platform.mcpConnections],
        [McpOAuthService, platform.mcpOAuth],
        [LearningJob, platform.learning],
        [Computers, platform.computers],
        [Data, platform.data],
        [DataSpaceInstance, platform.data],
        [DataViewPages, platform.workspace.pages],
        [Jobs, platform.jobs],
        [FullJobs, platform.jobs],
        [LongRuns, platform.longRuns],
        [FullLongRuns, platform.longRuns],
        [FullLongRunReports, platform.longRunReports],
        [FullSchedules, platform.schedules],
        [FullGoals, platform.goals],
        [ScheduleStore, platform.scheduleStore],
        [Tasks, platform.store.scheduled],
        [ScheduleBoard, platform.board],
        [NotificationChannels, platform.notifications],
        [NotificationsService, platform.notifications],
        [Plugins, platform.plugins],
        [PluginServiceTag, platform.plugins],
        [Apps, platform.apps],
        [AppsServiceTag, platform.apps],
        [AppsTelegram, platform.workspace.telegram],
        [AppExtractionDelivery, platform.gatewayAdopted.extractions],
        [HostedGateway, platform.gatewayAdopted.gateway],
        [Rooms, platform.rooms],
        [LegacyRooms, platform.rooms],
        [LegacyRoomTopics, platform.roomTopics],
        [LegacyRoomNotices, platform.roomNotices],
        [LegacyOrchestrator, platform.orchestrator],
        [RoomsWorkspace, platform.workspace],
        [SqliteBoardService, platform.board],
        [AutoTriageInstance, platform.autoTriage],
        [Leadership, platform.issuesLeadership],
        [Counters, platform.workspace.counters],
        [Inference, platform.inference],
        [Capabilities, platform.capabilities],
    ] as const;

/** What the members' tags read late, at each use, as the platform's getters do. */
function expectLateMembers(platform: TestPlatform) {
    const { services } = platform.context;
    expect(services.get(TelegramHost).channel).toBe(platform.telegram);
    expect(services.get(RoomsTelegram).channel).toBe(platform.telegram);
    expect(services.get(OperationsBackups).backups).toBe(platform.backups);
    expect(services.get(CoverageModules).modules).toBe(platform.modules);
    expect(services.get(ActorServices)).toMatchObject({
        actors: platform.actors,
        approvals: platform.approvals,
        apps: platform.apps,
        plugins: platform.plugins,
    });
}

/**
 * What the modules' context no longer carries, as the store and the
 * workspace hold it: each tag is that very object, in the app's runtime.
 */
const OWN_OBJECTS = (store: Store, workspace: WorkspaceStore) =>
    [
        [WorkspaceSettings, store.slices.settings],
        [People, workspace.slices.people],
        [Socios, workspace.slices.socios],
        [Conversations, workspace.slices.conversations],
        [Audit, workspace.slices.audit],
        [Spaces, workspace.slices.spaces],
        [SpaceAccess, workspace.spaceAccess],
        [Links, workspace.telegram],
        [ComputerRecords, workspace.computers],
        [MemoryItems, store.memoryItems],
        [Episodes, store.episodes],
        [SpaceMemories, store.spaceMemories],
    ] as const;

const config = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    appOrigin: 'https://app.example.invalid',
};

async function built(modules?: AppBoot['modules']) {
    const { runtime, platform, dispose } = await makeTestRuntime({ config, ...(modules ? { modules } : {}) });
    cleanup.push(dispose);
    return { runtime, platform };
}

it("gives a hook the app's services, the very ones the runtime built", async () => {
    const { runtime, platform } = await built();
    const context = await runtime.context();
    const { services } = platform.context;
    for (const tag of HOOK_TAGS) {
        expect(services.get(tag as never)).toBe(Context.get(context, tag as never));
    }
    expect(services.get(Runner)).toBe(platform.runner);
    for (const [tag, own] of OWN_OBJECTS(platform.store, platform.workspace)) {
        expect(services.get(tag as never)).toBe(own);
    }
    expect(services.get(IssuesConfig).appOrigin).toBe(config.appOrigin);
    for (const [port, tag] of SAME_AS) {
        expect(services.get(port as never)).toBe(services.get(tag as never));
    }
    for (const [tag, member] of MEMBERS(platform)) {
        expect(services.get(tag as never)).toBe(member);
    }
    expectLateMembers(platform);
    // An Effect runs with the same runtime.
    expect(
        await services.run(
            Effect.gen(function* () {
                return yield* ChatNotes;
            }),
        ),
    ).toBe(Context.get(context, ChatNotes));
});

it('tells a hook that runs while the graph is built that the services are not built yet', async () => {
    const seen: string[] = [];
    const probe: ServerModule = {
        id: 'probe',
        capabilities: ({ services }) => {
            try {
                services.get(ChatNotes);
                seen.push('read');
            } catch (error) {
                seen.push((error as Error).message);
            }
            return [];
        },
    };
    await built([...serverModules, probe]);
    expect(seen).toEqual([expect.stringContaining("while the app's services were being built")]);
});

it("reads the chat's pinned facts for memory's proposals from the app's ChatNotes", async () => {
    const { platform } = await built();
    const dot = platform.workspace.dots()[0]!;
    platform.context.services.get(ChatNotes).addFacts('alice-chat', ['Preference: weekly reports go out on Mondays']);
    const turn = {
        dot: { ...dot, memoryAllowed: true },
        userId: 'alice',
        threadId: 'alice-chat',
        check: () => {},
        said: [],
    } as unknown as DotTurn;
    const tool = memoriesModule.dotTools!(platform.context, turn).find(
        (t) => t.name === 'propose_memory',
    ) as unknown as {
        execute: (input: unknown) => Promise<unknown>;
    };
    await tool.execute({ text: 'Weekly reports go out on Mondays' });
    const [item] = await platform.store.memoryItems.list('alice');
    expect(item).toMatchObject({ text: 'Weekly reports go out on Mondays', source: 'notes', status: 'proposed' });
});
