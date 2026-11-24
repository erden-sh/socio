import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { ComponentType, ReactNode } from 'react';
import { Platform } from 'react-native';
import { SafeAreaInsetsContext, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BUILD_VARIANT } from '../platform/variant';
import { hasLiquidGlass } from '../ui/glass';

import { MATERIAL_NAVIGATION_BAR, onPlatform, tabRoot } from './presets';
import { hidesTabBar, staticTabScreens } from './routes';
import { ScreenBoundary } from './screen-boundary';
import { TAB_ROUTE_COMPONENTS } from './tab-screens';
import { tabRootName, tabRootPath, type TabName } from './tabs';

// A tab's own native stack (CB-420 for its root's bar), as each tab of
// Music, Mail, Settings and the App Store has one: the tab's root under
// `<tab>Root` (so a tab's name means the tab alone, and a navigate to it goes
// up to the tab navigator), then every page of the route table with a `tab`
// (routes.ts, components in tab-screens.tsx), pushed here with the tab bar
// still under it. Each tab remembers where the person was; tapping the tab
// again pops it to its root (the native tabs' repeated press, which
// native-stack's `tabPress` listener follows on Android). A page's link path
// opens it in its own tab only (`staticTabScreens`). On iOS the stack is a
// UINavigationController inside the UITabBarController, so iOS 26's bar
// transitions run between its pages; on Android each tab keeps its own back
// stack, and Back pops it before it leaves the tab (Material's bottom
// navigation). Sheets, compose page sheets and the page editor stay on the
// root stack, over the tab bar.
//
// A page pushed in a tab lies under the tab bar, which floats over its bottom
// (iOS 26's glass, and Android's bottom navigation, edge to edge). Its bottom
// safe area counts the bar (`TabPageInsets`), so a bottom edge (the chat's
// composer, a page's own bottom bar) and a padded page clear it: on iOS a safe
// area provider of the page's own, measured by UIKit, which counts the tab
// bar; on Android Material's navigation bar height on top of the window's.
// The tab's root keeps the window's, as it did, and so do the pages that hide
// the tab bar (a chat, a room, New chat: CB-491), whose composer sits on the
// home indicator and the keyboard with no tab bar's room left over.

/** A tab page's safe area: the window's, with the tab bar in its bottom. */
function TabPageInsets(props: { readonly children: ReactNode }) {
    const insets = useSafeAreaInsets();
    if (Platform.OS === 'ios') {
        return <SafeAreaProvider>{props.children}</SafeAreaProvider>;
    }
    return (
        <SafeAreaInsetsContext.Provider value={{ ...insets, bottom: insets.bottom + MATERIAL_NAVIGATION_BAR }}>
            {props.children}
        </SafeAreaInsetsContext.Provider>
    );
}

/** The tab's own stack, its root titled with the tab's label: a large title unless `large: false`. */
export function tabStack(tab: TabName, title: string, Root: ComponentType, bar: { readonly large?: boolean } = {}) {
    const rootOptions = tabRoot(title, bar);
    return createNativeStackNavigator({
        initialRouteName: tabRootName(tab),
        screenOptions: ({ theme }) => ({ headerTintColor: theme.colors.text }),
        screenLayout: (props) =>
            props.route.name === tabRootName(tab) || hidesTabBar(props.route.name) ? (
                <ScreenBoundary {...props} />
            ) : (
                <TabPageInsets>
                    <ScreenBoundary {...props} />
                </TabPageInsets>
            ),
        screens: {
            [tabRootName(tab)]: {
                screen: Root,
                // Its own path, if any (the Spaces list's, CB-459); a link opens the tab on it.
                linking: tabRootPath(tab),
                options: onPlatform(rootOptions, Platform.OS, hasLiquidGlass()),
            },
            ...staticTabScreens(tab, TAB_ROUTE_COMPONENTS, BUILD_VARIANT, Platform.OS, hasLiquidGlass()),
        },
    });
}
