import type { RoomInvite } from '@socio/shared/rooms/rooms';

import type { SnapshotDefinition } from './snapshot-cache';
import { keyed, list } from './snapshot-shape';

// The room invites kind: the
// invites waiting for the person, `GET /api/rooms/invites` (the server's
// `rooms.invites`, shared's `RoomInvite`): each room's name, who asked, how
// many are in it and the disclosure to accept, never its history.
// - `room-invites` (the scope's `roomInvites`) holds them by room id, unversioned, kept in cache.db so the
//   Inbox and Home show them offline; accepting and declining are online only
//   (room-actions.ts).
// - The path sends no ETag (a plain c.json), so the source keeps a hash of the
//   body in its place (`hashBody`).
// - Only the Inbox and Home show it, so it is pulled while one of them is in
//   view (`inView`, kinds.ts): as it comes into view, on a return or the
//   network back meanwhile, and every 60 s while it stays. An accept or
//   decline, and a "not found" answer to either, pulls it again
//   (room-actions.ts); PT's push linking to `/` pokes it too once PT lands.

export const ROOM_INVITES = 'room-invites';

/** How often the Inbox or Home, in view, asks again. */
export const ROOM_INVITES_POLL_MS = 60_000;

const ROOM_INVITES_PATH = '/api/rooms/invites';

/** `GET /api/rooms/invites`: the invites waiting, by room id. */
export const ROOM_INVITES_SNAPSHOT: SnapshotDefinition = {
    id: 'room-invites',
    path: ROOM_INVITES_PATH,
    format: 1,
    hashBody: true,
    feeds: [{ collection: ROOM_INVITES }],
    split(body) {
        return [keyed(ROOM_INVITES_PATH, list(ROOM_INVITES_PATH, body, 'the body'), 'the invites', { key: 'roomId' })];
    },
};

/** An invite's row as its collection holds it: the invite the server sent. */
export const roomInviteRow = (_key: string, value: unknown): RoomInvite => value as RoomInvite;
