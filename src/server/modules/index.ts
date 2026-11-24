import type { SchemaSet } from '@socio/data/migrate';
import { runtimeSchema } from '@socio/data/runtime-ownership';

import { actorsModule } from '../actors/module.js';
import { agentGrantsSchema } from '../agents/grants.js';
import { approvalsModule } from '../approvals/module.js';
import { appsModule } from '../apps/module.js';
import { askModule } from '../ask/module.js';
import { authSchema } from '../auth/schema.js';
import { bundleSchema } from '../bundle/migrations.js';
import { chatNamesModule } from '../chat-name-suggestions/module.js';
import { classifyModule } from '../classify/module.js';
import { computersModule, domainsModule, telegramModule, webModule } from '../composition/integration-modules.js';
import { chatModule } from '../context/module.js';
import { cyclesModule } from '../cycles/module.js';
import { makeDataModule } from '../dataspace/module.js';
import { dispatchSchema } from '../dispatch/migrations.js';
import { flagsModule } from '../flags/module.js';
import { gatewayModule } from '../gateway/module.js';
import { githubModule } from '../github/module.js';
import { inferenceSchema } from '../inference/migrations.js';
import { issuesModule } from '../issues/module.js';
import { learningModule } from '../learning/module.js';
import { changeCountersSchema } from '../live/change-counters.js';
import { mcpConnectionsModule } from '../mcp/module.js';
import { mediaModule } from '../media/module.js';
import { memoriesModule } from '../memory/module.js';
import { notificationsModule } from '../notifications/module.js';
import { operationsModule } from '../operations/module.js';
import { pagesSchema } from '../pages/pages.js';
import { pluginsModule } from '../plugins/module.js';
import { roomsModule } from '../rooms/module.js';
import { runsModule } from '../runs/run-module.js';
import { jobCheckpointRoutesOf } from '../schedules/checkpoint-routes.js';
import { scheduleTasksSchema } from '../schedules/migrations.js';
import { schedulesModule } from '../schedules/module.js';
import { coreSchema } from '../settings/store.js';
import { chatSkillsModule } from '../skills/module.js';
import { soulsModule } from '../souls/module.js';
import { spacesModule } from '../spaces/spaces-module.js';
import { channelsSchema } from '../telegram/channel-state.js';
import { updatesModule } from '../updates/module.js';
import { workspaceSecretsModule } from '../workspace-secrets/module.js';
import { workspaceSchema } from '../workspace/workspace.js';

import type { ServerModule } from './contract.js';

/**
 * The server modules, in mounting and start order (stopped in reverse). A
 * new module is one line here plus its folder; see `ServerModule`.
 */
export const serverModules = [
    spacesModule,
    computersModule,
    webModule,
    telegramModule,
    learningModule,
    runsModule,
    chatModule,
    memoriesModule,
    issuesModule,
    githubModule,
    approvalsModule,
    makeDataModule(jobCheckpointRoutesOf),
    mediaModule,
    appsModule,
    schedulesModule,
    domainsModule,
    notificationsModule,
    chatSkillsModule,
    operationsModule,
    mcpConnectionsModule,
    updatesModule,
    flagsModule,
    askModule,
    roomsModule,
    cyclesModule,
    classifyModule,
    pluginsModule,
    actorsModule,
    gatewayModule,
    workspaceSecretsModule,
    soulsModule,
    chatNamesModule,
] as const satisfies readonly ServerModule[];

/**
 * Every schema, in migration order: the stores that aren't modules (yet),
 * then the modules, then the change counters, whose triggers name the
 * others' tables. Boot migrates them all before any store opens the
 * database (`bootDatabase`); no store migrates anything itself. Computers and
 * web are modules for their Dot tools only: their tables still migrate
 * where they always did, before the rest.
 */
const stores: readonly SchemaSet[] = [
    coreSchema,
    runtimeSchema,
    workspaceSchema,
    // After both: it adopts the tables they made (CB-110).
    scheduleTasksSchema,
    authSchema,
    agentGrantsSchema,
    pagesSchema,
    computersModule,
    channelsSchema,
    inferenceSchema,
    webModule,
    // Workspace bundles' import record (CB-380): new tables, after every table it names.
    bundleSchema,
];
/**
 * Schemas of removed modules, kept so databases that ran their migrations
 * still start: dispatch (CB-325) until a later release drops its tables.
 */
const retired: readonly SchemaSet[] = [dispatchSchema];
export const schemas: readonly SchemaSet[] = [
    ...stores,
    ...serverModules.filter((module) => !stores.includes(module)),
    ...retired,
    changeCountersSchema,
];
