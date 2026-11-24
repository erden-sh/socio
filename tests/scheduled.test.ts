import { afterEach, expect, it, vi } from 'vitest';

import type { Claim } from '../src/server/schedules/contract.js';
import { scheduledTaskExecutor } from '../src/server/schedules/scheduled.js';

import { completion } from './fixtures/model-stream.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture(users = ['alice', 'bob']) {
    const { store, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'qwen-test',
        },
    });
    cleanup.push(dispose);
    const dot = workspace.dots()[0];
    const thread = workspace.bindThread('thread', dot.id, 'Scheduled', 'alice');
    const task = await store.createTask('Summarise the week', null, 'alice');
    await workspace.bindTask(task.id, thread.id);
    const execute = scheduledTaskExecutor(platform, (id) => users.includes(id));
    const claim = async (): Promise<Claim> => ({
        ...(await store.task(task.id))!,
        lease: 'lease',
    });
    return { store, workspace, platform, thread, task, execute, claim };
}
const run = (execute: ReturnType<typeof scheduledTaskExecutor>, claim: Claim) =>
    execute(claim, [], new AbortController().signal, () => {});

it("runs a scheduled task as its owner, with the owner's memories", async () => {
    const f = await fixture();
    await f.store.memoryItems.add({
        text: 'Alice likes tables',
        userId: 'alice',
        source: 'person',
    });
    await f.store.memoryItems.add({
        text: 'Bob likes haiku',
        userId: 'bob',
        source: 'person',
    });
    const model = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, init) =>
            String(init?.body).includes('Write a short title')
                ? Response.json({ choices: [{ message: { content: 'Weekly' } }] })
                : completion({ role: 'assistant', content: 'Here is the week.' }),
        );
    expect(await run(f.execute, await f.claim())).toEqual({
        text: 'Here is the week.',
        sources: [],
        sample: false,
    });
    const prompt = String(model.mock.calls[0][1]?.body);
    expect(prompt).toContain('Alice likes tables');
    expect(prompt).not.toContain('Bob likes haiku');
});

it('refuses a task whose owner is gone or no longer owns its conversation', async () => {
    const gone = await fixture(['bob']);
    await expect(run(gone.execute, await gone.claim())).rejects.toThrow('owner no longer has access');
    const moved = await fixture();
    moved.workspace.migrateLegacyOwner('alice', 'bob');
    await expect(run(moved.execute, await moved.claim())).rejects.toThrow('no longer has access to its conversation');
    const legacy = await fixture();
    await expect(run(legacy.execute, { ...(await legacy.claim()), userId: null })).rejects.toThrow(
        'owner no longer has access',
    );
});

it('gives tasks and memories from before user accounts to the first admin', async () => {
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    await store.createTask('Mine', null, 'bob');
    // Simulate rows written before the userId column existed.
    (store as unknown as { db: { exec(sql: string): void } }).db.exec(
        "INSERT INTO tasks (id, prompt, status, createdAt, updatedAt) VALUES ('old', 'Old task', 'queued', 1, 1); INSERT INTO memories (id, text, createdAt) VALUES ('m', 'Old memory', 1);",
    );
    expect(await store.assignUnowned('alice')).toBe(2);
    expect((await store.tasks('alice')).map((t) => t.id)).toEqual(['old']);
    expect((await store.memoryItems.active('alice')).map((m) => m.text)).toEqual(['Old memory']);
    expect((await store.tasks('bob')).map((t) => t.prompt)).toEqual(['Mine']);
    expect(await store.assignUnowned('alice')).toBe(0);
});

it('marks scheduled turns with the date and time as chats are (CB-141)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    cleanup.push(() => vi.useRealTimers());
    const f = await fixture();
    const model = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, init) =>
            String(init?.body).includes('Write a short title')
                ? Response.json({ choices: [{ message: { content: 'Weekly' } }] })
                : completion({ role: 'assistant', content: 'Here is the week.' }),
        );
    /** The scheduled turn at `at`: its request's time markers and system prompt. */
    const at = async (time: string) => {
        vi.setSystemTime(new Date(time));
        await run(f.execute, await f.claim());
        const body = JSON.parse(
            String(
                model.mock.calls.filter(([, init]) => String(init?.body).includes('specialist socio')).at(-1)![1]?.body,
            ),
        ) as {
            messages: Array<{
                role: string;
                content: string | Array<{ text: string }>;
            }>;
        };
        return {
            system: JSON.stringify(body.messages[0]),
            markers: body.messages.flatMap((message) =>
                typeof message.content === 'string'
                    ? []
                    : message.content
                          .map((part) => part.text)
                          .filter((text) => text.startsWith('[Date and time of this')),
            ),
        };
    };
    const first = await at('2026-10-21T09:00:00.000Z');
    expect(first.markers).toEqual(['[Date and time of this message: Wed 21 Oct 2026, 09:00 (UTC).]']);
    // Five minutes later, none; forty, a new one; the next day, another.
    expect((await at('2026-10-21T09:05:00.000Z')).markers).toEqual(first.markers);
    expect((await at('2026-10-21T09:45:00.000Z')).markers).toHaveLength(2);
    const nextDay = await at('2026-10-22T07:00:00.000Z');
    expect(nextDay.markers.at(-1)).toBe('[Date and time of this message: Thu 22 Oct 2026, 07:00 (UTC).]');
    expect(nextDay.markers).toHaveLength(3);
    expect(nextDay.system).toBe(first.system);
});

it('records a scheduled turn as its task’s, late by the time since it came due (CB-185)', async () => {
    const f = await fixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
        String(init?.body).includes('Write a short title')
            ? Response.json({ choices: [{ message: { content: 'Weekly' } }] })
            : completion({ role: 'assistant', content: 'Here is the week.' }),
    );
    const dueAt = Date.now() - 4_000;
    await run(f.execute, { ...(await f.claim()), dueAt });
    const [turn] = f.platform.runner.recentRuns();
    const { startedAt, trace } = f.platform.runner.runTrace(turn.runId)!;
    expect(trace!.trigger).toEqual({ kind: 'schedule', id: f.task.id });
    expect(trace!.receivedAt).toBe(dueAt);
    expect(startedAt - dueAt).toBeGreaterThanOrEqual(4_000);
    // Its prompt is the schedule's; the answer the socio's.
    expect(trace!.messages!.map((message) => message.author)).toEqual([
        { kind: 'schedule', id: f.task.id },
        { kind: 'socio', id: f.thread.dotId },
    ]);
});
