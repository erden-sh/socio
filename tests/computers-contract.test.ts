// The computers contract: the classes and functions serve the tag shapes, and
// the tags carry their `socio/computers/<Name>` keys.
import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { PlatformConfig } from '../src/server/composition/config.js';
import * as service from '../src/server/computers/computer-service.js';
import { ComputerService } from '../src/server/computers/computer-service.js';
import * as tools from '../src/server/computers/computer-tools.js';
import {
    ComputerRecords,
    ComputerWork,
    Computers,
    ComputersConfig,
    Screenshots,
    type ComputerWorkShape,
    type ComputersConfigShape,
    type ScreenshotsShape,
} from '../src/server/computers/contract.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

it('the tags carry their keys', () => {
    expect([Computers, ComputerRecords, ComputerWork, Screenshots, ComputersConfig].map((tag) => tag.key)).toEqual([
        'socio/computers/Computers',
        'socio/computers/ComputerRecords',
        'socio/computers/ComputerWork',
        'socio/computers/Screenshots',
        'socio/computers/ComputersConfig',
    ]);
});

it('a ComputerService and the workspace’s ComputerStore serve Computers and ComputerRecords', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const id = workspace.dots()[0].id;
    const config: PlatformConfig = { baseUrl: '', runtimeUrl: '', voiceName: 'marin' };
    const computers = new ComputerService(workspace, config, () => false);
    const layer = Layer.mergeAll(
        Layer.succeed(Computers, computers),
        Layer.succeed(ComputerRecords, workspace.computers),
        Layer.succeed(ComputersConfig, config satisfies ComputersConfigShape),
    );
    const read = await Effect.runPromise(
        Effect.gen(function* () {
            const served = yield* Computers;
            const records = yield* ComputerRecords;
            return {
                configured: served.configured,
                status: yield* Effect.promise(() => served.status(id)),
                permissions: yield* Effect.promise(() => records.permissions(id)),
                disk: served.disk.status().state,
            };
        }).pipe(Effect.provide(layer)),
    );
    expect(read.configured).toBe(false);
    expect(read.status.state).toBe('not_configured');
    expect(read.permissions).toEqual({ enabled: false, browser: false, files: false, shell: false });
    expect(read.disk).toBe('off');
});

it('today’s functions serve ComputerWork and Screenshots', async () => {
    const work: ComputerWorkShape = { inFlight: service.computerActionsInFlight, abort: service.abortComputerActions };
    const screenshots: ScreenshotsShape = { result: tools.screenshotResult };
    const layer = Layer.mergeAll(Layer.succeed(ComputerWork, work), Layer.succeed(Screenshots, screenshots));
    const read = await Effect.runPromise(
        Effect.gen(function* () {
            const inFlight = (yield* ComputerWork).inFlight();
            const served = yield* Screenshots;
            const shot = yield* Effect.promise(() => served.result({}, undefined));
            return { inFlight, shot };
        }).pipe(Effect.provide(layer)),
    );
    expect(read.inFlight).toBe(0);
    expect(read.shot).toEqual({ error: 'The computer sent no image.' });
});
