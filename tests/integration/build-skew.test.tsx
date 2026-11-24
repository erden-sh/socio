// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    afterPoll,
    BUILD_CHECK_MS,
    checkBuild,
    isStale,
    linkDestination,
    MANIFEST_PATH,
    navigateOrLoad,
    resetBuildSkew,
    useBuildSkew,
} from '../../packages/client/src/shell/build-skew';
import routerConfig from '../../react-router.config';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
    var __reactRouterManifest: { version: string } | undefined;
}

let root: Root;
let host: HTMLElement;
let requests: { url: string; init?: RequestInit }[];
// What the server says to this tab's version: current, or a newer build.
let live: 'same' | 'newer' | 'offline';
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    resetBuildSkew();
    globalThis.__reactRouterManifest = { version: 'v1' };
    requests = [];
    live = 'same';
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (live === 'offline') {
            throw new TypeError('Failed to fetch');
        }
        return live === 'newer'
            ? new Response(null, {
                  status: 204,
                  headers: { 'X-Remix-Reload-Document': 'true' },
              })
            : Response.json({});
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.__reactRouterManifest = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it('asks route discovery about this build, never from the cache, and marks the tab stale on a newer one', async () => {
    expect(MANIFEST_PATH).toBe(routerConfig.routeDiscovery.manifestPath);
    expect(await checkBuild()).toBe(false);
    expect(requests).toEqual([
        {
            url: `${MANIFEST_PATH}?version=v1&paths=%2F`,
            init: { cache: 'no-store' },
        },
    ]);
    live = 'offline';
    expect(await checkBuild()).toBe(false);
    live = 'newer';
    expect(await checkBuild()).toBe(true);
    expect(isStale()).toBe(true);
    // Stale stays stale, without asking again.
    expect(await checkBuild()).toBe(true);
    expect(requests).toHaveLength(3);
    // No manifest (tests, an error page): nothing to compare.
    resetBuildSkew();
    globalThis.__reactRouterManifest = undefined;
    expect(await checkBuild()).toBe(false);
    expect(requests).toHaveLength(3);
});

it('asks about the build as soon as the shell’s poll answers again after failing', async () => {
    // Polls that answer, as usual: nothing to ask.
    expect(await afterPoll(true)).toBe(false);
    expect(await afterPoll(true)).toBe(false);
    expect(requests).toHaveLength(0);
    // The server goes away for a deploy, then answers from the new build.
    expect(await afterPoll(false)).toBe(false);
    expect(await afterPoll(false)).toBe(false);
    expect(requests).toHaveLength(0);
    live = 'newer';
    expect(await afterPoll(true)).toBe(true);
    expect(requests.map(({ url }) => url)).toEqual([`${MANIFEST_PATH}?version=v1&paths=%2F`]);
    expect(isStale()).toBe(true);
    // Once is enough: the next answers ask nothing.
    expect(await afterPoll(true)).toBe(true);
    expect(requests).toHaveLength(1);
});

/**
 * A click on `element`, as the browser dispatches it. Returns whether
 * something before the page's own handlers took it over (prevented its
 * default); the page then keeps jsdom from following the link.
 */
const click = (element: Element, init: MouseEventInit = {}) => {
    const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init,
    });
    let taken: boolean | undefined;
    const page = (reached: Event) => {
        taken = reached.defaultPrevented;
        reached.preventDefault();
    };
    document.addEventListener('click', page);
    element.dispatchEvent(event);
    document.removeEventListener('click', page);
    // Stopped before the page saw it: taken over.
    return taken ?? event.defaultPrevented;
};

it('follows only plain same-origin clicks that would stay in this tab', () => {
    history.replaceState(null, '', '/memories');
    host.innerHTML = `
    <a id="issues" href="/issues?view=list"><span>Issues</span></a>
    <a id="here" href="/memories#top">Top</a>
    <a id="away" href="https://example.com/x">Away</a>
    <a id="tab" href="/runs" target="_blank">Runs</a>
    <a id="file" href="/api/issues/export.md" download>Export</a>
    <div contenteditable="true"><a id="edit" href="/spaces/s1">Space</a></div>
    <button id="button">Button</button>`;
    const destination = (id: string, init?: MouseEventInit) => {
        let found: string | undefined;
        const listen = (event: MouseEvent) => (found = linkDestination(event));
        window.addEventListener('click', listen, true);
        click(host.querySelector(`#${id}`)!, init);
        window.removeEventListener('click', listen, true);
        return found;
    };
    // From the link's own text too (the target is inside it).
    expect(destination('issues')).toBe('/issues?view=list');
    const span = host.querySelector('#issues span')!;
    let found: string | undefined;
    const listen = (event: MouseEvent) => (found = linkDestination(event));
    window.addEventListener('click', listen, true);
    click(span);
    window.removeEventListener('click', listen, true);
    expect(found).toBe('/issues?view=list');
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
        expect(destination('issues', { [modifier]: true }), modifier).toBe(undefined);
    }
    expect(destination('issues', { button: 1 })).toBeUndefined();
    for (const id of ['here', 'away', 'tab', 'file', 'edit', 'button']) {
        expect(destination(id), id).toBeUndefined();
    }
});

function Shell({ dirty, load }: { dirty: { current: boolean }; load: (to: string) => void }) {
    useBuildSkew(() => dirty.current, load);
    return (
        <>
            <a id="issues" href="/issues">
                Issues
            </a>
            <a id="tab" href="/runs" target="_blank">
                Runs
            </a>
        </>
    );
}

it('loads the next page from the server once a newer build is live, unless a draft is unsaved', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/');
    const loads: string[] = [];
    const dirty = { current: false };
    act(() => root.render(<Shell dirty={dirty} load={(to) => loads.push(to)} />));
    const issues = host.querySelector('#issues')!;
    // Current build: the router gets the click.
    expect(click(issues)).toBe(false);
    expect(loads).toEqual([]);
    // A deploy; the tab comes back into view and asks.
    live = 'newer';
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
    });
    expect(isStale()).toBe(true);
    // An unsaved draft: the router and its leave prompt stay in charge.
    dirty.current = true;
    expect(click(issues)).toBe(false);
    expect(loads).toEqual([]);
    dirty.current = false;
    // A new tab is the browser's; this tab's click loads the page.
    expect(click(host.querySelector('#tab')!)).toBe(false);
    expect(click(issues)).toBe(true);
    expect(loads).toEqual(['/issues']);
    // Code that navigates (the palette, the editor's links) does the same.
    const navigated: string[] = [];
    const go = navigateOrLoad(
        (to) => navigated.push(to),
        (to) => loads.push(to),
    );
    go('/memories');
    expect(loads).toEqual(['/issues', '/memories']);
    expect(navigated).toEqual([]);
});

it('asks every 5 minutes while the tab is open', async () => {
    vi.useFakeTimers();
    act(() => root.render(<Shell dirty={{ current: false }} load={() => {}} />));
    expect(requests).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(BUILD_CHECK_MS));
    expect(requests).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(BUILD_CHECK_MS));
    expect(requests).toHaveLength(2);
    // Before a deploy, code navigates in the app.
    const navigated: string[] = [];
    navigateOrLoad((to) => navigated.push(to))('/issues');
    expect(navigated).toEqual(['/issues']);
});
