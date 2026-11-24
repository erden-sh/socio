// Socio-actor access as tags, built by `actors/layer.ts` over the tags of the
// features it reads. A test swaps those features' layers for fakes.
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { RuntimeSession } from '@socio/data/runtime-ownership';
import { contextKey } from '@socio/foundation/actors/keys';

import { Actors, ActorsConfig, AppActors } from '../src/server/actors/contract.js';
import {
    ActorAccessTag,
    ActorsHost,
    ActorsLive,
    conversationState,
    type ActorsHostShape,
} from '../src/server/actors/layer.js';
import { ActorAccess } from '../src/server/actors/service.js';
import { actorsConfig, actorsHost, buildActors } from '../src/server/composition/actors.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import { Flags, type FlagsShape } from '../src/server/flags/contract.js';
import { RuntimeIdentity } from '../src/server/runtime/contract.js';
import type { LocalAgentRunner } from '../src/server/turns/local-runner.js';
import {
    Conversations,
    People,
    Socios,
    type AccessChange,
    type ConversationsShape,
    type PeopleShape,
    type SociosShape,
} from '../src/server/workspace/contract.js';

import type { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const SECRET = 'actors-layer-secret';

const dbs: DatabaseSync[] = [];
const built: ActorAccess[] = [];
afterEach(() => {
    for (const actors of built.splice(0)) {
        actors.stop();
    }
    for (const db of dbs.splice(0)) {
        db.close();
    }
    vi.restoreAllMocks();
});

function database() {
    const db = testDatabase();
    dbs.push(db);
    return db;
}

/** The conversations the fakes know, by id. */
const threads: Record<string, unknown> = {
    chat: { id: 'chat', kind: 'chat' },
    archived: { id: 'archived', kind: 'chat', archivedAt: 1 },
    room: { id: 'room', kind: 'room' },
    team: { id: 'team', kind: 'chat', team: 'T1' },
    topic: { id: 'topic', kind: 'chat' },
    dm: { id: 'dm', kind: 'chat' },
};

function fakeHost() {
    const listeners: Array<(change: AccessChange) => void> = [];
    const host: ActorsHostShape = {
        onAccessChange: (listener) => listeners.push(listener),
        task: async (id) => (id === 'live' ? { id } : undefined),
        threadInfo: async (id) => (id === 'topic' ? { kind: 'topic' } : id === 'dm' ? { kind: 'dm' } : undefined),
    };
    return { host, listeners };
}

function fakes(flagOn = true) {
    const { host, listeners } = fakeHost();
    const enabled = vi.fn((_flag: string, _userId: string) => flagOn);
    const layer = Layer.mergeAll(
        Layer.succeed(RuntimeIdentity, new RuntimeSession({ heartbeat: false })),
        Layer.succeed(ActorsConfig, { secret: SECRET }),
        Layer.succeed(People, { hasUser: () => true, isDeactivated: () => false } as unknown as PeopleShape),
        Layer.succeed(Socios, { canUseDot: () => true } as unknown as SociosShape),
        Layer.succeed(Conversations, {
            thread: (id: string) => threads[id],
        } as unknown as ConversationsShape),
        Layer.succeed(Flags, { enabled } as unknown as FlagsShape),
        Layer.succeed(ActorsHost, host),
    );
    return { layer, listeners, enabled };
}

const build = async (db: DatabaseSync, layer: ReturnType<typeof fakes>['layer']) => {
    const context = await Effect.runPromise(Layer.build(ActorsLive(db).pipe(Layer.provide(layer))).pipe(Effect.scoped));
    built.push(Context.get(context, ActorAccessTag));
    return context;
};

it('builds the service once, under its own tag and `Actors`, with `AppActors` over it', async () => {
    const { layer } = fakes();
    const context = await build(database(), layer);
    const actors = Context.get(context, ActorAccessTag);
    expect(actors).toBeInstanceOf(ActorAccess);
    expect(Context.get(context, Actors)).toBe(actors);
    const app = Context.get(context, AppActors);
    // `appActorAccess` over the same service: its registry, its secret.
    expect(app.audiences).toBe(actors.audiences);
    expect(app.contextKey('ctx-1')).toEqual(contextKey(SECRET, 'ctx-1'));
});

it('reads the flags from `Flags` at each check', async () => {
    const { layer, enabled } = fakes(false);
    const context = await build(database(), layer);
    const actors = Context.get(context, Actors);
    expect(actors.featureOn('alice')).toBe(false);
    expect(enabled).toHaveBeenCalledWith('socio-actor-access', 'alice');
});

it('re-checks grants on each access change, through one listener', async () => {
    const reevaluate = vi.spyOn(ActorAccess.prototype, 'reevaluate').mockResolvedValue([]);
    const { layer, listeners } = fakes();
    await build(database(), layer);
    expect(listeners).toHaveLength(1);
    listeners[0]!({ socioId: 'rulo' });
    expect(reevaluate).toHaveBeenCalledWith({ socioId: 'rulo' });
});

it('logs, and goes on, when a re-check after a change fails', async () => {
    vi.spyOn(ActorAccess.prototype, 'reevaluate').mockRejectedValue(new Error('boom'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { layer, listeners } = fakes();
    await build(database(), layer);
    listeners[0]!({ personId: 'alice' });
    await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith('Socio access: re-checking grants after a change failed.'),
    );
});

it('tells where a grant’s conversation stands, as before', async () => {
    const { host } = fakeHost();
    const deps = { conversations: { thread: (id: string) => threads[id] } as ConversationsShape, host };
    const states = await Promise.all(
        ['schedule:live', 'schedule:gone', 'missing', 'archived', 'room', 'team', 'topic', 'dm', 'chat'].map((id) =>
            conversationState(deps, id),
        ),
    );
    expect(states).toEqual([
        'schedule',
        'gone',
        'gone',
        'gone',
        'room',
        'telegram-group',
        'telegram-group',
        'private',
        'private',
    ]);
});

it('builds `ActorsConfig` from the keys the supplied config resolved', () => {
    expect(actorsConfig({ secret: 's3cret' })).toEqual({ secret: 's3cret' });
});

it('builds the same service for `Platform`’s constructor, over the boot step’s stores', () => {
    const db = database();
    const listeners: Array<(change: AccessChange) => void> = [];
    const workspace = {
        db,
        hasUser: () => true,
        isDeactivated: () => false,
        canUseDot: () => true,
        thread: () => undefined,
        telegram: { threadInfo: async () => undefined },
        onAccessChange: (listener: (change: AccessChange) => void) => listeners.push(listener),
    } as unknown as WorkspaceStore;
    const store = { task: async () => undefined } as unknown as Store;
    const runner = { runtime: new RuntimeSession({ heartbeat: false }) } as unknown as LocalAgentRunner;
    const flags = { enabled: () => true };
    const actors = buildActors({ store, workspace, runner, secret: SECRET, flags: () => flags as never });
    built.push(actors);
    expect(actors.contextKey('ctx-1')).toEqual(contextKey(SECRET, 'ctx-1'));
    expect(actors.featureOn('alice')).toBe(true);
    expect(listeners).toHaveLength(1);
    expect(Object.keys(actorsHost(workspace, store)).sort()).toEqual(['onAccessChange', 'task', 'threadInfo']);
});
