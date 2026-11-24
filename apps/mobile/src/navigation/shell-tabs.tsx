import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { getFocusedRouteNameFromRoute, type RouteProp } from '@react-navigation/native';
import { Platform } from 'react-native';

import { TabBadge } from '../screens/attention';
import { ChatsScreen } from '../screens/chats';
import { HomeScreen } from '../screens/home';
import { MoreScreen } from '../screens/more';
import { NotificationAskWatcher } from '../screens/notification-ask';
import { SearchScreen } from '../screens/search';
import { SpacesScreen } from '../screens/spaces';

import { hidesTabBar } from './routes';
import { ScreenBoundary } from './screen-boundary';
import { ShellDrawer } from './shell-drawer';
import { tabStack } from './tab-stack';
import { BADGED_TABS, staticTabs, tabBadge, TABS } from './tabs';

// The shell's tabs (tabs.ts): React Navigation's native bottom tabs,
// the root stack's `Tabs` route (routes.ts), built from the tab table and each
// tab's component here. The system draws the tab bar: iOS 26's in Liquid Glass,
// with Search as its separate glass button, and Android's Material bottom
// navigation. The tabs have no header of their own: each tab is its own stack
// (tab-stack.tsx), its root first, then the pages pushed inside it with
// the tab bar still under them. Home's, Chats' and More's roots have the
// system bar with the tab's large title (Home's bar is one row instead, led by
// its workspace button with the workspace's name: CB-431); Search's root
// has the bar's search field on iOS and draws its own on Android. Each sits in its own error boundary, as every stack screen does. The workspace
// drawer (shell-drawer.tsx) wraps the navigator, over the tab bar. The
// notification ask's watcher sits in it, so only the shell asks, and
// so do the tabs' badges, which show before their tab is ever opened: Chats'
// (CB-455: what needs attention, at the top of Chats since the Inbox tab went)
// and Spaces' (CB-459: the pages changed elsewhere while the person's edits waited).
// A chat or a room, and New chat, hide the tab bar while they show, in any tab
// (CB-491, as Messages and Slack do): Back returns to the list, and the bar.
const tabs = staticTabs(
    {
        Home: tabStack('Home', TABS.Home.label, HomeScreen, { large: false }),
        Chats: tabStack('Chats', TABS.Chats.label, ChatsScreen),
        Spaces: tabStack('Spaces', TABS.Spaces.label, SpacesScreen),
        More: tabStack('More', TABS.More.label, MoreScreen),
        Search: tabStack('Search', TABS.Search.label, SearchScreen),
    },
    Platform.OS,
);

/**
 * A tab's options from its route: its badge from the route's params (`tabBadge`, CB-455 and CB-459),
 * when `badge`, and no tab bar while its stack shows a chat, a room or New chat (`hidesTabBar`,
 * CB-491). The focused page's name comes from the tab's stack state, or from a link's params before
 * that stack has mounted, so a link into a chat lands with no bar.
 */
function tabOptions<Tab extends { readonly options: object }>(tab: Tab, badge: boolean) {
    return {
        ...tab,
        options: ({ route }: { route: RouteProp<Record<string, object | undefined>> }) => {
            const count = badge ? tabBadge(route.params) : undefined;
            const hidden = hidesTabBar(getFocusedRouteNameFromRoute(route));
            return {
                ...tab.options,
                ...(count === undefined ? {} : { tabBarBadge: count }),
                ...(hidden ? { tabBarStyle: { display: 'none' as const } } : {}),
            };
        },
    };
}

export const ShellTabs = createNativeBottomTabNavigator({
    layout: ({ children, state, navigation }) => (
        <ShellDrawer onHome={state.routes[state.index]?.name === 'Home'} navigation={navigation}>
            {children}
            <NotificationAskWatcher />
            {BADGED_TABS.map((tab) => (
                <TabBadge
                    key={tab}
                    tab={tab}
                    handle={{
                        navigator: state.key,
                        route: state.routes.find((route) => route.name === tab),
                        dispatch: navigation.dispatch,
                    }}
                />
            ))}
        </ShellDrawer>
    ),
    // Every tab's label shows, as Slack's do (Material shows only the selected one's past three tabs).
    screenOptions: { headerShown: false, tabBarLabelVisibilityMode: 'labeled' },
    screenLayout: (props) => <ScreenBoundary {...props} />,
    screens: {
        Home: tabOptions(tabs.Home, false),
        Chats: tabOptions(tabs.Chats, true),
        Spaces: tabOptions(tabs.Spaces, true),
        More: tabOptions(tabs.More, false),
        Search: tabOptions(tabs.Search, false),
    },
});
