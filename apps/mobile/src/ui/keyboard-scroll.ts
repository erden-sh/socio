// How every scrolling screen with a text field treats the keyboard (CB-418): a
// downward swipe hides it, and a plain tap in the content never does. On iOS the
// keyboard follows the finger (UIKit's interactive dismissal); Android has no
// such gesture, so the keyboard goes on drag. Taps always reach the fields and
// buttons while it is up ('always': 'handled' would dismiss it on a tap that
// lands on no button). Spread it on a ScrollView or a list:
// `{...keyboardScroll(Platform.OS)}`. No React Native here, so tests run it
// under Node.

export type KeyboardDismissMode = 'interactive' | 'on-drag';

export interface KeyboardScrollProps {
    readonly keyboardDismissMode: KeyboardDismissMode;
    readonly keyboardShouldPersistTaps: 'always';
}

/** The dismissal on `os`: interactive on iOS, on drag everywhere else. */
export function keyboardDismissMode(os: string): KeyboardDismissMode {
    return os === 'ios' ? 'interactive' : 'on-drag';
}

/** The keyboard props for a scroll view or list on `os`. */
export function keyboardScroll(os: string): KeyboardScrollProps {
    return { keyboardDismissMode: keyboardDismissMode(os), keyboardShouldPersistTaps: 'always' };
}

/** Who moves a Screen's content for the keyboard: UIKit's insets on iOS, keyboard-controller elsewhere. */
export interface KeyboardFollow {
    /** keyboard-controller's KeyboardAwareScrollView (`enabled`): Android, where nothing resizes. */
    readonly controller: boolean;
    /** UIKit's `automaticallyAdjustKeyboardInsets`: iOS. */
    readonly uikit: boolean;
    /**
     * The Screen's own bottom inset, the keyboard's height (`contentInset`): iOS, for a screen
     * whose field is the bar's (Search, a Space's "Search pages"; CB-552), outside its scroll view.
     */
    readonly inset: boolean;
}

/**
 * Whether a Screen follows the keyboard on `os`: only while it is the focused
 * screen (CB-461). A screen under a pushed page, or in a tab not shown, still
 * gets every keyboard notification; on iOS UIKit then shifts its content by the
 * keyboard's travel (a WebView's caret is outside it), and it came back
 * scrolled under the bar.
 *
 * `barField`: the screen's field is the bar's (iOS's UISearchController), not in its
 * content. There React Native's keyboard insets have nothing to bring into view, and
 * on every keyboard change they `scrollTo` an offset clamped to `contentInset`, not to
 * UIKit's adjusted inset: the content jumped up under the bar and the status bar, so
 * Search's first row and its "no results" sat unreadable under them (CB-552, CB-462).
 * Such a screen pads its bottom by the keyboard itself (`inset`), which moves nothing.
 */
export function keyboardFollow(os: string, keyboardAware: boolean, focused: boolean, barField = false): KeyboardFollow {
    const on = keyboardAware && focused;
    const ios = os === 'ios';
    return { controller: on && !ios, uikit: on && ios && !barField, inset: on && ios && barField };
}

/**
 * The bottom safe area a footer pinned over a lifted screen keeps, `progress` of
 * the way up the keyboard (0 down, 1 up; CB-466). Down, the whole inset (the
 * home indicator); up, none: the keyboard covers it, and a screen already
 * lifted by the keyboard's height kept that room between its composer and the
 * keyboard. A worklet, for keyboard-controller's
 * progress on the UI thread.
 */
export function keyboardFooterInset(bottom: number, progress: number): number {
    'worklet';
    return bottom * (1 - Math.min(Math.max(progress, 0), 1));
}
