import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ReactionsView } from '@socio/shared/chat/reactions';
import type { Conversation } from '@socio/shared/types';

import {
    accessibilityActionsOf,
    chatRowMenu,
    deleteSentence,
    messageMenu,
    messageRowActions,
    reactionOf,
    notSaved,
    REACTION_NOT_SAVED,
    withChatWrites,
} from '../../src/chat/long-press';
import { readNameSuggestion, settleNameSuggestion } from '../../src/chat/name-suggestion';
import { hasReactions, reactionButtons, reactionSaid, reactionsShown, withReaction } from '../../src/chat/reactions';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { CHAT_MANAGE_VIEWS } from '../../src/sync/chat-manage';
import type { OutboxRow } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';

// Reactions, the long-press menus and the name suggestion, under Node.

const row = (id: string, kind: string, payload: unknown, extra: Partial<OutboxRow> = {}): OutboxRow =>
    ({
        id,
        lane: `lane-${id}`,
        kind,
        payload: JSON.stringify(payload),
        payloadVersion: 1,
        idempotencyKey: `k-${id}`,
        state: 'queued',
        attempts: 0,
        createdAt: Number(id.replace(/\D/g, '')) || 1,
        nextAt: 0,
        lastError: null,
        ...extra,
    }) as OutboxRow;
const scope = { resolve: () => null };
const overlays = (rows: OutboxRow[]) => overlaysOf({ rows, kinds: CHAT_MANAGE_VIEWS, scope });

describe('reactions', () => {
    const view: ReactionsView = { shared: false, messages: { a1: { counts: { up: 1 }, mine: ['up'] } } };

    it("lays the outbox's reactions over the view in order, up and down excluding each other", () => {
        const shown = reactionsShown(
            view,
            overlays([
                row('r1', 'reaction', { threadId: 'c1', messageId: 'a1', reaction: 'down', on: true }),
                row('r2', 'reaction', { threadId: 'c1', messageId: 'a2', reaction: 'retry', on: true }),
                row('r3', 'reaction', { threadId: 'c2', messageId: 'a1', reaction: 'up', on: false }),
            ]),
            'c1',
        );
        expect(shown.messages).toEqual({
            a1: { counts: { down: 1 }, mine: ['down'] },
            a2: { counts: { retry: 1 }, mine: ['retry'] },
        });
    });

    it('drops a message with nothing left, and shows counts only when others see the chat or more than one gave it', () => {
        expect(withReaction(view, 'a1', 'up', false).messages).toEqual({});
        expect(hasReactions(view, 'a1')).toBe(true);
        const buttons = reactionButtons(
            { shared: false, messages: { a1: { counts: { up: 2, down: 1 }, mine: [] } } },
            'a1',
        );
        expect(buttons.map((b) => [b.kind, b.count, b.accessibilityLabel])).toEqual([
            ['up', 2, 'Good reply, 2'],
            ['down', null, 'Bad reply'],
            ['retry', null, 'Try again'],
            ['needs-work', null, 'Needs work'],
        ]);
        expect(reactionButtons({ ...view, shared: true }, 'a1')[0]).toMatchObject({ on: true, count: 1 });
        expect(reactionSaid('up', true)).toBe('Good reply removed');
    });
});

describe('long-press menus, also accessibility actions', () => {
    it('gives a message Copy and Share, and a stored reply its reactions as toggles', () => {
        expect(messageMenu(null).map((a) => a.label)).toEqual(['Copy', 'Share']);
        const menu = messageMenu(
            reactionButtons({ shared: false, messages: { a1: { counts: { up: 1 }, mine: ['up'] } } }, 'a1'),
        );
        expect(menu.map((a) => a.label)).toEqual([
            'Copy',
            'Share',
            'Remove “Good reply”',
            'Bad reply',
            'Try again',
            'Needs work',
        ]);
        expect(reactionOf(menu[2]!.name)).toBe('up');
        expect(reactionOf('copy')).toBeNull();
        expect(accessibilityActionsOf(menu)).toHaveLength(6);
    });

    it('puts the action row under every message (owner, 2026-11-18): Copy, a stored reply’s reactions, the time', () => {
        const view: ReactionsView = { shared: false, messages: {} };
        const buttons = () => reactionButtons(view, 'a1');
        // Every finished reply, not only the newest: Copy and the four reactions, in the web's order.
        const reply = messageRowActions({ kind: 'reply', text: 'Done.', streaming: false, stored: true }, buttons);
        expect(reply?.reactions?.map((button) => button.kind)).toEqual(['up', 'down', 'retry', 'needs-work']);
        // The person's own message: Copy and the time only.
        expect(messageRowActions({ kind: 'user', text: 'Hi' }, buttons)).toEqual({ reactions: null });
        // A reply not stored yet takes no reactions; one still being written, or with no words, has no row.
        expect(messageRowActions({ kind: 'reply', text: 'Done.', streaming: false, stored: false }, buttons)).toEqual({
            reactions: null,
        });
        expect(messageRowActions({ kind: 'reply', text: 'Do', streaming: true, stored: false }, buttons)).toBeNull();
        expect(messageRowActions({ kind: 'user', text: '  ' }, buttons)).toBeNull();
    });

    it("draws the row under every message with Copy first, and no More button (the web's MessageActions)", () => {
        const read = (file: string) => readFileSync(new URL(`../../src/screens/${file}`, import.meta.url), 'utf8');
        const chat = read('chat.tsx');
        expect(chat).toContain('rowActions={messageRowActions(item, () => reactionButtons(shownReactions, item.id))}');
        expect(chat).not.toContain('lastReply');
        expect(chat).not.toContain('MoreButton');
        const cards = read('chat-cards.tsx');
        const row = cards.slice(cards.indexOf('export function MessageActionRow'));
        expect(row.indexOf('-copy`')).toBeGreaterThan(0);
        expect(row.indexOf('-copy`')).toBeLessThan(row.indexOf('(buttons ?? []).map'));
        expect(row.indexOf('(buttons ?? []).map')).toBeLessThan(row.indexOf('-time`'));
        expect(row).toContain('accessibilityActions={accessibilityActionsOf(actions)}');
    });

    it('gives a private chat Rename, Archive and a destructive Delete, and a room nothing', () => {
        expect(chatRowMenu({ room: false }).map((a) => [a.name, a.destructive === true])).toEqual([
            ['rename', false],
            ['archive', false],
            ['delete', true],
        ]);
        expect(chatRowMenu({ room: true })).toEqual([]);
        expect(deleteSentence('Plans')).toBe('This will delete “Plans”.');
    });
});

describe("the chat list with this device's writes", () => {
    const chat = (id: string, extra: Partial<Conversation> = {}) =>
        ({ id, title: `Chat ${id}`, dotId: 'd1', createdAt: 1, ...extra }) as Conversation;

    it('shows a rename, an archive, an undo and a delete at once, and nothing of a refused write', () => {
        const chats = [chat('c1'), chat('c2'), chat('c3'), chat('c4', { archivedAt: 5 })];
        const shown = withChatWrites(
            chats,
            overlaysOf({
                rows: [
                    row('w1', 'chat-update', { threadId: 'c1', title: 'Renamed' }),
                    row('w2', 'chat-update', { threadId: 'c2', archived: true }),
                    row('w3', 'chat-delete', { threadId: 'c3' }),
                    row('w4', 'chat-update', { threadId: 'c4', archived: false }),
                ],
                unsent: [
                    {
                        id: 'w5',
                        kind: 'chat-update',
                        payload: JSON.stringify({ threadId: 'c1', title: 'Refused' }),
                        payloadVersion: 1,
                        createdAt: 9,
                        reason: 'title',
                    } as never,
                ],
                kinds: CHAT_MANAGE_VIEWS,
                scope,
            }),
        );
        expect(shown.map((c) => [c.id, c.title, c.archivedAt ?? null])).toEqual([
            ['c1', 'Renamed', null],
            ['c2', 'Chat c2', 1],
            ['c4', 'Chat c4', null],
        ]);
        expect(withChatWrites(chats, [])).toBe(chats);
    });
});

describe('a refused write and what waits behind it', () => {
    const chat = (id: string) => ({ id, title: `Chat ${id}`, dotId: 'd1', createdAt: 1 }) as Conversation;
    const refused = (id: string, kind: string, payload: unknown, createdAt: number) =>
        ({
            id,
            kind,
            payload: JSON.stringify(payload),
            payloadVersion: 1,
            createdAt,
            reason: 'blocked-telegram',
        }) as never;

    it("lays neither, says it with the chat's name, and leaves other chats' writes", () => {
        const chats = [chat('c1'), chat('c2')];
        const items = overlaysOf({
            rows: [
                row('w2', 'chat-update', { threadId: 'c1', archived: true }),
                row('w3', 'chat-update', { threadId: 'c2', title: 'Other' }),
            ],
            unsent: [refused('w1', 'chat-delete', { threadId: 'c1' }, 1)],
            kinds: CHAT_MANAGE_VIEWS,
            scope,
        });
        expect(withChatWrites(chats, items).map((c) => [c.id, c.title, c.archivedAt ?? null])).toEqual([
            ['c1', 'Chat c1', null],
            ['c2', 'Other', null],
        ]);
        expect(notSaved(items, { chats })).toEqual([{ id: 'w1', text: 'Couldn’t delete “Chat c1”.' }]);
        const words = (payload: unknown) =>
            notSaved(
                overlaysOf({
                    rows: [],
                    unsent: [refused('w9', 'chat-update', payload, 1)],
                    kinds: CHAT_MANAGE_VIEWS,
                    scope,
                }),
                { chats },
            )[0]?.text;
        expect(words({ threadId: 'c1', title: 'X' })).toBe('Couldn’t rename “Chat c1”.');
        expect(words({ threadId: 'c1', archived: true })).toBe('Couldn’t archive “Chat c1”.');
        expect(words({ threadId: 'c1', archived: false })).toBe('Couldn’t bring back “Chat c1”.');
        expect(words({ threadId: 'c1', title: 'X', archived: true })).toBe('Couldn’t change “Chat c1”.');
        expect(words({ threadId: 'gone', title: 'X' })).toBe('Couldn’t rename “this chat”.');
    });

    it('keeps a reaction waiting behind a refused one off the reply, and says it in that chat only', () => {
        const view: ReactionsView = { shared: false, messages: {} };
        const items = overlaysOf({
            rows: [
                row('w2', 'reaction', { threadId: 't1', messageId: 'a1', reaction: 'down', on: true }),
                row('w3', 'reaction', { threadId: 't1', messageId: 'a2', reaction: 'up', on: true }),
            ],
            unsent: [refused('w1', 'reaction', { threadId: 't1', messageId: 'a1', reaction: 'up', on: true }, 1)],
            kinds: CHAT_MANAGE_VIEWS,
            scope,
        });
        expect(reactionsShown(view, items, 't1').messages).toEqual({ a2: { counts: { up: 1 }, mine: ['up'] } });
        expect(notSaved(items, { threadId: 't1' })).toEqual([{ id: 'w1', text: REACTION_NOT_SAVED }]);
        expect(notSaved(items, { threadId: 't2' })).toEqual([]);
        expect(notSaved(items, { chats: [] })).toEqual([]);
    });
});

describe('the name suggestion', () => {
    const fake = (answers: Record<string, Response | Error>) => {
        const asked: { path: string; init: unknown }[] = [];
        const fetch: AuthedFetch = async (path, init) => {
            asked.push({ path, init });
            const answer = answers[path];
            if (answer instanceof Error || answer === undefined) {
                throw answer ?? new Error('no answer');
            }
            return answer;
        };
        return { fetch, asked };
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    it('reads the pending name, and none from an error or an empty suggestion', async () => {
        const { fetch } = fake({
            '/api/chats/c1/name-suggestion': json({ suggestion: { suggestedName: 'Trip to Lisbon' } }),
            '/api/chats/c2/name-suggestion': json({ suggestion: null }),
            '/api/chats/c3/name-suggestion': json({ error: 'Not found.' }, 404),
        });
        expect(await readNameSuggestion(fetch, 'c1')).toBe('Trip to Lisbon');
        expect(await readNameSuggestion(fetch, 'c2')).toBeNull();
        expect(await readNameSuggestion(fetch, 'c3')).toBeNull();
    });

    it('settles it, a 404 (settled elsewhere) included; a custom name is checked first and sent trimmed', async () => {
        const base = '/api/chats/c1/name-suggestion';
        const { fetch, asked } = fake({
            [`${base}/accept`]: json({ ok: true, title: 'Trip' }),
            [`${base}/reject`]: json({ error: 'No pending suggestion.' }, 404),
            [`${base}/customize`]: json({ error: 'x' }, 500),
        });
        expect(await settleNameSuggestion(fetch, 'c1', 'accept')).toBe('done');
        expect(await settleNameSuggestion(fetch, 'c1', 'reject')).toBe('done');
        expect(await settleNameSuggestion(fetch, 'c1', 'customize', '   ')).toBe('invalid');
        expect(await settleNameSuggestion(fetch, 'c1', 'customize', '  Mine ')).toBe('failed');
        expect(asked.at(-1)).toEqual({ path: `${base}/customize`, init: { method: 'POST', json: { name: 'Mine' } } });
        expect(await settleNameSuggestion(fake({}).fetch, 'c1', 'accept')).toBe('failed');
    });
});
