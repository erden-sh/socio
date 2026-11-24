import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStateStoreConformance } from '@copilotkit/channels-core/testing';
import { afterEach, expect, it } from 'vitest';

import { SqliteStateStore } from '../src/server/telegram/channel-state.js';

import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

runStateStoreConformance(
    'SqliteStateStore',
    () => new SqliteStateStore(testDatabase()),
    async (store) => (store as SqliteStateStore).close(),
);

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

it('expires kv, lists, locks and dedup keys on their TTLs', async () => {
    let now = 1_000;
    const store = new SqliteStateStore(testDatabase(), () => now);
    await store.kv.set('k', 'v', 100);
    await store.list.append('l', 1, { ttlMs: 100 });
    expect(await store.lock.acquire('lock', { ttlMs: 100 })).not.toBeNull();
    expect(await store.dedup.seen('d', 100)).toBe(false);
    expect(await store.dedup.seen('d', 100)).toBe(true);
    now += 101;
    expect(await store.kv.get('k')).toBeUndefined();
    expect(await store.list.range('l')).toEqual([]);
    expect(await store.lock.acquire('lock')).not.toBeNull();
    expect(await store.dedup.seen('d', 100)).toBe(false);
    store.close();
});

it('lets only one holder take a lock, and only the holder release it', async () => {
    const store = new SqliteStateStore(testDatabase());
    const first = await store.lock.acquire('turn');
    expect(first).not.toBeNull();
    expect(await store.lock.acquire('turn')).toBeNull();
    await store.lock.release('turn', 'not-the-token');
    expect(await store.lock.acquire('turn')).toBeNull();
    await store.lock.release('turn', first!.token);
    expect(await store.lock.acquire('turn')).not.toBeNull();
    store.close();
});

it('keeps state across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-state-'));
    dirs.push(dir);
    const path = testDatabaseFile(join(dir, 'state.sqlite'));
    let store = new SqliteStateStore(path);
    await store.kv.set('action:1', { pending: true });
    await store.list.append('history', 'a');
    await store.list.append('history', 'b');
    await store.queue.enqueue('q', 'job');
    expect(await store.dedup.seen('message:1', 60_000)).toBe(false);
    const held = await store.lock.acquire('turn', { ttlMs: 60_000 });
    store.close();
    store = new SqliteStateStore(path);
    expect(await store.kv.get('action:1')).toEqual({ pending: true });
    expect(await store.list.range('history')).toEqual(['a', 'b']);
    expect(await store.queue.dequeue('q')).toBe('job');
    expect(await store.dedup.seen('message:1', 60_000)).toBe(true);
    expect(await store.lock.acquire('turn')).toBeNull();
    await store.lock.release('turn', held!.token);
    store.close();
});
