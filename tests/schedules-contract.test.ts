// The schedules contract: the services implement the tag shapes, and the tags
// carry their `socio/schedules/<Name>` keys.
import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { sqliteData } from '@socio/data/open';

import {
    DEFAULT_SCHEDULE_SETTINGS,
    Goals,
    Jobs,
    LongRunReporting,
    LongRuns,
    ScheduleDetails,
    ScheduleError,
    Schedules,
    SchedulesConfig,
    TaskClaims,
    Tasks,
} from '../src/server/schedules/contract.js';
import { ScheduleDetailViews } from '../src/server/schedules/detail.js';
import { sqliteTaskRepositories } from '../src/server/schedules/infra/sqlite/index.js';
import * as settings from '../src/server/schedules/settings.js';
import { TaskService } from '../src/server/schedules/tasks.js';

import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const databases: Array<{ close(): void }> = [];
afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
});

it('the env defaults are the contract’s', () => {
    expect(settings.scheduleSettingsFromEnv({})).toEqual(DEFAULT_SCHEDULE_SETTINGS);
});

it('ScheduleError stays a plain Error with its status', () => {
    const error = new ScheduleError('Schedule not found.', 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('Error');
    expect(String(error)).toBe('Error: Schedule not found.');
    expect(error.status).toBe(404);
    expect(new ScheduleError('Bad.').status).toBe(400);
});

it('the tags carry their keys', () => {
    expect(
        [Schedules, ScheduleDetails, Tasks, TaskClaims, Jobs, LongRuns, LongRunReporting, Goals, SchedulesConfig].map(
            (tag) => tag.key,
        ),
    ).toEqual([
        'socio/schedules/Schedules',
        'socio/schedules/ScheduleDetails',
        'socio/schedules/Tasks',
        'socio/schedules/TaskClaims',
        'socio/schedules/Jobs',
        'socio/schedules/LongRuns',
        'socio/schedules/LongRunReporting',
        'socio/schedules/Goals',
        'socio/schedules/SchedulesConfig',
    ]);
});

it('a TaskService serves the Tasks and TaskClaims tags', async () => {
    const db = testDatabase();
    databases.push(db);
    const data = sqliteData(db);
    const taskService = new TaskService(data.uow, sqliteTaskRepositories(data), () => new Store(db).settings());
    const layer = Layer.mergeAll(Layer.succeed(Tasks, taskService), Layer.succeed(TaskClaims, taskService));
    const created = await Effect.runPromise(
        Tasks.use((t) => Effect.promise(() => t.create('Look into it', null, 'u1'))).pipe(Effect.provide(layer)),
    );
    expect(await taskService.owned(created.id, 'u1')).toMatchObject({ id: created.id, prompt: 'Look into it' });
    const run = <A>(work: Effect.Effect<A, never, Tasks | TaskClaims>) =>
        Effect.runPromise(work.pipe(Effect.provide(layer)));
    expect(await run(TaskClaims.use((c) => Effect.sync(() => c.leaseMs)))).toBe(taskService.leaseMs);

    // The runner's path through the tag: claim, check, a progress event, then interrupted.
    const claim = await run(TaskClaims.use((c) => Effect.promise(() => c.claim())));
    expect(claim).toMatchObject({ id: created.id });
    expect(await run(TaskClaims.use((c) => Effect.promise(() => c.owns(claim!))))).toBe(true);
    await run(TaskClaims.use((c) => Effect.promise(() => c.event(claim!.id, claim!.lease, 'Reading sources'))));
    await run(TaskClaims.use((c) => Effect.promise(() => c.interrupt(claim!, 'Server stopped during this run.'))));
    const detail = await run(Tasks.use((t) => Effect.promise(() => t.detail(created.id))));
    expect(detail?.task).toMatchObject({ status: 'interrupted', error: 'Server stopped during this run.' });
    expect(detail?.runs).toMatchObject([{ id: claim!.lease, status: 'interrupted' }]);
    expect(detail?.events.map((event) => event.text)).toContain('Reading sources');
});

it('ScheduleDetailViews answers a missing schedule with a ScheduleError 404', async () => {
    const views = new ScheduleDetailViews({
        schedules: { find: async () => undefined },
    } as unknown as ConstructorParameters<typeof ScheduleDetailViews>[0]);
    const detail = Effect.runPromise(
        ScheduleDetails.use((d) => Effect.promise(() => d.detail('u1', 'gone'))).pipe(
            Effect.provide(Layer.succeed(ScheduleDetails, views)),
        ),
    );
    await expect(detail).rejects.toMatchObject({ status: 404, message: 'Schedule not found.' });
    await expect(views.runs('u1', 'gone', 'r1')).rejects.toBeInstanceOf(ScheduleError);
});

it('SchedulesConfig takes the PlatformConfig fields as they are', async () => {
    const config = { schedules: { maxActivePerUser: 3 }, jobs: { concurrency: 1 } };
    const read = await Effect.runPromise(
        SchedulesConfig.use((c) => Effect.succeed(c)).pipe(Effect.provide(Layer.succeed(SchedulesConfig, config))),
    );
    expect(read).toBe(config);
});
