import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { BackHandler, Keyboard, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DrawerPanel } from '../screens/drawer-panel';

import { drawerHitSlop, drawerPanEnabled, drawerWidth, shownProgress } from './drawer';
import { type DrawerControls, DrawerContext } from './drawer-context';
import { drawerPanCallbacks, settleDrawer } from './drawer-gesture';
import { moreItemAction } from './tabs';

// The workspace drawer (Slack's; drawer.ts), hand-drawn mechanics with
// gesture-handler and reanimated, around the native tab
// navigator (shell-tabs.tsx, `layout`), so it covers the tab bar too. Home's
// workspace button opens it, and on iOS a swipe from the left edge while Home
// shows; a swipe back, the scrim, the panel's Close, VoiceOver's escape,
// Android's back and every row that goes somewhere close it. The pan runs on
// the UI thread and settles with the platform's spring from the finger's speed
// (drawer-gesture.ts, whose worklets the React Compiler never sees);
// with Reduce Motion on it opens and closes at once (a drag still follows the
// finger).

/** What the tab navigator hands the drawer: its dispatch, for Settings' page. */
export interface DrawerNavigation {
    dispatch(action: ReturnType<typeof moreItemAction>): void;
}

export function ShellDrawer({
    children,
    onHome,
    navigation,
}: {
    children: ReactNode;
    onHome: boolean;
    navigation: DrawerNavigation;
}) {
    const insets = useSafeAreaInsets();
    const width = drawerWidth(useWindowDimensions().width);
    const reduceMotion = useReducedMotion();
    const progress = useSharedValue(0);
    const dragStart = useSharedValue(0);
    const [open, setOpen] = useState(false);

    // Closing puts the keyboard away.
    const settled = (toOpen: boolean) => {
        setOpen(toOpen);
        if (!toOpen) {
            Keyboard.dismiss();
        }
    };
    const settle = (toOpen: boolean) => {
        settled(toOpen);
        settleDrawer(progress, toOpen, 0, Platform.OS, reduceMotion);
    };
    const controls: DrawerControls = { open: () => settle(true), close: () => settle(false) };
    const openSettings = (id: Parameters<typeof moreItemAction>[0], label: string) => {
        settle(false);
        navigation.dispatch(moreItemAction(id, label));
    };

    // Worklets from drawer-gesture.ts, named one by one: the worklets plugin reads this object.
    const callbacks = drawerPanCallbacks({
        progress,
        dragStart,
        width,
        os: Platform.OS,
        reduceMotion,
        onSettled: settled,
    });
    const pan = usePanGesture({
        enabled: drawerPanEnabled(open, onHome, Platform.OS),
        // Closed, a swipe from the left edge (iOS only); open, anywhere.
        hitSlop: drawerHitSlop(open),
        activeOffsetX: open ? -10 : 10,
        failOffsetY: [-15, 15],
        onActivate: callbacks.onActivate,
        onUpdate: callbacks.onUpdate,
        onDeactivate: callbacks.onDeactivate,
    });

    // Android's back closes the drawer while it is open.
    useEffect(() => {
        if (!open) {
            return;
        }
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            setOpen(false);
            Keyboard.dismiss();
            settleDrawer(progress, false, 0, Platform.OS, reduceMotion);
            return true;
        });
        return () => subscription.remove();
    }, [open, progress, reduceMotion]);

    const panelStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: (shownProgress(progress.get()) - 1) * width }],
    }));
    const scrimStyle = useAnimatedStyle(() => ({ opacity: shownProgress(progress.get()) }));

    return (
        <DrawerContext value={controls}>
            <GestureDetector gesture={pan}>
                <View className="flex-1">
                    <View
                        className="flex-1 bg-screen"
                        accessibilityElementsHidden={open}
                        importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
                    >
                        {children}
                    </View>
                    <>
                        <Animated.View
                            style={[StyleSheet.absoluteFill, scrimStyle]}
                            pointerEvents={open ? 'auto' : 'none'}
                        >
                            <Pressable
                                className="flex-1 bg-black/40"
                                accessibilityRole="button"
                                accessibilityLabel="Close workspaces"
                                onPress={controls.close}
                                testID="drawer-scrim"
                            />
                        </Animated.View>
                        <Animated.View
                            style={[styles.panel, { width }, panelStyle]}
                            pointerEvents={open ? 'auto' : 'none'}
                            accessibilityViewIsModal={open}
                            onAccessibilityEscape={controls.close}
                            accessibilityElementsHidden={!open}
                            importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
                            testID="drawer"
                        >
                            <View
                                className="flex-1 border-r border-tab-bar-border bg-tab-bar"
                                style={{
                                    paddingTop: insets.top,
                                    paddingBottom: insets.bottom,
                                    paddingLeft: insets.left,
                                }}
                            >
                                <DrawerPanel open={open} onSettings={openSettings} onClose={controls.close} />
                            </View>
                        </Animated.View>
                    </>
                </View>
            </GestureDetector>
        </DrawerContext>
    );
}

const styles = StyleSheet.create({
    panel: { position: 'absolute', top: 0, bottom: 0, left: 0 },
});
