import type { NativeStackHeaderItem, NativeStackNavigationOptions } from '@react-navigation/native-stack';

import type { MenuAction } from '../chat/long-press';
import { MENU_SYMBOLS } from '../shell/native-menu';
import type { ToneName } from '../theme/theme';

// A page's bar items, said once for both platforms (CB-420; the owner,
// 2026-11-18: the web's brand in each platform's own components), and what
// each platform's native bar takes from them (native-bar.tsx sets them):
// - iOS: UIBarButtonItems (`unstable_headerRightItems`), an SF Symbol or the
//   label, which iOS 26 puts in Liquid Glass, grouped as the system groups them;
// - Android: Material icon or text buttons in the top app bar's end
//   (`headerRight`, drawn by native-bar.tsx), each with its testID for Maestro.
// The module's tone has one place in the bar, MODULE_TONE_PLACE.
// No React Native here, so the Node tests read it as the app does.

/** A button in the bar. */
export interface BarButtonSpec {
    readonly kind?: 'button';
    /** Its testID on Android, its identifier on iOS (matched across a push). */
    readonly id: string;
    /** What it says: its words for screen readers, and the button itself where it has no icon. */
    readonly label: string;
    /** The SF Symbol iOS draws (`plus`, `ellipsis`); none: the label is the button. */
    readonly symbol?: string;
    /** Whether Android draws its icon (an icon button) or its label (a text button). */
    readonly iconOnly?: boolean;
    readonly onPress: () => void;
    readonly disabled?: boolean;
    readonly hint?: string;
    /** iOS 26's prominent (tinted) glass, for the bar's one main action (Done). */
    readonly prominent?: boolean;
    /** Its color, when not the bar's. */
    readonly tint?: string;
    /**
     * A menu the button opens instead of `onPress` (CB-421): a UIMenu from the
     * bar button on iOS, Material's popup from the icon button on Android.
     */
    readonly menu?: BarMenu;
}

/** A bar button's menu: `useActionMenu`'s items, so they are the screen-reader actions too. */
export interface BarMenu {
    readonly title?: string;
    readonly actions: readonly MenuAction[];
    readonly onAction: (name: string) => void;
}

/** Something the system has no item for (a room's socios), drawn by the app inside the bar. */
export interface BarCustomSpec {
    readonly kind: 'custom';
    readonly id: string;
    /** What it shows, for the bar to know when to draw it again. */
    readonly signature: string;
    /**
     * iOS 26: no Liquid Glass behind it, for an item that is its own shape (the
     * workspace's squircle logo on Home, owner 2026-11-08: no glass behind it).
     */
    readonly bare?: boolean;
}

export type BarItemSpec = BarButtonSpec | BarCustomSpec;

const isCustom = (item: BarItemSpec): item is BarCustomSpec => item.kind === 'custom';

/** iOS's bar item for a button, or for a button that opens a menu (a UIMenu from it). */
export function iosBarItem(item: BarButtonSpec): NativeStackHeaderItem {
    const menu = item.menu;
    if (menu !== undefined) {
        return {
            type: 'menu',
            label: item.label,
            ...(item.symbol === undefined ? {} : { icon: { type: 'sfSymbol' as const, name: item.symbol as never } }),
            ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
            variant: 'plain',
            ...(item.tint === undefined ? {} : { tintColor: item.tint }),
            identifier: item.id,
            accessibilityLabel: item.label,
            ...(item.hint === undefined ? {} : { accessibilityHint: item.hint }),
            menu: {
                ...(menu.title === undefined ? {} : { title: menu.title }),
                items: menu.actions.map((action) => {
                    const symbol = action.icon ?? MENU_SYMBOLS[action.name];
                    return {
                        type: 'action' as const,
                        label: action.label,
                        ...(symbol === undefined ? {} : { icon: { type: 'sfSymbol' as const, name: symbol as never } }),
                        onPress: () => menu.onAction(action.name),
                        ...(action.checked === true ? { state: 'on' as const } : {}),
                        ...(action.disabled === true ? { disabled: true } : {}),
                        ...(action.destructive === true ? { destructive: true } : {}),
                    };
                }),
            },
        };
    }
    return {
        type: 'button',
        label: item.label,
        ...(item.symbol === undefined ? {} : { icon: { type: 'sfSymbol' as const, name: item.symbol as never } }),
        onPress: item.onPress,
        ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
        variant: item.prominent === true ? 'prominent' : 'plain',
        ...(item.tint === undefined ? {} : { tintColor: item.tint }),
        identifier: item.id,
        accessibilityLabel: item.label,
        ...(item.hint === undefined ? {} : { accessibilityHint: item.hint }),
    };
}

/**
 * iOS's items, from the bar's end inward as UIKit lays them out: the first one
 * said is the one at the edge. `custom` gives the drawn element for a custom item.
 */
export function iosBarItems(
    items: readonly BarItemSpec[],
    custom: (item: BarCustomSpec) => NativeStackHeaderItem,
): NativeStackHeaderItem[] {
    return items.map((item) => (isCustom(item) ? custom(item) : iosBarItem(item)));
}

/**
 * When the bar must be set again: what each item shows and whether it can be
 * pressed. Its handlers aren't in it: the bar calls the latest ones.
 */
export function barSignature(parts: {
    readonly title?: string;
    readonly items: readonly BarItemSpec[];
    readonly search?: string | null;
    readonly extra?: string;
}): string {
    const items = parts.items.map((item) =>
        isCustom(item)
            ? `c:${item.id}:${item.signature}:${item.bare === true}`
            : `b:${item.id}:${item.label}:${item.symbol ?? ''}:${item.disabled === true}:${item.prominent === true}:${item.tint ?? ''}:${item.hint ?? ''}:${menuSignature(item.menu)}`,
    );
    return JSON.stringify([parts.title ?? null, items, parts.search ?? null, parts.extra ?? null]);
}

const menuSignature = (menu: BarMenu | undefined) =>
    menu === undefined
        ? ''
        : JSON.stringify([
              menu.title ?? null,
              menu.actions.map((action) => [
                  action.name,
                  action.label,
                  action.disabled,
                  action.checked,
                  action.destructive,
              ]),
          ]);

/** Whether a page's search field is the bar's own (iOS's UISearchController) or the page's drawn one (Android). */
export const barSearch = (os: string) => os === 'ios';

/**
 * Where a module page's tone goes now that the large title replaces
 * PageHeader's tile and title (the owner keeps the module tones, memory
 * "design-color-rationale"), at MODULE_TONE_PLACE:
 * - `title`: the large title in the module's tone, as Reminders colors each
 *   list's title (the inline title, once collapsed, stays the label's color);
 *   on Android, which has one size of title, the top app bar's title;
 * - `tint`: Back and the bar's buttons in the tone, as Notes tints its bar;
 * - `intro`: the tone tile, smaller, at the start of the page's first line
 *   (its counts or its intro), as Files and Settings lead a row with one.
 */
export type TonePlace = 'title' | 'tint' | 'intro';

export const TONE_PLACES = ['title', 'tint', 'intro'] as const satisfies readonly TonePlace[];

/**
 * The one switch (CB-420). The owner's pick (2026-11-19): `intro`, a small tone tile leading the
 * page's first line, the bar neutral.
 */
export const MODULE_TONE_PLACE: TonePlace = 'intro';

/** The bar's options for a module's tone at `place`, given the tone's text color and the bar's own. */
export function toneBarOptions(
    place: TonePlace,
    colors: { readonly tone: string; readonly bar: string },
    os: string,
): Pick<NativeStackNavigationOptions, 'headerLargeTitleStyle' | 'headerTintColor' | 'headerTitleStyle'> {
    switch (place) {
        case 'title':
            return os === 'ios'
                ? { headerLargeTitleStyle: { color: colors.tone } }
                : { headerTitleStyle: { color: colors.tone } };
        case 'tint':
            // native-stack colors the title with the tint too: the titles keep the bar's color.
            return {
                headerTintColor: colors.tone,
                headerTitleStyle: { color: colors.bar },
                headerLargeTitleStyle: { color: colors.bar },
            };
        case 'intro':
            return {};
    }
}

/** Whether the page's first line leads with the module's tile (`intro`). */
export const introTile = (place: TonePlace) => place === 'intro';

/** A module page's tone, as its bar takes it. */
export interface BarTone {
    readonly tone: ToneName;
}
