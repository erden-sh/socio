import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ART_DIR, CHARACTERS, stripTile, TILED } from '../src/build/art.ts';

import { readBuilt } from './helpers.ts';

// The characters come from the client's art at build time, with the four original drawings'
// cream tiles stripped, so a redrawn character reaches the site by itself.

const original = (id: string) => readFileSync(join(ART_DIR, `${id}.svg`), 'utf8');
/** The cream tile: a <rect> in one of the drawings' creams (the same cream may color other parts). */
const CREAM = /<rect\b[^>]*fill="#F[45]E[AB]D[3-6]"/i;

describe('the character art', () => {
    it('serves all eight characters, each the client’s drawing less its tile', () => {
        expect(CHARACTERS).toHaveLength(8);
        for (const id of CHARACTERS) {
            const built = readBuilt(`art/${id}.svg`);
            expect(built, id).toBe(stripTile(id, original(id)));
            expect(built, id).not.toMatch(CREAM);
            expect(built.startsWith('<svg'), id).toBe(true);
        }
    });

    it('removes exactly the one cream tile from sebas, manny, mingo and rulo, and nothing else', () => {
        for (const id of CHARACTERS) {
            const before = original(id);
            const after = stripTile(id, before);
            const removed = before.length - after.length;
            if (TILED.includes(id)) {
                expect(before, id).toMatch(CREAM);
                expect(removed, id).toBeGreaterThan(30);
                expect(removed, id).toBeLessThan(90);
                expect(after.match(/<rect\b/g)?.length ?? 0, id).toBe((before.match(/<rect\b/g)?.length ?? 0) - 1);
            } else {
                expect(after, id).toBe(before);
            }
        }
    });

    it('refuses a drawing whose tile count is unexpected, rather than ship a tile', () => {
        expect(() => stripTile('lino', `<svg><rect width="1" height="1" rx="1" fill="#F5EAD3"/></svg>`)).toThrow();
        expect(() => stripTile('sebas', '<svg></svg>')).toThrow();
    });

    it('makes the favicon from Sebas', () => {
        expect(readBuilt('favicon.svg')).toBe(readBuilt('art/sebas.svg'));
    });
});
