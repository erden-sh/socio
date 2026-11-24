// Color math for the theme generator: OKLCH to sRGB, a tint composited over
// its surface, and WCAG contrast. React Native takes no OKLCH, so Tailwind's
// palette crosses into the app as sRGB hex.
//
// Based on the color math in T3 Code's apps/mobile/src/lib/mobileTheme.ts
// (https://github.com/pingdotgg/t3code, commit 240446e2d9, MIT, Copyright (c)
// 2026 T3 Tools Inc.; the license is in THIRD_PARTY_NOTICES at the repository
// root): its OKLab to linear sRGB matrices and per-channel clip, its flattening
// of a translucent color over a surface, and its themeColorWithContrast, the
// correction that keeps a selected row visible.
// Ported rather than vendored: lightness may be a percentage, as Tailwind
// writes it, and colors pass between steps as channel triples, not strings.

/** An opaque sRGB color, 0 to 255 per channel. */
export type Rgb = readonly [red: number, green: number, blue: number];

const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+|none)\s+(-?[\d.]+|none)\s*\)$/;
const HEX = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

/** OKLab to linear sRGB (Björn Ottosson's matrices, as T3 Code has them). */
function oklabToLinearSrgb(lightness: number, a: number, b: number): Rgb {
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
}

/** A linear channel as an 8-bit sRGB one, clipped to the gamut. */
function linearToSrgb(value: number): number {
    const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

/**
 * An `oklch(L C H)` color in sRGB. A color outside sRGB (Tailwind 4's palette
 * reaches into Display P3) is clipped per channel, as T3 Code does; that gives
 * the hexes Tailwind 4's colors are listed with.
 */
export function oklchToRgb(value: string): Rgb {
    const match = OKLCH.exec(value.trim());
    if (!match) {
        throw new Error(`Not an opaque oklch() color: ${value}`);
    }
    // `none` (an achromatic color's hue, in Tailwind's neutrals) counts as 0.
    const number = (text: string) => (text === 'none' ? 0 : Number(text));
    const lightness = Number(match[1]) / (match[2] === '%' ? 100 : 1);
    const chroma = number(match[3]!);
    const hue = (number(match[4]!) * Math.PI) / 180;
    const linear = oklabToLinearSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
    return [linearToSrgb(linear[0]), linearToSrgb(linear[1]), linearToSrgb(linear[2])];
}

/** `#rgb`, `#rrggbb` or `oklch(L C H)` as sRGB channels. */
export function parseColor(value: string): Rgb {
    const text = value.trim();
    if (text.startsWith('oklch(')) {
        return oklchToRgb(text);
    }
    if (!HEX.test(text)) {
        throw new Error(`Not an opaque hex or oklch() color: ${value}`);
    }
    const digits = text.length === 4 ? [...text.slice(1)].map((digit) => digit + digit).join('') : text.slice(1);
    return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16)) as unknown as Rgb;
}

/** Whether `value` is a color parseColor reads. */
export const isColor = (value: string) => {
    const text = value.trim();
    return HEX.test(text) || OKLCH.test(text);
};

/** Lowercase `#rrggbb`. */
export const toHex = (rgb: Rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

/** `rgba(r, g, b, a)`, a translucent color both React Native and uniwind take. */
export const rgba = (rgb: Rgb, alpha: number) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;

/** `color` at `alpha` over an opaque surface, composited in sRGB as the browser paints it. */
export const composite = (color: Rgb, alpha: number, surface: Rgb): Rgb =>
    [0, 1, 2].map((index) =>
        Math.max(0, Math.min(255, Math.round(color[index]! * alpha + surface[index]! * (1 - alpha)))),
    ) as unknown as Rgb;

const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2 relative luminance. */
export const luminance = (rgb: Rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);

const ratio = (first: Rgb, second: Rgb) => {
    const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (high! + 0.05) / (low! + 0.05);
};

/** WCAG 2 contrast ratio of two opaque colors, 1 to 21. */
export const contrast = (first: string, second: string) => ratio(parseColor(first), parseColor(second));

/**
 * `color`, unchanged if it already contrasts `minimum` or more with every
 * surface; otherwise blended toward black or white (whichever contrasts more
 * with the surfaces) just far enough to. T3 Code's themeColorWithContrast:
 * twelve halvings of the blend.
 */
export function withContrast(color: string, surfaces: readonly string[], minimum: number): string {
    const start = parseColor(color);
    const behind = surfaces.map(parseColor);
    const lowest = (candidate: Rgb) => Math.min(...behind.map((surface) => ratio(candidate, surface)));
    if (behind.length === 0 || lowest(start) >= minimum) {
        return toHex(start);
    }
    const black: Rgb = [0, 0, 0];
    const white: Rgb = [255, 255, 255];
    const target = lowest(black) >= lowest(white) ? black : white;
    let readable = target;
    let lower = 0;
    let upper = 1;
    for (let step = 0; step < 12; step += 1) {
        const amount = (lower + upper) / 2;
        const candidate = [0, 1, 2].map((index) =>
            Math.round(start[index]! + (target[index]! - start[index]!) * amount),
        ) as unknown as Rgb;
        if (lowest(candidate) >= minimum) {
            readable = candidate;
            upper = amount;
        } else {
            lower = amount;
        }
    }
    return toHex(readable);
}
