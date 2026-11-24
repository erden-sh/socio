// Schedules' services are built by its layers (schedules/layer.ts) from the
// tags of other features' contracts, its own ports (`JobData`,
// `ScheduleBoard`) and `SchedulesHost`, each under its contract's tag and
// whole, in `Platform`'s order; `SchedulesConfig` comes from the supplied
// config.
import { Context, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { RuntimeSession } from '@socio/data/runtime-ownership';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';

import { Approvals, type ApprovalsShape } from '../src/server/approvals/contract.js';
import { Computers, type ComputersShape } from '../src/server/computers/contract.js';
import { NotificationsConfig, Notifier, type NotifierShape } from '../src/server/notifications/contract.js';
import {
    Goals,
    JobData,
    Jobs,
    LongRunReporting,
    LongRuns,
    ScheduleBoard,
    ScheduleDetails,
    ScheduleError,
    Schedules,
    SchedulesConfig,
    SchedulesViews,
    type JobDataShape,
    type ScheduleBoardShape,
    type SchedulesConfigShape,
} from '../src/server/schedules/contract.js';
import {
    FullGoals,
    FullJobs,
    FullLongRunReports,
    FullLongRuns,
    FullSchedules,
    GoalsLive,
    JobsLive,
    LongRunReportsLive,
    LongRunsLive,
    ScheduleDataLive,
    SchedulesHost,
    SchedulesLive,
    type SchedulesHostShape,
} from '../src/server/schedules/layer.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function build(options: { config?: SchedulesConfigShape } = {}) {
    const db = testDatabase();
    const store = new Store(db);
    const workspace = new WorkspaceStore(db);
    const runner = new LocalAgentRunner(testDatabase());
    const runtime = new RuntimeSession();
    const registered: string[] = [];
    const approvals = {
        register: vi.fn((handler: { capability: string }) => {
            registered.push(handler.capability);
            return approvals;
        }),
        capabilities: () => [],
        policies: async () => [],
        recordNote: vi.fn(async () => {}),
    } as unknown as ApprovalsShape;
    const host: SchedulesHostShape = {
        db,
        runtime,
        store,
        workspace,
        runner,
        data: { write: async () => ({ status: 'done' }) },
        jobOverrides: () => ({}),
        scheduleOverrides: () => ({}),
        listening: () => undefined,
        draining: () => false,
        telegram: () => undefined,
        turnOutcome: vi.fn(),
        log: () => {},
    };
    const root = Layer.mergeAll(
        Layer.succeed(SchedulesHost, host),
        Layer.succeed(SchedulesConfig, { data: { apiUrl: 'https://data.example.invalid' }, ...options.config }),
        Layer.succeed(Approvals, approvals),
        Layer.succeed(Computers, { configured: false } as unknown as ComputersShape),
        Layer.succeed(JobData, {} as JobDataShape),
        Layer.succeed(Notifier, { notify: vi.fn(async () => {}) } as unknown as NotifierShape),
        Layer.succeed(NotificationsConfig, {}),
        Layer.succeed(ScheduleBoard, {} as ScheduleBoardShape),
    );
    // In `Platform`'s order, each over the ones before, as composition/index.ts chains them.
    const graph = GoalsLive.pipe(
        Layer.provideMerge(SchedulesLive),
        Layer.provideMerge(LongRunReportsLive),
        Layer.provideMerge(LongRunsLive),
        Layer.provideMerge(JobsLive),
        Layer.provideMerge(ScheduleDataLive),
        Layer.provideMerge(root),
    );
    const app = ManagedRuntime.make(graph);
    const context = await app.context();
    cleanup.push(async () => {
        Context.get(context, FullLongRuns).stop();
        Context.get(context, FullLongRunReports).stop();
        await Context.get(context, FullJobs).stop();
        await app.dispose();
        runtime.detachSync(db);
        store.close();
        workspace.close();
    });
    return { context, registered, store };
}

it('offers each service under its contract’s tag and whole, the same instance', async () => {
    const { context } = await build();
    expect(Context.get(context, Jobs)).toBe(Context.get(context, FullJobs));
    expect(Context.get(context, LongRuns)).toBe(Context.get(context, FullLongRuns));
    expect(Context.get(context, LongRunReporting)).toBe(Context.get(context, FullLongRunReports));
    expect(Context.get(context, Schedules)).toBe(Context.get(context, FullSchedules));
    expect(Context.get(context, Goals)).toBe(Context.get(context, FullGoals));
    expect(Context.get(context, SchedulesViews)).toBe(Context.get(context, ScheduleDetails));
});

it('registers the approvals in Platform’s order: jobs, schedules, goals', async () => {
    const { registered } = await build();
    expect(registered).toEqual([
        APPROVAL_CAPABILITIES.jobSave,
        APPROVAL_CAPABILITIES.scheduleCreate,
        APPROVAL_CAPABILITIES.goalSet,
    ]);
});

it('builds the limits and the data API from SchedulesConfig', async () => {
    const { context } = await build({
        config: { schedules: { minIntervalMs: 30 * 60_000 }, jobs: { concurrency: 4 } },
    });
    expect(Context.get(context, Schedules).settings.minIntervalMs).toBe(30 * 60_000);
    expect(Context.get(context, Jobs).settings.concurrency).toBe(4);
    expect(Context.get(context, FullJobs).dataApi).toBe(true);
});

it('serves the views through SchedulesViews: the person’s state, and a missing schedule as a 404', async () => {
    const { context } = await build();
    const views = Context.get(context, SchedulesViews);
    const user = { id: 'nobody', role: 'member' } as Parameters<typeof views.schedules>[0];
    const state = await views.withLongRuns(await views.schedules(user));
    expect(state).toMatchObject({ schedules: [], goals: [], jobs: [], usage: { activeSchedules: 0, jobs: 0 } });
    expect(state.counts).toBeUndefined();
    const missing = await views.detail('nobody', 'none').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ScheduleError);
    expect(missing).toMatchObject({ status: 404, message: 'Schedule not found.' });
});
