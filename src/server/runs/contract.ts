/**
 * What other features may know of Runs (CB-128, CB-188, CB-194): its tag,
 * the slice of the service they call, and plain types. It imports only
 * `effect`, `@socio/*` and, with `import type`, `node:*`, and holds no logic.
 *
 * One import from another folder reaches into `runs/` today:
 * `turns/local-runner.ts` calls `runRefRecorder` (`infra/sqlite/run-refs.ts`)
 * for each turn's `run_refs`. That is infra over a SQLite connection, not a
 * pure helper, so it goes behind the `RunRefs` tag below rather than into a
 * package (`@socio/foundation` has no database, and `@socio/data` doesn't
 * depend on `@socio/shared`). `sqliteRunRefs` in `run-refs.ts` implements it.
 * The composition root provides `RunRefs` through `runs/layer.ts`.
 *
 * `RunsViews` holds the run views, moved from `live/views/runs.ts` (the old
 * copy was deleted once the issue routes read this tag).
 *
 * Not here, on purpose:
 * - No `RunsConfig`: Runs reads no `PlatformConfig` field.
 * - `runsModule`, `runRoutes`, `RunRoutesDeps` and `RUN_LIMIT`: the modules
 *   registry's and the routes' own; only `runs/` and its tests use them.
 * - `RunViewSources` (`views.ts`): what the views read, not what Runs
 *   offers.
 * - `RunRef`, `RunRefRecorder`, `RUN_REF_KINDS` and `RUN_REF_MAX`: already in
 *   `@socio/shared/runs/run-refs`.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context } from 'effect';

import type { AccessRoomContext } from '@socio/shared/operations/operations-access';
import type { RunRefRecorder } from '@socio/shared/runs/run-refs';
import type { RunTraceView } from '@socio/shared/runs/run-trace';
import type { AgentRunStatus, AgentRunSummary } from '@socio/shared/types';

// ── What grounded a turn (CB-194) ────────────────────────────────────────

/**
 * Where a turn records what grounded it, in `run_refs` (the Runs module's
 * table): references only, each once per turn, and a write that fails is
 * skipped, never failing the tool. `recorder` takes the connection the turn's
 * `agent_runs` row is written on (the runner's own), as `runRefRecorder` does
 * today.
 */
export interface RunRefsShape {
    readonly recorder: (db: DatabaseSync, runId: string, threadId: string) => RunRefRecorder;
}

export class RunRefs extends Context.Service<RunRefs, RunRefsShape>()('socio/runs/RunRefs') {}

// ── The run views ────────────────────────────────────────────────────────

/** What `GET /api/runs` lists: the latest turns, as `runsView` answers. */
export interface RunsList {
    limit: number;
    runs: AgentRunSummary[];
}

/**
 * One turn's trace as `runTraceView` finds it: the view sent, and, for the
 * access log only (CB-188, CB-213), whose conversation it is and a room
 * turn's context. Neither is sent.
 */
export interface RunTraceFound {
    view: RunTraceView;
    ownerId: string | undefined;
    room?: AccessRoomContext;
}

/**
 * The run views, for the viewer: Runs' routes and page loader answer with
 * them, and the Board opens a filing's trace through `runTraceView`.
 */
export interface RunsViewsShape {
    /**
     * `GET /api/runs`: the latest `limit` turns, newest first, leaving out
     * deleted conversations; with `own`, only the viewer's (members).
     */
    readonly runsView: (
        viewerId: string,
        options: { status?: AgentRunStatus; limit: number; own?: boolean },
    ) => Promise<RunsList>;
    /** `GET /api/runs/:runId/trace` (CB-128): null (a 404) for anyone who may not open it. */
    readonly runTraceView: (viewer: { id: string; admin: boolean }, runId: string) => RunTraceFound | null;
}

export class RunsViews extends Context.Service<RunsViews, RunsViewsShape>()('socio/runs/RunsViews') {}
