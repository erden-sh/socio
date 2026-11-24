import { ROOM_PRESENCE_POLL_MS, type RoomPresenceView } from '@socio/shared/rooms/room-notices';
import { readOnlyReason } from '@socio/shared/rooms/room-view';
import type { RoomView } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { type BoundedKindDefinition, type BoundedStore, createBoundedStore } from './bounded-kind';
import { HttpError, httpError, SnapshotShapeError } from './errors';
import type { FollowStore } from './follow';
import { type AppStateSource, isForeground } from './triggers';

// A room's data beside its history. The history, steering
// snapshot and follow stream serve a room as they serve a chat (`/history`,
// `/steering`, `/stream`, filtered per reader by the server); what they lack is
// here:
// - **The room's view** (`GET /api/rooms/:id`: its people and socios, the
//   reader's role, the switch), a bounded kind (bounded-kind.ts) keyed by room
//   id, kept in cache.db so a room opens offline with its header and its
//   people's current names (names come from here, the stamped
//   `socioSenderName` is the fallback). A 404 drops it and tells `onGone`.
// - **Its watch** (`show`): while a screen shows a room, its view is read on
//   open, every ROOM_VIEW_POLL_MS (10 s, the web's) in the foreground, on each
//   return, and when its follow stream ends with a reason (`closed`: removed,
//   left, archived, Rooms off); its presence (`GET /api/rooms/:id/presence`,
//   who else is looking) every ROOM_PRESENCE_POLL_MS (5 s), in memory only,
//   never cached. A presence 404 empties it and stops asking until shown again.
// - **`roomReadOnly`**: Rooms off or the room archived makes it read-only
//   (shared's `readOnlyReason`), from the shell's switch, the chat row and the
//   view.
// No React Native: tests/sync runs it under Node.

export const ROOM_VIEW_KIND = 'room-view';
/** Room views kept on disk at most. */
export const ROOM_VIEWS_KEPT = 100;
/** About how many characters of room views are kept on disk at most. */
export const ROOM_VIEWS_CHARS = 5_000_000;
/** How often a shown room's view is read again (the web's ROOM_VIEW_POLL_MS). */
export const ROOM_VIEW_POLL_MS = 10_000;
export { ROOM_PRESENCE_POLL_MS };

function checkView(path: string, body: unknown): RoomView {
    const view = body as Partial<RoomView> | null;
    if (!view || typeof view !== 'object' || typeof view.id !== 'string' || typeof view.dotId !== 'string') {
        throw new SnapshotShapeError(path, 'no room id or lead socio.');
    }
    if (!Array.isArray(view.members) || !Array.isArray(view.socios)) {
        throw new SnapshotShapeError(path, 'no members or socios.');
    }
    if (typeof view.roomsEnabled !== 'boolean' || (view.role !== 'admin' && view.role !== 'member')) {
        throw new SnapshotShapeError(path, 'no role or switch.');
    }
    for (const member of view.members as unknown[]) {
        const m = member as Partial<RoomView['members'][number]> | null;
        if (!m || typeof m.userId !== 'string' || typeof m.name !== 'string') {
            throw new SnapshotShapeError(path, 'a member without an id or name.');
        }
    }
    for (const socio of view.socios as unknown[]) {
        const s = socio as Partial<RoomView['socios'][number]> | null;
        if (!s || typeof s.dotId !== 'string' || typeof s.name !== 'string') {
            throw new SnapshotShapeError(path, 'a socio without an id or name.');
        }
    }
    return view as RoomView;
}

export const ROOM_VIEWS: BoundedKindDefinition<RoomView> = {
    name: ROOM_VIEW_KIND,
    format: 1,
    bounds: { items: ROOM_VIEWS_KEPT, chars: ROOM_VIEWS_CHARS },
    path: (key) => `/api/rooms/${encodeURIComponent(key)}`,
    parse: checkView,
};

export type RoomViews = BoundedStore<RoomView>;

export interface RoomViewsOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    /** A room the server says is gone for the reader (404): its writes go to the Unsent list. */
    readonly onGone?: (roomId: string) => void;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** Opens the scope's room views on its cache.db. */
export function createRoomViews(options: RoomViewsOptions): RoomViews {
    const { onGone, ...rest } = options;
    return createBoundedStore<RoomView>({
        definition: ROOM_VIEWS,
        ...rest,
        ...(onGone ? { onGone: (key: string) => onGone(key) } : {}),
    });
}

/**
 * Why nobody can write in the room now, or undefined when they can: Rooms off
 * (the shell's switch or the view's), the room archived, or no lead socio.
 */
export function roomReadOnly(
    room: Pick<Conversation, 'archivedAt'>,
    view: Pick<RoomView, 'roomsEnabled' | 'socios' | 'archivedAt'> | null | undefined,
    roomsEnabled: boolean,
): string | undefined {
    const archivedAt = room.archivedAt ?? view?.archivedAt ?? undefined;
    return readOnlyReason({ archivedAt }, view ?? undefined, roomsEnabled);
}

/** Who else of the room is looking at it, as its last read said. */
export interface RoomPresenceState {
    readonly people: RoomPresenceView['people'];
    /** The server answered 404: the reader isn't in the room; nothing more is asked while shown. */
    readonly gone: boolean;
}

const NOBODY: RoomPresenceState = { people: [], gone: false };

export interface RoomPresence {
    readonly state: RoomPresenceState;
    /** Calls `listener` after each change of `state`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
}

export interface RoomWatch {
    /**
     * A screen shows room `roomId`: its view is held (`use`) and read now, then
     * polled with its presence while the app is in the foreground. Returns the release.
     */
    show(roomId: string): () => void;
    /** Room `roomId`'s presence, empty while it isn't shown. */
    presence(roomId: string): RoomPresence;
    /** Stops every poll and takes no more. */
    close(): void;
}

export interface RoomWatchOptions {
    readonly views: RoomViews;
    /** The follow streams: a room's stream that ends with a reason reads its view again. */
    readonly follows: Pick<FollowStore, 'follow'>;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly appState: AppStateSource;
    readonly onError?: (error: unknown) => void;
    /** ROOM_VIEW_POLL_MS and ROOM_PRESENCE_POLL_MS by default. */
    readonly viewPollMs?: number;
    readonly presencePollMs?: number;
}

export function createRoomWatch(options: RoomWatchOptions): RoomWatch {
    const { views, follows, fetch, signal, appState, onError = () => {} } = options;
    const viewPollMs = options.viewPollMs ?? ROOM_VIEW_POLL_MS;
    const presencePollMs = options.presencePollMs ?? ROOM_PRESENCE_POLL_MS;
    const presences = new Map<string, Presence>();
    const shown = new Map<string, { count: number; stop: () => void }>();
    let closed = false;

    class Presence implements RoomPresence {
        state: RoomPresenceState = NOBODY;
        private listeners = new Set<() => void>();
        /** Bumped by each read and each reset: an older answer is dropped. */
        private reads = 0;

        constructor(private readonly roomId: string) {}

        subscribe = (listener: () => void) => {
            this.listeners.add(listener);
            return () => void this.listeners.delete(listener);
        };

        private set(next: RoomPresenceState) {
            this.state = next;
            for (const listener of [...this.listeners]) {
                listener();
            }
        }

        reset() {
            this.reads += 1;
            if (this.state !== NOBODY) {
                this.set(NOBODY);
            }
        }

        async read() {
            if (this.state.gone || closed) {
                return;
            }
            const read = (this.reads += 1);
            const path = `/api/rooms/${encodeURIComponent(this.roomId)}/presence`;
            try {
                const response = await fetch(path, signal ? { signal } : {});
                if (!response.ok) {
                    throw await httpError(response, signal);
                }
                const body = (await readJson(response, signal)) as Partial<RoomPresenceView> | null;
                if (read !== this.reads || closed) {
                    return;
                }
                const people = Array.isArray(body?.people)
                    ? body.people.filter(
                          (person): person is RoomPresenceView['people'][number] =>
                              !!person && typeof person.userId === 'string' && typeof person.name === 'string',
                      )
                    : [];
                this.set({ people, gone: false });
            } catch (error) {
                if (read !== this.reads || closed) {
                    return;
                }
                if (error instanceof HttpError && error.status === 404) {
                    this.set({ people: [], gone: true });
                    return;
                }
                // Offline or the server failed: the last people stay until the next read.
                if (!(error instanceof HttpError)) {
                    return;
                }
                onError(error);
            }
        }
    }

    const presenceOf = (roomId: string) => {
        let presence = presences.get(roomId);
        if (!presence) {
            presence = new Presence(roomId);
            presences.set(roomId, presence);
        }
        return presence;
    };

    function start(roomId: string): () => void {
        const item = views.item(roomId);
        const release = item.use();
        const presence = presenceOf(roomId);
        presence.reset();
        void presence.read();
        const refresh = () => void item.refresh().catch(onError);
        const foreground = () => isForeground(appState.current());
        const viewTimer = setInterval(() => {
            if (foreground()) {
                refresh();
            }
        }, viewPollMs);
        const presenceTimer = setInterval(() => {
            if (foreground()) {
                void presence.read();
            }
        }, presencePollMs);
        let background = !foreground();
        const unsubscribeApp = appState.subscribe((state) => {
            if (!isForeground(state)) {
                background = true;
            } else if (background) {
                background = false;
                refresh();
                void presence.read();
            }
        });
        // A stream that ends with a reason (removed, archived, Rooms off): the view says what changed.
        const follow = follows.follow(roomId);
        let ended = follow.state.ended;
        const unsubscribeFollow = follow.subscribe(() => {
            const next = follow.state.ended;
            if (next !== ended) {
                ended = next;
                if (next !== null) {
                    refresh();
                }
            }
        });
        return () => {
            clearInterval(viewTimer);
            clearInterval(presenceTimer);
            unsubscribeApp();
            unsubscribeFollow();
            presence.reset();
            release();
        };
    }

    return {
        show(roomId) {
            if (closed) {
                return () => {};
            }
            const current = shown.get(roomId);
            if (current) {
                current.count += 1;
            } else {
                shown.set(roomId, { count: 1, stop: start(roomId) });
            }
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                const entry = shown.get(roomId);
                if (!entry) {
                    return;
                }
                entry.count -= 1;
                if (entry.count === 0) {
                    shown.delete(roomId);
                    entry.stop();
                }
            };
        },
        presence: presenceOf,
        close() {
            closed = true;
            for (const entry of shown.values()) {
                entry.stop();
            }
            shown.clear();
            presences.clear();
        },
    };
}
