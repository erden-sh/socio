// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dot } from '@socio/shared/types';

import type { Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The live chat's CopilotKit agent, as far as the composer uses it.
const agent = vi.hoisted(() => ({
    messages: [] as unknown[],
    addMessage: vi.fn(),
    subscribe: () => ({ unsubscribe: () => {} }),
}));
const copilotkit = vi.hoisted(() => ({
    subscribe: () => ({ unsubscribe: () => {} }),
    connectAgent: vi.fn(async () => undefined),
    runAgent: vi.fn(async () => ({ newMessages: [{ role: 'assistant' }] })),
    stopAgent: vi.fn(),
}));
vi.mock('@copilotkit/react-core/v2', () => ({
    useAgent: () => ({ agent, isReady: true }),
    useCopilotKit: () => ({ copilotkit }),
    useRenderTool: () => {},
    useHumanInTheLoop: () => {},
    CopilotChatToolCallsView: () => null,
}));

const { DotChat } = await import('../src/views/ChatViews');
const { ShellContext } = await import('../src/shell/shell-context');

const dot: Dot = {
    id: 'd1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Dot',
    instructions: 'Dot helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};

const newConversation = vi.fn(async () => true);

let root: Root | undefined;
let host: HTMLElement | undefined;
beforeEach(() => {
    agent.messages = [];
    agent.addMessage.mockClear();
    newConversation.mockClear();
    // jsdom has no layout.
    Element.prototype.scrollIntoView = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
        Response.json(String(url).includes('/me/inference/options') ? { options: [], automatic: null } : null),
    );
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

async function render(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(node));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    return host;
}

/** Renders `/dots/:dotId/new` (the NewConversation composer) under a shell. */
async function renderNewChat(setupVoice: boolean | undefined) {
    const shell = {
        state: { settings: { paused: false } },
        workspace: {
            dots: [dot],
            setup: {
                model: true,
                telegram: 'not_configured',
                ...(setupVoice === undefined ? {} : { voice: setupVoice }),
            },
        },
        admin: false,
        configured: true,
        busy: false,
        newConversation,
        openDialog: () => {},
        openTarget: () => {},
        pane: false,
        setPane: () => {},
    } as unknown as Shell;
    const router = createMemoryRouter([{ path: '/dots/:dotId', element: <DotChat /> }], {
        initialEntries: ['/dots/d1'],
    });
    return render(
        <ShellContext.Provider value={shell}>
            <RouterProvider router={router} />
        </ShellContext.Provider>,
    );
}

it('shows the voice affordance on a new chat when voice is set up (CB-302)', async () => {
    const view = await renderNewChat(true);
    expect(view.querySelector('[data-slot="new-chat-voice"]')).toBeTruthy();
});

it('hides the voice affordance when voice is not set up (CB-302)', async () => {
    const view = await renderNewChat(false);
    expect(view.querySelector('[data-slot="new-chat-voice"]')).toBeNull();
});

it('tapping voice creates a conversation with the voice flag and no text (CB-302)', async () => {
    const view = await renderNewChat(true);
    const button = view.querySelector<HTMLButtonElement>('[data-slot="new-chat-voice"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => {
        button.click();
    });
    expect(newConversation).toHaveBeenCalledTimes(1);
    // Voice as the first message: no placeholder text is required first.
    expect(newConversation).toHaveBeenCalledWith(dot, undefined, null, [], {
        voice: true,
    });
});
