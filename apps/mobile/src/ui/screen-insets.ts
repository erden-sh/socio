import type { Edge } from 'react-native-safe-area-context';

// Which screens UIKit insets under a native bar (CB-420; screen.tsx). No React
// Native here, so the Node tests read it as the app does.

/** Whether UIKit insets a screen's content by the native bar over it: iOS, under a bar (no top edge). */
export const uikitInsets = (edges: readonly Edge[], os: string) => os === 'ios' && !edges.includes('top');

// Where an empty state centers (CB-552): in what shows of a Screen, between
// what lies over its top (iOS's bar) and over its bottom (iOS's tab bar or its
// bottom search field, or the keyboard), below what the screen draws above it.

/**
 * iOS 26's bottom search row (a tab's search: the bar's field in the glass Search button's place)
 * over the home indicator or the keyboard, in pt: the 48 pt field and its margins.
 */
export const IOS_BOTTOM_SEARCH_ROW = 62;

/** The Screen's bottom padding (pb-4), kept under an empty state as under any content. */
export const SCREEN_BOTTOM_PAD = 16;

export interface FillCovers {
    /** What lies over the frame's bottom while the keyboard is down. */
    readonly bottom: number;
    /** What lies over it while the keyboard is up (0 when down). */
    readonly keyboard: number;
}

/**
 * What covers a Screen's frame from below on `os`. iOS: the frame runs to the window's bottom under
 * the home indicator and the tab bar, `safeBottom` (a pushed page's counts its tab bar, tab-stack.tsx),
 * plus the bottom search row on a tab whose field is there (`bottomField`), which rides on the
 * keyboard once it is up. Android: the frame ends at the bottom navigation, `navigation` above the
 * window's bottom, and the keyboard, measured from the window's bottom, covers only what passes it.
 */
export function fillCovers(
    os: string,
    input: {
        readonly safeBottom: number;
        readonly keyboard: number;
        readonly bottomField: boolean;
        readonly navigation: number;
    },
): FillCovers {
    if (os === 'ios') {
        const row = input.bottomField ? IOS_BOTTOM_SEARCH_ROW : 0;
        return { bottom: input.safeBottom + row, keyboard: input.keyboard > 0 ? input.keyboard + row : 0 };
    }
    return { bottom: 0, keyboard: Math.max(0, input.keyboard - input.navigation) };
}

/**
 * The height an empty state fills so it centers in what shows: the frame less what lies over its
 * top (`top`, iOS's bar) and its bottom (`covers`), less what the screen draws above it (`above`,
 * its offset in the content, the Screen's top padding included) and the bottom padding. Never
 * negative: with no room it takes its own height.
 */
export function emptyFill(input: {
    readonly frame: number;
    readonly top: number;
    readonly covers: FillCovers;
    readonly above: number;
}): number {
    const { frame, top, covers, above } = input;
    return Math.max(0, Math.round(frame - top - Math.max(covers.bottom, covers.keyboard) - above - SCREEN_BOTTOM_PAD));
}
