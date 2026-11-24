import { useEffect } from 'react';

/**
 * Route discovery's address (react-router.config.ts); it answers 204 with
 * `X-Remix-Reload-Document` to a page from another build.
 */
export const MANIFEST_PATH = '/__manifest';

/** How often an open tab asks whether a newer build is live. */
export const BUILD_CHECK_MS = 5 * 60_000;

/** A page load at `to`: the browser asks the server for it. */
const loadPage = (to: string) => location.assign(to);

/** This page's build: React Router's route manifest version. */
const pageVersion = () =>
    (globalThis as { __reactRouterManifest?: { version?: string } }).__reactRouterManifest?.version;

let stale = false;
let unsaved: () => boolean = () => false;
let pollFailed = false;

/** A newer build is live: this tab's code and route list are out of date. */
export const isStale = () => stale;

/** For tests: a fresh tab. */
export function resetBuildSkew() {
    stale = false;
    unsaved = () => false;
    pollFailed = false;
}

/**
 * Asks the server whether this tab's build is still the live one. Never
 * from the HTTP cache: the live version's answer is cached for good, so
 * a cached copy would say "current" forever. A failed request (offline)
 * changes nothing; the next check asks again.
 */
export async function checkBuild(request: typeof fetch = fetch) {
    const version = pageVersion();
    if (stale || !version) {
        return stale;
    }
    const query = new URLSearchParams({ version, paths: '/' });
    try {
        const response = await request(`${MANIFEST_PATH}?${query}`, {
            cache: 'no-store',
        });
        if (response.status === 204 && response.headers.has('X-Remix-Reload-Document')) {
            stale = true;
        }
    } catch {
        // Offline or restarting: ask again later.
    }
    return stale;
}

/**
 * The shell's poll answered (`ok`) or failed. When it answers after
 * failing, the server was away, as it is while a deploy restarts it: ask
 * about the build at once, so a tab left open during a deploy is caught
 * before its next click rather than at the next 5-minute check.
 */
export function afterPoll(ok: boolean, request?: typeof fetch) {
    const back = ok && pollFailed;
    pollFailed = !ok;
    return back ? checkBuild(request) : Promise.resolve(stale);
}

/**
 * Once the tab is stale, and nothing unsaved would be lost, the next
 * navigation loads its page from the server: the new build, at the
 * address it was going to. (Without this, the click would find the old
 * build's code gone and reload the page it was on.)
 */
export const loadsDocument = () => stale && !unsaved();

/** Navigates in the app, or loads the page once the tab is stale. */
export const navigateOrLoad =
    (navigate: (to: string, state?: unknown) => void, load = loadPage) =>
    (to: string, state?: unknown) =>
        loadsDocument() ? load(to) : navigate(to, state);

/**
 * Where a click on a link takes this tab, when the router would follow it
 * here: a plain primary click on a same-origin link, opening in this tab,
 * not a download, not inside an editor (the editor follows its own links
 * through the app navigator), and not to the page it is on.
 */
export function linkDestination(event: MouseEvent): string | undefined {
    if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
    ) {
        return undefined;
    }
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement)) {
        return undefined;
    }
    if (
        (link.target && link.target !== '_self') ||
        link.hasAttribute('download') ||
        link.closest('[contenteditable="true"]')
    ) {
        return undefined;
    }
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) {
        return undefined;
    }
    if (url.pathname === location.pathname && url.search === location.search) {
        return undefined;
    }
    return url.pathname + url.search + url.hash;
}

/**
 * Catches a deploy before the click (CB-61 step 5): the shell asks
 * whether its build is still live when the tab comes back into view and
 * every 5 minutes. Once it isn't, a link click (in the capture phase,
 * before the router sees it) loads the link's page instead. `isDirty`:
 * an unsaved draft, which a page load would lose; the router's own
 * navigation and its leave prompt stay in charge then.
 */
export function useBuildSkew(isDirty: () => boolean, load = loadPage) {
    useEffect(() => {
        unsaved = isDirty;
        const check = () => void checkBuild();
        const visible = () => {
            if (document.visibilityState === 'visible') {
                check();
            }
        };
        const click = (event: MouseEvent) => {
            if (!loadsDocument()) {
                return;
            }
            const to = linkDestination(event);
            if (!to) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            load(to);
        };
        document.addEventListener('visibilitychange', visible);
        window.addEventListener('click', click, true);
        const timer = setInterval(check, BUILD_CHECK_MS);
        return () => {
            document.removeEventListener('visibilitychange', visible);
            window.removeEventListener('click', click, true);
            clearInterval(timer);
            if (unsaved === isDirty) {
                unsaved = () => false;
            }
        };
    }, [isDirty, load]);
}
