/**
 * Iframe bridge client. The message schema lives in Socio's
 * `packages/shared/src/plugins/plugins.ts` (`parseHostToPlugin`, `bridgeOrigin`). This file
 * only mounts it: ready, theme, open, and deep links (route, navigate and
 * go-to, CB-446).
 */
import {
    bridgeOrigin,
    parseHostToPlugin,
    pluginRoute,
    pluginRouteFromString,
    pluginRouteString,
    type PluginRoute,
} from '@socio/shared/plugins/plugins';

const PARENT_META = 'socio-parent';

export function pluginParentOrigin() {
    if (typeof document === 'undefined') {
        return undefined;
    }
    return bridgeOrigin(document.querySelector(`meta[name="${PARENT_META}"]`)?.getAttribute('content') ?? '');
}

export function applyPluginTheme(theme: 'light' | 'dark') {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
}

/** Post `{ v: 1, source: 'socio-plugin', ... }` to the host. False when not embedded. */
export function postToPluginHost(
    message:
        | { type: 'ready' }
        | { type: 'resize'; height: number }
        | { type: 'open'; url: string }
        | { type: 'embed-refused' }
        | ({ type: 'route' } & PluginRoute)
        | { type: 'navigate'; path: string; replace: boolean },
) {
    const parentOrigin = pluginParentOrigin();
    if (!parentOrigin || window.parent === window) {
        return false;
    }
    window.parent.postMessage({ v: 1, source: 'socio-plugin' as const, ...message }, parentOrigin);
    return true;
}

/**
 * Ask the host to open `url` in a new tab. Returns true when the message
 * was sent, so the caller can cancel the anchor's own navigation. Returns
 * false when the page is not inside the host iframe. The host opens a link
 * the manifest's `bridge.open` lists at once; with `bridge.openAnyHttps`,
 * any other https link after the person confirms it in the workspace's own
 * dialog; anything else (another scheme, or no declaration) not at all.
 * The host never answers, so a sent message isn't an opened tab.
 */
export function openInHost(url: string) {
    return postToPluginHost({ type: 'open', url });
}

/**
 * Ask the host to show `path` (`/path?query#hash`, the app's own) in its
 * address bar, for an app whose own URL doesn't change (a memory router).
 * An app whose URL does change needs nothing: `installPluginBridge`
 * reports every move (`route`). `replace` replaces the host's history
 * entry instead of adding one. Returns false when not embedded or the path
 * is refused (see `pluginRoutePath`).
 */
export function navigateInHost(path: string, options: { replace?: boolean } = {}) {
    const route = pluginRouteFromString(path);
    if (!route) {
        return false;
    }
    return postToPluginHost({ type: 'navigate', path: pluginRouteString(route), replace: options.replace ?? false });
}

/** This page's route as the bridge carries it, or undefined when the bridge would refuse it. */
export function currentPluginRoute(): PluginRoute | undefined {
    return pluginRoute(window.location.pathname, window.location.search, window.location.hash);
}

/**
 * The default `go-to`: the page's URL becomes the route, replacing the
 * current entry (the workspace already added one), and a `popstate` tells
 * the app's router, as Back would.
 */
export function goToPluginRoute(route: PluginRoute) {
    window.history.replaceState(window.history.state, '', pluginRouteString(route));
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

/**
 * Calls `onChange` after every location change of this page: `pushState`
 * and `replaceState` (wrapped), Back and Forward (`popstate`), and a
 * fragment change (`hashchange`). Returns a cleanup function.
 */
function watchLocation(onChange: () => void) {
    const history = window.history;
    const push = history.pushState;
    const replace = history.replaceState;
    const pushed: typeof push = function (this: History, ...args) {
        push.apply(this, args);
        onChange();
    };
    const replaced: typeof replace = function (this: History, ...args) {
        replace.apply(this, args);
        onChange();
    };
    history.pushState = pushed;
    history.replaceState = replaced;
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    return () => {
        // Only undo our own wrap: something wrapped after us keeps working.
        if (history.pushState === pushed) {
            history.pushState = push;
        }
        if (history.replaceState === replaced) {
            history.replaceState = replace;
        }
        window.removeEventListener('popstate', onChange);
        window.removeEventListener('hashchange', onChange);
    };
}

/**
 * Apply the system theme, tell the host the page is ready, and follow
 * later `theme` messages. Deep links (CB-446): report this page's route
 * (`{ path, query, hash }`, exactly its own location) to the host now and
 * after every location change, so the workspace address mirrors it; the
 * host ignores it unless the manifest has `bridge.routes`. A `go-to` from
 * the host (a workspace link into the open plugin, or Back) goes to
 * `onGoTo`, by default `goToPluginRoute`. Returns a cleanup function.
 */
export function installPluginBridge(options: { onGoTo?: (route: PluginRoute) => void } = {}) {
    const parentOrigin = pluginParentOrigin();
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        applyPluginTheme('dark');
    }
    const embedded = !!parentOrigin && window.parent !== window;
    let reported = '';
    const report = () => {
        const route = currentPluginRoute();
        if (!route || pluginRouteString(route) === reported) {
            return;
        }
        reported = pluginRouteString(route);
        postToPluginHost({ type: 'route', ...route });
    };
    let unwatch = () => {};
    if (embedded) {
        window.parent.postMessage({ v: 1, source: 'socio-plugin', type: 'ready' }, parentOrigin);
        report();
        unwatch = watchLocation(report);
    }
    const onMessage = (event: MessageEvent) => {
        if (!parentOrigin || event.origin !== parentOrigin) {
            return;
        }
        if (event.source !== window.parent) {
            return;
        }
        const data = parseHostToPlugin(event.data);
        if (!data) {
            return;
        }
        if (data.type === 'go-to') {
            const { path, query, hash } = data;
            (options.onGoTo ?? goToPluginRoute)({ path, query, hash });
            return;
        }
        applyPluginTheme(data.theme);
    };
    window.addEventListener('message', onMessage);
    return () => {
        unwatch();
        window.removeEventListener('message', onMessage);
    };
}
