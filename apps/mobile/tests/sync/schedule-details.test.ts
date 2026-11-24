import { afterEach, describe, expect, it } from 'vitest';

import type { JobDetail, JobView, ScheduleDetail, ScheduleView } from '@socio/shared/schedule-types';
import type { Detail, Task } from '@socio/shared/types';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    DETAIL_OFFLINE,
    detailAge,
    jobDetailView,
    scheduleDetailView,
    taskDetailView,
} from '../../src/shell/schedules';
import {
    createScheduleDetails,
    readJobRun,
    readOlderJobRuns,
    readOlderScheduleRuns,
    type ScheduleDetails,
} from '../../src/sync/schedule-details';

import { syncSetup } from './helpers';

// The task, schedule and job details, three bounded
// kinds against a real cache.db: read as a screen uses one, kept on disk, so a
// detail opened once shows offline with its age; a 404 drops it; older runs and
// a job run's logs are read online only and never kept.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Array<{ s: Setup; details: ScheduleDetails }> = [];
afterEach(async () => {
    for (const { s, details } of open.splice(0)) {
        await details.close().catch(() => {});
        await s.close().catch(() => {});
    }
});

const task: Task = {
    id: 'task-1',
    prompt: 'Summarize the news\nEvery morning',
    status: 'completed',
    intervalSeconds: 3600,
    nextRunAt: 5_000,
    createdAt: 1_000,
    updatedAt: 2_000,
    error: null,
    lease: null,
    leaseUntil: null,
};
const schedule: ScheduleView = {
    id: 'task-1',
    title: 'Morning digest',
    prompt: 'Summarize the news',
    kind: 'turn',
    cadence: 'every day at 09:00',
    timezone: 'Europe/Madrid',
    intervalSeconds: null,
    status: 'scheduled',
    origin: 'user',
    dotId: 'dot-1',
    dotName: 'Ada',
    jobId: null,
    jobName: null,
    threadId: 'chat-1',
    nextRunAt: 5_000,
    lastRun: null,
    error: null,
    createdAt: 1_000,
};
const job: JobView = {
    id: 'job-1',
    name: 'Prices',
    dotId: 'dot-1',
    dotName: 'Ada',
    entry: 'main.sh',
    version: 2,
    timeoutSeconds: 60,
    datasets: ['scratch'],
    files: [{ path: 'main.sh', size: 10 }],
    untilDone: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    lastRun: null,
} as JobView;

const BODIES: Record<string, unknown> = {
    '/api/tasks/task-1': {
        task,
        runs: [{ id: 'r1' }],
        events: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: n, text: `event ${n}` })),
    } as unknown as Detail,
    '/api/schedules/task-1': {
        schedule,
        cadenceText: 'Every day at 09:00',
        upcoming: [5_000],
        approvals: [],
        goal: null,
        runs: [
            {
                id: 'sr-1',
                status: 'completed',
                startedAt: 3_000,
                finishedAt: 4_000,
                summary: 'Done',
                error: null,
                turnPath: '/chats/chat-1#message-m1',
                board: [{ issue: 'CB-12', title: 'A bug', action: 'create' }],
            },
        ],
        moreRuns: true,
    } satisfies ScheduleDetail,
    '/api/schedules/task-1/runs?before=sr-1': { runs: [{ id: 'sr-0' }], more: false },
    '/api/schedules/jobs/job-1': {
        job,
        longRun: null,
        versions: [],
        runs: [
            {
                id: 'jr-1',
                jobId: 'job-1',
                version: 2,
                trigger: 'schedule',
                scheduleId: null,
                status: 'succeeded',
                queuedAt: 3_000,
                startedAt: 3_100,
                wakeMs: null,
                finishedAt: 4_300,
                exitCode: 0,
                error: null,
                longRunId: null,
            },
        ],
        moreRuns: false,
    } as unknown as JobDetail,
    '/api/schedules/jobs/job-1/runs?before=jr-1': { runs: [{ id: 'jr-0' }], more: false },
    '/api/schedules/runs/jr-1': { id: 'jr-1', stdout: 'ok', stderr: '' },
};

async function setup(directory?: string) {
    const s = await syncSetup(directory === undefined ? {} : { directory });
    const server = { mode: 'ok' as 'ok' | 'offline' | 'gone', requests: [] as string[] };
    const fetch: AuthedFetch = async (path) => {
        server.requests.push(path);
        if (server.mode === 'offline') {
            throw new NetworkError(path);
        }
        const body = BODIES[path];
        return server.mode === 'gone' || body === undefined
            ? new Response(JSON.stringify({ error: 'Not found.' }), { status: 404 })
            : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const details = createScheduleDetails({ db: s.db, fetch, now: s.clock.device });
    open.push({ s, details });
    return { s, details, server, fetch };
}

describe('the task, schedule and job details', () => {
    it('read each as a screen uses it, at its own path, and keep it on disk', async () => {
        const { details, server } = await setup();
        expect(server.requests).toEqual([]);
        for (const [store, key] of [
            [details.tasks, 'task-1'],
            [details.schedules, 'task-1'],
            [details.jobs, 'job-1'],
        ] as const) {
            const item = store.item(key);
            const release = item.use();
            await item.refresh();
            expect(item.state.value).not.toBeNull();
            release();
            await store.flush();
            expect(await store.stored(key)).toBe(true);
        }
        expect(server.requests).toEqual(
            expect.arrayContaining(['/api/tasks/task-1', '/api/schedules/task-1', '/api/schedules/jobs/job-1']),
        );
    });

    it('offline, show the copy read before with its age, and say so with none', async () => {
        const first = await setup();
        for (const [store, key] of [
            [first.details.schedules, 'task-1'],
            [first.details.tasks, 'task-1'],
            [first.details.jobs, 'job-1'],
        ] as const) {
            await store.item(key).refresh();
            await store.flush();
        }
        const directory = first.s.directory;
        await first.details.close();
        await first.s.close({ remove: false });
        open.splice(0);

        const again = await setup(directory);
        again.server.mode = 'offline';
        const scheduleItem = again.details.schedules.item('task-1');
        const release = scheduleItem.use();
        await scheduleItem.loaded;
        await scheduleItem.refresh();
        const view = scheduleDetailView(scheduleItem.state, null, null, 'UTC');
        expect(view.state).toBe('ready');
        expect(view.title).toBe('Morning digest');
        expect(view.age).toMatch(/^Saved /);
        expect(view.runs.map((run) => run.text)).toEqual(['Done']);
        expect(view.buttons).toEqual(['run', 'pause', 'cancel']);
        release();

        const taskItem = again.details.tasks.item('task-1');
        await taskItem.loaded;
        await taskItem.refresh();
        const taskView = taskDetailView(taskItem.state, null, 'UTC');
        expect(taskView.age).toMatch(/^Saved /);
        expect(taskView.events).toEqual(['event 2', 'event 3', 'event 4', 'event 5', 'event 6', 'event 7']);
        expect(taskView.status).toBe('Scheduled');

        const jobItem = again.details.jobs.item('job-1');
        await jobItem.loaded;
        await jobItem.refresh();
        expect(jobDetailView(jobItem.state, null, 'UTC')).toMatchObject({
            state: 'ready',
            name: 'Prices',
            going: false,
            runs: [
                { id: 'jr-1', head: 'Succeeded · Jan 1, 1970, 12:00 AM', line: 'schedule · v2 · exit 0 · took 1.2 s' },
            ],
        });

        const missing = again.details.jobs.item('job-9');
        await missing.loaded;
        await missing.refresh();
        expect(jobDetailView(missing.state, null).state).toBe('offline');
        expect(DETAIL_OFFLINE).toBe('This shows once you’re online.');
    });

    it('a 404 drops the copy: "It may have been deleted, or it isn’t yours"', async () => {
        const { details, server } = await setup();
        const item = details.schedules.item('task-1');
        const release = item.use();
        await item.refresh();
        await details.schedules.flush();
        server.mode = 'gone';
        await item.refresh();
        expect(item.state.gone).toBe(true);
        expect(scheduleDetailView(item.state, null, null).state).toBe('gone');
        release();
        await details.schedules.flush();
        expect(await details.schedules.stored('task-1')).toBe(false);
    });

    it('a failed read keeps what is shown, and the age shows only then', () => {
        expect(detailAge({ failed: false, fetchedAt: 1_000 })).toBeNull();
        expect(detailAge({ failed: true, fetchedAt: null })).toBeNull();
        expect(detailAge({ failed: true, fetchedAt: Date.UTC(2026, 10, 8, 15, 45) }, 'UTC')).toBe(
            'Saved Nov 8, 2026, 3:45 PM',
        );
    });

    it('older runs and a job run’s logs are read online only, never kept', async () => {
        const { details, server, fetch } = await setup();
        expect(await readOlderScheduleRuns(fetch, { scheduleId: 'task-1', before: 'sr-1' })).toEqual({
            runs: [{ id: 'sr-0' }],
            more: false,
        });
        expect((await readOlderJobRuns(fetch, { jobId: 'job-1', before: 'jr-1' })).runs).toEqual([{ id: 'jr-0' }]);
        expect(await readJobRun(fetch, 'jr-1')).toMatchObject({ stdout: 'ok' });
        expect(await details.jobs.stored('jr-1')).toBe(false);
        server.mode = 'offline';
        await expect(readOlderScheduleRuns(fetch, { scheduleId: 'task-1', before: 'sr-1' })).rejects.toThrow();
        await expect(readJobRun(fetch, 'jr-1')).rejects.toThrow();
    });
});
