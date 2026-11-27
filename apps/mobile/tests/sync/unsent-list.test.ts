import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Store, UserDb } from '../../src/data';
import { ROUTES } from '../../src/navigation/routes';
import type { FetchFunction } from '../../src/net/fetch-function';
import { UNTITLED_CHAT } from '../../src/shell/chat-list';
import {
    UNKNOWN_CHAT,
    shownUnsent,
    unsentBadge,
    UNSENT_SHOWN,
    unsentListRows,
    unsentWhy,
    UNSENT_FALLBACK,
} from '../../src/shell/unsent';
import { CHAT_UPDATE_KIND, REACTION_KIND } from '../../src/sync/chat-manage';
import { CHAT_MESSAGE_KIND } from '../../src/sync/chat-send';
import { NEW_CHAT_KIND } from '../../src/sync/new-chat';
import {
    type Outbox,
    type OutboxKind,
    openOutbox,
    type SendOutcome,
    UNSENT_GONE,
    type UnsentWrite,
} from '../../src/sync/outbox';
import { COALESCE_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, ORIGIN, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, WIFI } from './fakes';
import { fakeWorkspaceServer } from './helpers';
import { turns, userDb } from './outbox-fakes';
import { signedIn, wire } from './wire';

// The Unsent list: a chat that answers 404 or
// 410 moves its queued messages to `unsent` with "You no longer have access"
// (the history store's `onGone`, through the scope, into the outbox's
// `refuseLanes`), held ones and those behind them included; a `sent` row goes
// and one in flight settles by its own answer. The account sheet's rows
// (src/shell/unsent.ts) give Copy exactly what was written, and Discard takes
// the write out for good, across a relaunch.

const GONE = 'gone-1';

/** A chat message kind that waits on the person: what a held message (ask first) looks like. */
const HELD: OutboxKind<{ threadId: string; text: string }> = {
    kind: CHAT_MESSAGE_KIND,
    payloadVersion: 1,
    repeatable: false,
    send: async (): Promise<SendOutcome> => ({ action: 'hold', reason: 'ask' }),
};

const chatMessage = (id: string, text: string, createdBy = GONE) => ({
    id,
    lane: `chat:${createdBy}`,
    kind: CHAT_MESSAGE_KIND,
    payload: JSON.stringify({ threadId: createdBy, dotId: 'dot-1', text, watermark: {} }),
    payloadVersion: 1,
    idempotencyKey: `key-${id}`,
});

describe('a chat deleted with a queued message (the scope)', () => {
    let device: Phone;
    const scopes: WorkspaceScope[] = [];
    const stores: Store[] = [];

    beforeEach(() => {
        device = phone(mkdtempSync(join(tmpdir(), 'socio-unsent-')));
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

    async function setup(status: 404 | 410) {
        const { store } = await launch(device);
        stores.push(store);
        const clock = clocks();
        const server = fakeWorkspaceServer(clock);
        const net = wire(new Map([[ORIGIN, server]]));
        const id = await signedIn(store, ORIGIN, server, clock);
        // The deleted chat's history answers 404 or 410; everything else is the workspace's.
        const fetch: FetchFunction = (url: string, init: FetchRequestInit) =>
            new URL(url).pathname === `/api/conversations/${GONE}/history`
                ? Promise.resolve(new Response(JSON.stringify({ code: 'not_found' }), { status }))
                : net.fetch(url, init);
        const errors: unknown[] = [];
        const open = async () => {
            const scope = await openWorkspaceScope({
                store,
                workspaceId: id,
                fetch,
                userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
                variant: 'production',
                appState: fakeAppState('active'),
                network: fakeNetwork(WIFI),
                outboxKinds: [HELD] as OutboxKind<unknown>[],
                onError: (error) => errors.push(error),
                random: () => 0.5,
            });
            scopes.push(scope);
            return scope;
        };
        return { open, errors };
    }

    for (const status of [404, 410] as const) {
        it(`a ${status} moves the chat's messages, held and queued behind, to unsent: "You no longer have access"`, async () => {
            const s = await setup(status);
            const scope = await s.open();
            scope.start();
            await vi.advanceTimersByTimeAsync(COALESCE_MS);
            await scope.outbox.enqueue(chatMessage('m-1', 'first, held'));
            await scope.outbox.enqueue(chatMessage('m-2', 'second, behind it'));
            await scope.outbox.enqueue(chatMessage('m-3', 'another chat', 'other-1'));
            await turns();
            await scope.outbox.idle();
            expect(scope.outbox.rows().find((row) => row.id === 'm-1')?.state).toBe('held');

            await scope.histories.history(GONE).pull();
            await turns();
            await scope.outbox.idle();

            expect(scope.outbox.unsent().map((write) => [write.id, write.reason])).toEqual([
                ['m-1', UNSENT_GONE],
                ['m-2', UNSENT_GONE],
            ]);
            // Another chat's message stays where it was.
            expect(scope.outbox.rows().map((row) => row.id)).toEqual(['m-3']);
            expect(scope.collections.pending.has('m-1')).toBe(false);
            expect(scope.outbox.status().unsent).toBe(2);

            const rows = unsentListRows(scope.outbox.unsent(), scope.outbox.holds(), {
                chatTitle: () => null,
                resolve: () => null,
            });
            expect(rows.map((row) => [row.what, row.where, row.text, row.why])).toEqual([
                ['Message', UNKNOWN_CHAT, 'first, held', 'You no longer have access'],
                ['Message', UNKNOWN_CHAT, 'second, behind it', 'You no longer have access'],
            ]);
            expect(unsentBadge(rows.length)).toBe('2');
            expect(s.errors).toEqual([]);
        });
    }

    it('Copy takes what was written; Discard takes it out for good, across a relaunch', async () => {
        const s = await setup(404);
        let scope = await s.open();
        scope.start();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        const written = 'A long thought,\nwith a second line and an emoji 🙂';
        await scope.outbox.enqueue(chatMessage('m-1', written));
        await scope.outbox.enqueue(chatMessage('m-2', 'keep me'));
        await turns();
        await scope.histories.history(GONE).pull();
        await turns();
        await scope.outbox.idle();

        const [first] = unsentListRows(scope.outbox.unsent(), scope.outbox.holds(), {
            chatTitle: () => null,
            resolve: () => null,
        });
        expect(first?.text).toBe(written);

        expect(await scope.outbox.discardUnsent('m-1')).toMatchObject({ id: 'm-1' });
        expect(scope.outbox.unsent().map((write) => write.id)).toEqual(['m-2']);
        await scope.dispose();

        scope = await s.open();
        expect(scope.outbox.unsent().map((write) => [write.id, write.reason])).toEqual([['m-2', UNSENT_GONE]]);
        expect(scope.outbox.rows()).toEqual([]);
    });
});

describe('refuseLanes (the outbox)', () => {
    const outboxes: Outbox[] = [];
    const files: UserDb[] = [];
    const directories: string[] = [];
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

    it('drops a sent row, leaves one in flight to its answer, and keeps what it moved across a reopen', async () => {
        const store = await userDb();
        directories.push(store.directory);
        let release: (outcome: SendOutcome) => void = () => {};
        const kind: OutboxKind<{ text: string }> = {
            kind: CHAT_MESSAGE_KIND,
            payloadVersion: 1,
            repeatable: false,
            send: ({ payload }) =>
                payload.text === 'stored later'
                    ? Promise.resolve({ action: 'done', awaitStored: true })
                    : new Promise((resolve) => {
                          release = resolve;
                      }),
        };
        const open = async () => {
            const file = await store.open();
            files.push(file);
            const outbox = await openOutbox({
                db: file.db,
                state: file.state,
                kinds: [kind] as OutboxKind<unknown>[],
                fetch: (() => Promise.reject(new Error('no fetch'))) as never,
            });
            outboxes.push(outbox);
            return outbox;
        };
        const outbox = await open();
        outbox.start();
        await outbox.enqueue(chatMessage('sent', 'stored later', 'a'));
        await outbox.enqueue(chatMessage('flying', 'in flight', 'a'));
        await outbox.enqueue(chatMessage('queued', 'behind it', 'a'));
        await turns();
        expect(outbox.rows().map((row) => [row.id, row.state])).toEqual([
            ['sent', 'sent'],
            ['flying', 'inflight'],
            ['queued', 'queued'],
        ]);

        expect(await outbox.refuseLanes(['chat:a'], UNSENT_GONE)).toEqual(['queued']);
        expect(outbox.rows().map((row) => row.id)).toEqual(['flying']);

        // The request in flight finds the chat gone too.
        release({ action: 'unsent', reason: UNSENT_GONE });
        await turns();
        await outbox.idle();
        expect(outbox.unsent().map((write) => write.id)).toEqual(['flying', 'queued']);
        expect(await outbox.refuseLanes(['chat:a'], UNSENT_GONE)).toEqual([]);
        await outbox.dispose();

        const again = await open();
        expect(again.rows()).toEqual([]);
        expect(again.unsent().map((write) => [write.id, write.lane, write.reason])).toEqual([
            ['flying', 'chat:a', UNSENT_GONE],
            ['queued', 'chat:a', UNSENT_GONE],
        ]);
    });
});

describe('the Unsent list rows (src/shell/unsent.ts)', () => {
    const write = (over: Partial<UnsentWrite> & Pick<UnsentWrite, 'id' | 'kind' | 'payload'>): UnsentWrite => ({
        lane: 'chat:c1',
        dependsOn: null,
        payloadVersion: 1,
        reason: UNSENT_GONE,
        createdAt: 1,
        ...over,
    });

    it('says what each was, where, and why, oldest first, with what it holds back', () => {
        const rows = unsentListRows(
            [
                write({
                    id: 'r',
                    kind: REACTION_KIND,
                    payload: JSON.stringify({ threadId: 'c1', messageId: 'x', reaction: 'up', on: true }),
                    createdAt: 3,
                }),
                write({
                    id: 'n',
                    kind: NEW_CHAT_KIND,
                    payload: JSON.stringify({ dotId: 'd', title: 'Plans for Friday', after: null }),
                    reason: 'socio-gone',
                    createdAt: 2,
                }),
                write({
                    id: 'm',
                    kind: CHAT_MESSAGE_KIND,
                    payload: JSON.stringify({ threadId: 'local-1', text: 'hi', attachments: [{}, {}] }),
                    reason: 'http-413',
                    createdAt: 1,
                }),
                write({
                    id: 'u',
                    kind: CHAT_UPDATE_KIND,
                    payload: JSON.stringify({ threadId: 'c2', title: 'New name' }),
                    reason: 'teapot',
                    createdAt: 4,
                }),
                write({ id: 'b', kind: CHAT_MESSAGE_KIND, payload: '{not json', createdAt: 5 }),
            ],
            [
                {
                    root: {
                        id: 'm',
                        kind: CHAT_MESSAGE_KIND,
                        lane: 'chat:local-1',
                        cause: 'unsent',
                        reason: 'http-413',
                    },
                    rows: [{} as never, {} as never],
                },
            ],
            {
                chatTitle: (id) => (id === 'c1' ? 'Budget' : id === 'c2' ? '' : null),
                resolve: (id) => (id === 'local-1' ? 'c1' : null),
            },
        );
        expect(rows.map((row) => [row.id, row.what, row.where, row.text, row.why, row.holding])).toEqual([
            ['m', 'Message with 2 files', 'Budget', 'hi', 'Too long to send', '2 more wait behind it'],
            ['n', 'New chat', 'Plans for Friday', 'Plans for Friday', 'That socio is no longer here', null],
            ['r', 'Reaction', 'Budget', null, 'You no longer have access', null],
            ['u', 'Rename', UNTITLED_CHAT, 'New name', UNSENT_FALLBACK, null],
            ['b', 'Message', 'A chat', null, 'You no longer have access', null],
        ]);
        expect(rows[0]?.accessibilityLabel).toBe(
            'Message with 2 files, Budget, hi, Too long to send, 2 more wait behind it',
        );
        expect(unsentWhy('anything new')).toBe(UNSENT_FALLBACK);
    });

    it('badges 1 to 9, then 9+, and nothing for none', () => {
        expect([0, 1, 9, 10].map(unsentBadge)).toEqual([null, '1', '9', '9+']);
    });
});

describe('the sheet’s Unsent rows', () => {
    it('shows the oldest two, then a button to the Unsent page with every row, never scrolling inside the sheet', () => {
        const rows = Array.from({ length: 7 }, (_, index) => index);
        expect(UNSENT_SHOWN).toBe(2);
        expect(shownUnsent(rows)).toEqual({ shown: rows.slice(0, 2), seeAll: 'See all 7 unsent' });
        expect(shownUnsent(rows.slice(0, 3))).toEqual({ shown: rows.slice(0, 2), seeAll: 'See all 3 unsent' });
        expect(shownUnsent(rows.slice(0, 2))).toEqual({ shown: rows.slice(0, 2), seeAll: null });
        expect(shownUnsent([])).toEqual({ shown: [], seeAll: null });
    });

    it('the Unsent page is a page of the shell, which the sheet opens and which lists every row', () => {
        expect(ROUTES.Unsent.gates).toEqual(['shell']);
        expect(ROUTES.Unsent.preset.presentation).toBe('card');
        const screen = readFileSync(join(import.meta.dirname, '../../src/screens/unsent-list.tsx'), 'utf8');
        // A page of the More tab's stack, which the sheet's See all opens in the tab under it.
        expect(ROUTES.Unsent.tab).toBe('More');
        expect(screen).toContain("navigation.navigate('Unsent' as never)");
        expect(screen).toMatch(
            /function AllUnsent\(\) \{[\s\S]*?const \{ rows, discard, saveAsNew, retry, picker \} = useUnsentRows\(\);[\s\S]*<UnsentRows\s+rows=\{rows\}/,
        );
        // A refused filing's Edit opens FileIssue on it, from the sheet and the page alike.
        expect(screen.match(/navigate\('FileIssue', \{ edit: row\.id \}\)/g)).toHaveLength(2);
    });
});
