import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { afterEach, expect, it, vi } from 'vitest';

import { RuntimeSession } from '@socio/data/runtime-ownership';
import { DataError } from '@socio/foundation/dataspace/data-error';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { FORCE_STOP_MESSAGE } from '@socio/shared/operator';
import type {
    JobDetail,
    JobRunView,
    ScheduleDetail,
    ScheduleRunsPage,
    ScheduleView,
    SchedulesState,
} from '@socio/shared/schedule-types';
import type { User } from '@socio/shared/types';

import { accountLifecycle } from '../src/server/auth/accounts.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { abortComputerActions, computerActionsInFlight } from '../src/server/computers/computer-service.js';
import { forceStop } from '../src/server/runtime/force-stop.js';
import {
    DEACTIVATED_JOB_RUN,
    type JobSettings,
    SCHEDULE_PAUSE_AFTER_FAILURES,
    type ScheduleSettings,
} from '../src/server/schedules/contract.js';
import { jobFolder } from '../src/server/schedules/jobs.js';
import { scheduledTaskExecutor } from '../src/server/schedules/scheduled.js';

import { FakeComputer, SUPERVISOR } from './fixtures/fake-computer.js';
import { completion } from './fixtures/model-stream.js';
import { LocalAgentRunner, Runner } from './helpers/runners.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
vi.setConfig({ testTimeout: 20_000 });

const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'alice', name: 'Alice', role: 'member' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const SECRET = 'secret-0123456789abcdef-xyz';
const MAIN = 'echo hello\necho "token=$CB_DATA_TOKEN"\n';

async function fixture(
    options: {
        jobs?: Partial<JobSettings>;
        schedules?: Partial<ScheduleSettings>;
        apiUrl?: string | null;
        personal?: boolean;
        runtime?: RuntimeSession;
    } = {},
) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'cb-schedules-'));
    let computer!: FakeComputer;
    const model: string[] = [];
    // Before the platform: its computer service keeps the fetch it finds.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const answer = computer.handle(url, init ?? undefined);
        if (answer) {
            return answer;
        }
        if (url.startsWith('https://model.invalid/')) {
            model.push(String(init?.body));
            return String(init?.body).includes('Write a short title')
                ? Response.json({ choices: [{ message: { content: 'Title' } }] })
                : completion({ role: 'assistant', content: 'Here is the digest.' });
        }
        throw new Error(`Unexpected request to ${url}`);
    });
    const config: PlatformConfig = {
        baseUrl: 'https://model.invalid/v1',
        apiKey: 'unused',
        model: 'qwen-test',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: SECRET,
        computerSupervisorUrl: SUPERVISOR,
        computerSupervisorToken: 'supervisor-secret',
        computerToken: 'master-secret',
        data: {
            userDataDir: dir,
            ...(options.apiUrl === null ? {} : { apiUrl: options.apiUrl ?? 'http://company-brain-app:4310' }),
        },
        jobs: { pollMs: 10, graceMs: 50, ...options.jobs },
        schedules: options.schedules,
    };
    const { store, workspace, platform, app, dispose } = await makeTestRuntime({
        config,
        runner: new LocalAgentRunner(testDatabase(), options.runtime ? { runtime: options.runtime } : {}),
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }), dispose);
    const seed = workspace.dots()[0];
    const dot = options.personal
        ? workspace.createDot(
              seed.spaceId,
              'Personal',
              '',
              true,
              true,
              seed.spaceIds,
              null,
              false,
              null,
              false,
              'alice',
          )
        : seed;
    computer = new FakeComputer(dot.id);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    await workspace.computers.patch(dot.id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    // forceStop's scheduler (the app has its own runner).
    const scheduler = new Runner(store, { mode: 'live', baseUrl: '' });
    cleanup.push(() => scheduler.stop());
    const thread = workspace.bindThread('origin', dot.id, 'Chat', 'alice');
    const turn = (userId = 'alice', threadId = thread.id): DotTurn => ({
        dot: workspace.dot(dot.id)!,
        userId,
        threadId,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    });
    const tool = (name: string, userId = 'alice') => {
        const names: string[] = [];
        const tools = platform.dotExtensions.tools({
            ...turn(userId),
            toolNames: () => names,
        });
        names.push(...tools.map((item) => item.name));
        const found = tools.find((item) => item.name === name) as
            | (ToolDefinition & { execute: (input: unknown) => Promise<unknown> })
            | undefined;
        if (!found) {
            throw new Error(`No tool ${name}`);
        }
        return (input: unknown) => found.execute(input) as Promise<Record<string, unknown>>;
    };
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return async <T = unknown>(path: string, method = 'GET', body?: unknown) => {
            const response = await app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return {
                status: response.status,
                body: (await response.json()) as T,
            };
        };
    };
    const bypass = (capability: string, userId = 'alice') =>
        platform.approvals.setPolicy(userId, dot.id, capability, 'bypass');
    /** Saves a job under bypass and returns its id. */
    const saveJob = async (
        files: Record<string, string> = { 'main.sh': MAIN },
        extra: Record<string, unknown> = {},
        userId = 'alice',
    ) => {
        await bypass('job.save', userId);
        const result = await tool(
            'job_save',
            userId,
        )({
            name: 'Collect prices',
            entry: 'main.sh',
            files,
            timeoutSeconds: 30,
            ...extra,
        });
        if (result.status !== 'saved') {
            throw new Error(JSON.stringify(result));
        }
        return String(result.jobId);
    };
    return {
        store,
        workspace,
        platform,
        dot,
        computer,
        model,
        scheduler,
        app,
        thread,
        turn,
        tool,
        as,
        bypass,
        saveJob,
    };
}
const waitRun = async (
    f: Awaited<ReturnType<typeof fixture>>,
    runId: string,
    done = (run: JobRunView) => !['queued', 'starting', 'running'].includes(run.status),
) => {
    let run!: JobRunView;
    await vi.waitFor(
        async () => {
            run = await f.platform.jobs.run('alice', runId);
            expect(done(run)).toBe(true);
        },
        { timeout: 10_000, interval: 10 },
    );
    return run;
};

// ---- schedules -------------------------------------------------------------

it('keeps the complete maximum-length schedule instructions reviewable before approval (CB-244)', async () => {
    const f = await fixture();
    const ending = '\n\nOnly publish verified results. Never invent missing history.';
    const prompt = 'Review the board.\n'.padEnd(4000 - ending.length, 'x') + ending;
    const pending = await f.tool('schedule_create')({
        title: 'Board review',
        cadence: 'every day at 09:00',
        timezone: 'UTC',
        action: { kind: 'turn', prompt },
    });
    expect(pending).toMatchObject({ status: 'pending_approval' });
    const view = await f.platform.approvals.get(String(pending.id), 'alice');
    expect(view.details[1]).toBe(
        `Runs a turn of this socio as you, on your inference, in its own conversation:\n${prompt}`,
    );
    expect(await f.store.schedules('alice')).toEqual([]);
    await f.platform.approvals.decide(String(pending.id), 'alice', true);
    const [schedule] = await f.platform.schedules.list('alice');
    expect(schedule.prompt).toBe(prompt);
});

it('creates a Dot-proposed schedule only once the owner approves it, unless bypass', async () => {
    const f = await fixture();
    const create = f.tool('schedule_create');
    const pending = await create({
        title: 'Morning digest',
        cadence: 'every day at 09:00',
        timezone: 'Europe/Paris',
        action: { kind: 'turn', prompt: 'Summarise the prices tracked yesterday.' },
    });
    expect(pending).toMatchObject({
        status: 'pending_approval',
        approval: { summary: 'Schedule “Morning digest”, every day at 09:00' },
    });
    expect(await f.store.schedules('alice')).toEqual([]);
    // Another user can't decide it; the owner approves.
    await expect(f.platform.approvals.decide(String(pending.id), 'bob', true)).rejects.toThrow('not found');
    const decided = await f.platform.approvals.decide(String(pending.id), 'alice', true);
    expect(decided.outcome).toMatch(/^Schedule “Morning digest” created; next run/);
    const [schedule] = await f.platform.schedules.list('alice');
    expect(schedule).toMatchObject({
        title: 'Morning digest',
        kind: 'turn',
        cadence: 'every day at 09:00',
        timezone: 'Europe/Paris',
        status: 'scheduled',
        origin: 'dot',
        dotId: f.dot.id,
    });
    // 09:00 in Paris, in the future.
    expect(schedule.nextRunAt).toBeGreaterThan(Date.now());
    expect(
        new Date(schedule.nextRunAt!).toLocaleTimeString('en-GB', {
            timeZone: 'Europe/Paris',
        }),
    ).toBe('09:00:00');
    // Its turns get a conversation of their own, the owner's.
    const thread = f.workspace.thread(schedule.threadId!)!;
    expect(thread).toMatchObject({
        ownerId: 'alice',
        dotId: f.dot.id,
        title: 'Scheduled: Morning digest',
    });
    expect(schedule.threadId).not.toBe(f.thread.id);

    // Bypass: created at once, audited as such.
    await f.bypass('schedule.create');
    const direct = await create({
        title: 'Weekly review',
        cadence: '0 8 * * 1',
        action: { kind: 'turn', prompt: 'Review the week.' },
    });
    expect(direct).toMatchObject({ status: 'created' });
    expect(await f.platform.schedules.list('alice')).toHaveLength(2);
    expect(
        (await f.platform.approvals.auditFor('alice'))
            .filter((entry) => entry.capability === 'schedule.create')
            .map((entry) => entry.event),
    ).toEqual(expect.arrayContaining(['approved', 'bypassed', 'executed']));
});

it('refuses cadences under the minimum interval, unknown zones, others’ jobs, and more than the cap', async () => {
    const f = await fixture({ schedules: { maxActivePerUser: 2 } });
    await f.bypass('schedule.create');
    const create = f.tool('schedule_create');
    const turn = { kind: 'turn', prompt: 'Check the queue.' };
    expect(await create({ title: 'Too often', cadence: '*/5 * * * *', action: turn })).toEqual({
        error: 'Schedules run at most every 15 minutes. Choose a slower cadence.',
        code: 'http_400',
    });
    expect(
        await create({
            title: 'Too often',
            cadence: 'every 10 minutes',
            action: turn,
        }),
    ).toMatchObject({ error: expect.stringContaining('at most every 15') });
    expect(await create({ title: 'x', cadence: 'whenever', action: turn })).toMatchObject({
        error: expect.stringContaining('Use a phrase'),
    });
    expect(
        await create({
            title: 'x',
            cadence: 'every day',
            timezone: 'Mars/Olympus',
            action: turn,
        }),
    ).toMatchObject({ error: expect.stringContaining('Unknown time zone') });
    // Bob's job isn't Alice's to schedule.
    const bobJob = await f.saveJob(undefined, {}, 'bob');
    expect(
        await create({
            title: 'x',
            cadence: 'every hour',
            action: { kind: 'job', jobId: bobJob },
        }),
    ).toMatchObject({ error: expect.stringContaining('No such job') });
    for (const title of ['One', 'Two']) {
        expect(await create({ title, cadence: 'every 15 minutes', action: turn })).toMatchObject({ status: 'created' });
    }
    expect(await create({ title: 'Three', cadence: 'hourly', action: turn })).toMatchObject({
        error: expect.stringContaining('2 active schedules, the most allowed'),
    });
    // Canceling one frees a place; pending approvals are checked again.
    const [first] = await f.platform.schedules.list('alice', f.dot.id);
    expect(await f.tool('schedule_cancel')({ scheduleId: first.id })).toMatchObject({ status: 'cancelled' });
    expect(await create({ title: 'Three', cadence: 'hourly', action: turn })).toMatchObject({ status: 'created' });
});

it('lists, pauses, resumes and cancels a Dot’s schedules for its user only', async () => {
    const f = await fixture();
    await f.bypass('schedule.create');
    await f.tool('schedule_create')({
        title: 'Digest',
        cadence: 'every 6 hours',
        action: { kind: 'turn', prompt: 'Digest.' },
    });
    const list = (await f.tool('schedule_list')({})) as unknown as ScheduleView[];
    expect(list.map((item) => item.title)).toEqual(['Digest']);
    expect(await f.tool('schedule_list', 'bob')({})).toEqual([]);
    const id = list[0].id;
    expect(await f.tool('schedule_pause', 'bob')({ scheduleId: id })).toEqual({
        error: 'Schedule not found.',
        code: 'http_404',
    });
    expect(await f.tool('schedule_pause')({ scheduleId: id })).toMatchObject({
        status: 'paused',
        nextRunAt: null,
    });
    const resumed = await f.tool('schedule_resume')({ scheduleId: id });
    expect(resumed).toMatchObject({ status: 'scheduled' });
    expect(resumed.nextRunAt).toBeGreaterThan(Date.now());
    expect(await f.tool('schedule_cancel')({ scheduleId: id })).toMatchObject({
        status: 'cancelled',
    });
    expect(await f.tool('schedule_resume')({ scheduleId: id })).toEqual({
        error: 'This schedule was canceled.',
        code: 'http_409',
    });
});

it('runs a scheduled turn as its owner, on the owner’s inference for scheduled work, then schedules the next', async () => {
    const f = await fixture();
    await f.bypass('schedule.create');
    await f.tool('schedule_create')({
        title: 'Digest',
        cadence: 'every day at 07:00',
        action: { kind: 'turn', prompt: 'Write the morning digest.' },
    });
    const [schedule] = await f.platform.schedules.list('alice');
    const resolve = vi.spyOn(f.platform.inference, 'resolve');
    // The scheduler claims it once it is due.
    expect(await f.store.claim(schedule.nextRunAt! - 1000)).toBeNull();
    const claim = (await f.store.claim(schedule.nextRunAt! + 1000))!;
    expect(claim.id).toBe(schedule.id);
    const execute = scheduledTaskExecutor(f.platform, (id) => USERS.some((user) => user.id === id));
    const result = await execute(claim, [], new AbortController().signal, () => {});
    expect(result.text).toBe('Here is the digest.');
    expect(resolve).toHaveBeenCalledWith({
        userId: 'alice',
        purpose: 'scheduled',
    });
    expect(f.model[0]).toContain('Write the morning digest.');
    // In the schedule's own conversation, as a scheduled run.
    const messages = await f.platform.runner.messages(schedule.threadId!);
    expect(messages.map((message) => message.content)).toContain('Write the morning digest.');
    expect(
        f.platform.runner
            .recentRuns()
            .filter((run) => run.threadId === schedule.threadId)
            .map((run) => run.source),
    ).toEqual(['scheduled']);
    await f.store.finish(claim, result);
    const after = await f.platform.schedules.get('alice', schedule.id);
    expect(after.status).toBe('scheduled');
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    expect(after.lastRun).toMatchObject({ status: 'completed' });
    // A user who is gone no longer runs.
    await expect(
        scheduledTaskExecutor(f.platform, () => false)(claim, [], new AbortController().signal, () => {}),
    ).rejects.toThrow('no longer has access');
});

it('keeps a schedule’s cadence through failures and interruptions, and pauses it after repeated failures', async () => {
    const f = await fixture();
    const task = await f.store.createSchedule({
        userId: 'alice',
        title: 'Flaky',
        prompt: 'Try.',
        cadence: 'every 15 minutes',
        timezone: 'UTC',
        dotId: f.dot.id,
        kind: 'turn',
    });
    let at = task.nextRunAt!;
    const claimNext = async () => {
        const claim = (await f.store.claim(at + 1))!;
        expect(claim.id).toBe(task.id);
        return claim;
    };
    await f.store.interrupt(await claimNext(), 'Server stopped.');
    expect(await f.store.task(task.id)).toMatchObject({
        status: 'scheduled',
        error: 'Server stopped.',
    });
    at = (await f.store.task(task.id))!.nextRunAt!;
    for (let i = 0; i < SCHEDULE_PAUSE_AFTER_FAILURES; i++) {
        await f.store.fail(await claimNext(), 'Model unavailable.');
        const current = (await f.store.task(task.id))!;
        if (i < SCHEDULE_PAUSE_AFTER_FAILURES - 1) {
            expect(current.status).toBe('scheduled');
            at = current.nextRunAt!;
        }
    }
    expect(await f.store.task(task.id)).toMatchObject({
        status: 'paused',
        nextRunAt: null,
        error: expect.stringContaining('Paused after 5 failed runs in a row'),
    });
    // The minimum gap holds even when asked right after a run.
    await f.store.action(task.id, 'resume');
    const resumed = (await f.store.task(task.id))!;
    expect(resumed.nextRunAt! - resumed.lastRunAt!).toBeGreaterThanOrEqual(15 * 60_000 - 1);
});

// ---- jobs ------------------------------------------------------------------

it('saves a job only with approval, as versions whose code lives encrypted in the data space', async () => {
    const f = await fixture();
    const pending = await f.tool('job_save')({
        name: 'Collect prices',
        entry: 'main.sh',
        files: { 'main.sh': MAIN },
        timeoutSeconds: 30,
    });
    expect(pending).toMatchObject({ status: 'pending_approval' });
    expect(await f.platform.jobs.list('alice')).toEqual([]);
    const view = await f.platform.approvals.get(String(pending.id), 'alice');
    expect(view.details).toEqual(expect.arrayContaining([expect.stringContaining('Files: main.sh'), '│ echo hello']));
    await f.platform.approvals.decide(String(pending.id), 'alice', true);
    const jobId = String(pending.jobId);
    expect(await f.platform.jobs.job('alice', jobId)).toMatchObject({
        name: 'Collect prices',
        version: 1,
        entry: 'main.sh',
        datasets: [],
    });
    // The same name is the next version; the code is in the Dot's folder.
    const second = await f.saveJob({
        'main.sh': 'echo v2\n',
        'lib/x.sh': 'true',
    });
    expect(second).toBe(jobId);
    const detail = await f.platform.jobs.detail('alice', jobId);
    expect(detail.versions.map((version) => version.version)).toEqual([2, 1]);
    const stored = f.platform.data.listFiles({ kind: 'user', userId: 'alice' }).map((file) => file.path);
    expect(stored).toEqual(
        expect.arrayContaining([`${jobFolder(f.dot.id, jobId, 1)}main.sh`, `${jobFolder(f.dot.id, jobId, 2)}lib/x.sh`]),
    );
    expect((await f.platform.jobs.code('alice', jobId, 1)).files).toEqual({
        'main.sh': MAIN,
    });
    // Bad input is refused before anything is asked.
    for (const [input, error] of [
        [{ files: { 'main.ts': '' } }, 'must include the entry, main.sh'],
        [{ files: { '../x.sh': '', 'main.sh': '' } }, 'Invalid file path'],
        [{ timeoutSeconds: 100_000 }, 'The timeout is 5 to 900 seconds'],
        [{ datasets: ['nope'] }, 'No dataset "nope"'],
    ] as const) {
        expect(
            await f.tool('job_save')({
                name: 'Bad',
                entry: 'main.sh',
                files: { 'main.sh': 'true' },
                timeoutSeconds: 30,
                ...input,
            }),
        ).toMatchObject({ error: expect.stringContaining(error) });
    }
    // Others' jobs are invisible.
    expect(await f.platform.jobs.list('bob')).toEqual([]);
    await expect(f.platform.jobs.detail('bob', jobId)).rejects.toThrow('Job not found.');
});

it('runs a job through the computer: wake, fresh files, a scoped token for that run, logs, token revoked', async () => {
    const f = await fixture({ personal: true });
    const granted = f.platform.data.createDataset('alice', { name: 'Prices' });
    const other = f.platform.data.createDataset('alice', { name: 'Diary' });
    for (const dataset of [granted, other]) {
        f.platform.data.setGrant('alice', {
            dotId: f.dot.id,
            datasetId: dataset.id,
            access: 'write',
        });
    }
    const jobId = await f.saveJob({ 'main.sh': MAIN, 'lib/util.sh': 'true\n' }, { datasets: ['Prices'] });
    f.computer.wakeMs = 30;
    let seen: { live: unknown; datasets: unknown } | undefined;
    f.computer.behavior = async ({ env }) => {
        // While it runs, the token works, for the job's datasets and scratch only.
        const response = await f.app.request('http://company-brain-app:4310/api/data/datasets', {
            headers: { Authorization: `Bearer ${env.CB_DATA_TOKEN}` },
        });
        seen = {
            live: f.platform.data.tokens.resolve(env.CB_DATA_TOKEN),
            datasets: ((await response.json()) as Array<{ name: string }>).map((item) => item.name),
        };
        return {
            stdout: `hello\ntoken=${env.CB_DATA_TOKEN}\n`,
            stderr: 'warning\n',
            code: 0,
        };
    };
    const result = (await f.tool('job_run')({ jobId })) as unknown as JobRunView;
    expect(result).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        trigger: 'dot',
        version: 1,
        stdout: 'hello\ntoken=[redacted]\n',
        stderr: 'warning\n',
    });
    expect(result.wakeMs).toBeGreaterThanOrEqual(20);
    expect(f.computer.ensures).toBe(1);
    // A fresh directory per run with the version's files and the wrapper.
    const dir = `.socio/jobs/${jobId}/${result.id}`;
    expect(f.computer.writes.map((write) => write.path)).toEqual([
        `${dir}/lib/util.sh`,
        `${dir}/main.sh`,
        `${dir}/run.sh`,
        `${dir}/job.env`,
    ]);
    const wrapper = f.computer.files.get(`${dir}/run.sh`)!;
    expect(wrapper).toMatch(/timeout -k 5 (29|30) bash main\.sh > out\.log/);
    // The token came in the environment; its file was removed before the run.
    const [launch] = f.computer.launches;
    expect(launch.env).toMatchObject({
        CB_DATA_URL: 'http://company-brain-app:4310/api/data',
        CB_JOB_ID: jobId,
        CB_JOB_RUN_ID: result.id,
    });
    expect(f.computer.files.has(`${dir}/job.env`)).toBe(false);
    expect(seen!.live).toMatchObject({
        userId: 'alice',
        dotId: f.dot.id,
        purpose: 'job',
        datasetIds: [granted.id, 'scratch'],
    });
    expect(seen!.datasets).toEqual(expect.arrayContaining(['Prices']));
    expect(seen!.datasets).not.toContain('Diary');
    // Revoked once the run ended; never in a command, the logs or the database.
    expect(f.platform.data.tokens.resolve(launch.env.CB_DATA_TOKEN)).toBeUndefined();
    expect(f.computer.commands.join('\n')).not.toContain(launch.env.CB_DATA_TOKEN);
    expect(JSON.stringify(await f.platform.jobs.detail('alice', jobId))).not.toContain(launch.env.CB_DATA_TOKEN);
    expect((await f.platform.jobs.job('alice', jobId)).lastRun).toMatchObject({
        status: 'succeeded',
    });
    // The logs, for the Dot and the user only.
    expect(await f.tool('job_logs')({ runId: result.id })).toMatchObject({
        stdout: 'hello\ntoken=[redacted]\n',
    });
    expect(await f.tool('job_logs', 'bob')({ runId: result.id })).toEqual({
        error: 'Run not found.',
        code: 'http_404',
    });
});

it('records timeouts: the job’s own (exit 124) and a run that never reports, which is killed', async () => {
    const f = await fixture({ jobs: { syncMaxSeconds: 0 } });
    const jobId = await f.saveJob();
    f.computer.running = true;
    f.computer.behavior = () => ({ stdout: 'partial\n', code: 124 });
    const timedOut = await waitRun(f, (await f.platform.jobs.start('alice', jobId, { trigger: 'manual' })).id);
    expect(timedOut).toMatchObject({
        status: 'timed_out',
        exitCode: 124,
        stdout: 'partial\n',
        error: 'Stopped at the job’s 30 s timeout.',
    });
    // Detached (longer than one exec waits): polled, then killed at the deadline.
    expect(f.computer.commands.some((c) => c.includes('if command -v setsid'))).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    f.computer.behavior = ({ killed }) => killed.then(() => ({ stdout: 'stuck\n' }));
    const run = await f.platform.jobs.start('alice', jobId, {
        trigger: 'manual',
    });
    await vi.waitFor(async () => expect((await f.platform.jobs.run('alice', run.id)).status).toBe('running'));
    vi.setSystemTime(Date.now() + 60_000);
    const stuck = await waitRun(f, run.id);
    expect(stuck.status).toBe('timed_out');
    expect(f.computer.kills).toBeGreaterThanOrEqual(1);
});

it('refuses a run whose stored code changed outside job_save, and runs without a token when there is no data API', async () => {
    const f = await fixture({ apiUrl: null });
    const jobId = await f.saveJob();
    const runId = (await f.platform.jobs.start('alice', jobId, { trigger: 'manual' })).id;
    const run = await waitRun(f, runId);
    expect(run.status).toBe('succeeded');
    expect(f.computer.launches[0].env).toEqual({});
    await f.platform.data.putFile(
        { kind: 'dot', userId: 'alice', dotId: f.dot.id },
        `${jobFolder(f.dot.id, jobId, 1)}main.sh`,
        Buffer.from('curl evil'),
    );
    const tampered = await waitRun(f, (await f.platform.jobs.start('alice', jobId, { trigger: 'manual' })).id);
    expect(tampered).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('changed outside job_save'),
    });
});

it('keeps a job approved in a storage outage, visible with its code missing, and job_retry stores the approved code and runs it (CB-336)', async () => {
    const f = await fixture();
    const putFile = f.platform.data.putFile.bind(f.platform.data);
    const outage = vi
        .spyOn(f.platform.data, 'putFile')
        .mockRejectedValue(new DataError('File storage is unavailable; try again.', 503));
    const pending = await f.tool('job_save')({
        name: 'Ingest catalog',
        entry: 'main.sh',
        files: { 'main.sh': MAIN, 'lib/pages.sh': 'true\n' },
        timeoutSeconds: 30,
    });
    const jobId = String(pending.jobId);
    // The user approves during the outage: the approval failed as it ran, and says what to do next.
    expect(await f.platform.approvals.decide(String(pending.id), 'alice', true)).toMatchObject({
        status: 'failed',
        outcome: expect.stringContaining('couldn’t be stored: File storage is unavailable'),
    });
    // The job is there, not "not found".
    expect((await f.tool('job_list')({})) as unknown as Array<{ id: string }>).toEqual([
        expect.objectContaining({ id: jobId, name: 'Ingest catalog', version: 1 }),
    ]);
    const alice = await f.as('alice');
    expect((await alice<JobDetail>(`/schedules/jobs/${jobId}`)).body.code).toEqual({
        state: 'missing',
        missing: ['lib/pages.sh', 'main.sh'],
        error: null,
    });
    expect(await f.tool('job_inspect')({ jobId })).toMatchObject({
        saved: true,
        version: 1,
        code: { state: 'missing', missing: ['lib/pages.sh', 'main.sh'] },
        lastRun: null,
        retryable: true,
    });
    // A run while the code is missing fails, and says why.
    const missing = await waitRun(f, (await f.platform.jobs.start('alice', jobId, { trigger: 'manual' })).id);
    expect(missing).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('missing from storage. job_retry'),
    });
    // Still down: the retry fails as the storage does, and changes nothing.
    expect(await f.tool('job_retry')({ jobId })).toMatchObject({
        error: 'File storage is unavailable; try again.',
    });
    // Others can't see or retry it.
    expect(await f.tool('job_inspect', 'bob')({ jobId })).toMatchObject({ error: 'Job not found.' });
    expect(await f.tool('job_retry', 'bob')({ jobId })).toMatchObject({ error: 'Job not found.' });

    // Storage is back: the approved code is stored again, then it runs.
    outage.mockImplementation(putFile);
    const retried = await f.tool('job_retry')({ jobId });
    expect(retried).toMatchObject({ repaired: 'code', run: { status: 'succeeded', version: 1 } });
    expect((await f.platform.jobs.code('alice', jobId)).files).toEqual({
        'main.sh': MAIN,
        'lib/pages.sh': 'true\n',
    });
    expect(await f.tool('job_inspect')({ jobId })).toMatchObject({
        code: { state: 'stored', missing: [] },
        lastRun: { status: 'succeeded' },
        retryable: false,
    });
    // Stored: a retry only runs it again.
    expect(await f.tool('job_retry')({ jobId })).toMatchObject({ repaired: null, run: { status: 'succeeded' } });

    // Under bypass, job_save answers with the job's id and what to do.
    await f.bypass('job.save');
    outage.mockRejectedValue(new DataError('File storage is unavailable; try again.', 503));
    const bypassed = await f.tool('job_save')({
        name: 'Ingest catalog',
        entry: 'main.sh',
        files: { 'main.sh': 'echo v2\n' },
        timeoutSeconds: 30,
    });
    expect(bypassed).toMatchObject({
        error: expect.stringContaining(`(${jobId}) version 2, but its code couldn’t be stored`),
    });
    expect(await f.tool('job_inspect')({ jobId })).toMatchObject({ version: 2, code: { state: 'missing' } });
});

it('job_retry restores only the code the user approved, never newer code, and refuses without it (CB-336)', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    // The Dot rewrote the stored file outside job_save: retry puts the approved code back.
    await f.platform.data.putFile(
        { kind: 'dot', userId: 'alice', dotId: f.dot.id },
        `${jobFolder(f.dot.id, jobId, 1)}main.sh`,
        Buffer.from('curl evil'),
    );
    expect(await f.tool('job_inspect')({ jobId })).toMatchObject({
        code: { state: 'changed', error: expect.stringContaining('changed outside job_save') },
    });
    expect(await f.tool('job_retry')({ jobId })).toMatchObject({ repaired: 'code', run: { status: 'succeeded' } });
    expect((await f.platform.jobs.code('alice', jobId)).files).toEqual({ 'main.sh': MAIN });
    expect(f.computer.writes.map((write) => write.contents)).not.toContain('curl evil');

    // An approval that doesn't hold this version's code is no source: the retry refuses.
    await f.platform.data.putFile(
        { kind: 'dot', userId: 'alice', dotId: f.dot.id },
        `${jobFolder(f.dot.id, jobId, 1)}main.sh`,
        Buffer.from('curl evil'),
    );
    vi.spyOn(f.platform.approvals, 'approvedPayload').mockResolvedValue({
        dotId: f.dot.id,
        payload: { jobId, entry: 'main.sh', files: { 'main.sh': 'curl evil' } },
    });
    expect(await f.tool('job_retry')({ jobId })).toMatchObject({
        error: expect.stringContaining('approved code of this version isn’t on record'),
    });
    expect((await f.platform.jobs.run('alice', (await f.platform.jobs.job('alice', jobId)).lastRun!.id)).status).toBe(
        'succeeded',
    );
});

it('finds a job whose approved save never got recorded, and job_retry saves it from the approval (CB-336)', async () => {
    const f = await fixture();
    // A save that failed before the job was recorded (before CB-336 an
    // outage did this; here, the space was full).
    const refused = vi
        .spyOn(f.platform.data, 'putFile')
        .mockRejectedValueOnce(new DataError('The data space is full. Delete datasets or files in the app.', 413));
    const pending = await f.tool('job_save')({
        name: 'Ingest catalog',
        entry: 'main.sh',
        files: { 'main.sh': MAIN },
        timeoutSeconds: 30,
    });
    const jobId = String(pending.jobId);
    expect(await f.platform.approvals.decide(String(pending.id), 'alice', true)).toMatchObject({
        status: 'failed',
        outcome: expect.stringContaining('data space is full'),
    });
    expect(await f.platform.jobs.list('alice')).toEqual([]);
    expect(await f.tool('job_run')({ jobId })).toMatchObject({ error: 'Job not found.' });
    expect(await f.tool('job_inspect')({ jobId })).toMatchObject({
        saved: false,
        name: 'Ingest catalog',
        saveFailed: { error: expect.stringContaining('data space is full') },
        retryable: true,
    });
    expect(await f.tool('job_inspect', 'bob')({ jobId })).toMatchObject({ error: 'Job not found.' });
    refused.mockRestore();
    expect(await f.tool('job_retry')({ jobId })).toMatchObject({
        repaired: 'saved',
        run: { status: 'succeeded', version: 1 },
    });
    expect(await f.platform.jobs.job('alice', jobId)).toMatchObject({ name: 'Ingest catalog', version: 1 });
    expect(await f.tool('job_inspect')({ jobId })).toMatchObject({ saved: true, code: { state: 'stored' } });
});

it('counts job runs for the drain and stops them on a force stop, killing the process and revoking the token', async () => {
    const f = await fixture({ jobs: { concurrency: 1 } });
    const jobId = await f.saveJob();
    const otherId = await f.saveJob(undefined, { name: 'Other' });
    f.computer.running = true;
    f.computer.behavior = ({ killed }) => killed.then(() => ({ stdout: 'stopped\n' }));
    const run = await f.platform.jobs.start('alice', jobId, {
        trigger: 'manual',
    });
    await vi.waitFor(() => expect(f.computer.launches).toHaveLength(1));
    const token = f.computer.launches[0].env.CB_DATA_TOKEN;
    expect(f.platform.data.tokens.resolve(token)).toBeDefined();
    // A second start of the same job is the run in progress.
    expect((await f.platform.jobs.start('alice', jobId, { trigger: 'manual' })).id).toBe(run.id);
    expect(f.platform.inProgress()).toBe(1);
    // One slot: another job's run waits for it, and counts.
    const queued = await f.platform.jobs.start('alice', otherId, {
        trigger: 'manual',
    });
    expect(queued.status).toBe('queued');
    expect(f.platform.inProgress()).toBe(2);
    // Draining refuses new runs; the running one keeps going.
    f.platform.drain();
    await expect(f.platform.jobs.start('alice', jobId, { trigger: 'schedule' })).rejects.toThrow('Socio is updating');
    expect(f.platform.jobs.running).toBe(2);
    const result = await forceStop(
        {
            platform: f.platform,
            scheduler: f.scheduler,
            computers: { inFlight: computerActionsInFlight, abort: abortComputerActions },
        },
        { by: 'olga', hold: true },
    );
    expect(result.jobRuns).toBe(2);
    // forceStop resolves once the cancels are sent; the queued run is stored
    // as interrupted just after.
    await vi.waitFor(async () =>
        expect(await f.platform.jobs.run('alice', queued.id)).toMatchObject({
            status: 'interrupted',
            error: FORCE_STOP_MESSAGE,
        }),
    );
    const stopped = await waitRun(f, run.id);
    expect(stopped).toMatchObject({
        status: 'interrupted',
        error: FORCE_STOP_MESSAGE,
    });
    expect(f.computer.kills).toBe(1);
    expect(f.platform.data.tokens.resolve(token)).toBeUndefined();
    expect(f.platform.inProgress()).toBe(0);
});

it('stops a deactivated owner’s job runs, queued and running, and leaves others’ running', async () => {
    const f = await fixture({ jobs: { concurrency: 2 } });
    const jobId = await f.saveJob();
    const otherId = await f.saveJob(undefined, { name: 'Other' });
    const bobsId = await f.saveJob(undefined, { name: 'Bob’s' }, 'bob');
    f.computer.running = true;
    f.computer.behavior = ({ killed }) => killed.then(() => ({ stdout: 'stopped\n' }));
    const running = await f.platform.jobs.start('alice', jobId, {
        trigger: 'manual',
    });
    const bobs = await f.platform.jobs.start('bob', bobsId, {
        trigger: 'manual',
    });
    await vi.waitFor(() => expect(f.computer.launches).toHaveLength(2));
    const queued = await f.platform.jobs.start('alice', otherId, {
        trigger: 'manual',
    });
    expect(queued.status).toBe('queued');
    // As a deactivation does it (accounts.ts), and audits it.
    await accountLifecycle(f.platform)({
        action: 'deactivate',
        userId: 'alice',
        name: 'Alice',
        by: 'olga',
    });
    expect(await f.platform.jobs.run('alice', queued.id)).toMatchObject({
        status: 'interrupted',
        error: DEACTIVATED_JOB_RUN,
    });
    expect(await waitRun(f, running.id)).toMatchObject({
        status: 'interrupted',
        error: DEACTIVATED_JOB_RUN,
    });
    expect(f.computer.kills).toBe(1);
    expect((await f.platform.jobs.run('bob', bobs.id)).status).toBe('running');
    expect(f.platform.jobs.running).toBe(1);
    expect(f.workspace.auditOf('user', 'alice').at(-1)).toMatchObject({
        action: 'deactivate',
        detail: 'Alice; stopped 2 job run(s)',
    });
    // The queued run never started.
    expect(f.computer.launches).toHaveLength(2);
});

it('stops a job run whose owner is deactivated elsewhere (the auth CLI), within a second', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    f.computer.running = true;
    f.computer.behavior = ({ killed }) => killed.then(() => ({ stdout: 'stopped\n' }));
    const deactivated: string[] = [];
    f.workspace.useDeactivated(() => deactivated);
    const run = await f.platform.jobs.start('alice', jobId, {
        trigger: 'manual',
    });
    await vi.waitFor(() => expect(f.computer.launches).toHaveLength(1));
    deactivated.push('alice');
    expect(await waitRun(f, run.id)).toMatchObject({
        status: 'interrupted',
        error: DEACTIVATED_JOB_RUN,
    });
});

it('a job schedule starts a run of its job as the owner', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    await f.bypass('schedule.create');
    expect(
        await f.tool('schedule_create')({
            title: 'Prices hourly',
            cadence: 'every hour',
            action: { kind: 'job', jobId },
        }),
    ).toMatchObject({ status: 'created' });
    const [schedule] = await f.platform.schedules.list('alice');
    expect(schedule).toMatchObject({
        kind: 'job',
        jobName: 'Collect prices',
        threadId: null,
    });
    const claim = (await f.store.claim(schedule.nextRunAt! + 1))!;
    const result = await scheduledTaskExecutor(f.platform, () => true)(
        claim,
        [],
        new AbortController().signal,
        () => {},
    );
    expect(result.text).toMatch(/^Started a run of the job/);
    await f.store.finish(claim, result);
    const run = (await f.platform.jobs.lastScheduledRun(schedule.id))!;
    expect(run).toMatchObject({ trigger: 'schedule', scheduleId: schedule.id });
    expect((await waitRun(f, run.id)).status).toBe('succeeded');
    expect((await f.platform.schedules.get('alice', schedule.id)).lastRun).toMatchObject({
        status: 'succeeded',
    });
});

it('hides a deleted job from the app and its Dot, stops its schedules, frees its name, and keeps it (CB-64)', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    await f.bypass('schedule.create');
    await f.tool('schedule_create')({
        title: 'Prices hourly',
        cadence: 'every hour',
        action: { kind: 'job', jobId },
    });
    const started = await f.platform.jobs.start('alice', jobId, {
        trigger: 'manual',
    });
    await waitRun(f, started.id);
    const alice = await f.as('alice');
    expect((await alice(`/schedules/jobs/${jobId}`, 'DELETE')).status).toBe(200);

    // The app, the Dot's tools and every lookup.
    const state = await alice<SchedulesState>('/schedules');
    expect(state.body.jobs).toEqual([]);
    expect(await f.tool('job_list')({})).toEqual([]);
    for (const path of [`/schedules/jobs/${jobId}`, `/schedules/jobs/${jobId}/code`, `/schedules/runs/${started.id}`]) {
        expect((await alice(path)).status, path).toBe(404);
    }
    expect((await alice(`/schedules/jobs/${jobId}/run`, 'POST')).status).toBe(404);
    expect((await alice(`/schedules/jobs/${jobId}`, 'DELETE')).status).toBe(404);
    // Its schedule stops, and says its job is gone.
    expect(state.body.schedules).toMatchObject([{ kind: 'job', status: 'cancelled', jobName: null }]);
    expect(await f.store.claim(Date.now() + 2 * 3600_000)).toBeNull();
    expect((await f.platform.jobs.counts()).jobs).toBe(0);

    // Kept: the row, its versions, its runs and its code in the data space.
    expect(await f.platform.jobs.withDeleted(jobId)).toMatchObject({
        name: 'Collect prices',
        deletedBy: 'alice',
        deletedAt: expect.any(Number),
    });
    const count = (table: string) =>
        f.workspace.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE jobId=?`).get(jobId);
    expect(count('job_versions')).toEqual({ n: 1 });
    expect(count('job_runs')).toEqual({ n: 1 });
    // Pass 2: its code files are hidden with it, and kept.
    expect(f.platform.data.listFiles({ kind: 'user', userId: 'alice' }).map((file) => file.path)).not.toContain(
        `${jobFolder(f.dot.id, jobId, 1)}main.sh`,
    );
    expect(
        f.workspace.db
            .prepare('SELECT path, deletedBy, deletedWith FROM data_files WHERE path LIKE ?')
            .all(`dots/${f.dot.id}/jobs/${jobId}/%`)
            .map((row) => ({ ...row })),
    ).toEqual([
        {
            path: `${jobFolder(f.dot.id, jobId, 1)}main.sh`,
            deletedBy: 'alice',
            deletedWith: `job:${jobId}`,
        },
    ]);
    expect(f.workspace.auditOf('job', jobId)).toMatchObject([
        { actor: 'alice', action: 'delete', detail: 'Collect prices' },
    ]);
    // The name is free: the same name saves a new job.
    const again = await f.saveJob();
    expect(again).not.toBe(jobId);
    expect((await f.platform.jobs.list('alice')).map((job) => job.id)).toEqual([again]);
});

it('keeps every run, emptying the output of runs past the newest keepRuns', async () => {
    const f = await fixture({ jobs: { keepRuns: 2 } });
    const jobId = await f.saveJob();
    let n = 0;
    f.computer.behavior = () => {
        n++;
        return {
            stdout: `run ${n}\n`,
            stderr: `warn ${n}\n`,
            code: n === 1 ? 3 : 0,
        };
    };
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
        const started = await f.platform.jobs.start('alice', jobId, {
            trigger: i ? 'manual' : 'dot',
            dotId: i ? undefined : f.dot.id,
        });
        await waitRun(f, started.id);
        ids.push(started.id);
    }
    const [first, second, third, fourth] = ids;
    const alice = await f.as('alice');

    // Every run is listed; the two oldest say their output wasn't kept.
    const detail = await alice<JobDetail>(`/schedules/jobs/${jobId}`);
    expect(detail.body.runs.map((run) => [run.id, run.outputNotKept])).toEqual([
        [fourth, undefined],
        [third, undefined],
        [second, 'Output not kept for older runs.'],
        [first, 'Output not kept for older runs.'],
    ]);
    expect(detail.body.moreRuns).toBe(false);
    // Older runs page in, newest first, after a run of the job.
    expect((await alice(`/schedules/jobs/${jobId}/runs?before=${third}&limit=1`)).body).toMatchObject({
        runs: [{ id: second }],
        more: true,
    });
    expect((await alice(`/schedules/jobs/${jobId}/runs?before=${second}`)).body).toMatchObject({
        runs: [{ id: first }],
        more: false,
    });
    const bob = await f.as('bob');
    for (const [who, path, status] of [
        [alice, `/schedules/jobs/${jobId}/runs?before=nope`, 404],
        [alice, `/schedules/jobs/${jobId}/runs?before=${third}&limit=0`, 400],
        [bob, `/schedules/jobs/${jobId}/runs?before=${third}`, 404],
    ] as const) {
        expect((await who(path)).status, path).toBe(status);
    }
    // The run itself is kept: when, version, trigger, status, exit code.
    const old = await alice<JobRunView>(`/schedules/runs/${first}`);
    expect(old.status).toBe(200);
    expect(old.body).toMatchObject({
        trigger: 'dot',
        version: 1,
        status: 'failed',
        exitCode: 3,
        startedAt: expect.any(Number),
        finishedAt: expect.any(Number),
        outputNotKept: 'Output not kept for older runs.',
    });
    expect(old.body).not.toHaveProperty('stdout');
    expect(old.body).not.toHaveProperty('stderr');
    expect(await f.tool('job_logs')({ runId: second })).toMatchObject({
        status: 'succeeded',
        outputNotKept: 'Output not kept for older runs.',
    });
    // The newest keep theirs.
    expect((await alice<JobRunView>(`/schedules/runs/${third}`)).body).toMatchObject({
        stdout: 'run 3\n',
        stderr: 'warn 3\n',
    });
    expect((await alice<JobRunView>(`/schedules/runs/${fourth}`)).body.outputNotKept).toBeUndefined();
    // In the database: every row, the output gone only from the old ones.
    expect(
        f.workspace.db
            .prepare(
                'SELECT id, stdout, stderr, outputTrimmedAt IS NOT NULL AS trimmed FROM job_runs WHERE jobId=? ORDER BY queuedAt, rowid',
            )
            .all(jobId)
            .map((row) => ({ ...row })),
    ).toEqual([
        { id: first, stdout: null, stderr: null, trimmed: 1 },
        { id: second, stdout: null, stderr: null, trimmed: 1 },
        { id: third, stdout: 'run 3\n', stderr: 'warn 3\n', trimmed: 0 },
        { id: fourth, stdout: 'run 4\n', stderr: 'warn 4\n', trimmed: 0 },
    ]);
    expect((await f.platform.jobs.counts()).jobRuns).toEqual({
        failed: 1,
        succeeded: 3,
    });
});

it('refuses an update approved after its job was deleted, writing nothing (CB-64)', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    await f.platform.approvals.setPolicy('alice', f.dot.id, 'job.save', 'manual');
    const pending = await f.tool('job_save')({
        name: 'Collect prices',
        entry: 'main.sh',
        files: { 'main.sh': 'echo v2\n' },
        timeoutSeconds: 30,
    });
    expect(pending).toMatchObject({ status: 'pending_approval', jobId });
    const alice = await f.as('alice');
    expect((await alice(`/schedules/jobs/${jobId}`, 'DELETE')).status).toBe(200);

    const decided = await f.platform.approvals.decide(String(pending.id), 'alice', true);
    expect(decided).toMatchObject({
        status: 'failed',
        outcome: expect.stringContaining('was deleted'),
    });
    // The job stays deleted with its one version; no live code was written.
    expect(await f.platform.jobs.list('alice')).toEqual([]);
    expect(await f.platform.jobs.withDeleted(jobId)).toMatchObject({
        version: 1,
        deletedBy: 'alice',
    });
    expect(
        f.platform.data
            .listFiles({ kind: 'user', userId: 'alice' })
            .filter((file) => file.path.startsWith(`dots/${f.dot.id}/jobs/`)),
    ).toEqual([]);
});

// ---- the app ---------------------------------------------------------------

it('shows users only their own schedules and jobs; operators also get counts', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    await f.bypass('schedule.create');
    await f.tool('schedule_create')({
        title: 'Alice digest',
        cadence: 'daily',
        action: { kind: 'turn', prompt: 'Digest.' },
    });
    // A task Alice made in a conversation shows too, as hers.
    const own = await f.store.createTask('Weekly notes', 604_800, 'alice');
    await f.workspace.bindTask(own.id, f.thread.id);
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const olga = await f.as('olga');
    const mine = await alice<SchedulesState>('/schedules');
    expect(mine.status).toBe(200);
    expect(mine.body.schedules.map((item) => [item.title, item.origin])).toEqual(
        expect.arrayContaining([
            ['Alice digest', 'dot'],
            ['Weekly notes', 'user'],
        ]),
    );
    expect(mine.body.jobs.map((job) => job.id)).toEqual([jobId]);
    expect(mine.body.counts).toBeUndefined();
    const theirs = await bob<SchedulesState>('/schedules');
    expect(theirs.body.schedules).toEqual([]);
    expect(theirs.body.jobs).toEqual([]);
    const id = (await mine.body.schedules.find((item) => item.origin === 'dot'))!.id;
    expect((await bob(`/schedules/${id}/actions`, 'POST', { action: 'pause' })).status).toBe(404);
    expect((await bob(`/schedules/jobs/${jobId}`)).status).toBe(404);
    expect((await bob(`/schedules/jobs/${jobId}/run`, 'POST', {})).status).toBe(404);
    expect((await bob(`/schedules/jobs/${jobId}/code`)).status).toBe(404);
    // Operators: everyone's counts, never someone else's schedules.
    const ops = await olga<SchedulesState>('/schedules');
    expect(ops.body.schedules).toEqual([]);
    expect(ops.body.counts).toMatchObject({
        schedules: { scheduled: 1 },
        jobs: 1,
    });
    expect(JSON.stringify(ops.body)).not.toContain('Alice digest');
    // The owner pauses and resumes, runs a job and reads its run.
    expect(
        (
            await alice<ScheduleView>(`/schedules/${id}/actions`, 'POST', {
                action: 'pause',
            })
        ).body.status,
    ).toBe('paused');
    const started = await alice<JobRunView>(`/schedules/jobs/${jobId}/run`, 'POST', {});
    expect(started.body).toMatchObject({ trigger: 'manual' });
    await waitRun(f, started.body.id);
    const detail = await alice<JobDetail>(`/schedules/jobs/${jobId}`);
    expect(detail.body.runs[0]).toMatchObject({ status: 'succeeded' });
    expect((await alice<JobRunView>(`/schedules/runs/${started.body.id}`)).body.stdout).toBe('ok\n');
    expect((await bob(`/schedules/runs/${started.body.id}`)).status).toBe(404);
});

it('shows a schedule in full to its owner only: the cadence in words, next runs, policies and runs, paged (CB-88)', async () => {
    const f = await fixture();
    await f.bypass('schedule.create');
    await f.tool('schedule_create')({
        title: 'Weekday digest',
        cadence: '0 9 * * 1-5',
        timezone: 'Europe/Paris',
        action: { kind: 'turn', prompt: '## Digest\n\n- **Mail**\n- Calendar' },
    });
    const [schedule] = await f.platform.schedules.list('alice');
    const start = Date.now() - 3_600_000;
    for (let i = 0; i < 12; i++) {
        await f.store.action(schedule.id, 'run');
        const claim = (await f.store.claim(start + i * 60_000))!;
        await f.store.finish(
            claim,
            {
                text: i === 11 ? `**Run ${i}**: ${'all quiet. '.repeat(20)}` : `**Run ${i}**: all quiet.`,
                sources: [],
                sample: false,
            },
            start + i * 60_000 + 5_000,
        );
    }
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const detail = await alice<ScheduleDetail>(`/schedules/${schedule.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.schedule).toMatchObject({
        id: schedule.id,
        prompt: '## Digest\n\n- **Mail**\n- Calendar',
        timezone: 'Europe/Paris',
    });
    expect(detail.body.cadenceText).toBe('Every weekday at 09:00');
    // The next three, on weekdays at 09:00 in Paris, soonest first.
    expect(detail.body.upcoming).toHaveLength(3);
    for (const at of detail.body.upcoming) {
        const wall = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Paris',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
        }).format(at);
        expect(wall).toMatch(/^(Mon|Tue|Wed|Thu|Fri) 09:00$/);
    }
    expect([...detail.body.upcoming].sort()).toEqual(detail.body.upcoming);
    // What its runs may do without asking: the Dot's bypassed capability.
    expect(detail.body.approvals).toEqual([
        {
            capability: 'schedule.create',
            label: 'Create a schedule',
            policy: 'bypass',
        },
    ]);
    expect(detail.body.goal).toBeNull();
    // Newest first, a page at a time, each with the start of its answer.
    expect(detail.body.runs).toHaveLength(10);
    expect(detail.body.moreRuns).toBe(true);
    expect(detail.body.runs[0]!.summary!.length).toBeLessThanOrEqual(151);
    expect(detail.body.runs[0]).toMatchObject({
        status: 'completed',
        // Cut at 150 characters, and marked so.
        summary: expect.stringMatching(/^Run 11: all quiet\. .{100,}…$/),
        board: [],
    });
    const older = await alice<ScheduleRunsPage>(`/schedules/${schedule.id}/runs?before=${detail.body.runs.at(-1)!.id}`);
    expect(older.body.runs.map((run) => run.summary)).toEqual(['Run 1: all quiet.', 'Run 0: all quiet.']);
    expect(older.body.more).toBe(false);
    expect((await alice(`/schedules/${schedule.id}/runs?before=nope`)).status).toBe(404);
    // Nobody else's: not found, runs included.
    expect((await bob(`/schedules/${schedule.id}`)).status).toBe(404);
    expect((await bob(`/schedules/${schedule.id}/runs?before=${detail.body.runs[0]!.id}`)).status).toBe(404);
});

it('lists schedules and jobs in capabilities, with limits and usage', async () => {
    const f = await fixture();
    await f.saveJob();
    const result = (await f.tool('capabilities')({})) as {
        capabilities: Array<{
            id: string;
            enabled: boolean;
            tools: string[];
            limits?: Record<string, unknown>;
            usage?: Record<string, unknown>;
            approvals?: Array<{ capability: string; policy: string }>;
        }>;
    };
    const schedules = result.capabilities.find((item) => item.id === 'schedules');
    const jobs = result.capabilities.find((item) => item.id === 'jobs');
    expect(schedules).toMatchObject({
        enabled: true,
        limits: { minIntervalMinutes: 15, maxActiveSchedulesPerUser: 20 },
        approvals: [{ capability: 'schedule.create', policy: 'manual' }],
    });
    expect(jobs).toMatchObject({
        enabled: true,
        limits: { maxTimeoutSeconds: 900, computerWakeSeconds: 90 },
        usage: { yours: 1 },
        approvals: [{ capability: 'job.save', policy: 'bypass' }],
    });
});

it('lets a person comment on their own goal only (CB-135)', async () => {
    const f = await fixture();
    await f.bypass('goal.set');
    await f.tool('goal_set')({
        title: 'Keep the onboarding doc current',
        cadence: 'every day at 09:00',
    });
    const [goal] = await f.platform.goals.list('alice');
    const path = `/schedules/goals/${goal!.id}/comments`;
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    // Another person's goal is not found, and nothing is added.
    expect((await bob(path, 'POST', { body: 'Mine now.' })).status).toBe(404);
    expect((await alice(path, 'POST', { body: '   ' })).status).toBe(400);
    expect((await alice(path, 'POST', { body: 'x', extra: 1 })).status).toBe(400);
    const added = await alice<{
        comments: Array<{ author: string; body: string }>;
    }>(path, 'POST', { body: ' Also cover security training. ' });
    expect(added.status).toBe(200);
    expect(added.body.comments).toMatchObject([{ author: 'person', body: 'Also cover security training.' }]);
    // Her schedules list carries it; his does not carry her goal.
    const listed = await alice<{ goals: Array<{ comments: unknown[] }> }>('/schedules');
    expect(listed.body.goals[0]!.comments).toHaveLength(1);
    expect((await bob<{ goals: unknown[] }>('/schedules')).body.goals).toEqual([]);
});

it('a job on a company computer reaches shared data instead of private owner grants (CB-226)', async () => {
    const f = await fixture();
    const privateData = f.platform.data.createDataset('alice', {
        name: 'Private payroll',
    });
    f.platform.data.setGrant('alice', {
        dotId: f.dot.id,
        datasetId: privateData.id,
        access: 'write',
    });
    const jobId = await f.saveJob({ 'main.sh': MAIN }, { datasets: ['Private payroll'] });
    let denied = 0;
    let reach: string | undefined;
    f.computer.behavior = async ({ env }) => {
        reach = f.platform.data.tokens.resolve(env.CB_DATA_TOKEN)?.reach;
        denied = (
            await f.app.request(`http://company-brain-app:4310/api/data/datasets/${privateData.id}`, {
                headers: { Authorization: `Bearer ${env.CB_DATA_TOKEN}` },
            })
        ).status;
        return { stdout: 'safe', stderr: '', code: 0 };
    };
    const run = (await f.tool('job_run')({ jobId })) as unknown as JobRunView;
    expect(run.status).toBe('succeeded');
    expect(reach).toBe('socio');
    expect(denied).toBe(404);
    expect(f.platform.data.tokens.resolve(f.computer.launches[0].env.CB_DATA_TOKEN)).toBeUndefined();
});

it('recovers an expired job without another runtime, suppressing stale listeners and revoking its token', async () => {
    let now = 1000;
    const runtime = new RuntimeSession({
        heartbeat: false,
        leaseMs: 100,
        now: () => now,
    });
    const f = await fixture({ runtime, jobs: { syncMaxSeconds: 0 } });
    const jobId = await f.saveJob();
    f.computer.running = true;
    f.computer.behavior = ({ killed }) => killed.then(() => ({ stdout: 'stopped' }));
    const seen = vi.fn();
    f.platform.jobs.onRunEnded(seen);
    const run = await f.platform.jobs.start('alice', jobId, {
        trigger: 'manual',
    });
    await vi.waitFor(() => expect(f.computer.launches).toHaveLength(1));
    const token = f.computer.launches[0].env.CB_DATA_TOKEN;
    expect(f.platform.data.tokens.resolve(token)).toBeDefined();
    now += 101;
    const ended = await waitRun(f, run.id);
    expect(ended.status).toBe('interrupted');
    expect(ended.error).toContain('server restarted');
    await vi.waitFor(() => expect(f.platform.jobs.running).toBe(0));
    expect(seen).not.toHaveBeenCalled();
    expect(f.platform.data.tokens.resolve(token)).toBeUndefined();
});
