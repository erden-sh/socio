import theme from './generated/theme.json';

// The generated theme (scripts/generate-theme.mts) for code that takes values,
// not class names: React Navigation, the system bars, SVG icons, the type
// scale. No React Native here, so the Node tests read it as the app does.

export { theme };

export const SCHEMES = ['light', 'dark'] as const;

/** A color scheme: the system's, as uniwind follows it. */
export type Scheme = (typeof SCHEMES)[number];

/** A web token, or one of the mobile roles derived from one. */
export type ColorToken = keyof typeof theme.light.colors;

export type Colors = Readonly<Record<ColorToken, string>>;

/** A module tone (the web's shell/tones.ts). */
export type ToneName = keyof typeof theme.light.tones;

/** A surface a tone tile sits on; each has the tile's tint composited over it. */
export type TileSurface = keyof typeof theme.light.tones.mint.tiles;

/** A step of the web's type scale (Tailwind's text-*). */
export type TextSize = keyof typeof theme.type.sizes;

/** A step of the web's font weights (Tailwind's font-*). */
export type FontWeightName = keyof typeof theme.type.weights;

export const colorsOf = (scheme: Scheme): Colors => theme[scheme].colors;
