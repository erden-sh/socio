import { Effect } from 'effect';
import { Hono, type Context as HonoContext } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireOperator } from '@socio/foundation/http/guards';
import { forceStopLogLine } from '@socio/foundation/runtime/force-stop-log';
import type { AppEnvironment, ForceStopResult, OperatorWork } from '@socio/shared/operator';
import type { SearchStatsView } from '@socio/shared/pages/page-search';
import type { BackupStatus, ContinuousCopyStatus } from '@socio/shared/types';

import type { WorkControlShape } from '../runtime/contract.js';

const forceStopInput = z
    .object({
        /** Refuse new work until the restart (default): a deploy follows. */
        hold: z.boolean().optional(),
    })
    .strict();

/**
 * What the operator's routes read of the process, as Effects over the
 * services that hold it (`R`): the composition root binds them to the
 * runtime's and the pages' tags (`composition/http/operator.ts`).
 */
export interface OperatorReads<R> {
    /** `APP_ENV` (`RuntimeConfig`): production when unset. */
    readonly environment: Effect.Effect<AppEnvironment, never, R>;
    /** Whether the server is draining (`Lifecycle`), read when the request runs. */
    readonly draining: Effect.Effect<boolean, never, R>;
    /** Page search's timings and the kept page revisions (`PageStore`). */
    readonly pageSearch: Effect.Effect<SearchStatsView, never, R>;
}

/** Runs a route's Effect with the app's runtime (`appHandle`, `composition/http/handle.ts`). */
export type OperatorHandle<R> = <E>(
    f: (c: HonoContext<AppEnv>) => Effect.Effect<Response, E, R>,
) => (c: HonoContext<AppEnv>) => Promise<Response>;

/**
 * What the work view, the force stop and the replication status read of
 * the process: the running work and its force stop (`WorkControlShape`,
 * which the composition root builds over the platform and the task runner
 * until `WorkControl` is provided in the graph), the backups (set late,
 * `useBackups`) and the operational log.
 */
export interface OperatorRouteSources {
    readonly work: WorkControlShape;
    readonly backups: () => { status(): Pick<BackupStatus, 'continuous'> } | undefined;
    readonly log: (line: string) => void;
}

/**
 * Operator API: `GET /api/operator/work` (the environment and what is
 * running), `GET /api/operator/page-search` (page search timings, kept page revisions), `GET /api/operator/replication` (the continuous copy, CB-109) and, in development only (`APP_ENV=development`; 404 otherwise),
 * `POST /api/operator/force-stop`, which stops running work at once so a
 * deploy doesn't wait for it. Operators only (403 for admins and members),
 * like the other platform controls. Every force stop is logged: who, when
 * and the counts.
 */
export function operatorRoutes<R>(sources: OperatorRouteSources, reads: OperatorReads<R>, handle: OperatorHandle<R>) {
    const app = new Hono<AppEnv>();
    // Outside development the route does not exist, for everyone. The
    // route behind the gate runs to its end even if the client goes away,
    // so a force stop that started is always logged.
    app.use('/operator/force-stop', (c, next) =>
        handle((c) =>
            Effect.gen(function* () {
                if ((yield* reads.environment) !== 'development') {
                    return c.json({ error: 'Not found.' }, 404);
                }
                yield* Effect.uninterruptible(Effect.promise(() => next()));
                return c.res;
            }),
        )(c),
    );
    app.use('/operator', requireOperator);
    app.use('/operator/*', requireOperator);
    app.get(
        '/operator/work',
        handle((c) =>
            Effect.gen(function* () {
                const environment = yield* reads.environment;
                const draining = yield* reads.draining;
                const work = yield* Effect.promise(() => sources.work.running());
                return c.json({
                    environment,
                    forceStop: environment === 'development',
                    draining,
                    work,
                } satisfies OperatorWork);
            }),
        ),
    );
    // Page search's daily timing rollup and index sizes (no query text),
    // and how many page revisions are kept (counts and bytes only).
    app.get(
        '/operator/page-search',
        handle((c) => Effect.map(reads.pageSearch, (stats) => c.json(stats satisfies SearchStatsView))),
    );
    // The continuous copy of the database (CB-109): null when
    // LITESTREAM_REPLICA_DIR isn't set. Times only.
    app.get('/operator/replication', (c) =>
        c.json({
            continuous: sources.backups()?.status().continuous ?? null,
        } satisfies { continuous: ContinuousCopyStatus | null }),
    );
    app.post('/operator/force-stop', async (c) => {
        const parsed = forceStopInput.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) {
            return c.json({ error: 'Invalid force stop.' }, 400);
        }
        const by = c.get('user').id;
        const result = await sources.work.forceStop({
            by,
            hold: parsed.data.hold ?? true,
        });
        sources.log(forceStopLogLine(by, result));
        return c.json(result satisfies ForceStopResult);
    });
    return app;
}
