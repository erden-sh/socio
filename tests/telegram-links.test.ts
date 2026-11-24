import { afterEach, expect, it } from 'vitest';

import { LINK_CODE_TTL_MS } from '../src/server/telegram/telegram-links.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const stores: WorkspaceStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const links = () => {
    const workspace = new WorkspaceStore(testDatabase());
    stores.push(workspace);
    return workspace.telegram;
};

it('links a Telegram account with a one-time code and unlinks it', async () => {
    const store = links();
    const { code, expiresAt } = await store.createCode('alice', 1_000);
    expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(expiresAt).toBe(1_000 + LINK_CODE_TTL_MS);
    expect(await store.userFor('42')).toBeUndefined();
    expect(await store.redeem(code, '42', 'alice_tg', 2_000)).toEqual({
        ok: true,
        userId: 'alice',
    });
    expect(await store.userFor('42')).toBe('alice');
    expect(await store.linkFor('alice')).toEqual({
        telegramUserId: '42',
        username: 'alice_tg',
        linkedAt: 2_000,
    });
    expect(await store.unlink('alice')).toBe(true);
    expect(await store.userFor('42')).toBeUndefined();
    expect(await store.unlink('alice')).toBe(false);
});

it('refuses expired, reused, superseded and unknown codes', async () => {
    const store = links();
    const expired = (await store.createCode('alice', 0)).code;
    expect(await store.redeem(expired, '42', null, LINK_CODE_TTL_MS)).toEqual({
        ok: false,
        reason: 'expired',
    });
    const once = (await store.createCode('alice', 10)).code;
    expect((await store.redeem(once, '42', null, 20)).ok).toBe(true);
    expect(await store.redeem(once, '43', null, 30)).toEqual({
        ok: false,
        reason: 'used',
    });
    expect(await store.userFor('43')).toBeUndefined();
    const first = (await store.createCode('bob', 40)).code;
    const second = (await store.createCode('bob', 50)).code;
    expect(await store.redeem(first, '44', null, 60)).toEqual({
        ok: false,
        reason: 'invalid',
    });
    expect((await store.redeem(second, '44', null, 60)).ok).toBe(true);
    expect((await store.redeem('nope', '45')).ok).toBe(false);
    expect(await store.redeem('bad code!', '45')).toEqual({
        ok: false,
        reason: 'invalid',
    });
});

it('keeps one Telegram account per user and one user per Telegram account', async () => {
    const store = links();
    await store.redeem((await store.createCode('alice', 0)).code, '42', null, 1);
    // Alice relinks from another Telegram account: the old one is released.
    await store.redeem((await store.createCode('alice', 2)).code, '99', null, 3);
    expect(await store.userFor('42')).toBeUndefined();
    expect(await store.userFor('99')).toBe('alice');
    // Bob redeems from Alice's Telegram account: it moves to Bob.
    await store.redeem((await store.createCode('bob', 4)).code, '99', null, 5);
    expect(await store.userFor('99')).toBe('bob');
    expect(await store.linkFor('alice')).toBeUndefined();
});
