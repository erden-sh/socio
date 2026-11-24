import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '@ag-ui/core';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import type { OthersQueuedMessage, QueuedMessage, SteeringView } from '@socio/shared/chat/steering';
import type { RoomView } from '@socio/shared/rooms/rooms';
import { SENDER_METADATA, SENDER_NAME_METADATA } from '@socio/shared/types';

import { openCacheDb, type SqlConnection } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { chatLane, followStoredChats } from '../../src/sync/chat-send';
import { createHistoryStore, type HistoryStore } from '../../src/sync/history';
import { type Outbox, type OutboxKind, openOutbox, UNSENT_GONE } from '../../src/sync/outbox';
import { roomMessageKind, roomMessageWrite, roomReadKind, type RoomSendOptions } from '../../src/sync/room-send';
import { createServerClock, type ServerClock } from '../../src/sync/server-clock';
import { createSteeringStore, type SteeringStore } from '../../src/sync/steering';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

import { CACHE_KEY } from './helpers';
import { turns, userDb } from './outbox-fakes';

// The fake room the room tests run against: a room `R` with
// Ada (the reader, `ME`) and Ben, whose routes answer as src/server's do for a
// room: `/steering` per reader (a room admin also sees `others`), a POST that
// starts a turn when none runs, a room's refusals as a 409 with a `code`
// (`roomDenialStatus`), a Telegram topic's 409 without one; `/history` with
// each person's message stamped `socioSender`; `GET /api/rooms/R`, its
// presence and `POST /api/rooms/R/read`. It counts every message it takes, by
// text and sender, so a test can say each was sent once.

export const ROOM = 'room-1';
export const ME = 'u-ada';
export const BEN = 'u-ben';
export const SERVER_EPOCH = Date.UTC(2026, 10, 8, 12);

export type RoomSteeringScript =
    /** Taken, then the answer never comes (until the request stops). */
    'hang' | { readonly status: number; readonly body?: unknown };

export function roomView(patch: Partial<RoomView> = {}): RoomView {
    return {
        id: ROOM,
        title: 'A: launch room',
        dotId: 'dot-1',
        createdAt: SERVER_EPOCH,
        createdBy: ME,
        convertedAt: null,
        archivedAt: null,
        role: 'admin',
        roomsEnabled: true,
        members: [
            {
                userId: ME,
                name: 'Ada',
                role: 'admin',
                status: 'active',
                invitedBy: null,
                invitedAt: 1,
                inviteExpiresAt: null,
                acceptedAt: 1,
            },
            {
                userId: BEN,
                name: 'Ben',
                role: 'member',
                status: 'active',
                invitedBy: ME,
                invitedAt: 2,
                inviteExpiresAt: null,
                acceptedAt: 2,
            },
        ],
        socios: [{ dotId: 'dot-1', name: 'Manny', status: 'active', lead: true }],
        ...patch,
    };
}

export function roomServer() {
    let time = SERVER_EPOCH;
    const json = (status: number, body: unknown = {}) =>
        new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json', date: new Date(time).toUTCString() },
        });
    const runs: HistoryRun[] = [];
    let queue: QueuedMessage[] = [];
    let others: OthersQueuedMessage[] = [];
    let running = false;
    let seq = 0;
    let nextId = 1;
    let gone = false;
    let view: RoomView = roomView();
    let presence: { userId: string; name: string }[] = [{ userId: BEN, name: 'Ben' }];
    let presenceGone = false;
    const steeringScripts: RoomSteeringScript[] = [];
    const steeringBodies: unknown[] = [];
    const reads: unknown[] = [];
    const received: { id: string; text: string; sender: string }[] = [];
    const log: string[] = [];
    let offline = false;

    const steeringView = (): SteeringView => ({
        messages: [...queue],
        limit: 5,
        ...(running && { running: true }),
        ...(others.length ? { others: [...others] } : {}),
    });
    const person = (id: string, text: string, sender: string): Message =>
        ({
            id,
            role: 'user',
            content: text,
            metadata: { [SENDER_METADATA]: sender, [SENDER_NAME_METADATA]: sender === ME ? 'Ada' : 'Ben' },
        }) as Message;
    const store = (messages: Message[]) => {
        const prev = runs.at(-1)?.seq ?? null;
        seq += 10;
        runs.push({
            seq,
            prev,
            runId: `run-${seq}`,
            status: 'completed' as HistoryRun['status'],
            startedAt: time,
            finishedAt: time,
            messages: [...messages, { id: `reply-${seq}`, role: 'assistant', content: 'ok' }],
            times: { messages: [], tools: [], reasoning: [] },
            light: {},
            size: 10,
        });
    };
    const room = `/api/conversations/${ROOM}`;

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        log.push(`${method} ${input}`);
        time += 250;
        if (offline) {
            throw new NetworkError(input);
        }
        const url = new URL(input, 'https://brain.example.test');
        if (gone && (url.pathname.startsWith(`${room}/`) || url.pathname.startsWith(`/api/rooms/${ROOM}`))) {
            return json(404, { error: 'Conversation not found.', code: 'not_found' });
        }
        if (url.pathname === `${room}/steering`) {
            if (method === 'GET') {
                return json(200, steeringView());
            }
            steeringBodies.push(init.json);
            const script = steeringScripts.shift();
            if (script !== undefined && typeof script === 'object') {
                return json(script.status, script.body ?? {});
            }
            const body = init.json as { text: string };
            const message: QueuedMessage = { id: `srv-${nextId++}`, text: body.text, createdAt: time, updatedAt: time };
            received.push({ id: message.id, text: body.text, sender: ME });
            queue.push(message);
            // No turn to take it: it starts one.
            running = true;
            if (script === 'hang') {
                return new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new NetworkError(input)), { once: true });
                });
            }
            return json(201, { message, ...steeringView() });
        }
        if (url.pathname === `${room}/history`) {
            const after = Number(url.searchParams.get('after') ?? -1);
            return json(200, { runs: runs.filter((run) => run.seq > after), more: false });
        }
        if (url.pathname === `/api/rooms/${ROOM}`) {
            return json(200, view);
        }
        if (url.pathname === `/api/rooms/${ROOM}/presence`) {
            return presenceGone ? json(404, { code: 'not_found' }) : json(200, { people: presence });
        }
        if (url.pathname === `/api/rooms/${ROOM}/read`) {
            reads.push(init.json);
            const asked = (init.json as { seq?: number }).seq ?? seq;
            return json(200, { lastSeq: asked, unread: Math.max(0, (seq - asked) / 10) });
        }
        return json(404, { error: 'Not found.' });
    };

    return {
        fetch,
        runs,
        log,
        reads,
        steeringScripts,
        steeringBodies,
        get queue() {
            return queue;
        },
        get running() {
            return running;
        },
        offline(on: boolean) {
            offline = on;
        },
        /** The reader lost the room (removed, or it was deleted): its routes answer 404. */
        lose() {
            gone = true;
        },
        setView(next: RoomView) {
            view = next;
        },
        setPresence(people: { userId: string; name: string }[]) {
            presence = people;
        },
        losePresence() {
            presenceGone = true;
        },
        /** Ben's message waits in the queue too (a room admin sees it in `others`). */
        othersQueued(text: string) {
            others = [
                ...others,
                { id: `srv-${nextId++}`, text, files: 0, author: { name: 'Ben' }, createdAt: time, updatedAt: time },
            ];
        },
        /** Ben sends `text` in a turn of his own, stored. */
        benSends(text: string) {
            const id = `ben-${nextId++}`;
            received.push({ id, text, sender: BEN });
            store([person(id, text, BEN)]);
        },
        /** The running turn ends, stored with the reader's queued messages. */
        finishTurn() {
            const messages = queue.map((message) => person(message.id, message.text, ME));
            queue = [];
            running = false;
            store(messages);
        },
        /** How many times the server took `text` from the reader. */
        count(text: string, sender = ME) {
            return received.filter((message) => message.text === text && message.sender === sender).length;
        },
    };
}

export type RoomServer = ReturnType<typeof roomServer>;

const cleanups: (() => Promise<void> | void)[] = [];

export async function cleanup() {
    for (const step of cleanups.splice(0).reverse()) {
        await step();
    }
}

export interface RoomSetup {
    readonly outbox: Outbox;
    readonly histories: HistoryStore;
    readonly steering: SteeringStore;
    readonly db: SqlConnection;
    readonly serverClock: ServerClock;
    relaunch(options?: Partial<RoomSendOptions>): Promise<RoomSetup>;
    send(text: string, id: string, mentions?: { userId: string; label: string }[]): Promise<void>;
}

let ids = 0;

interface Shared {
    files: Awaited<ReturnType<typeof userDb>>;
    histories: HistoryStore;
    steering: SteeringStore;
    db: SqlConnection;
    serverClock: ServerClock;
    fetch: AuthedFetch;
    current: { outbox: Outbox | null };
}

/** A real outbox (user.db), history store (cache.db) and steering snapshot over the fake room. */
export async function roomSetup(
    server: RoomServer,
    options: Partial<RoomSendOptions> = {},
    shared?: Shared,
): Promise<RoomSetup> {
    let s = shared;
    if (!s) {
        const serverClock = createServerClock();
        const fetch: AuthedFetch = async (input, init) => {
            const response = await server.fetch(input, init);
            serverClock.observe({ date: response.headers.get('date') });
            return response;
        };
        const files = await userDb();
        const cacheDir = mkdtempSync(join(tmpdir(), 'socio-room-'));
        const { db } = await openCacheDb(createNodeSqliteDriver({ keys: new Map() }), cacheDir, CACHE_KEY);
        const current = { outbox: null as Outbox | null };
        const histories = createHistoryStore({
            scopeId: `room.${++ids}`,
            db,
            fetch,
            onRuns: (threadId, has) => void current.outbox?.caughtUp(chatLane(threadId), has),
            // As the scope's: lost access sends the room's messages to the Unsent list.
            onGone: (threadId) => void current.outbox?.refuseLanes([chatLane(threadId)], UNSENT_GONE),
        });
        const steering = createSteeringStore({ scopeId: `room.${ids}`, fetch });
        cleanups.push(async () => {
            await histories.close();
            await steering.close();
            await db.close();
            rmSync(cacheDir, { recursive: true, force: true });
            rmSync(files.directory, { recursive: true, force: true });
        });
        s = { files, histories, steering, db, serverClock, fetch, current };
    }
    const { files, histories, steering, db, serverClock, fetch, current } = s;
    const file = await files.open();
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [
            roomMessageKind({
                histories,
                steering,
                me: ME,
                newId: () => `id-${++ids}`,
                launchedAt: 0,
                ...options,
            }) as OutboxKind<unknown>,
            roomReadKind() as OutboxKind<unknown>,
        ],
        fetch,
        random: () => 0,
    });
    current.outbox = outbox;
    followStoredChats(outbox, histories);
    let closed = false;
    cleanups.push(async () => {
        if (!closed) {
            await outbox.dispose();
            await file.db.close();
        }
    });
    outbox.start();
    const shared2 = s;
    return {
        outbox,
        histories,
        steering,
        db,
        serverClock,
        async relaunch(next = {}) {
            // A kill: nothing more is written, and user.db opens again.
            closed = true;
            void outbox.dispose();
            await turns(5);
            await file.db.close().catch(() => {});
            return roomSetup(server, { ...options, ...next }, shared2);
        },
        async send(text, id, mentions) {
            await outbox.enqueue(
                roomMessageWrite({
                    id,
                    idempotencyKey: `key-${id}`,
                    roomId: ROOM,
                    text,
                    ...(mentions ? { mentions } : {}),
                    history: histories.history(ROOM),
                    steering: steering.steering(ROOM),
                    serverAt: serverClock.lastDate(),
                }),
            );
        },
    };
}

export const settleRoom = async (setup: RoomSetup) => {
    await turns(10);
    await setup.outbox.idle();
    await turns(10);
};

export async function openRoom(s: RoomSetup) {
    await s.steering.steering(ROOM).refresh();
    await s.histories.history(ROOM).pull();
}
