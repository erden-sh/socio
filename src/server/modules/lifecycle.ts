/**
 * The module runner: calls every module's lifecycle and prompt hooks in
 * registry order (or reverse, for `release` and `stop`), the way `LeaderWork`
 * and the socios' extensions (`dots/layer.ts`) call them, and runs a hook that
 * returns an Effect with the app's runtime.
 *
 * A hook's Effect is run to its end before the next module's hook starts,
 * as a promise is awaited. Its failure is handled as a thrown error or a
 * rejected promise is: the runner rethrows the failure itself (a typed
 * error, a defect, or an interruption, `Cause.squash`), never a wrapper, so
 * `stop`'s "every module, then the first failure" and a tick's failure
 * report see the same errors they do for promise hooks.
 *
 * The runtime comes from the composition root as a `ModuleServicesAccess`
 * (`moduleServices(() => runtime, () => built)`): it is built from a layer
 * that builds the app's services, so it is read only when a hook uses it.
 */
import { Cause, Context, Effect, Exit, type ManagedRuntime } from 'effect';

import type { DotTurn } from '@socio/foundation/turns/turn';

import type {
    ModuleContext,
    ModuleHookResult,
    ModuleServices,
    ModuleServicesAccess,
    ServerModule,
} from './contract.js';

/** Runs a hook's Effect to a promise of its value, rejected with its failure. */
export type ModuleEffectRunner<R = ModuleServices> = <A>(effect: Effect.Effect<A, unknown, R>) => Promise<A>;

/** What the runner needs of a runtime: one that can run Effects needing `R`. */
export type ModuleRuntime<R = ModuleServices> = Pick<ManagedRuntime.ManagedRuntime<R, unknown>, 'runPromiseExit'>;

/**
 * Runs hook Effects with `runtime()`, read at each run; a failure rejects
 * with what the Effect failed with (`Cause.squash`), as the issues
 * leadership does.
 */
export function moduleEffectRunner<R = ModuleServices>(runtime: () => ModuleRuntime<R>): ModuleEffectRunner<R> {
    return async (effect) => {
        const exit = await runtime().runPromiseExit(effect);
        if (Exit.isFailure(exit)) {
            throw Cause.squash(exit.cause);
        }
        return exit.value;
    };
}

/**
 * The app's services for module hooks (`ModuleContext.services`), from the
 * runtime the composition root made and the services it built: `built()`
 * is undefined until the root's `runtime.context()` resolves, so a hook
 * that reads a service while the graph is built (`capabilities`) is told
 * so instead of getting half a graph.
 */
export function moduleServices<R = ModuleServices>(
    runtime: () => ModuleRuntime<R>,
    built: () => Context.Context<R> | undefined,
): ModuleServicesAccess<R> {
    return {
        get: (tag) => {
            const context = built();
            if (!context) {
                throw new Error(
                    `A module hook asked for ${tag.key} while the app's services were being built: only hooks that run after boot (routes, dotTools, setup, the lifecycle and prompt hooks) can read them.`,
                );
            }
            return Context.get(context, tag);
        },
        run: moduleEffectRunner(runtime),
    };
}

/**
 * A hook's result as today's callers take it: an Effect becomes a promise
 * (run now), anything else is returned as it is, so a sync value stays
 * sync and a promise stays that promise.
 */
export function settleHook<A, R>(result: ModuleHookResult<A, R>, run: ModuleEffectRunner<R>): A | Promise<A> {
    return Effect.isEffect(result) ? run(result as Effect.Effect<A, unknown, R>) : (result as A | Promise<A>);
}

type Modules<R> = readonly ServerModule<R>[];

/** `LeaderWork.lead()`'s loop: each module's `start`, in registry order; the first failure stops it. */
export async function startModules<R>(modules: Modules<R>, ctx: ModuleContext, run: ModuleEffectRunner<R>) {
    for (const module of modules) {
        await settleHook(module.start?.(ctx), run);
    }
}

/** `LeaderWork.succeed()`'s loop: each module's `succeed`, in registry order; the first failure stops it. */
export async function succeedModules<R>(modules: Modules<R>, ctx: ModuleContext, run: ModuleEffectRunner<R>) {
    for (const module of modules) {
        await settleHook(module.succeed?.(ctx), run);
    }
}

/**
 * A hook of every module in reverse registry order, each even if an
 * earlier one failed; then the first failure is rethrown.
 */
async function inReverse<R>(
    modules: Modules<R>,
    hook: (module: ServerModule<R>) => ModuleHookResult<void, R>,
    run: ModuleEffectRunner<R>,
) {
    let failure: { error: unknown } | undefined;
    for (const module of [...modules].reverse()) {
        try {
            await settleHook(hook(module), run);
        } catch (error) {
            failure ??= { error };
        }
    }
    if (failure) {
        throw failure.error;
    }
}

/** `LeaderWork.stopBackground()`'s loop: every module's `release`, in reverse order; the first failure is rethrown. */
export function releaseModules<R>(modules: Modules<R>, ctx: ModuleContext, run: ModuleEffectRunner<R>) {
    return inReverse(modules, (module) => module.release?.(ctx), run);
}

/** `LeaderWork.stop()`'s loop: every module's `stop`, in reverse order; the first failure is rethrown. */
export function stopModules<R>(modules: Modules<R>, ctx: ModuleContext, run: ModuleEffectRunner<R>) {
    return inReverse(modules, (module) => module.stop?.(ctx), run);
}

/**
 * One run of a module's tick, for `LeaderWork.lead()`'s timer: an Effect
 * becomes a promise, so the timer skips ticks until it settles, as it does
 * for a run that returns a promise; anything else is returned as it is.
 */
export function runTick<R>(
    tick: NonNullable<ServerModule<R>['tick']>,
    ctx: ModuleContext,
    run: ModuleEffectRunner<R>,
): unknown {
    return settleHook(tick.run(ctx), run);
}

/** `dotExtensions.pageContext`: the first module's page that isn't undefined, in registry order. */
export async function modulePageContext<R>(
    modules: Modules<R>,
    ctx: ModuleContext,
    turn: DotTurn,
    run: ModuleEffectRunner<R>,
) {
    for (const module of modules) {
        const page = await settleHook(module.dotPageContext?.(ctx, turn), run);
        if (page !== undefined) {
            return page;
        }
    }
    return undefined;
}

/** `dotExtensions.news`: every module's `dotNews`, joined in registry order. */
export async function moduleNews<R>(
    modules: Modules<R>,
    ctx: ModuleContext,
    turn: DotTurn,
    run: ModuleEffectRunner<R>,
) {
    let news = '';
    for (const module of modules) {
        news += (await settleHook(module.dotNews?.(ctx, turn), run)) ?? '';
    }
    return news;
}

/** `dotExtensions.turnNote`: every module's `dotTurnNote`, joined in registry order. */
export async function moduleTurnNote<R>(
    modules: Modules<R>,
    ctx: ModuleContext,
    turn: DotTurn,
    run: ModuleEffectRunner<R>,
) {
    let note = '';
    for (const module of modules) {
        note += (await settleHook(module.dotTurnNote?.(ctx, turn), run)) ?? '';
    }
    return note;
}
