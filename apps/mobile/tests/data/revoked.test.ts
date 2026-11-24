import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    createRevokedWipes,
    type Store,
    wipeRevoked,
    workspaceKeyName,
    workspaceKeyNames,
    workspaceLayout,
} from '../../src/data';
import { createScopeHolds } from '../../src/sync/scope-holds';
import { addWorkspace, launch, phone, type Phone } from '../helpers/store';
import { deferred } from '../net/helpers';

// The silent wipe a 401 asks for (the server's `device_revoked` and
// `deactivated` codes): the scope stopped first, the row read again (only a copy
// still ready and locked is wiped), the copy wiped through wipe() with its
// install id, the memory caches cleared, and the most recently used workspace
// left opens. Nothing is sent: the server already ended the session. Then
// the platform's wiring: one wipe per workspace, after the lease pass, with
// its scope held and released, and the gate read again.

let device: Phone;
const stores: Store[] = [];
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-revoked-')));
});
afterEach(async () => {
    for (const store of stores.splice(0)) {
        await store.registry.close().catch(() => {});
    }
    rmSync(device.root, { recursive: true, force: true });
});

/** Two workspaces, Ada active and locked by the scope as the 401 came. */
async function twoCopies() {
    let clock = 1_000;
    const { store } = await launch(device, { now: () => (clock += 1000) });
    stores.push(store);
    const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
    const bob = await addWorkspace(store, 'https://bob.example.test', 'u-bob');
    await store.registry.setActive(bob.id);
    await store.registry.setActive(ada.id);
    await store.registry.setEnded(ada.id, clock);
    return { store, ada, bob };
}

describe('wipeRevoked', () => {
    it.each(['device-revoked', 'deactivated'] as const)(
        '%s wipes the locked copy, its install id included, and opens the workspace used last',
        async (end) => {
            const { store, ada, bob } = await twoCopies();
            const events: string[] = [];
            expect(await store.keys.read(workspaceKeyName(ada.id, 'install'))).not.toBeNull();

            const result = await wipeRevoked(
                {
                    store,
                    stopScope: async () => void events.push('scope stopped'),
                    clearImageMemory: async () => void events.push('images'),
                    clearWebViewData: async () => void events.push('webviews'),
                    wipeOptions: { afterStep: (step) => void events.push(step) },
                },
                ada.id,
                end,
            );

            expect(result).toBe('wiped');
            expect(events[0]).toBe('scope stopped');
            expect(events.slice(-3)).toEqual(['verified', 'images', 'webviews']);
            expect(await store.registry.get(ada.id)).toBeNull();
            expect(existsSync(workspaceLayout(store.root, ada.id).directory)).toBe(false);
            for (const name of workspaceKeyNames(ada.id)) {
                expect(device.keychain.has(name)).toBe(false);
            }
            expect(await store.keys.indexed()).not.toContain(workspaceKeyName(ada.id, 'install'));
            expect(await store.registry.active()).toBe(bob.id);
            expect(await store.keys.read(workspaceKeyName(bob.id, 'install'))).not.toBeNull();
        },
    );

    it('skips a copy signed in again while its scope stopped: the fresh sign-in cleared the lock', async () => {
        const { store, ada } = await twoCopies();
        const result = await wipeRevoked(
            {
                store,
                // The person signed in again meanwhile: the same-person commit unlocks the copy.
                stopScope: () => store.registry.setActive(ada.id, { signedIn: true }),
            },
            ada.id,
            'device-revoked',
        );
        expect(result).toBe('skipped');
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'ready', endedAt: null });
        expect(device.keychain.has(workspaceKeyName(ada.id, 'install'))).toBe(true);
    });

    it('skips a copy that was never locked, or is gone or being wiped already', async () => {
        const { store, bob, ada } = await twoCopies();
        expect(await wipeRevoked({ store, stopScope: async () => {} }, bob.id, 'deactivated')).toBe('skipped');
        expect(await store.registry.get(bob.id)).toMatchObject({ state: 'ready' });
        await store.registry.markWiping(ada.id, 'lease');
        expect(await wipeRevoked({ store, stopScope: async () => {} }, ada.id, 'deactivated')).toBe('skipped');
        expect(await store.registry.get(ada.id)).toMatchObject({ wipeReason: 'lease' });
    });

    it('a wipe that fails stays marked with its reason, for the next launch', async () => {
        const { store, ada } = await twoCopies();
        await expect(
            wipeRevoked(
                {
                    store,
                    stopScope: async () => {},
                    wipeOptions: {
                        afterStep: (step) => {
                            if (step === 'closed') {
                                throw new Error('killed');
                            }
                        },
                    },
                },
                ada.id,
                'device-revoked',
            ),
        ).rejects.toThrow('killed');
        expect(await store.registry.get(ada.id)).toMatchObject({ state: 'wiping', wipeReason: 'device-revoked' });
        await store.registry.close();
        const again = await launch(device);
        stores.push(again.store);
        expect(again.launch.wiped).toEqual([{ id: ada.id, reason: 'device-revoked' }]);
        expect(device.keychain.has(workspaceKeyName(ada.id, 'install'))).toBe(false);
    });
});

describe('the platform’s silent wipes (createRevokedWipes)', () => {
    function wiring(store: Store | null, lease: Promise<unknown> | null = null, onHold = async () => {}) {
        const events: string[] = [];
        const holds = createScopeHolds();
        const request = createRevokedWipes({
            store: () => store,
            leasePass: () => lease,
            holdScope: async (id) => {
                holds.hold(id);
                events.push(`hold ${id.slice(0, 4)}`);
                await onHold();
            },
            releaseScope: async (id) => {
                holds.release(id);
                events.push(`release ${id.slice(0, 4)}`);
            },
            refresh: async () => void events.push('refresh'),
            onError: (error) => void events.push(`error ${(error as Error).message}`),
        });
        return { events, holds, request };
    }

    it('waits for the lease pass running, holds the scope, wipes, reads the gate, then releases', async () => {
        const { store, ada } = await twoCopies();
        const lease = deferred();
        const { events, holds, request } = wiring(store, lease.promise);
        const done = request(ada.id, 'device-revoked');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events).toEqual([]);
        lease.resolve();
        await done;
        expect(events).toEqual([`hold ${ada.id.slice(0, 4)}`, 'refresh', `release ${ada.id.slice(0, 4)}`]);
        expect(holds.isHeld(ada.id)).toBe(false);
        expect(await store.registry.get(ada.id)).toBeNull();
    });

    it('runs one wipe per workspace: a second ask while one runs joins it', async () => {
        const { store, ada } = await twoCopies();
        const { events, request } = wiring(store);
        const first = request(ada.id, 'device-revoked');
        const second = request(ada.id, 'deactivated');
        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(events.filter((event) => event.startsWith('hold'))).toHaveLength(1);
        // Done: a later ask runs again, and finds nothing left to wipe.
        await request(ada.id, 'device-revoked');
        expect(events.filter((event) => event.startsWith('hold'))).toHaveLength(2);
    });

    it('releases the hold and reads the gate after a failed wipe too, and never rejects', async () => {
        const { store, ada } = await twoCopies();
        // The registry goes away once the scope is held: reading the row again fails.
        const { events, holds, request } = wiring(store, null, () => store.registry.close());
        await expect(request(ada.id, 'device-revoked')).resolves.toBeUndefined();
        expect(events[0]).toBe(`hold ${ada.id.slice(0, 4)}`);
        expect(events.some((event) => event.startsWith('error'))).toBe(true);
        expect(events.slice(-2)).toEqual(['refresh', `release ${ada.id.slice(0, 4)}`]);
        expect(holds.isHeld(ada.id)).toBe(false);
    });

    it('does nothing before the store has opened', async () => {
        const { events, request } = wiring(null);
        await request('a'.repeat(64), 'deactivated');
        expect(events).toEqual([]);
    });

    it('is bound once launch starts the lease, and the scope’s wiping 401s reach it', () => {
        const source = (name: string) => readFileSync(new URL(`../../src/platform/${name}`, import.meta.url), 'utf8');
        const session = source('session.ts');
        const startLeases = session.slice(session.indexOf('export async function startLeases'));
        expect(startLeases).toMatch(/copyRevoked\.add\(\(id, end\) => void wipeRevokedCopy\(id, end\)\)/);
        expect(session).toMatch(/leasePass: \(\) => running/);
        expect(session).toMatch(/releaseScope,/);
        const active = source('active-scope.ts');
        expect(active).toMatch(/end === 'device-revoked' \|\| end === 'deactivated'[\s\S]{0,120}copyRevoked/);
    });
});

describe('scope holds', () => {
    it('count per workspace: one release never drops another hold', () => {
        const holds = createScopeHolds();
        holds.hold('a');
        holds.hold('a');
        holds.hold('b');
        holds.release('a');
        expect(holds.isHeld('a')).toBe(true);
        holds.release('b');
        expect(holds.isHeld('a')).toBe(true);
        expect(holds.isHeld('b')).toBe(false);
        holds.release('a');
        holds.release('a');
        expect(holds.isHeld('a')).toBe(false);
        holds.hold('a');
        expect(holds.isHeld('a')).toBe(true);
    });
});
