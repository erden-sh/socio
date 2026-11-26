import type { ReactElement, ReactNode } from 'react';
import { type LayoutChangeEvent, Platform, type RefreshControlProps, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { type Edge, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBarInset } from '../navigation/bar-inset';
import { useScreenFocused } from '../navigation/screen-focus';

import { cx } from './cx';
import { GroupedPage, useGroupedColor } from './grouped';
import { keyboardFollow, keyboardScroll } from './keyboard-scroll';
import { uikitInsets } from './screen-insets';

// A screen's frame: the scheme's screen color edge to edge, its content inside
// the safe areas, and the web's page spacing (px-4, --page-top, --page-gap).
// It scrolls by default, so large text and the keyboard never cut anything off:
// taps reach the fields and buttons while the keyboard is up and never dismiss
// it, a downward swipe does (keyboard-scroll.ts, CB-418), and the focused field
// always scrolls into view above it. On iOS UIKit insets the content
// (automaticallyAdjustKeyboardInsets); on Android, where nothing resizes under
// keyboard-controller's edge-to-edge window, keyboard-controller's
// KeyboardAwareScrollView does (CB-418: a focused field sat behind the keyboard).
// A screen that lifts itself with a KeyboardAvoidingView turns that off
// (`keyboardAware={false}`), or the two would move it twice. Only the focused
// screen follows the keyboard (CB-461): a list under a pushed page took the
// page's keyboard too, and came back scrolled under the bar.
//
// A screen under a native bar (CB-420) leaves out the top edge. On iOS the bar
// lies over it, transparent: UIKit insets the scroll content by the bar and the
// home indicator (`contentInsetAdjustmentBehavior="automatic"`), so the content
// starts below the bar, scrolls under it, and a large title collapses as it
// scrolls; a screen that doesn't scroll pads by the bar's height. On Android
// the bar sits above the screen, which keeps its own bottom edge.

/** The space kept between the focused field and the keyboard, in dp. */
export const KEYBOARD_GAP = 16;

const ALL_EDGES: readonly Edge[] = ['top', 'right', 'bottom', 'left'];

export interface ScreenProps {
    readonly children: ReactNode;
    readonly testID?: string;
    /** Scrolls its content (the default); off for a screen that lays out a fixed height itself. */
    readonly scroll?: boolean;
    /** Centers its content, for an empty state or a placeholder. */
    readonly centered?: boolean;
    /** The safe areas it keeps clear: all four by default; a screen under a native header leaves out the top. */
    readonly edges?: readonly Edge[];
    // (No top edge: the screen is under a native bar, which lies over it on iOS.)
    /** Scrolls the focused field above the keyboard (the default); off under a KeyboardAvoidingView. */
    readonly keyboardAware?: boolean;
    /** How far it has scrolled (its content offset), for a bar whose title comes in on scroll. */
    readonly onScrollY?: (y: number) => void;
    /** An inset grouped page: the system's grouped background, its sections' rows on the grouped cell color. */
    readonly grouped?: boolean;
    /** Pull to refresh: a `RefreshControl` from `usePullToRefresh`, for a page that syncs. */
    readonly refreshControl?: ReactElement<RefreshControlProps>;
    /**
     * The keyboard's height (`useBarFieldKeyboard`), for a screen whose field is the bar's
     * (iOS's search field): it pads its bottom by it instead of following the keyboard with
     * UIKit's insets, which scrolled it under the bar (CB-552; keyboard-scroll.ts).
     */
    readonly keyboardInset?: number;
    /** Its frame's height as it lays out, for an empty state centered in what shows (CB-552). */
    readonly onFrameHeight?: (height: number) => void;
}

export function Screen({
    children,
    testID,
    scroll = true,
    centered = false,
    edges = ALL_EDGES,
    keyboardAware = true,
    onScrollY,
    grouped = false,
    refreshControl,
    keyboardInset,
    onFrameHeight,
}: ScreenProps) {
    const insets = useSafeAreaInsets();
    const groupedPage = useGroupedColor('page');
    const content = cx('grow gap-5 px-4 pt-4 pb-4', centered && 'items-center justify-center');
    const uikit = uikitInsets(edges, Platform.OS);
    const follow = keyboardFollow(Platform.OS, keyboardAware, useScreenFocused(), keyboardInset !== undefined);
    const frame = (
        // `collapsable={false}`: a View with only a background forms no stacking context, so
        // Fabric mounts its children beside it, and UIKit's walk down the first subviews meets
        // the empty background before the scroll view: the large title never collapses and the
        // scroll edge effect finds nothing (CB-420). Every page's root View says it too.
        <View
            testID={testID}
            className="flex-1 bg-screen"
            collapsable={false}
            {...(onFrameHeight === undefined
                ? {}
                : { onLayout: (event: LayoutChangeEvent) => onFrameHeight(event.nativeEvent.layout.height) })}
            style={{
                ...(grouped ? { backgroundColor: groupedPage } : {}),
                paddingTop: edges.includes('top') ? insets.top : 0,
                paddingRight: edges.includes('right') ? insets.right : 0,
                paddingBottom: edges.includes('bottom') && !(uikit && scroll) ? insets.bottom : 0,
                paddingLeft: edges.includes('left') ? insets.left : 0,
            }}
        >
            {scroll ? (
                <KeyboardAwareScrollView
                    className="flex-1"
                    contentContainerClassName={content}
                    {...keyboardScroll(Platform.OS)}
                    enabled={follow.controller}
                    bottomOffset={KEYBOARD_GAP}
                    {...(refreshControl === undefined ? {} : { refreshControl })}
                    automaticallyAdjustKeyboardInsets={follow.uikit}
                    {...(follow.inset ? { contentInset: { bottom: keyboardInset ?? 0 } } : {})}
                    // A tab screen (no bottom edge) scrolls under iOS 26's glass tab bar: let UIKit
                    // inset its content by the bar, so the last row can rest above it (owner,
                    // 2026-11-08). The native tabs only set this when the ScrollView is the
                    // first in the screen's first-child chain; set it here so it never depends on that.
                    // Under a native bar, UIKit insets it by the bar too (CB-420).
                    contentInsetAdjustmentBehavior={uikit || !edges.includes('bottom') ? 'automatic' : 'never'}
                    {...(onScrollY === undefined
                        ? {}
                        : {
                              scrollEventThrottle: 32,
                              onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) =>
                                  onScrollY(event.nativeEvent.contentOffset.y),
                          })}
                >
                    {children}
                </KeyboardAwareScrollView>
            ) : uikit ? (
                <BarPadded className={cx('flex-1', content)}>{children}</BarPadded>
            ) : (
                <View className={cx('flex-1', content)}>{children}</View>
            )}
        </View>
    );
    return grouped ? <GroupedPage>{frame}</GroupedPage> : frame;
}

/** A screen that doesn't scroll, under iOS's native bar: its content starts below the bar. */
function BarPadded({ className, children }: { className: string; children: ReactNode }) {
    const inset = useBarInset();
    return (
        <View className={className} style={{ marginTop: inset }}>
            {children}
        </View>
    );
}
