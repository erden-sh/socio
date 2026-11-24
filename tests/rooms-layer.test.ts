// Rooms' services as layers (rooms/layer.ts), over the tags of the features
// below it and the two inputs it declares (`RoomsWorkspace`, `RoomsHost`).
// Each contract tag holds the very instance its class tag holds, and the
// switch reads the settings and `RoomsConfig`.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { Cycles, type CyclesShape } from '../src/server/cycles/contract.js';
import { Access, Rooms, RoomsConfig, Streams, Topics } from '../src/server/rooms/contract.js';
import {
    LegacyRooms,
    LegacyRoomStreams,
    LegacyRoomTopics,
    RoomMembershipLive,
    RoomsBaseLive,
    RoomsHost,
    RoomStreamsLive,
    RoomsSwitch,
    RoomsWorkspace,
    RoomTopicsLive,
} from '../src/server/rooms/layer.js';
import { Limits, WorkspaceSettings } from '../src/server/settings/contract.js';
import { limitsFor } from '../src/server/settings/limits.js';
import { Runner } from '../src/server/turns/contract.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function boot() {
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    return { workspace, store, runner };
}

it('builds each service once, under its contract tag and its class tag', async () => {
    const { workspace, store, runner } = boot();
    // Membership only keeps the cycles for a room admin's limits and use.
    const cycles = {} as CyclesShape;
    const host = RoomsHost.of({
        revoke: vi.fn(async () => undefined),
        turnOutcome: vi.fn(async () => undefined),
        draining: () => false,
        settled: vi.fn(),
        invited: vi.fn(),
        isService: () => false,
        queued: async () => new Set<string>(),
    });
    const inputs = Layer.mergeAll(
        Layer.succeed(RoomsWorkspace, workspace),
        Layer.succeed(RoomsHost, host),
        Layer.succeed(WorkspaceSettings, store.slices.settings),
        Layer.succeed(Limits, limitsFor({} as never)),
        Layer.succeed(RoomsConfig, RoomsConfig.of({ rooms: { enabled: true } })),
        Layer.succeed(Runner, runner),
        Layer.succeed(Cycles, cycles),
    );
    const layer = RoomTopicsLive.pipe(
        Layer.provideMerge(RoomMembershipLive),
        Layer.provideMerge(RoomStreamsLive),
        Layer.provideMerge(RoomsBaseLive),
        Layer.provideMerge(inputs),
    );
    const context = await Effect.runPromise(Effect.scoped(Layer.build(layer)));
    expect(Context.get(context, Rooms)).toBe(Context.get(context, LegacyRooms));
    expect(Context.get(context, Streams)).toBe(Context.get(context, LegacyRoomStreams));
    expect(Context.get(context, Topics)).toBe(Context.get(context, LegacyRoomTopics));
    expect(Context.get(context, Access)).toBe(workspace.roomAccess);
    // The switch: `RoomsConfig` under an admin's setting, and the rule reads it.
    expect(Context.get(context, RoomsSwitch)()).toBe(true);
    expect(workspace.roomAccess.enabled()).toBe(true);
    await store.updateSettings({ rooms: { enabled: false } });
    expect(workspace.roomAccess.enabled()).toBe(false);
    Context.get(context, LegacyRoomStreams).stop();
});
