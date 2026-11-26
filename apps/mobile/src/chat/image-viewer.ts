// The attachment viewer's gestures (CB-536, CB-537), after iOS Photos and
// Android's Material viewers: pinch to zoom about the fingers, double-tap to
// zoom in on a spot and back to fit, pan while zoomed (clamped to the
// picture's edges, with a rubber band past them), page sideways only at fit
// (the drag moves the pager itself, so a pinch never races a native scroll),
// and drag down (or up) at fit to dismiss, with the black backdrop and the
// chrome fading as the picture moves. This file holds the math, no React
// Native, so tests/chat runs it under Node; every function is a worklet, so
// the gestures run it on reanimated's UI thread (attachment-viewer-gesture.ts).
//
// Offsets are the picture's translation from the page's center, in points;
// a scale of 1 is the picture fitted to the page (contentFit contain).

/** A width and a height, in points. */
export interface Size {
    readonly width: number;
    readonly height: number;
}

/** A point or a translation, in points. */
export interface Point {
    readonly x: number;
    readonly y: number;
}

/** A zoom: its scale and the picture's offset from the page's center. */
export interface Zoom {
    readonly scale: number;
    readonly x: number;
    readonly y: number;
}

/** Fit: the whole picture on the page, centered. */
export const FIT: Zoom = { scale: 1, x: 0, y: 0 };

/** The deepest zoom a pinch settles at (Photos' is about 5×; a pinch may overshoot it). */
export const MAX_SCALE = 5;

/** Where a double-tap at fit zooms to. */
export const DOUBLE_TAP_SCALE = 2.5;

/** A scale this close to 1 counts as fit. */
const FIT_EPSILON = 0.01;

/** UIScrollView's rubber band constant. */
const RUBBER = 0.55;

/** How far, as a share of the page's height, a drag must go to dismiss (Photos' is about a sixth). */
const DISMISS_SHARE = 0.15;

/** The dismiss distance's floor and cap, in points. */
const DISMISS_MIN = 80;
const DISMISS_MAX = 160;

/** A release at least this fast, in points a second, toward the drag's side dismisses at any distance. */
export const DISMISS_VELOCITY = 800;

/** How far, as a share of the page's height, a dismiss drag goes before the backdrop is gone. */
const FADE_SHARE = 0.4;

/** How small a dismiss drag shrinks the picture, at its farthest. */
const DISMISS_SHRINK = 0.2;

// The worklets plugin turns each worklet below into a variable made when the module loads, holding
// the worklets it calls: a worklet must come after every one it calls (tests/chat/image-viewer.test.ts).

/** The picture's size fitted into `page` (contentFit contain), or the page's own while its size is unknown. */
export function fittedSize(page: Size, picture: Size | null): Size {
    'worklet';
    if (picture === null || picture.width <= 0 || picture.height <= 0 || page.width <= 0 || page.height <= 0) {
        return page;
    }
    const ratio = Math.min(page.width / picture.width, page.height / picture.height);
    return { width: picture.width * ratio, height: picture.height * ratio };
}

/** How far the picture may move each way from center at `scale`: none on a side it doesn't overflow. */
export function panBounds(scale: number, fitted: Size, page: Size): Point {
    'worklet';
    return {
        x: Math.max(0, (fitted.width * scale - page.width) / 2),
        y: Math.max(0, (fitted.height * scale - page.height) / 2),
    };
}

/** Whether a picture at `scale` is zoomed in (past fit). */
export function isZoomed(scale: number): boolean {
    'worklet';
    return scale - 1 >= FIT_EPSILON;
}

/** Whether the pager pages: only at fit; zoomed in, a sideways drag pans the picture instead. */
export function pagingEnabled(scale: number): boolean {
    'worklet';
    return !isZoomed(scale);
}

/**
 * What a one-finger drag does, from where it was when it started: zoomed in, pan
 * the picture; at fit, page sideways (`page`) or move the picture toward a
 * dismiss (`dismiss`), whichever way it went more.
 */
export type DragMode = 'pan' | 'page' | 'dismiss';

export function dragMode(scale: number, translationX: number, translationY: number): DragMode {
    'worklet';
    if (!pagingEnabled(scale)) {
        return 'pan';
    }
    return Math.abs(translationY) > Math.abs(translationX) ? 'dismiss' : 'page';
}

/** How far, in points, a drag goes before it decides what it does. */
export const DRAG_DECIDE = 4;

/**
 * What a drag that has gone (`translationX`, `translationY`) does, or null while it has
 * hardly moved: gesture-handler's first events after a pan activates can carry no
 * translation yet, which would read as sideways.
 */
export function decideDrag(scale: number, translationX: number, translationY: number): DragMode | null {
    'worklet';
    if (Math.abs(translationX) < DRAG_DECIDE && Math.abs(translationY) < DRAG_DECIDE) {
        return null;
    }
    return dragMode(scale, translationX, translationY);
}

/** `value` held within ±`bound`. */
export function clampOffset(value: number, bound: number): number {
    'worklet';
    // + 0: never -0, which a zoom's equality would tell from 0.
    return Math.min(bound, Math.max(-bound, value)) + 0;
}

/** UIScrollView's rubber band: how far an overshoot of `over` shows on a side `dimension` long. */
export function rubberBand(over: number, dimension: number): number {
    'worklet';
    if (dimension <= 0 || over <= 0) {
        return 0;
    }
    return (1 - 1 / ((over * RUBBER) / dimension + 1)) * dimension;
}

/** `value` within ±`bound`, stretched past it by the rubber band (a drag while zoomed). */
export function rubberOffset(value: number, bound: number, dimension: number): number {
    'worklet';
    if (value > bound) {
        return bound + rubberBand(value - bound, dimension);
    }
    if (value < -bound) {
        return -bound - rubberBand(-bound - value, dimension);
    }
    return value;
}

/** A pinch's `raw` scale shown with a rubber band past 1 and MAX_SCALE. */
export function rubberScale(raw: number): number {
    'worklet';
    if (raw > MAX_SCALE) {
        return MAX_SCALE + rubberBand(raw - MAX_SCALE, MAX_SCALE / 2);
    }
    if (raw < 1) {
        return 1 - rubberBand(1 - raw, 0.5);
    }
    return raw;
}

/**
 * A pinch's zoom: from `start` (when it began, the fingers' midpoint at
 * `focalStart`), now at `scale` with the midpoint at `focal`. The spot that was
 * under the fingers stays under them, so the fingers pan as they pinch.
 * Points are from the page's center.
 */
export function pinchZoom(start: Zoom, focalStart: Point, focal: Point, scale: number): Zoom {
    'worklet';
    const ratio = start.scale > 0 ? scale / start.scale : 1;
    return {
        scale,
        x: focal.x - (focalStart.x - start.x) * ratio,
        y: focal.y - (focalStart.y - start.y) * ratio,
    };
}

/** Where a zoom comes to rest: its scale within 1 and MAX_SCALE, the picture within its edges. */
export function settleZoom(zoom: Zoom, fitted: Size, page: Size): Zoom {
    'worklet';
    const scale = Math.min(MAX_SCALE, Math.max(1, zoom.scale));
    if (scale - 1 < FIT_EPSILON) {
        return FIT;
    }
    // Scaled back from an overshoot about the page's center, then held within the edges.
    const ratio = zoom.scale > 0 ? scale / zoom.scale : 1;
    const bounds = panBounds(scale, fitted, page);
    return { scale, x: clampOffset(zoom.x * ratio, bounds.x), y: clampOffset(zoom.y * ratio, bounds.y) };
}

/**
 * A double-tap at `tap` (from the page's center): zoomed in, back to fit; at
 * fit, to DOUBLE_TAP_SCALE about the tapped spot, which stays where it was
 * as far as the picture's edges allow.
 */
export function doubleTapZoom(current: Zoom, tap: Point, fitted: Size, page: Size): Zoom {
    'worklet';
    if (isZoomed(current.scale)) {
        return FIT;
    }
    const scale = DOUBLE_TAP_SCALE;
    const bounds = panBounds(scale, fitted, page);
    return {
        scale,
        x: clampOffset(-tap.x * (scale - 1), bounds.x),
        y: clampOffset(-tap.y * (scale - 1), bounds.y),
    };
}

/** How far a dismiss drag must go on a page `height` tall. */
export function dismissDistance(height: number): number {
    'worklet';
    return Math.min(DISMISS_MAX, Math.max(DISMISS_MIN, height * DISMISS_SHARE));
}

/**
 * Whether a dismiss drag released `dy` from where it began, moving at `vy`,
 * dismisses: far enough and not flung back, or flung on toward its side.
 */
export function dismisses(dy: number, vy: number, height: number): boolean {
    'worklet';
    if (dy === 0) {
        return false;
    }
    const side = Math.sign(dy);
    const toward = vy * side;
    if (toward >= DISMISS_VELOCITY) {
        return true;
    }
    return Math.abs(dy) >= dismissDistance(height) && toward > -DISMISS_VELOCITY / 2;
}

/** How far along a dismiss drag `dy` is, 0 to 1, on a page `height` tall. */
export function dismissProgress(dy: number, height: number): number {
    'worklet';
    if (height <= 0) {
        return 0;
    }
    return Math.min(1, Math.abs(dy) / (height * FADE_SHARE));
}

/** The backdrop's and the chrome's opacity during a dismiss drag. */
export function backdropOpacity(dy: number, height: number): number {
    'worklet';
    return 1 - dismissProgress(dy, height);
}

/** The picture's scale during a dismiss drag: a little smaller the farther it goes, as Photos'. */
export function dismissScale(dy: number, height: number): number {
    'worklet';
    return 1 - DISMISS_SHRINK * dismissProgress(dy, height);
}

/** Where a dismissed picture leaves to: off the page on the drag's side. */
export function dismissTarget(dy: number, height: number): number {
    'worklet';
    return (dy < 0 ? -1 : 1) * height;
}

/** A paging drag let go at least this fast, in points a second, turns the page whatever its distance. */
export const PAGE_VELOCITY = 500;

/**
 * The page a paging drag settles on: the next or the previous one when it went
 * past half a page, or was flung that way; else the one it started on. Never
 * past the first or the last.
 */
export function pageTarget(
    index: number,
    translationX: number,
    velocityX: number,
    width: number,
    count: number,
): number {
    'worklet';
    let next = index;
    if (translationX < -width / 2 || (translationX < 0 && velocityX <= -PAGE_VELOCITY)) {
        next = index + 1;
    } else if (translationX > width / 2 || (translationX > 0 && velocityX >= PAGE_VELOCITY)) {
        next = index - 1;
    }
    return Math.min(Math.max(0, count - 1), Math.max(0, next));
}

/** The pager's scroll offset for a drag to `raw`: past the first or the last page, with the rubber band. */
export function pagerOffset(raw: number, count: number, width: number): number {
    'worklet';
    const half = ((Math.max(1, count) - 1) * width) / 2;
    return half + rubberOffset(raw - half, half, width);
}
