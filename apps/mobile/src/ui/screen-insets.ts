import type { Edge } from 'react-native-safe-area-context';

import { MATERIAL_NAVIGATION_BAR } from '../navigation/presets';

// Which screens UIKit insets under a native bar (CB-420; screen.tsx). No React
// Native here, so the Node tests read it as the app does.

/** Whether UIKit insets a screen's content by the native bar over it: iOS, under a bar (no top edge). */
export const uikitInsets = (edges: readonly Edge[], os: string) => os === 'ios' && !edges.includes('top');

// Where an empty state centers (CB-552): in what shows of a Screen, from its
// own top on the screen (measured, so whatever lies above it counts once) down
// to what covers the screen's bottom: the home indicator and the tab bar or
// the Search tab's bottom row (the safe area, which UIKit measures), or the
// keyboard with the row riding on it.

/**
 * iOS 26's Search tab: how far its bottom search row reaches above the keyboard while the keyboard
 * is up (the field and its margins, in pt; measured on iOS 27.2: the field's top 57 pt over the
 * keyboard's). With the keyboard down the safe area holds the row.
 */
export const IOS_SEARCH_ROW_ON_KEYBOARD = 57;

/** The Screen's bottom padding (pb-4), kept under an empty state as under any content. */
export const SCREEN_BOTTOM_PAD = 16;

export interface FillCovers {
    /** What lies over the screen's bottom while the keyboard is down. */
    readonly bottom: number;
    /** What lies over it while the keyboard is up (0 when down). */
    readonly keyboard: number;
}

/**
 * What covers the screen's bottom on `os`, given the safe area where the empty state is
 * (`safeBottom`): on iOS the Search tab's own (search-tab.tsx's provider, measured by UIKit) holds
 * the home indicator and the bottom search row, a pushed page's its tab bar (tab-stack.tsx). Up, the
 * keyboard covers it, with the row on it. Android's Search frame runs under the bottom navigation
 * (`searchTab`), which the keyboard covers too.
 */
export function fillCovers(
    os: string,
    input: { readonly safeBottom: number; readonly keyboard: number; readonly searchTab: boolean },
): FillCovers {
    if (os === 'ios') {
        const row = input.searchTab ? IOS_SEARCH_ROW_ON_KEYBOARD : 0;
        return { bottom: input.safeBottom, keyboard: input.keyboard > 0 ? input.keyboard + row : 0 };
    }
    const bar = input.searchTab ? MATERIAL_NAVIGATION_BAR : 0;
    return { bottom: input.safeBottom + bar, keyboard: input.keyboard };
}

/**
 * The height an empty state fills so it centers in what shows and the screen doesn't scroll: from
 * its top on the screen (`top`, measured in the window) to what covers the bottom, less the
 * Screen's bottom padding. Whole points, rounded down; never negative.
 */
export function emptyFill(input: {
    readonly screen: number;
    readonly top: number;
    readonly covers: FillCovers;
}): number {
    const { screen, top, covers } = input;
    return Math.max(0, Math.floor(screen - Math.max(covers.bottom, covers.keyboard) - top - SCREEN_BOTTOM_PAD));
}

/**
 * The bottom inset a Screen whose field is the bar's keeps for the keyboard (CB-552): what the
 * keyboard covers past what UIKit already insets it by (`safeBottom`), so the content ends where
 * the keyboard (and the row on it) starts, and an empty state that fits it never scrolls.
 */
export function keyboardInset(covers: FillCovers, safeBottom: number): number {
    return covers.keyboard > 0 ? Math.max(0, covers.keyboard - safeBottom) : 0;
}
