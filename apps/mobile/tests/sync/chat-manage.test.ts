import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import type { ReactionKind } from '@socio/shared/chat/reactions';
import type { QueuedMessage } from '@socio/shared/chat/steering';
import type { ModelChoice } from '@socio/shared/inference';
import type { Conversation } from '@socio/shared/types';

import { notSaved, withChatWrites } from '../../src/chat/long-press';
import { openCacheDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    archiveChat,
    CHAT_DELETE_KIND,
    CHAT_UPDATE_KIND,
    cancelQueuedMessage,
    ChatManageError,
    chatManageKinds,
    chatTitle,
    conversationLane,
    deleteChat,
    editQueuedMessage,
    MANAGE_REASON,
    REACTION_VERSION,
    react,
    renameChat,
    setChatModel,
} from '../../src/sync/chat-manage';
import { chatMessageWrite, MESSAGE_IDS } from '../../src/sync/chat-send';
import { createHistoryStore, type HistoryStore } from '../../src/sync/history';
import { CONVERSATION_IDS, isLocalChat } from '../../src/sync/local-ids';
import { newChatKind, newChatWrites } from '../../src/sync/new-chat';
import { type Outbox, type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import type { ReactionReport } from '../../src/sync/reactions';
import type { ConfirmedChange } from '../../src/sync/snapshot-cache';
import { createSteeringStore, queuedBubbles, type SteeringStore } from '../../src/sync/steering';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

import { CACHE_KEY } from './helpers';
import { turns, userDb } from './outbox-fakes';

// Chat management writes: rename,
// archive, delete, reactions, steering edit and cancel on a real outbox
// (user.db), history store (cache.db) and steering snapshot, against a fake
// server whose routes answer as src/server's do (workspace-routes.ts,
// reaction-routes.ts, steering-routes.ts): statuses and codes, never text.

const THREAD = 'conv-1';
const DOT = 'dot-1';

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Chat {
    id: string;
    dotId: string;
    title: string;
    createdAt: number;
    kind: 'private';
    archivedAt?: number;
    deleted?: boolean;
    inference?: ModelChoice | null;
}

type Script =
    /** The server applies the write, then the connection drops before the answer. */
    'drop' | { readonly status: number; readonly body?: unknown };

function server() {
    const chats = new Map<string, Chat>([
        [THREAD, { id: THREAD, dotId: DOT, title: 'First', createdAt: 100, kind: 'private' }],
    ]);
    const runs: HistoryRun[] = [];
    const queue: QueuedMessage[] = [];
    const reactions = new Map<string, Set<ReactionKind>>();
    /**
     * AI reply reports (CB-382), as reaction-routes.ts checks them: sharing,
     * consent, an existing report, then `shownByOther` against `promptByOther`.
     */
    const reports = {
        sharing: true,
        consent: 'consent-1',
        promptByOther: false,
        /** The next report can't be made (`unavailable`). */
        unavailable: false,
        /** By message: queued or shared (sent). */
        made: new Map<string, 'queued' | 'shared'>(),
        /** Every PUT's body, in order. */
        bodies: [] as unknown[],
    };
    /** The next answers, by `<METHOD> <route>`: `PATCH chat`, `DELETE chat`, `PUT reaction`, `PATCH queued`... */
    const scripts = new Map<string, Script[]>();
    const log: string[] = [];
    let blocked: string | null = null;
    let running = false;
    let next = 1;

    const script = (key: string) => scripts.get(key)?.shift();
    /** Removing the thumbs-down: an unsent report is deleted, a sent one kept (§5). */
    const withdraw = (messageId: string) => {
        const made = reports.made.get(messageId);
        if (made === undefined) {
            return undefined;
        }
        if (made === 'shared') {
            return 'kept';
        }
        reports.made.delete(messageId);
        return 'withdrawn';
    };
    const view = () => ({ messages: [...queue], limit: 5, running });
    const store = (messages: Message[]) => {
        const seq = (runs.at(-1)?.seq ?? 0) + 10;
        runs.push({
            seq,
            prev: runs.at(-1)?.seq ?? null,
            runId: `run-${seq}`,
            status: 'completed' as HistoryRun['status'],
            startedAt: seq,
            finishedAt: seq + 1,
            messages: [...messages, { id: `reply-${seq}`, role: 'assistant', content: 'ok' }],
            times: { messages: [], tools: [], reasoning: [] },
            light: {},
            size: 10,
        });
    };
    /** Applies, unless scripted: a status answers instead, a drop applies then throws. */
    const answer = (key: string, path: string, apply: () => Response): Response => {
        const scripted = script(key);
        if (scripted === 'drop') {
            apply();
            throw new NetworkError(path);
        }
        if (scripted !== undefined) {
            return json(scripted.status, scripted.body ?? {});
        }
        return apply();
    };

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        log.push(`${method} ${input}`);
        const url = new URL(input, 'https://brain.example.test');
        const path = url.pathname;
        if (path === '/api/conversations' && method === 'POST') {
            const body = init.json as { dotId: string; title: string };
            const chat: Chat = {
                id: `conv-${++next}`,
                dotId: body.dotId,
                title: body.title,
                createdAt: 200,
                kind: 'private',
            };
            chats.set(chat.id, chat);
            return json(201, chat);
        }
        let match = /^\/api\/conversations\/([^/]+)(\/deletion)?$/.exec(path);
        if (match) {
            const chat = chats.get(decodeURIComponent(match[1]!));
            if (chat === undefined || chat.deleted) {
                return json(404, { error: 'Conversation not found.' });
            }
            if (match[2]) {
                return json(200, { scheduledTasks: 0, blocked });
            }
            if (method === 'PATCH') {
                const body = init.json as { title?: string; archived?: boolean; inference?: ModelChoice | null };
                expect(
                    Object.keys(body).every((key) => key === 'title' || key === 'archived' || key === 'inference'),
                ).toBe(true);
                return answer('PATCH chat', path, () => {
                    if (body.inference !== undefined) {
                        chat.inference = body.inference;
                    }
                    if (body.title !== undefined) {
                        chat.title = body.title.trim();
                    }
                    if (body.archived === true) {
                        chat.archivedAt = 500;
                    } else if (body.archived === false) {
                        delete chat.archivedAt;
                    }
                    return json(200, chat);
                });
            }
            if (method === 'DELETE') {
                return answer('DELETE chat', path, () => {
                    if (blocked !== null) {
                        return json(409, { error: 'A turn is running.' });
                    }
                    chat.deleted = true;
                    return json(200, { ok: true });
                });
            }
        }
        match = /^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(path);
        if (match) {
            const [, , messageId, kind] = match as unknown as [string, string, string, ReactionKind];
            const key = method === 'PUT' ? 'PUT reaction' : 'DELETE reaction';
            return answer(key, path, () => {
                if (
                    method === 'PUT' &&
                    !runs.some((run) => run.messages.some((m) => m.id === messageId && m.role === 'assistant'))
                ) {
                    return json(404, { error: 'Message not found.' });
                }
                const mine = reactions.get(messageId) ?? new Set<ReactionKind>();
                reactions.set(messageId, mine);
                let report: string | undefined;
                if (method === 'PUT') {
                    reports.bodies.push(init.json);
                    mine.add(kind);
                    const asked = (init.json as { report?: { consent: string; shownByOther: boolean } } | undefined)
                        ?.report;
                    if (kind === 'up' && mine.delete('down')) {
                        report = withdraw(messageId);
                    } else if (asked !== undefined) {
                        report = !reports.sharing
                            ? 'not-sharing'
                            : asked.consent !== reports.consent
                              ? 'consent-changed'
                              : reports.made.has(messageId)
                                ? 'already'
                                : reports.promptByOther && !asked.shownByOther
                                  ? 'consent-changed'
                                  : reports.unavailable
                                    ? 'unavailable'
                                    : (reports.made.set(messageId, 'queued'), 'queued');
                    }
                } else {
                    mine.delete(kind);
                    if (kind === 'down') {
                        report = withdraw(messageId);
                    }
                }
                const mark = mine.has('down') ? reports.made.get(messageId) : undefined;
                return json(200, {
                    shared: false,
                    messages: {
                        [messageId]: { counts: {}, mine: [...mine], ...(mark === undefined ? {} : { report: mark }) },
                    },
                    ...(report === undefined ? {} : { report }),
                });
            });
        }
        if (path === `/api/conversations/${THREAD}/steering` && method === 'GET') {
            return json(200, view());
        }
        match = new RegExp(`^/api/conversations/${THREAD}/steering/([^/]+)$`).exec(path);
        if (match) {
            const id = decodeURIComponent(match[1]!);
            const index = queue.findIndex((message) => message.id === id);
            const key = method === 'PATCH' ? 'PATCH queued' : 'DELETE queued';
            return answer(key, path, () => {
                if (index < 0) {
                    return json(409, { error: 'That message has gone to your socio already.', code: 'delivered' });
                }
                if (method === 'PATCH') {
                    const body = init.json as { text: string };
                    queue[index] = { ...queue[index]!, text: body.text, updatedAt: 900 };
                    return json(200, { message: queue[index], ...view() });
                }
                queue.splice(index, 1);
                return json(200, view());
            });
        }
        if (path === `/api/conversations/${THREAD}/history`) {
            const after = Number(url.searchParams.get('after') ?? -1);
            return json(200, { runs: runs.filter((run) => run.seq > after), more: false });
        }
        return json(404, { error: 'Not found.' });
    };

    return {
        fetch,
        chats,
        runs,
        queue,
        reactions,
        reports,
        log,
        store,
        script(key: string, ...answers: Script[]) {
            scripts.set(key, [...(scripts.get(key) ?? []), ...answers]);
        },
        block(reason: string | null) {
            blocked = reason;
        },
        run(on: boolean) {
            running = on;
        },
        /** A turn takes queued message `id`: gone from the queue, stored when `store`. */
        deliver(id: string, stored = true) {
            const index = queue.findIndex((message) => message.id === id);
            const [message] = queue.splice(index, 1);
            if (stored && message) {
                store([{ id: message.id, role: 'user', content: message.text }]);
            }
        },
        queueMessage(text: string) {
            const message: QueuedMessage = { id: `srv-${++next}`, text, createdAt: next, updatedAt: next };
            queue.push(message);
            return message;
        },
    };
}

type Server = ReturnType<typeof server>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

let ids = 0;
const newId = () => `id-${++ids}`;

interface Phone {
    readonly outbox: Outbox;
    readonly histories: HistoryStore;
    readonly steering: SteeringStore;
    readonly confirmed: ConfirmedChange[];
    readonly reactionViews: [string, unknown][];
    /** What became of each report a write carried, as handed to the reactions store. */
    readonly reportOutcomes: ReactionReport[];
    readonly kinds: OutboxKind<unknown>[];
    /** Settles until `done` holds, through the outbox's back-off (real timers), or fails after 15 s. */
    until(done: () => boolean): Promise<void>;
    settle(): Promise<void>;
}

async function open(srv: Server, options: { extraKinds?: OutboxKind<unknown>[] } = {}): Promise<Phone> {
    const user = await userDb();
    const cacheDir = mkdtempSync(join(tmpdir(), 'socio-manage-'));
    const userFile = await user.open();
    const cacheDb = await openCacheDb(createNodeSqliteDriver({ keys: new Map() }), cacheDir, CACHE_KEY);
    const histories = createHistoryStore({
        scopeId: `t.${++ids}`,
        db: cacheDb.db,
        fetch: srv.fetch,
        isLocal: isLocalChat,
    });
    const steering = createSteeringStore({ scopeId: `t.${ids}`, fetch: srv.fetch, isLocal: isLocalChat });
    const confirmed: ConfirmedChange[] = [];
    const reactionViews: [string, unknown][] = [];
    const reportOutcomes: ReactionReport[] = [];
    const kinds = chatManageKinds({
        histories,
        steering,
        cache: {
            confirm: async (change) => {
                confirmed.push(change);
            },
        },
        onReactions: (threadId, view, report) => {
            reactionViews.push([threadId, view]);
            if (report !== undefined) {
                reportOutcomes.push(report);
            }
        },
        waits: { deleteBusyMs: 50, cancelTurnMs: 50 },
    });
    const outbox = await openOutbox({
        db: userFile.db,
        state: userFile.state,
        kinds: [...kinds, ...(options.extraKinds ?? [])],
        fetch: srv.fetch,
        random: () => 0,
    });
    cleanups.push(async () => {
        await outbox.dispose();
        await histories.close();
        await steering.close();
        await userFile.db.close().catch(() => {});
        await cacheDb.db.close().catch(() => {});
        rmSync(user.directory, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
    });
    outbox.start();
    const phone: Phone = {
        outbox,
        histories,
        steering,
        confirmed,
        reactionViews,
        reportOutcomes,
        kinds,
        async settle() {
            for (let i = 0; i < 3; i += 1) {
                await turns(10);
                await outbox.idle();
            }
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

const empty = (phone: Phone) => phone.outbox.rows().length === 0;

describe("the chat's model (the header's picker)", () => {
    const BYO: ModelChoice = { source: 'byo', kind: 'chatgpt', model: 'gpt-astra' };

    it("sets the model with the web's PATCH, and goes back to the socio's default with null", async () => {
        const srv = server();
        const phone = await open(srv);
        await setChatModel(phone.outbox, { threadId: THREAD, inference: BYO, newId });
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.inference).toEqual(BYO);
        expect(phone.confirmed.at(-1)).toEqual(
            expect.objectContaining({ key: THREAD, value: expect.objectContaining({ inference: BYO }) }),
        );
        await setChatModel(phone.outbox, { threadId: THREAD, inference: null, newId });
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.inference).toBeNull();
    });

    it('shows the pick at once, folded with a queued rename, and says a refused one in its own words', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('PATCH chat', { status: 503, body: { code: 'draining' } });
        await setChatModel(phone.outbox, { threadId: THREAD, inference: BYO, newId });
        const overlays = overlaysOf({ rows: phone.outbox.rows(), kinds: phone.kinds, scope: phone.outbox });
        expect(overlays).toEqual([
            expect.objectContaining({ collection: 'conversations', key: THREAD, value: { inference: BYO } }),
        ]);
        const shown = withChatWrites(
            [{ id: THREAD, dotId: DOT, title: 'First', createdAt: 1 } as Conversation],
            overlays,
        );
        expect(shown[0]!.inference).toEqual(BYO);
        await phone.until(() => empty(phone));

        srv.script('PATCH chat', { status: 400, body: { error: 'Pick a model.' } });
        await setChatModel(phone.outbox, { threadId: THREAD, inference: null, newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]!.reason).toBe('model');
        const refused = overlaysOf({
            rows: phone.outbox.rows(),
            unsent: phone.outbox.unsent(),
            kinds: phone.kinds,
            scope: phone.outbox,
        });
        expect(notSaved(refused, { chats: [{ id: THREAD, title: 'First' } as Conversation] })[0]!.text).toBe(
            'Couldn’t change the model of “First”.',
        );
    });
});

describe('rename and archive', () => {
    it('renames a chat, hands the answer to cache.db and pulls nothing twice', async () => {
        const srv = server();
        const phone = await open(srv);
        await renameChat(phone.outbox, { threadId: THREAD, title: '  Plans for May  ', newId });
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.title).toBe('Plans for May');
        expect(phone.confirmed).toEqual([
            expect.objectContaining({
                collection: 'conversations',
                scope: '',
                key: THREAD,
                value: expect.objectContaining({ title: 'Plans for May' }),
            }),
        ]);
        expect(srv.log.filter((line) => line.startsWith('PATCH'))).toHaveLength(1);
    });

    it('takes 1 to 80 characters, as the server does', async () => {
        const srv = server();
        const phone = await open(srv);
        expect(chatTitle('   ')).toBeNull();
        expect(chatTitle('x'.repeat(81))).toBeNull();
        expect(chatTitle(` ${'x'.repeat(80)} `)).toBe('x'.repeat(80));
        expect(() => renameChat(phone.outbox, { threadId: THREAD, title: ' ', newId })).toThrow(ChatManageError);
        expect(phone.outbox.rows()).toHaveLength(0);
    });

    it('shows the change at once as an overlay on the chat', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('PATCH chat', { status: 503, body: { code: 'draining' } });
        await renameChat(phone.outbox, { threadId: THREAD, title: 'New name', newId });
        const overlays = overlaysOf({ rows: phone.outbox.rows(), kinds: phone.kinds, scope: phone.outbox });
        expect(overlays).toEqual([
            expect.objectContaining({
                collection: 'conversations',
                key: THREAD,
                mode: 'patch',
                value: { title: 'New name' },
            }),
        ]);
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.title).toBe('New name');
    });

    it('folds a rename and an archive into the queued row, and archive then undo leaves it unarchived', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('PATCH chat', { status: 503, body: { code: 'draining' } });
        await archiveChat(phone.outbox, { threadId: THREAD, archived: true, newId });
        await phone.settle();
        // The first attempt is waiting out its back-off: queued, so it folds.
        await renameChat(phone.outbox, { threadId: THREAD, title: 'Kept', newId });
        await archiveChat(phone.outbox, { threadId: THREAD, archived: false, newId });
        expect(phone.outbox.rows()).toHaveLength(1);
        expect(JSON.parse(phone.outbox.rows()[0]!.payload)).toEqual({
            threadId: THREAD,
            archived: false,
            title: 'Kept',
        });
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)).toMatchObject({ title: 'Kept' });
        expect(srv.chats.get(THREAD)!.archivedAt).toBeUndefined();
    });

    it('archives, then the undo goes after it in order', async () => {
        const srv = server();
        const phone = await open(srv);
        await archiveChat(phone.outbox, { threadId: THREAD, archived: true, newId });
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.archivedAt).toBe(500);
        await archiveChat(phone.outbox, { threadId: THREAD, archived: false, newId });
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.archivedAt).toBeUndefined();
    });

    it('a 400 or a gone chat goes to unsent, by status alone', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('PATCH chat', { status: 400, body: { error: 'Enter a title of 1 to 80 characters.' } });
        await renameChat(phone.outbox, { threadId: THREAD, title: 'Too odd', newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]).toMatchObject({ kind: CHAT_UPDATE_KIND, reason: 'title' });

        const gone = await open(srv);
        await renameChat(gone.outbox, { threadId: 'conv-missing', title: 'Hello', newId });
        await gone.until(() => gone.outbox.unsent().length === 1);
        expect(gone.outbox.unsent()[0]).toMatchObject({ reason: MANAGE_REASON.gone });
    });

    it('a rename that may have landed goes again: the server applies it twice, the same', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('PATCH chat', 'drop');
        await renameChat(phone.outbox, { threadId: THREAD, title: 'Twice', newId });
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.title).toBe('Twice');
        expect(srv.log.filter((line) => line.startsWith('PATCH'))).toHaveLength(2);
    });

    it("a new chat's rename waits for its create and names the server's id", async () => {
        const srv = server();
        const phone = await open(srv, { extraKinds: [newChatKind() as OutboxKind<unknown>] });
        const [create] = newChatWrites({
            localId: 'local-a',
            dotId: DOT,
            messageId: newId(),
            text: 'hi',
            createKey: newId(),
            messageKey: newId(),
            after: 100,
        });
        await phone.outbox.enqueue(create);
        const row = await renameChat(phone.outbox, { threadId: 'local-a', title: 'Named', newId });
        expect(row).not.toBe('folded');
        expect(row).toMatchObject({ lane: conversationLane('local-a'), dependsOn: 'local-a' });
        await phone.until(() => empty(phone));
        const serverId = phone.outbox.resolve(CONVERSATION_IDS, 'local-a')!;
        expect(srv.chats.get(serverId)!.title).toBe('Named');
        expect(srv.log.some((line) => line.includes('local-'))).toBe(false);
        // A later write under the server id goes in its own lane: the local one holds nothing now.
        const later = await renameChat(phone.outbox, { threadId: serverId, title: 'Renamed', newId });
        expect(later).toMatchObject({ lane: conversationLane(serverId) });
    });
});

describe('delete', () => {
    it('deletes and hands the delete to cache.db', async () => {
        const srv = server();
        const phone = await open(srv);
        await deleteChat(phone.outbox, { threadId: THREAD, newId });
        const overlays = overlaysOf({ rows: phone.outbox.rows(), kinds: phone.kinds, scope: phone.outbox });
        expect(overlays[0]).toMatchObject({ collection: 'conversations', key: THREAD, value: { deleted: true } });
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.deleted).toBe(true);
        expect(phone.confirmed).toEqual([{ collection: 'conversations', scope: '', key: THREAD, deleted: true }]);
    });

    it('blocked while a turn runs: asks GET …/deletion and waits, then deletes once it ends', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.block('running');
        await deleteChat(phone.outbox, { threadId: THREAD, newId });
        await phone.until(() => srv.log.includes(`GET /api/conversations/${THREAD}/deletion`));
        expect(phone.outbox.rows()[0]).toMatchObject({ state: 'queued', lastError: MANAGE_REASON.busy });
        expect(srv.chats.get(THREAD)!.deleted).toBeUndefined();
        srv.block(null);
        await phone.until(() => srv.chats.get(THREAD)!.deleted === true);
    });

    it("a Telegram chat can't be deleted from here: unsent, never matched by text", async () => {
        const srv = server();
        const phone = await open(srv);
        srv.block('telegram');
        await deleteChat(phone.outbox, { threadId: THREAD, newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]).toMatchObject({ kind: CHAT_DELETE_KIND, reason: 'blocked-telegram' });
    });

    it('a rename after a refused delete replaces it, so it never waits behind the refusal', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.block('telegram');
        await deleteChat(phone.outbox, { threadId: THREAD, newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        await renameChat(phone.outbox, { threadId: THREAD, title: 'Kept', newId });
        expect(phone.outbox.unsent()).toHaveLength(0);
        await phone.until(() => empty(phone));
        expect(srv.chats.get(THREAD)!.title).toBe('Kept');
        expect(srv.chats.get(THREAD)!.deleted).toBeUndefined();
    });

    it("a room's 409 carries a code: unsent with it", async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('DELETE chat', {
            status: 409,
            body: { error: 'Rooms are archived, not deleted.', code: 'not_admin' },
        });
        await deleteChat(phone.outbox, { threadId: THREAD, newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]).toMatchObject({ reason: 'not_admin' });
    });

    it('a delete that landed before the connection dropped finds 404 and is done (the already-applied rule)', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.script('DELETE chat', 'drop');
        await deleteChat(phone.outbox, { threadId: THREAD, newId });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.log.filter((line) => line.startsWith('DELETE'))).toHaveLength(2);
        expect(phone.confirmed).toEqual([{ collection: 'conversations', scope: '', key: THREAD, deleted: true }]);
    });

    it('the second attempt of a delete that may have landed reads as ambiguous', async () => {
        const srv = server();
        const seen: (boolean | undefined)[] = [];
        const spy: OutboxKind<unknown> = {
            kind: 'spy',
            payloadVersion: 1,
            repeatable: true,
            async send(write) {
                seen.push(write.ambiguous);
                return seen.length === 1 ? { action: 'unknown', reason: 'http-500' } : { action: 'done' };
            },
        };
        const phone = await open(srv, { extraKinds: [spy] });
        await phone.outbox.enqueue({
            id: 'w',
            lane: 'spy',
            kind: 'spy',
            payload: '{}',
            payloadVersion: 1,
            idempotencyKey: 'k',
        });
        await phone.until(() => empty(phone));
        expect(seen).toEqual([undefined, true]);
    });
});

describe('reactions', () => {
    it('adds and takes off a reaction on a socio reply, handing each view to the reactions store', async () => {
        const srv = server();
        srv.store([{ id: 'u1', role: 'user', content: 'hi' }]);
        const phone = await open(srv);
        const reply = srv.runs[0]!.messages.at(-1)!.id;
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'up', on: true, newId });
        const overlays = overlaysOf({ rows: phone.outbox.rows(), kinds: phone.kinds, scope: phone.outbox });
        expect(overlays[0]).toMatchObject({
            collection: 'reactions',
            key: `${THREAD}/${reply}`,
            value: { reaction: 'up', on: true },
        });
        await phone.until(() => empty(phone));
        expect([...srv.reactions.get(reply)!]).toEqual(['up']);
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'up', on: false, newId });
        await phone.until(() => empty(phone));
        expect([...srv.reactions.get(reply)!]).toEqual([]);
        expect(phone.reactionViews.map(([thread]) => thread)).toEqual([THREAD, THREAD]);
    });

    it('a toggle back while queued folds into one row', async () => {
        const srv = server();
        srv.store([{ id: 'u1', role: 'user', content: 'hi' }]);
        const phone = await open(srv);
        const reply = srv.runs[0]!.messages.at(-1)!.id;
        srv.script('PUT reaction', { status: 503, body: { code: 'draining' } });
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'down', on: true, newId });
        await phone.settle();
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'down', on: false, newId });
        expect(phone.outbox.rows()).toHaveLength(1);
        await phone.until(() => empty(phone));
        expect(srv.reactions.get(reply)?.has('down') ?? false).toBe(false);
    });

    it("a reaction on what isn't a socio reply goes to unsent; taking one off a gone message is done", async () => {
        const srv = server();
        const phone = await open(srv);
        await react(phone.outbox, { threadId: THREAD, messageId: 'u-none', reaction: 'retry', on: true, newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]).toMatchObject({ reason: MANAGE_REASON.gone });
        srv.script('DELETE reaction', { status: 404, body: { error: 'Conversation not found.' } });
        await react(phone.outbox, { threadId: THREAD, messageId: 'u-other', reaction: 'retry', on: false, newId });
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(phone.outbox.unsent()).toHaveLength(1);
    });

    it("a reaction after a refused one on that message replaces it; another message's stays", async () => {
        const srv = server();
        const phone = await open(srv);
        await react(phone.outbox, { threadId: THREAD, messageId: 'u-none', reaction: 'up', on: true, newId });
        await react(phone.outbox, { threadId: THREAD, messageId: 'u-two', reaction: 'up', on: true, newId });
        await phone.until(() => phone.outbox.unsent().length === 2);
        await react(phone.outbox, { threadId: THREAD, messageId: 'u-none', reaction: 'down', on: true, newId });
        await phone.until(() => phone.outbox.rows().length === 0 && phone.outbox.unsent().length === 2);
        expect(phone.outbox.unsent().map((write) => JSON.parse(write.payload))).toEqual([
            expect.objectContaining({ messageId: 'u-two', reaction: 'up' }),
            expect.objectContaining({ messageId: 'u-none', reaction: 'down' }),
        ]);
    });

    it('refuses an unknown reaction before anything is queued', async () => {
        const srv = server();
        const phone = await open(srv);
        expect(() =>
            react(phone.outbox, {
                threadId: THREAD,
                messageId: 'm',
                reaction: 'love' as ReactionKind,
                on: true,
                newId,
            }),
        ).toThrow(ChatManageError);
    });
});

describe('AI reply reports (CB-382)', () => {
    const REPORT = { reason: 'offensive', consent: 'consent-1', shownByOther: false } as const;
    const stored = (srv: Server) => {
        srv.store([{ id: 'u1', role: 'user', content: 'hi' }]);
        return srv.runs[0]!.messages.at(-1)!.id;
    };

    it('sends the report as the thumbs-down PUT’s body, at payload version 2, and hands its outcome over', async () => {
        const srv = server();
        const reply = stored(srv);
        const phone = await open(srv);
        await react(phone.outbox, {
            threadId: THREAD,
            messageId: reply,
            reaction: 'down',
            on: true,
            report: { ...REPORT, note: '  too rude  ' },
            newId,
        });
        expect(phone.outbox.rows()[0]).toMatchObject({ payloadVersion: REACTION_VERSION });
        await phone.until(() => empty(phone));
        expect(srv.reports.bodies).toEqual([
            { report: { reason: 'offensive', note: 'too rude', consent: 'consent-1', shownByOther: false } },
        ]);
        expect(phone.reportOutcomes).toEqual([{ messageId: reply, outcome: 'queued' }]);
        expect(srv.reports.made.get(reply)).toBe('queued');
    });

    it('leaves a plain reaction at version 1 with no body, and hands no outcome', async () => {
        const srv = server();
        const reply = stored(srv);
        const phone = await open(srv);
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'down', on: true, newId });
        expect(phone.outbox.rows()[0]).toMatchObject({ payloadVersion: 1 });
        await phone.until(() => empty(phone));
        expect(srv.reports.bodies).toEqual([undefined]);
        expect(phone.reportOutcomes).toEqual([]);
    });

    it.each([
        [
            'not-sharing',
            (srv: Server): void => {
                srv.reports.sharing = false;
            },
        ],
        [
            'consent-changed',
            (srv: Server): void => {
                srv.reports.consent = 'consent-2';
            },
        ],
        [
            'consent-changed',
            (srv: Server): void => {
                srv.reports.promptByOther = true;
            },
        ],
        [
            'unavailable',
            (srv: Server): void => {
                srv.reports.unavailable = true;
            },
        ],
        ['already', (srv: Server) => srv.reports.made.set(srv.runs[0]!.messages.at(-1)!.id, 'shared')],
    ] as const)('takes %s without an error: the thumbs-down stays, nothing goes to unsent', async (outcome, set) => {
        const srv = server();
        const reply = stored(srv);
        set(srv);
        const phone = await open(srv);
        await react(phone.outbox, {
            threadId: THREAD,
            messageId: reply,
            reaction: 'down',
            on: true,
            report: REPORT,
            newId,
        });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toEqual([]);
        expect(srv.reactions.get(reply)?.has('down')).toBe(true);
        expect(phone.reportOutcomes).toEqual([{ messageId: reply, outcome }]);
    });

    it('reports another person’s message when the sheet said so (shownByOther)', async () => {
        const srv = server();
        const reply = stored(srv);
        srv.reports.promptByOther = true;
        const phone = await open(srv);
        await react(phone.outbox, {
            threadId: THREAD,
            messageId: reply,
            reaction: 'down',
            on: true,
            report: { ...REPORT, shownByOther: true },
            newId,
        });
        await phone.until(() => empty(phone));
        expect(phone.reportOutcomes).toEqual([{ messageId: reply, outcome: 'queued' }]);
    });

    it('offline, a plain thumbs-down waits; once back, reporting on it makes the report', async () => {
        const srv = server();
        const reply = stored(srv);
        srv.script('PUT reaction', 'drop', { status: 503, body: { code: 'draining' } });
        const phone = await open(srv);
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'down', on: true, newId });
        await phone.until(() => empty(phone));
        expect(srv.reports.made.has(reply)).toBe(false);
        // "Report it now?": the existing thumbs-down takes the report.
        await react(phone.outbox, {
            threadId: THREAD,
            messageId: reply,
            reaction: 'down',
            on: true,
            report: REPORT,
            newId,
        });
        await phone.until(() => empty(phone));
        expect(srv.reports.bodies.at(-1)).toEqual({ report: REPORT });
        expect(phone.reportOutcomes).toEqual([{ messageId: reply, outcome: 'queued' }]);
        expect(srv.reports.made.get(reply)).toBe('queued');
    });

    it('a report on a plain thumbs-down still queued folds into its row; a removal drops the report', async () => {
        const srv = server();
        const reply = stored(srv);
        srv.script('PUT reaction', { status: 503, body: { code: 'draining' } });
        const phone = await open(srv);
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'down', on: true, newId });
        await phone.settle();
        await react(phone.outbox, {
            threadId: THREAD,
            messageId: reply,
            reaction: 'down',
            on: true,
            report: REPORT,
            newId,
        });
        expect(phone.outbox.rows()).toHaveLength(1);
        expect(JSON.parse(phone.outbox.rows()[0]!.payload)).toMatchObject({ report: REPORT });
        expect(phone.outbox.rows()[0]).toMatchObject({ payloadVersion: REACTION_VERSION });
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'down', on: false, newId });
        expect(phone.outbox.rows()).toHaveLength(1);
        expect(JSON.parse(phone.outbox.rows()[0]!.payload)).not.toHaveProperty('report');
        expect(phone.outbox.rows()[0]).toMatchObject({ payloadVersion: 1 });
        await phone.until(() => empty(phone));
        expect(srv.reports.made.has(reply)).toBe(false);
    });

    it('withdraws an unsent report when the thumbs-down goes, and keeps a sent one (§5)', async () => {
        const srv = server();
        const reply = stored(srv);
        const phone = await open(srv);
        await react(phone.outbox, {
            threadId: THREAD,
            messageId: reply,
            reaction: 'down',
            on: true,
            report: REPORT,
            newId,
        });
        await phone.until(() => empty(phone));
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'down', on: false, newId });
        await phone.until(() => empty(phone));
        expect(srv.reports.made.has(reply)).toBe(false);
        await react(phone.outbox, {
            threadId: THREAD,
            messageId: reply,
            reaction: 'down',
            on: true,
            report: REPORT,
            newId,
        });
        await phone.until(() => empty(phone));
        srv.reports.made.set(reply, 'shared');
        await react(phone.outbox, { threadId: THREAD, messageId: reply, reaction: 'up', on: true, newId });
        await phone.until(() => empty(phone));
        expect(srv.reports.made.get(reply)).toBe('shared');
        expect(srv.reactions.get(reply)?.has('down')).toBe(false);
        // Removals carry no report outcome to show (the web says nothing either).
        expect(phone.reportOutcomes.map((item) => item.outcome)).toEqual(['queued', 'queued']);
    });

    it('refuses a report on anything but a thumbs-down being added, or one without its consent', async () => {
        const srv = server();
        const phone = await open(srv);
        const base = { threadId: THREAD, messageId: 'm', newId };
        expect(() => react(phone.outbox, { ...base, reaction: 'up', on: true, report: REPORT })).toThrow(
            ChatManageError,
        );
        expect(() => react(phone.outbox, { ...base, reaction: 'down', on: false, report: REPORT })).toThrow(
            ChatManageError,
        );
        expect(() =>
            react(phone.outbox, { ...base, reaction: 'down', on: true, report: { ...REPORT, consent: '' } }),
        ).toThrow(ChatManageError);
        expect(() =>
            react(phone.outbox, {
                ...base,
                reaction: 'down',
                on: true,
                report: { ...REPORT, reason: 'rude' as 'offensive' },
            }),
        ).toThrow(ChatManageError);
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('decodes a stored report row, and refuses one whose report is malformed', () => {
        const kind = chatManageKinds({ histories: {} as HistoryStore, steering: {} as SteeringStore }).find(
            (item) => item.kind === 'reaction',
        )!;
        const row = { threadId: THREAD, messageId: 'm', reaction: 'down', on: true, report: REPORT };
        expect(kind.decode!(JSON.stringify(row), 2)).toEqual(row);
        expect(() => kind.decode!(JSON.stringify({ ...row, reaction: 'up' }), 2)).toThrow(TypeError);
        expect(() => kind.decode!(JSON.stringify({ ...row, report: { reason: 'offensive' } }), 2)).toThrow(TypeError);
        expect(kind.payloadVersion).toBe(REACTION_VERSION);
    });
});

/** A chat message row, as the composer writes it. */
const message = (id: string, text: string) =>
    chatMessageWrite({
        id,
        idempotencyKey: newId(),
        threadId: THREAD,
        dotId: DOT,
        text,
        history: { list: () => [] },
        steering: { list: () => [], state: { running: true } },
    });

describe('steering edit and cancel', () => {
    it('a message still queued on the phone is edited and cancelled in place, with no request', async () => {
        const srv = server();
        const phone = await open(srv);
        // No chat-message kind here: its rows wait, as one queued behind a held message would.
        await phone.outbox.enqueue(message('m1', 'first'));
        expect(
            await editQueuedMessage(phone.outbox, { threadId: THREAD, messageId: 'm1', text: 'first, edited', newId }),
        ).toBe('in-place');
        expect(JSON.parse(phone.outbox.rows()[0]!.payload)).toMatchObject({ text: 'first, edited' });
        expect(await cancelQueuedMessage(phone.outbox, { threadId: THREAD, messageId: 'm1', newId })).toBe('in-place');
        expect(phone.outbox.rows()).toHaveLength(0);
        expect(srv.log).toEqual([]);
    });

    it('edits a message the server queued, and the snapshot takes the answer', async () => {
        const srv = server();
        srv.run(true);
        const queued = srv.queueMessage('hello');
        const phone = await open(srv);
        const chat = phone.steering.steering(THREAD);
        await chat.refresh();
        expect(
            await editQueuedMessage(phone.outbox, {
                threadId: THREAD,
                messageId: queued.id,
                text: 'hello there',
                newId,
            }),
        ).toBe('queued');
        const overlays = overlaysOf({ rows: phone.outbox.rows(), kinds: phone.kinds, scope: phone.outbox });
        expect(overlays[0]).toMatchObject({ collection: 'steering', key: queued.id, value: { text: 'hello there' } });
        await phone.until(() => empty(phone));
        expect(srv.queue[0]!.text).toBe('hello there');
        expect(chat.list()[0]!.text).toBe('hello there');
    });

    it("an edit of a message in flight waits for its send, then names the server's id", async () => {
        const srv = server();
        srv.run(true);
        let release = () => {};
        const sending = new Promise<void>((resolve) => {
            release = resolve;
        });
        let serverId = '';
        // The chat message kind, as far as this needs: the send goes as steering and settles with the server's id.
        const send: OutboxKind<unknown> = {
            kind: 'chat-message',
            payloadVersion: 1,
            repeatable: false,
            creates: MESSAGE_IDS,
            async send() {
                serverId = srv.queueMessage('from the phone').id;
                await sending;
                return { action: 'done', serverId };
            },
        };
        const phone = await open(srv, { extraKinds: [send] });
        await phone.outbox.enqueue(message('m2', 'from the phone'));
        while (phone.outbox.rows()[0]?.state !== 'inflight') {
            await turns(10);
        }
        const row = phone.outbox.rows()[0]!;
        expect(
            await editQueuedMessage(phone.outbox, { threadId: THREAD, messageId: 'm2', text: 'edited', newId }),
        ).toBe('queued');
        expect(phone.outbox.rows().at(-1)).toMatchObject({ dependsOn: row.id });
        release();
        await phone.until(() => empty(phone));
        expect(srv.log).toContain(`PATCH /api/conversations/${THREAD}/steering/${serverId}`);
        expect(srv.queue[0]!.text).toBe('edited');
    });

    it('an edit after a turn took the message keeps the edited text in unsent', async () => {
        const srv = server();
        srv.run(true);
        const queued = srv.queueMessage('hello');
        const phone = await open(srv);
        srv.deliver(queued.id);
        await editQueuedMessage(phone.outbox, { threadId: THREAD, messageId: queued.id, text: 'too late', newId });
        await phone.until(() => phone.outbox.unsent().length === 1);
        expect(phone.outbox.unsent()[0]).toMatchObject({ reason: MANAGE_REASON.delivered });
        expect(JSON.parse(phone.outbox.unsent()[0]!.payload)).toMatchObject({ text: 'too late' });
    });

    it('an edit that may have landed and then finds it delivered is kept as sent', async () => {
        const srv = server();
        srv.run(true);
        const queued = srv.queueMessage('hello');
        const phone = await open(srv);
        srv.script('PATCH queued', 'drop');
        await editQueuedMessage(phone.outbox, { threadId: THREAD, messageId: queued.id, text: 'edited', newId });
        await phone.until(() => srv.log.filter((line) => line.startsWith('PATCH')).length === 1);
        // The edit landed; the turn takes the edited message before the retry.
        srv.deliver(queued.id);
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.runs.at(-1)!.messages[0]).toMatchObject({ content: 'edited' });
    });

    it('refuses an edit over the steering limit that must go to the server', async () => {
        const srv = server();
        const phone = await open(srv);
        await expect(
            editQueuedMessage(phone.outbox, { threadId: THREAD, messageId: 'srv-9', text: 'x'.repeat(8001), newId }),
        ).rejects.toThrow(ChatManageError);
    });

    it('cancels a message the server queued', async () => {
        const srv = server();
        srv.run(true);
        const queued = srv.queueMessage('never mind');
        const phone = await open(srv);
        await cancelQueuedMessage(phone.outbox, { threadId: THREAD, messageId: queued.id, newId });
        await phone.until(() => empty(phone));
        expect(srv.queue).toHaveLength(0);
    });

    it('a cancel that finds it delivered and stored is done: the turn took it first', async () => {
        const srv = server();
        srv.run(true);
        const queued = srv.queueMessage('never mind');
        const phone = await open(srv);
        srv.deliver(queued.id, true);
        srv.run(false);
        await cancelQueuedMessage(phone.outbox, { threadId: THREAD, messageId: queued.id, newId });
        await phone.until(() => empty(phone));
        expect(phone.outbox.unsent()).toHaveLength(0);
        expect(srv.log).toContain(`GET /api/conversations/${THREAD}/steering`);
        expect(srv.log.some((line) => line.startsWith(`GET /api/conversations/${THREAD}/history`))).toBe(true);
    });

    it('a cancel that landed before the drop finds it absent from both: cancelled', async () => {
        const srv = server();
        srv.run(true);
        const queued = srv.queueMessage('never mind');
        const phone = await open(srv);
        srv.script('DELETE queued', 'drop');
        await cancelQueuedMessage(phone.outbox, { threadId: THREAD, messageId: queued.id, newId });
        srv.run(false);
        await phone.until(() => empty(phone));
        expect(srv.queue).toHaveLength(0);
        expect(srv.runs).toHaveLength(0);
    });

    it.each([
        ['a plain cancel', false],
        ['a cancel that landed before the drop (absent from both)', true],
    ])("%s of a message this phone sent also removes the message's own sent row", async (_name, drop) => {
        const srv = server();
        srv.run(true);
        let serverId = '';
        // The chat message kind, as far as this needs: sent as steering, its row stays `sent` until stored.
        const send: OutboxKind<unknown> = {
            kind: 'chat-message',
            payloadVersion: 1,
            repeatable: false,
            creates: MESSAGE_IDS,
            async send() {
                serverId = srv.queueMessage('from the phone').id;
                return { action: 'done', serverId, awaitStored: true };
            },
        };
        const phone = await open(srv, { extraKinds: [send] });
        await phone.outbox.enqueue(message('m3', 'from the phone'));
        await phone.until(() => phone.outbox.rows()[0]?.state === 'sent');
        const chat = phone.steering.steering(THREAD);
        await chat.refresh();
        const bubbles = () =>
            queuedBubbles(
                phone.outbox.rows().map((row) => ({ id: row.id, serverId: phone.outbox.resolve(MESSAGE_IDS, row.id) })),
                chat.list(),
                (id) => phone.histories.history(THREAD).has(id),
            ).outbox;
        if (drop) {
            srv.script('DELETE queued', 'drop');
        }
        expect(await cancelQueuedMessage(phone.outbox, { threadId: THREAD, messageId: 'm3', newId })).toBe('queued');
        if (drop) {
            srv.run(false);
        }
        await phone.until(() => empty(phone));
        expect(srv.log).toContain(`DELETE /api/conversations/${THREAD}/steering/${serverId}`);
        expect(srv.queue).toHaveLength(0);
        await chat.refresh();
        expect(bubbles()).toEqual([]);
    });

    it("while a turn runs that may hold it, a cancel can't tell yet and looks again", async () => {
        const srv = server();
        srv.run(true);
        const queued = srv.queueMessage('never mind');
        const phone = await open(srv);
        // Taken by the running turn, not stored yet.
        srv.deliver(queued.id, false);
        await cancelQueuedMessage(phone.outbox, { threadId: THREAD, messageId: queued.id, newId });
        await phone.until(() => phone.outbox.rows()[0]?.lastError === MANAGE_REASON.delivered);
        expect(phone.outbox.rows()).toHaveLength(1);
        // The turn ends with it stored.
        srv.store([{ id: queued.id, role: 'user', content: queued.text }]);
        srv.run(false);
        await phone.until(() => empty(phone));
    });
});
