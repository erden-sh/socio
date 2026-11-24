// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, Outlet, RouterProvider, useParams, type RouteObject } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PluginLauncherEntry } from '@socio/shared/plugins/plugins';
import type { State, WorkspaceState } from '@socio/shared/types';

import { installMirrorDiscoveryGuard } from '../src/modules/plugins/mirror-discovery';
import { OPEN_LINK_ARM_MS } from '../src/modules/plugins/OpenLinkDialog';
import { PluginFrame } from '../src/modules/plugins/PluginFrame';
import { handle, shouldRevalidate } from '../src/modules/plugins/PluginFrame.route';
import { useHeaderMenuSection } from '../src/shell/header-menu';
import { ShellContext, type Shell, type RouteHandle } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const entry = (patch: Partial<PluginLauncherEntry> = {}): PluginLauncherEntry => ({
    id: 'events',
    name: 'Events',
    description: 'Event docs and invoices.',
    display: 'embed',
    mode: 'service',
    origin: 'https://events.apps.example',
    entryPath: '/',
    openAllow: [],
    openAnyHttps: false,
    routes: false,
    ...patch,
});

let host: HTMLDivElement;
let root: Root;
let launches: string[];
let nexts: string[];
let opened: string[];
let router: ReturnType<typeof createMemoryRouter>;
/** What `/__manifest` answers: a status, or 0 for a network failure. */
let manifestStatus: number;
let manifestRequests: string[];
let removeGuard: () => void;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    launches = [];
    nexts = [];
    opened = [];
    manifestStatus = 200;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        if (url.pathname === '/__manifest') {
            manifestRequests.push(url.searchParams.get('paths') ?? '');
            if (init?.signal?.aborted) {
                throw init.signal.reason;
            }
            if (manifestStatus === 0) {
                throw new TypeError('Failed to fetch');
            }
            return new Response(manifestStatus === 200 ? '{}' : 'down', { status: manifestStatus });
        }
        launches.push(url.pathname);
        nexts.push((JSON.parse(String(init?.body ?? '{}')) as { next?: string }).next ?? '');
        return new Response(JSON.stringify({ url: 'https://events.apps.example/launch?code=x' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    vi.spyOn(window, 'open').mockImplementation((url) => {
        opened.push(String(url));
        return null;
    });
    manifestRequests = [];
    // As entry.client installs it, over the (stubbed) browser fetch.
    removeGuard = installMirrorDiscoveryGuard(window);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    removeGuard();
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

/** The header's last crumb (what AppHeader renders) beside the page. */
function Crumb({ workspace }: { workspace: WorkspaceState }) {
    const params = useParams();
    const crumbs = (handle as Required<RouteHandle>).crumb({ workspace, params } as never);
    return <div data-slot="test-header">{crumbs.at(-1)?.node}</div>;
}

function MenuProbe() {
    const section = useHeaderMenuSection();
    return <div data-slot="test-menu" data-has-items={section ? 'yes' : 'no'} />;
}

let parentLoads: number;
let frameLoads: number;
let discovered: string[];

/**
 * The page as the app routes it: a parent with a loader (the shell's
 * place), and `plugins/:pluginId/*` with the real route module's
 * `shouldRevalidate` and a loader that counts its runs (production's has
 * none; this proves the route would not load again). Routes are discovered
 * lazily, as `routeDiscovery: { mode: 'lazy' }` does: with `lazy`, the
 * frame route isn't known until the first navigation asks for it.
 */
function mount(
    plugin: PluginLauncherEntry,
    at = `/plugins/${plugin.id}`,
    options: {
        lazy?: boolean;
        /** Discovery's own work for a path (the framework fetches `/__manifest`); synchronous when absent. */
        discover?: (path: string, signal: AbortSignal) => Promise<void>;
    } = {},
) {
    const workspace = { plugins: [plugin], dots: [], spaces: [] } as unknown as WorkspaceState;
    const shell = { state: { settings: {} } as unknown as State, workspace } as unknown as Shell;
    parentLoads = 0;
    frameLoads = 0;
    discovered = [];
    const frameRoute: RouteObject = {
        id: 'plugins:frame',
        // As in routes.ts: the whole address is the plugin's (CB-446).
        path: 'plugins/:pluginId/*',
        loader: () => {
            frameLoads += 1;
            return null;
        },
        shouldRevalidate,
        element: (
            <>
                <Crumb workspace={workspace} />
                <MenuProbe />
                <PluginFrame />
            </>
        ),
    };
    const elsewhere: RouteObject = { id: 'elsewhere', path: '*', element: <div data-slot="elsewhere" /> };
    let patched = !options.lazy;
    router = createMemoryRouter(
        [
            {
                id: 'shell',
                path: '/',
                loader: () => {
                    parentLoads += 1;
                    return null;
                },
                element: <Outlet />,
                // The shell's error page: a mirror must never reach it.
                errorElement: <div data-slot="shell-error" />,
                children: options.lazy ? [] : [frameRoute, elsewhere],
            },
        ],
        {
            initialEntries: [at],
            // Lazy route discovery: asked on every navigation that matches a
            // dynamic or splat segment, as the framework's `/__manifest` is.
            patchRoutesOnNavigation: async ({ path, patch, signal }) => {
                discovered.push(path);
                await options.discover?.(path, signal);
                if (!patched) {
                    patched = true;
                    patch('shell', [frameRoute, elsewhere]);
                }
            },
        },
    );
    act(() =>
        root.render(
            <ShellContext.Provider value={shell}>
                <RouterProvider router={router} />
            </ShellContext.Provider>,
        ),
    );
}

const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);

it('shows an embedded plugin under the header alone: no second bar with its name', async () => {
    mount(entry());
    await settled();
    const frame = slot('plugin-frame')!;
    expect(frame).not.toBeNull();
    expect(frame.textContent).not.toContain('Events');
    expect([...frame.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Open in a new tab');
    expect(slot('plugin-iframe')).not.toBeNull();
    // Downloads a plugin starts (a CSV export) work; popups and top navigation stay off.
    expect(slot('plugin-iframe')!.getAttribute('sandbox')).toBe(
        'allow-scripts allow-forms allow-same-origin allow-downloads',
    );
    // The header's crumb carries the name and the action, labeled.
    const header = slot('test-header')!;
    expect(header.textContent).toBe('Events');
    const action = slot('plugin-open-tab')!;
    expect(action.getAttribute('aria-label')).toBe('Open in a new tab');
    expect(action.getAttribute('title')).toBe('Open in a new tab');
    // On phones it is in the header's ⋯ menu.
    expect(slot('test-menu')!.dataset.hasItems).toBe('yes');

    act(() => action.click());
    await settled();
    expect(launches.filter((path) => path === '/api/plugins/events/launch')).toHaveLength(2);
    expect(opened).toEqual(['https://events.apps.example/launch?code=x']);
});

it('offers no header action for a plugin that is not in a frame', async () => {
    mount(entry({ display: 'tab' }));
    await settled();
    expect(slot('test-header')!.textContent).toBe('Events');
    expect(slot('plugin-open-tab')).toBeNull();
    expect(slot('test-menu')!.dataset.hasItems).toBe('no');
});

const ORIGIN = 'https://events.apps.example';
const address = () => `${router.state.location.pathname}${router.state.location.search}${router.state.location.hash}`;
const iframe = () => document.querySelector<HTMLIFrameElement>('[data-slot="plugin-iframe"]');

/** A message from the plugin's frame (or from somewhere else). */
function fromFrame(data: unknown, patch: { origin?: string; source?: Window | null } = {}) {
    act(() => {
        window.dispatchEvent(
            new MessageEvent('message', {
                data,
                origin: patch.origin ?? ORIGIN,
                source: patch.source === undefined ? iframe()!.contentWindow : patch.source,
            }),
        );
    });
}

const report = (path: string, query = '', hash = '') => ({
    v: 1,
    source: 'socio-plugin',
    type: 'route',
    path,
    query,
    hash,
});
const ready = { v: 1, source: 'socio-plugin', type: 'ready' };

/** What the host posts to the frame. */
function sentToFrame() {
    const sent: { type: string }[] = [];
    vi.spyOn(iframe()!.contentWindow!, 'postMessage').mockImplementation((message: unknown) => {
        sent.push(message as { type: string });
    });
    return () => sent.filter((message) => message.type === 'go-to');
}

it('opens a cold deep link with its frame exactly at that route, under lazy route discovery (CB-446)', async () => {
    mount(entry({ routes: true, entryPath: '/app?mode=embed' }), '/plugins/events/events/42?tab=invoices#total', {
        lazy: true,
    });
    await settled();
    // The route was found by discovery, then the frame mounted once.
    expect([...new Set(discovered)]).toEqual(['/plugins/events/events/42']);
    expect(launches).toEqual(['/api/plugins/events/launch']);
    expect(nexts).toEqual(['/events/42?tab=invoices#total']);
    expect(iframe()!.getAttribute('src')).toBe('https://events.apps.example/launch?code=x');
    expect(address()).toBe('/plugins/events/events/42?tab=invoices#total');
});

it('opens the entry for the bare address, and for a route the bridge would refuse (CB-446)', async () => {
    for (const [at, next] of [
        ['/plugins/events', '/app?mode=embed'],
        ['/plugins/events?view=week', '/?view=week'],
        ['/plugins/events#/events/7', '/#/events/7'],
        ['/plugins/events/__cb/auth', '/app?mode=embed'],
        ['/plugins/events/a//b', '/app?mode=embed'],
        ['/plugins/events/manage', '/manage'],
    ] as const) {
        nexts = [];
        mount(entry({ routes: true, entryPath: '/app?mode=embed' }), at);
        await settled();
        expect(nexts, at).toEqual([next]);
        act(() => root.unmount());
        root = createRoot(host);
    }
});

it('keeps a plugin without bridge.routes at /plugins/:id, and sends the old open and manage addresses on (CB-446)', async () => {
    mount(entry(), '/plugins/events/events/42?tab=a');
    await settled();
    expect(address()).toBe('/plugins/events');
    expect(nexts).toEqual(['/']);
    act(() => root.unmount());
    root = createRoot(host);
    mount(entry(), '/plugins/events/open');
    await settled();
    expect(address()).toBe('/plugins/events');
    act(() => root.unmount());
    root = createRoot(host);
    // A disabled plugin is not in the launcher, and its settings still are an admin's.
    mount(entry({ id: 'other' }), '/plugins/events/Manage/');
    await settled();
    expect(address()).toBe('/settings/plugins/events');
    expect(slot('elsewhere')).not.toBeNull();
    // Its route reports change nothing.
    act(() => root.unmount());
    root = createRoot(host);
    mount(entry());
    await settled();
    fromFrame(report('/events/42'));
    await settled();
    expect(address()).toBe('/plugins/events');
});

it('mirrors the app route into the address, replacing, without reloading the frame or re-running the route (CB-446)', async () => {
    mount(entry({ routes: true }));
    await settled();
    const frame = iframe()!;
    const src = frame.getAttribute('src');
    expect(parentLoads).toBe(1);
    expect(frameLoads).toBe(1);
    const steps: [ReturnType<typeof report>, string][] = [
        [report('/events/42', '?tab=a'), '/plugins/events/events/42?tab=a'],
        [report('/events/42', '?tab=b'), '/plugins/events/events/42?tab=b'],
        [report('/events/42', '?tab=b', '#total'), '/plugins/events/events/42?tab=b#total'],
        // The fragment going away is not a hash-only change to the router.
        [report('/events/42', '?tab=b'), '/plugins/events/events/42?tab=b'],
        [report('/', '', '#/events/7'), '/plugins/events#/events/7'],
        [report('/'), '/plugins/events'],
        [report('/caf%C3%A9/open'), '/plugins/events/caf%C3%A9/open'],
    ];
    for (const [message, expected] of steps) {
        fromFrame(message);
        await settled();
        expect(address()).toBe(expected);
        expect(router.state.historyAction).toBe('REPLACE');
    }
    // The same frame element, its src untouched, one launch; no loader ran again.
    expect(iframe()).toBe(frame);
    expect(iframe()!.getAttribute('src')).toBe(src);
    expect(launches).toEqual(['/api/plugins/events/launch']);
    expect(parentLoads).toBe(1);
    expect(frameLoads).toBe(1);
    // Discovery was asked for each new path (the framework's /__manifest), and changed nothing.
    expect(discovered).toContain('/plugins/events/events/42');
});

it('pushes for a navigate that asks to, and follows its replace (CB-446)', async () => {
    mount(entry({ routes: true }));
    await settled();
    const frame = iframe();
    fromFrame({ v: 1, source: 'socio-plugin', type: 'navigate', path: '/events/42?tab=a#b', replace: false });
    await settled();
    expect(address()).toBe('/plugins/events/events/42?tab=a#b');
    expect(router.state.historyAction).toBe('PUSH');
    fromFrame({ v: 1, source: 'socio-plugin', type: 'navigate', path: '/events/43', replace: true });
    await settled();
    expect(address()).toBe('/plugins/events/events/43');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(iframe()).toBe(frame);
    expect(frameLoads).toBe(1);
});

it('ignores a route that is invalid, from another origin, or from another window (CB-446)', async () => {
    mount(entry({ routes: true }));
    await settled();
    for (const data of [
        report('//evil.example/x'),
        report('https://evil.example/'),
        report('/a/../../settings'),
        report('/a//b'),
        report('/__cb/auth'),
        report('/events', 'view=week'),
        report(`/${'a'.repeat(2000)}`),
        { ...report('/events'), extra: true },
        { v: 1, source: 'socio-plugin', type: 'route', path: '/events' },
    ]) {
        fromFrame(data);
    }
    fromFrame(report('/events'), { origin: 'https://evil.example' });
    fromFrame(report('/events'), { source: window });
    fromFrame(report('/events'), { source: null });
    await settled();
    expect(address()).toBe('/plugins/events');
    expect(router.state.historyAction).toBe('POP');
});

it('sends the open app a go-to for a workspace link or Back, never for its own mirror (CB-446)', async () => {
    mount(entry({ routes: true }));
    await settled();
    const goTos = sentToFrame();
    const frame = iframe();
    fromFrame(ready);
    fromFrame(report('/events/42'));
    await settled();
    expect(goTos()).toEqual([]);
    // A link elsewhere in the workspace into the open plugin: the route
    // doesn't load again (shouldRevalidate), the app is told where to go.
    await act(() => router.navigate('/plugins/events/events/7?tab=a#x'));
    await settled();
    expect(goTos()).toEqual([
        { v: 1, source: 'socio-host', type: 'go-to', path: '/events/7', query: '?tab=a', hash: '#x' },
    ]);
    expect(frameLoads).toBe(1);
    // The app goes there and reports it: nothing more is sent.
    fromFrame(report('/events/7', '?tab=a', '#x'));
    await settled();
    expect(goTos()).toHaveLength(1);
    // Back to the entry the mirror wrote: the app follows.
    await act(() => router.navigate(-1));
    await settled();
    expect(address()).toBe('/plugins/events/events/42');
    expect(goTos().at(-1)).toEqual({
        v: 1,
        source: 'socio-host',
        type: 'go-to',
        path: '/events/42',
        query: '',
        hash: '',
    });
    expect(iframe()).toBe(frame);
    expect(launches).toEqual(['/api/plugins/events/launch']);
    expect(frameLoads).toBe(1);
    // Another plugin's address is a new route instance: it loads.
    await act(() => router.navigate('/plugins/other'));
    await settled();
    expect(frameLoads).toBe(2);
});

/**
 * Discovery as the framework does it (`fetchAndApplyManifestPatches`):
 * fetch `/__manifest`, throw on a failed answer, and return quietly when the
 * navigation was superseded (its signal aborted).
 */
async function discover(path: string, signal: AbortSignal) {
    try {
        const response = await fetch(`/__manifest?paths=${encodeURIComponent(path)}&version=v1`, { signal });
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        throw error;
    }
}

/** A promise and its resolve, to hold discovery for one path. */
function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
}

it('lets a newer route report supersede a mirror still waiting on discovery, even one back at the committed address (CB-446)', async () => {
    const held = new Map<string, ReturnType<typeof gate>>();
    mount(entry({ routes: true }), '/plugins/events/events/42', {
        discover: async (path, signal) => {
            const wait = held.get(path);
            if (wait) {
                await Promise.race([
                    wait.promise,
                    new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
                ]);
            }
        },
    });
    await settled();
    const frame = iframe();
    fromFrame(ready);
    fromFrame(report('/events/42'));
    await settled();
    // /43's discovery is slow; meanwhile the app comes back to /42.
    held.set('/plugins/events/events/43', gate());
    fromFrame(report('/events/43'));
    await settled();
    expect(address()).toBe('/plugins/events/events/42');
    expect(router.state.navigation.state).toBe('loading');
    fromFrame(report('/events/42'));
    await settled();
    // /43's discovery finishing late must not take the address back to it.
    held.get('/plugins/events/events/43')!.open();
    await settled();
    expect(address()).toBe('/plugins/events/events/42');
    expect(router.state.navigation.state).toBe('idle');
    // And the newest report wins again afterwards.
    fromFrame(report('/events/44'));
    await settled();
    expect(address()).toBe('/plugins/events/events/44');
    expect(iframe()).toBe(frame);
    expect(frameLoads).toBe(1);
});

it('skips a mirror whose route discovery fails, leaving the frame mounted, and mirrors the next report (CB-446)', async () => {
    // Discovery fetches /__manifest, as the framework does.
    for (const failure of [503, 0]) {
        mount(entry({ routes: true }), '/plugins/events', { discover });
        await settled();
        const frame = iframe()!;
        fromFrame(ready);
        manifestStatus = failure;
        fromFrame(report('/events/43'));
        await settled();
        expect(manifestRequests.at(-1)).toBe('/plugins/events/events/43');
        // No error page, the same frame, the address where it was.
        expect(slot('shell-error'), String(failure)).toBeNull();
        expect(iframe()).toBe(frame);
        expect(address()).toBe('/plugins/events');
        // The same report again tries again; with the server back it mirrors.
        manifestStatus = 200;
        fromFrame(report('/events/43'));
        await settled();
        expect(address()).toBe('/plugins/events/events/43');
        expect(router.state.navigation.state).toBe('idle');
        expect(iframe()).toBe(frame);
        expect(launches).toEqual(['/api/plugins/events/launch']);
        act(() => root.unmount());
        root = createRoot(host);
        launches = [];
    }
});

it('leaves a failed discovery that is not a mirror to the router (CB-446)', async () => {
    mount(entry({ routes: true }), '/plugins/events', { discover });
    await settled();
    manifestStatus = 503;
    await act(() => router.navigate('/plugins/events/events/9'));
    await settled();
    expect(slot('shell-error')).not.toBeNull();
});

const openMsg = (url: string) => ({ v: 1, source: 'socio-plugin', type: 'open', url });
const dialogButton = (name: string) => slot(`plugin-open-link-${name}`) as HTMLButtonElement | null;

it('opens a bridge.open link at once, and nothing else, for a plugin without openAnyHttps', async () => {
    mount(entry({ openAllow: ['https://x.com/intent/post'] }));
    await settled();
    fromFrame(openMsg('https://x.com/intent/post?text=hi'));
    expect(opened).toEqual(['https://x.com/intent/post?text=hi']);
    fromFrame(openMsg('https://docs.example.com/guide.pdf'));
    await settled();
    expect(slot('plugin-open-link')).toBeNull();
    expect(opened).toHaveLength(1);
});

it('asks before opening any other https link for a plugin with openAnyHttps, in the host’s own dialog', async () => {
    mount(entry({ openAllow: ['https://x.com/intent/post'], openAnyHttps: true }));
    await settled();
    // Its listed links still open without a prompt.
    fromFrame(openMsg('https://x.com/intent/post?text=hi'));
    expect(opened).toEqual(['https://x.com/intent/post?text=hi']);
    expect(slot('plugin-open-link')).toBeNull();

    fromFrame(openMsg('https://docs.example.com/files/brief.pdf#page=2'));
    // Checked before any timer can run: Open waits a moment, so a click meant for the plugin can't land on it.
    expect(dialogButton('open')!.disabled).toBe(true);
    act(() => dialogButton('open')!.click());
    expect(opened).toHaveLength(1);
    await settled();
    const dialog = slot('plugin-open-link')!;
    // Drawn by the workspace, outside the plugin's frame.
    expect(dialog).not.toBeNull();
    expect(slot('plugin-frame')!.contains(dialog)).toBe(false);
    expect(dialog.textContent).toContain('Open docs.example.com in a new tab?');
    expect(dialog.textContent).toContain('Events asks to open this link.');
    expect(slot('plugin-open-link-url')!.textContent).toBe('https://docs.example.com/files/brief.pdf#page=2');
    expect(opened).toHaveLength(1);
    // Cancel has the focus.
    expect(document.activeElement).toBe(dialogButton('cancel'));
    // A second ask while it shows is dropped, a listed link's too.
    fromFrame(openMsg('https://evil.example/'));
    fromFrame(openMsg('https://x.com/intent/post?text=again'));
    expect(opened).toHaveLength(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, OPEN_LINK_ARM_MS + 50)));
    expect(slot('plugin-open-link-host')!.textContent).toBe('docs.example.com');
    expect(dialogButton('open')!.disabled).toBe(false);
    act(() => dialogButton('open')!.click());
    await settled();
    expect(opened).toEqual(['https://x.com/intent/post?text=hi', 'https://docs.example.com/files/brief.pdf#page=2']);
    expect(vi.mocked(window.open).mock.calls.at(-1)).toEqual([
        'https://docs.example.com/files/brief.pdf#page=2',
        '_blank',
        'noopener,noreferrer',
    ]);
    expect(slot('plugin-open-link')).toBeNull();
});

it('opens nothing when the person cancels, or for a link that is not https', async () => {
    mount(entry({ openAnyHttps: true }));
    await settled();
    fromFrame(openMsg('https://docs.example.com/guide'));
    await settled();
    act(() => dialogButton('cancel')!.click());
    await settled();
    expect(slot('plugin-open-link')).toBeNull();
    expect(opened).toEqual([]);
    for (const url of [
        'http://docs.example.com/guide',
        'javascript:alert(1)',
        'data:text/html,hi',
        'blob:https://events.apps.example/1',
        'file:///etc/passwd',
    ]) {
        fromFrame(openMsg(url));
        await settled();
        expect(slot('plugin-open-link'), url).toBeNull();
    }
    // From another origin or another window, nothing at all.
    fromFrame(openMsg('https://docs.example.com/guide'), { origin: 'https://evil.example' });
    fromFrame(openMsg('https://docs.example.com/guide'), { source: window });
    await settled();
    expect(slot('plugin-open-link')).toBeNull();
    expect(opened).toEqual([]);
});
