/**
 * The Hono-to-Effect route adapter. Routes stay Hono and handlers keep building
 * their own `Response`; `handle` only runs the handler's Effect with the
 * process's one `ManagedRuntime` (`main.ts`, `startAppRuntime`). On failure it
 * re-throws what the Effect failed with (`Cause.squash`: the typed error, or
 * the defect itself), so the router's existing `app.onError` answers exactly as
 * it does today.
 *
 * The runtime reaches the features' route mounts through the app they are
 * mounted on: `mountApp` binds it once (`bindAppRuntime`), and a feature's
 * `composition/http/<x>.ts` takes its adapter with `appHandle(app)`, so no
 * mount needs a new parameter. An app made without a runtime (tests that
 * build a platform on their own) still mounts; a route that calls `handle`
 * then fails with an error its `onError` answers, as a module hook's Effect
 * does on a platform with no app runtime (`platform.ts`, `noAppRuntime`).
 */
import { Cause, Effect, Exit, type ManagedRuntime } from 'effect';
import type { Context as HonoContext, Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppRuntime, AppServices } from '../../main.js';

/** What `handle` needs of a runtime: one that can run Effects needing `R`. */
export type HandleRuntime<R> = Pick<ManagedRuntime.ManagedRuntime<R, unknown>, 'runPromiseExit'>;

/** A route handler whose work is an Effect that ends in the handler's own `Response`. */
export type EffectHandler<R, E = unknown> = (c: HonoContext<AppEnv>) => Effect.Effect<Response, E, R>;

/** Turns an `EffectHandler` into a Hono handler. */
export type HandleFn<R> = <E>(f: EffectHandler<R, E>) => (c: HonoContext<AppEnv>) => Promise<Response>;

/**
 * The adapter. Called directly, a client that goes away interrupts the
 * fiber (the request's abort signal is forwarded). `uninterruptible` runs
 * the fiber to its end instead and returns the handler's own `Response`,
 * as a plain async Hono handler does: for routes whose work must finish
 * once started, and so a client that leaves causes no interruption
 * failure, and so no logged 500.
 */
export type Handle<R> = HandleFn<R> & { readonly uninterruptible: HandleFn<R> };

/**
 * Makes `handle` over `runtime`. Each request runs `f(c)` in a server span
 * named `${method} ${routePath}`; the direct form passes the request's
 * abort signal, so a client that goes away interrupts the fiber, and
 * `uninterruptible` doesn't. Success returns the handler's `Response` as
 * it is (a 201, a 304 with no body, Markdown, bytes); failure throws
 * `Cause.squash(exit.cause)` to the router's `onError`.
 */
export function makeHandle<R>(runtime: () => HandleRuntime<R>): Handle<R> {
    const over =
        (interruptOnAbort: boolean): HandleFn<R> =>
        (f) =>
        async (c) => {
            const exit = await runtime().runPromiseExit(
                f(c).pipe(Effect.withSpan(`${c.req.method} ${c.req.routePath}`, { kind: 'server' })),
                interruptOnAbort ? { signal: c.req.raw.signal } : undefined,
            );
            if (Exit.isSuccess(exit)) {
                return exit.value;
            }
            throw Cause.squash(exit.cause);
        };
    return Object.assign(over(true), { uninterruptible: over(false) });
}

const runtimes = new WeakMap<Hono<AppEnv>, AppRuntime>();

/** Binds the process's runtime to `app`, for `appHandle`; `mountApp` calls it first. */
export function bindAppRuntime(app: Hono<AppEnv>, runtime: AppRuntime) {
    runtimes.set(app, runtime);
}

/**
 * The runtime bound to `app`, if any: for a mount whose handlers aren't
 * Effects but read services the runtime built (the pages' loaders read the
 * features' views, `web.ts`). Pass the app the mount was given.
 */
export function boundAppRuntime(app: Hono<AppEnv>): AppRuntime | undefined {
    return runtimes.get(app);
}

/**
 * `handle` over the runtime bound to `app`, read when a request runs. Pass
 * the app the mount was given (not a sub-app made inside the mount).
 */
export function appHandle(app: Hono<AppEnv>): Handle<AppServices> {
    return makeHandle(() => {
        const runtime = runtimes.get(app);
        if (!runtime) {
            throw new Error('A route returned an Effect, but this app has no app runtime to run it.');
        }
        return runtime;
    });
}
