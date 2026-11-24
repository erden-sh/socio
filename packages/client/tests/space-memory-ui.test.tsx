// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SpaceMemoryState, SpaceMemoryView, SpacePeopleView } from '@socio/shared/space-memory';
import type { Space } from '@socio/shared/types';

import { SpaceMemory } from '../src/modules/spaces/SpaceMemory';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// CB-181: a Space's Memory tab. Editors approve, edit and reject
// proposals and retire entries; readers propose and withdraw their own; a
// Space the viewer may not read is "not found", and nothing else. Its
// people and who sees it are under Settings (space-settings-ui.test.tsx).

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const space: Space = {
    id: 's1',
    name: 'Billing',
    description: 'Money things.',
    createdAt: 1,
};
const version = (fields: Partial<SpaceMemoryView>): SpaceMemoryView => ({
    id: 'v1',
    entryId: 'e1',
    spaceId: 's1',
    version: 1,
    text: 'Invoices go out on the 1st.',
    status: 'active',
    proposedBy: 'mo',
    dotId: null,
    threadId: null,
    supersedes: null,
    createdAt: Date.UTC(2026, 9, 1),
    decidedBy: 'ada',
    decidedAt: Date.UTC(2026, 9, 2),
    endedBy: null,
    endedAt: null,
    proposedByName: 'Mo',
    dotName: null,
    chatTitle: null,
    decidedByName: 'Ada',
    endedByName: null,
    ...fields,
});

let root: Root;
let host: HTMLElement;
let calls: { method: string; path: string; body?: string }[];
let memory: SpaceMemoryState | null;
let people: SpacePeopleView;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path: url.pathname,
            body: typeof init?.body === 'string' ? init.body : undefined,
        });
        if (!memory) {
            return Response.json({ error: 'Space not found.' }, { status: 404 });
        }
        if (method !== 'GET') {
            return Response.json({ ok: true });
        }
        if (url.pathname === '/api/spaces/s1/memory') {
            return Response.json(memory);
        }
        if (url.pathname === '/api/spaces/s1/people') {
            return Response.json(people);
        }
        return Response.json([]);
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

function render() {
    const shell = {
        state: {
            settings: { name: 'Socio', paused: false, memoryAllowed: true },
            tasks: [],
            memories: [],
        },
        workspace: { dots: [], conversations: [], spaces: [space] },
        busy: false,
        mutate: vi.fn(async () => true),
        setError: vi.fn(),
        openDialog: vi.fn(),
    } as unknown as Shell;
    act(() =>
        root.render(
            <ShellContext.Provider value={shell}>
                <MemoryRouter initialEntries={['/spaces/s1/memory']}>
                    <SpaceMemory space={space} />
                </MemoryRouter>
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
const button = (name: string) =>
    [...host.querySelectorAll('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );

it('gives an editor the queue with approve, edit and reject, and the entries to manage', async () => {
    memory = {
        spaceId: 's1',
        access: 'editor',
        entries: [version({})],
        proposals: [
            version({
                id: 'p1',
                entryId: 'e2',
                version: null,
                status: 'proposed',
                text: 'Standups are at 9:30.',
                dotId: 'd1',
                dotName: 'Mingo',
                threadId: 't1',
                chatTitle: 'Planning',
                decidedBy: null,
                decidedAt: null,
                decidedByName: null,
            }),
        ],
        retired: [],
        retentionDays: 365,
    };
    people = {
        spaceId: 's1',
        membersOnly: false,
        people: [{ userId: 'mo', name: 'Mo', role: 'member', addedBy: 'ada', addedAt: 1 }],
        access: 'editor',
        candidates: [{ id: 'nina', name: 'Nina' }],
    };
    render();
    await until(() => !!button('Approve'), 'the queue');
    // The tabs: links, the current one marked.
    const tabs = host.querySelector('nav[aria-label="Billing sections"]')!;
    expect(
        [...tabs.querySelectorAll('a')].map((link) => [
            link.textContent,
            link.getAttribute('href'),
            link.getAttribute('aria-current'),
        ]),
    ).toEqual([
        ['Pages', '/spaces/s1', null],
        ['Memory', '/spaces/s1/memory', 'page'],
        ['Radar', '/spaces/s1/radar', null],
        ['Settings', '/spaces/s1/settings', null],
    ]);
    const queue = host.querySelector('[data-slot="space-memory-proposals"]')!;
    expect(queue.textContent).toContain('Proposed by Mingo for Mo in Planning');
    expect(queue.querySelector('a')?.getAttribute('href')).toBe('/chats/t1');
    expect(button('Edit and approve')).toBeTruthy();
    expect(button('Reject')).toBeTruthy();
    expect(button('Withdraw')).toBeUndefined();
    for (const label of ['Entry history', 'Edit entry', 'Retire entry']) {
        expect(button(label), label).toBeTruthy();
    }
    expect(button('Add entry')).toBeTruthy();
    expect(host.textContent).toContain('Approved by Ada');
    // Its people are under Settings now (space-settings-ui.test.tsx).
    expect(host.querySelector('[data-slot="space-people"]')).toBeNull();

    await act(async () => button('Approve')!.click());
    await until(() => calls.some((call) => call.method === 'POST'), 'the approval');
    expect(calls.find((call) => call.method === 'POST')?.path).toBe('/api/spaces/s1/memory/proposals/p1/approve');
});

it('lets a reader propose and withdraw their own, and nothing an editor does', async () => {
    memory = {
        spaceId: 's1',
        access: 'reader',
        entries: [version({})],
        proposals: [
            version({
                id: 'p2',
                entryId: 'e1',
                version: null,
                status: 'proposed',
                text: 'Invoices go out on the 2nd.',
                supersedes: 'v1',
                proposedBy: 'nina',
                proposedByName: 'Nina',
                decidedBy: null,
                decidedAt: null,
                decidedByName: null,
            }),
        ],
        retired: [],
        retentionDays: 365,
    };
    people = {
        spaceId: 's1',
        membersOnly: false,
        people: [],
        access: 'reader',
        candidates: [],
    };
    render();
    await until(() => !!button('Withdraw'), 'the reader’s proposal');
    expect(host.textContent).toContain('Your proposals');
    expect(host.textContent).toContain('Changes: “Invoices go out on the 1st.”');
    for (const label of ['Approve', 'Reject', 'Retire entry', 'Add entry']) {
        expect(button(label), label).toBeUndefined();
    }
    expect(button('Propose entry')).toBeTruthy();
    expect(button('Suggest a change')).toBeTruthy();
    expect(host.querySelector('[data-slot="permission-row"]')).toBeNull();
    await act(async () => button('Propose entry')!.click());
    await until(() => !!document.querySelector('[data-slot="space-memory-editor"]'), 'the editor');
    expect(document.body.textContent).toContain('It waits for one of the Space’s editors');
});

it('says only that the Space is not found when the viewer can’t read it', async () => {
    memory = null;
    render();
    await until(() => !!host.querySelector('[data-slot="space-memory-missing"]'), 'the note');
    expect(host.textContent).not.toContain('Invoices');
    expect(button('Propose entry')).toBeUndefined();
});
