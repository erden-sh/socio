import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { SqliteStateStore } from '../src/server/telegram/channel-state';
import {
    bootstrapTelegramIngress,
    signTelegramIngress,
    verifyTelegramIngress,
    type TelegramIngress,
} from '../src/server/telegram/telegram-ingress';

import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

it('bootstraps one stable per-bot key and trust epoch through competing SQLite connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-key-'));
    const path = testDatabaseFile(join(dir, 'state.sqlite'));
    const stores = [new SqliteStateStore(path), new SqliteStateStore(path)];
    try {
        const bootstraps = await Promise.all(
            Array.from({ length: 8 }, (_, i) => bootstrapTelegramIngress(stores[i % 2], '777')),
        );
        expect(new Set(bootstraps.map((x) => x.secret)).size).toBe(1);
        expect(new Set(bootstraps.map((x) => x.primedAt)).size).toBe(1);
        const before = bootstraps[0];
        stores.forEach((s) => s.close());
        const reopened = new SqliteStateStore(path);
        stores.push(reopened);
        const after = await bootstrapTelegramIngress(reopened, '777');
        expect(after.secret === before.secret).toBe(true);
        expect(after.primedAt).toBe(before.primedAt);
        const another = await bootstrapTelegramIngress(reopened, '778');
        expect(another.secret === after.secret).toBe(false);
    } finally {
        stores.forEach((s) => s.close());
        rmSync(dir, { recursive: true, force: true });
    }
});

it('authenticates every public binding and rejects copied, unsigned, oversized or malformed proof', () => {
    const key = 'a'.repeat(64),
        thread = 'thread-1',
        message = 'uuid-1';
    const ingress: TelegramIngress = {
        botId: '777',
        conversationKey: 'tg:42:dm',
        messageId: '10',
        actorId: '42',
    };
    const signature = signTelegramIngress(key, thread, message, ingress);
    expect(verifyTelegramIngress(key, thread, message, ingress, signature)).toBe(true);
    for (const [field, value] of [
        ['botId', '778'],
        ['actorId', '43'],
        ['messageId', '11'],
        ['conversationKey', 'tg:43:dm'],
    ]) {
        expect(verifyTelegramIngress(key, thread, message, { ...ingress, [field]: value }, signature)).toBe(false);
    }
    expect(verifyTelegramIngress(key, 'other-thread', message, ingress, signature)).toBe(false);
    expect(verifyTelegramIngress(key, thread, 'other-message', ingress, signature)).toBe(false);
    expect(verifyTelegramIngress('b'.repeat(64), thread, message, ingress, signature)).toBe(false);
    for (const invalid of [undefined, null, {}, '0'.repeat(64), 'x'.repeat(10000)]) {
        expect(verifyTelegramIngress(key, thread, message, ingress, invalid)).toBe(false);
    }
    expect(signTelegramIngress(key, 'x'.repeat(201), message, ingress)).toBeUndefined();
    expect(
        signTelegramIngress(key, thread, message, {
            ...ingress,
            messageId: 'not-a-number',
        }),
    ).toBeUndefined();
});

it('does not rotate an established proof key silently when state is corrupt', async () => {
    const state = new SqliteStateStore(testDatabase());
    try {
        await bootstrapTelegramIngress(state, '777');
        await state.kv.delete('telegram:ingress:v1:provenance-key:777');
        await expect(bootstrapTelegramIngress(state, '777')).rejects.toThrow('proof key is missing or invalid');
    } finally {
        state.close();
    }
});
