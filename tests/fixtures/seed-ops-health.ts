import { DatabaseSync } from 'node:sqlite';

import { goalState, scheduleState, type ScheduleState } from '@socio/shared/operations/operations-health';

import type {
    GoalFact,
    HealthMemoryFacts,
    JobRunFact,
    LongRunFact,
    RoundFact,
    ScheduleFact,
    TaskRunFact,
    ToolFact,
} from '../../src/server/operations/infra/memory/health.js';
import type { TurnFact } from '../../src/server/operations/infra/memory/reader.js';

import { PEOPLE, random, seedOpsDatabase, SOCIOS } from './seed-ops-runs.js';

// A database for Operations → Health (CB-192): turns whose traces have
// several models, reasoning kinds (some reported, some not, some turns
// from before CB-185 with none), first-output times, queue times and tool
// calls, and turns with no trace at all; schedules in every state with
// their runs (some due times unknown), job runs, goals and long runs with
// items. It returns what it meant, as MemoryOpsReader's facts.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface HealthSeeded {
    db: DatabaseSync;
    turns: TurnFact[];
    health: HealthMemoryFacts;
}

const MODELS = [
    { model: 'gpt-5', reports: true },
    { model: 'qwen3-32b', reports: false },
    { model: 'llama-4', reports: false },
];
const KINDS = ['summary', 'raw', 'hidden', 'none'] as const;
const TOOLS = ['search_pages', 'read_page', 'web_fetch', 'run_query'];

export function seedHealthDatabase(
    path: string,
    { now, turns: count = 160 }: { now: number; turns?: number },
): HealthSeeded {
    const base = seedOpsDatabase(path, {
        turns: 0,
        start: now - 40 * DAY,
        spanMs: DAY,
    });
    const db = base.db;
    const rand = random(11);
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
    const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
    const chats = base.chats.filter((chat) => chat.source === 'web' || chat.automation === 'schedule');
    const socios = SOCIOS.map((socio) => ({ ...socio }));
    const people = PEOPLE.map((id) => ({
        id,
        name: id[0]!.toUpperCase() + id.slice(1),
    }));

    const turns: TurnFact[] = [];
    const rounds: RoundFact[] = [];
    const tools: ToolFact[] = [];
    const insertRun = db.prepare(
        'INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    for (let n = 0; n < count; n++) {
        const chat = pick(chats);
        const socio = socios.find((s) => s.id === chat.socioId)!;
        const startedAt = now - between(MIN, 35 * DAY);
        const finishedAt = startedAt + between(2000, 90_000);
        const runId = `hrun-${String(n).padStart(4, '0')}`;
        const traced = rand() < 0.9;
        const signals = traced && rand() < 0.7;
        const { model, reports } = pick(MODELS);
        const kind = signals ? pick(KINDS) : undefined;
        const roundCount = traced ? between(1, 4) : 0;
        const automation = chat.automation === 'schedule';
        const person = automation ? null : chat.ownerId;
        const trigger = automation ? { kind: 'schedule', id: 'schedule-1' } : { kind: 'person', id: person! };
        const receivedAt = signals ? startedAt - between(0, 5000) : null;
        let input = 0;
        let output = 0;
        let reasoning = 0;
        const traceRounds = [];
        let at = startedAt;
        for (let r = 1; r <= roundCount; r++) {
            const roundIn = between(100, 4000);
            const roundOut = between(10, 800);
            const roundReasoning = reports ? between(0, 300) : undefined;
            const firstOutputMs = rand() < 0.8 ? between(80, 6000) : undefined;
            const endedAt = at + between(500, 9000);
            input += roundIn;
            output += roundOut;
            reasoning += roundReasoning ?? 0;
            traceRounds.push({
                kind: 'round',
                round: r,
                startedAt: at,
                endedAt,
                ...(firstOutputMs !== undefined ? { firstOutputMs } : {}),
                inputTokens: roundIn,
                outputTokens: roundOut,
                ...(roundReasoning !== undefined ? { reasoningTokens: roundReasoning } : {}),
                stop: r === roundCount ? 'stop' : 'tool_calls',
                ...(kind ? { reasoningKind: kind } : {}),
            });
            rounds.push({
                runId,
                socioId: socio.id,
                spaceId: socio.spaceId,
                source: chat.source,
                personId: person,
                startedAt: at,
                model,
                firstOutputMs: firstOutputMs ?? null,
            });
            at = endedAt;
        }
        const cached = traced ? Math.floor(input / 3) : 0;
        const toolCount = traced ? between(0, 4) : 0;
        const traceTools = [];
        for (let i = 0; i < toolCount; i++) {
            const name = pick(TOOLS);
            const outcome = pick(['ok', 'ok', 'ok', 'error', 'timeout', 'refused']);
            const toolAt = startedAt + 100 * i;
            const durationMs = between(5, 4000);
            traceTools.push({
                kind: 'tool',
                round: 1,
                name,
                startedAt: toolAt,
                endedAt: toolAt + durationMs,
                outcome,
            });
            tools.push({
                runId,
                socioId: socio.id,
                spaceId: socio.spaceId,
                source: chat.source,
                personId: person,
                startedAt: toolAt,
                tool: name,
                outcome,
                durationMs,
            });
        }
        const trace = traced
            ? {
                  turn: { label: 'Model', model, source: 'shared', cap: 12 },
                  rounds: traceRounds,
                  tools: traceTools,
                  waits: [],
                  end: { reason: 'completed', rounds: roundCount, cap: 12 },
                  totals: {
                      rounds: roundCount,
                      inputTokens: input,
                      outputTokens: output,
                      cachedTokens: cached,
                      ...(reports ? { reasoningTokens: reasoning } : {}),
                      ...(kind ? { reasoningKind: kind } : {}),
                  },
                  ...(signals ? { receivedAt, trigger } : {}),
              }
            : null;
        insertRun.run(
            chat.id,
            runId,
            'finished',
            JSON.stringify([
                { type: 'RUN_STARTED', threadId: chat.id, runId, timestamp: startedAt },
                {
                    type: 'RUN_FINISHED',
                    threadId: chat.id,
                    runId,
                    timestamp: finishedAt,
                },
            ]),
            startedAt,
            finishedAt,
            chat.recorded,
            trace && JSON.stringify(trace),
        );
        turns.push({
            runId,
            threadId: chat.id,
            socioId: socio.id,
            socioName: socio.name,
            spaceId: socio.spaceId,
            personId: person,
            source: chat.source,
            status: 'finished',
            startedAt,
            finishedAt,
            ...(traced ? { inputTokens: input, outputTokens: output, cachedTokens: cached } : {}),
            toolCalls: toolCount,
            model: traced ? model : null,
            reasoningTokens: traced && reports ? reasoning : null,
            reasoningTokensReported: traced && reports,
            reasoningKind: kind ?? 'unknown',
            receivedAt,
            rounds: roundCount,
            attribution: signals ? 'exact' : automation ? 'source' : 'owner',
        });
    }
    db.exec('COMMIT');

    // Schedules in every state, a research task (not a schedule) and a
    // deleted schedule, which Health leaves out.
    const schedules: ScheduleFact[] = [];
    const states = new Map<string, ScheduleState>();
    const insertTask = db.prepare(
        `INSERT INTO tasks (id, prompt, status, intervalSeconds, nextRunAt, createdAt, updatedAt, error,
      userId, title, cadence, dotId, kind, lastRunAt, deletedAt) VALUES (?, 'Do it.', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, ?)`,
    );
    const plan: {
        status: string;
        next: number | null;
        error?: string;
        cadence?: string;
        interval?: number;
    }[] = [
        { status: 'scheduled', next: now + 2 * DAY, cadence: 'daily 09:00' },
        { status: 'scheduled', next: now + 3 * HOUR, cadence: 'weekly mon' },
        { status: 'scheduled', next: now - 3 * HOUR, cadence: 'daily 07:00' },
        {
            status: 'paused',
            next: null,
            error: 'Paused after 3 failed runs in a row: boom',
            cadence: 'daily',
        },
        {
            status: 'scheduled',
            next: now + DAY,
            error: 'The model was busy.',
            cadence: 'daily',
        },
        { status: 'failed', next: null, error: 'Exit 1', cadence: 'hourly' },
        { status: 'cancelled', next: null, cadence: 'daily' },
        { status: 'completed', next: now + 5 * HOUR, interval: 3600 },
        { status: 'paused', next: null, cadence: 'monthly' },
    ];
    db.exec('BEGIN');
    for (const [i, item] of plan.entries()) {
        const socio = socios[i % socios.length]!;
        const userId = PEOPLE[i % PEOPLE.length]!;
        const updatedAt = now - (i + 1) * HOUR;
        const id = `sched-${i}`;
        insertTask.run(
            id,
            item.status,
            item.interval ?? null,
            item.next,
            now - 60 * DAY,
            updatedAt,
            item.error ?? null,
            userId,
            `Schedule ${i}`,
            item.cadence ?? null,
            socio.id,
            now - 2 * DAY,
            null,
        );
        const state = scheduleState({ status: item.status, nextRunAt: item.next, error: item.error ?? null }, now);
        states.set(id, state);
        schedules.push({
            id,
            title: `Schedule ${i}`,
            socioId: socio.id,
            personId: userId,
            state,
            status: item.status,
            cadence: item.cadence ?? null,
            nextRunAt: item.next,
            lastRunAt: now - 2 * DAY,
            updatedAt,
            error: item.error ?? null,
        });
    }
    insertTask.run(
        'research-1',
        'queued',
        null,
        null,
        now - DAY,
        now - DAY,
        null,
        'alice',
        'Research',
        null,
        'socio-a',
        null,
        null,
    );
    insertTask.run(
        'sched-gone',
        'scheduled',
        null,
        now - DAY,
        now - DAY,
        now - DAY,
        null,
        'alice',
        'Gone',
        'daily',
        'socio-a',
        null,
        now - HOUR,
    );

    const taskRuns: TaskRunFact[] = [];
    const insertTaskRun = db.prepare(
        'INSERT INTO runs (id, taskId, status, startedAt, finishedAt, error, dueAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let n = 0; n < 90; n++) {
        const schedule = pick(schedules);
        const dueAt = rand() < 0.75 ? now - between(HOUR, 33 * DAY) : null;
        const startedAt = (dueAt ?? now - between(HOUR, 33 * DAY)) + between(0, 20 * MIN);
        const status = pick(['completed', 'completed', 'completed', 'failed', 'interrupted']);
        const finishedAt = startedAt + between(1000, 60_000);
        const id = `trun-${String(n).padStart(3, '0')}`;
        insertTaskRun.run(id, schedule.id, status, startedAt, finishedAt, status === 'failed' ? 'boom' : null, dueAt);
        taskRuns.push({
            id,
            taskId: schedule.id,
            status,
            dueAt,
            startedAt,
            finishedAt,
        });
    }
    // A research task's run: not a schedule's.
    insertTaskRun.run('trun-research', 'research-1', 'completed', now - DAY, now - DAY + 1000, null, now - DAY);

    // Jobs, their runs, goals and long runs.
    const insertJob = db.prepare(
        'INSERT INTO jobs (id, userId, dotId, name, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?)',
    );
    const jobs = [
        {
            id: 'job-1',
            name: 'Nightly import',
            userId: 'alice',
            socioId: 'socio-a',
        },
        { id: 'job-2', name: 'Price check', userId: 'bob', socioId: 'socio-b' },
        { id: 'job-3', name: 'Archive', userId: 'carol', socioId: 'socio-c' },
    ];
    for (const job of jobs) {
        insertJob.run(job.id, job.userId, job.socioId, job.name, now - 90 * DAY, now - 90 * DAY);
    }
    const jobRuns: JobRunFact[] = [];
    const insertJobRun = db.prepare(
        `INSERT INTO job_runs (id, jobId, version, userId, dotId, trigger, scheduleId, status, queuedAt, startedAt, wakeMs, finishedAt, longRunId)
    VALUES (?, ?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    );
    for (let n = 0; n < 80; n++) {
        const job = pick(jobs);
        const queuedAt = now - between(MIN, 34 * DAY);
        const status = n < 2 ? 'queued' : pick(['succeeded', 'succeeded', 'failed', 'timed_out', 'running']);
        const startedAt = status === 'queued' ? null : queuedAt + between(0, 120_000);
        const wakeMs = startedAt !== null && rand() < 0.7 ? between(200, 30_000) : null;
        const finishedAt = startedAt !== null && status !== 'running' ? startedAt + between(1000, 600_000) : null;
        const id = `jrun-${String(n).padStart(3, '0')}`;
        insertJobRun.run(
            id,
            job.id,
            job.userId,
            job.socioId,
            pick(['manual', 'dot', 'schedule']),
            status,
            queuedAt,
            startedAt,
            wakeMs,
            finishedAt,
            null,
        );
        jobRuns.push({
            id,
            socioId: job.socioId,
            personId: job.userId,
            status,
            queuedAt,
            startedAt,
            wakeMs,
        });
    }

    const goals: GoalFact[] = [];
    const insertGoal = db.prepare(
        `INSERT INTO goals (id, userId, dotId, title, detail, scheduleId, status, createdAt, updatedAt, closedAt)
    VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
    );
    const goalPlan = [
        { status: 'active', schedule: 'sched-0', updatedAt: now - DAY },
        { status: 'active', schedule: 'sched-3', updatedAt: now - DAY },
        { status: 'active', schedule: 'sched-1', updatedAt: now - 20 * DAY },
        {
            status: 'done',
            schedule: 'sched-2',
            updatedAt: now - 3 * DAY,
            closedAt: now - 3 * DAY,
        },
        {
            status: 'cancelled',
            schedule: 'sched-6',
            updatedAt: now - 10 * DAY,
            closedAt: now - 10 * DAY,
        },
        {
            status: 'done',
            schedule: 'sched-7',
            updatedAt: now - 60 * DAY,
            closedAt: now - 60 * DAY,
        },
    ];
    for (const [i, goal] of goalPlan.entries()) {
        const schedule = schedules.find((item) => item.id === goal.schedule)!;
        insertGoal.run(
            `goal-${i}`,
            schedule.personId,
            schedule.socioId,
            `Goal ${i}`,
            goal.schedule,
            goal.status,
            now - 90 * DAY,
            goal.updatedAt,
            goal.closedAt ?? null,
        );
        goals.push({
            id: `goal-${i}`,
            socioId: schedule.socioId,
            personId: schedule.personId,
            status: goal.status,
            state: goalState(goal, states.get(goal.schedule), now),
            closedAt: goal.closedAt ?? null,
        });
    }

    const longRuns: LongRunFact[] = [];
    const insertLong = db.prepare(
        `INSERT INTO job_long_runs (id, jobId, userId, dotId, trigger, status, batches, retries, createdAt, updatedAt, finishedAt, waitReason, lastError)
    VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertItem = db.prepare(
        'INSERT INTO job_items (longRunId, key, status, attempts, updatedAt) VALUES (?, ?, ?, 1, ?)',
    );
    const longPlan = [
        {
            status: 'running',
            job: jobs[0]!,
            items: { done: 40, dead: 3, pending: 12 },
            finished: null,
            wait: null,
            error: null,
        },
        {
            status: 'waiting',
            job: jobs[1]!,
            items: { done: 5, dead: 1, pending: 2 },
            finished: null,
            wait: 'rate limited',
            error: null,
        },
        {
            status: 'done',
            job: jobs[2]!,
            items: { done: 9, dead: 2, pending: 0 },
            finished: now - 2 * DAY,
            wait: null,
            error: null,
        },
        {
            status: 'failed',
            job: jobs[0]!,
            items: { done: 1, dead: 4, pending: 0 },
            finished: now - 50 * DAY,
            wait: null,
            error: 'Too many retries',
        },
    ];
    for (const [i, run] of longPlan.entries()) {
        const id = `long-${i}`;
        const updatedAt = run.finished ?? now - (i + 1) * MIN;
        const createdAt = updatedAt - 3 * DAY;
        insertLong.run(
            id,
            run.job.id,
            run.job.userId,
            run.job.socioId,
            run.status,
            3 + i,
            i,
            createdAt,
            updatedAt,
            run.finished,
            run.wait,
            run.error,
        );
        let key = 0;
        for (const [status, n] of Object.entries(run.items)) {
            for (let k = 0; k < n; k++) {
                insertItem.run(
                    id,
                    `item-${key++}`,
                    status === 'pending' ? (k % 2 ? 'claimed' : 'pending') : status,
                    updatedAt,
                );
            }
        }
        longRuns.push({
            id,
            jobId: run.job.id,
            jobName: run.job.name,
            socioId: run.job.socioId,
            personId: run.job.userId,
            status: run.status,
            batches: 3 + i,
            retries: i,
            itemsDone: run.items.done,
            itemsDead: run.items.dead,
            itemsPending: run.items.pending,
            createdAt,
            updatedAt,
            finishedAt: run.finished,
            waitReason: run.wait,
            lastError: run.error,
        });
    }
    db.exec('COMMIT');

    return {
        db,
        turns,
        health: {
            rounds,
            tools,
            jobRuns,
            taskRuns,
            schedules,
            goals,
            longRuns,
            socios,
            people,
        },
    };
}
