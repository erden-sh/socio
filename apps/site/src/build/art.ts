import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The socio characters, from the client's own art (packages/client/src/locals/art), so a redrawn
// character reaches the site by itself. The four original drawings (sebas, manny, mingo, rulo)
// start with a cream rounded tile behind the character; the site strips it at build time so the
// characters stand free on any background. The newer four have no tile.

export const CHARACTERS = ['sebas', 'manny', 'mingo', 'rulo', 'lino', 'flake', 'iggy', 'rosy'] as const;
export type Character = (typeof CHARACTERS)[number];

/** The ones drawn on a cream tile. */
export const TILED: readonly Character[] = ['sebas', 'manny', 'mingo', 'rulo'];

export const ART_DIR = join(import.meta.dirname, '../../../../packages/client/src/locals/art');

/** The cream tile: a rounded <rect> filled with one of the drawings' creams (#F4–F5, E A–B, D 3–6). */
const TILE = /<rect\b[^>]*\bfill="#F[45]E[AB]D[3-6]"[^>]*\/>/gi;

/** The drawing with its cream tile removed. Throws unless it has exactly one when tiled, none otherwise. */
export function stripTile(id: Character, svg: string): string {
    const tiles = svg.match(TILE) ?? [];
    const expected = TILED.includes(id) ? 1 : 0;
    if (tiles.length !== expected) {
        throw new Error(`${id}.svg: ${tiles.length} cream tiles, expected ${expected}`);
    }
    return svg.replace(TILE, '');
}

export const readArt = (id: Character) => stripTile(id, readFileSync(join(ART_DIR, `${id}.svg`), 'utf8'));

/** Where a character is served from. */
export const artPath = (id: Character) => `/art/${id}.svg`;
