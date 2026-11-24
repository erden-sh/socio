import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { characterOf, LOCALS, type LocalId } from '@socio/shared/mascot';

import { LOCAL_ART, LOCAL_ART_MAX, socioPicture } from '../../src/ui/local-art';

// A socio's avatar (src/ui/local-art.ts): its Local's picture, the web's
// mascot, else the Local's initial. Under Vite a PNG import is the file's
// path, so each Local's entry can be checked against its own file.

const ASSETS = join(import.meta.dirname, '../../assets/locals');

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(path: string): [number, number] {
    const bytes = readFileSync(path);
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('socio pictures', () => {
    it('give every Local its own picture', () => {
        expect(Object.keys(LOCAL_ART).sort()).toEqual([...LOCALS].sort());
        for (const local of LOCALS) {
            const picture = socioPicture(local);
            expect(picture.kind).toBe('art');
            expect(picture.local).toBe(local);
            expect(String(picture.kind === 'art' ? picture.source : '')).toMatch(new RegExp(`/locals/${local}\\.png$`));
        }
    });

    it('follow the socio’s chosen Local, else its id’s, as the web does', () => {
        const chosen = characterOf({ id: 'dot-1', character: 'rosy' });
        expect(socioPicture(chosen)).toMatchObject({ kind: 'art', local: 'rosy', source: LOCAL_ART.rosy });
        // A character the shared roster doesn't know falls back to the id's Local, never to nothing.
        const unknown = characterOf({ id: 'dot-1', character: 'dragon' });
        expect(LOCALS).toContain(unknown);
        expect(unknown).toBe(characterOf({ id: 'dot-1', character: null }));
        expect(socioPicture(unknown).kind).toBe('art');
    });

    it('fall back to the Local’s initial when it has no picture', () => {
        const art: Partial<Record<LocalId, string>> = { sebas: 'sebas.png' };
        expect(socioPicture('sebas', art)).toEqual({ kind: 'art', local: 'sebas', source: 'sebas.png' });
        expect(socioPicture('manny', art)).toEqual({ kind: 'initial', local: 'manny', initial: 'M' });
        expect(socioPicture('rosy', {})).toEqual({ kind: 'initial', local: 'rosy', initial: 'R' });
    });

    it('ship at 1x, 2x and 3x for the largest avatar, with the tile left out', () => {
        for (const local of LOCALS) {
            for (const [suffix, scale] of [
                ['', 1],
                ['@2x', 2],
                ['@3x', 3],
            ] as const) {
                expect(pngSize(join(ASSETS, `${local}${suffix}.png`))).toEqual([
                    LOCAL_ART_MAX * scale,
                    LOCAL_ART_MAX * scale,
                ]);
            }
        }
    });
});
