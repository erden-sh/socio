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
        folder: false,
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
    props: {
        total?: number;
        onPage?: (id: string) => void;
        onNew?: (parentId: string | null) => void;
        onNewFolder?: (parentId: string | null, title: string) => Promise<unknown>;
    } = {},
) {
    act(() =>
        root.render(
            <SpaceLibrary
                space={{ id: 'space', name: 'Operations' } as Space}
                pages={pages}
                total={props.total}
                onPage={props.onPage ?? (() => {})}
                onNew={props.onNew ?? (() => {})}
                onNewFolder={props.onNewFolder}
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

// Folders (CB-426): a page marked as a folder, shown as a container.
const folder = (id: string, title: string, parentId: string | null = null, updatedAt = 1): PageSummary => ({
    ...page(id, title, parentId, updatedAt),
    excerpt: '',
    folder: true,
});
const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === name);
const folderLine = (title: string) => card(title).querySelector('[data-slot="library-folder"]')?.textContent;

it('shows folders as folders and opens one to its level, even empty', () => {
    const onPage = vi.fn();
    render(
        [folder('projects', 'Projects', null, 9), page('plan', 'Plan', 'projects'), folder('empty', 'Empty', null, 2)],
        {
            onPage,
        },
    );
    expect(titles()).toEqual(['Projects', 'Empty']);
    // A folder card says what it holds where a page shows its text.
    expect(folderLine('Projects')).toBe('Folder · 1 inside');
    expect(folderLine('Empty')).toBe('Empty folder');
    expect(card('Projects').querySelector('svg.lucide-folder')).not.toBeNull();
    expect(card('Projects').querySelector('[data-slot="library-inside"]')).toBeNull();

    click(card('Empty'));
    expect(onPage).not.toHaveBeenCalled();
    expect(heading()).toContain('In this folder');
    expect(trail()?.querySelector('[aria-current="location"]')?.textContent).toBe('Empty');
    expect(host.textContent).toContain('This folder is empty');
    // The trail's button opens the folder's own page.
    click([...trail()!.querySelectorAll('button')].find((el) => el.textContent?.includes('Open folder'))!);
    expect(onPage).toHaveBeenCalledWith('empty');
});

it('opens a folder from All pages at its level', () => {
    render([folder('projects', 'Projects'), page('plan', 'Plan', 'projects'), page('welcome', 'Welcome')]);
    choose('Browse pages', 'All pages');
    expect(titles()).toHaveLength(3);
    expect(folderLine('Projects')).toBe('Folder · 1 inside');
    click(card('Projects'));
    expect(heading()).toContain('In this folder');
    expect(titles()).toEqual(['Plan']);
});

it('asks a new folder’s name and makes it inside the level', async () => {
    const onNewFolder = vi.fn(async () => undefined);
    render(tree(), { onNewFolder });
    click(card('Policies and SOPs'));
    click(button('New folder')!);
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    await until(() => !!dialog(), 'the name dialog');
    const create = () => button('Create folder', dialog()!)!;
    expect(create().disabled).toBe(true);
    await type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!, '  Contracts ');
    click(create());
    await until(() => !dialog(), 'the dialog to close');
    expect(onNewFolder).toHaveBeenCalledWith('policies', 'Contracts');

    // From an empty level's own button, and a refusal keeps the dialog with its reason.
    onNewFolder.mockRejectedValueOnce(new Error('Pages require a title.'));
    render([folder('empty', 'Empty')], { onNewFolder });
    click(card('Empty'));
    // The header's, and the empty level's under it.
    const both = [...host.querySelectorAll('button')].filter((el) => el.textContent?.trim() === 'New folder');
    expect(both).toHaveLength(2);
    click(both[1]!);
    await until(() => !!dialog(), 'the name dialog again');
    await type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Folder name"]')!, 'Inner');
    click(create());
    await until(() => !!dialog()?.querySelector('[role="alert"]'), 'the refusal');
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe('Pages require a title.');
    expect(onNewFolder).toHaveBeenLastCalledWith('empty', 'Inner');
});
