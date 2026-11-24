// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { EpisodesState, MemoriesState, MemoryItem } from '@socio/shared/memory';
import type { Detail, State, Task } from '@socio/shared/types';

import { ActivityPage } from '../src/modules/activity/ActivityPage';
import { MemoriesPage } from '../src/modules/memories/MemoriesPage';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Radix checkboxes (the memory editor's) measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const task = (fields: Partial<Task> = {}): Task => ({
    id: 'one',
    prompt: 'Summarise competitor pricing',
    status: 'completed',
    intervalSeconds: 3600,
    nextRunAt: Date.now() + 3600_000,
    createdAt: 1,
    updatedAt: Date.now(),
    error: null,
    lease: null,
    leaseUntil: null,
    ...fields,
});
// Legacy classes these views used (CB-95): none may come back.
const legacy = new Set([
    'search-box',
    'task-list',
    'task-row',
    'task-row-icon',
    'status',
    'large-empty',
    'task-detail-card',
    'task-controls',
    'quiet-button',
    'chat-error',
    'muted',
    'spin',
    'memory-grid',
    'memory-card',
    'icon-button',
    'primary',
]);
const noLegacy = () => {
    for (const element of host.querySelectorAll('[class]')) {
        for (const name of element.classList) {
            expect(legacy.has(name), name).toBe(false);
        }
    }
};

let root: Root;
let host: HTMLElement;
let calls: { method: string; path: string; search?: string; body?: string }[];
let memories: MemoriesState;
let episodes: EpisodesState;
let shell: Shell;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    memories = { profile: null, memories: [], proposals: [] };
    episodes = { episodes: [], total: 0, retentionDays: 180 };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        calls.push({
            method: init?.method ?? 'GET',
            path: url.pathname,
            search: url.search,
            body: typeof init?.body === 'string' ? init.body : undefined,
        });
        // CB-180: the page's episodes, searched by `q`.
        if (url.pathname === '/api/memories/episodes' && (init?.method ?? 'GET') === 'GET') {
            const q = url.searchParams.get('q')?.toLowerCase();
            return Response.json({
                ...episodes,
                episodes: episodes.episodes.filter((episode) => !q || episode.text.toLowerCase().includes(q)),
            });
        }
        if (url.pathname.startsWith('/api/memories')) {
            return Response.json((init?.method ?? 'GET') === 'GET' ? memories : { ok: true });
        }
        const detail: Detail = {
            task: task({ error: 'The model was busy.' }),
            events: [
                { id: 'e1', taskId: 'one', kind: 'status', text: 'Queued.', at: 1 },
                { id: 'e2', taskId: 'one', kind: 'status', text: 'Done.', at: 2 },
            ],
            runs: [],
        } as unknown as Detail;
        return new Response(JSON.stringify(detail), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

function render(node: ReactNode, state: Partial<State>) {
    shell = {
        state: {
            settings: {
                name: 'Dot',
                paused: false,
                researchAllowed: true,
                memoryAllowed: true,
            },
            tasks: [],
            memories: [],
            ...state,
        },
        workspace: {
            dots: [{ id: 'd1', name: 'Mingo' }],
            conversations: [{ id: 't1', title: 'Planning' }],
        },
        busy: false,
        mutate: vi.fn(async () => true),
        setError: vi.fn(),
        openDialog: vi.fn(),
    } as unknown as Shell;
    act(() =>
        root.render(
            <ShellContext.Provider value={shell}>
                <MemoryRouter>{node}</MemoryRouter>
            </ShellContext.Provider>,
        ),
    );
}
async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const buttons = () => [...host.querySelectorAll('button')];

it('lists tasks, filters them and opens one in a card with its actions', async () => {
    render(<ActivityPage />, {
        tasks: [
            task(),
            task({
                id: 'two',
                prompt: 'Draft the checklist',
                status: 'running',
                intervalSeconds: null,
                nextRunAt: null,
            }),
        ],
    });
    const rows = () => [...host.querySelectorAll('[data-slot="task-row"]')];
    expect(rows().map((row) => row.textContent)).toEqual([
        expect.stringMatching(/Summarise competitor pricingRepeats every 1 hr/),
        expect.stringMatching(/Draft the checklist/),
    ]);
    expect(
        [...host.querySelectorAll('[data-slot="task-status"]')].map((chip) => [
            chip.getAttribute('data-status'),
            chip.textContent,
        ]),
    ).toEqual([
        ['completed', 'Scheduled'],
        ['running', 'Running'],
    ]);
    // The search box is the shadcn Input, 16px on phones (CB-96).
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search tasks"]')!;
    expect(search.dataset.slot).toBe('input');
    expect(search.className).toContain('text-base');
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'draft');
        search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringMatching(/^Draft the checklist/)]);
    act(() => (rows()[0] as HTMLElement).click());
    await until(() => !!host.querySelector('[data-slot="task-detail"]'), 'the card');
    const card = host.querySelector('[data-slot="task-detail"]')!;
    expect(card.textContent).toContain('The model was busy.');
    expect(card.textContent).toContain('Queued.');
    expect(card.querySelector('a[href="/schedules/one"]')?.textContent).toBe('Details and past runs');
    const pause = buttons().find((button) => button.textContent === 'Pause schedule')!;
    expect(pause.dataset.slot).toBe('button');
    act(() => pause.click());
    await until(() => calls.length > 1, 'the reload');
    expect(shell.mutate).toHaveBeenCalledWith('/tasks/one/actions', 'POST', {
        action: 'pause',
    });
    noLegacy();
});

it('says how to schedule a task when there are none', () => {
    render(<ActivityPage />, {});
    expect(host.textContent).toContain('Let a thought come back around.');
    noLegacy();
});

const item = (fields: Partial<MemoryItem> = {}): MemoryItem => ({
    id: 'm1',
    text: 'Keep it short.',
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 1),
    confirmedAt: Date.UTC(2026, 9, 3),
    status: 'active',
    source: 'person',
    shareable: false,
    dotId: null,
    threadId: null,
    ...fields,
});

it('shows memories with where they came from, and confirms, forgets and adds them', async () => {
    const proposal = item({
        id: 'p1',
        text: 'Plans in quarters.',
        status: 'proposed',
        source: 'notes',
        dotId: 'd1',
        threadId: 't1',
        confirmedAt: null,
    });
    memories = {
        profile: {
            fields: { name: 'Ali', style: 'Bullets, please.' },
            shareable: true,
            updatedAt: 1,
        },
        memories: [item({ shareable: true })],
        proposals: [proposal],
    };
    render(<MemoriesPage initial={memories} />, {});
    const card = host.querySelector('[data-memory="m1"]')!;
    expect(card.getAttribute('data-slot')).toBe('card');
    expect(card.textContent).toContain('Keep it short.');
    expect(card.textContent).toContain('Added by you');
    expect(card.textContent).toContain('Team chats too');
    expect(card.textContent).toContain('Confirmed');
    const waiting = host.querySelector('[data-proposal="p1"]')!;
    expect(waiting.textContent).toContain('Proposed by Mingo in Planning, from the chat’s notes');
    const profile = host.querySelector('[data-slot="memory-profile"]')!;
    expect(profile.textContent).toContain('Preferred nameAli');
    expect(profile.textContent).toContain('Your chats and team chats');

    act(() => [...waiting.querySelectorAll('button')].find((b) => b.textContent === 'Remember')!.click());
    await until(() => calls.some((call) => call.path === '/api/memories/p1/approve'), 'the approval');
    act(() => host.querySelector<HTMLElement>('[aria-label="Still true"]')!.click());
    await until(() => calls.some((call) => call.path === '/api/memories/m1/confirm'), 'the confirmation');
    act(() => host.querySelector<HTMLElement>('[aria-label="Forget memory"]')!.click());
    const forget = document.querySelector('[data-slot="forget-memory"]')!;
    expect(forget.textContent).toContain('Your socios stop using it');
    act(() => [...forget.querySelectorAll('button')].find((b) => b.textContent === 'Forget')!.click());
    await until(() => calls.some((call) => call.method === 'DELETE' && call.path === '/api/memories/m1'), 'the forget');
    act(() =>
        buttons()
            .find((b) => b.textContent === 'Add memory')!
            .click(),
    );
    const editor = document.querySelector('[data-slot="memory-editor"]')!;
    const text = editor.querySelector<HTMLTextAreaElement>('#memory-text')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'Call me Ali.');
        text.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => editor.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(
        () =>
            calls.some(
                (call) =>
                    call.method === 'POST' &&
                    call.path === '/api/memories' &&
                    call.body === '{"text":"Call me Ali.","shareable":false}',
            ),
        'the new memory',
    );
    noLegacy();
});

it('invites a first memory and a profile when there are none', async () => {
    render(<MemoriesPage />, {});
    await until(() => host.textContent!.includes('A little context goes a long way.'), 'the empty page');
    expect(host.querySelector('[data-slot="memory-profile"]')!.textContent).toContain('Add profile');
    noLegacy();
});

it('shows the profile’s time zone, marked when it was detected, and lets the person change it (CB-159)', async () => {
    memories = {
        profile: {
            fields: { name: 'Ali', timezone: 'Europe/Madrid' },
            shareable: false,
            timezoneDetected: true,
            updatedAt: 1,
        },
        memories: [],
        proposals: [],
    };
    render(<MemoriesPage initial={memories} />, {});
    const profile = host.querySelector('[data-slot="memory-profile"]')!;
    expect(profile.textContent).toContain('Time zoneEurope/Madrid · detected from your browser');
    act(() =>
        buttons()
            .find((b) => b.textContent === 'Edit profile')!
            .click(),
    );
    const editor = document.querySelector('[data-slot="profile-editor"]')!;
    const zone = editor.querySelector<HTMLInputElement>('#profile-timezone')!;
    expect(zone.value).toBe('Europe/Madrid');
    expect(zone.getAttribute('list')).toBe('profile-timezones');
    expect(editor.querySelectorAll('#profile-timezones option').length).toBeGreaterThan(100);
    const note = () => editor.querySelector('[data-slot="profile-timezone-note"]')!.textContent;
    expect(note()).toContain('Detected from your browser.');
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(zone, 'America/New_York');
        zone.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(note()).not.toContain('Detected');
    act(() => editor.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(
        () =>
            calls.some(
                (call) =>
                    call.method === 'PUT' &&
                    call.path === '/api/memories/profile' &&
                    call.body === '{"fields":{"name":"Ali","timezone":"America/New_York"},"shareable":false}',
            ),
        'the saved profile',
    );
    noLegacy();
});

it('says which memories the person asked a socio to save, and where (CB-172)', () => {
    memories = {
        profile: null,
        memories: [
            item({
                id: 'm2',
                text: 'Prefers metric units.',
                dotId: 'd1',
                threadId: 't1',
            }),
            item({ id: 'm3', text: 'Is vegetarian.', dotId: 'd1', threadId: null }),
        ],
        proposals: [],
    };
    render(<MemoriesPage initial={memories} />, {});
    const asked = host.querySelector('[data-memory="m2"]')!;
    expect(asked.textContent).toContain('You asked Mingo to remember it in Planning');
    expect(asked.querySelector('a')?.getAttribute('href')).toBe('/chats/t1');
    expect(host.querySelector('[data-memory="m3"]')!.textContent).toContain('You asked Mingo to remember it');
    noLegacy();
});

it('says once that a detected time zone followed the browser (CB-176)', async () => {
    memories = {
        profile: {
            fields: { timezone: 'Europe/Madrid' },
            shareable: false,
            timezoneDetected: true,
            updatedAt: 1,
        },
        memories: [],
        proposals: [],
        timeZoneMoved: 'Europe/Madrid',
    };
    render(<MemoriesPage initial={memories} />, {});
    await until(
        () =>
            calls.some(
                (call) =>
                    call.method === 'POST' &&
                    call.path === '/api/memories/time-zone-note/seen' &&
                    call.body === '{"zone":"Europe/Madrid"}',
            ),
        'the note marked seen',
    );
    expect(host.querySelector('[data-slot="time-zone-moved"]')!.textContent).toBe(
        'Your time zone is now Europe/Madrid (detected from your browser).',
    );
    noLegacy();
});

it('shows the person’s episodes with where they came from, searches them and deletes one or all (CB-180)', async () => {
    episodes = {
        episodes: [
            {
                id: 'e1',
                kind: 'fact',
                label: 'Decision',
                text: 'Decision: invoices go out on the 1st',
                dotId: 'd1',
                threadId: 't1',
                occurredAt: Date.UTC(2026, 9, 20),
                createdAt: 1,
            },
            {
                id: 'e2',
                kind: 'summary',
                label: null,
                text: 'They planned the beta launch.',
                dotId: 'd1',
                threadId: 'gone',
                occurredAt: Date.UTC(2026, 9, 19),
                createdAt: 1,
            },
        ],
        total: 2,
        retentionDays: 90,
    };
    render(<MemoriesPage initial={memories} />, {});
    await until(() => !!host.querySelector('[data-episode="e1"]'), 'the episodes');
    const section = host.querySelector('[data-slot="memory-episodes"]')!;
    expect(section.textContent).toContain('From your chats');
    expect(section.textContent).toContain('never in team chats or rooms');
    expect(section.textContent).toContain('after 90 days without coming up');
    expect(section.textContent).toContain('2 episodes');
    const first = host.querySelector('[data-episode="e1"]')!;
    expect(first.textContent).toContain('Decision: invoices go out on the 1st');
    expect(first.textContent).toContain('From Planning with Mingo');
    expect(first.querySelector('a')!.getAttribute('href')).toBe('/chats/t1');
    const second = host.querySelector('[data-episode="e2"]')!;
    expect(second.textContent).toContain('What the chat was about');
    expect(second.textContent).toContain('From a chat with Mingo');

    // Searching asks the server with the words, a moment after typing.
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search episodes"]')!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'invoices');
        search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await until(
        () => calls.some((call) => call.search === '?q=invoices') && !host.querySelector('[data-episode="e2"]'),
        'the search',
    );

    // Deleting one asks first, and says it is removed.
    act(() => host.querySelector<HTMLElement>('[aria-label="Delete episode"]')!.click());
    const confirm = document.querySelector('[data-slot="delete-episode"]')!;
    expect(confirm.textContent).toContain('removed from the workspace');
    act(() => [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click());
    await until(
        () => calls.some((call) => call.method === 'DELETE' && call.path === '/api/memories/episodes/e1'),
        'the delete',
    );
    act(() =>
        buttons()
            .find((b) => b.textContent === 'Delete all')!
            .click(),
    );
    const all = document.querySelector('[data-slot="delete-all-episodes"]')!;
    act(() => [...all.querySelectorAll('button')].find((b) => b.textContent === 'Delete all')!.click());
    await until(
        () => calls.some((call) => call.method === 'DELETE' && call.path === '/api/memories/episodes' && !call.search),
        'the delete of all',
    );
    noLegacy();
});

it('says where episodes come from when there are none yet (CB-180)', async () => {
    render(<MemoriesPage initial={memories} />, {});
    await until(() => !!host.querySelector('[data-slot="episodes-empty"]'), 'the empty episodes');
    expect(host.querySelector('[data-slot="episodes-empty"]')!.textContent).toContain(
        'once they are long enough to be compacted',
    );
    expect(host.querySelector('input[aria-label="Search episodes"]')).toBeNull();
});
