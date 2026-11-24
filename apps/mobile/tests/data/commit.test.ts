import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    type CommitJar,
    type CommitStep,
    commitSignIn,
    NEW_WORKSPACE_STEPS,
    SAME_PERSON_STEPS,
    SignInCommitError,
    type SignInToCommit,
    type SqlDriver,
    type Store,
    USER_DB,
    workspaceId,
    workspaceKeyName,
    workspaceLayout,
} from '../../src/data';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { sessionCookieName } from '../../src/net/session';
import { addWorkspace, kill, launch, type LaunchOptions, phone, type Phone, sha256 } from '../helpers/store';
import { httpDate, T0 } from '../net/helpers';

// Committing a sign-in (src/data/commit.ts): a new workspace in its order (a
// pending row, the directory, both databases, the jar, ready, active), the
// same person's re-sign-in (the jar, active), and a failure
// after or inside every step leaving the store as it was before the sign-in,
// `lastUsed` included: the clock moves on each read, so a rollback that
// counted as a use would show. The staging jar is discarded after a commit
// and released (signed out, then discarded) after a refusal or a rollback.

const ORIGIN = 'https://brain.example.test';
const OTHER = 'https://other.example.test';
const COOKIE = 'tok7f3a.c2lnbmF0dXJl%3D';
/** The install id a sign-in sent: staged until the commit. */
const STAGED_INSTALL = 'S'.repeat(43);

let device: Phone;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-commit-')));
});
afterEach(() => {
    rmSync(device.root, { recursive: true, force: true });
});

const socio = () => join(device.root, 'socio');

/** A staging jar from src/net with a session cookie in it, and whether it was discarded or released. */
async function stagingJar(
    origin = ORIGIN,
): Promise<CommitJar & { readonly discarded: boolean; readonly released: boolean }> {
    const jar = await openCookieJar({ origin, store: memoryJarStore(), now: () => T0 });
    await jar.apply(
        new URL(`${origin}/api/auth/sign-in/email`),
        [`${sessionCookieName(origin)}=${COOKIE}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Strict`],
        httpDate(T0),
    );
    let discarded = false;
    let released = false;
    const discard = async () => {
        discarded = true;
        await jar.clear();
        await jar.close();
    };
    return {
        get discarded() {
            return discarded;
        },
        get released() {
            return released;
        },
        serialize: () => {
            if (discarded) {
                throw new Error('discarded');
            }
            return jar.serialize();
        },
        discard,
        release: async () => {
            released = true;
            await discard();
        },
    };
}

async function signIn(appUserId = 'u-ada', origin = ORIGIN) {
    const jar = await stagingJar(origin);
    const input: SignInToCommit = {
        origin,
        appUserId,
        name: 'Acme',
        personName: 'Ada',
        personEmail: 'ada@example.test',
        jar,
        installId: STAGED_INSTALL,
    };
    return { input, jar, id: await workspaceId(sha256, origin, appUserId) };
}

/** Everything a sign-in could change: the rows, the active workspace, the keychain and the files. */
async function snapshot(store: Store) {
    return {
        rows: await store.registry.list(),
        active: await store.registry.active(),
        keychain: [...device.keychain.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
        files: readdirSync(socio(), { recursive: true, encoding: 'utf8' }).sort(),
    };
}

/** A failure the tests inject. */
class Injected extends Error {
    override name = 'Injected';
}

/** Launches with a clock that moves a second on each read, and a workspace on another origin already there and active. */
async function setUp(options: LaunchOptions = {}) {
    let clock = T0;
    const opened = await launch(device, { now: () => (clock += 1000), ...options });
    const other = await addWorkspace(opened.store, OTHER, 'u-zed');
    await opened.store.registry.setActive(other.id);
    return { ...opened, other };
}

describe('commitSignIn: a new workspace', () => {
    it('runs its order: a pending row, the directory, both keys and databases, the jar, ready, active', async () => {
        const events: string[] = [];
        let recording = false;
        const note = (event: string) => {
            if (recording) {
                events.push(event);
            }
        };
        const { store } = await setUp({
            driver: {
                intercept: (sql) => {
                    if (/^\s*INSERT INTO workspaces/.test(sql)) {
                        note('row: pending');
                    } else if (/SET state = 'ready'/.test(sql)) {
                        note('row: ready');
                    } else if (/^\s*INSERT INTO active/.test(sql)) {
                        note('row: active');
                    }
                    return undefined;
                },
            },
            fs: { before: (call, path) => call === 'mkdir' && note(`mkdir ${path.slice(socio().length + 1)}`) },
            keyStore: {
                before: (call, name) => call === 'set' && name !== 'socio.index' && note(`set ${name}`),
            },
            wrapDriver: (driver: SqlDriver): SqlDriver => ({
                open: (file) => {
                    note(`open ${file.name}`);
                    return driver.open(file);
                },
                delete: (file) => driver.delete(file),
            }),
        });
        const { input, jar, id } = await signIn();
        recording = true;
        const committed = await commitSignIn(store, input, {
            hash: sha256,
            afterStep: (step) => note(`step ${step}`),
        });
        expect(committed).toEqual({ id, kind: 'new' });
        expect(events).toEqual([
            'row: pending',
            'step registered',
            `mkdir ${id}`,
            'step directory',
            `set socio.${id}.cache`,
            `set socio.${id}.user`,
            'open cache.db',
            'open user.db',
            'step databases',
            `set socio.${id}.jar`,
            'step jar',
            `set socio.${id}.install`,
            'step install',
            'row: ready',
            'step ready',
            'row: active',
            'step active',
        ]);
        expect(events.filter((event) => event.startsWith('step ')).map((event) => event.slice(5))).toEqual(
            NEW_WORKSPACE_STEPS,
        );
        // Committed: its session lives on in the workspace's jar, so it is discarded, never signed out.
        expect(jar).toMatchObject({ discarded: true, released: false });
    });

    it('leaves a ready, active workspace whose jar slot opens with the staged session', async () => {
        const { store } = await setUp();
        const { input, id } = await signIn();
        await commitSignIn(store, input, { hash: sha256 });
        expect(await store.registry.get(id)).toMatchObject({
            origin: ORIGIN,
            appUserId: 'u-ada',
            state: 'ready',
            name: 'Acme',
            logo: null,
            personName: 'Ada',
            personEmail: 'ada@example.test',
        });
        expect(await store.registry.active()).toBe(id);
        expect(readdirSync(workspaceLayout(store.root, id).directory).sort()).toEqual(['cache.db', 'user.db']);
        expect(store.driver.openFiles().map((file) => file.name)).toEqual(['registry.db']);
        const jar = await openCookieJar({ origin: ORIGIN, store: store.keys.slot(workspaceKeyName(id, 'jar')) });
        expect(jar.session()?.value).toBe(COOKIE);
        expect(await store.keys.indexed()).toEqual(
            expect.arrayContaining(['cache', 'user', 'jar'].map((kind) => `socio.${id}.${kind}`)),
        );
    });

    it('commits the first workspace on the phone too', async () => {
        const { store } = await launch(device, { now: () => T0 });
        const { input, id } = await signIn();
        await commitSignIn(store, input, { hash: sha256 });
        expect(await store.registry.active()).toBe(id);
    });

    for (const failing of NEW_WORKSPACE_STEPS) {
        it(`a failure after ${failing} rolls back: no row, directory, keys or jar, and the active workspace as it was`, async () => {
            const { store } = await setUp();
            const before = await snapshot(store);
            const { input, jar, id } = await signIn();
            const failure = new Injected(failing);
            const steps: CommitStep[] = [];
            const error = await commitSignIn(store, input, {
                hash: sha256,
                afterStep: (step) => {
                    steps.push(step);
                    if (step === failing) {
                        throw failure;
                    }
                },
            }).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(SignInCommitError);
            expect(error).toMatchObject({ step: failing, rolledBack: true, rollbackError: null, cause: failure });
            expect(steps).toEqual(NEW_WORKSPACE_STEPS.slice(0, NEW_WORKSPACE_STEPS.indexOf(failing) + 1));
            expect(await snapshot(store)).toEqual(before);
            expect(existsSync(workspaceLayout(store.root, id).directory)).toBe(false);
            expect(store.driver.openFiles().map((file) => file.name)).toEqual(['registry.db']);
            expect(jar).toMatchObject({ discarded: true, released: true });
        });
    }

    // Each step's own work failing, as the platform would: a full disk, a keychain that refuses, a file that won't open.
    const inside: Array<{ step: CommitStep; arm: (fail: (where: string) => boolean) => LaunchOptions }> = [
        {
            step: 'registered',
            arm: (fail) => ({ driver: { intercept: (sql) => failing(fail(sql)) } }),
        },
        {
            step: 'directory',
            arm: (fail) => ({ fs: { before: (call, path) => call === 'mkdir' && fail(path) && throwInjected() } }),
        },
        {
            step: 'databases',
            arm: (fail) => ({ keyStore: { before: (call, name) => call === 'set' && fail(name) && throwInjected() } }),
        },
        {
            step: 'databases',
            arm: (fail) => ({
                wrapDriver: (driver: SqlDriver): SqlDriver => ({
                    open: async (file) => (fail(`open ${file.name}`) ? throwInjected() : driver.open(file)),
                    delete: (file) => driver.delete(file),
                }),
            }),
        },
        {
            step: 'jar',
            arm: (fail) => ({ keyStore: { before: (call, name) => call === 'set' && fail(name) && throwInjected() } }),
        },
        {
            step: 'install',
            arm: (fail) => ({ keyStore: { before: (call, name) => call === 'set' && fail(name) && throwInjected() } }),
        },
        {
            step: 'ready',
            arm: (fail) => ({ driver: { intercept: (sql) => failing(fail(sql)) } }),
        },
        {
            step: 'active',
            arm: (fail) => ({ driver: { intercept: (sql) => failing(fail(sql)) } }),
        },
    ];
    /** What each case's failure matches, once armed. */
    const target: Record<string, RegExp> = {
        registered: /^\s*INSERT INTO workspaces/,
        directory: /[0-9a-f]{64}$/,
        databases: /\.user$|^open user\.db$/,
        jar: /\.jar$/,
        install: /\.install$/,
        ready: /SET state = 'ready'/,
        active: /^\s*INSERT INTO active/,
    };

    it('fails every step inside it, so a new step can’t join the plan without its case', () => {
        expect(new Set(inside.map((entry) => entry.step))).toEqual(new Set(NEW_WORKSPACE_STEPS));
        expect(Object.keys(target).sort()).toEqual([...NEW_WORKSPACE_STEPS].sort());
    });

    for (const [index, { step, arm }] of inside.entries()) {
        it(`a failure inside ${step} (${index}) rolls back to the store as it was`, async () => {
            let armed = false;
            const { store } = await setUp(arm((where) => armed && target[step].test(where)));
            const before = await snapshot(store);
            const { input, jar } = await signIn();
            armed = true;
            const error = await commitSignIn(store, input, { hash: sha256 }).catch((caught: unknown) => caught);
            armed = false;
            expect(error).toMatchObject({ name: 'SignInCommitError', step, rolledBack: true });
            // The injected failure, or the store's error around it (open.ts's StoreOpenError for an open).
            expect(causes(error).some((cause) => cause instanceof Injected)).toBe(true);
            expect(await snapshot(store)).toEqual(before);
            expect(jar).toMatchObject({ discarded: true, released: true });
        });
    }

    it('a rollback that fails too leaves the row marked, and the next launch finishes it', async () => {
        let armed = false;
        const { store } = await setUp({
            keyStore: { before: (call) => armed && call === 'delete' && throwInjected() },
        });
        const before = await snapshot(store);
        const { input, id } = await signIn();
        const error = await commitSignIn(store, input, {
            hash: sha256,
            afterStep: (step) => {
                if (step === 'jar') {
                    armed = true;
                    throwInjected();
                }
            },
        }).catch((caught: unknown) => caught);
        armed = false;
        expect(error).toMatchObject({ name: 'SignInCommitError', step: 'jar', rolledBack: false });
        expect((error as SignInCommitError).rollbackError).toBeInstanceOf(Injected);
        expect(await store.registry.get(id)).toMatchObject({ state: 'wiping', wipeReason: 'unfinished' });
        expect(await store.registry.active()).toBe(before.active);

        await kill(store);
        const relaunched = await launch(device, { now: () => T0 });
        expect(relaunched.launch.wiped).toEqual([{ id, reason: 'unfinished' }]);
        expect(await snapshot(relaunched.store)).toEqual(before);
    });

    it('a kill in the middle leaves a pending row, which the next launch wipes', async () => {
        const { store } = await setUp();
        const before = await snapshot(store);
        const { input, id } = await signIn();
        let killed!: () => void;
        const atJar = new Promise<void>((done) => {
            killed = done;
        });
        void commitSignIn(store, input, {
            hash: sha256,
            afterStep: (step) => {
                if (step === 'jar') {
                    killed();
                    // The process dies here: nothing after this runs.
                    return new Promise<never>(() => undefined);
                }
                return undefined;
            },
        });
        await atJar;
        expect(await store.registry.get(id)).toMatchObject({ state: 'pending' });
        await kill(store);
        const relaunched = await launch(device, { now: () => T0 });
        expect(relaunched.launch.wiped).toEqual([{ id, reason: 'unfinished' }]);
        expect(await snapshot(relaunched.store)).toEqual(before);
    });
});

describe('commitSignIn: the same person again', () => {
    it('replaces only the jar and makes it active: the directory, user.db and row stay', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        const userDb = join(workspaceLayout(store.root, ada.id).directory, USER_DB);
        const bytes = readFileSync(userDb);
        const row = await store.registry.get(ada.id);
        const { input, jar } = await signIn('u-ada');
        const steps: CommitStep[] = [];
        expect(await commitSignIn(store, input, { hash: sha256, afterStep: (step) => void steps.push(step) })).toEqual({
            id: ada.id,
            kind: 'same-person',
        });
        expect(steps).toEqual(SAME_PERSON_STEPS);
        expect(readFileSync(userDb).equals(bytes)).toBe(true);
        const after = await store.registry.get(ada.id);
        // The sign-in counts as contact, so the lease starts over.
        // The sign-in's install id is recorded as written.
        expect(after).toEqual({
            ...row,
            lastUsed: expect.any(Number),
            lastContact: after!.lastUsed,
            installSetAt: expect.any(Number),
        });
        expect(await store.keys.read(workspaceKeyName(ada.id, 'install'))).toBe(STAGED_INSTALL);
        expect(after!.lastUsed).toBeGreaterThan(row!.lastUsed);
        expect(await store.registry.active()).toBe(ada.id);
        expect(await store.keys.read(workspaceKeyName(ada.id, 'jar'))).toContain(COOKIE);
        expect(jar).toMatchObject({ discarded: true, released: false });
    });

    it('unlocks an Ended or lease-locked copy, keeping everything', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        await store.registry.setLastContact(ada.id, T0 - 40 * 86_400_000);
        await store.registry.setEnded(ada.id, T0 - 39 * 86_400_000);
        await store.registry.setLeaseLocked(ada.id, T0 - 10 * 86_400_000);
        const { input } = await signIn('u-ada');
        await commitSignIn(store, input, { hash: sha256 });
        const after = await store.registry.get(ada.id);
        expect(after).toMatchObject({ endedAt: null, leaseLockedAt: null, lastContact: after!.lastUsed });
        expect(await store.registry.active()).toBe(ada.id);
    });

    it('a failure after active puts the lock and the lease back as they were', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        await store.registry.setLastContact(ada.id, T0 - 40 * 86_400_000);
        await store.registry.setEnded(ada.id, T0 - 39 * 86_400_000);
        await store.registry.setLeaseLocked(ada.id, T0 - 10 * 86_400_000);
        const before = await snapshot(store);
        const { input } = await signIn('u-ada');
        const error = await commitSignIn(store, input, {
            hash: sha256,
            afterStep: (step) => {
                if (step === 'active') {
                    throwInjected();
                }
            },
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ name: 'SignInCommitError', step: 'active', rolledBack: true });
        expect(await snapshot(store)).toEqual(before);
    });

    for (const failing of SAME_PERSON_STEPS) {
        it(`a failure after ${failing} puts the old jar and the active workspace back, and never wipes`, async () => {
            const { store } = await setUp();
            const ada = await addWorkspace(store, ORIGIN, 'u-ada');
            const before = await snapshot(store);
            const userDb = readFileSync(join(workspaceLayout(store.root, ada.id).directory, USER_DB));
            const { input, jar } = await signIn('u-ada');
            const error = await commitSignIn(store, input, {
                hash: sha256,
                afterStep: (step) => {
                    if (step === failing) {
                        throwInjected();
                    }
                },
            }).catch((caught: unknown) => caught);
            expect(error).toMatchObject({ name: 'SignInCommitError', step: failing, rolledBack: true });
            expect(await snapshot(store)).toEqual(before);
            expect(await store.keys.read(workspaceKeyName(ada.id, 'jar'))).toBe('{"v":1}');
            expect(readFileSync(join(workspaceLayout(store.root, ada.id).directory, USER_DB)).equals(userDb)).toBe(
                true,
            );
            expect(jar).toMatchObject({ discarded: true, released: true });
        });
    }

    it(`a failure after active, with the person's workspace already the active one, gives its lastUsed back`, async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        await store.registry.setActive(ada.id);
        const before = await snapshot(store);
        const { input } = await signIn('u-ada');
        const error = await commitSignIn(store, input, {
            hash: sha256,
            afterStep: (step) => {
                if (step === 'active') {
                    throwInjected();
                }
            },
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ name: 'SignInCommitError', step: 'active', rolledBack: true });
        expect(await snapshot(store)).toEqual(before);
    });

    // Each step's own work failing once: the keychain refusing the new jar, the registry refusing the active mark.
    const insideSame: Array<{ step: CommitStep; arm: (armed: () => boolean) => LaunchOptions }> = [
        {
            step: 'jar',
            arm: (armed) => {
                let refused = false;
                return {
                    keyStore: {
                        before: (call, name) => {
                            if (armed() && !refused && call === 'set' && name.endsWith('.jar')) {
                                refused = true;
                                throwInjected();
                            }
                        },
                    },
                };
            },
        },
        {
            step: 'install',
            arm: (armed) => {
                let refused = false;
                return {
                    keyStore: {
                        before: (call, name) => {
                            if (armed() && !refused && call === 'set' && name.endsWith('.install')) {
                                refused = true;
                                throwInjected();
                            }
                        },
                    },
                };
            },
        },
        {
            step: 'active',
            arm: (armed) => ({
                driver: { intercept: (sql) => failing(armed() && /^\s*INSERT INTO active/.test(sql)) },
            }),
        },
    ];

    it('fails every step inside it, so a new step can’t join the plan without its case', () => {
        expect(new Set(insideSame.map((entry) => entry.step))).toEqual(new Set(SAME_PERSON_STEPS));
    });

    for (const { step, arm } of insideSame) {
        it(`a failure inside ${step} puts everything back, and never wipes`, async () => {
            let armed = false;
            const { store } = await setUp(arm(() => armed));
            const ada = await addWorkspace(store, ORIGIN, 'u-ada');
            const before = await snapshot(store);
            const { input, jar } = await signIn('u-ada');
            armed = true;
            const error = await commitSignIn(store, input, { hash: sha256 }).catch((caught: unknown) => caught);
            armed = false;
            expect(error).toMatchObject({ name: 'SignInCommitError', step, rolledBack: true });
            expect(causes(error).some((cause) => cause instanceof Injected)).toBe(true);
            expect(await snapshot(store)).toEqual(before);
            expect(await store.keys.read(workspaceKeyName(ada.id, 'jar'))).toBe('{"v":1}');
            expect(jar).toMatchObject({ discarded: true, released: true });
        });
    }

    it('a keychain that can’t read the old jar refuses before any step, as a SignInCommitError', async () => {
        let armed = false;
        const { store } = await setUp({
            keyStore: { before: (call, name) => armed && call === 'get' && name.endsWith('.jar') && throwInjected() },
        });
        await addWorkspace(store, ORIGIN, 'u-ada');
        const before = await snapshot(store);
        const { input, jar } = await signIn('u-ada');
        const steps: CommitStep[] = [];
        armed = true;
        const error = await commitSignIn(store, input, {
            hash: sha256,
            afterStep: (step) => void steps.push(step),
        }).catch((caught: unknown) => caught);
        armed = false;
        expect(error).toBeInstanceOf(SignInCommitError);
        expect(error).toMatchObject({ step: 'check', rolledBack: true });
        expect(causes(error).some((cause) => cause instanceof Injected)).toBe(true);
        expect(steps).toEqual([]);
        expect(await snapshot(store)).toEqual(before);
        expect(jar).toMatchObject({ discarded: true, released: true });
    });

    it('a workspace whose jar was missing goes back to having none', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        await store.keys.erase([workspaceKeyName(ada.id, 'jar')]);
        const before = await snapshot(store);
        const { input } = await signIn('u-ada');
        const error = await commitSignIn(store, input, {
            hash: sha256,
            afterStep: () => throwInjected(),
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ step: 'jar', rolledBack: true });
        expect(await snapshot(store)).toEqual(before);
    });
});

describe('commitSignIn: what it refuses', () => {
    it('another person’s copy on the origin: nothing is done until the caller wipes it', async () => {
        const { store } = await setUp();
        await addWorkspace(store, ORIGIN, 'u-bob');
        const before = await snapshot(store);
        const { input, jar } = await signIn('u-ada');
        const error = await commitSignIn(store, input, { hash: sha256 }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ name: 'SignInCommitError', step: 'check', rolledBack: true });
        expect(String((error as Error).message)).toMatch(/another person/);
        expect(await snapshot(store)).toEqual(before);
        expect(jar).toMatchObject({ discarded: true, released: true });
    });

    it('the same person’s copy still being wiped', async () => {
        const { store } = await setUp();
        const ada = await addWorkspace(store, ORIGIN, 'u-ada');
        await store.registry.markWiping(ada.id, 'sign-out');
        const before = await snapshot(store);
        const { input } = await signIn('u-ada');
        const error = await commitSignIn(store, input, { hash: sha256 }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ step: 'check', rolledBack: true });
        expect(await snapshot(store)).toEqual(before);
    });

    it('an origin that isn’t exact, before anything is done', async () => {
        const { store } = await setUp();
        const before = await snapshot(store);
        const { input, jar } = await signIn();
        const error = await commitSignIn(store, { ...input, origin: `${ORIGIN}/` }, { hash: sha256 }).catch(
            (caught: unknown) => caught,
        );
        expect(error).toMatchObject({ step: 'check', rolledBack: true });
        expect((error as SignInCommitError).cause).toBeInstanceOf(TypeError);
        expect(await snapshot(store)).toEqual(before);
        expect(jar).toMatchObject({ discarded: true, released: true });
    });
});

function throwInjected(): never {
    throw new Injected('injected');
}

/** `error`'s causes, nearest first. */
function causes(error: unknown): unknown[] {
    const chain: unknown[] = [];
    for (let cause = (error as Error).cause; cause !== undefined && chain.length < 5; cause = (cause as Error).cause) {
        chain.push(cause);
    }
    return chain;
}

/** An intercept that throws when told to, and otherwise lets SQLite answer. */
function failing(fail: boolean): undefined {
    if (fail) {
        throwInjected();
    }
    return undefined;
}
