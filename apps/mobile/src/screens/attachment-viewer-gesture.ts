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
    dragMode,
    FIT,
    pagingEnabled,
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
// page's pinch, double-tap and one-finger drag move its picture frame by frame
// and settle with the platform's spring, with no JavaScript in between; the
// math is image-viewer.ts's. Only what React draws goes back to it: whether
// the pager may page (`onPaging`: only at fit) and a dismiss
// (`onDismiss`, the stack's own goBack).
//
// The callbacks are worklets made here, in a plain function the React
// Compiler leaves alone (it compiles only components and hooks), as the
// drawer's are (drawer-gesture.ts). Under Reduce Motion nothing springs: a
// zoom jumps, a dismiss fades out quickly and a drag let go short of it jumps back.

/** How long Reduce Motion's dismiss fade and a flung picture's exit take, in milliseconds. */
export const DISMISS_FADE_MS = 150;
const TOSS_MS = 200;

/** A page's picture: its zoom, and what a gesture began from. */
export interface PageZoom {
    readonly scale: SharedValue<number>;
    readonly x: SharedValue<number>;
    readonly y: SharedValue<number>;
    /** The zoom and the fingers' midpoint (from the page's center) when a pinch or drag began. */
    readonly start: SharedValue<Zoom & { readonly fx: number; readonly fy: number }>;
}

/** What the viewer moves for a dismiss: the shown picture's drag, and a fade (1 shown, 0 gone). */
export interface ViewerDismiss {
    readonly dy: SharedValue<number>;
    readonly fade: SharedValue<number>;
}

export interface PageGestures {
    readonly zoom: PageZoom;
    readonly dismiss: ViewerDismiss;
    readonly page: Size;
    readonly fitted: Size;
    readonly os: string;
    readonly reduceMotion: boolean;
    /** Told on the JavaScript thread whether the pager may page: only with the picture at fit. */
    readonly onPaging: (paging: boolean) => void;
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

/** The page's gesture callbacks, every one a worklet. */
export function pageGestureCallbacks(gestures: PageGestures) {
    const { zoom, dismiss, page, fitted, os, reduceMotion, onPaging, onDismiss } = gestures;
    const current = (): Zoom => {
        'worklet';
        return { scale: zoom.scale.get(), x: zoom.x.get(), y: zoom.y.get() };
    };
    const settle = (velocity?: { readonly x: number; readonly y: number }) => {
        'worklet';
        const target = settleZoom(current(), fitted, page);
        moveZoom(zoom, target, os, reduceMotion, velocity);
        scheduleOnRN(onPaging, pagingEnabled(target.scale));
    };
    return {
        pinchActivate: (event: PinchGestureActiveEvent) => {
            'worklet';
            // Setting the values stops a settle still running: the fingers take the picture where it is.
            zoom.start.set({ ...current(), fx: event.focalX - page.width / 2, fy: event.focalY - page.height / 2 });
            scheduleOnRN(onPaging, false);
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
            scheduleOnRN(onPaging, pagingEnabled(target.scale));
        },
        dragActivate: () => {
            'worklet';
            zoom.start.set({ ...current(), fx: 0, fy: 0 });
        },
        dragUpdate: (event: PanGestureActiveEvent) => {
            'worklet';
            const start = zoom.start.get();
            if (dragMode(start.scale) === 'dismiss') {
                dismiss.dy.set(event.translationY);
                return;
            }
            const bounds = panBounds(start.scale, fitted, page);
            zoom.x.set(rubberOffset(start.x + event.translationX, bounds.x, page.width));
            zoom.y.set(rubberOffset(start.y + event.translationY, bounds.y, page.height));
        },
        dragDeactivate: (event: PanGestureActiveEvent) => {
            'worklet';
            if (dragMode(zoom.start.get().scale) === 'pan') {
                settle({ x: event.velocityX, y: event.velocityY });
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
