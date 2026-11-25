import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useNavigationType, useParams } from 'react-router';

import {
    PLUGIN_SANDBOX,
    bridgeOpenMode,
    bridgeOrigin,
    parsePluginToHost,
    pluginAddressFor,
    pluginRouteFromAddress,
    pluginRouteFromString,
    pluginRouteString,
    samePluginRoute,
    type HostToPluginMessage,
    type PluginLauncherEntry,
    type PluginRoute,
} from '@socio/shared/plugins/plugins';

import { api } from '../../lib/api';
import { bundledPluginPages } from '../../plugins/bundled';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { beginMirror } from './mirror-discovery';
import { OpenLinkDialog } from './OpenLinkDialog';
import { managePath, pluginPath } from './plugin-rows';
import { usePluginFrameAction } from './plugin-title-crumb';
import { PluginOpen } from './PluginOpen';

import { Button } from '@/components/ui/button';
import { useThemeChoice } from '@/shell/theme';

const READY_MS = 8000;

/**
 * `/plugins/:id` and everything under it: the plugin's address, all of it
 * the plugin's (CB-446). A bundled plugin is a page of this client. A tab
 * plugin's page opens it in a new tab. A service embed's frame is the apps
 * host, never an arbitrary URL; a launch code is redeemed there, and the
 * plugin's replicas hold no session. Below `/plugins/:id` is the embed's
 * own route when its manifest has `bridge.routes`; for any other plugin
 * the address is `/plugins/:id` alone, and the old `/plugins/:id/open` and
 * `/plugins/:id/manage` move to their new places.
 */
export function PluginFrame() {
    const { pluginId = '', '*': rest = '' } = useParams();
    const { workspace } = useShell();
    const plugin = workspace.plugins?.find((item) => item.id === pluginId);
    if (rest && !plugin?.routes) {
        // `manage` before the lookup: a disabled plugin's settings are still an admin's.
        const to = /^manage\/?$/i.test(rest) ? managePath(pluginId) : pluginPath(pluginId);
        return <Navigate to={to} replace />;
    }
    if (!plugin) {
        return <PluginMissing />;
    }
    if (plugin.mode === 'bundled') {
        return <BundledPlugin id={plugin.id} />;
    }
    if (plugin.display !== 'embed') {
        return <PluginOpen key={plugin.id} plugin={plugin} />;
    }
    // Keyed on the plugin only: its route moving never remounts the frame.
    return <ServicePlugin key={plugin.id} plugin={plugin} />;
}

/** Not installed, disabled, or not for this person. */
export function PluginMissing() {
    return (
        <WorkspacePage
            slot="plugin-missing"
            title="Plugin not available"
            description="It is not installed on this instance, it is disabled, or it is not open to you. An admin can change that from Plugins."
        />
    );
}

/** A plugin that runs inside Socio: its page from this build. */
function BundledPlugin({ id }: { id: string }) {
    const Page = bundledPluginPages[id];
    if (!Page) {
        return (
            <WorkspacePage
                slot="plugin-no-page"
                title="No page for this plugin"
                description="This version of Socio has no page for it. Its tools may still work for socios and connected agents."
            />
        );
    }
    return (
        <Suspense
            fallback={
                <div className="m-4 min-h-80 flex-1" aria-busy="true" aria-label="Opening the plugin">
                    <div className="h-full animate-pulse rounded-xl bg-muted" />
                </div>
            }
        >
            <Page />
        </Suspense>
    );
}

/** Whether a route is the app's `/` with nothing after it (the frame then opens at `entry.path`). */
const isBareRoot = (route: PluginRoute) => route.path === '/' && !route.query && !route.hash;

/** What a mirror navigation carries, so the location effect knows the app is already there. */
const MIRROR_STATE = { pluginMirror: true } as const;
const isMirror = (state: unknown) =>
    !!state && typeof state === 'object' && (state as { pluginMirror?: unknown }).pluginMirror === true;

function ServicePlugin({ plugin }: { plugin: PluginLauncherEntry }) {
    const { resolved } = useThemeChoice();
    const pluginIdStable = plugin.id;
    const origin = plugin.origin;
    const routes = plugin.routes;
    const openAllow = plugin.openAllow.join('\n');
    const openAnyHttps = plugin.openAnyHttps === true;
    const frame = useRef<HTMLIFrameElement>(null);
    const location = useLocation();
    const navigationType = useNavigationType();
    const navigate = useNavigate();
    // The app route this page's address names (CB-446), for a plugin with
    // deep links; undefined for one without, or when the bridge would
    // refuse it (`/__cb/…`, `//`, a `..` segment): the frame then opens at
    // `entry.path`.
    const address = routes ? pluginRouteFromAddress(location) : undefined;
    const addressKey = address ? pluginRouteString(address) : '';
    const addressNow = useRef(address);
    addressNow.current = address;
    // Where the app is as far as the host knows: where the frame was sent,
    // then what it reports. Undefined until known.
    const appRoute = useRef<PluginRoute | undefined>(undefined);
    // The mirror navigation in flight, if any (its address isn't committed yet).
    const pendingMirror = useRef<PluginRoute | undefined>(undefined);
    // Read once, on mount: the frame's src is never bound to anything later.
    const launchNext = useRef(plugin.entryPath || '/');
    const [src, setSrc] = useState<string>();
    const [error, setError] = useState<string>();
    const [ready, setReady] = useState(false);
    const [waiting, setWaiting] = useState(true);
    const [refused, setRefused] = useState(false);
    // A link outside `bridge.open` waiting for the person's yes
    // (`bridge.openAnyHttps`). One at a time: every other `open` meanwhile,
    // a `bridge.open` one included, is dropped.
    const [confirming, setConfirming] = useState<string>();
    const confirmingNow = useRef<string | undefined>(undefined);
    confirmingNow.current = confirming;
    useEffect(() => {
        if (!pluginIdStable) {
            return;
        }
        let cancelled = false;
        setSrc(undefined);
        setReady(false);
        setWaiting(true);
        setRefused(false);
        setError(undefined);
        // The frame opens where the address says, once; later moves of
        // either side never reload it.
        const start = addressNow.current;
        appRoute.current = start && !isBareRoot(start) ? start : undefined;
        api<{ url: string }>(`/plugins/${pluginIdStable}/launch`, 'POST', {
            next: appRoute.current ? pluginRouteString(appRoute.current) : launchNext.current,
        })
            .then((body) => {
                if (!cancelled) {
                    setSrc(body.url);
                }
            })
            .catch((reason) => {
                if (!cancelled) {
                    setError(reason instanceof Error ? reason.message : 'Could not open the plugin.');
                }
            });
        return () => {
            cancelled = true;
        };
    }, [pluginIdStable]);

    useEffect(() => {
        if (!src) {
            return;
        }
        const timer = window.setTimeout(() => setWaiting(false), READY_MS);
        return () => window.clearTimeout(timer);
    }, [src]);

    const postTheme = useCallback(() => {
        const win = frame.current?.contentWindow;
        const target = bridgeOrigin(origin);
        if (!win || !target || !pluginIdStable) {
            return;
        }
        const message: HostToPluginMessage = {
            v: 1,
            source: 'socio-host',
            type: 'theme',
            theme: resolved,
            pluginId: pluginIdStable,
        };
        win.postMessage(message, target);
    }, [origin, pluginIdStable, resolved]);

    useEffect(() => {
        if (!origin) {
            return;
        }
        // The address follows the app: through the router, replacing the
        // entry, with no revalidation, so neither the frame nor any route
        // loads again. A mirror can wait on route discovery (`/__manifest`
        // for a new path); the newest report always wins, so it is compared
        // with the mirror still in flight, not only with the committed
        // address, and a newer navigation supersedes (aborts) that one.
        const mirror = (route: PluginRoute, replace: boolean) => {
            appRoute.current = route;
            const latest = pendingMirror.current ?? addressNow.current;
            if (latest && samePluginRoute(latest, route)) {
                return;
            }
            const to = pluginAddressFor(pluginIdStable, route);
            pendingMirror.current = route;
            // A failed discovery skips this mirror (the address stays, the
            // frame stays mounted); the next report tries again.
            const end = beginMirror(to.split(/[?#]/, 1)[0]!, () => {
                if (pendingMirror.current === route) {
                    pendingMirror.current = undefined;
                }
            });
            void Promise.resolve(
                navigate(to, {
                    replace,
                    state: MIRROR_STATE,
                    preventScrollReset: true,
                    defaultShouldRevalidate: false,
                }),
            ).finally(() => {
                end();
                if (pendingMirror.current === route) {
                    pendingMirror.current = undefined;
                }
            });
        };
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== origin) {
                return;
            }
            if (event.source !== frame.current?.contentWindow) {
                return;
            }
            const allow = openAllow ? openAllow.split('\n') : [];
            const data = parsePluginToHost(event.data, allow, openAnyHttps);
            if (!data) {
                return;
            }
            if (data.type === 'ready') {
                postTheme();
                setReady(true);
                setWaiting(false);
            }
            // While the person is deciding on a link, every other `open` is dropped, listed ones too.
            if (data.type === 'open' && !confirmingNow.current) {
                const mode = bridgeOpenMode(new URL(data.url), allow, openAnyHttps);
                if (mode === 'direct') {
                    window.open(data.url, '_blank', 'noopener,noreferrer');
                } else if (mode === 'confirm') {
                    confirmingNow.current = data.url;
                    setConfirming(data.url);
                }
            }
            if (data.type === 'embed-refused') {
                setRefused(true);
                setWaiting(false);
            }
            // Deep links only for a plugin whose manifest asks (`bridge.routes`).
            if (routes && data.type === 'route') {
                mirror({ path: data.path, query: data.query, hash: data.hash }, true);
            }
            if (routes && data.type === 'navigate') {
                const route = pluginRouteFromString(data.path);
                if (route) {
                    mirror(route, data.replace);
                }
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [origin, openAllow, openAnyHttps, navigate, pluginIdStable, routes, postTheme]);

    // The address moved and the app didn't (a workspace link into the open
    // plugin, Back or Forward): tell it where to go. Not for our own mirror,
    // unless Back or Forward returned to it.
    useEffect(() => {
        const win = frame.current?.contentWindow;
        const target = bridgeOrigin(origin);
        const route = addressNow.current;
        const known = appRoute.current;
        if (!win || !target || !ready || !route || !known || samePluginRoute(route, known)) {
            return;
        }
        if (isMirror(location.state) && navigationType !== 'POP') {
            return;
        }
        appRoute.current = route;
        const message: HostToPluginMessage = { v: 1, source: 'socio-host', type: 'go-to', ...route };
        win.postMessage(message, target);
        // `addressKey` is `addressNow`'s value; `location.key` names each history entry.
    }, [origin, addressKey, ready, location.key, location.state, navigationType]);

    useEffect(() => {
        if (src) {
            postTheme();
        }
    }, [postTheme, src]);

    const openTab = useCallback(() => {
        const at = appRoute.current;
        api<{ url: string }>(`/plugins/${pluginIdStable}/launch`, 'POST', {
            next: at ? pluginRouteString(at) : launchNext.current,
        })
            .then((body) => window.open(body.url, '_blank', 'noopener,noreferrer'))
            .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not open the plugin.'));
    }, [pluginIdStable]);
    // The header carries the name and Open in a new tab (PluginTitleCrumb),
    // so the frame takes the whole page below it.
    usePluginFrameAction(pluginIdStable, openTab);

    const fallback = refused || (!ready && !waiting && !error);
    return (
        <main className="flex min-h-0 w-full flex-1 flex-col overflow-hidden" data-slot="plugin-frame">
            {error && (
                <p className="px-4 py-2 text-sm text-destructive" role="alert">
                    {error}
                </p>
            )}
            {fallback && (
                <p className="px-4 py-2 text-sm" data-slot="plugin-fallback">
                    This plugin did not open inside the workspace.{' '}
                    <Button type="button" variant="outline" size="sm" onClick={openTab}>
                        Open in a new tab
                    </Button>
                </p>
            )}
            {!src && !error && (
                <div className="m-4 min-h-80 flex-1" aria-busy="true" aria-label="Opening the plugin">
                    <div className="h-full animate-pulse rounded-xl bg-muted" />
                </div>
            )}
            {src && !refused && (
                <iframe
                    ref={frame}
                    title={plugin.name}
                    src={src}
                    sandbox={PLUGIN_SANDBOX}
                    className="min-h-0 w-full flex-1 border-0 bg-background"
                    data-slot="plugin-iframe"
                />
            )}
            {confirming && (
                <OpenLinkDialog
                    url={confirming}
                    pluginName={plugin.name}
                    onOpen={() => {
                        window.open(confirming, '_blank', 'noopener,noreferrer');
                        setConfirming(undefined);
                    }}
                    onCancel={() => setConfirming(undefined)}
                />
            )}
        </main>
    );
}
