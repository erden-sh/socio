import { afterEach, expect, it, vi } from 'vitest';

import type { Conversation } from '@socio/shared/types';

import type { TelegramConversationKind } from '../src/server/integrations/contract.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// WorkspaceStore.conversations used to look up each row's Telegram facts on
// its own (9 ms for 500 rows); it now asks once per list. The list must be
// the same as before, row for row and byte for byte as JSON.
const stores: WorkspaceStore[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    stores.splice(0).forEach((store) => store.close());
});

/** A small seeded generator, so the set is the same on every run. */
function generator(seed: number) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

async function seeded() {
    const workspace = new WorkspaceStore(testDatabase());
    stores.push(workspace);
    const dot = workspace.dots()[0]!;
    const random = generator(42);
    const users = ['alice', 'bob', 'carol'];
    const kinds: Array<TelegramConversationKind | null> = [null, null, 'dm', 'group', 'topic'];
    const chats = ['-100', '-200', '-300'];
    for (let index = 0; index < 300; index++) {
        const id = `thread-${String(index).padStart(3, '0')}`;
        const owner = users[Math.floor(random() * users.length)]!;
        workspace.bindThread(id, dot.id, `Conversation ${index}`, owner);
        const kind = kinds[Math.floor(random() * kinds.length)]!;
        if (kind === 'dm') {
            await workspace.telegram.bindThread(`dm:${index}`, id, kind, `${index}`, null);
        } else if (kind) {
            const chat = chats[Math.floor(random() * chats.length)]!;
            const topic = kind === 'topic' ? `${index}` : null;
            await workspace.telegram.bindThread(`${kind}:${chat}:${index}`, id, kind, chat, topic);
        } else if (random() < 0.2) {
            await workspace.deleteThread(id, owner);
        }
    }
    // Alice is in two group chats (team topics she doesn't own), Bob in one,
    // Carol in none.
    await workspace.telegram.recordMember('-100', 'alice');
    await workspace.telegram.recordMember('-200', 'alice');
    await workspace.telegram.recordMember('-200', 'bob');
    return { workspace, users };
}

/** The list as the store built it before: one Telegram lookup per row. */
async function oneLookupPerRow(workspace: WorkspaceStore, userId: string) {
    const team = new Set(await workspace.telegram.teamThreadsFor(userId));
    const rows: Conversation[] = [];
    for (const listed of await workspace.conversations(userId)) {
        const row = workspace.thread(listed.id)!;
        const telegram = await workspace.telegram.threadInfo(listed.id);
        rows.push(
            telegram
                ? {
                      ...row,
                      source: 'telegram',
                      telegram,
                      ...(team.has(row.id) ? { team: true } : {}),
                  }
                : row,
        );
    }
    return rows;
}

it('lists the same conversations as one lookup per row did', async () => {
    const { workspace, users } = await seeded();
    let telegramRows = 0;
    let teamRows = 0;
    for (const user of users) {
        const listed = await workspace.conversations(user);
        const before = await oneLookupPerRow(workspace, user);
        expect(listed).toEqual(before);
        expect(JSON.stringify(listed)).toBe(JSON.stringify(before));
        telegramRows += listed.filter((row) => row.telegram).length;
        teamRows += listed.filter((row) => row.team).length;
    }
    // The set covers every case: web, Telegram of each kind, team topics.
    expect(telegramRows).toBeGreaterThan(50);
    expect(teamRows).toBeGreaterThan(5);
    const kinds = new Set<string>();
    for (const user of users) {
        for (const row of await workspace.conversations(user)) {
            kinds.add(row.telegram?.kind ?? 'web');
        }
    }
    expect(kinds).toEqual(new Set(['web', 'dm', 'group', 'topic']));
});

it('asks for Telegram facts once per list', async () => {
    const { workspace } = await seeded();
    const single = vi.spyOn(workspace.telegram, 'threadInfo');
    const batch = vi.spyOn(workspace.telegram, 'threadInfos');
    expect((await workspace.conversations('alice')).length).toBeGreaterThan(50);
    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
});

it('returns only Telegram threads from threadInfos', async () => {
    const { workspace } = await seeded();
    const ids = (await workspace.conversations('alice')).map((row) => row.id);
    const infos = await workspace.telegram.threadInfos([...ids, 'no-such-thread']);
    for (const id of ids) {
        expect(infos.get(id)).toEqual(await workspace.telegram.threadInfo(id));
    }
    expect(infos.has('no-such-thread')).toBe(false);
    expect((await workspace.telegram.threadInfos([])).size).toBe(0);
});
