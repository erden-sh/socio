import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';

import { afterCommitEvents } from '@socio/data/events';
import { Mutex, MutexTimeoutError } from '@socio/data/mutex';
import { openDatabase, sqliteData } from '@socio/data/open';
import { SqliteUnitOfWork, UnitOfWorkError } from '@socio/data/uow';
import { conditionalJsonAsync } from '@socio/foundation/http/conditional';

import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

/** A scratch connection with one table, and a unit of work on it. */
function scratch(options: ConstructorParameters<typeof SqliteUnitOfWork>[2]) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    cleanup.push(() => db.close());
    const uow = new SqliteUnitOfWork(db, db, options);
    const insert = (v: string) => uow.executor().prepare('INSERT INTO t (v) VALUES (?)').run(v);
    const values = () =>
        db
            .prepare('SELECT v FROM t ORDER BY id')
            .all()
            .map((row) => row.v);
    return { db, uow, insert, values };
}

it('hands the lock over first come, first served, and times out naming the holder', async () => {
    const mutex = new Mutex(50);
    const order: string[] = [];
    const first = await mutex.acquire('first');
    const second = mutex.acquire('second').then((release) => {
        order.push('second');
        release();
    });
    const third = mutex.acquire('third').then((release) => {
        order.push('third');
        release();
    });
    expect(mutex.heldBy).toBe('first');
    first();
    // A release works once.
    first();
    await Promise.all([second, third]);
    expect(order).toEqual(['second', 'third']);
    expect(mutex.heldBy).toBeUndefined();

    const held = await mutex.acquire('slow import');
    const late = mutex.acquire('board write');
    await expect(late).rejects.toBeInstanceOf(MutexTimeoutError);
    await expect(late).rejects.toThrow(
        '"board write" waited 50 ms for the database write lock, held by "slow import".',
    );
    held();
    // The timed-out waiter left the queue: the lock is free again.
    (await mutex.acquire('next'))();
});

it('commits a unit of work, rolls it back on an error, and joins nested calls', async () => {
    const { db, uow, insert, values } = scratch({ strict: true });
    await uow.run(async () => {
        insert('a');
        expect(db.isTransaction).toBe(true);
        expect(uow.active).toBe(true);
        // A nested call joins the same transaction.
        await uow.run(async () => insert('b'));
    });
    expect(db.isTransaction).toBe(false);
    expect(uow.active).toBe(false);
    await expect(
        uow.run(async () => {
            insert('c');
            await uow.run(async () => insert('d'));
            throw new Error('no');
        }),
    ).rejects.toThrow('no');
    expect(values()).toEqual(['a', 'b']);
    expect(db.isTransaction).toBe(false);
});

it('rolls a savepoint back alone, with the effects it registered', async () => {
    const { uow, insert, values } = scratch({ strict: true });
    const effects: string[] = [];
    await uow.run(async () => {
        insert('kept');
        uow.afterCommit(() => void effects.push('outer'));
        await uow
            .run(
                async () => {
                    insert('dropped');
                    uow.afterCommit(() => void effects.push('inner'));
                    throw new Error('inner fails');
                },
                { savepoint: true },
            )
            .catch(() => undefined);
        await uow.run(async () => insert('also kept'), { savepoint: true });
    });
    expect(values()).toEqual(['kept', 'also kept']);
    expect(effects).toEqual(['outer']);
});

it('runs after-commit effects once committed, in order, never on rollback', async () => {
    const lines: string[] = [];
    const { db, uow, insert, values } = scratch({
        strict: true,
        log: (line) => lines.push(line),
    });
    const seen: string[] = [];
    const result = await uow.run(async () => {
        insert('a');
        uow.afterCommit(() => {
            // The commit is done and the lock released: a new unit may start.
            expect(db.isTransaction).toBe(false);
            seen.push(`first saw ${values().join(',')}`);
        });
        uow.afterCommit(async () => {
            await uow.run(async () => insert('from an effect'));
            seen.push('second');
        });
        uow.afterCommit(() => {
            throw new TypeError('effect bug');
        });
        uow.afterCommit(() => void seen.push('after the failure'));
        return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual(['first saw a', 'second', 'after the failure']);
    expect(lines).toEqual(['After-commit effect failed (unit of work): TypeError']);
    expect(values()).toEqual(['a', 'from an effect']);

    await uow
        .run(async () => {
            uow.afterCommit(() => void seen.push('never'));
            throw new Error('rolled back');
        })
        .catch(() => undefined);
    expect(seen).not.toContain('never');
});

it('runs one unit of work at a time on a connection', async () => {
    const { uow, insert, values } = scratch({ strict: true });
    // Two callers that don't share an async context queue for the lock.
    await Promise.all([
        uow.run(async () => {
            insert('a1');
            await Promise.resolve();
            insert('a2');
        }),
        uow.run(async () => {
            insert('b1');
            await Promise.resolve();
            insert('b2');
        }),
    ]);
    expect(values()).toEqual(['a1', 'a2', 'b1', 'b2']);
});

it('fails a unit of work that spans the event loop in tests, and logs it once in production', async () => {
    const strict = scratch({ strict: true });
    await expect(
        strict.uow.run(
            async () => {
                strict.insert('a');
                await new Promise((resolve) => setTimeout(resolve, 5));
            },
            { label: 'slow filing' },
        ),
    ).rejects.toThrow(new UnitOfWorkError('A unit of work spanned the event loop: slow filing'));
    // Rolled back, and the connection is free again.
    expect(strict.values()).toEqual([]);
    expect(strict.db.isTransaction).toBe(false);

    const lines: string[] = [];
    const production = scratch({
        strict: false,
        log: (line) => lines.push(line),
    });
    for (const value of ['a', 'b']) {
        await production.uow.run(
            async () => {
                production.insert(value);
                await new Promise((resolve) => setImmediate(resolve));
            },
            { label: 'slow filing' },
        );
    }
    expect(production.values()).toEqual(['a', 'b']);
    expect(lines).toEqual(['A unit of work spanned the event loop: slow filing']);
});

it('catches work that outlives its unit of work', async () => {
    const strict = scratch({ strict: true });
    let leaked: Promise<unknown> | undefined;
    await strict.uow.run(
        async () => {
            // Fire-and-forget work keeps the unit's async context.
            leaked = new Promise((resolve) => setTimeout(resolve, 1)).then(() => strict.insert('late'));
        },
        { label: 'filing' },
    );
    await expect(leaked).rejects.toThrow('A unit of work was used after it ended: filing');
    // A new unit started from there is its own.
    let fresh: Promise<unknown> | undefined;
    await strict.uow.run(async () => {
        fresh = new Promise((resolve) => setTimeout(resolve, 1)).then(() =>
            strict.uow.run(async () => strict.insert('own unit')),
        );
    });
    await fresh;
    expect(strict.values()).toEqual(['own unit']);
});

it('delivers domain events after the commit, to each subscriber, never on rollback', async () => {
    const { uow } = scratch({ strict: true });
    const failures: string[] = [];
    const events = afterCommitEvents<{ filed: { n: number } }>(uow, (type) => failures.push(String(type)));
    const seen: string[] = [];
    const off = events.subscribe('filed', ({ n }) => void seen.push(`a${n}`));
    events.subscribe('filed', () => {
        throw new Error('subscriber bug');
    });
    events.subscribe('filed', async ({ n }) => void seen.push(`c${n}`));
    await uow.run(async () => {
        events.publish('filed', { n: 1 });
        expect(seen).toEqual([]);
    });
    expect(seen).toEqual(['a1', 'c1']);
    expect(failures).toEqual(['filed']);
    await uow
        .run(async () => {
            events.publish('filed', { n: 2 });
            throw new Error('rolled back');
        })
        .catch(() => undefined);
    off();
    await uow.run(async () => events.publish('filed', { n: 3 }));
    expect(seen).toEqual(['a1', 'c1', 'c3']);
});

it('opens the database with the pragmas, and keeps one data layer per connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openDatabase(testDatabaseFile(join(dir, 'nested', 'app.sqlite')), {});
    cleanup.push(() => db.close());
    const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0];
    expect(pragma('journal_mode')).toBe('wal');
    expect(pragma('busy_timeout')).toBe(5000);
    expect(pragma('synchronous')).toBe(1);
    expect(sqliteData(db)).toBe(sqliteData(db));
    expect(sqliteData(db)).not.toBe(sqliteData(new DatabaseSync(':memory:')));
});

it('shares one connection between the core store and the workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const connection = openDatabase(testDatabaseFile(join(dir, 'app.sqlite')), {});
    const store = new Store(connection);
    const workspace = new WorkspaceStore(connection);
    // Both migrated their sets on it; the workspace's unit of work is its.
    expect(store.settings().name).toBe('Socio');
    expect(workspace.data.uow).toBe(sqliteData(connection).uow);
    // One transaction now spans what used to be two connections.
    const space = await workspace.data.uow.run(async () => {
        await store.assignUnowned('alice');
        expect(connection.isTransaction).toBe(true);
        return workspace.createSpace('Inside', '');
    });
    // The stores don't close a connection they were given.
    store.close();
    workspace.close();
    expect(connection.isOpen).toBe(true);
    expect(workspace.spaces().map((row) => row.id)).toContain(space.id);
    connection.close();
    // A store given a path still owns, and closes, its own.
    const own = new Store(testDatabaseFile(join(dir, 'own.sqlite')));
    own.close();
    expect(() => own.settings()).toThrow();
});

it('answers an async polled view, reading the version before the build', async () => {
    let counter = 1;
    let body = { n: 1 };
    const app = new Hono();
    app.get('/view', (c) =>
        conditionalJsonAsync(
            c,
            async () => {
                await Promise.resolve();
                return body;
            },
            async () => `v${counter}`,
        ),
    );
    const first = await app.request('/view');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ n: 1 });
    const tag = first.headers.get('ETag')!;
    const again = await app.request('/view', {
        headers: { 'If-None-Match': tag },
    });
    expect(again.status).toBe(304);
    // A write: a new version and body.
    counter = 2;
    body = { n: 2 };
    const changed = await app.request('/view', {
        headers: { 'If-None-Match': tag },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ n: 2 });
    // A missing dependency (the body changed, the version didn't) still
    // fails the audit, as with conditionalJson.
    const current = changed.headers.get('ETag')!;
    body = { n: 3 };
    const audited = await app.request('/view', {
        headers: { 'If-None-Match': current },
    });
    expect(audited.status).toBe(500);
});
