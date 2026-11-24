import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';
import type { JobDetail, LongRunView, SchedulesState } from '@socio/shared/schedule-types';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import type { JobSettings } from '../src/server/schedules/contract.js';
import { COMPUTER_STOPPED_JOB_RUN } from '../src/server/schedules/jobs.js';

import { FakeComputer, SUPERVISOR } from './fixtures/fake-computer.js';
import { completion } from './fixtures/model-stream.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

/**
 * Jobs that run until done (CB-122): long runs the server works through in
 * batches, from a checkpoint and per-item claims, across stops, refusals
 * and restarts. The Dot's computer is the fake one; every batch reaches the
 * checkpoint API with its own run's data token, as a real job would.
 */

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
vi.setConfig({ testTimeout: 20_000 });

const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'alice', name: 'Alice', role: 'member' },
];
const SECRET = 'secret-0123456789abcdef-xyz';
const API = 'http://company-brain-app:4310';

async function fixture(jobs: Partial<JobSettings> = {}) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'cb-long-runs-'));
    // The connections outlive each runtime: a restart boots over the same data.
    const database = { store: testDatabase(), workspace: testDatabase() };
    cleanup.unshift(() => {
        database.store.close();
        database.workspace.close();
        rmSync(dir, { recursive: true, force: true });
    });
    // Mocked before the runtime is built, as what it builds may keep `fetch`.
    // The fake computer is the first Dot's, known once the runtime is.
    let computer: FakeComputer | undefined;
    const model: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const answer = computer?.handle(url, init ?? undefined);
        if (answer) {
            return answer;
        }
        if (url.startsWith('https://model.invalid/')) {
            model.push(String(init?.body));
            return String(init?.body).includes('Write a short title')
                ? Response.json({ choices: [{ message: { content: 'Title' } }] })
                : completion({ role: 'assistant', content: 'All 10 are in.' });
        }
        throw new Error(`Unexpected request to ${url}`);
    });
    const config: Partial<PlatformConfig> = {
        baseUrl: 'https://model.invalid/v1',
        apiKey: 'unused',
        model: 'qwen-test',
        sessionSecret: SECRET,
        computerSupervisorUrl: SUPERVISOR,
        computerSupervisorToken: 'supervisor-secret',
        computerToken: 'master-secret',
        data: { userDataDir: dir, apiUrl: API },
        jobs: {
            pollMs: 10,
            graceMs: 50,
            retryBaseMs: 20,
            refusalWaitMs: 300,
            ...jobs,
        },
    };
    const boot = async () => {
        const { platform, app, dispose } = await makeTestRuntime({
            database,
            config,
            app: {
                config: { mode: 'live', baseUrl: '' },
                auth: {
                    provider: new MockAuthProvider(USERS, SECRET),
                    secureCookies: false,
                },
            },
        });
        cleanup.push(dispose);
        return { platform, app };
    };
    const first = await boot();
    const { store, workspace } = first.platform;
    const dot = workspace.dots()[0];
    const fake = new FakeComputer(dot.id);
    computer = fake;
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    await workspace.computers.patch(dot.id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    const thread = workspace.bindThread('origin', dot.id, 'Chat', 'alice');
    const f = {
        ...first,
        store,
        workspace,
        dot,
        computer: fake,
        model,
        thread,
        boot,
        /** Simulate the old process going away without gracefully finishing rows. */
        async crash() {
            f.platform.longRuns.stop();
            f.platform.longRunReports.stop();
            await f.platform.runner.runtime.detach(workspace.db);
            f.platform.runner.close();
        },
        /** A tool of the Dot's turn in its chat with Alice. */
        tool(name: string) {
            const turn: DotTurn = {
                dot: workspace.dot(dot.id)!,
                userId: 'alice',
                threadId: thread.id,
                channel: false,
                purpose: 'chat',
                check: () => {},
                signal: new AbortController().signal,
                toolNames: () => [],
            };
            const found = f.platform.dotExtensions.tools(turn).find((item) => item.name === name) as
                | (ToolDefinition & { execute: (input: unknown) => Promise<unknown> })
                | undefined;
            if (!found) {
                throw new Error(`No tool ${name}`);
            }
            return (input: unknown) => found.execute(input) as Promise<Record<string, unknown>>;
        },
        /** Saves a job under bypass and returns its id. */
        async saveJob(extra: Record<string, unknown> = {}) {
            await f.platform.approvals.setPolicy('alice', dot.id, 'job.save', 'bypass');
            const result = await f.tool('job_save')({
                name: 'Collect listings',
                entry: 'main.sh',
                files: { 'main.sh': 'true\n' },
                timeoutSeconds: 30,
                untilDone: true,
                ...extra,
            });
            if (result.status !== 'saved') {
                throw new Error(JSON.stringify(result));
            }
            return String(result.jobId);
        },
        /** The job's long run once `done` holds. */
        async until(jobId: string, done: (view: LongRunView | null) => boolean): Promise<LongRunView> {
            let view: LongRunView | null = null;
            await vi.waitFor(
                async () => {
                    view = await f.platform.longRuns.status('alice', jobId);
                    expect(done(view)).toBe(true);
                },
                { timeout: 10_000, interval: 10 },
            );
            return view!;
        },
        /** Signs in through the mock provider. */
        async as(userId: string) {
            const login = await f.app.request('/api/auth/mock/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            const cookie = login.headers.get('set-cookie')!.split(';')[0];
            return async <T = unknown>(path: string, method = 'GET') => {
                const response = await f.app.request(`/api${path}`, {
                    method,
                    headers: {
                        cookie,
                        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                    },
                    ...(method === 'GET' ? {} : { body: '{}' }),
                });
                return {
                    status: response.status,
                    body: (await response.json()) as T,
                };
            };
        },
    };
    return f;
}

/** A batch's calls, with its own run's token: the data API and the checkpoint API. */
function client(
    app: {
        request: (url: string, init?: RequestInit) => Response | Promise<Response>;
    },
    env: Record<string, string>,
) {
    const call = async (url: string, body?: unknown) => {
        const response = await app.request(url, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                Authorization: `Bearer ${env.CB_DATA_TOKEN}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        // oxlint-disable-next-line typescript/no-explicit-any -- test JSON
        return { status: response.status, body: (await response.json()) as any };
    };
    return {
        job: (path: string, body?: unknown) => call(`${env.CB_JOB_API}${path}`, body),
        data: (path: string, body?: unknown) => call(`${env.CB_DATA_URL}${path}`, body),
    };
}
const LISTINGS = {
    table: 'listings',
    columns: [
        { name: 'id', primaryKey: true },
        { name: 'price', type: 'INTEGER' },
    ],
    ifNotExists: true,
};
const write = (key: string) => ({
    dataset: 'scratch',
    table: 'listings',
    rows: [{ id: key, price: 100 }],
    key: ['id'],
});
const items = (f: Awaited<ReturnType<typeof fixture>>, longRunId: string) =>
    Object.fromEntries(
        f.workspace.db
            .prepare('SELECT key, attempts FROM job_items WHERE longRunId=?')
            .all(longRunId)
            .map((row) => [row.key, row.attempts]),
    );

it('runs a job until done in batches: a batch the computer stopped resumes from its checkpoint, each item done once, no duplicate rows', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    const keys = Array.from({ length: 10 }, (_, i) => `listing-${i + 1}`);
    const done: string[] = [];
    const checkpoints: unknown[] = [];
    let batch = 0;
    f.computer.behavior = async ({ env }) => {
        const b = ++batch;
        const { job, data } = client(f.app, env);
        const state = (await job('')).body;
        checkpoints.push(state.checkpoint);
        if (!state.checkpoint) {
            expect((await data('/datasets/scratch/tables', LISTINGS)).status).toBe(200);
            await job('/items', { keys, complete: true });
            await job('/checkpoint', { value: { listed: true } });
        }
        for (;;) {
            const { items } = (await job('/claim', { limit: 3 })).body;
            if (!items.length) {
                break;
            }
            for (const key of items as string[]) {
                if (b === 1 && key === 'listing-5') {
                    // Written, then the computer stops before the item is marked done.
                    await data('/datasets/scratch/tables/listings/rows', {
                        rows: [{ id: key, price: 100 }],
                        key: ['id'],
                    });
                    f.computer.running = false;
                    return { code: 143 };
                }
                const marked = await job('/done', { key, write: write(key) });
                expect(marked.body).toEqual({ done: true });
                done.push(key);
            }
        }
        return { stdout: `batch ${b}\n`, code: 0 };
    };
    // Where it stands after each batch that goes on (Telegram, CB-145).
    const progress: LongRunView[] = [];
    f.platform.longRuns.onProgress((_row, view) => progress.push(view));
    const started = await f.tool('job_run')({ jobId });
    expect(started).toMatchObject({
        status: 'started',
        longRun: { jobId, trigger: 'dot' },
    });
    // Asked again while it runs: the same long run, not a second one.
    expect(await f.tool('job_run')({ jobId })).toMatchObject({
        status: 'already_running',
        longRun: { id: (started.longRun as LongRunView).id },
    });
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(view).toMatchObject({
        status: 'done',
        batches: 2,
        listComplete: true,
        items: { total: 10, done: 10, remaining: 0, failed: 0, inProgress: 0 },
        retries: 0,
        deadLetters: [],
        checkpoint: '{"listed":true}',
    });
    expect(view.outcome).toMatch(/^“Collect listings” is done: 10 of 10 items done, in 2 batches over/);
    // The second batch started from the first's checkpoint.
    expect(checkpoints).toEqual([null, { listed: true }]);
    // The first batch's end was progress; the last one's end is the finish.
    expect(progress.map((run) => run.items.done)).toEqual([4]);
    // Every item marked done exactly once, the interrupted one by batch 2.
    expect([...done].sort()).toEqual([...keys].sort());
    // The interrupted try didn't count against listing-5 or listing-6.
    expect(items(f, view.id)).toMatchObject({ 'listing-5': 1, 'listing-6': 1 });
    // listing-5 was written twice, once: the upsert left no duplicate.
    const token = f.platform.data.tokens.issue({
        userId: 'alice',
        dotId: f.dot.id,
        purpose: 'computer',
        reach: 'socio',
        session: 'check',
    });
    const rows = await client(f.app, {
        CB_DATA_TOKEN: token,
        CB_DATA_URL: `${API}/api/data`,
    }).data('/datasets/scratch/query', {
        sql: 'SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS ids FROM listings',
    });
    expect(rows.body.rows).toEqual([[10, 10]]);
    // The batches are the job's runs, the first stopped with the computer.
    const detail = await f.platform.jobs.detail('alice', jobId);
    expect(detail.runs.map((run) => [run.status, run.longRunId, run.error])).toEqual([
        ['succeeded', view.id, null],
        ['interrupted', view.id, COMPUTER_STOPPED_JOB_RUN],
    ]);
    // The Dot tells the chat that started it, from a hidden note.
    await vi.waitFor(() => expect(f.model.some((body) => body.includes('Job finished.'))).toBe(true));
    const note = f.model.find((body) => body.includes('Job finished.'))!;
    expect(note).toContain('is done: 10 of 10 items done');
    await vi.waitFor(async () =>
        expect(
            f.workspace.db.prepare('SELECT reportedAt FROM job_long_runs WHERE id=?').get(view.id)?.reportedAt,
        ).toBeTypeOf('number'),
    );
});

it('sets a bad item aside, after its tries, and finishes the rest; a crash charges only the item it was on', async () => {
    const f = await fixture({ itemAttempts: 2 });
    const jobId = await f.saveJob();
    f.computer.behavior = async ({ env }) => {
        const { job } = client(f.app, env);
        await job('/items', {
            keys: ['a', 'bad', 'b', 'crash', 'c'],
            complete: true,
        });
        for (;;) {
            const { items } = (await job('/claim', { limit: 10 })).body;
            if (!items.length) {
                break;
            }
            for (const key of items as string[]) {
                if (key === 'bad') {
                    await job('/fail', { key, error: 'Unexpected detail schema' });
                } else if (key === 'crash') {
                    return { stderr: 'TypeError: x is undefined\n', code: 1 };
                } else {
                    await job('/done', { key });
                }
            }
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(view.items).toEqual({
        total: 5,
        done: 3,
        remaining: 0,
        inProgress: 0,
        failed: 2,
    });
    expect(view.deadLetters.map((item) => [item.key, item.attempts]).sort()).toEqual([
        ['bad', 2],
        ['crash', 2],
    ]);
    expect(view.deadLetters.find((item) => item.key === 'bad')?.error).toBe('Unexpected detail schema');
    expect(view.deadLetters.find((item) => item.key === 'crash')?.error).toMatch(
        /^Its batch ended \(failed\) before it was done: Exited with code 1\./,
    );
    // c was claimed with crash each time but never reached: no try charged.
    expect(items(f, view.id).c).toBe(1);
    expect(view.outcome).toContain('3 of 5 items done, 2 set aside as failed');
});

it.each([
    [
        '/fail 429',
        3,
        (job: ReturnType<typeof client>['job'], items: string[]) =>
            job('/fail', { key: items[0], error: 'Too Many Requests', status: 429 }),
    ],
    [
        '/pause',
        2,
        (job: ReturnType<typeof client>['job']) =>
            job('/pause', { reason: 'Forbidden', status: 403, retryAfterSeconds: 0 }),
    ],
])('a batch that exits nonzero after a refusal (%s) charges no item a try', async (_name, itemAttempts, refuse) => {
    const f = await fixture({ itemAttempts, batchRetries: 10 });
    const jobId = await f.saveJob();
    let batch = 0;
    f.computer.behavior = async ({ env }) => {
        const b = ++batch;
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a', 'b', 'c', 'd'], complete: true });
        const { items } = (await job('/claim', { limit: 4 })).body;
        if (b <= itemAttempts) {
            await refuse(job, items);
            return { stderr: 'Error: refused\n', code: 1 };
        }
        for (const key of items as string[]) {
            await job('/done', { key });
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(view.items).toMatchObject({ total: 4, done: 4, failed: 0 });
    expect(view.outcome).not.toContain('not all of it');
});

it('pauses on a 429 without charging the item, waits, then resumes; a source that keeps refusing ends it as failed', async () => {
    const f = await fixture({ batchRetries: 1 });
    const jobId = await f.saveJob();
    const times: number[] = [];
    let batch = 0;
    f.computer.behavior = async ({ env }) => {
        const b = ++batch;
        times.push(Date.now());
        const { job } = client(f.app, env);
        await job('/items', { keys: ['x', 'y'], complete: true });
        const { items } = (await job('/claim', { limit: 1 })).body;
        if (b === 1) {
            const refused = await job('/fail', {
                key: items[0],
                error: 'Too Many Requests',
                status: 429,
            });
            expect(refused.body).toMatchObject({ item: 'pending', paused: true });
            // While it waits, nothing more is handed out: the batch stops.
            expect((await job('/claim', { limit: 5 })).body).toMatchObject({
                items: [],
                stop: 'waiting',
            });
            return { code: 0 };
        }
        for (const key of [items, (await job('/claim', { limit: 5 })).body.items].flat().filter(Boolean)) {
            await job('/done', { key });
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const waiting = await f.until(jobId, (run) => run?.status === 'waiting' && run.batches === 1 && !!run.nextAt);
    expect(waiting.waitReason).toMatch(/^The source refused \(HTTP 429\): Too Many Requests\. Waiting until /);
    expect(waiting.items.remaining).toBe(2);
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(view).toMatchObject({ batches: 2, items: { done: 2, failed: 0 } });
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(250);
    // The refused try didn't count.
    expect(items(f, view.id)).toEqual({ x: 1, y: 1 });

    // Refused every time, with no progress: after the retries, it fails.
    const stubborn = await f.saveJob({ name: 'Stubborn' });
    f.computer.behavior = async ({ env }) => {
        const { job } = client(f.app, env);
        await job('/items', { keys: ['z'], complete: true });
        const { items } = (await job('/claim', { limit: 1 })).body;
        if (items.length) {
            await job('/pause', {
                reason: 'Forbidden',
                status: 403,
                retryAfterSeconds: 0,
            });
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', stubborn, { trigger: 'manual' });
    const failed = await f.until(stubborn, (run) => run?.status === 'failed');
    expect(failed.outcome).toMatch(
        /^“Stubborn” stopped before it was done: 2 batches in a row were refused\. The source refused \(HTTP 403\): Forbidden\. 0 of 1 item done, 1 left, after 3 batches over/,
    );
    expect(failed.items).toMatchObject({ total: 1, done: 0, remaining: 1 });
});

it('fails a job that never says it is complete after its retries, instead of running forever', async () => {
    const f = await fixture({ batchRetries: 2 });
    const jobId = await f.saveJob();
    let batches = 0;
    f.computer.behavior = () => {
        batches++;
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'failed');
    // The first batch, then two retries, then the third in a row ends it.
    expect(batches).toBe(3);
    expect(view.outcome).toContain(
        '3 batches in a row made no progress. The job must declare its whole list of items or say it is complete.',
    );

    // Saving the same checkpoint again each batch isn't progress either.
    const stuck = await f.saveJob({ name: 'Stuck' });
    batches = 0;
    f.computer.behavior = async ({ env }) => {
        batches++;
        await client(f.app, env).job('/checkpoint', { value: { page: 1 } });
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', stuck, { trigger: 'manual' });
    const same = await f.until(stuck, (run) => run?.status === 'failed');
    // The first checkpoint moved it; three batches in a row after it didn't.
    expect(batches).toBe(4);
    expect(same.outcome).toContain('3 batches in a row made no progress.');
});

it('fails a job that crashes every batch after its retries, waiting longer each time, instead of setting good items aside one by one', async () => {
    const f = await fixture({
        itemAttempts: 2,
        batchRetries: 2,
        maxBatches: 30,
        retryBaseMs: 60,
    });
    const jobId = await f.saveJob();
    const keys = Array.from({ length: 20 }, (_, i) => `listing-${i + 1}`);
    const times: number[] = [];
    f.computer.behavior = async ({ env }) => {
        times.push(Date.now());
        const { job } = client(f.app, env);
        await job('/items', { keys, complete: true });
        // Takes ten, then a regression crashes it on the first.
        expect((await job('/claim', { limit: 10 })).body.items).toHaveLength(10);
        return { stderr: 'KeyError: price\n', code: 1 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'failed');
    // The first batch, then two retries, then the third in a row ends it.
    expect(view.batches).toBe(3);
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(60);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(120);
    expect(view.outcome).toContain('3 batches in a row failed without progress; the last: Exited with code 1.');
    // At most the item it kept crashing on was set aside, not the list.
    expect(view.items.done).toBe(0);
    expect(view.items.failed).toBeLessThanOrEqual(1);
    expect(view.items.remaining).toBeGreaterThanOrEqual(19);
});

it('makes the item a crash was charged for wait before it is tried again', async () => {
    const f = await fixture({ retryBaseMs: 300 });
    const jobId = await f.saveJob();
    const times: number[] = [];
    f.computer.behavior = async ({ env }) => {
        times.push(Date.now());
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a', 'crash'], complete: true });
        for (;;) {
            const { items } = (await job('/claim', { limit: 5 })).body;
            if (!items.length) {
                break;
            }
            for (const key of items as string[]) {
                if (key === 'crash' && times.length === 1) {
                    return { code: 1 };
                }
                await job('/done', { key });
            }
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(view).toMatchObject({ batches: 2, items: { done: 2, failed: 0 } });
    // The first batch got a done (no retry), but crash waited its backoff.
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(300);
    expect(items(f, view.id).crash).toBe(2);
});

it('fails a job that crashes every batch after its retries even when its checkpoint changes each batch', async () => {
    const f = await fixture({
        itemAttempts: 2,
        batchRetries: 2,
        maxBatches: 15,
        retryBaseMs: 30,
    });
    const jobId = await f.saveJob();
    const keys = Array.from({ length: 20 }, (_, i) => `listing-${i + 1}`);
    let batches = 0;
    f.computer.behavior = async ({ env }) => {
        const n = ++batches;
        const { job } = client(f.app, env);
        await job('/items', { keys, complete: true });
        // A checkpoint that is new every batch, with no real progress.
        await job('/checkpoint', { value: { batch: n, at: Date.now() } });
        expect((await job('/claim', { limit: 10 })).body.items).toHaveLength(10);
        return { code: 1 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'failed');
    expect(batches).toBe(3);
    expect(view.outcome).toContain('3 batches in a row failed without progress');
    expect(view.items).toMatchObject({ done: 0, failed: 1, remaining: 19 });
});

it('counts a crashed batch that held no item by its checkpoint and the items it failed itself', async () => {
    const f = await fixture({ itemAttempts: 5, batchRetries: 1 });
    // Listing pages, it crashes once between them, holding nothing.
    const listing = await f.saveJob();
    let pages = 0;
    f.computer.behavior = async ({ env }) => {
        const { job } = client(f.app, env);
        const page = ((await job('')).body.checkpoint as { page?: number } | null)?.page ?? 0;
        pages++;
        if (page < 3) {
            await job('/items', { keys: [`p${page}`] });
            await job('/checkpoint', { value: { page: page + 1 } });
            return { code: 1 };
        }
        await job('/items', { keys: [], complete: true });
        for (const key of (await job('/claim', { limit: 5 })).body.items as string[]) {
            await job('/done', { key });
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', listing, { trigger: 'manual' });
    const listed = await f.until(listing, (run) => run?.status === 'done');
    expect(pages).toBe(4);
    expect(listed.items).toMatchObject({ total: 3, done: 3 });

    // Fails a bad item itself, then exits nonzero because something failed.
    const strict = await f.saveJob({ name: 'Strict' });
    f.computer.behavior = async ({ env }) => {
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a', 'b', 'c', 'd', 'bad'], complete: true });
        let failed = false;
        for (const key of (await job('/claim', { limit: 5 })).body.items as string[]) {
            if (key === 'bad') {
                await job('/fail', { key, error: 'Unexpected detail schema' });
                failed = true;
            } else {
                await job('/done', { key });
            }
        }
        return { code: failed ? 1 : 0 };
    };
    await f.platform.longRuns.startJob('alice', strict, { trigger: 'manual' });
    const view = await f.until(strict, (run) => !!run?.finishedAt);
    // Each try of the bad item was progress, up to its last.
    expect(view).toMatchObject({
        status: 'done',
        batches: 5,
        items: { done: 4, failed: 1 },
    });
});

it('waits for the next item due before a retry, so the retry finds work', async () => {
    const f = await fixture({
        itemAttempts: 5,
        batchRetries: 1,
        retryBaseMs: 50,
    });
    const jobId = await f.saveJob();
    let batches = 0;
    f.computer.behavior = async ({ env }) => {
        const n = ++batches;
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a'], complete: true });
        const { items } = (await job('/claim', { limit: 1 })).body;
        if (!items.length) {
            return { code: 0 };
        }
        // Two tries fail, the third crashes; the item then waits 4 × 50 ms.
        if (n < 3) {
            await job('/fail', { key: 'a', error: 'Flaky' });
        } else if (n === 3) {
            return { code: 1 };
        } else {
            await job('/done', { key: 'a' });
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => !!run?.finishedAt);
    // Not a fourth batch at 50 ms that finds nothing and costs the last retry.
    expect(view).toMatchObject({
        status: 'done',
        batches: 4,
        items: { done: 1 },
    });
});

it('keeps a refusal’s wait when its batch is then stopped from outside', async () => {
    const f = await fixture({ refusalWaitMs: 400 });
    const jobId = await f.saveJob();
    const times: number[] = [];
    f.computer.behavior = async ({ env }) => {
        times.push(Date.now());
        const { job } = client(f.app, env);
        await job('/items', { keys: ['x'], complete: true });
        const { items } = (await job('/claim', { limit: 1 })).body;
        if (times.length === 1) {
            await job('/fail', {
                key: items[0],
                error: 'Too Many Requests',
                status: 429,
            });
            f.computer.running = false;
            return { code: 143 };
        }
        await job('/done', { key: items[0] });
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const waiting = await f.until(
        jobId,
        (run) => run?.status === 'done' || (run?.status === 'waiting' && run.batches === 1 && !!run.nextAt),
    );
    expect(waiting.status).toBe('waiting');
    expect(waiting.waitReason).toMatch(/^The source refused \(HTTP 429\)/);
    await f.until(jobId, (run) => run?.status === 'done');
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(350);
});

it('ends as failed when its items were mostly set aside, and says when it was done with failures', async () => {
    const f = await fixture({ itemAttempts: 1 });
    const notify = vi.spyOn(f.platform.notifications, 'notify');
    const failing = await f.saveJob();
    const partly = await f.saveJob({ name: 'Partly' });
    const fails = new Set(['p3', 'x1', 'x2', 'x3']);
    f.computer.behavior = async ({ env }) => {
        const { job } = client(f.app, env);
        const keys = env.CB_JOB_ID === failing ? ['x1', 'x2', 'x3'] : ['p1', 'p2', 'p3'];
        await job('/items', { keys, complete: true });
        for (const key of (await job('/claim', { limit: 5 })).body.items as string[]) {
            if (fails.has(key)) {
                await job('/fail', { key, error: 'Unexpected detail schema' });
            } else {
                await job('/done', { key });
            }
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', failing, { trigger: 'manual' });
    const failed = await f.until(failing, (run) => run?.status === 'failed');
    expect(failed.outcome).toMatch(
        /^“Collect listings” failed: None of its items could be done; each was set aside as failed\. 0 of 3 items done, 3 set aside as failed, after 1 batch over/,
    );
    await f.platform.longRuns.startJob('alice', partly, { trigger: 'manual' });
    const done = await f.until(partly, (run) => run?.status === 'done');
    expect(done.outcome).toMatch(
        /^“Partly” is done, but not all of it: 2 of 3 items done, 1 set aside as failed, in 1 batch over/,
    );
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify.mock.calls.map(([input]) => input.title)).toEqual(['Job failed', 'Job done, with failures']);
});

it('ends as done when as many items were done as set aside, and as failed with one more set aside', async () => {
    const f = await fixture({ itemAttempts: 1 });
    const even = await f.saveJob({ name: 'Even' });
    const worse = await f.saveJob({ name: 'Worse' });
    f.computer.behavior = async ({ env }) => {
        const { job } = client(f.app, env);
        const keys = env.CB_JOB_ID === even ? ['ok', 'x1'] : ['ok', 'x1', 'x2'];
        await job('/items', { keys, complete: true });
        for (const key of (await job('/claim', { limit: 5 })).body.items as string[]) {
            if (key === 'ok') {
                await job('/done', { key });
            } else {
                await job('/fail', { key, error: 'Unexpected detail schema' });
            }
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', even, { trigger: 'manual' });
    const done = await f.until(even, (run) => !!run?.finishedAt);
    expect(done).toMatchObject({ status: 'done', items: { done: 1, failed: 1 } });
    await f.platform.longRuns.startJob('alice', worse, { trigger: 'manual' });
    const failed = await f.until(worse, (run) => !!run?.finishedAt);
    expect(failed).toMatchObject({
        status: 'failed',
        items: { done: 1, failed: 2 },
    });
    expect(failed.outcome).toContain('More of its items were set aside as failed than done.');
});

it('resumes a batch the computer stopped before it got anywhere after a wait, without counting it as a retry', async () => {
    const f = await fixture({ retryBaseMs: 300 });
    const jobId = await f.saveJob();
    const times: number[] = [];
    f.computer.behavior = async ({ env }) => {
        times.push(Date.now());
        if (times.length === 1) {
            f.computer.running = false;
            return { code: 143 };
        }
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a'], complete: true });
        for (const key of (await job('/claim', { limit: 5 })).body.items as string[]) {
            await job('/done', { key });
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const waiting = await f.until(jobId, (run) => run?.status === 'waiting' && run.batches === 1 && !!run.nextAt);
    expect(waiting.retries).toBe(0);
    expect(waiting.waitReason).toMatch(/^Resuming from its checkpoint at .*: The computer stopped during this run\.$/);
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(view).toMatchObject({ batches: 2, retries: 0 });
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(300);
});

it('picks up an unfinished long run after a restart, from its checkpoint and items', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    let app = f.app;
    const done: string[] = [];
    let batch = 0;
    f.computer.behavior = async ({ env, killed }) => {
        const b = ++batch;
        const { job } = client(app, env);
        await job('/items', {
            keys: ['1', '2', '3', '4', '5', '6'],
            complete: true,
        });
        for (;;) {
            const { items } = (await job('/claim', { limit: 2 })).body;
            if (!items.length) {
                break;
            }
            for (const key of items as string[]) {
                // The server goes away while batch 1 is on item 3.
                if (b === 1 && key === '3') {
                    await killed;
                    return { code: 143 };
                }
                await job('/done', { key });
                done.push(key);
            }
            await job('/checkpoint', { value: { after: items.at(-1) } });
        }
        return { code: 0 };
    };
    const { longRun } = await f.platform.longRuns.startJob('alice', jobId, {
        trigger: 'manual',
    });
    const first = await f.until(jobId, (run) => run?.status === 'running' && run.items.done === 2);
    expect(first.items).toMatchObject({ inProgress: 2, remaining: 4 });
    // A new process starts on the same database while the old one is gone
    // (as after a crash or a deploy): the batch it was running is
    // interrupted, its claims go back, and the long run carries on.
    await f.crash();
    const next = await f.boot();
    f.platform = next.platform;
    app = next.app;
    expect((await f.platform.jobs.run('alice', first.currentRunId!)).error).toContain(
        'The server restarted during this run',
    );
    await f.platform.longRuns.resume();
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(view).toMatchObject({
        id: longRun!.id,
        batches: 2,
        items: { total: 6, done: 6, failed: 0 },
        checkpoint: '{"after":"6"}',
    });
    expect([...done].sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    // Claimed when the server went away: their tries didn't count.
    expect(items(f, view.id)).toEqual({
        1: 1,
        2: 1,
        3: 1,
        4: 1,
        5: 1,
        6: 1,
    });
});

it('keeps a refusal’s wait across a restart', async () => {
    const f = await fixture({ refusalWaitMs: 400 });
    const jobId = await f.saveJob();
    let app = f.app;
    const times: number[] = [];
    f.computer.behavior = async ({ env, killed }) => {
        times.push(Date.now());
        const { job } = client(app, env);
        await job('/items', { keys: ['x'], complete: true });
        const { items } = (await job('/claim', { limit: 1 })).body;
        if (times.length === 1) {
            await job('/fail', {
                key: items[0],
                error: 'Too Many Requests',
                status: 429,
            });
            // The server goes away before the batch has stopped.
            await killed;
            return { code: 143 };
        }
        await job('/done', { key: items[0] });
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    await f.until(jobId, (run) => run?.status === 'running' && !!run.lastError);
    await f.crash();
    const next = await f.boot();
    f.platform = next.platform;
    app = next.app;
    await f.platform.longRuns.resume();
    const waiting = await f.until(jobId, (run) => !!run && !run.currentRunId);
    expect(waiting.status).toBe('waiting');
    expect(waiting.waitReason).toMatch(/^The source refused \(HTTP 429\)/);
    await f.until(jobId, (run) => run?.status === 'done');
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(350);
});

it('shows status counts to the Dot and the app, stops on the owner’s Stop, and keeps batches out of the deploy drain', async () => {
    const f = await fixture();
    const jobId = await f.saveJob();
    const plain = await f.saveJob({ name: 'Once', untilDone: false });
    f.computer.behavior = async ({ env, killed }) => {
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a', 'b', 'c', 'd', 'e'] });
        const { items } = (await job('/claim', { limit: 2 })).body;
        await job('/done', { key: items[0] });
        await job('/fail', { key: items[1], error: 'Gone (404)', retry: false });
        // Marked again: still done once.
        expect((await job('/done', { key: items[0] })).body).toEqual({
            done: true,
            already: true,
        });
        await job('/checkpoint', { value: { page: 3 } });
        await killed;
        return { code: 143 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    await f.until(jobId, (run) => !!run?.checkpointAt);
    const status = (await f.tool('job_status')({
        jobId,
    })) as unknown as LongRunView;
    expect(status).toMatchObject({
        status: 'running',
        items: { total: 5, done: 1, failed: 1, remaining: 3, inProgress: 0 },
        listComplete: false,
        batches: 1,
        checkpoint: '{"page":3}',
        retries: 0,
        deadLetters: [{ key: 'b', error: 'Gone (404)', attempts: 1 }],
        outcome: null,
    });
    expect(status.currentRunId).toBeTruthy();
    // A deploy doesn't wait for it: the next process resumes it.
    expect(f.platform.jobs.running).toBe(1);
    expect(f.platform.inProgress()).toBe(0);
    // The app lists it with the job, and in the job's detail.
    const alice = await f.as('alice');
    const state = await alice<SchedulesState>('/schedules');
    expect(state.body.jobs.find((job) => job.id === jobId)).toMatchObject({
        untilDone: true,
        longRun: { status: 'running', items: { done: 1, total: 5 } },
    });
    expect(state.body.jobs.find((job) => job.id === plain)).toMatchObject({
        untilDone: false,
    });
    const detail = await alice<JobDetail>(`/schedules/jobs/${jobId}`);
    expect(detail.body.longRun).toMatchObject({ id: status.id });
    // A job that runs once has no long run.
    expect(await f.tool('job_status')({ jobId: plain })).toMatchObject({
        status: 'not_started',
    });
    // Stop: the batch ends, what's left stays, and it says so.
    const stopped = await alice<LongRunView>(`/schedules/jobs/${jobId}/stop`, 'POST');
    expect(stopped).toMatchObject({ status: 200, body: { status: 'cancelled' } });
    expect(stopped.body.outcome).toBe(
        '“Collect listings” was stopped: Stopped by its owner. 1 of 5 items done, 1 set aside as failed, 3 left, after 1 batch over under a minute.',
    );
    await vi.waitFor(() => expect(f.platform.jobs.running).toBe(0));
    expect(await f.platform.jobs.run('alice', status.currentRunId!)).toMatchObject({
        status: 'interrupted',
        error: 'Stopped by its owner.',
    });
    expect((await alice(`/schedules/jobs/${jobId}/stop`, 'POST')).status).toBe(409);
});

it('refuses the checkpoint API to sessions and to a job that runs once', async () => {
    const f = await fixture();
    const plain = await f.saveJob({ untilDone: false });
    let answer: { status: number; body: unknown } | undefined;
    f.computer.behavior = async ({ env }) => {
        answer = await client(f.app, {
            ...env,
            CB_JOB_API: `${API}/api/data/job`,
        }).job('/claim', { limit: 1 });
        return { code: 0 };
    };
    const { run } = await f.platform.longRuns.startJob('alice', plain, {
        trigger: 'manual',
    });
    await vi.waitFor(async () => expect((await f.platform.jobs.run('alice', run!.id)).status).toBe('succeeded'));
    expect(answer).toMatchObject({
        status: 409,
        body: { error: expect.stringContaining('Save it with untilDone') },
    });
    const alice = await f.as('alice');
    expect((await alice('/data/job')).status).toBe(403);
});

// ---- the app starting (CB-161) -----------------------------------------------

const REFUSED = 'error: ConnectionRefused http://app:4310/api/data/datasets/scratch/query\n';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('resumes after a restart only once the server is listening, at no cost to its items', async () => {
    const f = await fixture({ startupSettleMs: 30 });
    const jobId = await f.saveJob();
    let app = f.app;
    let listening = false;
    const started: Array<{ batch: number; listening: boolean }> = [];
    let batch = 0;
    f.computer.behavior = async ({ env, killed }) => {
        const b = ++batch;
        started.push({ batch: b, listening });
        // The app isn't accepting connections yet: what the batch would see.
        if (b > 1 && !listening) {
            return { code: 1, stderr: REFUSED };
        }
        const { job } = client(app, env);
        await job('/items', { keys: ['1', '2', '3'], complete: true });
        for (;;) {
            const { items } = (await job('/claim', { limit: 1 })).body;
            if (!items.length) {
                break;
            }
            for (const key of items as string[]) {
                if (b === 1 && key === '2') {
                    await killed;
                    return { code: 143 };
                }
                await job('/done', { key });
            }
        }
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    await f.until(jobId, (run) => run?.status === 'running' && run.items.done === 1);
    // The restart: the new process isn't listening yet.
    await f.crash();
    const next = await f.boot();
    next.platform.awaitListening();
    f.platform = next.platform;
    app = next.app;
    await f.platform.longRuns.resume();
    await sleep(250);
    // Nothing resumed while the server was down.
    expect(started).toEqual([{ batch: 1, listening: false }]);
    listening = true;
    f.platform.markListening();
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(started.slice(1)).toEqual([{ batch: 2, listening: true }]);
    expect(view).toMatchObject({ batches: 2, retries: 0, items: { done: 3 } });
    expect(items(f, view.id)).toEqual({ 1: 1, 2: 1, 3: 1 });
});

it('does not count a batch that failed only because the app was not up yet, nor charge its item', async () => {
    const f = await fixture({ startupSettleMs: 5, retryBaseMs: 20 });
    f.platform.awaitListening();
    f.platform.markListening();
    const jobId = await f.saveJob();
    let batch = 0;
    f.computer.behavior = async ({ env }) => {
        // The first call of the first batch is refused: nothing was done yet.
        if (++batch === 1) {
            return { code: 1, stderr: REFUSED };
        }
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a'], complete: true });
        const { items: claimed } = (await job('/claim', { limit: 1 })).body;
        await job('/done', { key: claimed[0] });
        return { code: 0 };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'done');
    expect(view).toMatchObject({ batches: 2, retries: 0 });
    expect(items(f, view.id)).toEqual({ a: 1 });
    // The batch's wrapper waits for the app, then runs the job as before.
    const script = f.computer.writes.find((w) => w.path.endsWith('run.sh'))!;
    expect(script.contents).toContain('/healthz');
    expect(script.contents).toMatch(/timeout -k 5 \d+ bash main\.sh > out\.log/);
});

it('still fails a long run whose batches keep being refused after the startup window', async () => {
    const f = await fixture({
        startupSettleMs: 5,
        startupWindowMs: 1,
        retryBaseMs: 10,
        batchRetries: 1,
    });
    f.platform.awaitListening();
    f.platform.markListening();
    const jobId = await f.saveJob();
    await sleep(10);
    f.computer.behavior = async ({ env }) => {
        await sleep(20);
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a'], complete: true });
        await job('/claim', { limit: 1 });
        return { code: 1, stderr: REFUSED };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'failed');
    expect(view.retries).toBeGreaterThan(1);
    expect(view.outcome).toMatch(/in a row failed without progress/);
});

it('counts a crash that is not a refusal, even right after the app is up', async () => {
    const f = await fixture({
        startupSettleMs: 5,
        startupWindowMs: 60_000,
        retryBaseMs: 10,
        batchRetries: 1,
    });
    f.platform.awaitListening();
    f.platform.markListening();
    const jobId = await f.saveJob();
    f.computer.behavior = async ({ env }) => {
        const { job } = client(f.app, env);
        await job('/items', { keys: ['a'], complete: true });
        await job('/claim', { limit: 1 });
        return { code: 1, stderr: 'TypeError: x is not a function\n' };
    };
    await f.platform.longRuns.startJob('alice', jobId, { trigger: 'manual' });
    const view = await f.until(jobId, (run) => run?.status === 'failed');
    expect(view.outcome).toMatch(/2 batches in a row failed without progress/);
});

it('checkpoint writes cannot bypass a company job token’s shared-data reach (CB-226)', async () => {
    const f = await fixture();
    const privateData = f.platform.data.createDataset('alice', {
        name: 'Private payroll',
    });
    f.platform.data.setGrant('alice', {
        dotId: f.dot.id,
        datasetId: privateData.id,
        access: 'write',
    });
    const jobId = await f.saveJob({ datasets: ['Private payroll'] });
    let denied = 0;
    f.computer.behavior = async ({ env }) => {
        const { job } = client(f.app, env);
        await job('/items', { keys: ['one'], complete: true });
        await job('/claim', { limit: 1 });
        denied = (
            await job('/done', {
                key: 'one',
                write: { ...write('one'), dataset: privateData.id },
            })
        ).status;
        await job('/fail', {
            key: 'one',
            error: 'Private data is unavailable',
            retry: false,
        });
        return { code: 0 };
    };
    await f.tool('job_run')({ jobId });
    await f.until(jobId, (run) => run?.status === 'failed');
    expect(denied).toBe(404);
});
