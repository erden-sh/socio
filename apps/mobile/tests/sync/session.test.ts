import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Store, workspaceKeyName } from '../../src/data';
import { readRootState } from '../../src/navigation/root-gate';
import type { SessionEnd } from '../../src/net/session';
import { COALESCE_MS, SHELL_POLL_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { createSessionWatch, writeHold } from '../../src/sync/session';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, DAY, ORIGIN, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, WIFI } from './fakes';
import { fakeWorkspaceServer } from './helpers';
import { signedIn, wire } from './wire';

// The open workspace's session states, over a real store and the fake
// workspace server, on fake timers: a 401 before the stored expiry is Ended
// (the registry locks the copy, sync stops, the app hears it); a 401 after it
// is Expired (readable, writes held, nothing locked); and the expiry passing
// with no request shows Expired on time.

let device: Phone;
const scopes: WorkspaceScope[] = [];
const stores: Store[] = [];

beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-session-')));
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(async () => {
    for (const scope of scopes.splice(0)) {
        await scope.dispose();
    }
    for (const store of stores.splice(0)) {
        await store.registry.close().catch(() => {});
    }
    vi.useRealTimers();
    rmSync(device.root, { recursive: true, force: true });
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function setup() {
    const { store } = await launch(device);
    stores.push(store);
    const clock = clocks();
    const server = fakeWorkspaceServer(clock);
    const net = wire(new Map([[ORIGIN, server]]));
    const id = await signedIn(store, ORIGIN, server, clock);
    await store.registry.setActive(id);
    const ends: SessionEnd[] = [];
    const scope = await openWorkspaceScope({
        store,
        workspaceId: id,
        fetch: net.fetch,
        userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
        variant: 'production',
        appState: fakeAppState('active'),
        network: fakeNetwork(WIFI),
        onUnauthorized: (end) => void ends.push(end),
        onError: () => {},
        random: () => 0.5,
    });
    scopes.push(scope);
    return { store, clock, server, net, id, scope, ends };
}

describe('the session states', () => {
    it('a 401 before the stored expiry is Ended: the copy locks, sync stops, the app hears it', async () => {
        const s = await setup();
        s.scope.start();
        await advance(COALESCE_MS);
        await s.scope.scheduler.idle();
        expect(s.scope.session.state()).toBe('signed-in');
        expect(await readRootState(s.store.registry)).toEqual({ active: { id: s.id, locked: false } });

        // Sign-out everywhere, on day 2: the session's stored expiry is still days ahead.
        vi.setSystemTime(T0 + 2 * DAY);
        s.clock.server = T0 + 2 * DAY;
        s.server.end();
        s.scope.scheduler.poke();
        await advance(COALESCE_MS);
        await s.scope.scheduler.idle();

        expect(s.ends).toContain('ended');
        expect(s.ends).not.toContain('expired');
        expect(await s.store.registry.session(s.id)).toMatchObject({
            endedAt: T0 + 2 * DAY + COALESCE_MS,
            leaseLockedAt: null,
        });
        expect(await readRootState(s.store.registry)).toEqual({ active: { id: s.id, locked: true } });
        // Not Expired: the lock screen says it, not the banner.
        expect(s.scope.session.state()).toBe('signed-in');
        // Sync stopped: no more requests while the gate closes the scope.
        const calls = s.net.calls.length;
        await advance(SHELL_POLL_MS * 4);
        expect(s.net.calls.length).toBe(calls);
    });

    it('the stored expiry passing is Expired with no request, and a 401 after it locks nothing', async () => {
        const s = await setup();
        const changes: string[] = [];
        s.scope.session.subscribe(() => changes.push(s.scope.session.state()));
        expect(s.scope.session.state()).toBe('signed-in');
        expect(writeHold(s.scope.session.state(), s.scope.versions.gate())).toBeNull();

        // A week idle, offline: the watch's own timer notices.
        await advance(7 * DAY - 1000);
        expect(s.scope.session.state()).toBe('signed-in');
        await advance(1000);
        expect(s.scope.session.state()).toBe('expired');
        expect(changes).toEqual(['expired']);
        expect(writeHold(s.scope.session.state(), s.scope.versions.gate())).toBe('sign-in');

        // Back online: the server answers 401, after the stored expiry.
        s.clock.server = Date.now();
        s.scope.start();
        await advance(COALESCE_MS);
        await s.scope.scheduler.idle();
        expect(s.ends.length).toBeGreaterThan(0);
        expect(new Set(s.ends)).toEqual(new Set(['expired']));
        expect(await s.store.registry.session(s.id)).toMatchObject({ endedAt: null, leaseLockedAt: null });
        expect(await readRootState(s.store.registry)).toEqual({ active: { id: s.id, locked: false } });
        expect(s.scope.session.state()).toBe('expired');
    });
});

describe('the server’s 401 codes through the open scope', () => {
    /** Ends the session with `code` on day 2, a pull goes, and what the scope did. */
    async function endWith(code: string) {
        const s = await setup();
        s.scope.start();
        await advance(COALESCE_MS);
        await s.scope.scheduler.idle();
        vi.setSystemTime(T0 + 2 * DAY);
        s.clock.server = T0 + 2 * DAY;
        s.server.end(code);
        s.scope.scheduler.poke();
        await advance(COALESCE_MS);
        await s.scope.scheduler.idle();
        // Every request carried the install id, the 401s included.
        expect(s.server.requests.length).toBeGreaterThan(0);
        return s;
    }

    it('session_ended ("Sign out this device") is Ended: the copy locks and stays', async () => {
        const s = await endWith('session_ended');
        expect(new Set(s.ends)).toEqual(new Set(['ended']));
        expect(await readRootState(s.store.registry)).toEqual({ active: { id: s.id, locked: true } });
        expect(await s.store.registry.get(s.id)).toMatchObject({ state: 'ready' });
    });

    it.each(['device_revoked', 'deactivated'])(
        '%s locks the copy at once and tells the app, which wipes it',
        async (code) => {
            const s = await endWith(code);
            expect(new Set(s.ends)).toEqual(new Set([code === 'deactivated' ? 'deactivated' : 'device-revoked']));
            // Hidden before the wipe: the gate shows the lock, and sync stopped.
            expect(await readRootState(s.store.registry)).toEqual({ active: { id: s.id, locked: true } });
            const calls = s.net.calls.length;
            await advance(SHELL_POLL_MS * 4);
            expect(s.net.calls.length).toBe(calls);
        },
    );

    it('session_expired is Expired even before the stored expiry: readable, nothing locked', async () => {
        const s = await endWith('session_expired');
        expect(new Set(s.ends)).toEqual(new Set(['expired']));
        expect(await s.store.registry.session(s.id)).toMatchObject({ endedAt: null });
        expect(await readRootState(s.store.registry)).toEqual({ active: { id: s.id, locked: false } });
    });

    it('an install key this build never recorded writing (an older build’s wipe left it) is not sent', async () => {
        const { store } = await launch(device);
        stores.push(store);
        const clock = clocks();
        const server = fakeWorkspaceServer(clock);
        const net = wire(new Map([[ORIGIN, server]]));
        const id = await signedIn(store, ORIGIN, server, clock);
        await store.registry.setInstallSet(id, null);
        await store.registry.setActive(id);
        const ends: SessionEnd[] = [];
        const scope = await openWorkspaceScope({
            store,
            workspaceId: id,
            fetch: net.fetch,
            userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
            variant: 'production',
            appState: fakeAppState('active'),
            network: fakeNetwork(WIFI),
            onUnauthorized: (end) => void ends.push(end),
            onError: () => {},
            random: () => 0.5,
        });
        scopes.push(scope);
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        vi.setSystemTime(T0 + 2 * DAY);
        clock.server = T0 + 2 * DAY;
        server.end('device_revoked');
        scope.scheduler.poke();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        // The fake gives the code only to a request with the header: Ended shows none went.
        expect(new Set(ends)).toEqual(new Set(['ended']));
    });

    it('a copy signed in before install ids existed has none: the code isn’t asked for, and the plain Ended stands', async () => {
        const { store } = await launch(device);
        stores.push(store);
        const clock = clocks();
        const server = fakeWorkspaceServer(clock);
        const net = wire(new Map([[ORIGIN, server]]));
        const id = await signedIn(store, ORIGIN, server, clock);
        await store.keys.delete([workspaceKeyName(id, 'install')]);
        await store.registry.setActive(id);
        const ends: SessionEnd[] = [];
        const scope = await openWorkspaceScope({
            store,
            workspaceId: id,
            fetch: net.fetch,
            userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
            variant: 'production',
            appState: fakeAppState('active'),
            network: fakeNetwork(WIFI),
            onUnauthorized: (end) => void ends.push(end),
            onError: () => {},
            random: () => 0.5,
        });
        scopes.push(scope);
        scope.start();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        vi.setSystemTime(T0 + 2 * DAY);
        clock.server = T0 + 2 * DAY;
        server.end('device_revoked');
        scope.scheduler.poke();
        await advance(COALESCE_MS);
        await scope.scheduler.idle();
        // The fake gives the code only to a request with the header: Ended shows none went.
        expect(new Set(ends)).toEqual(new Set(['ended']));
    });
});

describe('the session watch', () => {
    it('follows the jar after each check: a slide puts it back to signed in', () => {
        let expiresAt: number | null = T0 + 1000;
        const watch = createSessionWatch({ sessionExpiresAt: () => expiresAt, serverNow: () => Date.now() });
        vi.advanceTimersByTime(1000);
        expect(watch.state()).toBe('expired');
        expiresAt = Date.now() + 7 * DAY;
        watch.check();
        expect(watch.state()).toBe('signed-in');
        // No known expiry: nothing says it expired (a 401 then reads as Ended).
        expiresAt = null;
        watch.check();
        expect(watch.state()).toBe('signed-in');
        watch.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('holds writes for a sign-in while Expired, for an update while the gate is closed', () => {
        expect(writeHold('signed-in', 'open')).toBeNull();
        expect(writeHold('signed-in', null)).toBeNull();
        expect(writeHold('signed-in', 'closed')).toBe('update');
        expect(writeHold('expired', 'closed')).toBe('sign-in');
        expect(writeHold('expired', 'open')).toBe('sign-in');
    });
});
