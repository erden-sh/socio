import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { sqliteData } from '@socio/data/open';
import type { TimingSample } from '@socio/foundation/inference/timings';
import {
    RUN_MODEL_EVENT,
    RUN_WAIT_EVENT,
    nextPhase,
    phaseHint,
    phaseText,
    startPhase,
    type RunWaitInfo,
} from '@socio/shared/runs/run-phase';

import type { PlatformConfig } from '../src/server/composition/config.js';
import type { InferenceTimingRepository } from '../src/server/inference/domain/repositories.js';
import { sqliteInferenceRepositories } from '../src/server/inference/infra/sqlite/index.js';
import { InferenceService } from '../src/server/inference/service.js';
import { InferenceTimings } from '../src/server/inference/timings.js';
import { timedRounds } from '../src/server/turns/round-timer.js';

import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

function timings() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const { timings: repo } = sqliteInferenceRepositories(sqliteData(workspace.db));
    return { workspace, timings: new InferenceTimings(repo) };
}
/** A model's stored samples, newest first, from the timings' own (private) repository. */
const stored = (store: InferenceTimings, key: string) =>
    (store as unknown as { repo: InferenceTimingRepository }).repo.latest(key, 100);
/** Samples are stored off the stream's path: until they are. */
const settled = () => new Promise((resolve) => setImmediate(resolve));
const sample = (overrides: Partial<TimingSample>): TimingSample => ({
    key: 'shared:b1:qwen',
    round: 'first',
    promptChars: 40_000,
    promptTokens: 10_000,
    uncachedTokens: 10_000,
    ttftMs: 4_000,
    ...overrides,
});

it('says nothing until a model has a few samples, then the median wait', async () => {
    const { timings: store } = timings();
    const size = { promptChars: 40_000 };
    for (let i = 0; i < 4; i++) {
        await store.record(sample({ ttftMs: 1_000 * (i + 1) }));
    }
    expect(await store.estimate('shared:b1:qwen', 'first', size)).toBeUndefined();
    await store.record(sample({ ttftMs: 9_000 }));
    // Same-sized prompts: no fit, the median of 1, 2, 3, 4 and 9 s.
    expect(await store.estimate('shared:b1:qwen', 'first', size)).toEqual({
        ms: 3_000,
        tokens: 10_000,
        samples: 5,
    });
    // Other models know nothing yet.
    expect(await store.estimate('byo:byo-chatgpt:gpt-6.1-sol', 'first', size)).toBe(undefined);
});

it('fits the wait to the uncached prompt size, learning tokens per character and the cache share', async () => {
    const { timings: store } = timings();
    // Prefill at 2,500 tokens a second plus 0.4 s; half of each prompt cached.
    for (const tokens of [4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000, 32_000]) {
        await store.record(
            sample({
                promptChars: tokens * 4,
                promptTokens: tokens,
                uncachedTokens: tokens / 2,
                ttftMs: 400 + (tokens / 2 / 2_500) * 1_000,
            }),
        );
    }
    // 80k characters: ~20k tokens, ~10k uncached: 0.4 + 4 s.
    expect(await store.estimate('shared:b1:qwen', 'first', { promptChars: 80_000 })).toEqual({
        ms: 4_400,
        tokens: 20_000,
        samples: 8,
    });
    // A later round sized in tokens; no 'next' samples yet, so all of them.
    expect(await store.estimate('shared:b1:qwen', 'next', { promptTokens: 40_000 })).toMatchObject({
        ms: 8_400,
        tokens: 40_000,
    });
});

it('keeps the latest 200 samples per model', async () => {
    const { workspace, timings: store } = timings();
    for (let i = 0; i < 210; i++) {
        await store.record(sample({}), 1_000 + i);
    }
    await store.record(sample({ key: 'other' }));
    const count = (key: string) =>
        (workspace.db.prepare('SELECT COUNT(*) AS n FROM inference_timings WHERE key=?').get(key) as { n: number }).n;
    expect(count('shared:b1:qwen')).toBe(200);
    expect(count('other')).toBe(1);
    // Nonsense is not kept.
    await store.record(sample({ key: 'bad', promptTokens: 0 }));
    await store.record(sample({ key: 'bad', ttftMs: -5 }));
    expect(count('bad')).toBe(0);
});

it('times each model round to its first output and announces the expected wait', async () => {
    const { timings: store } = timings();
    for (let i = 0; i < 5; i++) {
        await store.record(sample({ ttftMs: 2_000 }));
    }
    for (let i = 0; i < 5; i++) {
        await store.record(sample({ round: 'next', promptChars: undefined, ttftMs: 500 }));
    }
    let clock = 0;
    const emitted: RunWaitInfo[] = [];
    async function* model() {
        clock += 2_500;
        yield { type: 'TOOL_CALL_START' };
        yield {
            type: 'RUN_FINISHED',
            usage: { promptTokens: 9_000, completionTokens: 40 },
        };
        clock += 1_000;
        yield { type: 'TOOL_CALL_RESULT', content: 'x'.repeat(4_000) };
        clock += 700;
        yield { type: 'TEXT_MESSAGE_START' };
        yield {
            type: 'RUN_FINISHED',
            usage: {
                promptTokens: 10_100,
                completionTokens: 5,
                promptTokensDetails: { cachedTokens: 9_000 },
            },
        };
    }
    const seen: string[] = [];
    for await (const chunk of timedRounds(model(), {
        key: 'shared:b1:qwen',
        promptChars: 36_000,
        timings: store,
        showTokens: true,
        emit: (wait) => emitted.push(wait),
        now: () => clock,
    })) {
        seen.push(chunk.type);
    }
    // Passed on as it is.
    expect(seen).toEqual(['TOOL_CALL_START', 'RUN_FINISHED', 'TOOL_CALL_RESULT', 'TEXT_MESSAGE_START', 'RUN_FINISHED']);
    // The first wait (36k characters ≈ 9k tokens), then the one after the tool
    // result (9,000 + 40 + 1,000 tokens).
    expect(emitted).toEqual([
        { expectedMs: 2_000, tokens: 9_000 },
        { expectedMs: 500, tokens: 10_040 },
    ]);
    await settled();
    const rows = (await stored(store, 'shared:b1:qwen')).slice(0, 2);
    expect(rows).toEqual([
        {
            round: 'next',
            promptChars: null,
            promptTokens: 10_100,
            uncachedTokens: 1_100,
            ttftMs: 700,
        },
        {
            round: 'first',
            promptChars: 36_000,
            promptTokens: 9_000,
            uncachedTokens: 9_000,
            ttftMs: 2_500,
        },
    ]);
});

it('shows the estimate while waiting, and drops it once the model answers', () => {
    let phase = startPhase(0);
    phase = nextPhase(phase, { type: 'RUN_STARTED' }, 0);
    phase = nextPhase(
        phase,
        {
            type: 'CUSTOM',
            name: RUN_MODEL_EVENT,
            value: { label: 'Homelab', model: 'qwen' },
        },
        0,
    );
    phase = nextPhase(
        phase,
        {
            type: 'CUSTOM',
            name: RUN_WAIT_EVENT,
            value: { expectedMs: 7_400, tokens: 18_200 },
        },
        0,
    );
    // The usual wait and the prompt's size are in the tooltip (CB-66).
    expect(phaseText(phase, 'Dot', 4_000)).toBe('Waiting for Homelab · qwen · 4 s');
    expect(phaseHint(phase)).toBe('Usually ~7 s · ~18k tokens');
    phase = nextPhase(phase, { type: 'TOOL_CALL_START', toolCallName: 'search_web' }, 8_000);
    // The next wait's estimate can come just before the tool result.
    phase = nextPhase(phase, { type: 'CUSTOM', name: RUN_WAIT_EVENT, value: { expectedMs: 1_200 } }, 9_000);
    phase = nextPhase(phase, { type: 'TOOL_CALL_RESULT' }, 9_000);
    expect(phaseText(phase, 'Dot', 9_000)).toBe('Waiting for Homelab · qwen');
    expect(phaseHint(phase)).toBe('Usually ~1 s');
    phase = nextPhase(phase, { type: 'TEXT_MESSAGE_START' }, 10_000);
    expect(phase.wait).toBeUndefined();
    expect(phaseHint(phase)).toBeUndefined();
});

it('sends a Dot turn’s expected wait after RUN_STARTED, and records the round', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    const store = new Store(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => workspace.close(),
        () => store.close(),
        () => runner.close(),
    );
    const inference = new InferenceService(workspace.db, {
        secret: 'response-times-test-secret-0123456789',
        log: () => {},
    });
    const backend = await inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid/v1',
        model: 'qwen',
    });
    const key = `shared:${backend.id}:qwen`;
    for (let i = 0; i < 5; i++) {
        await inference.timings.record(sample({ key, ttftMs: 3_000 }));
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        completion({ role: 'assistant', content: 'Hi.' }, 'stop', {
            prompt_tokens: 1_234,
            completion_tokens: 2,
            total_tokens: 1_236,
        }),
    );
    const dot = workspace.dots()[0];
    workspace.bindThread('t1', dot.id, 'Hi', 'bob');
    const config: PlatformConfig = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: 'response-times-test-secret-0123456789',
    };
    const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
        inference,
    });
    const input: RunAgentInput = {
        threadId: 't1',
        runId: 'r1',
        state: {},
        context: [],
        messages: [{ id: 'u1', role: 'user', content: 'Hello?' }],
        tools: [],
        forwardedProps: {},
    };
    agent.threadId = 't1';
    agent.setMessages(input.messages);
    const events = await lastValueFrom(runner.run({ threadId: 't1', agent, input }).pipe(toArray()));
    expect(events.slice(0, 3).map((event) => [event.type, (event as { name?: string }).name])).toEqual([
        ['RUN_STARTED', undefined],
        ['CUSTOM', RUN_MODEL_EVENT],
        ['CUSTOM', RUN_WAIT_EVENT],
    ]);
    expect((events[2] as unknown as { value: RunWaitInfo }).value).toMatchObject({
        expectedMs: 3_000,
    });
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    await settled();
    const [latest] = await stored(inference.timings, key);
    expect(latest).toMatchObject({ round: 'first', promptTokens: 1_234 });
    expect(latest.promptChars).toBeGreaterThan(100);
});
