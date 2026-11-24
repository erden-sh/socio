import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Store } from '../../src/data';
import type { FetchFunction } from '../../src/net/fetch-function';
import { drawerWorkspaces } from '../../src/shell/workspaces';
import { type ActiveScope, createActiveScope } from '../../src/sync/active-scope';
import { chatDraft } from '../../src/sync/chat-drafts';
import type { OutboxKind } from '../../src/sync/outbox';
import { COALESCE_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, WIFI } from './fakes';
import { fakeWorkspaceServer } from './helpers';
import { fakeMessageServer, type FakeMessageServer, MESSAGE, message, turns } from './outbox-fakes';
import { signedIn, wire } from './wire';

// The outbox in the open workspace's scope (src/sync/scope.ts, outbox.ts): only
// the open workspace's queue sends; a switch stops its requests and leaves
// their rows `unknown`; the queue waits, said in the
// drawer as "Waiting to send", while another workspace is open; back on it,
// the row is checked and the message arrives exactly once. Two fake workspace
// servers, each with a fake message endpoint, through the active scope and the
// store on node:sqlite.

const A = 'https://a.example.test';
const B = 'https://b.example.test';

let device: Phone;
const stores: Store[] = [];
const actives: ActiveScope[] = [];

beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-outbox-switch-')));
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(async () => {
    for (const active of actives.splice(0)) {
        await active.show(null);
    }
    for (const store of stores.splice(0)) {
        await store.registry.close().catch(() => {});
    }
    vi.useRealTimers();
    rmSync(device.root, { recursive: true, force: true });
});

async function setup() {
    const { store } = await launch(device);
    stores.push(store);
    const ids: Record<'a' | 'b', string> = { a: '', b: '' };
    const workspaces = new Map();
    for (const [key, origin] of [
        ['a', A],
        ['b', B],
    ] as const) {
        const clock = clocks();
        const server = fakeWorkspaceServer(clock);
        workspaces.set(origin, server);
        ids[key] = await signedIn(store, origin, server, clock);
    }
    const messages: Record<string, FakeMessageServer> = { [A]: fakeMessageServer(), [B]: fakeMessageServer() };
    const net = wire(workspaces);
    // The message endpoints beside each workspace's own.
    const fetch: FetchFunction = (url: string, init: FetchRequestInit) => {
        const { origin, pathname } = new URL(url);
        const server = messages[origin];
        if (server !== undefined && pathname.startsWith('/api/test/')) {
            return server.handle(pathname, {
                method: init.method,
                json: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
                signal: init.signal ?? undefined,
            });
        }
        return net.fetch(url, init);
    };
    const appState = fakeAppState('active');
    const network = fakeNetwork(WIFI);
    const errors: unknown[] = [];
    const active = createActiveScope({
        open: (workspaceId) =>
            openWorkspaceScope({
                store,
                workspaceId,
                fetch,
                userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
                variant: 'production',
                appState,
                network,
                outboxKinds: [MESSAGE] as OutboxKind<unknown>[],
                onError: (error) => errors.push(error),
                random: () => 0.5,
            }),
        onError: (error) => errors.push(error),
    });
    actives.push(active);
    return { store, ids, messages, active, errors };
}

function openScope(active: ActiveScope): WorkspaceScope {
    const state = active.get();
    if (state.kind !== 'open') {
        throw new Error(`No scope open: ${state.kind}`);
    }
    return state.scope;
}

async function switchTo(active: ActiveScope, id: string): Promise<WorkspaceScope> {
    await active.show(id);
    const scope = openScope(active);
    scope.start();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await scope.scheduler.idle();
    await scope.outbox.idle();
    await turns();
    return scope;
}

describe('the outbox across a workspace switch', () => {
    for (const reached of [true, false]) {
        it(
            `sends a message queued in A once after a switch to B and back (its request ${reached ? 'reached' : 'never reached'} A)`,
            { timeout: 30_000 },
            async () => {
                const { store, ids, messages, active } = await setup();
                const a = messages[A] as FakeMessageServer;
                const b = messages[B] as FakeMessageServer;
                let scope = await switchTo(active, ids.a);
                if (reached) {
                    a.hang(true);
                } else {
                    a.stall(true);
                }
                const write = message('from A', { lane: 'chat:a1' });
                await scope.outbox.enqueue(write);
                await turns();
                expect(scope.collections.pending.get(write.id)).toMatchObject({ state: 'inflight' });

                // To B: A's request stops, its row is unknown, and its queue waits, said in the drawer.
                scope = await switchTo(active, ids.b);
                a.hang(false);
                a.stall(false);
                expect(scope.outbox.rows()).toEqual([]);
                const rows = await store.registry.list();
                expect(rows.find((row) => row.id === ids.a)?.waiting).toBe(1);
                const drawer = drawerWorkspaces(rows, ids.b, device.root);
                expect(drawer.find((row) => row.id === ids.a)).toMatchObject({
                    notice: 'Waiting to send',
                    accessibilityLabel: expect.stringContaining('Waiting to send'),
                });
                expect(drawer.find((row) => row.id === ids.b)?.notice).toBeNull();
                await vi.advanceTimersByTimeAsync(120_000);
                expect(a.received.get(write.id) ?? 0).toBe(reached ? 1 : 0);
                expect(b.log).toEqual([]);

                // Back to A: the unknown row is checked, then sent only if it never arrived.
                scope = await switchTo(active, ids.a);
                await scope.outbox.idle();
                await turns();
                expect(a.received.get(write.id)).toBe(1);
                expect(a.log.filter((line) => line.startsWith('POST'))).toHaveLength(reached ? 1 : 2);
                expect(scope.outbox.rows()).toEqual([]);
                expect(scope.collections.pending.size).toBe(0);
                expect((await store.registry.get(ids.a))?.waiting).toBe(0);
                expect(drawerWorkspaces(await store.registry.list(), ids.b, device.root)[1]?.notice ?? null).toBeNull();
            },
        );
    }

    it('fills `pending` from user.db as the scope opens, and follows the outbox', { timeout: 30_000 }, async () => {
        const { ids, messages, active } = await setup();
        const a = messages[A] as FakeMessageServer;
        a.stall(true);
        let scope = await switchTo(active, ids.a);
        const write = message('kept', { lane: 'chat:a1' });
        await scope.outbox.enqueue(write);
        await turns();
        scope = await switchTo(active, ids.b);
        a.stall(false);
        await active.show(ids.a);
        scope = openScope(active);
        // Before start: shown from user.db, in the state the switch left it.
        expect(scope.collections.pending.get(write.id)).toMatchObject({ state: 'unknown', attempts: 1 });
        scope.start();
        await scope.outbox.idle();
        await turns();
        expect(scope.collections.pending.has(write.id)).toBe(false);
        expect(a.received.get(write.id)).toBe(1);
    });
    it(
        'keeps a draft typed just before a switch, and sends it from the draft once (C1)',
        { timeout: 30_000 },
        async () => {
            const { ids, messages, active } = await setup();
            const a = messages[A] as FakeMessageServer;
            const scope = chatDraft('a1');
            let open = await switchTo(active, ids.a);
            // Typed, not yet written, when the switch comes: dispose writes it.
            open.drafts.write(scope, 'Hello from A');
            open = await switchTo(active, ids.b);
            expect(open.drafts.read(scope).text).toBe('');
            open = await switchTo(active, ids.a);
            expect(open.drafts.read(scope).text).toBe('Hello from A');
            await open.drafts.enqueueFromDraft(scope, (text) => message(text, { id: 'm-from-draft', lane: 'chat:a1' }));
            expect(open.drafts.read(scope).text).toBe('');
            expect(open.collections.pending.has('m-from-draft')).toBe(true);
            await open.outbox.idle();
            await turns();
            expect(a.received.get('m-from-draft')).toBe(1);
            open = await switchTo(active, ids.b);
            open = await switchTo(active, ids.a);
            expect(open.drafts.read(scope).text).toBe('');
            expect(a.received.get('m-from-draft')).toBe(1);
        },
    );
});
