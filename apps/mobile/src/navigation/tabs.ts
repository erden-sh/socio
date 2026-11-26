import type { NativeBottomTabIcon } from '@react-navigation/bottom-tabs/unstable';
import type { ParamListBase, PathConfig, StaticNavigation } from '@react-navigation/native';
import type { ComponentType } from 'react';

import { MODULE_IDS, type ModuleId } from '@socio/shared/modules';
import { normalizeRole } from '@socio/shared/roles';
import type { Role } from '@socio/shared/types';

import { issueParam, type ShellScreen } from '../shell/last-screen';
import type { MediaFileParams } from '../shell/media';
import { moduleEntry, moduleNavLabel } from '../shell/modules';

// The tab table (the owner's 2026-11-08 choice, modelled on Slack's
// iOS app): the system's own tab bar, React Navigation's native bottom tabs
// (shell-tabs.tsx) on react-native-screens' Tabs, the root stack's first shell
// route (`Tabs`, routes.ts). iOS 26 draws it in Liquid Glass with Search as its
// separate glass button; Android draws Material bottom navigation. Each tab has
// its own stack (tab-stack.tsx): its root, then the pages pushed inside it
// with the tab bar still under them. Each tab says:
// - its label;
// - its icon: an SF Symbol on iOS (the system tab bar draws it in its glass;
//   the outline one, filled when selected), and on Android lucide's icon, which
//   plugins/tab-icons.ts writes as a vector drawable named `tab_<icon>` (the
//   native tab bar takes images, not SVG components);
// - its link path, the web's, or none (the web has no Chats, More or Search
//   path); the pages of its stack bring their own (routes.ts `tab`);
// - its testID, for Maestro.
// No tab is called "Activity": in Socio that means scheduled tasks. There is
// no Inbox tab (CB-455, the owner, 2026-11-19): what it held is at the top of
// Chats, and the Chats tab's badge counts it; a kept "Inbox" opens Chats
// (`TAB_REDIRECTS`, last-screen.ts). Its slot went to Spaces (CB-459, the
// owner, 2026-11-20): the Spaces list is that tab's root, and a Space and its
// pages open in its stack; its badge counts the pages changed elsewhere.
// No React Native here, so tests/navigation runs the table under Node.

export interface TabSpec {
    readonly label: string;
    /** The SF Symbol on iOS, and its filled form for the selected tab; none for Search, the system's. */
    readonly sfSymbol: { readonly normal: string; readonly selected: string } | null;
    /** lucide's icon (kebab case) on Android, as plugins/tab-icons.ts writes it. */
    readonly lucide: string;
    readonly linking?: string;
    /**
     * Its root's link path (the Spaces list's `spaces`, CB-459): on the root, not the tab, since the
     * pages of the tab's stack bring their own whole paths (`spaces/:spaceId`), which a tab's path
     * would prefix.
     */
    readonly rootPath?: string;
    readonly testID: string;
    /** Search: iOS 26 draws it as the separate glass button. */
    readonly search?: true;
}

export const TABS = {
    // Home: the workspace's header, its tiles and its sections. Its link is the web's root.
    Home: {
        label: 'Home',
        sfSymbol: { normal: 'house', selected: 'house.fill' },
        lucide: 'house',
        linking: '',
        testID: 'tab-home',
    },
    Chats: {
        label: 'Chats',
        sfSymbol: { normal: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' },
        lucide: 'message-circle',
        testID: 'tab-chats',
    },
    // Spaces (CB-459): the list of Spaces at the web's path, its root; a Space and its pages push inside it.
    Spaces: {
        label: 'Spaces',
        sfSymbol: { normal: 'folder', selected: 'folder.fill' },
        lucide: 'folder',
        rootPath: 'spaces',
        testID: 'tab-spaces',
    },
    More: {
        label: 'More',
        sfSymbol: { normal: 'ellipsis', selected: 'ellipsis' },
        lucide: 'ellipsis',
        testID: 'tab-more',
    },
    Search: { label: 'Search', sfSymbol: null, lucide: 'search', testID: 'tab-search', search: true },
} as const satisfies Record<string, TabSpec>;

export type TabName = keyof typeof TABS;

export const TAB_NAMES = Object.keys(TABS) as TabName[];

/** A tab's root route's name in its own stack (tab-stack.tsx): `ChatsRoot`. */
export const tabRootName = <Tab extends TabName>(tab: Tab) => `${tab}Root` as const;

/** The tab whose root `route` names (`SpacesRoot`), or null. */
export const tabOfRoot = (route: string): TabName | null => {
    const tab = route.endsWith('Root') ? route.slice(0, -'Root'.length) : '';
    return isTabName(tab) ? tab : null;
};

/** A tab root's link path (`TabSpec.rootPath`), or null. */
export const tabRootPath = (tab: TabName): string | null => (TABS[tab] as TabSpec).rootPath ?? null;

/**
 * A tab's link config: its own path, if any, and its root as the stack's first screen, so a link to
 * one of its pages opens over the root (Back goes to the list) even before the tab ever showed.
 */
export const tabLinking = (name: TabName): { readonly path?: string; readonly initialRouteName: string } => {
    const tab: TabSpec = TABS[name];
    return tab.linking === undefined
        ? { initialRouteName: tabRootName(name) }
        : { path: tab.linking, initialRouteName: tabRootName(name) };
};

export const isTabName = (value: unknown): value is TabName =>
    typeof value === 'string' && (TAB_NAMES as readonly string[]).includes(value);

/** Tabs that are gone, and the tab that holds what they did (CB-455: the Inbox is the top of Chats). */
export const TAB_REDIRECTS = { Inbox: 'Chats' } as const satisfies Record<string, TabName>;

/**
 * The Chats and Spaces tabs' badges ride on their routes' params (`attention`, a count): the shell's
 * TabBadge (shell-tabs.tsx) sets each from the open workspace, since a tab's options can't read the
 * live store, and a tab mounts only once it is opened.
 */
export const ATTENTION_PARAM = 'attention';

/** The tabs with a badge: Chats (CB-455, what needs attention) and Spaces (CB-459, pages changed elsewhere). */
export const BADGED_TABS = ['Chats', 'Spaces'] as const satisfies readonly TabName[];

/** A badged tab's badge for its route's params: the count (`99+` past 99), none at 0. */
export function tabBadge(params: object | undefined): string | undefined {
    const count = (params as Record<string, unknown> | undefined)?.[ATTENTION_PARAM];
    return typeof count !== 'number' || count <= 0 ? undefined : count > 99 ? '99+' : String(count);
}

/** The lucide icons the Android tab bar draws, for plugins/tab-icons.ts (app.config.ts). */
export const TAB_LUCIDE_ICONS = TAB_NAMES.map((name) => TABS[name].lucide);

/**
 * What More holds, in order: Approvals, Scheduled & activity and
 * Schedules (both, as the web shows them), Memories, Media (CB-558), Learning
 * (Skills for members), Runs and Settings.
 */
export const MORE_ITEMS = [
    MODULE_IDS.approvals,
    MODULE_IDS.activity,
    MODULE_IDS.schedules,
    MODULE_IDS.memories,
    MODULE_IDS.media,
    MODULE_IDS.learning,
    MODULE_IDS.runs,
    MODULE_IDS.settings,
] as const satisfies readonly ModuleId[];

export type MoreItem = (typeof MORE_ITEMS)[number];

export const isMoreItem = (value: unknown): value is MoreItem =>
    typeof value === 'string' && (MORE_ITEMS as readonly string[]).includes(value);

/** A More row: its module's navigation label for the person's role, icon and tone. */
export function moreRows(role: Role | null | undefined) {
    // An older server may still send the retired `operator` role (CB-390).
    const admin = normalizeRole(role) === 'admin';
    return MORE_ITEMS.map((id) => {
        const entry = moduleEntry(id);
        return { id, label: moduleNavLabel(entry, admin), icon: entry.icon, tone: entry.tone };
    });
}

/** A tab's icon as the native tab navigator takes it: an SF Symbol on iOS, a drawable on Android. */
export type NativeTabIcon = NativeBottomTabIcon;

/** The drawable plugins/tab-icons.ts writes for lucide icon `name`. */
export const tabDrawable = (name: string) => `tab_${name.replace(/-/g, '_')}`;

/** Tab `name`'s icon on `os`, selected or not; undefined for Search on iOS, whose icon is the system's. */
export function tabIcon(name: TabName, os: string, focused: boolean): NativeTabIcon | undefined {
    const tab: TabSpec = TABS[name];
    if (os === 'ios') {
        return tab.sfSymbol === null
            ? undefined
            : ({
                  type: 'sfSymbol',
                  name: focused ? tab.sfSymbol.selected : tab.sfSymbol.normal,
              } as NativeTabIcon);
    }
    return { type: 'image', source: { uri: tabDrawable(tab.lucide) } };
}

/** What the native tab navigator's static API gets for each tab. */
export interface StaticTab<Screen> {
    readonly screen: Screen;
    readonly linking: PathConfig<ParamListBase>;
    readonly options: {
        readonly title: string;
        readonly tabBarButtonTestID: string;
        /** None for Search on iOS, whose icon is the system item's. */
        readonly tabBarIcon?: (props: { focused: boolean }) => NativeTabIcon;
        /**
         * Search's system item on iOS: the system's magnifying glass and localized label on every iOS,
         * where the search role (iOS 26.1 and later) would leave iOS 18 and 26.0 with no icon.
         */
        readonly tabBarSystemItem?: 'search';
        /** Search's role on iOS (the separate glass button); Android has no such role, so none there. */
        readonly tabBarRole?: 'search';
        /**
         * With the search role: iOS 27 draws Search as the separate glass button only with this on (iOS
         * 26 always does). It would focus a native header search bar; Search draws its own field, so
         * nothing else changes.
         */
        readonly tabBarSearchAutoFocus?: true;
    };
}

/** The tab navigator's `screens`, from the table and each tab's component (shell-tabs.tsx), for `os`. */
export function staticTabs<
    // oxlint-disable-next-line typescript/no-explicit-any -- the static API's own type for a nested navigator (a tab's stack)
    const Components extends { readonly [Name in TabName]: ComponentType<never> | StaticNavigation<any, any, any> },
>(components: Components, os: string): { readonly [Name in TabName]: StaticTab<Components[Name]> } {
    const screens: Partial<Record<TabName, StaticTab<Components[TabName]>>> = {};
    for (const name of TAB_NAMES) {
        const tab: TabSpec = TABS[name];
        const systemIcon = tabIcon(name, os, false) === undefined;
        screens[name] = {
            screen: components[name],
            linking: tabLinking(name),
            options: {
                title: tab.label,
                tabBarButtonTestID: tab.testID,
                ...(systemIcon ? {} : { tabBarIcon: ({ focused }) => tabIcon(name, os, focused) as NativeTabIcon }),
                ...(tab.search === true && os === 'ios'
                    ? {
                          tabBarSystemItem: 'search' as const,
                          tabBarRole: 'search' as const,
                          tabBarSearchAutoFocus: true as const,
                      }
                    : {}),
            },
        };
    }
    return screens as { readonly [Name in TabName]: StaticTab<Components[Name]> };
}

/** The pages Home's tiles push (routes.ts), and the Spaces tab, which its tile switches to (CB-459). */
export type ShellPage = 'Spaces' | 'Board' | 'Memories' | 'Activity' | 'Schedules' | 'Learning' | 'Runs' | 'Media';

/**
 * The action that goes to a tab or a shell page from inside the tabs. The
 * stack of the tab it is dispatched in pushes a page it has; a tab's name
 * goes up to the tab navigator, which switches to it. Never
 * `navigate('Tabs', { screen })`: the root stack reuses `Tabs` only while it is
 * the focused route, so with a sheet over the tabs it would push a second tab
 * navigator.
 */
export const tabAction = (name: TabName | ShellPage) => ({ type: 'NAVIGATE', payload: { name } }) as const;

/**
 * A More module's page, pushed in the tab it is opened from: Settings' own route, the approvals
 * list's, Memories', Scheduled & activity's and Schedules', Learning's, Runs' and Media's, else the
 * module's placeholder.
 */
export const moreItemAction = (id: MoreItem, label: string) => {
    const page = MORE_PAGES[id];
    return page === undefined
        ? ({ type: 'NAVIGATE', payload: { name: 'MoreItem', params: { id, label } } } as const)
        : ({ type: 'NAVIGATE', payload: { name: page } } as const);
};

const MORE_PAGES: Partial<Record<MoreItem, 'Settings' | 'Approvals' | ShellPage>> = {
    [MODULE_IDS.settings]: 'Settings',
    [MODULE_IDS.approvals]: 'Approvals',
    [MODULE_IDS.memories]: 'Memories',
    [MODULE_IDS.activity]: 'Activity',
    [MODULE_IDS.schedules]: 'Schedules',
    [MODULE_IDS.learning]: 'Learning',
    [MODULE_IDS.runs]: 'Runs',
    [MODULE_IDS.media]: 'Media',
};

/** A Media folder (CB-558), pushed over the one it is in, so Back is the way up. */
export const mediaFolderAction = (folder: string) =>
    ({ type: 'PUSH', payload: { name: 'Media', params: { folder } } }) as const;

/**
 * A file's page in Media (CB-558), pushed in the tab it is opened from: by library item, by chat
 * attachment (a file chip in a chat or room) or by issue attachment, with what the caller knows of
 * the file so the page draws at once.
 */
export const mediaFileAction = (params: MediaFileParams) =>
    ({ type: 'PUSH', payload: { name: 'MediaFile', params } }) as const;

/** A schedule's page, pushed from Schedules, a task's detail and links; PUSH, so Back returns. */
export const scheduleAction = (scheduleId: string) =>
    ({ type: 'PUSH', payload: { name: 'Schedule', params: { scheduleId } } }) as const;
/** A scheduled task's detail, from Scheduled & activity. */
export const taskAction = (taskId: string) =>
    ({ type: 'NAVIGATE', payload: { name: 'Task', params: { taskId } } }) as const;
/** A run's page, from Runs: the tap that reads its trace. */
export const runAction = (runId: string) =>
    ({ type: 'NAVIGATE', payload: { name: 'Run', params: { runId } } }) as const;
/** A job's detail, from Schedules' Jobs. */
export const jobAction = (jobId: string) =>
    ({ type: 'NAVIGATE', payload: { name: 'Job', params: { jobId } } }) as const;

/** The approvals list, or one request's page, pushed in the tab it is opened from. */
export const approvalsAction = () => ({ type: 'NAVIGATE', payload: { name: 'Approvals' } }) as const;
export const approvalAction = (id: string) =>
    ({ type: 'NAVIGATE', payload: { name: 'Approval', params: { id } } }) as const;

/**
 * What Home does with the kept last screen as its lists mount: open it, only
 * while Home is the focused screen (its tab, and `Tabs` on the root stack).
 * Home's lists also mount when a first chat arrives, maybe while the person is
 * on another tab, a page or a sheet: then nothing moves them.
 */
export function restoreAction(last: ShellScreen, homeFocused: boolean) {
    return homeFocused && last !== 'Home' ? tabAction(last) : null;
}

/** A chat (the Chat route), pushed in the tab it is opened from: the chat list, Home or Search. */
export const chatAction = (id: string) => ({ type: 'NAVIGATE', payload: { name: 'Chat', params: { id } } }) as const;

/**
 * A page opened in `tab`'s own stack from a sheet over the tabs, in the sheet's place (a
 * REPLACE, which a compose sheet's draft question lets pass): `tabPageRedirect` closes the sheet
 * and pushes the page in that tab, whichever tab shows. New room's Create opens the room in Chats
 * (CB-470).
 */
export const inOwnTabAction = (tab: TabName, name: string, params?: object) =>
    ({ type: 'REPLACE', payload: { name, params, tab } }) as const;

/** New chat with a socio (the `NewChat` route), pushed in the tab it is opened from, Home or Chats. */
export const newChatAction = (socioId: string) =>
    ({ type: 'NAVIGATE', payload: { name: 'NewChat', params: { socioId } } }) as const;

/** A socio's page (the `Socio` route, CB-431), pushed in Home from its row there. */
export const socioAction = (socioId: string) =>
    ({ type: 'NAVIGATE', payload: { name: 'Socio', params: { socioId } } }) as const;

/** A Space's library, pushed in the tab it is opened from: the Spaces, Search and links. */
export const spaceAction = (spaceId: string) =>
    ({ type: 'NAVIGATE', payload: { name: 'Space', params: { spaceId } } }) as const;

/**
 * A route opened in `tab`'s own stack, over its root (`initial: false`), from anywhere inside the
 * tabs: the name goes up to the tab navigator, which switches to the tab and pushes the page there.
 */
export const inTabAction = (tab: TabName, name: string, params?: object) =>
    ({
        type: 'NAVIGATE',
        payload: { name: tab, params: { screen: name, params, initial: false } },
    }) as const;

/**
 * Home opening a kept Space (`keptSpace`), by restoreAction's rule: only while Home is focused. It
 * opens in the Spaces tab, over its list, where its link would (CB-459).
 */
export function restoreSpaceAction(spaceId: string | null, homeFocused: boolean) {
    return homeFocused && spaceId !== null ? inTabAction('Spaces', 'Space', { spaceId }) : null;
}

/**
 * A page, pushed in the tab's stack from its Space's library, another
 * page's links and links: always a new screen (PUSH), so Back from a page
 * opened from another page returns to that one; NAVIGATE would put the new
 * params on the page already showing.
 */
export const pageAction = (spaceId: string, pageId: string) =>
    ({ type: 'PUSH', payload: { name: 'Page', params: { spaceId, pageId } } }) as const;

/** A dataset (CB-469), pushed from its Space's tree or the Private group (`spaceId` null). */
export const datasetAction = (datasetId: string, spaceId: string | null) =>
    ({
        type: 'PUSH',
        payload: { name: 'Dataset', params: spaceId === null ? { datasetId } : { datasetId, spaceId } },
    }) as const;

/** One view of a dataset's table (CB-469); `preview` reads the shared fixtures (the dev preview). */
export const datasetViewAction = (params: {
    datasetId: string;
    table: string;
    viewId?: string;
    spaceId?: string;
    preview?: boolean;
    mode?: 'day' | 'week' | 'month' | 'agenda';
    day?: string;
}) => ({ type: 'PUSH', payload: { name: 'DatasetView', params } }) as const;

/** A dataset table's field settings (CB-469), from a view's ⋯; `preview` reads the fixtures. */
export const datasetFieldsAction = (params: { datasetId: string; table: string; preview?: boolean }) =>
    ({ type: 'PUSH', payload: { name: 'DatasetFields', params } }) as const;

/** One field's settings, from the field settings' list. */
export const datasetFieldAction = (params: { datasetId: string; table: string; field: string; preview?: boolean }) =>
    ({ type: 'PUSH', payload: { name: 'DatasetField', params } }) as const;

/** New row (CB-469), a form over a view's fields, from the view's ⋯. */
export const datasetNewRowAction = (params: { datasetId: string; table: string; viewId: string; preview?: boolean }) =>
    ({ type: 'PUSH', payload: { name: 'DatasetNewRow', params } }) as const;

/** The page editor, pushed from a page's Edit. */
export const pageEditorAction = (spaceId: string, pageId: string) =>
    ({ type: 'PUSH', payload: { name: 'PageEditor', params: { spaceId, pageId } } }) as const;

/** Home opening a kept page (`keptPage`) in the Spaces tab, by restoreAction's rule: only while Home is focused. */
export function restorePageAction(page: { spaceId: string; pageId: string } | null, homeFocused: boolean) {
    return homeFocused && page !== null ? inTabAction('Spaces', 'Page', page) : null;
}

/**
 * An issue, pushed in the tab's stack from the Board, Search, chips,
 * another issue's links and notifications: always a new screen (PUSH), so Back
 * from a linked issue returns to the one it was opened from. `key` is the
 * issue's as the store keys it (its number, or a local key): the route says
 * `CB-12`, as the web's path does.
 */
export const issueAction = (key: string) =>
    ({ type: 'PUSH', payload: { name: 'Issue', params: { key: issueParam(key) } } }) as const;

/** Home opening a kept issue (`keptIssue`) over itself, by restoreAction's rule: only while Home is focused. */
export function restoreIssueAction(key: string | null, homeFocused: boolean) {
    return homeFocused && key !== null ? issueAction(key) : null;
}

/**
 * Home opening a kept chat (`keptChat`), by restoreAction's rule: only while Home is focused. It
 * opens in the Chats tab, where its link would, with the chat list under it.
 */
export function restoreChatAction(id: string | null, homeFocused: boolean) {
    return homeFocused && id !== null ? inTabAction('Chats', 'Chat', { id }) : null;
}
