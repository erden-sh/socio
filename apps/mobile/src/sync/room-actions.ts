import type { RoomNotifyLevel } from '@socio/shared/rooms/room-notices';
import { ROOM_NOTIFY_LEVELS } from '@socio/shared/rooms/room-notices';
import type { RoomView } from '@socio/shared/rooms/rooms';

import type { AuthedFetch } from '../net/authed-fetch';

import { readAnswer } from './outbox-answers';
import type { WriteHold } from './session';
import type { NetworkSource } from './triggers';

// A room's online-only requests, the scope's `roomActions`:
// accepting and declining an invite (`POST
// /api/rooms/:id/{accept,decline}`) and the reader's notification level
// in a room (`GET`/`PUT /api/rooms/:id/notifications`). None goes
// through the outbox:
// - **Refused before any request** (`blocked()`) while NetInfo says offline,
//   the server is away (the scheduler's "Reconnecting…") or writes wait
//   (`writeHold`). The screens say "Needs a connection".
// - **One request at a time per room** (`busy`), accept's `joined` wait included.
// - **Accept posts `{disclosureVersion}`**, the version of the disclosure the
//   person was shown (the invite's own), and answers the room's view.
// - **A "not found" answer** (404 or 410: revoked, accepted elsewhere, or
//   declined) reads the invites again (`invitesChanged`), as does every accept
//   and decline the server took. Accepting also pulls the shell, so the chat
//   list holds the room before it opens (`joined`, awaited).
// - Refusals are told by status and `code`, never the server's text.
// No React Native: tests/sync runs it under Node against a fake fetch.

/** Why nothing can be sent now. */
export type RoomActionBlock = 'offline' | 'away' | 'sign-in' | 'update';

/** What a room request came to. */
export type RoomActionOutcome<T> =
    /** The server took it. */
    | { readonly kind: 'done'; readonly value: T }
    /** Nothing was sent (offline, away, a sign-in or an update). */
    | { readonly kind: 'blocked'; readonly reason: RoomActionBlock }
    /** Nothing was sent: a request for the room is in flight. */
    | { readonly kind: 'busy' }
    /** 404 or 410: the invite (or the room) isn't there for the person any more. */
    | { readonly kind: 'gone' }
    /** Another refusal: its `code`, else `http-<status>`. */
    | { readonly kind: 'refused'; readonly reason: string }
    /** It went and no answer came. */
    | { readonly kind: 'no-answer' };

export interface RoomActionsOptions {
    readonly fetch: AuthedFetch;
    readonly network: NetworkSource;
    /** Whether the server is away (the scheduler's status). */
    readonly away: () => boolean;
    /** Why writes wait (session.ts's `writeHold`). */
    readonly hold: () => WriteHold;
    /** The invites may have changed: read them again. */
    readonly invitesChanged: () => void;
    /** An invite was accepted: the shell is pulled, resolving once the chat list holds the room (or a while passed). */
    readonly joined: (roomId: string) => Promise<void>;
}

export interface RoomActions {
    /** Why nothing can be sent now, or null. */
    blocked(): RoomActionBlock | null;
    /** Whether a request for the room is in flight. */
    busy(roomId: string): boolean;
    /** Calls `listener` after each change of `blocked()` or `busy()`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Joins the room, having shown the invite's disclosure (`version`). Answers the room's view. */
    accept(roomId: string, disclosureVersion: number): Promise<RoomActionOutcome<RoomView | null>>;
    /** Declines the invite. */
    decline(roomId: string): Promise<RoomActionOutcome<null>>;
    /** The reader's notification level in the room. */
    notifyLevel(roomId: string): Promise<RoomActionOutcome<RoomNotifyLevel>>;
    /** Sets it. */
    setNotifyLevel(roomId: string, level: RoomNotifyLevel): Promise<RoomActionOutcome<RoomNotifyLevel>>;
    /** Stops listening to the network. */
    dispose(): void;
}

const roomPath = (roomId: string, what: string) => `/api/rooms/${encodeURIComponent(roomId)}/${what}`;

const isLevel = (value: unknown): value is RoomNotifyLevel =>
    typeof value === 'string' && (ROOM_NOTIFY_LEVELS as readonly string[]).includes(value);

export function createRoomActions(options: RoomActionsOptions): RoomActions {
    const { fetch, network, away, hold, invitesChanged, joined } = options;
    const listeners = new Set<() => void>();
    const inFlight = new Set<string>();
    let connected: boolean | null = null;
    const tell = () => {
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const unsubscribe = network.subscribe((next) => {
        if (next.connected !== null && next.connected !== connected) {
            connected = next.connected;
            tell();
        }
    });
    network
        .current()
        .then((next) => {
            if (connected === null && next.connected !== null) {
                connected = next.connected;
                tell();
            }
        })
        .catch(() => {});

    const blocked = (): RoomActionBlock | null => {
        if (connected === false) {
            return 'offline';
        }
        if (away()) {
            return 'away';
        }
        return hold();
    };

    /**
     * One request, refused before sending while blocked or busy; `read` takes
     * the 2xx body. The room stays busy through `after` too (accept's `joined`
     * wait), so no other request for it goes until all of it is done.
     */
    const once = async <T>(
        roomId: string,
        path: string,
        init: { method: 'GET' | 'POST' | 'PUT'; json?: unknown },
        read: (body: unknown) => T,
        { writes, after }: { writes: boolean; after?: (outcome: RoomActionOutcome<T>) => Promise<void> },
    ): Promise<RoomActionOutcome<T>> => {
        const reason = blocked();
        if (reason !== null && (writes || reason === 'offline' || reason === 'away')) {
            return { kind: 'blocked', reason };
        }
        if (inFlight.has(roomId)) {
            return { kind: 'busy' };
        }
        inFlight.add(roomId);
        tell();
        try {
            let answer;
            try {
                answer = await readAnswer(await fetch(path, init.json === undefined ? { method: init.method } : init));
            } catch {
                return { kind: 'no-answer' };
            }
            const outcome: RoomActionOutcome<T> =
                answer.status >= 200 && answer.status < 300
                    ? { kind: 'done', value: read(answer.body) }
                    : answer.status === 404 || answer.status === 410
                      ? { kind: 'gone' }
                      : { kind: 'refused', reason: answer.code ?? `http-${answer.status}` };
            await after?.(outcome).catch(() => {});
            return outcome;
        } finally {
            inFlight.delete(roomId);
            tell();
        }
    };

    return {
        blocked,
        busy: (roomId) => inFlight.has(roomId),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async accept(roomId, disclosureVersion) {
            const outcome = await once(
                roomId,
                roomPath(roomId, 'accept'),
                { method: 'POST', json: { disclosureVersion } },
                (body) => (body !== null && typeof body === 'object' ? (body as RoomView) : null),
                // Busy until the chat list holds the room: Decline can't follow a Join the server took.
                { writes: true, after: (taken) => (taken.kind === 'done' ? joined(roomId) : Promise.resolve()) },
            );
            if (outcome.kind === 'done' || outcome.kind === 'gone') {
                invitesChanged();
            }
            return outcome;
        },
        async decline(roomId) {
            const outcome = await once(roomId, roomPath(roomId, 'decline'), { method: 'POST', json: {} }, () => null, {
                writes: true,
            });
            if (outcome.kind === 'done' || outcome.kind === 'gone') {
                invitesChanged();
            }
            return outcome;
        },
        async notifyLevel(roomId) {
            const outcome = await once(
                roomId,
                roomPath(roomId, 'notifications'),
                { method: 'GET' },
                (body) => (body as { level?: unknown } | null)?.level,
                { writes: false },
            );
            if (outcome.kind === 'done' && !isLevel(outcome.value)) {
                return { kind: 'refused', reason: 'unreadable' };
            }
            return outcome as RoomActionOutcome<RoomNotifyLevel>;
        },
        async setNotifyLevel(roomId, level) {
            return once(
                roomId,
                roomPath(roomId, 'notifications'),
                { method: 'PUT', json: { level } },
                (body) => {
                    const value = (body as { level?: unknown } | null)?.level;
                    return isLevel(value) ? value : level;
                },
                { writes: true },
            );
        },
        dispose() {
            unsubscribe();
            listeners.clear();
        },
    };
}
