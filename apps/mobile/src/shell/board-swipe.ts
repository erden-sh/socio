// A sideways swipe between the Board's columns (CB-468, the owner's TestFlight
// note of 2026-11-21): the cards follow the finger as a page view's pages do,
// the next or previous column's first cards come in beside them, and a release
// snaps to one column with the platform's spring from the finger's speed
// (src/ui/motion.ts), or at once under Reduce Motion. The chips stay the tabs:
// a tap still picks a column, and the chosen chip scrolls into view.
//
// The page stays one vertical list (CB-420: UIKit collapses the large title by
// the first scroll view, so a horizontal pager there would hold the title
// open), and the pan sits around it: a sideways drag past ACTIVE_OFFSET takes
// it, a vertical one past FAIL_OFFSET leaves it to the list. It starts only on
// the cards, never on the heading (whose chip row scrolls sideways itself), and
// on iOS never within BACK_EDGE of the left edge, which stays the system's
// back swipe (the Board limits the back gesture to that edge while it shows the
// board: `backSwipeDistance`).
//
// Where the cards are is one number, `position`: the chosen column's index
// times the page's width while still, anything between while dragged. Each
// column's cards draw at `pageShift` from it, the chosen one and its two
// neighbors alike, so a frame that has the next column chosen but its cards
// not yet drawn still shows them in the right place. No React Native here, so
// tests/shell runs it under Node; every function is a worklet, so the pan
// (screens/board-swipe-gesture.ts) runs them on the UI thread.

import { type SpringSpec, systemSpring } from '../ui/motion';

/** How far from the left edge iOS's back swipe keeps its start, in points (the system's edge swipe). */
export const BACK_EDGE = 24;

/** A sideways drag this long takes the swipe (points): a tap or a slight wobble stays a tap. */
export const ACTIVE_OFFSET = 12;

/** A vertical drag this long first leaves it to the list's scroll (points). */
export const FAIL_OFFSET = 10;

/** How much of a drag past the first or last column moves the cards: a rubber band, as UIScrollView's. */
const RUBBER_BAND = 0.3;

/** How far ahead a release's speed carries the cards, in seconds of travel (a flick turns the page). */
const TOSS = 0.15;

/**
 * Whether a pan that starts at (`x`, `y`) in the list's view may move the columns: on the cards
 * (below the heading's rows, `rowsStart` in the list's content, which is scrolled `offsetY`), and on
 * iOS not in the back swipe's edge.
 */
export function swipeStartsOnCards(x: number, y: number, offsetY: number, rowsStart: number, os: string): boolean {
    'worklet';
    if (os === 'ios' && x < BACK_EDGE) {
        return false;
    }
    return y + offsetY >= rowsStart;
}

/**
 * Where the cards are after a drag of `translationX` from `start`, among `count` columns `width`
 * wide: with the finger between the first and last column, a rubber band past either.
 */
export function dragPosition(start: number, translationX: number, width: number, count: number): number {
    'worklet';
    const raw = start - translationX;
    const last = Math.max(0, count - 1) * width;
    if (raw < 0) {
        return raw * RUBBER_BAND;
    }
    if (raw > last) {
        return last + (raw - last) * RUBBER_BAND;
    }
    return raw;
}

/**
 * The column a release settles on: the nearest to where the finger's speed (`velocityX`, points a
 * second) would carry the cards, at most one column from the chosen one (`current`; a page view
 * turns one page a swipe) and never past either end.
 */
export function settleColumn(
    position: number,
    velocityX: number,
    width: number,
    current: number,
    count: number,
): number {
    'worklet';
    if (width <= 0 || count <= 1) {
        return current;
    }
    const projected = Math.round((position - velocityX * TOSS) / width);
    const lowest = Math.max(0, current - 1);
    const highest = Math.min(count - 1, current + 1);
    return Math.min(highest, Math.max(lowest, projected));
}

/** How far a column's cards (`index`) sit to the right of where the chosen one's would be still. */
export function pageShift(index: number, position: number, width: number): number {
    'worklet';
    return index * width - position;
}

/** How the cards settle, or null to jump there (Reduce Motion on: the slide is decoration). */
export function swipeSettle(
    os: string,
    reduceMotion: boolean,
    velocity: number,
): (SpringSpec & { readonly velocity: number }) | null {
    'worklet';
    return reduceMotion ? null : { ...systemSpring(os, 'spatial'), velocity };
}

/**
 * Where a neighbor's first cards draw down the screen while they come in: where the chosen
 * column's first card is (`rowsStart` less the scroll), or just under the bar (`barTop`) once the
 * list has scrolled past the heading.
 */
export function peekTop(rowsStart: number, offsetY: number, barTop: number): number {
    'worklet';
    return Math.max(rowsStart - offsetY, barTop);
}

/**
 * Where the list scrolls as the swipe lands, so the new column's first card is where its peek
 * drew it (`peekTop`): just under the bar when the list was past the heading, else null (it stays).
 */
export function landingScroll(rowsStart: number, offsetY: number, barTop: number): number | null {
    'worklet';
    return rowsStart - offsetY < barTop ? rowsStart - barTop : null;
}

/**
 * The back swipe's reach while the Board shows (native-stack's `gestureResponseDistance`): on the
 * board, only the left edge, so a swipe right on the cards goes to the previous column instead of
 * back (iOS 26 takes a swipe anywhere on a page as back); the list keeps the whole page.
 */
export function backSwipeDistance(swiping: boolean): { readonly start: number; readonly end: number } | undefined {
    return swiping ? { start: 0, end: BACK_EDGE } : undefined;
}
