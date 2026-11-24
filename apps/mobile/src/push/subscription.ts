import { workspaceKeyName } from '../data/keys';
import { leaseLockAt } from '../data/lease';
import { isRelayOrigin, PUSH_SUBSCRIPTIONS_PATH, recordPushRevocation } from '../data/push-revocation';
import { NO_PUSH, type PushRow, type WorkspaceRow } from '../data/registry';
import type { Store } from '../data/wipe';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';
import { base64url } from '../sync/presence';

import type { RelayClient } from './relay-client';
import { retryPushRevocation } from './revocation';

// Registering and keeping each workspace's push subscription, under Node, with
// expo-notifications, the socio-push module and the relay client handed in:
//
// - **Registering** (`ensure`, when a workspace's scope opens and daily while it
//   is open): the native token, then the workspace's `pushKey` and the push
//   channel's targets (`GET /api/notifications/channels`), then the relay's
//   registration with an id and secret chosen and kept first
//   (`socio.<id>.relay`, a workspace key: a retry after a kill makes the same
//   one), then `POST /api/notifications/push/subscriptions` with
//   `installed: true` (idempotent by endpoint). Each answer is kept as it comes
//   (the relay's, then the subscription's id), so a kill after any step ends
//   with one registration and one subscription. A 400 from the server means its
//   host list doesn't take the relay (Technical details). A changed `pushKey`,
//   or our subscription missing from the push channel's targets, makes a fresh
//   registration (the old one is deleted at the relay).
// - **Keepalive** (`keepalive`, at launch and on each return): the native token
//   is compared with each registered one before anything else; a change, and
//   once a day, `PUT`s every workspace's registration (the secret only, no
//   cookie). A registration the relay no longer has (410) or isn't ours (403) is
//   forgotten here, and the workspace's next `ensure` makes a new one.
// - **Permission taken back** in the phone's Settings: the next keepalive (the
//   foreground) deletes the open workspace's subscription (once, best effort)
//   and every registration at the relay, whose 410 then makes each server drop
//   its subscription.
// - **The flags** the extension and the messaging service read: each
//   registered workspace's locked flag and `leaseLockAt` (lease.ts), written
//   when they change: at launch, after a lock, and whenever contact moves.
// - **A build that can't share push items with the extension** (a Personal
//   Team build: `canRegister` false), or one with no relay origin, never
//   registers.
// - **A new relay origin:** each registration's credentials keep the relay
//   origin they were made for (`socio.<id>.relay`'s `origin`; one kept before
//   origins were kept has none and was made at the build's own). When the
//   build's origin is another, or none, the workspace's `ensure` retires it
//   before anything else: its revocation record first (with that origin, so
//   the old relay is told even after a kill), then the old subscription's
//   `DELETE` at the server (no answer or a 5xx stops there, to try again),
//   then the registration is forgotten here and the record tried at the old
//   relay at once (src/push/revocation.ts; launch and each return try it
//   again). A build with a relay then registers afresh there and subscribes,
//   so a kill after any step ends with one registration and one subscription,
//   at the new relay; one with none stops (push off). The keepalive never
//   refreshes a registration made at another relay: it waits for its
//   workspace's `ensure`.
// - **A wipe** (`forgetWorkspace`) marks the workspace forgotten at once, then
//   waits for the runs queued before it, but no longer than
//   `FORGET_WAIT_MS`: a relay that never answers can't hold a sign-out, a
//   lease expiry or an unfinished add. Its native keys, flags and index entries
//   go either way. A run that started before it checks the mark before each
//   write and stops there, so an ensure still waiting on the relay can't make
//   keys, flags or credentials again; when the wait ran out, the cleanup runs
//   once more after that run ends. Nothing is written for a row that isn't
//   ready, so later runs leave it alone.
// - Nothing personal goes to the relay or the server: no email, name or user id.

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often an open workspace's subscription is checked again. */
export const PUSH_CHECK_MS = DAY_MS;
/** How often every registration is refreshed at the relay; it drops one not refreshed in 60 days. */
export const PUSH_REFRESH_MS = DAY_MS;
/** The longest a wipe waits for a push run still going before deleting the workspace's native keys anyway. */
export const FORGET_WAIT_MS = 10_000;

export const CHANNELS_PATH = '/api/notifications/channels';
export const SUBSCRIPTIONS_PATH = PUSH_SUBSCRIPTIONS_PATH;

export type PushPermission = 'granted' | 'denied' | 'undetermined';

/** expo-notifications, as the platform binds it. */
export interface PushNotifications {
    permission(): Promise<PushPermission>;
    /** The native token (APNs hex, FCM); throws when the build or phone gives none. */
    nativeToken(): Promise<string>;
}

/** The public half of a workspace's Web Push keys (socio-push). */
export interface PushKeyPair {
    readonly p256dh: string;
    readonly auth: string;
}

/** socio-push, as the platform binds it. */
export interface PushNative {
    /** Whether this build shares push items with the notification extension: false in a Personal Team build. */
    canRegister(): Promise<boolean>;
    getKeys(workspaceId: string): Promise<PushKeyPair | null>;
    createKeys(workspaceId: string): Promise<PushKeyPair>;
    /** Deletes the workspace's keys, its flags and the registrations that point at it. */
    deleteKeys(workspaceId: string): Promise<void>;
    setRegistration(registrationId: string, workspaceId: string, name: string): Promise<void>;
    deleteRegistration(registrationId: string): Promise<void>;
    setLocked(workspaceId: string, locked: boolean): Promise<void>;
    setLeaseLockAt(workspaceId: string, at: number | null): Promise<void>;
    setShowText(showText: boolean): Promise<void>;
}

/** What the relay needs to know of this app. */
export interface PushApp {
    readonly platform: 'ios' | 'android';
    readonly bundleId: string;
    readonly apnsEnv: 'sandbox' | 'production' | null;
}

/** Where a workspace's push stands, for Technical details. */
export type PushStatus =
    | { readonly kind: 'unknown' }
    /** A Personal Team build: no push. */
    | { readonly kind: 'build' }
    /** No relay origin in this build. */
    | { readonly kind: 'no-relay' }
    | { readonly kind: 'no-permission' }
    | { readonly kind: 'no-token' }
    | { readonly kind: 'subscribed'; readonly subscriptionId: string }
    /** The server's push host list doesn't take the relay (its 400). */
    | { readonly kind: 'host-not-allowed' }
    /** A step failed: `step` and the status, or 'offline'. */
    | {
          readonly kind: 'failed';
          readonly step: 'channels' | 'relay' | 'subscribe' | 'unsubscribe';
          readonly status: number | 'offline';
      };

/** The open workspace's scope, as `ensure` uses it. */
export interface PushScope {
    readonly workspaceId: string;
    /** The workspace's name, the notification's subtitle when several are signed in. */
    readonly name: string;
    readonly fetch: AuthedFetch;
}

export interface PushManagerDeps {
    readonly store: Store;
    readonly native: PushNative;
    readonly notifications: PushNotifications;
    /** The relay client, or null when the build has no relay origin. */
    readonly relay: RelayClient | null;
    readonly relayOrigin: string | null;
    /**
     * A client for a relay origin a registration was made at that isn't the
     * build's, to delete it there; null when the build can't reach it.
     * None: only the build's own relay.
     */
    readonly relayAt?: (origin: string) => RelayClient | null;
    readonly app: PushApp;
    readonly randomBytes: (length: number) => Uint8Array;
    /** The device clock. */
    readonly now: () => number;
    readonly onError?: (error: unknown) => void;
    /** How long `forgetWorkspace` waits for the queue; `FORGET_WAIT_MS` unless a test sets it. */
    readonly forgetWaitMs?: number;
}

export interface PushManager {
    /** Registers and subscribes the open workspace, or checks it again (`force`, else once a day). */
    ensure(scope: PushScope, options?: { readonly force?: boolean }): Promise<PushStatus>;
    /**
     * At launch and on each return: the token, the daily refresh, a permission
     * taken back. `token`: the phone's token event's, used instead of asking
     * for it again, and skipped when it is the one this manager last saw:
     * expo-notifications fires that event on every `getDevicePushTokenAsync`
     * too, so asking again would loop.
     */
    keepalive(open?: PushScope | null, options?: { readonly token?: string }): Promise<void>;
    /** Writes each registered workspace's locked flag and lease deadline where they changed. */
    syncFlags(): Promise<void>;
    /** Hands the device's show-text setting to the native side. */
    syncShowText(): Promise<void>;
    /**
     * A wipe's push step (wipe.ts' 1a, through `StorePush.deleteKeys`): marks
     * the workspace forgotten, so a run already going (an ensure waiting on
     * the relay) writes nothing more for it; waits for the runs queued before
     * it, at most `forgetWaitMs`; then deletes its native keys, flags and
     * registration index entries and forgets what this manager knew of it,
     * and once more after those runs end when the wait ran out. Nothing queued
     * after it writes for the workspace again: `ensure` touches only a ready row.
     */
    forgetWorkspace(workspaceId: string): Promise<void>;
    status(workspaceId: string): PushStatus;
    /** The last keepalive `PUT` for the workspace since the app started, and the relay's answer; null before one. */
    lastRefresh(workspaceId: string): PushRefresh | null;
    subscribe(listener: () => void): () => void;
}

/** A keepalive's `PUT` and what the relay answered: `done`, `gone` (410), `forbidden` (403), `offline`, or another status. */
export interface PushRefresh {
    readonly at: number;
    readonly answer: 'done' | 'gone' | 'forbidden' | 'offline' | number;
}

/** One object, so a screen's store snapshot stays the same while nothing changed. */
const UNKNOWN: PushStatus = { kind: 'unknown' };

interface RelayCredentials {
    readonly id: string;
    readonly secret: string;
    /** The relay origin they were made for; null in credentials kept before origins were, made at the build's own. */
    readonly origin: string | null;
}

/** A registration's credentials as kept: `{v: 1, id, secret, origin}`; null for anything else. */
function parseCredentials(text: string | null): RelayCredentials | null {
    if (text === null) {
        return null;
    }
    try {
        const value = JSON.parse(text) as Record<string, unknown>;
        if (typeof value.id !== 'string' || typeof value.secret !== 'string') {
            return null;
        }
        if (value.origin === undefined || value.origin === null) {
            return { id: value.id, secret: value.secret, origin: null };
        }
        return typeof value.origin === 'string' && isRelayOrigin(value.origin)
            ? { id: value.id, secret: value.secret, origin: value.origin }
            : null;
    } catch {
        return null;
    }
}

/** Thrown inside a run when a wipe forgot the workspace meanwhile: the run writes nothing more for it. */
class Forgotten extends Error {
    override name = 'Forgotten';
}

/** Whether `row`'s copy is locked: Ended, or the lease. */
const lockedOf = (row: Pick<WorkspaceRow, 'endedAt' | 'leaseLockedAt'>) =>
    row.endedAt !== null || row.leaseLockedAt !== null;

export function createPushManager(deps: PushManagerDeps): PushManager {
    const { store, native, notifications, relay, app } = deps;
    const onError = deps.onError ?? (() => {});
    const statuses = new Map<string, PushStatus>();
    const refreshes = new Map<string, PushRefresh>();
    const checkedAt = new Map<string, number>();
    const flagsWritten = new Map<string, string>();
    const listeners = new Set<() => void>();
    /** The native token this manager last got or was given: a token event with it is our own call's echo. */
    let seenToken: string | null = null;
    /** The native token, kept as the last seen. */
    const nativeToken = async () => {
        const token = await notifications.nativeToken();
        seenToken = token;
        return token;
    };
    /** Bumped by each `forgetWorkspace`: a run that saw another count at its start was overtaken by a wipe. */
    const forgotten = new Map<string, number>();
    /** The counts as the running run found them at its start. */
    let started = new Map<string, number>();
    /** Before each write for `workspaceId`: stops the run (Forgotten) when a wipe forgot the workspace since it started. */
    const live = (workspaceId: string) => {
        if ((forgotten.get(workspaceId) ?? 0) !== (started.get(workspaceId) ?? 0)) {
            throw new Forgotten();
        }
    };
    /** Runs `work` for one workspace, skipping it quietly when a wipe forgot it meanwhile. */
    const unlessForgotten = async (work: () => Promise<void>) => {
        try {
            await work();
        } catch (error) {
            if (!(error instanceof Forgotten)) {
                throw error;
            }
        }
    };
    /** One run at a time: a keepalive and an ensure never interleave their writes. */
    let queue: Promise<unknown> = Promise.resolve();
    const queued = <T>(work: () => Promise<T>): Promise<T> => {
        const run = queue.then(() => {
            started = new Map(forgotten);
            return work();
        });
        queue = run.catch(() => {});
        return run;
    };

    const setStatus = (workspaceId: string, status: PushStatus): PushStatus => {
        statuses.set(workspaceId, status);
        for (const listener of [...listeners]) {
            listener();
        }
        return status;
    };

    const relayKey = (workspaceId: string) => workspaceKeyName(workspaceId, 'relay');

    /** The client for the relay at `origin` (null: the build's own), or null when this build can't reach it. */
    const relayFor = (origin: string | null): RelayClient | null =>
        origin === null || origin === deps.relayOrigin ? relay : (deps.relayAt?.(origin) ?? null);

    /**
     * Whether the workspace's registration was made at another relay than the
     * build's: its credentials' origin, or any registration at all in
     * a build with no relay.
     */
    const madeElsewhere = (creds: RelayCredentials | null, row: PushRow): boolean =>
        deps.relayOrigin === null
            ? creds !== null || row.registrationId !== null
            : creds !== null && creds.origin !== null && creds.origin !== deps.relayOrigin;

    /**
     * Credentials kept before origins were have no origin: they were made at the
     * build's own relay, which is written into them, so a later build with
     * another relay retires them.
     */
    const stampOrigin = async (workspaceId: string, creds: RelayCredentials | null) => {
        if (creds !== null && creds.origin === null && deps.relayOrigin !== null) {
            live(workspaceId);
            await store.keys.write(
                relayKey(workspaceId),
                JSON.stringify({ v: 1, id: creds.id, secret: creds.secret, origin: deps.relayOrigin }),
            );
        }
    };

    /** The workspace's registration credentials for `origin`, made and kept first when it has none. */
    const credentials = async (workspaceId: string, origin: string, renew = false): Promise<RelayCredentials> => {
        const kept = renew ? null : parseCredentials(await store.keys.read(relayKey(workspaceId)));
        if (kept !== null) {
            return kept;
        }
        // 16 bytes: 22 characters, the relay's shortest id; 32 bytes: a 43-character secret.
        const made = { id: base64url(deps.randomBytes(16)), secret: base64url(deps.randomBytes(32)), origin };
        live(workspaceId);
        await store.keys.write(relayKey(workspaceId), JSON.stringify({ v: 1, ...made }));
        return made;
    };

    /** Forgets the workspace's registration here: the row's push fields, the native index entry and the credentials. */
    const forget = async (workspaceId: string, row: PushRow) => {
        live(workspaceId);
        await store.registry.setPush(workspaceId, NO_PUSH);
        if (row.registrationId !== null) {
            await native.deleteRegistration(row.registrationId).catch(onError);
        }
        await store.keys.delete([relayKey(workspaceId)]);
        flagsWritten.delete(workspaceId);
    };

    /**
     * Deletes the registration at the relay it was made at, then here.
     * Resolves false when the relay didn't answer. One this build can't reach
     * goes to a revocation record first, which a build that can tells.
     */
    const deleteRegistration = async (workspaceId: string, row: PushRow): Promise<boolean> => {
        const kept = parseCredentials(await store.keys.read(relayKey(workspaceId)));
        const at = kept === null ? null : relayFor(kept.origin);
        if (kept !== null && row.registrationId !== null) {
            if (at === null) {
                live(workspaceId);
                await recordPushRevocation(store.keys, workspaceId);
            } else {
                const outcome = await at.remove(kept.id, kept.secret);
                if (outcome.kind === 'offline' || outcome.kind === 'refused') {
                    return false;
                }
            }
        }
        await forget(workspaceId, row);
        return true;
    };

    /**
     * Retires a registration made at another relay, each step kept
     * before the next: its revocation record (its own origin), the old
     * subscription's `DELETE` at the server, the registration forgotten here,
     * then the record tried at its relay. Resolves the status to stop at when
     * the server didn't answer the `DELETE` (or a 5xx), else null.
     */
    const retire = async (workspaceId: string, row: PushRow, fetch: AuthedFetch): Promise<PushStatus | null> => {
        live(workspaceId);
        const record = await recordPushRevocation(store.keys, workspaceId);
        if (row.subscriptionId !== null) {
            let answer: Response;
            try {
                answer = await fetch(`${SUBSCRIPTIONS_PATH}/${encodeURIComponent(row.subscriptionId)}`, {
                    method: 'DELETE',
                });
            } catch {
                return { kind: 'failed', step: 'unsubscribe', status: 'offline' };
            }
            // Any other answer settles it: a 404 or 410 is already gone, and a refusal won't change by asking again.
            if (answer.status >= 500) {
                return { kind: 'failed', step: 'unsubscribe', status: answer.status };
            }
        }
        await forget(workspaceId, row);
        checkedAt.delete(workspaceId);
        if (record !== null) {
            await retryPushRevocation(store.keys, record, relayFor).catch(onError);
        }
        return null;
    };

    const writeFlags = async (row: WorkspaceRow) => {
        const locked = lockedOf(row);
        const at = leaseLockAt(row);
        const written = `${locked}:${at}`;
        if (flagsWritten.get(row.id) === written) {
            return;
        }
        live(row.id);
        await native.setLocked(row.id, locked);
        await native.setLeaseLockAt(row.id, at);
        flagsWritten.set(row.id, written);
    };

    /** Whether this build registers at all: socio-push can share its items, and the build has a relay. */
    const usable = async (): Promise<boolean> =>
        relay !== null && deps.relayOrigin !== null && (await native.canRegister());

    const ensureNow = async (scope: PushScope): Promise<PushStatus> => {
        const { workspaceId } = scope;
        // A workspace being wiped (or gone) gets nothing: its keys, flags and relay credentials stay deleted.
        if ((await store.registry.get(workspaceId))?.state !== 'ready') {
            return statuses.get(workspaceId) ?? UNKNOWN;
        }
        if (!(await native.canRegister())) {
            return setStatus(workspaceId, { kind: 'build' });
        }
        // Made at another relay, or this build has none: retired first.
        const before = (await store.registry.push(workspaceId)) ?? NO_PUSH;
        const madeWith = parseCredentials(await store.keys.read(relayKey(workspaceId)));
        if (madeElsewhere(madeWith, before)) {
            const stopped = await retire(workspaceId, before, scope.fetch);
            if (stopped !== null) {
                return setStatus(workspaceId, stopped);
            }
        } else {
            await stampOrigin(workspaceId, madeWith);
        }
        if (relay === null || deps.relayOrigin === null) {
            return setStatus(workspaceId, { kind: 'no-relay' });
        }
        const origin = deps.relayOrigin;
        const permission = await notifications.permission();
        const kept = (await store.registry.push(workspaceId)) ?? NO_PUSH;
        if (permission !== 'granted') {
            if (kept.registrationId !== null) {
                await revoke(workspaceId, kept, scope.fetch);
            }
            return setStatus(workspaceId, { kind: 'no-permission' });
        }
        let token: string;
        try {
            token = await nativeToken();
        } catch (error) {
            onError(error);
            return setStatus(workspaceId, { kind: 'no-token' });
        }

        let channels: Response;
        try {
            channels = await scope.fetch(CHANNELS_PATH);
        } catch {
            return setStatus(workspaceId, { kind: 'failed', step: 'channels', status: 'offline' });
        }
        if (channels.status !== 200) {
            return setStatus(workspaceId, { kind: 'failed', step: 'channels', status: channels.status });
        }
        const body = (await readJson(channels).catch(() => null)) as {
            pushKey?: unknown;
            channels?: { id?: unknown; targets?: { id?: unknown }[] }[];
        } | null;
        const pushKey = typeof body?.pushKey === 'string' && body.pushKey !== '' ? body.pushKey : null;
        if (pushKey === null) {
            return setStatus(workspaceId, { kind: 'failed', step: 'channels', status: 200 });
        }
        const targets = new Set(
            (body?.channels?.find((channel) => channel.id === 'push')?.targets ?? []).map((target) => target.id),
        );

        let row = kept;
        let freshKeys = false;
        if (
            row.registrationId !== null &&
            (row.pushKey !== pushKey || (row.subscriptionId !== null && !targets.has(row.subscriptionId)))
        ) {
            // Bound to another key, or the server dropped our subscription: start again.
            // A relay that didn't answer keeps the old one until its 60 days run out.
            if (!(await deleteRegistration(workspaceId, row))) {
                await forget(workspaceId, row);
            }
            row = NO_PUSH;
            freshKeys = true;
        }

        let registrationId = row.registrationId;
        if (registrationId === null) {
            let creds = await credentials(workspaceId, origin);
            live(workspaceId);
            let outcome = await relay.register({
                id: creds.id,
                secret: creds.secret,
                ...app,
                nativeToken: token,
                vapidKey: pushKey,
            });
            if (outcome.kind === 'taken') {
                creds = await credentials(workspaceId, origin, true);
                live(workspaceId);
                outcome = await relay.register({
                    id: creds.id,
                    secret: creds.secret,
                    ...app,
                    nativeToken: token,
                    vapidKey: pushKey,
                });
            }
            if (outcome.kind !== 'registered') {
                return setStatus(workspaceId, {
                    kind: 'failed',
                    step: 'relay',
                    status: outcome.kind === 'refused' ? outcome.status : outcome.kind === 'taken' ? 409 : 'offline',
                });
            }
            registrationId = creds.id;
            live(workspaceId);
            await store.registry.setPush(workspaceId, { registrationId, pushKey, nativeToken: token });
            freshKeys = true;
        }
        live(workspaceId);
        await native.setRegistration(registrationId, workspaceId, scope.name);
        const current = await store.registry.get(workspaceId);
        if (current !== null) {
            await writeFlags(current);
        }

        let keys = freshKeys ? null : await native.getKeys(workspaceId);
        if (keys === null) {
            live(workspaceId);
            keys = await native.createKeys(workspaceId);
        }
        let answer: Response;
        try {
            answer = await scope.fetch(SUBSCRIPTIONS_PATH, {
                method: 'POST',
                json: {
                    endpoint: `${origin}/v1/push/${registrationId}`,
                    keys: { p256dh: keys.p256dh, auth: keys.auth },
                    installed: true,
                },
            });
        } catch {
            return setStatus(workspaceId, { kind: 'failed', step: 'subscribe', status: 'offline' });
        }
        if (answer.status === 400) {
            return setStatus(workspaceId, { kind: 'host-not-allowed' });
        }
        const saved = (await readJson(answer).catch(() => null)) as { id?: unknown } | null;
        if (answer.status !== 201 && answer.status !== 200) {
            return setStatus(workspaceId, { kind: 'failed', step: 'subscribe', status: answer.status });
        }
        if (typeof saved?.id !== 'string') {
            return setStatus(workspaceId, { kind: 'failed', step: 'subscribe', status: answer.status });
        }
        live(workspaceId);
        await store.registry.setPush(workspaceId, { subscriptionId: saved.id });
        checkedAt.set(workspaceId, deps.now());
        return setStatus(workspaceId, { kind: 'subscribed', subscriptionId: saved.id });
    };

    /**
     * Permission taken back: the open workspace's subscription once, best
     * effort (`fetch`; null for another workspace, whose server drops it at the
     * relay's 410), then the registration.
     */
    const revoke = async (workspaceId: string, row: PushRow, fetch: AuthedFetch | null) => {
        if (fetch !== null && row.subscriptionId !== null) {
            await fetch(`${SUBSCRIPTIONS_PATH}/${encodeURIComponent(row.subscriptionId)}`, { method: 'DELETE' }).catch(
                () => {},
            );
        }
        await deleteRegistration(workspaceId, row);
    };

    const keepaliveNow = async (open: PushScope | null, given: string | null) => {
        if (!(await usable()) || relay === null) {
            return;
        }
        const registered: { row: WorkspaceRow; push: PushRow }[] = [];
        for (const row of await store.registry.list()) {
            const push = row.state === 'ready' ? await store.registry.push(row.id) : null;
            if (push !== null && push.registrationId !== null) {
                registered.push({ row, push });
            }
        }
        if (registered.length === 0) {
            return;
        }
        if ((await notifications.permission()) !== 'granted') {
            for (const { row, push } of registered) {
                await unlessForgotten(async () => {
                    await revoke(row.id, push, open?.workspaceId === row.id ? open.fetch : null);
                    setStatus(row.id, { kind: 'no-permission' });
                });
            }
            return;
        }
        let token: string;
        if (given !== null) {
            token = given;
        } else {
            try {
                token = await nativeToken();
            } catch (error) {
                onError(error);
                return;
            }
        }
        const device = await store.registry.pushDevice();
        const daily = device.refreshedAt === null || deps.now() - device.refreshedAt >= PUSH_REFRESH_MS;
        let all = true;
        for (const { row, push } of registered) {
            const changed = push.nativeToken !== token;
            if (!changed && !daily) {
                continue;
            }
            await unlessForgotten(async () => {
                const creds = parseCredentials(await store.keys.read(relayKey(row.id)));
                if (creds === null) {
                    await forget(row.id, push);
                    return;
                }
                // Made at another relay: kept alive there, its secret sent nowhere else,
                // until its workspace's ensure retires it. One this build can't reach waits.
                const at = madeElsewhere(creds, push) ? relayFor(creds.origin) : relay;
                if (at === null) {
                    return;
                }
                await stampOrigin(row.id, creds);
                const outcome = await at.refresh(creds.id, creds.secret, changed ? token : undefined);
                refreshes.set(row.id, {
                    at: deps.now(),
                    answer: outcome.kind === 'refused' ? outcome.status : outcome.kind,
                });
                for (const listener of [...listeners]) {
                    listener();
                }
                if (outcome.kind === 'done') {
                    if (changed) {
                        live(row.id);
                        await store.registry.setPush(row.id, { nativeToken: token });
                    }
                } else if (outcome.kind === 'gone' || outcome.kind === 'forbidden') {
                    await forget(row.id, push);
                    checkedAt.delete(row.id);
                } else {
                    all = false;
                }
            });
        }
        if (daily && all) {
            await store.registry.setPushDevice({ refreshedAt: deps.now() });
        }
    };

    const syncFlagsNow = async () => {
        for (const row of await store.registry.list()) {
            if (row.state !== 'ready') {
                continue;
            }
            const push = await store.registry.push(row.id);
            if (push?.registrationId != null) {
                await unlessForgotten(() => writeFlags(row));
            }
        }
    };

    return {
        ensure: (scope, { force = false } = {}) =>
            queued(async () => {
                const last = checkedAt.get(scope.workspaceId);
                if (!force && last !== undefined && deps.now() - last < PUSH_CHECK_MS) {
                    return statuses.get(scope.workspaceId) ?? UNKNOWN;
                }
                try {
                    return await ensureNow(scope);
                } catch (error) {
                    if (error instanceof Forgotten) {
                        return UNKNOWN;
                    }
                    throw error;
                }
            }),
        keepalive: (open = null, { token }: { readonly token?: string } = {}) =>
            queued(async () => {
                if (token === undefined) {
                    return keepaliveNow(open, null);
                }
                // Checked in the queue: a run asking for the token has kept it by then.
                if (token === '' || token === seenToken) {
                    return;
                }
                seenToken = token;
                return keepaliveNow(open, token);
            }),
        syncFlags: () => queued(syncFlagsNow),
        syncShowText: () =>
            queued(async () => {
                if (await native.canRegister()) {
                    await native.setShowText((await store.registry.pushDevice()).showText);
                }
            }),
        async forgetWorkspace(workspaceId) {
            forgotten.set(workspaceId, (forgotten.get(workspaceId) ?? 0) + 1);
            // The runs queued so far; this mark itself never fails.
            const before = queued(async () => {});
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = await Promise.race([
                before.then(() => true),
                new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(false), deps.forgetWaitMs ?? FORGET_WAIT_MS);
                }),
            ]);
            clearTimeout(timer);
            const cleanUp = async () => {
                await native.deleteKeys(workspaceId);
                checkedAt.delete(workspaceId);
                flagsWritten.delete(workspaceId);
                statuses.delete(workspaceId);
                refreshes.delete(workspaceId);
                for (const listener of [...listeners]) {
                    listener();
                }
            };
            await cleanUp();
            if (!done) {
                // A write that was already under way when the mark came: undone once that run ends,
                // unless the workspace is back (a fresh add under the same id).
                void before
                    .then(async () => {
                        if ((await store.registry.get(workspaceId))?.state !== 'ready') {
                            await cleanUp();
                        }
                    })
                    .catch(onError);
            }
        },
        status: (workspaceId) => statuses.get(workspaceId) ?? UNKNOWN,
        lastRefresh: (workspaceId) => refreshes.get(workspaceId) ?? null,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
