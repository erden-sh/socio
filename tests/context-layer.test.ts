// The context's layer offers its stores and the steering turns under their
// tags, the turns built from other features' tags, and the composition's
// bridges step builds ContextConfig from the startup configuration.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { LegacyConfig, LegacyWorkspace } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { contextLayers, LegacySteering } from '../src/server/composition/context.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import {
    ChatNotes,
    ContextConfig,
    ContextFitting,
    DotReplies,
    Reactions,
    Steering,
    TimeMarkers,
    WaitingTurns,
} from '../src/server/context/contract.js';
import { contextFitting } from '../src/server/context/fit.js';
import { ContextStoresLive, SteeringTurnsLive, type SteeringLate } from '../src/server/context/layer.js';
import { contextNotes } from '../src/server/context/notes.js';
import { messageReactions } from '../src/server/context/reactions.js';
import { SteeringTurns } from '../src/server/context/steering-turns.js';
import { steeringQueue } from '../src/server/context/steering.js';
import { timeMarkers } from '../src/server/context/time-markers.js';
import { Cycles, type CyclesShape } from '../src/server/cycles/contract.js';
import type { DotAgentRequest } from '../src/server/dots/contract.js';
import { Media, type MediaShape } from '../src/server/media/contract.js';
import { Orchestrator, type OrchestratorShape } from '../src/server/rooms/contract.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';
import { Runner, type RunnerShape } from '../src/server/turns/contract.js';
import {
    Conversations,
    People,
    Socios,
    type ConversationsShape,
    type PeopleShape,
    type SociosShape,
} from '../src/server/workspace/contract.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

function database() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return db;
}

it('offers the stores on the connection and the fitting under their tags', async () => {
    const db = database();
    const context = await Effect.runPromise(Layer.build(ContextStoresLive(db)).pipe(Effect.scoped));
    expect(Context.get(context, ChatNotes)).toBe(contextNotes(db));
    expect(Context.get(context, TimeMarkers)).toBe(timeMarkers(db));
    expect(Context.get(context, Steering)).toBe(steeringQueue(db));
    expect(Context.get(context, Reactions)).toBe(messageReactions(db));
    expect(Context.get(context, ContextFitting)).toBe(contextFitting);
});

it("builds the bridges step's ContextConfig from the startup configuration, and the turns as WaitingTurns", async () => {
    const db = database();
    const turns = { turn: () => undefined } as unknown as SteeringTurns;
    const layer = contextLayers.bridges.pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(LegacyConfig, { context: { selection: 'pointer' } } as PlatformConfig),
                Layer.succeed(LegacyWorkspace, { db } as WorkspaceStore),
                Layer.succeed(Runner, { rowsMentioning: () => [] } as unknown as RunnerShape),
                Layer.succeed(LegacySteering, turns),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    expect(Context.get(context, ContextConfig)).toEqual({ context: { selection: 'pointer' } });
    expect(Context.get(context, WaitingTurns)).toBe(turns);
    expect(Context.get(context, ChatNotes)).toBe(contextNotes(db));
    expect(await Context.get(context, DotReplies).find('t', 'm')).toBeUndefined();
});

/** The tags the steering turns read, as fakes; what they did is recorded. */
function steeringGraph(options: { draining?: boolean } = {}) {
    const db = database();
    const seen: string[] = [];
    const requests: DotAgentRequest[] = [];
    const runs: unknown[] = [];
    const finished: Array<(...args: never[]) => void> = [];
    const runner = {
        onRunFinished: (listener: (...args: never[]) => void) => finished.push(listener),
        knownMessageIds: () => new Set<string>(),
        activeRunId: () => undefined,
        run: (request: unknown) => {
            runs.push(request);
            return { subscribe: () => undefined };
        },
    } as unknown as RunnerShape;
    const thread = { id: 't1', dotId: 'd1', ownerId: 'alice', title: 'Chat', createdAt: 0, updatedAt: 0 };
    const agent = {
        threadId: '',
        messages: [] as unknown[],
        setMessages(messages: unknown[]) {
            this.messages = messages;
        },
    };
    const late: SteeringLate = {
        draining: () => options.draining ?? false,
        setup: async () => ({ missing: [] }) as never,
        log: (line) => seen.push(line),
        links: { threadInfo: async () => undefined },
        agents: {
            agent: (request: DotAgentRequest) => {
                requests.push(request);
                return agent as never;
            },
        },
    };
    const layer = SteeringTurnsLive(late).pipe(
        Layer.provide(
            Layer.mergeAll(
                ContextStoresLive(db),
                Layer.succeed(Runner, runner),
                Layer.succeed(Conversations, {
                    thread: (id: string) => (id === 't1' ? thread : undefined),
                } as unknown as ConversationsShape),
                Layer.succeed(Socios, { dot: (id: string) => ({ id, name: 'Dot' }) } as unknown as SociosShape),
                Layer.succeed(People, {
                    users: () => [{ id: 'alice', name: 'Alice', role: 'member' }],
                } as unknown as PeopleShape),
                Layer.succeed(WorkspaceSettings, { settings: () => ({}) } as unknown as WorkspaceSettingsShape),
                Layer.succeed(Orchestrator, {
                    waiting: async () => false,
                    route: () => ['d1'],
                    queueNamed: async () => undefined,
                    dropAfter: async () => undefined,
                } as unknown as OrchestratorShape),
                Layer.succeed(Cycles, {
                    limitsFor: async () => ({ handoffsPerCycle: 0 }),
                    mayDispatch: async () => true,
                } as unknown as CyclesShape),
                Layer.succeed(Media, { bindNew: async () => undefined } as unknown as MediaShape),
            ),
        ),
    );
    return { db, layer, seen, requests, runs, finished, agent };
}

it('builds the steering turns from the tags, and starts a waiting turn with the Dots’ agent', async () => {
    const graph = steeringGraph();
    const context = await Effect.runPromise(Layer.build(graph.layer).pipe(Effect.scoped));
    const turns = Context.get(context, WaitingTurns);
    expect(turns).toBeInstanceOf(SteeringTurns);
    // It listens for the runner's ends as it is built, as before.
    expect(graph.finished).toHaveLength(1);
    await steeringQueue(graph.db).add('t1', 'alice', 'one more thing', 1);
    expect(await turns.consider('t1')).toBe(true);
    // The chat's owner's own turn: no acting person.
    expect(graph.requests).toEqual([{ dotId: 'd1', channel: false, actingUserId: undefined }]);
    expect(graph.agent.threadId).toBe('t1');
    expect(graph.runs).toHaveLength(1);
    expect(await steeringQueue(graph.db).list('t1', 'alice')).toEqual([]);
});

it('starts no turn while the server drains', async () => {
    const graph = steeringGraph({ draining: true });
    const context = await Effect.runPromise(Layer.build(graph.layer).pipe(Effect.scoped));
    await steeringQueue(graph.db).add('t1', 'alice', 'later', 1);
    expect(await Context.get(context, WaitingTurns).consider('t1')).toBe(false);
    expect(graph.requests).toEqual([]);
    expect(await steeringQueue(graph.db).list('t1', 'alice')).toHaveLength(1);
});
