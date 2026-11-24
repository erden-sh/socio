import { Hono, type Context, type Handler } from 'hono';
import { z } from 'zod';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJson } from '@socio/foundation/http/conditional';
import { GOAL_COMMENT_MAX, type SchedulesState } from '@socio/shared/schedule-types';

import { ScheduleError } from './contract.js';
import {
    scheduleDetailView,
    scheduleRunsView,
    schedulesView,
    withLongRuns,
    type ScheduleViewSources,
} from './detail.js';
import type { GoalService } from './goals.js';
import { JobError, type JobService } from './jobs.js';
import type { LongRunService } from './long-runs.js';
import type { ScheduleService } from './service.js';
import type { SchedulesStore } from './slices.js';

/** What the routes use: the views' sources, with the whole of this folder's services. */
export type ScheduleRouteSources = ScheduleViewSources & {
    readonly schedules: ScheduleService;
    readonly jobs: JobService;
    readonly goals: GoalService;
    readonly longRuns: LongRunService;
    readonly store: SchedulesStore;
};

/**
 * `/api/schedules`: a user's own schedules (the Dots' and their own
 * repeating tasks) and jobs. Nobody sees another user's; operators also get
 * everyone's counts, never titles, prompts, code or logs.
 */
export function scheduleRoutes(platform: ScheduleRouteSources) {
    const app = new Hono<AppEnv>();
    const { schedules, jobs } = platform;
    const handle =
        (work: (c: Context<AppEnv>) => unknown): Handler<AppEnv> =>
        async (c) => {
            try {
                return c.json((await work(c)) ?? { ok: true });
            } catch (error) {
                if (error instanceof ScheduleError || error instanceof JobError || error instanceof DataError) {
                    return c.json({ error: error.message }, error.status);
                }
                throw error;
            }
        };
    const user = (c: Context<AppEnv>) => c.get('user').id;
    const id = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';

    // Polled by Schedules: 304 when the answer is the same (a body hash).
    app.get('/schedules', async (c) => {
        const state = await withLongRuns(platform, await schedulesView(platform, c.get('user')));
        return conditionalJson(c, (): SchedulesState => state);
    });
    app.post(
        '/schedules/:id/actions',
        handle(async (c) => {
            const parsed = z
                .object({ action: z.enum(['run', 'pause', 'resume', 'cancel']) })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                throw new ScheduleError('Unknown action.');
            }
            if (parsed.data.action === 'run' && !platform.store.settings().researchAllowed) {
                throw new ScheduleError('Research is disabled in Settings.', 403);
            }
            return schedules.act(user(c), id(c, 'id'), parsed.data.action);
        }),
    );
    // A comment on the person's own goal (CB-135); the Dot's are goal_comment.
    app.post(
        '/schedules/goals/:id/comments',
        handle(async (c) => {
            const parsed = z
                .object({ body: z.string().trim().min(1).max(GOAL_COMMENT_MAX) })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                throw new ScheduleError(`Write the comment in 1 to ${GOAL_COMMENT_MAX} characters.`);
            }
            return platform.goals.comment(user(c), undefined, id(c, 'id'), parsed.data.body);
        }),
    );
    app.get(
        '/schedules/jobs/:id',
        handle(async (c) => {
            const detail = await jobs.detail(user(c), id(c, 'id'));
            return {
                ...detail,
                longRun: detail.job.untilDone ? await platform.longRuns.status(user(c), id(c, 'id')) : null,
            };
        }),
    );
    app.get(
        '/schedules/jobs/:id/runs',
        handle((c) => {
            const raw = c.req.query('limit');
            const limit = raw ? Number(raw) : undefined;
            if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
                throw new JobError('Invalid limit: give 1 to 200.');
            }
            return jobs.runs(user(c), id(c, 'id'), c.req.query('before') ?? '', limit);
        }),
    );
    app.get(
        '/schedules/jobs/:id/code',
        handle((c) => {
            const raw = c.req.query('version');
            const version = raw ? Number(raw) : undefined;
            if (version !== undefined && !Number.isInteger(version)) {
                throw new JobError('Invalid version.');
            }
            return jobs.code(user(c), id(c, 'id'), version);
        }),
    );
    app.post(
        '/schedules/jobs/:id/run',
        handle(async (c) => {
            const started = await platform.longRuns.startJob(user(c), id(c, 'id'), {
                trigger: 'manual',
            });
            return started.run ?? started.longRun;
        }),
    );
    // CB-336: stores the approved code again when it is missing or changed
    // (never other code), then starts the job as Run now does.
    app.post(
        '/schedules/jobs/:id/retry',
        handle(async (c) => {
            const { repaired } = await jobs.repair(user(c), id(c, 'id'));
            const started = await platform.longRuns.startJob(user(c), id(c, 'id'), {
                trigger: 'manual',
            });
            return { repaired, run: started.run ?? started.longRun };
        }),
    );
    // Stops a job that runs until done (CB-122): its batch and what's left.
    app.post(
        '/schedules/jobs/:id/stop',
        handle(async (c) => {
            const stopped = await platform.longRuns.cancel(user(c), id(c, 'id'));
            if (!stopped) {
                throw new JobError('The job isn’t running.', 409);
            }
            return stopped;
        }),
    );
    app.delete(
        '/schedules/jobs/:id',
        handle(async (c) => {
            await jobs.remove(user(c), id(c, 'id'));
            await platform.longRuns.jobDeleted(id(c, 'id'));
            await schedules.cancelJobSchedules(user(c), id(c, 'id'));
            return { ok: true };
        }),
    );
    app.get(
        '/schedules/runs/:id',
        handle((c) => jobs.run(user(c), id(c, 'id'))),
    );
    // A schedule's details and its older runs (CB-88): after the routes
    // above, which these would otherwise match.
    app.get(
        '/schedules/:id',
        handle((c) => scheduleDetailView(platform, user(c), id(c, 'id'))),
    );
    app.get(
        '/schedules/:id/runs',
        handle((c) => {
            const raw = c.req.query('limit');
            const limit = raw ? Number(raw) : undefined;
            if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
                throw new ScheduleError('Invalid limit: give 1 to 200.');
            }
            return scheduleRunsView(platform, user(c), id(c, 'id'), c.req.query('before') ?? '', limit);
        }),
    );
    return app;
}
