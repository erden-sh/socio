import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HistoryPage } from '@socio/shared/chat/chat-history';
import type { ReactionsView } from '@socio/shared/chat/reactions';

import { openCacheDb } from '../../src/data';
import { createAuthedFetch, type AuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { FetchFunction } from '../../src/net/fetch-function';
import { readJson } from '../../src/net/read-body';
import { SIGN_IN_PATH } from '../../src/net/sign-in';
import { chatManageKinds, react, renameChat } from '../../src/sync/chat-manage';
import { chatLane, chatMessageKind, chatMessageWrite, followStoredChats } from '../../src/sync/chat-send';
import { createHistoryStore } from '../../src/sync/history';
import { type Outbox, type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { createSteeringStore } from '../../src/sync/steering';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { CACHE_KEY } from '../sync/helpers';
import { userDb } from '../sync/outbox-fakes';

// The chat management writes' contract test: a rename and a reaction through
// the outbox against a real local Socio server with the fake model, as the
// chat send's (chat-send.test.ts): it needs `pnpm run build` and `node
// apps/mobile/e2e/servers.mjs`, and runs only when SOCIO_CONTRACT_CREDENTIALS
// names the credentials file servers.mjs wrote; CI skips it.

const CREDENTIALS = process.env.SOCIO_CONTRACT_CREDENTIALS;

interface Credentials {
    password: string;
    accounts: { email: string }[];
    servers: { origin: string }[];
}

const nodeFetch: FetchFunction = (url, init) => fetch(url, init as RequestInit);

let ids = 0;
const newId = () => `o3c-${Date.now().toString(36)}-${++ids}`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

async function json<T>(request: AuthedFetch, path: string, init?: Parameters<AuthedFetch>[1]): Promise<T> {
    const response = await request(path, init);
    if (!response.ok) {
        throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status}`);
    }
    return (await readJson(response)) as T;
}

async function setup() {
    const credentials = JSON.parse(readFileSync(CREDENTIALS!, 'utf8')) as Credentials;
    const origin = credentials.servers[0]!.origin;
    const jar = await openCookieJar({ origin, store: memoryJarStore() });
    const request = createAuthedFetch({
        origin,
        jar,
        fetch: nodeFetch,
        userAgent: 'Socio/0.1.0 (contract test)',
        signal: new AbortController().signal,
    });
    await json(request, SIGN_IN_PATH, {
        method: 'POST',
        json: { email: credentials.accounts[0]!.email, password: credentials.password },
    });
    const workspace = await json<{ dots: { id: string }[] }>(request, '/api/workspace');
    const dotId = workspace.dots[0]!.id;
    const thread = await json<{ id: string }>(request, '/api/conversations', {
        method: 'POST',
        json: { dotId, title: 'O3c contract' },
    });

    const views: unknown[] = [];
    const cacheDir = mkdtempSync(join(tmpdir(), 'socio-o3c-contract-'));
    const cacheDb = await openCacheDb(createNodeSqliteDriver({ keys: new Map() }), cacheDir, CACHE_KEY);
    let outboxRef: Outbox | null = null;
    const histories = createHistoryStore({
        scopeId: `contract.${++ids}`,
        db: cacheDb.db,
        fetch: request,
        onRuns: (threadId, has) => void outboxRef?.caughtUp(chatLane(threadId), has),
    });
    const steering = createSteeringStore({ scopeId: `contract.${ids}`, fetch: request });
    const files = await userDb();
    const file = await files.open();
    const kind = chatMessageKind({
        histories,
        steering,
        newId,
        afterWrite: () => void histories.history(thread.id).pull(),
    });
    const manage = chatManageKinds({
        histories,
        steering,
        onReactions: (_thread, view) => views.push(view),
    });
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [kind as OutboxKind<unknown>, ...manage],
        fetch: request,
    });
    outboxRef = outbox;
    followStoredChats(outbox, histories);
    outbox.start();
    cleanups.push(async () => {
        await outbox.dispose();
        await file.db.close();
        await histories.close();
        await steering.close();
        await cacheDb.db.close();
        rmSync(cacheDir, { recursive: true, force: true });
        rmSync(files.directory, { recursive: true, force: true });
    });
    const send = async (text: string) => {
        const id = newId();
        await outbox.enqueue(
            chatMessageWrite({
                id,
                idempotencyKey: newId(),
                threadId: thread.id,
                dotId,
                text,
                history: histories.history(thread.id),
                steering: steering.steering(thread.id),
            }),
        );
        return id;
    };
    const stored = async () =>
        (
            await json<HistoryPage>(request, `/api/conversations/${encodeURIComponent(thread.id)}/history?after=0`)
        ).runs.flatMap((run) => run.messages);
    return { request, outbox, histories, steering, send, stored, views, threadId: thread.id, dotId };
}

const until = async (check: () => Promise<boolean> | boolean, ms = 45_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) {
            throw new Error('Timed out.');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
};

describe.skipIf(!CREDENTIALS)('chat management writes against a local server', () => {
    it('renames a chat, and the chat list says so', { timeout: 60_000 }, async () => {
        const session = await setup();
        await renameChat(session.outbox, { threadId: session.threadId, title: '  Renamed by O3c  ', newId });
        await until(() => session.outbox.rows().length === 0);
        expect(session.outbox.unsent()).toHaveLength(0);
        const workspace = await json<{ conversations: { id: string; title: string; renamed?: boolean }[] }>(
            session.request,
            '/api/workspace',
        );
        expect(workspace.conversations.find((chat) => chat.id === session.threadId)).toMatchObject({
            title: 'Renamed by O3c',
            renamed: true,
        });
    });

    it("adds and takes off a reaction on the socio's reply", { timeout: 60_000 }, async () => {
        const session = await setup();
        await session.send('smoke stream');
        await until(async () => (await session.stored()).some((message) => message.role === 'assistant'));
        await until(() => session.outbox.rows().length === 0);
        const reply = (await session.stored()).find((message) => message.role === 'assistant')!.id;
        await react(session.outbox, { threadId: session.threadId, messageId: reply, reaction: 'up', on: true, newId });
        await until(() => session.outbox.rows().length === 0);
        expect(session.outbox.unsent()).toHaveLength(0);
        const path = `/api/conversations/${encodeURIComponent(session.threadId)}/reactions`;
        expect((await json<ReactionsView>(session.request, path)).messages[reply]?.mine).toEqual(['up']);
        expect(session.views).toHaveLength(1);
        await react(session.outbox, { threadId: session.threadId, messageId: reply, reaction: 'up', on: false, newId });
        await until(() => session.outbox.rows().length === 0);
        expect((await json<ReactionsView>(session.request, path)).messages[reply]?.mine ?? []).toEqual([]);
    });
});
