import type { RoomPerson } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import type { AuthedFetch } from '../net/authed-fetch';

import { readAnswer } from './outbox-answers';
import type { WriteHold } from './session';
import type { NetworkSource } from './triggers';

// New room (CB-470), the scope's `roomCreate`: the web's create dialog's two
// requests (packages/client's CreateRoomDialog and roomsApi, the server's
// src/server/rooms/routes.ts), online only, never through the outbox:
// - **The people one may invite,** `GET /api/rooms/people` (CB-278), read as
//   the form opens, before any room exists: names and ids, kept in memory only.
// - **Create,** `POST /api/rooms` with `{dotId, title, dotIds?, userIds?}`: the
//   first socio leads, the others start as requests a workspace admin lets in,
//   and each person gets a member invite (the maker is the room's admin).
// - **Online only:** the server picks the room's id and checks who may be in
//   it, and the room is nothing on the phone until the chat list holds it. So
//   both are refused before any request (`blocked()`) while NetInfo says
//   offline, the server is away (the scheduler's "Reconnecting…"), and Create
//   while writes wait (`writeHold`); the form says "Needs a connection".
// - **One create at a time** (`busy`), the wait for the chat list included, so
//   a second tap on Create can't make a second room.
// - **201 answers the room's conversation;** then the shell is pulled and the
//   create resolves once the chat list holds it (`listed`), so it opens.
// - **Refusals are told by `code`** (`rooms_off`, `personal_socio`,
//   `not_eligible`, …), else the status, never the server's text (10.2). A lost
//   answer or a 5xx may still have made it: the shell is pulled.
// No React Native: tests/sync runs it under Node against a fake fetch.

/** Why nothing can be sent now. */
export type RoomCreateBlock = 'offline' | 'away' | 'sign-in' | 'update';

/** What a create came to. */
export type RoomCreateOutcome =
    /** The server made it, and the chat list holds it (or a while passed). */
    | { readonly kind: 'done'; readonly room: Pick<Conversation, 'id' | 'title'> }
    /** Nothing was sent (offline, away, a sign-in or an update). */
    | { readonly kind: 'blocked'; readonly reason: RoomCreateBlock }
    /** Nothing was sent: a create is in flight. */
    | { readonly kind: 'busy' }
    /** Refused: its `code`, else `http-<status>`. */
    | { readonly kind: 'refused'; readonly reason: string }
    /** It went and no answer came, or the server failed: the room may be there. */
    | { readonly kind: 'no-answer' };

/** What reading the people came to. */
export type RoomPeopleOutcome =
    | { readonly kind: 'done'; readonly people: readonly RoomPerson[] }
    | { readonly kind: 'blocked'; readonly reason: RoomCreateBlock }
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'no-answer' };

/** The form's choices: the socios in order (the first leads), and the people to invite. */
export interface RoomCreateInput {
    readonly title: string;
    readonly socioIds: readonly string[];
    readonly userIds: readonly string[];
}

export interface RoomCreateOptions {
    readonly fetch: AuthedFetch;
    readonly network: NetworkSource;
    /** Whether the server is away (the scheduler's status). */
    readonly away: () => boolean;
    /** Why writes wait (session.ts's `writeHold`). */
    readonly hold: () => WriteHold;
    /** Pulls the shell; resolves once the chat list holds `roomId` (or a while passed). */
    readonly listed: (roomId: string) => Promise<void>;
    /** Pulls the shell, after an answer that may hide a room made. */
    readonly refresh: () => void;
}

export interface RoomCreate {
    /** Why nothing can be sent now, or null. */
    blocked(): RoomCreateBlock | null;
    /** Whether a create is in flight. */
    busy(): boolean;
    /** Calls `listener` after each change of `blocked()` or `busy()`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** The people the maker may invite, by name. */
    people(): Promise<RoomPeopleOutcome>;
    /** Makes the room, as the web's dialog does. */
    create(input: RoomCreateInput): Promise<RoomCreateOutcome>;
    /** Stops listening to the network. */
    dispose(): void;
}

export const ROOMS_PATH = '/api/rooms';
export const ROOM_PEOPLE_PATH = '/api/rooms/people';

const isRoom = (value: unknown): value is Pick<Conversation, 'id' | 'title'> =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id !== '' &&
    typeof (value as { title?: unknown }).title === 'string';

const isPerson = (value: unknown): value is RoomPerson =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { userId?: unknown }).userId === 'string' &&
    typeof (value as { name?: unknown }).name === 'string';

/** The request's body: the lead first, the further socios and the people only when there are any. */
export function roomCreateBody(input: RoomCreateInput): Record<string, unknown> {
    const socios = [...new Set(input.socioIds)];
    const further = socios.slice(1);
    const people = [...new Set(input.userIds)];
    return {
        dotId: socios[0] ?? '',
        title: input.title.trim(),
        ...(further.length > 0 ? { dotIds: further } : {}),
        ...(people.length > 0 ? { userIds: people } : {}),
    };
}

export function createRoomCreate(options: RoomCreateOptions): RoomCreate {
    const { fetch, network, away, hold, listed, refresh } = options;
    const listeners = new Set<() => void>();
    let inFlight = false;
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

    const unreachable = (): 'offline' | 'away' | null => {
        if (connected === false) {
            return 'offline';
        }
        return away() ? 'away' : null;
    };
    const blocked = (): RoomCreateBlock | null => unreachable() ?? hold();

    const send = async (json: unknown): Promise<RoomCreateOutcome> => {
        let answer;
        try {
            answer = await readAnswer(await fetch(ROOMS_PATH, { method: 'POST', json }));
        } catch {
            refresh();
            return { kind: 'no-answer' };
        }
        if (answer.status >= 200 && answer.status < 300) {
            if (!isRoom(answer.body)) {
                refresh();
                return { kind: 'no-answer' };
            }
            await listed(answer.body.id).catch(() => {});
            return { kind: 'done', room: { id: answer.body.id, title: answer.body.title } };
        }
        if (answer.status >= 500) {
            refresh();
            return { kind: 'no-answer' };
        }
        return { kind: 'refused', reason: answer.code ?? `http-${answer.status}` };
    };

    return {
        blocked,
        busy: () => inFlight,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async people() {
            // A read: it still goes while writes wait for a sign-in or an update.
            const reason = unreachable();
            if (reason !== null) {
                return { kind: 'blocked', reason };
            }
            let answer;
            try {
                answer = await readAnswer(await fetch(ROOM_PEOPLE_PATH, { method: 'GET' }));
            } catch {
                return { kind: 'no-answer' };
            }
            if (answer.status >= 200 && answer.status < 300) {
                return Array.isArray(answer.body)
                    ? { kind: 'done', people: answer.body.filter(isPerson) }
                    : { kind: 'refused', reason: 'unreadable' };
            }
            return answer.status >= 500
                ? { kind: 'no-answer' }
                : { kind: 'refused', reason: answer.code ?? `http-${answer.status}` };
        },
        async create(input) {
            const reason = blocked();
            if (reason !== null) {
                return { kind: 'blocked', reason };
            }
            if (inFlight) {
                return { kind: 'busy' };
            }
            inFlight = true;
            tell();
            try {
                return await send(roomCreateBody(input));
            } finally {
                inFlight = false;
                tell();
            }
        },
        dispose() {
            unsubscribe();
            listeners.clear();
        },
    };
}
