import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import {
    RUN_MODEL_EVENT,
    nextPhase,
    phaseText,
    startPhase,
    toolActivity,
    type RunPhase,
} from '@socio/shared/runs/run-phase';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { InferenceService } from '../src/server/inference/service.js';

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

it('keeps waiting while a steering message of the person’s goes in (CB-151)', () => {
    let phase: RunPhase = startPhase(0);
    phase = nextPhase(phase, { type: 'RUN_STARTED' }, 0);
    phase = nextPhase(phase, { type: 'TOOL_CALL_RESULT' }, 1_000);
    const waiting = phase;
    for (const event of [
        { type: 'TEXT_MESSAGE_START', messageId: 'q1', role: 'user' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'q1' },
        { type: 'TEXT_MESSAGE_END', messageId: 'q1' },
    ]) {
        phase = nextPhase(phase, event, 2_000);
    }
    expect(phase.kind).toBe('waiting');
    expect(phase.since).toBe(waiting.since);
    expect(phaseText(phase, 'Dot', 3_000)).toBe('Waiting for the model · 3 s');
    // The Dot's own answer after it is writing.
    phase = nextPhase(phase, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a2' }, 4_000);
    expect(phase.kind).toBe('answering');
});

it('follows a turn through its phases, timing each one', () => {
    const events = [
        [0, { type: 'RUN_STARTED' }],
        [
            100,
            {
                type: 'CUSTOM',
                name: RUN_MODEL_EVENT,
                value: { label: 'ChatGPT (Pro)', model: 'gpt-6.1-sol' },
            },
        ],
        [4_200, { type: 'REASONING_START' }],
        [9_000, { type: 'TOOL_CALL_START', toolCallName: 'computer_navigate' }],
        [12_000, { type: 'TOOL_CALL_RESULT' }],
        [15_000, { type: 'TEXT_MESSAGE_START' }],
    ] as const;
    let phase: RunPhase = startPhase(0);
    expect(phaseText(phase, 'Dot', 500)).toBe('Sending to Dot');
    const seen: string[] = [];
    for (const [at, event] of events) {
        phase = nextPhase(phase, event, at);
        seen.push(phaseText(phase, 'Dot', at + 2_000));
    }
    expect(seen).toEqual([
        'Waiting for the model · 2 s',
        // The model's name arrives; the wait keeps its start.
        'Waiting for ChatGPT (Pro) · gpt-6.1-sol · 2 s',
        'Dot is thinking · 2 s',
        'Using its computer · 2 s',
        'Waiting for ChatGPT (Pro) · gpt-6.1-sol · 2 s',
        'Dot is writing',
    ]);
    // More of the same keeps the phase (and its clock).
    const writing = phase;
    expect(nextPhase(writing, { type: 'TEXT_MESSAGE_CONTENT' }, 20_000)).toBe(writing);
    expect(nextPhase(writing, { type: 'STATE_SNAPSHOT' }, 20_000)).toBe(writing);
    // Another tool in a row restarts the clock under its own name.
    const first = nextPhase(writing, { type: 'TOOL_CALL_START', toolCallName: 'search_web' }, 1_000);
    const second = nextPhase(first, { type: 'TOOL_CALL_START', toolCallName: 'http_get' }, 3_000);
    expect(phaseText(second, 'Dot', 3_000)).toBe('Reading a web page');
});

it('names tools by what they do', () => {
    expect(toolActivity('computer_snapshot')).toBe('Using its computer');
    expect(toolActivity('search_web')).toBe('Searching the web');
    expect(toolActivity('unfurl_link')).toBe('Saving a link to a page');
    expect(toolActivity('read_space_page')).toBe('Working on pages');
    expect(toolActivity('request_capability')).toBe('Running request capability');
});

it('tells the client which model the turn runs on, right after RUN_STARTED', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    const store = new Store(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => workspace.close(),
        () => store.close(),
        () => runner.close(),
    );
    const inference = new InferenceService(workspace.db, {
        secret: 'run-phase-test-secret-0123456789',
        log: () => {},
    });
    await inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid/v1',
        model: 'qwen',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion({ role: 'assistant', content: 'Hi.' }));
    const dot = workspace.dots()[0];
    workspace.bindThread('t1', dot.id, 'Hi', 'bob');
    const config: PlatformConfig = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: 'run-phase-test-secret-0123456789',
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
    expect(events[0].type).toBe('RUN_STARTED');
    expect(events[1]).toMatchObject({
        type: 'CUSTOM',
        name: RUN_MODEL_EVENT,
        value: { label: 'Homelab', model: 'qwen' },
    });
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
});
