import type { ToolDefinition } from '@copilotkit/runtime/v2';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import { APP_APPROVALS } from '@socio/shared/apps/app-types';

import { ActorActions, Actors } from '../actors/contract.js';
import { ComputerRecords } from '../computers/contract.js';
import { Media } from '../media/contract.js';
import type { ModuleServicesAccess, ServerModule } from '../modules/contract.js';
import { Plugins } from '../plugins/contract.js';
import { Conversations, Socios } from '../workspace/contract.js';

import { BROWSE_TOOL_NAMES, browseTools, type AppsBrowsePlatform } from './browse-tools.js';
import { AppExtractionDelivery, AppsConfig, AppsTelegram } from './contract.js';
import { appsSchema } from './migrations.js';
import { appRoutes } from './routes.js';
import { AppsServiceTag } from './tags.js';
import { APP_TOOL_NAMES, appTools } from './tools.js';

/**
 * What the app browser's tools read, from the app's services at the moment
 * of use: the registry, the plugins, socio access, the browser's key
 * (`AppsConfig.sessionSecret`), media for screenshots, and the chats'
 * socios, conversations and Telegram facts.
 */
const browseServices = (services: ModuleServicesAccess): AppsBrowsePlatform => {
    const socios = services.get(Socios);
    const conversations = services.get(Conversations);
    return {
        apps: services.get(AppsServiceTag),
        plugins: services.get(Plugins),
        actors: services.get(Actors),
        config: services.get(AppsConfig),
        media: services.get(Media),
        workspace: {
            dot: (id) => socios.dot(id),
            thread: (id) => conversations.thread(id),
            telegram: services.get(AppsTelegram),
        },
    };
};

/**
 * Socio-access tool sets of the apps capability (CB-232): each set
 * keeps its tools in its own file and is listed here once, so adding one
 * never edits this module. The `app_*` browse tools: their flag,
 * `socio-actor-access`, hides them while it is off. Revocation reaches the
 * apps service through its `actors` option (platform.ts), which service.ts
 * calls on unpublish, unregister and unshare.
 */
const DELEGATED_APP_TOOLS: readonly {
    names: readonly string[];
    tools: (platform: AppsBrowsePlatform, turn: DotTurn) => ToolDefinition[];
}[] = [{ names: BROWSE_TOOL_NAMES, tools: browseTools }];

/** How often the apps' token files in computers are checked (the tick is 1 min). */
const COMPUTER_REFRESH_MS = 10 * 60_000;
let lastComputerRefresh = 0;
/** How often attempts past the retention setting are dropped (CB-175). */
const LOG_PRUNE_MS = 60 * 60_000;
let lastLogPrune = 0;

/**
 * Mini apps. The service lives on the platform (`platform.apps`); the
 * module owns the tables, `/api/apps`, the Dot tools, the capability entry,
 * and the tick that keeps tokens current and drops apps of deleted Dots.
 * The proxy for the apps origin is mounted by `createApp` before anything
 * else, and WebSocket upgrades by the server entry.
 *
 * Promotion (`platform.apps.promotions`): versions, the handoff, the
 * workspace app runtime; the tick keeps promoted apps running there with
 * live tokens (after either side restarts), and repairs apps in computers
 * that stopped answering (CB-291).
 */
export const appsModule: ServerModule = {
    ...appsSchema,
    // The registry (`AppsServiceTag`), socio access's `ActorActions` and its
    // extraction delivery, from the app's services.
    routes: ({ services }) =>
        appRoutes(services.get(AppsServiceTag), services.get(ActorActions), services.get(AppExtractionDelivery)),
    dotTools: ({ services }, turn) => {
        const apps = services.get(AppsServiceTag);
        return [
            ...appTools(apps, turn),
            ...(apps.enabled ? DELEGATED_APP_TOOLS.flatMap((set) => set.tools(browseServices(services), turn)) : []),
        ];
    },
    capabilities: ({ services }) => [
        {
            id: 'apps',
            label: 'Mini apps',
            description:
                'Run a small Bun web app in your computer and publish it with app_register: the user opens it from Socio on its own address, signed in. It reads and writes the data space with its own token. Ephemeral: it runs only while your computer does. To make it last, package it (app_package) and propose promoting it with app_promote, which shows the user an approval card: it then runs in the workspace app runtime, with versioned updates (app_update). app_combine starts a new app from several.',
            tools: [...APP_TOOL_NAMES, ...DELEGATED_APP_TOOLS.flatMap((set) => set.names)],
            approvals: [APPROVAL_CAPABILITIES.appRegister, APP_APPROVALS.promote, APP_APPROVALS.update],
            status: async (turn) => {
                const apps = services.get(AppsServiceTag);
                const settings = apps.settings;
                if (!settings) {
                    return {
                        enabled: false,
                        note: 'Mini apps are not set up on this server (APPS_HOST).',
                    };
                }
                const computer = await services.get(ComputerRecords).permissions(turn.dot.id);
                return {
                    enabled: computer.enabled,
                    ...(computer.enabled ? {} : { note: 'This socio’s computer is turned off.' }),
                    limits: {
                        ports: '3000-3999',
                        sessionHours: settings.sessionTtlMs / 3_600_000,
                        requestMaxMB: settings.maxRequestBytes / 1048576,
                        timeoutSeconds: settings.timeoutMs / 1000,
                        bundleMaxFiles: settings.bundle.maxFiles,
                        bundleMaxMB: settings.bundle.maxBytes / 1048576,
                    },
                    usage: {
                        apps: apps.forDot(turn.userId, turn.dot.id).length,
                        promoted: apps.forDot(turn.userId, turn.dot.id).filter((app) => app.status === 'promoted')
                            .length,
                    },
                    details: {
                        promotion: apps.promotions.runtime
                            ? 'available'
                            : 'not set up here (APPS_RUNTIME_URL): apps can be packaged, not promoted',
                    },
                };
            },
        },
    ],
    start: async ({ services }) => {
        const apps = services.get(AppsServiceTag);
        await apps.forgetDeletedDots();
        lastComputerRefresh = Date.now();
        void apps.refreshTokens().catch(() => undefined);
        // Tokens died with the last process: promoted apps get new ones.
        void apps.promotions.reconcile().catch((error) => apps.promotions.checkFailed(error));
        lastLogPrune = Date.now();
        void apps.promotions.pruneAttempts().catch(() => undefined);
    },
    tick: {
        everyMs: 60_000,
        run: ({ services }) => {
            const apps = services.get(AppsServiceTag);
            // Its failures show in Operations → Health and the log (CB-291).
            void apps.promotions.reconcile().catch((error) => apps.promotions.checkFailed(error));
            // Apps in computers: unanswered ports and renewed tokens (CB-291).
            void apps.checkHealth().catch(() => undefined);
            if (Date.now() - lastLogPrune >= LOG_PRUNE_MS) {
                lastLogPrune = Date.now();
                void apps.promotions.pruneAttempts().catch(() => undefined);
            }
            if (Date.now() - lastComputerRefresh < COMPUTER_REFRESH_MS) {
                return;
            }
            lastComputerRefresh = Date.now();
            void apps.forgetDeletedDots().catch(() => undefined);
            void apps.refreshTokens().catch(() => undefined);
        },
    },
};
