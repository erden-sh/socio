import type {
    PanGestureActiveEvent,
    PinchGestureActiveEvent,
    TapGestureActiveEvent,
} from 'react-native-gesture-handler';
import { Easing, ReduceMotion, type SharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
    dismisses,
    dismissTarget,
    doubleTapZoom,
    decideDrag,
    type DragMode,
    FIT,
    pagerOffset,
    pageTarget,
    panBounds,
    pinchZoom,
    rubberOffset,
    rubberScale,
    settleZoom,
    type Size,
    type Zoom,
} from '../chat/image-viewer';
import { systemSpring } from '../ui/motion';

// The attachment viewer's gestures on the UI thread (CB-536, CB-537): a
// page's pinch, double-tap and one-finger drag move its picture, or the pager,
// frame by frame and settle with the platform's spring, with no JavaScript in
// between; the math is image-viewer.ts's. The pager doesn't scroll by itself:
// the drag moves it (`pager.x`, which the viewer scrolls to), so a pinch never
// races a native scroll for the fingers. Only what React draws goes back to it:
// the page the pager settled on (`onPage`) and a dismiss (`onDismiss`, the
// stack's own goBack).
//
// The callbacks are worklets made here, in a plain function the React
// Compiler leaves alone (it compiles only components and hooks), as the
// drawer's are (drawer-gesture.ts). Under Reduce Motion nothing springs: a
// zoom or a page jumps, a dismiss fades out quickly and a drag let go short of it jumps back.

/** How long Reduce Motion's dismiss fade and a flung picture's exit take, in milliseconds. */
export const DISMISS_FADE_MS = 150;
const TOSS_MS = 200;

/**
 * Where a pinch or a drag began: the zoom, the fingers' midpoint (from the page's center), what the
 * drag does (`null` until its first move: a drag's activation carries no translation yet) and the
 * pager's offset.
 */
export interface GestureStart extends Zoom {
    readonly fx: number;
    readonly fy: number;
    readonly mode: DragMode | null;
    readonly px: number;
}

export const NO_START: GestureStart = { ...FIT, fx: 0, fy: 0, mode: null, px: 0 };

/** A page's picture: its zoom, and what a gesture began from. */
export interface PageZoom {
    readonly scale: SharedValue<number>;
    readonly x: SharedValue<number>;
    readonly y: SharedValue<number>;
    readonly start: SharedValue<GestureStart>;
}

/** What the viewer moves for a dismiss: the shown picture's drag, and a fade (1 shown, 0 gone). */
export interface ViewerDismiss {
    readonly dy: SharedValue<number>;
    readonly fade: SharedValue<number>;
}

/** The pager: its scroll offset, which the viewer scrolls to, and this page's place in it. */
export interface PagerDrive {
    readonly x: SharedValue<number>;
    readonly index: number;
    readonly count: number;
}

export interface PageGestures {
    readonly zoom: PageZoom;
    readonly dismiss: ViewerDismiss;
    readonly pager: PagerDrive;
    readonly page: Size;
    readonly fitted: Size;
    readonly os: string;
    readonly reduceMotion: boolean;
    /** Told on the JavaScript thread the page a paging drag settled on, when it changed. */
    readonly onPage: (index: number) => void;
    /** Called on the JavaScript thread once a dismissed picture is gone. */
    readonly onDismiss: () => void;
}

/** Moves the picture to `target`: the platform's spring carrying `velocity`, or at once under Reduce Motion. */
export function moveZoom(
    zoom: PageZoom,
    target: Zoom,
    os: string,
    reduceMotion: boolean,
    velocity: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): void {
    'worklet';
    if (reduceMotion) {
        zoom.scale.set(target.scale);
        zoom.x.set(target.x);
        zoom.y.set(target.y);
        return;
    }
    const spring = { ...systemSpring(os, 'spatial'), reduceMotion: ReduceMotion.System };
    zoom.scale.set(withSpring(target.scale, spring));
    zoom.x.set(withSpring(target.x, { ...spring, velocity: velocity.x }));
    zoom.y.set(withSpring(target.y, { ...spring, velocity: velocity.y }));
}

/** Puts the picture back at fit at once (the pager moved to another page). */
export function resetZoom(zoom: PageZoom): void {
    'worklet';
    zoom.scale.set(FIT.scale);
    zoom.x.set(FIT.x);
    zoom.y.set(FIT.y);
}

/** Moves the pager to page `index` (`width` wide): the platform's spring carrying `velocity`, or at once under Reduce Motion. */
export function movePager(
    x: SharedValue<number>,
    index: number,
    width: number,
    os: string,
    reduceMotion: boolean,
    velocity = 0,
): void {
    'worklet';
    const target = index * width;
    x.set(
        reduceMotion
            ? target
            : withSpring(target, { ...systemSpring(os, 'spatial'), velocity, reduceMotion: ReduceMotion.System }),
    );
}

/** The page's gesture callbacks, every one a worklet. */
export function pageGestureCallbacks(gestures: PageGestures) {
    const { zoom, dismiss, pager, page, fitted, os, reduceMotion, onPage, onDismiss } = gestures;
    const current = (): Zoom => {
        'worklet';
        return { scale: zoom.scale.get(), x: zoom.x.get(), y: zoom.y.get() };
    };
    const settle = (velocity?: { readonly x: number; readonly y: number }) => {
        'worklet';
        moveZoom(zoom, settleZoom(current(), fitted, page), os, reduceMotion, velocity);
    };
    return {
        pinchActivate: (event: PinchGestureActiveEvent) => {
            'worklet';
            // Setting the values stops a settle still running: the fingers take the picture where it is.
            zoom.start.set({
                ...current(),
                fx: event.focalX - page.width / 2,
                fy: event.focalY - page.height / 2,
                mode: 'pan',
                px: pager.x.get(),
            });
        },
        pinchUpdate: (event: PinchGestureActiveEvent) => {
            'worklet';
            const start = zoom.start.get();
            const next = pinchZoom(
                start,
                { x: start.fx, y: start.fy },
                { x: event.focalX - page.width / 2, y: event.focalY - page.height / 2 },
                rubberScale(start.scale * event.scale),
            );
            zoom.scale.set(next.scale);
            zoom.x.set(next.x);
            zoom.y.set(next.y);
        },
        pinchDeactivate: () => {
            'worklet';
            settle();
        },
        doubleTap: (event: TapGestureActiveEvent) => {
            'worklet';
            const target = doubleTapZoom(
                current(),
                { x: event.x - page.width / 2, y: event.y - page.height / 2 },
                fitted,
                page,
            );
            moveZoom(zoom, target, os, reduceMotion);
        },
        dragActivate: () => {
            'worklet';
            zoom.start.set({ ...current(), fx: 0, fy: 0, mode: null, px: pager.x.get() });
        },
        dragUpdate: (event: PanGestureActiveEvent) => {
            'worklet';
            let start = zoom.start.get();
            if (start.mode === null) {
                // Decided once the finger has moved, by which way it went.
                const mode = decideDrag(start.scale, event.translationX, event.translationY);
                if (mode === null) {
                    return;
                }
                start = { ...start, mode };
                zoom.start.set(start);
            }
            if (start.mode === 'dismiss') {
                dismiss.dy.set(event.translationY);
                return;
            }
            if (start.mode === 'page') {
                pager.x.set(pagerOffset(start.px - event.translationX, pager.count, page.width));
                return;
            }
            const bounds = panBounds(start.scale, fitted, page);
            zoom.x.set(rubberOffset(start.x + event.translationX, bounds.x, page.width));
            zoom.y.set(rubberOffset(start.y + event.translationY, bounds.y, page.height));
        },
        dragDeactivate: (event: PanGestureActiveEvent) => {
            'worklet';
            const start = zoom.start.get();
            if (start.mode === null) {
                return;
            }
            if (start.mode === 'pan') {
                settle({ x: event.velocityX, y: event.velocityY });
                return;
            }
            if (start.mode === 'page') {
                const next = pageTarget(pager.index, event.translationX, event.velocityX, page.width, pager.count);
                movePager(pager.x, next, page.width, os, reduceMotion, -event.velocityX);
                if (next !== pager.index) {
                    scheduleOnRN(onPage, next);
                }
                return;
            }
            const dy = dismiss.dy.get();
            if (!dismisses(dy, event.velocityY, page.height)) {
                if (reduceMotion) {
                    dismiss.dy.set(0);
                } else {
                    dismiss.dy.set(
                        withSpring(0, {
                            ...systemSpring(os, 'spatial'),
                            velocity: event.velocityY,
                            reduceMotion: ReduceMotion.System,
                        }),
                    );
                }
                return;
            }
            const gone = (finished?: boolean) => {
                'worklet';
                if (finished !== false) {
                    scheduleOnRN(onDismiss);
                }
            };
            if (reduceMotion) {
                dismiss.fade.set(withTiming(0, { duration: DISMISS_FADE_MS, reduceMotion: ReduceMotion.Never }, gone));
                return;
            }
            // Thrown on off the page the way it was going; the backdrop fades with the distance.
            dismiss.dy.set(
                withTiming(
                    dismissTarget(dy, page.height),
                    { duration: TOSS_MS, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never },
                    gone,
                ),
            );
        },
    };
}
