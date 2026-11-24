// The HeaderBar's numbers (header-bar.tsx): the back chevron and the title
// start at the content's 16 pt edge, as the web's header lines its toggle up
// with its page. No React
// Native here, so the Node tests read it as the app does.

/** The page's inset at each side: the web's px-4, the Screen's and every list's padding. */
export const CONTENT_INSET = 16;

/** The bar's height: the web's AppHeader, h-16. */
export const HEADER_HEIGHT = 64;

/** The smallest touch target. */
export const TOUCH_TARGET = 44;

/** The back chevron's size, in points. */
export const BACK_ICON_SIZE = 20;

/**
 * Where lucide's chevron-left starts inside its box: its path runs from x 9 to
 * 15 of a 24 grid, with a 2-unit stroke, so the drawn stroke starts at 8/24.
 */
export const CHEVRON_INSET_RATIO = 8 / 24;

/** The space between the chevron's stroke and the title, in points. */
export const TITLE_GAP = 12;

const round = (value: number) => Math.round(value * 100) / 100;

/** Where the chevron's stroke starts and ends inside its icon's box. */
const chevronStroke = (size: number) => ({ start: round(size * CHEVRON_INSET_RATIO), width: round(size / 3) });

/**
 * The back button's box, in the bar's row (which pads CONTENT_INSET at each
 * side): it starts at the screen's edge (a negative margin of the inset) and
 * pads the icon so the chevron's stroke lands on CONTENT_INSET. It is as wide
 * as the title's start, and `hitSlop` extends its target to TOUCH_TARGET each
 * way without moving the title.
 */
export function backButtonLayout() {
    const stroke = chevronStroke(BACK_ICON_SIZE);
    const paddingLeft = round(CONTENT_INSET - stroke.start);
    const titleStart = round(CONTENT_INSET + stroke.width + TITLE_GAP);
    const width = titleStart;
    return {
        marginLeft: -CONTENT_INSET,
        paddingLeft,
        width,
        height: TOUCH_TARGET,
        hitSlop: { top: 0, bottom: 0, left: 0, right: Math.max(0, round(TOUCH_TARGET - width)) },
        /** Where the chevron's stroke starts, from the safe area's edge. */
        chevronStart: round(paddingLeft + stroke.start),
        /** Where the title starts, from the safe area's edge. */
        titleStart,
    } as const;
}
