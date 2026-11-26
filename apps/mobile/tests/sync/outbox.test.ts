import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SqlConnection, UPDATE_TO_SEND, type UserDb } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    type Outbox,
    type OutboxChange,
    type OutboxKind,
    OutboxError,
    type OutboxOptions,
    outboxRetryDelayMs,
    OUTBOX_RETRY_MAX_MS,
    openOutbox,
} from '../../src/sync/outbox';

import {
    fakeMessageServer,
    type FakeMessageServer,
    fetchTo,
    killAt,
    MESSAGE,
    message,
    REPEATABLE,
    turns,
    UNCHECKED,
    userDb,
} from './outbox-fakes';

// The outbox's core (src/sync/outbox.ts)
// on a real user.db (node:sqlite) and a fake server. The first block ports T3
// Code's thread-outbox.test.ts cases (pingdotgg/t3code 549d182a) as specs; then
// the drain, the states, a kill between every two steps (no write lost, none
// sent twice), and the fetch never called before the commit.

const directories: string[] = [];
const outboxes: Outbox[] = [];
const files: UserDb[] = [];

afterEach(async () => {
    vi.useRealTimers();
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

interface Setup {
    readonly server: FakeMessageServer;
    readonly file: UserDb;
    readonly outbox: Outbox;
    readonly changes: OutboxChange[];
    readonly errors: unknown[];
    readonly reopen: (options?: Partial<OutboxOptions>) => Promise<Outbox>;
    readonly onDisk: () => Promise<{ id: string; state: string; payload: string; attempts: number }[]>;
}

const KINDS = [MESSAGE, UNCHECKED, REPEATABLE] as OutboxKind<unknown>[];

async function setup(
    options: Partial<OutboxOptions> & {
        wrapDb?: (db: SqlConnection) => SqlConnection;
        wrapFetch?: (f: AuthedFetch) => AuthedFetch;
    } = {},
): Promise<Setup> {
    const { wrapDb = (db) => db, wrapFetch = (f) => f, ...rest } = options;
    const store = await userDb();
    directories.push(store.directory);
    const file = await store.open();
    files.push(file);
    const server = fakeMessageServer();
    const errors: unknown[] = [];
    const make = async (more: Partial<OutboxOptions> = {}) => {
        const outbox = await openOutbox({
            db: wrapDb(file.db),
            state: file.state,
            kinds: KINDS,
            fetch: wrapFetch(fetchTo(server)),
            onError: (error) => errors.push(error),
            random: () => 0.5,
            ...rest,
            ...more,
        });
        outboxes.push(outbox);
        return outbox;
    };
    const outbox = await make();
    const changes: OutboxChange[] = [];
    outbox.subscribe((change) => changes.push(change));
    return {
        server,
        file,
        outbox,
        changes,
        errors,
        reopen: make,
        onDisk: () => file.db.all('SELECT id, state, payload, attempts FROM outbox ORDER BY createdAt, id'),
    };
}

/** A gate: `wait()` resolves once `open()` is called. */
function gate() {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { wait: () => opened, open: () => open() };
}

describe('the outbox, after T3 Code’s thread-outbox specs', () => {
    it('publishes an enqueued write before the durable write resolves', async () => {
        const commit = gate();
        const { outbox, onDisk, changes } = await setup({
            wrapDb: (db) => ({
                ...db,
                exec: (sql) => db.exec(sql),
                run: (sql, params) => db.run(sql, params),
                get: (sql, params) => db.get(sql, params),
                all: (sql, params) => db.all(sql, params),
                transaction: async (task) => {
                    await commit.wait();
                    return db.transaction(task);
                },
                close: () => db.close(),
            }),
        });
        const write = message('hello');
        const stored = outbox.enqueue(write);
        expect(outbox.rows().map((row) => [row.id, row.state])).toEqual([[write.id, 'queued']]);
        expect(changes).toEqual([{ type: 'upsert', row: expect.objectContaining({ id: write.id }) }]);
        expect(outbox.status().waiting).toBe(1);
        expect(await onDisk()).toEqual([]);
        commit.open();
        await expect(stored).resolves.toMatchObject({ id: write.id, revision: 1 });
        expect(await onDisk()).toEqual([expect.objectContaining({ id: write.id, state: 'queued' })]);
    });

    it('rolls an enqueued write back out when the durable write fails, and never sends it', async () => {
        const { outbox, server, onDisk, changes } = await setup({
            wrapDb: (db) => ({
                ...db,
                exec: (sql) => db.exec(sql),
                run: (sql, params) => db.run(sql, params),
                get: (sql, params) => db.get(sql, params),
                all: (sql, params) => db.all(sql, params),
                transaction: () => Promise.reject(new Error('disk full')),
                close: () => db.close(),
            }),
        });
        outbox.start();
        const write = message('lost?');
        await expect(outbox.enqueue(write)).rejects.toBeInstanceOf(OutboxError);
        await outbox.idle();
        expect(outbox.rows()).toEqual([]);
        expect(changes.map((change) => change.type)).toEqual(['upsert', 'remove']);
        expect(await onDisk()).toEqual([]);
        expect(server.log).toEqual([]);
    });

    it('stores the caller’s statements in the same transaction, or neither', async () => {
        const { outbox, file, onDisk } = await setup();
        const draft =
            "INSERT OR REPLACE INTO drafts (scope, text, payloadVersion, updatedAt) VALUES ('chat:1', '', 1, 1)";
        await outbox.enqueue(message('with the draft'), async (tx) => {
            await tx.run(draft);
        });
        expect(await file.db.all('SELECT scope FROM drafts')).toEqual([{ scope: 'chat:1' }]);

        await expect(
            outbox.enqueue(message('without'), async (tx) => {
                await tx.run("UPDATE drafts SET text = 'x'");
                throw new Error('the draft failed');
            }),
        ).rejects.toBeInstanceOf(OutboxError);
        expect(await onDisk()).toHaveLength(1);
        expect(await file.db.all('SELECT text FROM drafts')).toEqual([{ text: '' }]);
        expect(outbox.rows()).toHaveLength(1);
    });

    it('serializes its writes even when an earlier one is slower', async () => {
        const slow = gate();
        const order: string[] = [];
        let first = true;
        const { outbox, onDisk } = await setup({
            wrapDb: (db) => ({
                ...db,
                exec: (sql) => db.exec(sql),
                run: async (sql, params) => {
                    order.push(sql.split(' ')[0] ?? '');
                    return db.run(sql, params);
                },
                get: (sql, params) => db.get(sql, params),
                all: (sql, params) => db.all(sql, params),
                transaction: async (task) => {
                    if (first) {
                        first = false;
                        await slow.wait();
                    }
                    order.push('INSERT');
                    return db.transaction(task);
                },
                close: () => db.close(),
            }),
        });
        order.length = 0;
        const write = message('one');
        const stored = outbox.enqueue(write);
        const updated = outbox.update(write.id, { payload: JSON.stringify({ text: 'two' }), payloadVersion: 1 });
        await turns();
        expect(order).toEqual([]);
        slow.open();
        await stored;
        expect(await updated).toBe(true);
        expect(order).toEqual(['INSERT', 'UPDATE']);
        expect(await onDisk()).toEqual([expect.objectContaining({ payload: '{"text":"two"}' })]);
    });

    it('updates a queued write in place but never resurrects a removed one', async () => {
        const { outbox, onDisk } = await setup();
        const write = message('first');
        await outbox.enqueue(write);
        expect(await outbox.update(write.id, { payload: '{"text":"edited"}', payloadVersion: 1 })).toBe(true);
        expect(outbox.rows()[0]).toMatchObject({ payload: '{"text":"edited"}', revision: 2 });
        expect(await outbox.remove(write.id)).toMatchObject({ id: write.id });
        expect(await outbox.update(write.id, { payload: '{"text":"late"}', payloadVersion: 1 })).toBe(false);
        expect(outbox.rows()).toEqual([]);
        expect(await onDisk()).toEqual([]);
    });

    it('rejects a stale revision before its payload reaches user.db', async () => {
        const { outbox, onDisk } = await setup();
        const write = message('base');
        await outbox.enqueue(write);
        const before = outbox.revisionOf(write.id);
        expect(await outbox.update(write.id, { payload: '{"text":"winner"}', payloadVersion: 1 }, before)).toBe(true);
        expect(await outbox.update(write.id, { payload: '{"text":"stale"}', payloadVersion: 1 }, before)).toBe(false);
        expect(await onDisk()).toEqual([expect.objectContaining({ payload: '{"text":"winner"}' })]);
    });

    it('refuses to remove a write rewritten after the removal was decided', async () => {
        const { outbox, onDisk } = await setup();
        const write = message('keep me');
        await outbox.enqueue(write);
        const decided = outbox.revisionOf(write.id);
        await outbox.update(write.id, { payload: '{"text":"newer"}', payloadVersion: 1 });
        expect(await outbox.remove(write.id, decided)).toBeNull();
        expect(await onDisk()).toHaveLength(1);
    });

    it('keeps a tombstone, so a stale writer from before a removal never matches the id enqueued again', async () => {
        const { outbox } = await setup();
        const write = message('one life');
        await outbox.enqueue(write);
        const stale = outbox.revisionOf(write.id);
        await outbox.remove(write.id);
        await outbox.enqueue({ ...write, idempotencyKey: '00000000-0000-4000-8000-0000000000ff' });
        expect(outbox.revisionOf(write.id)).toBeGreaterThan(stale);
        expect(await outbox.update(write.id, { payload: '{"text":"stale"}', payloadVersion: 1 }, stale)).toBe(false);
        expect(await outbox.remove(write.id, stale)).toBeNull();
    });

    it('refuses an id that is queued already', async () => {
        const { outbox } = await setup();
        const write = message('once');
        await outbox.enqueue(write);
        await expect(outbox.enqueue(write)).rejects.toThrow(/queued already/);
        expect(outbox.rows()).toHaveLength(1);
    });

    it('sends what is queued when it goes: an edit before sending changes the request, a removal stops it', async () => {
        const { outbox, server } = await setup();
        const edited = message('draft', { lane: 'chat:a' });
        const removed = message('never', { lane: 'chat:b' });
        await outbox.enqueue(edited);
        await outbox.enqueue(removed);
        await outbox.update(edited.id, { payload: '{"text":"final"}', payloadVersion: 1 });
        await outbox.remove(removed.id);
        outbox.start();
        await outbox.idle();
        expect([...server.received]).toEqual([[edited.id, 1]]);
        expect(outbox.rows()).toEqual([]);
    });

    it('confirms a write is still queued only after the writes before it settle', async () => {
        const { outbox } = await setup();
        const row = await outbox.enqueue(message('here'));
        expect(await outbox.confirmQueued(row)).toBe(true);
        await outbox.update(row.id, { payload: '{"text":"changed"}', payloadVersion: 1 });
        expect(await outbox.confirmQueued(row)).toBe(false);
    });
});

describe('the drain', () => {
    it('never calls the fetch before the row’s commit', async () => {
        const commit = gate();
        const fetched: string[] = [];
        const { outbox, server } = await setup({
            wrapDb: (db) => ({
                ...db,
                exec: (sql) => db.exec(sql),
                run: (sql, params) => db.run(sql, params),
                get: (sql, params) => db.get(sql, params),
                all: (sql, params) => db.all(sql, params),
                transaction: async (task) => {
                    await commit.wait();
                    const result = await db.transaction(task);
                    fetched.push('committed');
                    return result;
                },
                close: () => db.close(),
            }),
            wrapFetch: (f) => (input, init) => {
                fetched.push('fetch');
                return f(input, init);
            },
        });
        outbox.start();
        const stored = outbox.enqueue(message('durable first'));
        outbox.poke();
        await turns();
        expect(fetched).toEqual([]);
        commit.open();
        await stored;
        await outbox.idle();
        expect(fetched).toEqual(['committed', 'fetch', 'committed']);
        expect(server.received.size).toBe(1);
    });

    it('sends nothing before start, then each lane in order, one request in flight per lane', async () => {
        const { outbox, server } = await setup();
        const a1 = message('a1', { lane: 'chat:a' });
        const a2 = message('a2', { lane: 'chat:a' });
        const b1 = message('b1', { lane: 'chat:b' });
        for (const write of [a1, a2, b1]) {
            await outbox.enqueue(write);
        }
        await turns();
        expect(server.log).toEqual([]);
        server.hang(true);
        outbox.start();
        await turns();
        // a2 waits for a1; b's lane runs beside a's.
        expect([...server.received.keys()]).toEqual([a1.id, b1.id]);
        expect(outbox.status().inflight).toBe(2);
        expect(outbox.rows().find((row) => row.id === a2.id)?.state).toBe('queued');
    });

    it('sends a lane’s rows oldest first, each after the one before is done', async () => {
        const { outbox, server } = await setup();
        const writes = [message('1'), message('2'), message('3')];
        for (const write of writes) {
            await outbox.enqueue(write);
        }
        outbox.start();
        await outbox.idle();
        expect([...server.received.keys()]).toEqual(writes.map((write) => write.id));
        expect(outbox.rows()).toEqual([]);
        expect(outbox.status()).toMatchObject({ waiting: 0, inflight: 0 });
    });

    it('waits for the row it depends on', async () => {
        const { outbox, server } = await setup();
        const parent = message('parent', { lane: 'create' });
        await outbox.enqueue(parent);
        server.answers.push(503);
        await outbox.enqueue({ ...message('child', { lane: 'chat:new' }), dependsOn: parent.id });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        outbox.start();
        await outbox.idle();
        expect(server.received.size).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
        await outbox.idle();
        expect([...server.received.keys()]).toEqual([parent.id, expect.stringMatching(/^m-/)]);
    });

    it('backs off from 1 s to 60 s with jitter, with no limit on attempts', async () => {
        expect(outboxRetryDelayMs(1, () => 0)).toBe(1_000);
        expect(outboxRetryDelayMs(1, () => 1)).toBe(1_000);
        expect(outboxRetryDelayMs(2, () => 0)).toBe(1_000);
        expect(outboxRetryDelayMs(2, () => 1)).toBe(2_000);
        expect(outboxRetryDelayMs(4, () => 0.5)).toBe(6_000);
        expect(outboxRetryDelayMs(30, () => 0)).toBe(OUTBOX_RETRY_MAX_MS / 2);
        expect(outboxRetryDelayMs(30, () => 1)).toBe(OUTBOX_RETRY_MAX_MS);

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { outbox, server, onDisk } = await setup();
        server.offline(true);
        const write = message('later', { kind: REPEATABLE.kind });
        await outbox.enqueue(write);
        outbox.start();
        await outbox.idle();
        for (let attempt = 1; attempt <= 12; attempt += 1) {
            expect(server.log).toHaveLength(attempt);
            const delay = outboxRetryDelayMs(attempt, () => 0.5);
            await vi.advanceTimersByTimeAsync(delay - 1);
            await outbox.idle();
            expect(server.log).toHaveLength(attempt);
            await vi.advanceTimersByTimeAsync(1);
            await outbox.idle();
        }
        expect(await onDisk()).toEqual([expect.objectContaining({ state: 'queued', attempts: 13 })]);
        server.offline(false);
        await vi.advanceTimersByTimeAsync(OUTBOX_RETRY_MAX_MS);
        await outbox.idle();
        expect(server.received.get(write.id)).toBe(1);
        expect(await onDisk()).toEqual([]);
    });

    it('holds a lane for a 429’s window, and leaves the other lanes running', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { outbox, server } = await setup();
        server.answers.push(429);
        const a = message('a', { lane: 'chat:a' });
        const b = message('b', { lane: 'chat:b' });
        await outbox.enqueue(a);
        await outbox.enqueue(b);
        outbox.start();
        await outbox.idle();
        expect([...server.received.keys()]).toEqual([b.id]);
        await vi.advanceTimersByTimeAsync(29_999);
        await outbox.idle();
        expect(server.received.has(a.id)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await outbox.idle();
        expect(server.received.get(a.id)).toBe(1);
    });

    it('ends a plain back-off when the network comes back (wake), never a 429’s window', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { outbox, server } = await setup();
        server.offline(true);
        server.answers.push(429);
        const away = message('away', { kind: REPEATABLE.kind, lane: 'chat:away' });
        await outbox.enqueue(away);
        outbox.start();
        await outbox.idle();
        for (let attempt = 1; attempt <= 6; attempt += 1) {
            await vi.advanceTimersByTimeAsync(OUTBOX_RETRY_MAX_MS);
            await outbox.idle();
        }
        // Waiting out a long back-off; a poke (the foreground) leaves it.
        const tries = server.log.length;
        outbox.poke();
        await outbox.idle();
        expect(server.log).toHaveLength(tries);
        server.offline(false);
        const windowed = message('windowed', { lane: 'chat:windowed' });
        await outbox.enqueue(windowed);
        await outbox.idle();
        expect(server.received.has(windowed.id)).toBe(false);
        outbox.wake();
        await outbox.idle();
        expect(server.received.get(away.id)).toBe(1);
        // The 429's window still holds its lane.
        expect(server.received.has(windowed.id)).toBe(false);
        await vi.advanceTimersByTimeAsync(30_000);
        await outbox.idle();
        expect(server.received.get(windowed.id)).toBe(1);
    });

    it('holds every lane on a 401, drops nothing, and sends once the person is back', async () => {
        let unauthorized = true;
        const { outbox, server, onDisk } = await setup({
            wrapFetch: (f) => async (input, init) =>
                unauthorized ? new Response('{}', { status: 401 }) : f(input, init),
        });
        const statuses: boolean[] = [];
        outbox.onStatus((status) => statuses.push(status.heldForSignIn));
        await outbox.enqueue(message('a', { lane: 'chat:a' }));
        await outbox.enqueue(message('b', { lane: 'chat:b' }));
        outbox.start();
        await outbox.idle();
        expect(outbox.status().heldForSignIn).toBe(true);
        expect(statuses).toContain(true);
        expect((await onDisk()).map((row) => row.state)).toEqual(['queued', 'queued']);
        outbox.poke();
        await outbox.idle();
        expect(server.received.size).toBe(0);

        unauthorized = false;
        outbox.resume();
        await outbox.idle();
        expect(outbox.status().heldForSignIn).toBe(false);
        expect(server.received.size).toBe(2);
        expect(await onDisk()).toEqual([]);
    });

    it('holds every lane on a 426 until the update, drops nothing and sends nothing to Unsent (CB-553)', async () => {
        let refused = true;
        const { outbox, server, onDisk } = await setup({
            wrapFetch: (f) => async (input, init) =>
                refused
                    ? new Response(
                          JSON.stringify({ code: 'client_update_required', minimum: '0.2.8', platform: 'ios' }),
                          {
                              status: 426,
                              headers: { 'Content-Type': 'application/json' },
                          },
                      )
                    : f(input, init),
        });
        const statuses: boolean[] = [];
        outbox.onStatus((status) => statuses.push(status.heldForUpdate));
        await outbox.enqueue(message('a', { lane: 'chat:a' }));
        await outbox.enqueue(message('b', { lane: 'chat:b' }));
        await outbox.enqueue(message('c', { kind: REPEATABLE.kind, lane: 'chat:c' }));
        outbox.start();
        await outbox.idle();
        expect(outbox.status()).toMatchObject({ heldForUpdate: true, heldForSignIn: false, unsent: 0 });
        expect(statuses).toContain(true);
        expect((await onDisk()).map((row) => row.state)).toEqual(['queued', 'queued', 'queued']);
        // A poke, the network back or a sign-in's resume don't end it: only the update does.
        outbox.poke();
        outbox.wake();
        outbox.resume();
        await outbox.idle();
        expect(server.received.size).toBe(0);
        expect(outbox.status().heldForUpdate).toBe(true);

        refused = false;
        outbox.holdForUpdate(false);
        await outbox.idle();
        expect(outbox.status().heldForUpdate).toBe(false);
        expect(server.received.size).toBe(3);
        expect(await onDisk()).toEqual([]);
    });

    it('sends a row refused with a 426 again as new, never as one that may have reached the server', async () => {
        const seen: (boolean | undefined)[] = [];
        let refused = true;
        const watched: OutboxKind<unknown> = {
            ...(MESSAGE as OutboxKind<unknown>),
            async send(write, context) {
                seen.push(write.ambiguous);
                return MESSAGE.send(write as Parameters<typeof MESSAGE.send>[0], context);
            },
        };
        const { outbox, server } = await setup({
            kinds: [watched, UNCHECKED, REPEATABLE] as OutboxKind<unknown>[],
            wrapFetch: (f) => async (input, init) =>
                refused ? new Response('{"code":"client_update_required"}', { status: 426 }) : f(input, init),
        });
        await outbox.enqueue(message('a', { lane: 'chat:a' }));
        outbox.start();
        await outbox.idle();
        expect(outbox.status().heldForUpdate).toBe(true);
        refused = false;
        outbox.holdForUpdate(false);
        await outbox.idle();
        expect(seen).toEqual([undefined, undefined]);
        expect(server.received.size).toBe(1);
    });

    /** A promise the test opens. */
    const opening = () => {
        let open = () => {};
        const opened = new Promise<void>((done) => {
            open = done;
        });
        return { opened, open };
    };
    const updateRequired = () =>
        new Response('{"code":"client_update_required","minimum":"0.2.8","platform":"ios"}', {
            status: 426,
            headers: { 'Content-Type': 'application/json' },
        });
    /** user.db, its write of a 426's settlement (`queued`, `update`) held until `write.open()`. */
    const holdingSettlement = (write: ReturnType<typeof opening>, seen: () => void) => (db: SqlConnection) =>
        ({
            ...db,
            exec: (sql: string) => db.exec(sql),
            run: async (sql: string, params?: unknown[]) => {
                if (
                    sql.startsWith('UPDATE outbox SET state = ?') &&
                    params?.[0] === 'queued' &&
                    params[1] === 'update'
                ) {
                    seen();
                    await write.opened;
                }
                return db.run(sql, params as never);
            },
            get: (sql: string, params?: unknown[]) => db.get(sql, params as never),
            all: (sql: string, params?: unknown[]) => db.all(sql, params as never),
            transaction: (task: Parameters<SqlConnection['transaction']>[0]) => db.transaction(task),
            close: () => db.close(),
        }) as SqlConnection;

    it('never holds again for a 426 whose settlement ends after the scope said the app is fine (CB-553)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let refused = true;
        const write = opening();
        const writing = opening();
        const { outbox, server } = await setup({
            wrapDb: holdingSettlement(write, writing.open),
            wrapFetch: (f) => async (input, init) => (refused ? updateRequired() : f(input, init)),
        });
        await outbox.enqueue(message('a', { lane: 'chat:a' }));
        outbox.start();
        await writing.opened;
        // The 426's own compat read: the gate closes, then a newer answer (a rollback) says this app is
        // fine, all while the settlement's write waits on SQLite.
        outbox.holdForUpdate(true);
        refused = false;
        outbox.holdForUpdate(false);
        write.open();
        await outbox.idle();
        expect(outbox.status().heldForUpdate).toBe(false);
        await vi.advanceTimersByTimeAsync(OUTBOX_RETRY_MAX_MS);
        await outbox.idle();
        expect(server.received.size).toBe(1);
        expect(outbox.status().waiting).toBe(0);
    });

    it('holds for neither of two 426s that race a newer answer, one settling late, one answered late', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let refused = true;
        const write = opening();
        const writing = opening();
        const late = opening();
        const asked = opening();
        let bAnswered = false;
        const { outbox, server } = await setup({
            wrapDb: holdingSettlement(write, writing.open),
            wrapFetch: (f) => async (input, init) => {
                if ((init?.json as { text?: string } | undefined)?.text === 'b' && !bAnswered) {
                    bAnswered = true;
                    // Lane b's request went before the release; its 426 comes after it.
                    asked.open();
                    await late.opened;
                    return updateRequired();
                }
                return refused ? updateRequired() : f(input, init);
            },
        });
        await outbox.enqueue(message('a', { lane: 'chat:a' }));
        await outbox.enqueue(message('b', { lane: 'chat:b' }));
        outbox.start();
        await Promise.all([writing.opened, asked.opened]);
        outbox.holdForUpdate(true);
        refused = false;
        outbox.holdForUpdate(false);
        write.open();
        late.open();
        await outbox.idle();
        expect(outbox.status().heldForUpdate).toBe(false);
        await vi.advanceTimersByTimeAsync(OUTBOX_RETRY_MAX_MS);
        await outbox.idle();
        // a went; b's next attempt goes to the real server too.
        expect(server.received.size).toBe(2);
    });

    it('still holds for a 426 when no newer answer came since its request went', async () => {
        const write = opening();
        const writing = opening();
        const { outbox, server } = await setup({
            wrapDb: holdingSettlement(write, writing.open),
            wrapFetch: () => async () => updateRequired(),
        });
        // An old release, before the request went, doesn't excuse it.
        outbox.holdForUpdate(false);
        await outbox.enqueue(message('a', { lane: 'chat:a' }));
        outbox.start();
        await writing.opened;
        write.open();
        await outbox.idle();
        expect(outbox.status().heldForUpdate).toBe(true);
        expect(server.received.size).toBe(0);
    });

    it('holds from the start when the kept numbers say the app is too old, and goes after', async () => {
        const { outbox, server } = await setup();
        outbox.holdForUpdate(true);
        await outbox.enqueue(message('a', { lane: 'chat:a' }));
        outbox.start();
        await outbox.idle();
        expect(server.received.size).toBe(0);
        expect(outbox.status().heldForUpdate).toBe(true);
        outbox.holdForUpdate(false);
        await outbox.idle();
        expect(server.received.size).toBe(1);
    });

    it('holds a row, and the rest of its lane, for the person; Send now lets it go', async () => {
        const { outbox, server } = await setup();
        server.answers.push(400);
        const first = message('needs a tap', { lane: 'chat:a' });
        const next = message('after it', { lane: 'chat:a' });
        const other = message('other lane', { lane: 'chat:b' });
        for (const write of [first, next, other]) {
            await outbox.enqueue(write);
        }
        outbox.start();
        await outbox.idle();
        expect(outbox.rows().map((row) => [row.id, row.state, row.lastError])).toEqual([
            [first.id, 'held', '400'],
            [next.id, 'queued', null],
        ]);
        expect(server.received.has(other.id)).toBe(true);
        expect(await outbox.sendNow(first.id)).toBe(true);
        await outbox.idle();
        expect(outbox.rows()).toEqual([]);
        expect([...server.received.keys()]).toEqual([other.id, first.id, next.id]);
    });

    it('keeps rows it can’t decode, never sends or changes them, and holds their lane', async () => {
        const { outbox, file, server, onDisk, reopen } = await setup();
        const insert = (id: string, lane: string, kind: string, payload: string, version: number, at = 1) =>
            file.db.run(
                `INSERT INTO outbox (id, lane, kind, payload, payloadVersion, idempotencyKey, state, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
                [id, lane, kind, payload, version, `key-${id}`, at],
            );
        await insert('future-kind', 'l1', 'poll-vote', '{}', 1);
        await insert('future-version', 'l2', MESSAGE.kind, '{"text":"x"}', 2);
        await insert('bad-payload', 'l3', MESSAGE.kind, '{"words":"x"}', 1);
        await insert('behind', 'l1', MESSAGE.kind, '{"text":"waits"}', 1, 2);
        await outbox.dispose();
        const before = await onDisk();

        const again = await reopen();
        expect(again.status()).toMatchObject({ waiting: 4, undecodable: 3, readOnly: false });
        await again.enqueue(message('fine', { lane: 'l4' }));
        again.start();
        await again.idle();
        expect([...server.received.keys()]).toEqual([expect.stringMatching(/^m-/)]);
        expect(await onDisk()).toEqual(before);
    });

    it('sends nothing from a read-only user.db and refuses new writes', async () => {
        const store = await userDb();
        directories.push(store.directory);
        const first = await store.open();
        await first.db.run(
            `INSERT INTO outbox (id, lane, kind, payload, payloadVersion, idempotencyKey, state, createdAt)
             VALUES ('m-old', 'chat:1', ?, '{"text":"old"}', 1, 'k', 'inflight', 1)`,
            [MESSAGE.kind],
        );
        await first.db.exec('PRAGMA user_version = 99');
        await first.db.close();
        const file = await store.open();
        files.push(file);
        expect(file.state).toMatchObject({ writable: false, reason: 'newer' });
        const server = fakeMessageServer();
        const outbox = await openOutbox({ db: file.db, state: file.state, kinds: KINDS, fetch: fetchTo(server) });
        outboxes.push(outbox);
        expect(outbox.rows()).toEqual([expect.objectContaining({ id: 'm-old', state: 'unknown' })]);
        expect(outbox.status()).toMatchObject({ readOnly: true, undecodable: 1 });
        await expect(outbox.enqueue(message('new'))).rejects.toThrow(UPDATE_TO_SEND);
        outbox.start();
        await outbox.idle();
        expect(server.log).toEqual([]);
    });
});

describe('rows that may have reached the server', () => {
    it('marks a row in flight when the app died unknown as it opens, and checks it before sending again', async () => {
        const { outbox, file, server, reopen, onDisk } = await setup();
        const write = message('sent?');
        await outbox.enqueue(write);
        await file.db.run("UPDATE outbox SET state = 'inflight'");
        await outbox.dispose();

        const again = await reopen();
        expect(again.rows()).toEqual([expect.objectContaining({ id: write.id, state: 'unknown' })]);
        expect(await onDisk()).toEqual([expect.objectContaining({ state: 'unknown' })]);
        again.start();
        await again.idle();
        // Not there: the check found it absent, so it went, once.
        expect(server.log).toEqual([`GET /api/test/messages/${write.id}`, 'POST /api/test/messages']);
        expect(server.received.get(write.id)).toBe(1);
        expect(await onDisk()).toEqual([]);
    });

    it('settles an unknown row the server has without sending it again', async () => {
        const { outbox, file, server, reopen, onDisk } = await setup();
        const write = message('arrived');
        await outbox.enqueue(write);
        await file.db.run("UPDATE outbox SET state = 'inflight'");
        server.received.set(write.id, 1);
        await outbox.dispose();
        const again = await reopen();
        again.start();
        await again.idle();
        expect(server.log).toEqual([`GET /api/test/messages/${write.id}`]);
        expect(server.received.get(write.id)).toBe(1);
        expect(await onDisk()).toEqual([]);
    });

    it('leaves an unknown row of a kind with no check for the person, and holds its lane', async () => {
        const { outbox, file, server, reopen } = await setup();
        const write = message('unchecked', { kind: UNCHECKED.kind });
        const behind = message('behind it', { kind: UNCHECKED.kind });
        await outbox.enqueue(write);
        await outbox.enqueue(behind);
        await file.db.run('UPDATE outbox SET state = ? WHERE id = ?', ['inflight', write.id]);
        await outbox.dispose();
        const again = await reopen();
        again.start();
        await again.idle();
        expect(server.log).toEqual([]);
        expect(await again.sendNow(write.id)).toBe(true);
        await again.idle();
        expect([...server.received.keys()]).toEqual([write.id, behind.id]);
    });

    it('sends an unknown row of a kind that is safe to repeat again, unchecked', async () => {
        const { outbox, file, server, reopen } = await setup();
        const write = message('repeat me', { kind: REPEATABLE.kind });
        await outbox.enqueue(write);
        await file.db.run("UPDATE outbox SET state = 'inflight'");
        await outbox.dispose();
        const again = await reopen();
        again.start();
        await again.idle();
        expect(server.log).toEqual(['POST /api/test/messages']);
    });

    it('makes a request that broke off unknown for a kind that isn’t safe to repeat, then checks it', async () => {
        const { outbox, server } = await setup({
            wrapFetch: (f) => {
                let first = true;
                return async (input, init) => {
                    const response = await f(input, init);
                    if (first && init?.method === 'POST') {
                        first = false;
                        throw new NetworkError(input);
                    }
                    return response;
                };
            },
        });
        const write = message('cut off');
        await outbox.enqueue(write);
        outbox.start();
        await outbox.idle();
        // It arrived before the answer broke off: the check finds it, and it never goes twice.
        expect(server.log).toEqual(['POST /api/test/messages', `GET /api/test/messages/${write.id}`]);
        expect(server.received.get(write.id)).toBe(1);
        expect(outbox.rows()).toEqual([]);
    });

    it('marks rows in flight unknown on disk before interrupt stops their requests, then checks them', async () => {
        const { outbox, server, onDisk } = await setup();
        server.hang(true);
        const write = message('grace ran out');
        await outbox.enqueue(write);
        outbox.start();
        await turns();
        expect(outbox.status().inflight).toBe(1);
        server.hang(false);
        await outbox.interrupt();
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/test/messages', `GET /api/test/messages/${write.id}`]);
        expect(server.received.get(write.id)).toBe(1);
        expect(await onDisk()).toEqual([]);
    });

    it('settles a row whose answer came after interrupt marked it unknown', async () => {
        const answer = gate();
        const { outbox, onDisk, server } = await setup({
            wrapFetch: (f) => async (input, init) => {
                const response = await f(input, { ...init, signal: undefined });
                await answer.wait();
                return response;
            },
        });
        await outbox.enqueue(message('late answer'));
        outbox.start();
        await turns();
        const stopped = outbox.interrupt();
        await stopped;
        expect(await onDisk()).toEqual([expect.objectContaining({ state: 'unknown' })]);
        answer.open();
        await outbox.idle();
        expect(await onDisk()).toEqual([]);
        expect(server.log).toEqual(['POST /api/test/messages']);
    });

    it('on dispose, marks rows in flight unknown first, then writes nothing more and takes no write', async () => {
        const { outbox, server, onDisk } = await setup();
        server.hang(true);
        await outbox.enqueue(message('switching away'));
        outbox.start();
        await turns();
        await outbox.dispose();
        expect(await onDisk()).toEqual([expect.objectContaining({ state: 'unknown', attempts: 1 })]);
        await expect(outbox.enqueue(message('too late'))).rejects.toThrow(/closed/);
        await turns();
        expect(await onDisk()).toHaveLength(1);
    });
});

describe('a stop at every moment of a dispatch', () => {
    it(
        'never leaves a row in flight on disk, and never sends after dispose or interrupt',
        { timeout: 60_000 },
        async () => {
            for (let wait = 0; wait < 8; wait += 1) {
                for (const stop of ['dispose', 'interrupt'] as const) {
                    const { outbox, server, onDisk } = await setup();
                    server.hang(true);
                    await outbox.enqueue(message(`stop after ${wait}`));
                    outbox.start();
                    for (let tick = 0; tick < wait; tick += 1) {
                        await Promise.resolve();
                    }
                    await (stop === 'dispose' ? outbox.dispose() : outbox.interrupt());
                    const states = (await onDisk()).map((row) => row.state);
                    expect(states).not.toContain('inflight');
                    if (stop === 'dispose') {
                        const sent = server.log.length;
                        await turns();
                        expect(server.log).toHaveLength(sent);
                        expect(server.received.size).toBeLessThanOrEqual(1);
                    } else {
                        server.hang(false);
                        outbox.poke();
                        await outbox.idle();
                        expect(await onDisk()).toEqual([]);
                        expect([...server.received.values()]).toEqual([1]);
                    }
                }
            }
        },
    );
});

describe('a kill between every two steps', () => {
    /**
     * Runs one launch of the phone: opens the outbox on a new connection to
     * user.db, starts it and enqueues `write` if asked, with a kill at step
     * `at` (none: -1). Resolves once it is idle, or the kill came and
     * everything that could settle has.
     */
    async function launch(
        store: Awaited<ReturnType<typeof userDb>>,
        server: FakeMessageServer,
        at: number,
        write?: ReturnType<typeof message>,
    ): Promise<{ killed: boolean; steps: string[]; enqueued: boolean }> {
        const kill = killAt(at);
        const file = await store.open();
        files.push(file);
        let enqueued = false;
        const run = (async () => {
            const outbox = await openOutbox({
                db: kill.db(file.db),
                state: file.state,
                kinds: KINDS,
                fetch: kill.fetch(fetchTo(server)),
                random: () => 0.5,
            });
            outbox.start();
            if (write !== undefined) {
                await outbox.enqueue(write);
                enqueued = true;
            }
            await outbox.idle();
            await outbox.dispose();
        })();
        await Promise.race([
            run,
            (async () => {
                while (!kill.killed) {
                    await turns(1);
                }
                await turns();
            })(),
        ]);
        return { killed: kill.killed, steps: kill.steps, enqueued };
    }

    it('loses no write and sends none twice, wherever the app dies, twice over', { timeout: 120_000 }, async () => {
        const store = await userDb();
        directories.push(store.directory);
        const server = fakeMessageServer();

        // The steps of one send, unkilled.
        const clean = await launch(store, server, -1, message('count the steps'));
        expect(clean.steps).toEqual([
            'run UPDATE outbox',
            'transaction',
            'run UPDATE outbox',
            'send POST /api/test/messages',
            'answer POST /api/test/messages',
            'transaction',
        ]);

        let cases = 0;
        for (let first = 0; first < clean.steps.length; first += 1) {
            for (let second = 0; ; second += 1) {
                const write = message(`kill at ${first}, then ${second}`);
                const one = await launch(store, server, first, write);
                expect(one.killed).toBe(true);
                const two = await launch(store, server, second);
                const three = await launch(store, server, -1);
                expect(three.killed).toBe(false);
                // A write is the person's once its enqueue resolved; one killed before its commit never was.
                const arrived = server.received.get(write.id) ?? 0;
                const stored = first > 1;
                expect({ first, second, arrived }).toEqual({ first, second, arrived: stored ? 1 : 0 });
                // The enqueue resolved for every kill after its commit, and only then: the composer clears then.
                expect(one.enqueued).toBe(stored);
                const file = files.at(-1) as UserDb;
                expect(await file.db.all('SELECT id FROM outbox')).toEqual([]);
                cases += 1;
                if (!two.killed) {
                    break;
                }
            }
        }
        expect(cases).toBeGreaterThan(clean.steps.length);
        for (const count of server.received.values()) {
            expect(count).toBe(1);
        }
    });
});
