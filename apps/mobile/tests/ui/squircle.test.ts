import { describe, expect, it } from 'vitest';

import { squirclePath } from '../../src/ui/squircle-path';

// The avatar fallback's shape is a superellipse (|x|^n + |y|^n = 1), not a
// rounded rectangle: every point of the path lies on that curve.
describe('squirclePath', () => {
    it('puts every point on the superellipse inside the square', () => {
        const size = 40;
        const r = size / 2;
        const points = [...squirclePath(size).matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [
            Number(m[1]),
            Number(m[2]),
        ]);
        expect(points.length).toBeGreaterThan(32);
        for (const [x, y] of points) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(size);
            const value = Math.abs((x - r) / r) ** 5 + Math.abs((y - r) / r) ** 5;
            expect(value).toBeCloseTo(1, 1);
        }
    });

    it('reaches the middle of each side, unlike a circle bulging less at the corners', () => {
        const d = squirclePath(40);
        expect(d).toContain('40.00,20.00');
        // At 45°, a superellipse reaches further into the corner than a circle (r·0.707 from the centre).
        const corner = 20 + 20 * Math.SQRT1_2 ** (2 / 5);
        expect(corner).toBeGreaterThan(20 + 20 * Math.SQRT1_2);
    });
});
