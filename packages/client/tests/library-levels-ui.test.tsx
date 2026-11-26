// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PageSummary } from '@socio/shared/pages/page-library';
import type { PageSearchResult } from '@socio/shared/pages/page-search';
import type { Space } from '@socio/shared/types';

import { SpaceLibrary } from '../src/modules/spaces/SpaceLibrary';

Element.prototype.scrollIntoView ??= () => {};

// The Space library browses one level of the page tree at a time (CB-426).
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
let root: Root;
let host: HTMLElement;
let searchResults: PageSearchResult['results'];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    searchResults = [];
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input, 'http://app.test');
        if (url.pathname !== '/api/spaces/search') {
            return new Response(null, { status: 404 });
        }
        return Response.json({
            query: url.searchParams.get('q') ?? '',
            corrected: null,
            more: false,
            results: searchResults,
        } satisfies PageSearchResult);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
async function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function page(id: string, title: string, parentId: string | null = null, updatedAt = 1): PageSummary {
    return {
        id,
        spaceId: 'space',
        parentId,
        title,
        excerpt: `${title} body.`,
        revision: 1,
        createdAt: 1,
        updatedAt,
        sourceThreadId: null,
        createdBy: null,
        cover: null,
    };
}

// The tree from the reports: a policies page with pages inside, one of them with its own.
const tree = () => [
    page('policies', 'Policies and SOPs', null, 9),
    page('vendors', 'Vendor list', 'policies', 8),
    page('it', 'IT vendor', 'vendors', 7),
    page('cleaning', 'Cleaning vendor', 'vendors', 6),
    page('invoices', 'Submit invoices', 'policies', 5),
    page('welcome', 'Welcome', null, 4),
];

const titles = () => [...host.querySelectorAll('[data-slot="library-page-card"] h3')].map((el) => el.textContent);
const card = (title: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('[data-slot="library-page-card"]')].find(
        (el) => el.querySelector('h3')?.textContent === title,
    )!;
const heading = () => host.querySelector('[data-slot="library-count"]')!.textContent;
const trail = () => host.querySelector('nav[aria-label="Library level"]');
const click = (el: Element) => act(() => (el as HTMLElement).click());

function render(
    pages: PageSummary[],
    props: { total?: number; onPage?: (id: string) => void; onNew?: (parentId: string | null) => void } = {},
) {
    act(() =>
        root.render(
            <SpaceLibrary
                space={{ id: 'space', name: 'Operations' } as Space}
                pages={pages}
                total={props.total}
                onPage={props.onPage ?? (() => {})}
                onNew={props.onNew ?? (() => {})}
                onDeleted={() => {}}
            />,
        ),
    );
}

function choose(label: string, option: string) {
    const select = host.querySelector(`[role="combobox"][aria-label="${label}"]`)!;
    act(() =>
        select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })),
    );
    const item = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent === option)!;
    act(() => item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
}

it('shows only the top level, and a page with pages inside opens its level', () => {
    const onPage = vi.fn();
    render(tree(), { onPage });
    expect(titles()).toEqual(['Policies and SOPs', 'Welcome']);
    expect(heading()).toContain('Top level');
    expect(heading()).toContain('2');
    expect(card('Policies and SOPs').querySelector('[data-slot="library-inside"]')?.textContent).toBe('2 inside');
    expect(card('Welcome').querySelector('[data-slot="library-inside"]')).toBeNull();

    click(card('Policies and SOPs'));
    expect(onPage).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Vendor list', 'Submit invoices']);
    expect(heading()).toContain('Inside this page');
    expect(trail()?.textContent).toContain('Top level');
    expect(trail()?.querySelector('[aria-current="location"]')?.textContent).toBe('Policies and SOPs');

    click(card('Vendor list'));
    expect(titles()).toEqual(['IT vendor', 'Cleaning vendor']);
    // The trail returns to any ancestor, and to the top.
    const back = [...trail()!.querySelectorAll('button')].find((el) => el.textContent === 'Policies and SOPs')!;
    click(back);
    expect(titles()).toEqual(['Vendor list', 'Submit invoices']);

    // A page with nothing inside opens as before.
    click(card('Submit invoices'));
    expect(onPage).toHaveBeenCalledWith('invoices');

    const top = [...trail()!.querySelectorAll('button')].find((el) => el.textContent === 'Top level')!;
    click(top);
    expect(titles()).toEqual(['Policies and SOPs', 'Welcome']);
    expect(trail()).toBeNull();
});

it("opens the level's own page from the trail and creates new pages inside the level", () => {
    const onPage = vi.fn();
    const onNew = vi.fn();
    render(tree(), { onPage, onNew });
    const newPage = () => [...host.querySelectorAll('button')].find((el) => el.textContent?.trim() === 'New page')!;
    click(newPage());
    expect(onNew).toHaveBeenLastCalledWith(null);

    click(card('Policies and SOPs'));
    click(newPage());
    expect(onNew).toHaveBeenLastCalledWith('policies');
    const open = [...trail()!.querySelectorAll('button')].find((el) => el.textContent?.includes('Open page'))!;
    click(open);
    expect(onPage).toHaveBeenCalledWith('policies');

    // In All pages, a new page goes at the top level, as before.
    choose('Browse pages', 'All pages');
    click(newPage());
    expect(onNew).toHaveBeenLastCalledWith(null);
});

it('keeps All pages as an option: every page, each with its path', () => {
    render(tree());
    choose('Browse pages', 'All pages');
    expect(heading()).toContain('All pages');
    expect(titles()).toHaveLength(6);
    const path = (title: string) => card(title).querySelector('[aria-label="Parent pages"]')?.textContent;
    expect(path('IT vendor')).toBe('Policies and SOPs › Vendor list');
    expect(path('Welcome')).toBeUndefined();
    // No level marker in the flat list: every page opens itself.
    expect(host.querySelector('[data-slot="library-inside"]')).toBeNull();
});

it('never hides a page: one whose parent is missing or in a cycle is at the top level', () => {
    render([
        page('orphan', 'Orphan', 'gone'),
        page('a', 'Loop A', 'b'),
        page('b', 'Loop B', 'a'),
        page('top', 'Top', null),
    ]);
    expect(titles()).toEqual(expect.arrayContaining(['Orphan', 'Loop A', 'Loop B', 'Top']));
    expect(titles()).toHaveLength(4);
});

it('shows only pages with no parent while the first screen is all that has loaded', () => {
    // The first screen lacks Policies, so it can't place Vendor list yet; it doesn't guess.
    render([page('vendors', 'Vendor list', 'policies'), page('welcome', 'Welcome')], { total: 40 });
    expect(titles()).toEqual(['Welcome']);
});

it('searches the whole Space and names each result’s path', async () => {
    const pages = tree();
    searchResults = [
        {
            id: 'it',
            spaceId: 'space',
            title: 'IT vendor',
            updatedAt: 7,
            matched: 'word',
            snippet: [{ text: 'vendor', match: true }],
            freshness: { basis: 'edited', at: 7 },
        },
    ];
    render(pages);
    // From inside a level, too.
    click(card('Policies and SOPs'));
    await type(host.querySelector<HTMLInputElement>('[aria-label="Search pages"]')!, 'vendor');
    await until(() => titles().length === 1, 'the search result');
    expect(heading()).toContain('Search results');
    expect(card('IT vendor').querySelector('[aria-label="Parent pages"]')?.textContent).toBe(
        'Policies and SOPs › Vendor list',
    );
    expect(trail()).toBeNull();
});
