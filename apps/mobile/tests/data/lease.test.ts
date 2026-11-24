import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Store, workspaceKeyName, workspaceLayout } from '../../src/data';
import {
    enforceLeases,
    LEASE_LOCK_MS,
    LEASE_WIPE_MS,
    leaseDue,
    leaseLockAt,
    leaseWipeAt,
    MAX_POLICY_DAYS,
    MIN_LEASE_DAYS,
    MIN_WIPE_DAYS,
} from '../../src/data/lease';
import { readRootState } from '../../src/navigation/root-gate';
import { addWorkspace, launch, phone, type Phone } from '../helpers/store';

// The lease, with an injected
// clock over a real store: 30 days without contact locks the copy (the root
// gate shows the lock screen), 30 days after that lock it is wiped, an Ended
// copy keeps counting from its last contact, and a same-person sign-in starts
// it over.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const ORIGIN = 'https://brain.example.test';
const B_ORIGIN = 'https://b.example.test';

let device: Phone;
const stores: Store[] = [];

beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-lease-')));
});
afterEach(async () => {
    for (const store of stores.splice(0)) {
        await store.registry.close().catch(() => {});
    }
    rmSync(device.root, { recursive: true, force: true });
});

async function setUp() {
    let now = T0;
    const { store } = await launch(device, { now: () => now });
    stores.push(store);
    const clock = {
        get now() {
            return now;
        },
        set(at: number) {
            now = at;
        },
    };
    return { store, clock };
}

const enforce = (store: Store, at: number, calls: string[] = []) =>
    enforceLeases(store, {
        now: () => at,
        afterLock: (locked) => void calls.push(`locked ${locked.length}`),
        beforeWipe: (id) => void calls.push(`before wipe ${id.slice(0, 6)}`),
    });

describe('the lease', () => {
    it('counts from the last contact, else from when the workspace was added', () => {
        const row = { state: 'ready', createdAt: T0, lastContact: null, leaseLockedAt: null };
        expect(leaseDue(row, T0 + LEASE_LOCK_MS - 1)).toBe('none');
        expect(leaseDue(row, T0 + LEASE_LOCK_MS)).toBe('lock');
        expect(leaseDue({ ...row, lastContact: T0 + 5 * DAY }, T0 + LEASE_LOCK_MS)).toBe('none');
        expect(leaseDue({ ...row, leaseLockedAt: T0 + LEASE_LOCK_MS }, T0 + 59 * DAY)).toBe('none');
        expect(leaseDue({ ...row, leaseLockedAt: T0 + LEASE_LOCK_MS }, T0 + 60 * DAY)).toBe('wipe');
        expect(leaseWipeAt(row)).toBe(T0 + 60 * DAY);
        // Only a ready copy has a lease.
        expect(leaseDue({ ...row, state: 'wiping' }, T0 + 90 * DAY)).toBe('none');
    });

    it('locks at day 30 and the gate shows the lock screen; wipes at day 60, leaving nothing', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        await store.registry.setActive(ada.id);
        await store.registry.setLastContact(ada.id, T0);

        expect(await enforce(store, T0 + 29 * DAY)).toEqual({ locked: [], wiped: [], failed: [] });
        expect(await readRootState(store.registry)).toEqual({ active: { id: ada.id, locked: false } });

        const calls: string[] = [];
        expect(await enforce(store, T0 + 30 * DAY + 3 * 60_000, calls)).toEqual({
            locked: [ada.id],
            wiped: [],
            failed: [],
        });
        expect(calls).toEqual(['locked 1']);
        // The lock is put at the 30th day, so the wipe date doesn't move with when the app noticed.
        expect(await store.registry.session(ada.id)).toEqual({
            lastContact: T0,
            endedAt: null,
            leaseLockedAt: T0 + LEASE_LOCK_MS,
        });
        expect(await readRootState(store.registry)).toEqual({ active: { id: ada.id, locked: true } });

        // A second pass changes nothing until day 60.
        expect(await enforce(store, T0 + 59 * DAY)).toEqual({ locked: [], wiped: [], failed: [] });
        expect(await store.registry.get(ada.id)).toMatchObject({ leaseLockedAt: T0 + LEASE_LOCK_MS });

        calls.length = 0;
        expect(await enforce(store, T0 + 60 * DAY, calls)).toEqual({ locked: [], wiped: [ada.id], failed: [] });
        expect(calls).toEqual([`before wipe ${ada.id.slice(0, 6)}`]);
        expect(await store.registry.get(ada.id)).toBeNull();
        expect(existsSync(workspaceLayout(store.root, ada.id).directory)).toBe(false);
        expect(await store.keys.read(workspaceKeyName(ada.id, 'jar'))).toBeNull();
        expect(await readRootState(store.registry)).toEqual({ active: null });
    });

    it('wipes a phone left off past day 60 in one pass, at launch, and opens the workspace left', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const bea = await addWorkspace(store, B_ORIGIN, 'u-bea');
        await store.registry.setLastContact(bea.id, T0 + 50 * DAY);
        await store.registry.setActive(bea.id);
        await store.registry.setActive(ada.id);
        await store.registry.setLastContact(ada.id, T0);

        const calls: string[] = [];
        const result = await enforce(store, T0 + 61 * DAY, calls);
        expect(result).toEqual({ locked: [ada.id], wiped: [ada.id], failed: [] });
        // The lock first (the gate reads it), then the wipe.
        expect(calls).toEqual(['locked 1', `before wipe ${ada.id.slice(0, 6)}`]);
        expect(await store.registry.active()).toBe(bea.id);
        expect(await readRootState(store.registry)).toEqual({ active: { id: bea.id, locked: false } });
    });

    it('an Ended copy keeps counting from its last contact: locked by the lease at 30, wiped at 60', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        await store.registry.setActive(ada.id);
        await store.registry.setLastContact(ada.id, T0);
        // Ended on day 3: locked, and no contact since.
        await store.registry.setEnded(ada.id, T0 + 3 * DAY);
        await store.registry.setEnded(ada.id, T0 + 4 * DAY);
        expect(await store.registry.session(ada.id)).toEqual({
            lastContact: T0,
            endedAt: T0 + 3 * DAY,
            leaseLockedAt: null,
        });
        expect(await readRootState(store.registry)).toEqual({ active: { id: ada.id, locked: true } });

        expect((await enforce(store, T0 + 30 * DAY)).locked).toEqual([ada.id]);
        expect(await store.registry.session(ada.id)).toEqual({
            lastContact: T0,
            endedAt: T0 + 3 * DAY,
            leaseLockedAt: T0 + LEASE_LOCK_MS,
        });
        expect((await enforce(store, T0 + LEASE_LOCK_MS + LEASE_WIPE_MS)).wiped).toEqual([ada.id]);
        expect(await store.registry.get(ada.id)).toBeNull();
    });

    it('a same-person sign-in unlocks and starts the lease over', async () => {
        const { store, clock } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        await store.registry.setLastContact(ada.id, T0);
        await store.registry.setEnded(ada.id, T0 + DAY);
        await enforce(store, T0 + 40 * DAY);
        clock.set(T0 + 45 * DAY);
        await store.registry.setActive(ada.id, { signedIn: true });
        expect(await store.registry.session(ada.id)).toEqual({
            lastContact: T0 + 45 * DAY,
            endedAt: null,
            leaseLockedAt: null,
        });
        expect(await readRootState(store.registry)).toEqual({ active: { id: ada.id, locked: false } });
        expect(await enforce(store, T0 + 70 * DAY)).toEqual({ locked: [], wiped: [], failed: [] });
    });

    it('counts with the manifest’s policy when its server gave one, else 30 and 30', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const bob = await addWorkspace(store, B_ORIGIN, 'u-bob');
        await store.registry.setLastContact(ada.id, T0);
        await store.registry.setLastContact(bob.id, T0);
        await store.registry.setManifest(ada.id, { serverWorkspaceId: 'ws_a', leaseDays: 7, wipeDays: 8 });

        expect((await enforce(store, T0 + 7 * DAY - 1)).locked).toEqual([]);
        expect((await enforce(store, T0 + 7 * DAY)).locked).toEqual([ada.id]);
        expect(await store.registry.session(ada.id)).toMatchObject({ leaseLockedAt: T0 + 7 * DAY });
        // Bob's server had no manifest: still the app's 30 days.
        expect(await store.registry.session(bob.id)).toMatchObject({ leaseLockedAt: null });
        expect((await enforce(store, T0 + 15 * DAY - 1)).wiped).toEqual([]);
        expect((await enforce(store, T0 + 15 * DAY)).wiped).toEqual([ada.id]);
        expect(await store.registry.get(bob.id)).toMatchObject({ state: 'ready', leaseLockedAt: null });
    });

    it('holds a policy to a year at most, a day of lease and a week of wipe at least; one not in whole days is none', () => {
        const row = { state: 'ready', createdAt: T0, lastContact: null, leaseLockedAt: null };
        expect(leaseLockAt({ ...row, leaseDays: 10_000 })).toBe(T0 + MAX_POLICY_DAYS * DAY);
        expect(leaseLockAt({ ...row, leaseDays: 0 })).toBe(T0 + MIN_LEASE_DAYS * DAY);
        expect(leaseLockAt({ ...row, leaseDays: -3 })).toBe(T0 + MIN_LEASE_DAYS * DAY);
        expect(leaseLockAt({ ...row, leaseDays: 2.5 })).toBe(T0 + LEASE_LOCK_MS);
        // A manifest asking a 2-day wipe gets the app's floor of 7 (the outbox's guard).
        expect(leaseWipeAt({ ...row, leaseDays: 1, wipeDays: 2 })).toBe(T0 + (1 + MIN_WIPE_DAYS) * DAY);
        expect(leaseWipeAt({ ...row, leaseDays: 1, wipeDays: 9 })).toBe(T0 + 10 * DAY);
    });
});
