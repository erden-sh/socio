import type { ParamListBase, PathConfig, StaticNavigation } from '@react-navigation/native';
import type { ComponentType } from 'react';

import type { VariantName } from '../../variant';

import { immersive, onPlatform, page, pageSheet, type Preset, sheet } from './presets';
import { type RootGate, rootState, type RootStateSource, useRootGate } from './root-gate';
import type { TabName } from './tabs';

// The route table: every screen of the app,
// with its component in root-stack.tsx, or tab-screens.tsx for a route in the
// tabs. A route either sits on the root stack (the tabs themselves, sheets,
// compose page sheets, the page editor, the gate's screens) or, with `tab`,
// in every tab's own stack (tab-stack.tsx): pushed inside the tab the
// person is in, with the tab bar under it, as Music's, Mail's and the App
// Store's pages are. Each route says:
// - which gate states show it (root-gate.ts). A state opens on the first route
//   here that it shows: React Navigation falls back to its first screen when
//   the gate changes the screens it has.
// - its link path after the scheme, the web's (`chats/:id`), or none. Workspace
//   content belongs to the shell alone, never to the locked state.
// - its preset (presets.ts).
// - `tab`, for a page that lives in the tabs' stacks: the tab its link path
//   opens it in (only that tab's copy has the path; the others push it
//   without one).
// - `hidesTabBar`, for a tab page that hides the tab bar while it shows (a
//   chat or a room, and New chat: CB-491).
// - the variants that have it, when not all three do. A route a build's variant
//   lacks isn't in its root stack at all: no screen, no link path.
// No React Native here, so the Node tests read the table as the app does.

export interface RouteSpec {
    readonly gates: readonly RootGate[];
    readonly linking?: string | PathConfig<ParamListBase>;
    readonly preset: Preset;
    /**
     * A page pushed inside the tabs: every tab's stack has it, and its link opens it in this
     * tab. Absent: the root stack, over the tabs (sheets, compose, the editor, the gate's screens).
     */
    readonly tab?: TabName;
    /**
     * A tab page that hides the tab bar while it shows (CB-491: a chat or a room, and New chat), as
     * Messages' and Slack's conversations do: Back is the way out, and the composer gets the room.
     */
    readonly hidesTabBar?: true;
    /** The variants whose builds have the route; every variant when absent. */
    readonly variants?: readonly VariantName[];
}

export const ROUTES = {
    // The shell: the native tabs (tabs.ts) are its root, holding
    // Home, Chats, More and Search. Home's path is the tabs' own (tabs.ts),
    // under this route's empty one. Pages push inside each tab's own stack.
    Tabs: { gates: ['shell'], linking: '', preset: page({ header: false }) },
    // The Board, pushed from Home's tile and Search, at the web's path, with a large title (CB-420)
    // the screen names and fills in (native-bar.tsx): New issue, Select. The Spaces list is the Spaces
    // tab's root (CB-459, tabs.ts).
    Board: { gates: ['shell'], linking: 'issues', preset: page({ header: 'large' }), tab: 'Home' },
    // An issue, pushed from the Board, Search, issue chips, another
    // issue's links and notifications, at the web's path (`CB-12`, or an issue
    // filed offline by its local key). Its inline title is its key.
    Issue: { gates: ['shell'], linking: 'issues/:key', preset: page(), tab: 'Home' },
    // Filing an issue, from the Board's New issue, a failed run's "File
    // issue" (`runId`) and a refused filing's Edit (`edit`, its local key): a
    // page sheet with its own Cancel and File (a swipe down asks first while
    // it holds a draft, CB-421), with no path (the web's is a dialog).
    FileIssue: { gates: ['shell'], preset: pageSheet() },
    // New Space (CB-410), from the Spaces list's New Space: a page sheet with its
    // own Cancel and Create (a swipe down asks first once something is typed,
    // CB-421), with no path (the web's is a dialog). Online only.
    NewSpace: { gates: ['shell'], preset: pageSheet() },
    // New room (CB-470), from the Chats tab's compose menu and Home's Rooms: a page sheet
    // with its own Cancel and Create (a swipe down asks first once something is chosen),
    // with no path (the web's is a dialog). Online only; the room opens in Chats.
    NewRoom: { gates: ['shell'], preset: pageSheet() },
    // Memories, from More, Home's tile and Search, at the web's path: a
    // large title, with Add in the bar.
    Memories: { gates: ['shell'], linking: 'memories', preset: page({ header: 'large' }), tab: 'Home' },
    // Scheduled & activity and Schedules & jobs, from More, Home's
    // Scheduled tile and Search, at the web's paths, and a schedule's page at
    // its web path. A task's and a job's detail are the app's own pages, with
    // no path (the web shows them in place). The lists take a large title, the details an inline one.
    Activity: { gates: ['shell'], linking: 'activity', preset: page({ header: 'large' }), tab: 'Home' },
    Schedules: { gates: ['shell'], linking: 'schedules', preset: page({ header: 'large' }), tab: 'Home' },
    Schedule: { gates: ['shell'], linking: 'schedules/:scheduleId', preset: page(), tab: 'Home' },
    Task: { gates: ['shell'], preset: page(), tab: 'Home' },
    Job: { gates: ['shell'], preset: page(), tab: 'Home' },
    // Learning ("Skills" for members) and Runs, from More, Home and
    // Search, at the web's paths; a run's page is the app's own, with no path
    // (the web opens a trace in place), so no link opens a trace untapped.
    Learning: { gates: ['shell'], linking: 'learning', preset: page({ header: 'large' }), tab: 'Home' },
    Runs: { gates: ['shell'], linking: 'runs', preset: page({ header: 'large' }), tab: 'Home' },
    Run: { gates: ['shell'], preset: page(), tab: 'Home' },
    // A Space's library, pushed from the Spaces, Search and links at
    // the web's path. Its large title is its Space's name, with the Keep offline
    // toggle in the bar.
    Space: { gates: ['shell'], linking: 'spaces/:spaceId', preset: page({ header: 'large' }), tab: 'Spaces' },
    // A Space's memory and radar, read-only, at the web's paths: the
    // Space's screen opened on that tab, which then switches in place.
    SpaceMemory: {
        gates: ['shell'],
        linking: 'spaces/:spaceId/memory',
        preset: page({ header: 'large' }),
        tab: 'Spaces',
    },
    SpaceRadar: {
        gates: ['shell'],
        linking: 'spaces/:spaceId/radar',
        preset: page({ header: 'large' }),
        tab: 'Spaces',
    },
    // A page, pushed from its Space's library, another page's links and
    // links from outside, at the web's path: an inline bar whose title comes in
    // as the page's own scrolls under it (Notes and Files), Edit in the bar.
    Page: { gates: ['shell'], linking: 'spaces/:spaceId/pages/:pageId', preset: page(), tab: 'Spaces' },
    // A dataset (CB-469, CB-451), pushed from its Space's tree and the Private group at
    // the web's path: its tables, then each table's views. `spaceId` names the Space it was opened
    // in (none for Private), so the phone finds the item it holds. A large title, its name.
    Dataset: {
        gates: ['shell'],
        linking: 'data/datasets/:datasetId',
        preset: page({ header: 'large' }),
        tab: 'Spaces',
    },
    // One view of a dataset's table (CB-469), pushed from the dataset's tables (and the dev
    // preview): its layout, the Views and Filter-and-sort sheets, the record sheet. No path yet: the
    // web opens views inside the dataset's page.
    DatasetView: { gates: ['shell'], preset: page(), tab: 'Spaces' },
    // A table's field settings (CB-469, CB-451), from a view's ⋯: every field with its
    // kind, and one field's kind, name and settings for people who may change them. No path: the web
    // edits them in the view's Fields panel.
    DatasetFields: { gates: ['shell'], preset: page({ header: 'large' }), tab: 'Spaces' },
    DatasetField: { gates: ['shell'], preset: page(), tab: 'Spaces' },
    // New row (CB-469), a native form over the view's fields, from a view's ⋯. No path.
    DatasetNewRow: { gates: ['shell'], preset: page(), tab: 'Spaces' },
    // The dataset views' contract fixtures in every layout (CB-469), for development and preview
    // builds only, like Diagnostics: the views open in DatasetView from the shared fixtures.
    DatasetPreview: {
        gates: ['shell'],
        linking: 'dataset-preview',
        preset: page({ header: 'large' }),
        tab: 'Spaces',
        variants: ['development', 'preview'],
    },
    // The page editor, from a page's Edit: no path (the web edits in
    // place), the system's compact bar over its WebView with the save line (CB-417).
    PageEditor: { gates: ['shell'], preset: page({ header: 'native' }) },
    // A chat, pushed in its tab from the chat list, Home and Search,
    // at the web's path, a room's too: one inline bar (CB-420), its title the socio
    // (or the room) with the model as the title's menu, the transcript scrolling under it. It
    // hides the tab bar, as Messages' and Slack's conversations do (CB-491): Back returns to the list.
    Chat: { gates: ['shell'], linking: 'chats/:id', preset: page(), tab: 'Chats', hidesTabBar: true },
    // New chat, from Home's New chat, a
    // socio row's new-chat button and the Chats tab's compose button, at the
    // web's path: the first run's screen with the socio asked for, its own
    // Back at the top. No tab bar under it, as under a chat (CB-491).
    NewChat: {
        gates: ['shell'],
        linking: 'dots/:socioId/new',
        preset: page({ header: false }),
        tab: 'Chats',
        hidesTabBar: true,
    },
    // A socio's page (CB-431; the web's DotHome), from a socio row on Home and links, at the web's
    // path: its head, Start a chat, then its chats, running work, schedules and turns as an inset
    // grouped list; an inline bar the name comes into as it scrolls, with Compose.
    Socio: { gates: ['shell'], linking: 'dots/:socioId', preset: page(), tab: 'Home' },
    // A screen's picker in a native sheet (CB-421, route-sheets.ts): the
    // content is the screen's, handed over by id, with no path. Sheet opens at
    // the medium detent alone (a field's choices, the batch bar's), TallSheet
    // at medium, then large (the Board's Filters, Move, a Space, a diff).
    Sheet: { gates: ['shell'], preset: sheet({ detent: 0.5, expands: false }) },
    TallSheet: { gates: ['shell'], preset: sheet({ detent: 0.5 }) },
    // A chat's model (the web's ModelPicker), from its header's socio bar: a
    // sheet over the chat with no path.
    ChatModel: { gates: ['shell'], preset: sheet({ detent: 0.6 }) },
    // The person's approval requests, from the Inbox and More, at the
    // web's paths: the list (waiting, then recent decisions) and one request (a
    // notice's or Telegram's link), each card the chat's approval card.
    Approvals: {
        gates: ['shell'],
        linking: 'approvals',
        preset: page({ title: 'Approvals', header: 'large' }),
        tab: 'More',
    },
    Approval: { gates: ['shell'], linking: 'approvals/:id', preset: page({ title: 'Approval request' }), tab: 'More' },
    // A turn's trace, from its row in a chat: a sheet over the chat,
    // with no path (the web's trace opens in place).
    TurnTrace: { gates: ['shell'], preset: sheet({ detent: 0.6 }) },
    // A page review, from its card in a chat: the draft with
    // Save and Skip, a sheet over the chat with no path.
    PageReview: { gates: ['shell'], preset: sheet({ detent: 0.85 }) },
    // A page review's editor, from the review sheet's Edit: the page
    // editor on the socio's draft, no path; leaving goes back to the sheet.
    PageReviewEditor: { gates: ['shell'], preset: page({ header: 'native' }) },
    // A room's Members, from its header's socios: read-only, with
    // "Manage on the web"; a sheet over the room with no path.
    RoomMembers: { gates: ['shell'], preset: sheet({ detent: 0.6 }) },
    // A room's menu, from its header's menu button: the reader's
    // notification level, Members and "Open in your browser"; a sheet with no path.
    RoomMenu: { gates: ['shell'], preset: sheet({ detent: 0.6 }) },
    // A room invite, from its row in the Inbox or on Home: what
    // joining shares, then Decline and Join; a sheet with no path.
    RoomInvite: { gates: ['shell'], preset: sheet({ detent: 0.6 }) },
    // An approval request's long details, from its card in a chat:
    // opened (`POST …/open`) and shown whole, so Approve unlocks; a sheet with no path.
    ApprovalDetails: { gates: ['shell'], preset: sheet({ detent: 0.85 }) },
    // A message's or the tray's pictures at full size, from a thumbnail:
    // full-screen media closed by its own button, with no path.
    AttachmentViewer: { gates: ['shell'], preset: immersive() },
    // A More row's module, a placeholder for now, its title its module's.
    MoreItem: { gates: ['shell'], preset: page(), tab: 'More' },
    // The phone's settings, from More and the drawer, at the web's path.
    Settings: {
        gates: ['shell'],
        linking: 'settings',
        preset: page({ title: 'Settings', header: 'large' }),
        tab: 'More',
    },
    // Settings → Notifications, from Settings, at the web's path,
    // which the test notification links to.
    Notifications: {
        gates: ['shell'],
        linking: 'settings/notifications',
        preset: page({ title: 'Notifications' }),
        tab: 'More',
    },
    // Technical details, from Settings while Advanced mode is on:
    // the app's own, so no path (the web has no such page).
    TechnicalDetails: { gates: ['shell'], preset: page({ title: 'Technical details' }), tab: 'More' },
    // The web's account menu is a dialog with no path; so is this sheet.
    Account: { gates: ['shell'], preset: sheet({ detent: 'fit' }) },
    // The notification ask's explanation, over whatever showed when a
    // trigger asked: Allow and Not now, a sheet sized to its words, with no path.
    NotificationAsk: { gates: ['shell'], preset: sheet({ detent: 'fit' }) },
    // Every unsent write, from the Account sheet's "See all" past its
    // first five: a page, its root a ScrollView, with no path (the app's own).
    Unsent: { gates: ['shell'], preset: page({ title: 'Unsent' }), tab: 'More' },
    // The lock screen is a placeholder until its screen lands.
    // Add workspace's first screen: the ways in, and Get the app links (links.ts `openRoute`).
    AddWorkspace: { gates: ['add-workspace'], preset: page({ header: false }) },
    // The workspace's address, typed, from the first screen's third way.
    WorkspaceAddress: { gates: ['add-workspace'], preset: page({ title: '' }) },
    // The workspace the address led to, before signing in.
    ConfirmWorkspace: { gates: ['add-workspace'], preset: page({ title: '' }) },
    // Email and password, then the commit.
    SignIn: { gates: ['add-workspace'], preset: page({ title: '' }) },
    // The sign-in sheet's callback redeemed and committed: from SignIn's Continue, or from
    // the callback's link after a kill (links.ts `openRoute`), never by a path.
    SheetSignIn: { gates: ['add-workspace'], preset: page({ title: '' }) },
    // A sign-in code by email or Telegram: from SignIn's "Email me a code" or "Send a code to
    // my Telegram", or from the code's link after a kill (links.ts `openRoute`), never by a path.
    SignInCode: { gates: ['add-workspace'], preset: page({ title: '' }) },
    // Add a device, on the new device: only from the QR code's link (links.ts `openRoute`),
    // never by a path, so nothing of the link goes into the navigation state.
    AddDevice: { gates: ['add-workspace'], preset: page({ title: '' }) },
    // An invite: only from the invite's link (links.ts `openRoute`), never by a path, so its
    // token goes into no param or navigation state.
    Invite: { gates: ['add-workspace'], preset: page({ title: '' }) },
    Lock: { gates: ['locked'], preset: page({ header: false }) },
    // The store's checks, for development and preview builds only:
    // production never mounts it. A locked copy shows nothing past the lock screen.
    Diagnostics: {
        gates: ['add-workspace', 'shell'],
        linking: 'diagnostics',
        preset: page({ title: 'Diagnostics' }),
        variants: ['development', 'preview'],
    },
    // The page editor's Markdown round trip against the web, in the
    // real WebView: development and preview builds only, like Diagnostics.
    EditorCorpus: {
        gates: ['add-workspace', 'shell'],
        linking: 'editor-corpus',
        preset: page({ title: 'Editor corpus' }),
        variants: ['development', 'preview'],
    },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

export const ROUTE_NAMES = Object.keys(ROUTES) as RouteName[];

/** The routes that live in the tabs' own stacks. */
export type TabRouteName = {
    [Name in RouteName]: (typeof ROUTES)[Name] extends { readonly tab: TabName } ? Name : never;
}[RouteName];

/** The routes of the root stack: the tabs, and what shows over them. */
export type RootRouteName = Exclude<RouteName, TabRouteName>;

const spec = (name: RouteName): RouteSpec => ROUTES[name];

/** The tab whose stack a route's link opens it in, or null for a root stack route. */
export const routeTab = (name: string): TabName | null =>
    (ROUTES as Record<string, RouteSpec | undefined>)[name]?.tab ?? null;

/**
 * Whether the tab bar hides while `name` is the page a tab's stack shows (CB-491): a chat or a room,
 * and New chat. A tab's root, or no page yet (undefined), keeps it.
 */
export const hidesTabBar = (name: string | undefined): boolean =>
    name !== undefined && (ROUTES as Record<string, RouteSpec | undefined>)[name]?.hidesTabBar === true;

export const TAB_ROUTE_NAMES = ROUTE_NAMES.filter((name) => routeTab(name) !== null) as TabRouteName[];

export const ROOT_ROUTE_NAMES = ROUTE_NAMES.filter((name) => routeTab(name) === null) as RootRouteName[];

/** Whether a gate state shows the route. */
export const routeShows = (name: RouteName, gate: RootGate) => spec(name).gates.includes(gate);

/** Whether a variant's builds have the route at all. */
export const routeInVariant = (name: RouteName, variant: VariantName) => spec(name).variants?.includes(variant) ?? true;

/** The route a gate state opens on: the first one in the table that it shows. */
export function gateRoot(gate: RootGate): RouteName {
    const root = ROUTE_NAMES.find((name) => routeShows(name, gate));
    if (root === undefined) {
        throw new Error(`No route shows while the gate is ${gate}.`);
    }
    return root;
}

/**
 * The way out of a screen that failed to render (its error boundary): Back
 * when the stack has a page under it, else the gate state's root, unless it is
 * that root, which has nowhere to go but Try again.
 */
export function wayOut(route: string, canGoBack: boolean, gate: RootGate): 'back' | RouteName | null {
    if (canGoBack) {
        return 'back';
    }
    const root = gateRoot(gate);
    return route === root ? null : root;
}

/** The static API's `if` for a route: whether the gate state now shows it. */
function shownBy(name: RouteName, source: RootStateSource) {
    return function useShownByGate() {
        return routeShows(name, useRootGate(source));
    };
}

/** A route's component: a screen, or a navigator in the static API (the tabs). */
// oxlint-disable-next-line typescript/no-explicit-any -- the static API's own type for a nested navigator
export type RouteComponent = ComponentType<never> | StaticNavigation<any, any, any>;

/** What the route table gives React Navigation's static API for each screen. */
export interface StaticScreen<Screen> {
    readonly screen: Screen;
    readonly linking: RouteSpec['linking'] | null;
    readonly options: Preset;
    readonly if: () => boolean;
}

/**
 * The root stack's `screens` (the routes with no `tab`), from the table and each route's component, for
 * `variant`'s builds (a route the variant lacks is left out), gated by
 * `source` (the app's root state unless a test passes its own). Typed per
 * route, so the static API infers each screen's params from its component;
 * a route left out is typed as there, and nothing navigates to it in a build
 * without it.
 */
export function staticScreens<const Components extends { readonly [Name in RootRouteName]: RouteComponent }>(
    components: Components,
    variant: VariantName,
    source: RootStateSource = rootState,
    /** The platform (`Platform.OS`), for `onPlatform`. */
    os = 'ios',
    /** Whether the phone draws Liquid Glass (iOS 26 and later), for `onPlatform`. */
    liquidGlass = true,
): { readonly [Name in RootRouteName]: StaticScreen<Components[Name]> } {
    const screens: Partial<Record<RootRouteName, StaticScreen<Components[RootRouteName]>>> = {};
    for (const name of ROOT_ROUTE_NAMES) {
        if (!routeInVariant(name, variant)) {
            continue;
        }
        const { linking, preset } = spec(name);
        screens[name] = {
            screen: components[name],
            // null takes the route out of the links, a nested navigator's included.
            linking: linking ?? null,
            options: onPlatform(preset, os, liquidGlass),
            if: shownBy(name, source),
        };
    }
    return screens as { readonly [Name in RootRouteName]: StaticScreen<Components[Name]> };
}

/** What a tab's stack gets for each of its pages: no gate of its own, since only the shell has the tabs. */
export interface StaticTabScreen<Screen> {
    readonly screen: Screen;
    readonly linking: RouteSpec['linking'] | null;
    readonly options: Preset;
}

/**
 * The pages of `tab`'s own stack (tab-stack.tsx): every route with a `tab`, for `variant`'s
 * builds. Only the routes whose `tab` is this one keep their link path, so a link opens each in
 * one tab (React Navigation refuses two screens with one pattern); the other tabs push it with none.
 */
export function staticTabScreens<const Components extends { readonly [Name in TabRouteName]: RouteComponent }>(
    tab: TabName,
    components: Components,
    variant: VariantName,
    os = 'ios',
    liquidGlass = true,
): { readonly [Name in TabRouteName]: StaticTabScreen<Components[Name]> } {
    const screens: Partial<Record<TabRouteName, StaticTabScreen<Components[TabRouteName]>>> = {};
    for (const name of TAB_ROUTE_NAMES) {
        if (!routeInVariant(name, variant)) {
            continue;
        }
        const { linking, preset } = spec(name);
        screens[name] = {
            screen: components[name],
            linking: routeTab(name) === tab ? (linking ?? null) : null,
            options: onPlatform(preset, os, liquidGlass),
        };
    }
    return screens as { readonly [Name in TabRouteName]: StaticTabScreen<Components[Name]> };
}
