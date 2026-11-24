// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PageSummary } from '@socio/shared/pages/page-library';
import type { PageSearchResult } from '@socio/shared/pages/page-search';
import type { Space } from '@socio/shared/types';

import { SpaceLibrary } from '../src/modules/spaces/SpaceLibrary';

// The Space library's search box asks the server.
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
const DAY = 86_400_000;
let root: Root;
let host: HTMLElement;
let calls: Array<{ method: string; url: URL }>;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        calls.push({ method: init?.method ?? 'GET', url });
        const q = url.searchParams.get('q');
        const fixed = q === 'invioce' && url.searchParams.get('exact') !== 'true';
        const body: PageSearchResult | null =
            url.pathname === '/api/spaces/search'
                ? {
                      query: q ?? '',
                      corrected: fixed ? 'invoice' : null,
                      more: false,
                      results:
                          q === 'invo' || fixed
                              ? [
                                    {
                                        id: 'p2',
                                        spaceId: 'space',
                                        title: 'Billing',
                                        updatedAt: 1,
                                        matched: 'word',
                                        snippet: [
                                            { text: 'Send the ', match: false },
                                            { text: 'invoice', match: true },
                                        ],
                                        freshness: { basis: 'used', at: Date.now() - DAY },
                                    },
                                ]
                              : [],
                  }
                : null;
        return new Response(body ? JSON.stringify(body) : null, {
            status: body ? 200 : 204,
        });
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

it('searches the Space on the server and marks the matched words', async () => {
    const page = (id: string, title: string, content: string) =>
        ({
            id,
            spaceId: 'space',
            parentId: null,
            title,
            excerpt: content,
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
        }) as unknown as PageSummary;
    const opened: string[] = [];
    act(() =>
        root.render(
            <SpaceLibrary
                space={{ id: 'space', name: 'Team' } as Space}
                pages={[page('p1', 'Roadmap', 'Plans.'), page('p2', 'Billing', 'Send the invoice.')]}
                onPage={(id) => opened.push(id)}
                onNew={() => {}}
                onDeleted={() => {}}
            />,
        ),
    );
    const input = host.querySelector<HTMLInputElement>('[aria-label="Search pages"]')!;
    // One letter: the pages it has, by title and text, as before.
    await type(input, 'r');
    expect(host.textContent).toContain('Roadmap');
    expect(calls).toEqual([]);
    // Two or more: the server, for this Space.
    await type(input, 'invo');
    await until(() => host.textContent!.includes('Searching pages…'), 'waiting');
    await until(() => !!host.querySelector('[data-slot="library-snippet"] mark'), 'the hit');
    expect(calls.map(({ url }) => url.searchParams.get('space'))).toEqual(['space']);
    expect(host.querySelector('[data-slot="library-snippet"]')?.textContent).toBe('Send the invoice');
    expect(host.querySelector('[data-slot="library-freshness"]')?.textContent).toBe('Used this week');
    expect(host.textContent).not.toContain('Roadmap');
    // Opening a hit counts as a use.
    act(() => host.querySelector<HTMLElement>('[data-slot="library-page-card"]')!.click());
    expect(opened).toEqual(['p2']);
    await until(() => calls.some((call) => call.method === 'POST'), 'the use');
    expect(calls.find((call) => call.method === 'POST')!.url.pathname).toBe('/api/spaces/space/pages/p2/used');
    // A correction, and the words as typed instead.
    await type(input, 'invioce');
    await until(() => !!host.querySelector('[data-slot="library-correction"]'), 'the correction');
    expect(host.querySelector('[data-slot="library-correction"]')?.textContent).toBe(
        'Showing results for invoice. Search instead for invioce',
    );
    act(() => host.querySelector<HTMLElement>('[data-slot="library-correction"] button')!.click());
    await until(() => calls.some((call) => call.url.searchParams.get('exact') === 'true'), 'the exact search');
    await until(() => host.textContent!.includes('No matching pages'), 'nothing found');
});
