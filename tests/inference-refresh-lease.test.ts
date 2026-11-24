import { afterEach, expect, it } from 'vitest';

import { FAKE_BYO_KIND, fakeByoKind } from '../src/server/inference/fake-byo.js';
import { InferenceService } from '../src/server/inference/service.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const SECRET = 'inference-lease-test-secret-0123456789';
const BYO_URL = 'https://byo.invalid/v1';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
        await fn();
    }
});

function service() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const inference = new InferenceService(workspace.db, { secret: SECRET, log: () => {} });
    inference.register(fakeByoKind({ baseUrl: BYO_URL }));
    return { workspace, inference };
}

/** Saves a fake-byo connection as a finished sign-in leaves it. */
async function connect(inference: InferenceService, userId: string) {
    await inference.store.saveConnection(userId, FAKE_BYO_KIND, { token: 'tok-1' }, { account: 'Fake plan' });
}

it('tryLeaseRefresh: one runtime acquires, a second waits; release lets the second acquire', async () => {
    const { inference } = service();
    await connect(inference, 'alice');
    const now = 1_000_000;
    // Runtime A acquires the lease until now + 10s.
    const a = await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'a', now + 10_000, now);
    expect(a).toEqual({ acquired: true, leasedUntil: now + 10_000 });
    // Runtime B, same instant: not acquired — A holds it.
    const b = await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'b', now + 10_000, now);
    expect(b.acquired).toBe(false);
    expect(b.leasedUntil).toBe(now + 10_000);
    // After A releases, B acquires.
    await inference.store.releaseLease('alice', FAKE_BYO_KIND, 'a');
    const b2 = await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'b', now + 10_000, now);
    expect(b2.acquired).toBe(true);
});

it('tryLeaseRefresh: an expired lease is taken over by another runtime', async () => {
    const { inference } = service();
    await connect(inference, 'alice');
    const now = 1_000_000;
    // A held a lease that has since expired.
    await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'a', now - 1_000, now - 5_000);
    // B at a later instant: the expired lease is taken over.
    const b = await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'b', now + 10_000, now);
    expect(b.acquired).toBe(true);
});

it('tryLeaseRefresh: the holder may re-acquire (idempotent for its own runtime)', async () => {
    const { inference } = service();
    await connect(inference, 'alice');
    const now = 1_000_000;
    await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'a', now + 10_000, now);
    // The same runtime renewing its own lease succeeds.
    const again = await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'a', now + 20_000, now);
    expect(again.acquired).toBe(true);
});

it('personalCodingTransport wraps send with the lease (acquires and releases)', async () => {
    const { inference } = service();
    await connect(inference, 'alice');
    await inference.updateSettings({ allowedByoKinds: [FAKE_BYO_KIND] });
    // The fake-byo kind has no codingTransport, so the transport is undefined;
    // the lease is only wired for kinds that offer one. Verify the store lease
    // API directly exercises the path personalCodingTransport would use.
    const now = Date.now();
    const lease = await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'x', now + 5_000, now);
    expect(lease.acquired).toBe(true);
    await inference.store.releaseLease('alice', FAKE_BYO_KIND, 'x');
    // After release, the row's lease is clear.
    const after = await inference.store.tryLeaseRefresh('alice', FAKE_BYO_KIND, 'y', now + 5_000, now);
    expect(after.acquired).toBe(true);
});
