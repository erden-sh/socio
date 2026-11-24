import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULE_IDS } from '@socio/shared/modules';

import { gateRoot } from '../../src/navigation/routes';
import {
    isMoreItem,
    approvalAction,
    approvalsAction,
    ATTENTION_PARAM,
    BADGED_TABS,
    tabBadge,
    moreItemAction,
    isTabName,
    MORE_ITEMS,
    moreRows,
    restoreAction,
    pageAction,
    restorePageAction,
    restoreIssueAction,
    issueAction,
    jobAction,
    runAction,
    scheduleAction,
    taskAction,
    restoreSpaceAction,
    staticTabs,
    tabAction,
    tabDrawable,
    tabIcon,
    TAB_NAMES,
    TAB_REDIRECTS,
    TABS,
    type TabSpec,
} from '../../src/navigation/tabs';
import { lastScreen, SHELL_SCREENS } from '../../src/shell/last-screen';
import { moduleEntry } from '../../src/shell/modules';
import { navigationCore } from '../helpers/navigation-core';

// The tab table: the native
// tabs, their labels, icons, links and testIDs, Search's role, what More
// holds, and that the navigator and the root stack are built from it. No React
// Native renderer under Node, so the .tsx files are read as text.

const app = join(import.meta.dirname, '../..');
const src = join(app, 'src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');
const lucide = join(app, 'node_modules/lucide-react-native');
const stand = () => Object.fromEntries(TAB_NAMES.map((name) => [name, () => null])) as never;

describe('the tab table', () => {
    it('is Home, Chats, More and Search, in that order, with no tab called Activity and no Inbox (CB-455)', () => {
        // CB-459: the slot the Inbox freed went to Spaces.
        expect(TAB_NAMES).toEqual(['Home', 'Chats', 'Spaces', 'More', 'Search']);
        expect(TAB_NAMES.map((name) => TABS[name].label)).toEqual(['Home', 'Chats', 'Spaces', 'More', 'Search']);
        expect(isTabName('Inbox')).toBe(false);
        expect(TAB_REDIRECTS.Inbox).toBe('Chats');
    });

    it('badges Chats (CB-455) and Spaces (CB-459) from their routes’ params, none at 0', () => {
        expect(BADGED_TABS).toEqual(['Chats', 'Spaces']);
        expect(tabBadge(undefined)).toBeUndefined();
        expect(tabBadge({ [ATTENTION_PARAM]: 0 })).toBeUndefined();
        expect(tabBadge({ [ATTENTION_PARAM]: 3 })).toBe('3');
        expect(tabBadge({ [ATTENTION_PARAM]: 120 })).toBe('99+');
        expect(tabBadge({ [ATTENTION_PARAM]: '3' })).toBeUndefined();
        const shell = read('navigation/shell-tabs.tsx');
        expect(shell).toContain('const count = badge ? tabBadge(route.params) : undefined;');
        expect(shell).toContain('tabBarBadge: count');
        expect(shell).toContain('Chats: tabOptions(tabs.Chats, true),');
        expect(shell).toContain('Spaces: tabOptions(tabs.Spaces, true),');
        expect(shell).toContain('Home: tabOptions(tabs.Home, false),');
        // In the tabs' layout, so a badge shows before its tab is ever opened.
        expect(shell).toContain('<TabBadge');
        expect(shell).not.toContain('InboxScreen');
        const attention = read('screens/attention.tsx');
        expect(attention).toContain('useTabBadge(handle, attentionCount(useAttention()));');
        // Spaces' badge: the pages changed elsewhere (CB-459).
        expect(attention).toContain('useTabBadge(handle, spacesAttention(useAllPageConflicts()));');
        expect(attention).toContain("type: 'SET_PARAMS'");
        // What the Inbox held is at the top of Chats, and nothing shows while it's empty.
        expect(read('screens/chats.tsx')).toContain('<AttentionSections view={attention} />');
        expect(attention).toMatch(/if \(view\.empty\) \{\n\s+return null;/);
        expect(existsSync(join(src, 'screens/inbox.tsx'))).toBe(false);
    });

    it('draws SF Symbols on iOS, filled when selected, and the system’s search icon for Search', () => {
        expect(tabIcon('Home', 'ios', false)).toEqual({ type: 'sfSymbol', name: 'house' });
        expect(tabIcon('Home', 'ios', true)).toEqual({ type: 'sfSymbol', name: 'house.fill' });
        expect(tabIcon('Chats', 'ios', true)).toEqual({ type: 'sfSymbol', name: 'bubble.left.and.bubble.right.fill' });
        expect(tabIcon('Search', 'ios', false)).toBeUndefined();
    });

    it('draws lucide’s icons on Android, as the drawables plugins/tab-icons.ts writes', () => {
        for (const name of TAB_NAMES) {
            const icon = TABS[name].lucide;
            expect(existsSync(join(lucide, 'dist/esm/icons', `${icon}.mjs`)), icon).toBe(true);
            expect(tabIcon(name, 'android', true)).toEqual({ type: 'image', source: { uri: tabDrawable(icon) } });
        }
        expect(TABS.Chats.lucide).toBe('message-circle');
        expect(tabDrawable('message-circle')).toBe('tab_message_circle');
    });

    it('gives Search the search role on iOS, which draws it as the separate glass button, and none on Android', () => {
        const ios = staticTabs(stand(), 'ios');
        const android = staticTabs(stand(), 'android');
        expect(ios.Search.options.tabBarRole).toBe('search');
        // iOS 27 separates it only with autofocus on.
        expect(ios.Search.options.tabBarSearchAutoFocus).toBe(true);
        expect(android.Search.options.tabBarSearchAutoFocus).toBeUndefined();
        expect(ios.Search.options.tabBarIcon).toBeUndefined();
        // The role needs iOS 26.1; the system item draws the icon on iOS 18 and 26.0 too.
        expect(ios.Search.options.tabBarSystemItem).toBe('search');
        expect(android.Search.options.tabBarSystemItem).toBeUndefined();
        expect(android.Search.options.tabBarRole).toBeUndefined();
        expect(android.Search.options.tabBarIcon?.({ focused: false })).toEqual(tabIcon('Search', 'android', false));
        for (const name of TAB_NAMES) {
            const options: { tabBarIcon?: unknown; tabBarSystemItem?: unknown } = ios[name].options;
            expect(options.tabBarIcon !== undefined || options.tabBarSystemItem !== undefined, name).toBe(true);
        }
        for (const name of TAB_NAMES.filter((n) => n !== 'Search')) {
            expect(ios[name].options.tabBarRole, name).toBeUndefined();
            expect(ios[name].options.tabBarIcon?.({ focused: true }), name).toEqual(tabIcon(name, 'ios', true));
        }
    });

    it("links Home at the web's root and no other tab", () => {
        const links = Object.fromEntries(TAB_NAMES.map((name) => [name, (TABS[name] as TabSpec).linking]));
        expect(links).toEqual({ Home: '', Chats: undefined, Inbox: undefined, More: undefined, Search: undefined });
    });

    it('gives each tab its own testID, which the navigator uses', () => {
        const ids = TAB_NAMES.map((name) => TABS[name].testID);
        expect(new Set(ids).size).toBe(ids.length);
        const screens = staticTabs(stand(), 'ios');
        for (const name of TAB_NAMES) {
            expect(screens[name].options).toMatchObject({
                title: TABS[name].label,
                tabBarButtonTestID: TABS[name].testID,
            });
            // A tab's own path, if any, with its root as the first screen of its stack, so a link to
            // one of its pages opens over the root.
            const path = (TABS[name] as TabSpec).linking;
            expect(screens[name].linking).toEqual(
                path === undefined ? { initialRouteName: `${name}Root` } : { path, initialRouteName: `${name}Root` },
            );
        }
    });

    it('knows its own names and nothing else', () => {
        for (const name of TAB_NAMES) {
            expect(isTabName(name)).toBe(true);
        }
        for (const value of ['Board', 'Activity', 'toString', '', null, 3]) {
            expect(isTabName(value), String(value)).toBe(false);
        }
    });
});

describe('More', () => {
    it('holds Approvals, Scheduled & activity, Schedules, Memories, Learning, Runs and Settings, in that order', () => {
        expect(MORE_ITEMS).toEqual([
            MODULE_IDS.approvals,
            MODULE_IDS.activity,
            MODULE_IDS.schedules,
            MODULE_IDS.memories,
            MODULE_IDS.learning,
            MODULE_IDS.runs,
            MODULE_IDS.settings,
        ]);
        expect(moreRows('admin').map((row) => row.label)).toEqual([
            'Approvals',
            'Scheduled & activity',
            'Schedules',
            'Memories',
            'Learning',
            'Runs',
            'Settings & setup',
        ]);
    });

    it('reads Learning as Skills for members, and for a role not known yet', () => {
        const learning = (role: Parameters<typeof moreRows>[0]) =>
            moreRows(role).find((row) => row.id === MODULE_IDS.learning)?.label;
        // An older server's retired `operator` role reads as an admin (CB-390).
        expect(learning('operator' as never)).toBe('Learning');
        expect(learning('admin')).toBe('Learning');
        expect(learning('member')).toBe('Skills');
        expect(learning(null)).toBe('Skills');
    });

    it("gives each row its module's icon and tone", () => {
        for (const row of moreRows('member')) {
            expect(row).toMatchObject({ icon: moduleEntry(row.id).icon, tone: moduleEntry(row.id).tone });
        }
    });

    it('opens no module that is not a More item', () => {
        expect(isMoreItem(MODULE_IDS.memories)).toBe(true);
        expect(isMoreItem(MODULE_IDS.issues)).toBe(false);
        expect(isMoreItem('toString')).toBe(false);
    });
});

describe('the navigation built from it', () => {
    it('makes the tabs the shell gate’s root, as the root stack’s Tabs route', () => {
        expect(gateRoot('shell')).toBe('Tabs');
        expect(read('navigation/root-stack.tsx')).toMatch(/Tabs: ShellTabs,/);
    });

    it("builds the native tab navigator from the table, one component per tab, with the system's tab bar and no header", () => {
        const tabs = read('navigation/shell-tabs.tsx');
        expect(tabs).toContain(
            "import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';",
        );
        expect(tabs).not.toContain('tabBar:');
        expect(tabs).toContain("screenOptions: { headerShown: false, tabBarLabelVisibilityMode: 'labeled' },");
        expect(tabs).toContain('Platform.OS,');
        expect(tabs).toContain('screenLayout: (props) => <ScreenBoundary {...props} />');
        const block = tabs.slice(tabs.indexOf('= staticTabs('));
        // Every tab is its own stack, its root first: the system's bar and large title (CB-420),
        // Search's with the bar's search field, Home's one row (CB-431: the workspace button leads it).
        for (const name of ['Chats', 'More', 'Search']) {
            expect(block, name).toContain(`${name}: tabStack('${name}', TABS.${name}.label, ${name}Screen),`);
        }
        expect(block).toContain("Home: tabStack('Home', TABS.Home.label, HomeScreen, { large: false }),");
    });

    it("gives every stack page the system's bar, never a drawn one (CB-420)", () => {
        const stack = read('navigation/root-stack.tsx');
        expect(stack).not.toContain('stackHeader');
        expect(stack).toContain('screenOptions: ({ theme }) => ({ headerTintColor: theme.colors.text }),');
        expect(stack).toContain('hasLiquidGlass(),');
        const tab = read('navigation/tab-stack.tsx');
        expect(tab).toContain('tabRoot(title, bar)');
        expect(tab).toContain('options: onPlatform(rootOptions, Platform.OS, hasLiquidGlass()),');
        expect(tab).toContain('screenOptions: ({ theme }) => ({ headerTintColor: theme.colors.text }),');
        // The tab's pages, each with its preset as the platform takes it (routes.ts `staticTabScreens`).
        expect(tab).toContain(
            '...staticTabScreens(tab, TAB_ROUTE_COMPONENTS, BUILD_VARIANT, Platform.OS, hasLiquidGlass()),',
        );
    });

    it('keeps each tab but Search, and the Spaces and Board pages, as the last screen, and opens it again', () => {
        for (const name of [...TAB_NAMES.filter((n) => n !== 'Search'), 'Spaces', 'Board'] as const) {
            expect(SHELL_SCREENS).toContain(name);
            expect(lastScreen(name)).toBe(name);
        }
        expect(lastScreen('Search')).toBe('Home');
        // The Inbox tab is gone (CB-455): one kept by an older build opens Chats, which holds it.
        expect(SHELL_SCREENS).not.toContain('Inbox');
        expect(lastScreen('Inbox')).toBe('Chats');
        expect(lastScreen('toString')).toBe('Home');
        expect(read('screens/search.tsx')).not.toContain('useRememberScreen');
        for (const [file, name] of [
            ['screens/board.tsx', 'Board'],
            ['screens/chats.tsx', 'Chats'],
            ['screens/more.tsx', 'More'],
            ['screens/spaces.tsx', 'Spaces'],
        ]) {
            expect(read(file), file).toContain(`useRememberScreen('${name}')`);
        }
        expect(read('screens/home.tsx')).toContain(
            'restoreAction(lastScreen(viewState.get(LAST_SCREEN_KEY)), navigation.isFocused())',
        );
    });
});

describe("Home opening the kept last screen, on React Navigation's routers", () => {
    const config = { routeParamList: {}, routeGetIdList: {} };
    const stack = navigationCore.StackRouter({});
    const tabs = navigationCore.TabRouter({});
    const ROOT = [
        'Tabs',
        'Spaces',
        'Board',
        'Memories',
        'Activity',
        'Schedules',
        'Schedule',
        'Task',
        'Job',
        'Learning',
        'Runs',
        'Run',
        'Issue',
        'Space',
        'Page',
        'MoreItem',
        'Settings',
        'Account',
        'Approvals',
        'Approval',
    ];
    type Action =
        | ReturnType<typeof tabAction>
        | { type: 'NAVIGATE'; payload: { name: string; params?: object } }
        | { type: 'PUSH'; payload: { name: string; params?: object } }
        | { type: 'POP'; payload: { count: number } };
    type Root = ReturnType<typeof stack.getInitialState>;
    type TabState = ReturnType<typeof tabs.getInitialState>;

    /** The root stack with the tabs on `tab`, then the pages pushed over them. */
    function root(tab: string, ...pages: string[]) {
        let tabState: TabState = tabs.getInitialState({ ...config, routeNames: TAB_NAMES });
        tabState = tabs.getStateForAction(tabState, tabAction(tab as never), {
            ...config,
            routeNames: TAB_NAMES,
        }) as TabState;
        let state = stack.getInitialState({ ...config, routeNames: ROOT });
        state = { ...state, routes: [{ ...state.routes[0]!, state: tabState }] } as Root;
        for (const name of pages) {
            state = stack.getStateForAction(
                state,
                { type: 'PUSH', payload: { name } },
                { ...config, routeNames: ROOT },
            ) as Root;
        }
        return state;
    }

    /** Dispatched from inside the tabs: the tab router first, then the root stack, as React Navigation bubbles it. */
    function dispatch(state: Root, action: Action): Root {
        const tabsRoute = state.routes.find((route) => route.name === 'Tabs')!;
        const tabState = tabs.getStateForAction(
            tabsRoute.state as TabState,
            action as Parameters<typeof tabs.getStateForAction>[1],
            {
                ...config,
                routeNames: TAB_NAMES,
            },
        );
        if (tabState) {
            return {
                ...state,
                routes: state.routes.map((r) => (r === tabsRoute ? { ...r, state: tabState } : r)),
            } as Root;
        }
        return (stack.getStateForAction(state, action as Parameters<typeof stack.getStateForAction>[1], {
            ...config,
            routeNames: ROOT,
        }) ?? state) as Root;
    }
    const names = (state: Root) => state.routes.map((route) => route.name);
    const tab = (state: Root) => {
        const s = state.routes.find((route) => route.name === 'Tabs')!.state as TabState;
        return s.routes[s.index]!.name;
    };

    it('opens a kept tab on the tab navigator, and a kept page on the root stack, while Home is focused', () => {
        for (const last of ['Chats', 'Spaces', 'More'] as const) {
            const after = dispatch(root('Home'), restoreAction(last, true)!);
            expect(names(after), last).toEqual(['Tabs']);
            expect(tab(after), last).toBe(last);
        }
        for (const last of ['Board', 'Memories', 'Activity', 'Schedules', 'Learning', 'Runs'] as const) {
            expect(names(dispatch(root('Home'), restoreAction(last, true)!)), last).toEqual(['Tabs', last]);
        }
        expect(restoreAction('Home', true)).toBeNull();
    });

    /** The shown tab's route params: what it opens inside its own stack. */
    const opens = (state: Root) => {
        const s = state.routes.find((route) => route.name === 'Tabs')!.state as TabState;
        return s.routes[s.index]!.params;
    };

    it('opens a kept Space’s library in the Spaces tab, over its list, only while Home is focused (CB-459)', () => {
        const after = dispatch(root('Home'), restoreSpaceAction('ops', true)!);
        expect(names(after)).toEqual(['Tabs']);
        expect(tab(after)).toBe('Spaces');
        expect(opens(after)).toEqual({ screen: 'Space', params: { spaceId: 'ops' }, initial: false });
        expect(restoreSpaceAction('ops', false)).toBeNull();
        expect(restoreSpaceAction(null, true)).toBeNull();
        expect(read('screens/home.tsx')).toContain('restoreSpaceAction(spaceKept, navigation.isFocused())');
        expect(read('platform/active-scope.ts')).toContain('await preloadKeptSpace(scope');
    });

    it('opens a kept page in the Spaces tab, over its list, only while Home is focused (CB-459)', () => {
        const kept = { spaceId: 'ops', pageId: 'p1' };
        const after = dispatch(root('Home'), restorePageAction(kept, true)!);
        expect(names(after)).toEqual(['Tabs']);
        expect(tab(after)).toBe('Spaces');
        expect(opens(after)).toEqual({ screen: 'Page', params: kept, initial: false });
        expect(restorePageAction(kept, false)).toBeNull();
        // A page opened from a page is a new screen (PUSH): Back returns to the first.
        expect(pageAction('ops', 'p2').type).toBe('PUSH');
        expect(restorePageAction(null, true)).toBeNull();
        expect(read('screens/home.tsx')).toContain('restorePageAction(pageKept, navigation.isFocused())');
        expect(read('platform/active-scope.ts')).toContain('await preloadKeptPage(scope');
    });

    it('opens a kept issue over Home on the root stack, at its CB- key, only while Home is focused', () => {
        const after = dispatch(root('Home'), restoreIssueAction('12', true)!);
        expect(names(after)).toEqual(['Tabs', 'Issue']);
        expect(after.routes.at(-1)?.params).toEqual({ key: 'CB-12' });
        // A linked issue is a new screen: Back returns to the first.
        const twice = dispatch(after, issueAction('7'));
        expect(names(twice)).toEqual(['Tabs', 'Issue', 'Issue']);
        // An issue filed offline keeps its local key in the route until its create resolves.
        expect(issueAction('pending-issue-a').payload.params).toEqual({ key: 'pending-issue-a' });
        expect(restoreIssueAction('12', false)).toBeNull();
        expect(restoreIssueAction(null, true)).toBeNull();
        expect(read('screens/home.tsx')).toContain('restoreIssueAction(issueKept, navigation.isFocused())');
        expect(read('platform/active-scope.ts')).toContain('await preloadKeptIssue(scope');
    });

    it("opens nothing when a first chat arrives while Home isn't focused (another tab, a page or a sheet)", () => {
        for (const last of SHELL_SCREENS) {
            expect(restoreAction(last, false), last).toBeNull();
        }
    });

    it('keeps exactly one Tabs route even when a tab is opened with a page pushed over the tabs', () => {
        const pushed = root('More', 'MoreItem');
        const after = dispatch(pushed, tabAction('Chats'));
        expect(names(after)).toEqual(['Tabs', 'MoreItem']);
        expect(tab(after)).toBe('Chats');
        // The old way, navigate('Tabs', { screen }), goes to the root stack, which pushes a second tab navigator.
        const old = dispatch(pushed, { type: 'NAVIGATE', payload: { name: 'Tabs', params: { screen: 'More' } } });
        expect(names(old)).toEqual(['Tabs', 'MoreItem', 'Tabs']);
    });

    it('opens Settings on its own page and every other More module on its placeholder, from anywhere in the tabs', () => {
        const settings = dispatch(root('More'), moreItemAction(MODULE_IDS.settings, 'Settings & setup'));
        expect(names(settings)).toEqual(['Tabs', 'Settings']);
        expect(settings.routes[1]!.params).toBeUndefined();
        const approvals = dispatch(root('More'), moreItemAction(MODULE_IDS.approvals, 'Approvals'));
        expect(names(approvals)).toEqual(['Tabs', 'Approvals']);
        const request = dispatch(root('Chats'), approvalAction('a1'));
        expect(names(request)).toEqual(['Tabs', 'Approval']);
        expect(request.routes[1]!.params).toEqual({ id: 'a1' });
        expect(names(dispatch(root('Chats'), approvalsAction()))).toEqual(['Tabs', 'Approvals']);
        // Memories has its own page; the modules still to come keep their placeholder.
        expect(names(dispatch(root('More'), moreItemAction(MODULE_IDS.memories, 'Memories')))).toEqual([
            'Tabs',
            'Memories',
        ]);
        // So do Scheduled & activity and Schedules, and their details push over them.
        for (const [id, page] of [
            [MODULE_IDS.activity, 'Activity'],
            [MODULE_IDS.schedules, 'Schedules'],
        ] as const) {
            expect(names(dispatch(root('More'), moreItemAction(id, page)))).toEqual(['Tabs', page]);
        }
        const task = dispatch(
            dispatch(root('More'), moreItemAction(MODULE_IDS.activity, 'Activity')),
            taskAction('t1'),
        );
        expect(names(task)).toEqual(['Tabs', 'Activity', 'Task']);
        const schedule = dispatch(task, scheduleAction('t1'));
        expect(names(schedule)).toEqual(['Tabs', 'Activity', 'Task', 'Schedule']);
        expect(schedule.routes[3]!.params).toEqual({ scheduleId: 't1' });
        expect(names(dispatch(root('More', 'Schedules'), jobAction('j1')))).toEqual(['Tabs', 'Schedules', 'Job']);
        // So do Learning and Runs, and a run's page pushes over Runs.
        expect(names(dispatch(root('More'), moreItemAction(MODULE_IDS.learning, 'Skills')))).toEqual([
            'Tabs',
            'Learning',
        ]);
        const runs = dispatch(root('Home'), moreItemAction(MODULE_IDS.runs, 'Runs'));
        expect(names(runs)).toEqual(['Tabs', 'Runs']);
        const opened = dispatch(runs, runAction('r1'));
        expect(names(opened)).toEqual(['Tabs', 'Runs', 'Run']);
        expect(opened.routes[2]!.params).toEqual({ runId: 'r1' });
        // More's rows, Search, Home's tiles and the drawer all go through it.
        for (const file of [
            'screens/more.tsx',
            'screens/search.tsx',
            'screens/home-parts.tsx',
            'navigation/shell-drawer.tsx',
        ]) {
            expect(read(file), file).toContain('dispatch(moreItemAction(');
            expect(read(file), file).not.toContain("navigate('MoreItem'");
        }
    });

    it("sends Home's tiles and All chats through tabAction, never navigate('Tabs', { screen })", () => {
        const home = read('screens/home.tsx') + read('screens/home-parts.tsx');
        expect(home).toContain('navigation.dispatch(tabAction(target.name))');
        expect(home).toContain("navigation.dispatch(tabAction('Chats'))");
        expect(home).not.toContain("navigate('Tabs'");
    });
});
