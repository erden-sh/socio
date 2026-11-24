// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import type { Dot, User } from '@socio/shared/types';

import { CurrentUser } from '../src/shell/current-user';
import { ShellContext, type Shell } from '../src/shell/shell-context';
import { DotChat } from '../src/views/ChatViews';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// CB-160: the new-chat screen, its composer anchored at the bottom as a
// chat's is, the starters above it.
const dot: Dot = {
    id: 'd1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Ada',
    instructions: 'Ada helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
const shell = {
    state: { settings: { paused: false } },
    workspace: {
        user: bob,
        dots: [dot],
        setup: { model: true, telegram: 'not_configured' },
    },
    admin: false,
    configured: true,
    busy: false,
    newConversation: async () => false,
    openDialog: () => {},
    openTarget: () => {},
    pane: false,
    setPane: () => {},
} as unknown as Shell;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    vi.unstubAllGlobals();
});

it('puts the starters above the composer, which stays at the bottom while what is above it gives way (CB-160)', async () => {
    vi.stubGlobal(
        'fetch',
        async () =>
            new Response(JSON.stringify({ options: [], automatic: null }), {
                headers: { 'Content-Type': 'application/json' },
            }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const router = createMemoryRouter([{ path: '/dots/:dotId', element: <DotChat /> }], {
        initialEntries: ['/dots/d1'],
    });
    await act(async () =>
        root!.render(
            <CurrentUser.Provider value={bob}>
                <ShellContext.Provider value={shell}>
                    <RouterProvider router={router} />
                </ShellContext.Provider>
            </CurrentUser.Provider>,
        ),
    );
    const screen = host.querySelector<HTMLElement>('[data-slot="new-chat"]')!;
    const intro = screen.querySelector<HTMLElement>('[data-slot="new-chat-intro"]')!;
    const starters = screen.querySelector<HTMLElement>('[data-slot="new-chat-starters"]')!;
    const composer = screen.querySelector<HTMLElement>('[data-slot="new-chat-composer"]')!;
    // The screen is the intro, then the composer: nothing under the box.
    expect([...screen.children]).toEqual([intro, composer]);
    expect(intro.contains(starters)).toBe(true);
    expect(starters.textContent).toContain('Help me think this through');
    // The intro takes the room and scrolls on its own; the box keeps its
    // place at the bottom, whatever the intro holds.
    expect(intro.className).toMatch(/\bflex-1\b/);
    expect(intro.className).toContain('min-h-0');
    expect(intro.className).toContain('overflow-y-auto');
    expect(composer.className).toContain('shrink-0');
    expect(composer.className).not.toContain('mt-auto');
    // As tall as what it holds, as a chat's box is: no blank under its
    // toolbar.
    expect(composer.className).not.toMatch(/(^| )min-h-/);
    // The starters sit just above the box.
    expect(starters.parentElement!.className).toContain('mt-auto');
    // With the keyboard up, the welcome and the starters give way, inside
    // the intro: the box doesn't move for them (CB-155).
    expect(starters.className).toContain('keyboard:hidden');
    expect(intro.firstElementChild!.className).toContain('keyboard:hidden');
});

it.each([true, false])(
    'uses the socio default availability (%s) for a new chat with automatic inference disabled (CB-236)',
    async (available) => {
        const choice = { source: 'shared' as const, backendId: 'chosen' };
        vi.stubGlobal('fetch', async () =>
            Response.json({
                automatic: null,
                options: [
                    {
                        key: 'shared:chosen',
                        choice,
                        label: 'Chosen model',
                        group: 'Fixture',
                        available,
                    },
                ],
            }),
        );
        const chosenShell = {
            ...shell,
            workspace: {
                ...shell.workspace,
                dots: [{ ...dot, inference: choice }],
                setup: {
                    ...shell.workspace.setup,
                    inference: { available: false, byoAllowed: false },
                },
            },
        } as Shell;
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        const router = createMemoryRouter([{ path: '/dots/:dotId', element: <DotChat /> }], {
            initialEntries: ['/dots/d1'],
        });
        await act(async () =>
            root!.render(
                <CurrentUser.Provider value={bob}>
                    <ShellContext.Provider value={chosenShell}>
                        <RouterProvider router={router} />
                    </ShellContext.Provider>
                </CurrentUser.Provider>,
            ),
        );
        expect(host.querySelector('textarea')?.disabled).toBe(!available);
        expect(!!host.querySelector('[data-slot="no-inference"]')).toBe(!available);
    },
);
