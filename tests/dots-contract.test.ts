// The dots contract: the tags other features will reach `dots/` through, and
// the factory that serves `DotAgents` the way `telegram/` and `context/` build
// their agents today.
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Effect, Layer } from 'effect';
import { type Observable, lastValueFrom, of, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { DotAgents, DotsConfig } from '../src/server/dots/contract.js';
import type { DotExtensions } from '../src/server/dots/contract.js';
import { DotAgentCore } from '../src/server/dots/dot-agent.js';

import { DotAgentFactory } from './helpers/dot-agent.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// The model call is replaced: the turn is assembled, its tools asked for, and
// the inner agent just finishes the run.
const inner = vi.hoisted(() => ({ run: vi.fn<(input: RunAgentInput) => Observable<BaseEvent>>() }));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
    const original = await importOriginal<typeof import('@copilotkit/runtime/v2')>();
    return {
        ...original,
        BuiltInAgent: class {
            run = inner.run;
            abortRun = vi.fn();
        },
    };
});

const databases: Array<{ close(): void }> = [];
afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
    inner.run.mockReset();
});

const config: PlatformConfig = {
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: 'https://unused.invalid',
    runtimeUrl: '',
    voiceName: 'marin',
    context: { selection: 'pointer' },
};

function fixture(extensions?: DotExtensions) {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    databases.push(store, workspace);
    return { workspace, factory: new DotAgentFactory(store, workspace, config, { extensions }) };
}

it('declares its tags under socio/dots', () => {
    expect(DotAgents.key).toBe('socio/dots/DotAgents');
    expect(DotsConfig.key).toBe('socio/dots/DotsConfig');
});

it('builds the agent a caller asks for: the Dot, a channel turn, and who it acts as', () => {
    const { workspace, factory } = fixture();
    const dot = workspace.dots()[0];
    const channel = factory.agent({ dotId: dot.id, channel: true, actingUserId: 'sender' });
    expect(channel).toBeInstanceOf(DotAgentCore);
    expect(channel.agentId).toBe(dot.id);
    expect((channel as DotAgentCore).turnActingUserId).toBe('sender');
    const own = factory.agent({ dotId: dot.id, channel: false });
    expect((own as DotAgentCore).turnActingUserId).toBeUndefined();
    expect(own).not.toBe(channel);
});

it('passes the channel flag on: the turn the modules see is a channel turn only when asked', async () => {
    const seen: DotTurn[] = [];
    const { workspace, factory } = fixture({ tools: (turn) => (seen.push(turn), []) });
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Test', 'owner');
    inner.run.mockImplementation(() => of({ type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' }));
    const input: RunAgentInput = {
        threadId: 'thread',
        runId: 'run',
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
    };
    for (const channel of [true, false]) {
        await lastValueFrom(factory.agent({ dotId: dot.id, channel }).run(input).pipe(toArray()));
    }
    expect(seen.map((turn) => turn.channel)).toEqual([true, false]);
});

it('serves the DotAgents tag, and PlatformConfig serves DotsConfig', async () => {
    const { workspace, factory } = fixture();
    const dot = workspace.dots()[0];
    const program = Effect.gen(function* () {
        const agents = yield* DotAgents;
        const dotsConfig = yield* DotsConfig;
        return { agent: agents.agent({ dotId: dot.id, channel: false }), context: dotsConfig.context };
    });
    const result = await Effect.runPromise(
        program.pipe(
            Effect.provide(Layer.mergeAll(Layer.succeed(DotAgents, factory), Layer.succeed(DotsConfig, config))),
        ),
    );
    expect(result.agent.agentId).toBe(dot.id);
    expect(result.context).toEqual({ selection: 'pointer' });
});
