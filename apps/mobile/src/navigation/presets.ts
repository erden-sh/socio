import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

// Route presets: the route table takes only
// a Preset, which only these functions make, so a screen never sets its own
// presentation. After T3 Code's route-options.ts, rewritten for stock
// native-stack (T3's uses its react-native-screens fork). A page's bar is
// the system's (CB-420; the owner, 2026-11-18: the web's brand in each
// platform's own components): on iOS a UINavigationBar, transparent over the
// page, which scrolls under it with iOS 26's scroll edge effect, its buttons in
// Liquid Glass and Back the system's chevron (swipe, and long-press for the
// history); on Android a Material top app bar above the page. The screen fills
// it in (native-bar.tsx: its title, buttons and search field).

declare const preset: unique symbol;

/** Screen options made by a preset function. */
export type Preset = NativeStackNavigationOptions & { readonly [preset]: true };

const made = (options: NativeStackNavigationOptions) => options as Preset;

const titled = (title: string | undefined) => (title === undefined ? {} : { title });

/**
 * A page's bar:
 * - `true` (the default): the system's bar with an inline title, for a detail page (an issue, a page,
 *   a chat, a setting);
 * - `large`: a large title that collapses into the inline one as the page scrolls, for a list or a
 *   module's page (the Board, the Spaces, Memories, Settings); iOS only, Android's top app bar has one size;
 * - `native`: the page editor's (CB-417, Apple Notes): compact, over a WebView, so the system's
 *   material is drawn behind it (the scroll edge effect can't find a WebView's scroll);
 * - `false`: none, for a screen with no bar at all (the tabs, Add workspace's first screen, the lock).
 */
export type PageBar = boolean | 'large' | 'native';

export interface PageOptions {
    readonly title?: string;
    readonly header?: PageBar;
}

/**
 * The system's bar (CB-420). On iOS it is transparent over the page, which scrolls under it: the
 * scroll edge effect (iOS 26) blurs the page under the bar's glass buttons, and `onPlatform` gives
 * older iOS the system's material in its place. On Android `onPlatform` makes it a Material top app
 * bar on the page's own color, above the page. Back is the chevron alone.
 */
function nativeBar(kind: 'inline' | 'large' | 'native'): NativeStackNavigationOptions {
    return {
        headerShown: true,
        headerLargeTitleEnabled: kind === 'large',
        headerTransparent: true,
        headerShadowVisible: false,
        ...(kind === 'large' ? { headerLargeTitleShadowVisible: false } : {}),
        ...(kind === 'native' ? { headerBlurEffect: 'systemChromeMaterial' as const } : {}),
    };
}

/** Whether a page's native bar lies over its content (iOS) or above it (Android): the screen pads by it only then. */
export const nativeBarOverlays = (os: string) => os === 'ios';

/**
 * A compact iPhone bar's height under the status bar, before the system says it: iOS 26's Liquid
 * Glass bar is 54 pt, older ones 44 (CB-456: a chat seeded with 44 under iOS 26's bar started its
 * first message 6 pt below it, not the transcript's 16).
 */
export const iosCompactBar = (liquidGlass: boolean) => (liquidGlass ? 54 : 44);

/**
 * Material 3's navigation bar height (dp): Android's bottom navigation, which lies over the bottom of
 * a tab's pages, edge to edge, above the system's own inset (tab-stack.tsx).
 */
export const MATERIAL_NAVIGATION_BAR = 80;

/** A page, pushed over the stack, with Back and the back gesture. */
export function page(options: PageOptions = {}): Preset {
    const header = options.header ?? true;
    if (header === false) {
        return made({ presentation: 'card', headerShown: false, ...titled(options.title) });
    }
    return made({
        presentation: 'card',
        ...nativeBar(header === true ? 'inline' : header),
        headerBackButtonDisplayMode: 'minimal',
        ...titled(options.title),
    });
}

/**
 * A tab's root (Chats, More, Search), the first screen of its tab's own stack (tab-stack.tsx):
 * the tab's name as a large title over its list, collapsing as it scrolls, as Mail's and Settings'
 * do. `large: false` keeps the bar one row (Home, CB-431: its workspace button leads that row).
 */
export function tabRoot(title: string, options: { readonly large?: boolean } = {}): Preset {
    return made({ ...nativeBar(options.large === false ? 'inline' : 'large'), title });
}

export interface SheetOptions {
    readonly title?: string;
    /** The header. Off by default: a sheet has a grabber, not a bar. */
    readonly header?: boolean;
    /** The height it opens at, as a fraction of the window, or `fit` to size it to its content. */
    readonly detent: number | 'fit';
    /**
     * Whether it can be dragged up to the full window (the large detent). On by
     * default; off for a short picker (CB-421), which keeps the one it opens at.
     */
    readonly expands?: boolean;
}

/** A sheet over the current page: it opens part way, expands to the full window, and closes by swiping down. */
export function sheet(options: SheetOptions): Preset {
    return made({
        presentation: 'formSheet',
        headerShown: options.header ?? false,
        headerBackVisible: false,
        gestureEnabled: true,
        sheetGrabberVisible: true,
        sheetAllowedDetents:
            options.detent === 'fit'
                ? 'fitToContents'
                : options.expands === false
                  ? [options.detent]
                  : [options.detent, 1],
        ...titled(options.title),
    });
}

export interface ModalOptions {
    readonly title?: string;
    /** The header. Off by default: the screen draws its own close button. */
    readonly header?: boolean;
}

/** A full-screen modal over everything, closed by its own button, never by Back. */
export function modal(options: ModalOptions = {}): Preset {
    return made({
        presentation: 'fullScreenModal',
        headerShown: options.header ?? false,
        headerBackVisible: false,
        ...titled(options.title),
    });
}

/**
 * A compose screen as a page sheet (CB-421; Mail's compose):
 * on iOS the page behind recedes and a swipe down dismisses it, unless the
 * screen holds a draft (React Navigation's `usePreventRemove`, which makes
 * the swipe ask); on Android, which has no page sheet, it is a modal over the
 * page that Back closes. Its own Cancel and action sit at its top.
 */
export function pageSheet(options: ModalOptions = {}): Preset {
    return made({
        presentation: 'pageSheet',
        headerShown: options.header ?? false,
        headerBackVisible: false,
        gestureEnabled: true,
        ...titled(options.title),
    });
}

/**
 * The top inset a page sheet's own bar pads by: none on iOS, where the sheet
 * starts below the status bar, the status bar's on Android, where it is the
 * whole window.
 */
export const pageSheetTopInset = (os: string, top: number) => (os === 'ios' ? 0 : top);

export interface ImmersiveOptions {
    /** Hide the status bar, Android's navigation bar and the iOS home indicator. */
    readonly hideSystemBars?: boolean;
}

/**
 * Full-screen media with no bar and no system dismiss gesture: the screen draws its own drag to
 * dismiss (the attachment viewer's, CB-537), so it is a transparent modal, and the screen underneath
 * shows through as its backdrop fades.
 */
export function immersive(options: ImmersiveOptions = {}): Preset {
    return made({
        presentation: 'transparentModal',
        headerShown: false,
        gestureEnabled: false,
        ...(options.hideSystemBars
            ? { statusBarHidden: true, navigationBarHidden: true, autoHideHomeIndicator: true }
            : {}),
    });
}

/**
 * A preset as one platform takes it (`liquidGlass`: iOS 26 or later).
 * - A native bar lies over the page on iOS only: Android's is a Material top
 *   app bar above it, opaque, with one size of title. Before iOS 26 there is
 *   no scroll edge effect, so a transparent bar gets the system's material.
 * - react-native-screens lays an Android form sheet out at its largest detent,
 *   so at a lower one its bottom (the page review's Save and Skip) sits below
 *   the visible part: on Android a sheet keeps only the detent it opens at.
 *   iOS keeps both.
 */
export function onPlatform(options: Preset, os: string, liquidGlass = true): Preset {
    if (options.headerShown === true && options.headerTransparent === true) {
        if (!nativeBarOverlays(os)) {
            const {
                headerBlurEffect: _blur,
                headerLargeTitleEnabled: _large,
                headerLargeTitleShadowVisible: _largeShadow,
                ...rest
            } = options;
            return made({ ...rest, headerTransparent: false });
        }
        if (!liquidGlass && options.headerBlurEffect === undefined) {
            return made({ ...options, headerBlurEffect: 'systemChromeMaterial' });
        }
        return options;
    }
    const detents = options.sheetAllowedDetents;
    if (os !== 'android' || !Array.isArray(detents) || detents.length < 2) {
        return options;
    }
    return made({ ...options, sheetAllowedDetents: detents.slice(0, 1) });
}
