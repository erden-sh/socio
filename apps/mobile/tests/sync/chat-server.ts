import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '@ag-ui/core';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import type { QueuedMessage, SteeringView } from '@socio/shared/chat/steering';

import { openCacheDb, type UserDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    chatLane,
    chatMessageKind,
    chatMessageWrite,
    type ChatSendOptions,
    followStoredChats,
} from '../../src/sync/chat-send';
import { createHistoryStore, type HistoryStore } from '../../src/sync/history';
import { type Outbox, type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { followStoredReviews, pageReviewKind, reviewHold, reviewLane } from '../../src/sync/page-review';
import { createServerClock, type ServerClock } from '../../src/sync/server-clock';
import { createSteeringStore, type SteeringStore } from '../../src/sync/steering';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

import { CACHE_KEY } from './helpers';
import { turns, userDb } from './outbox-fakes';

// The fake private chat the chat message kind's tests run against: a real
// outbox (user.db), history store (cache.db) and steering snapshot, and a
// server whose run, connect, steering and history routes answer as
// src/server's do: a busy thread's run is a 409 `thread_running` (CB-357;
// a 500 with no code from an older server, by script), a turn takes
// the queue at its end, a run stores its user messages, and a connect replays
// the runs after its cursor and the running turn's start. The server counts
// every user message it receives, by id and by text, so a test can say each
// was sent once. Its clock is its own, as a server's is: each answer's Date.

export const DOT = 'dot-1';
export const THREAD = 'thread-1';

/** A run sent while the chat's turn runs: refused, nothing taken (CB-357). */
export const BUSY = { error: 'Thread already running', code: 'thread_running' } as const;

export const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

export type RunScript =
    /** The turn streams and finishes. */
    | 'ok'
    /** The server takes the turn, then the connection drops before any answer (it runs on, stored at `finishTurn`). */
    | 'drop'
    /** Another turn started meanwhile: the busy thread's 409 `thread_running` (CB-357). */
    | 'busy-elsewhere'
    /** The same, from a server before the code: a 500 with no code. */
    | 'busy-elsewhere-500'
    /** The busy thread's 409, then the phone goes offline: the pulls after it fail. */
    | 'busy-offline'
    /** A 500 while no turn runs and nothing was taken. */
    | 'error'
    /** The server takes the turn and starts it, but the proxy in front answers 502 (it runs on, stored at `finishTurn`). */
    | 'proxy-502'
    /** The chat is deleted as the run lands: a 500, then its routes answer 404. */
    | 'busy-gone'
    /** The server stores the whole turn, then the connection drops before any of the answer arrives. */
    | 'stored-drop'
    /**
     * An earlier POST of this same message lands late and starts its turn, so
     * this one gets the busy thread's 500 (the server takes the message once).
     */
    | 'busy-own'
    /**
     * The turn starts and streams a little, then the connection breaks when the
     * test calls `dropRun` (it runs on, stored at `finishTurn`).
     */
    | 'started-drop'
    | { readonly status: number; readonly body?: unknown };

export type SteeringScript =
    | 'delivered'
    | 'ambiguous'
    /** Queued, then the answer never comes (until the request is stopped). */
    | 'hang'
    | { readonly status: number; readonly body?: unknown };

/** Where the fake server's clock starts: 2026-11-08 12:00:00.000 UTC. */
export const SERVER_EPOCH = Date.UTC(2026, 10, 8, 12);

/**
 * The fake workspace: one chat with its stored runs, its steering queue and
 * maybe a running turn. Its clock is its own (`time`, 250 ms a request), sent
 * as each answer's Date and kept as what it stores' times, as the server's.
 */
export function chatServer() {
    let time = SERVER_EPOCH;
    // How far the Date header runs ahead of what the server stamps (a reverse proxy's own clock).
    let dateAhead = 0;
    const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json', date: new Date(time + dateAhead).toUTCString(), ...headers },
        });
    const runs: HistoryRun[] = [];
    let queue: QueuedMessage[] = [];
    let running: { runId: string; messages: Message[] } | null = null;
    let nextRun = 1;
    const turn = (messages: Message[] = []) => ({ runId: `live-${nextRun++}`, messages });
    /** Each connect's replay, and how many are open. */
    let connects = 0;
    let streaming = 0;
    let limit = 5;
    let nextId = 1;
    let seq = 0;
    const runScripts: RunScript[] = [];
    const steeringScripts: SteeringScript[] = [];
    /** Each run's POSTed messages. */
    const runBodies: Message[][] = [];
    /** Every user message the server took: by id (a run's) or by its server id (a queued one), with its text. */
    const received: { id: string; text: string; via: 'run' | 'steering' }[] = [];
    /** Every steering POST's body. */
    const steeringBodies: unknown[] = [];
    const log: string[] = [];
    let offline = false;
    let gone = false;
    let stallConnects = false;
    let failConnects = false;
    /** The open 'started-drop' POST's stream, which `dropRun` breaks. */
    let dropping: (() => void) | null = null;

    const view = (): SteeringView => ({ messages: [...queue], limit, ...(running && { running: true }) });

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

    const known = () => new Set(runs.flatMap((run) => run.messages.map((message) => message.id)));

    const takeRun = (messages: Message[]) => {
        const stored = known();
        // A page review's tool result is stored with the turn too; only the person's messages count.
        const fresh = messages.filter(
            (message) => (message.role === 'user' || message.role === 'tool') && !stored.has(message.id),
        );
        for (const message of fresh) {
            if (message.role === 'user') {
                received.push({ id: message.id, text: String(message.content), via: 'run' });
            }
        }
        return fresh;
    };

    // The page review's receipts: `reviewed-page` as src/server/pages/page-routes.ts answers it.
    const receipts = new Map<string, Record<string, unknown> | 'deleted' | 'forbidden'>();
    const reviewScripts: ('drop' | { readonly status: number })[] = [];
    let reviewPosts = 0;
    /** Each reviewed-page POST's body, as sent (the edited draft). */
    const reviewBodies: unknown[] = [];
    let nextPage = 1;

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        log.push(`${method} ${input}`);
        time += 250;
        if (offline) {
            throw new NetworkError(input);
        }
        const url = new URL(input, 'https://brain.example.test');
        if (gone && url.pathname.startsWith(`/api/conversations/${THREAD}/`)) {
            return json(404, { error: 'Not found.' });
        }
        if (url.pathname === `/api/conversations/${THREAD}/steering`) {
            if (method === 'GET') {
                return json(200, view());
            }
            const body = init.json as { text: string };
            steeringBodies.push(init.json);
            const script = steeringScripts.shift();
            if (script !== undefined && typeof script === 'object') {
                return json(script.status, script.body ?? {});
            }
            const message: QueuedMessage = {
                id: `srv-${nextId++}`,
                text: body.text,
                createdAt: time,
                updatedAt: time,
            };
            received.push({ id: message.id, text: body.text, via: 'steering' });
            if (script === 'ambiguous') {
                queue.push(message);
                return json(500, { error: 'Something went wrong.' });
            }
            if (script === 'hang') {
                queue.push(message);
                return new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new NetworkError(input)), { once: true });
                });
            }
            if (script === 'delivered' || !running) {
                // A turn took it at once, or none ran and it started one.
                running ??= turn();
                running.messages.push({ id: message.id, role: 'user', content: body.text });
                return json(script === 'delivered' ? 200 : 201, {
                    message,
                    ...(script === 'delivered' && { delivered: true }),
                    ...view(),
                });
            }
            queue.push(message);
            return json(201, { message, ...view() });
        }
        const review = /^\/api\/conversations\/[^/]+\/reviewed-page(?:\/([^/]+))?$/.exec(url.pathname);
        if (review) {
            const callId = review[1] === undefined ? undefined : decodeURIComponent(review[1]);
            if (method === 'GET' && callId !== undefined) {
                const receipt = receipts.get(callId);
                if (receipt === 'deleted') {
                    return json(410, { error: 'Gone.' });
                }
                // A receipt in a Space the socio no longer reads (page-routes.ts's 403).
                return receipt === 'forbidden' ? json(403, { error: 'Forbidden.' }) : json(200, receipt ?? null);
            }
            reviewPosts += 1;
            const body = init.json as { toolCallId: string; title: string; content: string; spaceId?: string | null };
            reviewBodies.push(body);
            const script = reviewScripts.shift();
            if (script !== undefined && script !== 'drop') {
                return json(script.status, { error: 'No.' });
            }
            const { toolCallId, ...draft } = body;
            const spaceId = draft.spaceId ?? 'space-default';
            const page = {
                id: `page-${nextPage++}`,
                spaceId,
                title: draft.title,
                reviewDraft: { title: draft.title, content: draft.content, spaceId },
            };
            receipts.set(toolCallId, page);
            if (script === 'drop') {
                throw new NetworkError(input);
            }
            return json(201, page);
        }
        if (url.pathname === `/api/conversations/${THREAD}/history`) {
            const after = Number(url.searchParams.get('after') ?? -1);
            return json(200, { runs: runs.filter((run) => run.seq > after), more: false });
        }
        if (url.pathname === `/api/copilotkit/agent/${DOT}/run`) {
            const body = init.json as { runId: string; messages: Message[] };
            runBodies.push(body.messages);
            const script = runScripts.shift() ?? 'ok';
            if (script === 'busy-elsewhere') {
                // A turn started elsewhere: refused, nothing taken (CB-357).
                running = turn();
                return json(409, BUSY);
            }
            if (script === 'busy-offline') {
                running = turn();
                offline = true;
                return json(409, BUSY);
            }
            if (script === 'busy-elsewhere-500') {
                running = turn();
                return json(500, { error: 'Thread already running' });
            }
            if (script === 'busy-own') {
                running = turn(takeRun(body.messages));
                return json(500, { error: 'Thread already running' });
            }
            if (script === 'busy-gone') {
                gone = true;
                return json(500, { error: 'Something went wrong.' });
            }
            if (script === 'error') {
                return json(500, { error: 'Something went wrong.' });
            }
            if (typeof script === 'object') {
                return json(script.status, script.body ?? {});
            }
            if (running) {
                return json(409, BUSY);
            }
            const fresh = takeRun(body.messages);
            if (script === 'drop') {
                running = turn(fresh);
                throw new NetworkError(input);
            }
            if (script === 'stored-drop') {
                store(fresh);
                throw new NetworkError(input);
            }
            if (script === 'started-drop') {
                running = turn(fresh);
                const head = [
                    frame({ type: 'RUN_STARTED', threadId: THREAD, runId: body.runId }),
                    frame({ type: 'TEXT_MESSAGE_START', messageId: `a-${body.runId}`, role: 'assistant' }),
                    frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: `a-${body.runId}`, delta: 'Second 1.' }),
                ].join('');
                // The break waits for the test (`dropRun`), never a timer: a timer can fire before
                // the app reads the head (an error drops queued chunks) or after the test looks.
                const broken = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(head));
                        dropping = () => controller.error(new NetworkError(input));
                    },
                });
                return new Response(broken, { status: 200, headers: { 'content-type': 'text/event-stream' } });
            }
            if (script === 'proxy-502') {
                running = turn(fresh);
                return new Response('<html>Bad Gateway</html>', { status: 502 });
            }
            store(fresh);
            const text = [
                frame({ type: 'RUN_STARTED', threadId: THREAD, runId: body.runId }),
                frame({ type: 'TEXT_MESSAGE_START', messageId: `a-${body.runId}`, role: 'assistant' }),
                frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: `a-${body.runId}`, delta: 'ok' }),
                frame({ type: 'TEXT_MESSAGE_END', messageId: `a-${body.runId}` }),
                frame({ type: 'RUN_FINISHED', threadId: THREAD, runId: body.runId }),
            ].join('');
            return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (url.pathname === `/api/copilotkit/agent/${DOT}/connect`) {
            if (stallConnects) {
                connects += 1;
                return new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new NetworkError(input)), { once: true });
                });
            }
            if (failConnects) {
                connects += 1;
                return json(500, { error: 'Something went wrong.' });
            }
            return replay(Number(init.headers?.['x-cb-history-after'] ?? -1), init.signal);
        }
        return json(404, { error: 'Not found.' });
    };

    /**
     * `connect` as local-runner's: the stored runs after `after`, each with its
     * input (the user messages it added), then the running turn's start,
     * held open until the request stops.
     */
    const replay = (after: number, signal: AbortSignal | undefined) => {
        connects += 1;
        const head = runs
            .filter((run) => run.seq > after)
            .flatMap((run) => [
                frame({
                    type: 'RUN_STARTED',
                    threadId: THREAD,
                    runId: run.runId,
                    input: { messages: run.messages.filter((message) => message.role === 'user') },
                }),
                frame({ type: 'RUN_FINISHED', threadId: THREAD, runId: run.runId }),
            ])
            .join('');
        const live = running;
        let end = () => {};
        let open = live !== null;
        const close = () => {
            if (open) {
                open = false;
                streaming -= 1;
            }
        };
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                if (head) {
                    controller.enqueue(encoder.encode(head));
                }
                if (live === null) {
                    controller.close();
                    return;
                }
                streaming += 1;
                controller.enqueue(
                    encoder.encode(
                        frame({
                            type: 'RUN_STARTED',
                            threadId: THREAD,
                            runId: live.runId,
                            input: { messages: [...live.messages] },
                        }),
                    ),
                );
                end = () => {
                    close();
                    controller.error(new NetworkError('connect'));
                };
                if (signal?.aborted) {
                    end();
                } else {
                    signal?.addEventListener('abort', () => end(), { once: true });
                }
            },
            // The client stopped reading (readSse cancels its reader): the connection closes.
            cancel() {
                close();
                end = () => {};
            },
        });
        return new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream', date: new Date(time + dateAhead).toUTCString() },
        });
    };

    return {
        fetch,
        runs,
        runBodies,
        received,
        steeringBodies,
        log,
        get queue() {
            return queue;
        },
        runScripts,
        steeringScripts,
        offline(on: boolean) {
            offline = on;
        },
        /** Connects from now on never answer, until the request stops. */
        stallConnects(on: boolean) {
            stallConnects = on;
        },
        /** Connects from now on answer a 500, so a replay (the exactly-once check) fails. */
        failConnects(on: boolean) {
            failConnects = on;
        },
        /** The chat is deleted (on the web): its routes answer 404. */
        deleteChat() {
            gone = true;
        },
        setLimit(value: number) {
            limit = value;
        },
        /** The 'started-drop' POST's connection breaks now (its turn runs on). */
        dropRun() {
            if (dropping === null) {
                throw new Error('no started-drop POST is open');
            }
            dropping();
            dropping = null;
        },
        /** A turn started elsewhere (another device, the web). */
        startTurn() {
            running = turn();
        },
        /** Whether a turn runs. */
        get running() {
            return running !== null;
        },
        /** The server's clock now. */
        get time() {
            return time;
        },
        /** A proxy in front writes its own Date, `ms` ahead of the app server's clock. */
        dateAhead(ms: number) {
            dateAhead = ms;
        },
        /** Moves the server's clock on (the person waits, or someone else writes later). */
        tick(ms: number) {
            time += ms;
        },
        /** Connects asked so far, and replays still streaming a turn. */
        get connects() {
            return { asked: connects, open: streaming };
        },
        /** A queued message of the person's from another device (the web), with the server's time. */
        queueFromElsewhere(text: string) {
            const message: QueuedMessage = { id: `srv-${nextId++}`, text, createdAt: time, updatedAt: time };
            received.push({ id: message.id, text, via: 'steering' });
            queue.push(message);
            return message;
        },
        /** The running turn ends: it is stored with what it took, and the queue starts no more. */
        finishTurn() {
            const messages = [
                ...(running?.messages ?? []),
                ...queue.map((m) => ({ id: m.id, role: 'user' as const, content: m.text })),
            ];
            queue = [];
            running = null;
            store(messages);
        },
        /** A finished turn of someone else's (another device). */
        storeTurn(text: string) {
            const id = `other-${nextId++}`;
            received.push({ id, text, via: 'run' });
            store([{ id, role: 'user', content: text }]);
        },
        /** A turn that ended asking for a page review: its call has no result yet. */
        storeReview(callId: string, args: unknown) {
            const prev = runs.at(-1)?.seq ?? null;
            seq += 10;
            runs.push({
                seq,
                prev,
                runId: `run-${seq}`,
                status: 'completed' as HistoryRun['status'],
                startedAt: time,
                finishedAt: time,
                messages: [
                    { id: `ask-${seq}`, role: 'user', content: 'Write it up' },
                    {
                        id: `call-msg-${seq}`,
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            {
                                id: callId,
                                type: 'function',
                                function: { name: 'review_space_page', arguments: JSON.stringify(args) },
                            },
                        ],
                    },
                ],
                times: { messages: [], tools: [], reasoning: [] },
                light: {},
                size: 10,
            });
        },
        /** A review answered elsewhere (the web, or closed as skipped by a message): its result stored. */
        answerReview(callId: string) {
            store([{ id: `answer-${callId}`, role: 'tool', toolCallId: callId, content: '{"approved":false}' }]);
        },
        /** The page reviews' receipts by call id, and their scripts. */
        receipts,
        reviewScripts,
        reviewBodies,
        get reviewPosts() {
            return reviewPosts;
        },
        /** How many times the server took text `text`. */
        count(text: string) {
            return received.filter((message) => message.text === text).length;
        },
    };
}

export type Server = ReturnType<typeof chatServer>;

/** What each test leaves to close: the test file's afterEach runs `cleanup`. */
const cleanups: (() => Promise<void> | void)[] = [];

export async function cleanup() {
    for (const step of cleanups.splice(0).reverse()) {
        await step();
    }
}

export interface Setup {
    readonly outbox: Outbox;
    readonly histories: HistoryStore;
    readonly steering: SteeringStore;
    readonly clock: { now: number };
    /** The newest Date the answers carried, as the scope's (server-clock.ts). */
    readonly serverClock: ServerClock;
    readonly file: UserDb;
    /** Opens user.db again with a new outbox and kind, as after a kill (the old one is dropped). */
    relaunch(options?: Partial<ChatSendOptions>): Promise<Setup>;
    send(text: string, id?: string): Promise<void>;
}

let ids = 0;

export async function setup(
    server: Server,
    options: Partial<ChatSendOptions> & {
        readonly reviews?: boolean;
        /** This phone's decision reached the chat (the scope clears the review's edits). */
        readonly reviewDecided?: (threadId: string, toolCallId: string) => void;
    } = {},
    shared?: {
        clock: { now: number };
        files: Awaited<ReturnType<typeof userDb>>;
        histories: HistoryStore;
        steering: SteeringStore;
        serverClock: ServerClock;
        fetch: AuthedFetch;
        current: { outbox: Outbox | null };
    },
): Promise<Setup> {
    const clock = shared?.clock ?? { now: 1_000_000 };
    const serverClock = shared?.serverClock ?? createServerClock();
    // As the scope's authedFetch: each answer's Date goes to the server clock.
    const fetch: AuthedFetch =
        shared?.fetch ??
        (async (input, init) => {
            const response = await server.fetch(input, init);
            serverClock.observe({ date: response.headers.get('date') });
            return response;
        });
    const files = shared?.files ?? (await userDb());
    if (!shared) {
        cleanups.push(() => rmSync(files.directory, { recursive: true, force: true }));
    }
    let histories = shared?.histories;
    let steering = shared?.steering;
    // The open outbox, which the shared history store's runs settle (as the scope's onRuns): a relaunch's.
    const current = shared?.current ?? { outbox: null as Outbox | null };
    if (!histories || !steering) {
        const cacheDir = mkdtempSync(join(tmpdir(), 'socio-chat-send-'));
        const cacheDb = await openCacheDb(createNodeSqliteDriver({ keys: new Map() }), cacheDir, CACHE_KEY);
        histories = createHistoryStore({
            scopeId: `test.${++ids}`,
            db: cacheDb.db,
            fetch,
            onRuns: (threadId, has) => {
                void current.outbox?.caughtUp(chatLane(threadId), has);
                void current.outbox?.caughtUp(reviewLane(threadId), has);
            },
        });
        steering = createSteeringStore({ scopeId: `test.${ids}`, fetch });
        const h = histories;
        const s = steering;
        cleanups.push(async () => {
            await h.close();
            await s.close();
            await cacheDb.db.close();
            rmSync(cacheDir, { recursive: true, force: true });
        });
    }
    const file = await files.open();
    const h0 = histories;
    const { reviews = false, reviewDecided, ...sendOptions } = options;
    const kind = chatMessageKind({
        histories,
        steering,
        newId: () => `id-${++ids}`,
        // As the scope's: the chat a write names is pulled again.
        afterWrite: () => void h0.history(THREAD).pull(),
        now: () => clock.now,
        launchedAt: 0,
        ...(reviews ? { prepare: reviewHold(() => current.outbox?.unsent() ?? []) } : {}),
        ...sendOptions,
    });
    // The page review's decisions, as src/platform/active-scope.ts gives them.
    const reviewKind = pageReviewKind({
        histories,
        steering,
        newId: () => `id-${++ids}`,
        afterWrite: () => void h0.history(THREAD).pull(),
        ...sendOptions,
        ...(reviewDecided ? { reviewDecided } : {}),
    });
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: reviews
            ? [kind as OutboxKind<unknown>, reviewKind as OutboxKind<unknown>]
            : [kind as OutboxKind<unknown>],
        fetch,
        now: () => clock.now,
        random: () => 0,
    });
    current.outbox = outbox;
    followStoredChats(outbox, histories);
    followStoredReviews(outbox, histories);
    let closed = false;
    cleanups.push(async () => {
        if (!closed) {
            await outbox.dispose();
            await file.db.close();
        }
    });
    outbox.start();
    const h = histories;
    const s = steering;
    return {
        outbox,
        histories: h,
        steering: s,
        clock,
        serverClock,
        file,
        async relaunch(next = {}) {
            // A kill: nothing more is written, and the file is opened again.
            closed = true;
            void outbox.dispose();
            await turns(5);
            await file.db.close().catch(() => {});
            return setup(
                server,
                { ...options, ...next },
                {
                    clock,
                    files,
                    histories: h,
                    steering: s,
                    serverClock,
                    fetch,
                    current,
                },
            );
        },
        async send(text, id = `msg-${++ids}`) {
            const write = chatMessageWrite({
                id,
                idempotencyKey: `key-${id}`,
                threadId: THREAD,
                dotId: DOT,
                text,
                history: h.history(THREAD),
                steering: s.steering(THREAD),
                serverAt: serverClock.lastDate(),
            });
            await outbox.enqueue(write);
        },
    };
}

/** Lets the outbox, the pulls and the fake server settle. */
export const settle = async (setup: Setup) => {
    await turns(10);
    await setup.outbox.idle();
    await turns(10);
};

/** Opens the chat as a screen does: its history and steering snapshot pulled. */
export async function openChat(s: Setup) {
    await s.steering.steering(THREAD).refresh();
    await s.histories.history(THREAD).pull();
}
