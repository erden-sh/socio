import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { TURN_FAILURE_MESSAGES } from '@socio/foundation/observability/failures';
import { OUTPUT_LIMIT_NOTE } from '@socio/foundation/turns/output-limit';
import { LOOP_END_EVENT, type LoopEnd } from '@socio/shared/loop-end';
import { pageReviewTool } from '@socio/shared/pages/page-review';

import { dotModelRoundsFromEnv, type PlatformConfig } from '../src/server/composition/config.js';
import { spacePages } from '../src/server/composition/pages.js';
import { WorkspacePageTools } from '../src/server/pages/page-tools.js';
import { SpacePages } from '../src/server/spaces/contract.js';
import { spacesModule } from '../src/server/spaces/spaces-module.js';
import { agentLoop, lastRoundNote } from '../src/server/turns/agent-loop.js';
import { DEFAULT_DOT_MODEL_ROUNDS } from '../src/server/turns/contract.js';

import { completion, completionStream } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { testModuleServices } from './helpers/module-services.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

// A Dot turn's model rounds (CB-127) and rounds cut off by the model's
// output limit (CB-126), on a fake Chat Completions model.

const databases: Array<{ close(): void }> = [];
afterEach(() => {
    vi.restoreAllMocks();
    databases.splice(0).forEach((db) => db.close());
});

function fixture(config: Partial<PlatformConfig> = {}) {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    databases.push(store, workspace);
    const dot = workspace.dots()[0];
    // Its pages need a person who may read the Space (CB-181).
    workspace.recordUser({ id: 'owner', name: 'Owner', role: 'member' });
    workspace.bindThread('thread', dot.id, 'Rounds', 'owner');
    const agent = new DotAgent(
        store,
        workspace,
        {
            apiKey: 'fixture',
            model: 'custom-model',
            baseUrl: 'https://unused.invalid/v1',
            runtimeUrl: '',
            voiceName: 'marin',
            ...config,
        },
        dot.id,
        false,
        undefined,
        {
            extensions: {
                // The page tools (`SpacePages` over `PageTools`) over the workspace, as the app's are.
                tools: (turn) =>
                    spacesModule.dotTools!(
                        {
                            services: testModuleServices({ workspace }, [
                                [SpacePages, spacePages(new WorkspacePageTools(workspace))],
                            ]),
                        } as never,
                        turn,
                    ),
            },
        },
    );
    const input: RunAgentInput = {
        threadId: 'thread',
        runId: 'run',
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: 'Tidy up my Spaces.' }],
        tools: [],
        forwardedProps: {},
    };
    return { store, workspace, dot, agent, input };
}

/** Runs the agent through a file-backed runner, as the server does. */
async function runStored(agent: DotAgent, input: RunAgentInput) {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-rounds-'));
    const path = testDatabaseFile(join(dir, 'runs.sqlite'));
    const runner = new LocalAgentRunner(path);
    agent.threadId = input.threadId;
    agent.setMessages(input.messages);
    try {
        const events = await lastValueFrom(runner.run({ threadId: input.threadId, agent, input }).pipe(toArray()));
        await expect.poll(() => runner.activeRunId(input.threadId)).toBeUndefined();
        const db = new DatabaseSync(path, { readOnly: true });
        const row = db.prepare('SELECT status, errorDetail FROM agent_runs').get() as {
            status: string;
            errorDetail: string | null;
        };
        db.close();
        return { events, row };
    } finally {
        runner.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

/** A round that calls `name` with these raw arguments. */
function callRound(id: string, name: string, rawArguments: string, finishReason: string | null = 'tool_calls') {
    return completion(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id,
                    type: 'function',
                    function: { name, arguments: rawArguments },
                },
            ],
        },
        finishReason,
    );
}

type Request = {
    tools?: unknown[];
    messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};
const bodies = (network: { mock: { calls: unknown[][] } }) =>
    network.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as Request);

/** A model that lists Spaces for as long as it has tools, then reports. */
function busyModel() {
    let round = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Request;
        round += 1;
        return body.tools?.length
            ? callRound(`call-${round}`, 'list_authorized_spaces', '{}')
            : completion({
                  role: 'assistant',
                  content: 'Listed the Spaces; the tidy-up itself is still to do.',
              });
    });
}

const loopEnds = (events: BaseEvent[]) =>
    events
        .filter((event) => event.type === EventType.CUSTOM && (event as { name?: string }).name === LOOP_END_EVENT)
        .map((event) => (event as unknown as { value: LoopEnd }).value);

const textOf = (events: BaseEvent[]) =>
    events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK)
        .map((event) => (event as unknown as { delta: string }).delta)
        .join('');

it('lets a turn run 30 model rounds, the last without tools, ending with a status (CB-127)', async () => {
    const f = fixture();
    const network = busyModel();
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(DEFAULT_DOT_MODEL_ROUNDS).toBe(30);
    expect(network).toHaveBeenCalledTimes(30);
    const requests = bodies(network);
    // Every round before the last offers the tools; the last offers none and
    // tells the model why.
    expect(requests.slice(0, 29).every((body) => body.tools?.length)).toBe(true);
    const last = requests[29];
    expect(last.tools ?? []).toEqual([]);
    expect(JSON.stringify(last.messages)).toContain(lastRoundNote(30));
    // It sees the 29th round's tool result before it writes.
    expect(last.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call-29' }));
    expect(textOf(events)).toBe('Listed the Spaces; the tidy-up itself is still to do.');
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    expect(loopEnds(events)).toEqual([{ reason: 'round_cap', rounds: 30, cap: 30 }]);
    // Just before the turn's last event.
    expect(events.at(-2)).toMatchObject({ name: LOOP_END_EVENT });
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('takes the cap from Settings over DOT_MAX_MODEL_ROUNDS (CB-127)', async () => {
    expect(dotModelRoundsFromEnv({})).toBeUndefined();
    expect(dotModelRoundsFromEnv({ DOT_MAX_MODEL_ROUNDS: ' 12 ' })).toBe(12);
    for (const bad of ['1', '201', '2.5', 'many']) {
        expect(() => dotModelRoundsFromEnv({ DOT_MAX_MODEL_ROUNDS: bad })).toThrow(
            'DOT_MAX_MODEL_ROUNDS must be a whole number from 2 to 200.',
        );
    }

    // The environment's value…
    const env = fixture({ dotModelRounds: 6 });
    const fromEnv = busyModel();
    const envEvents = await lastValueFrom(env.agent.run(env.input).pipe(toArray()));
    expect(fromEnv).toHaveBeenCalledTimes(6);
    expect(loopEnds(envEvents)).toEqual([{ reason: 'round_cap', rounds: 6, cap: 6 }]);
    vi.restoreAllMocks();

    // …under an admin's.
    const saved = fixture({ dotModelRounds: 6 });
    await saved.store.updateSettings({ limits: { dotModelRounds: 3 } });
    const fromSettings = busyModel();
    const savedEvents = await lastValueFrom(saved.agent.run(saved.input).pipe(toArray()));
    expect(fromSettings).toHaveBeenCalledTimes(3);
    expect(bodies(fromSettings)[2].tools ?? []).toEqual([]);
    expect(loopEnds(savedEvents)).toEqual([{ reason: 'round_cap', rounds: 3, cap: 3 }]);
});

it('counts the rounds that ran and stops before the cap when the model answers', async () => {
    const loop = agentLoop(4);
    expect(loop.strategy({ iterationCount: 3 } as never)).toBe(true);
    expect(loop.strategy({ iterationCount: 4 } as never)).toBe(false);

    const f = fixture();
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(callRound('spaces', 'list_authorized_spaces', '{}'))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'You have one Space.' }));
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(network).toHaveBeenCalledTimes(2);
    expect(textOf(events)).toBe('You have one Space.');
    expect(loopEnds(events)).toEqual([{ reason: 'completed', rounds: 2, cap: 30 }]);
});

it('still ends a turn at the time limit, before its rounds run out (CB-127)', async () => {
    vi.useFakeTimers();
    try {
        const f = fixture();
        // A slow model: 20 s a round, always asking for a tool.
        let round = 0;
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(
            (_url, init) =>
                new Promise((resolve, reject) => {
                    const timer = setTimeout(
                        () => resolve(callRound(`call-${++round}`, 'list_authorized_spaces', '{}')),
                        20_000,
                    );
                    init?.signal?.addEventListener(
                        'abort',
                        () => {
                            clearTimeout(timer);
                            reject(init.signal?.reason);
                        },
                        { once: true },
                    );
                }),
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
        await vi.advanceTimersByTimeAsync(300_001);
        const events = await finished;
        expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toEqual([
            expect.objectContaining({
                type: EventType.RUN_ERROR,
                code: 'time_limit',
            }),
        ]);
        const [end] = loopEnds(events);
        expect(end).toMatchObject({ reason: 'time_limit', cap: 30 });
        expect(end.rounds).toBeGreaterThan(5);
        expect(end.rounds).toBeLessThan(30);
        // No round went without tools: the cap was never reached.
        expect(bodies(network).every((body) => body.tools?.length)).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});

/** A model that never answers; the turn can only end at its time limit. */
function hangingModel() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
}
const runErrors = (events: BaseEvent[]) => events.filter((event) => event.type === EventType.RUN_ERROR);

it('takes the turn time limit from Settings over TURN_TIME_LIMIT_SECONDS (CB-123)', async () => {
    vi.useFakeTimers();
    try {
        const f = fixture({ turnTimeLimitSeconds: 90 });
        await f.store.updateSettings({ limits: { turnTimeLimitSeconds: 45 } });
        hangingModel();
        let done = false;
        const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray())).finally(() => (done = true));
        await vi.advanceTimersByTimeAsync(44_000);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1_001);
        expect(runErrors(await finished)).toEqual([
            expect.objectContaining({
                code: 'time_limit',
                message: expect.stringContaining('45 second time limit'),
            }),
        ]);
    } finally {
        vi.useRealTimers();
    }
});

it('uses the environment’s turn time limit until an admin saves one (CB-123)', async () => {
    vi.useFakeTimers();
    try {
        const f = fixture({ turnTimeLimitSeconds: 90 });
        hangingModel();
        const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
        await vi.advanceTimersByTimeAsync(90_001);
        expect(runErrors(await finished)).toEqual([
            expect.objectContaining({
                code: 'time_limit',
                message: expect.stringContaining('90 second time limit'),
            }),
        ]);
    } finally {
        vi.useRealTimers();
    }
});

it('lets a running turn keep the time limit it started with (CB-123)', async () => {
    vi.useFakeTimers();
    try {
        const f = fixture({ turnTimeLimitSeconds: 90 });
        hangingModel();
        let done = false;
        const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray())).finally(() => (done = true));
        await vi.advanceTimersByTimeAsync(10_000);
        // A shorter limit saved mid-turn does not cut this turn at 30 s...
        await f.store.updateSettings({ limits: { turnTimeLimitSeconds: 30 } });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(done).toBe(false);
        // ...it ends at the 90 s it started with.
        await vi.advanceTimersByTimeAsync(20_001);
        expect(runErrors(await finished)).toEqual([
            expect.objectContaining({
                message: expect.stringContaining('90 second time limit'),
            }),
        ]);
        // The next turn has the new limit.
        const next = fixture({ turnTimeLimitSeconds: 90 });
        await next.store.updateSettings({ limits: { turnTimeLimitSeconds: 30 } });
        done = false;
        const second = lastValueFrom(next.agent.run(next.input).pipe(toArray())).finally(() => (done = true));
        await vi.advanceTimersByTimeAsync(30_001);
        expect(done).toBe(true);
        expect(runErrors(await second)).toHaveLength(1);
    } finally {
        vi.useRealTimers();
    }
});

const notes = { title: 'Notes', content: '# Notes\n\nAll of it.' };

it('skips a tool call the output limit cut off, tells the model to write in parts and carries on (CB-126)', async () => {
    const f = fixture();
    const before = f.workspace.pages.list(f.dot.spaceId).length;
    // Cut off after a complete string: CB-12 would have closed the brace and
    // run the call with the part it had.
    const cut = '{"title":"Notes","content":"# Notes\\n\\nThe first half"';
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(callRound('cut', 'create_space_page', cut, 'length'))
        .mockResolvedValueOnce(callRound('whole', 'create_space_page', JSON.stringify(notes)))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Created Notes.' }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, row } = await runStored(f.agent, f.input);
    expect(network).toHaveBeenCalledTimes(3);
    const pages = f.workspace.pages.list(f.dot.spaceId);
    expect(pages).toHaveLength(before + 1);
    const page = pages.find((entry) => entry.title === 'Notes')!;
    expect(f.workspace.pages.get(f.dot.spaceId, page.id)?.content).toBe(notes.content);
    expect(bodies(network)[1].messages).toContainEqual(
        expect.objectContaining({
            role: 'tool',
            tool_call_id: 'cut',
            content: expect.stringContaining(OUTPUT_LIMIT_NOTE),
        }),
    );
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    expect(row).toMatchObject({ status: 'finished', errorDetail: null });
    expect(loopEnds(events)).toEqual([{ reason: 'completed', rounds: 3, cap: 30 }]);
    expect(errors.mock.calls.flat().join('\n')).toContain(
        'Model tool call create_space_page (cut): cut off by the output limit; asked the model to write in parts',
    );
});

it('runs the whole calls of a round the output limit cut, and only skips the cut one (CB-126)', async () => {
    const f = fixture();
    const call = (index: number, id: string, name: string, args: string) => ({
        role: 'assistant',
        tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }],
    });
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
            completionStream(
                [
                    call(0, 'spaces', 'list_authorized_spaces', '{}'),
                    call(1, 'cut', 'create_space_page', '{"title":"Notes","con'),
                ],
                'length',
            ),
        )
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Listed; writing next.' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(network).toHaveBeenCalledTimes(2);
    const results = bodies(network)[1].messages.filter((message) => message.role === 'tool');
    expect(results).toEqual([
        expect.objectContaining({
            tool_call_id: 'spaces',
            content: expect.stringContaining(f.dot.spaceId),
        }),
        expect.objectContaining({
            tool_call_id: 'cut',
            content: expect.stringContaining(OUTPUT_LIMIT_NOTE),
        }),
    ]);
    expect(loopEnds(events)).toEqual([{ reason: 'completed', rounds: 2, cap: 30 }]);
});

it('ends a turn whose tool calls the output limit cuts off twice, saying why (CB-126)', async () => {
    const f = fixture();
    const before = f.workspace.pages.list(f.dot.spaceId);
    const cut = '{"title":"Notes","content":"# Notes\\n\\nThe first';
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(callRound('first', 'create_space_page', cut, 'length'))
        .mockResolvedValueOnce(callRound('second', 'create_space_page', cut, 'length'))
        .mockResolvedValue(completion({ role: 'assistant', content: 'Never requested.' }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, row } = await runStored(f.agent, f.input);
    expect(network).toHaveBeenCalledTimes(2);
    expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(before);
    expect(events.filter((event) => event.type === EventType.RUN_ERROR)).toEqual([
        {
            type: EventType.RUN_ERROR,
            message: TURN_FAILURE_MESSAGES.output_limit,
            code: 'output_limit',
            timestamp: expect.any(Number),
        },
    ]);
    expect(TURN_FAILURE_MESSAGES.output_limit).not.toBe(TURN_FAILURE_MESSAGES.failed);
    expect(row).toMatchObject({
        status: 'failed',
        errorDetail: 'The model’s output limit cut off its tool calls twice (create_space_page).',
    });
    expect(loopEnds(events)).toEqual([{ reason: 'output_limit', rounds: 2, cap: 30 }]);
    expect(errors.mock.calls.flat().join('\n')).toContain(
        'Model tool call create_space_page (second): cut off by the output limit again; turn stopped',
    );
});

it('keeps an answer the output limit cut off, and ends a round cut off before it wrote anything (CB-126)', async () => {
    const f = fixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'A long answer that' }, 'length'),
    );
    const { events, row } = await runStored(f.agent, f.input);
    expect(row.status).toBe('finished');
    expect(loopEnds(events)).toEqual([{ reason: 'output_limit', rounds: 1, cap: 30 }]);
    vi.restoreAllMocks();

    const empty = fixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(completion({ role: 'assistant' }, 'length'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ended = await runStored(empty.agent, empty.input);
    expect(ended.events.find((event) => event.type === EventType.RUN_ERROR)).toMatchObject({ code: 'output_limit' });
    expect(loopEnds(ended.events)).toEqual([{ reason: 'output_limit', rounds: 1, cap: 30 }]);
});

it('says how the loop ended when it fails, is stopped or waits for the person', async () => {
    // A model that can't be reached: an error.
    const failing = fixture();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await runStored(failing.agent, failing.input);
    expect(loopEnds(failed.events)).toEqual([{ reason: 'error', rounds: 1, cap: 30 }]);
    vi.restoreAllMocks();

    // Paused while the model thinks: stopped.
    const paused = fixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const running = lastValueFrom(paused.agent.run(paused.input).pipe(toArray()));
    await expect.poll(() => vi.mocked(fetch).mock.calls.length).toBe(1);
    await paused.store.updateSettings({ paused: true });
    const stopped = await running;
    expect(stopped.at(-1)).toMatchObject({ code: 'stopped' });
    expect(loopEnds(stopped)).toEqual([{ reason: 'stopped', rounds: 1, cap: 30 }]);
    vi.restoreAllMocks();

    // Stopped by its owner: stopped, with no RUN_ERROR.
    const owner = fixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            }),
    );
    const own = lastValueFrom(owner.agent.run(owner.input).pipe(toArray()));
    await expect.poll(() => vi.mocked(fetch).mock.calls.length).toBe(1);
    owner.agent.abortRun();
    const ownEvents = await own;
    expect(ownEvents.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
    expect(loopEnds(ownEvents)).toEqual([{ reason: 'stopped', rounds: 1, cap: 30 }]);
    vi.restoreAllMocks();

    // The review tool hands the page to the person: interrupted.
    const review = fixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        callRound('review-page', pageReviewTool.name, JSON.stringify({ ...notes, spaceId: review.dot.spaceId })),
    );
    const waiting = await lastValueFrom(
        review.agent
            .run({
                ...review.input,
                tools: [
                    {
                        name: pageReviewTool.name,
                        description: 'Review',
                        parameters: {},
                    },
                ],
            })
            .pipe(toArray()),
    );
    expect(loopEnds(waiting)).toEqual([{ reason: 'interrupted', rounds: 1, cap: 30 }]);
});
