import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LEAVE_REFUSAL_MESSAGES, LEAVE_WORKSPACE_PATH } from '@socio/shared/leave-workspace';

import { signOutWorkspace, type Store, workspaceKeyName } from '../../src/data';
import {
    LEAVE_CHECK_FAILED,
    LEAVE_FAILED,
    LEAVE_NO_ANSWER,
    leaveWorkspace,
    readLeaveCheck,
} from '../../src/data/leave-workspace';
import { createAuthedFetch } from '../../src/net/authed-fetch';
import { openCookieJar } from '../../src/net/cookie-jar';
import { NetworkError } from '../../src/net/errors';
import { LEAVE_REFUSED_TITLE, LEAVE_WORKSPACE, leaveQuestion, leaveRow } from '../../src/shell/account';
import { addWorkspace, type AddedWorkspace, launch, nodeRandomBytes, phone, type Phone } from '../helpers/store';
import { answer, fakeFetch, ORIGIN, SESSION, sentHeaders, sessionSetCookie } from '../net/helpers';

// Leave workspace (CB-383; shared's leave-workspace.ts):
// the check's states, the leave's outcomes on a real store (only a 200
// wipes; a 409, another answer or none keeps every file and secret), the
// confirmation on the wire, and the alert's words.

let device: Phone;
beforeEach(() => {
    device = phone(mkdtempSync(join(tmpdir(), 'socio-leave-')));
});
afterEach(() => {
    rmSync(device.root, { recursive: true, force: true });
});
/** A new phone, for a loop that runs several cases in one test. */
function freshDevice() {
    rmSync(device.root, { recursive: true, force: true });
    device = phone(mkdtempSync(join(tmpdir(), 'socio-leave-')));
}

const everything = () => readdirSync(device.root, { recursive: true, encoding: 'utf8' }).sort();
const TOKEN = 'session-token-1';

/** A signed-in workspace with files and a live session in its jar. */
async function signedIn(store: Store): Promise<AddedWorkspace> {
    const workspace = await addWorkspace(store, ORIGIN, 'seed-user-001', { plant: true });
    const jar = await openCookieJar({ origin: ORIGIN, store: store.keys.slot(workspaceKeyName(workspace.id, 'jar')) });
    await jar.apply(new URL('/api/auth/sign-in/email', ORIGIN), [sessionSetCookie(TOKEN)], null);
    await jar.close();
    await store.registry.setActive(workspace.id);
    return workspace;
}

/** The workspace's authedFetch on its own jar, as its scope's, over `respond`. */
async function scopeFetch(store: Store, id: string, respond: (url: string) => Response | Promise<Response>) {
    const wire = fakeFetch((url) => respond(url));
    const jar = await openCookieJar({ origin: ORIGIN, store: store.keys.slot(workspaceKeyName(id, 'jar')) });
    const stop = new AbortController();
    const fetch = createAuthedFetch({
        origin: ORIGIN,
        jar,
        fetch: wire,
        userAgent: 'Socio/0.1 (test)',
        signal: stop.signal,
    });
    return { fetch, wire, close: () => jar.close() };
}

/** The sign-out's wipe, as src/platform/sign-out.ts runs it for a leave. */
function signOutWipe(store: Store, id: string, events: string[]) {
    return async () => {
        events.push('wipe');
        await signOutWorkspace(
            {
                store,
                fetch: fakeFetch(() => answer(401, { body: { code: 'deactivated' } })),
                userAgent: 'Socio/0.1 (test)',
                randomBytes: nodeRandomBytes,
                stopScope: async () => {
                    for (const file of store.driver.openFiles().filter((open) => open.name !== 'registry.db')) {
                        await store.driver.closeFile(file);
                    }
                },
                clearImageMemory: async () => undefined,
                clearWebViewData: async () => undefined,
            },
            id,
        );
    };
}

describe('the check (GET /api/account/leave)', () => {
    const check = async (respond: () => Response | Promise<Response>) => {
        const { store } = await launch(device);
        const workspace = await signedIn(store);
        const { fetch, wire, close } = await scopeFetch(store, workspace.id, respond);
        const result = await readLeaveCheck(fetch);
        await close();
        return { result, wire };
    };

    it('asks the path with a GET and no body, and reads allowed', async () => {
        const { result, wire } = await check(() => answer(200, { body: { allowed: true, refusal: null } }));
        expect(result).toEqual({ kind: 'allowed' });
        expect(wire.calls).toHaveLength(1);
        expect(wire.calls[0]?.url).toBe(`${ORIGIN}${LEAVE_WORKSPACE_PATH}`);
        expect(wire.calls[0]?.init.method ?? 'GET').toBe('GET');
        expect(wire.calls[0]?.init.body ?? null).toBeNull();
        expect(leaveRow(result)).toEqual({ enabled: true, note: null });
    });

    it('reads a refusal with the server’s sentence, shown under the row turned off', async () => {
        const message = LEAVE_REFUSAL_MESSAGES.last_admin;
        const { result } = await check(() =>
            answer(200, { body: { allowed: false, refusal: { code: 'last_admin', message } } }),
        );
        expect(result).toEqual({ kind: 'refused', message });
        expect(leaveRow(result)).toEqual({ enabled: false, note: message });
    });

    it('takes a 404 (a server from before the endpoint) as unsupported, and hides the row', async () => {
        const { result } = await check(() => answer(404, { body: { error: 'Not found' } }));
        expect(result).toEqual({ kind: 'unsupported' });
        expect(leaveRow(result)).toBeNull();
    });

    it('takes no answer, another status or a body it can’t read as unknown: the row off, with our line', async () => {
        for (const respond of [
            () => Promise.reject(new TypeError('Network request failed')),
            () => answer(500, { body: { error: 'boom' } }),
            () => answer(200, { body: { allowed: 'yes' } }),
        ]) {
            const { result } = await check(respond);
            expect(result).toEqual({ kind: 'unknown' });
            expect(leaveRow(result)).toEqual({ enabled: false, note: LEAVE_CHECK_FAILED });
            freshDevice();
        }
    });

    it('shows the row off while it checks', () => {
        expect(leaveRow({ kind: 'checking' })).toEqual({ enabled: false, note: null });
    });
});

describe('leaving (POST /api/account/leave)', () => {
    async function leave(respond: () => Response | Promise<Response>) {
        const { store } = await launch(device);
        const workspace = await signedIn(store);
        const before = everything();
        const keysBefore = [...device.keychain.keys()].sort();
        const events: string[] = [];
        const { fetch, wire, close } = await scopeFetch(store, workspace.id, respond);
        const outcome = await leaveWorkspace({ fetch, wipe: signOutWipe(store, workspace.id, events) });
        await close();
        return { store, workspace, outcome, events, wire, before, keysBefore };
    }

    it('sends the confirmation as JSON, with the session and Origin', async () => {
        const { wire } = await leave(() => answer(409, { body: { error: 'no', code: 'already_left' } }));
        const call = wire.calls[0];
        expect(call?.url).toBe(`${ORIGIN}${LEAVE_WORKSPACE_PATH}`);
        expect(call?.init.method).toBe('POST');
        expect(JSON.parse(String(call?.init.body))).toEqual({ confirm: 'leave' });
        const headers = sentHeaders(call);
        expect(headers['content-type']).toBe('application/json');
        expect(headers.origin).toBe(ORIGIN);
        expect(headers.cookie).toContain(`${SESSION}=${TOKEN}`);
    });

    it('wipes the workspace’s copy on a 200, and the next workspace or Add workspace follows', async () => {
        const { store, workspace, outcome, events } = await leave(() => answer(200, { body: { ok: true } }));
        expect(outcome).toEqual({ kind: 'left' });
        expect(events).toEqual(['wipe']);
        expect(everything().filter((path) => path.includes(workspace.id))).toEqual([]);
        expect([...device.keychain.keys()].filter((name) => name.includes(workspace.id))).toEqual([]);
        expect(await store.registry.get(workspace.id)).toBeNull();
        expect(await store.registry.active()).toBeNull();
    });

    it('keeps everything on a 409 and gives the server’s reason', async () => {
        const error = LEAVE_REFUSAL_MESSAGES.last_operator;
        const { store, workspace, outcome, events, before, keysBefore } = await leave(() =>
            answer(409, { body: { error, code: 'last_operator' } }),
        );
        expect(outcome).toEqual({ kind: 'refused', message: error });
        expect(events).toEqual([]);
        expect(everything()).toEqual(before);
        expect([...device.keychain.keys()].sort()).toEqual(keysBefore);
        expect((await store.registry.get(workspace.id))?.state).toBe('ready');
    });

    it('words a 409 by its code when its text is empty', async () => {
        const { outcome } = await leave(() => answer(409, { body: { error: '', code: 'last_admin' } }));
        expect(outcome).toEqual({ kind: 'refused', message: LEAVE_REFUSAL_MESSAGES.last_admin });
    });

    it('keeps everything with no answer, and says to check the connection', async () => {
        const { store, workspace, outcome, events, before, keysBefore } = await leave(() =>
            Promise.reject(new NetworkError(ORIGIN)),
        );
        expect(outcome).toEqual({ kind: 'failed', message: LEAVE_NO_ANSWER });
        expect(events).toEqual([]);
        expect(everything()).toEqual(before);
        expect([...device.keychain.keys()].sort()).toEqual(keysBefore);
        expect((await store.registry.get(workspace.id))?.state).toBe('ready');
    });

    it('keeps everything on any other answer (400, 403, 5xx)', async () => {
        for (const status of [400, 403, 500]) {
            const { outcome, events } = await leave(() => answer(status, { body: { error: 'x' } }));
            expect(outcome).toEqual({ kind: 'failed', message: LEAVE_FAILED });
            expect(events).toEqual([]);
            freshDevice();
        }
    });
});

describe('the words', () => {
    it('asks in plain words, Cancel first, Leave workspace destructive', () => {
        expect(leaveQuestion('Acme', 0)).toEqual({
            title: 'Leave Acme?',
            message:
                'You’ll be signed out on every device and lose access. What you shared stays with the team. ' +
                'An admin can let you back in.',
            confirm: 'Leave workspace',
            cancel: 'Cancel',
        });
        expect(LEAVE_WORKSPACE).toBe('Leave workspace');
        expect(LEAVE_REFUSED_TITLE).toBe('Couldn’t leave the workspace');
    });

    it('says what unsent work the phone would lose, and never takes a count it couldn’t make as none', () => {
        expect(leaveQuestion('Acme', 1).message).toMatch(/back in\. 1 unsent item will be deleted from this phone\.$/);
        expect(leaveQuestion('Acme', 3).message).toMatch(/3 unsent items will be deleted from this phone\.$/);
        expect(leaveQuestion('Acme', null).message).toMatch(
            /Anything you haven’t sent yet will be deleted from this phone\.$/,
        );
    });

    it('the sheet asks before it leaves, and leaves through the scope’s fetch', () => {
        const sheet = readFileSync(join(import.meta.dirname, '../../src/screens/account.tsx'), 'utf8');
        expect(sheet).toContain('leaveQuestion(');
        expect(sheet).toContain("style: 'destructive'");
        expect(sheet).toContain('<LeaveWorkspace');
        expect(sheet).toMatch(/await leave\(id, fetch\)/);
    });
});
