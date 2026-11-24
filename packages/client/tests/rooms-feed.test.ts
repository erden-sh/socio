import { expect, it } from 'vitest';

import { stillDelivering } from '../src/modules/rooms/feed';
import { personTones, toneOf } from '../src/modules/rooms/RoomSpeaker';

// CB-212 follow-ups, the web's own rules (the room view's and the live
// turn's are shared's: tests/shared-room-view.test.ts,
// tests/shared-live-turn.test.ts): avatar tones as the web's classes, and a
// queued message a room admin cancelled.

it('gives two people with one name different avatar tones, and anyone else their name’s', () => {
    const tones = personTones([
        { id: 'ana-2', name: 'Ana Lima' },
        { id: 'ana-1', name: 'Ana Lima' },
        { id: 'ana-1', name: 'Ana Lima' },
        { id: 'mo', name: 'Mo' },
        { name: 'No id' },
    ]);
    expect(tones.get('ana-1')).toBe(toneOf('Ana Lima'));
    expect(tones.get('ana-2')).not.toBe(tones.get('ana-1'));
    expect(tones.get('mo')).toBe(toneOf('Mo'));
    expect(tones.size).toBe(3);
});

it('drops a queued message a room admin cancelled while a turn runs, and keeps one the turn took (CB-215)', () => {
    const queued = (id: string) => ({
        id,
        text: id,
        createdAt: 1,
        updatedAt: 1,
    });
    // Both left the reader's queue during a turn; neither shows yet.
    const left = [queued('taken'), queued('cancelled')];
    expect(stillDelivering(left, [], [], ['someone-else', 'taken']).map((m) => m.id)).toEqual(['taken']);
    // Nothing the turn took: both were canceled.
    expect(stillDelivering(left, [], [], [])).toEqual([]);
    // An older server that doesn't say: as before, both are being read.
    expect(stillDelivering(left, [], []).map((m) => m.id)).toEqual(['taken', 'cancelled']);
});
