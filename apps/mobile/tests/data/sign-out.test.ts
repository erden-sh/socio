import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    isPushRevocationKey,
    isRevocationKey,
    parseRevocation,
    retryRevocations,
    type SignOutDeps,
    type SignOutStep,
    signOutWorkspace,
    type Store,
    workspaceKeyName,
    workspaceKeyNames,
    workspaceLayout,
} from '../../src/data';
import { openCookieJar } from '../../src/net/cookie-jar';
import { type RelayWriteOutcome, retryPushRevocations } from '../../src/push';
import { addWorkspace, type AddedWorkspace, kill, launch, nodeRandomBytes, phone, type Phone } from '../helpers/store';
import { answer, type Call, fakeFetch, ORIGIN, SESSION, sentHeaders, sessionSetCookie } from '../net/helpers';

// Signing out (src/data/sign-out.ts) on a real temporary directory:
// the scope stops, the workspace is marked, a pending-revocation record is
// kept, logout goes with the session cookie alone, and the wipe leaves nothing
// of the workspace (`images/`, `attachments/`, `-wal`, `-shm`, its logo and a
// staged logo included). The record outlives the wipe when logout gets no
// answer, holds only the origin and the session cookie, and goes on the next
// answer. A kill between any two steps is finished by the next launch.

let device: Phone;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-sign-out-')));
});
afterEach(() => {
    rmSync(device.root, { recursive: true, force: true });
});

const socio = () => join(device.root, 'socio');
const everything = () => readdirSync(device.root, { recursive: true, encoding: 'utf8' }).sort();
const TOKEN = 'session-token-1';

/** A workspace with everything a sign-out must remove, and a jar holding a live session. */
async function planted(store: Store): Promise<AddedWorkspace> {
    const workspace = await addWorkspace(store, ORIGIN, 'seed-user-001', { plant: true });
    const layout = workspaceLayout(store.root, workspace.id);
    writeFileSync(join(layout.directory, 'logo.png'), 'png');
    mkdirSync(join(socio(), 'staging'));
    writeFileSync(join(socio(), 'staging', 'logo-1.png'), 'png');
    const jar = await openCookieJar({ origin: ORIGIN, store: store.keys.slot(workspaceKeyName(workspace.id, 'jar')) });
    await jar.apply(new URL('/api/auth/sign-in/email', ORIGIN), [sessionSetCookie(TOKEN), 'theme=dark; Path=/'], null);
    await jar.close();
    // The files are there, -wal and -shm included, as Diagnostics' Plant test files leaves them.
    const files = readdirSync(layout.directory, { recursive: true, encoding: 'utf8' });
    for (const name of ['cache.db-wal', 'user.db-shm', 'images/logo.png', 'attachments/a1.jpg', 'logo.png']) {
        expect(files).toContain(name);
    }
    return workspace;
}

interface Run {
    readonly deps: SignOutDeps;
    readonly events: string[];
    readonly fetch: ReturnType<typeof fakeFetch>;
}

function run(
    store: Store,
    respond: (url: string) => Response | Promise<Response>,
    extra: Partial<SignOutDeps> = {},
): Run {
    const events: string[] = [];
    const fetch = fakeFetch(async (url) => {
        events.push(`fetch ${new URL(url).pathname}`);
        return respond(url);
    });
    const deps: SignOutDeps = {
        store,
        fetch,
        userAgent: 'Socio/0.1 (test)',
        randomBytes: nodeRandomBytes,
        stopScope: async () => {
            events.push('stop scope');
            // The scope's dispose: its two databases close; the registry stays open.
            for (const file of store.driver.openFiles().filter((open) => open.name !== 'registry.db')) {
                await store.driver.closeFile(file);
            }
        },
        clearImageMemory: async () => {
            events.push('clear image memory');
        },
        clearWebViewData: async () => {
            events.push('clear webview data');
        },
        afterStep: (step) => {
            events.push(step);
        },
        ...extra,
    };
    return { deps, events, fetch };
}

/**
 * Nothing of `workspace` is on the phone: files, secrets, index entries, row;
 * and, after a sign-out that finished, nothing but the registry at all (no
 * staged logo). Launch leaves the staging directory to Add workspace.
 */
async function nothingLeft(store: Store, workspace: AddedWorkspace, { finished = true } = {}): Promise<void> {
    expect(everything().filter((path) => path.includes(workspace.id))).toEqual([]);
    if (finished) {
        expect(everything().filter((path) => !path.startsWith('socio/registry.db') && path !== 'socio')).toEqual([]);
    }
    for (const name of workspaceKeyNames(workspace.id)) {
        expect(device.keychain.has(name)).toBe(false);
    }
    expect((await store.keys.indexed()).filter((name) => name.includes(workspace.id))).toEqual([]);
    expect(await store.registry.get(workspace.id)).toBeNull();
}

const revocations = () => [...device.keychain.keys()].filter(isRevocationKey);
const pushRecords = () => [...device.keychain.keys()].filter(isPushRevocationKey);
const SUBSCRIPTION = 'sub-1';

function expectLogout(call: Call | undefined) {
    expect(call?.url).toBe(`${ORIGIN}/api/auth/logout`);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.body).toBe('{}');
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.redirect).toBe('error');
    const headers = sentHeaders(call);
    expect(headers.origin).toBe(ORIGIN);
    expect(headers['content-type']).toBe('application/json');
    // The session cookie alone: the record holds nothing else.
    expect(headers.cookie).toBe(`${SESSION}=${TOKEN}`);
}

describe('signOutWorkspace', () => {
    it('stops the scope, marks, records, logs out, wipes, then clears the images and the WebViews, in that order', async () => {
        const { store } = await launch(device);
        const workspace = await planted(store);
        await store.registry.setActive(workspace.id);
        const { deps, events, fetch } = run(store, () => answer(200, { body: { success: true } }));

        await expect(signOutWorkspace(deps, workspace.id)).resolves.toEqual({ revocation: 'answered' });

        expect(events).toEqual([
            'stop scope',
            'stopped',
            'marked',
            'recorded',
            'unsubscribed',
            'fetch /api/auth/logout',
            'requested',
            'wiped',
            'clear image memory',
            'images-cleared',
            'clear webview data',
            'webview-cleared',
        ]);
        expect(fetch.calls).toHaveLength(1);
        expectLogout(fetch.calls[0]);
        await nothingLeft(store, workspace);
        expect(revocations()).toEqual([]);
        expect(await store.registry.active()).toBeNull();
    });

    it('drops the record on any HTTP answer, an error status included', async () => {
        const { store } = await launch(device);
        const workspace = await planted(store);
        const { deps } = run(store, () => answer(500));
        await expect(signOutWorkspace(deps, workspace.id)).resolves.toEqual({ revocation: 'answered' });
        expect(revocations()).toEqual([]);
        await nothingLeft(store, workspace);
    });

    it('wipes with no answer, and keeps a record of the origin and the session cookie alone', async () => {
        const { store } = await launch(device);
        const workspace = await planted(store);
        const { deps } = run(store, () => Promise.reject(new TypeError('Network request failed')));

        await expect(signOutWorkspace(deps, workspace.id)).resolves.toEqual({ revocation: 'pending' });

        await nothingLeft(store, workspace);
        const names = revocations();
        expect(names).toHaveLength(1);
        expect(await store.keys.indexed()).toContain(names[0]);
        const stored = JSON.parse(device.keychain.get(names[0]!)!) as Record<string, unknown>;
        expect(stored).toEqual({ v: 1, origin: ORIGIN, name: SESSION, value: TOKEN });
        expect(names[0]).not.toContain(workspace.id);

        // It survives a relaunch's reconcile, then goes on the next answer, and only then.
        const again = await launch(device);
        expect(revocations()).toEqual(names);
        const offline = fakeFetch(() => Promise.reject(new TypeError('Network request failed')));
        await expect(
            retryRevocations(again.store.keys, { fetch: offline, userAgent: 'Socio/0.1 (test)' }),
        ).resolves.toBe(1);
        expect(revocations()).toEqual(names);
        const online = fakeFetch(() => answer(401));
        await expect(
            retryRevocations(again.store.keys, { fetch: online, userAgent: 'Socio/0.1 (test)' }),
        ).resolves.toBe(0);
        expectLogout(online.calls[0]);
        expect(revocations()).toEqual([]);
        expect((await again.store.keys.indexed()).filter(isRevocationKey)).toEqual([]);
    });

    it('sends nothing and keeps no record when the jar holds no session', async () => {
        const { store } = await launch(device);
        const workspace = await addWorkspace(store, ORIGIN, 'seed-user-001');
        const { deps, fetch } = run(store, () => answer(200));
        await expect(signOutWorkspace(deps, workspace.id)).resolves.toEqual({ revocation: 'none' });
        expect(fetch.calls).toEqual([]);
        expect(revocations()).toEqual([]);
        await nothingLeft(store, workspace);
    });

    it('leaves the other workspaces as they were', async () => {
        const { store } = await launch(device);
        const workspace = await planted(store);
        const other = await addWorkspace(store, 'https://other.example.test', 'seed-user-002');
        const { deps } = run(store, () => answer(200));
        await signOutWorkspace(deps, workspace.id);
        expect(existsSync(join(socio(), other.id))).toBe(true);
        for (const name of workspaceKeyNames(other.id)) {
            expect(device.keychain.has(name)).toBe(true);
        }
        expect(await store.registry.get(other.id)).toMatchObject({ state: 'ready' });
    });

    it('deletes the push subscription once, with the session cookie alone, before logout', async () => {
        const { store } = await launch(device);
        const workspace = await planted(store);
        await store.registry.setPush(workspace.id, {
            registrationId: workspace.id.slice(0, 22),
            pushKey: 'key',
            nativeToken: 'token',
            subscriptionId: SUBSCRIPTION,
        });
        const { deps, events, fetch } = run(store, () => answer(200));

        await expect(signOutWorkspace(deps, workspace.id)).resolves.toEqual({ revocation: 'answered' });

        expect(events.slice(3, 8)).toEqual([
            'recorded',
            `fetch /api/notifications/push/subscriptions/${SUBSCRIPTION}`,
            'unsubscribed',
            'fetch /api/auth/logout',
            'requested',
        ]);
        expect(fetch.calls).toHaveLength(2);
        const call = fetch.calls[0];
        expect(call?.url).toBe(`${ORIGIN}/api/notifications/push/subscriptions/${SUBSCRIPTION}`);
        expect(call?.init.method).toBe('DELETE');
        expect(call?.init.credentials).toBe('omit');
        expect(sentHeaders(call).cookie).toBe(`${SESSION}=${TOKEN}`);
        expect(sentHeaders(call).origin).toBe(ORIGIN);
        expectLogout(fetch.calls[1]);
        await nothingLeft(store, workspace);
        // The relay registration waits in its own record, for the relay.
        expect(pushRecords()).toHaveLength(1);
    });

    it('offline: wipes, keeps both records, and the relay DELETE goes on return', async () => {
        const { store } = await launch(device);
        const workspace = await planted(store);
        await store.registry.setPush(workspace.id, {
            registrationId: workspace.id.slice(0, 22),
            subscriptionId: SUBSCRIPTION,
        });
        const relayKept = JSON.parse(device.keychain.get(workspaceKeyName(workspace.id, 'relay'))!) as {
            id: string;
            secret: string;
        };
        const { deps, fetch } = run(store, () => Promise.reject(new TypeError('Network request failed')));

        await expect(signOutWorkspace(deps, workspace.id)).resolves.toEqual({ revocation: 'pending' });
        // The subscription's DELETE was tried once and isn't kept: the relay's 410 settles it.
        expect(fetch.calls.map((call) => new URL(call.url).pathname)).toEqual([
            `/api/notifications/push/subscriptions/${SUBSCRIPTION}`,
            '/api/auth/logout',
        ]);
        await nothingLeft(store, workspace);
        expect(revocations()).toHaveLength(1);
        expect(pushRecords()).toHaveLength(1);

        const again = await launch(device);
        const removes: string[] = [];
        const relay = (outcome: RelayWriteOutcome) => ({
            remove: async (id: string, secret: string) => {
                removes.push(`${id} ${secret}`);
                return outcome;
            },
        });
        await expect(retryPushRevocations(again.store.keys, relay({ kind: 'offline' }))).resolves.toBe(1);
        expect(pushRecords()).toHaveLength(1);
        await expect(retryPushRevocations(again.store.keys, relay({ kind: 'done' }))).resolves.toBe(0);
        expect(pushRecords()).toEqual([]);
        expect(removes).toEqual([`${relayKept.id} ${relayKept.secret}`, `${relayKept.id} ${relayKept.secret}`]);
        // The logout record is its own, untouched by the relay's.
        expect(revocations()).toHaveLength(1);
    });

    const STEPS: readonly SignOutStep[] = [
        'stopped',
        'marked',
        'recorded',
        'unsubscribed',
        'requested',
        'wiped',
        'images-cleared',
        'webview-cleared',
    ];
    it.each(STEPS)('is finished by the next launch after a kill once %s', async (killedAt) => {
        const first = await launch(device);
        const workspace = await planted(first.store);
        const { deps } = run(first.store, () => answer(200), {
            afterStep: (step) => {
                if (step === killedAt) {
                    throw new Error(`killed after ${step}`);
                }
            },
        });
        await expect(signOutWorkspace(deps, workspace.id)).rejects.toThrow(`killed after ${killedAt}`);
        await kill(first.store);

        const next = await launch(device);
        if (killedAt === 'stopped') {
            // Nothing was marked: the workspace is as it was, and the person signs out again.
            expect(await next.store.registry.get(workspace.id)).toMatchObject({ state: 'ready' });
            expect(revocations()).toEqual([]);
            return;
        }
        await nothingLeft(next.store, workspace, {
            finished: killedAt === 'wiped' || killedAt === 'images-cleared' || killedAt === 'webview-cleared',
        });
        // The wipe, run or resumed, kept the push registration's record.
        expect(pushRecords()).toHaveLength(1);
        // Killed before the answer dropped it: the record waits for the next try.
        expect(revocations()).toHaveLength(killedAt === 'recorded' || killedAt === 'unsubscribed' ? 1 : 0);
        if (killedAt === 'recorded' || killedAt === 'unsubscribed') {
            const record = parseRevocation(device.keychain.get(revocations()[0]!)!);
            expect(record).toEqual({ origin: ORIGIN, cookie: { name: SESSION, value: TOKEN } });
        }
    });

    it('runs again after a wipe that failed, and finishes it', async () => {
        const { store } = await launch(device);
        const workspace = await planted(store);
        let fail = true;
        const { deps } = run(store, () => answer(200), {
            wipeOptions: {
                afterStep: (step) => {
                    if (step === 'row-deleted' && fail) {
                        fail = false;
                        throw new Error('the check found something');
                    }
                },
            },
        });
        await expect(signOutWorkspace(deps, workspace.id)).rejects.toThrow('the check found something');
        await expect(signOutWorkspace(deps, workspace.id)).resolves.toEqual({ revocation: 'none' });
        await nothingLeft(store, workspace);
    });
});
