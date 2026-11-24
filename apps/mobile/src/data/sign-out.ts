import { type AuthedFetch, createAuthedFetch } from '../net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../net/cookie-jar';
import { AbortedError, NetworkError } from '../net/errors';
import type { FetchFunction } from '../net/fetch-function';
import { readText } from '../net/read-body';
import { LOGOUT_PATH, SIGN_OUT_TIMEOUT_MS } from '../net/sign-in';

import { type Keys, newDbKey, type RandomBytes, workspaceKeyName } from './keys';
import { stagingDirectory } from './logo';
import { PUSH_SUBSCRIPTIONS_PATH } from './push-revocation';
import { type Store, wipe, type WipeOptions } from './wipe';

// Signing out of a workspace, under Node. The screen asks first when the
// workspace has unsent items (`countUnsentItems`), then:
//
// 1. stops the workspace's scope, so no pull, write or Set-Cookie reaches the
//    jar or the files from here on (a pull after the logout would also read
//    the 401 as an ended session);
// 2. marks the workspace for its wipe, so a kill from here on is finished by
//    the next launch (`resumeWipes`);
// 3. keeps a pending-revocation record in secure storage: the origin and the
//    session cookie, nothing else, under a name of its own
//    (`socio.revoke.<random>`), which is no workspace key, so the wipe and
//    launch's reconcile leave it (keys.ts), and launch retries it;
// 3a. while the session lives, `DELETE` the workspace's push subscription
//    once, with the record's cookie, and never again: an answer or
//    none, the wipe revokes the relay registration, whose 410 makes the
//    server drop the subscription at its next send;
// 4. `POST /api/auth/logout` with the record's cookie, Origin and a JSON `{}`
//    body, through authedFetch on a jar in memory: any HTTP answer drops the
//    record; no answer (offline, too slow) keeps it, and launch and each
//    return to the foreground try it again (`retryRevocations`);
// 5. wipes the workspace whatever the answer (wipe.ts, which checks nothing is
//    left, and keeps the push revocation record), deletes any staged logo, and clears the images held in memory;
// 6. resolves only then, so the caller navigates after the wipe is verified.
//
// Steps 2 and 3 come before the request, rather than after a failed one, so a
// kill while it goes leaves both: the jar the record copies is gone once the
// wipe runs. The mark comes first: a kill between the two still wipes the
// phone, and only the revocation is lost (the session ends by itself within
// a week, as a best-effort logout's does).

/** The names pending-revocation records take: `socio.revoke.<32 hex>`. */
export const REVOCATION_PREFIX = 'socio.revoke.';

const REVOCATION_NAME = /^socio\.revoke\.[0-9a-f]{32}$/;
/** The record's stored form's version. */
const REVOCATION_VERSION = 1;

/** A session the phone signed out of but the server hasn't been told about: all a record holds. */
export interface PendingRevocation {
    /** The workspace's exact origin. */
    readonly origin: string;
    /** The session cookie's name and value. */
    readonly cookie: { readonly name: string; readonly value: string };
}

/** Whether `name` is a pending-revocation record's. */
export function isRevocationKey(name: string): boolean {
    return REVOCATION_NAME.test(name);
}

/** The record's stored form: `{v, origin, name, value}`. */
export function formatRevocation(record: PendingRevocation): string {
    return JSON.stringify({
        v: REVOCATION_VERSION,
        origin: record.origin,
        name: record.cookie.name,
        value: record.cookie.value,
    });
}

/** The record in `text`, or null when it can't be read. */
export function parseRevocation(text: string): PendingRevocation | null {
    let stored: unknown;
    try {
        stored = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof stored !== 'object' || stored === null) {
        return null;
    }
    const { origin, name, value } = stored as Record<string, unknown>;
    if (typeof origin !== 'string' || typeof name !== 'string' || typeof value !== 'string' || name === '') {
        return null;
    }
    return { origin, cookie: { name, value } };
}

/** What logout needs: the app's one fetch and its User-Agent. */
export interface RevokeDeps {
    readonly fetch: FetchFunction;
    readonly userAgent: string;
}

/**
 * Tells the server the session ended: `POST /api/auth/logout` with the
 * record's cookie alone. 'answered' for any HTTP answer, 4xx and 5xx included
 * (the server has seen the cookie; it has nothing more to do with it);
 * 'unanswered' when no answer came within SIGN_OUT_TIMEOUT_MS.
 */
export async function revoke(record: PendingRevocation, deps: RevokeDeps): Promise<'answered' | 'unanswered'> {
    return withSession(record, deps, async (request, signal) => {
        const answer = await request(LOGOUT_PATH, { method: 'POST', json: {} });
        await readText(answer, signal).catch(() => undefined);
    });
}

/**
 * Deletes push subscription `subscriptionId` on the record's workspace with
 * its cookie alone: once, before logout, never again.
 */
export async function unsubscribePush(
    record: PendingRevocation,
    subscriptionId: string,
    deps: RevokeDeps,
): Promise<'answered' | 'unanswered'> {
    return withSession(record, deps, async (request, signal) => {
        const path = `${PUSH_SUBSCRIPTIONS_PATH}/${encodeURIComponent(subscriptionId)}`;
        const answer = await request(path, { method: 'DELETE' });
        await readText(answer, signal).catch(() => undefined);
    });
}

/**
 * Runs `task` with authedFetch on a jar in memory that holds the record's
 * cookie alone, at most SIGN_OUT_TIMEOUT_MS. 'answered' for any HTTP answer,
 * 'unanswered' when none came.
 */
async function withSession(
    record: PendingRevocation,
    deps: RevokeDeps,
    task: (request: AuthedFetch, signal: AbortSignal) => Promise<void>,
): Promise<'answered' | 'unanswered'> {
    const url = new URL(LOGOUT_PATH, record.origin);
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    const jar = await openCookieJar({
        origin: record.origin,
        store: memoryJarStore(),
        sessionCookie: record.cookie.name,
    });
    await jar.apply(url, [`${record.cookie.name}=${record.cookie.value}; Path=/${secure}`], null);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), SIGN_OUT_TIMEOUT_MS);
    try {
        await task(createAuthedFetch({ ...deps, origin: record.origin, jar, signal: stop.signal }), stop.signal);
        return 'answered';
    } catch (error) {
        // A refused redirect is an answer too; only no answer at all keeps the record.
        return error instanceof NetworkError || error instanceof AbortedError ? 'unanswered' : 'answered';
    } finally {
        clearTimeout(timer);
        await jar.close();
    }
}

/**
 * Tries every pending-revocation record once, at launch and on each return to
 * the foreground: an answer drops it, no answer keeps it. A record that can't
 * be read is dropped. Resolves how many are left; never rejects for a request.
 */
export async function retryRevocations(keys: Keys, deps: RevokeDeps): Promise<number> {
    let left = 0;
    for (const name of (await keys.indexed()).filter(isRevocationKey)) {
        const text = await keys.read(name);
        const record = text === null ? null : parseRevocation(text);
        if (record === null || (await revoke(record, deps)) === 'answered') {
            await keys.delete([name]);
        } else {
            left += 1;
        }
    }
    return left;
}

/** The sign-out's steps, as each ends. */
export type SignOutStep =
    | 'stopped'
    | 'marked'
    | 'recorded'
    | 'unsubscribed'
    | 'requested'
    | 'wiped'
    | 'images-cleared'
    | 'webview-cleared';

export interface SignOutDeps extends RevokeDeps {
    readonly store: Store;
    readonly randomBytes: RandomBytes;
    /** Stops the workspace's scope and its jar: resolves once nothing of it writes (its `dispose`). */
    readonly stopScope: () => Promise<void>;
    /** Drops the images held in memory (expo-image's memory cache). */
    readonly clearImageMemory: () => Promise<unknown>;
    /**
     * Clears the WebViews' data (the page editor's runs incognito with storage
     * off, so this is a second lock): cookies, storage and caches,
     * socio-device's `clearWebViewData`.
     */
    readonly clearWebViewData: () => Promise<unknown>;
    /** Called as each step ends; the tests throw from it to kill the sign-out there. */
    readonly afterStep?: (step: SignOutStep) => void | Promise<void>;
    /** Passed to the wipe. */
    readonly wipeOptions?: WipeOptions;
}

export interface SignedOut {
    /** 'none': the jar held no session; 'answered': the server answered; 'pending': a record is kept for later. */
    readonly revocation: 'none' | 'answered' | 'pending';
}

/**
 * Signs out of workspace `id` in the steps above. Resolves once the wipe has
 * found nothing of the workspace left; throws what failed otherwise, with the
 * workspace marked, so the next launch (or trying again) finishes it.
 */
export async function signOutWorkspace(deps: SignOutDeps, id: string): Promise<SignedOut> {
    const { store } = deps;
    const after = async (step: SignOutStep) => {
        await deps.afterStep?.(step);
    };
    // Null when trying again after a wipe that removed the row but found something left: the wipe runs again.
    const row = await store.registry.get(id);
    const subscriptionId = row === null ? null : ((await store.registry.push(id))?.subscriptionId ?? null);

    await deps.stopScope();
    await after('stopped');

    await store.registry.markWiping(id, 'sign-out');
    await after('marked');

    // A copy of the jar in memory: nothing here writes the stored one.
    const stored = row === null ? null : await store.keys.read(workspaceKeyName(id, 'jar'));
    let session: { readonly name: string; readonly value: string } | null = null;
    if (row !== null && stored !== null) {
        const jar = await openCookieJar({ origin: row.origin, store: memoryJarStore(stored) });
        session = jar.session();
        await jar.close();
    }
    let record: { readonly name: string; readonly value: PendingRevocation } | null = null;
    if (row !== null && session !== null) {
        const value = { origin: row.origin, cookie: { name: session.name, value: session.value } };
        record = { name: `${REVOCATION_PREFIX}${newDbKey(deps.randomBytes).slice(0, 32)}`, value };
        await store.keys.write(record.name, formatRevocation(value));
    }
    await after('recorded');

    if (record !== null && subscriptionId !== null) {
        await unsubscribePush(record.value, subscriptionId, deps);
    }
    await after('unsubscribed');

    let revocation: SignedOut['revocation'] = 'none';
    if (record !== null) {
        revocation = (await revoke(record.value, deps)) === 'answered' ? 'answered' : 'pending';
        if (revocation === 'answered') {
            await store.keys.delete([record.name]);
        }
    }
    await after('requested');

    await wipe(store, id, 'sign-out', deps.wipeOptions);
    await store.fs.remove(stagingDirectory(store.root));
    await after('wiped');

    await deps.clearImageMemory();
    await after('images-cleared');

    await deps.clearWebViewData();
    await after('webview-cleared');
    return { revocation };
}
