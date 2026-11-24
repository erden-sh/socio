import { activityModule } from './activity/module';
import { connectedAgentsModule } from './agents/module';
import { approvalsModule } from './approvals/module';
import { appsModule } from './apps/module';
import { askModule } from './ask/module';
import { chatModule } from './chat/module';
import { dataModule } from './dataspace/module';
import { dotsModule } from './dots/module';
import { helpModule } from './help/module';
import { issuesModule } from './issues/module';
import { learningModule } from './learning/module';
import { mediaModule } from './media/module';
import { memoriesModule } from './memories/module';
import { operationsModule } from './operations/module';
import { operatorModule } from './operator/module';
import { pluginsModule } from './plugins/module';
import { runsModule } from './runs/module';
import { schedulesModule } from './schedules/module';
import { settingsModule } from './settings/module';
import { spacesModule } from './spaces/module';
import { telegramModule } from './telegram/module';
import type { ClientModule } from './types';

/**
 * The client modules, one line each. A new module is its folder (with a
 * `module.ts` exporting a `ClientModule`) plus one line here; the sidebar,
 * breadcrumbs, launcher, palette and slots pick it up. Order on screen
 * comes from each manifest's `order`.
 *
 * A module with pages also has a `routes.ts` (a layout on its
 * `gate.route.tsx`, id `module:<id>`) and one line in `modules/routes.ts`.
 * `packages/client/tests/route-config.test.ts` checks the two lists agree.
 */
export const clientModules: readonly ClientModule[] = [
    helpModule,
    chatModule,
    spacesModule,
    activityModule,
    memoriesModule,
    dataModule,
    mediaModule,
    approvalsModule,
    appsModule,
    schedulesModule,
    pluginsModule,
    learningModule,
    issuesModule,
    runsModule,
    dotsModule,
    connectedAgentsModule,
    telegramModule,
    settingsModule,
    operationsModule,
    operatorModule,
    askModule,
];
