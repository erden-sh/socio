import { useUniwind } from 'uniwind';

import { type Colors, colorsOf, type Scheme } from './theme';

// The scheme the app draws in: uniwind's, which follows the system's, or the
// person's Light or Dark from Settings (8.8; src/platform/device-settings.ts
// sets it), so class names, the navigation theme, the system bars and SVG
// colors always agree.

/** The scheme uniwind draws class names in. */
export function useScheme(): Scheme {
    return useUniwind().theme === 'dark' ? 'dark' : 'light';
}

/** The current scheme's colors, for props that take a value, not a class name (SVG, React Navigation). */
export function useColors(): Colors {
    return colorsOf(useScheme());
}
