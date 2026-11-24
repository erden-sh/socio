import { readFileSync } from 'node:fs';

import type { BaseEvent, Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';

import type { HistoryPage } from '@socio/shared/chat/chat-history';

import { createAuthedFetch, type AuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { FetchFunction } from '../../src/net/fetch-function';
import { readJson } from '../../src/net/read-body';
import { readSse, type SseFrame } from '../../src/net/read-sse';
import { createRunClient, type RunClient } from '../../src/net/run-client';
import { SIGN_IN_PATH } from '../../src/net/sign-in';

// The run client's contract test: the run client
// against a real local Socio server with the fake model, not a fake endpoint.
// It needs `pnpm run build` and `node apps/mobile/e2e/servers.mjs` (made-up
// accounts, the fake model with its scripts), and runs only when
// SOCIO_CONTRACT_CREDENTIALS names the credentials file servers.mjs wrote;
// CI has no server, so it skips there. It covers one turn, a stop, and a POST
// dropped after RUN_STARTED whose run still finishes and which `/stream`
// replays.

const CREDENTIALS = process.env.SOCIO_CONTRACT_CREDENTIALS;

interface Credentials {
    password: string;
    accounts: { email: string }[];
    servers: { origin: string }[];
}

interface Session {
    request: AuthedFetch;
    client: RunClient;
    dotId: string;
    threadId: string;
}

let ids = 0;
const newId = () => `rc-contract-${Date.now().toString(36)}-${++ids}`;

/** Node's fetch, as the app's FetchFunction (expo/fetch's signature). */
const nodeFetch: FetchFunction = (url, init) => fetch(url, init as RequestInit);

async function json<T>(request: AuthedFetch, path: string, init?: Parameters<AuthedFetch>[1]): Promise<T> {
    const response = await request(path, init);
    if (!response.ok) {
        throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status}`);
    }
    return (await readJson(response)) as T;
}

async function signIn(): Promise<Session> {
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
    // A chat of its own, so runs elsewhere don't touch it.
    const thread = await json<{ id: string }>(request, '/api/conversations', {
        method: 'POST',
        json: { dotId, title: 'RC contract' },
    });
    return { request, client: createRunClient({ fetch: request, newId }), dotId, threadId: thread.id };
}

const history = (session: Session, after = 0) =>
    json<HistoryPage>(
        session.request,
        `/api/conversations/${encodeURIComponent(session.threadId)}/history?after=${after}`,
    );

const storedMessages = async (session: Session): Promise<Message[]> =>
    (await history(session)).runs.flatMap((run) => run.messages);

const say = (id: string, content: string): Message => ({ id, role: 'user', content });

describe.skipIf(!CREDENTIALS)('the run client against a local server', () => {
    it('one turn: streams, finishes, and the server stores exactly the one message', { timeout: 60_000 }, async () => {
        const session = await signIn();
        const message = say(newId(), 'smoke stream');
        const body = session.client.body({ threadId: session.threadId, stored: [], message });
        const events: BaseEvent[] = [];
        const outcome = await session.client.run(session.dotId, body, { onEvent: (event) => events.push(event) });
        expect(outcome).toMatchObject({ kind: 'ended' });
        expect(outcome.kind === 'ended' && outcome.error).toBeFalsy();
        const startedEvent = events.find((event) => event.type === 'RUN_STARTED') as
            | (BaseEvent & { input?: { messages?: Message[] } })
            | undefined;
        expect(
            startedEvent?.input?.messages?.filter((known) => known.role === 'user').map((known) => known.id),
        ).toEqual([message.id]);
        expect(events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT').length).toBeGreaterThan(3);
        expect(outcome.turn.running).toBe(false);
        const page = await history(session);
        expect(page.runs).toHaveLength(1);
        expect(page.runs[0]?.status).toBe('finished');
        expect(page.runs[0]?.messages.filter((known) => known.id === message.id)).toHaveLength(1);

        // A second turn carries the stored tail and only its own message.
        const next = say(newId(), 'thanks');
        const second = session.client.body({
            threadId: session.threadId,
            stored: await storedMessages(session),
            message: next,
        });
        expect(second.messages).toEqual([next]);
        expect(await session.client.run(session.dotId, second)).toMatchObject({ kind: 'ended' });
        expect((await history(session)).runs).toHaveLength(2);
    });

    it('a stop ends a slow turn long before its 60 s', { timeout: 60_000 }, async () => {
        const session = await signIn();
        const body = session.client.body({
            threadId: session.threadId,
            stored: [],
            message: say(newId(), 'smoke slow-stream'),
        });
        const began = Date.now();
        let stopped: Promise<unknown> | undefined;
        const outcome = await session.client.run(session.dotId, body, {
            onEvent: (event) => {
                if (event.type === 'TEXT_MESSAGE_CONTENT' && stopped === undefined) {
                    stopped = session.client.stop(session.dotId, session.threadId);
                }
            },
        });
        expect(await stopped).toEqual({ ok: true });
        expect(outcome.kind).toBe('ended');
        expect(Date.now() - began).toBeLessThan(20_000);
        const page = await history(session);
        expect(page.runs).toHaveLength(1);
        expect(page.runs[0]?.status).not.toBe('running');
    });

    it(
        'a POST dropped after RUN_STARTED: the run still finishes, and /stream replays it',
        { timeout: 60_000 },
        async () => {
            const session = await signIn();
            const message = say(newId(), 'smoke stream');
            const body = session.client.body({ threadId: session.threadId, stored: [], message });
            const drop = new AbortController();
            const outcome = await session.client.run(session.dotId, body, {
                signal: drop.signal,
                onEvent: (event) => {
                    if (event.type === 'RUN_STARTED') {
                        drop.abort();
                    }
                },
            });
            expect(outcome).toMatchObject({ kind: 'failed', failure: { action: 'stopped' }, startedRunId: body.runId });

            const frames: SseFrame[] = [];
            const follow = new AbortController();
            const response = await session.request(
                `/api/conversations/${encodeURIComponent(session.threadId)}/stream?after=0`,
                { headers: { accept: 'text/event-stream' }, signal: follow.signal },
            );
            expect(response.status).toBe(200);
            await readSse(
                response,
                (frame) => {
                    frames.push(frame);
                    // The replayed run is delivered whole once its cursor comes.
                    if (frame.kind === 'cursor') {
                        follow.abort();
                    }
                },
                { signal: follow.signal },
            ).catch((error: unknown) => {
                if (!follow.signal.aborted) {
                    throw error;
                }
            });
            const types = frames.flatMap((frame) => (frame.kind === 'event' ? [(frame.event as BaseEvent).type] : []));
            expect(types[0]).toBe('RUN_STARTED');
            expect(types).toContain('TEXT_MESSAGE_CONTENT');
            expect(types.at(-1)).toBe('RUN_FINISHED');
            expect(frames.at(-1)?.kind).toBe('cursor');
            const page = await history(session);
            expect(page.runs).toHaveLength(1);
            expect(page.runs[0]).toMatchObject({ runId: body.runId, status: 'finished' });
        },
    );
});
