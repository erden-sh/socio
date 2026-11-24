import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MATERIAL_NAVIGATION_BAR } from '../../src/navigation/presets';
import { hidesTabBar, routeTab, staticTabScreens, TAB_ROUTE_NAMES } from '../../src/navigation/routes';
import { handOffAction, isHandOff, redirectSteps, tabPageRedirect } from '../../src/navigation/shell-actions';
import {
    chatAction,
    inOwnTabAction,
    inTabAction,
    restoreChatAction,
    TAB_NAMES,
    tabOfRoot,
    tabRootName,
    tabRootPath,
} from '../../src/navigation/tabs';
import { spacesAttention } from '../../src/shell/inbox';
import { navigationCore } from '../helpers/navigation-core';
import { tabStackTree } from '../helpers/route-tree';

// Each tab's own stack: the pages that live in the tabs, which every
// tab's stack holds, the tab that each one's link opens it in, and how an
// action reaches them from inside a tab and from over the tabs.

const blank = () => null;
const pages = Object.fromEntries(TAB_ROUTE_NAMES.map((name) => [name, blank])) as never;

describe("the tabs' own stacks", () => {
    it('hold a chat and New chat in every tab, linked from the Chats tab alone', () => {
        expect(TAB_ROUTE_NAMES).toEqual(expect.arrayContaining(['Chat', 'NewChat']));
        expect(routeTab('Chat')).toBe('Chats');
        expect(routeTab('NewChat')).toBe('Chats');
        // Sheets, compose page sheets and the page editor stay on the root stack, over the tab bar.
        for (const name of ['FileIssue', 'NewSpace', 'PageEditor', 'TurnTrace', 'Account', 'Tabs', 'SignIn']) {
            expect(routeTab(name), name).toBeNull();
        }
        for (const tab of TAB_NAMES) {
            const screens = staticTabScreens(tab, pages, 'development');
            expect(Object.keys(screens), tab).toEqual(TAB_ROUTE_NAMES);
            expect(screens.Chat.linking, tab).toBe(tab === 'Chats' ? 'chats/:id' : null);
            expect(screens.Chat.options.headerShown, tab).toBe(true);
        }
    });

    it('hold every page of the shell, each linked from its own tab', () => {
        for (const name of ['Board', 'Issue', 'Memories', 'Socio', 'Runs', 'Run']) {
            expect(routeTab(name), name).toBe('Home');
        }
        // The Spaces tab (CB-459): its root is the list; a Space and its pages are its pages.
        for (const name of ['Space', 'SpaceMemory', 'SpaceRadar', 'Page']) {
            expect(routeTab(name), name).toBe('Spaces');
        }
        expect(routeTab('Spaces')).toBeNull();
        for (const name of ['Settings', 'Notifications', 'TechnicalDetails', 'Approvals', 'Approval', 'Unsent']) {
            expect(routeTab(name), name).toBe('More');
        }
        // The page editors open full screen, over the tab bar, as Notes' does.
        expect(routeTab('PageEditor')).toBeNull();
        expect(routeTab('PageReviewEditor')).toBeNull();
    });

    it("open with the tab's root first", () => {
        for (const tab of TAB_NAMES) {
            const tree = tabStackTree(tab);
            expect(tree.config.initialRouteName).toBe(tabRootName(tab));
            expect(Object.keys(tree.config.screens)[0]).toBe(`${tab}Root`);
        }
    });

    it('push a chat in the tab it is opened from', () => {
        const router = navigationCore.StackRouter({ initialRouteName: 'HomeRoot' });
        const routeNames = Object.keys(tabStackTree('Home').config.screens);
        const options = { routeNames, routeParamList: {}, routeGetIdList: {} };
        const home = router.getInitialState(options);
        const next = router.getStateForAction(home, chatAction('c1'), options);
        expect(next?.routes.map((route) => route.name)).toEqual(['HomeRoot', 'Chat']);
        // A tab's name isn't the stack's: it goes up to the tab navigator, which switches.
        expect(router.getStateForAction(home, inTabAction('Chats', 'Chat', { id: 'c1' }), options)).toBeNull();
    });

    it('switch to the Chats tab for a kept chat, over its list (the remembered last screen)', () => {
        expect(restoreChatAction(null, true)).toBeNull();
        expect(restoreChatAction('c1', false)).toBeNull();
        const action = restoreChatAction('c1', true);
        expect(action).toEqual({
            type: 'NAVIGATE',
            payload: { name: 'Chats', params: { screen: 'Chat', params: { id: 'c1' }, initial: false } },
        });
        const router = navigationCore.TabRouter({});
        const options = { routeNames: [...TAB_NAMES], routeParamList: {}, routeGetIdList: {} };
        const tabs = router.getInitialState(options);
        const next = router.getStateForAction(tabs, action!, options);
        const shown = next === null ? undefined : next.routes[next.index ?? 0];
        expect(shown?.name).toBe('Chats');
        expect(shown?.params).toMatchObject({ screen: 'Chat', initial: false });
    });
});

describe('the Spaces tab (CB-459)', () => {
    it('badges the pages changed elsewhere, one per page', () => {
        const conflict = (id: string, pageId: string) => ({ id, pageId }) as never;
        expect(spacesAttention([])).toBe(0);
        expect(spacesAttention([conflict('w1', 'p1'), conflict('w2', 'p1'), conflict('w3', 'p2')])).toBe(2);
    });

    it('names the list as /spaces for presence, from its root', () => {
        expect(tabOfRoot('SpacesRoot')).toBe('Spaces');
        expect(tabOfRoot('Spaces')).toBeNull();
        expect(tabRootPath('Spaces')).toBe('spaces');
        expect(tabRootPath('Chats')).toBeNull();
    });
});

describe("a tab's page over the tab bar", () => {
    const stack = readFileSync(join(import.meta.dirname, '../../src/navigation/tab-stack.tsx'), 'utf8');

    it('counts the tab bar in its bottom safe area; the root and the pages that hide the bar keep the window’s', () => {
        expect(stack).toMatch(
            /props\.route\.name === tabRootName\(tab\) \|\| hidesTabBar\(props\.route\.name\) \? \(\s*<ScreenBoundary \{\.\.\.props\} \/>\s*\) : \(\s*<TabPageInsets>/,
        );
        // iOS: a provider of the page's own, which UIKit's safe area (tab bar included) measures.
        expect(stack).toContain('return <SafeAreaProvider>{props.children}</SafeAreaProvider>;');
        // Android: Material's navigation bar lies over the page, edge to edge.
        expect(stack).toContain('bottom: insets.bottom + MATERIAL_NAVIGATION_BAR');
        expect(MATERIAL_NAVIGATION_BAR).toBe(80);
    });
});

describe('a chat, a room and New chat hide the tab bar (CB-491)', () => {
    const tabs = readFileSync(join(import.meta.dirname, '../../src/navigation/shell-tabs.tsx'), 'utf8');

    it('names the pages that hide it: a chat (rooms too) and New chat, never a tab root or another page', () => {
        expect(hidesTabBar('Chat')).toBe(true);
        expect(hidesTabBar('NewChat')).toBe(true);
        expect(hidesTabBar(undefined)).toBe(false);
        for (const tab of TAB_NAMES) {
            expect(hidesTabBar(tabRootName(tab)), tab).toBe(false);
        }
        for (const name of TAB_ROUTE_NAMES.filter((name) => name !== 'Chat' && name !== 'NewChat')) {
            expect(hidesTabBar(name), name).toBe(false);
        }
        expect(hidesTabBar('toString')).toBe(false);
    });

    it("hides it from every tab's options while that tab's stack shows one, a link's params included", () => {
        expect(tabs).toContain('const hidden = hidesTabBar(getFocusedRouteNameFromRoute(route));');
        expect(tabs).toContain("...(hidden ? { tabBarStyle: { display: 'none' as const } } : {}),");
        for (const tab of TAB_NAMES) {
            expect(tabs, tab).toMatch(new RegExp(`${tab}: tabOptions\\(tabs\\.${tab}, (true|false)\\),`));
        }
        // The badges stay on Chats and Spaces.
        expect(tabs).toContain('Chats: tabOptions(tabs.Chats, true),');
        expect(tabs).toContain('Spaces: tabOptions(tabs.Spaces, true),');
    });

    it('reads a chat from the tab route the way React Navigation does, before and after its stack mounts', () => {
        const focused = (route: object) => navigationCore.getFocusedRouteNameFromRoute(route as never);
        // A link before the Chats stack mounted: NAVIGATE Tabs › Chats { screen: 'Chat', initial: false }.
        const linked = {
            key: 'Chats-1',
            name: 'Chats',
            params: { screen: 'Chat', params: { id: 'c1' }, initial: false },
        };
        expect(hidesTabBar(focused(linked))).toBe(true);
        const pushed = {
            key: 'Home-1',
            name: 'Home',
            state: { index: 1, routes: [{ name: 'HomeRoot' }, { name: 'NewChat' }] },
        };
        expect(hidesTabBar(focused(pushed))).toBe(true);
        // Back to the list: the bar again.
        const back = { ...pushed, state: { index: 0, routes: [{ name: 'HomeRoot' }] } };
        expect(hidesTabBar(focused(back))).toBe(false);
        expect(hidesTabBar(focused({ key: 'More-1', name: 'More' }))).toBe(false);
    });
});

describe("a tab's page opened from over the tabs", () => {
    const stack = (tab: string, names: readonly string[]) => ({
        key: `${tab}-stack`,
        index: 0,
        routeNames: Object.keys(tabStackTree(tab as never).config.screens),
        routes: names.map((name) => ({ name })),
    });
    const root = (top: readonly string[], shown = 1) => ({
        key: 'root',
        index: top.length,
        routeNames: ['Tabs', 'FileIssue', 'RoomInvite', 'Account'],
        routes: [
            {
                name: 'Tabs',
                state: {
                    key: 'tabs',
                    index: shown,
                    routeNames: [...TAB_NAMES],
                    routes: [
                        { name: 'Home', state: stack('Home', ['HomeRoot']) },
                        { name: 'Chats', state: stack('Chats', ['ChatsRoot']) },
                        { name: 'More' },
                        { name: 'Search' },
                    ],
                },
            },
            ...top.map((name) => ({ name })),
        ],
    });

    it('closes the sheet, then pushes the page in the tab the person is in', () => {
        expect(tabPageRedirect(chatAction('r1'), root(['RoomInvite'], 0))).toEqual([
            handOffAction('root'),
            { type: 'NAVIGATE', payload: { name: 'Chat', params: { id: 'r1' } }, target: 'Home-stack' },
        ]);
        // Nothing over the tabs: the push alone.
        expect(tabPageRedirect(chatAction('r1'), root([], 1))).toEqual([
            { type: 'NAVIGATE', payload: { name: 'Chat', params: { id: 'r1' } }, target: 'Chats-stack' },
        ]);
    });

    it("turns a compose sheet's replace into a push, which its draft question lets pass", () => {
        const steps = tabPageRedirect(
            { type: 'REPLACE', payload: { name: 'Chat', params: { id: 'c2' } } },
            root(['FileIssue']),
        );
        expect(steps[0]).toEqual(handOffAction('root'));
        expect(isHandOff(steps[0]!)).toBe(true);
        expect(isHandOff({ type: 'POP_TO', payload: { name: 'Tabs' } })).toBe(false);
        expect(isHandOff({ type: 'GO_BACK' })).toBe(false);
        expect(steps[1]).toEqual({
            type: 'PUSH',
            payload: { name: 'Chat', params: { id: 'c2' } },
            target: 'Chats-stack',
        });
    });

    it('opens a filed issue in the tab under File an issue, in place of the sheet', () => {
        const steps = tabPageRedirect(
            { type: 'REPLACE', payload: { name: 'Issue', params: { key: 'pending-issue-1' } } },
            root(['FileIssue'], 0),
        );
        expect(steps).toEqual([
            handOffAction('root'),
            { type: 'PUSH', payload: { name: 'Issue', params: { key: 'pending-issue-1' } }, target: 'Home-stack' },
        ]);
    });

    it('opens a page in the tab its action names, whichever tab shows (New room’s room, in Chats)', () => {
        const action = inOwnTabAction('Chats', 'Chat', { id: 'r7' });
        expect(action).toEqual({ type: 'REPLACE', payload: { name: 'Chat', params: { id: 'r7' }, tab: 'Chats' } });
        // Over Home: the sheet goes, then Chats shows the room over its list.
        expect(tabPageRedirect(action, root(['NewRoom'], 0))).toEqual([
            handOffAction('root'),
            {
                type: 'NAVIGATE',
                payload: { name: 'Chats', params: { screen: 'Chat', params: { id: 'r7' }, initial: false } },
                target: 'tabs',
            },
        ]);
        // Over Chats: pushed in its own stack.
        expect(tabPageRedirect(action, root(['NewRoom'], 1))).toEqual([
            handOffAction('root'),
            { type: 'PUSH', payload: { name: 'Chat', params: { id: 'r7' } }, target: 'Chats-stack' },
        ]);
    });

    it('on Android, pushes the page a frame after the sheet goes, never in the same commit (CB-470)', () => {
        const steps = tabPageRedirect(inOwnTabAction('Chats', 'Chat', { id: 'r7' }), root(['NewRoom'], 1));
        expect(redirectSteps(steps, 'android')).toEqual({ now: [steps[0]], later: [steps[1]] });
        expect(redirectSteps(steps, 'ios')).toEqual({ now: steps, later: [] });
        // Nothing over the tabs: the push alone, at once.
        const alone = tabPageRedirect(chatAction('r1'), root([], 1));
        expect(redirectSteps(alone, 'android')).toEqual({ now: alone, later: [] });
        const navigation = readFileSync(join(import.meta.dirname, '../../src/navigation/root-navigation.tsx'), 'utf8');
        expect(navigation).toContain('const { now, later } = redirectSteps(steps, Platform.OS);');
        expect(navigation).toMatch(/requestAnimationFrame\(\(\) => \{\s+for \(const step of later\)/);
    });

    it("opens it in its own tab when the tab that shows hasn't mounted its stack", () => {
        expect(tabPageRedirect(chatAction('c3'), root(['Account'], 2))).toEqual([
            handOffAction('root'),
            {
                type: 'NAVIGATE',
                payload: { name: 'Chats', params: { screen: 'Chat', params: { id: 'c3' }, initial: false } },
                target: 'tabs',
            },
        ]);
    });

    it('leaves alone what names no tab page, and anything while the gate shows no tabs', () => {
        expect(tabPageRedirect({ type: 'NAVIGATE', payload: { name: 'Nowhere' } }, root([]))).toEqual([]);
        expect(tabPageRedirect({ type: 'GO_BACK' }, root([]))).toEqual([]);
        expect(tabPageRedirect({ type: 'SET_PARAMS', payload: { name: 'Chat' } }, root([]))).toEqual([]);
        expect(tabPageRedirect(chatAction('c1'), undefined)).toEqual([]);
        expect(
            tabPageRedirect(chatAction('c1'), {
                key: 'root',
                index: 0,
                routeNames: ['Lock'],
                routes: [{ name: 'Lock' }],
            }),
        ).toEqual([]);
    });
});
