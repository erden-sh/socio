/**
 * Socio-actor access's construction: the graph's step over actors' layers
 * (`actors/layer.ts`), and the builder the tests call, over the same code
 * (`makeActors`). What no tag holds yet at the step is provided to it from the
 * boot step's objects: `ActorsHost` (the workspace's access changes, the
 * settings store's tasks, the Telegram links' thread kinds). Later, `actions`:
 * `ActorActions` over the approvals, apps and plugins.
 */
import { Context, Effect, Layer } from 'effect';

import { actorActions } from '../actors/action-calls.js';
import { ActorActions, Actors, ActorsConfig, ActorServices, type ActorsConfigShape } from '../actors/contract.js';
import { ActorAccessTag, ActorsHost, ActorsLive, makeActors, type ActorsHostShape } from '../actors/layer.js';
import type { ActorAccess } from '../actors/service.js';
import { Approvals } from '../approvals/contract.js';
import { Apps } from '../apps/contract.js';
import type { FlagService } from '../flags/service.js';
import type { LocalAgentRunner } from '../turns/local-runner.js';

import { LegacyStore, LegacyWorkspace } from './base.js';
import type { CoreStore } from './core-store.js';
import { PlatformKeys } from './keys.js';
import { LegacyPlugins } from './plugins.js';
import type { AppWorkspace } from './workspace-parts.js';

/** Socio-actor access, as the apps' step holds it (the class): the layer's own tag. */
export { ActorAccessTag as LegacyActors };

/**
 * `ActorsConfig` from the startup configuration: the instance secret
 * `platformKeys` resolved once from the supplied `PlatformConfig`
 * (`SESSION_SECRET`, or this process's own when that is unset), the same
 * value every feature that keys on it sees. Moving env parsing into
 * composition is a later change.
 */
export function actorsConfig(keys: { secret: string }): ActorsConfigShape {
    return { secret: keys.secret };
}

/** What socio access reads of the boot step's stores that no tag holds yet. */
export function actorsHost(workspace: AppWorkspace, store: CoreStore): ActorsHostShape {
    return {
        onAccessChange: (listener) => workspace.onAccessChange(listener),
        task: (id) => store.scheduled.get(id),
        threadInfo: (threadId) => workspace.telegram.threadInfo(threadId),
    };
}

/**
 * Socio-actor access (CB-232), and its grants checked again on each access
 * change, for the tests: the layer's service (`makeActors`)
 * over the workspace store, which implements the slices it reads.
 */
export function buildActors(deps: {
    store: CoreStore;
    workspace: AppWorkspace;
    runner: LocalAgentRunner;
    secret: string;
    /** The platform's flags, read at each check (tests replace them). */
    flags: () => FlagService;
}): ActorAccess {
    const { store, workspace } = deps;
    return makeActors({
        db: workspace.db,
        ownership: deps.runner.runtime.attach(workspace.db),
        config: actorsConfig(deps),
        people: workspace,
        socios: workspace,
        conversations: workspace,
        flags: deps.flags,
        host: actorsHost(workspace, store),
    });
}

/**
 * `ActorsHost` over the boot step's stores. The runtime identity is the
 * graph's (`runtimeLayers.bridges`, a leaf bridge at the chain's front).
 */
const early = Layer.effect(
    ActorsHost,
    Effect.gen(function* () {
        return actorsHost(yield* LegacyWorkspace, yield* LegacyStore);
    }),
);

/**
 * `ActorActions`: the action calls and `consumeAppAction` over the very
 * objects the routes read from the graph's tags: socio access, the
 * approvals, the apps, the plugins (the class, with its `appsSettings`)
 * and the workspace. It builds only closures and takes no listener. Those
 * objects are also `ActorServices`, which the module's hooks read.
 */
const ActorActionsLive = Layer.effectContext(
    Effect.gen(function* () {
        const services = ActorServices.of({
            actors: yield* Actors,
            approvals: yield* Approvals,
            apps: yield* Apps,
            plugins: yield* LegacyPlugins,
            workspace: yield* LegacyWorkspace,
        });
        return Context.make(ActorActions, ActorActions.of(actorActions(services))).pipe(
            Context.add(ActorServices, services),
        );
    }),
);

/**
 * Socio-actor access's steps of the graph: the service (`LegacyActors`,
 * `Actors`, with `AppActors` over it) and its `ActorsConfig`; then, once
 * the approvals, the apps and the plugins are built, `actions`
 * (`ActorActions`).
 */
export const actorsLayers = {
    actors: Layer.unwrap(
        Effect.gen(function* () {
            return ActorsLive((yield* LegacyWorkspace).db);
        }),
    ).pipe(
        Layer.provide(early),
        Layer.provideMerge(
            Layer.effect(
                ActorsConfig,
                Effect.gen(function* () {
                    return actorsConfig(yield* PlatformKeys);
                }),
            ),
        ),
    ),
    actions: ActorActionsLive,
};
