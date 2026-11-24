import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { type SqlConnection, UPDATE_TO_SEND, type UserDb, type UserDbState } from '../../src/data';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import {
    afterSend,
    chatDraft,
    DraftError,
    type Drafts,
    DRAFTS_KEPT,
    newChatDraft,
    openDrafts,
    reviewDraft,
    SENDS_KEPT,
} from '../../src/sync/chat-drafts';
import { type Outbox, OutboxError, type OutboxKind, openOutbox } from '../../src/sync/outbox';

import {
    fakeMessageServer,
    type FakeMessageServer,
    fetchTo,
    killAt,
    MESSAGE,
    message,
    turns,
    userDb,
} from './outbox-fakes';

// The composers' drafts (src/sync/chat-drafts.ts) on a
// real user.db (node:sqlite): the web's cases (packages/client/tests/
// chat-drafts.test.ts) where they apply on a phone, the bound and
// `payloadVersion`, and `enqueueFromDraft`: the draft cleared and the outbox
// row inserted in one transaction, with a kill between every two steps (the
// text never lost once stored, and never in both places).

const directories: string[] = [];
const files: UserDb[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const close of closers.splice(0).reverse()) {
        await close();
    }
    for (const file of files.splice(0)) {
        await file.db.close();
    }
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

interface Setup {
    readonly file: UserDb;
    readonly server: FakeMessageServer;
    readonly outbox: Outbox;
    readonly drafts: Drafts;
    readonly errors: unknown[];
    /** A relaunch: the drafts and outbox closed, then opened again on a new connection. */
    readonly reopen: () => Promise<{ drafts: Drafts; outbox: Outbox; file: UserDb }>;
    readonly onDisk: () => Promise<{ scope: string; text: string; payloadVersion: number; sending: string | null }[]>;
}

async function setup(
    options: { state?: UserDbState; wrapFetch?: (fetch: AuthedFetch) => AuthedFetch; clock?: () => number } = {},
): Promise<Setup> {
    const store = await userDb();
    directories.push(store.directory);
    const server = fakeMessageServer();
    const errors: unknown[] = [];
    const make = async () => {
        const file = await store.open();
        files.push(file);
        const state = options.state ?? file.state;
        const outbox = await openOutbox({
            db: file.db,
            state,
            kinds: [MESSAGE] as OutboxKind<unknown>[],
            fetch: (options.wrapFetch ?? ((fetch) => fetch))(fetchTo(server)),
            random: () => 0.5,
        });
        const drafts = await openDrafts({
            db: file.db,
            state,
            outbox,
            onError: (error) => errors.push(error),
            ...(options.clock ? { now: options.clock } : {}),
        });
        closers.push(
            () => outbox.dispose(),
            () => drafts.close(),
        );
        return { file, outbox, drafts };
    };
    const first = await make();
    return {
        ...first,
        server,
        errors,
        async reopen() {
            await first.drafts.close();
            await first.outbox.dispose();
            return make();
        },
        onDisk: () => first.file.db.all('SELECT scope, text, payloadVersion, sending FROM drafts ORDER BY scope'),
    };
}

/** A send's write for the box's text. */
const sendAs =
    (id: string, lane = 'chat:c1') =>
    (text: string) =>
        message(text, { id, lane });

describe('the web’s rules', () => {
    it('keeps one draft per chat, per socio’s new chat and per page review, across a relaunch', async () => {
        const { drafts, reopen, onDisk } = await setup();
        drafts.write(chatDraft('c1'), 'one');
        drafts.write(newChatDraft('d1'), 'two');
        drafts.write(reviewDraft('t1', 'call-1'), '{"title":"Edited"}');
        expect(drafts.read(chatDraft('c1')).text).toBe('one');
        await drafts.flush();
        expect((await onDisk()).map((row) => [row.scope, row.text, row.payloadVersion])).toEqual([
            ['chat:c1', 'one', 1],
            ['new:d1', 'two', 1],
            ['review:t1:call-1', '{"title":"Edited"}', 1],
        ]);
        // Empty text deletes it.
        drafts.write(newChatDraft('d1'), '');
        const next = await reopen();
        expect(next.drafts.read(chatDraft('c1')).text).toBe('one');
        expect(next.drafts.read(newChatDraft('d1'))).toEqual({ text: '', at: 0 });
        expect(next.drafts.read(reviewDraft('t1', 'call-1')).text).toBe('{"title":"Edited"}');
    });

    it('shows each change at once and writes them in order, coalesced', async () => {
        const { drafts, onDisk } = await setup();
        const told: string[] = [];
        drafts.subscribe((scope) => told.push(scope));
        for (const text of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
            drafts.write(chatDraft('c1'), text);
        }
        expect(drafts.read(chatDraft('c1')).text).toBe('Hello');
        expect(told).toHaveLength(5);
        await drafts.flush();
        expect((await onDisk()).map((row) => row.text)).toEqual(['Hello']);
    });

    it('remembers a send until it settles, and gives its text back after what the box holds', async () => {
        const { drafts, reopen } = await setup();
        const scope = chatDraft('c1');
        drafts.markSending(scope, 'm1', 'Hello');
        expect(drafts.read(scope)).toMatchObject({ text: '', sending: [{ id: 'm1', text: 'Hello' }] });
        drafts.settleSending(scope, 'm0', true);
        expect(drafts.read(scope).sending).toEqual([{ id: 'm1', text: 'Hello' }]);
        await drafts.flush();
        const next = (await reopen()).drafts;
        expect(next.read(scope).sending).toEqual([{ id: 'm1', text: 'Hello' }]);
        next.settleSending(scope, 'm1', true);
        expect(next.read(scope)).toEqual({ text: 'Hello', at: expect.any(Number) });
        next.write(scope, '');
        next.markSending(scope, 'm2', 'Again');
        next.write(scope, 'Typed since');
        // Never instead of it (CB-154): after it.
        next.settleSending(scope, 'm2', true);
        expect(next.read(scope).text).toBe('Typed since\n\nAgain');
    });

    it(`keeps up to ${SENDS_KEPT} sends at once; an older one's text goes back in the box (CB-154)`, async () => {
        const { drafts } = await setup();
        const scope = chatDraft('c1');
        drafts.markSending(scope, 'a', 'First');
        drafts.markSending(scope, 'b', 'Second');
        drafts.write(scope, 'Typing');
        // A retry keeps what the box holds.
        drafts.markSending(scope, 'a', 'First', true);
        expect(drafts.read(scope)).toMatchObject({
            text: 'Typing',
            sending: [
                { id: 'b', text: 'Second' },
                { id: 'a', text: 'First' },
            ],
        });
        drafts.write(scope, '');
        for (let i = 0; i < SENDS_KEPT - 1; i += 1) {
            drafts.markSending(scope, `n${i}`, `More ${i}`);
        }
        expect(drafts.read(scope).sending).toHaveLength(SENDS_KEPT);
        expect(drafts.read(scope).text).toBe('Second');
    });

    it(`keeps the newest ${DRAFTS_KEPT} drafts`, async () => {
        let time = 1000;
        const { drafts, onDisk } = await setup({ clock: () => time });
        for (let i = 0; i <= DRAFTS_KEPT; i += 1) {
            time += 1;
            drafts.write(chatDraft(`c${i}`), `draft ${i}`);
        }
        await drafts.flush();
        const rows = await onDisk();
        expect(rows).toHaveLength(DRAFTS_KEPT);
        expect(rows.some((row) => row.scope === 'chat:c0')).toBe(false);
        expect(drafts.read(chatDraft('c0')).text).toBe('');
        expect(drafts.read(chatDraft(`c${DRAFTS_KEPT}`)).text).toBe(`draft ${DRAFTS_KEPT}`);
    });
});

describe('payloadVersion and a read-only user.db', () => {
    it('shows a newer build’s draft and never changes, sends or drops it', async () => {
        const { file, reopen, onDisk } = await setup();
        await file.db.run(
            "INSERT INTO drafts (scope, text, payloadVersion, updatedAt, sending) VALUES ('chat:new', 'From later', 2, 1, '{')",
        );
        const { drafts, outbox } = await reopen();
        expect(drafts.read('chat:new')).toMatchObject({ text: 'From later', locked: true });
        expect(() => drafts.write('chat:new', 'Mine')).toThrow(new DraftError(UPDATE_TO_SEND));
        await expect(drafts.enqueueFromDraft('chat:new', sendAs('m-new'))).rejects.toThrow(DraftError);
        // The bound passes over it, though it is the oldest.
        for (let i = 0; i < DRAFTS_KEPT; i += 1) {
            drafts.write(chatDraft(`c${i}`), `draft ${i}`);
        }
        await drafts.flush();
        const rows = await onDisk();
        expect(rows.find((row) => row.scope === 'chat:new')).toMatchObject({
            text: 'From later',
            payloadVersion: 2,
            sending: '{',
        });
        expect(rows).toHaveLength(DRAFTS_KEPT);
        expect(outbox.rows()).toEqual([]);
    });

    it('drops a `sending` it can’t read, as the web does, and never locks a draft of its own version', async () => {
        const { file, reopen, onDisk } = await setup();
        await file.db.run(
            `INSERT INTO drafts (scope, text, payloadVersion, updatedAt, sending) VALUES
             ('chat:bad', 'Odd', 1, 1, '{'),
             ('chat:mixed', 'Some', 1, 1, '[{"id":"w-1","text":"Kept"},{"id":3},null]'),
             ('chat:one', '', 1, 1, '{"id":"w-2","text":"First version"}')`,
        );
        const { drafts, outbox } = await reopen();
        expect(drafts.read('chat:bad')).toEqual({ text: 'Odd', at: 1 });
        expect(drafts.read('chat:mixed')).toEqual({ text: 'Some', at: 1, sending: [{ id: 'w-1', text: 'Kept' }] });
        expect(drafts.read('chat:one')).toEqual({ text: '', at: 1, sending: [{ id: 'w-2', text: 'First version' }] });
        drafts.write('chat:bad', 'Odd, edited');
        expect(await drafts.enqueueFromDraft('chat:bad', sendAs('m-bad'))).toMatchObject({ id: 'm-bad' });
        expect(outbox.rows().map((row) => row.id)).toEqual(['m-bad']);
        await drafts.flush();
        expect((await onDisk()).map((row) => row.scope)).toEqual(['chat:mixed', 'chat:one']);
    });

    it('keeps changes in memory only while user.db is read-only, and sends nothing', async () => {
        const { drafts, outbox, onDisk } = await setup({
            state: { writable: false, reason: 'newer', version: 2, message: UPDATE_TO_SEND },
        });
        drafts.write(chatDraft('c1'), 'Hello');
        await drafts.flush();
        expect(drafts.read(chatDraft('c1')).text).toBe('Hello');
        expect(await onDisk()).toEqual([]);
        await expect(drafts.enqueueFromDraft(chatDraft('c1'), sendAs('m-ro'))).rejects.toThrow(OutboxError);
        expect(drafts.read(chatDraft('c1')).text).toBe('Hello');
        expect(outbox.rows()).toEqual([]);
    });
});

describe('enqueueFromDraft', () => {
    it('clears the draft and inserts the row in one transaction, before any request', async () => {
        const order: string[] = [];
        const { drafts, outbox, server, onDisk, file } = await setup({
            wrapFetch: (fetch) => (input, init) => {
                order.push('fetch');
                return fetch(input, init);
            },
        });
        const scope = chatDraft('c1');
        drafts.write(scope, 'Hello');
        drafts.subscribe(() => order.push(`box: "${drafts.read(scope).text}"`));
        outbox.start();
        const row = await drafts.enqueueFromDraft(scope, sendAs('m-1'));
        order.push('committed');
        expect(row).toMatchObject({ id: 'm-1', payload: JSON.stringify({ text: 'Hello' }) });
        // The box cleared after the commit, and nothing went before it.
        expect(order.slice(0, 2)).toEqual(['box: ""', 'committed']);
        expect(drafts.read(scope)).toEqual({ text: '', at: 0 });
        expect(await onDisk()).toEqual([]);
        await outbox.idle();
        await turns();
        expect(order).toContain('fetch');
        expect(server.received.get('m-1')).toBe(1);
        expect(await file.db.all('SELECT id FROM outbox')).toEqual([]);
    });

    it('sends nothing for a blank box', async () => {
        const { drafts, outbox } = await setup();
        drafts.write(chatDraft('c1'), '  \n');
        expect(await drafts.enqueueFromDraft(chatDraft('c1'), sendAs('m-blank'))).toBeNull();
        expect(await drafts.enqueueFromDraft(chatDraft('c2'), sendAs('m-none'))).toBeNull();
        expect(outbox.rows()).toEqual([]);
        expect(drafts.read(chatDraft('c1')).text).toBe('  \n');
    });

    it('leaves the box as it was when the insert fails', async () => {
        const { drafts, outbox, onDisk } = await setup();
        await outbox.enqueue(message('first', { id: 'm-dup' }));
        drafts.write(chatDraft('c1'), 'Hello');
        await expect(drafts.enqueueFromDraft(chatDraft('c1'), sendAs('m-dup'))).rejects.toThrow(OutboxError);
        expect(drafts.read(chatDraft('c1')).text).toBe('Hello');
        expect((await onDisk()).map((row) => row.text)).toEqual(['Hello']);
        expect(outbox.rows().map((row) => row.id)).toEqual(['m-dup']);
    });

    it('sends what the box holds when its turn comes, and keeps what was typed after', async () => {
        const { drafts, outbox, onDisk } = await setup();
        const scope = chatDraft('c1');
        drafts.write(scope, 'Hello');
        const sent = drafts.enqueueFromDraft(scope, sendAs('m-typed'));
        // Typed before the send's transaction: it goes with it.
        drafts.write(scope, 'Hello there');
        await sent;
        expect(outbox.rows()[0]?.payload).toBe(JSON.stringify({ text: 'Hello there' }));
        expect(drafts.read(scope).text).toBe('');
        expect(await onDisk()).toEqual([]);
    });

    it('keeps text typed while the transaction runs, never the sent text twice', () => {
        expect(afterSend('Hello', 'Hello')).toBe('');
        expect(afterSend('Hello and more', 'Hello')).toBe('and more');
        expect(afterSend('Edited', 'Hello')).toBe('Edited');
    });

    it('keeps the draft’s other sends in the transaction', async () => {
        const { drafts, onDisk } = await setup();
        const scope = chatDraft('c1');
        drafts.markSending(scope, 'web-1', 'Earlier');
        drafts.write(scope, 'Now');
        await drafts.enqueueFromDraft(scope, sendAs('m-now'));
        expect(drafts.read(scope)).toMatchObject({ text: '', sending: [{ id: 'web-1', text: 'Earlier' }] });
        expect(await onDisk()).toEqual([
            {
                scope,
                text: '',
                payloadVersion: 1,
                sending: JSON.stringify([{ id: 'web-1', text: 'Earlier' }]),
            },
        ]);
    });
});

describe('close()', () => {
    it('commits a send queued before it, behind a pending flush, and leaves an empty draft', async () => {
        const { drafts, outbox, reopen } = await setup();
        const scope = chatDraft('c1');
        drafts.write(scope, 'Hello');
        // The write's flush is still in the queue; the send waits behind it, then the scope closes.
        const sent = drafts.enqueueFromDraft(scope, sendAs('m-closing'));
        const closing = drafts.close();
        expect(() => drafts.write(scope, 'Later')).toThrow(DraftError);
        await expect(sent).resolves.toMatchObject({ id: 'm-closing' });
        await closing;
        expect(outbox.rows().map((row) => row.id)).toEqual(['m-closing']);
        const next = await reopen();
        expect(next.drafts.read(scope)).toEqual({ text: '', at: 0 });
        expect(next.outbox.rows().map((row) => row.id)).toEqual(['m-closing']);
    });

    it('writes what a failed flush left dirty once more as it closes', async () => {
        const { drafts, file, errors, onDisk } = await setup();
        const transaction = file.db.transaction.bind(file.db);
        let failures = 1;
        file.db.transaction = (async (work: Parameters<typeof transaction>[0]) => {
            if (failures > 0) {
                failures -= 1;
                throw new Error('disk full');
            }
            return transaction(work);
        }) as typeof file.db.transaction;
        drafts.write(chatDraft('c1'), 'Kept');
        await drafts.flush();
        expect(errors).toHaveLength(1);
        expect(await onDisk()).toEqual([]);
        await drafts.close();
        expect((await onDisk()).map((row) => [row.scope, row.text])).toEqual([['chat:c1', 'Kept']]);
    });
});

describe('a kill between every two steps', () => {
    /**
     * One launch: opens user.db on a new connection with a kill at step `at`
     * (none: -1), and, if asked, types `text` in the box and sends it. Resolves
     * once idle, or once the kill came and what could settle has.
     */
    async function launch(
        store: Awaited<ReturnType<typeof userDb>>,
        server: FakeMessageServer,
        at: number,
        send?: { text: string; id: string },
    ): Promise<{ killed: boolean; steps: string[]; cleared: boolean }> {
        const kill = killAt(at);
        const file = await store.open();
        files.push(file);
        const scope = chatDraft('c1');
        let cleared = false;
        const run = (async () => {
            const db: SqlConnection = kill.db(file.db);
            const outbox = await openOutbox({
                db,
                state: file.state,
                kinds: [MESSAGE] as OutboxKind<unknown>[],
                fetch: kill.fetch(fetchTo(server)),
                random: () => 0.5,
            });
            const drafts = await openDrafts({ db, state: file.state, outbox });
            outbox.start();
            if (send !== undefined) {
                drafts.write(scope, send.text);
                await drafts.flush();
                await drafts.enqueueFromDraft(scope, sendAs(send.id));
                cleared = drafts.read(scope).text === '';
            }
            await outbox.idle();
            await drafts.close();
            await outbox.dispose();
        })();
        await Promise.race([
            run,
            (async () => {
                while (!kill.killed) {
                    await turns(1);
                }
                await turns();
            })(),
        ]);
        return { killed: kill.killed, steps: kill.steps, cleared };
    }

    it('never loses the text once stored, and never keeps it in both places', { timeout: 120_000 }, async () => {
        const store = await userDb();
        directories.push(store.directory);
        const server = fakeMessageServer();

        const clean = await launch(store, server, -1, { text: 'count the steps', id: 'm-steps' });
        expect(clean.steps).toEqual([
            'run UPDATE outbox',
            'transaction', // the draft typed
            'transaction', // the send: the draft cleared, the row inserted
            'run UPDATE outbox',
            'send POST /api/test/messages',
            'answer POST /api/test/messages',
            'transaction',
        ]);
        expect(clean.cleared).toBe(true);

        let cases = 0;
        for (let first = 0; first < clean.steps.length; first += 1) {
            for (let second = 0; ; second += 1) {
                const id = `m-${first}-${second}`;
                const text = `kill at ${first}, then ${second}`;
                const one = await launch(store, server, first, { text, id });
                expect(one.killed).toBe(true);
                const two = await launch(store, server, second);
                const three = await launch(store, server, -1);
                expect(three.killed).toBe(false);
                const file = files.at(-1) as UserDb;
                const draft = await file.db.get<{ text: string }>("SELECT text FROM drafts WHERE scope = 'chat:c1'");
                const inDraft = draft?.text === text ? 1 : 0;
                const arrived = server.received.get(id) ?? 0;
                // Stored once the draft's write committed (step 1): then in exactly one place.
                const stored = first > 1;
                expect({ first, second, places: inDraft + arrived }).toEqual({ first, second, places: stored ? 1 : 0 });
                // The send committed only after step 2: before it, the text is still the draft.
                expect({ first, second, inDraft }).toEqual({ first, second, inDraft: first === 2 ? 1 : 0 });
                // The box cleared once the send committed, and only then.
                expect(one.cleared).toBe(first > 2);
                expect(await file.db.all('SELECT id FROM outbox')).toEqual([]);
                // The next case types again into an empty box.
                await file.db.run('DELETE FROM drafts');
                cases += 1;
                if (!two.killed) {
                    break;
                }
            }
        }
        expect(cases).toBeGreaterThan(clean.steps.length);
        for (const count of server.received.values()) {
            expect(count).toBe(1);
        }
    });
});

describe('rekey (a new chat’s local id to its server id)', () => {
    it('moves a draft in one write, after what the target holds, and leaves locked drafts alone', async () => {
        const { file, drafts, reopen, onDisk } = await setup();
        drafts.write(chatDraft('local-1'), 'typed on');
        expect(drafts.scopes()).toEqual([chatDraft('local-1')]);
        expect(drafts.rekey(chatDraft('local-1'), chatDraft('c1'))).toBe(true);
        expect(drafts.read(chatDraft('local-1')).text).toBe('');
        expect(drafts.read(chatDraft('c1')).text).toBe('typed on');
        await drafts.flush();
        expect((await onDisk()).map((row) => [row.scope, row.text])).toEqual([['chat:c1', 'typed on']]);
        // Nothing to move, or the same scope.
        expect(drafts.rekey(chatDraft('local-2'), chatDraft('c2'))).toBe(false);
        expect(drafts.rekey(chatDraft('c1'), chatDraft('c1'))).toBe(false);
        // The target's text comes first.
        drafts.write(chatDraft('local-3'), 'second');
        expect(drafts.rekey(chatDraft('local-3'), chatDraft('c1'))).toBe(true);
        expect(drafts.read(chatDraft('c1')).text).toBe('typed on\n\nsecond');
        await drafts.flush();
        await file.db.run(
            "INSERT INTO drafts (scope, text, payloadVersion, updatedAt, sending) VALUES ('chat:local-4', 'From later', 2, 1, NULL)",
        );
        const next = await reopen();
        expect(next.drafts.rekey(chatDraft('local-4'), chatDraft('c4'))).toBe(false);
        expect(next.drafts.read(chatDraft('local-4'))).toMatchObject({ text: 'From later', locked: true });
    });

    it('sends several writes from one box in one transaction', async () => {
        const { drafts, outbox, onDisk } = await setup();
        drafts.write(newChatDraft('d1'), 'hello');
        const row = await drafts.enqueueFromDraft(newChatDraft('d1'), (text) => [
            message(`${text} (parent)`, { id: 'p-1', lane: 'chat:l1' }),
            { ...message(text, { id: 'm-1', lane: 'chat:l1' }), dependsOn: 'p-1' },
        ]);
        expect(row?.id).toBe('m-1');
        expect(outbox.rows().map((r) => [r.id, r.dependsOn])).toEqual([
            ['p-1', null],
            ['m-1', 'p-1'],
        ]);
        expect(await onDisk()).toEqual([]);
    });

    it('a move from a scope whose send is in flight waits for it, so the sent text stays out of the target', async () => {
        const { drafts, outbox, onDisk } = await setup();
        drafts.write(chatDraft('local-5'), 'already sent');
        let moved: boolean | null = null;
        const row = await drafts.enqueueFromDraft(chatDraft('local-5'), (text) => {
            // The create settles while the send is being stored: its re-key runs now.
            moved = drafts.rekey(chatDraft('local-5'), chatDraft('c5'));
            return message(text, { id: 'm-5', lane: 'chat:local-5' });
        });
        expect(row?.id).toBe('m-5');
        expect(moved).toBe(true);
        await drafts.flush();
        expect(drafts.read(chatDraft('local-5')).text).toBe('');
        expect(drafts.read(chatDraft('c5')).text).toBe('');
        expect(outbox.rows().map((r) => r.id)).toEqual(['m-5']);
        expect(await onDisk()).toEqual([]);

        // What was typed during the send still moves, after it.
        drafts.write(chatDraft('local-6'), 'first');
        await drafts.enqueueFromDraft(chatDraft('local-6'), (text) => {
            drafts.write(chatDraft('local-6'), 'first then more');
            expect(drafts.rekey(chatDraft('local-6'), chatDraft('c6'))).toBe(true);
            return message(text, { id: 'm-6', lane: 'chat:local-6' });
        });
        await drafts.flush();
        expect(drafts.read(chatDraft('local-6')).text).toBe('');
        expect(drafts.read(chatDraft('c6')).text).toBe('then more');
    });
});
