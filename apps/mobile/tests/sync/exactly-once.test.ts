import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Conversation } from '@socio/shared/types';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import { MESSAGE_IDS } from '../../src/sync/chat-send';
import { DEFAULT_CHAT_TITLE, NEW_CHAT_KIND, type NewChatPayload, newChatKind } from '../../src/sync/new-chat';
import type { OutboxContext, OutboxRow } from '../../src/sync/outbox';
import { createServerClock, SERVER_CLOCK_SLACK_MS, serverSince } from '../../src/sync/server-clock';
import { recoverRun } from '../../src/sync/turn-recovery';

import { chatServer, cleanup, DOT, openChat, SERVER_EPOCH, settle, setup, THREAD } from './chat-server';
import { turns } from './outbox-fakes';

// Exactly once: every send that may have
// reached the server is settled by what the server holds, never sent twice,
// across kills, with the device clock off. Turns go through shared's
// recoverTurn (turn-recovery.ts): a replayed run's input or the stored history.
// Steering and new chats match candidates after a watermark that keeps the
// server's Date (server-clock.ts): exactly one is the write, two the person
// decides. The fake server counts what it took, by id and by text.

afterEach(async () => {
    vi.useRealTimers();
    await cleanup();
});

const MINUTE = 60_000;

describe('turns: recoverTurn wrapped for the durable outbox', () => {
    it('a kill after the server stored the whole turn: after the relaunch the check finds it, and the run never goes again', async () => {
        const server = chatServer();
        server.runScripts.push('stored-drop');
        const s = await setup(server);
        await openChat(s);
        await s.send('stored before the kill', 'm-1');
        await turns(30);
        const after = await s.relaunch();
        await settle(after);
        expect(server.runBodies).toHaveLength(1);
        expect(server.count('stored before the kill')).toBe(1);
        expect(after.outbox.rows()).toEqual([]);
    });

    it('after a restart the check starts from connect: the running turn’s replay confirms it, then the history settles it', async () => {
        const server = chatServer();
        server.runScripts.push('drop');
        const s = await setup(server);
        await openChat(s);
        server.stallConnects(true);
        await s.send('in flight at the kill', 'm-1');
        // The check waits on its connect: the outbox isn't idle.
        await turns(40);
        const after = await s.relaunch();
        server.stallConnects(false);
        const asked = server.connects.asked;
        await settle(after);
        expect(server.connects.asked).toBe(asked + 1);
        expect(after.outbox.rows().map((row) => row.state)).toEqual(['sent']);
        // The check never streams the turn to its end.
        expect(server.connects.open).toBe(0);
        server.finishTurn();
        await openChat(after);
        await settle(after);
        expect(after.outbox.rows()).toEqual([]);
        expect(server.runBodies).toHaveLength(1);
        expect(server.count('in flight at the kill')).toBe(1);
    });

    it('a kill during the recovery leaves the row unknown on disk, and the relaunch recovers it once', async () => {
        const server = chatServer();
        server.runScripts.push('drop');
        const s = await setup(server);
        await openChat(s);
        server.stallConnects(true);
        await s.send('killed mid-recovery', 'm-1');
        // The check waits on its connect: the outbox isn't idle.
        await turns(40);
        // The check is waiting on its connect.
        expect(s.outbox.rows().map((row) => row.state)).toEqual(['unknown']);
        expect(server.connects.asked).toBe(1);
        const after = await s.relaunch();
        expect(after.outbox.rows().map((row) => row.state)).toEqual(['unknown']);
        server.stallConnects(false);
        await settle(after);
        expect(after.outbox.rows().map((row) => row.state)).toEqual(['sent']);
        expect(server.runBodies).toHaveLength(1);
        expect(server.queue).toEqual([]);
        expect(server.count('killed mid-recovery')).toBe(1);
    });

    it('the busy-thread rule asks the replay first: a turn that is the row’s own late POST is never sent again as steering', async () => {
        const server = chatServer();
        server.runScripts.push('busy-own');
        const s = await setup(server);
        await openChat(s);
        await s.send('landed late', 'm-1');
        await settle(s);
        expect(server.queue).toEqual([]);
        expect(server.count('landed late')).toBe(1);
        expect(s.outbox.rows().map((row) => row.state)).toEqual(['sent']);
    });

    it('a recovery stopped while it replays gives up and leaves the row unknown, never sent again', async () => {
        const server = chatServer();
        server.runScripts.push('drop');
        const s = await setup(server);
        await openChat(s);
        server.stallConnects(true);
        await s.send('stopped', 'm-1');
        // The check waits on its connect: the outbox isn't idle.
        await turns(40);
        await s.outbox.dispose();
        expect(s.outbox.rows().map((row) => row.state)).toEqual(['unknown']);
        expect(server.runBodies).toHaveLength(1);
        expect(server.count('stopped')).toBe(1);
    });

    it('recoverRun gives up after its limit while the server stays away (timeout), and never asks to send', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const requests: string[] = [];
        const fetch: AuthedFetch = async (input) => {
            requests.push(input);
            return new Response('<html>Bad Gateway</html>', { status: 502 });
        };
        const recovery = recoverRun({
            id: 'm-1',
            dotId: DOT,
            threadId: THREAD,
            after: null,
            fetch,
            signal: new AbortController().signal,
            newId: () => 'run-x',
            stored: async () => false,
            probe: async () => true,
            limit: 5_000,
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await recovery).toBe('gave-up');
        expect(requests.every((path) => path.endsWith('/connect'))).toBe(true);
    });

    it('recoverRun: a server that stops answering mid-recovery is a NetworkError, for the outbox’s back-off', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const fetch: AuthedFetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
        const recovery = recoverRun({
            id: 'm-1',
            dotId: DOT,
            threadId: THREAD,
            after: null,
            fetch,
            signal: new AbortController().signal,
            newId: () => 'run-x',
            stored: async () => false,
            probe: async () => false,
        });
        const settled = recovery.then(
            () => 'resolved',
            (error: Error) => error.name,
        );
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await settled).toBe('NetworkError');
    });
});

describe('a kill at every step of a send: no loss, no duplicate turn', () => {
    const scripts = ['ok', 'drop', 'stored-drop', 'proxy-502', 'busy-own'] as const;
    const kills = [0, 1, 2, 3, 5, 8, 13, 21, 34];
    const cases = scripts.flatMap((script) => kills.map((steps) => [script, steps] as const));
    it.each(cases)('a run answered %s, killed after %i steps', async (script, steps) => {
        const server = chatServer();
        server.runScripts.push(script);
        const s = await setup(server);
        await openChat(s);
        const text = `${script} killed after ${steps}`;
        await s.send(text, 'm-1');
        await turns(steps);
        const after = await s.relaunch();
        await settle(after);
        if (server.running) {
            server.finishTurn();
        }
        await openChat(after);
        await settle(after);
        // Each user message the server took, by id or by text: exactly this one, once.
        expect(server.count(text)).toBe(1);
        expect(after.outbox.rows()).toEqual([]);
        expect(after.outbox.unsent()).toEqual([]);
    });
});

describe('steering: the watermark keeps the server’s Date', () => {
    for (const offset of [-10 * MINUTE, 10 * MINUTE]) {
        it(`one candidate after a fresh pull is the write, with the device clock ${offset / MINUTE} minutes off`, async () => {
            const server = chatServer();
            server.startTurn();
            const s = await setup(server);
            s.clock.now = server.time + offset;
            await openChat(s);
            // The same words, queued on the web after the phone's steering pull: older than the write,
            // by more than the slack the check allows a proxy's Date.
            server.queueFromElsewhere('same words');
            server.tick(SERVER_CLOCK_SLACK_MS + MINUTE);
            await s.histories.history(THREAD).pull();
            server.tick(5_000);
            server.steeringScripts.push('hang');
            await s.send('same words', 'm-1');
            // Its POST arrived; the answer never comes before the kill.
            await turns(30);
            const after = await s.relaunch();
            after.clock.now = server.time + offset;
            await settle(after);
            const mine = server.queue.at(-1)!;
            expect(server.queue.map((message) => message.text)).toEqual(['same words', 'same words']);
            expect(after.outbox.holds()).toEqual([]);
            expect(after.outbox.resolve(MESSAGE_IDS, 'm-1')).toBe(mine.id);
            expect(server.count('same words')).toBe(2);
        });
    }

    it('a proxy’s Date 5 seconds ahead of the app server’s clock still finds the forgotten row as the one candidate', async () => {
        const server = chatServer();
        server.dateAhead(5_000);
        server.startTurn();
        const s = await setup(server);
        await openChat(s);
        server.tick(1_000);
        server.steeringScripts.push('hang');
        await s.send('ahead', 'm-1');
        // Its POST arrived; the answer never comes before the kill.
        await turns(30);
        const mine = server.queue.at(-1)!;
        expect(mine.createdAt).toBeLessThan(s.serverClock.lastDate()!);
        const after = await s.relaunch();
        await settle(after);
        expect(after.outbox.holds()).toEqual([]);
        expect(after.outbox.resolve(MESSAGE_IDS, 'm-1')).toBe(mine.id);
        expect(server.count('ahead')).toBe(1);
    });

    it('two candidates after the watermark: "Couldn’t confirm this was sent", with both for View, and nothing sent by itself', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const server = chatServer();
        server.startTurn();
        const s = await setup(server);
        await openChat(s);
        server.steeringScripts.push('ambiguous');
        await s.send('twice?', 'm-1');
        // The web queues the same words after the phone wrote.
        server.tick(1_000);
        const theirs = server.queueFromElsewhere('twice?');
        await settle(s);
        await vi.advanceTimersByTimeAsync(60_000);
        await settle(s);
        const groups = s.outbox.holds();
        expect(groups.map((group) => group.root.cause)).toEqual(['unconfirmed']);
        expect([...(groups[0]?.root.candidates ?? [])].sort()).toEqual(
            server.queue.map((message) => message.id).sort(),
        );
        expect(groups[0]?.root.candidates).toContain(theirs.id);
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        await settle(s);
        expect(server.count('twice?')).toBe(2);
        // Send again is the person's call.
        expect(await s.outbox.sendNow('m-1')).toBe(true);
        await settle(s);
        expect(server.count('twice?')).toBe(3);
    });
});

describe('new chats: the watermark keeps the server’s Date', () => {
    const row = (payload: NewChatPayload): OutboxRow => ({
        id: 'local-1',
        lane: 'chat:local-1',
        kind: NEW_CHAT_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: 1,
        state: 'unknown',
        attempts: 1,
        lastError: null,
        createdAt: 0,
        dependsOn: null,
        idempotencyKey: 'k',
        revision: 1,
    });

    const chat = (id: string, title: string, createdAt: number): Partial<Conversation> => ({
        id,
        kind: 'private',
        dotId: DOT,
        title,
        createdAt,
    });

    const check = async (payload: NewChatPayload, chats: Partial<Conversation>[]) => {
        const context: OutboxContext = {
            signal: new AbortController().signal,
            resolve: () => null,
            claimed: () => false,
            fetch: async () =>
                new Response(JSON.stringify({ conversations: chats, archived: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        };
        return newChatKind().check!({ row: row(payload), payload }, context);
    };

    it('a chat of the same default title made before the watermark, which the phone never held, isn’t the create', async () => {
        const at = SERVER_EPOCH;
        const payload: NewChatPayload = { dotId: DOT, title: DEFAULT_CHAT_TITLE, after: null, serverAt: at };
        // Made on the web an hour earlier, after the phone's last list: `after` alone would count it.
        expect(await check(payload, [chat('web-1', DEFAULT_CHAT_TITLE, at - 60 * MINUTE)])).toEqual({
            action: 'not-sent',
        });
        expect(
            await check(payload, [
                chat('web-1', DEFAULT_CHAT_TITLE, at - 60 * MINUTE),
                chat('mine', DEFAULT_CHAT_TITLE, at + 400),
            ]),
        ).toEqual({ action: 'sent', serverId: 'mine' });
    });

    it('two chats of the same default title after the watermark: the person decides, with both for View', async () => {
        const at = SERVER_EPOCH;
        const payload: NewChatPayload = { dotId: DOT, title: DEFAULT_CHAT_TITLE, after: null, serverAt: at };
        expect(
            await check(payload, [chat('a', DEFAULT_CHAT_TITLE, at + 10), chat('b', DEFAULT_CHAT_TITLE, at + 20)]),
        ).toEqual({ action: 'unconfirmed', candidates: ['a', 'b'] });
    });

    it('the Date is cut to the second: a chat made in the same second as the watermark still counts', async () => {
        const clock = createServerClock();
        clock.observe({ date: new Date(SERVER_EPOCH + 900).toUTCString() });
        expect(clock.lastDate()).toBe(SERVER_EPOCH);
        const payload: NewChatPayload = { dotId: DOT, title: 'hi', after: null, serverAt: clock.lastDate() };
        expect(await check(payload, [chat('mine', 'hi', SERVER_EPOCH + 950)])).toEqual({
            action: 'sent',
            serverId: 'mine',
        });
    });

    it('a proxy’s Date ahead of the app server’s clock: a chat stamped seconds before the watermark is still the create', async () => {
        const payload: NewChatPayload = { dotId: DOT, title: 'hi', after: null, serverAt: SERVER_EPOCH };
        expect(await check(payload, [chat('mine', 'hi', SERVER_EPOCH - 5_000)])).toEqual({
            action: 'sent',
            serverId: 'mine',
        });
        expect(serverSince(SERVER_EPOCH)).toBe(SERVER_EPOCH - SERVER_CLOCK_SLACK_MS);
        expect(serverSince(null)).toBeNull();
    });

    it('rows an older build wrote, without the server’s Date, keep the new chat’s rule', async () => {
        const payload = { dotId: DOT, title: 'hi', after: 50 } as NewChatPayload;
        expect(await check(payload, [chat('mine', 'hi', 60)])).toEqual({ action: 'sent', serverId: 'mine' });
    });
});

describe('the server clock', () => {
    it('keeps the newest readable Date, whatever the device clock says', () => {
        const clock = createServerClock();
        expect(clock.lastDate()).toBeNull();
        clock.observe({ date: null });
        clock.observe({ date: 'not a date' });
        expect(clock.lastDate()).toBeNull();
        clock.observe({ date: new Date(SERVER_EPOCH + 5_000).toUTCString() });
        clock.observe({ date: new Date(SERVER_EPOCH).toUTCString() });
        expect(clock.lastDate()).toBe(SERVER_EPOCH + 5_000);
    });
});
