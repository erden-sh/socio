import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { HistoryPage } from '@socio/shared/chat/chat-history';

import { openCacheDb } from '../../src/data';
import { createAuthedFetch, type AuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { FetchFunction } from '../../src/net/fetch-function';
import { readJson } from '../../src/net/read-body';
import { stopPath } from '../../src/net/run-client';
import { SIGN_IN_PATH } from '../../src/net/sign-in';
import { chatLane, chatMessageKind, chatMessageWrite, followStoredChats, MESSAGE_IDS } from '../../src/sync/chat-send';
import { createHistoryStore } from '../../src/sync/history';
import { type Outbox, type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { createSteeringStore } from '../../src/sync/steering';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { CACHE_KEY } from '../sync/helpers';
import { userDb } from '../sync/outbox-fakes';

// The chat send's contract test: the chat message kind on a real outbox
// against a real local Socio server with the fake model. It needs `pnpm run
// build` and `node apps/mobile/e2e/servers.mjs` (made-up accounts, the fake
// model with its scripts), and runs only when SOCIO_CONTRACT_CREDENTIALS
// names the credentials file servers.mjs wrote; CI skips it. A send goes as a
// run; a send while a slow turn runs goes as steering, the turn takes it, and
// each message is stored exactly once.

const CREDENTIALS = process.env.SOCIO_CONTRACT_CREDENTIALS;

interface Credentials {
    password: string;
    accounts: { email: string }[];
    servers: { origin: string }[];
}

const nodeFetch: FetchFunction = (url, init) => fetch(url, init as RequestInit);

let ids = 0;
const newId = () => `o3a-${Date.now().toString(36)}-${++ids}`;

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
        json: { dotId, title: 'O3a contract' },
    });

    const cacheDir = mkdtempSync(join(tmpdir(), 'socio-o3a-contract-'));
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
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [kind as OutboxKind<unknown>],
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
    return { request, outbox, histories, steering, send, stored, threadId: thread.id, dotId };
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

describe.skipIf(!CREDENTIALS)('sending in a private chat against a local server', () => {
    it('a send goes as a run, stored once, and leaves the outbox', { timeout: 60_000 }, async () => {
        const session = await setup();
        const id = await session.send('smoke stream');
        await until(() => session.outbox.rows().length === 0);
        const messages = await session.stored();
        expect(messages.filter((message) => message.id === id)).toHaveLength(1);
    });

    it('a send while a turn runs goes as steering; the turn takes it, once', { timeout: 90_000 }, async () => {
        const session = await setup();
        await session.send('smoke slow-stream');
        await until(async () => {
            await session.steering.steering(session.threadId).refresh();
            return session.steering.steering(session.threadId).state.running;
        });
        const queuedId = await session.send('smoke stream');
        await until(() => session.outbox.resolve(MESSAGE_IDS, queuedId) !== null);
        const serverId = session.outbox.resolve(MESSAGE_IDS, queuedId)!;
        expect(serverId).not.toBe(queuedId);
        // End the slow turn: the server starts the next one with the queued message.
        await session.request(stopPath(session.dotId, session.threadId), { method: 'POST', json: {} });
        await until(async () => (await session.stored()).some((message) => message.id === serverId), 60_000);
        const users = (await session.stored()).filter((message) => message.role === 'user');
        expect(users.filter((message) => message.content === 'smoke stream')).toHaveLength(1);
        expect(users.filter((message) => message.content === 'smoke slow-stream')).toHaveLength(1);
        await until(async () => {
            await session.histories.history(session.threadId).pull();
            return session.outbox.rows().length === 0;
        });
    });
});
