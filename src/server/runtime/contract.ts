/**
 * What other features may know of the runtime (CB-108): its tags, the
 * slices of its services they call, its error and its constants. It
 * imports only `effect`, `@socio/*` and `import type` from `node:*`, and
 * holds no logic.
 *
 * The ownership types (`WorkLease`, `OwnershipError`, the identity's and
 * ownership's shapes) and `RuntimeSession`, which implements them, are in
 * `@socio/data/runtime-ownership`: the turn runner, below this feature, makes
 * the process's identity. This contract re-exports the types, so the tags'
 * callers name them here.
 */
import { Context, type Effect } from 'effect';

import type { RuntimeIdentityShape } from '@socio/data/runtime-ownership';
import type { AppEnvironment, ForceStopResult, RunningWork } from '@socio/shared/operator';

export {
    OwnershipError,
    type RuntimeIdentityShape,
    type RuntimeOwnershipShape,
    type WorkLease,
} from '@socio/data/runtime-ownership';

// ── Plain types and constants ─────────────────────────────────────────────

/** What a refused turn or run says while the server drains for a restart. */
export const DRAINING_MESSAGE = 'Socio is updating. Try again in a minute.';
/** `Retry-After` (seconds) on requests refused while draining. */
export const DRAINING_RETRY_AFTER_S = 60;

// ── Tags ─────────────────────────────────────────────────────────────────

/**
 * This process's runtime identity (CB-108), shared by its turns, job runs
 * and leader lease: one per process, attached to each database it uses.
 * `RuntimeSession` implements it; today `LocalAgentRunner` makes it.
 */
export class RuntimeIdentity extends Context.Service<RuntimeIdentity, RuntimeIdentityShape>()(
    'socio/runtime/RuntimeIdentity',
) {}

/**
 * The drain (CB-37, CB-108): set on SIGTERM, after which new turns and runs are
 * refused while the running ones finish. `LeaderWork` holds it (`drain()`, over
 * the `draining` port); the root bridges it.
 */
export interface LifecycleShape {
    /** Whether the server is draining, read when the Effect runs. */
    readonly draining: Effect.Effect<boolean>;
    /** Starts the drain; a second call does nothing. */
    readonly drain: Effect.Effect<void>;
}

export class Lifecycle extends Context.Service<Lifecycle, LifecycleShape>()('socio/runtime/Lifecycle') {}

/**
 * The work running in this process, and the operator's force stop (CB-108,
 * development only; the route checks that). Promise-based, as
 * `runningWork` and `forceStop` (`runtime/force-stop.ts`) are today.
 */
export interface WorkControlShape {
    /** What is running now (the Platform page's counts). */
    readonly running: () => Promise<RunningWork>;
    /** Stops running work at once; with `hold`, drains until the restart. */
    readonly forceStop: (options: { by: string; hold: boolean }) => Promise<ForceStopResult>;
}

export class WorkControl extends Context.Service<WorkControl, WorkControlShape>()('socio/runtime/WorkControl') {}

/** The `PlatformConfig` field the runtime reads, built once from env. */
export interface RuntimeConfigShape {
    /** `APP_ENV`; production when unset. Development enables the force stop and `SHUTDOWN_FORCE`. */
    readonly environment: AppEnvironment;
}

export class RuntimeConfig extends Context.Service<RuntimeConfig, RuntimeConfigShape>()(
    'socio/runtime/RuntimeConfig',
) {}
