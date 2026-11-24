import { expect, it } from 'vitest';

import type { QueuedMessage } from '@socio/shared/chat/steering';
import { notesForWrite } from '@socio/shared/live/change-notes';
import type { RoomView } from '@socio/shared/rooms/rooms';

import { stillDelivering, stillQueued, tookFromQueue, type RoomMessage } from '../src/modules/rooms/feed';
import { soleAdmin, successorsOf } from '../src/modules/rooms/MembersPanel';
import { toneOf } from '../src/modules/rooms/RoomSpeaker';

// CB-212 (client half): the web's own room rules (the room view's are
// shared's: tests/shared-room-view.test.ts). A queued message shown once
// between the queue and the transcript, the last admin, and the notes other
// tabs get after a room change.

const queued = (id: string): QueuedMessage => ({
    id,
    text: id,
    createdAt: 1,
    updatedAt: 1,
});
const stored = (id: string): RoomMessage => ({
    id,
    role: 'user',
    content: id,
});
const member = (userId: string, role: 'admin' | 'member', status: 'active' | 'invited' = 'active') => ({
    userId,
    name: userId.toUpperCase(),
    role,
    status,
    invitedBy: null,
    invitedAt: 1,
    inviteExpiresAt: null,
    acceptedAt: 1,
});
const view = (extra: Partial<RoomView> = {}): RoomView => ({
    id: 'r1',
    title: 'Room',
    dotId: 'd1',
    createdAt: 1,
    createdBy: 'a',
    convertedAt: null,
    archivedAt: null,
    role: 'admin',
    roomsEnabled: true,
    members: [member('a', 'admin'), member('b', 'member')],
    socios: [{ dotId: 'd1', name: 'Sebas', status: 'active', lead: true }],
    ...extra,
});
it('shows a queued message once, as it moves to the transcript', () => {
    // Read in both places at once: delivered.
    expect(stillQueued([queued('q1'), queued('q2')], [stored('q1')])).toEqual([queued('q2')]);
    expect(stillQueued([queued('q1')], undefined)).toEqual([queued('q1')]);
    // Left the queue, not stored yet: a turn took it.
    expect(tookFromQueue([queued('q1'), queued('q2')], [queued('q2')], [])).toEqual([queued('q1')]);
    expect(tookFromQueue([queued('q1')], [], [stored('q1')])).toEqual([]);
    // Being read until stored, or put back in the queue; each once.
    const reading = [queued('q1'), queued('q1'), queued('q2'), queued('q3')];
    expect(stillDelivering(reading, [queued('q2')], [stored('q3')]).map((m) => m.id)).toEqual(['q1']);
});

it('knows the last admin and who could take the role on', () => {
    expect(soleAdmin(view(), 'a')).toBe(true);
    expect(soleAdmin(view(), 'b')).toBe(false);
    expect(soleAdmin(view({ members: [member('a', 'admin'), member('b', 'admin')] }), 'a')).toBe(false);
    // Invited people can't take it on: they haven't joined.
    expect(
        successorsOf(
            view({
                members: [member('a', 'admin'), member('b', 'member'), member('c', 'member', 'invited')],
            }),
            'a',
        ),
    ).toEqual([{ userId: 'b', name: 'B' }]);
});

it('gives the same name the same tone', () => {
    expect(toneOf('Ana')).toBe(toneOf('Ana'));
});

it('tells other tabs about a room change, by its id only', () => {
    expect(notesForWrite('rooms/r1/invites')).toEqual([{ topic: 'conversation', id: 'r1' }]);
    expect(notesForWrite('rooms/r1/members/bob')).toEqual([{ topic: 'conversation', id: 'r1' }]);
    expect(notesForWrite('rooms')).toEqual([{ topic: 'conversation' }]);
    expect(notesForWrite('rooms/invites')).toEqual([{ topic: 'conversation' }]);
});
