import { useEffect, useState } from 'react';
import { Animated, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { AppSymbol, Text } from '../ui';
import { systemSpring } from '../ui/motion';
import type { SymbolName } from '../ui/symbols';

export { useBarInset } from '../navigation/bar-inset';

// The page editor's native bar (CB-417; the owner, 2026-11-18: Apple Notes).
// The route's preset (`page({ header: 'native' })`) gives the system's
// compact bar, translucent over the page on iOS and a Material top app bar on
// Android; the screen fills it in with these:
//
// - `EditorBarTitle`: the save line ("Saved", "Saving…") as the bar's small
//   status, and once the document's title has scrolled under the bar, the
//   title on one line above it, clipped, fading in as Notes and Files do it,
//   with the platform's spring, at once under Reduce Motion.
// - `BarButton`: an icon button for the bar's end (Markdown source or Visual
//   editor); iOS 26 puts it in Liquid Glass.
// - `useBarInset`: how far the bar reaches over the page (iOS only: Android's
//   sits above it), which the document pads so its text starts below the bar
//   and scrolls under it.

/** How the bar's title comes and goes: a fade and a short slide, so the spring that never overshoots. */
const TITLE_SPRING = systemSpring(Platform.OS, 'effects');

export function EditorBarTitle(props: {
    /** The page's title; '' shows "Untitled page" once it has scrolled away. */
    title: string;
    /** The document's title is still in view: the bar shows only the status. */
    titleShown: boolean;
    status: string;
    destructive: boolean;
}) {
    const { width } = useWindowDimensions();
    // The title's line, measured: the status shifts up by half of it while the title isn't there, so it sits in the bar's middle.
    const [line, setLine] = useState(20);
    const reduceMotion = useReducedMotion();
    const [collapsed] = useState(() => new Animated.Value(props.titleShown ? 0 : 1));
    useEffect(() => {
        const toValue = props.titleShown ? 0 : 1;
        if (reduceMotion) {
            collapsed.setValue(toValue);
            return undefined;
        }
        const animation = Animated.spring(collapsed, { toValue, ...TITLE_SPRING, useNativeDriver: true });
        animation.start();
        return () => animation.stop();
    }, [collapsed, props.titleShown, reduceMotion]);
    const ios = Platform.OS === 'ios';
    return (
        <Animated.View
            testID="page-editor-save-line"
            accessibilityRole="summary"
            style={{
                // Back and the bar's button take the rest; iOS centers the title between them.
                maxWidth: width - (ios ? 150 : 140),
                alignItems: ios ? 'center' : 'flex-start',
                transform: [{ translateY: collapsed.interpolate({ inputRange: [0, 1], outputRange: [-line / 2, 0] }) }],
            }}
        >
            <Animated.View
                style={{ opacity: collapsed }}
                onLayout={(event) => setLine(Math.round(event.nativeEvent.layout.height))}
                importantForAccessibility={props.titleShown ? 'no-hide-descendants' : 'auto'}
                accessibilityElementsHidden={props.titleShown}
            >
                <Text
                    weight="semibold"
                    numberOfLines={1}
                    accessibilityRole="header"
                    tone={props.title === '' ? 'muted' : 'default'}
                    testID="page-editor-bar-title"
                >
                    {props.title === '' ? 'Untitled page' : props.title}
                </Text>
            </Animated.View>
            <Text
                variant="footnote"
                tone={props.destructive ? 'destructive' : 'muted'}
                numberOfLines={1}
                accessibilityLiveRegion="polite"
                testID="page-editor-saved"
            >
                {props.status}
            </Text>
        </Animated.View>
    );
}

export function BarButton(props: {
    icon: SymbolName;
    label: string;
    disabled: boolean;
    onPress: () => void;
    testID: string;
}) {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            hitSlop={6}
            className="size-9 items-center justify-center rounded-full active:opacity-50 disabled:opacity-40"
        >
            <AppSymbol name={props.icon} size={20} />
        </Pressable>
    );
}

/** A row of the bar's things under it (the notice, a save's detail): a bar inset's worth below the top. */
export function UnderBar({ inset, children }: { inset: number; children: React.ReactNode }) {
    return (
        <View pointerEvents="box-none" className="absolute right-0 left-0 z-10 gap-2 px-3" style={{ top: inset + 8 }}>
            {children}
        </View>
    );
}
