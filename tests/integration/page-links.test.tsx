import { renderToStaticMarkup } from 'react-dom/server';
import { matchPath } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { ChatTranscript } from '../../packages/client/src/modules/chat/ChatTranscript';
import {
    followLink,
    legacyHashPath,
    legacyLocationPath,
    resolveLink,
    setAppNavigator,
} from '../../packages/client/src/modules/pages/page-navigation';
import { WorkspaceStore } from '../helpers/stores.js';
import { testDatabase } from '../helpers/test-database.js';

const origin = 'https://brain.example';
// Old links are hash routes; new ones are paths. Both open the path.
const route = '#/spaces/s1/pages/p1';
const path = '/spaces/s1/pages/p1';

afterEach(() => {
    vi.unstubAllGlobals();
});

it('resolves page links in every form the app has written them, to the path', () => {
    for (const href of [
        `/${route}`,
        route,
        `${origin}/${route}`,
        `  /${route}  `,
        path,
        `${origin}${path}`,
        `  ${path}  `,
    ]) {
        expect(resolveLink(href, origin), href).toEqual({ kind: 'page', path });
    }
    expect(resolveLink('/#/spaces/s1', origin)).toEqual({
        kind: 'page',
        path: '/spaces/s1',
    });
    expect(resolveLink('/spaces/s1', origin)).toEqual({
        kind: 'page',
        path: '/spaces/s1',
    });
});

it('resolves issue and chat paths, which have no hash form', () => {
    for (const path of ['/issues/CB-12', '/chats/c1']) {
        for (const href of [path, `${origin}${path}`, `  ${path} `]) {
            expect(resolveLink(href, origin), href).toEqual({ kind: 'page', path });
        }
    }
    for (const href of [
        '/issues',
        '/issues/12',
        '/issues/CB-0',
        '/issues/CB-12/x',
        '/issues/CB-12?x=1',
        '/#/issues/CB-12',
        '/chats',
        '/chats/c1/x',
    ]) {
        expect(resolveLink(href, origin), href).toBeNull();
    }
    expect(legacyHashPath('#/issues/CB-12')).toBeUndefined();
});

it('maps old hash routes to their paths, and nothing else', () => {
    expect(legacyHashPath(route)).toBe(path);
    expect(legacyHashPath('#/spaces/s1')).toBe('/spaces/s1');
    for (const hash of ['', '#', '#section', '#/spaces/', '#/spaces/s1/x', '#/runs']) {
        expect(legacyHashPath(hash), hash).toBeUndefined();
    }
    const at = (pathname: string, hash: string, search = '') => legacyLocationPath({ pathname, hash, search });
    expect(at('/', route)).toBe(path);
    // Only the old app's address (the root) is rewritten.
    expect(at('/spaces/s2', route)).toBeUndefined();
    expect(at('/', route, '?x=1')).toBeUndefined();
});

it('treats absolute http(s) and mailto URLs as external', () => {
    expect(resolveLink('https://example.com/a?b=1#c', origin)).toEqual({
        kind: 'external',
        url: 'https://example.com/a?b=1#c',
    });
    expect(resolveLink('HTTP://Example.com', origin)).toEqual({
        kind: 'external',
        url: 'http://example.com/',
    });
    expect(resolveLink('mailto:team@example.com', origin)).toEqual({
        kind: 'external',
        url: 'mailto:team@example.com',
    });
    // Another app's hash route is just an external page.
    expect(resolveLink(`https://other.example/${route}`, origin)).toEqual({
        kind: 'external',
        url: `https://other.example/${route}`,
    });
});

it('never follows unsafe or ambiguous links', () => {
    for (const href of [
        undefined,
        null,
        '',
        'javascript:alert(1)',
        ' JavaScript:alert(1)',
        'java\tscript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        '//evil.example/x',
        'notes/other.md',
        '/api/workspace',
        '#section',
        `/settings${route}`,
        `/?x=1${route}`,
        // Only Space and page paths are links into the app.
        '/runs',
        '/spaces',
        `${path}/edit`,
        `${path}?x=1`,
        `${path}#heading`,
        `//brain.example${path}`,
    ]) {
        expect(resolveLink(href, origin), String(href)).toBeNull();
    }
});

function stubBrowser() {
    const location = { origin, assign: vi.fn() };
    const open = vi.fn();
    const navigate = vi.fn();
    vi.stubGlobal('location', location);
    vi.stubGlobal('window', { open });
    const unregister = setAppNavigator(navigate);
    return { location, open, navigate, unregister };
}

it('follows a page link with the router, or in a new tab when asked', () => {
    const { location, open, navigate, unregister } = stubBrowser();
    expect(followLink(`/${route}`)).toBe(true);
    expect(followLink(path)).toBe(true);
    expect(navigate.mock.calls).toEqual([[path], [path]]);
    expect(open).not.toHaveBeenCalled();
    expect(followLink(`/${route}`, { newTab: true })).toBe(true);
    expect(open).toHaveBeenCalledWith(`${origin}${path}`, '_blank', 'noopener,noreferrer');
    // Without a router (before it mounts), a link loads the page.
    unregister();
    expect(followLink(route)).toBe(true);
    expect(location.assign).toHaveBeenCalledWith(path);
    expect(navigate).toHaveBeenCalledTimes(2);
});

it('opens external links in a new tab without an opener', () => {
    const { navigate, open, unregister } = stubBrowser();
    expect(followLink('https://example.com/docs')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(navigate).not.toHaveBeenCalled();
    unregister();
});

it('does nothing for a javascript: link', () => {
    const { navigate, open, unregister } = stubBrowser();
    expect(followLink('javascript:alert(1)')).toBe(false);
    expect(followLink('')).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    unregister();
});

it('renders chat links by kind: page routes in the app, external in a new tab, unsafe as text', () => {
    const html = renderToStaticMarkup(
        <ChatTranscript
            messages={[
                {
                    id: 'reply',
                    role: 'assistant',
                    content: `Saved [the page](/${route}). See [docs](https://example.com/docs) and [notes](notes.md).`,
                },
            ]}
            calls={[]}
        />,
    );
    // An old hash link renders as its path.
    expect(html).toContain(`<a href="${path}">the page</a>`);
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(html).toContain('<span>notes</span>');
    expect(html).not.toContain('href="notes.md"');
});

it('opens the right page from old hash links stored in a page', async () => {
    // A page saved before paths, holding both link forms and a foreign one.
    const ws = new WorkspaceStore(testDatabase());
    const spaceId = ws.spaces()[0].id;
    const target = await ws.pages.create(spaceId, { title: 'Target' });
    const stored = await ws.pages.create(spaceId, {
        title: 'Index',
        content: [
            `Old: [target](/#/spaces/${spaceId}/pages/${target.id}).`,
            `Older: [space](#/spaces/${spaceId}).`,
            `New: [target again](/spaces/${spaceId}/pages/${target.id}).`,
            'Elsewhere: [site](https://other.example/#/spaces/x).',
        ].join('\n\n'),
    });
    const links = [...ws.pages.get(spaceId, stored.id).content.matchAll(/\]\(([^)]+)\)/g)].map((match) =>
        resolveLink(match[1], origin),
    );
    ws.close();
    expect(links).toEqual([
        { kind: 'page', path: `/spaces/${spaceId}/pages/${target.id}` },
        { kind: 'page', path: `/spaces/${spaceId}` },
        { kind: 'page', path: `/spaces/${spaceId}/pages/${target.id}` },
        { kind: 'external', url: 'https://other.example/#/spaces/x' },
    ]);
    // The path is the page route's, with the stored ids.
    const page = links[0]?.kind === 'page' ? links[0].path : '';
    expect(matchPath('/spaces/:spaceId/pages/:pageId', page)?.params).toEqual({
        spaceId,
        pageId: target.id,
    });
});
