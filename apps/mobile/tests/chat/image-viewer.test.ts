import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    backdropOpacity,
    clampOffset,
    DISMISS_VELOCITY,
    dismisses,
    dismissDistance,
    dismissScale,
    dismissTarget,
    DOUBLE_TAP_SCALE,
    doubleTapZoom,
    dragActivation,
    dragMode,
    FIT,
    fittedSize,
    isZoomed,
    MAX_SCALE,
    pagingEnabled,
    panBounds,
    pinchZoom,
    rubberBand,
    rubberOffset,
    rubberScale,
    settleZoom,
} from '../../src/chat/image-viewer';

// The attachment viewer's gestures (CB-536: no zoom; CB-537: no swipe to
// dismiss), after iOS Photos: the math under Node, and the screen's wiring
// read as text (no React Native renderer under Node).

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');

// An iPhone's page and a wide desktop screenshot, fitted to its width.
const PAGE = { width: 393, height: 852 };
const WIDE = { width: 2880, height: 1800 };
const FITTED = fittedSize(PAGE, WIDE);

describe('the fitted picture', () => {
    it('fits a wide screenshot to the page’s width, centered, and fills the page while its size is unknown', () => {
        expect(FITTED.width).toBeCloseTo(393);
        expect(FITTED.height).toBeCloseTo(245.6, 1);
        expect(fittedSize(PAGE, { width: 1000, height: 4000 })).toEqual({ width: 213, height: 852 });
        expect(fittedSize(PAGE, null)).toEqual(PAGE);
        expect(fittedSize(PAGE, { width: 0, height: 0 })).toEqual(PAGE);
    });
});

describe('panning while zoomed', () => {
    it('stays within the picture’s edges: no room on a side the picture doesn’t overflow', () => {
        expect(panBounds(1, FITTED, PAGE)).toEqual({ x: 0, y: 0 });
        const at3 = panBounds(3, FITTED, PAGE);
        expect(at3.x).toBeCloseTo((393 * 3 - 393) / 2);
        // 3 × 245.6 still fits the page's height: no vertical pan.
        expect(at3.y).toBe(0);
        expect(panBounds(5, FITTED, PAGE).y).toBeCloseTo((FITTED.height * 5 - 852) / 2);
        expect(clampOffset(500, 393)).toBe(393);
        expect(clampOffset(-500, 393)).toBe(-393);
        expect(clampOffset(20, 393)).toBe(20);
    });

    it('stretches past an edge with UIScrollView’s rubber band, never as far as the finger', () => {
        expect(rubberBand(0, 393)).toBe(0);
        expect(rubberBand(100, 0)).toBe(0);
        const over = rubberOffset(300, 200, 393) - 200;
        expect(over).toBeGreaterThan(0);
        expect(over).toBeLessThan(100);
        expect(rubberOffset(-300, 200, 393)).toBeCloseTo(-200 - over);
        expect(rubberOffset(150, 200, 393)).toBe(150);
        // However far the finger goes, the overshoot stays under the page.
        expect(rubberBand(1e6, 393)).toBeLessThan(393);
    });
});

describe('pinching', () => {
    it('zooms from 1× up to MAX_SCALE, with a rubber band past both ends', () => {
        expect(MAX_SCALE).toBeGreaterThanOrEqual(4);
        expect(MAX_SCALE).toBeLessThanOrEqual(5);
        expect(rubberScale(2)).toBe(2);
        expect(rubberScale(8)).toBeGreaterThan(MAX_SCALE);
        expect(rubberScale(8)).toBeLessThan(8);
        expect(rubberScale(0.5)).toBeLessThan(1);
        expect(rubberScale(0.5)).toBeGreaterThan(0.5);
        expect(rubberScale(0.01)).toBeGreaterThan(0.5);
    });

    it('keeps the spot under the fingers under them, as they pinch and as they move', () => {
        const focal = { x: 100, y: -40 };
        const zoom = pinchZoom(FIT, focal, focal, 3);
        // The spot that was at `focal` (picture coordinates `focal` at fit) is at scale × spot + offset.
        expect(3 * focal.x + zoom.x).toBeCloseTo(focal.x);
        expect(3 * focal.y + zoom.y).toBeCloseTo(focal.y);
        // From a zoom already panned, with the fingers moving 30 pt right.
        const from = { scale: 2, x: -50, y: 10 };
        const moved = pinchZoom(from, focal, { x: 130, y: -40 }, 4);
        const spot = { x: (focal.x - from.x) / from.scale, y: (focal.y - from.y) / from.scale };
        expect(4 * spot.x + moved.x).toBeCloseTo(130);
        expect(4 * spot.y + moved.y).toBeCloseTo(-40);
    });

    it('settles within 1× and MAX_SCALE, the picture within its edges', () => {
        expect(settleZoom({ scale: 0.6, x: 30, y: 12 }, FITTED, PAGE)).toEqual(FIT);
        expect(settleZoom({ scale: 1.004, x: 3, y: 0 }, FITTED, PAGE)).toEqual(FIT);
        const over = settleZoom({ scale: 7, x: 0, y: 0 }, FITTED, PAGE);
        expect(over.scale).toBe(MAX_SCALE);
        const far = settleZoom({ scale: 3, x: 2000, y: -900 }, FITTED, PAGE);
        expect(far).toEqual({ scale: 3, x: panBounds(3, FITTED, PAGE).x, y: 0 });
        expect(settleZoom({ scale: 2, x: 40, y: 0 }, FITTED, PAGE)).toEqual({ scale: 2, x: 40, y: 0 });
    });
});

describe('double-tapping', () => {
    it('zooms in to about 2.5× about the tapped spot, held within the edges', () => {
        expect(DOUBLE_TAP_SCALE).toBe(2.5);
        const tap = { x: 60, y: 20 };
        const zoom = doubleTapZoom(FIT, tap, FITTED, PAGE);
        expect(zoom.scale).toBe(2.5);
        // The tapped spot stays under the finger sideways; the wide picture still fits the height, so it stays centered.
        expect(2.5 * tap.x + zoom.x).toBeCloseTo(tap.x);
        expect(zoom.y).toBe(0);
        // A tall picture, which overflows the height at 2.5×, keeps the tapped spot both ways.
        const tall = fittedSize(PAGE, { width: 1000, height: 3000 });
        const tallZoom = doubleTapZoom(FIT, tap, tall, PAGE);
        expect(2.5 * tap.y + tallZoom.y).toBeCloseTo(tap.y);
        // A tap on the black beside a tall picture: the picture's edge stops it at the page's.
        const edge = doubleTapZoom(FIT, { x: 190, y: 0 }, tall, PAGE);
        expect(edge.x).toBeCloseTo(-panBounds(2.5, tall, PAGE).x);
        expect(-panBounds(2.5, tall, PAGE).x).toBeGreaterThan(-190 * 1.5);
        // A tap on the black above a wide picture can't move it up or down: it fits the height at 2.5×.
        expect(doubleTapZoom(FIT, { x: 0, y: 300 }, FITTED, PAGE).y).toBe(0);
    });

    it('goes back to fit when zoomed in', () => {
        expect(doubleTapZoom({ scale: 2.5, x: -40, y: 0 }, { x: 0, y: 0 }, FITTED, PAGE)).toEqual(FIT);
        expect(doubleTapZoom({ scale: 1.5, x: 0, y: 0 }, { x: 10, y: 10 }, FITTED, PAGE)).toEqual(FIT);
    });
});

describe('paging and dragging', () => {
    it('pages only at fit; zoomed in, a drag pans the picture', () => {
        expect(pagingEnabled(1)).toBe(true);
        expect(pagingEnabled(1.005)).toBe(true);
        expect(pagingEnabled(1.5)).toBe(false);
        expect(isZoomed(1)).toBe(false);
        expect(isZoomed(2.5)).toBe(true);
        expect(dragMode(1)).toBe('dismiss');
        expect(dragMode(2)).toBe('pan');
    });

    it('takes only an up or down drag at fit, so a sideways one pages; any drag zoomed in', () => {
        expect(dragActivation(false)).toEqual({ maxPointers: 1, activeOffsetY: [-10, 10], failOffsetX: [-12, 12] });
        const zoomed = dragActivation(true);
        expect(zoomed).not.toHaveProperty('failOffsetX');
        expect(zoomed).not.toHaveProperty('activeOffsetY');
        expect(zoomed.maxPointers).toBe(1);
    });
});

describe('dragging to dismiss', () => {
    it('dismisses past a distance, or on a fling toward the drag’s side', () => {
        const distance = dismissDistance(PAGE.height);
        expect(distance).toBeGreaterThanOrEqual(80);
        expect(distance).toBeLessThanOrEqual(160);
        expect(dismisses(distance + 1, 0, PAGE.height)).toBe(true);
        expect(dismisses(-(distance + 1), 0, PAGE.height)).toBe(true);
        expect(dismisses(distance - 20, 0, PAGE.height)).toBe(false);
        // A short flick down, or up.
        expect(dismisses(30, DISMISS_VELOCITY, PAGE.height)).toBe(true);
        expect(dismisses(-30, -DISMISS_VELOCITY, PAGE.height)).toBe(true);
        // A slow drag that stops short springs back.
        expect(dismisses(30, 200, PAGE.height)).toBe(false);
        expect(dismisses(0, 2000, PAGE.height)).toBe(false);
    });

    it('springs back when flung back toward the start, even past the distance', () => {
        expect(dismisses(dismissDistance(PAGE.height) + 40, -DISMISS_VELOCITY, PAGE.height)).toBe(false);
        expect(dismisses(30, -DISMISS_VELOCITY, PAGE.height)).toBe(false);
    });

    it('fades the backdrop and the chrome and shrinks the picture as it goes, then leaves on its side', () => {
        expect(backdropOpacity(0, PAGE.height)).toBe(1);
        expect(backdropOpacity(170, PAGE.height)).toBeCloseTo(0.5, 1);
        expect(backdropOpacity(-2000, PAGE.height)).toBe(0);
        expect(dismissScale(0, PAGE.height)).toBe(1);
        expect(dismissScale(2000, PAGE.height)).toBeCloseTo(0.8);
        expect(dismissTarget(40, PAGE.height)).toBe(PAGE.height);
        expect(dismissTarget(-40, PAGE.height)).toBe(-PAGE.height);
    });
});

describe('the math', () => {
    it('can run on reanimated’s UI thread: every function is a worklet but the pan’s activation', () => {
        const math = read('chat/image-viewer.ts');
        const functions = [...math.matchAll(/^export function (\w+)/gm)].map((match) => match[1]);
        expect(functions.length).toBeGreaterThan(10);
        for (const name of functions.filter((fn) => fn !== 'dragActivation')) {
            expect(math, name).toMatch(new RegExp(`export function ${name}\\([^]*?\\{\\n {4}'worklet';`));
        }
    });
});

describe('the viewer screen', () => {
    const viewer = read('screens/attachment-viewer.tsx');
    const gesture = read('screens/attachment-viewer-gesture.ts');

    it('zooms its pictures: a pinch, a double-tap and a drag on each page, together (CB-536)', () => {
        expect(viewer).toContain('usePinchGesture({');
        expect(viewer).toMatch(/useTapGesture\(\{[^}]*numberOfTaps: 2/);
        expect(viewer).toContain('usePanGesture({');
        expect(viewer).toContain('useSimultaneousGestures(pinch, drag, doubleTap)');
        expect(viewer).toContain('<GestureDetector gesture={gestures}>');
        // The pager is gesture-handler's, so a pinch takes over from its scroll.
        expect(viewer).toMatch(/import \{[^}]*\bFlatList\b[^}]*\} from 'react-native-gesture-handler'/);
    });

    it('pages only at fit, and puts a page the pager left back to fit', () => {
        expect(viewer).toContain('scrollEnabled={paging}');
        expect(viewer).toContain('const activation = dragActivation(active && !paging);');
        expect(viewer).toContain('failOffsetX: activation.failOffsetX,');
        expect(viewer).toMatch(/if \(!active\) \{\n\s+resetZoom\(\{ scale, x, y, start \}\);/);
        expect(gesture).toContain('scheduleOnRN(onPaging, pagingEnabled(target.scale))');
        expect(gesture).toContain('scheduleOnRN(onPaging, false)');
    });

    it('drags to dismiss through the stack’s own goBack, fading the backdrop and the chrome (CB-537)', () => {
        expect(viewer).toContain('const close = () => navigation.goBack();');
        expect(viewer).toContain('onDismiss={close}');
        expect(viewer.match(/backdropOpacity\(dy\.get\(\), page\.height\) \* fade\.get\(\)/g)?.length).toBe(2);
        // The black is a layer that fades, not the screen's own background.
        expect(viewer).not.toMatch(/testID="attachment-viewer"\s+className="[^"]*bg-black/);
        expect(gesture).toContain('dismisses(dy, event.velocityY, page.height)');
        expect(gesture).toContain('scheduleOnRN(onDismiss)');
    });

    it('keeps a close button and VoiceOver’s escape', () => {
        expect(viewer).toContain('testID="attachment-viewer-close"');
        expect(viewer).toContain('onAccessibilityEscape={close}');
    });

    it('runs its gestures on the UI thread: worklets made outside the React Compiler’s reach', () => {
        for (const callback of [
            'pinchActivate',
            'pinchUpdate',
            'pinchDeactivate',
            'doubleTap',
            'dragActivate',
            'dragUpdate',
            'dragDeactivate',
        ]) {
            expect(gesture, callback).toMatch(new RegExp(`${callback}: \\([^)]*\\) => \\{\\n\\s+'worklet';`));
            expect(viewer, callback).toContain(`callbacks.${callback}`);
        }
    });

    it('springs nothing under Reduce Motion: a zoom jumps, a dismiss fades', () => {
        expect(viewer).toContain('useReducedMotion()');
        expect(gesture).toMatch(/if \(reduceMotion\) \{\n\s+zoom\.scale\.set\(target\.scale\);/);
        expect(gesture).toMatch(
            /if \(reduceMotion\) \{\n\s+dismiss\.fade\.set\(withTiming\(0, \{ duration: DISMISS_FADE_MS/,
        );
        expect(gesture).toMatch(/if \(reduceMotion\) \{\n\s+dismiss\.dy\.set\(0\);/);
    });
});
