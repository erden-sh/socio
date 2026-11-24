import type { PanGestureActiveEvent } from 'react-native-gesture-handler';
import { ReduceMotion, type SharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { dragProgress, drawerSettle, progressVelocity, settlesOpen } from './drawer';

// The workspace drawer's pan on the UI thread: the panel follows the
// finger frame by frame, and on release settles with the platform's spring
// from the finger's speed (drawer.ts), as Slack's does, with no JavaScript in
// between; only the settled side goes back to React (`onSettled`), for the
// drawer's `open` state and the keyboard.
//
// The callbacks are worklets made here, in a plain function the React
// Compiler leaves alone (it compiles only components and hooks), so it never
// memoizes or rewrites a worklet's closure. shell-drawer.tsx hands them to
// `usePanGesture`, which runs them on the UI thread since they are worklets.

/** What the pan needs: the drawer's progress (0 closed, 1 open) and where a drag began. */
export interface DrawerPan {
    readonly progress: SharedValue<number>;
    readonly dragStart: SharedValue<number>;
    readonly width: number;
    readonly os: string;
    readonly reduceMotion: boolean;
    /** Told on the JavaScript thread which side a release settles on. */
    readonly onSettled: (open: boolean) => void;
}

/**
 * Moves the drawer open or closed from wherever it is, carrying `velocity`
 * (drawer widths a second): the platform's spring, or at once with Reduce
 * Motion on. Callable from either thread.
 */
export function settleDrawer(
    progress: SharedValue<number>,
    toOpen: boolean,
    velocity: number,
    os: string,
    reduceMotion: boolean,
): void {
    'worklet';
    const target = toOpen ? 1 : 0;
    const spring = drawerSettle(os, reduceMotion, velocity);
    progress.set(spring === null ? target : withSpring(target, { ...spring, reduceMotion: ReduceMotion.System }));
}

/** The pan's callbacks, every one a worklet. */
export function drawerPanCallbacks(pan: DrawerPan) {
    const { progress, dragStart, width, os, reduceMotion, onSettled } = pan;
    return {
        onActivate: () => {
            'worklet';
            // Setting progress stops a settle still running: the finger takes the drawer where it is.
            dragStart.set(progress.get());
        },
        onUpdate: (event: PanGestureActiveEvent) => {
            'worklet';
            progress.set(dragProgress(dragStart.get(), event.translationX, width));
        },
        onDeactivate: (event: PanGestureActiveEvent) => {
            'worklet';
            const toOpen = settlesOpen(progress.get(), event.velocityX, width);
            settleDrawer(progress, toOpen, progressVelocity(event.velocityX, width), os, reduceMotion);
            scheduleOnRN(onSettled, toOpen);
        },
    };
}
