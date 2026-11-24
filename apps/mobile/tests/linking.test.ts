import { describe, expect, it } from 'vitest';

import { appPathOf, linkTarget } from '../src/chat/markdown-links';
import { linkPrefix, pathFromUrl, variantFromConfig } from '../src/navigation/linking';
import { createExternalLinks, type LinkAction, linkResolver } from '../src/navigation/links';
import { ROUTE_NAMES, ROUTES, type RouteSpec } from '../src/navigation/routes';
import { VARIANTS, type VariantName } from '../variant';

import { navigationCore } from './helpers/navigation-core';
import { rootScreens } from './helpers/route-tree';

// The linking table: each
// variant opens only its own scheme's links, read from the config embedded in
// the build, and the route table gives React Navigation each route's path.

const { createPathConfigForStaticNavigation, getActionFromState, getStateFromPath } = navigationCore;

const NAMES = Object.keys(VARIANTS) as VariantName[];

// What the root stack gets from the route table, with stand-in components: the
// tabs (tabs.ts) as the static navigator shell-tabs.tsx builds, each tab with
// its own stack (tab-stack.tsx).
const screens = rootScreens('development');
const HOME_PAGES = {
    Board: { path: 'issues' },
    Issue: { path: 'issues/:key' },
    Memories: { path: 'memories' },
    Activity: { path: 'activity' },
    Schedules: { path: 'schedules' },
    Schedule: { path: 'schedules/:scheduleId' },
    Learning: { path: 'learning' },
    Runs: { path: 'runs' },
    Socio: { path: 'dots/:socioId' },
};
// The Spaces tab (CB-459): its root is the list, at the web's path, and a Space and its pages push inside it.
const SPACES_PAGES = {
    SpacesRoot: { path: 'spaces' },
    Space: { path: 'spaces/:spaceId' },
    SpaceMemory: { path: 'spaces/:spaceId/memory' },
    SpaceRadar: { path: 'spaces/:spaceId/radar' },
    Page: { path: 'spaces/:spaceId/pages/:pageId' },
    // CB-469: a dataset, at the web's path, pushed from its Space's tree or the Private group.
    Dataset: { path: 'data/datasets/:datasetId' },
    // The dataset views' fixtures, in development and preview builds only.
    DatasetPreview: { path: 'dataset-preview' },
};
const TAB_PATHS = {
    path: '',
    screens: {
        Home: { path: '', initialRouteName: 'HomeRoot', screens: HOME_PAGES },
        Chats: {
            initialRouteName: 'ChatsRoot',
            screens: { Chat: { path: 'chats/:id' }, NewChat: { path: 'dots/:socioId/new' } },
        },
        Spaces: { initialRouteName: 'SpacesRoot', screens: SPACES_PAGES },
        More: {
            initialRouteName: 'MoreRoot',
            screens: {
                Approvals: { path: 'approvals' },
                Approval: { path: 'approvals/:id' },
                Settings: { path: 'settings' },
                Notifications: { path: 'settings/notifications' },
            },
        },
        Search: { initialRouteName: 'SearchRoot' },
    },
};
const pathConfig = { screens: createPathConfigForStaticNavigation({ config: { screens } }) ?? {} };

interface LinkState {
    readonly routes: readonly { readonly name: string; readonly params?: object; readonly state?: LinkState }[];
}

/** The routes a link's state stacks up, from the root down the last route of each navigator. */
function chain(state: LinkState | undefined): string[] {
    const last = state?.routes.at(-1);
    return last === undefined ? [] : [state!.routes.map((route) => route.name).join('+'), ...chain(last.state)];
}

/** The page a navigate action opens: its name, or the nested `screen` it names, with that screen's params. */
function pageOf(payload: object | undefined): { name?: string; params?: object } | null {
    if (payload === undefined) {
        return null;
    }
    const { name, params } = payload as { name?: string; params?: { screen?: string; params?: object } };
    let at: { name?: string; params?: object } = { name, params };
    while (typeof (at.params as { screen?: unknown } | undefined)?.screen === 'string') {
        const nested = at.params as { screen: string; params?: object };
        at = { name: nested.screen, params: nested.params };
    }
    return at;
}

/** The page a link opens: the last route of the deepest navigator. */
function leaf(state: LinkState | undefined): LinkState['routes'][number] | undefined {
    const last = state?.routes.at(-1);
    return last?.state === undefined ? last : leaf(last.state);
}

describe("the build's variant", () => {
    it.each(NAMES)('is extra.variant when it names one (%s)', (name) => {
        expect(variantFromConfig({ extra: { variant: name }, scheme: VARIANTS[name].scheme })).toBe(name);
    });

    it.each(NAMES)('falls back to the scheme the config registers while extra.variant is absent (%s)', (name) => {
        const { scheme } = VARIANTS[name];
        expect(variantFromConfig({ scheme })).toBe(name);
        expect(variantFromConfig({ extra: {}, scheme: [scheme] })).toBe(name);
        expect(variantFromConfig({ extra: null, scheme })).toBe(name);
    });

    it.each(NAMES)('is production when extra.variant names no variant, whatever the scheme (%s)', (name) => {
        const { scheme } = VARIANTS[name];
        for (const variant of ['staging', 7, null, '', 'toString']) {
            expect(variantFromConfig({ extra: { variant }, scheme }), String(variant)).toBe('production');
        }
    });

    it('believes extra.variant over the scheme', () => {
        expect(variantFromConfig({ extra: { variant: 'preview' }, scheme: 'socio-dev' })).toBe('preview');
    });

    it('is production, the strictest, when the config names none', () => {
        expect(variantFromConfig(null)).toBe('production');
        expect(variantFromConfig(undefined)).toBe('production');
        expect(variantFromConfig({})).toBe('production');
        expect(variantFromConfig({ scheme: 'exp+socio' })).toBe('production');
        expect(variantFromConfig({ extra: { variant: 'toString' } })).toBe('production');
    });
});

describe.each(NAMES)("the %s variant's links", (name) => {
    const { scheme } = VARIANTS[name];

    it(`strip ${scheme}:// for React Navigation`, () => {
        expect(linkPrefix(name)).toBe(`${scheme}://`);
    });

    it('open the path after the scheme, with its query', () => {
        expect(pathFromUrl(`${scheme}://chats/abc`, name)).toBe('/chats/abc');
        expect(pathFromUrl(`${scheme}:///chats/abc`, name)).toBe('/chats/abc');
        expect(pathFromUrl(`${scheme}://spaces/s1//pages/p2/`, name)).toBe('/spaces/s1/pages/p2/');
        expect(pathFromUrl(`${scheme}://issues/CB-344?tab=comments`, name)).toBe('/issues/CB-344?tab=comments');
        expect(pathFromUrl(`${scheme.toUpperCase()}://chats/abc`, name)).toBe('/chats/abc');
    });

    it('drop the fragment, which React Navigation would fold into the last param', () => {
        expect(pathFromUrl(`${scheme}://chats/abc#message-9`, name)).toBe('/chats/abc');
        expect(pathFromUrl(`${scheme}://issues/CB-344?tab=comments#c9`, name)).toBe('/issues/CB-344?tab=comments');
        expect(pathFromUrl(`${scheme}://spaces/s1/pages/p2#heading?x=1`, name)).toBe('/spaces/s1/pages/p2');
        expect(pathFromUrl(`${scheme}://#message-9`, name)).toBeNull();
    });

    it("refuse every other variant's scheme, and lookalikes", () => {
        for (const other of NAMES.filter((candidate) => candidate !== name)) {
            expect(pathFromUrl(`${VARIANTS[other].scheme}://chats/abc`, name), other).toBeNull();
        }
        expect(pathFromUrl(`${scheme}x://chats/abc`, name)).toBeNull();
        expect(pathFromUrl(`exp+socio://chats/abc`, name)).toBeNull();
        expect(pathFromUrl(`https://brain.example.test/chats/abc`, name)).toBeNull();
    });

    it('leave the app as it is for the bare scheme', () => {
        for (const url of [`${scheme}:`, `${scheme}://`, `${scheme}:///`, `${scheme}://?from=widget`]) {
            expect(pathFromUrl(url, name), url).toBeNull();
        }
    });

    it("ignore the development client's launcher URL", () => {
        const launcher = `${scheme}://expo-development-client/?url=${encodeURIComponent('http://10.0.2.2:8081')}`;
        expect(pathFromUrl(launcher, name)).toBeNull();
        // The same words in a query don't make a link the launcher's.
        expect(pathFromUrl(`${scheme}://chats/abc?q=expo-development-client`, name)).toBe(
            '/chats/abc?q=expo-development-client',
        );
    });

    it("ignore the sign-in sheet's custom-scheme callback, which the sheet takes", () => {
        expect(pathFromUrl(`${scheme}://auth-callback#code=ABCD&state=xyz`, name)).toBeNull();
        expect(pathFromUrl(`${scheme}://auth-callback`, name)).toBeNull();
        // The verified https callback isn't a scheme link either.
        expect(pathFromUrl('https://link.socio.sh/app/cb#code=ABCD&state=xyz&ws=acme.example', name)).toBeNull();
    });
});

describe('the route table as React Navigation reads it', () => {
    it('gives every route its own path, or none', () => {
        const paths = ROUTE_NAMES.flatMap((name) => {
            const { linking }: RouteSpec = ROUTES[name];
            return linking === undefined ? [] : [typeof linking === 'string' ? linking : (linking.path ?? '')];
        });
        expect(new Set(paths).size).toBe(paths.length);
        expect(pathConfig.screens).toEqual({
            Tabs: TAB_PATHS,
            Diagnostics: { path: 'diagnostics' },
            EditorCorpus: { path: 'editor-corpus' },
        });
    });

    it('gives a production build no path to a route it lacks', () => {
        const production = rootScreens('production');
        const config = { screens: createPathConfigForStaticNavigation({ config: { screens: production } }) ?? {} };
        // Without the dataset views' fixtures (CB-469), a development and preview route.
        const { DatasetPreview: _preview, ...spacesPages } = SPACES_PAGES;
        const productionTabs = {
            ...TAB_PATHS,
            screens: { ...TAB_PATHS.screens, Spaces: { ...TAB_PATHS.screens.Spaces, screens: spacesPages } },
        };
        expect(config.screens).toEqual({ Tabs: productionTabs });
        expect(getStateFromPath('/dataset-preview', config)).toBeUndefined();
        expect(getStateFromPath('/diagnostics', config)).toBeUndefined();
        expect(getStateFromPath('/editor-corpus', config)).toBeUndefined();
    });

    it("opens New chat with a socio at the web's path", () => {
        const state = getStateFromPath('/dots/sebas/new', pathConfig);
        // In the Chats tab's own stack, over the chat list.
        expect(chain(state)).toEqual(['Tabs', 'Chats', 'ChatsRoot+NewChat']);
        expect(leaf(state)).toEqual({ name: 'NewChat', params: { socioId: 'sebas' }, path: '/dots/sebas/new' });
    });

    it('opens the shell at the root path, as on the web, on the Home tab', () => {
        const state = getStateFromPath('/', pathConfig);
        expect(state?.routes.map((route) => route.name)).toEqual(['Tabs']);
        expect(state?.routes[0]?.state?.routes.map((route) => route.name)).toEqual(['Home']);
    });

    it("opens a page at the web's path for it: the Spaces at /spaces, the Board at /issues, Settings at /settings", () => {
        for (const [path, page] of [
            ['/spaces', 'Spaces'],
            ['/issues', 'Board'],
            ['/memories', 'Memories'],
            ['/activity', 'Activity'],
            ['/schedules', 'Schedules'],
            ['/learning', 'Learning'],
            ['/runs', 'Runs'],
            ['/settings', 'Settings'],
        ] as const) {
            const state = getStateFromPath(path, pathConfig);
            // In its own tab's stack, over the tab's root.
            const tab = page === 'Settings' ? 'More' : page === 'Spaces' ? 'Spaces' : 'Home';
            // The Spaces list is the Spaces tab's root (CB-459).
            expect(chain(state), path).toEqual(
                page === 'Spaces' ? ['Tabs', 'Spaces', 'SpacesRoot'] : ['Tabs', tab, `${tab}Root+${page}`],
            );
        }
        // Chats, the Inbox, More and Search have no path on the web, so none here either.
        for (const path of ['/inbox', '/Inbox', '/more', '/More', '/chats', '/search', '/Search']) {
            expect(getStateFromPath(path, pathConfig), path).toBeUndefined();
        }
    });

    it("opens an issue at the web's path, /issues/CB-12", () => {
        const state = getStateFromPath('/issues/CB-12', pathConfig);
        expect(chain(state)).toEqual(['Tabs', 'Home', 'HomeRoot+Issue']);
        expect(leaf(state)).toEqual({ name: 'Issue', params: { key: 'CB-12' }, path: '/issues/CB-12' });
    });

    it("opens the approvals at the web's paths, /approvals and /approvals/:id", () => {
        expect(chain(getStateFromPath('/approvals', pathConfig))).toEqual(['Tabs', 'More', 'MoreRoot+Approvals']);
        const state = getStateFromPath('/approvals/a1', pathConfig);
        expect(leaf(state)).toEqual({ name: 'Approval', params: { id: 'a1' }, path: '/approvals/a1' });
        const action = state === undefined ? undefined : getActionFromState(state, pathConfig);
        expect(pageOf(action !== undefined && 'payload' in action ? action.payload : undefined)).toEqual({
            name: 'Approval',
            params: { id: 'a1' },
        });
    });

    it("doesn't open the gate's screens, or a path no route has, by a link", () => {
        for (const path of ['/add-workspace', '/AddWorkspace', '/lock', '/Lock', '/chats', '/chats/abc/more']) {
            expect(getStateFromPath(path, pathConfig), path).toBeUndefined();
        }
    });

    it("opens a Space's library at the web's path for it, /spaces/:spaceId", () => {
        const state = getStateFromPath('/spaces/ops', pathConfig);
        expect(leaf(state)).toEqual({ name: 'Space', params: { spaceId: 'ops' }, path: '/spaces/ops' });
    });

    it("opens a Space's memory and radar at the web's paths for them", () => {
        expect(leaf(getStateFromPath('/spaces/ops/memory', pathConfig))).toEqual({
            name: 'SpaceMemory',
            params: { spaceId: 'ops' },
            path: '/spaces/ops/memory',
        });
        expect(leaf(getStateFromPath('/spaces/ops/radar', pathConfig))).toEqual({
            name: 'SpaceRadar',
            params: { spaceId: 'ops' },
            path: '/spaces/ops/radar',
        });
    });

    it("opens a page at the web's path for it, /spaces/:spaceId/pages/:pageId", () => {
        const state = getStateFromPath('/spaces/ops/pages/p1', pathConfig);
        expect(leaf(state)).toEqual({
            name: 'Page',
            params: { spaceId: 'ops', pageId: 'p1' },
            path: '/spaces/ops/pages/p1',
        });
    });

    it("opens a chat at the web's path for it, /chats/:id, a room's id too", () => {
        const state = getStateFromPath('/chats/abc', pathConfig);
        // The Chats tab, its list under the chat, so Back (and a tap on the tab) goes to the list.
        expect(chain(state)).toEqual(['Tabs', 'Chats', 'ChatsRoot+Chat']);
        expect(leaf(state)).toEqual({ name: 'Chat', params: { id: 'abc' }, path: '/chats/abc' });
        // Back to the tabs on the root stack (`pop`, never a second tab navigator), then the chat
        // pushed over the list in the Chats tab.
        expect(state && getActionFromState(state, pathConfig)).toMatchObject({
            type: 'NAVIGATE',
            payload: {
                name: 'Tabs',
                pop: true,
                params: { screen: 'Chats', params: { screen: 'Chat', initial: false, params: { id: 'abc' } } },
            },
        });
    });

    it.each(NAMES)("opens the chat's path after the %s scheme, with typed params", (name) => {
        const later = pathConfig;
        const path = pathFromUrl(`${VARIANTS[name].scheme}://chats/abc?draft=1`, name) ?? '';
        const state = getStateFromPath(path, later);
        expect(leaf(state)).toEqual({ name: 'Chat', params: { id: 'abc', draft: '1' }, path: '/chats/abc?draft=1' });
        expect(state && getActionFromState(state, later)).toMatchObject({
            type: 'NAVIGATE',
            payload: {
                name: 'Tabs',
                params: { screen: 'Chats', params: { screen: 'Chat', params: { id: 'abc', draft: '1' } } },
            },
        });
    });

    it.each(NAMES)("opens a %s link's route and params without its fragment", (name) => {
        // The server's links carry anchors (`/chats/<id>#message-<id>`).
        const resolve = linkResolver(pathConfig, getStateFromPath, getActionFromState);
        const { scheme } = VARIANTS[name];
        const opens = (url: string) => pageOf(resolve(pathFromUrl(url, name) ?? '')?.action.payload);

        expect(opens(`${scheme}://chats/abc#message-9`)).toMatchObject({ name: 'Chat', params: { id: 'abc' } });
        expect(opens(`${scheme}://issues/CB-344?tab=comments#c9`)).toMatchObject({
            name: 'Issue',
            params: { key: 'CB-344', tab: 'comments' },
        });
        expect(opens(`${scheme}://spaces/s1/pages/p2#heading`)).toMatchObject({
            name: 'Page',
            params: { spaceId: 's1', pageId: 'p2' },
        });
        // A notification's link comes as a path, fragment and all.
        expect(pageOf(resolve('/chats/abc#message-9')?.action.payload)).toMatchObject({
            name: 'Chat',
            params: { id: 'abc' },
        });
    });

    it("maps a notification's links: a tag's chat, / to the shell, the test notification to Notifications", () => {
        const links = createExternalLinks({
            resolve: linkResolver(pathConfig, getStateFromPath, getActionFromState),
            report: () => {},
        });
        const root = { key: 'root', routeNames: ['Tabs', 'Chat', 'Settings', 'Notifications'] };
        const dispatched: LinkAction[] = [];
        links.attach({ isReady: () => true, getRootState: () => root, dispatch: (action) => dispatched.push(action) });
        const opened = (path: string) => {
            links.open(path);
            return pageOf(dispatched.at(-1)?.payload);
        };
        expect(opened('/chats/room-1#message-9')).toMatchObject({ name: 'Chat', params: { id: 'room-1' } });
        expect(opened('/')).toMatchObject({ name: 'Home' });
        // The test notification's link opens the Notifications settings screen.
        expect(opened('/settings/notifications')).toMatchObject({ name: 'Notifications' });
        expect(opened('/settings')).toMatchObject({ name: 'Settings' });
        expect(dispatched).toHaveLength(4);
    });

    it.each(NAMES)('never switches the workspace by a %s link: there is no /w/ path', (name) => {
        const resolve = linkResolver(pathConfig, getStateFromPath, getActionFromState);
        const path = pathFromUrl(`${VARIANTS[name].scheme}://w/ws-beta/chats/abc`, name);
        expect(path).toBe('/w/ws-beta/chats/abc');
        expect(resolve(path ?? '')).toBeUndefined();
    });

    it.each(NAMES)('opens a %s link from a locked phone once the gate shows its screen', (name) => {
        const links = createExternalLinks({
            resolve: linkResolver(pathConfig, getStateFromPath, getActionFromState),
            report: () => {},
        });
        const root = { key: 'root', routeNames: ['Lock'] };
        const dispatched: LinkAction[] = [];
        links.attach({ isReady: () => true, getRootState: () => root, dispatch: (action) => dispatched.push(action) });

        links.open(pathFromUrl(`${VARIANTS[name].scheme}://chats/abc`, name) ?? '');
        expect(dispatched).toEqual([]);

        root.routeNames = ['Tabs'];
        links.flush();
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toMatchObject({ target: 'root', type: 'NAVIGATE', payload: { name: 'Tabs' } });
        expect(pageOf(dispatched[0]?.payload)).toEqual({ name: 'Chat', params: { id: 'abc' } });
    });
});

describe('links in messages open the app’s own screens (CB-413)', () => {
    const resolve = linkResolver(pathConfig, getStateFromPath, getActionFromState);
    const workspace = 'https://acme.example';
    const shellRoutes = ROUTE_NAMES.filter((route) => (ROUTES[route] as RouteSpec).gates.includes('shell'));
    const container = () => {
        const dispatched: LinkAction[] = [];
        return {
            dispatched,
            navigator: {
                isReady: () => true,
                getRootState: () => ({ key: 'root-1', routeNames: shellRoutes }),
                dispatch: (action: LinkAction) => {
                    dispatched.push(action);
                },
            },
        };
    };
    const opened = (href: string) => {
        const links = createExternalLinks({ resolve, report: () => {} });
        const { navigator, dispatched } = container();
        links.attach(navigator);
        const target = linkTarget(href, workspace);
        const path = target === null ? null : appPathOf(target);
        return { path, opened: path !== null && links.openNow(path), dispatched };
    };

    it.each([
        ['/spaces/ops', 'Space', { spaceId: 'ops' }],
        ['/spaces/ops/pages/p1', 'Page', { spaceId: 'ops', pageId: 'p1' }],
        [`${workspace}/spaces/ops/pages/p1`, 'Page', { spaceId: 'ops', pageId: 'p1' }],
        ['/#/spaces/ops/pages/p1', 'Page', { spaceId: 'ops', pageId: 'p1' }],
        ['/data/datasets/ds1', 'Dataset', { datasetId: 'ds1' }],
        ['/chats/room-1', 'Chat', { id: 'room-1' }],
        ['/chats/abc#message-9', 'Chat', { id: 'abc' }],
        ['/schedules/s1', 'Schedule', { scheduleId: 's1' }],
        ['/approvals/a1', 'Approval', { id: 'a1' }],
        ['/memories', 'Memories', undefined],
        ['/dots/sebas/new', 'NewChat', { socioId: 'sebas' }],
    ])('%s opens %s', (href, name, params) => {
        const { opened: done, dispatched } = opened(href);
        expect(done).toBe(true);
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toMatchObject({ target: 'root-1', type: 'NAVIGATE' });
        expect(pageOf(dispatched[0]?.payload)).toMatchObject({ name });
        if (params !== undefined) {
            expect(pageOf(dispatched[0]?.payload)).toMatchObject({ params });
        }
    });

    it('leaves to the browser what no screen opens, or what only the web shows', () => {
        for (const href of [
            '/somewhere/else',
            '/chats/abc/more',
            '/issues?status=open',
            '/spaces/ops?view=list',
            '/api/media/attachments/cbatt_1/content?download=1',
            '/',
        ]) {
            const { opened: done, dispatched } = opened(href);
            expect(done, href).toBe(false);
            expect(dispatched, href).toEqual([]);
        }
        // Another site, an issue (its own rule) and an attachment have no app path.
        for (const href of ['https://other.example/spaces/ops', '/issues/CB-3', '/api/issue-attachments/abc']) {
            const target = linkTarget(href, workspace);
            expect(target === null ? null : appPathOf(target), href).toBeNull();
        }
    });

    it('never opens a screen the gate doesn’t show now, and never waits for one', () => {
        const links = createExternalLinks({ resolve, report: () => {} });
        const dispatched: LinkAction[] = [];
        links.attach({
            isReady: () => true,
            getRootState: () => ({ key: 'root-1', routeNames: ['Lock'] }),
            dispatch: (action) => dispatched.push(action),
        });
        expect(links.openNow('/chats/abc')).toBe(false);
        expect(links.pending()).toBeNull();
        expect(dispatched).toEqual([]);
        const unready = createExternalLinks({ resolve, report: () => {} });
        expect(unready.openNow('/chats/abc')).toBe(false);
    });
});
