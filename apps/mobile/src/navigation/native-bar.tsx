import { useNavigation } from '@react-navigation/native';
import type { NativeStackHeaderItem, NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { type ReactElement, type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { Platform, Pressable, View } from 'react-native';
import type { SearchBarCommands } from 'react-native-screens';

import { ActionMenu } from '../screens/action-menu';
import { MENU_TAKES_TAP } from '../shell/native-menu';
import { useScheme } from '../theme/scheme';
import { theme, type ToneName } from '../theme/theme';
import { AppSymbol, Text } from '../ui';
import type { SymbolName } from '../ui/symbols';

import {
    type BarButtonSpec,
    type BarCustomSpec,
    barSearch,
    barSignature,
    iosBarItems,
    MODULE_TONE_PLACE,
    toneBarOptions,
} from './bar-items';

// A page fills in the system's bar its preset gives (CB-420; presets.ts):
// its title, its buttons at the end, a search field, and its module's tone.
// iOS takes native bar items (SF Symbols in Liquid Glass) and a native search
// field (UISearchController); Android draws Material icon and text buttons in
// its top app bar, each with its testID, and keeps the page's drawn search
// field (`barSearch`). The bar is set again only when what it shows changes
// (`barSignature`); its buttons always call the latest handlers.

/** A button, with the lucide icon Android draws for it. */
export interface BarButton extends BarButtonSpec {
    readonly icon?: SymbolName;
}

/** A custom item: the element the bar draws on both platforms. */
export interface BarCustom extends BarCustomSpec {
    readonly element: () => ReactElement;
}

export type BarItem = BarButton | BarCustom;

export interface BarSearch {
    /** The placeholder, and what screen readers call it. */
    readonly placeholder: string;
    readonly onChange: (text: string) => void;
    /**
     * The system field's commands (iOS), for a page that empties or focuses it itself: Search's
     * and a Space's Clear search (CB-552). Setting its text from here sends no change: the page
     * sets its own query too.
     */
    readonly ref?: RefObject<SearchBarCommands | null>;
}

export interface NativeBar {
    /** The bar's title, large or inline as the route's preset says. */
    readonly title?: string;
    /** A title drawn by the page (the chat's socio), with what it shows for `signature`. */
    readonly titleView?: { readonly element: () => ReactNode; readonly signature: string };
    /** The buttons at the bar's end, the first at the edge. */
    readonly right?: readonly BarItem[];
    /**
     * Items at the bar's start, the first at the edge, for a tab's root with no Back (Home's
     * workspace button, Slack's): UIBarButtonItems on iOS, Material's navigation icon on Android.
     */
    readonly left?: readonly BarItem[];
    /**
     * `true` hides the bar while the screen draws its own top (Home's first run, which is New
     * chat's screen); `false` shows it again. Left out, the preset's holds.
     */
    readonly hidden?: boolean;
    /** A search field in the bar (iOS); Android's page draws its own. */
    readonly search?: BarSearch;
    /** The module's tone, placed by MODULE_TONE_PLACE. */
    readonly tone?: ToneName;
    /** `false` hides Back and its swipe while the page is in a mode of its own (the Board's Select, Mail's). */
    readonly back?: false;
    /**
     * iOS 26's edge under the bar: `hard`, a cutoff and a dividing line, for a transcript under a
     * two-line title (the chat's socio, a room), where the soft one leaves the bubbles legible
     * through the title. Pages keep the system's (`automatic`).
     */
    readonly edge?: 'hard';
}

const NO_ITEMS: readonly BarItem[] = [];

const isCustom = (item: BarItem): item is BarCustom => item.kind === 'custom';

/** Sets the page's bar. */
export function useNativeBar(bar: NativeBar): void {
    const navigation = useNavigation();
    const scheme = useScheme();
    const latest = useRef(bar);
    useLayoutEffect(() => {
        latest.current = bar;
    });
    const items = bar.right ?? NO_ITEMS;
    const leftItems = bar.left ?? NO_ITEMS;
    const signature = barSignature({
        ...(bar.title === undefined ? {} : { title: bar.title }),
        items,
        search: bar.search?.placeholder ?? null,
        extra: `${bar.titleView?.signature ?? ''}|${bar.tone ?? ''}|${bar.back ?? ''}|${bar.edge ?? ''}|${bar.hidden ?? ''}|${scheme}|${barSignature({ items: leftItems })}`,
    });
    useLayoutEffect(() => {
        const current = latest.current;
        const right = current.right ?? NO_ITEMS;
        const left = current.left ?? NO_ITEMS;
        // Each button calls the handler the page gave last, by its side and place.
        const press = (side: 'left' | 'right', index: number) => () => {
            const item = (latest.current[side] ?? NO_ITEMS)[index];
            if (item !== undefined && !isCustom(item)) {
                item.onPress();
            }
        };
        // A menu's choice too: the bar is set again only when what it shows changes, so a page
        // whose params moved under the same bar (a link to another page) would answer for the old one.
        const choose = (side: 'left' | 'right', index: number) => (name: string) => {
            const item = (latest.current[side] ?? NO_ITEMS)[index];
            if (item !== undefined && !isCustom(item)) {
                item.menu?.onAction(name);
            }
        };
        const withPress = (side: 'left' | 'right', list: readonly BarItem[]) =>
            list.map((item, index) =>
                isCustom(item)
                    ? item
                    : {
                          ...item,
                          onPress: press(side, index),
                          ...(item.menu === undefined ? {} : { menu: { ...item.menu, onAction: choose(side, index) } }),
                      },
            );
        const pressed = withPress('right', right);
        const pressedLeft = withPress('left', left);
        // A custom item's element, by its id, for iOS's item (in glass unless it is `bare`).
        const customItem =
            (list: readonly BarItem[]) =>
            (item: BarCustomSpec): NativeStackHeaderItem => ({
                type: 'custom',
                element: (list.find((one) => one.id === item.id) as BarCustom).element(),
                ...(item.bare === true ? { hidesSharedBackground: true } : {}),
            });
        const colors = theme[scheme].colors;
        // Every key, each time: setOptions merges, so a key left out would keep the last value
        // (a search field after the tab that had it, a button after its mode).
        const options: NativeStackNavigationOptions = {
            ...(current.title === undefined ? {} : { title: current.title }),
            headerBackVisible: current.back !== false,
            gestureEnabled: current.back !== false,
            headerTitle: current.titleView === undefined ? undefined : () => latest.current.titleView?.element(),
            headerTintColor: colors['header-foreground'],
            headerTitleStyle: undefined,
            headerLargeTitleStyle: undefined,
            ...(current.tone === undefined
                ? {}
                : toneBarOptions(
                      MODULE_TONE_PLACE,
                      {
                          tone: theme[scheme].tones[current.tone].foreground,
                          bar: colors['header-foreground'],
                      },
                      Platform.OS,
                  )),
            scrollEdgeEffects: current.edge === 'hard' ? { top: 'hard' } : undefined,
            ...(current.hidden === undefined ? {} : { headerShown: !current.hidden }),
            headerSearchBarOptions: undefined,
            headerRight: undefined,
            unstable_headerRightItems: undefined,
            headerLeft: undefined,
            unstable_headerLeftItems: undefined,
        };
        if (Platform.OS === 'ios') {
            options.unstable_headerRightItems = () => iosBarItems(pressed, customItem(right));
            if (left.length > 0) {
                options.unstable_headerLeftItems = () => iosBarItems(pressedLeft, customItem(left));
            }
            if (current.search !== undefined && barSearch(Platform.OS)) {
                options.headerSearchBarOptions = {
                    placeholder: current.search.placeholder,
                    autoCapitalize: 'none',
                    hideWhenScrolling: false,
                    onChangeText: (event) => latest.current.search?.onChange(event.nativeEvent.text),
                    onCancelButtonPress: () => latest.current.search?.onChange(''),
                    ...(current.search.ref === undefined ? {} : { ref: current.search.ref }),
                };
            }
        } else {
            if (right.length > 0) {
                // The first item at the bar's edge, as UIKit lays iOS's out.
                options.headerRight = () => <MaterialBarItems items={[...pressed].reverse()} />;
            }
            if (left.length > 0) {
                options.headerLeft = () => <MaterialBarItems items={pressedLeft} />;
            }
        }
        navigation.setOptions(options);
        // `signature` says when what the bar shows changed; the handlers are read from `latest`.
    }, [navigation, signature, scheme]);
}

/** A Material top app bar's items, in the order they are laid out. */
function MaterialBarItems({ items }: { items: readonly BarItem[] }) {
    return (
        <View className="flex-row items-center">
            {items.map((item) =>
                isCustom(item) ? (
                    <View key={item.id}>{(item as BarCustom).element()}</View>
                ) : (
                    <MaterialBarButton key={item.id} item={item as BarButton} />
                ),
            )}
        </View>
    );
}

/**
 * A Material top app bar's action: an icon button (48 dp, a 24 dp icon) or a
 * text button in the brand's primary, as Material 3's app bars have them.
 */
function MaterialBarButton({ item }: { item: BarButton }) {
    const icon = item.iconOnly === true && item.icon !== undefined;
    const button = (
        <Pressable
            testID={item.menu === undefined ? item.id : undefined}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            accessibilityHint={item.hint}
            accessibilityState={{ disabled: item.disabled === true }}
            disabled={item.disabled}
            onPress={item.menu === undefined ? item.onPress : MENU_TAKES_TAP}
            android_ripple={{ borderless: true, radius: 24 }}
            className="h-12 min-w-12 items-center justify-center px-3 disabled:opacity-40"
        >
            {icon && item.icon !== undefined ? (
                <AppSymbol name={item.icon} size={24} />
            ) : (
                <Text weight="medium" tone="primary">
                    {item.label}
                </Text>
            )}
        </Pressable>
    );
    // A button with a menu (CB-421): Material's popup from it; the menu takes the tap and is what TalkBack reaches.
    return item.menu === undefined ? (
        button
    ) : (
        <ActionMenu request={item.menu} trigger="press" label={item.label} testID={item.id} disabled={item.disabled}>
            {button}
        </ActionMenu>
    );
}
