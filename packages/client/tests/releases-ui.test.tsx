// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import type { Release, ReleasesResponse } from '@socio/shared/updates/releases';

import { ReleasesPage } from '../src/views/ReleasesPage';

// CB-168: the release notes page, newest first, with the asked-for
// release's full notes open and issue keys linked.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host?.textContent}`);
}

const release = (version: string, date: string, issue: string): Release => ({
    version,
    tag: `v${version}`,
    date,
    summary: `What v${version} brings.`,
    highlights: [{ title: `The best of v${version}`, issue }],
    url: `/releases/v${version}`,
    notesMarkdown: `### Fixed\n\n- **A fix (${issue}).** See \`CB-1\` in code.`,
});
const RELEASES = [release('0.6.1', '2026-10-22', 'CB-157'), release('0.5.0', '2026-10-21', 'CB-146')];

function serve() {
    const asked: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            asked.push(url);
            const path = new URL(url, 'http://app.test').pathname;
            const found =
                path === '/api/releases'
                    ? ({
                          current: '0.6.1',
                          commit: 'eb7d6e8',
                          releases: RELEASES.map(({ notesMarkdown: _notes, ...summary }) => summary),
                      } satisfies ReleasesResponse)
                    : RELEASES.find((item) => path === `/api/releases/${item.tag}`);
            return Promise.resolve(
                new Response(JSON.stringify(found ?? { error: 'No such release.' }), {
                    status: found ? 200 : 404,
                }),
            );
        }),
    );
    return asked;
}

function mount(tag?: string) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
        root!.render(
            <MemoryRouter>
                <ReleasesPage tag={tag} />
            </MemoryRouter>,
        ),
    );
}

const card = (tag: string) => host!.querySelector<HTMLElement>(`[data-release="${tag}"]`)!;

it('lists the releases newest first and opens the newest one’s notes', async () => {
    const asked = serve();
    mount();
    await until(() => !!host!.querySelector('[data-release]'), 'the releases');
    expect([...host!.querySelectorAll('[data-release]')].map((item) => item.getAttribute('data-release'))).toEqual([
        'v0.6.1',
        'v0.5.0',
    ]);
    expect(host!.textContent).toContain('You’re on v0.6.1 (eb7d6e8)');
    expect(card('v0.6.1').textContent).toContain('Current');
    expect(card('v0.6.1').textContent).toContain('Oct 22, 2026');
    expect(card('v0.6.1').textContent).toContain('What v0.6.1 brings.');
    // The highlight's issue links to it, on Socio's own board, in a new tab
    // (CB-381): this instance's CB-157 is another issue.
    const highlight = card('v0.6.1').querySelector<HTMLAnchorElement>('ul[aria-label="v0.6.1 highlights"] a')!;
    expect(highlight.getAttribute('href')).toBe('https://brain.ingenioventures.com/issues/CB-157');
    expect(highlight.getAttribute('target')).toBe('_blank');
    expect(highlight.getAttribute('rel')).toBe('noopener noreferrer');
    // The newest one's notes load; issue keys in them link, not in code.
    await until(() => !!card('v0.6.1').querySelector('[data-slot="release-notes"] h3'), 'the notes');
    const links = [...card('v0.6.1').querySelectorAll('[data-slot="release-notes"] a')].map((link) =>
        link.getAttribute('href'),
    );
    expect(links).toEqual(['https://brain.ingenioventures.com/issues/CB-157']);
    expect(card('v0.6.1').querySelector('[data-slot="release-notes"] a')!.getAttribute('target')).toBe('_blank');
    expect(card('v0.5.0').querySelector('[data-slot="release-notes"]')).toBe(null);
    expect(asked).not.toContain('/api/releases/v0.5.0');
    // Opening another loads its notes.
    const toggle = [...card('v0.5.0').querySelectorAll('button')].find(
        (button) => button.textContent === 'Full notes',
    )!;
    act(() => toggle.click());
    await until(() => !!card('v0.5.0').querySelector('[data-slot="release-notes"] h3'), 'v0.5.0’s notes');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
});

it('opens at the release asked for, and says when there is none', async () => {
    serve();
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.id);
    };
    mount('v0.5.0');
    await until(() => !!card('v0.5.0')?.querySelector('[data-slot="release-notes"] h3'), 'v0.5.0’s notes');
    expect(scrolled).toContain('v0.5.0');
    expect(card('v0.6.1').querySelector('[data-slot="release-notes"]')).toBe(null);
    act(() => root!.unmount());
    host!.remove();
    mount('v9.9.9');
    await until(() => !!host!.querySelector('[role="status"]'), 'the notice');
    expect(host!.textContent).toContain('There is no release v9.9.9.');
});

// The list pages implicitly: the first page, then the next as the end
// scrolls near (or from Load more), by the server's cursor, until every
// release is there.

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
function inView(element: Element) {
    act(() => {
        for (const observer of [...observers]) {
            if (observer.elements.has(element)) {
                observer.callback(
                    [{ target: element, intersectionRatio: 1, isIntersecting: true } as IntersectionObserverEntry],
                    observer as unknown as IntersectionObserver,
                );
            }
        }
    });
}

/** 25 releases, newest first, paged by `limit` and `before` as the server does. */
function servePaged({ failOnce }: { failOnce?: string } = {}) {
    let failing = failOnce;
    const all = Array.from({ length: 25 }, (_, index) => release(`0.${25 - index}.0`, '2026-10-21', 'CB-1'));
    const asked: string[] = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            asked.push(url);
            if (url === failing) {
                failing = undefined;
                return Promise.resolve(new Response(JSON.stringify({ error: 'Try later.' }), { status: 503 }));
            }
            const { pathname, searchParams } = new URL(url, 'http://app.test');
            let found: unknown;
            if (pathname === '/api/releases') {
                const limit = Number(searchParams.get('limit') ?? all.length);
                const before = searchParams.get('before');
                const start = before ? all.findIndex((item) => item.tag === before) + 1 : 0;
                const page = all.slice(start, start + limit);
                found = {
                    current: '0.25.0',
                    commit: null,
                    releases: page.map(({ notesMarkdown: _notes, ...summary }) => summary),
                    nextCursor: start + limit < all.length ? page.at(-1)!.tag : null,
                } satisfies ReleasesResponse;
            } else {
                found = all.find((item) => pathname === `/api/releases/${item.tag}`);
            }
            return Promise.resolve(
                new Response(JSON.stringify(found ?? { error: 'No such release.' }), { status: found ? 200 : 404 }),
            );
        }),
    );
    return { all, asked };
}

const shownTags = () => [...host!.querySelectorAll('[data-release]')].map((item) => item.getAttribute('data-release'));
const end = () => host!.querySelector('[data-slot="releases-end"]');

it('loads a page at a time as the end scrolls near, until every release is there', async () => {
    const { all, asked } = servePaged();
    mount();
    await until(() => shownTags().length === 10, 'the first page');
    expect(asked.filter((url) => url.startsWith('/api/releases?'))).toEqual(['/api/releases?limit=10']);
    // The end comes into view: the next page, from the last one's cursor.
    await until(() => !!end(), 'the end of the list');
    inView(end()!);
    await until(() => shownTags().length === 20, 'the second page');
    expect(asked).toContain('/api/releases?limit=10&before=v0.16.0');
    // Load more does the same from the keyboard.
    await until(() => !!end(), 'the end of the list');
    const more = [...host!.querySelectorAll('button')].find((button) => button.textContent === 'Load more')!;
    act(() => more.click());
    await until(() => shownTags().length === 25, 'the last page');
    expect(shownTags()).toEqual(all.map((item) => item.tag));
    // Nothing more to ask for.
    expect(end()).toBe(null);
    expect([...host!.querySelectorAll('button')].some((button) => button.textContent === 'Load more')).toBe(false);
    expect(asked.filter((url) => url.startsWith('/api/releases?'))).toHaveLength(3);
});

it('loads the pages up to a release asked for further down, and opens it', async () => {
    const { asked } = servePaged();
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.id);
    };
    mount('v0.1.0');
    await until(() => !!card('v0.1.0')?.querySelector('[data-slot="release-notes"] h3'), 'v0.1.0’s notes');
    expect(scrolled).toContain('v0.1.0');
    expect(shownTags()).toHaveLength(25);
    // Only the asked-for release's notes open, not the newest's.
    expect(card('v0.25.0').querySelector('[data-slot="release-notes"]')).toBe(null);
    expect(asked).not.toContain('/api/releases/v0.25.0');
    act(() => root!.unmount());
    host!.remove();
    // One there isn't: every page loads, then the page says so.
    mount('v9.9.9');
    await until(() => !!host!.querySelector('[role="status"]'), 'the notice');
    expect(shownTags()).toHaveLength(25);
    expect(host!.textContent).toContain('There is no release v9.9.9.');
});

it('keeps the newest closed while a page up to the asked-for release fails, then opens it on retry', async () => {
    const { asked } = servePaged({ failOnce: '/api/releases?limit=10&before=v0.16.0' });
    Element.prototype.scrollIntoView = () => {};
    mount('v0.1.0');
    await until(() => !!host!.querySelector('[role="alert"]'), 'the failed page');
    expect(shownTags()).toHaveLength(10);
    // The asked-for release may still come: the newest's notes stay closed.
    expect(card('v0.25.0').querySelector('[data-slot="release-notes"]')).toBe(null);
    expect(host!.querySelector('[role="status"]')).toBe(null);
    const retry = [...host!.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!;
    act(() => retry.click());
    await until(() => !!card('v0.1.0')?.querySelector('[data-slot="release-notes"] h3'), 'v0.1.0’s notes');
    expect(shownTags()).toHaveLength(25);
    expect(card('v0.25.0').querySelector('[data-slot="release-notes"]')).toBe(null);
    expect(asked).not.toContain('/api/releases/v0.25.0');
});

it('drops a stale first page in StrictMode, when answers land out of order', async () => {
    const all = Array.from({ length: 25 }, (_, index) => release(`0.${25 - index}.0`, '2026-10-21', 'CB-1'));
    const page = (before: string | null) => {
        const start = before ? all.findIndex((item) => item.tag === before) + 1 : 0;
        const slice = all.slice(start, start + 10);
        return {
            current: '0.25.0',
            commit: null,
            releases: slice.map(({ notesMarkdown: _notes, ...summary }) => summary),
            nextCursor: start + 10 < all.length ? slice.at(-1)!.tag : null,
        } satisfies ReleasesResponse;
    };
    // Every list request waits until the test answers it.
    const waiting: { url: string; answer: () => void }[] = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            const { pathname, searchParams } = new URL(url, 'http://app.test');
            if (pathname !== '/api/releases') {
                const found = all.find((item) => pathname === `/api/releases/${item.tag}`);
                return Promise.resolve(new Response(JSON.stringify(found), { status: 200 }));
            }
            return new Promise<Response>((resolve) => {
                waiting.push({
                    url,
                    answer: () => resolve(new Response(JSON.stringify(page(searchParams.get('before'))))),
                });
            });
        }),
    );
    const answer = async (url: string, which: 'first' | 'last' = 'first') => {
        await until(() => waiting.some((item) => item.url === url), url);
        const matches = waiting.filter((item) => item.url === url);
        const pick = which === 'first' ? matches[0]! : matches.at(-1)!;
        waiting.splice(waiting.indexOf(pick), 1);
        await act(async () => pick.answer());
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
        root!.render(
            <StrictMode>
                <MemoryRouter>
                    <ReleasesPage />
                </MemoryRouter>
            </StrictMode>,
        ),
    );
    // StrictMode replays the effect: two first-page requests, the first stale.
    await until(() => waiting.filter((item) => item.url === '/api/releases?limit=10').length === 2, 'both');
    await answer('/api/releases?limit=10', 'last');
    await until(() => shownTags().length === 10, 'the first page');
    // The second page lands; the third is on its way.
    await until(() => !!end(), 'the end of the list');
    inView(end()!);
    await answer('/api/releases?limit=10&before=v0.16.0');
    await until(() => shownTags().length === 20, 'the second page');
    await until(() => !!end(), 'the end of the list');
    inView(end()!);
    await until(() => waiting.some((item) => item.url.endsWith('before=v0.6.0')), 'the third page asked');
    // Now the stale first page lands: it changes nothing.
    await answer('/api/releases?limit=10');
    expect(shownTags()).toHaveLength(20);
    await answer('/api/releases?limit=10&before=v0.6.0');
    await until(() => shownTags().length === 25, 'the last page');
    expect(shownTags()).toEqual(all.map((item) => item.tag));
    expect(end()).toBe(null);
});
