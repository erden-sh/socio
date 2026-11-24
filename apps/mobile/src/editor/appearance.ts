import { colorsOf, type ColorToken, type Scheme } from '../theme/theme';

// What the page editor's WebView is told of the app's look: the system's
// font scale and the theme's generated colors for the scheme, sent as
// `socio-appearance` on open and again whenever either changes. The WebView's
// background stays transparent.
import type { EditorAppearance } from './bridge';

/** The theme's tokens the editor's stylesheet uses (editor/styles.ts). */
export const EDITOR_TOKENS = [
    'foreground',
    'muted',
    'muted-foreground',
    'border',
    'primary',
    'accent',
] as const satisfies readonly ColorToken[];

/**
 * `insets` (CB-417): the native bar's room over the document's top (iOS's
 * translucent bar) and the room kept clear at its foot, in points.
 */
export function editorAppearance(
    scheme: Scheme,
    fontScale: number,
    insets?: { readonly top: number; readonly bottom: number },
): EditorAppearance {
    const colors = colorsOf(scheme);
    const clamp = (value: number) => Math.min(Math.max(Math.round(value), 0), 2000);
    return {
        // The bridge takes (0, 5]; the system's largest is about 3.1.
        fontScale: Math.min(Math.max(fontScale, 0.5), 5),
        tokens: Object.fromEntries(EDITOR_TOKENS.map((token) => [token, colors[token]])),
        ...(insets === undefined ? {} : { insets: { top: clamp(insets.top), bottom: clamp(insets.bottom) } }),
    };
}
