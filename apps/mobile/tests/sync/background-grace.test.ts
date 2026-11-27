import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { UserDb } from '../../src/data';
import type { ActiveScopeState } from '../../src/sync/active-scope';
import {
    type BackgroundGrace,
    bindBackgroundGrace,
    followBackgroundGrace,
    type GraceOutbox,
} from '../../src/sync/background-grace';
import { type Outbox, type OutboxKind, type OutboxStatus, openOutbox } from '../../src/sync/outbox';
import type { WorkspaceScope } from '../../src/sync/scope';

import { fakeMessageServer, fetchTo, MESSAGE, message, REPEATABLE, turns, UNCHECKED, userDb } from './outbox-fakes';

// The outbox's background grace (src/sync/background-grace.ts): held
// only while a request is in flight, and when it runs out the rows in flight
// are `unknown` on disk before their requests stop, and nothing more goes
// until the app is active again. On a real user.db
// (node:sqlite) and the outbox's fake server, with a fake grace in place of
// socio-device's.

const directories: string[] = [];
const outboxes: Outbox[] = [];
const files: UserDb[] = [];

afterEach(async () => {
    for (const outbox of outboxes.splice(0)) {
        await outbox.dispose();
    }
    for (const file of files.splice(0)) {
        await file.db.close();
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

/** A grace that records each hold and lets the test run it out. */
function fakeGrace() {
    const holds: boolean[] = [];
    const listeners = new Set<() => void>();
    const grace: BackgroundGrace = {
        hold: (hold) => holds.push(hold),
        onExpiring(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return {
        grace,
        holds,
        listeners,
        runOut: () => {
            for (const listener of [...listeners]) {
                listener();
            }
        },
    };
}

/** AppState, in the background until the test brings the app back. */
function fakeAppState(initial = 'background') {
    let state = initial;
    const listeners = new Set<(state: string) => void>();
    return {
        listeners,
        current: () => state,
        subscribe(listener: (state: string) => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        set(next: string) {
            state = next;
            for (const listener of [...listeners]) {
                listener(next);
            }
        },
    };
}

async function setup() {
    const store = await userDb();
    directories.push(store.directory);
    const file = await store.open();
    files.push(file);
    const server = fakeMessageServer();
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [MESSAGE, UNCHECKED, REPEATABLE] as OutboxKind<unknown>[],
        fetch: fetchTo(server),
        random: () => 0.5,
    });
    outboxes.push(outbox);
    const onDisk = () => file.db.all<{ id: string; state: string }>('SELECT id, state FROM outbox ORDER BY id');
    return { server, outbox, onDisk };
}

describe('binding the grace to an outbox', () => {
    it('holds only while a request is in flight', async () => {
        const { outbox, server } = await setup();
        const { grace, holds } = fakeGrace();
        bindBackgroundGrace(outbox, grace, fakeAppState());
        expect(holds).toEqual([]);
        server.hang(true);
        await outbox.enqueue(message('lock the phone now'));
        outbox.start();
        await turns();
        expect(outbox.status().inflight).toBe(1);
        expect(holds).toEqual([true]);
        server.hang(false);
        await outbox.interrupt();
        await outbox.idle();
        expect(holds).toEqual([true, false]);
    });

    it('lets go once the request is answered, and holds again for the next', async () => {
        const { outbox } = await setup();
        const { grace, holds } = fakeGrace();
        bindBackgroundGrace(outbox, grace, fakeAppState());
        outbox.start();
        await outbox.enqueue(message('one'));
        await outbox.idle();
        await outbox.enqueue(message('two'));
        await outbox.idle();
        expect(outbox.rows()).toEqual([]);
        expect(holds).toEqual([true, false, true, false]);
    });

    it('marks the rows in flight unknown on disk before their requests stop when the grace runs out', async () => {
        const { outbox, server, onDisk } = await setup();
        const { grace, holds, runOut } = fakeGrace();
        bindBackgroundGrace(outbox, grace, fakeAppState());
        server.hang(true);
        const write = message('cut off', { kind: UNCHECKED.kind });
        await outbox.enqueue(write);
        outbox.start();
        await turns();
        expect(await onDisk()).toEqual([{ id: write.id, state: 'inflight' }]);
        runOut();
        await outbox.idle();
        // It reached the server once and was never sent again: with no check, it waits for the person.
        expect(await onDisk()).toEqual([{ id: write.id, state: 'unknown' }]);
        expect(server.received.get(write.id)).toBe(1);
        expect(outbox.status().inflight).toBe(0);
        expect(holds).toEqual([true, false]);
    });

    it('checks a row the grace cut off only once the app is active again, and sends it only once', async () => {
        const { outbox, server, onDisk } = await setup();
        const { grace, runOut } = fakeGrace();
        const app = fakeAppState();
        bindBackgroundGrace(outbox, grace, app);
        server.hang(true);
        const write = message('checked on resume');
        await outbox.enqueue(write);
        outbox.start();
        await turns();
        server.hang(false);
        runOut();
        await outbox.idle();
        // Its aborted POST may still be running on the server: no check in the background.
        expect(server.log).toEqual(['POST /api/test/messages']);
        expect(await onDisk()).toEqual([{ id: write.id, state: 'unknown' }]);
        // Neither a poke nor 'inactive' ends the pause; 'active' does.
        outbox.poke();
        app.set('inactive');
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/test/messages']);
        app.set('active');
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/test/messages', `GET /api/test/messages/${write.id}`]);
        expect(server.received.get(write.id)).toBe(1);
        expect(outbox.rows()).toEqual([]);
    });

    it('does not send a repeatable row the grace cut off again until the app is active', async () => {
        const { outbox, server, onDisk } = await setup();
        const { grace, runOut } = fakeGrace();
        const app = fakeAppState();
        bindBackgroundGrace(outbox, grace, app);
        server.hang(true);
        const write = message('repeatable', { kind: REPEATABLE.kind });
        await outbox.enqueue(write);
        outbox.start();
        await turns();
        server.hang(false);
        runOut();
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/test/messages']);
        expect(await onDisk()).toEqual([{ id: write.id, state: 'unknown' }]);
        app.set('active');
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/test/messages', 'POST /api/test/messages']);
        expect(outbox.rows()).toEqual([]);
    });

    it(
        'holds back a send begun at any moment before the grace ran out until the app is active',
        { timeout: 30_000 },
        async () => {
            for (let wait = 0; wait < 8; wait += 1) {
                const { outbox, server } = await setup();
                const { grace, runOut } = fakeGrace();
                const app = fakeAppState();
                bindBackgroundGrace(outbox, grace, app);
                outbox.start();
                server.hang(true);
                const write = message(`begun ${wait}`);
                const enqueued = outbox.enqueue(write);
                for (let tick = 0; tick < wait; tick += 1) {
                    await Promise.resolve();
                }
                runOut();
                await enqueued;
                await turns();
                server.hang(false);
                await outbox.idle();
                // At most the one request that was already going, and nothing after the grace ran out.
                const before = [...server.log];
                expect(before.length).toBeLessThanOrEqual(1);
                outbox.poke();
                await outbox.idle();
                expect(server.log).toEqual(before);
                expect(outbox.rows()).toHaveLength(1);
                app.set('active');
                await outbox.idle();
                expect(server.received.get(write.id)).toBe(1);
                expect(outbox.rows()).toEqual([]);
            }
        },
    );

    it('unpauses at once when the app is already active as the interrupt ends', async () => {
        const { outbox, server } = await setup();
        const { grace, runOut } = fakeGrace();
        bindBackgroundGrace(outbox, grace, fakeAppState('active'));
        server.hang(true);
        const write = message('back on screen');
        await outbox.enqueue(write);
        outbox.start();
        await turns();
        server.hang(false);
        runOut();
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/test/messages', `GET /api/test/messages/${write.id}`]);
        expect(outbox.rows()).toEqual([]);
    });

    it('holds at once for a request already in flight, and lets go and stops listening when unbound', async () => {
        const { outbox, server } = await setup();
        server.hang(true);
        await outbox.enqueue(message('already going'));
        outbox.start();
        await turns();
        const { grace, holds, listeners, runOut } = fakeGrace();
        const app = fakeAppState();
        const unbind = bindBackgroundGrace(outbox, grace, app);
        expect(holds).toEqual([true]);
        unbind();
        expect(holds).toEqual([true, false]);
        expect(listeners.size).toBe(0);
        expect(app.listeners.size).toBe(0);
        runOut();
        await turns();
        expect(outbox.status().inflight).toBe(1);
        server.hang(false);
    });

    it('ends up matching what is in flight when the interrupt fails', async () => {
        let status: OutboxStatus = {
            waiting: 1,
            inflight: 1,
            heldForSignIn: false,
            heldForUpdate: false,
            undecodable: 0,
            unsent: 0,
            readOnly: false,
        };
        const errors: unknown[] = [];
        const failing: GraceOutbox = {
            status: () => status,
            onStatus: () => () => {},
            interrupt: async () => {
                status = { ...status, inflight: 0 };
                throw new Error('disk full');
            },
            unpause: () => {},
        };
        const { grace, holds, runOut } = fakeGrace();
        bindBackgroundGrace(failing, grace, fakeAppState(), (error) => errors.push(error));
        runOut();
        await turns();
        expect(errors).toEqual([new Error('disk full')]);
        expect(holds).toEqual([true, false]);
    });
});

describe('following the active scope', () => {
    /** A scope with only the outbox the grace reads, and a way to say what is in flight. */
    function fakeScope(id: string) {
        const listeners = new Set<(status: OutboxStatus) => void>();
        let inflight = 0;
        const status = (): OutboxStatus => ({
            waiting: inflight,
            inflight,
            heldForSignIn: false,
            heldForUpdate: false,
            undecodable: 0,
            unsent: 0,
            readOnly: false,
        });
        const interrupted: string[] = [];
        const outbox: GraceOutbox = {
            status,
            onStatus(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            interrupt: async () => {
                interrupted.push(id);
                inflight = 0;
                for (const listener of [...listeners]) {
                    listener(status());
                }
            },
            unpause: () => {},
        };
        const scope = { id, outbox } as unknown as WorkspaceScope;
        return {
            scope,
            listeners,
            interrupted,
            send: (count: number) => {
                inflight = count;
                for (const listener of [...listeners]) {
                    listener(status());
                }
            },
        };
    }

    function fakeActiveScope() {
        let state: ActiveScopeState = { kind: 'none' };
        const listeners = new Set<() => void>();
        return {
            listeners,
            get: () => state,
            subscribe(listener: () => void) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            set(next: ActiveScopeState) {
                state = next;
                for (const listener of [...listeners]) {
                    listener();
                }
            },
        };
    }

    it('takes the open scope’s outbox, lets go of it on a switch, and interrupts only the open one', async () => {
        const active = fakeActiveScope();
        const a = fakeScope('a');
        const b = fakeScope('b');
        const { grace, holds, listeners, runOut } = fakeGrace();
        active.set({ kind: 'open', scope: a.scope });
        const app = fakeAppState();
        const stop = followBackgroundGrace(active, grace, app);
        a.send(1);
        expect(holds).toEqual([true]);
        // A switch: the old scope goes while the next opens.
        active.set({ kind: 'opening', workspaceId: 'b' });
        expect(holds).toEqual([true, false]);
        expect(a.listeners.size).toBe(0);
        active.set({ kind: 'open', scope: b.scope });
        b.send(1);
        expect(holds).toEqual([true, false, true]);
        runOut();
        await turns();
        expect(a.interrupted).toEqual([]);
        expect(b.interrupted).toEqual(['b']);
        expect(holds).toEqual([true, false, true, false]);
        stop();
        expect(active.listeners.size).toBe(0);
        expect(b.listeners.size).toBe(0);
        expect(listeners.size).toBe(0);
        expect(app.listeners.size).toBe(0);
    });

    it('binds nothing while no scope is open or one failed', () => {
        const active = fakeActiveScope();
        const { grace, holds, listeners } = fakeGrace();
        followBackgroundGrace(active, grace, fakeAppState());
        active.set({ kind: 'failed', workspaceId: 'a', error: new Error('no key') });
        expect(listeners.size).toBe(0);
        expect(holds).toEqual([]);
    });
});
