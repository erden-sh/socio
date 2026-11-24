import { afterEach, describe, expect, it, vi } from 'vitest';

import { STEERING_MAX_CHARS } from '@socio/shared/chat/steering';
import { type LiveTurn, NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';

import { chatLiveTurn } from '../../src/chat/composer';
import {
    CHAT_WAIT,
    chatMessageKind,
    chatMessageWrite,
    chatWaitCopy,
    MESSAGE_IDS,
    QUEUED_ASK_AFTER_MS,
} from '../../src/sync/chat-send';
import type { OutboxKind } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';

import { BUSY, chatServer, cleanup, DOT, openChat, settle, setup, THREAD } from './chat-server';
import { turns } from './outbox-fakes';

// Sending in a private chat: the chat message kind on a real outbox (user.db),
// history store (cache.db) and steering snapshot, against chat-server.ts's
// fake server. The exit check is no double sends: the server counts every user message it
// receives, by id and by text, and every test ends with each sent once.

afterEach(async () => {
    vi.useRealTimers();
    await cleanup();
});

describe('a message in a private chat', () => {
    it('goes as a run when no turn runs, then leaves the outbox once the stored history has it', async () => {
        const server = chatServer();
        const s = await setup(server);
        await openChat(s);
        await s.send('hello', 'm-1');
        await settle(s);
        expect(server.runBodies).toEqual([[{ id: 'm-1', role: 'user', content: 'hello' }]]);
        expect(server.count('hello')).toBe(1);
        expect(s.outbox.rows()).toEqual([]);
        expect(s.outbox.resolve(MESSAGE_IDS, 'm-1')).toBe('m-1');
    });

    it('a run it POSTs is the follow stream’s own until it ends (one source per run)', async () => {
        const server = chatServer();
        const owned: string[] = [];
        const follows = {
            follow: (threadId: string) => ({
                ownRun: () => {
                    owned.push(`start ${threadId}`);
                    return (end?: { broken?: boolean }) => void owned.push(end?.broken ? 'broken' : 'end');
                },
            }),
        };
        const s = await setup(server, { follows: follows as never });
        await openChat(s);
        await s.send('hello', 'm-1');
        await settle(s);
        expect(owned).toEqual([`start ${THREAD}`, 'end']);
    });

    it('a POST that breaks after RUN_STARTED hands its turn back to the follow stream, never left running', async () => {
        const server = chatServer();
        const shown: LiveTurn[] = [];
        const s = await setup(server, { onTurn: (_threadId, turn) => void shown.push(turn) });
        await openChat(s);
        server.runScripts.push('started-drop');
        await s.send('slow please', 'm-1');
        await settle(s);
        // It runs: RUN_STARTED let the lane go on while the turn streams outside the outbox...
        expect(shown.at(-1)?.running).toBe(true);
        // ...then the break, which the outbox's idle can't wait for, so the test makes it.
        server.dropRun();
        await settle(s);
        // The own turn is no longer running (no pill over the replay)...
        expect(shown.some((turn) => turn.running)).toBe(true);
        const last = shown.at(-1);
        expect(last?.running).toBe(false);
        // ...but keeps the partial reply it streamed, so the text stays on screen until /stream replays it.
        expect(JSON.stringify(last?.messages)).toContain('Second 1.');
        expect(chatLiveTurn(last ?? NO_LIVE_TURN, NO_LIVE_TURN)).toBe(last);
        expect(server.count('slow please')).toBe(1);
    });

    it('two queued rows never share a body: each run carries the stored tail and exactly its own message', async () => {
        const server = chatServer();
        const s = await setup(server);
        await openChat(s);
        await s.send('first', 'm-1');
        await s.send('second', 'm-2');
        await settle(s);
        expect(server.runBodies).toEqual([
            [{ id: 'm-1', role: 'user', content: 'first' }],
            [{ id: 'm-2', role: 'user', content: 'second' }],
        ]);
        expect(server.received.map((message) => message.id)).toEqual(['m-1', 'm-2']);
        expect(s.outbox.rows()).toEqual([]);
    });

    it('a send while a turn runs becomes steering, under the server id the ids map records', async () => {
        const server = chatServer();
        server.startTurn();
        const s = await setup(server);
        await openChat(s);
        await s.send('also this', 'm-1');
        await settle(s);
        expect(server.runBodies).toEqual([]);
        expect(server.queue.map((message) => message.text)).toEqual(['also this']);
        const serverId = server.queue[0]!.id;
        expect(s.outbox.resolve(MESSAGE_IDS, 'm-1')).toBe(serverId);
        // Sent, waiting for the stored history: its bubble hides once the snapshot lists it.
        expect(s.outbox.rows().map((row) => row.state)).toEqual(['sent']);
        expect(s.steering.steering(THREAD).lists(serverId)).toBe(true);

        server.finishTurn();
        await s.histories.history(THREAD).pull();
        await settle(s);
        expect(s.outbox.rows()).toEqual([]);
        expect(server.count('also this')).toBe(1);
    });

    it('a 200 with delivered: true is the server having it', async () => {
        const server = chatServer();
        server.startTurn();
        server.steeringScripts.push('delivered');
        const s = await setup(server);
        await openChat(s);
        await s.send('right now', 'm-1');
        await settle(s);
        expect(s.outbox.rows().map((row) => row.state)).toEqual(['sent']);
        expect(s.outbox.resolve(MESSAGE_IDS, 'm-1')).toMatch(/^srv-/);
        server.finishTurn();
        await s.histories.history(THREAD).pull();
        await settle(s);
        expect(s.outbox.rows()).toEqual([]);
        expect(server.count('right now')).toBe(1);
    });

    it.each(['busy-elsewhere', 'busy-elsewhere-500'] as const)(
        'a busy thread (%s) with a turn started elsewhere re-routes the row to steering in place (correction 1)',
        async (script) => {
            const server = chatServer();
            const s = await setup(server);
            await openChat(s);
            server.runScripts.push(script);
            await s.send('quick question', 'm-1');
            await s.send('and another', 'm-2');
            await settle(s);
            // One run tried and refused; then both went as steering, in order, once each.
            expect(server.runBodies).toHaveLength(1);
            expect(server.queue.map((message) => message.text)).toEqual(['quick question', 'and another']);
            expect(server.count('quick question')).toBe(1);
            expect(server.count('and another')).toBe(1);
            const [first] = s.outbox.rows();
            expect(JSON.parse(first!.payload)).toMatchObject({ steered: true });
            server.finishTurn();
            await s.histories.history(THREAD).pull();
            await settle(s);
            expect(s.outbox.rows()).toEqual([]);
        },
    );

    it('a 500 with no turn running and the message absent backs off and sends again once', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        const s = await setup(server);
        await openChat(s);
        server.runScripts.push('error');
        await s.send('try again', 'm-1');
        await settle(s);
        expect(s.outbox.rows().map((row) => [row.state, row.lastError])).toEqual([['queued', CHAT_WAIT.busy]]);
        expect(server.count('try again')).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
        await settle(s);
        expect(server.runBodies).toHaveLength(2);
        expect(server.count('try again')).toBe(1);
        expect(s.outbox.rows()).toEqual([]);
    });

    // CB-357: a 409 `thread_running` is a definite answer (the server took
    // nothing), so the row is never `unknown`: what can't be told now goes
    // again after the back-off.
    describe('a busy thread’s 409 thread_running (CB-357)', () => {
        it('with no turn running (it ended meanwhile) backs off and sends again once, never unknown', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const server = chatServer();
            const s = await setup(server);
            await openChat(s);
            server.runScripts.push({ status: 409, body: BUSY });
            await s.send('try again', 'm-1');
            await settle(s);
            expect(s.outbox.rows().map((row) => [row.state, row.lastError])).toEqual([['queued', CHAT_WAIT.busy]]);
            expect(server.connects.asked).toBe(0);
            expect(server.count('try again')).toBe(0);
            await vi.advanceTimersByTimeAsync(1_000);
            await settle(s);
            expect(server.runBodies).toHaveLength(2);
            expect(server.count('try again')).toBe(1);
            expect(s.outbox.rows()).toEqual([]);
        });

        it('whose pull fails backs off, never unknown, then goes as steering once', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const server = chatServer();
            const s = await setup(server);
            await openChat(s);
            server.runScripts.push('busy-offline');
            await s.send('quick question', 'm-1');
            await settle(s);
            expect(s.outbox.rows().map((row) => [row.state, row.lastError])).toEqual([['queued', CHAT_WAIT.busy]]);
            expect(server.connects.asked).toBe(0);
            server.offline(false);
            await vi.advanceTimersByTimeAsync(1_000);
            await settle(s);
            expect(server.runBodies).toHaveLength(1);
            expect(server.queue.map((message) => message.text)).toEqual(['quick question']);
            expect(server.count('quick question')).toBe(1);
        });

        it('whose recovery check throws backs off, never unknown, then goes as steering once', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const server = chatServer();
            const s = await setup(server);
            await openChat(s);
            server.failConnects(true);
            server.runScripts.push('busy-elsewhere');
            await s.send('quick question', 'm-1');
            await settle(s);
            // The turn runs, so the replay was asked; it failed, and the row waits.
            expect(server.connects.asked).toBeGreaterThan(0);
            expect(s.outbox.rows().map((row) => [row.state, row.lastError])).toEqual([['queued', CHAT_WAIT.busy]]);
            expect(server.count('quick question')).toBe(0);
            server.failConnects(false);
            await vi.advanceTimersByTimeAsync(1_000);
            await settle(s);
            expect(server.runBodies).toHaveLength(1);
            expect(server.queue.map((message) => message.text)).toEqual(['quick question']);
            expect(server.count('quick question')).toBe(1);
        });
    });

    it('a message over 8000 characters waits for the turn to end and goes as a run', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        server.startTurn();
        const s = await setup(server);
        await openChat(s);
        const long = 'x'.repeat(STEERING_MAX_CHARS + 1);
        await s.send(long, 'm-1');
        await settle(s);
        expect(server.log.filter((line) => line.startsWith('POST'))).toEqual([]);
        const [row] = s.outbox.rows();
        expect(row?.lastError).toBe(CHAT_WAIT.turn);
        expect(chatWaitCopy(row!.lastError, 'Ada')).toBe('Sends when Ada finishes');
        server.finishTurn();
        await vi.advanceTimersByTimeAsync(5_000);
        await settle(s);
        expect(server.runBodies).toHaveLength(1);
        expect(server.count(long)).toBe(1);
    });

    it('the lane never runs more than maxQueued ahead, and a queue_full 429 holds it', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        server.startTurn();
        server.setLimit(1);
        const s = await setup(server);
        await openChat(s);
        await s.send('one', 'm-1');
        await s.send('two', 'm-2');
        await settle(s);
        expect(server.queue.map((message) => message.text)).toEqual(['one']);
        expect(s.outbox.rows().find((row) => row.id === 'm-2')?.lastError).toBe(CHAT_WAIT.queue);
        expect(chatWaitCopy(CHAT_WAIT.queue, 'Ada')).toBe('Waiting for Ada to read your earlier messages');

        // The socio read it; the next steering POST meets a queue_full anyway (another device's).
        server.finishTurn();
        server.startTurn();
        server.steeringScripts.push({ status: 429, body: { code: 'queue_full', limit: 1 } });
        await vi.advanceTimersByTimeAsync(5_000);
        await settle(s);
        expect(server.count('two')).toBe(0);
        expect(s.outbox.rows().find((row) => row.id === 'm-2')?.lastError).toBe('queue_full');
        await vi.advanceTimersByTimeAsync(5_000);
        await settle(s);
        expect(server.count('two')).toBe(1);
    });

    it('a cycle_rate 429 waits out Retry-After', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        server.startTurn();
        server.steeringScripts.push({ status: 429, body: { code: 'cycle_rate' } });
        const s = await setup(server);
        await openChat(s);
        await s.send('slow down', 'm-1');
        await settle(s);
        expect(s.outbox.rows()[0]?.lastError).toBe('cycle_rate');
        await vi.advanceTimersByTimeAsync(59_999);
        await settle(s);
        expect(server.count('slow down')).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        await settle(s);
        expect(server.count('slow down')).toBe(1);
    });

    it('a steering 409 (a Telegram chat) and a 400 without attachments go to unsent', async () => {
        const server = chatServer();
        server.startTurn();
        server.steeringScripts.push({ status: 409 }, { status: 400 });
        const s = await setup(server);
        await openChat(s);
        await s.send('from the app', 'm-1');
        await settle(s);
        expect(s.outbox.unsent().map((write) => [write.id, write.reason])).toEqual([['m-1', 'telegram']]);
        await s.outbox.discardUnsent('m-1');
        await s.send('bad', 'm-2');
        await settle(s);
        expect(s.outbox.unsent().map((write) => [write.id, write.reason])).toEqual([['m-2', 'content']]);
    });

    it('a steering 400 with attachments re-uploads once, then goes to unsent', async () => {
        const server = chatServer();
        server.startTurn();
        server.steeringScripts.push({ status: 400 }, { status: 400 });
        const reupload = vi.fn(async (write: { row: { id: string }; payload: object }) => ({
            action: 'rewrite' as const,
            payload: JSON.stringify({ ...write.payload, reuploaded: true }),
            payloadVersion: 1,
            idempotencyKey: `re-${write.row.id}`,
        }));
        const s = await setup(server, { reupload: reupload as never });
        await openChat(s);
        const write = chatMessageWrite({
            id: 'm-1',
            idempotencyKey: 'k-1',
            threadId: THREAD,
            dotId: DOT,
            text: 'see file',
            attachments: [{ id: 'att_1', name: 'a.png', mediaType: 'image/png', size: 3, kind: 'image' } as never],
            history: s.histories.history(THREAD),
            steering: s.steering.steering(THREAD),
        });
        await s.outbox.enqueue(write);
        await settle(s);
        expect(reupload).toHaveBeenCalledTimes(1);
        expect(s.outbox.unsent().map((unsent) => [unsent.id, unsent.reason])).toEqual([['m-1', 'attachment-expired']]);
    });

    it('with attachments: waits for the uploads, sends the server’s ids, re-uploads by local id after a 400', async () => {
        const server = chatServer();
        server.startTurn();
        server.steeringScripts.push({ status: 400 });
        let ready = false;
        const attachments = {
            prepare: vi.fn(async () => (ready ? null : { action: 'retry' as const, delayMs: 5, reason: 'uploading' })),
            resolve: vi.fn((refs: readonly { id: string }[]) =>
                ready ? refs.map((ref) => ({ ...ref, id: `cbatt_${ref.id}` })) : null,
            ),
            reupload: vi.fn(),
        };
        const s = await setup(server, { attachments: attachments as never });
        await openChat(s);
        const file = { id: 'f1', name: 'a.png', mediaType: 'image/png', size: 3, kind: 'image' as const };
        await s.outbox.enqueue(
            chatMessageWrite({
                id: 'm-1',
                idempotencyKey: 'k-1',
                threadId: THREAD,
                dotId: DOT,
                text: 'see file',
                attachments: [file],
                history: s.histories.history(THREAD),
                steering: s.steering.steering(THREAD),
            }),
        );
        await settle(s);
        expect(server.steeringBodies).toEqual([]);
        ready = true;
        await vi.waitFor(() => expect(server.received.map((message) => message.id)).toHaveLength(1));
        // The first went with the server's id and got a 400: the files went up again, the row by local id.
        expect(attachments.reupload).toHaveBeenCalledWith('m-1');
        // The payload's refs go with it, so a file this device lost sends the row to unsent.
        expect(attachments.prepare).toHaveBeenCalledWith('m-1', [file]);
        expect(server.steeringBodies).toEqual([
            { text: 'see file', attachments: [{ id: 'cbatt_f1' }] },
            { text: 'see file', attachments: [{ id: 'cbatt_f1' }] },
        ]);
        expect(attachments.resolve).toHaveBeenLastCalledWith([file]);
    });

    describe('6.2: a queued message asks before it goes by itself', () => {
        it('after 3 hours (an injected clock), then goes on Send now', async () => {
            const server = chatServer();
            server.offline(true);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const s = await setup(server);
            await s.send('written offline', 'm-1');
            await settle(s);
            s.clock.now += QUEUED_ASK_AFTER_MS + 1;
            server.offline(false);
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(s.outbox.rows().map((row) => [row.state, row.lastError])).toEqual([['held', CHAT_WAIT.ask]]);
            expect(server.count('written offline')).toBe(0);
            expect(await s.outbox.sendNow('m-1')).toBe(true);
            await settle(s);
            expect(server.count('written offline')).toBe(1);
        });

        it('across a restart', async () => {
            const server = chatServer();
            server.offline(true);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const s = await setup(server);
            await s.send('before the restart', 'm-1');
            await settle(s);
            server.offline(false);
            const after = await s.relaunch({ launchedAt: s.clock.now + 1 });
            await settle(after);
            expect(after.outbox.rows().map((row) => row.state)).toEqual(['held']);
            expect(server.count('before the restart')).toBe(0);
        });

        it('when turns finished in the chat since it was written', async () => {
            const server = chatServer();
            server.offline(true);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const s = await setup(server);
            await s.send('stale', 'm-1');
            await settle(s);
            server.storeTurn('from the web');
            server.offline(false);
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(s.outbox.rows().map((row) => row.state)).toEqual(['held']);
            expect(server.count('stale')).toBe(0);
        });
    });

    describe('6.4: a send that may have reached the server is checked, never sent twice', () => {
        it('a steering 500 that queued it: the check finds the one candidate and records its id', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const server = chatServer();
            server.startTurn();
            server.steeringScripts.push('ambiguous');
            const s = await setup(server);
            await openChat(s);
            await s.send('did it go?', 'm-1');
            await settle(s);
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(server.count('did it go?')).toBe(1);
            expect(s.outbox.resolve(MESSAGE_IDS, 'm-1')).toBe(server.queue[0]?.id);
            expect(s.outbox.rows().map((row) => row.state)).toEqual(['sent']);
        });

        it('a run dropped before any answer while its turn runs: the replay of that turn confirms it', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const server = chatServer();
            server.runScripts.push('drop');
            const s = await setup(server);
            await openChat(s);
            await s.send('dropped', 'm-1');
            await settle(s);
            // The running turn's start carries the message: sent, while the turn still streams.
            expect(s.outbox.rows().map((row) => row.state)).toEqual(['sent']);
            expect(server.connects.open).toBe(0);
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(server.runBodies).toHaveLength(1);
            server.finishTurn();
            await s.histories.history(THREAD).pull();
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(server.runBodies).toHaveLength(1);
            expect(server.count('dropped')).toBe(1);
            expect(s.outbox.rows()).toEqual([]);
        });

        it('a run in flight at a kill: after the relaunch its check finds it stored and never sends it again', async () => {
            const server = chatServer();
            const s = await setup(server);
            await openChat(s);
            server.runScripts.push('drop');
            await s.send('killed', 'm-1');
            await settle(s);
            server.finishTurn();
            const after = await s.relaunch();
            await settle(after);
            await openChat(after);
            await settle(after);
            expect(server.runBodies).toHaveLength(1);
            expect(server.count('killed')).toBe(1);
            expect(after.outbox.rows()).toEqual([]);
        });

        it('a steering send forgotten by a kill, with one candidate after the watermark: it is that one', async () => {
            const server = chatServer();
            server.startTurn();
            server.steeringScripts.push('hang');
            const s = await setup(server);
            await openChat(s);
            await s.send('maybe', 'm-1');
            // Its POST arrived; the answer never comes before the kill.
            await turns(30);
            expect(server.queue.map((message) => message.text)).toEqual(['maybe']);
            const after = await s.relaunch();
            await settle(after);
            expect(after.outbox.holds()).toEqual([]);
            expect(after.outbox.resolve(MESSAGE_IDS, 'm-1')).toBe(server.queue[0]?.id);
            expect(server.count('maybe')).toBe(1);
        });

        it('a run answered 502 by a proxy after its turn started is checked, never re-sent as steering', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const server = chatServer();
            server.runScripts.push('proxy-502');
            const s = await setup(server);
            await openChat(s);
            await s.send('through the proxy', 'm-1');
            await settle(s);
            // Its own turn runs, and its replay carries the message: sent, never again as steering.
            expect(s.outbox.rows().map((row) => row.state)).toEqual(['sent']);
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(server.runBodies).toHaveLength(1);
            expect(server.queue).toEqual([]);
            server.finishTurn();
            await s.histories.history(THREAD).pull();
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(server.count('through the proxy')).toBe(1);
            expect(s.outbox.rows()).toEqual([]);
        });

        it('a check on a chat deleted meanwhile moves the row to unsent instead of retrying forever', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const server = chatServer();
            const s = await setup(server);
            await openChat(s);
            // No answer at all: it may have reached the server, so it is checked.
            server.offline(true);
            await s.send('into the void', 'm-1');
            await settle(s);
            expect(s.outbox.rows().map((row) => row.state)).toEqual(['unknown']);
            server.deleteChat();
            server.offline(false);
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(s.outbox.unsent().map((write) => [write.id, write.reason])).toEqual([['m-1', 'gone']]);
            expect(server.count('into the void')).toBe(0);
        });

        it('a busy 500 on a chat deleted meanwhile goes to unsent', async () => {
            const server = chatServer();
            server.runScripts.push('busy-gone');
            const s = await setup(server);
            await openChat(s);
            await s.send('gone mid-send', 'm-1');
            await settle(s);
            expect(server.runBodies).toHaveLength(1);
            expect(s.outbox.unsent().map((write) => [write.id, write.reason])).toEqual([['m-1', 'gone']]);
        });

        it('nothing reached the server and no turn runs: it goes again, once', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const server = chatServer();
            server.startTurn();
            server.steeringScripts.push({ status: 500 });
            const s = await setup(server);
            await openChat(s);
            await s.send('lost', 'm-1');
            await settle(s);
            server.finishTurn();
            await vi.advanceTimersByTimeAsync(60_000);
            await settle(s);
            expect(server.count('lost')).toBe(1);
        });
    });

    it('lays its bubble over the history until the stored history has it', async () => {
        const server = chatServer();
        server.offline(true);
        const s = await setup(server);
        await s.send('hi', 'm-1');
        const kind = chatMessageKind({ histories: s.histories, steering: s.steering, newId: () => 'x' });
        expect(
            overlaysOf({ rows: s.outbox.rows(), kinds: [kind as OutboxKind<unknown>], scope: s.outbox }).map((item) => [
                item.collection,
                item.key,
                item.state,
                item.value,
            ]),
        ).toEqual([
            [
                'history',
                'm-1',
                expect.any(String),
                { threadId: THREAD, message: { id: 'm-1', role: 'user', content: 'hi' }, serverId: null },
            ],
        ]);
    });
});
