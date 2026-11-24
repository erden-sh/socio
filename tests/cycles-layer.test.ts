// The work cycles' layer and the composition's step build one `WorkCycles`,
// offered under every tag, from `CycleSources`, which the step fills from the
// workspace's slices, the settings and the runner.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { RoomLimits } from '@socio/shared/rooms/rooms';

import { LegacyConfig, LegacyRunner, LegacyStore, LegacyWorkspace } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { cyclesLayers, LegacyCycles } from '../src/server/composition/cycles.js';
import { settingsLayers } from '../src/server/composition/settings.js';
import { CycleSources, Cycles, CycleUpkeep, type CycleSourcesShape } from '../src/server/cycles/contract.js';
import { CyclesLive } from '../src/server/cycles/layer.js';
import { WorkCycles } from '../src/server/cycles/service.js';
import { sqliteCycles } from '../src/server/cycles/services.js';
import { cycleLimits } from '../src/server/settings/limits.js';
import { Runner } from '../src/server/turns/contract.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
    vi.restoreAllMocks();
});

function workspaceStore() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    return workspace;
}

const LIMITS: RoomLimits = {
    cycleTimeMs: 300_000,
    cycleTokens: 400_000,
    messagesPerMinute: 20,
    maxQueued: 5,
    handoffsPerCycle: 4,
    cycleSpendUsd: null,
};

/**
 * What a stopped process left on `db`: a running step in each of `chats`,
 * never ended. Returns each one's cycle id.
 */
async function leftRunning(db: WorkspaceStore['db'], chats: string[]) {
    const before = sqliteCycles(db, {
        conversation: (id) => ({ id, dotId: 'dot', ownerId: 'alice' }),
        socio: (id) => ({ id }),
        limits: () => LIMITS,
    });
    const ids: Record<string, string> = {};
    for (const chat of chats) {
        const admission = await before.begin({
            conversationId: chat,
            runId: `run-${chat}`,
            dotId: 'dot',
            trigger: { kind: 'person', id: 'alice' },
        });
        if (!admission.ok || !admission.step) {
            throw new Error(`refused: ${JSON.stringify(admission)}`);
        }
        ids[chat] = admission.step.id;
    }
    await before.tick();
    return ids;
}

it('offers one service as Cycles and CycleUpkeep, over CycleSources', async () => {
    const workspace = workspaceStore();
    const sources: CycleSourcesShape = {
        conversation: (id) => (id === 'chat' ? { id, dotId: 'dot', ownerId: 'alice' } : undefined),
        socio: (id) => ({ id }),
        limits: () => LIMITS,
        alive: vi.fn(() => false),
    };
    const layer = CyclesLive(workspace.db).pipe(Layer.provide(Layer.succeed(CycleSources, sources)));
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const cycles = Context.get(context, Cycles);
    expect(cycles).toBeInstanceOf(WorkCycles);
    expect(Context.get(context, CycleUpkeep)).toBe(cycles);
    expect(await cycles.limitsFor('chat')).toEqual(LIMITS);
    expect(await cycles.withinRate('chat')).toBe(true);
    await Context.get(context, CycleUpkeep).tick();
});

it("builds the graph's step from the slices, the settings and the runner, and gates the runner", async () => {
    const workspace = workspaceStore();
    const store = new Store(workspace.db);
    cleanup.push(() => store.close());
    const ids = await leftRunning(workspace.db, ['live', 'dead']);
    const runner = new LocalAgentRunner(testDatabase());
    const gate = vi.spyOn(runner, 'setCycleGate');
    // Another runtime still runs `live`'s step (a start-first deploy, CB-108); `dead`'s process is gone.
    const alive = vi.spyOn(runner, 'turnAlive').mockImplementation((runId) => runId === 'run-live');
    const config = { roomCycleTokens: 123_456 } as PlatformConfig;
    // The settings' tags are the graph's leaf bridges, built before this step.
    const layer = cyclesLayers.cycles.pipe(
        Layer.provide(settingsLayers.bridges),
        Layer.provide(
            Layer.mergeAll(
                WorkspaceLive(workspace),
                Layer.succeed(LegacyWorkspace, workspace),
                Layer.succeed(LegacyStore, store),
                Layer.succeed(LegacyConfig, config),
                Layer.succeed(LegacyRunner, runner),
                Layer.succeed(Runner, runner),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const cycles = Context.get(context, LegacyCycles);
    expect(cycles).toBeInstanceOf(WorkCycles);
    expect(Context.get(context, Cycles)).toBe(cycles);
    expect(Context.get(context, CycleUpkeep)).toBe(cycles);
    // Only the cycles' own tags leave the step: its sources stay inside.
    expect(Context.getOrUndefined(context, CycleSources)).toBeUndefined();
    expect(gate).toHaveBeenCalledExactlyOnceWith(cycles);
    // The workspace's limits in force, as the cycles' step reads them.
    const limits = await cycles.limitsFor('none');
    expect(limits).toEqual(cycleLimits(store.settings(), config));
    expect(limits.cycleTokens).toBe(123_456);
    // The start's reconciliation ran on its own, with no call to `recover`:
    // the live runtime's step is left running, the dead process's parked.
    await vi.waitFor(async () => expect((await cycles.cycle(ids.dead))?.status).toBe('waiting'));
    expect(await cycles.cycle(ids.dead)).toMatchObject({ status: 'waiting', runId: null });
    expect(await cycles.cycle(ids.live)).toMatchObject({ status: 'running', runId: 'run-live' });
    expect(alive).toHaveBeenCalledWith('run-live');
    expect(alive).toHaveBeenCalledWith('run-dead');
});
