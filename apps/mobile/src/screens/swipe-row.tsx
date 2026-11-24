import * as Haptics from 'expo-haptics';
import { createContext, type ReactNode, use, useEffect, useRef, useState } from 'react';
import {
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    Platform,
    Pressable,
    useWindowDimensions,
    View,
} from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, {
    runOnJS,
    type SharedValue,
    useAnimatedReaction,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';

import { useHaptics } from '../platform/device-settings';
import {
    type SwipeActionView,
    type SwipeEdge,
    type SwipeGroup,
    swipeGroup,
    swipeLayout,
    swipePaneLook,
    swipeTone,
} from '../shell/swipe-actions';
import { useColors } from '../theme/scheme';
import { AppSymbol, Text } from '../ui';
import type { SymbolName } from '../ui/symbols';

// Swipe actions on a row (Mail's, Messages' and T3 Code's, through
// gesture-handler's ReanimatedSwipeable): swipe a row toward an edge for its
// actions there, each a full-height pane in its color with its symbol and
// word (iOS 26's filled circles over the row's own color on iOS, Material's
// full-bleed color on Android). Swiping on past the full-swipe point does the action nearest the edge
// (the primary) on release, with a tap of haptics as it arms (by the
// phone's Haptics setting) and the pane stretching over the others, as Mail's.
// A destructive action is red and its own `run` asks first (the app's
// confirms), so a full swipe never deletes by itself. Every action is also the
// row's accessibility action, so VoiceOver and TalkBack reach it without the
// gesture (the row passes them; this draws only the gesture).

export interface SwipeAction extends SwipeActionView {
    readonly icon: SymbolName;
    readonly onPress: () => void;
}

// A list of swipe rows (CB-453): Mail's rules (swipe-actions.ts's `swipeGroup`). The list spreads
// `handlers` on its scroll view; its rows find the group through context. While the list scrolls,
// `enabled` (a shared value, so no row renders again) keeps every row's pan off: a vertical drag
// that drifts sideways stays the list's.
interface RowGroup {
    readonly group: SwipeGroup<SwipeableMethods>;
    readonly enabled: SharedValue<boolean>;
}

const SwipeGroupContext = createContext<RowGroup | null>(null);

/**
 * How long the list must go without a scroll event before rows swipe again, in ms. Idle, not the
 * momentum events: an overscroll's bounce at the top begins momentum on iOS and may never end it,
 * which would leave every row unable to swipe.
 */
const SCROLL_SETTLE_MS = 200;

/**
 * A list's swipe rows, as one group: `Provider` around the rows, `handlers` on the list,
 * `closeOpen()` first in a row's tap (true: the tap only closed the open row).
 */
export function useSwipeGroup() {
    const [group] = useState(() => swipeGroup<SwipeableMethods>());
    const enabled = useSharedValue(true);
    const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearSettle = () => {
        if (settle.current !== null) {
            clearTimeout(settle.current);
            settle.current = null;
        }
    };
    useEffect(() => clearSettle, []);
    const [value] = useState<RowGroup>(() => ({ group, enabled }));
    // Rows swipe again once the list has been still for SCROLL_SETTLE_MS: every scroll event while
    // they're off starts the wait over, so a drag, its momentum or a bounce all keep them off.
    const settleLater = () => {
        clearSettle();
        settle.current = setTimeout(() => {
            settle.current = null;
            group.scrollEnd();
            enabled.set(true);
        }, SCROLL_SETTLE_MS);
    };
    return {
        value,
        closeOpen: () => group.closeOpen(),
        handlers: {
            scrollEventThrottle: 16,
            onScrollBeginDrag: (_event: NativeSyntheticEvent<NativeScrollEvent>) => {
                group.scrollBegin();
                enabled.set(false);
                settleLater();
            },
            onScroll: (_event: NativeSyntheticEvent<NativeScrollEvent>) => {
                if (group.state.scrolling) {
                    settleLater();
                }
            },
            onScrollEndDrag: (_event: NativeSyntheticEvent<NativeScrollEvent>) => settleLater(),
            onMomentumScrollEnd: (_event: NativeSyntheticEvent<NativeScrollEvent>) => settleLater(),
        },
    };
}

/** The rows of one list (`useSwipeGroup`'s `value`). */
export function SwipeGroupProvider({ value, children }: { value: RowGroup; children: ReactNode }) {
    return <SwipeGroupContext value={value}>{children}</SwipeGroupContext>;
}

export function SwipeRow(props: {
    /** Toward the trailing edge (a swipe to the left in left-to-right text), the primary last. */
    trailing?: readonly SwipeAction[];
    /** Toward the leading edge (a swipe to the right), the primary first. */
    leading?: readonly SwipeAction[];
    children: ReactNode;
    testID?: string;
}) {
    const trailing = props.trailing ?? [];
    const leading = props.leading ?? [];
    const swipeable = useRef<SwipeableMethods>(null);
    const haptics = useHaptics();
    const { width } = useWindowDimensions();
    const armed = useRef<SwipeEdge | null>(null);
    const rows = use(SwipeGroupContext);
    if (trailing.length === 0 && leading.length === 0) {
        return <>{props.children}</>;
    }
    const onArm = (edge: SwipeEdge | null) => {
        if (edge !== null && armed.current !== edge && haptics) {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        }
        armed.current = edge;
    };
    const run = (action: SwipeAction) => {
        swipeable.current?.close();
        action.onPress();
    };
    // Released past the full-swipe point: the primary runs, the row closes.
    const willOpen = (direction: 'left' | 'right') => {
        // gesture-handler names the side the actions show on: `right` is the trailing actions.
        const edge: SwipeEdge = direction === 'right' ? 'trailing' : 'leading';
        if (swipeable.current !== null) {
            rows?.group.willOpen(swipeable.current);
        }
        if (armed.current !== edge) {
            return;
        }
        armed.current = null;
        const primary = edge === 'trailing' ? trailing.at(-1) : leading[0];
        if (primary !== undefined) {
            run(primary);
        }
    };
    const { pane } = swipePaneLook(Platform.OS);
    const trailingLayout = swipeLayout(trailing.length, width, pane);
    const leadingLayout = swipeLayout(leading.length, width, pane);
    return (
        <ReanimatedSwipeable
            ref={swipeable}
            testID={props.testID}
            friction={1}
            overshootFriction={1}
            overshootRight={trailing.length > 0}
            overshootLeft={leading.length > 0}
            rightThreshold={trailingLayout.openAt}
            leftThreshold={leadingLayout.openAt}
            // A drag swipes only once it has gone 12 pt sideways: activeOffsetX's [-12, 12]. The
            // offset from the right is negative (CB-453): a positive one made every touch that moved
            // at all a swipe, so a vertical drag on a row never reached the list's scroll.
            dragOffsetFromRight={-12}
            dragOffsetFromLeft={12}
            // Off while the list scrolls (useSwipeGroup), so a scroll that drifts sideways stays a scroll.
            {...(rows === null ? {} : { enabled: rows.enabled })}
            onSwipeableOpenStartDrag={() => {
                if (swipeable.current !== null) {
                    rows?.group.willOpen(swipeable.current);
                }
            }}
            onSwipeableWillOpen={willOpen}
            onSwipeableClose={() => {
                armed.current = null;
                if (swipeable.current !== null) {
                    rows?.group.closed(swipeable.current);
                }
            }}
            {...(trailing.length === 0
                ? {}
                : {
                      renderRightActions: (_progress: SharedValue<number>, translation: SharedValue<number>) => (
                          <SwipeActions
                              edge="trailing"
                              actions={trailing}
                              translation={translation}
                              fullAt={trailingLayout.fullAt}
                              paneWidth={trailingLayout.pane}
                              onArm={onArm}
                              onPress={run}
                          />
                      ),
                  })}
            {...(leading.length === 0
                ? {}
                : {
                      renderLeftActions: (_progress: SharedValue<number>, translation: SharedValue<number>) => (
                          <SwipeActions
                              edge="leading"
                              actions={leading}
                              translation={translation}
                              fullAt={leadingLayout.fullAt}
                              paneWidth={leadingLayout.pane}
                              onArm={onArm}
                              onPress={run}
                          />
                      ),
                  })}
        >
            {props.children}
        </ReanimatedSwipeable>
    );
}

function SwipeActions(props: {
    edge: SwipeEdge;
    actions: readonly SwipeAction[];
    translation: SharedValue<number>;
    fullAt: number;
    paneWidth: number;
    onArm: (edge: SwipeEdge | null) => void;
    onPress: (action: SwipeAction) => void;
}) {
    const { edge, translation, fullAt, paneWidth, onArm } = props;
    const [armedHere, setArmedHere] = useState(false);
    const sign = edge === 'trailing' ? -1 : 1;
    const total = paneWidth * props.actions.length;
    const arm = (on: boolean) => {
        setArmedHere(on);
        onArm(on ? edge : null);
    };
    useAnimatedReaction(
        () => translation.value * sign >= fullAt,
        (on, was) => {
            if (on !== was && was !== null) {
                runOnJS(arm)(on);
            }
        },
    );
    // The panes take what the row uncovers, the primary every point past their own width.
    const style = useAnimatedStyle(() => ({ width: Math.max(total, translation.value * sign) }));
    const primary = edge === 'trailing' ? props.actions.length - 1 : 0;
    // The outer box keeps the panes' own width, which the swipeable measures as where the row opens
    // to; the panes past it overflow toward the row as it is swiped on.
    return (
        <View style={{ width: total, height: '100%' }}>
            <Animated.View
                style={[
                    { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row' },
                    edge === 'trailing' ? { right: 0 } : { left: 0 },
                    style,
                ]}
            >
                {props.actions.map((action, index) => (
                    <Pane
                        key={action.name}
                        action={action}
                        // Armed, the primary covers the others, as Mail's does.
                        width={index === primary ? null : armedHere ? 0 : paneWidth}
                        onPress={() => props.onPress(action)}
                    />
                ))}
            </Animated.View>
        </View>
    );
}

function Pane({ action, width, onPress }: { action: SwipeAction; width: number | null; onPress: () => void }) {
    const colors = useColors();
    const tone = swipeTone(action.tone);
    const look = swipePaneLook(Platform.OS);
    return (
        <Pressable
            // The row's accessibility actions say these; the panes only draw the gesture.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={onPress}
            testID={action.testID}
            style={[
                { overflow: 'hidden' },
                look.fill === 'pane' ? { backgroundColor: colors[tone.background] } : null,
                width === null ? { flex: 1, minWidth: 0 } : { width },
            ]}
        >
            {/* The symbol and its word, centered in the row and inside its height (CB-454). */}
            <View className="flex-1 items-center justify-center gap-1 px-1">
                {look.fill === 'circle' ? (
                    // iOS 26's: a filled circle with the symbol, the word under it (Reminders', Mail's).
                    <View
                        className="items-center justify-center rounded-full"
                        style={{ width: look.circle, height: look.circle, backgroundColor: colors[tone.background] }}
                    >
                        <AppSymbol name={action.icon} size={look.icon} color={tone.foreground} />
                    </View>
                ) : (
                    <AppSymbol name={action.icon} size={look.icon} color={tone.foreground} />
                )}
                <Text
                    variant={look.label}
                    weight="medium"
                    tone={look.fill === 'circle' ? 'default' : tone.text}
                    numberOfLines={1}
                    maxFontSizeMultiplier={look.labelMaxScale}
                >
                    {action.label}
                </Text>
            </View>
        </Pressable>
    );
}
