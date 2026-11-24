import { describe, expect, it } from 'vitest';

import { blockStyle, groupTimed } from '@socio/plugin-ui';
import { formatZonedLocal } from '@socio/shared/planner';
import { weightedLength, X_POST_LIMIT } from '@socio/shared/x-post';

import { placeOn } from '../src/plugins/planner/dates';
import { expandParts, nextQueueSlot, splitToLimit } from '../src/plugins/planner/thread';
import type { PlannedPost } from '../src/plugins/planner/types';

const post = (id: string, startMin: number): { post: PlannedPost; startMin: number } => ({
    startMin,
    post: {
        id,
        status: 'draft',
        account: 'acme',
        plannedAt: 0,
        topic: '',
        notes: '',
        parts: [{ text: id }],
    },
});

describe('planner calendar', () => {
    it('puts overlapping posts in side-by-side columns', () => {
        const groups = groupTimed([post('a', 9 * 60), post('b', 9 * 60 + 15)]);
        expect(groups).toHaveLength(2);
        const style = blockStyle(9 * 60, 1, 2);
        expect(style.left).toBe('50%');
        expect(style.width).toBe('50%');
    });

    it('keeps a later post in the same column when the block has ended', () => {
        const groups = groupTimed([post('a', 9 * 60), post('b', 10 * 60)]);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.map((item) => item.post.id)).toEqual(['a', 'b']);
    });

    it('places a slot on the New York wall clock', () => {
        const at = placeOn('2026-10-27', 9, 30);
        expect(at).toBeTypeOf('number');
        expect(formatZonedLocal(at!)).toBe('2026-10-27T09:30');
    });

    it('splits a long draft on the weighted limit and leaves short text alone', () => {
        expect(splitToLimit('Hello', X_POST_LIMIT)).toEqual(['Hello']);
        const long = Array.from({ length: 80 }, () => 'word').join(' ');
        const pieces = splitToLimit(long, X_POST_LIMIT);
        expect(pieces.length).toBeGreaterThan(1);
        for (const piece of pieces) {
            expect(weightedLength(piece)).toBeLessThanOrEqual(X_POST_LIMIT);
        }
        const expanded = expandParts([{ text: long, xId: 'kept' }], X_POST_LIMIT);
        expect(expanded[0]?.xId).toBe('kept');
        expect(expanded[1]?.xId).toBe('');
    });

    it('offers the next open queue slot', () => {
        expect(nextQueueSlot(['2026-10-27T09:00'], '2026-10-27T09:00')).toBe('2026-10-27T09:30');
    });
});
