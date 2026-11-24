import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { DataKeyAdmin } from '../src/server/composition/app/data-keys.js';
import { AdminNotices } from '../src/server/composition/app/notices.js';
import { AppStatus } from '../src/server/composition/app/status.js';
import { Ports } from '../src/server/composition/ports.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

async function runtime() {
    const t = await makeTestRuntime();
    disposers.push(t.dispose);
    return t;
}

it("delegates Platform's status, data keys and notices to one service each per runtime", async () => {
    const { edge, platform } = await runtime();
    const status = Context.get(edge.services, AppStatus);
    const keys = Context.get(edge.services, DataKeyAdmin);
    const notices = Context.get(edge.services, AdminNotices);

    const setup = vi.spyOn(status, 'setup');
    const health = vi.spyOn(status, 'health');
    const epoch = vi.spyOn(status, 'statusEpoch');
    const keyStatus = vi.spyOn(keys, 'status');
    const notifyOperators = vi.spyOn(notices, 'notifyOperators');

    await platform.setup('alice');
    expect(setup).toHaveBeenCalledWith('alice');
    await platform.health();
    expect(health).toHaveBeenCalledOnce();
    expect(platform.statusEpoch()).toBe(status.statusEpoch());
    expect(epoch).toHaveBeenCalledTimes(2);
    await platform.dataKeyStatus();
    // `health` reads the data key too: the same service.
    expect(keyStatus).toHaveBeenCalledTimes(2);
    await platform.notifyOperators({ trigger: 't', title: 'T', message: 'M', path: '/' });
    expect(notifyOperators).toHaveBeenCalledOnce();
});

it('keeps one re-seal run: the facade and the service hand out the same promise', async () => {
    const { edge, platform } = await runtime();
    const keys = Context.get(edge.services, DataKeyAdmin);
    const first = platform.resealData();
    expect(keys.reseal()).toBe(first);
    expect(keys.resealing).toBe(true);
    await first;
    expect(keys.resealing).toBe(false);
});

it("fills the setup port with the status's setup", async () => {
    const { edge } = await runtime();
    const status = Context.get(edge.services, AppStatus);
    const setup = vi.spyOn(status, 'setup');
    const port = Context.get(edge.services, Ports).setup.get();
    expect(await port.setup('bob')).toEqual(await status.setup('bob'));
    expect(setup).toHaveBeenCalledTimes(2);
    expect(setup).toHaveBeenNthCalledWith(1, 'bob');
});
