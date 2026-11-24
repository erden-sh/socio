import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import type { ModelChoice } from '@socio/shared/inference';

import { openCacheDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { chatScreen, keptChat, LAST_SCREEN_KEY } from '../../src/shell/last-screen';
import { chatDraft, type Drafts, newChatDraft, openDrafts } from '../../src/sync/chat-drafts';
import { CHAT_WAIT, chatMessageKind, chatMessageWrite, followStoredChats } from '../../src/sync/chat-send';
import { createHistoryStore, type HistoryStore } from '../../src/sync/history';
import { chatLanes, chatWriteRoute, CONVERSATION_IDS, isLocalChat, serverChatId } from '../../src/sync/local-ids';
import {
    createLocalChats,
    DEFAULT_CHAT_TITLE,
    enqueueNewChat,
    type LocalChats,
    NEW_CHAT_KIND,
    NEW_CHAT_VERSION,
    newChatKind,
    newChatTitle,
    newChatWrites,
    newestChat,
} from '../../src/sync/new-chat';
import { type Outbox, type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import { createSteeringStore, type SteeringStore } from '../../src/sync/steering';
import { openViewState, type ViewState } from '../../src/sync/view-state';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

import { CACHE_KEY } from './helpers';
import { turns, userDb } from './outbox-fakes';

// A new chat and its local id:
// the create and its first message on a real outbox and drafts (user.db),
// history store, steering snapshots and view state (cache.db), against a
// fake server whose conversation, chat list, steering, history and run routes
// answer as src/server's do. Every test ends with the server holding each
// chat once and each message once.

const DOT = 'dot-1';

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

interface Chat {
    id: string;
    dotId: string;
    ownerId: string;
    title: string;
    createdAt: number;
    kind: 'private';
    inference?: ModelChoice | null;
}

type CreateScript =
    | 'ok'
    /** The server makes the chat, then the connection drops before the answer. */
    | 'drop'
    /** The same, and the phone stays offline after. */
    | 'drop-offline'
    | { readonly status: number; readonly body?: unknown; readonly raw?: string };

function server() {
    const chats: Chat[] = [
        { id: 'old-1', dotId: DOT, ownerId: 'u', title: 'Earlier', createdAt: 100, kind: 'private' },
    ];
    const runs = new Map<string, HistoryRun[]>();
    const creates: CreateScript[] = [];
    /** Runs answered with the busy thread's 409 `thread_running` (CB-357) before any is taken. */
    let busyRuns = 0;
    const log: string[] = [];
    /** Every user message the server took, with its chat. */
    const received: { id: string; threadId: string; text: string }[] = [];
    /** Each run the server took, with the model its chat held when it ran (the reply's model). */
    const runModels: { threadId: string; inference: ModelChoice | null | undefined }[] = [];
    let offline = false;
    let next = 1;
    let clock = 1_000;

    /** Every create's body, as the server read it. */
    const createBodies: Record<string, unknown>[] = [];
    const create = (body: { dotId: string; title: string; inference?: ModelChoice | null }) => {
        const chat: Chat = {
            id: `conv-${next++}`,
            dotId: body.dotId,
            ownerId: 'u',
            // As the server's schema stores it (`z.string().trim()`).
            title: body.title.trim(),
            createdAt: ++clock,
            kind: 'private',
            // As the server's createConversation keeps it: the chat's model before any run.
            inference: body.inference ?? null,
        };
        chats.push(chat);
        runs.set(chat.id, []);
        return chat;
    };

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        log.push(`${method} ${input}`);
        if (offline) {
            throw new NetworkError(input);
        }
        const url = new URL(input, 'https://brain.example.test');
        const path = url.pathname;
        if (path === '/api/conversations' && method === 'POST') {
            const body = init.json as { dotId: string; title: string; inference?: ModelChoice | null };
            createBodies.push(body);
            // The server's schema is `.strict()`: only these keys (workspace-routes.ts).
            expect(['dotId', 'title', 'inference']).toEqual(expect.arrayContaining(Object.keys(body)));
            expect(Object.keys(body)).toEqual(expect.arrayContaining(['dotId', 'title']));
            const script = creates.shift() ?? 'ok';
            if (typeof script === 'object') {
                return script.raw === undefined
                    ? json(script.status, script.body ?? {})
                    : new Response(script.raw, { status: script.status });
            }
            const chat = create(body);
            if (script === 'drop' || script === 'drop-offline') {
                offline = script === 'drop-offline';
                throw new NetworkError(input);
            }
            return json(201, chat);
        }
        if (path === '/api/workspace') {
            return json(200, { user: {}, conversations: [...chats].reverse(), archived: [], spaces: [], dots: [] });
        }
        const match = /^\/api\/conversations\/([^/]+)\/(steering|history)$/.exec(path);
        if (match) {
            const thread = runs.get(decodeURIComponent(match[1]!));
            if (thread === undefined) {
                return json(404, { error: 'Not found.' });
            }
            if (match[2] === 'steering') {
                return json(200, { messages: [], limit: 5 });
            }
            const after = Number(url.searchParams.get('after') ?? -1);
            return json(200, { runs: thread.filter((run) => run.seq > after), more: false });
        }
        if (path === `/api/copilotkit/agent/${DOT}/run`) {
            const body = init.json as { threadId: string; runId: string; messages: Message[] };
            const thread = runs.get(body.threadId);
            if (thread === undefined) {
                return json(404, { error: 'Not found.' });
            }
            if (busyRuns > 0) {
                busyRuns -= 1;
                return json(409, { error: 'Thread already running', code: 'thread_running' });
            }
            runModels.push({
                threadId: body.threadId,
                inference: chats.find((c) => c.id === body.threadId)?.inference,
            });
            const known = new Set(thread.flatMap((run) => run.messages.map((message) => message.id)));
            const fresh = body.messages.filter((message) => message.role === 'user' && !known.has(message.id));
            for (const message of fresh) {
                received.push({ id: message.id, threadId: body.threadId, text: String(message.content) });
            }
            const seq = (thread.at(-1)?.seq ?? 0) + 10;
            thread.push({
                seq,
                prev: thread.at(-1)?.seq ?? null,
                runId: body.runId,
                status: 'completed' as HistoryRun['status'],
                startedAt: seq,
                finishedAt: seq + 1,
                messages: [...fresh, { id: `reply-${seq}`, role: 'assistant', content: 'ok' }],
                times: { messages: [], tools: [], reasoning: [] },
                light: {},
                size: 10,
            });
            const text = [
                frame({ type: 'RUN_STARTED', threadId: body.threadId, runId: body.runId }),
                frame({ type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId }),
            ].join('');
            return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return json(404, { error: 'Not found.' });
    };

    return {
        fetch,
        chats,
        creates,
        createBodies,
        runModels,
        log,
        received,
        offline(on: boolean) {
            offline = on;
        },
        /** The next `n` runs are refused as busy (a turn started elsewhere and ended). */
        busy(n: number) {
            busyRuns = n;
        },
        /** Chats this test made (not the one there before). */
        made: () => chats.filter((chat) => chat.id !== 'old-1'),
        /** Requests that named a local id: there must be none. */
        localReads: () => log.filter((line) => line.includes('local-')),
    };
}

type Server = ReturnType<typeof server>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

interface Phone {
    readonly outbox: Outbox;
    readonly drafts: Drafts;
    readonly viewState: ViewState;
    readonly histories: HistoryStore;
    readonly steering: SteeringStore;
    readonly chats: LocalChats | null;
    readonly resolved: [string, string][];
    readonly clock: { now: number };
    /** A kill, then the scope opens again on the same files. */
    relaunch(options?: { localChats?: boolean }): Promise<Phone>;
    /** Lets the outbox, the pulls and the fake server settle. */
    settle(): Promise<void>;
    /** Settles until `done` holds, through the outbox's back-off (real timers), or fails after 15 s. */
    until(done: () => boolean): Promise<void>;
}

let ids = 0;
const newId = () => `id-${++ids}`;

async function open(
    srv: Server,
    options: { localChats?: boolean; launchedAt?: number } = {},
    files?: {
        user: Awaited<ReturnType<typeof userDb>>;
        cacheDir: string;
        clock: { now: number };
    },
): Promise<Phone> {
    const clock = files?.clock ?? { now: 1_000_000 };
    const user = files?.user ?? (await userDb());
    const cacheDir = files?.cacheDir ?? mkdtempSync(join(tmpdir(), 'socio-new-chat-'));
    if (!files) {
        cleanups.push(() => {
            rmSync(user.directory, { recursive: true, force: true });
            rmSync(cacheDir, { recursive: true, force: true });
        });
    }
    const userFile = await user.open();
    const cacheDb = await openCacheDb(createNodeSqliteDriver({ keys: new Map() }), cacheDir, CACHE_KEY);
    let outboxRef: Outbox | null = null;
    const histories = createHistoryStore({
        scopeId: `test.${++ids}`,
        db: cacheDb.db,
        fetch: srv.fetch,
        isLocal: isLocalChat,
        onRuns: (threadId, has) => {
            for (const lane of outboxRef === null ? [] : chatLanes(outboxRef, threadId)) {
                void outboxRef?.caughtUp(lane, has);
            }
        },
    });
    const steering = createSteeringStore({ scopeId: `test.${ids}`, fetch: srv.fetch, isLocal: isLocalChat });
    const kinds = [
        chatMessageKind({
            histories,
            steering,
            newId,
            now: () => clock.now,
            launchedAt: options.launchedAt ?? 0,
        }),
        newChatKind(),
    ] as OutboxKind<unknown>[];
    const outbox = await openOutbox({
        db: userFile.db,
        state: userFile.state,
        kinds,
        fetch: srv.fetch,
        now: () => clock.now,
        random: () => 0,
    });
    outboxRef = outbox;
    followStoredChats(outbox, histories);
    const drafts = await openDrafts({ db: userFile.db, state: userFile.state, outbox, now: () => clock.now });
    const viewState = await openViewState(cacheDb.db);
    const resolved: [string, string][] = [];
    const chats = options.localChats === false ? null : createLocalChats({ outbox, drafts, viewState });
    chats?.subscribe((local, serverId) => resolved.push([local, serverId]));
    let closed = false;
    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        chats?.dispose();
        await drafts.close();
        await outbox.dispose();
        await viewState.close();
        await histories.close();
        await steering.close();
        await userFile.db.close().catch(() => {});
        await cacheDb.db.close().catch(() => {});
    };
    cleanups.push(close);
    outbox.start();
    const phone: Phone = {
        outbox,
        drafts,
        viewState,
        histories,
        steering,
        chats,
        resolved,
        clock,
        async relaunch(next = {}) {
            // Written so far stays; then the files open again, as after a kill.
            await drafts.flush();
            await viewState.flush();
            await close();
            return open(srv, { ...next, launchedAt: clock.now + 1_000 }, { user, cacheDir, clock });
        },
        async settle() {
            for (let i = 0; i < 3; i += 1) {
                await turns(10);
                await outbox.idle();
            }
            await turns(10);
        },
        async until(done) {
            const end = Date.now() + 15_000;
            await phone.settle();
            while (!done()) {
                if (Date.now() > end) {
                    throw new Error('Timed out waiting for the outbox.');
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                await phone.settle();
            }
        },
    };
    return phone;
}

/** The person types in the socio's new chat and sends, on the model chosen if any. */
async function startChat(phone: Phone, text: string, inference?: ModelChoice | null) {
    phone.drafts.write(newChatDraft(DOT), text);
    const sent = await enqueueNewChat({
        drafts: phone.drafts,
        dotId: DOT,
        newId,
        after: 100,
        ...(inference === undefined ? {} : { inference }),
    });
    expect(sent).not.toBeNull();
    return sent!;
}

describe('a new chat', () => {
    it('creates the chat, then sends its first message to the server id, with nothing read for the local id', async () => {
        const srv = server();
        const phone = await open(srv);
        const { localId, row } = await startChat(phone, 'Plan the offsite');
        expect(isLocalChat(localId)).toBe(true);
        expect(row.dependsOn).toBe(localId);
        expect(phone.drafts.read(newChatDraft(DOT)).text).toBe('');
        await phone.settle();

        expect(srv.made()).toEqual([expect.objectContaining({ id: 'conv-1', dotId: DOT, title: 'Plan the offsite' })]);
        expect(srv.received).toEqual([{ id: row.id, threadId: 'conv-1', text: 'Plan the offsite' }]);
        expect(phone.outbox.resolve(CONVERSATION_IDS, localId)).toBe('conv-1');
        // The create went before the run, and no request named the local id.
        const create = srv.log.indexOf('POST /api/conversations');
        const run = srv.log.indexOf(`POST /api/copilotkit/agent/${DOT}/run`);
        expect(create).toBeGreaterThanOrEqual(0);
        expect(run).toBeGreaterThan(create);
        expect(srv.localReads()).toEqual([]);
        // The screen was told to swap its route param.
        expect(phone.resolved).toEqual([[localId, 'conv-1']]);
        // The message's row settles once the server id's history holds it.
        await phone.histories.history('conv-1').pull();
        await phone.settle();
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('a first message refused as busy (409 thread_running, CB-357) goes again after the back-off, never unknown, once', async () => {
        const srv = server();
        srv.busy(1);
        const phone = await open(srv);
        const { row } = await startChat(phone, 'Plan the offsite');
        await phone.settle();
        expect(srv.made()).toHaveLength(1);
        expect(srv.received).toEqual([]);
        expect(phone.outbox.rows().map((write) => [write.id, write.state, write.lastError])).toEqual([
            [row.id, 'queued', CHAT_WAIT.busy],
        ]);
        expect(srv.log.filter((line) => line.includes('/connect'))).toEqual([]);
        await phone.until(() => srv.received.length > 0);
        expect(srv.received).toEqual([{ id: row.id, threadId: 'conv-1', text: 'Plan the offsite' }]);
        expect(srv.made()).toHaveLength(1);
    });

    it('stores the create, the message and the cleared box in one transaction', async () => {
        const srv = server();
        const phone = await open(srv);
        phone.drafts.write(newChatDraft(DOT), 'Hello');
        await phone.drafts.flush();
        // The first message's id is already queued: the insert fails, and neither row goes in.
        await phone.outbox.enqueue({
            id: 'id-taken',
            lane: 'other',
            kind: 'unknown-kind',
            payload: '{}',
            payloadVersion: 1,
            idempotencyKey: 'k',
        });
        let calls = 0;
        const clashing = () => (++calls === 2 ? 'id-taken' : `x-${calls}`);
        await expect(
            enqueueNewChat({ drafts: phone.drafts, dotId: DOT, newId: clashing, after: null }),
        ).rejects.toThrow();
        expect(phone.outbox.rows().map((row) => row.id)).toEqual(['id-taken']);
        expect(phone.drafts.read(newChatDraft(DOT)).text).toBe('Hello');
    });

    it('reads nothing from the network for a local id before its create resolves', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.offline(true);
        const { localId } = await startChat(phone, 'Offline thought');
        // The screen opens the chat: its history, steering and pulls.
        const history = phone.histories.history(localId);
        const release = history.use();
        expect(await history.pull()).toBe(true);
        await phone.steering.steering(localId).refresh();
        await phone.settle();
        release();
        expect(history.state.gone).toBe(false);
        expect(srv.localReads()).toEqual([]);
        // The message shows over the local chat while it waits.
        const overlays = overlaysOf({
            rows: phone.outbox.rows(),
            unsent: phone.outbox.unsent(),
            kinds: [
                chatMessageKind({ histories: phone.histories, steering: phone.steering, newId }) as OutboxKind<unknown>,
                newChatKind() as OutboxKind<unknown>,
            ],
            scope: phone.outbox,
        });
        expect(overlays.map((item) => (item.value as { threadId: string }).threadId)).toEqual([localId]);
    });

    it('offline: the create waits, survives a relaunch, and goes once online; the message asks first', async () => {
        const srv = server();
        let phone = await open(srv);
        srv.offline(true);
        const { localId, row } = await startChat(phone, 'Written on the plane');
        await phone.settle();
        expect(srv.made()).toEqual([]);

        phone = await phone.relaunch();
        await phone.settle();
        expect(srv.made()).toEqual([]);
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, localId) !== null);

        // The check found no chat (it never landed), so the create went, once.
        expect(srv.made()).toHaveLength(1);
        expect(phone.outbox.resolve(CONVERSATION_IDS, localId)).toBe('conv-1');
        // Written before the restart: the message waits for Send now.
        expect(phone.outbox.rows()).toEqual([
            expect.objectContaining({ id: row.id, state: 'held', lastError: CHAT_WAIT.ask }),
        ]);
        await phone.outbox.sendNow(row.id);
        await phone.settle();
        expect(srv.received).toEqual([{ id: row.id, threadId: 'conv-1', text: 'Written on the plane' }]);
        expect(srv.localReads()).toEqual([]);
    });

    it('a create whose answer was lost is found by its check after a relaunch, never made twice', async () => {
        const srv = server();
        let phone = await open(srv);
        srv.creates.push('drop-offline');
        const { localId, row } = await startChat(phone, 'Lost answer');
        await phone.settle();
        expect(srv.made()).toHaveLength(1);
        expect(phone.outbox.rows()[0]).toMatchObject({ id: localId, state: 'unknown' });

        phone = await phone.relaunch();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, localId) !== null);
        expect(srv.made()).toHaveLength(1);
        expect(phone.outbox.resolve(CONVERSATION_IDS, localId)).toBe('conv-1');
        await phone.outbox.sendNow(row.id);
        await phone.settle();
        expect(srv.received).toEqual([{ id: row.id, threadId: 'conv-1', text: 'Lost answer' }]);
    });

    it('a long first message whose 80th character is a space: the check still finds the chat after a lost answer', async () => {
        const srv = server();
        let phone = await open(srv);
        srv.creates.push('drop-offline');
        const text = `${'a'.repeat(79)} ${'b'.repeat(20)}`;
        const { localId, row } = await startChat(phone, text);
        await phone.settle();
        expect(srv.made()).toEqual([expect.objectContaining({ title: 'a'.repeat(79) })]);

        phone = await phone.relaunch();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, localId) !== null);
        expect(srv.made()).toHaveLength(1);
        expect(srv.log.filter((line) => line === 'POST /api/conversations')).toHaveLength(1);
        await phone.outbox.sendNow(row.id);
        await phone.settle();
        expect(srv.received).toEqual([{ id: row.id, threadId: 'conv-1', text }]);
    });

    it('the check leaves two candidates to the person, and takes none another write claimed', async () => {
        const srv = server();
        const phone = await open(srv);
        // The person made one alike on the web meanwhile, after the phone's watermark.
        srv.chats.push({ id: 'web-1', dotId: DOT, ownerId: 'u', title: 'Same words', createdAt: 500, kind: 'private' });
        // And one before it, which the watermark rules out.
        srv.chats.push({ id: 'web-0', dotId: DOT, ownerId: 'u', title: 'Lone', createdAt: 50, kind: 'private' });
        srv.creates.push('drop');
        const { localId } = await startChat(phone, 'Same words');
        await phone.until(() => phone.outbox.rows().some((row) => row.lastError === 'unconfirmed'));
        expect(phone.outbox.rows().find((row) => row.id === localId)).toMatchObject({
            state: 'unknown',
            lastError: 'unconfirmed',
        });
        expect(phone.outbox.resolve(CONVERSATION_IDS, localId)).toBeNull();

        // Older than the watermark, or another write's: no candidate.
        srv.creates.push('drop');
        const lone = await startChat(phone, 'Lone');
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, lone.localId) !== null);
        expect(phone.outbox.resolve(CONVERSATION_IDS, lone.localId)).not.toBe('web-0');
    });

    it('a proxy’s 502 is unknown (the chat may exist); a readable 503 goes again; 400 and 404 go to unsent', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.creates.push({ status: 502, raw: '<html>Bad Gateway</html>' });
        const first = await startChat(phone, 'Through the proxy');
        await phone.settle();
        // Unknown, then checked: the chat list has none, so it waits for the back-off, queued.
        expect(phone.outbox.rows()[0]).toMatchObject({ id: first.localId, state: 'queued' });
        expect(srv.log.filter((line) => line === 'GET /api/workspace')).toHaveLength(1);
        // The 502 made no chat here: its check finds none, and the create goes again.
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, first.localId) !== null);
        expect(srv.made()).toHaveLength(1);
        expect(phone.outbox.resolve(CONVERSATION_IDS, first.localId)).toBe('conv-1');

        srv.creates.push({ status: 404, body: { error: 'Socio not found.' } });
        const second = await startChat(phone, 'To a gone socio');
        await phone.settle();
        expect(phone.outbox.unsent()).toEqual([expect.objectContaining({ id: second.localId, reason: 'socio-gone' })]);
        // The message waits on its refused create, shown as one group.
        expect(phone.outbox.holds()).toEqual([
            expect.objectContaining({
                root: expect.objectContaining({ id: second.localId, cause: 'unsent' }),
                rows: [expect.objectContaining({ id: second.row.id })],
            }),
        ]);
        // Discarded: the message has no chat to go to.
        await phone.outbox.discardUnsent(second.localId);
        await phone.settle();
        expect(phone.outbox.unsent()).toEqual([expect.objectContaining({ id: second.row.id, reason: 'no-chat' })]);
        expect(srv.made()).toHaveLength(1);
    });

    it('a readable 503 (setup missing) goes again after the back-off, making the chat once', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.creates.push({ status: 503, body: { error: 'Setup required: model.' } });
        const { localId } = await startChat(phone, 'Before setup');
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, localId) !== null);
        expect(srv.made()).toHaveLength(1);
        expect(phone.outbox.resolve(CONVERSATION_IDS, localId)).toBe('conv-1');
    });
});

describe('re-keying a new chat’s local id', () => {
    it('moves the draft and the last screen to the server id once the create resolves', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.offline(true);
        const { localId } = await startChat(phone, 'First');
        // The screen is the local chat now: the person types on, and leaves it there.
        phone.drafts.write(chatDraft(localId), 'second thought');
        phone.viewState.set(LAST_SCREEN_KEY, chatScreen(localId));
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.resolved.length > 0);
        expect(phone.drafts.read(chatDraft(localId)).text).toBe('');
        expect(phone.drafts.read(chatDraft('conv-1')).text).toBe('second thought');
        expect(keptChat(phone.viewState.get(LAST_SCREEN_KEY))).toBe('conv-1');
        expect(phone.resolved).toEqual([[localId, 'conv-1']]);
    });

    it('after a kill between the create settling and the moves, the next open makes them', async () => {
        const srv = server();
        // No re-keying runs: as if the app died right after the settle's transaction.
        let phone = await open(srv, { localChats: false });
        srv.offline(true);
        const { localId } = await startChat(phone, 'First');
        phone.drafts.write(chatDraft(localId), 'typed before the kill');
        phone.viewState.set(LAST_SCREEN_KEY, chatScreen(localId));
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, localId) !== null);
        expect(phone.outbox.resolve(CONVERSATION_IDS, localId)).toBe('conv-1');
        expect(phone.drafts.read(chatDraft(localId)).text).toBe('typed before the kill');

        phone = await phone.relaunch({ localChats: true });
        expect(phone.drafts.read(chatDraft(localId)).text).toBe('');
        expect(phone.drafts.read(chatDraft('conv-1')).text).toBe('typed before the kill');
        expect(keptChat(phone.viewState.get(LAST_SCREEN_KEY))).toBe('conv-1');
        // And it was written: one more open finds it there.
        phone = await phone.relaunch({ localChats: false });
        expect(phone.drafts.read(chatDraft('conv-1')).text).toBe('typed before the kill');
        expect(phone.drafts.scopes()).not.toContain(chatDraft(localId));
    });

    it('a link naming the local id opens the local chat before the create resolves, the server’s after', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.offline(true);
        const { localId } = await startChat(phone, 'Linked');
        expect(phone.chats!.resolve(localId)).toBe(localId);
        expect(phone.chats!.resolve('old-1')).toBe('old-1');
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, localId) !== null);
        expect(phone.chats!.resolve(localId)).toBe('conv-1');
        expect(serverChatId(phone.outbox.resolve, localId)).toBe('conv-1');
        expect(srv.localReads()).toEqual([]);
    });

    it('a message written under the server id joins the local lane while that lane still holds a write', async () => {
        const srv = server();
        const phone = await open(srv, { launchedAt: Number.MAX_SAFE_INTEGER });
        // Every message asks first (written "before the launch"): the first holds the local lane.
        const { localId, row } = await startChat(phone, 'One');
        await phone.settle();
        expect(phone.outbox.rows()).toEqual([expect.objectContaining({ id: row.id, state: 'held' })]);
        const route = chatWriteRoute(phone.outbox, 'conv-1');
        expect(route).toEqual({ lane: `chat:${localId}`, dependsOn: null });
        const write = chatMessageWrite({
            id: 'm-2',
            idempotencyKey: 'k-2',
            threadId: 'conv-1',
            dotId: DOT,
            text: 'Two',
            history: phone.histories.history('conv-1'),
            steering: phone.steering.steering('conv-1'),
            route,
        });
        await phone.outbox.enqueue(write);
        await phone.outbox.sendNow(row.id);
        await phone.settle();
        await phone.outbox.sendNow('m-2');
        await phone.settle();
        expect(srv.received.map((message) => message.text)).toEqual(['One', 'Two']);
        expect(new Set(srv.received.map((message) => message.threadId))).toEqual(new Set(['conv-1']));
        // With nothing left in the local lane, a chat's writes go in its own.
        await phone.histories.history('conv-1').pull();
        await phone.settle();
        expect(chatWriteRoute(phone.outbox, 'conv-1')).toEqual({ lane: 'chat:conv-1', dependsOn: null });
        // Before its create resolves, a local chat's writes wait for it.
        srv.offline(true);
        const next = await startChat(phone, 'Three');
        expect(chatWriteRoute(phone.outbox, next.localId)).toEqual({
            lane: `chat:${next.localId}`,
            dependsOn: next.localId,
        });
    });
});

const SHARED: ModelChoice = { source: 'shared', backendId: 'backend-2' };
const BYO: ModelChoice = { source: 'byo', kind: 'openai', model: 'gpt-x' };

/** The create's write of a new chat, as `enqueueNewChat` builds it. */
const createWrite = (inference?: ModelChoice | null) =>
    newChatWrites({
        localId: 'local-a',
        dotId: DOT,
        messageId: 'm-1',
        text: 'Plan the offsite',
        createKey: 'k-1',
        messageKey: 'k-2',
        after: 100,
        serverAt: 5_000,
        ...(inference === undefined ? {} : { inference }),
    })[0];

/** The kind's decode, as the outbox calls it for a row of this build's version. */
const decode = (payload: string) => newChatKind().decode!(payload, NEW_CHAT_VERSION);

describe('the model chosen on New chat', () => {
    it('keeps the model in the create’s payload, and decodes it back; none for the socio’s default', () => {
        for (const choice of [SHARED, BYO]) {
            const write = createWrite(choice);
            expect(write.payloadVersion).toBe(NEW_CHAT_VERSION);
            expect(decode(write.payload)).toEqual({
                dotId: DOT,
                title: 'Plan the offsite',
                after: 100,
                serverAt: 5_000,
                inference: choice,
            });
        }
        for (const none of [undefined, null]) {
            const decoded = decode(createWrite(none).payload);
            expect(decoded).toEqual({ dotId: DOT, title: 'Plan the offsite', after: 100, serverAt: 5_000 });
            expect('inference' in decoded).toBe(false);
        }
    });

    it('decodes a row an older build queued (no model, no serverAt), and refuses a model the server wouldn’t take', () => {
        expect(decode(JSON.stringify({ dotId: DOT, title: 'Old', after: null }))).toEqual({
            dotId: DOT,
            title: 'Old',
            after: null,
        });
        for (const bad of [null, 'shared', { source: 'shared' }, { source: 'byo' }, { source: 'other', kind: 'x' }]) {
            expect(() => decode(JSON.stringify({ dotId: DOT, title: 'Old', after: null, inference: bad }))).toThrow(
                TypeError,
            );
        }
    });

    it('sends the model in the create’s body as the web does (`inference`), and leaves it out for the default', async () => {
        const srv = server();
        const phone = await open(srv);
        await startChat(phone, 'On a chosen model', SHARED);
        await phone.settle();
        await startChat(phone, 'On the default', null);
        await phone.settle();
        expect(srv.createBodies).toEqual([
            { dotId: DOT, title: 'On a chosen model', inference: SHARED },
            { dotId: DOT, title: 'On the default' },
        ]);
    });

    it('a first send with a chosen model: the chat holds it before its first message runs, so the first reply uses it', async () => {
        const srv = server();
        const phone = await open(srv);
        // Offline first, so the create and the message wait in the outbox together.
        srv.offline(true);
        const { localId, row } = await startChat(phone, 'Plan the offsite', BYO);
        await phone.settle();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => srv.received.length === 1);

        const serverId = phone.outbox.resolve(CONVERSATION_IDS, localId);
        expect(srv.made()).toEqual([expect.objectContaining({ id: serverId, inference: BYO })]);
        expect(srv.received).toEqual([{ id: row.id, threadId: serverId, text: 'Plan the offsite' }]);
        // One create, and the run (the first reply) on the chosen model; no separate model write.
        expect(srv.runModels).toEqual([{ threadId: serverId, inference: BYO }]);
        expect(srv.log.filter((line) => line.startsWith('PATCH '))).toEqual([]);
    });

    it('a create an older build queued (no model) still goes, on the socio’s default', async () => {
        const srv = server();
        const phone = await open(srv);
        await phone.outbox.enqueue({
            id: 'local-old',
            lane: 'chat:local-old',
            kind: NEW_CHAT_KIND,
            payload: JSON.stringify({ dotId: DOT, title: 'Queued before P-15', after: 100 }),
            payloadVersion: NEW_CHAT_VERSION,
            idempotencyKey: 'old-key',
        });
        await phone.until(() => phone.outbox.resolve(CONVERSATION_IDS, 'local-old') !== null);
        expect(srv.createBodies).toEqual([{ dotId: DOT, title: 'Queued before P-15' }]);
        expect(srv.made()).toEqual([expect.objectContaining({ title: 'Queued before P-15', inference: null })]);
    });
});

describe('titles and watermarks', () => {
    it('takes the web’s title: the text’s first 80 characters, else the first file, else the default', () => {
        expect(newChatTitle('  hello  ')).toBe('hello');
        expect(newChatTitle('x'.repeat(100))).toBe('x'.repeat(80));
        expect(newChatTitle(' ', [{ id: 'f', name: 'scan.pdf', mediaType: 'application/pdf' } as never])).toBe(
            'scan.pdf',
        );
        expect(newChatTitle('')).toBe(DEFAULT_CHAT_TITLE);
    });

    it('builds the title as the server stores it: trimmed after the cut, never half an emoji', () => {
        expect(newChatTitle(`${'a'.repeat(79)} tail`)).toBe('a'.repeat(79));
        const emoji = newChatTitle(`${'a'.repeat(79)}😀😀`);
        expect(emoji).toBe(`${'a'.repeat(79)}😀`);
        expect(emoji.isWellFormed()).toBe(true);
        expect(newChatTitle('', [{ id: 'f', name: 'scan .pdf ', mediaType: 'application/pdf' } as never])).toBe(
            'scan .pdf',
        );
    });

    it('the watermark is the newest chat the phone holds, on the server’s clock', () => {
        expect(newestChat([])).toBeNull();
        expect(newestChat([{ createdAt: 5 }, { createdAt: 9 }, { createdAt: 'x' }])).toBe(9);
    });
});
