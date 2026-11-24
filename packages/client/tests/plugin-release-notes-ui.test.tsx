// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { State, WorkspaceState } from '@socio/shared/types';
import type { PluginReleaseNotesResponse, WhatsNewResponse } from '@socio/shared/updates/whats-new';

import { forgetPluginReleaseNotes } from '../src/modules/whats-new/use-plugin-release-notes';
import { forgetWhatsNew } from '../src/modules/whats-new/use-whats-new';

import { createTestRouter } from './helpers/app-router';

// CB-527: plugins' release notes in What's new (a card per plugin the
// server says the person may see) and the once-per-person modal, from
// mocked /api/v1 answers.
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

// Hostile notes: none of it may reach the page as markup or a fetch.
const HOSTILE = [
    'Faster **sync**.',
    '<img src="https://tracker.invalid/pixel.gif" onerror="alert(1)">',
    '<script>alert(1)</script>',
    '![pixel](https://tracker.invalid/p.png)',
    '[run](javascript:alert(1)) [data](data:text/html,hi) [docs](https://docs.example.com/bookings)',
].join('\n\n');

const CARDS: PluginReleaseNotesResponse = {
    apiVersion: 1,
    plugins: [
        {
            id: 'bookings',
            name: 'Reference bookings',
            version: '1.2.0',
            lastSeen: '1.1.0',
            releases: [
                { version: '1.2.0', date: '2026-11-02', title: 'Faster sync', notes: HOSTILE },
                { version: '1.1.0', date: '2026-10-02', notes: 'Older notes.' },
                { version: '1.0.0', date: '2026-09-02', notes: 'First.' },
            ],
        },
    ],
};
const MODAL: WhatsNewResponse = {
    apiVersion: 1,
    show: true,
    workspace: null,
    plugins: [
        {
            id: 'bookings',
            name: 'Reference bookings',
            from: '1.1.0',
            to: '1.2.0',
            releases: [CARDS.plugins[0]!.releases[0]!],
            count: 1,
        },
    ],
};

let modal: WhatsNewResponse;
let seenPosts: unknown[];
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
        return [200, { current: '0.7.0', commit: null, releases: [], nextCursor: null }];
    }
    if (path === '/api/releases/seen') {
        return [200, { lastSeen: '0.7.0' }];
    }
    if (path === '/api/v1/release-notes/plugins') {
        return [200, CARDS];
    }
    if (path === '/api/v1/whats-new') {
        return [200, modal];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    forgetWhatsNew();
    forgetPluginReleaseNotes();
    modal = MODAL;
    seenPosts = [];
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
            takeRecords() {
                return [];
            }
        },
    );
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
        if (init?.method === 'POST' && url.pathname === '/api/v1/whats-new/seen') {
            seenPosts.push(JSON.parse(String(init.body)));
            return Response.json({ apiVersion: 1, show: false, workspace: null, plugins: [] });
        }
        if (init?.method === 'POST') {
            return Response.json({ ok: true });
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
const open = async () => {
    act(() => root.render(<RouterProvider router={createTestRouter('/')} />));
    await until(() => !!host.querySelector('[data-slot="home-recent-link"]'), 'Home');
    await settle();
};
const dialog = () => document.querySelector<HTMLElement>('[data-slot="whats-new-modal"]');

it('shows the modal once, with a section per updated plugin, and saves its dismissal as shown', async () => {
    await open();
    await until(() => !!dialog(), 'the modal');
    const section = dialog()!.querySelector('[data-slot="whats-new-modal-plugin"]')!;
    expect(section.textContent).toContain('Reference bookings');
    expect(section.textContent).toContain('v1.2.0');
    expect(section.textContent).toContain('Faster sync');
    // Nothing on screen names who runs the workspace.
    expect(dialog()!.textContent!.toLowerCase()).not.toContain('operator');
    await act(async () => dialog()!.querySelector<HTMLElement>('[data-slot="whats-new-modal-close"]')!.click());
    await settle();
    expect(dialog()).toBeNull();
    expect(seenPosts).toEqual([{ plugins: { bookings: '1.2.0' } }]);
    // The help button's dot is gone: nothing else new.
    expect(document.querySelector('[data-slot="whats-new-dot"]')).toBeNull();
});

it('shows no modal when the server says nothing changed', async () => {
    modal = { apiVersion: 1, show: false, workspace: null, plugins: [] };
    await open();
    await settle();
    expect(dialog()).toBeNull();
    expect(seenPosts).toEqual([]);
});

it('renders a plugin’s notes sanitized: no raw HTML, no images, no script links', async () => {
    modal = { apiVersion: 1, show: false, workspace: null, plugins: [] };
    await open();
    // The drawer: Help, then What's new.
    const button = document.querySelector<HTMLButtonElement>('[data-slot="help-menu-button"]')!;
    expect(button.getAttribute('aria-label')).toBe('Help (new release)');
    await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const item = document.querySelector<HTMLElement>('[data-slot="whats-new-button"]')!;
    await act(async () => item.click());
    await until(() => !!document.querySelector('[data-slot="plugin-release-card"]'), 'the plugin card');
    const card = document.querySelector<HTMLElement>('[data-slot="plugin-release-card"]')!;
    // Opening What's new marks the plugin's version seen.
    expect(seenPosts).toEqual([{ plugins: { bookings: '1.2.0' } }]);
    // Since last seen (1.1.0): 1.2.0 open; 1.1.0 and 1.0.0 folded away.
    const shown = () =>
        [...card.querySelectorAll<HTMLElement>('[data-slot="plugin-release"]')].map((item) => item.dataset.version);
    expect(shown()).toEqual(['1.2.0']);
    const older = card.querySelector<HTMLButtonElement>('[data-slot="plugin-release-older"]')!;
    expect(older.textContent).toContain('Earlier versions (2)');
    await act(async () => older.click());
    expect(shown()).toEqual(['1.2.0', '1.1.0', '1.0.0']);

    const notes = card.querySelector<HTMLElement>('[data-slot="plugin-notes-markdown"]')!;
    expect(notes.querySelector('strong')?.textContent).toBe('sync');
    expect(notes.querySelector('img, script, iframe, [onerror]')).toBeNull();
    expect(document.querySelector('img[src*="tracker.invalid"], script[src], [onerror]')).toBeNull();
    expect(notes.innerHTML).not.toContain('tracker.invalid');
    const links = [...notes.querySelectorAll('a')];
    expect(
        links.map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('target'), link.rel]),
    ).toEqual([['docs', 'https://docs.example.com/bookings', '_blank', 'noopener noreferrer']]);
    expect(notes.textContent).toContain('run');
    expect(notes.innerHTML).not.toMatch(/javascript:|data:text/);
});
