import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';

import {
    checkPerson,
    commitSignIn,
    type SignInFlowDeps,
    signInAndCommit,
    type Store,
    USER_DB,
    wipe,
    workspaceId,
    workspaceKeyName,
    workspaceLayout,
} from '../src/data';
import {
    LOGOUT_PATH,
    openCookieJar,
    SESSION_PATH,
    SIGN_IN_PATH,
    signInCopy,
    type SignInResult,
    signInWithPassword,
    type StagedSignIn,
} from '../src/net';

import { addWorkspace, launch, phone, type Phone, sha256 } from './helpers/store';
import {
    answer,
    cookieValue,
    fakeFetch,
    httpDate,
    ORIGIN,
    SESSION,
    sentHeaders,
    sessionSetCookie,
    T0,
} from './net/helpers';

// The sign-in, end to end under Node: src/net's sign-in against a fake workspace,
// the person check and the commit on the fake phone. A refused sign-in or a cancel leaves
// the phone as it was, each case of the person check leads where it should, and the password is
// in no stored byte and no log.

const USER_AGENT = 'Socio/0.1.0 (iPhone; iOS 26)';
const PASSWORDS = { ada: 'pw-ada-7f3a-horse', bob: 'pw-bob-91c2-staple' } as const;

interface Account {
    readonly email: string;
    readonly password: string;
    readonly appUserId: string;
    readonly name: string;
    banned: boolean;
}

/**
 * A workspace that signs people in as Better Auth does: the password checked
 * first, then the ban (403 BANNED_USER, no cookie); a session cookie per
 * sign-in; `GET /api/auth/session` naming the cookie's app user; logout
 * clearing the cookie.
 */
function workspace() {
    const accounts: Account[] = [
        { email: 'ada@example.test', password: PASSWORDS.ada, appUserId: 'u-ada', name: 'Ada', banned: false },
        { email: 'bob@example.test', password: PASSWORDS.bob, appUserId: 'u-bob', name: 'Bob', banned: false },
    ];
    const sessions = new Map<string, Account>();
    /** What `/.well-known/socio/workspace` serves; null: a 404, as today's servers. */
    const served: { manifest: unknown } = { manifest: null };
    const json = (status: number, body: unknown, setCookie: string[] = []) =>
        answer(status, { date: httpDate(T0), headers: { 'content-type': 'application/json' }, setCookie, body });
    const fetch = fakeFetch((url: string, init: FetchRequestInit) => {
        const path = new URL(url).pathname;
        const cookie = cookieValue(sentHeaders({ url, init }).cookie, SESSION);
        if (path === SIGN_IN_PATH) {
            const { email, password } = JSON.parse(String(init.body)) as { email: string; password: string };
            const account = accounts.find((entry) => entry.email === email.toLowerCase());
            if (account === undefined || account.password !== password) {
                return json(401, { error: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' });
            }
            if (account.banned) {
                return json(403, { error: DEACTIVATED_MESSAGE, code: 'BANNED_USER' });
            }
            const token = `tok${sessions.size + 1}`;
            sessions.set(`${token}.c2ln`, account);
            return json(200, { redirect: false, token, user: { id: `ba-${account.appUserId}` } }, [
                sessionSetCookie(`${token}.c2ln`),
            ]);
        }
        if (path === SESSION_PATH) {
            const account = cookie === undefined ? undefined : sessions.get(cookie);
            return json(200, {
                provider: 'betterauth',
                branding: { name: 'Acme', logo: '/favicon.svg' },
                user: account === undefined ? null : { id: account.appUserId, name: account.name, role: 'member' },
            });
        }
        if (path === '/.well-known/socio/workspace' && served.manifest !== null) {
            return json(200, served.manifest);
        }
        if (path === LOGOUT_PATH) {
            if (cookie !== undefined) {
                sessions.delete(cookie);
            }
            return json(200, { ok: true }, [sessionSetCookie('', 0)]);
        }
        return json(404, { error: 'Not found.' });
    });
    return { fetch, accounts, sessions, served };
}

let device: Phone;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-sign-in-')));
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined),
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(device.root, { recursive: true, force: true });
});

const signIn = (server: ReturnType<typeof workspace>, email: string, password: string) =>
    signInWithPassword({ origin: ORIGIN, email, password, fetch: server.fetch, userAgent: USER_AGENT, now: () => T0 });

function staged(result: SignInResult): StagedSignIn {
    if (!result.ok) {
        throw new Error(`Expected a sign-in, got ${result.problem.kind}.`);
    }
    return result.signIn;
}

const commit = (store: Store, signedIn: StagedSignIn) =>
    commitSignIn(store, { ...signedIn, name: signedIn.workspaceName }, { hash: sha256 });

/** Every file under the phone's document directory, with its bytes. */
function files(root: string): Array<{ path: string; bytes: Buffer }> {
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
        .map((path) => join(root, path))
        .filter((path) => statSync(path).isFile())
        .map((path) => ({ path, bytes: readFileSync(path) }));
}

/** What the phone holds: the keychain and the file names. */
const phoneState = () => ({
    keychain: [...device.keychain.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    files: readdirSync(device.root, { recursive: true, encoding: 'utf8' }).sort(),
});

describe('signing in, end to end', () => {
    it('a first sign-in commits a ready, active workspace with the session in its jar', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const signedIn = staged(await signIn(server, ' Ada@example.test', PASSWORDS.ada));
        expect(await checkPerson(store, ORIGIN, { kind: 'signed-in', appUserId: signedIn.appUserId })).toEqual({
            kind: 'new',
        });
        const { id } = await commit(store, signedIn);
        expect(await store.registry.get(id)).toMatchObject({
            origin: ORIGIN,
            appUserId: 'u-ada',
            state: 'ready',
            name: 'Acme',
            personName: 'Ada',
            personEmail: 'Ada@example.test',
        });
        expect(await store.registry.active()).toBe(id);
        const jar = await openCookieJar({ origin: ORIGIN, store: store.keys.slot(workspaceKeyName(id, 'jar')) });
        expect(server.sessions.get(jar.session()!.value)?.appUserId).toBe('u-ada');
    });

    it('the password is in no stored byte, no keychain value, no registry row and no log', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const bob = staged(await signIn(server, 'bob@example.test', PASSWORDS.bob));
        await commit(store, bob);
        // A refused one, a cancelled one, and another person's after a wipe.
        await signIn(server, 'ada@example.test', 'not-her-password');
        const ada = staged(await signIn(server, 'ada@example.test', PASSWORDS.ada));
        const check = await checkPerson(store, ORIGIN, { kind: 'signed-in', appUserId: ada.appUserId });
        expect(check).toMatchObject({ kind: 'other-person', unsent: 0 });
        await ada.cancel();
        const again = staged(await signIn(server, 'ada@example.test', PASSWORDS.ada));
        for (const previous of check.kind === 'other-person' ? check.previous : []) {
            await wipe(store, previous.id, 'other-person');
        }
        await commit(store, again);

        for (const password of Object.values(PASSWORDS)) {
            for (const { path, bytes } of files(device.root)) {
                expect(bytes.includes(password), path).toBe(false);
                expect(bytes.includes(Buffer.from(password, 'utf16le')), path).toBe(false);
            }
            for (const [name, value] of device.keychain) {
                expect(value.includes(password), name).toBe(false);
            }
            expect(JSON.stringify(await store.registry.list())).not.toContain(password);
        }
        for (const spy of consoleSpies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it('a refused sign-in, or one whose session check fails, leaves nothing on the phone', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        await addWorkspace(store, 'https://other.example.test', 'u-zed');
        const before = phoneState();

        const refused = await signIn(server, 'ada@example.test', 'wrong');
        expect(refused).toMatchObject({ ok: false, problem: { kind: 'wrong-credentials' } });
        expect(phoneState()).toEqual(before);

        // The cookie lands in the staging jar, then the session check finds nobody: still nothing on the phone.
        const lost = await signInWithPassword({
            origin: ORIGIN,
            email: 'ada@example.test',
            password: PASSWORDS.ada,
            fetch: async (url, init) =>
                new URL(url).pathname === SESSION_PATH
                    ? answer(200, { body: { provider: 'betterauth', branding: { name: 'Acme' }, user: null } })
                    : server.fetch(url, init),
            userAgent: USER_AGENT,
        });
        expect(lost).toMatchObject({ ok: false, problem: { kind: 'not-signed-in' } });
        expect(phoneState()).toEqual(before);
        expect(await store.registry.byOrigin(ORIGIN)).toEqual([]);
    });

    it('another person: Cancel signs the new session out and changes nothing; confirming wipes the previous copy first', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const bob = await commit(store, staged(await signIn(server, 'bob@example.test', PASSWORDS.bob)));
        const before = phoneState();

        const ada = staged(await signIn(server, 'ada@example.test', PASSWORDS.ada));
        const check = await checkPerson(store, ORIGIN, { kind: 'signed-in', appUserId: ada.appUserId });
        expect(check).toEqual({
            kind: 'other-person',
            previous: [{ id: bob.id, personName: 'Bob', personEmail: 'bob@example.test', unsent: 0 }],
            unsent: 0,
        });
        const live = server.sessions.size;
        await ada.cancel();
        expect(server.sessions.size).toBe(live - 1);
        expect(ada.jar.discarded).toBe(true);
        expect(phoneState()).toEqual(before);

        // Confirmed: the previous person's copy goes (signed out first), then the commit.
        const confirmed = staged(await signIn(server, 'ada@example.test', PASSWORDS.ada));
        await wipe(store, bob.id, 'other-person');
        const committed = await commit(store, confirmed);
        expect(committed.kind).toBe('new');
        expect((await store.registry.byOrigin(ORIGIN)).map((row) => row.appUserId)).toEqual(['u-ada']);
    });

    it('a commit that refuses or rolls back signs the staged session out; one that commits keeps it', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const logouts = () => server.fetch.calls.filter((call) => new URL(call.url).pathname === LOGOUT_PATH).length;
        const bob = staged(await signIn(server, 'bob@example.test', PASSWORDS.bob));
        await commit(store, bob);
        expect([...server.sessions.values()].map((account) => account.appUserId)).toEqual(['u-bob']);
        expect(logouts()).toBe(0);

        // Refused: Bob's copy is still on the phone. Ada's new session ends, and Cancel after it sends nothing.
        const refused = staged(await signIn(server, 'ada@example.test', PASSWORDS.ada));
        await expect(commit(store, refused)).rejects.toMatchObject({ name: 'SignInCommitError', step: 'check' });
        expect(logouts()).toBe(1);
        await refused.cancel();
        expect(logouts()).toBe(1);

        // Rolled back: a failure after the jar step. That session ends too.
        const failed = staged(await signIn(server, 'ada@example.test', PASSWORDS.ada));
        await wipe(store, (await store.registry.byOrigin(ORIGIN))[0].id, 'other-person');
        await expect(
            commitSignIn(
                store,
                { ...failed, name: failed.workspaceName },
                {
                    hash: sha256,
                    afterStep: (step) => {
                        if (step === 'jar') {
                            throw new Error('injected');
                        }
                    },
                },
            ),
        ).rejects.toMatchObject({ name: 'SignInCommitError', step: 'jar', rolledBack: true });
        expect(logouts()).toBe(2);
        expect(failed.jar.discarded).toBe(true);
        // Only Bob's session is left on the server (Ada's is signed out before the wipe): none of Ada's.
        expect([...server.sessions.values()].map((account) => account.appUserId)).toEqual(['u-bob']);
    });

    it('the same person again keeps their files and replaces the jar', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const first = await commit(store, staged(await signIn(server, 'ada@example.test', PASSWORDS.ada)));
        const userDb = join(workspaceLayout(store.root, first.id).directory, USER_DB);
        const bytes = readFileSync(userDb);
        const again = staged(await signIn(server, 'ada@example.test', PASSWORDS.ada));
        expect(await checkPerson(store, ORIGIN, { kind: 'signed-in', appUserId: again.appUserId })).toEqual({
            kind: 'same-person',
            id: first.id,
        });
        expect(await commit(store, again)).toEqual({ id: first.id, kind: 'same-person' });
        expect(readFileSync(userDb).equals(bytes)).toBe(true);
        const jar = await openCookieJar({ origin: ORIGIN, store: store.keys.slot(workspaceKeyName(first.id, 'jar')) });
        expect(jar.session()?.value).toBe('tok2.c2ln');
    });

    it('BANNED_USER for a person on the phone: the deactivated line, and their copy is wiped silently', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const ada = await commit(store, staged(await signIn(server, 'ada@example.test', PASSWORDS.ada)));
        server.accounts[0].banned = true;

        const result = await signIn(server, 'ada@example.test', PASSWORDS.ada);
        if (result.ok) {
            throw new Error('Expected BANNED_USER.');
        }
        expect(signInCopy(result.problem).message).toBe(DEACTIVATED_MESSAGE);
        const check = await checkPerson(store, ORIGIN, { kind: 'deactivated', email: 'ada@example.test' });
        expect(check).toEqual({ kind: 'deactivated', wipe: [ada.id] });
        for (const id of check.kind === 'deactivated' ? check.wipe : []) {
            await wipe(store, id, 'deactivated');
        }
        expect(await store.registry.list()).toEqual([]);
        expect(await store.registry.active()).toBeNull();
    });
});

// The SignIn screen's flow: the same steps, run by signInAndCommit.
// Each case commits up to three workspaces (six encrypted databases): slow on a loaded machine.
describe('signInAndCommit', { timeout: 20_000 }, () => {
    const deps = (store: Store, server: ReturnType<typeof workspace>): SignInFlowDeps => ({
        store,
        hash: sha256,
        fetch: server.fetch,
        userAgent: USER_AGENT,
        now: () => T0,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });
    const request = (email: string, password: string, logo: string | null = null) => ({
        origin: ORIGIN,
        email,
        password,
        logo,
    });

    it('a new workspace commits at once, with the logo name it is given', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const outcome = await signInAndCommit(
            request('ada@example.test', PASSWORDS.ada, 'logo.png'),
            deps(store, server),
        );
        expect(outcome).toMatchObject({ kind: 'committed', committed: 'new' });
        const id = outcome.kind === 'committed' ? outcome.id : '';
        expect(await store.registry.get(id)).toMatchObject({ state: 'ready', logo: 'logo.png', appUserId: 'u-ada' });
        expect(await store.registry.active()).toBe(id);
        const again = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        expect(again).toEqual({ kind: 'committed', id, committed: 'same-person' });
    });

    it('a refusal is its problem and leaves the phone as it was', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const before = phoneState();
        const outcome = await signInAndCommit(request('ada@example.test', 'not-her-password'), deps(store, server));
        expect(outcome).toEqual({
            kind: 'problem',
            problem: { kind: 'wrong-credentials', status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' },
            wiped: [],
        });
        expect(phoneState()).toEqual(before);
    });

    it('BANNED_USER wipes that person’s copy silently and says so', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const first = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        server.accounts[0].banned = true;
        const outcome = await signInAndCommit(request('Ada@example.test', PASSWORDS.ada), deps(store, server));
        expect(outcome).toMatchObject({ kind: 'problem', problem: { kind: 'deactivated', status: 403 } });
        expect(outcome.kind === 'problem' && outcome.wiped).toEqual([first.kind === 'committed' ? first.id : '']);
        expect(await store.registry.list()).toEqual([]);
    });

    it('another person: Cancel signs the new session out and changes nothing', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        await signInAndCommit(request('bob@example.test', PASSWORDS.bob), deps(store, server));
        const before = phoneState();
        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        if (outcome.kind !== 'other-person') {
            throw new Error(`Expected other-person, got ${outcome.kind}.`);
        }
        expect(outcome.unsent).toBe(0);
        expect([...server.sessions.values()].map((account) => account.appUserId)).toEqual(['u-bob', 'u-ada']);
        await outcome.cancel();
        expect([...server.sessions.values()].map((account) => account.appUserId)).toEqual(['u-bob']);
        expect(phoneState()).toEqual(before);
        await expect(outcome.confirm()).rejects.toThrow('already answered');
    });

    it('another person: confirming signs the old session out, wipes the old copy, then commits', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const bob = await signInAndCommit(request('bob@example.test', PASSWORDS.bob), deps(store, server));
        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        if (outcome.kind !== 'other-person') {
            throw new Error(`Expected other-person, got ${outcome.kind}.`);
        }
        const committed = await outcome.confirm();
        expect(committed).toMatchObject({ kind: 'committed', committed: 'new' });
        // Bob's session ended on the server before his copy went; only Ada's is left.
        expect([...server.sessions.values()].map((account) => account.appUserId)).toEqual(['u-ada']);
        expect(await store.registry.get(bob.kind === 'committed' ? bob.id : '')).toBeNull();
        expect((await store.registry.byOrigin(ORIGIN)).map((row) => row.appUserId)).toEqual(['u-ada']);
        expect(device.keychain.has(workspaceKeyName(bob.kind === 'committed' ? bob.id : '', 'jar'))).toBe(false);
        await expect(outcome.cancel()).rejects.toThrow('already answered');
    });

    it('the person’s own copy still pending: unfinished, and the new session is signed out', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const id = await workspaceId(sha256, ORIGIN, 'u-ada');
        await store.registry.add({
            id,
            origin: ORIGIN,
            appUserId: 'u-ada',
            name: 'Acme',
            personName: null,
            personEmail: null,
        });
        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        expect(outcome).toEqual({ kind: 'unfinished' });
        expect(server.sessions.size).toBe(0);
        expect((await store.registry.get(id))?.state).toBe('pending');
    });

    it('the password is in no stored byte, keychain value or log after any of them', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        await signInAndCommit(request('bob@example.test', PASSWORDS.bob), deps(store, server));
        await signInAndCommit(request('ada@example.test', 'wrong-password-1'), deps(store, server));
        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        if (outcome.kind === 'other-person') {
            await outcome.confirm();
        }
        for (const password of Object.values(PASSWORDS)) {
            for (const { path, bytes } of files(device.root)) {
                expect(bytes.includes(password), path).toBe(false);
            }
            for (const [name, value] of device.keychain) {
                expect(value.includes(password), name).toBe(false);
            }
        }
        for (const spy of consoleSpies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });
});

// The install id: the manifest checked and the install id staged before the sign-in.
describe('signInAndCommit with the manifest and the install id', { timeout: 20_000 }, () => {
    const deps = (store: Store, server: ReturnType<typeof workspace>): SignInFlowDeps => ({
        store,
        hash: sha256,
        fetch: server.fetch,
        userAgent: USER_AGENT,
        now: () => T0,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });
    const request = (email: string, password: string) => ({ origin: ORIGIN, email, password, logo: null });
    const manifest = (id: string) => ({
        id,
        origin: ORIGIN,
        name: 'Acme',
        branding: { name: 'Acme', logo: '/favicon.svg' },
        methods: { password: true, passkey: false, sheet: false, signInCodes: null, addDevice: false },
        serverVersion: '0.40.0',
        protocol: 1,
        policy: { leaseDays: 21, wipeDays: 9, appLock: false, notificationText: true },
    });
    const installSent = (server: ReturnType<typeof workspace>, path: string) =>
        server.fetch.calls
            .filter((call) => new URL(call.url).pathname === path)
            .map((call) => sentHeaders(call)['x-socio-install']);

    it('sends a new install id with the sign-in and moves it into the workspace’s slot at the commit', async () => {
        const server = workspace();
        server.served.manifest = manifest('ws_acme');
        const { store } = await launch(device, { now: () => T0 });
        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        expect(outcome).toMatchObject({ kind: 'committed', committed: 'new' });
        const id = outcome.kind === 'committed' ? outcome.id : '';
        const [sent] = installSent(server, SIGN_IN_PATH);
        expect(sent).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // The session check goes with it too: every request of the sign-in does.
        expect(installSent(server, SESSION_PATH)).toEqual([sent]);
        expect(await store.keys.read(workspaceKeyName(id, 'install'))).toBe(sent);
        expect(await store.registry.get(id)).toMatchObject({
            serverWorkspaceId: 'ws_acme',
            leaseDays: 21,
            wipeDays: 9,
        });
    });

    it('signing in again stays the same device: the kept install id goes, and the manifest is read again', async () => {
        const server = workspace();
        server.served.manifest = manifest('ws_acme');
        const { store } = await launch(device, { now: () => T0 });
        const first = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        const id = first.kind === 'committed' ? first.id : '';
        const kept = await store.keys.read(workspaceKeyName(id, 'install'));
        server.served.manifest = { ...manifest('ws_acme'), policy: { ...manifest('ws_acme').policy, leaseDays: 5 } };
        // Signing in again comes with no manifest from a probe: the flow reads it itself.
        const again = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        expect(again).toEqual({ kind: 'committed', id, committed: 'same-person' });
        expect(installSent(server, SIGN_IN_PATH)).toEqual([kept, kept]);
        expect(await store.keys.read(workspaceKeyName(id, 'install'))).toBe(kept);
        expect(await store.registry.get(id)).toMatchObject({ leaseDays: 5 });
    });

    it('refuses a saved origin whose manifest names another workspace, sending nothing to it', async () => {
        const server = workspace();
        server.served.manifest = manifest('ws_acme');
        const { store } = await launch(device, { now: () => T0 });
        await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        server.served.manifest = manifest('ws_someone_else');
        const before = phoneState();
        const calls = server.fetch.calls.length;
        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        expect(outcome).toEqual({
            kind: 'problem',
            problem: { kind: 'workspace-changed', status: null, code: null },
            wiped: [],
        });
        expect(signInCopy(outcome.kind === 'problem' ? outcome.problem : (null as never)).message).toMatch(
            /different workspace/,
        );
        // Only the manifest was asked: no password went.
        expect(server.fetch.calls.slice(calls).map((call) => new URL(call.url).pathname)).toEqual([
            '/.well-known/socio/workspace',
        ]);
        expect(phoneState()).toEqual(before);
    });

    it('on today’s servers (no manifest) signs in as before, with no workspace id kept', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        const id = outcome.kind === 'committed' ? outcome.id : '';
        expect(await store.registry.get(id)).toMatchObject({ serverWorkspaceId: null, leaseDays: null });
        // A server that gains a manifest later is checked from then on, never refused for having none before.
        server.served.manifest = manifest('ws_acme');
        expect(await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server))).toMatchObject({
            kind: 'committed',
        });
        expect(await store.registry.get(id)).toMatchObject({ serverWorkspaceId: 'ws_acme' });
    });

    it('a refused sign-in leaves no install id behind', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const before = phoneState();
        await signInAndCommit(request('ada@example.test', 'wrong'), deps(store, server));
        expect(installSent(server, SIGN_IN_PATH)).toHaveLength(1);
        expect(phoneState()).toEqual(before);
        expect((await store.keys.indexed()).filter((name) => name.endsWith('.install'))).toEqual([]);
    });

    it('another person never gets someone else’s install id: a fresh one, and Cancel leaves the first person’s', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const bob = await signInAndCommit(request('bob@example.test', PASSWORDS.bob), deps(store, server));
        const bobId = bob.kind === 'committed' ? bob.id : '';
        const bobInstall = await store.keys.read(workspaceKeyName(bobId, 'install'));

        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        if (outcome.kind !== 'other-person') {
            throw new Error(`Expected other-person, got ${outcome.kind}.`);
        }
        const [, adaSent] = installSent(server, SIGN_IN_PATH);
        expect(adaSent).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(adaSent).not.toBe(bobInstall);
        await outcome.cancel();
        expect(await store.keys.read(workspaceKeyName(bobId, 'install'))).toBe(bobInstall);
        expect(await store.registry.get(bobId)).toMatchObject({ state: 'ready', installSetAt: expect.any(Number) });
    });

    it('confirming another person commits their own install id, never the previous person’s', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const bob = await signInAndCommit(request('bob@example.test', PASSWORDS.bob), deps(store, server));
        const bobInstall = await store.keys.read(workspaceKeyName(bob.kind === 'committed' ? bob.id : '', 'install'));
        const outcome = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        if (outcome.kind !== 'other-person') {
            throw new Error(`Expected other-person, got ${outcome.kind}.`);
        }
        const committed = await outcome.confirm();
        const adaId = committed.kind === 'committed' ? committed.id : '';
        const adaInstall = await store.keys.read(workspaceKeyName(adaId, 'install'));
        expect(adaInstall).not.toBeNull();
        expect(adaInstall).not.toBe(bobInstall);
        expect(adaInstall).toBe(installSent(server, SIGN_IN_PATH)[1]);
    });

    it('the same person typed in another case keeps the id; a key this build never recorded isn’t reused', async () => {
        const server = workspace();
        const { store } = await launch(device, { now: () => T0 });
        const first = await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        const id = first.kind === 'committed' ? first.id : '';
        const kept = await store.keys.read(workspaceKeyName(id, 'install'));
        await signInAndCommit(request('  ADA@example.test ', PASSWORDS.ada), deps(store, server));
        expect(installSent(server, SIGN_IN_PATH)[1]).toBe(kept);

        // As after an older build's wipe and re-add: the key is there, the record isn't.
        await store.registry.setInstallSet(id, null);
        await signInAndCommit(request('ada@example.test', PASSWORDS.ada), deps(store, server));
        const fresh = installSent(server, SIGN_IN_PATH)[2];
        expect(fresh).not.toBe(kept);
        expect(await store.keys.read(workspaceKeyName(id, 'install'))).toBe(fresh);
        expect(await store.registry.get(id)).toMatchObject({ installSetAt: expect.any(Number) });
    });
});
