import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { applyRoomEvent, NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';

import { openCacheDb, type SqlConnection } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { createFollowStore, type FollowStore, type FollowStoreOptions } from '../../src/sync/follow';
import { createHistoryStore, type HistoryStore } from '../../src/sync/history';
import { createSteeringStore } from '../../src/sync/steering';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { settle } from '../net/helpers';

import { CACHE_KEY } from './helpers';

// The follow stream
// against a fake server whose `/history` pages as the server's historyPage
// does and whose `/stream` frames are conversationStream's (src/server/
// workspace/conversation-stream.ts): AG-UI `data:` frames, `cursor` with its
// seq in `id:`, `closed` with a reason, and an end with no reason when the
// server stops. Each test drives the frames by hand.

const PAGE = 20;
const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function storedRun(seq: number, prev: number | null, runId = `r${seq}`, reply = `reply ${seq}`): HistoryRun {
    return {
        seq,
        prev,
        runId,
        status: 'completed' as HistoryRun['status'],
        startedAt: seq,
        finishedAt: seq + 1,
        messages: [
            { id: `u-${runId}`, role: 'user', content: `ask ${seq}` },
            { id: `a-${runId}`, role: 'assistant', content: reply },
        ],
        times: { messages: [], tools: [], reasoning: [] },
        light: {},
        size: reply.length,
    };
}

/** A run's events as the stream tells it, `reply` in two deltas. */
function runEvents(runId: string, reply = 'Hello there') {
    const half = Math.ceil(reply.length / 2);
    return [
        {
            type: 'RUN_STARTED',
            threadId: 'c1',
            runId,
            input: { messages: [{ id: `u-${runId}`, role: 'user', content: 'ask' }] },
        },
        { type: 'TEXT_MESSAGE_START', messageId: `a-${runId}`, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: `a-${runId}`, delta: reply.slice(0, half) },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: `a-${runId}`, delta: reply.slice(half) },
        { type: 'TEXT_MESSAGE_END', messageId: `a-${runId}` },
    ];
}
const finished = (runId: string) => ({ type: 'RUN_FINISHED', threadId: 'c1', runId });

interface FakeStream {
    readonly path: string;
    readonly headers: Record<string, string>;
    aborted: boolean;
    event(event: unknown): void;
    cursor(seq: number): void;
    closed(reason: string): void;
    end(): void;
}

function streamServer() {
    const runs: HistoryRun[] = [];
    const steering: string[] = [];
    const requests: string[] = [];
    const streams: FakeStream[] = [];
    let gone = false;
    /** Statuses the next stream requests answer with, in order. */
    const refusals: number[] = [];
    const encoder = new TextEncoder();
    const fetch: AuthedFetch = async (input, init) => {
        requests.push(input);
        const url = new URL(input, 'https://brain.example.test');
        const match = /^\/api\/conversations\/c1\/(history|stream|steering)$/.exec(url.pathname);
        if (!match || gone) {
            return json(404, { error: 'Conversation not found.' });
        }
        if (match[1] === 'steering') {
            steering.push(input);
            return json(200, { messages: [], limit: 5 });
        }
        if (match[1] === 'history') {
            const after = url.searchParams.get('after');
            if (after !== null) {
                const later = runs.filter((r) => r.seq > Number(after));
                return json(200, { runs: later.slice(0, PAGE), more: later.length > PAGE });
            }
            return json(200, { runs: runs.slice(-PAGE), more: false });
        }
        const refused = refusals.shift();
        if (refused !== undefined) {
            return json(refused, { error: 'Away.' });
        }
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start: (c) => {
                controller = c;
            },
            cancel: () => {
                stream.aborted = true;
            },
        });
        const write = (text: string) => {
            try {
                controller.enqueue(encoder.encode(text));
            } catch {
                // The reader is gone.
            }
        };
        const stream: FakeStream = {
            path: input,
            headers: { ...(init?.headers as Record<string, string> | undefined) },
            aborted: false,
            event: (event) => write(`data: ${JSON.stringify(event)}\n\n`),
            cursor: (seq) => write(`event: cursor\nid: ${seq}\ndata: ${JSON.stringify({ seq })}\n\n`),
            closed: (reason) => {
                write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
                stream.end();
            },
            end: () => {
                try {
                    controller.close();
                } catch {
                    // Already closed.
                }
            },
        };
        init?.signal?.addEventListener('abort', () => {
            stream.aborted = true;
        });
        streams.push(stream);
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    return {
        runs,
        requests,
        streams,
        steering,
        refusals,
        fetch,
        /** Stores runs as finished on the server, chained. */
        store(count = 1, runId?: string) {
            for (let index = 0; index < count; index += 1) {
                const prev = runs.at(-1)?.seq ?? null;
                runs.push(storedRun((prev ?? 0) + 10, prev, count === 1 ? runId : undefined));
            }
            return runs.at(-1)!;
        },
        gone() {
            gone = true;
        },
    };
}

interface Setup {
    server: ReturnType<typeof streamServer>;
    histories: HistoryStore;
    follows: FollowStore;
    db: SqlConnection;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

async function setup(options: Partial<FollowStoreOptions> & { server?: ReturnType<typeof streamServer> } = {}) {
    const server = options.server ?? streamServer();
    const directory = mkdtempSync(join(tmpdir(), 'socio-follow-'));
    const { db } = await openCacheDb(createNodeSqliteDriver(), directory, CACHE_KEY);
    const histories = createHistoryStore({ scopeId: 'ws.follow', db, fetch: server.fetch });
    const steering = createSteeringStore({ scopeId: 'ws.follow', fetch: server.fetch });
    const follows = createFollowStore({
        fetch: server.fetch,
        histories,
        steering,
        delay: () => 5,
        ...options,
    });
    cleanups.push(async () => {
        await follows.close();
        await steering.close();
        await histories.close();
        await db.close();
        rmSync(directory, { recursive: true, force: true });
    });
    return { server, histories, follows, db } satisfies Setup;
}

const streamAt = async (s: Setup, count: number) => {
    await vi.waitFor(() => expect(s.server.streams).toHaveLength(count));
    return s.server.streams[count - 1]!;
};
const reply = (s: Setup) =>
    s.follows
        .follow('c1')
        .state.turn.messages.filter((m) => m.role === 'assistant')
        .map((m) => m.content);

describe('the follow stream', () => {
    it('opens only once the history caught up, after weeks away, from the newest run', async () => {
        const s = await setup();
        s.server.store(3);
        await s.histories.history('c1').pull();
        // Weeks away: more than a page of runs since.
        s.server.store(30);
        const asked = s.server.requests.length;
        s.follows.follow('c1').use();
        const stream = await streamAt(s, 1);
        const newest = s.server.runs.at(-1)!.seq;
        const order = s.server.requests.slice(asked).filter((path) => !path.endsWith('/steering'));
        expect(order).toEqual([
            '/api/conversations/c1/history?after=30',
            '/api/conversations/c1/history',
            `/api/conversations/c1/stream?after=${newest}`,
        ]);
        expect(stream.headers['Last-Event-ID']).toBeUndefined();
        await vi.waitFor(() => expect(s.follows.follow('c1').state.live).toBe(true));
    });

    it('reduces frames into the running turn, and a replay twice gives the same turn', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const first = await streamAt(s, 1);
        for (const event of runEvents('run-1')) {
            first.event(event);
        }
        await vi.waitFor(() => expect(reply(s)).toEqual(['Hello there']));
        const once = follow.state.turn;
        expect(once.running).toBe(true);

        // Checked again (back in the foreground): the server replays the running turn whole.
        follow.check();
        expect(follow.state.live).toBe(false);
        const second = await streamAt(s, 2);
        expect(first.aborted).toBe(true);
        for (const event of runEvents('run-1')) {
            second.event(event);
        }
        await vi.waitFor(() => expect(follow.state.live).toBe(true));
        await settle();
        expect(follow.state.turn).toEqual(once);

        // The reducer itself: the same events twice over give the same turn.
        const events = runEvents('run-1') as Parameters<typeof applyRoomEvent>[1][];
        const replayed = [...events, ...events].reduce(
            (turn, event) => applyRoomEvent(turn, event, undefined),
            NO_LIVE_TURN,
        );
        expect(replayed).toEqual(events.reduce((turn, event) => applyRoomEvent(turn, event, undefined), NO_LIVE_TURN));
    });

    it('drops a run the history already holds, and every event while this device’s POST lives', async () => {
        const s = await setup();
        const stored = s.server.store(1, 'run-stored');
        const follow = s.follows.follow('c1');
        follow.use();
        const stream = await streamAt(s, 1);
        // A replay of a stored run (a race with the cursor): dropped whole.
        for (const event of [...runEvents('run-stored'), finished('run-stored')]) {
            stream.event(event);
        }
        stream.cursor(stored.seq);
        await settle();
        expect(follow.state.turn).toEqual(NO_LIVE_TURN);

        // This device's own run: the run client shows it, the stream doesn't.
        const end = follow.ownRun();
        for (const event of runEvents('run-own')) {
            stream.event(event);
        }
        stream.event(finished('run-own'));
        await settle();
        expect(follow.state.turn).toEqual(NO_LIVE_TURN);
        end();

        // Someone else's run afterwards is told.
        for (const event of runEvents('run-other', 'Hi')) {
            stream.event(event);
        }
        await vi.waitFor(() => expect(reply(s)).toEqual(['Hi']));
        expect(s.server.streams).toHaveLength(1);
    });

    it('keeps a run already streaming whole when this device’s POST opens and ends mid-run', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const stream = await streamAt(s, 1);
        // A run started on the web streams; then this device POSTs (a busy-thread 500, say).
        const events = runEvents('run-web', 'Hello there');
        for (const event of events.slice(0, 3)) {
            stream.event(event);
        }
        await vi.waitFor(() => expect(reply(s)).toEqual(['Hello ']));
        const end = follow.ownRun();
        for (const event of events.slice(3)) {
            stream.event(event);
        }
        stream.event(finished('run-web'));
        await vi.waitFor(() => expect(reply(s)).toEqual(['Hello there']));
        expect(follow.state.turn.running).toBe(false);
        end();
        // RUN_FINISHED released the history's hold: a run stored meanwhile is written.
        s.server.store(1, 'run-earlier');
        stream.cursor(s.server.runs.at(-1)!.seq);
        await vi.waitFor(() => expect(s.histories.history('c1').hasRun('run-earlier')).toBe(true));
        await s.histories.flush();
        const kept = await s.db.all<{ key: string }>("SELECT key FROM rows WHERE collection = 'history'");
        expect(kept).toHaveLength(1);
    });

    it('asks steering again when the server delivers a queued message mid-run', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const stream = await streamAt(s, 1);
        for (const event of runEvents('run-1')) {
            stream.event(event);
        }
        await vi.waitFor(() => expect(reply(s)).toEqual(['Hello there']));
        await settle();
        const asks = () => s.server.requests.filter((path) => path.endsWith('/steering')).length;
        const before = asks();
        // Deltas ask nothing.
        stream.event({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a-run-1', delta: '!' });
        await settle();
        expect(asks()).toBe(before);
        // dot-agent's deliver(): the queued message as a user message, with no run boundary.
        stream.event({ type: 'TEXT_MESSAGE_START', messageId: 'q-1', role: 'user' });
        stream.event({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'q-1', delta: 'also this' });
        stream.event({ type: 'TEXT_MESSAGE_END', messageId: 'q-1' });
        await vi.waitFor(() => expect(asks()).toBe(before + 1));
    });

    it('asks steering again on a reconnect: a turn ended while the stream was down sends no frame', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const first = await streamAt(s, 1);
        await vi.waitFor(() => expect(follow.state.live).toBe(true));
        await settle();
        const asks = () => s.server.requests.filter((path) => path.endsWith('/steering')).length;
        const before = asks();
        // The server restarts: the stream ends with no reason, and the next one opens on the new process.
        first.end();
        await streamAt(s, 2);
        await vi.waitFor(() => expect(follow.state.live).toBe(true));
        await vi.waitFor(() => expect(asks()).toBe(before + 1));
    });

    it('tells each RUN_ERROR with its run, a dropped own run’s too, so its code outlives /history', async () => {
        const errors: [string, string, unknown][] = [];
        const s = await setup({ onRunError: (threadId, runId, code) => errors.push([threadId, runId, code]) });
        const follow = s.follows.follow('c1');
        follow.use();
        const stream = await streamAt(s, 1);
        for (const event of runEvents('run-failed')) {
            stream.event(event);
        }
        stream.event({ type: 'RUN_ERROR', code: 'cycle_tokens', message: 'Not shown.' });
        const end = follow.ownRun();
        for (const event of runEvents('run-own')) {
            stream.event(event);
        }
        stream.event({ type: 'RUN_ERROR', code: 'time_limit', message: 'Not shown.' });
        end();
        await vi.waitFor(() => expect(errors).toHaveLength(2));
        expect(errors).toEqual([
            ['c1', 'run-failed', 'cycle_tokens'],
            ['c1', 'run-own', 'time_limit'],
        ]);
    });

    it('takes the turn over when this device’s POST breaks', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const first = await streamAt(s, 1);
        const end = follow.ownRun();
        const events = runEvents('run-own', 'All of it');
        for (const event of events.slice(0, 3)) {
            first.event(event);
        }
        await settle();
        expect(follow.state.turn).toEqual(NO_LIVE_TURN);
        // The POST breaks mid-turn; the turn goes on on the server, which replays it to a new stream.
        end({ broken: true });
        const second = await streamAt(s, 2);
        expect(first.aborted).toBe(true);
        for (const event of events) {
            second.event(event);
        }
        await vi.waitFor(() => expect(reply(s)).toEqual(['All of it']));
        expect(follow.state.turn.running).toBe(true);
    });

    it('rides out a server restart: an end with no reason reconnects from the last cursor', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const first = await streamAt(s, 1);
        const stored = s.server.store(1);
        first.cursor(stored.seq);
        await vi.waitFor(() => expect(s.histories.history('c1').hasRun(stored.runId)).toBe(true));
        // The server stops: the body ends with no `closed` frame; then it is away for one try.
        const seen: boolean[] = [];
        follow.subscribe(() => seen.push(follow.state.reconnecting));
        s.server.refusals.push(502);
        first.end();
        const second = await streamAt(s, 2);
        // It said "Reconnecting…" while it waited, through the 502 too.
        expect(seen).toContain(true);
        expect(s.server.requests.filter((path) => path.includes('/stream'))).toHaveLength(3);
        expect(second.path).toBe(`/api/conversations/c1/stream?after=${stored.seq}`);
        expect(second.headers['Last-Event-ID']).toBe(String(stored.seq));
        await vi.waitFor(() => expect(follow.state).toMatchObject({ live: true, reconnecting: false }));
    });

    it('reconnects a stream silent past the watchdog', async () => {
        const s = await setup({ silenceMs: 40 });
        const follow = s.follows.follow('c1');
        follow.use();
        await vi.waitFor(() => expect(s.server.streams.length).toBeGreaterThanOrEqual(2));
        expect(s.server.streams[0]!.aborted).toBe(true);
        expect(follow.state.ended).toBeNull();
    });

    it('ends on `closed` with a reason, without reconnecting, and asks history and steering again', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const stream = await streamAt(s, 1);
        for (const event of runEvents('run-1')) {
            stream.event(event);
        }
        const steeringAsks = () => s.server.requests.filter((path) => path.endsWith('/steering')).length;
        const steeringBefore = steeringAsks();
        s.server.gone();
        stream.closed('access');
        await vi.waitFor(() => expect(follow.state.ended).toBe('access'));
        expect(follow.state).toMatchObject({ live: false, reconnecting: false, turn: NO_LIVE_TURN });
        await vi.waitFor(() => expect(steeringAsks()).toBeGreaterThan(steeringBefore));
        await vi.waitFor(() => expect(s.histories.history('c1').state.gone).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(s.server.streams).toHaveLength(1);
    });

    it('swaps the live turn for the stored run, never showing it twice', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        const history = s.histories.history('c1');
        follow.use();
        const stream = await streamAt(s, 1);
        const doubles: string[] = [];
        const look = () => {
            const live = follow.state.turn.messages.map((m) => m.id);
            for (const id of live) {
                if (history.has(id)) {
                    doubles.push(id);
                }
            }
        };
        follow.subscribe(look);
        history.subscribe(look);
        for (const event of [...runEvents('run-9', 'Done.'), finished('run-9')]) {
            stream.event(event);
        }
        await vi.waitFor(() => expect(reply(s)).toEqual(['Done.']));
        expect(follow.state.turn.running).toBe(false);
        const stored = s.server.store(1, 'run-9');
        stream.cursor(stored.seq);
        await vi.waitFor(() => expect(history.hasRun('run-9')).toBe(true));
        expect(follow.state.turn).toEqual(NO_LIVE_TURN);
        expect(doubles).toEqual([]);
        expect(history.has('a-run-9')).toBe(true);
    });

    it('holds the history’s writes while a run streams, until it ends', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const stream = await streamAt(s, 1);
        for (const event of runEvents('run-live')) {
            stream.event(event);
        }
        await vi.waitFor(() => expect(reply(s)).toHaveLength(1));
        // Someone's earlier run lands while this one streams: kept in memory, not written yet.
        s.server.store(1, 'run-earlier');
        stream.cursor(s.server.runs.at(-1)!.seq);
        await vi.waitFor(() => expect(s.histories.history('c1').hasRun('run-earlier')).toBe(true));
        await s.histories.flush();
        const kept = () => s.db.all<{ key: string }>("SELECT key FROM rows WHERE collection = 'history'");
        expect(await kept()).toEqual([]);
        stream.event(finished('run-live'));
        await settle();
        await s.histories.flush();
        expect(await kept()).toHaveLength(1);
    });

    it('checks every open stream on return to the foreground, catching up first', async () => {
        const s = await setup();
        const follow = s.follows.follow('c1');
        follow.use();
        const first = await streamAt(s, 1);
        await vi.waitFor(() => expect(follow.state.live).toBe(true));
        s.server.store(2);
        const asked = s.server.requests.length;
        s.follows.foreground();
        expect(follow.state.live).toBe(false);
        const second = await streamAt(s, 2);
        expect(first.aborted).toBe(true);
        const since = s.server.requests.slice(asked).filter((path) => !path.endsWith('/steering'));
        expect(since).toEqual(['/api/conversations/c1/history', second.path]);
        expect(second.path).toBe(`/api/conversations/c1/stream?after=${s.server.runs.at(-1)!.seq}`);
        await vi.waitFor(() => expect(follow.state.live).toBe(true));
    });

    it('stops when no screen uses it, and never opens for a local id', async () => {
        const s = await setup({ isLocal: (threadId) => threadId.startsWith('local-') });
        s.follows.follow('local-1').use();
        const follow = s.follows.follow('c1');
        const release = follow.use();
        const stream = await streamAt(s, 1);
        release();
        await settle();
        expect(stream.aborted).toBe(true);
        expect(follow.state.live).toBe(false);
        expect(s.server.requests.some((path) => path.includes('local-'))).toBe(false);
    });
});
