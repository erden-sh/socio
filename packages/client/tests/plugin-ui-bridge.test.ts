// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { installPluginBridge, navigateInHost } from '@socio/plugin-ui';

// The plugin side of deep links (CB-446): `installPluginBridge` reports the
// app's route on every location change and follows the host's `go-to`.

const PARENT = 'https://workspace.example';
let posted: unknown[];
let parent: { postMessage: (message: unknown, target: string) => void };
let cleanup: () => void;

beforeEach(() => {
    posted = [];
    parent = {
        postMessage: (message, target) => {
            expect(target).toBe(PARENT);
            posted.push(message);
        },
    };
    Object.defineProperty(window, 'parent', { value: parent, configurable: true });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const meta = document.createElement('meta');
    meta.name = 'socio-parent';
    meta.content = PARENT;
    document.head.append(meta);
    window.history.replaceState(null, '', '/events/42?tab=a#b');
});

afterEach(() => {
    cleanup?.();
    document.head.innerHTML = '';
    Reflect.deleteProperty(window, 'parent');
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
});

const routes = () => posted.filter((message) => (message as { type: string }).type === 'route');
const route = (path: string, query = '', hash = '') => ({
    v: 1,
    source: 'socio-plugin',
    type: 'route',
    path,
    query,
    hash,
});

it('reports the route at once and after every push, replace, Back and fragment change', () => {
    cleanup = installPluginBridge();
    expect(posted[0]).toEqual({ v: 1, source: 'socio-plugin', type: 'ready' });
    expect(routes()).toEqual([route('/events/42', '?tab=a', '#b')]);
    window.history.pushState(null, '', '/events/43');
    window.history.replaceState(null, '', '/events/43?view=week');
    // The same place again: no second report.
    window.history.replaceState({ any: 'state' }, '', '/events/43?view=week');
    window.history.pushState(null, '', '/#/hash-router/7');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(routes()).toEqual([
        route('/events/42', '?tab=a', '#b'),
        route('/events/43'),
        route('/events/43', '?view=week'),
        route('/', '', '#/hash-router/7'),
    ]);
    // A route the bridge refuses is not sent.
    window.history.pushState(null, '', '/a//b');
    expect(routes()).toHaveLength(4);
    // After cleanup, nothing more.
    cleanup();
    window.history.pushState(null, '', '/later');
    expect(routes()).toHaveLength(4);
});

it('follows a go-to from the parent only, by default replacing its URL and telling its router', () => {
    cleanup = installPluginBridge();
    const pops: string[] = [];
    window.addEventListener('popstate', () => pops.push(window.location.pathname));
    const goTo = { v: 1, source: 'socio-host', type: 'go-to', path: '/events/7', query: '?x=1', hash: '' };
    window.dispatchEvent(
        new MessageEvent('message', { data: goTo, origin: 'https://evil.example', source: parent as never }),
    );
    window.dispatchEvent(new MessageEvent('message', { data: goTo, origin: PARENT, source: window }));
    expect(window.location.pathname).toBe('/events/42');
    const length = window.history.length;
    window.dispatchEvent(new MessageEvent('message', { data: goTo, origin: PARENT, source: parent as never }));
    expect(`${window.location.pathname}${window.location.search}`).toBe('/events/7?x=1');
    expect(window.history.length).toBe(length);
    expect(pops).toEqual(['/events/7']);
    expect(routes().at(-1)).toEqual(route('/events/7', '?x=1'));
    // An app can take it itself.
    cleanup();
    const onGoTo = vi.fn();
    cleanup = installPluginBridge({ onGoTo });
    window.dispatchEvent(
        new MessageEvent('message', { data: { ...goTo, path: '/x' }, origin: PARENT, source: parent as never }),
    );
    expect(onGoTo).toHaveBeenCalledWith({ path: '/x', query: '?x=1', hash: '' });
});

it('sends navigate only for a route the bridge takes', () => {
    expect(navigateInHost('/events/9?a=1#b', { replace: true })).toBe(true);
    expect(navigateInHost('//evil.example')).toBe(false);
    expect(posted).toEqual([
        { v: 1, source: 'socio-plugin', type: 'navigate', path: '/events/9?a=1#b', replace: true },
    ]);
});
