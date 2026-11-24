// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { State, WorkspaceState } from '@socio/shared/types';
import type { ReleasesResponse, ReleaseSummary } from '@socio/shared/updates/releases';

import { forgetWhatsNew } from '../src/modules/whats-new/use-whats-new';

import { createTestRouter } from './helpers/app-router';

// CB-166: What's new on Home and in the header, from a mocked
// GET /api/releases and the person's last seen release.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const state: State = {
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: false,
};
const workspace: WorkspaceState = {
    user: { id: 'alice', name: 'Alice', role: 'member' },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Manny',
            instructions: 'Helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [{ id: 'c1', dotId: 'd1', ownerId: 'alice', title: 'A plan', createdAt: 1 }],
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
};
const release = (minor: number, day: number): ReleaseSummary => ({
    version: `0.${minor}.0`,
    tag: `v0.${minor}.0`,
    date: `2026-10-${String(day).padStart(2, '0')}`,
    summary: `Release 0.${minor} makes Socio steadier.`,
    highlights: [
        { title: `Highlight one of 0.${minor}`, issue: `CB-${150 + minor}` },
        { title: `Highlight two of 0.${minor}` },
        { title: `Highlight three of 0.${minor}`, issue: 'not a key' },
        { title: `Highlight four of 0.${minor}`, issue: 'CB-1' },
    ],
    url: `/releases/v0.${minor}.0`,
});
// Newest first: 0.7.0 down to 0.1.0, served a page at a time.
const RELEASES = [7, 6, 5, 4, 3, 2, 1].map((minor) => release(minor, 10 + minor));
const page = (url: URL): ReleasesResponse => {
    const limit = Number(url.searchParams.get('limit') ?? RELEASES.length);
    const before = url.searchParams.get('before');
    const start = before ? RELEASES.findIndex((item) => item.tag === before) + 1 : 0;
    const releases = RELEASES.slice(start, start + limit);
    return {
        current: '0.7.0',
        commit: null,
        releases,
        nextCursor: start + limit < RELEASES.length ? releases.at(-1)!.tag : null,
    };
};

// The first page's answer when a test sets one; else `page`.
let releases: [number, unknown] | undefined;
let seen: [number, unknown];
let posted: unknown[];
let viewsPosted: unknown[];
let asked: string[];
// Holds the older pages back until a test lets them go.
let hold: Promise<void> | undefined;
const respond = (url: URL): [number, unknown] => {
    const path = url.pathname;
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    if (path === '/api/releases') {
        return releases && !url.searchParams.has('before') ? releases : [200, page(url)];
    }
    if (path === '/api/releases/seen') {
        return seen;
    }
    return [404, { error: 'Not found.' }];
};

// jsdom has no IntersectionObserver: this one is told what is in view.
const observers = new Set<FakeObserver>();
class FakeObserver {
    elements = new Set<Element>();
    constructor(readonly callback: IntersectionObserverCallback) {
        observers.add(this);
    }
    observe(element: Element) {
        this.elements.add(element);
    }
    unobserve(element: Element) {
        this.elements.delete(element);
    }
    disconnect() {
        observers.delete(this);
    }
    takeRecords() {
        return [];
    }
}
/** Puts `element` in view, `ratio` of it. */
function inView(element: Element, ratio = 1) {
    act(() => {
        for (const observer of [...observers]) {
            if (observer.elements.has(element)) {
                observer.callback(
                    [
                        {
                            target: element,
                            intersectionRatio: ratio,
                            isIntersecting: ratio > 0,
                        } as IntersectionObserverEntry,
                    ],
                    observer as unknown as IntersectionObserver,
                );
            }
        }
    });
}

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    forgetWhatsNew();
    releases = undefined;
    hold = undefined;
    seen = [200, { lastSeen: '0.6.0' }];
    posted = [];
    viewsPosted = [];
    asked = [];
    observers.clear();
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        asked.push(`${url.pathname}${url.search}`);
        if (init?.method === 'POST' && url.pathname === '/api/releases/seen') {
            const body = JSON.parse(String(init.body)) as { version: string };
            posted.push(body);
            return Response.json({ lastSeen: body.version });
        }
        if (init?.method === 'POST' && url.pathname === '/api/releases/views') {
            viewsPosted.push(JSON.parse(String(init.body)));
            return Response.json({ ok: true });
        }
        if (url.searchParams.has('before')) {
            await hold;
        }
        const [status, body] = respond(url);
        return Response.json(body, { status });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
async function openHome() {
    act(() => root.render(<RouterProvider router={createTestRouter('/')} />));
    await until(() => !!host.querySelector('[data-slot="home-recent-link"]'), 'Home');
    // Both answers are in.
    await until(() => asked.includes('/api/releases?limit=5') && asked.includes('/api/releases/seen'), 'the releases');
    await settle();
}
// What's new is in the header's Help menu (CB-308).
const button = () => document.querySelector<HTMLButtonElement>('[data-slot="help-menu-button"]')!;
const openWhatsNew = async () => {
    await act(async () => button().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const item = document.querySelector<HTMLElement>('[data-slot="whats-new-button"]')!;
    expect(item.getAttribute('role')).toBe('menuitem');
    const count = item.querySelector('[data-slot="whats-new-count"]');
    await act(async () => item.click());
    return count?.textContent;
};
const dot = () => document.querySelector('[data-slot="whats-new-dot"]');
const section = () => host.querySelector('[data-slot="home-whats-new"]');
const versions = (within: ParentNode) =>
    [...within.querySelectorAll<HTMLElement>('[data-slot="release-card"]')].map((card) => card.dataset.version);
const end = (within: ParentNode) => within.querySelector('[data-slot="release-feed-end"]');

it('lists the five most recent releases on Home, each linking to its page, with a link to all of them and no further loading (CB-333)', async () => {
    await openHome();
    // The first page, capped at five: Home never grows past it.
    expect(versions(section()!)).toEqual(['0.7.0', '0.6.0', '0.5.0', '0.4.0', '0.3.0']);
    const [newest] = section()!.querySelectorAll<HTMLElement>('[data-slot="release-card"]');
    const link = newest!.querySelector('[data-slot="release-link"]')!;
    expect(link.textContent).toBe('v0.7.0');
    expect(link.getAttribute('href')).toBe('/releases/v0.7.0');
    // The day as released, the same in every time zone.
    expect(newest!.querySelector('time')!.textContent).toBe('Oct 17, 2026');
    expect(newest!.textContent).toContain('Release 0.7 makes Socio steadier.');
    // At most three highlights; only a board key links to its issue, on
    // Socio's own board (CB-381).
    const items = [...newest!.querySelectorAll('li')];
    expect(items.map((item) => item.textContent)).toEqual([
        'Highlight one of 0.7CB-157',
        'Highlight two of 0.7',
        'Highlight three of 0.7',
    ]);
    expect(
        [...newest!.querySelectorAll('[data-slot="release-issue"]')].map((issue) => [
            issue.getAttribute('href'),
            issue.getAttribute('target'),
        ]),
    ).toEqual([['https://brain.ingenioventures.com/issues/CB-157', '_blank']]);
    const all = [...section()!.querySelectorAll('a')].find((anchor) => anchor.textContent === 'All releases')!;
    expect(all.getAttribute('href')).toBe('/releases');
    // Home caps the list: no load-more sentinel, and scrolling never asks
    // for the next page (the header list still does — see the next test).
    expect(end(section()!)).toBeNull();
    asked = [];
    inView(section()!.lastElementChild!);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(asked.filter((path) => path.includes('before='))).toEqual([]);
});

it('shows a dot until the header list is opened, which marks the newest seen and loads more as it scrolls', async () => {
    await openHome();
    expect(dot()).not.toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Help (new release)');
    // The menu counts the releases newer than the last seen (0.6.0).
    expect(await openWhatsNew()).toBe('1');
    const menu = await (async () => {
        await until(() => !!document.querySelector('[data-slot="whats-new-menu"]'), 'the list');
        return document.querySelector('[data-slot="whats-new-menu"]')!;
    })();
    expect(menu.getAttribute('role')).toBe('dialog');
    // Named by its heading.
    const title = document.getElementById(menu.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('What’s new');
    // The header list still loads more as it scrolls (Home no longer does).
    expect(versions(menu)).toEqual(['0.7.0', '0.6.0', '0.5.0', '0.4.0', '0.3.0']);
    expect(end(menu)).not.toBeNull();
    // Near the end, the next page comes, with skeletons meanwhile; then
    // there is no more to ask for.
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    inView(end(menu)!);
    await until(() => asked.includes('/api/releases?limit=5&before=v0.3.0'), 'the next page');
    expect(menu.querySelector('[data-slot="release-card-skeleton"]')).not.toBeNull();
    release();
    await until(() => versions(menu).length === 7, 'the older releases');
    expect(versions(menu).slice(5)).toEqual(['0.2.0', '0.1.0']);
    expect(menu.querySelector('[data-slot="release-card-skeleton"]')).toBeNull();
    expect(end(menu)).toBeNull();
    expect(posted).toEqual([{ version: '0.7.0' }]);
    expect(dot()).toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Help');
    // Opening it again posts nothing more, and counts none.
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(await openWhatsNew()).toBeUndefined();
    expect(posted).toEqual([{ version: '0.7.0' }]);
});

it('puts Help and guides, What’s new, Keyboard shortcuts and the theme in one Help menu; “?” opens the shortcuts (CB-308)', async () => {
    await openHome();
    const header = document.querySelector('[data-slot="app-header"]')!;
    // Ask a socio keeps its own button; the theme and What’s new have none.
    expect(header.querySelector('[aria-label="Ask a socio"]')).not.toBeNull();
    expect(header.querySelector('[aria-label^="Theme"]')).toBeNull();
    expect(header.querySelector('[aria-label^="What’s new"]')).toBeNull();
    await act(async () => button().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const menu = document.querySelector('[data-slot="help-menu"]')!;
    expect(
        [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.replace(/\d+$/, '')),
    ).toEqual(['Help and guides', 'What’s new', 'Keyboard shortcuts?']);
    expect([...menu.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
        'Light',
        'Dark',
        'System',
    ]);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    // "?" from the page opens the shortcuts; typed in a field it doesn't.
    const field = document.createElement('input');
    document.body.append(field);
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })));
    expect(document.querySelector('[data-slot="shortcuts-dialog"]')).toBeNull();
    field.remove();
    act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })));
    const dialog = document.querySelector('[data-slot="shortcuts-dialog"]')!;
    expect(dialog.textContent).toContain('Keyboard shortcuts');
    expect(dialog.textContent).toContain('SearchCtrl K');
    expect(dialog.textContent).toContain('Ask a socioCtrl J');
});

it('takes a new person as having seen the running version', async () => {
    seen = [200, { lastSeen: null }];
    releases = [200, { ...page(new URL('http://app.test/?limit=5')), current: '0.6.0' }];
    await openHome();
    expect(posted).toEqual([{ version: '0.6.0' }]);
    // 0.7.0 is after the version they started on: new to them.
    expect(dot()).not.toBeNull();
    act(() => root.unmount());
    forgetWhatsNew();
    posted = [];
    asked = [];
    root = createRoot(host);
    releases = undefined;
    await openHome();
    expect(posted).toEqual([{ version: '0.7.0' }]);
    expect(dot()).toBeNull();
});

it('hides What’s new quietly when the releases can’t be read', async () => {
    for (const answer of [
        [500, { error: 'Broken.' }],
        [404, { error: 'Not found.' }],
        [200, { current: '0.7.0', releases: [] }],
        [200, { nonsense: true }],
    ] as [number, unknown][]) {
        act(() => root.unmount());
        forgetWhatsNew();
        root = createRoot(host);
        releases = answer;
        asked = [];
        await openHome();
        expect(section(), JSON.stringify(answer)).toBeNull();
        expect(dot()).toBeNull();
        // Home is all there.
        expect(host.querySelector('[data-slot="dot-card"]')).not.toBeNull();
    }
    // The seen answer failing leaves no dot either.
    act(() => root.unmount());
    forgetWhatsNew();
    root = createRoot(host);
    releases = undefined;
    seen = [500, { error: 'Broken.' }];
    asked = [];
    await openHome();
    expect(section()).not.toBeNull();
    expect(dot()).toBeNull();
});

it('records the releases a person was shown, in batches, once each', async () => {
    await openHome();
    const card = (version: string) => section()!.querySelector(`[data-version="${version}"]`)!;
    // Half in view for a second: seen. Less, or not as long: not yet.
    inView(card('0.7.0'), 0.6);
    inView(card('0.6.0'), 0.6);
    inView(card('0.5.0'), 0.3);
    inView(card('0.4.0'), 0.8);
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    inView(card('0.4.0'), 0);
    await until(() => viewsPosted.length > 0, 'the views');
    expect(viewsPosted).toEqual([{ versions: ['0.7.0', '0.6.0'] }]);
    // Shown again: nothing more to send.
    inView(card('0.7.0'), 1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 3_200)));
    expect(viewsPosted).toHaveLength(1);
});
