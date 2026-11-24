import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SOURCES } from '../../scripts/generate-theme.mts';
import { composite, contrast, oklchToRgb, parseColor, rgba, toHex, withContrast } from '../../scripts/theme/color.mts';
import { readBlock } from '../../scripts/theme/sources.mts';

// The generator's color math: OKLCH to sRGB hex (React Native takes no
// OKLCH), a tint composited over its surface, and WCAG contrast.

const palette = readBlock(readFileSync(SOURCES.tailwind, 'utf8'), '@theme default');

describe('OKLCH to hex', () => {
    // Tailwind 4's colors as their sRGB hexes are listed, clipped per channel
    // where the color reaches past sRGB. T3 Code's palette at 240446e2d9
    // (packages/shared/src/themePalettes.ts) holds the zinc, amber, red and
    // blue ones as literals; the others are the tones' shades.
    const KNOWN: Record<string, string> = {
        'zinc-100': '#f4f4f5',
        'zinc-200': '#e4e4e7',
        'zinc-500': '#71717b',
        'zinc-800': '#27272a',
        'zinc-900': '#18181b',
        'neutral-50': '#fafafa',
        'neutral-500': '#737373',
        'amber-400': '#ffb900',
        'red-400': '#ff6467',
        'red-500': '#fb2c36',
        'red-700': '#c10007',
        'blue-400': '#51a2ff',
        'slate-50': '#f8fafc',
        'sky-300': '#74d4ff',
        'sky-500': '#00a6f4',
        'sky-700': '#0069a8',
        'amber-300': '#ffd230',
        'amber-500': '#fe9a00',
        'amber-700': '#bb4d00',
        'violet-300': '#c4b4ff',
        'violet-500': '#8e51ff',
        'violet-700': '#7008e7',
        'emerald-300': '#5ee9b5',
        'emerald-500': '#00bc7d',
        'emerald-700': '#007a55',
        'orange-300': '#ffb86a',
        'orange-500': '#ff6900',
        'orange-700': '#ca3500',
        'slate-300': '#cad5e2',
        'slate-500': '#62748e',
        'slate-700': '#314158',
        'indigo-300': '#a3b3ff',
        'indigo-500': '#615fff',
        'indigo-700': '#432dd7',
        'rose-300': '#ffa1ad',
        'rose-500': '#ff2056',
        'rose-700': '#c70036',
    };

    it.each(Object.entries(KNOWN))('gives Tailwind 4.3.3’s %s as %s', (name, hex) => {
        const value = palette[`color-${name}`];
        expect(value, name).toMatch(/^oklch\(/);
        expect(toHex(oklchToRgb(value!))).toBe(hex);
    });

    it('takes plain numbers, percentages and `none`', () => {
        expect(toHex(oklchToRgb('oklch(1 0 0)'))).toBe('#ffffff');
        expect(toHex(oklchToRgb('oklch(0% 0 0)'))).toBe('#000000');
        expect(toHex(oklchToRgb('oklch(100% 0 none)'))).toBe('#ffffff');
        expect(toHex(oklchToRgb('oklch(55.6% none none)'))).toBe('#737373');
    });

    it('refuses what it can’t make opaque sRGB of', () => {
        expect(() => oklchToRgb('oklch(50% 0.1 120 / 0.5)')).toThrow(/Not an opaque oklch/);
        expect(() => parseColor('rgb(0 0 0)')).toThrow(/Not an opaque hex or oklch/);
        expect(() => parseColor('#12345')).toThrow();
    });

    it('reads hex in three or six digits, either case', () => {
        expect(parseColor('#fff')).toEqual([255, 255, 255]);
        expect(parseColor('#3D7E75')).toEqual([61, 126, 117]);
        expect(toHex([61, 126, 117])).toBe('#3d7e75');
    });
});

describe('compositing', () => {
    it('lays a translucent color over a surface in sRGB, as the browser paints it', () => {
        // sky-500 at 12% over white and over the dark page.
        expect(toHex(composite([0, 166, 244], 0.12, [255, 255, 255]))).toBe('#e0f4fe');
        expect(toHex(composite([0, 166, 244], 0.12, [20, 20, 21]))).toBe('#122630');
        expect(composite([10, 20, 30], 1, [255, 255, 255])).toEqual([10, 20, 30]);
        expect(composite([10, 20, 30], 0, [1, 2, 3])).toEqual([1, 2, 3]);
        expect(rgba([0, 166, 244], 0.12)).toBe('rgba(0, 166, 244, 0.12)');
    });
});

describe('contrast', () => {
    it.each([
        ['#ffffff', '#000000', 21],
        ['#777777', '#777777', 1],
        ['#767676', '#ffffff', 4.54],
        ['#ffffff', '#38766d', 5.28],
        ['#9b865e', '#f3eee4', 3.04],
    ])('puts %s on %s at %d:1', (a, b, ratio) => {
        expect(contrast(a, b)).toBeCloseTo(ratio, 2);
        expect(contrast(b, a)).toBeCloseTo(ratio, 2);
    });

    it('moves a color only as far as it takes to reach a ratio (T3 Code’s correction)', () => {
        // Already there: unchanged.
        expect(withContrast('#000000', ['#ffffff'], 4.5)).toBe('#000000');
        // The web's selected row on its sidebar, light and dark: darker, then lighter.
        const light = withContrast('#f1f1f1', ['#f9f9f9', '#ffffff'], 1.2);
        expect(contrast(light, '#f9f9f9')).toBeGreaterThanOrEqual(1.2);
        expect(contrast(light, '#f9f9f9')).toBeLessThan(1.25);
        expect(parseColor(light)[0]).toBeLessThan(0xf1);
        const dark = withContrast('#1d1d1f', ['#0f0f10', '#141415'], 1.2);
        expect(Math.min(contrast(dark, '#0f0f10'), contrast(dark, '#141415'))).toBeGreaterThanOrEqual(1.2);
        expect(parseColor(dark)[0]).toBeGreaterThan(0x1d);
        // Unreachable against both ends: black or white, the best there is.
        expect(withContrast('#777777', ['#000000', '#ffffff'], 21)).toMatch(/^#(?:000000|ffffff)$/);
    });
});
