/**
 * The issues feature's construction: `issues/layer.ts` builds auto-triage and
 * the issue views from the tags; this file builds `IssuesConfig` from the
 * startup configuration and the settings' and counters' tags the graph offers
 * only later, and wires them in at the step the server has always built
 * auto-triage at. The Board is built by the root (`main.ts`, `BoardLive`) and
 * handed in.
 */

import { Effect, Layer } from 'effect';

import { isAdmin } from '@socio/shared/roles';

import { Actors } from '../actors/contract.js';
import {
    AgentRunner,
    AutoTriageControl,
    Deliveries,
    Goals,
    IssuesConfig,
    MediaFiles,
    TelegramDirect,
    type IssuesConfigShape,
} from '../issues/contract.js';
import type { IssueComponentSourcesShape } from '../issues/contract.js';
import { AutoTriageInstance, AutoTriageLive, IssuesViewsLive, SqliteBoardService } from '../issues/layer.js';
import { turnFiles } from '../issues/turn-files.js';
import { Counters } from '../live/contract.js';
import { Plugins } from '../plugins/contract.js';
import { People } from '../workspace/contract.js';

import { LegacyApps } from './apps.js';
import { LegacyConfig, LegacyRunner, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { LegacyMedia } from './media.js';
import { LegacyNotifications } from './notifications.js';
import { Ports } from './ports.js';
import { LegacyGoals } from './schedules.js';

/** Auto-triage, under the graph's `LegacyAutoTriage` tag (the class): the layer's `AutoTriageInstance`. */
export { AutoTriageInstance as LegacyAutoTriage } from '../issues/layer.js';

/** `IssuesConfig` from the startup configuration, never from the environment. */
export const issuesConfig = (config: PlatformConfig): IssuesConfigShape => ({
    dotRequestLimits: config.dotRequestLimits,
    autoTriage: config.autoTriage,
    appOrigin: config.appOrigin,
});

/** `IssuesConfig`, from the startup configuration (`LegacyConfig`). */
const IssuesConfigLive = Layer.effect(
    IssuesConfig,
    Effect.gen(function* () {
        return IssuesConfig.of(issuesConfig(yield* LegacyConfig));
    }),
);

/**
 * The change counters the list's version reads. Live's own step
 * (`liveLayers.counters`, which syncs them) comes after this one, so this
 * step takes the same object from the boot step's workspace.
 */
const CountersHere = Layer.effect(
    Counters,
    Effect.gen(function* () {
        return (yield* LegacyWorkspace).counters;
    }),
);

/** Auto-triage on the workspace connection's unit of work, the one the Board's services share. */
const AutoTriageOnWorkspace = Layer.unwrap(
    Effect.gen(function* () {
        return AutoTriageLive((yield* LegacyWorkspace).data.uow);
    }),
);

/**
 * Issue components' sources (CB-442): the installed plugins, the live apps,
 * the people and the socio grants, bound to the Board's components once
 * they are built (they come before this step). Each is read at the moment
 * of use, so an install, a rename or a new share shows at once.
 */
export const issueComponentSources = (parts: {
    apps: Pick<import('../apps/service.js').AppsService, 'enabled' | 'all' | 'get' | 'access' | 'withDeleted'>;
    plugins: Pick<import('../plugins/contract.js').PluginsShape, 'list' | 'get' | 'mayUse'>;
    people: Pick<import('../workspace/contract.js').PeopleShape, 'users'>;
    grants: Pick<import('../actors/contract.js').SocioGrantsShape, 'unrevoked'>;
}): IssueComponentSourcesShape => {
    const { apps, plugins, people, grants } = parts;
    const person = (userId: string) => people.users().find((user) => user.id === userId);
    return {
        plugins: () =>
            plugins.list().map((row) => ({
                id: row.id,
                name: row.manifest.name,
                enabled: row.enabled,
                audience: row.audience,
            })),
        mayUsePlugin: (pluginId, userId) => plugins.mayUse(plugins.get(pluginId), person(userId)),
        apps: () =>
            apps.enabled
                ? apps.all().map((app) => ({
                      id: app.id,
                      name: app.name,
                      ownerUserId: app.ownerUserId,
                      createdAt: app.createdAt,
                  }))
                : [],
        mayOpenApp: (appId, userId) => {
            const app = apps.enabled ? apps.get(appId) : undefined;
            return !!app && !!apps.access(userId, app);
        },
        retiredApp: (appId, generation) => {
            const row = apps
                .withDeleted(appId)
                .find((one) => one.createdAt === generation && (one.deletedAt !== null || one.id !== appId));
            return row && { name: row.name, ownerUserId: row.ownerUserId };
        },
        isAdmin: (userId) => isAdmin(person(userId)),
        userName: (userId) => person(userId)?.name,
        conversationAudiences: ({ personId, socioId, conversationId }) => {
            const now = Date.now();
            return grants
                .unrevoked({ personId, socioId })
                .filter((grant) => grant.conversationId === conversationId && grant.expiresAt > now)
                .flatMap((grant) => grant.audiences);
        },
    };
};

const IssueComponentSourcesLive = Layer.effectDiscard(
    Effect.gen(function* () {
        const board = yield* SqliteBoardService;
        board.components.useSources(
            issueComponentSources({
                apps: yield* LegacyApps,
                plugins: yield* Plugins,
                people: yield* People,
                grants: (yield* Actors).grants,
            }),
        );
    }),
);

/**
 * The bridges issues needs over the graph's services: auto-triage, the app
 * deliveries, goals, the runner's traces, the media and the Telegram channel,
 * each called at the moment of use. The channel is read from its late-bound
 * port, which the boot step fills after the graph is built.
 */
const IssuesBridges = Layer.unwrap(
    Effect.gen(function* () {
        const autoTriage = yield* AutoTriageInstance;
        const notifications = yield* LegacyNotifications;
        const goals = yield* LegacyGoals;
        const runner = yield* LegacyRunner;
        const media = yield* LegacyMedia;
        const workspace = yield* LegacyWorkspace;
        const ports = yield* Ports;
        return Layer.mergeAll(
            Layer.succeed(
                AutoTriageControl,
                AutoTriageControl.of({
                    start: (options) => autoTriage.start(options),
                    stop: () => autoTriage.stop(),
                    recover: () => autoTriage.recover(),
                }),
            ),
            Layer.succeed(
                Deliveries,
                Deliveries.of({
                    resume: () => notifications.resumeAppDeliveries(),
                    stop: () => notifications.stopAppDeliveries(),
                    queueFromApp: (input) => notifications.queueFromApp(input),
                }),
            ),
            Layer.succeed(Goals, Goals.of({ byTask: (taskId) => goals.byTask(taskId) })),
            Layer.succeed(AgentRunner, AgentRunner.of({ runTrace: (runId) => runner.runTrace(runId) })),
            Layer.succeed(MediaFiles, MediaFiles.of({ turnFiles: (turn, ids) => turnFiles(media, turn, ids) })),
            Layer.succeed(TelegramDirect, {
                online: () => ports.telegram.peek()?.status === 'online',
                linkFor: (userId) => workspace.telegram.linkFor(userId),
                sendDirect: (telegramUserId, text) => ports.telegram.peek()!.sendDirect(telegramUserId, text),
            }),
        );
    }),
);

/**
 * The issues feature's steps: `autoTriage`, the graph's step after
 * learning: auto-triage (`LegacyAutoTriage`) over the root's Board
 * (`main.ts`, `BoardLive`), with `IssuesConfig`, and the issue views
 * (`IssuesViews`). `bridges`, which `main.ts` places after the graph,
 * before auth's tags. The issues module's leader work (`Leadership`)
 * comes from the root (`composition/root.ts`).
 */
export const issuesLayers = {
    autoTriage: Layer.mergeAll(AutoTriageOnWorkspace, IssuesViewsLive, IssueComponentSourcesLive).pipe(
        Layer.provide(CountersHere),
        Layer.provideMerge(IssuesConfigLive),
    ),
    bridges: IssuesBridges,
};
