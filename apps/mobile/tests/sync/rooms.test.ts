import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { STEERING_MAX_CHARS } from '@socio/shared/chat/steering';
import type { Conversation } from '@socio/shared/types';

import { withChatWrites } from '../../src/chat/long-press';
import { openCacheDb } from '../../src/data';
import { unsentWhy } from '../../src/shell/unsent';
import { editQueuedMessage } from '../../src/sync/chat-manage';
import { CHAT_WAIT, MESSAGE_IDS } from '../../src/sync/chat-send';
import type { ChatFollow, FollowStore } from '../../src/sync/follow';
import type { OutboxContext, OutboxRow, OutboxWrite } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import { markRoomRead, ROOM_READ_VIEW, roomReadKind, type RoomReadPayload } from '../../src/sync/room-send';
import {
    createRoomViews,
    createRoomWatch,
    ROOM_PRESENCE_POLL_MS,
    ROOM_VIEW_POLL_MS,
    roomReadOnly,
} from '../../src/sync/rooms';
import { createRunFailures, RUN_FAILURES_KEPT } from '../../src/sync/run-failures';
import { CONVERSATIONS } from '../../src/sync/shell';
import type { AppStateSource } from '../../src/sync/triggers';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

import { CACHE_KEY } from './helpers';
import { turns } from './outbox-fakes';
import { BEN, cleanup, openRoom, ROOM, roomServer, roomSetup, roomView, settleRoom } from './room-server';

// A room's data: the room message and
// read mark kinds on a real outbox, history store and steering snapshot against
// room-server.ts's fake room, the room view's bounded kind and its polls, and the
// RUN_ERROR codes kept past `/history`.

afterEach(async () => {
    vi.useRealTimers();
    await cleanup();
});

describe('a message in a room', () => {
    it('goes as steering with its mentions, starts the turn, and leaves the outbox once the history stores it', async () => {
        const server = roomServer();
        const s = await roomSetup(server);
        await openRoom(s);
        await s.send('@Ben look', 'm-1', [{ userId: BEN, label: 'Ben' }]);
        await settleRoom(s);
        expect(server.steeringBodies).toEqual([{ text: '@Ben look', mentions: [{ userId: BEN, label: 'Ben' }] }]);
        expect(server.running).toBe(true);
        expect(s.outbox.rows().map((row) => row.state)).toEqual(['sent']);
        expect(s.outbox.resolve(MESSAGE_IDS, 'm-1')).toBe(server.queue[0]!.id);
        server.finishTurn();
        await s.histories.history(ROOM).pull();
        await settleRoom(s);
        expect(s.outbox.rows()).toEqual([]);
        expect(server.count('@Ben look')).toBe(1);
    });

    it('a kill mid-send leaves exactly one message, even when another member sent the same text', async () => {
        const server = roomServer();
        server.steeringScripts.push('hang');
        const s = await roomSetup(server);
        await openRoom(s);
        await s.send('ok', 'm-1');
        // Its POST arrived; the answer never comes before the kill.
        await turns(30);
        // Ben says "ok" too, and the turn stores the reader's.
        server.benSends('ok');
        server.finishTurn();
        const after = await s.relaunch();
        await settleRoom(after);
        await openRoom(after);
        await settleRoom(after);
        expect(after.outbox.holds()).toEqual([]);
        const mine = server.runs.at(-1)!.messages[0]!.id;
        expect(after.outbox.resolve(MESSAGE_IDS, 'm-1')).toBe(mine);
        expect(server.count('ok')).toBe(1);
        expect(server.count('ok', BEN)).toBe(1);
        expect(after.outbox.rows()).toEqual([]);
    });

    it('a room’s refusal goes to unsent by its code, a Telegram topic’s by its kind, never the server’s text', async () => {
        const server = roomServer();
        server.steeringScripts.push(
            { status: 409, body: { error: 'Rooms are turned off in Settings.', code: 'rooms_off' } },
            { status: 409, body: { error: 'Send messages for this conversation in Telegram.' } },
        );
        const s = await roomSetup(server);
        await openRoom(s);
        await s.send('first', 'm-1');
        await settleRoom(s);
        await s.outbox.discardUnsent('m-1');
        await s.send('second', 'm-2');
        await settleRoom(s);
        const reasons = s.outbox.unsent().map((write) => write.reason);
        expect(reasons).toEqual(['telegram']);
        expect(unsentWhy('rooms_off')).toBe('Rooms are turned off');
        expect(unsentWhy('telegram')).toBe('Send this one in Telegram');
    });

    it('Rooms off or the room archived make it read-only', () => {
        const room = {} as Pick<Conversation, 'archivedAt'>;
        expect(roomReadOnly(room, roomView(), true)).toBeUndefined();
        expect(roomReadOnly(room, roomView(), false)).toMatch(/^Rooms are turned off/);
        expect(roomReadOnly(room, roomView({ roomsEnabled: false }), true)).toMatch(/^Rooms are turned off/);
        expect(roomReadOnly(room, roomView({ archivedAt: 5 }), true)).toMatch(/archived/);
        expect(roomReadOnly({ archivedAt: 5 }, null, true)).toMatch(/archived/);
    });

    it('a room that is gone sends its messages to the Unsent list as lost access', async () => {
        const server = roomServer();
        const s = await roomSetup(server);
        await openRoom(s);
        server.offline(true);
        await s.send('anyone?', 'm-1');
        await turns(20);
        server.lose();
        server.offline(false);
        await s.histories.history(ROOM).pull();
        await settleRoom(s);
        expect(s.histories.history(ROOM).state.gone).toBe(true);
        expect(s.outbox.unsent().map((write) => write.reason)).toEqual(['gone']);
        expect(unsentWhy('gone')).toBe('You no longer have access');
        expect(server.count('anyone?')).toBe(0);
    });

    it('asks before it goes past someone else’s turns, and a text over the limit is unsent', async () => {
        const server = roomServer();
        const s = await roomSetup(server);
        await openRoom(s);
        server.offline(true);
        await s.send('late', 'm-1');
        await turns(20);
        server.benSends('one');
        server.benSends('two');
        server.offline(false);
        s.outbox.wake();
        await settleRoom(s);
        expect(s.outbox.rows().map((row) => [row.state, row.lastError])).toEqual([['held', CHAT_WAIT.ask]]);
        expect(server.count('late')).toBe(0);
        await s.outbox.remove('m-1', s.outbox.revisionOf('m-1'));
        await s.send('x'.repeat(STEERING_MAX_CHARS + 1), 'm-2');
        await settleRoom(s);
        expect(s.outbox.unsent().map((write) => write.reason)).toEqual(['too-large']);
    });

    it('a queued room message is edited in place, keeping only the mentions still in its text', async () => {
        const server = roomServer();
        // Written before this launch: it is held to ask first, so it can be edited on the phone.
        const s = await roomSetup(server, { launchedAt: Number.MAX_SAFE_INTEGER });
        await openRoom(s);
        await s.send('@Ben and @Cy', 'm-1', [
            { userId: BEN, label: 'Ben' },
            { userId: 'u-cy', label: 'Cy' },
        ]);
        await settleRoom(s);
        expect(s.outbox.rows()[0]!.state).toBe('held');
        expect(
            await editQueuedMessage(s.outbox, { threadId: ROOM, messageId: 'm-1', text: 'just @Cy', newId: () => 'x' }),
        ).toBe('in-place');
        const payload = JSON.parse(s.outbox.rows()[0]!.payload) as { text: string; mentions?: unknown };
        expect(payload).toMatchObject({ text: 'just @Cy', mentions: [{ userId: 'u-cy', label: 'Cy' }] });
    });

    it('keeps a room admin’s view of everyone else’s queued messages (the steering snapshot’s `others`)', async () => {
        const server = roomServer();
        server.othersQueued('from Ben');
        const s = await roomSetup(server);
        await openRoom(s);
        expect(s.steering.steering(ROOM).state.others.map((message) => message.text)).toEqual(['from Ben']);
    });
});

describe('read marks', () => {
    it('collapse to the newest, never go backwards, and clear the unread count at once', async () => {
        const server = roomServer();
        const s = await roomSetup(server);
        server.offline(true);
        let n = 0;
        const newId = () => `read-${++n}`;
        expect(await markRoomRead(s.outbox, ROOM, 10, newId)).toBe(true);
        await turns(20);
        expect(await markRoomRead(s.outbox, ROOM, 20, newId)).toBe(true);
        expect(await markRoomRead(s.outbox, ROOM, 15, newId)).toBe(false);
        const rows = s.outbox.rows();
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.payload)).toEqual({ roomId: ROOM, seq: 20 });
        const room = { id: ROOM, kind: 'room', title: 'A: launch room', unread: 4, createdAt: 1 } as Conversation;
        const overlays = overlaysOf({ rows, kinds: [ROOM_READ_VIEW], scope: { resolve: () => null } });
        expect(withChatWrites([room], overlays)[0]!.unread).toBe(0);
        server.offline(false);
        s.outbox.wake();
        await settleRoom(s);
        expect(server.reads).toEqual([{ seq: 20 }]);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('hands the answer’s count to cache.db’s row, and drops a refusal', async () => {
        const room = { id: ROOM, kind: 'room', title: 'A: launch room', unread: 4, createdAt: 1 } as Conversation;
        const confirmed: unknown[] = [];
        const kind = roomReadKind({
            cache: {
                rows: (name: string) =>
                    new Map(name === CONVERSATIONS ? [[ROOM, { json: JSON.stringify(room), version: null }]] : []),
                confirm: async (row: unknown) => void confirmed.push(row),
            } as never,
        });
        const write = { row: {} as OutboxRow, payload: { roomId: ROOM, seq: 30 } } as OutboxWrite<RoomReadPayload>;
        const context = (status: number, body: unknown): OutboxContext => ({
            fetch: async () => new Response(JSON.stringify(body), { status }),
            signal: new AbortController().signal,
            resolve: () => null,
            claimed: () => false,
        });
        const done = await kind.send(write, context(200, { lastSeq: 30, unread: 0 }));
        expect(done.action).toBe('done');
        await (done as { handOff?: () => Promise<void> }).handOff?.();
        expect(confirmed).toEqual([{ collection: CONVERSATIONS, scope: '', key: ROOM, value: { ...room, unread: 0 } }]);
        expect(await kind.send(write, context(404, { code: 'not_found' }))).toEqual({ action: 'done' });
    });
});

describe('the room view and its polls', () => {
    async function views(server = roomServer(), onGone?: (roomId: string) => void) {
        const directory = mkdtempSync(join(tmpdir(), 'socio-room-view-'));
        const { db } = await openCacheDb(createNodeSqliteDriver(), directory, CACHE_KEY);
        const store = createRoomViews({ db, fetch: server.fetch, ...(onGone ? { onGone } : {}) });
        return {
            server,
            db,
            store,
            async close() {
                await store.close();
                await db.close();
                rmSync(directory, { recursive: true, force: true });
            },
        };
    }

    function fakeFollow() {
        const listeners = new Set<() => void>();
        const follow = {
            state: { ended: null as string | null },
            subscribe: (listener: () => void) => {
                listeners.add(listener);
                return () => void listeners.delete(listener);
            },
        };
        return {
            follows: { follow: () => follow as unknown as ChatFollow } as Pick<FollowStore, 'follow'>,
            close(reason: string) {
                follow.state = { ended: reason };
                for (const listener of listeners) {
                    listener();
                }
            },
        };
    }

    function appState(initial = 'active') {
        let current = initial;
        const listeners = new Set<(state: string) => void>();
        return {
            source: {
                current: () => current,
                subscribe: (listener: (state: string) => void) => {
                    listeners.add(listener);
                    return () => void listeners.delete(listener);
                },
            } satisfies AppStateSource,
            set(state: string) {
                current = state;
                for (const listener of listeners) {
                    listener(state);
                }
            },
        };
    }

    const viewReads = (server: ReturnType<typeof roomServer>) =>
        server.log.filter((line) => line === `GET /api/rooms/${ROOM}`).length;
    const presenceReads = (server: ReturnType<typeof roomServer>) =>
        server.log.filter((line) => line === `GET /api/rooms/${ROOM}/presence`).length;

    it('is kept in cache.db, so a room opens offline with its header', async () => {
        const v = await views();
        const item = v.store.item(ROOM);
        const release = item.use();
        await vi.waitFor(() => expect(item.state.value?.title).toBe('A: launch room'));
        release();
        await v.store.flush();
        const again = createRoomViews({ db: v.db, fetch: v.server.fetch });
        v.server.offline(true);
        const preloaded = await again.preload(ROOM);
        expect(preloaded.state.value?.members.map((member) => member.name)).toEqual(['Ada', 'Ben']);
        await again.close();
        await v.close();
    });

    it('is read every 10 s and its presence every 5 s while shown in the foreground, and again on return', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        const v = await views();
        const follow = fakeFollow();
        const app = appState();
        const watch = createRoomWatch({
            views: v.store,
            follows: follow.follows,
            fetch: v.server.fetch,
            appState: app.source,
        });
        const release = watch.show(ROOM);
        await vi.advanceTimersByTimeAsync(0);
        expect(viewReads(v.server)).toBe(1);
        expect(watch.presence(ROOM).state.people.map((person) => person.name)).toEqual(['Ben']);
        await vi.advanceTimersByTimeAsync(ROOM_VIEW_POLL_MS);
        expect(viewReads(v.server)).toBe(2);
        expect(presenceReads(v.server)).toBe(1 + ROOM_VIEW_POLL_MS / ROOM_PRESENCE_POLL_MS);
        // In the background nothing is asked; back in the foreground both are read at once.
        app.set('background');
        await vi.advanceTimersByTimeAsync(ROOM_VIEW_POLL_MS * 3);
        expect(viewReads(v.server)).toBe(2);
        app.set('active');
        await vi.advanceTimersByTimeAsync(0);
        expect(viewReads(v.server)).toBe(3);
        release();
        await vi.advanceTimersByTimeAsync(ROOM_VIEW_POLL_MS * 3);
        expect(viewReads(v.server)).toBe(3);
        expect(watch.presence(ROOM).state.people).toEqual([]);
        watch.close();
        await v.close();
    });

    it('a `closed` frame with a reason reads the view again; a presence 404 empties it and stops asking', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        const v = await views();
        const follow = fakeFollow();
        const watch = createRoomWatch({
            views: v.store,
            follows: follow.follows,
            fetch: v.server.fetch,
            appState: appState().source,
        });
        watch.show(ROOM);
        await vi.advanceTimersByTimeAsync(0);
        v.server.setView(roomView({ roomsEnabled: false }));
        follow.close('rooms_off');
        await vi.advanceTimersByTimeAsync(0);
        expect(viewReads(v.server)).toBe(2);
        expect(v.store.item(ROOM).state.value?.roomsEnabled).toBe(false);
        v.server.losePresence();
        await vi.advanceTimersByTimeAsync(ROOM_PRESENCE_POLL_MS);
        expect(watch.presence(ROOM).state).toEqual({ people: [], gone: true });
        const asked = presenceReads(v.server);
        await vi.advanceTimersByTimeAsync(ROOM_PRESENCE_POLL_MS * 3);
        expect(presenceReads(v.server)).toBe(asked);
        watch.close();
        await v.close();
    });

    it('a room the reader lost drops its view and tells `onGone`', async () => {
        const gone: string[] = [];
        const v = await views(roomServer(), (roomId) => gone.push(roomId));
        v.server.lose();
        const item = v.store.item(ROOM);
        item.use();
        await vi.waitFor(() => expect(item.state.gone).toBe(true));
        expect(gone).toEqual([ROOM]);
        await v.close();
    });
});

describe('RUN_ERROR codes kept past /history', () => {
    function kv() {
        const values = new Map<string, string>();
        return {
            get: (key: string) => values.get(key) ?? null,
            set: (key: string, value: string) => void values.set(key, value),
        };
    }

    it('keeps each run’s code across a restart, never text, at most RUN_FAILURES_KEPT', () => {
        const state = kv();
        const failures = createRunFailures(state);
        failures.note('run-1', 'cycle_tokens');
        failures.note('run-2', 'This message used the most model tokens.');
        failures.note('run-3', undefined);
        expect(createRunFailures(state).codeOf('run-1')).toBe('cycle_tokens');
        expect(failures.codeOf('run-2')).toBeUndefined();
        expect(failures.codeOf('run-3')).toBeUndefined();
        for (let index = 0; index < RUN_FAILURES_KEPT; index += 1) {
            failures.note(`run-x${index}`, 'time_limit');
        }
        const reopened = createRunFailures(state);
        expect(reopened.codeOf('run-1')).toBeUndefined();
        expect(reopened.codeOf(`run-x${RUN_FAILURES_KEPT - 1}`)).toBe('time_limit');
    });
});
