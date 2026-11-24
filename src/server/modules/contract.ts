/**
 * What a server module is, for every feature that has one: `ServerModule`,
 * the `ModuleContext` its hooks get, and what a hook may return. Types only,
 * importing other features' contracts and packages, never their files.
 *
 * Moved from `modules/types.ts`, since deleted with the context's `store`,
 * `workspace` and `config`, then its `platform`: a hook reads the
 * workspace's settings, its slices, its feature's configuration and every
 * service it used to reach on the platform as the app's services, by their
 * tags (`WorkspaceSettings`, `People`, `Conversations`, `XConfig`,
 * `Approvals`, ...).
 *
 * The composition side fills in, by declaration merging,
 * `ModuleRuntimeServices`: the services a hook may use, the app's
 * (`AppServices`), so this contract never names the app's layer graph. The
 * composition root (`main.ts`) binds them where it builds the runtime.
 *
 * How a hook reaches those services (`ModuleContext.services`):
 *
 * - An Effect hook (`start`, `succeed`, `release`, `stop`, `tick`, the
 *   prompt hooks) yields the tags: the runner runs it with the app's runtime.
 * - A synchronous hook (`routes`, `dotTools`, `setup`) reads one with
 *   `services.get(Tag)`: the service the root built at boot, at once.
 * - Promise code runs an Effect with `services.run(effect)`.
 *
 * `capabilities` runs while the graph is built, before the services are,
 * so it can't read them then: what it lists reads them later, when a turn
 * asks (`status`). What it wires at once (socio access's approvals, the
 * plugins' late bindings) it reads from the services built before the
 * capabilities, which its caller passes it (`ModuleBuildServices`).
 */
import type { DatabaseSync } from 'node:sqlite';

import type { ToolDefinition } from '@copilotkit/runtime/v2';
import type { Context, Effect } from 'effect';
import type { Hono } from 'hono';

import type { Migration, SchemaSet } from '@socio/data/migrate';
import type { DataContext } from '@socio/data/uow';
import type { CapabilityDefinition } from '@socio/foundation/capabilities/definition';
import type { AppEnv } from '@socio/foundation/http/app-env';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { DatasetFilesStatus, SetupStatus } from '@socio/shared/types';

// ── What the composition side binds ──────────────────────────────────────

/**
 * The services a hook may use, bound by the composition root where it
 * builds the app's runtime (`main.ts`): `{ app: AppServices }`.
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- filled by declaration merging
export interface ModuleRuntimeServices {}

/** The app's services, which an Effect hook's `R` may name; `never` until bound. */
export type ModuleServices = ModuleRuntimeServices extends { app: infer S } ? S : never;

/**
 * How a hook reaches the app's services (`ModuleContext.services`): the
 * services the composition root built once, at boot, never a second
 * runtime. A platform built on its own (tests, scripts) offers the ones
 * the modules' hooks read, built over its connection and its members, and
 * says which when asked for another (`composition/module-services.ts`).
 */
export interface ModuleServicesAccess<R = ModuleServices> {
    /**
     * The service behind `tag`, synchronously, for the hooks whose callers
     * use their value at once (`routes`, `dotTools`, `setup`). Throws while
     * the graph is still being built (the `capabilities` hook), and for a
     * service a platform built on its own doesn't offer.
     */
    readonly get: <I extends R, S>(tag: Context.Key<I, S>) => S;
    /**
     * Runs `effect` with the app's runtime: a promise of its value,
     * rejected with its failure itself, as the runner runs an Effect hook.
     */
    readonly run: <A>(effect: Effect.Effect<A, unknown, R>) => Promise<A>;
}

// ── Hooks ────────────────────────────────────────────────────────────────

/**
 * What a hook may return: a value, a promise of it, or an Effect whose `R`
 * is (part of) the app's services. The module runner (`modules/lifecycle.ts`)
 * runs an Effect with the app's runtime and treats its failure as a thrown
 * error or rejected promise: the failure itself, not a wrapper.
 */
export type ModuleHookResult<A, R = ModuleServices> = A | Promise<A> | Effect.Effect<A, unknown, R>;

/**
 * The services built before the capabilities (the approvals, socio access,
 * the apps, the plugins, ...), by tag, while the graph is still being
 * built: what a `capabilities` hook wires at once. Throws for a service
 * built after them.
 */
export interface ModuleBuildServices {
    readonly get: <I, S>(tag: Context.Key<I, S>) => S;
}

/**
 * What a module's hooks get; one per platform, shared by all modules: the
 * workspace connection and its data layer, the app's services and the log.
 * No platform: a hook reads what it needs as a service.
 */
export interface ModuleContext {
    /** The workspace connection, which module stores share; migrated at boot. */
    db: DatabaseSync;
    /**
     * The data layer on that connection (CB-110): its unit of work, which
     * every repository on it joins. Modules build their repositories from it.
     */
    data: DataContext;
    /**
     * The app's services, which the hook reads by their tags
     * (`ModuleServicesAccess`): among them the workspace's settings and
     * slices and each feature's configuration, which this context no
     * longer carries.
     */
    services: ModuleServicesAccess;
    /** Operational lines only: never message content, tokens or chat IDs. */
    log: (line: string) => void;
}

/**
 * A server module, listed in `modules/index.ts`. Its id names its
 * `schema_migrations` rows and its routes' prefix, and matches the client
 * module of the same feature. Hooks that read data may return a promise
 * (repositories are async, CB-110), and the lifecycle and prompt hooks may
 * return an Effect (`ModuleHookResult`): the runner awaits each in registry
 * order, so what they add, and where, is the same as when they were sync.
 * `routes`, `dotTools`, `capabilities` and `setup` stay synchronous: their
 * callers use the value at once.
 * `R` is what its Effect hooks need, the app's services by default; it only
 * appears in what the hooks return, so a module that needs less fits
 * wherever more is provided.
 */
export interface ServerModule<R = ModuleServices> extends SchemaSet {
    /** Lowercase letters, digits and dashes. */
    id: string;
    /**
     * The path segments under `/api` its routes may use; `[id]` by default.
     * Modules that predate the registry keep their extra paths; new ones don't.
     */
    paths?: readonly string[];
    /** Admin-only modules have every path guarded by `requireAdmin`. */
    access?: 'admin';
    migrations?: readonly Migration[];
    /** Mounted at `/api` after the user middleware, in registry order. */
    routes?: (ctx: ModuleContext) => Hono<AppEnv>;
    /**
     * Called in registry order by `LeaderWork.lead()`, after ticks are set:
     * when this runtime becomes the leader (CB-108), so work that must run
     * once (polling, schedules) belongs here, never request handling.
     */
    start?: (ctx: ModuleContext) => ModuleHookResult<void, R>;
    /**
     * Recovery of what a dead process left (runs it was following, work it
     * marked in progress), by `LeaderWork.succeed()`: once, on the leader,
     * when no other runtime is alive. In a start-first deploy that is after
     * the previous task exits, so it never takes over work still running.
     */
    succeed?: (ctx: ModuleContext) => ModuleHookResult<void, R>;
    /**
     * The leader hands over (a drain, CB-108): stop what `start` started so
     * the next leader can, while this process still serves requests and
     * finishes its turns and runs. `LeaderWork.stopBackground()`, in reverse
     * registry order, before the ticks' last runs settle.
     */
    release?: (ctx: ModuleContext) => ModuleHookResult<void, R>;
    /** Called in reverse registry order by `LeaderWork.stop()`. */
    stop?: (ctx: ModuleContext) => ModuleHookResult<void, R>;
    /**
     * Periodic work from `start()` until `release()` or `stop()`, on the
     * leader only; the timer doesn't hold the process. A run that returns a
     * promise (or an Effect, which the runner turns into one) skips ticks
     * until it settles.
     */
    tick?: { everyMs: number; run: (ctx: ModuleContext) => ModuleHookResult<unknown, R> };
    /**
     * Tools this module gives every Dot turn that has tools (not `textOnly`
     * ones), for the turn's Dot acting for its user. Collected in registry
     * order by `LegacyDotExtensions`.
     */
    dotTools?: (ctx: ModuleContext, turn: DotTurn) => ToolDefinition[];
    /**
     * The page the turn's conversation is about, which the prompt shows as
     * untrusted data; undefined when this module has none (a promise or
     * Effect may resolve to either). The first module that answers wins.
     */
    dotPageContext?: (ctx: ModuleContext, turn: DotTurn) => ModuleHookResult<unknown, R>;
    /**
     * A line for the prompt about what changed since the Dot last spoke to
     * this user (marking it told), or an empty string. Joined in registry order.
     */
    dotNews?: (ctx: ModuleContext, turn: DotTurn) => ModuleHookResult<string, R>;
    /**
     * A note for this turn only (marking what it tells as told), or an empty
     * string: unlike `dotNews`, it goes just before the person's newest
     * message, not in the system prompt (`withTurnNote`), so the prompt's
     * start stays the same from turn to turn. Joined in registry order.
     */
    dotTurnNote?: (ctx: ModuleContext, turn: DotTurn) => ModuleHookResult<string, R>;
    /**
     * What the `capabilities` tool lists for it; registered when the platform
     * is built, in registry order. `built` reads the services built before
     * the capabilities, for what the hook wires at once; what it lists reads
     * `ctx.services` when a turn asks.
     */
    capabilities?: (ctx: ModuleContext, built: ModuleBuildServices) => readonly CapabilityDefinition[];
    /** Merged into `AppStatus.setup()` (`/api/workspace` setup, `/healthz`). */
    setup?: (ctx: ModuleContext) => Partial<SetupStatus>;
    /**
     * What `AppStatus` reports to operators: counts in `/healthz` (no ids:
     * it is unauthenticated), the whole of it in admins' setup.
     */
    health?: (ctx: ModuleContext) => ModuleHealth;
}

/** What modules report to operators (`ServerModule.health`). */
export interface ModuleHealth {
    datasetFiles?: DatasetFilesStatus;
}
