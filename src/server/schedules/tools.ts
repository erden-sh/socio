// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { DataError } from '@socio/foundation/dataspace/data-error';
import { toolError } from '@socio/foundation/http/tool-error';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { JOB_ENTRIES } from '@socio/shared/schedule-types';
import type { Action } from '@socio/shared/types';

import { ScheduleError } from './contract.js';
import { JobError, type JobService } from './jobs.js';
import type { LongRunService } from './long-runs.js';
import type { ScheduleService } from './service.js';

export const SCHEDULE_TOOL_NAMES = [
    'schedule_create',
    'schedule_list',
    'schedule_pause',
    'schedule_resume',
    'schedule_cancel',
] as const;
export const JOB_TOOL_NAMES = [
    'job_save',
    'job_run',
    'job_list',
    'job_logs',
    'job_status',
    'job_inspect',
    'job_retry',
] as const;

/** How long `job_run` waits for a short run before answering "running". */
const RUN_WAIT_MS = 20_000;

async function attempt(turn: DotTurn, work: () => unknown) {
    turn.check();
    try {
        return await work();
    } catch (error) {
        if (error instanceof ScheduleError || error instanceof JobError || error instanceof DataError) {
            return toolError(error);
        }
        throw error;
    }
}

/**
 * The schedule tools of one turn: the Dot's schedules for the turn's user.
 * Creating one needs the user's approval (`schedule.create`) unless they
 * set bypass; listing, pausing, resuming and canceling don't.
 */
export function scheduleTools(schedules: ScheduleService, turn: DotTurn): ToolDefinition[] {
    const { userId } = turn;
    const dotId = turn.dot.id;
    const minutes = Math.round(schedules.settings.minIntervalMs / 60_000);
    const act = (name: string, action: Action, description: string) =>
        defineTool({
            name,
            description,
            parameters: z.object({
                scheduleId: z.string().min(1).max(64).describe('From schedule_list.'),
            }),
            execute: ({ scheduleId }) => attempt(turn, () => schedules.act(userId, scheduleId, action, dotId)),
        });
    return [
        defineTool({
            name: 'schedule_create',
            description: `Propose recurring work for the user you are helping: either a turn of yours (a prompt you will be given at each run, in a conversation of its own, on the user's model) or one of your jobs (job_save). The user approves it first unless they turned approvals off. Use it when the user wants something done regularly ("every morning", "weekly"); write the prompt so it stands on its own (it will not see this conversation). At most every ${minutes} minutes, and a few active schedules per user. Times are read in the user's time zone when you pass it (ask if it matters), else UTC.`,
            parameters: z.object({
                title: z.string().min(1).max(80).describe('A short name the user will recognise.'),
                cadence: z
                    .string()
                    .min(1)
                    .max(120)
                    .describe(
                        'A phrase ("every 6 hours", "every day at 09:00", "every monday at 08:30", "every 2 weeks on friday at 17:00") or a five-field cron ("0 9 * * 1-5").',
                    ),
                timezone: z.string().max(64).optional().describe('IANA time zone (Europe/Paris). UTC when omitted.'),
                action: z
                    .discriminatedUnion('kind', [
                        z.object({
                            kind: z.literal('turn'),
                            prompt: z.string().min(3).max(4000).describe('What you will be asked at each run.'),
                        }),
                        z.object({
                            kind: z.literal('job'),
                            jobId: z.string().min(1).max(64).describe('From job_list.'),
                        }),
                    ])
                    .describe('What runs: a turn with a prompt, or a job.'),
            }),
            execute: (input) =>
                attempt(turn, async () => {
                    const outcome = await schedules.propose(userId, dotId, input, turn.threadId);
                    return outcome.status === 'approved'
                        ? {
                              status: 'created',
                              outcome: outcome.outcome,
                              schedules: await schedules.list(userId, dotId),
                          }
                        : outcome;
                }),
        }),
        defineTool({
            name: 'schedule_list',
            description: 'List your schedules for the user you are helping: title, cadence, status, next and last run.',
            parameters: z.object({}),
            execute: () => attempt(turn, () => schedules.list(userId, dotId)),
        }),
        act('schedule_pause', 'pause', 'Pause one of your schedules; it keeps its cadence and can be resumed.'),
        act('schedule_resume', 'resume', 'Resume a paused schedule; it runs at its next time.'),
        act(
            'schedule_cancel',
            'cancel',
            'Cancel one of your schedules for good (the user can see it, cancelled, in the app).',
        ),
    ];
}

/**
 * The job tools of one turn: the Dot's jobs for the turn's user. Saving a
 * job (or a new version) needs the user's approval (`job.save`) unless
 * bypass; running, listing and reading logs don't.
 */
export function jobTools(jobs: JobService, longRuns: LongRunService, turn: DotTurn): ToolDefinition[] {
    const { userId } = turn;
    const dotId = turn.dot.id;
    const max = jobs.settings.maxTimeoutSeconds;
    /** Starts the job as job_run does and answers the same way. */
    const start = async (jobId: string) => {
        const started = await longRuns.startJob(userId, jobId, {
            trigger: 'dot',
            dotId,
            threadId: turn.threadId,
        });
        if (started.longRun) {
            return {
                status: started.already ? 'already_running' : 'started',
                longRun: started.longRun,
                message: started.already
                    ? 'This job is already running until done; this is how far it got.'
                    : 'Started. It runs in batches until done; you will be told here when it ends.',
            };
        }
        return jobs.wait(started.run!.id, RUN_WAIT_MS);
    };
    return [
        defineTool({
            name: 'job_save',
            description: `Save code as a job: fixed work that runs in your computer without the model, now (job_run) or on a schedule (schedule_create with kind job). Use it for collection that should repeat (fetch a page or an API, parse it, store rows). Entry main.ts runs with \`bun ./main.ts\` (Bun: fetch, Bun.file, no npm installs), main.sh with \`bash main.sh\`. Jobs reach the user's data space only through the data API: CB_DATA_URL and CB_DATA_TOKEN are in the environment (Authorization: Bearer $CB_DATA_TOKEN; POST $CB_DATA_URL/datasets/scratch/tables/<table>/rows with {"rows":[...]} to insert, …/query with {"sql"} to read). Files on the computer are disposable. Saving the same name makes a new version. The user approves the code first unless they turned that off.

Work that may outlast one timeout (crawling or enriching many items) must set untilDone: the server then runs the job in batches, each within the timeout, and keeps starting the next one (after a stop, a restart or a deploy too) until the job says it is complete; one batch succeeding is not the end. Each batch uses the checkpoint API at $CB_JOB_API (same token, JSON): POST /items {"keys":[...], "complete":true once that is every item} to declare items (idempotent); POST /claim {"limit":20} for items to do (stop when it returns none, or "stop"); for each, write its rows with an upsert key (POST /done {"key", "write":{"dataset":"scratch","table","rows","key":["id"]}} writes and marks it done in one call) or POST /fail {"key","error"} (retried, then set aside after a few tries; the rest go on). On a 403 or 429 from a source, POST /fail with "status" (and "retryAfterSeconds" if it said) or /pause, then exit: the run waits and resumes later. GET / gives counts and your checkpoint; POST /checkpoint {"value":{...}} saves a small cursor; POST /complete {"summary"} ends the run when your own completion check holds. Exit before the timeout; the next batch carries on.`,
            parameters: z.object({
                name: z.string().min(1).max(80),
                entry: z.enum(JOB_ENTRIES),
                files: z
                    .record(z.string(), z.string())
                    .describe('Relative path to contents, including the entry, e.g. {"main.ts": "…"}.'),
                timeoutSeconds: z
                    .number()
                    .int()
                    .min(5)
                    .max(max)
                    .describe(`5 to ${max}; includes starting the computer if it was stopped (up to 90 s).`),
                datasets: z
                    .array(z.string().min(1).max(100))
                    .max(20)
                    .optional()
                    .describe('Dataset ids or names (from data_list) the job may use besides your scratch dataset.'),
                untilDone: z
                    .boolean()
                    .optional()
                    .describe('Run in batches until the job says it is complete (the checkpoint API above), not once.'),
            }),
            execute: (input) =>
                attempt(turn, async () => {
                    const { jobId, outcome } = await jobs.propose(userId, dotId, input, turn.threadId);
                    return outcome.status === 'approved'
                        ? {
                              status: 'saved',
                              jobId,
                              outcome: outcome.outcome,
                              job: await jobs.job(userId, jobId, dotId),
                          }
                        : { ...outcome, jobId };
                }),
        }),
        defineTool({
            name: 'job_run',
            description:
                'Run one of your saved jobs now (its latest version). Waits up to 20 s; a longer run keeps going, and job_logs shows how it ended. A job that runs until done starts its run (or answers with the one already going) and keeps going in batches without you; you are told in this conversation when it ends, and job_status shows how it is going.',
            parameters: z.object({ jobId: z.string().min(1).max(64) }),
            execute: ({ jobId }) => attempt(turn, () => start(jobId)),
        }),
        defineTool({
            name: 'job_list',
            description:
                'List your saved jobs for the user you are helping: version, entry, timeout, datasets and last run.',
            parameters: z.object({}),
            execute: () => attempt(turn, () => jobs.list(userId, dotId)),
        }),
        defineTool({
            name: 'job_logs',
            description:
                'A job run’s status, exit code, timings and the end of its stdout and stderr (secrets redacted). Only the latest runs of a job keep their output; older ones say so in outputNotKept.',
            parameters: z.object({
                runId: z.string().min(1).max(64).describe('From job_run or job_list.'),
            }),
            execute: ({ runId }) => attempt(turn, () => jobs.run(userId, runId, dotId)),
        }),
        defineTool({
            name: 'job_status',
            description:
                'How a job that runs until done is going, without reading logs: its status (running, waiting, done, failed, cancelled), items done, left and set aside (with why), batches, the last checkpoint, the retry and wait state and, once it ended, the outcome. For "how is it going?".',
            parameters: z.object({
                jobId: z.string().min(1).max(64).describe('From job_list.'),
            }),
            execute: ({ jobId }) =>
                attempt(turn, async () => {
                    const status = await longRuns.status(userId, jobId, dotId);
                    return (
                        status ?? {
                            status: 'not_started',
                            message: (await jobs.job(userId, jobId, dotId)).untilDone
                                ? 'This job hasn’t run yet.'
                                : 'This job runs once per start, not until done: job_list and job_logs show its runs.',
                        }
                    );
                }),
        }),
        defineTool({
            name: 'job_inspect',
            description:
                'Inspect one of your jobs without running it: its version, whether its saved code is in storage and matches what the user approved (stored, missing, unreadable or changed), its last run with its error, its long run if it runs until done, and whether job_retry can help. It also finds a job the user approved whose save failed (for example in a storage outage), which job_list doesn’t show. Use it when a job is "not found", fails or won’t start.',
            parameters: z.object({
                jobId: z.string().min(1).max(64).describe('From job_save or job_list.'),
            }),
            execute: ({ jobId }) =>
                attempt(turn, async () => {
                    const inspection = await jobs.inspect(userId, jobId, dotId);
                    return inspection.saved && inspection.untilDone
                        ? { ...inspection, longRun: await longRuns.status(userId, jobId, dotId) }
                        : inspection;
                }),
        }),
        defineTool({
            name: 'job_retry',
            description:
                'Retry one of your jobs that failed, then run it as job_run does. If the user approved it but its code never reached storage, or its stored code is missing or changed, it first stores the code the user approved again (never other code: new code goes through job_save and the user’s approval). Storage that is still down fails again; try later.',
            parameters: z.object({
                jobId: z.string().min(1).max(64).describe('From job_save, job_list or job_inspect.'),
            }),
            execute: ({ jobId }) =>
                attempt(turn, async () => {
                    const { repaired } = await jobs.repair(userId, jobId, dotId);
                    const run = await start(jobId);
                    return {
                        repaired,
                        note:
                            repaired === 'saved'
                                ? 'Saved the approved job, whose save had failed, and started it.'
                                : repaired === 'code'
                                  ? 'Stored the approved code again and started the job.'
                                  : 'Its code was stored; started the job again.',
                        run,
                    };
                }),
        }),
    ];
}
