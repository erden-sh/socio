import { GestureStateManager, type PanGestureActiveEvent, type PanGestureEvent } from 'react-native-gesture-handler';
import { ReduceMotion, type SharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { dragPosition, settleColumn, swipeSettle, swipeStartsOnCards } from '../shell/board-swipe';

// The Board's sideways swipe on the UI thread (CB-468; src/shell/board-swipe.ts):
// the cards follow the finger frame by frame and settle with the platform's
// spring, with no JavaScript in between; only the column a release lands on
// goes back to React (`onLand`), which chooses it.
//
// The callbacks are worklets made here, in a plain function the React Compiler
// leaves alone (it compiles only components and hooks), as the drawer's are
// (navigation/drawer-gesture.ts). board.tsx names them one by one in
// `usePanGesture`, since the worklets plugin reads that object.

/** Where the cards are and what the pan reads, each a shared value the UI thread reads. */
export interface BoardSwipe {
    /** The cards' place: the chosen column's index times `width` while still. */
    readonly position: SharedValue<number>;
    /** 1 while a drag or its settle moves the cards (the neighbors show), 0 while still. */
    readonly moving: SharedValue<number>;
    /** Where the drag began. */
    readonly start: SharedValue<number>;
    /** The chosen column's index and how many columns there are, as React last drew them. */
    readonly current: SharedValue<number>;
    readonly count: SharedValue<number>;
    /** The page's width, the list's scroll and where its cards start in its content. */
    readonly width: SharedValue<number>;
    readonly offsetY: SharedValue<number>;
    readonly rowsStart: SharedValue<number>;
}

/** Settles the cards on column `index` from wherever they are, carrying `velocity` (points a second). */
export function settleSwipe(
    swipe: BoardSwipe,
    index: number,
    velocity: number,
    os: string,
    reduceMotion: boolean,
    onLand: (index: number) => void,
): void {
    'worklet';
    const target = index * swipe.width.get();
    const spring = swipeSettle(os, reduceMotion, velocity);
    if (spring === null) {
        swipe.position.set(target);
        scheduleOnRN(onLand, index);
        return;
    }
    swipe.position.set(
        withSpring(target, { ...spring, reduceMotion: ReduceMotion.System }, (finished) => {
            'worklet';
            // A new drag that took the cards mid-way settles them itself.
            if (finished === true) {
                scheduleOnRN(onLand, index);
            }
        }),
    );
}

/** The pan's callbacks, every one a worklet. */
export function boardSwipeCallbacks(input: {
    readonly swipe: BoardSwipe;
    readonly os: string;
    readonly reduceMotion: boolean;
    /** Told on the JavaScript thread which column a release landed on (maybe the one it left). */
    readonly onLand: (index: number) => void;
}) {
    const { swipe, os, reduceMotion, onLand } = input;
    return {
        onBegin: (event: PanGestureEvent) => {
            'worklet';
            // Only on the cards: the heading's chip row scrolls sideways itself, and iOS's left edge is Back.
            if (!swipeStartsOnCards(event.x, event.y, swipe.offsetY.get(), swipe.rowsStart.get(), os)) {
                GestureStateManager.fail(event.handlerTag);
            }
        },
        onActivate: () => {
            'worklet';
            // Still, the cards are at the chosen column; mid-settle, the finger takes them where they are.
            if (swipe.moving.get() === 0) {
                swipe.position.set(swipe.current.get() * swipe.width.get());
                swipe.moving.set(1);
            } else {
                swipe.position.set(swipe.position.get());
            }
            swipe.start.set(swipe.position.get());
        },
        onUpdate: (event: PanGestureActiveEvent) => {
            'worklet';
            swipe.position.set(
                dragPosition(swipe.start.get(), event.translationX, swipe.width.get(), swipe.count.get()),
            );
        },
        onDeactivate: (event: PanGestureActiveEvent) => {
            'worklet';
            const index = settleColumn(
                swipe.position.get(),
                event.velocityX,
                swipe.width.get(),
                swipe.current.get(),
                swipe.count.get(),
            );
            settleSwipe(swipe, index, -event.velocityX, os, reduceMotion, onLand);
        },
    };
}
