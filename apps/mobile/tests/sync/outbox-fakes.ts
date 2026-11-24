import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openUserDb, type SqlConnection, type SqlStatements, type UserDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { AbortedError, NetworkError } from '../../src/net/errors';
import type { Outbox, OutboxKind, SendOutcome } from '../../src/sync/outbox';
import { createNodeSqliteDriver, type NodeSqliteDriver } from '../helpers/node-sqlite-driver';

// Fakes for the outbox's tests (outbox.test.ts, outbox-scope.test.ts): a
// server that takes test messages and says whether it has one, the write kinds
// that send them, user.db on node:sqlite, and a "kill": every step after a
// chosen one never runs, as when the app dies there.

export const USER_KEY = '1e'.repeat(32);

/** A user.db on node:sqlite in a new temporary directory, and a way to open it again (a relaunch). */
export async function userDb(): Promise<{ driver: NodeSqliteDriver; directory: string; open: () => Promise<UserDb> }> {
    const driver = createNodeSqliteDriver({ keys: new Map() });
    const directory = mkdtempSync(join(tmpdir(), 'socio-outbox-'));
    return { driver, directory, open: () => openUserDb(driver, directory, USER_KEY) };
}

export interface FakeMessageServer {
    /** How many times each message id arrived. */
    readonly received: Map<string, number>;
    /** Every request, as `<METHOD> <path>`. */
    readonly log: string[];
    /** The next answers to POSTs, by status (default 201). */
    readonly answers: number[];
    /** POSTs from now on arrive and then never answer, until aborted. */
    hang(on: boolean): void;
    /** POSTs from now on never arrive (offline): a NetworkError. */
    offline(on: boolean): void;
    /** POSTs from now on wait before they arrive, until aborted: they never reach the server. */
    stall(on: boolean): void;
    handle(path: string, init: AuthedRequestInit): Promise<Response>;
}

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A server for `POST /api/test/messages {id, text}` and `GET /api/test/messages/:id` (has it arrived?). */
export function fakeMessageServer(): FakeMessageServer {
    const received = new Map<string, number>();
    const log: string[] = [];
    const answers: number[] = [];
    let hanging = false;
    let away = false;
    let stalling = false;
    const aborted = (signal: AbortSignal | undefined) =>
        new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new AbortedError('', signal.reason)), { once: true });
        });
    return {
        received,
        log,
        answers,
        hang(on) {
            hanging = on;
        },
        offline(on) {
            away = on;
        },
        stall(on) {
            stalling = on;
        },
        async handle(path, init) {
            const method = init.method ?? 'GET';
            log.push(`${method} ${path}`);
            if (init.signal?.aborted) {
                throw new AbortedError(path, init.signal.reason);
            }
            if (away) {
                throw new NetworkError(path);
            }
            if (method === 'POST') {
                if (stalling) {
                    return aborted(init.signal ?? undefined);
                }
                const status = answers.shift() ?? 201;
                if (status === 201) {
                    const { id } = init.json as { id: string };
                    received.set(id, (received.get(id) ?? 0) + 1);
                }
                if (hanging) {
                    return aborted(init.signal ?? undefined);
                }
                return json(status);
            }
            const id = decodeURIComponent(path.split('/').pop() ?? '');
            return received.has(id) ? json(200, { id }) : json(404);
        },
    };
}

/** An AuthedFetch straight to the fake server (no jar: the outbox's tests don't need one). */
export const fetchTo =
    (server: FakeMessageServer): AuthedFetch =>
    (input, init = {}) =>
        server.handle(input, init);

export interface TestMessage {
    readonly text: string;
}

/** How a test kind reads the server's answers to a send. */
function classify(response: Response): SendOutcome {
    if (response.ok) {
        return { action: 'done' };
    }
    if (response.status === 503) {
        return { action: 'retry', reason: '503' };
    }
    if (response.status === 429) {
        return { action: 'retry', delayMs: 30_000, reason: 'cycle_rate' };
    }
    return { action: 'hold', reason: String(response.status) };
}

/** Not safe to repeat: an ambiguous attempt is checked against the server. */
export const MESSAGE: OutboxKind<TestMessage> = {
    kind: 'test-message',
    payloadVersion: 1,
    repeatable: false,
    decode(payload) {
        const value = JSON.parse(payload) as Partial<TestMessage>;
        if (typeof value.text !== 'string') {
            throw new TypeError('No text.');
        }
        return { text: value.text };
    },
    async send({ row, payload }, { fetch }) {
        return classify(
            await fetch('/api/test/messages', { method: 'POST', json: { id: row.id, text: payload.text } }),
        );
    },
    async check({ row }, { fetch }) {
        const response = await fetch(`/api/test/messages/${encodeURIComponent(row.id)}`);
        return response.status === 200 ? { action: 'sent' } : { action: 'not-sent' };
    },
};

/** The same, with no check: an ambiguous attempt waits for the person. */
export const UNCHECKED: OutboxKind<TestMessage> = { ...MESSAGE, kind: 'test-unchecked', check: undefined };

/** Safe to repeat: an ambiguous attempt goes again. */
export const REPEATABLE: OutboxKind<TestMessage> = {
    ...MESSAGE,
    kind: 'test-repeatable',
    repeatable: true,
    check: undefined,
};

let counter = 0;
/** A new test message's write. */
export function message(text: string, { lane = 'chat:1', kind = MESSAGE.kind, id = '' } = {}) {
    counter += 1;
    const n = String(counter).padStart(4, '0');
    return {
        id: id || `m-${n}`,
        lane,
        kind,
        payload: JSON.stringify({ text }),
        payloadVersion: 1,
        idempotencyKey: `00000000-0000-4000-8000-00000000${n}`,
    };
}

/** Waits for `count` turns of the event loop: enough for every promise that can settle to settle. */
export async function turns(count = 20): Promise<void> {
    for (let turn = 0; turn < count; turn += 1) {
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
    }
}

const never = <T>() => new Promise<T>(() => {});

/**
 * A kill at a step: steps are user.db's writes and each request's two halves
 * (going to the server, its answer coming back). Once step `at` is reached it
 * never runs, and nothing after it does either: every later statement or
 * request waits forever, as in a process that died. `steps` counts the steps
 * reached; `killed` says whether the kill came.
 */
export interface Kill {
    readonly db: (db: SqlConnection) => SqlConnection;
    readonly fetch: (fetch: AuthedFetch) => AuthedFetch;
    readonly steps: string[];
    readonly killed: boolean;
}

export function killAt(at: number): Kill {
    const steps: string[] = [];
    let killed = false;
    /** Whether step `name` may run. */
    const step = (name: string) => {
        if (killed) {
            return false;
        }
        if (steps.length === at) {
            killed = true;
            return false;
        }
        steps.push(name);
        return true;
    };
    const statements = (db: SqlStatements): SqlStatements => ({
        exec: (sql) => (killed ? never() : db.exec(sql)),
        run: (sql, params) => (step(`run ${sql.split(' ').slice(0, 2).join(' ')}`) ? db.run(sql, params) : never()),
        get: (sql, params) => (killed ? never() : db.get(sql, params)),
        all: (sql, params) => (killed ? never() : db.all(sql, params)),
    });
    return {
        steps,
        get killed() {
            return killed;
        },
        db: (db) => ({
            ...statements(db),
            // A transaction is one step: a process that dies inside one leaves nothing of it.
            transaction: (task) => (step('transaction') ? db.transaction(task) : never()),
            close: () => db.close(),
        }),
        fetch: (fetch) => async (input, init) => {
            if (!step(`send ${init?.method ?? 'GET'} ${input}`)) {
                return never();
            }
            const response = await fetch(input, init);
            return step(`answer ${init?.method ?? 'GET'} ${input}`) ? response : never();
        },
    };
}

/**
 * Resolves once `check` holds, tested now and on each of the outbox's row,
 * status and Unsent changes, then (unless `idle: false`) once nothing is in
 * flight or queued. The exact event, never a real-time poll with a deadline
 * (`vi.waitFor`'s 1 s), which a loaded machine can miss: only the test's own
 * timeout ends a wait that never comes.
 */
export async function outboxUntil(
    outbox: Outbox,
    check: () => boolean,
    { idle = true }: { readonly idle?: boolean } = {},
): Promise<void> {
    await new Promise<void>((resolve) => {
        const stops: (() => void)[] = [];
        const test = () => {
            if (check()) {
                for (const stop of stops.splice(0)) {
                    stop();
                }
                resolve();
            }
        };
        stops.push(outbox.subscribe(test), outbox.onStatus(test), outbox.onUnsent(test));
        test();
    });
    if (idle) {
        await outbox.idle();
    }
}
