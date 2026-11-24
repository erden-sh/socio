import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';

import { Approvals } from '../approvals/contract.js';
import { ComputerRecords, Computers } from '../computers/contract.js';
import type { ModuleServicesAccess, ServerModule } from '../modules/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Runner } from '../turns/contract.js';

import { ScheduleBoard, Tasks } from './contract.js';
import { GOAL_TOOL_NAMES, goalTools, turnGoal } from './goal-tools.js';
import { schedulesSchema } from './migrations.js';
import { scheduleRoutes, type ScheduleRouteSources } from './routes.js';
import { FullGoals, FullJobs, FullLongRunReports, FullLongRuns, FullSchedules, ScheduleStore } from './tags.js';
import { JOB_TOOL_NAMES, SCHEDULE_TOOL_NAMES, jobTools, scheduleTools } from './tools.js';

/**
 * What the routes read (`ScheduleRouteSources`), from the app's services at
 * the moment of use: this folder's services (`tags.ts`), the store's
 * forwarders, the approvals, the runner and the Board's port.
 */
const routeSources = (services: ModuleServicesAccess): ScheduleRouteSources => ({
    schedules: services.get(FullSchedules),
    jobs: services.get(FullJobs),
    goals: services.get(FullGoals),
    longRuns: services.get(FullLongRuns),
    store: services.get(ScheduleStore),
    approvals: services.get(Approvals),
    runner: services.get(Runner),
    board: services.get(ScheduleBoard),
});

/**
 * Schedules and jobs. The services live on the platform (`platform.schedules`,
 * `platform.jobs`), where the scheduler, the drain and the force stop reach
 * them; the module owns the jobs' tables, the `/api/schedules` routes, the
 * Dot tools and their capabilities.
 */
export const schedulesModule: ServerModule = {
    ...schedulesSchema,
    routes: ({ services }) => scheduleRoutes(routeSources(services)),
    dotTools: ({ services }, turn) => [
        ...scheduleTools(services.get(FullSchedules), turn),
        ...goalTools(services.get(FullGoals), turn),
        // Jobs need a computer to run in.
        ...(services.get(Computers).configured
            ? jobTools(services.get(FullJobs), services.get(FullLongRuns), turn)
            : []),
    ],
    // Read when the status is asked for, after boot: the workspace's
    // settings (`WorkspaceSettings`), the person's active schedules
    // (`Tasks`), and this folder's services.
    capabilities: ({ services }) => [
        {
            id: 'schedules',
            label: 'Schedules',
            description:
                'Recurring work for the user: a turn of yours with a fixed prompt (in its own conversation, on the user’s model) or one of your jobs, at a cadence ("every day at 09:00", cron). The user approves each new schedule unless they turned that off, and can pause or cancel it in the app; you can list, pause, resume and cancel yours.',
            tools: SCHEDULE_TOOL_NAMES,
            approvals: [APPROVAL_CAPABILITIES.scheduleCreate],
            status: async (turn) => {
                const schedules = services.get(FullSchedules);
                const mine = await schedules.list(turn.userId, turn.dot.id);
                return {
                    enabled: true,
                    ...(services.get(WorkspaceSettings).settings().researchAllowed
                        ? {}
                        : {
                              note: 'Scheduled work is off while research is disabled in the workspace settings.',
                          }),
                    limits: {
                        minIntervalMinutes: Math.round(schedules.settings.minIntervalMs / 60_000),
                        maxActiveSchedulesPerUser: schedules.settings.maxActivePerUser,
                        timeZone: 'UTC unless you pass the user’s IANA time zone',
                    },
                    usage: {
                        activeSchedulesOfUser: await services.get(Tasks).activeScheduleCount(turn.userId),
                        yours: mine.filter((view) => view.status !== 'cancelled').length,
                    },
                };
            },
        },
        {
            id: 'goals',
            label: 'Goals',
            description:
                'Persistent goals the person gives you: you work toward each on its own cadence, in a conversation of its own, acting for that person, and record progress until you mark it done. Set one only when the person asks you to keep at something over time. If they already have a goal like it, add to it with goal_comment instead of setting another.',
            tools: GOAL_TOOL_NAMES,
            approvals: [APPROVAL_CAPABILITIES.goalSet],
            status: async (turn) => {
                const goals = services.get(FullGoals);
                const mine = await goals.list(turn.userId, turn.dot.id);
                return {
                    enabled: true,
                    usage: {
                        active: mine.filter((goal) => goal.status === 'active').length,
                        paused: mine.filter((goal) => goal.status === 'paused').length,
                    },
                    details: {
                        thisTurnsGoal: (await turnGoal(goals, turn))?.id ?? null,
                    },
                };
            },
        },
        {
            id: 'jobs',
            label: 'Jobs',
            description:
                'Code you write (Bun main.ts or bash main.sh) saved as a job and run in your computer without the model, now or on a schedule, with a timeout. Runs reach the user’s data only through the data API with a token for that run (your scratch dataset and the datasets named in the job). Use jobs for repeated collection; use schedules with a turn for summaries that need you. Work longer than one timeout (a crawl of many items) runs until done: save the job with untilDone and the server runs it in batches, resuming from its checkpoint after any stop, until it says it is complete; job_status shows how far it got.',
            tools: JOB_TOOL_NAMES,
            approvals: [APPROVAL_CAPABILITIES.jobSave],
            status: async (turn) => {
                const permissions = await services.get(ComputerRecords).permissions(turn.dot.id);
                const jobs = services.get(FullJobs);
                const { configured } = services.get(Computers);
                const settings = jobs.settings;
                const ready = configured && permissions.enabled && permissions.shell;
                return {
                    enabled: configured,
                    ...(ready
                        ? {}
                        : {
                              note: configured
                                  ? 'Runs need this socio’s computer with shell access; an admin enables it in the socio’s computer permissions.'
                                  : 'No computer service is configured, so jobs can’t run.',
                          }),
                    limits: {
                        maxTimeoutSeconds: settings.maxTimeoutSeconds,
                        computerWakeSeconds: Math.round(settings.wakeTimeoutMs / 1000),
                        concurrentRunsInWorkspace: settings.concurrency,
                        maxJobsPerUser: settings.maxJobsPerUser,
                        maxFiles: settings.maxFiles,
                        maxKB: Math.round(settings.maxBytes / 1024),
                        logKBPerStream: Math.round(settings.logMaxBytes / 1024),
                        untilDone: {
                            triesPerItem: settings.itemAttempts,
                            retriesInARow: settings.batchRetries,
                            maxBatches: settings.maxBatches,
                        },
                    },
                    usage: {
                        yours: (await jobs.list(turn.userId, turn.dot.id)).length,
                        dataApi: jobs.dataApi ? 'available to runs' : 'not configured (runs get no data token)',
                    },
                };
            },
        },
    ],
    // Long runs the last process left open carry on, and ends it didn't
    // report are reported (CB-122).
    start: async ({ services }) => {
        await services.get(FullLongRuns).resume();
        await services.get(FullLongRunReports).resume();
    },
    // No new batches here once the next leader runs them (CB-108); batches
    // already running finish under their own job-run leases.
    release: ({ services }) => {
        services.get(FullLongRuns).stop();
        services.get(FullLongRunReports).stop();
    },
    stop: ({ services }) => {
        services.get(FullLongRuns).stop();
        services.get(FullLongRunReports).stop();
        return services.get(FullJobs).stop();
    },
};
