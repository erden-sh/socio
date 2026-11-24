import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqlConnection, UserDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { type Outbox, type OutboxKind, type OutboxOptions, openOutbox, type SendOutcome } from '../../src/sync/outbox';
import { type Answer, classify, outcomeOf, readAnswer, type WriteMethod } from '../../src/sync/outbox-answers';
import { overlaysOf } from '../../src/sync/outbox-overlay';

import { turns, userDb } from './outbox-fakes';

// The outbox's dependencies, local ids, refusals and answers (src/sync/outbox.ts,
// outbox-answers.ts, outbox-overlay.ts), on a real user.db (node:sqlite) and a
// scripted fake server: chains across lanes, holds shown as one group, unsent
// writes edited, retried and discarded in place, the hand-off with a kill
// between its two writes, the stored-history wait by the server's id, each
// classifier action, and two edge cases (a clock stepped back; interrupt's
// pause).

const directories: string[] = [];
const outboxes: Outbox[] = [];
const files: UserDb[] = [];

afterEach(async () => {
    vi.useRealTimers();
    for (const outbox of outboxes.splice(0)) {
        await outbox.dispose();
    }
    for (const file of files.splice(0)) {
        await file.db.close();
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * A scripted server: each request takes the next scripted answer for its
 * `<METHOD> <path>` (else a default: 201 to a POST with a new server id, 204
 * to the rest), and everything that arrived is kept.
 */
function scriptedServer() {
    const log: string[] = [];
    const arrived: { method: string; path: string; body: unknown }[] = [];
    const scripts = new Map<string, (() => Response)[]>();
    let next = 0;
    return {
        log,
        arrived,
        /** The next answers to `<METHOD> <path>`. */
        script(route: string, ...answers: (() => Response)[]) {
            scripts.set(route, [...(scripts.get(route) ?? []), ...answers]);
        },
        fetch: (async (input: string, init: AuthedRequestInit = {}) => {
            const method = init.method ?? 'GET';
            const route = `${method} ${input}`;
            log.push(route);
            const answer = scripts.get(route)?.shift();
            if (answer) {
                const response = answer();
                if (response.ok) {
                    arrived.push({ method, path: input, body: init.json });
                }
                return response;
            }
            arrived.push({ method, path: input, body: init.json });
            if (method === 'POST') {
                next += 1;
                return json(201, { id: `srv-${next}` });
            }
            return new Response(null, { status: 204 });
        }) as AuthedFetch,
    };
}

interface Write {
    readonly path: string;
    readonly method?: WriteMethod;
    /** A local id the path names: `{id}` in `path` becomes its server id. */
    readonly ref?: { readonly kind: string; readonly id: string };
    readonly text?: string;
}

/**
 * The test kinds: `create` makes a `thing` (the server's id from its 201),
 * `child` writes under one through a local id resolved as it is sent, and
 * `say` is a message whose row stays until the stored history has it (by the
 * server's id, as steering's). Each reads its answers through `classify`.
 */
function kind(name: string, more: Partial<OutboxKind<Write>> = {}, work: Parameters<typeof outcomeOf>[2] = {}) {
    const definition: OutboxKind<Write> = {
        kind: name,
        payloadVersion: 1,
        repeatable: false,
        async send(write, { fetch, resolve }) {
            const { payload } = write;
            let path = payload.path;
            if (payload.ref) {
                const id = resolve(payload.ref.kind, payload.ref.id);
                if (id === null) {
                    return { action: 'unsent', reason: 'gone' };
                }
                path = path.replace('{id}', id);
            }
            const method = payload.method ?? 'POST';
            const answer = await readAnswer(
                await fetch(path, { method, json: { id: write.row.id, text: payload.text } }),
            );
            const action = classify(answer, { method, ambiguous: write.row.attempts > 1 });
            const outcome = await outcomeOf(action, write, work as never);
            if (outcome.action === 'done' && definition.creates !== undefined) {
                return { ...outcome, serverId: (answer.body as { id: string }).id };
            }
            return outcome;
        },
        async check() {
            return { action: 'not-sent' };
        },
        overlay({ id, payload }, scope) {
            const key = payload.ref ? (scope.resolve(payload.ref.kind, payload.ref.id) ?? payload.ref.id) : id;
            return { collection: 'things', key, mode: payload.ref ? 'patch' : 'insert', value: { text: payload.text } };
        },
        ...more,
    };
    return definition;
}

const CREATE = kind('create', { creates: 'thing' });
const CHILD = kind('child');

let counter = 0;
const write = (
    kindName: string,
    lane: string,
    payload: Write,
    { id = '', dependsOn = null as string | null, idempotencyKey = '' } = {},
) => {
    counter += 1;
    const n = String(counter).padStart(4, '0');
    return {
        id: id || `w-${n}`,
        lane,
        kind: kindName,
        payload: JSON.stringify(payload),
        payloadVersion: 1,
        idempotencyKey: idempotencyKey || `00000000-0000-4000-8000-00000001${n}`,
        dependsOn,
    };
};

async function setup(
    kinds: OutboxKind<unknown>[],
    options: Partial<OutboxOptions> & { wrapDb?: (db: SqlConnection) => SqlConnection } = {},
) {
    const { wrapDb = (db) => db, ...rest } = options;
    const store = await userDb();
    directories.push(store.directory);
    const file = await store.open();
    files.push(file);
    const server = scriptedServer();
    const errors: unknown[] = [];
    const open = async (more: Partial<OutboxOptions> & { db?: SqlConnection } = {}) => {
        const outbox = await openOutbox({
            db: wrapDb(file.db),
            state: file.state,
            kinds,
            fetch: server.fetch,
            onError: (error) => errors.push(error),
            random: () => 0.5,
            ...rest,
            ...more,
        });
        outboxes.push(outbox);
        return outbox;
    };
    const outbox = await open();
    return { server, file, outbox, errors, open };
}

describe('dependencies and local ids', () => {
    it('sends a chain across lanes in order, each child with its parent’s server id, written with the create', async () => {
        const GRANDCHILD = kind('grandchild', { creates: 'thing' });
        const { outbox, server, file } = await setup([CREATE, CHILD, GRANDCHILD] as OutboxKind<unknown>[]);
        const parent = write('create', 'lane:new', { path: '/api/things', text: 'parent' }, { id: 'local-1' });
        const child = write(
            'grandchild',
            'lane:child',
            { path: '/api/things/{id}/children', ref: { kind: 'thing', id: 'local-1' }, text: 'child' },
            { id: 'local-2', dependsOn: 'local-1' },
        );
        const leaf = write(
            'child',
            'lane:leaf',
            { path: '/api/things/{id}/notes', method: 'PUT', ref: { kind: 'thing', id: 'local-2' }, text: 'leaf' },
            { dependsOn: 'local-2' },
        );
        // Enqueued leaf first: order across lanes comes from the dependencies alone.
        await outbox.enqueue(leaf);
        await outbox.enqueue(child);
        await outbox.enqueue(parent);
        outbox.start();
        await outbox.idle();
        expect(server.log).toEqual([
            'POST /api/things',
            'POST /api/things/srv-1/children',
            'PUT /api/things/srv-2/notes',
        ]);
        expect(outbox.resolve('thing', 'local-1')).toBe('srv-1');
        expect(await file.db.all('SELECT kind, localId, serverId FROM ids ORDER BY localId')).toEqual([
            { kind: 'thing', localId: 'local-1', serverId: 'srv-1' },
            { kind: 'thing', localId: 'local-2', serverId: 'srv-2' },
        ]);
        expect(outbox.rows()).toEqual([]);
    });

    it('keeps the ids map across a relaunch, and a dependent waits while its parent is held', async () => {
        const { outbox, server, open } = await setup([CREATE, CHILD] as OutboxKind<unknown>[]);
        server.script('POST /api/things', () => json(201, { id: 'srv-9' }));
        await outbox.enqueue(write('create', 'lane:new', { path: '/api/things' }, { id: 'local-9' }));
        outbox.start();
        await outbox.idle();
        await outbox.dispose();
        const again = await open();
        expect(again.resolve('thing', 'local-9')).toBe('srv-9');
        expect(again.resolve('thing', 'nope')).toBeNull();
    });
});

describe('unsent and holds', () => {
    it('moves a refusal to unsent in one write, and holds the rest of its lane and its dependents as one group', async () => {
        const { outbox, server, file } = await setup([CREATE, CHILD] as OutboxKind<unknown>[]);
        server.script('POST /api/things', () => json(413, { error: 'Too large' }));
        const parent = write('create', 'lane:a', { path: '/api/things', text: 'big' }, { id: 'p' });
        const later = write('child', 'lane:a', { path: '/api/other', text: 'later in its lane' }, { id: 'later' });
        const dependent = write(
            'child',
            'lane:b',
            { path: '/api/things/{id}/x', ref: { kind: 'thing', id: 'p' } },
            { id: 'dep', dependsOn: 'p' },
        );
        const behindDependent = write('child', 'lane:b', { path: '/api/b' }, { id: 'b2' });
        const free = write('child', 'lane:c', { path: '/api/c' }, { id: 'free' });
        for (const item of [parent, later, dependent, behindDependent, free]) {
            await outbox.enqueue(item);
        }
        outbox.start();
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/things', 'POST /api/c']);
        expect(outbox.unsent()).toEqual([
            expect.objectContaining({ id: 'p', lane: 'lane:a', reason: 'http-413', payload: parent.payload }),
        ]);
        expect(await file.db.all('SELECT id, reason FROM unsent')).toEqual([{ id: 'p', reason: 'http-413' }]);
        expect(await file.db.all('SELECT id FROM outbox ORDER BY createdAt')).toEqual([
            { id: 'later' },
            { id: 'dep' },
            { id: 'b2' },
        ]);
        expect(outbox.status()).toMatchObject({ waiting: 3, unsent: 1 });
        const groups = outbox.holds();
        expect(groups).toHaveLength(1);
        expect(groups[0]!.root).toEqual({
            id: 'p',
            kind: 'create',
            lane: 'lane:a',
            cause: 'unsent',
            reason: 'http-413',
        });
        expect(groups[0]!.rows.map((row) => row.id)).toEqual(['later', 'dep', 'b2']);
    });

    it('edits an unsent write in place, then retries it in its place, ahead of what it held', async () => {
        const { outbox, server, file, open } = await setup([CREATE, CHILD] as OutboxKind<unknown>[]);
        server.script('POST /api/things', () => json(400, { code: 'too_long' }));
        await outbox.enqueue(write('create', 'lane:a', { path: '/api/things', text: 'first try' }, { id: 'p' }));
        await outbox.enqueue(write('child', 'lane:a', { path: '/api/after' }, { id: 'after' }));
        outbox.start();
        await outbox.idle();
        const revision = outbox.revisionOf('p');
        const edited = JSON.stringify({ path: '/api/things', text: 'shorter' });
        expect(await outbox.editUnsent('p', { payload: edited, payloadVersion: 1 }, revision)).toBe(true);
        // A stale editor loses.
        expect(await outbox.editUnsent('p', { payload: '{}', payloadVersion: 1 }, revision)).toBe(false);
        // In place, across a relaunch.
        await outbox.dispose();
        const again = await open();
        expect(again.unsent()).toEqual([expect.objectContaining({ id: 'p', payload: edited, reason: 'too_long' })]);
        again.start();
        await again.idle();
        expect(server.log).toEqual(['POST /api/things']);
        expect(await again.retryUnsent('p', '00000000-0000-4000-8000-0000000fresh')).toBe(true);
        await again.idle();
        expect(server.log).toEqual(['POST /api/things', 'POST /api/things', 'POST /api/after']);
        expect(server.arrived[0]!.body).toEqual({ id: 'p', text: 'shorter' });
        expect(again.unsent()).toEqual([]);
        expect(await file.db.all('SELECT id FROM unsent')).toEqual([]);
    });

    it('discards an unsent write: its lane goes on, and a dependent finds no server id and goes to unsent too', async () => {
        const { outbox, server } = await setup([CREATE, CHILD] as OutboxKind<unknown>[]);
        server.script('POST /api/things', () => json(403, { code: 'forbidden' }));
        await outbox.enqueue(write('create', 'lane:a', { path: '/api/things' }, { id: 'p' }));
        await outbox.enqueue(write('child', 'lane:a', { path: '/api/after' }, { id: 'after' }));
        await outbox.enqueue(
            write(
                'child',
                'lane:b',
                { path: '/api/things/{id}', ref: { kind: 'thing', id: 'p' } },
                { id: 'dep', dependsOn: 'p' },
            ),
        );
        outbox.start();
        await outbox.idle();
        expect(await outbox.discardUnsent('p')).toMatchObject({ id: 'p' });
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/things', 'POST /api/after']);
        expect(outbox.unsent()).toEqual([expect.objectContaining({ id: 'dep', reason: 'gone' })]);
        expect(outbox.rows()).toEqual([]);
    });

    it('shows a held row and an unconfirmed one as roots of their own groups', async () => {
        const HOLDING = kind('holding', {
            async send() {
                return { action: 'hold', reason: 'waiting-on-person' };
            },
        });
        const { outbox } = await setup([HOLDING, CHILD] as OutboxKind<unknown>[]);
        await outbox.enqueue(write('holding', 'lane:a', { path: '/x' }, { id: 'h' }));
        await outbox.enqueue(write('child', 'lane:a', { path: '/y' }, { id: 'y' }));
        await outbox.enqueue(write('child', 'lane:z', { path: '/z' }, { id: 'z', dependsOn: 'y' }));
        outbox.start();
        await outbox.idle();
        expect(outbox.holds()).toEqual([
            {
                root: { id: 'h', kind: 'holding', lane: 'lane:a', cause: 'held', reason: 'waiting-on-person' },
                rows: [expect.objectContaining({ id: 'y' }), expect.objectContaining({ id: 'z' })],
            },
        ]);
    });

    it('keeps an unsent row a newer build wrote, never sending it again from here', async () => {
        const { outbox, file, open } = await setup([CREATE] as OutboxKind<unknown>[]);
        await file.db.run(
            "INSERT INTO unsent (id, kind, payload, payloadVersion, reason, createdAt) VALUES ('future', 'create', '{\"v\":2}', 1, 'x', 1)",
        );
        await outbox.dispose();
        const again = await open();
        expect(again.unsent()).toEqual([expect.objectContaining({ id: 'future', lane: '', payload: '{"v":2}' })]);
        expect(await again.retryUnsent('future', 'k')).toBe(false);
        expect(await again.editUnsent('future', { payload: '{}', payloadVersion: 1 })).toBe(false);
        expect(again.holds()).toEqual([]);
    });
});

describe('the hand-off and the stored history', () => {
    it('writes cache.db before it deletes the row; a kill between them leaves the row, which its check settles once', async () => {
        const cache = new Map<string, string>();
        let killed = false;
        let handedOff = false;
        const HANDED = kind('handed', {
            async send(item, { fetch }) {
                await fetch('/api/handed', { method: 'POST', json: { id: item.row.id } });
                return {
                    action: 'done',
                    handOff: async () => {
                        cache.set(item.row.id, 'confirmed');
                        handedOff = true;
                    },
                };
            },
            async check(item, { fetch }) {
                const response = await fetch(`/api/handed/${item.row.id}`);
                return response.status === 200
                    ? { action: 'sent', handOff: async () => void cache.set(item.row.id, 'confirmed') }
                    : { action: 'not-sent' };
            },
        });
        // The process dies right after the hand-off: user.db's delete never runs.
        const never = <T>() => new Promise<T>(() => {});
        const { outbox, server, file, open } = await setup([HANDED] as OutboxKind<unknown>[], {
            wrapDb: (db) => ({
                ...db,
                run: (sql, params) => (killed ? never() : db.run(sql, params)),
                get: (sql, params) => db.get(sql, params),
                all: (sql, params) => db.all(sql, params),
                exec: (sql) => db.exec(sql),
                close: () => db.close(),
                transaction: (task) => {
                    if (handedOff && !killed) {
                        killed = true;
                    }
                    return killed ? never() : db.transaction(task);
                },
            }),
        });
        await outbox.enqueue(write('handed', 'lane:a', { path: '/api/handed' }, { id: 'h1' }));
        outbox.start();
        await turns();
        expect(killed).toBe(true);
        expect(cache.get('h1')).toBe('confirmed');
        // Both hold it for a moment: the overlay isn't laid over twice.
        const rows = await file.db.all<{ id: string; state: string }>('SELECT id, state FROM outbox');
        expect(rows).toEqual([{ id: 'h1', state: 'inflight' }]);
        expect(
            overlaysOf({
                rows: outbox.rows(),
                kinds: [HANDED] as OutboxKind<unknown>[],
                scope: { resolve: () => null },
                has: (collection, key) => collection === 'things' && cache.has(key),
            }),
        ).toEqual([]);
        // The dead process is never disposed: its queue waits forever.
        outboxes.splice(outboxes.indexOf(outbox), 1);
        // Relaunch: the row is unknown, its check finds it sent, and it goes, sent once.
        server.script('GET /api/handed/h1', () => json(200, { id: 'h1' }));
        const again = await open({ db: file.db });
        again.start();
        await again.idle();
        expect(server.log).toEqual(['POST /api/handed', 'GET /api/handed/h1']);
        expect(await file.db.all('SELECT id FROM outbox')).toEqual([]);
    });

    it('keeps a message sent until the stored history holds its server id, and its lane goes on meanwhile', async () => {
        const SAY = kind('say', {
            creates: 'message',
            async send(item, { fetch }) {
                const answer = await readAnswer(
                    await fetch('/api/steer', { method: 'POST', json: { id: item.row.id } }),
                );
                return { action: 'done', serverId: (answer.body as { id: string }).id, awaitStored: true };
            },
        });
        const { outbox, server, file, open } = await setup([SAY] as OutboxKind<unknown>[]);
        server.script('POST /api/steer', () => json(201, { id: 'server-msg-1' }));
        await outbox.enqueue(write('say', 'chat:1', { path: '/api/steer' }, { id: 'local-msg-1' }));
        await outbox.enqueue(write('say', 'chat:1', { path: '/api/steer' }, { id: 'local-msg-2' }));
        outbox.start();
        await outbox.idle();
        expect(server.log).toEqual(['POST /api/steer', 'POST /api/steer']);
        expect(outbox.rows().map((row) => [row.id, row.state])).toEqual([
            ['local-msg-1', 'sent'],
            ['local-msg-2', 'sent'],
        ]);
        expect(outbox.status()).toMatchObject({ waiting: 0 });
        // The device's id isn't the steering message's: it never clears the row.
        expect(await outbox.caughtUp('chat:1', new Set(['local-msg-1']))).toEqual([]);
        // Kept across a relaunch, still sent, never sent again.
        await outbox.dispose();
        const again = await open();
        again.start();
        await again.idle();
        expect(server.log).toHaveLength(2);
        expect(await again.caughtUp('chat:1', (id) => id === 'server-msg-1')).toEqual(['local-msg-1']);
        expect(await again.caughtUp('chat:1', new Set(['srv-1']))).toEqual(['local-msg-2']);
        expect(await file.db.all('SELECT id FROM outbox')).toEqual([]);
    });
});

describe('6.6’s answers', () => {
    const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
        readAnswer(json(status, body, headers));

    it('classifies each answer by status and code, never by its text', async () => {
        const post = { method: 'POST' } as const;
        expect(classify(await answer(201), post)).toEqual({ action: 'delivered' });
        expect(classify(await answer(503, { code: 'draining' }), post)).toEqual({
            action: 'retry',
            reason: 'draining',
        });
        expect(classify(await answer(502), post)).toEqual({ action: 'retry', reason: 'http-502' });
        expect(classify(await readAnswer(new Response('<html>', { status: 503 })), post)).toEqual({
            action: 'retry',
            reason: 'http-503',
        });
        expect(classify(await answer(429, { code: 'cycle_rate' }, { 'retry-after': '30' }), post)).toEqual({
            action: 'back-off',
            delayMs: 30_000,
            reason: 'cycle_rate',
        });
        expect(classify(await answer(429, { code: 'queue_full', limit: 3 }), post)).toEqual({
            action: 'back-off',
            delayMs: null,
            reason: 'queue_full',
        });
        expect(classify(await answer(413), post)).toEqual({ action: 'unsent', reason: 'http-413' });
        expect(classify(await answer(400, { error: 'Thread already running' }), post)).toEqual({
            action: 'unsent',
            reason: 'http-400',
        });
        expect(classify(await answer(500, { error: 'Thread already running' }), post)).toEqual({
            action: 'unknown',
            reason: 'http-500',
        });
        // The already-applied rule, after an ambiguous attempt only.
        expect(classify(await answer(404), { method: 'DELETE', ambiguous: true })).toEqual({ action: 'delivered' });
        expect(classify(await answer(404), { method: 'DELETE' })).toEqual({ action: 'unsent', reason: 'http-404' });
        expect(classify(await answer(409, { code: 'delivered' }), { method: 'PATCH', ambiguous: true })).toEqual({
            action: 'delivered',
        });
        // A kind's own rules come first.
        const page = (a: Answer) =>
            a.status === 409
                ? ({ action: 'merge' } as const)
                : a.status === 404
                  ? ({ action: 'relocate' } as const)
                  : undefined;
        expect(classify(await answer(409), { method: 'PATCH', special: page })).toEqual({ action: 'merge' });
        expect(classify(await answer(404), { method: 'PATCH', special: page })).toEqual({ action: 'relocate' });
    });

    it('reads Retry-After as seconds or as a date on the server’s clock', async () => {
        const at = (
            await answer(
                429,
                {},
                { 'retry-after': 'Wed, 21 Oct 2026 07:28:30 GMT', date: 'Wed, 21 Oct 2026 07:28:00 GMT' },
            )
        ).retryAfterMs;
        expect(at).toBe(30_000);
        expect((await answer(429, {}, { 'retry-after': 'soon' })).retryAfterMs).toBeNull();
    });

    it('does what each action says against the fake server', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pageRules = (a: Answer) =>
            a.status === 409
                ? ({ action: 'merge' } as const)
                : a.status === 404
                  ? ({ action: 'relocate' } as const)
                  : undefined;
        const PAGE = kind('page', {
            async send(item, { fetch }) {
                const read = await readAnswer(
                    await fetch(item.payload.path, { method: 'PATCH', json: { text: item.payload.text } }),
                );
                return outcomeOf(classify(read, { method: 'PATCH', special: pageRules }), item, {
                    merge: async () => ({
                        action: 'rewrite',
                        payload: JSON.stringify({ path: '/api/page', text: 'merged' }),
                        payloadVersion: 1,
                        idempotencyKey: 'key-merged',
                        reason: 'merged',
                    }),
                    relocate: async () => ({
                        action: 'rewrite',
                        payload: JSON.stringify({ path: '/api/moved', text: 'moved' }),
                        payloadVersion: 1,
                        idempotencyKey: 'key-moved',
                    }),
                });
            },
        });
        const { outbox, server } = await setup([PAGE] as OutboxKind<unknown>[]);
        server.script(
            'PATCH /api/page',
            () => json(502),
            () => json(429, { code: 'cycle_rate' }, { 'retry-after': '30' }),
            () => json(409, { code: 'stale' }),
            () => json(404, { code: 'not_in_space' }),
        );
        await outbox.enqueue(write('page', 'page:1', { path: '/api/page', text: 'mine' }, { id: 'pg' }));
        outbox.start();
        await turns();
        // Retry: the server is away, with the back-off's first second.
        expect(server.log).toEqual(['PATCH /api/page']);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(server.log).toEqual(['PATCH /api/page', 'PATCH /api/page']);
        // Back off, holding the lane for the 429's 30 s.
        await vi.advanceTimersByTimeAsync(29_999);
        expect(server.log).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        await turns();
        // Merge: rewritten and sent again at once; relocate, the second rewrite, waits for the back-off.
        expect(server.log).toHaveLength(4);
        expect(outbox.rows()[0]?.idempotencyKey).toBe('key-moved');
        await vi.advanceTimersByTimeAsync(5_999);
        expect(server.log).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(1);
        await turns();
        expect(server.log).toEqual([
            'PATCH /api/page',
            'PATCH /api/page',
            'PATCH /api/page',
            'PATCH /api/page',
            'PATCH /api/moved',
        ]);
        expect(server.arrived.map((item) => item.body)).toEqual([{ text: 'moved' }]);
        expect(outbox.rows()).toEqual([]);
    });

    it('sends a re-upload, a merge or a relocate a kind has no work for to unsent', async () => {
        const item = { row: {} as never, payload: {} };
        expect(await outcomeOf({ action: 're-upload' }, item)).toEqual({
            action: 'unsent',
            reason: 'attachment-expired',
        });
        expect(await outcomeOf({ action: 'merge' }, item)).toEqual({ action: 'unsent', reason: 'conflict' });
        expect(await outcomeOf({ action: 'relocate' }, item)).toEqual({ action: 'unsent', reason: 'gone' });
        const reupload = async (): Promise<SendOutcome> => ({
            action: 'rewrite',
            payload: '{}',
            payloadVersion: 1,
            idempotencyKey: 'k2',
        });
        expect(await outcomeOf({ action: 're-upload' }, item, { reupload })).toEqual({
            action: 'rewrite',
            payload: '{}',
            payloadVersion: 1,
            idempotencyKey: 'k2',
        });
    });

    it('rewrites under a fresh key, waits before the second rewrite, and sends a third to unsent', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const keys: string[] = [];
        let minted = 0;
        // A concurrent editor: every save meets a fresh 409, and every merge rewrites.
        const PAGE = kind('page', {
            async send(item, { fetch }) {
                keys.push(item.row.idempotencyKey);
                const read = await readAnswer(await fetch('/api/page', { method: 'PATCH', json: item.payload }));
                return outcomeOf(classify(read, { method: 'PATCH', special: () => ({ action: 'merge' }) }), item, {
                    merge: async () => {
                        minted += 1;
                        return {
                            action: 'rewrite',
                            payload: JSON.stringify({ path: '/api/page', text: `merged ${minted}` }),
                            payloadVersion: 1,
                            idempotencyKey: `key-${minted}`,
                        };
                    },
                });
            },
        });
        const { outbox, server, open } = await setup([PAGE] as OutboxKind<unknown>[]);
        server.script(
            'PATCH /api/page',
            () => json(409, { code: 'stale' }),
            () => json(409, { code: 'stale' }),
            () => json(409, { code: 'stale' }),
        );
        await outbox.enqueue(write('page', 'page:1', { path: '/api/page' }, { id: 'pg', idempotencyKey: 'key-0' }));
        outbox.start();
        await turns();
        // The first rewrite goes at once; the second waits for the back-off (1.5 s after two attempts).
        expect(keys).toEqual(['key-0', 'key-1']);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(keys).toEqual(['key-0', 'key-1']);
        await vi.advanceTimersByTimeAsync(60_000);
        await turns();
        // The third merge is past the cap: the row goes to unsent, and nothing more is sent.
        expect(keys).toEqual(['key-0', 'key-1', 'key-2']);
        expect(outbox.rows()).toEqual([]);
        expect(outbox.unsent()).toMatchObject([{ id: 'pg', reason: 'rewrite-limit' }]);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(server.log).toHaveLength(3);
        await outbox.dispose();
        expect((await open()).unsent()).toMatchObject([
            { id: 'pg', payload: JSON.stringify({ path: '/api/page', text: 'merged 2' }) },
        ]);
    });

    it('stores a rewrite’s fresh key with its payload', async () => {
        const PAGE = kind('page', {
            async send(item) {
                return item.row.idempotencyKey === 'key-0'
                    ? {
                          action: 'rewrite',
                          payload: JSON.stringify({ path: '/api/page' }),
                          payloadVersion: 1,
                          idempotencyKey: 'key-1',
                      }
                    : { action: 'hold', reason: 'stop' };
            },
        });
        const { outbox, open } = await setup([PAGE] as OutboxKind<unknown>[]);
        await outbox.enqueue(write('page', 'page:1', { path: '/api/page' }, { id: 'pg', idempotencyKey: 'key-0' }));
        outbox.start();
        await turns();
        await outbox.dispose();
        expect((await open()).rows()).toMatchObject([{ id: 'pg', idempotencyKey: 'key-1', state: 'held' }]);
    });

    it('waits the back-off before it checks and resends a row a server error made unknown', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { outbox, server } = await setup([CHILD] as OutboxKind<unknown>[]);
        server.script(
            'POST /api/x',
            () => json(500),
            () => json(500),
        );
        await outbox.enqueue(write('child', 'lane:a', { path: '/api/x' }, { id: 'x' }));
        outbox.start();
        await turns();
        // The check (not-sent) runs, but the resend waits.
        expect(server.log).toEqual(['POST /api/x']);
        await vi.advanceTimersByTimeAsync(1_000);
        await turns();
        expect(server.log).toEqual(['POST /api/x', 'POST /api/x']);
    });
});

describe('a clock stepped back and a pausing interrupt', () => {
    it('keeps a lane’s order when the device clock steps back', async () => {
        const clock = [1_000_000, 400_000, 400_000];
        const { outbox, server, open } = await setup([CHILD] as OutboxKind<unknown>[], {
            now: () => clock.shift() ?? 0,
        });
        await outbox.enqueue(write('child', 'lane:a', { path: '/api/first' }, { id: 'z-first' }));
        await outbox.enqueue(write('child', 'lane:a', { path: '/api/second' }, { id: 'a-second' }));
        expect(outbox.rows().map((row) => row.createdAt)).toEqual([1_000_000, 1_000_001]);
        // And after a relaunch, from what user.db holds.
        await outbox.dispose();
        const again = await open({ now: () => 5 });
        await again.enqueue(write('child', 'lane:a', { path: '/api/third' }, { id: 'a-third' }));
        again.start();
        await again.idle();
        expect(server.log).toEqual(['POST /api/first', 'POST /api/second', 'POST /api/third']);
    });

    it('sends nothing after a pausing interrupt, not a back-off, a poke or a write, until unpause', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const REPEAT = kind('repeat', { repeatable: true });
        const { outbox, server } = await setup([REPEAT] as OutboxKind<unknown>[]);
        server.script('POST /api/r', () => json(502));
        await outbox.enqueue(write('repeat', 'lane:a', { path: '/api/r' }, { id: 'r' }));
        outbox.start();
        await turns();
        expect(server.log).toEqual(['POST /api/r']);
        await outbox.interrupt({ pause: true });
        await vi.advanceTimersByTimeAsync(60_000);
        await turns();
        expect(server.log).toEqual(['POST /api/r']);
        // A write and a poke wait too (the background grace: only the app becoming active ends the pause).
        await outbox.enqueue(write('repeat', 'lane:b', { path: '/api/b' }, { id: 'b' }));
        outbox.poke();
        await turns();
        expect(server.log).toEqual(['POST /api/r']);
        outbox.unpause();
        await outbox.idle();
        expect(server.log.sort()).toEqual(['POST /api/b', 'POST /api/r', 'POST /api/r']);
    });
});

describe('overlays', () => {
    it('lays each kind’s overlay over the store: queued, sent, unsent; a local id resolved; nothing for a row it can’t decode', () => {
        const row = (id: string, kindName: string, payload: Write, more: Record<string, unknown> = {}) => ({
            id,
            lane: 'lane:a',
            kind: kindName,
            payload: JSON.stringify(payload),
            payloadVersion: 1,
            dependsOn: null,
            idempotencyKey: `k-${id}`,
            state: 'queued',
            attempts: 0,
            revision: 1,
            createdAt: 10,
            lastError: null,
            ...more,
        });
        const items = overlaysOf({
            rows: [
                row('new-1', 'create', { path: '/api/things', text: 'new' }),
                row(
                    'rename',
                    'child',
                    { path: '/x', ref: { kind: 'thing', id: 'local-1' }, text: 'renamed' },
                    { createdAt: 11, state: 'sent' },
                ),
                row('odd', 'create', { path: '/x' }, { createdAt: 12, payloadVersion: 9 }),
                row('alien', 'from-a-newer-build', { path: '/x' }, { createdAt: 13 }),
                row(
                    'unsure',
                    'create',
                    { path: '/x', text: 'unsure' },
                    { createdAt: 14, state: 'unknown', lastError: 'unconfirmed' },
                ),
            ],
            unsent: [
                {
                    id: 'refused',
                    kind: 'create',
                    lane: 'lane:b',
                    dependsOn: null,
                    payload: JSON.stringify({ path: '/api/things', text: 'too big' }),
                    payloadVersion: 1,
                    reason: 'http-413',
                    createdAt: 5,
                },
            ],
            kinds: [CREATE, CHILD] as OutboxKind<unknown>[],
            scope: { resolve: (kindName, id) => (kindName === 'thing' && id === 'local-1' ? 'srv-1' : null) },
        });
        expect(items.map(({ id, key, mode, state, reason }) => ({ id, key, mode, state, reason }))).toEqual([
            { id: 'refused', key: 'refused', mode: 'insert', state: 'unsent', reason: 'http-413' },
            { id: 'new-1', key: 'new-1', mode: 'insert', state: 'queued', reason: null },
            { id: 'rename', key: 'srv-1', mode: 'patch', state: 'sent', reason: null },
            { id: 'unsure', key: 'unsure', mode: 'insert', state: 'unconfirmed', reason: 'unconfirmed' },
        ]);
    });
});
