import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    checkPerson,
    countUnsentItems,
    decidePerson,
    openUserDb,
    type PersonCheck,
    type SignInAnswer,
    type Store,
    USER_DB,
    workspaceKeyName,
    workspaceLayout,
    type WorkspaceRow,
} from '../../src/data';
import { addWorkspace, launch, phone, type Phone } from '../helpers/store';

// The person check (src/data/person-check.ts): the same person, another
// person with their unsent count, BANNED_USER for a copy on the phone, and
// rows still being added or wiped. The decision is pure; checkPerson reads
// the registry and counts user.db's outbox and unsent rows.

const ORIGIN = 'https://brain.example.test';
const OTHER_PORT = 'https://brain.example.test:8443';
const ELSEWHERE = 'https://other.example.test';
const id = (n: number) => n.toString(16).padStart(64, '0');

function row(n: number, fields: Partial<WorkspaceRow> = {}): WorkspaceRow {
    return {
        id: id(n),
        origin: ORIGIN,
        appUserId: `u-${n}`,
        state: 'ready',
        wipeReason: null,
        name: 'Acme',
        logo: null,
        personName: `Person ${n}`,
        personEmail: `person${n}@example.test`,
        createdAt: n,
        lastUsed: n,
        sessionExpiresAt: null,
        lastContact: null,
        endedAt: null,
        leaseLockedAt: null,
        unread: null,
        waiting: null,
        ...fields,
    };
}

const signedIn = (appUserId: string): SignInAnswer => ({ kind: 'signed-in', appUserId });
const deactivated = (email: string): SignInAnswer => ({ kind: 'deactivated', email });

describe('decidePerson', () => {
    const cases: Array<{
        name: string;
        rows: WorkspaceRow[];
        answer: SignInAnswer;
        unsent?: Map<string, number | null>;
        expected: PersonCheck;
    }> = [
        { name: 'no workspace on the phone', rows: [], answer: signedIn('u-1'), expected: { kind: 'new' } },
        {
            name: 'the workspace only on another origin',
            rows: [row(1, { origin: ELSEWHERE }), row(2, { origin: OTHER_PORT })],
            answer: signedIn('u-1'),
            expected: { kind: 'new' },
        },
        {
            name: 'the same person, signing in again',
            rows: [row(1)],
            answer: signedIn('u-1'),
            expected: { kind: 'same-person', id: id(1) },
        },
        {
            name: 'the same person whose session ended or whose lease locked',
            rows: [row(1, { endedAt: 5, leaseLockedAt: 6 })],
            answer: signedIn('u-1'),
            expected: { kind: 'same-person', id: id(1) },
        },
        {
            name: 'the same app user id on another origin is someone new here',
            rows: [row(1, { origin: ELSEWHERE })],
            answer: signedIn('u-1'),
            expected: { kind: 'new' },
        },
        {
            name: 'another person, with nothing unsent',
            rows: [row(1)],
            answer: signedIn('u-2'),
            unsent: new Map([[id(1), 0]]),
            expected: {
                kind: 'other-person',
                previous: [{ id: id(1), personName: 'Person 1', personEmail: 'person1@example.test', unsent: 0 }],
                unsent: 0,
            },
        },
        {
            name: 'another person, with unsent items',
            rows: [row(1)],
            answer: signedIn('u-2'),
            unsent: new Map([[id(1), 3]]),
            expected: {
                kind: 'other-person',
                previous: [{ id: id(1), personName: 'Person 1', personEmail: 'person1@example.test', unsent: 3 }],
                unsent: 3,
            },
        },
        {
            name: 'another person whose count failed: unknown, never none',
            rows: [row(1), row(3)],
            answer: signedIn('u-2'),
            unsent: new Map([
                [id(1), 2],
                [id(3), null],
            ]),
            expected: {
                kind: 'other-person',
                previous: [
                    { id: id(1), personName: 'Person 1', personEmail: 'person1@example.test', unsent: 2 },
                    { id: id(3), personName: 'Person 3', personEmail: 'person3@example.test', unsent: null },
                ],
                unsent: null,
            },
        },
        {
            name: 'another person with no count given',
            rows: [row(1)],
            answer: signedIn('u-2'),
            expected: {
                kind: 'other-person',
                previous: [{ id: id(1), personName: 'Person 1', personEmail: 'person1@example.test', unsent: null }],
                unsent: null,
            },
        },
        {
            name: 'the same person beside another: the other is confirmed first',
            rows: [row(1), row(2)],
            answer: signedIn('u-2'),
            unsent: new Map([[id(1), 1]]),
            expected: {
                kind: 'other-person',
                previous: [{ id: id(1), personName: 'Person 1', personEmail: 'person1@example.test', unsent: 1 }],
                unsent: 1,
            },
        },
        {
            name: 'a newer build’s state is on the phone',
            rows: [row(1, { state: 'archived' })],
            answer: signedIn('u-2'),
            unsent: new Map([[id(1), 0]]),
            expected: {
                kind: 'other-person',
                previous: [{ id: id(1), personName: 'Person 1', personEmail: 'person1@example.test', unsent: 0 }],
                unsent: 0,
            },
        },
        {
            name: 'another person’s copy being wiped is going: someone new',
            rows: [row(1, { state: 'wiping', wipeReason: 'sign-out' })],
            answer: signedIn('u-2'),
            expected: { kind: 'new' },
        },
        {
            name: 'another person’s pending row (a kill launch will wipe) is not on the phone',
            rows: [row(1, { state: 'pending' })],
            answer: signedIn('u-2'),
            expected: { kind: 'new' },
        },
        {
            name: 'the same person’s copy still being wiped',
            rows: [row(1, { state: 'wiping', wipeReason: 'sign-out' })],
            answer: signedIn('u-1'),
            expected: { kind: 'unfinished', id: id(1) },
        },
        {
            name: 'the same person’s row still pending',
            rows: [row(1, { state: 'pending' })],
            answer: signedIn('u-1'),
            expected: { kind: 'unfinished', id: id(1) },
        },
        {
            name: 'BANNED_USER for the email of a copy on the phone, typed in another case and with spaces',
            rows: [row(1), row(2)],
            answer: deactivated('  PERSON1@Example.test '),
            expected: { kind: 'deactivated', wipe: [id(1)] },
        },
        {
            name: 'BANNED_USER for an email the phone holds no copy for',
            rows: [row(1)],
            answer: deactivated('someone@example.test'),
            expected: { kind: 'deactivated', wipe: [] },
        },
        {
            name: 'BANNED_USER for that email on another origin only',
            rows: [row(1, { origin: ELSEWHERE })],
            answer: deactivated('person1@example.test'),
            expected: { kind: 'deactivated', wipe: [] },
        },
        {
            name: 'BANNED_USER for a copy already being wiped, or with no email',
            rows: [row(1, { state: 'wiping', wipeReason: 'sign-out' }), row(2, { personEmail: null })],
            answer: deactivated('person1@example.test'),
            expected: { kind: 'deactivated', wipe: [] },
        },
    ];

    for (const { name, rows, answer, unsent, expected } of cases) {
        it(name, () => {
            expect(decidePerson({ origin: ORIGIN, rows, answer, unsent })).toEqual(expected);
        });
    }
});

describe('checkPerson and countUnsentItems on a store', () => {
    let device: Phone;
    beforeEach(() => {
        device = phone(mkdtempSync(join(tmpdir(), 'socio-person-')));
    });
    afterEach(() => {
        rmSync(device.root, { recursive: true, force: true });
    });

    /** Writes `outbox` outbox rows and `unsent` unsent rows into the workspace's user.db. */
    async function plantUnsent(store: Store, workspace: string, outbox: number, unsent: number) {
        const key = (await store.keys.read(workspaceKeyName(workspace, 'user')))!;
        const { db } = await openUserDb(store.driver, workspaceLayout(store.root, workspace).directory, key);
        for (let n = 0; n < outbox; n++) {
            await db.run(
                `INSERT INTO outbox (id, lane, kind, payload, payloadVersion, idempotencyKey, state, createdAt)
                 VALUES (?, 'chat:c1', 'send', '{}', 1, ?, 'queued', 1)`,
                [`o${n}`, `k${n}`],
            );
        }
        for (let n = 0; n < unsent; n++) {
            await db.run(
                "INSERT INTO unsent (id, kind, payload, payloadVersion, reason, createdAt) VALUES (?, 'send', '{}', 1, 'refused', 1)",
                [`s${n}`],
            );
        }
        await db.close();
    }

    it('counts the previous person’s outbox and unsent rows from their user.db', async () => {
        const { store } = await launch(device);
        const bob = await addWorkspace(store, ORIGIN, 'u-bob');
        await plantUnsent(store, bob.id, 2, 1);
        expect(await countUnsentItems(store, bob.id)).toBe(3);
        const check = await checkPerson(store, ORIGIN, signedIn('u-ada'));
        expect(check).toMatchObject({ kind: 'other-person', unsent: 3, previous: [{ id: bob.id, unsent: 3 }] });
        expect(store.driver.openFiles()).toEqual([expect.objectContaining({ name: 'registry.db' })]);
    });

    it('leaves out a message sent and waiting for the stored history: the server has it', async () => {
        const { store } = await launch(device);
        const bob = await addWorkspace(store, ORIGIN, 'u-bob');
        await plantUnsent(store, bob.id, 2, 1);
        const key = (await store.keys.read(workspaceKeyName(bob.id, 'user')))!;
        const { db } = await openUserDb(store.driver, workspaceLayout(store.root, bob.id).directory, key);
        await db.run("UPDATE outbox SET state = 'sent' WHERE id = 'o0'");
        await db.close();
        expect(await countUnsentItems(store, bob.id)).toBe(2);
    });

    it('is 0 when nothing has been written to user.db yet', async () => {
        const { store } = await launch(device);
        const bob = await addWorkspace(store, ORIGIN, 'u-bob');
        expect(await checkPerson(store, ORIGIN, signedIn('u-ada'))).toMatchObject({
            kind: 'other-person',
            unsent: 0,
            previous: [{ id: bob.id, unsent: 0 }],
        });
    });

    it('a count it can’t make is null, and makes no file', async () => {
        const { store } = await launch(device);
        const noFile = await addWorkspace(store, ORIGIN, 'u-bob');
        const userDb = join(workspaceLayout(store.root, noFile.id).directory, USER_DB);
        rmSync(userDb);
        await expect(countUnsentItems(store, noFile.id)).rejects.toThrow(/no user\.db/);
        expect(existsSync(userDb)).toBe(false);
        expect(await checkPerson(store, ORIGIN, signedIn('u-ada'))).toMatchObject({
            kind: 'other-person',
            unsent: null,
        });

        const noKey = await addWorkspace(store, ELSEWHERE, 'u-bob');
        await store.keys.delete([workspaceKeyName(noKey.id, 'user')]);
        await expect(countUnsentItems(store, noKey.id)).rejects.toThrow(/no user\.db key/);
        expect(await checkPerson(store, ELSEWHERE, signedIn('u-ada'))).toMatchObject({
            kind: 'other-person',
            unsent: null,
        });
    });

    it('asks the counter only about other people’s copies on that origin', async () => {
        const { store } = await launch(device);
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const bob = await addWorkspace(store, ORIGIN, 'u-bob');
        await addWorkspace(store, ELSEWHERE, 'u-carol');
        const counter = vi.fn(async (_store: Store, _workspace: string) => 4);
        expect(await checkPerson(store, ORIGIN, signedIn('u-ada'), counter)).toMatchObject({
            kind: 'other-person',
            unsent: 4,
            previous: [{ id: bob.id }],
        });
        expect(counter.mock.calls.map(([, workspace]) => workspace)).toEqual([bob.id]);

        counter.mockClear();
        expect(await checkPerson(store, ELSEWHERE, signedIn('u-carol'), counter)).toMatchObject({
            kind: 'same-person',
        });
        expect(await checkPerson(store, ORIGIN, deactivated('ada@example.test'), counter)).toEqual({
            kind: 'deactivated',
            // The store helper gives every person this email.
            wipe: [ada.id, bob.id],
        });
        expect(counter).not.toHaveBeenCalled();
    });
});
